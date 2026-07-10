import {
  canRecoverFailedTakerFill,
  recoverFailedTakerFill,
  type TakerFillRecoveryOrderRequest,
  type TakerFillRecoverySubmitOrderResponse,
} from '@bitcaster-market/client-sdk/tradeRecovery'
import type { SubmitOrderResponse } from '@bitcaster-market/client-sdk/engineClient'
import {
  readState,
  recordSubmittedOrder,
  updateState,
  type DaemonState,
  type LocalOrderRecord,
  type LocalSwapRecord,
} from './state.ts'

export interface DaemonTakerFillRecoveryOptions {
  submitOrder: (
    marketId: string,
    request: TakerFillRecoveryOrderRequest,
  ) => Promise<DaemonTakerFillRecoverySubmitOrderResponse>
  newClientOrderId: () => string
  onResubmitted?: (input: {
    marketId: string
    orderId: string
    response: DaemonTakerFillRecoverySubmitOrderResponse
  }) => Promise<void>
}

type DaemonTakerFillRecoverySubmitOrderResponse =
  TakerFillRecoverySubmitOrderResponse &
  Partial<Pick<SubmitOrderResponse, 'status' | 'remainingAmountSubunits' | 'fills' | 'baseAsset' | 'divisibility' | 'pendingPubkeySubmissions'>>

/**
 * Daemon adapter for the SDK's maker-caused taker replacement policy. The
 * persisted marker makes a transport-ambiguous replacement idempotent across
 * duplicate terminal events and daemon restart.
 */
export class DaemonTakerFillRecovery {
  private readonly submitOrder: DaemonTakerFillRecoveryOptions['submitOrder']
  private readonly newClientOrderId: () => string
  private readonly onResubmitted?: DaemonTakerFillRecoveryOptions['onResubmitted']
  private readonly inFlightTradeIds = new Set<string>()

  constructor(options: DaemonTakerFillRecoveryOptions) {
    this.submitOrder = options.submitOrder
    this.newClientOrderId = options.newClientOrderId
    this.onResubmitted = options.onResubmitted
  }

  async recoverTrade(tradeId: string): Promise<void> {
    if (this.inFlightTradeIds.has(tradeId)) return
    this.inFlightTradeIds.add(tradeId)
    try {
      const state = await readState()
      const swap = state?.swaps[tradeId]
      const order = swap?.orderId ? state?.orders[swap.orderId] : undefined
      const input = buildRecoveryInput(swap, order)
      if (!input) return

      const marked = await reserveRecoveryAttempt(tradeId, this.newClientOrderId)
      if (!marked) return

      let submittedResponse: DaemonTakerFillRecoverySubmitOrderResponse | null = null
      const result = await recoverFailedTakerFill({
        failureReason: marked.failureReason,
        isTaker: marked.isTaker === true,
        deadlineMs: input.deadlineMs,
        sourceOrder: input.sourceOrder,
        failedFillAmountSubunits: input.failedFillAmountSubunits,
        resubmitAttempt: input.resubmitAttempt,
        submitOrder: async (marketId, request) => {
          submittedResponse = await this.submitOrder(marketId, request)
          return submittedResponse
        },
        newClientOrderId: () => marked.takerRecovery!.clientOrderId,
      })
      if (result.kind !== 'resubmitted') return

      await recordSubmittedOrder(
        input.sourceOrder.marketId,
        result.clientOrderId,
        submittedResponse ?? { orderId: result.orderId, status: 'resting', fills: [] },
        null,
        input.sourceOrder.tokenSide,
        input.sourceOrder.side,
        input.sourceOrder.price,
        input.failedFillAmountSubunits,
        input.sourceOrder.timeInForce,
        input.resubmitAttempt + 1,
      )
      await this.onResubmitted?.({
        marketId: input.sourceOrder.marketId,
        orderId: result.orderId,
        response: submittedResponse ?? { orderId: result.orderId },
      })
      await markRecoverySubmitted(tradeId, result.orderId)
    } finally {
      this.inFlightTradeIds.delete(tradeId)
    }
  }

  async resumePending(state: DaemonState): Promise<void> {
    const pendingTradeIds = Object.values(state.swaps)
      .filter((swap) => swap.takerRecovery?.status !== 'submitted')
      .map((swap) => swap.tradeId)
      .sort()
    for (const tradeId of pendingTradeIds) {
      await this.recoverTrade(tradeId)
    }
  }
}

function buildRecoveryInput(
  swap: LocalSwapRecord | undefined,
  order: LocalOrderRecord | undefined,
): {
  deadlineMs: number
  failedFillAmountSubunits: number
  resubmitAttempt: number
  sourceOrder: {
    marketId: string
    outcomeId: string
    tokenSide: 'Outcome' | 'Complement'
    side: 'Buy' | 'Sell'
    price: number
    timeInForce: 'FAK' | 'FOK' | 'GTC'
  }
} | null {
  const failedFillAmountSubunits = swap?.fillAmountSubunits
  if (
    !swap ||
    !order ||
    typeof failedFillAmountSubunits !== 'number' ||
    !Number.isSafeInteger(failedFillAmountSubunits) ||
    failedFillAmountSubunits <= 0 ||
    !canRecoverFailedTakerFill({
      failureReason: swap.failureReason,
      isTaker: swap.isTaker === true,
      failedFillAmountSubunits,
    }) ||
    typeof swap.buyerLocktime !== 'number' ||
    !Number.isSafeInteger(swap.buyerLocktime) ||
    !order.tokenSide ||
    !order.side ||
    typeof order.priceSubunits !== 'number' ||
    !Number.isSafeInteger(order.priceSubunits) ||
    !order.timeInForce
  ) {
    return null
  }
  const separator = order.marketId.lastIndexOf('-')
  if (separator <= 0 || separator === order.marketId.length - 1) return null

  return {
    deadlineMs: swap.buyerLocktime * 1_000,
    failedFillAmountSubunits,
    resubmitAttempt: order.recoveryAttempt ?? 0,
    sourceOrder: {
      marketId: order.marketId,
      outcomeId: order.marketId.slice(separator + 1),
      tokenSide: order.tokenSide,
      side: order.side,
      price: order.priceSubunits,
      timeInForce: order.timeInForce,
    },
  }
}

async function reserveRecoveryAttempt(
  tradeId: string,
  newClientOrderId: () => string,
): Promise<LocalSwapRecord | null> {
  return updateState((state, now) => {
    const swap = state.swaps[tradeId]
    if (!swap || swap.takerRecovery?.status === 'submitted') return null
    if (!swap.takerRecovery) {
      swap.takerRecovery = {
        clientOrderId: newClientOrderId(),
        status: 'pending',
      }
      swap.updatedAt = now
    }
    return structuredClone(swap)
  })
}

async function markRecoverySubmitted(
  tradeId: string,
  replacementOrderId: string,
): Promise<void> {
  await updateState((state, now) => {
    const swap = state.swaps[tradeId]
    if (!swap?.takerRecovery) return
    swap.takerRecovery = {
      ...swap.takerRecovery,
      status: 'submitted',
      replacementOrderId,
    }
    swap.updatedAt = now
  })
}
