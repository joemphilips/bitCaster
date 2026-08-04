import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import {
  createEncryptedWalletBackupKeyHandle,
  prepareBoundedEncryptedWalletBackupManifestTarget,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  type EncryptedWalletBackupKeyHandle,
  type PreparedEncryptedWalletBackupManifestTarget,
} from '../src/encryptedWalletBackup.ts'
import { issueBoundedManifestTargetCapabilityForTest } from '../src/encryptedWalletBackupManifestTargetAuthority.ts'
import {
  createEncryptedWalletBackupCoordinatorStore,
  claimBoundedEncryptedWalletBackupUploadAttempt,
  measureEncryptedWalletBackupCoordinatorPersistenceRowBytes,
  sealBoundedEncryptedWalletBackupUploadAttempt,
  sealOrRehydrateEncryptedWalletBackupCasAttempt,
  type EncryptedWalletBackupCoordinatorPersistencePort,
  type EncryptedWalletBackupCoordinatorPersistenceReservation,
  type EncryptedWalletBackupCoordinatorPersistenceTransaction,
} from '../src/index.ts'
import { encodeEncryptedWalletBackupUploadCursor } from '../src/encryptedWalletBackupUploadPlanningPersistence.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'

test('coordinator row measurement includes framing and every persisted value type', () => {
  const binaryOnly = measureEncryptedWalletBackupCoordinatorPersistenceRowBytes(Uint8Array.of(1))
  const complete = measureEncryptedWalletBackupCoordinatorPersistenceRowBytes({
    text: 'row',
    integer: 7,
    flag: true,
    entries: [null, Uint8Array.of(1)],
  })
  assert.ok(complete > binaryOnly)
  assert.throws(
    () => measureEncryptedWalletBackupCoordinatorPersistenceRowBytes({ unsupported: undefined }),
    /not measurable/,
  )
})

test('coordinator factory preserves class transaction receivers, reservations, exact retry, and restart claims', async () => {
  const fixture = await emptyTargetFixture()
  const raw = new RawCoordinatorPort()
  const store = createEncryptedWalletBackupCoordinatorStore(raw)
  const input = uploadInput(fixture, store, '11')
  const first = await sealBoundedEncryptedWalletBackupUploadAttempt(input)
  const retry = await sealBoundedEncryptedWalletBackupUploadAttempt(input)
  assert.equal(retry.record.attemptId, first.record.attemptId)
  assert.equal(raw.reservations.at(-1)?.readRows, 2)
  assert.equal(raw.reservations.at(-1)?.readBytes, 1_048_576)
  assert.equal(raw.counts().attempts, 1)

  const restartedRaw = new RawCoordinatorPort(raw.capture())
  const restarted = createEncryptedWalletBackupCoordinatorStore(restartedRaw)
  assert.equal(
    await claimBoundedEncryptedWalletBackupUploadAttempt({
      ownerId: 'other-owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      store: restarted,
    }),
    null,
  )
  restartedRaw.now = first.record.leaseExpiresAtUnixMilliseconds
  const claimed = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'other-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store: restarted,
  })
  assert.equal(claimed?.record.ownerId, 'other-owner')
  assert.equal(claimed?.record.ownerEpoch, 2)
  await assert.rejects(
    restarted.validateUploadAttemptClaim(first.record, () => Object.freeze({ stale: true })),
    /stale backup upload owner claim/,
  )
})

test('coordinator factory rolls back callback failure and rejects deferred callbacks', async () => {
  const fixture = await emptyTargetFixture()
  const raw = new RawCoordinatorPort()
  const store = createEncryptedWalletBackupCoordinatorStore(raw)
  const seedStore = createEncryptedWalletBackupCoordinatorStore(new RawCoordinatorPort())
  const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(
    uploadInput(fixture, seedStore, '22'),
  )
  const candidate = {
    ...sealed.record,
    attemptId: '23'.repeat(16),
  }
  const cursor = encodeEncryptedWalletBackupUploadCursor({
    schemaVersion: 1,
    realm: candidate.realm,
    vaultId: candidate.vaultId,
    attemptId: candidate.attemptId,
    targetManifestDigest: candidate.targetManifestDigest,
    phase: 'complete',
    nextPageIndex: 0,
    exclusiveChunkObjectId: null,
    nextBatchOrdinal: 0,
    version: 1,
  })
  await assert.rejects(
    store.sealActiveUploadAttemptAndCursor(
      {
        candidate: omitMutable(candidate),
        initialCursor: cursor,
        leaseDurationMilliseconds: 60_000,
        reservation: attemptReservation(),
      },
      () => {
        throw new Error('callback failure')
      },
    ),
    /callback failure/,
  )
  assert.deepEqual(raw.counts(), { attempts: 0, cursors: 0, batches: 0, casAttempts: 0 })

  const real = await sealBoundedEncryptedWalletBackupUploadAttempt(
    uploadInput(fixture, store, '24'),
  )
  await assert.rejects(
    store.validateUploadAttemptClaim(real.record, (() => Promise.resolve('late')) as never),
    /callback must be synchronous/,
  )
})

