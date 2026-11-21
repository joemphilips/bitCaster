import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { deriveRecoveryIndexKeys, sealRecoveryIndexDocument } from '../src/recoveryIndexDocument.ts'
import {
  RECOVERY_INDEX_PATH,
  RECOVERY_INDEX_REALMS,
  RecoveryIndexEngineError,
  createRecoveryIndexEngineStore,
  isRecoveryIndexRealm,
  recoveryIndexRequestDigest,
  signRecoveryIndexRequest,
} from '../src/recoveryIndexEngine.ts'
import { RecoveryIndexFakeEngine, problem } from './support/recoveryIndexFakeEngine.ts'

interface RequestVector {
  readonly name: string
  readonly realm: string
  readonly method: 'GET' | 'PUT' | 'DELETE'
  readonly requestPublicKey: string
  readonly body: string
  readonly expectedVersion: number
  readonly issuedAt: number
  readonly digest: string
  readonly auxRand: string
  readonly signature: string
}

const VECTORS = JSON.parse(
  readFileSync(new URL('./fixtures/recovery-index-v1.json', import.meta.url), 'utf8'),
) as { readonly seed: string; readonly requests: readonly RequestVector[] }
const SEED = hexToBytes(VECTORS.seed)
const REALM = RECOVERY_INDEX_REALMS.local
const KEYS = deriveRecoveryIndexKeys(SEED, REALM)
const SECRET_THREE = hexToBytes(`${'00'.repeat(31)}03`)
const NOW_SECONDS = 1_800_000_000

/** ADR-034 "Clarifications (2026-11-13)": the digest that the engine tests pin. */
const ENGINE_PINNED_DIGEST = 'ff7eaaee71d3d049480402306d5dc9317e736f922f67b4aabeef7ef4a7270a1d'

function document(label: number): Uint8Array {
  return sealRecoveryIndexDocument({
    keys: KEYS,
    entries: [
      { kind: 'regular', mintUrl: 'https://mint.example.com', keysetId: `01${'ab'.repeat(32)}` },
    ],
    writtenVersion: label,
  })
}

function store(engine: RecoveryIndexFakeEngine, nowMs = () => NOW_SECONDS * 1000) {
  return createRecoveryIndexEngineStore({
    engineBaseUrl: engine.baseUrl,
    realm: REALM,
    keys: KEYS,
    fetchImpl: engine.fetch,
    nowMs,
  })
}

async function engineError(promise: Promise<unknown>): Promise<RecoveryIndexEngineError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof RecoveryIndexEngineError, 'the store fails with an engine error')
    return error
  }
  throw new Error('the request was expected to fail')
}

test("the SDK request digest equals the engine's pinned digest", () => {
  const digest = recoveryIndexRequestDigest({
    realm: 'bitcaster-test',
    method: 'PUT',
    requestPublicKey: bytesToHex(schnorr.getPublicKey(SECRET_THREE)),
    body: new TextEncoder().encode('recovery index body'),
    expectedVersion: 7,
    issuedAt: 1_700_000_000,
  })
  assert.equal(bytesToHex(digest), ENGINE_PINNED_DIGEST)
  assert.equal(VECTORS.requests[0]!.digest, ENGINE_PINNED_DIGEST)
})

test('the signer gives the golden request digests and signatures', () => {
  const secrets: Record<string, Uint8Array> = {
    'ADR-034 pinned engine vector': SECRET_THREE,
    'seed-derived read': KEYS.locatorSecretKey,
  }
  for (const vector of VECTORS.requests) {
    const input = {
      realm: vector.realm,
      method: vector.method,
      body: hexToBytes(vector.body),
      expectedVersion: vector.expectedVersion,
      issuedAt: vector.issuedAt,
    }
    const secret = secrets[vector.name]!
    const signed = signRecoveryIndexRequest({
      ...input,
      locatorSecretKey: secret,
      auxRand: hexToBytes(vector.auxRand),
    })
    assert.equal(signed.requestPublicKey, vector.requestPublicKey, vector.name)
    assert.equal(signed.signature, vector.signature, vector.name)
    const digest = recoveryIndexRequestDigest({
      ...input,
      requestPublicKey: vector.requestPublicKey,
    })
    assert.equal(bytesToHex(digest), vector.digest, vector.name)
    assert.ok(
      schnorr.verify(hexToBytes(signed.signature), digest, hexToBytes(vector.requestPublicKey)),
    )
  }
  assert.equal(VECTORS.requests[1]!.requestPublicKey, KEYS.locatorPublicKey)
})

