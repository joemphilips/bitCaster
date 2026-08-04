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
  claimEncryptedWalletBackupUploadAttempt,
  claimBoundedEncryptedWalletBackupUploadAttempt,
  sealBoundedEncryptedWalletBackupUploadAttempt,
  sealOrRehydrateEncryptedWalletBackupCasAttempt,
  type EncryptedWalletBackupActiveUploadAttemptRecord,
  type EncryptedWalletBackupUploadAttemptCursorStore,
} from '../src/encryptedWalletBackupSync.ts'
import {
  decodeEncryptedWalletBackupUploadCursor,
  encodeEncryptedWalletBackupUploadCursor,
} from '../src/encryptedWalletBackupUploadPlanningPersistence.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'

type Mode =
  | 'normal'
  | 'missing-attempt'
  | 'missing-cursor'
  | 'changed-target'
  | 'changed-cursor'
  | 'foreign'
  | 'omitted'
  | 'repeated'
  | 'substituted'
  | 'thenable'
  | 'over-return'
  | 'deferred'
  | 'claim-deferred'
  | 'reservation-mismatch'

test('bounded upload attempt atomically seals a non-empty target and its pages cursor', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const originalHead = fixture.target.wire.canonicalHead.slice()
  const originalReferences = fixture.target.wire.canonicalReferenceSet.slice()
  fixture.target.wire.canonicalHead[0]! ^= 1
  fixture.target.wire.canonicalReferenceSet[0]! ^= 1
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '11'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  assert.equal(claim.record.targetManifestDigest, fixture.target.head.manifestDigest)
  assert.equal(equalBytes(claim.record.canonicalTargetHead, originalHead), true)
  assert.equal(equalBytes(claim.record.canonicalTargetReferenceSet, originalReferences), true)
  assert.equal(store.attempts.size, 1)
  assert.equal(store.cursors.size, 1)
  assert.equal(store.reservation?.readRows, 2)
  assert.equal(store.reservation?.writeRows, 2)
  assert.equal(store.reservation?.readBytes, 1_048_576)
  assert.equal(store.reservation?.writeBytes, 1_048_576)
  const cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'pages')
  assert.equal(cursor.nextPageIndex, 0)
  assert.equal(cursor.nextBatchOrdinal, 0)
  assert.equal(cursor.version, 1)
  assert.equal(cursor.targetManifestDigest, fixture.target.head.manifestDigest)
})

test('bounded upload attempt atomically seals an empty target and its complete cursor', async () => {
  const fixture = await boundedTargetFixture(true)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '22'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  const cursor = decodeEncryptedWalletBackupUploadCursor(store.cursors.get(claim.record.attemptId)!)
  assert.equal(cursor.phase, 'complete')
  assert.equal(cursor.exclusiveChunkObjectId, null)
})

test('bounded upload attempt retries exactly and the paired claim API restarts it', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const input = {
    attemptId: '33'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  }
  const first = await sealBoundedEncryptedWalletBackupUploadAttempt(input)
  const retry = await sealBoundedEncryptedWalletBackupUploadAttempt(input)
  assert.equal(first.record.attemptId, retry.record.attemptId)
  assert.equal(store.attempts.size, 1)
  assert.equal(store.cursors.size, 1)
  const restarted = await claimBoundedEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    store,
  })
  assert.equal(restarted?.record.attemptId, first.record.attemptId)
  await assert.rejects(
    sealBoundedEncryptedWalletBackupUploadAttempt({ ...input, attemptId: '34'.repeat(16) }),
    /live backup upload attempt already exists/,
  )
  assert.equal(store.attempts.size, 1)
  assert.equal(store.cursors.size, 1)
  await assert.rejects(
    claimEncryptedWalletBackupUploadAttempt({
      ownerId: 'owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      store,
    }),
    /legacy upload attempt claim cannot read a bounded cursor store/,
  )
})

