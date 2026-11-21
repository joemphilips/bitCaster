import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CtfRangeOrderLookupSchedule,
  ctfRangeOrderLookupDelayMs,
  projectCtfRangeOrderAdmissionResponse,
  projectCtfRangeOrderLookup,
  recoverCtfRangeOrderRequest,
  type CtfRangeOrderAdmissionIdentity,
} from '../src/ctfRangeOrderAdmission.ts'
import {
  EngineClientError,
  type OrderLookupResponse,
  type SettlementCapabilityResponse,
  type SubmitOrderResponse,
} from '../src/engineClient.ts'

const CONDITION_ID = 'a'.repeat(64)
const EXPIRY_SECONDS = 2_000_000_300
const START_MS = 2_000_000_000_000

const IDENTITY: CtfRangeOrderAdmissionIdentity = {
  rangeOperationId: 'range-1',
  conditionId: CONDITION_ID,
  clientOrderId: 'client-1',
  marketId: `${CONDITION_ID}-Alpha`,
  artifactDigest: 'c'.repeat(64),
  authorizationExpiresAtUnixSeconds: EXPIRY_SECONDS,
}

const REFERENCE = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  bindingDigest: 'b'.repeat(64),
}
const ORDER_ID = '22222222-2222-4222-8222-222222222222'
const CAPABILITY = {
  artifactId: REFERENCE.artifactId,
  bindingDigest: REFERENCE.bindingDigest,
  artifactDigest: IDENTITY.artifactDigest,
  orderId: ORDER_ID,
}

function lookup(overrides: Partial<OrderLookupResponse> = {}): OrderLookupResponse {
  return {
    orderId: ORDER_ID,
    marketId: IDENTITY.marketId,
    status: 'accepted',
    settlementCapability: REFERENCE,
    artifactDigest: IDENTITY.artifactDigest,
    ...overrides,
  }
}

function admissionResponse(
  capability: Partial<SettlementCapabilityResponse> | null,
): SubmitOrderResponse {
  return {
    orderId: ORDER_ID,
    status: 'filled',
    remainingAmountSubunits: 0,
    fills: [],
    baseAsset: 'sat',
    divisibility: 1_000,
    activeSettlementGroup: null,
    ...(capability === null
      ? {}
      : {
          settlementCapability: {
            reference: REFERENCE,
            orderId: ORDER_ID,
            clientOrderId: IDENTITY.clientOrderId,
            marketId: IDENTITY.marketId,
            artifactDigest: IDENTITY.artifactDigest,
            state: 'bound',
            version: 1,
            authorizationExpiresAt: '2033-05-18T03:38:20.000Z',
            stageExpiresAt: '2033-05-18T03:39:20.000Z',
            settlementGroup: null,
            ...capability,
          },
        }),
  }
}

test('the lookup backoff starts at 5 seconds, doubles after each read, and stops at 60 seconds', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 40].map(ctfRangeOrderLookupDelayMs),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000],
  )
  for (const invalid of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => ctfRangeOrderLookupDelayMs(invalid), /read count/)
  }
})

test('an accepted admission response gives the capability only for the local artifact', () => {
  assert.deepEqual(
    projectCtfRangeOrderAdmissionResponse(admissionResponse({}), IDENTITY),
    CAPABILITY,
  )
  for (const state of ['bindingPending', 'bound', 'selected', 'uncertain', 'terminal'] as const) {
    assert.deepEqual(
      projectCtfRangeOrderAdmissionResponse(admissionResponse({ state }), IDENTITY),
      CAPABILITY,
    )
  }
  for (const foreign of [
    null,
    { artifactDigest: 'd'.repeat(64) },
    { clientOrderId: 'client-2' },
    { marketId: `${CONDITION_ID}-Beta` },
    { orderId: '33333333-3333-4333-8333-333333333333' },
    { state: 'staged' as const },
    { state: 'quarantined' as const },
  ]) {
    assert.throws(
      () => projectCtfRangeOrderAdmissionResponse(admissionResponse(foreign), IDENTITY),
      /admission response/,
      JSON.stringify(foreign),
    )
  }
})

test('a found order binds only when its artifact digest equals the local digest', () => {
  assert.deepEqual(projectCtfRangeOrderLookup(lookup(), IDENTITY), CAPABILITY)
  assert.deepEqual(
    projectCtfRangeOrderLookup(lookup({ status: 'processed' }), IDENTITY),
    CAPABILITY,
  )
  assert.equal(
    projectCtfRangeOrderLookup(lookup({ artifactDigest: 'd'.repeat(64) }), IDENTITY),
    null,
  )
  assert.equal(
    projectCtfRangeOrderLookup(lookup({ marketId: `${CONDITION_ID}-Beta` }), IDENTITY),
    null,
  )
})

function recovery(
  schedule: CtfRangeOrderLookupSchedule,
  nowMs: number,
  found: OrderLookupResponse | null,
) {
  const reads: Array<[string, string]> = []
  return {
    reads,
    result: recoverCtfRangeOrderRequest({
      identity: IDENTITY,
      nowMs,
      schedule,
      lookupOrder: async (conditionId, clientOrderId) => {
        reads.push([conditionId, clientOrderId])
        return found
      },
    }),
  }
}

test('a found order with the local digest moves to order-submitted', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  const { reads, result } = recovery(schedule, START_MS, lookup())
  assert.deepEqual(await result, { kind: 'submitted', capability: CAPABILITY })
  assert.deepEqual(reads, [[CONDITION_ID, IDENTITY.clientOrderId]])
})

