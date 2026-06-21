import { useEffect, useRef } from 'react'
import type { components } from '@/generated/api'
import { usePendingTradesStore } from '@/stores/pendingTrades'
import {
  type Notification,
  type NotificationKind,
  useNotificationsStore,
} from '@/stores/notifications'
import { useActiveSwapsStore } from '@/stores/activeSwaps'
import { useToastStore } from '@/stores/toast'
import { generateNip98Header } from '@/lib/markets'
import { BitcasterEngineClient } from '@bitcaster/client-sdk/engineClient'
import { normalizeMarketBaseAsset } from '@bitcaster/client-sdk/marketUnits'

export type OrderStatusResponse = components['schemas']['OrderStatusResponse']
export type FillStatus = components['schemas']['FillStatus']

/**
 * Mirrors `OrderStatusResponse.status` from `openapi.yaml`.
 */
export type OrderStatus =
  | 'resting'
  | 'matched'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'failed'

export function isTerminalFillStatus(status: FillStatus): boolean {
  switch (status) {
    case 'Matched':
      return false
    case 'Filled':
    case 'Failed':
      return true
    default:
      return assertNever(status)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled FillStatus: ${value}`)
}

type PendingTradeForPromotion = {
  orderId: string
  marketId: string
  ephemeralPubkey: string
  ephemeralPrivkey: string
  baseAsset?: string | null
  divisibility?: number | null
  side?: 'Buy' | 'Sell'
  tokenSide?: 'Outcome' | 'Complement'
  priceSubunits?: number | null
  amountSubunits?: number | null
}

type FillLike = {
  tradeId?: string
}

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'filled',
  'cancelled',
  'failed',
])

export async function fetchOrderStatus(
  marketId: string,
  orderId: string,
): Promise<OrderStatusResponse | null> {
  return (await new BitcasterEngineClient({
    baseUrl: window.location.origin,
    authorization: ({ url, method }) => generateNip98Header(url, method),
  }).getOrderStatus(marketId, orderId)) as OrderStatusResponse | null
}

const POLL_INTERVAL_MS = 5_000

/**
 * Promote any fill carrying a `tradeId` to the in-progress swap
 * store. Complementary matches (Buy vs Sell) surface the `tradeId` on produced
 * fills once the engine creates the Trade aggregate; mint matches (Buy vs Buy
 * splitter) surface a fill-shaped settlement handle before final fill commit
 * so clients can join TradeHub even if they missed the one-shot `TradeCreated`
 * push. Legacy bootstrap fills with no `tradeId` are ignored here.
 * Idempotent — `promote()` is a no-op for tradeIds already present in
 * `activeSwaps`.
 *
 * Captures the ephemeral keypair from `pendingTrades` at promote-time so the
 * swap-driver keeps working after the pending-trade entry is evicted on a
 * terminal order status.
 */
export function promoteNewFillsToActiveSwaps(
  status: OrderStatusResponse,
  trade: PendingTradeForPromotion,
  lastFillCount: number,
): number {
  return promoteFillsToActiveSwaps(status.fills, trade, lastFillCount)
}

export function promoteFillsToActiveSwaps(
  fills: readonly FillLike[],
  trade: PendingTradeForPromotion,
  lastFillCount = 0,
): number {
  if (fills.length <= lastFillCount) return 0

  const promote = useActiveSwapsStore.getState().promote
  let promoted = 0
  for (const fill of fills.slice(lastFillCount)) {
    const tradeId = fill.tradeId
    if (!tradeId) continue
    promote({
      tradeId,
      orderId: trade.orderId,
      marketId: trade.marketId,
      ephemeralPrivkeyHex: trade.ephemeralPrivkey,
      ephemeralPubkeyHex: trade.ephemeralPubkey,
      baseAsset: trade.baseAsset,
      divisibility: trade.divisibility,
      side: trade.side,
      tokenSide: trade.tokenSide,
      priceSubunits: trade.priceSubunits,
      amountSubunits: trade.amountSubunits,
    })
    promoted += 1
  }
  return promoted
}

export function buildOrderStatusNotifications(
  status: OrderStatusResponse,
  trade: PendingTradeForPromotion,
  lastFillCount: number,
  now = Date.now(),
): Notification[] {
  const current = status.status as OrderStatus
  const isTerminal = TERMINAL_STATUSES.has(current)
  const fillCount = status.fills.length
  const hasNewFills = fillCount > lastFillCount

  const unit = normalizeMarketBaseAsset(trade.baseAsset)

  if (
    !isTerminal &&
    (current === 'matched' || current === 'partially_filled') &&
    hasNewFills &&
    status.filledAmountSats > 0
  ) {
    const kind = current === 'matched' ? 'matched' : 'partially_filled'
    return [
      {
        id: `${trade.orderId}-${kind}-${fillCount}`,
        kind,
        orderId: trade.orderId,
        marketId: trade.marketId,
        filledAmountSats: status.filledAmountSats,
        remainingAmountSats: status.remainingAmountSats,
        unit,
        occurredAt: now,
        read: false,
      },
    ]
  }

  if (isTerminal) {
    const kind = current as NotificationKind
    return [
      {
        id: `${trade.orderId}-${kind}`,
        kind,
        orderId: trade.orderId,
        marketId: trade.marketId,
        filledAmountSats: status.filledAmountSats,
        remainingAmountSats: status.remainingAmountSats,
        unit,
        occurredAt: now,
        read: false,
      },
    ]
  }

  return []
}

function shortOrderId(orderId: string): string {
  return orderId.length > 12 ? `${orderId.slice(0, 8)}...` : orderId
}

/**
 * Foreground-only poll loop that watches every pending trade's status on the
 * matching engine and fires notifications on state transitions.
 *
 * Design notes:
 *  - Pull-based. The engine does not (yet) push status over SignalR, so we
 *    poll each resting order at a slow cadence. Cheap because the number of
 *    pending trades per user is tiny (most users have zero; active traders
 *    might have a handful).
 *  - Pauses when the tab is hidden and fires one catch-up poll on the next
 *    visibility change. No point hammering the API for a tab the user isn't
 *    looking at.
 *  - Uses a ref of last-seen fill counts so a repeated snapshot ("3 → 3
 *    fills") doesn't re-emit the same partial-fill notification. The store
 *    also dedups by id, but tracking locally lets the happy path avoid the
 *    store write entirely.
 *
 * Mount this once at the application root, the same way as
 * `useBookmarkSync` / `useCreatorSync`.
 */
export function usePendingTradesPoller(): void {
  const lastFillCountRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // True from the moment a `tick()` begins network work to the moment its
    // trailing `setTimeout` lands. Used so a visibilitychange firing mid-tick
    // doesn't spawn a parallel tick chain.
    let inFlight = false

    const scheduleNext = () => {
      if (cancelled) return
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    const tick = async () => {
      if (cancelled || inFlight) return
      if (document.visibilityState !== 'visible') {
        // Don't reschedule — the visibilitychange handler will kick a poll
        // when the tab comes back.
        return
      }

      inFlight = true
      try {
        const trades = Object.values(usePendingTradesStore.getState().byOrderId)
        if (trades.length === 0) {
          scheduleNext()
          return
        }

        const addNotification = useNotificationsStore.getState().add
        const removePendingTrade = usePendingTradesStore.getState().remove

        await Promise.allSettled(
          trades.map(async (trade) => {
            let status: OrderStatusResponse | null
            try {
              status = await fetchOrderStatus(trade.marketId, trade.orderId)
            } catch {
              // Transient failure — we'll retry on the next tick. Swallowing
              // here keeps a dead engine from spamming console.error every 5s.
              return
            }
            if (!status || cancelled) return

            const current = status.status as OrderStatus
            const isTerminal = TERMINAL_STATUSES.has(current)
            const fillCount = status.fills.length
            const lastFillCount =
              lastFillCountRef.current.get(trade.orderId) ?? 0

            // Hand any fresh complementary-match fills (Buy vs Sell) or
            // mint-match settlement handles (Buy vs Buy splitter) to
            // useTradeSettlement so the atomic-swap driver can pick them up.
            // Legacy bootstrap fills without a tradeId are skipped here.
            const hasNewFills = fillCount > lastFillCount
            promoteNewFillsToActiveSwaps(status, trade, lastFillCount)

            // Terminal status short-circuits partial-fill: a "filled" that
            // also has new fills shouldn't generate two separate bell entries
            // for the same settlement.
            const notifications = buildOrderStatusNotifications(
              status,
              trade,
              lastFillCount,
            )
            for (const notification of notifications) {
              addNotification(notification)
            }

            if (!isTerminal && hasNewFills) {
              lastFillCountRef.current.set(trade.orderId, fillCount)
            }

            if (isTerminal) {
              if (current === 'filled') {
                useToastStore.getState().addToast({
                  type: 'success',
                  message: `All your amount for order ${shortOrderId(trade.orderId)} has been filled. 0 sats remaining.`,
                })
              }
              removePendingTrade(trade.orderId)
              lastFillCountRef.current.delete(trade.orderId)

              // Per P08, the server is not the source of truth for user
              // positions — the wallet (Cashu proofs in IndexedDB) is.
              // Wallet balance is driven by a Dexie `useLiveQuery` over
              // the proof-db, which auto-updates when new Cashu proofs
              // land, so no explicit refresh is needed here on terminal
              // status.
            }
          }),
        )
      } finally {
        inFlight = false
      }

      scheduleNext()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // If a tick is already running, the `inFlight` guard in `tick()` will
      // turn this into a no-op; the running tick's own `scheduleNext()` will
      // take over.
      void tick()
    }

    // Kick off the first poll immediately so users don't wait 5s after load.
    void tick()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}

/**
 * Split a marketId of the form `{conditionId}-{outcomeName}` back into its
 * parts. Public market ids use primitive outcome names, while condition ids
 * may come from external systems with their own separator conventions.
 * Returns `null` for malformed IDs so callers can fall back to the raw string.
 */
export function splitMarketId(
  marketId: string,
): { conditionId: string; outcomeName: string } | null {
  const idx = marketId.lastIndexOf('-')
  if (idx <= 0 || idx >= marketId.length - 1) return null
  return {
    conditionId: marketId.slice(0, idx),
    outcomeName: marketId.slice(idx + 1),
  }
}
