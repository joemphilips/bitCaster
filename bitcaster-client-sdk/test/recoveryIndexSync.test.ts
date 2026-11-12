import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  deriveRecoveryIndexKeys,
  openRecoveryIndexDocument,
  sealRecoveryIndexDocument,
  type RecoveryIndexEntry,
} from '../src/recoveryIndexDocument.ts'
import {
  RECOVERY_INDEX_REALMS,
  createRecoveryIndexEngineStore,
} from '../src/recoveryIndexEngine.ts'
import {
  RECOVERY_INDEX_CONFLICT_RETRIES_MAX,
  RECOVERY_INDEX_MINIMUM_WRITE_INTERVAL_MS,
  RECOVERY_INDEX_RETRY_BASE_MS,
  RECOVERY_INDEX_RETRY_MAX_MS,
  RecoveryIndexSync,
  deleteRecoveryIndexDocument,
  isRecoveryIndexReadMintRefusal,
  planRecoveryIndexRetryDelayMs,
} from '../src/recoveryIndexSync.ts'
import { RecoveryIndexFakeEngine, problem } from './support/recoveryIndexFakeEngine.ts'

const SEED = new Uint8Array(64).fill(3)
const REALM = RECOVERY_INDEX_REALMS.local
const KEYS = deriveRecoveryIndexKeys(SEED, REALM)
const MINT = 'https://mint.example.com'
const START_MS = 1_800_000_000_000

function entry(label: string): RecoveryIndexEntry {
  return {
    kind: 'regular',
    mintUrl: MINT,
    keysetId: `01${bytesToHex(sha256(utf8ToBytes(label)))}`,
  }
}

/** One client of the seed: its local keysets, its clock, and its sync loop. */
function client(engine: RecoveryIndexFakeEngine, local: RecoveryIndexEntry[] = []) {
  const clock = { nowMs: START_MS }
  const sync = new RecoveryIndexSync({
    store: createRecoveryIndexEngineStore({
      engineBaseUrl: engine.baseUrl,
      realm: REALM,
      keys: KEYS,
      fetchImpl: engine.fetch,
      nowMs: () => clock.nowMs,
    }),
    keys: KEYS,
    localEntries: async () => [...local],
    verifyEntry: async () => true,
    walletMints: () => [MINT],
    nowMs: () => clock.nowMs,
    random: () => 0,
  })
  return { sync, local, clock }
}

function engine(): RecoveryIndexFakeEngine {
  const fake = new RecoveryIndexFakeEngine(REALM)
  fake.nowSeconds = START_MS / 1000
  return fake
}

/** The entries of the stored document, read with the seed keys. */
function stored(fake: RecoveryIndexFakeEngine): readonly RecoveryIndexEntry[] {
  const row = fake.rows.get(KEYS.locatorPublicKey)
  assert.ok(row?.document != null, 'the engine holds a document')
  return openRecoveryIndexDocument({
    keys: KEYS,
    document: row.document,
    storeVersion: row.version,
  })
}

test('the first use of a keyset reads the index and then writes it once', async () => {
  const fake = engine()
  const { sync } = client(fake, [entry('a')])

  assert.deepEqual(await sync.upload(), { status: 'written', version: 1 })
  assert.deepEqual(
    fake.requests.map(({ method }) => method),
    ['GET', 'PUT'],
  )
  assert.ok(isDeepStrictEqual(stored(fake), [entry('a')]))
})

test('an order result in a listed keyset writes nothing, whether the order failed or filled', async () => {
  const fake = engine()
  const { sync } = client(fake, [entry('a'), entry('b')])
  assert.equal((await sync.upload()).status, 'written')
  const requests = fake.requests.length

  // The order advanced the counters of listed keysets only: no keyset is pending.
  for (const _orderResult of ['failed', 'filled'] as const) {
    assert.deepEqual(await sync.upload(), { status: 'current', version: 1 })
  }
  assert.equal(fake.requests.length, requests)
  assert.equal(fake.count('PUT'), 1)
})

test('a new keyset after a write is read for, merged, and written after the write interval', async () => {
  const fake = engine()
  const { sync, local, clock } = client(fake, [entry('a')])
  assert.equal((await sync.upload()).status, 'written')

  local.push(entry('b'))
  // Within the write interval the upload sends nothing.
  const early = await sync.upload()
  assert.deepEqual(early, {
    status: 'retry',
    reason: 'write-interval',
    retryAtMs: START_MS + RECOVERY_INDEX_MINIMUM_WRITE_INTERVAL_MS,
    limitCode: null,
  })
  clock.nowMs = early.status === 'retry' ? early.retryAtMs : 0
  assert.deepEqual(await sync.upload(), { status: 'written', version: 2 })
  assert.deepEqual(
    fake.requests.map(({ method }) => method),
    ['GET', 'PUT', 'GET', 'PUT'],
  )
  assert.ok(isDeepStrictEqual(stored(fake), [entry('a'), entry('b')].sort(byKeyset)))
})

