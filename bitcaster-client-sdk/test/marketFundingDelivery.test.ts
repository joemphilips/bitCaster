import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMarketFundingDeliveryMetadata,
  createMarketFundingDeliverySubmission,
  deriveMarketFundingProductBinding,
  executeMarketFundingDelivery,
  marketFundingDeliveryIntent,
  requireMarketFundingActivationAmount,
  type MarketFundingDeliveryPorts,
} from '../src/marketFundingDelivery.ts'
import type { DurableOutgoingCashuTransfer } from '../src/durableOutgoingCashuTransfer.ts'
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
} from '../src/durableRecipientDelivery.ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

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

const token = 'cashuBabc123'
const tokenSha256 = bytesToHex(sha256(new TextEncoder().encode(token)))
const funding = {
  accountSubject: input.accountSubject,
  conditionId: input.conditionId,
  mintUrl: input.mintUrl,
  unit: input.unit,
  divisibility: input.divisibility,
}

function fundingTransfer(
  deliveryId = input.deliveryId,
  predecessorTransferId: string | null = null,
  requestedAmount = input.requestedAmount,
): DurableOutgoingCashuTransfer {
  const metadata = createMarketFundingDeliveryMetadata({
    ...funding,
    deliveryId,
    requestedAmount,
  })
  // Only delivery fields are read by this coordinator. Custody fields belong to the injected adapter.
  return {
    transferId: deliveryId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    requestedAmount,
    recipientSequence: { predecessorTransferId },
    deliveryIntent: marketFundingDeliveryIntent({
      accountSubject: input.accountSubject,
      productBindingSha256: metadata.productBindingSha256,
      tokenBytesLimit: 61_440,
    }),
    token: { encodedToken: token, sha256: tokenSha256, encodedLength: token.length },
  } as DurableOutgoingCashuTransfer
}

function fundingStatus(deliveryId = input.deliveryId, state: 'received' | 'credited' = 'credited') {
  const metadata = createMarketFundingDeliveryMetadata({
    ...funding,
    deliveryId,
    requestedAmount: input.requestedAmount,
  })
  const delivery = { ...metadata, tokenSha256, tokenEncodedLength: token.length }
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(delivery),
    state,
    result: {
      creditedAmount: input.requestedAmount,
      receiveFee: '0',
      creditVerification: 'net-of-receive-fee',
      receiveOperationId: 'receive-1',
      receivedAt: '2026-08-11T00:00:00.000Z',
      ...(state === 'credited'
        ? { businessEventId: 'event-1', businessEventAt: '2026-08-11T00:01:00.000Z' }
        : {}),
    },
  })
}

function fundingPorts(overrides: Partial<MarketFundingDeliveryPorts> = {}) {
  const calls = { prepared: 0, acknowledged: 0, submitted: 0, creditedChecks: 0 }
  const ports: MarketFundingDeliveryPorts = {
    readTransfer: async () => null,
    findSuccessor: async () => null,
    prepareTransfer: async ({ attempt, requireCredited }) => {
      calls.prepared++
      if (attempt.expectedPreviousTransferId !== null) {
        calls.creditedChecks++
        await requireCredited(fundingTransfer(attempt.expectedPreviousTransferId))
      }
      return fundingTransfer(attempt.newAttemptId, attempt.expectedPreviousTransferId)
    },
    recoverTransfer: async () => null,
    getDurableRecipientDeliveryStatus: async () => null,
    submitDurableRecipientDelivery: async (submission) => {
      calls.submitted++
      assert.equal(submission.token, token)
      return fundingStatus(submission.deliveryId)
    },
    acknowledgeRecipient: async ({ transfer }) => {
      calls.acknowledged++
      return transfer
    },
    ...overrides,
  }
  return { ports, calls }
}

test('funding runner prepares and acknowledges a fresh explicit payment', async () => {
  const { ports, calls } = fundingPorts()
  const result = await executeMarketFundingDelivery({
    funding,
    attempt: {
      kind: 'begin',
      expectedPreviousTransferId: null,
      newAttemptId: input.deliveryId,
      requestedAmount: input.requestedAmount,
    },
    ports,
  })
  assert.equal(result.progress, 'credited')
  assert.deepEqual(calls, { prepared: 1, acknowledged: 1, submitted: 1, creditedChecks: 0 })
})

