import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceEmergencySeedRecoveryCursor,
  classifyEmergencySeedRecoveryProof,
  commitEmergencySeedRecoveryBatch,
  createEmergencySeedRecoveryCoCommit,
  createEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCursor,
  validateEmergencySeedRecoveryCoCommit,
} from '../src/emergencySeedRecovery.ts'
import { advanceSeedScan, classifySeedRecoveryMintState } from '../src/seedRecoveryCore.ts'

function cursor() {
  return createEmergencySeedRecoveryCursor({
    recoveryId: 'recovery-1',
    walletScopeId: `custody:wallet:${'a'.repeat(64)}`,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-1',
  })
}

test('ordinary seed recovery advances exactly and stops after the trailing gap', () => {
  const afterSignature = advanceEmergencySeedRecoveryCursor(cursor(), {
    expectedRevision: 0,
    startCounter: 0,
    requestedCount: 300,
    lastCounterWithSignature: 298,
    scanThroughCounter: 300,
  })
  assert.deepEqual(
    {
      nextCounter: afterSignature.nextCounter,
      trailingEmptyCounters: afterSignature.trailingEmptyCounters,
      state: afterSignature.state,
    },
    { nextCounter: 300, trailingEmptyCounters: 1, state: 'active' },
  )

  const completed = advanceEmergencySeedRecoveryCursor(afterSignature, {
    expectedRevision: 1,
    startCounter: 300,
    requestedCount: 300,
    lastCounterWithSignature: null,
    scanThroughCounter: 600,
  })
  assert.deepEqual(
    {
      nextCounter: completed.nextCounter,
      trailingEmptyCounters: completed.trailingEmptyCounters,
      state: completed.state,
    },
    { nextCounter: 600, trailingEmptyCounters: 301, state: 'completed' },
  )
})

test('ordinary seed recovery stays active until it reaches the scan-through target', () => {
  let active = cursor()
  for (const startCounter of [0, 300, 600, 900]) {
    active = advanceEmergencySeedRecoveryCursor(active, {
      expectedRevision: active.revision,
      startCounter,
      requestedCount: 300,
      lastCounterWithSignature: null,
      scanThroughCounter: 1_500,
    })
  }
  assert.deepEqual(
    {
      nextCounter: active.nextCounter,
      trailingEmptyCounters: active.trailingEmptyCounters,
      state: active.state,
    },
    { nextCounter: 1_200, trailingEmptyCounters: 1_200, state: 'active' },
  )
  const completed = advanceEmergencySeedRecoveryCursor(active, {
    expectedRevision: active.revision,
    startCounter: 1_200,
    requestedCount: 300,
    lastCounterWithSignature: null,
    scanThroughCounter: 1_500,
  })
  assert.equal(completed.state, 'completed')
})

test('ordinary seed recovery rejects stale, oversized, and inconsistent cursors', () => {
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(cursor(), {
        expectedRevision: 1,
        startCounter: 0,
        requestedCount: 1,
        lastCounterWithSignature: null,
        scanThroughCounter: 1,
      }),
    /revision is stale/,
  )
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(cursor(), {
        expectedRevision: 0,
        startCounter: 300,
        requestedCount: 300,
        lastCounterWithSignature: null,
        scanThroughCounter: 300,
      }),
    /stale counter/,
  )
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(cursor(), {
        expectedRevision: 0,
        startCounter: 0,
        requestedCount: 301,
        lastCounterWithSignature: null,
        scanThroughCounter: 301,
      }),
    /batch size/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCursor({
        ...cursor(),
        state: 'completed',
      }),
    /completion state/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCursor({
        ...cursor(),
        foreignAuthority: true,
      } as never),
    /foreign fields/,
  )
})

test('completed recovery continues only to satisfy a higher scan-through target', () => {
  const completed = advanceEmergencySeedRecoveryCursor(cursor(), {
    expectedRevision: 0,
    startCounter: 0,
    requestedCount: 300,
    lastCounterWithSignature: null,
    scanThroughCounter: 300,
  })
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(completed, {
        expectedRevision: 1,
        startCounter: 300,
        requestedCount: 1,
        lastCounterWithSignature: null,
        scanThroughCounter: 300,
      }),
    /already completed/,
  )
  assert.equal(
    advanceEmergencySeedRecoveryCursor(completed, {
      expectedRevision: 1,
      startCounter: 300,
      requestedCount: 300,
      lastCounterWithSignature: null,
      scanThroughCounter: 600,
    }).nextCounter,
    600,
  )
  assert.throws(
    () =>
      advanceEmergencySeedRecoveryCursor(cursor(), {
        expectedRevision: 0,
        startCounter: 0,
        requestedCount: 1,
        lastCounterWithSignature: null,
        scanThroughCounter: -1,
      }),
    /scan-through counter/,
  )
})