function byKeyset(left: RecoveryIndexEntry, right: RecoveryIndexEntry): number {
  return left.keysetId < right.keysetId ? -1 : left.keysetId > right.keysetId ? 1 : 0
}

test('a conflict with another client merges both clients and writes the union', async () => {
  const fake = engine()
  const other = client(fake, [entry('other')])
  assert.equal((await other.sync.upload()).status, 'written')
  const mine = client(fake, [entry('mine')])
  // The other client writes again between this client's read and write.
  let raced = false
  fake.onRequest = (request) => {
    if (request.method !== 'PUT' || raced) return
    raced = true
    const row = fake.rows.get(KEYS.locatorPublicKey)!
    row.version += 1
    row.document = sealRecoveryIndexDocument({
      keys: KEYS,
      entries: [entry('other'), entry('late')],
      writtenVersion: row.version,
    })
  }

  assert.deepEqual(await mine.sync.upload(), { status: 'written', version: 3 })
  assert.ok(
    isDeepStrictEqual(stored(fake), [entry('other'), entry('late'), entry('mine')].sort(byKeyset)),
  )
})

test('after three conflicts in a row the upload uses the retry schedule', async () => {
  const fake = engine()
  const { sync } = client(fake, [entry('mine')])
  fake.onRequest = (request) => {
    if (request.method !== 'PUT') return
    const row = fake.rows.get(KEYS.locatorPublicKey) ?? { version: 0, document: null }
    row.version += 1
    row.document = sealRecoveryIndexDocument({
      keys: KEYS,
      entries: [entry(`other ${row.version}`)],
      writtenVersion: row.version,
    })
    fake.rows.set(KEYS.locatorPublicKey, row)
  }

  const outcome = await sync.upload()
  assert.deepEqual(outcome, {
    status: 'retry',
    reason: 'conflict',
    retryAtMs: START_MS + RECOVERY_INDEX_RETRY_BASE_MS,
    limitCode: null,
  })
  assert.equal(fake.count('PUT'), 1 + RECOVERY_INDEX_CONFLICT_RETRIES_MAX)
})

test('engine failures back off, the first engine success resets the backoff, and a refusal resolves', async () => {
  const fake = engine()
  const { sync, clock } = client(fake, [entry('a')])
  const delays: number[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    fake.interruptions.push(() => problem(503, 'recovery-index-unavailable'))
    const outcome = await sync.upload()
    assert.equal(outcome.status, 'retry')
    assert.ok(outcome.status === 'retry' && outcome.reason === 'unavailable')
    delays.push(outcome.retryAtMs - clock.nowMs)
    // During the backoff an upload sends nothing.
    const requests = fake.requests.length
    assert.deepEqual(await sync.upload(), { ...outcome, reason: 'backoff' })
    assert.equal(fake.requests.length, requests)
    clock.nowMs = outcome.retryAtMs
  }
  assert.deepEqual(delays, [5_000, 10_000, 20_000])

  // An event read succeeds and resets the backoff.
  assert.equal((await sync.read('wallet-open')).status, 'read')
  fake.interruptions.push(() =>
    problem(
      429,
      'recovery-index-ip-writes',
      { limitCode: 'recovery-index-ip-writes' },
      {
        'Retry-After': '120',
      },
    ),
  )
  const limited = await sync.upload()
  assert.deepEqual(limited, {
    status: 'retry',
    reason: 'limited',
    retryAtMs: clock.nowMs + 120_000,
    limitCode: 'recovery-index-ip-writes',
  })
  clock.nowMs = limited.status === 'retry' ? limited.retryAtMs : 0
  assert.deepEqual(await sync.upload(), { status: 'written', version: 1 })
})

test('the retry schedule doubles from 5 seconds to a 1-hour cap with up to 20 percent jitter', () => {
  assert.equal(
    planRecoveryIndexRetryDelayMs({ streak: 1, minimumDelayMs: 0, random: () => 0 }),
    5_000,
  )
  assert.equal(
    planRecoveryIndexRetryDelayMs({ streak: 4, minimumDelayMs: 0, random: () => 0 }),
    40_000,
  )
  assert.equal(
    planRecoveryIndexRetryDelayMs({ streak: 30, minimumDelayMs: 0, random: () => 0 }),
    RECOVERY_INDEX_RETRY_MAX_MS,
  )
  assert.equal(
    planRecoveryIndexRetryDelayMs({ streak: 1, minimumDelayMs: 0, random: () => 0.999_999 }),
    6_000,
  )
  assert.equal(
    planRecoveryIndexRetryDelayMs({ streak: 1, minimumDelayMs: 90_000, random: () => 0 }),
    90_000,
  )
  assert.throws(() =>
    planRecoveryIndexRetryDelayMs({ streak: 0, minimumDelayMs: 0, random: () => 0 }),
  )
})