test('coordinator factory rejects tampered rows and creates one linked CAS row for a complete target', async () => {
  const fixture = await emptyTargetFixture()
  const raw = new RawCoordinatorPort()
  const store = createEncryptedWalletBackupCoordinatorStore(raw)
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt(
    uploadInput(fixture, store, '31'),
  )
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(cas.record.uploadAttemptId, claim.record.attemptId)
  assert.equal(raw.reservations.at(-1)?.readRows, 68)
  assert.equal(raw.reservations.at(-1)?.writeRows, 67)
  assert.equal(raw.reservations.at(-1)?.readBytes, 1_048_576)
  assert.equal(raw.reservations.at(-1)?.writeBytes, 1_048_576)
  assert.deepEqual(raw.counts(), { attempts: 1, cursors: 1, batches: 0, casAttempts: 1 })
  raw.tamperAttempt(claim.record.attemptId)
  await assert.rejects(
    claimBoundedEncryptedWalletBackupUploadAttempt({
      ownerId: 'owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      store,
    }),
    /trailing CBOR envelope|active target head|backup upload attempt is invalid/,
  )
})

test('coordinator terminal cleanup deletes rows without redundant replacements', async () => {
  const fixture = await emptyTargetFixture()
  const raw = new RawCoordinatorPort()
  const store = createEncryptedWalletBackupCoordinatorStore(raw)
  await sealBoundedEncryptedWalletBackupUploadAttempt(uploadInput(fixture, store, '41'))
  const initialClaim = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.notEqual(initialClaim, null)
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: initialClaim!,
    keyHandle: fixture.keyHandle,
    store,
  })
  const terminalClaim = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.notEqual(terminalClaim, null)
  raw.resetOperations()
  await store.completeLinkedCasAttempt(
    terminalClaim!.record,
    cas.record,
    { ...cas.record, state: 'acknowledged', casAttempts: 1 },
    () => 'complete',
  )
  assert.deepEqual(raw.operations(), {
    replaceAttempts: 0,
    replaceBatches: 0,
    replaceCasAttempts: 0,
    deleteAttempts: 1,
    deleteBatches: 0,
    deleteCasAttempts: 1,
  })
})

function uploadInput(
  fixture: Awaited<ReturnType<typeof emptyTargetFixture>>,
  store: ReturnType<typeof createEncryptedWalletBackupCoordinatorStore>,
  suffix: string,
) {
  return {
    attemptId: suffix.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  }
}

function attemptReservation() {
  return Object.freeze({
    readRows: 2 as const,
    writeRows: 2 as const,
    readBytes: 1_048_576 as const,
    writeBytes: 1_048_576 as const,
  })
}

function omitMutable(
  record: Awaited<ReturnType<typeof sealBoundedEncryptedWalletBackupUploadAttempt>>['record'],
) {
  const {
    ownerEpoch: _ownerEpoch,
    leaseExpiresAtUnixMilliseconds: _lease,
    batchIds: _batchIds,
    activeBatchId: _activeBatchId,
    casAttemptId: _casAttemptId,
    lifecycle: _lifecycle,
    ...candidate
  } = record
  return candidate
}

