import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX,
  classifyCtfRangeSourceRecovery,
  type CtfRangeSourceRecoveryInput,
} from '../src/ctfRangeSourceRecovery.ts'

const PREPARED_SOURCE: CtfRangeSourceRecoveryInput = {
  journalKind: 'authorization-source',
  journalState: 'prepared',
  inputStates: ['UNSPENT'],
  now: 99,
  authorizationExpiry: 100,
}

test('classifies completed and failed journals without mint effects', () => {
  assert.deepEqual(
    classifyCtfRangeSourceRecovery({
      ...PREPARED_SOURCE,
      journalState: 'completed',
      inputStates: [],
    }),
    { kind: 'reuse-completed' },
  )
  assert.deepEqual(
    classifyCtfRangeSourceRecovery({
      ...PREPARED_SOURCE,
      journalState: 'failed',
      inputStates: [],
      failureReason: 'persisted mint rejection',
    }),
    { kind: 'fail', reason: 'persisted mint rejection' },
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        journalState: 'failed',
        inputStates: [],
      }),
    /failure reason/,
  )
})

test('replays only before expiry and releases exact unspent source inputs at the boundary', () => {
  for (const [now, kind] of [
    [99, 'replay-exact-persisted-operation'],
    [100, 'release-exact-unspent-inputs'],
    [101, 'release-exact-unspent-inputs'],
  ] as const) {
    assert.deepEqual(classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, now }), { kind })
  }
  assert.deepEqual(
    classifyCtfRangeSourceRecovery({
      ...PREPARED_SOURCE,
      authorizationExpiry: null,
    }),
    { kind: 'replay-exact-persisted-operation' },
  )
})

test('consolidation replay has no authorization-expiry release branch', () => {
  assert.deepEqual(
    classifyCtfRangeSourceRecovery({
      journalKind: 'consolidation',
      journalState: 'prepared',
      inputStates: ['UNSPENT', 'UNSPENT'],
      now: Number.MAX_SAFE_INTEGER,
    }),
    { kind: 'replay-exact-persisted-operation' },
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        journalKind: 'consolidation',
        journalState: 'prepared',
        inputStates: ['UNSPENT'],
        now: 100,
        authorizationExpiry: 100,
      }),
    /must not carry authorization expiry/,
  )
})

test('restores only when every exact input is spent', () => {
  for (const journalKind of ['authorization-source', 'consolidation'] as const) {
    assert.deepEqual(
      classifyCtfRangeSourceRecovery({
        journalKind,
        journalState: 'prepared',
        inputStates: ['SPENT', 'SPENT'],
        now: 200,
        ...(journalKind === 'authorization-source' ? { authorizationExpiry: 100 } : {}),
      }),
      { kind: 'restore-exact-persisted-outputs' },
    )
  }
})

test('keeps pending, mixed, and unknown observations nonterminal', () => {
  const cases = [
    {
      inputStates: ['UNSPENT', 'PENDING'],
      reason: 'pending-input-state',
    },
    {
      inputStates: ['SPENT', 'PENDING'],
      reason: 'pending-input-state',
    },
    {
      inputStates: ['UNSPENT', 'SPENT'],
      reason: 'mixed-input-states',
    },
    {
      inputStates: ['UNSPENT', 'UNKNOWN'],
      reason: 'unknown-input-state',
    },
    {
      inputStates: ['SPENT', 'spent'],
      reason: 'unknown-input-state',
    },
  ] as const

  for (const { inputStates, reason } of cases) {
    assert.deepEqual(
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        inputStates,
        now: 200,
      }),
      { kind: 'remain-pending', reason },
    )
  }
})

test('is total across homogeneous input counts up to the journal bound', () => {
  for (let count = 1; count <= CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX; count += 1) {
    assert.equal(
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        inputStates: Array.from({ length: count }, () => 'UNSPENT'),
      }).kind,
      'replay-exact-persisted-operation',
    )
    assert.equal(
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        inputStates: Array.from({ length: count }, () => 'SPENT'),
      }).kind,
      'restore-exact-persisted-outputs',
    )
  }
})

test('rejects malformed persisted authority and unbounded observations', () => {
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        journalKind: 'source' as never,
      }),
    /journal kind/,
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        journalState: 'Prepared' as never,
      }),
    /journal state/,
  )
  for (const inputStates of [
    [],
    Array.from({ length: CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX + 1 }, () => 'UNSPENT'),
  ]) {
    assert.throws(
      () => classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, inputStates }),
      /input count/,
    )
  }
  for (const now of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, now }),
      /observation time/,
    )
  }
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        authorizationExpiry: -1,
      }),
    /authorization expiry/,
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        journalState: 'failed',
        failureReason: ' ',
      }),
    /failure reason/,
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        failureReason: 'foreign failure',
      }),
    /non-failed/,
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        journalState: 'completed',
        inputStates: Array.from(
          { length: CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX + 1 },
          () => 'UNKNOWN',
        ),
      }),
    /input count/,
  )
})
