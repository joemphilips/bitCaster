import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  RateLimitError,
  hashToCurve,
} from '@cashu/cashu-ts'
import {
  MINT_OUTPUT_REUSE_REFUSAL_CODES,
  classifyCashuMintFailure,
  decideCtfRangeRequestSettlement,
  settlingMintRefusal,
} from '../src/mintRefusal.ts'

test('classifies every coded mint answer as a refusal', () => {
  for (const code of [10001, 11001, 11002, 11003, 11008, 12002, 13041, 50000]) {
    assert.deepEqual(classifyCashuMintFailure(new MintOperationError(code, 'refused')), {
      kind: 'refusal',
      code,
      detail: 'refused',
    })
  }
})

test('names every coded refusal, and only coded refusals, as settling', () => {
  assert.equal(settlingMintRefusal({ kind: 'refusal', code: 11003, detail: '' }), 'outputs-signed')
  assert.equal(settlingMintRefusal({ kind: 'refusal', code: 11008, detail: '' }), 'outputs-signed')
  assert.equal(
    settlingMintRefusal({ kind: 'refusal', code: 13042, detail: '' }),
    'condition-attested',
  )
  for (const code of [10001, 11001, 11002, 11005, 11007, 12001, 12002, 13041, 50000]) {
    assert.equal(settlingMintRefusal({ kind: 'refusal', code, detail: '' }), 'coded-refusal')
  }
  assert.equal(settlingMintRefusal({ kind: 'transient', retryAfterMs: null }), null)
  assert.deepEqual([...MINT_OUTPUT_REUSE_REFUSAL_CODES].sort(), [11003, 11008])
})

const KEYSET_ID = `01${'aa'.repeat(32)}`
const A = { id: KEYSET_ID, secret: 'input-a' }
const B = { id: KEYSET_ID, secret: 'input-b' }
const FOREIGN = { id: KEYSET_ID, secret: 'foreign' }

/** A NUT-07 reading with one entry for each listed input, in the listed order. */
function reading(...entries: Array<readonly [{ readonly secret: string }, unknown]>) {
  return entries.map(([input, state]) => ({
    Y: hashToCurve(new TextEncoder().encode(input.secret)).toHex(true),
    state,
    witness: null,
  }))
}

test('releases unspent inputs after outputs-signed refusals', () => {
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'outputs-signed',
      inputs: [A, B],
      inputStates: reading([A, 'UNSPENT'], [B, 'UNSPENT']),
    }),
    { kind: 'release', spentInputIndexes: [] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'outputs-signed',
      inputs: [A, B],
      inputStates: reading([A, 'SPENT'], [B, 'SPENT']),
    }),
    { kind: 'restore' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'outputs-signed',
      inputs: [A, B],
      inputStates: reading([A, 'UNSPENT'], [B, 'PENDING']),
    }),
    { kind: 'wait' },
  )
})

test('settles a condition-attested refusal like outputs-signed', () => {
  // An attested condition never permits a convert again, so no copy can commit.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputs: [A, B],
      inputStates: reading([A, 'UNSPENT'], [B, 'UNSPENT']),
    }),
    { kind: 'release', spentInputIndexes: [] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputs: [A, B],
      inputStates: reading([A, 'UNSPENT'], [B, 'SPENT']),
    }),
    { kind: 'release', spentInputIndexes: [1] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputs: [A],
      inputStates: reading([A, 'SPENT']),
    }),
    { kind: 'restore' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputs: [A, B],
      inputStates: reading([A, 'PENDING'], [B, 'UNSPENT']),
    }),
    { kind: 'wait' },
  )
})

test('settles a mixed reading on any coded refusal and keeps an unspent one waiting', () => {
  // A mixed reading proves that this request did not commit and can never commit.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputs: [A, B],
      inputStates: reading([A, 'UNSPENT'], [B, 'SPENT']),
    }),
    { kind: 'release', spentInputIndexes: [1] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputs: [A, B],
      inputStates: reading([A, 'SPENT'], [B, 'SPENT']),
    }),
    { kind: 'restore' },
  )
  // With every input unspent, a coded refusal does not prove the request is final.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputs: [A],
      inputStates: reading([A, 'UNSPENT']),
    }),
    { kind: 'wait' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputs: [A, B],
      inputStates: reading([A, 'SPENT'], [B, 'unknown']),
    }),
    { kind: 'wait' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputs: [A, B],
      inputStates: reading([A, 'SPENT'], [B, 'PENDING']),
    }),
    { kind: 'wait' },
  )
})