test('a document that the client cannot decode blocks the upload and is never overwritten', async () => {
  const fake = engine()
  const otherRealm = deriveRecoveryIndexKeys(SEED, RECOVERY_INDEX_REALMS.staging)
  fake.rows.set(KEYS.locatorPublicKey, {
    version: 1,
    document: sealRecoveryIndexDocument({
      keys: otherRealm,
      entries: [entry('x')],
      writtenVersion: 1,
    }),
  })
  const { sync } = client(fake, [entry('a')])
  assert.deepEqual(await sync.upload(), { status: 'blocked', reason: 'undecodable' })
  assert.equal(fake.count('PUT'), 0)

  const newer = sealRecoveryIndexDocument({ keys: KEYS, entries: [entry('x')], writtenVersion: 2 })
  newer[7] = 2
  fake.rows.set(KEYS.locatorPublicKey, { version: 2, document: newer })
  const read = await sync.read('wallet-open')
  assert.ok(read.status === 'read' && read.document.status === 'undecodable')
  assert.deepEqual(await sync.upload(), { status: 'blocked', reason: 'unsupported-version' })
  assert.equal(fake.count('PUT'), 0)
})

test('a merge above the cap is not written', async () => {
  const fake = engine()
  const local = Array.from({ length: 9 }, (_, index) => ({
    ...entry(`k${index}`),
    mintUrl: `https://m${index}.example.com`,
  }))
  const { sync } = client(fake, local)
  assert.deepEqual(await sync.upload(), { status: 'blocked', reason: 'over-cap' })
  assert.equal(fake.count('PUT'), 0)
})

test('a delete of the index makes the local keysets pending again after the next read', async () => {
  const fake = engine()
  const { sync, clock } = client(fake, [entry('a')])
  assert.equal((await sync.upload()).status, 'written')
  fake.rows.set(KEYS.locatorPublicKey, { version: 2, document: null })

  assert.deepEqual(await sync.upload(), { status: 'current', version: 1 })
  const read = await sync.read('seed-handoff')
  assert.ok(read.status === 'read')
  assert.deepEqual(read.document, { status: 'absent', version: 2 })
  clock.nowMs += RECOVERY_INDEX_MINIMUM_WRITE_INTERVAL_MS
  assert.deepEqual(await sync.upload(), { status: 'written', version: 3 })
})

test('concurrent uploads of one seed share one write', async () => {
  const fake = engine()
  const { sync } = client(fake, [entry('a')])
  const [first, second] = await Promise.all([sync.upload(), sync.upload()])
  assert.deepEqual(first, { status: 'written', version: 1 })
  assert.deepEqual(second, first)
  assert.equal(fake.count('PUT'), 1)
})

test('a read lists the keysets to scan: listed keysets without a local cursor', async () => {
  const fake = engine()
  const foreign = { ...entry('foreign'), mintUrl: 'https://other.example.com' }
  const other = client(fake, [entry('a'), entry('b'), entry('c'), foreign])
  assert.equal((await other.sync.upload()).status, 'written')
  const { sync } = client(fake, [entry('b')])

  const read = await sync.read('wallet-open')
  assert.ok(read.status === 'read')
  assert.equal(read.trigger, 'wallet-open')
  // An entry of a mint that is not a wallet mint is not scanned (ADR-039); it stays listed.
  assert.ok(isDeepStrictEqual(read.scan, [entry('a'), entry('c')].sort(byKeyset)))
  assert.ok(read.document.status === 'listed' && read.document.entries.length === 4)
  // The second read is "not modified" and lists the same keysets.
  const again = await sync.read('upload-conflict')
  assert.ok(again.status === 'read' && isDeepStrictEqual(again.scan, read.scan))
  assert.equal(fake.requests.at(-1)!.headers['if-none-match'], '"1"')

  fake.interruptions.push(() => problem(503, 'recovery-index-unavailable'))
  const failed = await sync.read('mint-refusal')
  assert.ok(failed.status === 'failed' && failed.error.kind === 'unavailable')
})

test('the mint refusals 11001, 11003, and 11008 are index read triggers', () => {
  for (const code of [11001, 11003, 11008]) {
    assert.equal(isRecoveryIndexReadMintRefusal({ kind: 'refusal', code, detail: '' }), true)
  }
  assert.equal(isRecoveryIndexReadMintRefusal({ kind: 'refusal', code: 11002, detail: '' }), false)
  assert.equal(isRecoveryIndexReadMintRefusal({ kind: 'transient', retryAfterMs: null }), false)
})

