import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  RateLimitError,
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

test('releases unspent inputs after outputs-signed refusals', () => {
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'outputs-signed',
      inputStates: ['UNSPENT', 'UNSPENT'],
    }),
    { kind: 'release', spentInputIndexes: [] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({ refusal: 'outputs-signed', inputStates: ['SPENT', 'SPENT'] }),
    { kind: 'restore' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'outputs-signed',
      inputStates: ['UNSPENT', 'PENDING'],
    }),
    { kind: 'wait' },
  )
})

test('settles a condition-attested refusal like outputs-signed', () => {
  // An attested condition never permits a convert again, so no copy can commit.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputStates: ['UNSPENT', 'UNSPENT'],
    }),
    { kind: 'release', spentInputIndexes: [] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputStates: ['UNSPENT', 'SPENT'],
    }),
    { kind: 'release', spentInputIndexes: [1] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({ refusal: 'condition-attested', inputStates: ['SPENT'] }),
    { kind: 'restore' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'condition-attested',
      inputStates: ['PENDING', 'UNSPENT'],
    }),
    { kind: 'wait' },
  )
})

test('settles a mixed reading on any coded refusal and keeps an unspent one waiting', () => {
  // A mixed reading proves that this request did not commit and can never commit.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputStates: ['UNSPENT', 'SPENT'],
    }),
    { kind: 'release', spentInputIndexes: [1] },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({ refusal: 'coded-refusal', inputStates: ['SPENT', 'SPENT'] }),
    { kind: 'restore' },
  )
  // With every input unspent, a coded refusal does not prove the request is final.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({ refusal: 'coded-refusal', inputStates: ['UNSPENT'] }),
    { kind: 'wait' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputStates: ['SPENT', 'unknown'],
    }),
    { kind: 'wait' },
  )
  assert.deepEqual(
    decideCtfRangeRequestSettlement({
      refusal: 'coded-refusal',
      inputStates: ['SPENT', 'PENDING'],
    }),
    { kind: 'wait' },
  )
})

test('replays without a refusal unless every input is spent or one is pending', () => {
  assert.deepEqual(decideCtfRangeRequestSettlement({ refusal: null, inputStates: ['UNSPENT'] }), {
    kind: 'replay',
  })
  // A mixed reading replays to obtain the mint's spent-input answer.
  assert.deepEqual(
    decideCtfRangeRequestSettlement({ refusal: null, inputStates: ['SPENT', 'UNSPENT'] }),
    { kind: 'replay' },
  )
  assert.deepEqual(decideCtfRangeRequestSettlement({ refusal: null, inputStates: ['SPENT'] }), {
    kind: 'restore',
  })
  assert.deepEqual(
    decideCtfRangeRequestSettlement({ refusal: null, inputStates: ['PENDING', 'SPENT'] }),
    { kind: 'wait' },
  )
  assert.throws(() => decideCtfRangeRequestSettlement({ refusal: null, inputStates: [] }))
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