test('releases the spent input of a reordered reading by its Y', () => {
  for (const refusal of ['outputs-signed', 'condition-attested', 'coded-refusal'] as const) {
    assert.deepEqual(
      decideCtfRangeRequestSettlement({
        refusal,
        inputs: [A, B],
        inputStates: reading([B, 'SPENT'], [A, 'UNSPENT']),
      }),
      { kind: 'release', spentInputIndexes: [1] },
      refusal,
    )
    assert.deepEqual(
      decideCtfRangeRequestSettlement({
        refusal,
        inputs: [A, B],
        inputStates: reading([B, 'UNSPENT'], [A, 'SPENT']),
      }),
      { kind: 'release', spentInputIndexes: [0] },
      refusal,
    )
  }
})

test('waits on a reading that does not hold each exact input Y once', () => {
  // A positional reading of each case would release or restore the request.
  const cases: Array<[string, unknown]> = [
    ['missing', reading([A, 'SPENT'])],
    ['extra', reading([A, 'UNSPENT'], [B, 'UNSPENT'], [FOREIGN, 'SPENT'])],
    ['duplicate', reading([A, 'UNSPENT'], [A, 'UNSPENT'])],
    ['conflicting duplicate', reading([A, 'UNSPENT'], [A, 'SPENT'])],
    ['foreign', reading([A, 'UNSPENT'], [FOREIGN, 'SPENT'])],
    ['states without Y', ['UNSPENT', 'SPENT']],
    ['not an array', { states: reading([A, 'UNSPENT'], [B, 'SPENT']) }],
  ]
  for (const refusal of ['outputs-signed', 'condition-attested', 'coded-refusal'] as const) {
    for (const [name, inputStates] of cases) {
      assert.deepEqual(
        decideCtfRangeRequestSettlement({ refusal, inputs: [A, B], inputStates }),
        { kind: 'wait' },
        `${refusal}: ${name}`,
      )
    }
  }
})

test('rejects a request without inputs or with an unsupported input keyset', () => {
  assert.throws(
    () =>
      decideCtfRangeRequestSettlement({ refusal: 'coded-refusal', inputs: [], inputStates: [] }),
    /inputs are missing/,
  )
  assert.throws(
    () =>
      decideCtfRangeRequestSettlement({
        refusal: 'coded-refusal',
        inputs: [{ id: `02${'aa'.repeat(32)}`, secret: 'input-a' }],
        inputStates: reading([A, 'SPENT']),
      }),
    /keyset ID/,
  )
})

test('treats network failures, timeouts, 5xx, and rate limits as transient', () => {
  assert.deepEqual(classifyCashuMintFailure(new NetworkError('offline')), {
    kind: 'transient',
    retryAfterMs: null,
  })
  assert.deepEqual(classifyCashuMintFailure(new HttpResponseError('bad gateway', 502)), {
    kind: 'transient',
    retryAfterMs: null,
  })
  assert.deepEqual(classifyCashuMintFailure(new RateLimitError('slow down', 4_000)), {
    kind: 'transient',
    retryAfterMs: 4_000,
  })
  const unavailable = new HttpResponseError('unavailable', 503)
  Object.defineProperty(unavailable, 'retryAfterMs', { value: 9_000 })
  assert.deepEqual(classifyCashuMintFailure(unavailable), {
    kind: 'transient',
    retryAfterMs: 9_000,
  })
  assert.deepEqual(classifyCashuMintFailure(new Error('client failed before the request')), {
    kind: 'transient',
    retryAfterMs: null,
  })
})

test('finds a wrapped mint refusal in the cause chain', () => {
  const wrapped = new Error('wallet swap failed', {
    cause: new MintOperationError(11008, 'Duplicate outputs'),
  })
  assert.deepEqual(classifyCashuMintFailure(wrapped), {
    kind: 'refusal',
    code: 11008,
    detail: 'Duplicate outputs',
  })
})

test('bounds the stored detail and removes long hexadecimal values', () => {
  const blinded = `02${'ab'.repeat(32)}`
  const failure = classifyCashuMintFailure(
    new MintOperationError(
      50000,
      `duplicate key (blinded_message)=(${blinded}) ${'x'.repeat(600)}`,
    ),
  )
  assert.equal(failure.kind, 'refusal')
  if (failure.kind !== 'refusal') return
  assert.equal(failure.detail.includes(blinded), false)
  assert.equal(failure.detail.length <= 256, true)
})