test('the next write resolves a listed entry whose form conflicts with the local keyset', async () => {
  const fake = engine()
  const local = { ...entry('k') }
  const conditional: RecoveryIndexEntry = {
    kind: 'conditional',
    mintUrl: MINT,
    keysetId: local.keysetId,
    conditionId: 'aa'.repeat(32),
    outcomeCollectionId: 'bb'.repeat(32),
  }
  // A faulty writer listed the conditional keyset in the regular form.
  fake.rows.set(KEYS.locatorPublicKey, {
    version: 1,
    document: sealRecoveryIndexDocument({ keys: KEYS, entries: [local], writtenVersion: 1 }),
  })
  const sync = new RecoveryIndexSync({
    store: createRecoveryIndexEngineStore({
      engineBaseUrl: fake.baseUrl,
      realm: REALM,
      keys: KEYS,
      fetchImpl: fake.fetch,
      nowMs: () => START_MS,
    }),
    keys: KEYS,
    localEntries: async () => [conditional, entry('new')],
    // The mint keys derive the keyset id only with the condition identity.
    verifyEntry: async (candidate) => candidate.kind === 'conditional',
    walletMints: () => [MINT],
    nowMs: () => START_MS,
  })

  assert.deepEqual(await sync.upload(), { status: 'written', version: 2 })
  assert.ok(isDeepStrictEqual(stored(fake), [conditional, entry('new')].sort(byKeyset)))
})

test('a restore Retry reads the index again only after the engine was unreachable', async () => {
  const fake = engine()
  const { sync } = client(fake, [])

  // After a successful read, a Retry sends nothing and returns the known document.
  assert.equal((await sync.read('wallet-open')).status, 'read')
  const requests = fake.requests.length
  const skipped = await sync.read('restore-retry')
  assert.ok(skipped.status === 'skipped' && skipped.document.status === 'absent')
  assert.equal(fake.requests.length, requests)

  // A 503 or a network failure makes the engine unreachable: the next Retry reads.
  for (const unreachable of [
    () => problem(503, 'recovery-index-unavailable'),
    () => {
      throw new TypeError('fetch failed')
    },
  ]) {
    fake.interruptions.push(unreachable)
    assert.equal((await sync.read('wallet-open')).status, 'failed')
    const before = fake.requests.length
    assert.equal((await sync.read('restore-retry')).status, 'read')
    assert.equal(fake.requests.length, before + 1)
  }

  // A limit refusal is not an unreachable engine.
  fake.interruptions.push(() =>
    problem(429, 'recovery-index-ip-requests', { limitCode: 'recovery-index-ip-requests' }),
  )
  assert.equal((await sync.read('mint-refusal')).status, 'failed')
  const before = fake.requests.length
  assert.equal((await sync.read('restore-retry')).status, 'skipped')
  assert.equal(fake.requests.length, before)
})

test('a delete leaves a tombstone, and a later upload writes the index again', async () => {
  const fake = engine()
  const browser = client(fake, [entry('first')])
  assert.equal((await browser.sync.upload()).status, 'written')
  const store = createRecoveryIndexEngineStore({
    engineBaseUrl: fake.baseUrl,
    realm: REALM,
    keys: KEYS,
    fetchImpl: fake.fetch,
    nowMs: () => START_MS,
  })

  assert.deepEqual(await deleteRecoveryIndexDocument(store), { status: 'deleted', version: 2 })
  assert.deepEqual(fake.rows.get(KEYS.locatorPublicKey), { version: 2, document: null })
  assert.deepEqual(await deleteRecoveryIndexDocument(store), { status: 'absent', version: 2 })

  // The delete does not stop a browser with the same seed (ADR-034 "Client upload").
  browser.clock.nowMs += RECOVERY_INDEX_MINIMUM_WRITE_INTERVAL_MS
  assert.equal((await browser.sync.read('wallet-open')).status, 'read')
  assert.equal((await browser.sync.upload()).status, 'written')
  assert.equal(fake.rows.get(KEYS.locatorPublicKey)?.version, 3)
})

test('a delete reads the version again after another client wrote', async () => {
  const fake = engine()
  const browser = client(fake, [entry('first')])
  assert.equal((await browser.sync.upload()).status, 'written')
  let interleaved = false
  fake.onRequest = (request) => {
    // Another client writes between the read and the delete of the CLI.
    if (request.method === 'DELETE' && !interleaved) {
      interleaved = true
      const row = fake.rows.get(KEYS.locatorPublicKey)!
      row.version += 1
    }
  }
  const store = createRecoveryIndexEngineStore({
    engineBaseUrl: fake.baseUrl,
    realm: REALM,
    keys: KEYS,
    fetchImpl: fake.fetch,
    nowMs: () => START_MS,
  })

  assert.deepEqual(await deleteRecoveryIndexDocument(store), { status: 'deleted', version: 3 })
  assert.equal(fake.count('DELETE'), 2)
})
