import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { deriveRecoveryIndexKeys, type RecoveryIndexEntry } from '../src/recoveryIndexDocument.ts'
import {
  RECOVERY_INDEX_REALMS,
  createRecoveryIndexEngineStore,
} from '../src/recoveryIndexEngine.ts'
import { RECOVERY_INDEX_RETRY_BASE_MS, RecoveryIndexSync } from '../src/recoveryIndexSync.ts'
import { RecoveryIndexUploader } from '../src/recoveryIndexUploader.ts'
import { RecoveryIndexFakeEngine, problem } from './support/recoveryIndexFakeEngine.ts'

const SEED = new Uint8Array(64).fill(5)
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

/** A controlled timer: the test fires each scheduled retry. */
class TestTimers {
  readonly scheduled = new Map<
    number,
    { readonly callback: () => void; readonly delayMs: number }
  >()
  #next = 1

  readonly set = (callback: () => void, delayMs: number): unknown => {
    const id = this.#next++
    this.scheduled.set(id, { callback, delayMs })
    return id
  }

  readonly clear = (timer: unknown): void => {
    this.scheduled.delete(timer as number)
  }

  /** The delay of the one scheduled retry. */
  only(): number {
    assert.equal(this.scheduled.size, 1, 'one retry is scheduled')
    return [...this.scheduled.values()][0]!.delayMs
  }

  fire(): void {
    const [[id, timer]] = [...this.scheduled.entries()]
    this.scheduled.delete(id!)
    timer!.callback()
  }
}

function fixture(input: {
  readonly local?: RecoveryIndexEntry[]
  readonly localEntries?: () => Promise<readonly RecoveryIndexEntry[]>
  readonly fetch?: typeof fetch
}) {
  const fake = new RecoveryIndexFakeEngine(REALM)
  fake.nowSeconds = START_MS / 1000
  const clock = { nowMs: START_MS }
  const local = input.local ?? []
  const sync = new RecoveryIndexSync({
    store: createRecoveryIndexEngineStore({
      engineBaseUrl: fake.baseUrl,
      realm: REALM,
      keys: KEYS,
      fetchImpl: input.fetch ?? fake.fetch,
      nowMs: () => clock.nowMs,
    }),
    keys: KEYS,
    localEntries: input.localEntries ?? (async () => [...local]),
    verifyEntry: async () => true,
    walletMints: () => [MINT],
    nowMs: () => clock.nowMs,
    random: () => 0,
  })
  const timers = new TestTimers()
  const current: string[] = []
  const uploader = new RecoveryIndexUploader({
    sync,
    nowMs: () => clock.nowMs,
    random: () => 0,
    setTimer: timers.set,
    clearTimer: timers.clear,
    afterCurrent: async () => {
      current.push(uploader.status.kind)
    },
  })
  return { fake, clock, local, sync, timers, uploader, current }
}

test('an upload request writes the pending keysets and leaves the index current', async () => {
  const { fake, uploader, current } = fixture({ local: [entry('a')] })
  assert.deepEqual(uploader.status, { kind: 'starting' })

  uploader.requestUpload()
  await uploader.settled()

  assert.deepEqual(uploader.status, { kind: 'current' })
  assert.deepEqual(
    fake.requests.map(({ method }) => method),
    ['GET', 'PUT'],
  )
  // The client hook runs after an upload that leaves the index current.
  assert.deepEqual(current, ['current'])
})

test('requests during an upload coalesce into one more upload after it', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  const { fake, sync, uploader } = fixture({
    local: [entry('a')],
    fetch: async (input, init) => {
      if (first) {
        first = false
        await gate
      }
      return fake.fetch(input, init)
    },
  })
  let uploads = 0
  const upload = sync.upload.bind(sync)
  sync.upload = () => {
    uploads += 1
    return upload()
  }

  uploader.requestUpload()
  uploader.requestUpload()
  uploader.requestUpload()
  release()
  await uploader.settled()

  // The running upload and one more for the requests that came during it.
  assert.equal(uploads, 2)
  assert.equal(fake.count('PUT'), 1)
  assert.deepEqual(uploader.status, { kind: 'current' })
})

test('a failed upload waits for the SDK retry, and the retry uploads with no other event', async () => {
  const { fake, clock, timers, uploader } = fixture({ local: [entry('a')] })
  fake.interruptions.push(() => problem(503, 'recovery-index-unavailable'))

  uploader.requestUpload()
  await uploader.settled()

  assert.deepEqual(uploader.status, { kind: 'pending', reason: 'unavailable' })
  assert.equal(timers.only(), RECOVERY_INDEX_RETRY_BASE_MS)
  assert.equal(fake.count('PUT'), 0)

  clock.nowMs += RECOVERY_INDEX_RETRY_BASE_MS
  timers.fire()
  await uploader.settled()

  assert.deepEqual(uploader.status, { kind: 'current' })
  assert.equal(fake.count('PUT'), 1)
  assert.equal(timers.scheduled.size, 0)
})