test('only NUT-07 unspent proofs become selectable', () => {
  assert.equal(classifyEmergencySeedRecoveryProof('UNSPENT'), 'import-selectable')
  assert.equal(classifyEmergencySeedRecoveryProof('SPENT'), 'ignore-spent')
  assert.equal(classifyEmergencySeedRecoveryProof('PENDING'), 'retain-nonselectable')
  assert.equal(classifyEmergencySeedRecoveryProof('UNKNOWN'), 'fail-closed')
  assert.equal(classifyEmergencySeedRecoveryProof('FOREIGN'), 'fail-closed')
})

test('recovery cursor requires canonical mint origin and bounded coherent fields', () => {
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCursor({
        ...cursor(),
        mintUrl: 'https://user:password@mint.example',
      }),
    /normalized mint/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCursor({
        ...cursor(),
        keysetId: 'x'.repeat(4_097),
      }),
    /keyset id/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCursor({
        ...cursor(),
        nextCounter: 1,
        trailingEmptyCounters: 2,
      }),
    /counters are inconsistent/,
  )
})

test('ordinary cursor delegates to the shared exact scan core', () => {
  const scan = advanceSeedScan(
    {
      startCounter: 9,
      nextCounter: 9,
      totalRequestedOutputs: 0,
      totalReturnedProofs: 0,
      consecutiveEmptyOutputs: 0,
    },
    { startCounter: 9, requestedCount: 3, returnedCounterOffsets: [1] },
    { maxBatchSize: 300, maxTotalOutputs: 300 },
  )
  assert.deepEqual(scan, {
    startCounter: 9,
    nextCounter: 12,
    totalRequestedOutputs: 3,
    totalReturnedProofs: 1,
    consecutiveEmptyOutputs: 1,
  })
  assert.equal(classifySeedRecoveryMintState('PENDING'), 'retain-nonselectable')
})

test('recovery co-commit binds live fencing, exact cursor CAS, and proof batch', async () => {
  const current = cursor()
  const coCommit = createEmergencySeedRecoveryCoCommit({
    cursor: current,
    observation: {
      expectedRevision: 0,
      startCounter: 0,
      requestedCount: 2,
      lastCounterWithSignature: 1,
      scanThroughCounter: 2,
    },
    recoveredProofIds: ['1'.repeat(64), '2'.repeat(64)],
    recoveryJobId: 'recovery-job-1',
    authority: {
      walletScopeId: current.walletScopeId,
      incarnationId: 'process-1',
      fencingEpoch: 1,
      observedAtMs: 5,
      leaseExpiresAtMs: 10,
      effectiveClockHighWaterMarkMs: 4,
    },
  })
  let committed: unknown = null
  await commitEmergencySeedRecoveryBatch(
    {
      commitRecoveryBatch: async (input) => {
        committed = input
      },
    },
    coCommit,
  )
  assert.deepEqual(committed, coCommit)
  assert.equal(coCommit.nextCursor.revision, 1)
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCoCommit({
        ...coCommit,
        expectedCursorRevision: 1,
      }),
    /cursor CAS/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCoCommit({
        ...coCommit,
        recoveredProofIds: ['1'.repeat(64), '1'.repeat(64)],
      }),
    /proof batch is inconsistent/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCoCommit({
        ...coCommit,
        authority: {
          ...coCommit.authority,
          observedAtMs: coCommit.authority.leaseExpiresAtMs,
        },
      }),
    /not live/,
  )
  assert.throws(
    () =>
      validateEmergencySeedRecoveryCoCommit({
        ...coCommit,
        nextCursor: {
          ...coCommit.nextCursor,
          nextCounter: coCommit.nextCursor.nextCounter + 1,
        },
      }),
    /cursor is inconsistent/,
  )
})