async function emptyTargetFixture(): Promise<{
  keyHandle: EncryptedWalletBackupKeyHandle
  target: PreparedEncryptedWalletBackupManifestTarget
}> {
  const seed = new Uint8Array(64).fill(9)
  const runtime = {
    subtle: webcrypto.subtle,
    getRandomValues: (value: Uint8Array) => webcrypto.getRandomValues(value),
  }
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'backup.example.test',
    runtime,
  })
  const control = issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    {
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      enrollmentEpoch: 1,
      parentGeneration: null,
      parentManifestDigest: null,
      parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: 1,
      snapshotNonce: '22'.repeat(16),
      snapshotId: 'empty',
      snapshotRevision: 1,
    },
  )
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime,
    signal: AbortSignal.timeout(60_000),
  })
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  return {
    keyHandle,
    target: prepareBoundedEncryptedWalletBackupManifestTarget({
      keyHandle,
      capability: issueBoundedManifestTargetCapabilityForTest({
        keyHandle,
        control,
        parentEvidence,
        pages: [],
        chunkReferences: [],
        proofCount: 0,
      }),
    }),
  }
}

type RawSnapshot = Readonly<{
  attempts: readonly [string, unknown][]
  cursors: readonly [string, Uint8Array][]
  batches: readonly [string, unknown][]
  casAttempts: readonly [string, unknown][]
  now: number
}>