test('the digest refuses fields outside the signed layout', () => {
  const valid = {
    realm: REALM,
    method: 'GET' as const,
    requestPublicKey: KEYS.locatorPublicKey,
    body: new Uint8Array(),
    expectedVersion: 0,
    issuedAt: NOW_SECONDS,
  }
  assert.equal(recoveryIndexRequestDigest(valid).length, 32)
  assert.throws(() => recoveryIndexRequestDigest({ ...valid, realm: '' }), /realm/)
  assert.throws(() => recoveryIndexRequestDigest({ ...valid, realm: 'r'.repeat(65) }), /realm/)
  assert.throws(
    () => recoveryIndexRequestDigest({ ...valid, method: 'POST' as unknown as 'GET' }),
    /method/,
  )
  assert.throws(() => recoveryIndexRequestDigest({ ...valid, requestPublicKey: 'AB' }), /key/)
  assert.throws(() => recoveryIndexRequestDigest({ ...valid, expectedVersion: -1 }), /version/)
  assert.throws(
    () => recoveryIndexRequestDigest({ ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }),
    /version/,
  )
  assert.throws(() => recoveryIndexRequestDigest({ ...valid, issuedAt: 1.5 }), /issue time/)
})

test('the realms are the three permanent environment values', () => {
  assert.deepEqual(Object.values(RECOVERY_INDEX_REALMS), [
    'bitcaster-production',
    'bitcaster-staging',
    'bitcaster-local',
  ])
  assert.equal(isRecoveryIndexRealm('bitcaster-local'), true)
  assert.equal(isRecoveryIndexRealm('bitcaster-test'), false)
  assert.throws(
    () =>
      createRecoveryIndexEngineStore({
        engineBaseUrl: 'https://engine.example.com',
        realm: 'bitcaster-test' as never,
        keys: KEYS,
        fetchImpl: fetch,
      }),
    /realm/,
  )
})

test('the store reads, writes with compare-and-swap, retries exactly, and deletes', async () => {
  const engine = new RecoveryIndexFakeEngine(REALM)
  engine.nowSeconds = NOW_SECONDS
  const index = store(engine)

  assert.deepEqual(await index.read(), { status: 'absent', version: 0 })
  const first = document(1)
  assert.deepEqual(await index.write(first, 0), { status: 'written', version: 1 })
  const read = await index.read()
  assert.equal(read.status, 'found')
  assert.ok(
    read.status === 'found' &&
      read.version === 1 &&
      bytesToHex(read.document) === bytesToHex(first),
  )
  assert.deepEqual(await index.read({ knownVersion: 1 }), { status: 'not-modified', version: 1 })
  // The lost response of an accepted write: the same bytes succeed again.
  assert.deepEqual(await index.write(first, 0), { status: 'written', version: 1 })
  assert.deepEqual(await index.write(document(2), 0), { status: 'conflict', currentVersion: 1 })
  assert.deepEqual(await index.remove(1), { status: 'deleted', version: 2 })
  assert.deepEqual(await index.read(), { status: 'absent', version: 2 })
  assert.deepEqual(await index.remove(2), { status: 'absent', version: 2 })
  // A tombstone takes a new document at its version.
  assert.deepEqual(await index.write(document(3), 2), { status: 'written', version: 3 })

  const [get, put] = [engine.requests[0]!, engine.requests[1]!]
  assert.equal(get.method, 'GET')
  assert.equal(get.body.length, 0)
  assert.equal(get.headers['x-recovery-index-expected-version'], undefined)
  assert.equal(get.headers['x-recovery-index-key'], KEYS.locatorPublicKey)
  assert.equal(get.headers['x-recovery-index-issued-at'], String(NOW_SECONDS))
  assert.equal(put.method, 'PUT')
  assert.equal(put.headers['x-recovery-index-expected-version'], '0')
  assert.equal(put.headers['content-type'], 'application/octet-stream')
  assert.equal(engine.requests[3]!.headers['if-none-match'], '"1"')
})

