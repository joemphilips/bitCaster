import { useEffect, useRef } from 'react'
import type { components } from '@/generated/api'
import {
  getCurrentGuiPendingTrades,
  isCurrentGuiPendingTrade,
  removeGuiPendingTrade,
  type PendingTradeRecord,
} from '@/stores/pendingTrades'
import {
  type Notification,
  type NotificationKind,
  useNotificationsStore,
} from '@/stores/notifications'
import { useActiveSwapsStore } from '@/stores/activeSwaps'
import { usePendingPubkeySubmissionsStore } from '@/stores/pendingPubkeySubmissions'
import { getGuiPendingSwapIntent } from '@/stores/pending-swap-intent-db'
import { useToastStore } from '@/stores/toast'
import { generateNip98Header } from '@/lib/markets'
import { resolveApiSigningUrl } from '@/lib/hubUrl'
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
  | 'Matched'
  | 'partially_filled'
  | 'filled'
  | 'Filled'
  | 'cancelled'
  | 'failed'
  | 'Failed'

function normalizeOrderStatus(status: string): OrderStatus {
  switch (status) {
    case 'resting':
    case 'matched':
    case 'Matched':
    case 'partially_filled':
    case 'filled':
    case 'Filled':
    case 'cancelled':
    case 'failed':
    case 'Failed':
      return status
    default:
      throw new Error(`Unhandled OrderStatus: ${status}`)
  }
}

function notificationKindForTerminalStatus(status: OrderStatus): NotificationKind {
  switch (status) {
    case 'filled':
    case 'Filled':
      return 'Filled'
    case 'failed':
    case 'Failed':
      return 'Failed'
    case 'cancelled':
      return 'cancelled'
    case 'resting':
    case 'matched':
    case 'Matched':
    case 'partially_filled':
      throw new Error(`OrderStatus is not terminal: ${status}`)
    default:
      return assertNever(status)
  }
}

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

type PendingTradeDetails = {
  orderId: string
  clientOrderId?: string
  marketId: string
  baseAsset?: string | null
  divisibility?: number | null
  side?: 'Buy' | 'Sell'
  tokenSide?: 'Outcome' | 'Complement'
  priceSubunits?: number | null
  amountSubunits?: number | null
  timeInForce?: 'FAK' | 'FOK' | 'GTC'
  recoveryAttempt?: number
}

type FillLike = {
  tradeId?: string
  makerOrderId?: string
  takerOrderId?: string
  amountSubunits?: number
}

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'filled',
  'Filled',
  'cancelled',
  'failed',
  'Failed',
])

