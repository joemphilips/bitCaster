import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isRetryableTransportError,
  recoverFailedTakerFill,
  retryTransientTradeOperation,
  type TakerFillRecoveryRequest,
} from '../src/tradeRecovery.ts'

function baseRequest(overrides: Partial<TakerFillRecoveryRequest> = {}): TakerFillRecoveryRequest {
  return {
    failureReason: 'maker-collateral-failure',
    isTaker: true,
    deadlineMs: 10_000,
    sourceOrder: {
      marketId: 'condition-YES',
      outcomeId: 'YES',
      tokenSide: 'Outcome',
      side: 'Buy',
      price: 75,
      timeInForce: 'FAK',
    },
    failedFillAmountSubunits: 1_000,
    resubmitAttempt: 0,
    submitOrder: async () => ({ orderId: 'recovered-order' }),
    newClientOrderId: () => 'recovery-client-order',
    now: () => 1_000,
    delay: async () => undefined,
    ...overrides,
  }
}

test('recoverFailedTakerFill retries a transient submission with one stable idempotency key', async () => {
  const submitted: Array<{ marketId: string; request: Record<string, unknown> }> = []
  let calls = 0
  const result = await recoverFailedTakerFill(baseRequest({
    submitOrder: async (marketId, request) => {
      submitted.push({ marketId, request })
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return { orderId: 'recovered-order' }
    },
  }))

  assert.equal(result.kind, 'resubmitted')
  assert.equal(submitted.length, 2)
  assert.deepEqual(submitted[0], {
    marketId: 'condition-YES',
    request: {
      outcomeId: 'YES',
      tokenSide: 'Outcome',
      side: 'Buy',
      price: 75,
      amountSubunits: 1_000,
      timeInForce: 'FAK',
      clientOrderId: 'recovery-client-order',
    },
  })
  assert.deepEqual(submitted[1], submitted[0])
})

test('retryTransientTradeOperation retries only transport failures before its deadline', async () => {
  let calls = 0
  const result = await retryTransientTradeOperation({
    deadlineMs: 10_000,
    operation: async () => {
      calls += 1
      if (calls === 1) throw new Error('TradeHub not connected')
      return 'sent'
    },
    now: () => 1_000,
    delay: async () => undefined,
  })

  assert.deepEqual(result, { kind: 'completed', value: 'sent' })
  assert.equal(calls, 2)
})

test('retryTransientTradeOperation retries an idempotent same-trade tag reservation race', async () => {
  let calls = 0
  const result = await retryTransientTradeOperation({
    deadlineMs: 10_000,
    operation: async () => {
      calls += 1
      if (calls === 1) {
        throw new Error(
          'HubException: Failed to reserve tags: Tag trade:10000000000000000000000000000001 is currently reserved',
        )
      }
      return 'sent'
    },
    now: () => 1_000,
    delay: async () => undefined,
  })

  assert.deepEqual(result, { kind: 'completed', value: 'sent' })
  assert.equal(calls, 2)
})

test('retryTransientTradeOperation retries an honest TradeHub rate limit before deadline', async () => {
  let calls = 0
  const result = await retryTransientTradeOperation({
    deadlineMs: 10_000,
    operation: async () => {
      calls += 1
      if (calls === 1) throw new Error('Rate limit exceeded')
      return 'sent'
    },
    now: () => 1_000,
    delay: async () => undefined,
  })

  assert.deepEqual(result, { kind: 'completed', value: 'sent' })
  assert.equal(calls, 2)
})

test('isRetryableTransportError rejects shared-tag reservation conflicts', () => {
  assert.equal(
    isRetryableTransportError(
      new Error('Failed to reserve tags: Tag condition-book:condition-a is currently reserved'),
    ),
    false,
  )
})

test('recoverFailedTakerFill never resubmits an unclassified failure or a maker fill', async () => {
  let calls = 0
  const submitOrder = async () => {
    calls += 1
    return { orderId: 'must-not-submit' }
  }

  assert.deepEqual(
    await recoverFailedTakerFill(baseRequest({
      failureReason: 'settlement-timeout',
      submitOrder,
    })),
    { kind: 'not-recoverable' },
  )
  assert.deepEqual(
    await recoverFailedTakerFill(baseRequest({ isTaker: false, submitOrder })),
    { kind: 'not-recoverable' },
  )
  assert.equal(calls, 0)
})

test('recoverFailedTakerFill stops before the locktime deadline and after its resubmit budget', async () => {
  let calls = 0
  const submitOrder = async () => {
    calls += 1
    return { orderId: 'must-not-submit' }
  }

  assert.deepEqual(
    await recoverFailedTakerFill(baseRequest({ deadlineMs: 1_000, now: () => 1_000, submitOrder })),
    { kind: 'deadline-expired' },
  )
  assert.deepEqual(
    await recoverFailedTakerFill(baseRequest({ resubmitAttempt: 2, maxResubmitAttempts: 2, submitOrder })),
    { kind: 'resubmit-limit-reached' },
  )
  assert.equal(calls, 0)
})

test('recoverFailedTakerFill does not retry an explicit protocol rejection', async () => {
  let calls = 0
  await assert.rejects(
    () => recoverFailedTakerFill(baseRequest({
      submitOrder: async () => {
        calls += 1
        throw new Error('Not authorised to submit this order')
      },
    })),
    /Not authorised/,
  )
  assert.equal(calls, 1)
})

test('isRetryableTransportError rejects programming TypeErrors', () => {
  assert.equal(
    isRetryableTransportError(new TypeError("Cannot read properties of undefined (reading 'id')")),
    false,
  )
})
