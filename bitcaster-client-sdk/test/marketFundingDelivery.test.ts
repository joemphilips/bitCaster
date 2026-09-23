import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMarketFundingDeliveryMetadata,
  createMarketFundingDeliverySubmission,
  deriveMarketFundingProductBinding,
  marketFundingDeliveryIntent,
  requireMarketFundingActivationAmount,
} from '../src/marketFundingDelivery.ts'

const input = {
  deliveryId: '123e4567-e89b-42d3-a456-426614174000',
  accountSubject: 'a'.repeat(64),
  conditionId: 'b'.repeat(64),
  mintUrl: 'https://mint.example',
  unit: 'msat' as const,
  requestedAmount: '100000000',
  divisibility: 1_000,
}

for (const [outcomeCount, minimumNetMsat] of [
  [2, 1],
  [3, 2],
  [4, 2],
  [5, 2],
  [6, 2],
  [7, 2],
  [8, 3],
]) {
  test(`funding preview preserves the first-activation boundary for ${outcomeCount} outcomes`, () => {
    const grossMsat = 1000
    assert.equal(
      requireMarketFundingActivationAmount({
        grossMsat,
        receiveFeeMsat: grossMsat - minimumNetMsat,
        outcomeCount,
      }),
      minimumNetMsat,
    )
    assert.throws(
      () =>
        requireMarketFundingActivationAmount({
          grossMsat,
          receiveFeeMsat: grossMsat - minimumNetMsat + 1,
          outcomeCount,
        }),
      /too small/,
    )
  })
}

test('funding preview rejects malformed amounts, fees, and outcome counts', () => {
  const valid = { grossMsat: 1000, receiveFeeMsat: 1, outcomeCount: 2 }
  for (const invalid of [
    { grossMsat: 0 },
    { grossMsat: Number.MAX_SAFE_INTEGER + 1 },
    { receiveFeeMsat: -1 },
    { receiveFeeMsat: 0.5 },
    { outcomeCount: 1 },
    { outcomeCount: 9 },
    { outcomeCount: 2.5 },
  ]) {
    assert.throws(() => requireMarketFundingActivationAmount({ ...valid, ...invalid }), /invalid/)
  }
  assert.throws(
    () => requireMarketFundingActivationAmount({ ...valid, receiveFeeMsat: 1001 }),
    /too small/,
  )
})

test('builds one canonical AMM durable-recipient binding', () => {
  const metadata = createMarketFundingDeliveryMetadata(input)
  assert.equal(metadata.destinationId, input.conditionId)
  assert.equal(metadata.creditPolicy, 'net-of-receive-fee')
  assert.equal(metadata.productBindingSha256, deriveMarketFundingProductBinding(input))
  assert.equal(metadata.productBindingSha256.length, 64)
  assert.deepEqual(
    marketFundingDeliveryIntent({
      accountSubject: input.accountSubject,
      productBindingSha256: metadata.productBindingSha256,
      tokenBytesLimit: 1024,
    }),
    {
      policy: 'durable-recipient-ack',
      expectedSubject: input.accountSubject,
      opaqueProductBinding: metadata.productBindingSha256,
      tokenBytesLimit: 1024,
      tokenProofLimit: 512,
    },
  )
})

test('rejects a noncanonical condition or nonexact token authority', () => {
  assert.throws(
    () =>
      createMarketFundingDeliveryMetadata({
        ...input,
        conditionId: input.conditionId.toUpperCase(),
      }),
    /condition id/,
  )
  const metadata = createMarketFundingDeliveryMetadata(input)
  const submission = createMarketFundingDeliverySubmission({ metadata, token: 'cashuBabc123' })
  assert.equal(submission.token, 'cashuBabc123')
  assert.throws(
    () => createMarketFundingDeliverySubmission({ metadata, token: 'not-a-token' }),
    /token/,
  )
  assert.throws(
    () => createMarketFundingDeliveryMetadata({ ...input, requestedAmount: '0' }),
    /requested amount/,
  )
  assert.throws(
    () => createMarketFundingDeliveryMetadata({ ...input, requestedAmount: '1001' }),
    /requested amount/,
  )
  assert.throws(
    () => createMarketFundingDeliveryMetadata({ ...input, requestedAmount: '9007199254740992' }),
    /requested amount/,
  )
  assert.throws(
    () => createMarketFundingDeliveryMetadata({ ...input, divisibility: 1 }),
    /divisibility/,
  )
  assert.throws(
    () =>
      createMarketFundingDeliveryMetadata({
        ...input,
        // Runtime decoders must reject untyped callers before wallet mutation.
        unit: 'sat',
      } as unknown as typeof input),
    /unit must be msat/,
  )
})