test('funding runner reuses an exact indexed successor without a new payment', async () => {
  const { ports, calls } = fundingPorts({
    findSuccessor: async () => fundingTransfer(),
    getDurableRecipientDeliveryStatus: async () => fundingStatus(),
  })
  const result = await executeMarketFundingDelivery({
    funding,
    attempt: {
      kind: 'begin',
      expectedPreviousTransferId: null,
      newAttemptId: '99999999-9999-4999-8999-999999999999',
      requestedAmount: '200000000',
    },
    ports,
  })
  assert.equal(result.transfer.transferId, input.deliveryId)
  assert.deepEqual(calls, { prepared: 0, acknowledged: 1, submitted: 0, creditedChecks: 0 })
})

test('funding runner recovers a tokenless indexed successor without fresh preparation', async () => {
  const persisted = { ...fundingTransfer(), token: null }
  let recovered = 0
  const { ports, calls } = fundingPorts({
    findSuccessor: async () => persisted,
    recoverTransfer: async (transfer) => {
      assert.equal(transfer.transferId, input.deliveryId)
      recovered++
      return fundingTransfer()
    },
    getDurableRecipientDeliveryStatus: async () => fundingStatus(),
  })
  const result = await executeMarketFundingDelivery({
    funding,
    attempt: {
      kind: 'begin',
      expectedPreviousTransferId: null,
      newAttemptId: '99999999-9999-4999-8999-999999999999',
      requestedAmount: '200000000',
    },
    ports,
  })
  assert.equal(result.transfer.transferId, input.deliveryId)
  assert.equal(recovered, 1)
  assert.deepEqual(calls, { prepared: 0, acknowledged: 1, submitted: 0, creditedChecks: 0 })
  await assert.rejects(
    executeMarketFundingDelivery({
      funding: { ...funding, conditionId: 'c'.repeat(64) },
      attempt: {
        kind: 'resume',
        transferId: input.deliveryId,
      },
      ports: { ...ports, readTransfer: async () => persisted },
    }),
    /product|binding|conflict/,
  )
  assert.equal(recovered, 1)
})

test('funding runner allows a second independent payment only after credited predecessor', async () => {
  const nextId = '99999999-9999-4999-8999-999999999999'
  const { ports, calls } = fundingPorts({
    getDurableRecipientDeliveryStatus: async (deliveryId) =>
      deliveryId === input.deliveryId ? fundingStatus() : null,
  })
  const result = await executeMarketFundingDelivery({
    funding,
    attempt: {
      kind: 'begin',
      expectedPreviousTransferId: input.deliveryId,
      newAttemptId: nextId,
      requestedAmount: input.requestedAmount,
    },
    ports,
  })
  assert.equal(result.transfer.transferId, nextId)
  assert.equal(calls.creditedChecks, 1)
  assert.equal(calls.prepared, 1)
  const received = fundingPorts({
    getDurableRecipientDeliveryStatus: async () => fundingStatus(input.deliveryId, 'received'),
  })
  await assert.rejects(
    executeMarketFundingDelivery({
      funding,
      attempt: {
        kind: 'begin',
        expectedPreviousTransferId: input.deliveryId,
        newAttemptId: nextId,
        requestedAmount: input.requestedAmount,
      },
      ports: received.ports,
    }),
    /not credited/,
  )
})

test('funding runner resolves an uncertain POST from status without a second token plan', async () => {
  let reads = 0
  const { ports, calls } = fundingPorts({
    readTransfer: async () => fundingTransfer(),
    getDurableRecipientDeliveryStatus: async () => (++reads === 1 ? null : fundingStatus()),
    submitDurableRecipientDelivery: async () => {
      throw new Error('network interrupted')
    },
  })
  const result = await executeMarketFundingDelivery({
    funding,
    attempt: { kind: 'resume', transferId: input.deliveryId },
    ports,
  })
  assert.equal(result.progress, 'credited')
  assert.equal(reads, 2)
  assert.equal(calls.prepared, 0)
  assert.equal(calls.acknowledged, 1)
})