test('a request during the backoff keeps the reason of the failure', async () => {
  const { fake, timers, uploader } = fixture({ local: [entry('a')] })
  fake.interruptions.push(() => problem(503, 'recovery-index-unavailable'))
  uploader.requestUpload()
  await uploader.settled()
  const failed = uploader.status
  assert.deepEqual(failed, { kind: 'pending', reason: 'unavailable' })
  const seen: string[] = []
  uploader.subscribe(() => seen.push(JSON.stringify(uploader.status)))

  // A local commit during the backoff asks for an upload. The SDK answers
  // "backoff" and sends nothing, and the state still names the failure.
  uploader.requestUpload()
  await uploader.settled()

  assert.equal(uploader.status, failed)
  assert.deepEqual(seen, [])
  assert.equal(fake.requests.length, 1)
  assert.equal(timers.only(), RECOVERY_INDEX_RETRY_BASE_MS)
})

test('a write-interval wait after a write shows its own reason', async () => {
  const { local, uploader } = fixture({ local: [entry('a')] })
  uploader.requestUpload()
  await uploader.settled()
  assert.deepEqual(uploader.status, { kind: 'current' })

  local.push(entry('b'))
  uploader.requestUpload()
  await uploader.settled()

  assert.deepEqual(uploader.status, { kind: 'pending', reason: 'write-interval' })
})

test('a document that the client cannot decode blocks the upload with no retry', async () => {
  const { fake, timers, uploader } = fixture({ local: [entry('a')] })
  // A document of a permitted size that no key of this seed opens.
  fake.rows.set(KEYS.locatorPublicKey, { version: 3, document: new Uint8Array(4_133).fill(7) })

  uploader.requestUpload()
  await uploader.settled()

  assert.deepEqual(uploader.status, { kind: 'blocked', reason: 'undecodable' })
  assert.equal(fake.count('PUT'), 0)
  assert.equal(timers.scheduled.size, 0)
})

test('a local read failure backs off with the retry schedule and then recovers', async () => {
  let failures = 2
  const { fake, clock, timers, uploader } = fixture({
    localEntries: async () => {
      if (failures > 0) {
        failures -= 1
        throw new Error('local store is unavailable')
      }
      return [entry('a')]
    },
  })

  uploader.requestUpload()
  await uploader.settled()
  assert.deepEqual(uploader.status, { kind: 'pending', reason: 'local-failure' })
  assert.equal(timers.only(), RECOVERY_INDEX_RETRY_BASE_MS)

  clock.nowMs += RECOVERY_INDEX_RETRY_BASE_MS
  timers.fire()
  await uploader.settled()
  // The second failure in a row doubles the delay.
  assert.equal(timers.only(), RECOVERY_INDEX_RETRY_BASE_MS * 2)
  assert.equal(fake.requests.length, 0)

  clock.nowMs += RECOVERY_INDEX_RETRY_BASE_MS * 2
  timers.fire()
  await uploader.settled()
  assert.deepEqual(uploader.status, { kind: 'current' })
  assert.equal(fake.count('PUT'), 1)
})

test('status listeners run only when the status changes', async () => {
  const { local, uploader } = fixture({ local: [entry('a')] })
  const seen: string[] = []
  const unsubscribe = uploader.subscribe(() => seen.push(uploader.status.kind))

  uploader.requestUpload()
  await uploader.settled()
  const status = uploader.status
  // A later upload with no pending keyset keeps the same status object.
  uploader.requestUpload()
  await uploader.settled()
  assert.equal(uploader.status, status)
  assert.deepEqual(seen, ['current'])

  unsubscribe()
  local.push(entry('b'))
  uploader.requestUpload()
  await uploader.settled()
  assert.deepEqual(seen, ['current'])
})

test('a gate upload returns its outcome and applies it to the status', async () => {
  const { uploader } = fixture({ local: [entry('a')] })

  assert.deepEqual(await uploader.uploadOnce(), { status: 'written', version: 1 })
  assert.deepEqual(uploader.status, { kind: 'current' })
})

test('stop clears the retry and ignores later requests', async () => {
  const { fake, timers, uploader } = fixture({ local: [entry('a')] })
  fake.interruptions.push(() => problem(503, 'recovery-index-unavailable'))
  uploader.requestUpload()
  await uploader.settled()
  assert.equal(timers.scheduled.size, 1)

  uploader.stop()
  uploader.requestUpload()
  await uploader.settled()

  assert.equal(timers.scheduled.size, 0)
  assert.equal(fake.requests.length, 1)
})