export async function fetchOrderStatus(
  marketId: string,
  orderId: string,
): Promise<OrderStatusResponse | null> {
  return (await new BitcasterEngineClient({
    baseUrl: window.location.origin,
    authorization: ({ url, method }) =>
      generateNip98Header(resolveApiSigningUrl(url), method),
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
 * Captures the per-trade ephemeral keypair from `pendingPubkeySubmissions`.
 */
export function promoteNewFillsToActiveSwaps(
  status: OrderStatusResponse,
  trade: PendingTradeRecord,
  lastFillCount: number,
): number {
  return promoteFillsToActiveSwaps(status.fills, trade, lastFillCount)
}

export function promoteFillsToActiveSwaps(
  fills: readonly FillLike[],
  trade: PendingTradeRecord,
  lastFillCount = 0,
): number {
  if (!isCurrentGuiPendingTrade(trade)) return 0
  if (fills.length <= lastFillCount) return 0

  const promote = useActiveSwapsStore.getState().promote
  let promoted = 0
  for (const fill of fills.slice(lastFillCount)) {
    const tradeId = fill.tradeId
    if (!tradeId) continue
    const pendingKey = usePendingPubkeySubmissionsStore.getState().byTradeId[tradeId]
    if (!pendingKey) {
      void getGuiPendingSwapIntent(tradeId)
        .then((intent) => {
          if (!intent || !isCurrentGuiPendingTrade(trade)) return
          usePendingPubkeySubmissionsStore.getState().addPendingPubkey(intent)
          promoteSwapFill(promote, fill, trade, intent)
        })
        .catch(() => {
          // A failed durable lookup cannot create an active swap or new key.
        })
      continue
    }
    promoteSwapFill(promote, fill, trade, pendingKey)
    promoted += 1
  }
  return promoted
}

function promoteSwapFill(
  promote: ReturnType<typeof useActiveSwapsStore.getState>['promote'],
  fill: FillLike,
  trade: PendingTradeRecord,
  pendingKey: { pubkey: string; privkey: string },
): void {
  if (!isCurrentGuiPendingTrade(trade)) return
  const tradeId = fill.tradeId
  if (!tradeId) return
  promote({
    tradeId,
    orderId: trade.orderId,
    clientOrderId: trade.clientOrderId,
    marketId: trade.marketId,
    ephemeralPrivkeyHex: pendingKey.privkey,
    ephemeralPubkeyHex: pendingKey.pubkey,
    baseAsset: trade.baseAsset,
    divisibility: trade.divisibility,
    side: trade.side,
    tokenSide: trade.tokenSide,
    priceSubunits: trade.priceSubunits,
    amountSubunits: trade.amountSubunits,
    timeInForce: trade.timeInForce,
    isTaker: fill.takerOrderId === trade.orderId,
    matchedAmountSubunits: fill.amountSubunits ?? null,
    recoveryAttempt: trade.recoveryAttempt,
  })
}

export function buildOrderStatusNotifications(
  status: OrderStatusResponse,
  trade: PendingTradeDetails,
  lastFillCount: number,
  now = Date.now(),
): Notification[] {
  const current = normalizeOrderStatus(String(status.status))
  const isTerminal = TERMINAL_STATUSES.has(current)
  const fillCount = status.fills.length
  const hasNewFills = fillCount > lastFillCount

  const unit = normalizeMarketBaseAsset(trade.baseAsset)

  if (
    !isTerminal &&
    (current === 'matched' || current === 'Matched' || current === 'partially_filled') &&
    hasNewFills &&
    status.filledAmountSubunits > 0
  ) {
    const kind = current === 'matched' || current === 'Matched' ? 'Matched' : 'partially_filled'
    const idKind = current === 'matched' || current === 'Matched' ? 'matched' : 'partially_filled'
    return [
      {
        id: `${trade.orderId}-${idKind}-${fillCount}`,
        kind,
        orderId: trade.orderId,
        marketId: trade.marketId,
        filledAmountSubunits: status.filledAmountSubunits,
        remainingAmountSubunits: status.remainingAmountSubunits,
        unit,
        occurredAt: now,
        read: false,
      },
    ]
  }

  if (isTerminal) {
    const kind = notificationKindForTerminalStatus(current)
    const idKind = String(current).toLowerCase()
    return [
      {
        id: `${trade.orderId}-${idKind}`,
        kind,
        orderId: trade.orderId,
        marketId: trade.marketId,
        filledAmountSubunits: status.filledAmountSubunits,
        remainingAmountSubunits: status.remainingAmountSubunits,
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
        const trades = getCurrentGuiPendingTrades()
        if (trades.length === 0) {
          scheduleNext()
          return
        }

        const addNotification = useNotificationsStore.getState().add
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
            if (!status || cancelled || !isCurrentGuiPendingTrade(trade)) return

            const current = normalizeOrderStatus(String(status.status))
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

            // Terminal status short-circuits partial-fill: a "Filled" that
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
              if (current === 'Filled' || current === 'filled') {
                useToastStore.getState().addToast({
                  type: 'success',
                  message: `All your amount for order ${shortOrderId(trade.orderId)} has been filled. 0 sats remaining.`,
                })
              }
              await removeGuiPendingTrade(trade)
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
