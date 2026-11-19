import assert from 'node:assert/strict'
import test from 'node:test'
import { hashToCurve } from '@cashu/cashu-ts'
import {
  CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX,
  classifyCtfRangeSourceRecovery,
  type CtfRangeSourceRecoveryInput,
} from '../src/ctfRangeSourceRecovery.ts'

const KEYSET_ID = `01${'aa'.repeat(32)}`
const A = { id: KEYSET_ID, secret: 'input-a' }
const B = { id: KEYSET_ID, secret: 'input-b' }
const FOREIGN = { id: KEYSET_ID, secret: 'foreign' }

function inputY(input: { readonly secret: string }): string {
  return hashToCurve(new TextEncoder().encode(input.secret)).toHex(true)
}

/** A NUT-07 reading with one entry for each listed input, in the listed order. */
function reading(...entries: Array<readonly [{ readonly secret: string }, unknown]>) {
  return entries.map(([input, state]) => ({ Y: inputY(input), state, witness: null }))
}

const PREPARED_SOURCE: CtfRangeSourceRecoveryInput = {
  journalKind: 'authorization-source',
  journalState: 'prepared',
  inputs: [A],
  inputStates: reading([A, 'UNSPENT']),
  now: 99,
  authorizationExpiry: 100,
}

test('classifies completed and failed journals without mint effects', () => {
  assert.deepEqual(
    classifyCtfRangeSourceRecovery({
      ...PREPARED_SOURCE,
      journalState: 'completed',
      inputs: [],
      inputStates: [],
    }),
    { kind: 'reuse-completed' },
  )
  assert.deepEqual(
    classifyCtfRangeSourceRecovery({
      ...PREPARED_SOURCE,
      journalState: 'failed',
      inputs: [],
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
        inputs: [],
        inputStates: [],
      }),
    /failure reason/,
  )
})

test('replays exact unspent source inputs before, at, and after authorization expiry', () => {
  for (const now of [99, 100, 101]) {
    assert.deepEqual(classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, now }), {
      kind: 'replay-exact-persisted-operation',
    })
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
      inputs: [A, B],
      inputStates: reading([A, 'UNSPENT'], [B, 'UNSPENT']),
      now: Number.MAX_SAFE_INTEGER,
    }),
    { kind: 'replay-exact-persisted-operation' },
  )
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        journalKind: 'consolidation',
        journalState: 'prepared',
        inputs: [A],
        inputStates: reading([A, 'UNSPENT']),
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
        inputs: [A, B],
        inputStates: reading([A, 'SPENT'], [B, 'SPENT']),
        now: 200,
        ...(journalKind === 'authorization-source' ? { authorizationExpiry: 100 } : {}),
      }),
      { kind: 'restore-exact-persisted-outputs' },
    )
  }
})

test('keeps pending, mixed, and unknown observations nonterminal', () => {
  const cases = [
    { inputStates: reading([A, 'UNSPENT'], [B, 'PENDING']), reason: 'pending-input-state' },
    { inputStates: reading([A, 'SPENT'], [B, 'PENDING']), reason: 'pending-input-state' },
    { inputStates: reading([A, 'UNSPENT'], [B, 'SPENT']), reason: 'mixed-input-states' },
    { inputStates: reading([A, 'UNSPENT'], [B, 'UNKNOWN']), reason: 'unknown-input-state' },
    { inputStates: reading([A, 'SPENT'], [B, 'spent']), reason: 'unknown-input-state' },
  ] as const

  for (const { inputStates, reason } of cases) {
    assert.deepEqual(
      classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, inputs: [A, B], inputStates, now: 200 }),
      { kind: 'remain-pending', reason },
    )
  }
})

test('keeps a reading that does not hold each exact input Y once pending', () => {
  // A positional reading of each case would restore, replay, or report mixed states.
  const cases: Array<[string, unknown]> = [
    ['missing', reading([A, 'SPENT'])],
    ['extra', reading([A, 'SPENT'], [B, 'SPENT'], [FOREIGN, 'SPENT'])],
    ['duplicate', reading([A, 'SPENT'], [A, 'SPENT'])],
    ['conflicting duplicate', reading([A, 'UNSPENT'], [A, 'SPENT'])],
    ['foreign', reading([A, 'UNSPENT'], [FOREIGN, 'UNSPENT'])],
    ['states without Y', ['SPENT', 'SPENT']],
  ]
  for (const journalKind of ['authorization-source', 'consolidation'] as const) {
    for (const [name, inputStates] of cases) {
      assert.deepEqual(
        classifyCtfRangeSourceRecovery({
          journalKind,
          journalState: 'prepared',
          inputs: [A, B],
          inputStates,
          now: 200,
        }),
        { kind: 'remain-pending', reason: 'input-state-mismatch' },
        `${journalKind}: ${name}`,
      )
    }
  }
})

test('classifies a reordered reading by Y', () => {
  const classify = (inputStates: unknown) =>
    classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, inputs: [A, B], inputStates, now: 200 })
  assert.deepEqual(classify(reading([B, 'SPENT'], [A, 'SPENT'])), {
    kind: 'restore-exact-persisted-outputs',
  })
  assert.deepEqual(classify(reading([B, 'UNSPENT'], [A, 'UNSPENT'])), {
    kind: 'replay-exact-persisted-operation',
  })
  assert.deepEqual(classify(reading([B, 'PENDING'], [A, 'SPENT'])), {
    kind: 'remain-pending',
    reason: 'pending-input-state',
  })
})

test('is total across homogeneous input counts up to the journal bound', () => {
  for (const count of [1, 2, 128, CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX]) {
    const inputs = Array.from({ length: count }, (_, index) => ({
      id: KEYSET_ID,
      secret: `input-${index}`,
    }))
    const states = (state: string) => inputs.map((input) => [input, state] as const)
    assert.equal(
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        inputs,
        inputStates: reading(...states('UNSPENT')),
      }).kind,
      'replay-exact-persisted-operation',
    )
    assert.equal(
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        inputs,
        inputStates: reading(...states('SPENT')),
      }).kind,
      'restore-exact-persisted-outputs',
    )
  }
})

test('rejects malformed persisted authority and unbounded inputs', () => {
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
  const unbounded = Array.from({ length: CTF_RANGE_SOURCE_RECOVERY_INPUT_LIMIT_MAX + 1 }, () => A)
  for (const inputs of [[], unbounded, 'input-a' as never]) {
    assert.throws(
      () => classifyCtfRangeSourceRecovery({ ...PREPARED_SOURCE, inputs }),
      /input count/,
    )
  }
  assert.throws(
    () =>
      classifyCtfRangeSourceRecovery({
        ...PREPARED_SOURCE,
        inputs: [{ id: `02${'aa'.repeat(32)}`, secret: 'input-a' }],
      }),
    /keyset ID/,
  )
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
        inputs: unbounded,
        inputStates: [],
      }),
    /input count/,
  )
})