test('the store refuses a document of a size that the engine does not take before it sends', async () => {
  const engine = new RecoveryIndexFakeEngine(REALM)
  engine.nowSeconds = NOW_SECONDS
  await assert.rejects(store(engine).write(new Uint8Array(4134), 0), /size/)
  assert.equal(engine.requests.length, 0)
})

test('the store reports limits, outages, refusals, and network failures as engine errors', async () => {
  const engine = new RecoveryIndexFakeEngine(REALM)
  engine.nowSeconds = NOW_SECONDS
  const index = store(engine)
  engine.interruptions.push(() =>
    problem(
      429,
      'recovery-index-ip-writes',
      { limitCode: 'recovery-index-ip-writes' },
      {
        'Retry-After': '30',
      },
    ),
  )
  const limited = await engineError(index.write(document(1), 0))
  assert.equal(limited.kind, 'limited')
  assert.equal(limited.retryAfterMs, 30_000)
  assert.equal(limited.limitCode, 'recovery-index-ip-writes')

  engine.interruptions.push(() => problem(503, 'recovery-index-unavailable'))
  assert.equal((await engineError(index.read())).kind, 'unavailable')
  engine.interruptions.push(() => problem(500, 'internal'))
  assert.equal((await engineError(index.read())).kind, 'unavailable')
  engine.interruptions.push(() => problem(400, 'recovery-index-invalid-request'))
  assert.equal((await engineError(index.read())).kind, 'refused')
  engine.interruptions.push(() => problem(401, 'recovery-index-unauthenticated'))
  assert.equal((await engineError(index.read())).kind, 'unauthenticated')
  engine.interruptions.push(() => {
    throw new TypeError('fetch failed')
  })
  assert.equal((await engineError(index.read())).kind, 'network')
})

test('the store corrects its clock once from the engine time', async () => {
  const engine = new RecoveryIndexFakeEngine(REALM)
  engine.nowSeconds = NOW_SECONDS + 300
  const index = store(engine)

  assert.deepEqual(await index.read(), { status: 'absent', version: 0 })
  assert.equal(engine.requests.length, 2)
  assert.equal(engine.requests[1]!.headers['x-recovery-index-issued-at'], String(NOW_SECONDS + 300))
  // The offset stays for later requests.
  assert.deepEqual(await index.write(document(1), 0), { status: 'written', version: 1 })
  assert.equal(engine.requests.length, 3)

  // A second refusal right after a correction is a clock failure, not a loop.
  engine.interruptions.push(
    () => problem(401, 'recovery-index-stale-request', { serverTime: NOW_SECONDS + 900 }),
    () => problem(401, 'recovery-index-stale-request', { serverTime: NOW_SECONDS + 900 }),
  )
  assert.equal((await engineError(index.read())).kind, 'clock')
  assert.equal(engine.requests.length, 5)
})

test('the store refuses a response that breaks the contract', async () => {
  const engine = new RecoveryIndexFakeEngine(REALM)
  engine.nowSeconds = NOW_SECONDS
  const index = store(engine)
  const responses: Array<[string, () => Response]> = [
    [
      'a body of another size',
      () =>
        new Response(new Uint8Array(5000), {
          status: 200,
          headers: { 'X-Recovery-Index-Version': '1', 'Content-Type': 'application/octet-stream' },
        }),
    ],
    [
      'no version',
      () =>
        new Response(new Uint8Array(document(1)), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    ],
    [
      'a non-canonical version',
      () =>
        new Response(new Uint8Array(document(1)), {
          status: 200,
          headers: { 'X-Recovery-Index-Version': '01', 'Content-Type': 'application/octet-stream' },
        }),
    ],
    ['a redirect status', () => new Response(null, { status: 302 })],
  ]
  for (const [name, response] of responses) {
    engine.interruptions.push(response)
    assert.equal((await engineError(index.read())).kind, 'invalid-response', name)
  }
  engine.interruptions.push(
    () =>
      new Response(JSON.stringify({ version: 0 }), {
        status: 200,
        headers: { 'X-Recovery-Index-Version': '0' },
      }),
  )
  assert.equal((await engineError(index.write(document(1), 0))).kind, 'invalid-response')
  assert.ok(engine.requests.every(({ method }) => method === 'GET' || method === 'PUT'))
  assert.equal(new URL(RECOVERY_INDEX_PATH, engine.baseUrl).pathname, '/api/v1/recovery-index')
})