test('a digest mismatch keeps order-requested and reads again on the backoff', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  const first = recovery(schedule, START_MS, lookup({ artifactDigest: 'd'.repeat(64) }))
  assert.deepEqual(await first.result, {
    kind: 'pending',
    reason: 'digest-mismatch',
    retryAtMs: START_MS + 5_000,
  })
})

test('not found before expiry is not definitive: reads follow 5, 10, 20, 40, 60 and 60 seconds', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  let nowMs = START_MS
  const readTimes: number[] = []
  for (let read = 0; read < 6; read += 1) {
    const due = recovery(schedule, nowMs, null)
    const result = await due.result
    assert.equal(due.reads.length, 1)
    assert.ok(result.kind === 'pending' && result.reason === 'not-found')
    readTimes.push(nowMs)
    // A pass before the next read time sends no request.
    const early = recovery(schedule, result.retryAtMs - 1, null)
    assert.deepEqual(await early.result, {
      kind: 'pending',
      reason: 'waiting',
      retryAtMs: result.retryAtMs,
    })
    assert.equal(early.reads.length, 0)
    nowMs = result.retryAtMs
  }
  const gaps = readTimes.slice(1).map((time, index) => time - readTimes[index]!)
  assert.deepEqual(gaps, [5_000, 10_000, 20_000, 40_000, 60_000])
})

test('the next read never waits past authorization expiry', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  const nearExpiry = EXPIRY_SECONDS * 1_000 - 2_000
  const { result } = recovery(schedule, nearExpiry, null)
  assert.deepEqual(await result, {
    kind: 'pending',
    reason: 'not-found',
    retryAtMs: EXPIRY_SECONDS * 1_000,
  })
})

test('at or after authorization expiry no order request is sent and the refund path runs', async () => {
  for (const nowMs of [EXPIRY_SECONDS * 1_000, EXPIRY_SECONDS * 1_000 + 1]) {
    const schedule = new CtfRangeOrderLookupSchedule()
    const { reads, result } = recovery(schedule, nowMs, lookup())
    assert.deepEqual(await result, { kind: 'expired' })
    assert.equal(reads.length, 0)
  }
})

test('a failed lookup still counts as a read, so the backoff spaces the next one', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  await assert.rejects(
    recoverCtfRangeOrderRequest({
      identity: IDENTITY,
      nowMs: START_MS,
      schedule,
      lookupOrder: async () => {
        throw new Error('engine unavailable')
      },
    }),
    /engine unavailable/,
  )
  const { reads, result } = recovery(schedule, START_MS + 4_999, lookup())
  assert.deepEqual(await result, {
    kind: 'pending',
    reason: 'waiting',
    retryAtMs: START_MS + 5_000,
  })
  assert.equal(reads.length, 0)
})

test('the schedule holds a bounded number of operations', () => {
  const schedule = new CtfRangeOrderLookupSchedule({ maxOperations: 2 })
  schedule.recordRead('one', START_MS)
  schedule.recordRead('two', START_MS)
  schedule.recordRead('three', START_MS)
  // The oldest entry left; it is due again, which only allows an earlier read.
  assert.deepEqual(schedule.state('one', START_MS), { kind: 'due' })
  assert.deepEqual(schedule.state('three', START_MS), {
    kind: 'waiting',
    nextReadAtMs: START_MS + 5_000,
  })
  schedule.forget('three')
  assert.deepEqual(schedule.state('three', START_MS), { kind: 'due' })
})

test('a rate-limited lookup waits for Retry-After and is not a counted read', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  const limited = async () => {
    throw new EngineClientError(429, '{}', 'order-lookup-limited', undefined, 90)
  }
  assert.deepEqual(
    await recoverCtfRangeOrderRequest({
      identity: IDENTITY,
      nowMs: START_MS,
      schedule,
      lookupOrder: limited,
    }),
    { kind: 'pending', reason: 'rate-limited', retryAtMs: START_MS + 90_000 },
  )
  // No read before Retry-After.
  const early = recovery(schedule, START_MS + 89_999, null)
  assert.deepEqual(await early.result, {
    kind: 'pending',
    reason: 'waiting',
    retryAtMs: START_MS + 90_000,
  })
  assert.equal(early.reads.length, 0)
  // The refused read was not counted: the first counted read waits 5 seconds.
  const due = recovery(schedule, START_MS + 90_000, null)
  assert.deepEqual(await due.result, {
    kind: 'pending',
    reason: 'not-found',
    retryAtMs: START_MS + 95_000,
  })
  assert.equal(due.reads.length, 1)
})

test('a rate-limited lookup without Retry-After waits at least the next backoff step', async () => {
  const schedule = new CtfRangeOrderLookupSchedule()
  await recovery(schedule, START_MS, null).result
  const result = await recoverCtfRangeOrderRequest({
    identity: IDENTITY,
    nowMs: START_MS + 5_000,
    schedule,
    lookupOrder: async () => {
      throw new EngineClientError(429, '')
    },
  })
  // One read is counted, so the next step is 10 seconds.
  assert.deepEqual(result, {
    kind: 'pending',
    reason: 'rate-limited',
    retryAtMs: START_MS + 15_000,
  })
  const nearExpiry = await recoverCtfRangeOrderRequest({
    identity: IDENTITY,
    nowMs: EXPIRY_SECONDS * 1_000 - 1_000,
    schedule: new CtfRangeOrderLookupSchedule(),
    lookupOrder: async () => {
      throw new EngineClientError(429, '{}', undefined, undefined, 600)
    },
  })
  assert.deepEqual(nearExpiry, {
    kind: 'pending',
    reason: 'rate-limited',
    retryAtMs: EXPIRY_SECONDS * 1_000,
  })
})