test('bounded paired claim rejects missing, malformed, mismatched, and deferred cursor callbacks', async (t) => {
  const fixture = await boundedTargetFixture(false)
  for (const mode of ['missing', 'malformed', 'mismatched', 'deferred'] as const) {
    await t.test(mode, async () => {
      const store = new AtomicAttemptCursorStore(mode === 'deferred' ? 'claim-deferred' : 'normal')
      const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt({
        attemptId: '35'.repeat(16),
        ownerId: 'owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        target: fixture.target,
        store,
      })
      if (mode === 'missing') store.cursors.delete(sealed.record.attemptId)
      if (mode === 'malformed') store.cursors.set(sealed.record.attemptId, new Uint8Array([1]))
      if (mode === 'mismatched') {
        const cursor = decodeEncryptedWalletBackupUploadCursor(
          store.cursors.get(sealed.record.attemptId)!,
        )
        store.cursors.set(
          sealed.record.attemptId,
          encodeEncryptedWalletBackupUploadCursor({
            ...cursor,
            targetManifestDigest: '00'.repeat(32),
          }),
        )
      }
      await assert.rejects(
        claimBoundedEncryptedWalletBackupUploadAttempt({
          ownerId: 'owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store,
        }),
      )
    })
  }
})

test('bounded paired claim rejects forged page, chunk, and complete cursor positions', async (t) => {
  const fixture = await boundedTargetFixture(false)
  for (const mode of ['pages', 'chunks', 'complete'] as const) {
    await t.test(mode, async () => {
      const store = new AtomicAttemptCursorStore()
      const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt({
        attemptId: '37'.repeat(16),
        ownerId: 'owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        target: fixture.target,
        store,
      })
      const initial = decodeEncryptedWalletBackupUploadCursor(
        store.cursors.get(sealed.record.attemptId)!,
      )
      const forged =
        mode === 'pages'
          ? { ...initial, nextPageIndex: 1 }
          : mode === 'chunks'
            ? {
                ...initial,
                phase: 'chunks' as const,
                nextPageIndex: 0,
                exclusiveChunkObjectId: null,
              }
            : {
                ...initial,
                phase: 'complete' as const,
                nextPageIndex: 1,
                exclusiveChunkObjectId: '88'.repeat(16),
              }
      store.cursors.set(
        sealed.record.attemptId,
        encodeEncryptedWalletBackupUploadCursor(forged as never),
      )
      await assert.rejects(
        claimBoundedEncryptedWalletBackupUploadAttempt({
          ownerId: 'owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store,
        }),
        /bounded upload cursor position is invalid/,
      )
    })
  }
})

test('a non-empty bounded upload claim cannot authorize a premature CAS', async () => {
  const fixture = await boundedTargetFixture(false)
  const store = new AtomicAttemptCursorStore()
  const claim = await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: '36'.repeat(16),
    ownerId: 'owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  })
  await assert.rejects(
    sealOrRehydrateEncryptedWalletBackupCasAttempt({
      claim,
      keyHandle: fixture.keyHandle,
      store: store as never,
    }),
    /bounded upload cursor is not complete/,
  )
})

test('bounded upload attempt rejects incomplete, changed, foreign, and malformed atomic callbacks', async (t) => {
  const fixture = await boundedTargetFixture(false)
  for (const mode of [
    'missing-attempt',
    'missing-cursor',
    'changed-target',
    'changed-cursor',
    'foreign',
    'omitted',
    'repeated',
    'substituted',
    'thenable',
    'over-return',
    'deferred',
    'reservation-mismatch',
  ] as const) {
    await t.test(mode, async () => {
      const store = new AtomicAttemptCursorStore(mode)
      await assert.rejects(
        sealBoundedEncryptedWalletBackupUploadAttempt({
          attemptId: '44'.repeat(16),
          ownerId: 'owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          target: fixture.target,
          store,
        }),
      )
      assert.equal(store.attempts.size, 0)
      assert.equal(store.cursors.size, 0)
    })
  }
})

test('bounded upload attempt rejects a legacy head', async () => {
  const fixture = await boundedTargetFixture(false)
  await assert.rejects(
    sealBoundedEncryptedWalletBackupUploadAttempt({
      attemptId: '55'.repeat(16),
      ownerId: 'owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      target: fixture.target.head as never,
      store: new AtomicAttemptCursorStore(),
    }),
    /bounded upload attempt target is invalid/,
  )
})

class AtomicAttemptCursorStore implements EncryptedWalletBackupUploadAttemptCursorStore {
  readonly attempts = new Map<string, EncryptedWalletBackupActiveUploadAttemptRecord>()
  readonly cursors = new Map<string, Uint8Array>()
  reservation:
    | Parameters<
        EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
      >[0]['reservation']
    | null = null
  readonly mode: Mode

