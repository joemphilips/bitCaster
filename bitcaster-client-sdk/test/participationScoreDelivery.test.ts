import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createParticipationScoreDeliveryMetadata,
  createParticipationScoreDeliverySubmission,
  deriveParticipationScoreProductBinding,
  participationScoreDeliveryIntent,
} from '../src/participationScoreDelivery.ts'

const input = {
  deliveryId: '123e4567-e89b-42d3-a456-426614174000',
  accountSubject: 'a'.repeat(64),
  mintUrl: 'https://mint.example',
  requestedAmount: '21',
}

test('builds one canonical Participation Score durable-recipient binding', () => {
  const metadata = createParticipationScoreDeliveryMetadata(input)
  assert.equal(metadata.destinationId, input.deliveryId)
  assert.equal(metadata.purpose, 'participation-score')
  assert.equal(metadata.unit, 'sat')
  assert.equal(metadata.creditPolicy, 'exact-amount')
  assert.equal(metadata.productBindingSha256, deriveParticipationScoreProductBinding())
  assert.equal(metadata.productBindingSha256.length, 64)
  assert.deepEqual(
    participationScoreDeliveryIntent({
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

test('uses the fixed domain-separated binding for every Score payment', () => {
  assert.equal(
    deriveParticipationScoreProductBinding(),
    createParticipationScoreDeliveryMetadata({
      ...input,
      deliveryId: crypto.randomUUID(),
      accountSubject: 'b'.repeat(64),
      requestedAmount: '22',
    }).productBindingSha256,
  )
})

test('requires canonical identifiers, exact positive sats, and a canonical token', () => {
  assert.throws(
    () => createParticipationScoreDeliveryMetadata({ ...input, requestedAmount: '0' }),
    /requested amount/,
  )
  assert.throws(
    () =>
      createParticipationScoreDeliveryMetadata({
        ...input,
        deliveryId: input.deliveryId.toUpperCase(),
      }),
    /delivery id/,
  )
  const metadata = createParticipationScoreDeliveryMetadata(input)
  assert.equal(
    createParticipationScoreDeliverySubmission({ metadata, token: 'cashuBabc123' }).token,
    'cashuBabc123',
  )
  assert.throws(
    () => createParticipationScoreDeliverySubmission({ metadata, token: 'cashuAwrong' }),
    /token/,
  )
})
