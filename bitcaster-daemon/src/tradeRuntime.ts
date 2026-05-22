import type { DaemonState, LocalOrderRecord, LocalSwapRecord } from './state.ts'

export interface TradeRuntimeConnection {
  start(): Promise<void>
  stop(): Promise<void>
  joinOrder(marketId: string, orderId: string): Promise<void>
  joinTrade(tradeId: string): Promise<void>
  sendSwapMessage(
    tradeId: string,
    messageType: string,
    ciphertext: string,
  ): Promise<void>
}

export interface TradeRuntime {
  start(state: DaemonState): Promise<TradeResumePlan>
  stop(): Promise<void>
}

export interface TradeResumePlan {
  orders: Array<{ marketId: string; orderId: string }>
  trades: Array<{ marketId?: string; tradeId: string }>
}

export class DaemonTradeRuntime implements TradeRuntime {
  private readonly joinedOrders = new Set<string>()
  private readonly joinedTrades = new Set<string>()
  private started = false
  private readonly connection: TradeRuntimeConnection

  constructor(connection: TradeRuntimeConnection) {
    this.connection = connection
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
        await this.connection.joinTrade(trade.tradeId)
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
  return !['filled', 'cancelled', 'failed'].includes(order.status.toLowerCase())
}

function isLiveSwap(swap: LocalSwapRecord): boolean {
  return !['confirmed', 'refunded', 'failed'].includes(swap.step)
}