  constructor(mode: Mode = 'normal') {
    this.mode = mode
  }

  async sealActiveUploadAttemptAndCursor<T>(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
    >[0],
    seal: (value: {
      attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
      cursor: Uint8Array | null
    }) => T,
  ): Promise<T> {
    this.reservation = input.reservation
    if (this.mode === 'reservation-mismatch') {
      this.reservation = { ...input.reservation, readRows: 1 } as never
      throw new Error('reservation mismatch')
    }
    if (this.mode === 'omitted') return {} as T
    const existingAttempt = this.attempts.get(input.candidate.attemptId) ?? null
    const existingCursor = this.cursors.get(input.candidate.attemptId)?.slice() ?? null
    if (
      existingAttempt === null &&
      [...this.attempts.values()].some(
        (value) =>
          value.realm === input.candidate.realm && value.vaultId === input.candidate.vaultId,
      )
    ) {
      throw new Error('live backup upload attempt already exists')
    }
    const expectedAttempt = this.record(input)
    const attempt = existingAttempt ?? expectedAttempt
    const cursor = existingCursor ?? input.initialCursor.slice()
    if (
      existingAttempt !== null &&
      (!isDeepStrictEqual(existingAttempt, expectedAttempt) || !equalBytes(existingCursor!, cursor))
    ) {
      throw new Error('backup upload attempt conflicts with different content')
    }
    const beforeAttempts = new Map(this.attempts)
    const beforeCursors = new Map(this.cursors)
    if (existingAttempt === null) this.attempts.set(attempt.attemptId, attempt)
    if (existingCursor === null) this.cursors.set(attempt.attemptId, cursor)
    try {
      const committed = this.committed(attempt, cursor)
      if (this.mode === 'deferred')
        return Promise.resolve()
          .then(() => seal(committed))
          .catch((error: unknown) => {
            this.restore(beforeAttempts, beforeCursors)
            throw error
          })
      const result = seal(committed)
      if (this.mode === 'repeated') seal(committed)
      if (this.mode === 'over-return') {
        this.restore(beforeAttempts, beforeCursors)
        return Object.freeze({ ...result }) as T
      }
      return result
    } catch (error) {
      this.restore(beforeAttempts, beforeCursors)
      throw error
    }
  }

  async claimActiveUploadAttempt<T>(
    query: { realm: string; vaultId: string; ownerId: string; leaseDurationMilliseconds: number },
    claim: (record: EncryptedWalletBackupActiveUploadAttemptRecord | null) => T,
  ): Promise<T> {
    const record = [...this.attempts.values()].find(
      (value) => value.realm === query.realm && value.vaultId === query.vaultId,
    )
    return claim(record ?? null)
  }

  async claimActiveUploadAttemptAndCursor<T>(
    _input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['claimActiveUploadAttemptAndCursor']
    >[0],
    claim: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['claimActiveUploadAttemptAndCursor']
    >[1],
  ): Promise<T> {
    const record = [...this.attempts.values()][0] ?? null
    const cursor = record === null ? null : (this.cursors.get(record.attemptId)?.slice() ?? null)
    const committed = { attempt: record, cursor }
    if (this.mode === 'claim-deferred') return Promise.resolve().then(() => claim(committed))
    return claim(committed)
  }

  async validateUploadAttemptClaim<T>(
    _claim: EncryptedWalletBackupActiveUploadAttemptRecord,
    read: (record: EncryptedWalletBackupActiveUploadAttemptRecord) => T,
  ): Promise<T> {
    throw new Error(`unused ${read}`)
  }
  async sealActiveUploadAttempt<T>(): Promise<T> {
    throw new Error('unused')
  }
  async sealUploadBatch<T>(): Promise<T> {
    throw new Error('unused')
  }
  async readUploadBatch<T>(): Promise<T> {
    throw new Error('unused')
  }
  async claimUploadBatchExecution<T>(): Promise<T> {
    throw new Error('unused')
  }
  async validateUploadBatchExecution<T>(): Promise<T> {
    throw new Error('unused')
  }
  async transitionUploadBatch<T>(): Promise<T> {
    throw new Error('unused')
  }
  async fenceUploadAttemptForAbort<T>(): Promise<T> {
    throw new Error('unused')
  }
  async completeUploadAttemptAbort<T>(): Promise<T> {
    throw new Error('unused')
  }

