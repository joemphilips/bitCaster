import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMarketFundingDeliveryMetadata,
  createMarketFundingDeliverySubmission,
  deriveMarketFundingProductBinding,
  marketFundingDeliveryIntent,
} from '../src/marketFundingDelivery.ts'

const input = {
  deliveryId: '123e4567-e89b-42d3-a456-426614174000',
  accountSubject: 'a'.repeat(64),
  conditionId: 'b'.repeat(64),
  mintUrl: 'https://mint.example',
  unit: 'msat' as const,
  requestedAmount: '100000000',
  divisibility: 10_000,
}

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
    () => createMarketFundingDeliveryMetadata({ ...input, requestedAmount: '10001' }),
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
