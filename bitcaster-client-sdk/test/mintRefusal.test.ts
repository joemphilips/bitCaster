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
  UNCOMMITTED_FINAL_MINT_REFUSAL_CODES,
  classifyCashuMintFailure,
} from '../src/mintRefusal.ts'

// cdk 0.18.2 returns each of these codes before its commit, and the same request bytes can never
// succeed later. The list is the reviewed refusal table, so the test spells it out.
const FINAL_CODES = [
  10001, 11003, 11005, 11007, 11008, 11009, 11010, 12003, 13016, 13017, 13041, 13042,
] as const

test('classifies every reviewed cdk refusal code as an uncommitted final refusal', () => {
  assert.deepEqual([...UNCOMMITTED_FINAL_MINT_REFUSAL_CODES].sort(), [...FINAL_CODES].sort())
  for (const code of FINAL_CODES) {
    assert.deepEqual(classifyCashuMintFailure(new MintOperationError(code, 'refused')), {
      kind: 'final-refusal',
      code,
      detail: 'refused',
    })
  }
})

test('keeps codes that can follow a commit or can succeed later outside the final set', () => {
  // 11001 can follow this request's own lost commit, 11002 an in-flight copy, and the rest
  // depend on mutable mint configuration or time.
  for (const code of [11001, 11002, 11014, 11015, 12001, 12002, 13021, 15001, 15006, 50000]) {
    assert.deepEqual(classifyCashuMintFailure(new MintOperationError(code, 'other')), {
      kind: 'refusal',
      code,
      detail: 'other',
    })
  }
})

test('marks only output reuse codes for counter recovery', () => {
  assert.deepEqual([...MINT_OUTPUT_REUSE_REFUSAL_CODES].sort(), [11003, 11008])
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
    kind: 'final-refusal',
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