  private record(
    input: Parameters<
      EncryptedWalletBackupUploadAttemptCursorStore['sealActiveUploadAttemptAndCursor']
    >[0],
  ): EncryptedWalletBackupActiveUploadAttemptRecord {
    return Object.freeze({
      ...structuredClone(input.candidate),
      ownerEpoch: 1,
      leaseExpiresAtUnixMilliseconds: 1_700_000_060_000,
      batchIds: Object.freeze([]),
      activeBatchId: null,
      casAttemptId: null,
      lifecycle: 'active',
    })
  }

  private committed(
    attempt: EncryptedWalletBackupActiveUploadAttemptRecord,
    cursor: Uint8Array,
  ): { attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null; cursor: Uint8Array | null } {
    switch (this.mode) {
      case 'normal':
      case 'repeated':
      case 'over-return':
      case 'deferred':
      case 'claim-deferred':
        return { attempt: structuredClone(attempt), cursor: cursor.slice() }
      case 'substituted':
        return Object.assign(Object.create({ cursor: cursor.slice() }), {
          attempt: structuredClone(attempt),
        }) as {
          attempt: EncryptedWalletBackupActiveUploadAttemptRecord | null
          cursor: Uint8Array | null
        }
      case 'thenable':
        return Object.assign(
          { attempt: structuredClone(attempt), cursor: cursor.slice() },
          { then() {} },
        )
      case 'missing-attempt':
        return { attempt: null, cursor: cursor.slice() }
      case 'missing-cursor':
        return { attempt: structuredClone(attempt), cursor: null }
      case 'changed-target':
        return {
          attempt: { ...attempt, targetManifestDigest: '00'.repeat(32) },
          cursor: cursor.slice(),
        }
      case 'changed-cursor': {
        const changed = cursor.slice()
        changed[changed.byteLength - 1]! ^= 1
        return { attempt: structuredClone(attempt), cursor: changed }
      }
      case 'foreign':
        return { attempt: { ...attempt, vaultId: '00'.repeat(32) }, cursor: cursor.slice() }
      case 'omitted':
      case 'reservation-mismatch':
        throw new Error('unreachable')
    }
  }

  private restore(
    attempts: ReadonlyMap<string, EncryptedWalletBackupActiveUploadAttemptRecord>,
    cursors: ReadonlyMap<string, Uint8Array>,
  ): void {
    this.attempts.clear()
    this.cursors.clear()
    for (const [key, value] of attempts) this.attempts.set(key, value)
    for (const [key, value] of cursors) this.cursors.set(key, value)
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

async function boundedTargetFixture(empty: boolean): Promise<{
  keyHandle: EncryptedWalletBackupKeyHandle
  target: PreparedEncryptedWalletBackupManifestTarget
}> {
  const seed = new Uint8Array(64).fill(empty ? 7 : 8)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'backup.example.test',
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues: (value) => webcrypto.getRandomValues(value),
    },
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
      snapshotId: empty ? 'empty' : 'pages',
      snapshotRevision: 1,
    },
  )
  const request = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues: (value) => webcrypto.getRandomValues(value),
    },
    signal: AbortSignal.timeout(60_000),
  })
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: request,
    remote: {
      async readCurrentHead() {
        return { status: 'not-found' as const }
      },
    },
  })
  const pages = empty
    ? []
    : [
        {
          formatVersion: 1 as const,
          kindCode: 2 as const,
          realm: keyHandle.realm,
          vaultId: keyHandle.vaultId,
          objectId: '66'.repeat(16),
          generation: 1,
          paddedLength: 65_536 as const,
          digest: '77'.repeat(32),
        },
      ]
  const chunkReferences = empty ? [] : [{ objectId: '88'.repeat(16), digest: '99'.repeat(32) }]
  const target = prepareBoundedEncryptedWalletBackupManifestTarget({
    keyHandle,
    capability: issueBoundedManifestTargetCapabilityForTest({
      keyHandle,
      control,
      parentEvidence,
      pages,
      chunkReferences,
      proofCount: empty ? 0 : 1,
    }),
  })
  return { keyHandle, target }
}