class RawCoordinatorPort
  implements
    EncryptedWalletBackupCoordinatorPersistencePort,
    EncryptedWalletBackupCoordinatorPersistenceTransaction
{
  #attempts = new Map<string, unknown>()
  #cursors = new Map<string, Uint8Array>()
  #batches = new Map<string, unknown>()
  #casAttempts = new Map<string, unknown>()
  readonly reservations: EncryptedWalletBackupCoordinatorPersistenceReservation[] = []
  #operations = {
    replaceAttempts: 0,
    replaceBatches: 0,
    replaceCasAttempts: 0,
    deleteAttempts: 0,
    deleteBatches: 0,
    deleteCasAttempts: 0,
  }
  now = 1_700_000_000_000

  constructor(snapshot?: RawSnapshot) {
    if (snapshot === undefined) return
    this.#attempts = new Map(structuredClone(snapshot.attempts))
    this.#cursors = new Map(snapshot.cursors.map(([key, value]) => [key, value.slice()]))
    this.#batches = new Map(structuredClone(snapshot.batches))
    this.#casAttempts = new Map(structuredClone(snapshot.casAttempts))
    this.now = snapshot.now
  }

  get nowUnixMilliseconds(): number {
    return this.now
  }

  async transaction<T>(
    reservation: EncryptedWalletBackupCoordinatorPersistenceReservation,
    operation: (transaction: EncryptedWalletBackupCoordinatorPersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    this.reservations.push({ ...reservation })
    const snapshot = this.capture()
    try {
      return await operation(this)
    } catch (error) {
      this.restore(snapshot)
      throw error
    }
  }

  async readAttempt(attemptId: string) {
    return cloneOrNull(this.#attempts.get(attemptId))
  }
  async readAttemptsForScope(input: { realm: string; vaultId: string; maximumRows: 2 }) {
    return [...this.#attempts.values()]
      .filter((row) => matchesScope(row, input.realm, input.vaultId))
      .slice(0, input.maximumRows)
      .map(clone)
  }
  async readCursor(attemptId: string) {
    return this.#cursors.get(attemptId)?.slice() ?? null
  }
  async readBatch(batchId: string) {
    return cloneOrNull(this.#batches.get(batchId))
  }
  async readBatchesForAttempt(input: { attemptId: string; maximumRows: 64 }) {
    return [...this.#batches.values()]
      .filter((row) => (row as { attemptId?: unknown }).attemptId === input.attemptId)
      .slice(0, input.maximumRows)
      .map(clone)
  }
  async readCasAttempt(attemptId: string) {
    return cloneOrNull(this.#casAttempts.get(attemptId))
  }
  async readCasAttemptsForUploadAttempt(input: { uploadAttemptId: string; maximumRows: 2 }) {
    return [...this.#casAttempts.values()]
      .filter(
        (row) => (row as { uploadAttemptId?: unknown }).uploadAttemptId === input.uploadAttemptId,
      )
      .slice(0, input.maximumRows)
      .map(clone)
  }
  async insertAttempt(record: { attemptId: string }) {
    this.insert(this.#attempts, record.attemptId, record)
  }
  async replaceAttempt(expected: { attemptId: string }, next: { attemptId: string }) {
    this.#operations.replaceAttempts += 1
    this.replace(this.#attempts, expected.attemptId, expected, next)
  }
  async deleteAttempt(expected: { attemptId: string }) {
    this.#operations.deleteAttempts += 1
    this.delete(this.#attempts, expected.attemptId, expected)
  }
  async insertCursor(input: { attemptId: string; canonicalCursor: Uint8Array }) {
    if (this.#cursors.has(input.attemptId)) throw new Error('duplicate cursor')
    this.#cursors.set(input.attemptId, input.canonicalCursor.slice())
  }
  async replaceCursor(input: {
    attemptId: string
    expectedCanonicalCursor: Uint8Array
    nextCanonicalCursor: Uint8Array
  }) {
    const current = this.#cursors.get(input.attemptId)
    if (!equalBytes(current, input.expectedCanonicalCursor)) throw new Error('stale cursor')
    this.#cursors.set(input.attemptId, input.nextCanonicalCursor.slice())
  }
  async deleteCursor(input: { attemptId: string; expectedCanonicalCursor: Uint8Array }) {
    const current = this.#cursors.get(input.attemptId)
    if (!equalBytes(current, input.expectedCanonicalCursor)) throw new Error('stale cursor')
    this.#cursors.delete(input.attemptId)
  }
  async insertBatch(record: { batchId: string }) {
    this.insert(this.#batches, record.batchId, record)
  }
  async replaceBatch(expected: { batchId: string }, next: { batchId: string }) {
    this.#operations.replaceBatches += 1
    this.replace(this.#batches, expected.batchId, expected, next)
  }
  async deleteBatch(expected: { batchId: string }) {
    this.#operations.deleteBatches += 1
    this.delete(this.#batches, expected.batchId, expected)
  }
  async insertCasAttempt(record: { attemptId: string }) {
    this.insert(this.#casAttempts, record.attemptId, record)
  }
  async replaceCasAttempt(expected: { attemptId: string }, next: { attemptId: string }) {
    this.#operations.replaceCasAttempts += 1
    this.replace(this.#casAttempts, expected.attemptId, expected, next)
  }
  async deleteCasAttempt(expected: { attemptId: string }) {
    this.#operations.deleteCasAttempts += 1
    this.delete(this.#casAttempts, expected.attemptId, expected)
  }

  capture(): RawSnapshot {
    return {
      attempts: structuredClone([...this.#attempts]),
      cursors: [...this.#cursors].map(([key, value]) => [key, value.slice()]),
      batches: structuredClone([...this.#batches]),
      casAttempts: structuredClone([...this.#casAttempts]),
      now: this.now,
    }
  }
  counts() {
    return {
      attempts: this.#attempts.size,
      cursors: this.#cursors.size,
      batches: this.#batches.size,
      casAttempts: this.#casAttempts.size,
    }
  }
  operations() {
    return { ...this.#operations }
  }
  resetOperations() {
    this.#operations = {
      replaceAttempts: 0,
      replaceBatches: 0,
      replaceCasAttempts: 0,
      deleteAttempts: 0,
      deleteBatches: 0,
      deleteCasAttempts: 0,
    }
  }
  tamperAttempt(attemptId: string) {
    const row = this.#attempts.get(attemptId) as { canonicalTargetHead: Uint8Array }
    row.canonicalTargetHead[0]! ^= 1
  }
  private insert(map: Map<string, unknown>, key: string, value: unknown) {
    if (map.has(key)) throw new Error('duplicate row')
    map.set(key, clone(value))
  }
  private replace(map: Map<string, unknown>, key: string, expected: unknown, next: unknown) {
    if (!isDeepStrictEqual(map.get(key), expected)) throw new Error('stale row')
    map.set(key, clone(next))
  }
  private delete(map: Map<string, unknown>, key: string, expected: unknown) {
    if (!isDeepStrictEqual(map.get(key), expected)) throw new Error('stale row')
    map.delete(key)
  }
  private restore(snapshot: RawSnapshot) {
    this.#attempts = new Map(structuredClone(snapshot.attempts))
    this.#cursors = new Map(snapshot.cursors.map(([key, value]) => [key, value.slice()]))
    this.#batches = new Map(structuredClone(snapshot.batches))
    this.#casAttempts = new Map(structuredClone(snapshot.casAttempts))
    this.now = snapshot.now
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
function cloneOrNull(value: unknown): unknown | null {
  return value === undefined ? null : clone(value)
}
function matchesScope(value: unknown, realm: string, vaultId: string): boolean {
  const row = value as { realm?: unknown; vaultId?: unknown }
  return row.realm === realm && row.vaultId === vaultId
}
function equalBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return (
    left !== undefined &&
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  )
}
