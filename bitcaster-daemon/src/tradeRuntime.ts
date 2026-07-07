import type { DaemonState, LocalOrderRecord, LocalSwapRecord } from './state.ts'

export interface TradeRuntimeConnection {
  start(): Promise<void>
  stop(): Promise<void>
  joinOrder(marketId: string, orderId: string): Promise<void>
  joinTrade(tradeId: string): Promise<TradeJoinResult>
  sendSwapMessage(
    tradeId: string,
    messageType: string,
    ciphertext: string,
  ): Promise<void>
}

export interface MarketRuntimeConnection {
  start(): Promise<void>
  stop(): Promise<void>
  trackOrder(marketId: string, orderId: string): Promise<void>
}

export class CompositeTradeRuntimeConnection implements TradeRuntimeConnection {
  private readonly trade: TradeRuntimeConnection
  private readonly market?: MarketRuntimeConnection

  constructor(
    trade: TradeRuntimeConnection,
    market?: MarketRuntimeConnection,
  ) {
    this.trade = trade
    this.market = market
  }

  async start(): Promise<void> {
    await this.market?.start()
    await this.trade.start()
  }

  async stop(): Promise<void> {
    await this.market?.stop()
    await this.trade.stop()
  }

  async joinOrder(marketId: string, orderId: string): Promise<void> {
    await this.market?.trackOrder(marketId, orderId)
    try {
      await this.trade.joinOrder(marketId, orderId)
    } catch (_err) {
      // TradeHub JoinOrder failure should not block MarketHub Matched delivery.
      // The maker can still receive Matched events and submit ephemeral pubkeys.
    }
  }

  joinTrade(tradeId: string): Promise<TradeJoinResult> {
    return this.trade.joinTrade(tradeId)
  }

  sendSwapMessage(
    tradeId: string,
    messageType: string,
    ciphertext: string,
  ): Promise<void> {
    return this.trade.sendSwapMessage(tradeId, messageType, ciphertext)
  }
}

export interface TradeJoinResult {
  success: boolean
  error?: string
}

export interface TradeRuntime {
  start(state: DaemonState): Promise<TradeResumePlan>
  stop(): Promise<void>
}

export interface TradeResumePlan {
  orders: Array<{ marketId: string; orderId: string }>
  trades: Array<{ marketId?: string; tradeId: string }>
}

export interface DaemonTradeRuntimeOptions {
  joinTradeMaxRetries?: number
  joinTradeRetryDelayMs?: number
  retryExhaustedRecoveryDelayMs?: number
  scheduleResumeActiveSwaps?: (delayMs: number) => void
}

const DEFAULT_JOIN_TRADE_MAX_RETRIES = 5
const DEFAULT_JOIN_TRADE_RETRY_DELAY_MS = 500
const DEFAULT_RETRY_EXHAUSTED_RECOVERY_DELAY_MS = 10_000

export class DaemonTradeRuntime implements TradeRuntime {
  private readonly joinedOrders = new Set<string>()
  private readonly joinedTrades = new Set<string>()
  private started = false
  private readonly connection: TradeRuntimeConnection
  private readonly joinTradeMaxRetries: number
  private readonly joinTradeRetryDelayMs: number
  private readonly retryExhaustedRecoveryDelayMs: number
  private readonly scheduleResumeActiveSwaps?: (delayMs: number) => void

  constructor(
    connection: TradeRuntimeConnection,
    options: DaemonTradeRuntimeOptions = {},
  ) {
    this.connection = connection
    this.joinTradeMaxRetries =
      options.joinTradeMaxRetries ?? DEFAULT_JOIN_TRADE_MAX_RETRIES
    this.joinTradeRetryDelayMs =
      options.joinTradeRetryDelayMs ?? DEFAULT_JOIN_TRADE_RETRY_DELAY_MS
    this.retryExhaustedRecoveryDelayMs =
      options.retryExhaustedRecoveryDelayMs ??
      DEFAULT_RETRY_EXHAUSTED_RECOVERY_DELAY_MS
    this.scheduleResumeActiveSwaps = options.scheduleResumeActiveSwaps
  }

  async start(state: DaemonState): Promise<TradeResumePlan> {
    const plan = buildTradeResumePlan(state)
    if (!this.started) {
      await this.connection.start()
      this.started = true
    }

    for (const order of plan.orders) {
      const key = `${order.marketId}|${order.orderId}`
      if (this.joinedOrders.has(key)) continue
      this.joinedOrders.add(key)
      try {
        await this.connection.joinOrder(order.marketId, order.orderId)
      } catch (err) {
        this.joinedOrders.delete(key)
        throw err
      }
    }

    for (const trade of plan.trades) {
      if (this.joinedTrades.has(trade.tradeId)) continue
      this.joinedTrades.add(trade.tradeId)
      try {
        const result = await this.joinTradeWithBoundedRetry(state, trade.tradeId)
        if (!result.success) {
          this.joinedTrades.delete(trade.tradeId)
        }
      } catch (err) {
        this.joinedTrades.delete(trade.tradeId)
        throw err
      }
    }

    return plan
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.joinedOrders.clear()
    this.joinedTrades.clear()
    await this.connection.stop()
  }

  private async joinTradeWithBoundedRetry(
    state: DaemonState,
    tradeId: string,
  ): Promise<TradeJoinResult> {
    let lastResult: TradeJoinResult = { success: false }
    for (let retry = 0; retry <= this.joinTradeMaxRetries; retry += 1) {
      if (retry > 0 && !shouldRetryJoinTrade(state, tradeId)) {
        return lastResult
      }

      lastResult = await this.connection.joinTrade(tradeId)
      if (lastResult.success) return lastResult

      if (!shouldRetryJoinTrade(state, tradeId)) return lastResult
      if (retry >= this.joinTradeMaxRetries) break

      await delay(this.joinTradeRetryDelayMs)
    }

    if (!lastResult.success) {
      this.scheduleResumeActiveSwaps?.(this.retryExhaustedRecoveryDelayMs)
    }
    return lastResult
  }
}

export function buildTradeResumePlan(state: DaemonState): TradeResumePlan {
  const orderMap = new Map<string, { marketId: string; orderId: string }>()
  const tradeMap = new Map<string, { marketId?: string; tradeId: string }>()

  for (const order of Object.values(state.orders)) {
    if (!isLiveOrder(order)) continue
    orderMap.set(order.orderId, {
      marketId: order.marketId,
      orderId: order.orderId,
    })
    for (const tradeId of order.tradeIds) {
      tradeMap.set(tradeId, { marketId: order.marketId, tradeId })
    }
  }

  for (const swap of Object.values(state.swaps)) {
    if (!isLiveSwap(swap)) continue
    tradeMap.set(swap.tradeId, {
      marketId: swap.marketId,
      tradeId: swap.tradeId,
    })
  }

  return {
    orders: [...orderMap.values()].sort(
      (a, b) =>
        a.marketId.localeCompare(b.marketId) ||
        a.orderId.localeCompare(b.orderId),
    ),
    trades: [...tradeMap.values()].sort((a, b) =>
      a.tradeId.localeCompare(b.tradeId),
    ),
  }
}

function isLiveOrder(order: LocalOrderRecord): boolean {
  return !['Filled', 'cancelled', 'Failed'].includes(order.status)
}

function isLiveSwap(swap: LocalSwapRecord): boolean {
  return !['confirmed', 'refunded', 'Failed'].includes(swap.step)
}

function shouldRetryJoinTrade(state: DaemonState, tradeId: string): boolean {
  return state.swaps[tradeId]?.step === 'awaiting-trade-created'
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
