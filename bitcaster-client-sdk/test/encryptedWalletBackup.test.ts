import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import * as Cashu from '@cashu/cashu-ts'
import * as BackupModule from '../src/encryptedWalletBackup.ts'
import * as BackupSyncModule from '../src/encryptedWalletBackupSync.ts'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { decode, encode, rfc8949EncodeOptions } from 'cborg'
import {
  acknowledgeDurableWalletBackupSnapshot,
  advanceEncryptedWalletBackupManifestRestore,
  authenticateEncryptedWalletBackupRequest,
  advanceEncryptedWalletBackupSyncAttempt,
  beginEncryptedWalletBackupManifestRestore,
  EncryptedWalletBackupDeadlineError,
  EncryptedWalletBackupRemoteBackoffError,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES_RESERVED,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES_RESERVED,
  encodeEncryptedWalletBackupRequestProof,
  createEncryptedWalletBackupKeyHandle,
  decryptEncryptedWalletBackupManifestPage,
  decryptEncryptedWalletBackupProofChunk,
  deriveDurableWalletEncryptedBackupReceipt,
  discoverEncryptedWalletBackupEnrollmentEpoch,
  packEncryptedWalletBackupProofChunk,
  prepareEncryptedWalletBackupManifest,
  prepareIncrementalEncryptedWalletBackupManifest,
  prepareEncryptedWalletBackupManifestHead,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupProof,
  prepareEncryptedWalletBackupRequestProof as sdkPrepareEncryptedWalletBackupRequestProof,
  prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof as sdkPrepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof,
  synchronizeEncryptedWalletBackupManifestHead as sdkSynchronizeEncryptedWalletBackupManifestHead,
  restoreEncryptedWalletBackupProofs,
  verifyEncryptedWalletBackupConditionalKeyset,
  readPreparedEncryptedWalletBackupObject,
  readPreparedEncryptedWalletBackupManifestHead,
  readAuthenticatedEncryptedWalletBackupHead,
  resumeEncryptedWalletBackupSyncAttempt,
  verifyEncryptedWalletBackupRequestProof,
  type EncryptedWalletBackupProofInput,
  type EncryptedWalletBackupRestoreStore,
  type EncryptedWalletBackupRestoreProofRow,
  type VerifiedEncryptedWalletBackupConditionalKeyset,
  type EncryptedWalletBackupRuntime,
} from '../src/encryptedWalletBackup.ts'
import { preflightEncryptedProofChunkCbor } from '../src/encryptedWalletBackupCbor.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../src/durableCustody.ts'
import {
  validateEncryptedWalletBackupAggregateCasLifecycle,
  validateEncryptedWalletBackupCasState,
} from '../src/encryptedWalletBackupCasState.ts'
import {
  classifyDurableWalletStorage,
  deriveDurableWalletBackupSnapshotId,
  prepareDurableWalletAcknowledgedBackupSnapshot,
} from '../src/recoverableWalletStorage.ts'
import { planEncryptedWalletBackupRetry } from '../src/encryptedWalletBackupRetrySchedule.ts'
import {
  compareEncryptedWalletBackupRestoreTupleText,
  groupEncryptedWalletBackupRestoreRecordsByMintUnit,
} from '../src/encryptedWalletBackupRestore.ts'
import {
  readVerifiedCtfLosingOutcomeEvidence,
  redeemOutcomeLegWithOperation,
} from '../src/ctfRedeem.ts'
import type {
  CtfPrepareProofOperationInput,
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from '../src/ctfSplit.ts'
import {
  EncryptedWalletBackupAccountQuotaExceededError,
  executeEncryptedWalletBackupAccountOperation,
  prepareEncryptedWalletBackupAccountOperation as sdkPrepareEncryptedWalletBackupAccountOperation,
  readPreparedEncryptedWalletBackupAccountOperation,
} from '../src/encryptedWalletBackupEnrollment.ts'
import {
  abandonEncryptedWalletBackupUploadAttempt as sdkAbandonEncryptedWalletBackupUploadAttempt,
  claimEncryptedWalletBackupUploadAttempt,
  cleanUpRejectedEncryptedWalletBackupFork as sdkCleanUpRejectedEncryptedWalletBackupFork,
  deriveEncryptedWalletBackupCasAttemptId,
  ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX,
  prepareEncryptedWalletBackupUploadPlan,
  sealOrRehydrateEncryptedWalletBackupCasAttempt,
  rehydrateEncryptedWalletBackupUploadBatch,
  sealEncryptedWalletBackupUploadAttempt,
  sealEncryptedWalletBackupUploadBatch,
  uploadEncryptedWalletBackupBatch as sdkUploadEncryptedWalletBackupBatch,
  type EncryptedWalletBackupUploadBatchRecord,
} from '../src/encryptedWalletBackupSync.ts'

type OptionalTestSignal<T extends { signal: AbortSignal }> = Omit<T, 'signal'> & {
  signal?: AbortSignal
}

function withTestCycleSignal<T extends { signal: AbortSignal }>(input: OptionalTestSignal<T>): T {
  return {
    ...input,
    signal: input.signal ?? AbortSignal.timeout(60_000),
  } as T
}

const prepareEncryptedWalletBackupRequestProof = (
  input: OptionalTestSignal<Parameters<typeof sdkPrepareEncryptedWalletBackupRequestProof>[0]>,
) => sdkPrepareEncryptedWalletBackupRequestProof(withTestCycleSignal(input))

const prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof = (
  input: OptionalTestSignal<
    Parameters<typeof sdkPrepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof>[0]
  >,
) => sdkPrepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof(withTestCycleSignal(input))

const synchronizeEncryptedWalletBackupManifestHead = (
  input: OptionalTestSignal<Parameters<typeof sdkSynchronizeEncryptedWalletBackupManifestHead>[0]>,
) => sdkSynchronizeEncryptedWalletBackupManifestHead(withTestCycleSignal(input))

const prepareEncryptedWalletBackupAccountOperation = (
  input: OptionalTestSignal<Parameters<typeof sdkPrepareEncryptedWalletBackupAccountOperation>[0]>,
) => sdkPrepareEncryptedWalletBackupAccountOperation(withTestCycleSignal(input))

const uploadEncryptedWalletBackupBatch = (
  input: OptionalTestSignal<Parameters<typeof sdkUploadEncryptedWalletBackupBatch>[0]>,
) => sdkUploadEncryptedWalletBackupBatch(withTestCycleSignal(input))

const abandonEncryptedWalletBackupUploadAttempt = (
  input: OptionalTestSignal<Parameters<typeof sdkAbandonEncryptedWalletBackupUploadAttempt>[0]>,
) => sdkAbandonEncryptedWalletBackupUploadAttempt(withTestCycleSignal(input))

const cleanUpRejectedEncryptedWalletBackupFork = (
  input: OptionalTestSignal<Parameters<typeof sdkCleanUpRejectedEncryptedWalletBackupFork>[0]>,
) => sdkCleanUpRejectedEncryptedWalletBackupFork(withTestCycleSignal(input))

type CasHandoffFixture = Readonly<{
  state: 'cas-journaled'
  targetManifestDigest: string
  uploadAttemptId: string
  localSnapshotId: string
  localSnapshotRevision: number
  objectCount: number
  casAttempt: Awaited<ReturnType<typeof sealOrRehydrateEncryptedWalletBackupCasAttempt>>
  claim: Awaited<ReturnType<typeof sealEncryptedWalletBackupUploadAttempt>>
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  store: ReturnType<typeof inMemoryUploadBatchStore>
}>

async function journalEncryptedWalletBackupCasHandoffForTest(input: {
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  claim: Awaited<ReturnType<typeof sealEncryptedWalletBackupUploadAttempt>>
  store: ReturnType<typeof inMemoryUploadBatchStore>
}): Promise<CasHandoffFixture> {
  const casAttempt = await sealOrRehydrateEncryptedWalletBackupCasAttempt(input)
  return Object.freeze({
    state: 'cas-journaled' as const,
    targetManifestDigest: input.claim.record.targetManifestDigest,
    uploadAttemptId: input.claim.record.attemptId,
    localSnapshotId: input.claim.record.localSnapshotId,
    localSnapshotRevision: input.claim.record.localSnapshotRevision,
    objectCount: casAttempt.record.targetHead.objectCount,
    casAttempt,
    claim: input.claim,
    keyHandle: input.keyHandle,
    store: input.store,
  })
}

const journalZeroDeltaEncryptedWalletBackupCasHandoffForTest =
  journalEncryptedWalletBackupCasHandoffForTest

async function rehydrateEncryptedWalletBackupCasHandoffForTest(input: {
  uploadAttemptId: string
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  store: ReturnType<typeof inMemoryUploadBatchStore>
}): Promise<CasHandoffFixture> {
  const claim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: input.keyHandle,
    store: input.store,
  })
  if (claim === null || claim.record.attemptId !== input.uploadAttemptId)
    throw new Error('missing linked upload aggregate')
  return journalEncryptedWalletBackupCasHandoffForTest({
    claim,
    keyHandle: input.keyHandle,
    store: input.store,
  })
}

async function rehydrateZeroDeltaEncryptedWalletBackupCasHandoffForTest(input: {
  attemptId: string
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  store: ReturnType<typeof inMemoryUploadBatchStore>
}): Promise<CasHandoffFixture> {
  return rehydrateEncryptedWalletBackupCasHandoffForTest({
    uploadAttemptId: input.attemptId,
    keyHandle: input.keyHandle,
    store: input.store,
  })
}

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as BackupVector

const SEED = fromHex(vector.inputs.seedHex)
const SECRET = vector.expected.derivedSecretHex
const CTF_KEYSET_ID = '0170110f06b9bb85565a6746ca5715f877b99db14d87219f6e9030cb529f61e6ea'
const CTF_MINT_KEYS = {
  id: CTF_KEYSET_ID,
  unit: 'sat',
  active: true,
  input_fee_ppk: 0,
  final_expiry: 1_754_296_607,
  keys: {
    1: '02f970b6ee058705c0dddc4313721cffb7efd3d142d96ea8e01d31c2b2ff09f181',
    2: '03361cd8bd1329fea797a6add1cf1990ffcf2270ceb9fc81eeee0e8e9c1bd0cdf5',
  },
}
const CTF_CONDITIONAL_METADATA = {
  conditionId: 'aa'.repeat(32),
  outcomeCollection: 'YES',
  outcomeCollectionId: 'cc'.repeat(32),
  registeredAt: 1_700_000_000,
}
type UnboundProofInput = Omit<EncryptedWalletBackupProofInput, 'proofSnapshotStore'>

test('raw upload descriptors are not public planner authority', () => {
  assert.equal('planEncryptedWalletBackupUploadBatches' in BackupSyncModule, false)
})

test('account lifecycle authorization is scheme-neutral and exact-vault scoped', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'account-lifecycle',
  })
  let captured: unknown
  const enrolled = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action: 'enroll',
    url: 'https://backup.example.test/v1/vaults:enroll',
    operationId: '12'.repeat(16),
    expectedEnrollmentEpoch: 0,
    authorizationPort: {
      async authorizeBackupAccountOperation(intent) {
        captured = structuredClone(intent)
        return {
          scheme: 'test-account-v1',
          authorization: new Uint8Array([1, 2, 3]),
        }
      },
    },
  })
  assert.equal(enrolled.vaultId, keyHandle.vaultId)
  assert.equal(enrolled.requestAuthPublicKey, keyHandle.requestAuthPublicKey)
  assert.equal(enrolled.authorizationScheme, 'test-account-v1')
  assert.equal(JSON.stringify(captured).toLowerCase().includes('nostr'), false)
  assert.ok(readPreparedEncryptedWalletBackupAccountOperation(enrolled).byteLength > 0)
  assert.throws(
    () => readPreparedEncryptedWalletBackupAccountOperation({ ...enrolled }),
    /not prepared/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupAccountOperation({
        keyHandle: { ...keyHandle },
        action: 'enroll',
        url: 'https://backup.example.test/v1/vaults:enroll',
        operationId: '15'.repeat(16),
        expectedEnrollmentEpoch: 0,
        authorizationPort: {
          async authorizeBackupAccountOperation() {
            return { scheme: 'test', authorization: new Uint8Array([1]) }
          },
        },
      }),
    /backup key handle is invalid/,
  )
  const committed = await executeEncryptedWalletBackupAccountOperation({
    operation: enrolled,
    remote: {
      async executeAccountOperation({ canonicalRequest }) {
        assert.equal(
          isDeepStrictEqual(
            canonicalRequest,
            readPreparedEncryptedWalletBackupAccountOperation(enrolled),
          ),
          true,
          'account operation must dispatch exact canonical bytes',
        )
        return {
          status: 'committed' as const,
          operationId: enrolled.operationId,
          intentDigest: enrolled.intentDigest,
          enrollmentEpoch: 1,
          lifecycle: 'active' as const,
        }
      },
    },
    store: {
      async commitAccountOperationResult<T>(
        result: unknown,
        commit: (value: never) => T,
      ): Promise<T> {
        return commit(structuredClone(result) as never)
      },
    },
  })
  assert.equal(committed.record.result, 'committed')
  assert.equal(committed.record.operationId, enrolled.operationId)
  assert.equal(committed.record.intentDigest, enrolled.intentDigest)
  assert.equal(committed.record.observedEnrollmentEpoch, 1)
  let backoffStoreCalls = 0
  await assert.rejects(
    () =>
      executeEncryptedWalletBackupAccountOperation({
        operation: enrolled,
        remote: {
          async executeAccountOperation() {
            return {
              status: 'overloaded' as const,
              retryAfterSeconds: 23,
            }
          },
        },
        store: {
          async commitAccountOperationResult<T>(): Promise<T> {
            backoffStoreCalls += 1
            throw new Error('backoff must not commit an account result')
          },
        },
      }),
    (error) =>
      error instanceof EncryptedWalletBackupRemoteBackoffError &&
      error.status === 'overloaded' &&
      error.retryAfterSeconds === 23,
  )
  assert.equal(backoffStoreCalls, 0)
  let quotaStoreCalls = 0
  await assert.rejects(
    () =>
      executeEncryptedWalletBackupAccountOperation({
        operation: enrolled,
        remote: {
          async executeAccountOperation() {
            return {
              status: 'quota-exceeded' as const,
              retryAfterSeconds: null,
            }
          },
        },
        store: {
          async commitAccountOperationResult<T>(): Promise<T> {
            quotaStoreCalls += 1
            throw new Error('quota refusal must not commit an account result')
          },
        },
      }),
    (error) =>
      error instanceof EncryptedWalletBackupAccountQuotaExceededError &&
      !(error instanceof EncryptedWalletBackupRemoteBackoffError) &&
      error.status === 'quota-exceeded' &&
      error.retryable === false &&
      error.message === 'encrypted backup account quota exceeded' &&
      !error.message.includes(enrolled.vaultId),
  )
  assert.equal(quotaStoreCalls, 0)
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupAccountOperation({
        keyHandle,
        action: 'revoke',
        url: 'https://backup.example.test/v1/vault:revoke',
        operationId: '13'.repeat(16),
        expectedEnrollmentEpoch: 0,
        authorizationPort: {
          async authorizeBackupAccountOperation() {
            return { scheme: 'test', authorization: new Uint8Array([1]) }
          },
        },
      }),
    /expected enrollment epoch is invalid/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupAccountOperation({
        keyHandle,
        action: 'enroll',
        url: 'https://backup.example.test/v1/vaults:enroll',
        operationId: '14'.repeat(16),
        expectedEnrollmentEpoch: 0,
        authorizationPort: {
          async authorizeBackupAccountOperation() {
            return {
              scheme: 'test',
              authorization: new Uint8Array(16 * 1_024 + 1),
            }
          },
        },
      }),
    /authorization is invalid/,
  )
})

test('account authorization and request signing share the caller-owned cycle deadline', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'cycle-deadline',
  })
  await assert.rejects(
    sdkPrepareEncryptedWalletBackupRequestProof({
      keyHandle,
      enrollmentEpoch: 1,
      method: 'GET',
      url: 'https://backup.example.test/v1/head',
      issuedAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_000_030,
      payload: new Uint8Array(),
      signal: undefined as never,
    }),
    /abort signal is invalid/,
  )
  const authorizationAbort = new AbortController()
  await assert.rejects(
    prepareEncryptedWalletBackupAccountOperation({
      keyHandle,
      action: 'enroll',
      url: 'https://backup.example.test/v1/vaults:enroll',
      operationId: '15'.repeat(16),
      expectedEnrollmentEpoch: 0,
      signal: authorizationAbort.signal,
      authorizationPort: {
        async authorizeBackupAccountOperation() {
          authorizationAbort.abort()
          return new Promise<never>(() => undefined)
        },
      },
    }),
    EncryptedWalletBackupDeadlineError,
  )

  const signingAbort = new AbortController()
  const delayed = delayedSigningRuntimeForTest()
  const signing = prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    signal: signingAbort.signal,
    runtime: delayed.runtime,
  })
  await delayed.signingStarted
  signingAbort.abort()
  await assert.rejects(signing, EncryptedWalletBackupDeadlineError)
  delayed.releaseSigning()
})

test('every public backup coordinator requires a host cycle signal', async () => {
  const cases: ReadonlyArray<readonly [string, (input: never) => Promise<unknown>]> = [
    ['request proof', sdkPrepareEncryptedWalletBackupRequestProof],
    ['epoch discovery proof', sdkPrepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof],
    ['account operation', sdkPrepareEncryptedWalletBackupAccountOperation],
    ['manifest synchronization', sdkSynchronizeEncryptedWalletBackupManifestHead],
    ['object upload', sdkUploadEncryptedWalletBackupBatch],
    ['upload abandonment', sdkAbandonEncryptedWalletBackupUploadAttempt],
    ['fork cleanup', sdkCleanUpRejectedEncryptedWalletBackupFork],
  ]
  for (const [name, invoke] of cases) {
    await assert.rejects(
      () => invoke({ signal: undefined } as never),
      /abort signal is invalid/,
      name,
    )
  }
})

test('origin-loss enrollment epoch discovery is signed and non-mutating', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'epoch-discovery',
  })
  const proof = await prepareEncryptedWalletBackupEnrollmentEpochDiscoveryProof({
    keyHandle,
    url: 'https://backup.example.test/v1/vault/enrollment-epoch',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    runtime: deterministicRuntime([new Uint8Array(16).fill(21), new Uint8Array(32).fill(22)]),
  })
  assert.equal(proof.enrollmentEpoch, 0)
  assert.equal(
    verifyEncryptedWalletBackupRequestProof({
      proof,
      expectedRealm: keyHandle.realm,
      expectedVaultId: keyHandle.vaultId,
      expectedPublicKey: keyHandle.requestAuthPublicKey,
      expectedEnrollmentEpoch: 0,
      expectedMethod: 'GET',
      expectedUrl: proof.url,
      payload: new Uint8Array(),
      serverNowUnixSeconds: 1_700_000_001,
    }),
    true,
  )
  assert.equal(
    verifyEncryptedWalletBackupRequestProof({
      proof: encodeEncryptedWalletBackupRequestProof(proof),
      expectedRealm: keyHandle.realm,
      expectedVaultId: keyHandle.vaultId,
      expectedPublicKey: keyHandle.requestAuthPublicKey,
      expectedEnrollmentEpoch: 0,
      expectedMethod: 'GET',
      expectedUrl: proof.url,
      payload: new Uint8Array(),
      serverNowUnixSeconds: 1_700_000_001,
    }),
    true,
  )
  const discovered = await discoverEncryptedWalletBackupEnrollmentEpoch({
    keyHandle,
    requestProof: proof,
    remote: {
      async discoverEnrollmentEpoch() {
        return { status: 'active' as const, enrollmentEpoch: 7 }
      },
    },
  })
  assert.deepEqual(discovered, { state: 'active', enrollmentEpoch: 7 })
  await assert.rejects(
    () =>
      discoverEncryptedWalletBackupEnrollmentEpoch({
        keyHandle,
        requestProof: proof,
        remote: {
          async discoverEnrollmentEpoch() {
            return {
              status: 'rate-limited' as const,
              retryAfterSeconds: 19,
            }
          },
        },
      }),
    (error) =>
      error instanceof EncryptedWalletBackupRemoteBackoffError &&
      error.status === 'rate-limited' &&
      error.retryAfterSeconds === 19 &&
      error.delayMilliseconds() === 19_000,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupRequestProof({
        keyHandle,
        enrollmentEpoch: 0,
        method: 'GET',
        url: proof.url,
        issuedAtUnixSeconds: 1_700_000_000,
        expiresAtUnixSeconds: 1_700_000_030,
        payload: new Uint8Array(),
      }),
    /enrollment epoch is invalid/,
  )
})

test('request-proof CBOR rejects hostile envelopes before materialization', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'request-preflight',
  })
  const proof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
  })
  const valid = encodeEncryptedWalletBackupRequestProof(proof)
  let nested: unknown = 0
  for (let index = 0; index < 10; index += 1) nested = [nested]
  const hostile = [
    new Uint8Array(4_097),
    encode(
      [
        1,
        'backup-request-proof',
        nested,
        new Uint8Array(32),
        new Uint8Array(32),
        1,
        'GET',
        proof.url,
        1_700_000_000,
        1_700_000_030,
        new Uint8Array(16),
        0,
        new Uint8Array(32),
        new Uint8Array(64),
      ],
      rfc8949EncodeOptions,
    ),
    Uint8Array.of(0x9f, 0xff),
    valid.slice(0, -1),
  ]
  for (const encodedProof of hostile) {
    assert.equal(
      verifyEncryptedWalletBackupRequestProof({
        proof: encodedProof,
        expectedRealm: keyHandle.realm,
        expectedVaultId: keyHandle.vaultId,
        expectedPublicKey: keyHandle.requestAuthPublicKey,
        expectedEnrollmentEpoch: 1,
        expectedMethod: 'GET',
        expectedUrl: proof.url,
        payload: new Uint8Array(),
        serverNowUnixSeconds: 1_700_000_001,
      }),
      false,
    )
  }
})

test('public vector freezes key derivation, canonical proof bytes, AEAD body, and restore', async () => {
  const runtime = deterministicRuntime([
    fromHex(vector.inputs.objectIdHex),
    fromHex(vector.inputs.nonceHex),
  ])
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
    runtime,
  })
  assert.deepEqual(keyHandle, {
    formatVersion: 1,
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    requestAuthPublicKey: vector.expected.requestAuthPublicKeyHex,
  })
  assert.equal(JSON.stringify(keyHandle).includes(vector.inputs.seedHex), false)
  assert.equal(Object.isFrozen(keyHandle), true)
  const requestVector = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: vector.inputs.request.enrollmentEpoch,
    method: vector.inputs.request.method,
    url: vector.inputs.request.url,
    issuedAtUnixSeconds: vector.inputs.request.issuedAtUnixSeconds,
    expiresAtUnixSeconds: vector.inputs.request.expiresAtUnixSeconds,
    payload: fromHex(vector.inputs.request.payloadHex),
    runtime: deterministicRuntime([
      fromHex(vector.inputs.request.replayNonceHex),
      fromHex(vector.inputs.request.auxiliaryRandomnessHex),
    ]),
  })
  assert.equal(requestVector.payloadDigest, vector.expected.requestPayloadDigestHex)
  assert.equal(requestVector.signature, vector.expected.requestSignatureHex)
  assert.equal(
    toHex(encodeEncryptedWalletBackupRequestProof(requestVector)),
    vector.expected.requestProofCborHex,
  )

  const proofHandle = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  assert.deepEqual(proofHandle, {
    proofId: vector.expected.proofIdHex,
    commitment: vector.expected.commitmentHex,
  })
  assert.equal(JSON.stringify(proofHandle).includes(SECRET), false)
  const canonicalRoot = decode(fromHex(vector.expected.canonicalCborHex)) as unknown[]
  const canonicalRecord = (canonicalRoot[2] as unknown[][])[0]!
  const encodedSecret = canonicalRecord[6] as Uint8Array
  assert.equal(encodedSecret.byteLength, 64)
  assert.match(new TextDecoder().decode(encodedSecret), /^[0-9a-f]{64}$/)
  const chunk = packEncryptedWalletBackupProofChunk([proofHandle])
  assert.deepEqual(chunk.bindings, [
    {
      proofId: vector.expected.proofIdHex,
      commitment: vector.expected.commitmentHex,
    },
  ])
  assert.equal(JSON.stringify(chunk).includes(SECRET), false)

  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: vector.inputs.generation,
    runtime,
    objectIdExists: () => false,
  })
  const wire = readPreparedEncryptedWalletBackupObject(prepared)
  assert.equal(wire.objectId, vector.inputs.objectIdHex)
  assert.equal(wire.digest, vector.expected.objectDigestHex)
  assert.equal(wire.body.byteLength, vector.expected.bodyLength)
  assert.equal(toHex(wire.aad), vector.expected.aadHex)
  assert.equal(toHex(await sha256(wire.body)), vector.expected.bodySha256Hex)
  assert.equal(toHex(wire.body.slice(-16)), vector.expected.tagHex)
  assert.equal(JSON.stringify(prepared).includes(SECRET), false)
  assert.equal(toHex(wire.aad).includes(SECRET), false)
  assert.equal(toHex(wire.body).includes(SECRET), false)
  assert.throws(
    () => readPreparedEncryptedWalletBackupObject({ ...prepared }),
    /prepared backup object is invalid/,
  )

  const retry = readPreparedEncryptedWalletBackupObject(prepared)
  assert.equal(isDeepStrictEqual(retry.body, wire.body), true, 'retry body must be byte-exact')
  assert.equal(isDeepStrictEqual(retry.aad, wire.aad), true, 'retry AAD must be byte-exact')
  const restored = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed: SEED,
    object: wire,
  })
  assert.deepEqual(restored, { formatVersion: 1, kindCode: 1, recordCount: 1 })
  assert.equal(Object.isFrozen(restored), true)
  assert.equal(JSON.stringify(restored).includes(SECRET), false)
  assert.equal('proof' in restored, false)
  assert.equal('proofKind' in restored, false)
})

test('manifest pages flatten interleaved immutable chunks into one sorted private index', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
    runtime: deterministicRuntime([]),
  })
  const proofs = await Promise.all(
    [0, 1, 2, 3].map((counter) =>
      prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, counter)),
    ),
  )
  const sorted = [...proofs].sort((left, right) => compareLowerHex(left.proofId, right.proofId))
  const chunks = [
    packEncryptedWalletBackupProofChunk([sorted[0]!, sorted[2]!]),
    packEncryptedWalletBackupProofChunk([sorted[1]!, sorted[3]!]),
  ]
  const chunkObjects = await Promise.all(
    chunks.map((chunk, index) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicRuntime([
          new Uint8Array(16).fill(index + 1),
          new Uint8Array(12).fill(index + 11),
        ]),
      }),
    ),
  )
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(33),
    chunks: chunks.map((chunk, index) => ({
      chunk,
      object: chunkObjects[index]!,
    })),
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(21), new Uint8Array(12).fill(31)]),
  })
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  })
  const headWire = readPreparedEncryptedWalletBackupManifestHead(head)
  assert.equal(toHex(headWire.canonicalHead), vector.expected.manifestCanonicalHeadHex)
  assert.equal(
    toHex(headWire.canonicalReferenceSet),
    vector.expected.manifestCanonicalReferenceSetHex,
  )
  const manifestPageWire = readPreparedEncryptedWalletBackupObject(manifest.pages[0]!)
  assert.equal(manifestPageWire.objectId, vector.expected.manifestPageObjectIdHex)
  assert.equal(manifestPageWire.digest, vector.expected.manifestPageDigestHex)
  assert.equal(toHex(manifestPageWire.aad), vector.expected.manifestPageAadHex)
  assert.equal(
    toHex(await sha256(manifestPageWire.body)),
    vector.expected.manifestPageBodySha256Hex,
  )
  const headRequest = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(81), new Uint8Array(32).fill(82)]),
  })
  const authenticated = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: headRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: structuredClone(headWire),
        }
      },
    },
  })

  assert.equal(manifest.proofCount, 4)
  assert.equal(manifest.pageCount, 1)
  assert.equal(manifest.snapshotId, 'test-snapshot')
  assert.equal(manifest.snapshotRevision, 1)
  const page = await decryptEncryptedWalletBackupManifestPage({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(manifest.pages[0]!),
    headEvidence: authenticated,
  })
  assert.deepEqual(
    page.entries.map((entry) => entry.proofId),
    sorted.map((proof) => proof.proofId),
  )
  assert.deepEqual(
    new Set(page.entries.map((entry) => entry.chunkDigest)),
    new Set(chunkObjects.map((object) => object.digest)),
  )
})

test('incremental manifests and upload-ledger recovery remain exact', async () => {
  const { keyHandle, sorted, chunks, chunkObjects, manifest, head, headWire, authenticated, page } =
    await createManifestUploadFixtureForTest()
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupManifest({
        keyHandle,
        generation: 2,
        snapshotNonce: new Uint8Array(16).fill(88),
        chunks: chunks.map((chunk, index) => ({
          chunk,
          object: chunkObjects[index]!,
        })),
        snapshotStore: acceptingSnapshotSealStore(),
      }),
    /non-genesis manifest requires authenticated parent provenance/,
  )
  assert.throws(
    () =>
      prepareEncryptedWalletBackupManifestHead({
        keyHandle,
        manifest,
        parent: authenticated.head,
      }),
    /generation does not advance its parent/,
  )
  const carriedManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(89),
    parentEvidence: authenticated,
    parentPages: [page],
    chunks: [],
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 2 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(90), new Uint8Array(12).fill(91)]),
  })
  const carriedHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: carriedManifest,
    parent: authenticated.head!,
  })
  assert.equal(carriedHead.proofCount, head.proofCount)
  assert.equal(carriedManifest.chunkObjects.length, 0)
  const carriedReferences = decode(
    readPreparedEncryptedWalletBackupManifestHead(carriedHead).canonicalReferenceSet,
  ) as unknown[]
  assert.equal((carriedReferences[3] as unknown[]).length, chunkObjects.length)
  const carriedUploadStore = inMemoryUploadBatchStore()
  const carriedClaim = await uploadAttemptClaimForTest(
    keyHandle,
    carriedHead,
    carriedUploadStore,
    '6b'.repeat(16),
  )
  const carriedUpload = await sealEncryptedWalletBackupUploadBatch({
    batchId: '6a'.repeat(16),
    claim: carriedClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, carriedHead, carriedClaim.record.attemptId),
    store: carriedUploadStore,
  })
  assert.equal(carriedUpload.record.items.length, carriedManifest.pages.length)
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        batchId: '6c'.repeat(16),
        claim: carriedClaim,
        keyHandle,
        plannedBatch: {
          ...plannedUploadBatchForTest(keyHandle, carriedHead, carriedClaim.record.attemptId),
        },
        store: inMemoryUploadBatchStore(),
      }),
    /backup upload attempt claim is invalid/,
  )
  await assert.rejects(
    () =>
      prepareIncrementalEncryptedWalletBackupManifest({
        keyHandle,
        generation: 2,
        snapshotNonce: new Uint8Array(16).fill(92),
        parentEvidence: authenticated,
        parentPages: [{ ...page }],
        chunks: [],
        removedProofIds: [],
        snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 2 },
        snapshotStore: acceptingSnapshotSealStore(),
      }),
    /incomplete or foreign/,
  )
  const splitRepackedChunks = sorted.map((proof) => packEncryptedWalletBackupProofChunk([proof]))
  const repackedChunkObjects = await Promise.all(
    splitRepackedChunks.map((chunk, index) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicRuntime([
          new Uint8Array(16).fill(110 + index),
          new Uint8Array(12).fill(120 + index),
        ]),
      }),
    ),
  )
  const repackedManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(93),
    parentEvidence: authenticated,
    parentPages: [page],
    chunks: splitRepackedChunks.map((chunk, index) => ({
      chunk,
      object: repackedChunkObjects[index]!,
    })),
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(94), new Uint8Array(12).fill(95)]),
  })
  const repackedHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: repackedManifest,
    parent: authenticated.head!,
  })
  const repackedTarget = BackupModule.readPreparedEncryptedWalletBackupManifestTarget({
    keyHandle,
    head: repackedHead,
  })
  const repackedInherited = decode(repackedTarget.canonicalInheritedReferenceSet) as unknown[]
  assert.equal((repackedInherited[3] as unknown[]).length, 0)
  const repackedStore = inMemoryUploadBatchStore()
  const repackedClaim = await uploadAttemptClaimForTest(
    keyHandle,
    repackedHead,
    repackedStore,
    '6f'.repeat(16),
  )
  const repackedBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '6e'.repeat(16),
    claim: repackedClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(
      keyHandle,
      repackedHead,
      repackedClaim.record.attemptId,
    ),
    store: repackedStore,
  })
  assert.equal(repackedBatch.record.items.length, 5)
  assert.equal(repackedBatch.record.repackedChunkCount, 2)

  const emptyChildManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(96),
    parentEvidence: authenticated,
    parentPages: [page],
    chunks: [],
    removedProofIds: page.entries.map((entry) => entry.proofId),
    snapshot: { snapshotId: 'empty-snapshot', snapshotRevision: 2 },
    snapshotStore: acceptingSnapshotSealStore(),
  })
  const emptyChildHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: emptyChildManifest,
    parent: authenticated.head!,
  })
  assert.equal(emptyChildHead.proofCount, 0)
  assert.equal(emptyChildHead.objectCount, 0)
  assert.equal(emptyChildHead.storedBytes, 0)
  const emptyChildReferences = decode(
    readPreparedEncryptedWalletBackupManifestHead(emptyChildHead).canonicalReferenceSet,
  ) as unknown[]
  assert.deepEqual(emptyChildReferences.slice(2), [[], []])
  const emptyHeadRequest = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/empty-head',
    issuedAtUnixSeconds: 1_700_000_020,
    expiresAtUnixSeconds: 1_700_000_050,
    payload: new Uint8Array(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(97), new Uint8Array(32).fill(98)]),
  })
  const authenticatedEmpty = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: emptyHeadRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(emptyChildHead),
        }
      },
    },
  })
  assert.equal(authenticatedEmpty.head?.proofCount, 0)
  assert.deepEqual(
    beginEncryptedWalletBackupManifestRestore({
      headEvidence: authenticatedEmpty,
    }),
    {
      formatVersion: 1,
      generation: 2,
      pageCount: 0,
      nextPageIndex: 0,
      restoredEntryCount: 0,
      complete: true,
    },
  )
  const acknowledgedEmpty = acknowledgeDurableWalletBackupSnapshot({
    headEvidence: authenticatedEmpty,
  })
  assert.deepEqual(acknowledgedEmpty.snapshot.reachableChunkDigests, [])
  const emptyAttemptStore = inMemoryUploadBatchStore()
  const emptyAttemptClaim = await uploadAttemptClaimForTest(
    keyHandle,
    emptyChildHead,
    emptyAttemptStore,
    '69'.repeat(16),
  )
  const directEmptyCas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: emptyAttemptClaim,
    keyHandle,
    store: emptyAttemptStore,
  })
  assert.equal(directEmptyCas.record.targetHead.proofCount, 0)
  assert.equal(directEmptyCas.record.targetHead.objectCount, 0)
  const finalizedEmpty = await journalZeroDeltaEncryptedWalletBackupCasHandoffForTest({
    claim: emptyAttemptClaim,
    keyHandle,
    store: emptyAttemptStore,
  })
  assert.equal(finalizedEmpty.objectCount, 0)
  const emptyRestartKey = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: keyHandle.realm,
  })
  const restartedEmpty = await rehydrateZeroDeltaEncryptedWalletBackupCasHandoffForTest({
    attemptId: emptyAttemptClaim.record.attemptId,
    keyHandle: emptyRestartKey,
    store: emptyAttemptStore,
  })
  await assert.rejects(
    () =>
      rehydrateZeroDeltaEncryptedWalletBackupCasHandoffForTest({
        attemptId: '67'.repeat(16),
        keyHandle: emptyRestartKey,
        store: {
          ...emptyAttemptStore,
          async inspectUploadAttemptPartition<T>(_attemptId: string, read: (raw: never) => T) {
            return emptyAttemptStore.inspectUploadAttemptPartition(
              emptyAttemptClaim.record.attemptId,
              read,
            )
          },
        },
      }),
    /attempt id|batch set is invalid|missing linked upload aggregate/,
  )
  const foreignEmptyKey = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(SEED).fill(0x42),
    realm: keyHandle.realm,
  })
  await assert.rejects(
    () =>
      rehydrateZeroDeltaEncryptedWalletBackupCasHandoffForTest({
        attemptId: emptyAttemptClaim.record.attemptId,
        keyHandle: foreignEmptyKey,
        store: emptyAttemptStore,
      }),
    /foreign vault|foreign backup key|missing linked upload aggregate/,
  )
  const emptyFinalizedRaw = await emptyAttemptStore.inspectUploadAttemptPartition(
    emptyAttemptClaim.record.attemptId,
    (raw: unknown) =>
      structuredClone(raw) as {
        attempt: Record<string, unknown>
        batches: Record<string, unknown>[]
      },
  )
  await assert.rejects(
    () =>
      rehydrateZeroDeltaEncryptedWalletBackupCasHandoffForTest({
        attemptId: emptyAttemptClaim.record.attemptId,
        keyHandle: emptyRestartKey,
        store: {
          ...emptyAttemptStore,
          async sealOrReadLinkedCasAttempt<T>(
            _claim: Record<string, unknown>,
            _candidate: Record<string, unknown>,
            read: (raw: never) => T,
          ) {
            return read({
              attempt: structuredClone(emptyFinalizedRaw.attempt),
              batches: [structuredClone(carriedUpload.record)],
              casAttempts: [structuredClone(restartedEmpty.casAttempt.record)],
            } as never)
          },
        },
      }),
    /aggregate batch partition|batch set is invalid/,
  )
  const currentEmptyClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: emptyRestartKey,
    store: emptyAttemptStore,
  })
  assert.notEqual(currentEmptyClaim, null)
  const emptySyncAttempt = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: currentEmptyClaim!,
    keyHandle: emptyRestartKey,
    store: emptyAttemptStore,
  })
  assert.equal(emptySyncAttempt.record.targetHead.proofCount, 0)
  const acknowledgedEmptyCas = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: emptySyncAttempt,
    keyHandle: emptyRestartKey,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/empty/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/empty/head',
    clock: { nowUnixSeconds: () => 1_700_000_030 },
    runtime: deterministicRuntime([
      new Uint8Array(16).fill(99),
      new Uint8Array(32).fill(100),
      new Uint8Array(16).fill(101),
      new Uint8Array(32).fill(102),
    ]),
    remote: {
      async compareAndSwapCurrentHead() {
        return { status: 'committed' as const }
      },
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(emptyChildHead),
        }
      },
    },
  })
  assert.equal(acknowledgedEmptyCas.record.state, 'acknowledged')
  const emptyAbortStore = inMemoryUploadBatchStore()
  const emptyAbortClaim = await uploadAttemptClaimForTest(
    keyHandle,
    emptyChildHead,
    emptyAbortStore,
    '64'.repeat(16),
  )
  await assert.rejects(
    () =>
      abandonEncryptedWalletBackupUploadAttempt({
        claim: emptyAbortClaim,
        store: emptyAbortStore,
        keyHandle,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/empty/upload-attempt:abort',
        clock: { nowUnixSeconds: () => 1_700_000_040 },
        runtime: {
          subtle: webcrypto.subtle,
          getRandomValues(target) {
            return webcrypto.getRandomValues(target)
          },
        },
        remote: {
          async abortUploadAttempt() {
            throw new Error('lost empty abort response')
          },
        },
      }),
    /lost empty abort response/,
  )
  const emptyAbortRestartKey = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: keyHandle.realm,
  })
  const emptyAbortRestartClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: emptyAbortRestartKey,
    store: emptyAbortStore,
  })
  const emptyAbandoned = await abandonEncryptedWalletBackupUploadAttempt({
    claim: emptyAbortRestartClaim!,
    store: emptyAbortStore,
    keyHandle: emptyAbortRestartKey,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/empty/upload-attempt:abort',
    clock: { nowUnixSeconds: () => 1_700_000_041 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    remote: {
      async abortUploadAttempt() {
        return { status: 'already-abandoned' as const }
      },
    },
  })
  assert.equal(emptyAbandoned.record.lifecycle, 'abandoned')
  const firstEntry = page.entries[0]!
  const receiptEvidence = deriveDurableWalletEncryptedBackupReceipt({
    headEvidence: authenticated,
    manifestPage: page,
    proofId: firstEntry.proofId,
    proofCommitment: firstEntry.commitment,
  })
  assert.deepEqual(receiptEvidence.receipt, {
    formatVersion: 1,
    realm: head.realm,
    backupPublicKey: head.backupPublicKey,
    generation: head.generation,
    snapshotId: head.snapshotId,
    manifestDigest: head.manifestDigest,
    chunkDigest: firstEntry.chunkDigest,
    proofCommitment: firstEntry.commitment,
  })
  assert.throws(
    () =>
      deriveDurableWalletEncryptedBackupReceipt({
        headEvidence: authenticated,
        manifestPage: { ...page },
        proofId: firstEntry.proofId,
        proofCommitment: firstEntry.commitment,
      }),
    /membership is not authenticated/,
  )
  assert.throws(
    () =>
      deriveDurableWalletEncryptedBackupReceipt({
        headEvidence: authenticated,
        manifestPage: page,
        proofId: firstEntry.proofId,
        proofCommitment: 'ff'.repeat(32),
      }),
    /not a member/,
  )
  const snapshotEvidence = acknowledgeDurableWalletBackupSnapshot({
    headEvidence: authenticated,
  })
  const preparedSnapshot = prepareDurableWalletAcknowledgedBackupSnapshot(snapshotEvidence)
  assert.deepEqual(
    new Set(preparedSnapshot.snapshot.reachableChunkDigests),
    new Set(chunkObjects.map((object) => object.digest)),
  )
  assert.throws(
    () => prepareDurableWalletAcknowledgedBackupSnapshot({ ...snapshotEvidence }),
    /snapshot evidence is not acknowledged/,
  )
})

test('upload ledger execution, retry, abort, and rehydration are durable', async () => {
  const {
    keyHandle,
    sorted,
    chunks,
    chunkObjects,
    manifest,
    head,
    headWire,
    headRequest,
    authenticated,
    page,
  } = await createManifestUploadFixtureForTest()
  const uploadStore = inMemoryUploadBatchStore()
  const uploadClaim = await uploadAttemptClaimForTest(keyHandle, head, uploadStore, '72'.repeat(16))
  const uploadBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '71'.repeat(16),
    claim: uploadClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, uploadClaim.record.attemptId),
    store: uploadStore,
  })
  assert.equal(uploadBatch.record.repackedChunkCount, 0)
  uploadBatch.record.items[0]!.canonicalPutPayload[0] ^= 1
  let activeUploads = 0
  let maximumUploads = 0
  let uploadCalls = 0
  const uploaded = await uploadEncryptedWalletBackupBatch({
    batch: uploadBatch,
    claim: uploadClaim,
    store: uploadStore,
    keyHandle,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    objectUrl: (objectId) => `https://backup.example.test/v1/vault/objects/${objectId}`,
    remote: {
      async putObject({ requestProof, canonicalPutPayload }) {
        uploadCalls += 1
        activeUploads += 1
        maximumUploads = Math.max(maximumUploads, activeUploads)
        const persisted = await rehydrateEncryptedWalletBackupUploadBatch({
          batchId: '71'.repeat(16),
          keyHandle,
          store: uploadStore,
        })
        assert.equal(persisted.record.state, 'put-uncertain')
        assert.equal(requestProof.payloadDigest, toHex(await sha256(canonicalPutPayload)))
        await Promise.resolve()
        activeUploads -= 1
        return { status: 'stored' as const }
      },
    },
  })
  assert.equal(uploaded.record.state, 'acknowledged')
  assert.equal(
    uploaded.record.items.every((item) => item.canonicalPutPayload === null),
    true,
  )
  assert.equal(uploadCalls, 3)
  assert.ok(maximumUploads <= 4)
  const retryUploadStore = inMemoryUploadBatchStore()
  const retryUploadClaim = await uploadAttemptClaimForTest(
    keyHandle,
    head,
    retryUploadStore,
    '76'.repeat(16),
  )
  const retryUploadBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '75'.repeat(16),
    claim: retryUploadClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, retryUploadClaim.record.attemptId),
    store: retryUploadStore,
  })
  const firstPayloads: string[] = []
  await assert.rejects(
    () =>
      uploadEncryptedWalletBackupBatch({
        batch: retryUploadBatch,
        claim: retryUploadClaim,
        store: retryUploadStore,
        keyHandle,
        enrollmentEpoch: 1,
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        runtime: {
          subtle: webcrypto.subtle,
          getRandomValues(target) {
            return webcrypto.getRandomValues(target)
          },
        },
        objectUrl: (objectId) => `https://backup.example.test/v1/vault/objects/${objectId}`,
        remote: {
          async putObject({ canonicalPutPayload }) {
            firstPayloads.push(toHex(canonicalPutPayload))
            throw new Error('connection lost')
          },
        },
      }),
    /connection lost/,
  )
  const persistedRetryBatch = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: '75'.repeat(16),
    keyHandle,
    store: retryUploadStore,
  })
  assert.equal(persistedRetryBatch.record.state, 'put-uncertain')
  const corruptedUploadRecord = structuredClone(persistedRetryBatch.record) as {
    items: Array<{ canonicalPutPayload: Uint8Array }>
  }
  corruptedUploadRecord.items[0]!.canonicalPutPayload = Uint8Array.of(0x9f, 0xff)
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupUploadBatch({
        batchId: '75'.repeat(16),
        keyHandle,
        store: uploadBatchReadOnlyStore(
          corruptedUploadRecord as unknown as Record<string, unknown>,
        ),
      }),
    /CBOR|PUT|payload|envelope/i,
  )
  for (const [field, replacement, message] of [
    [4, 'foreign-realm', /PUT realm does not match target head/],
    [5, new Uint8Array(32).fill(0xff), /PUT vault does not match target head/],
    [7, head.generation + 1, /generation .* target head/],
  ] as const) {
    const mismatch = structuredClone(persistedRetryBatch.record) as {
      items: Array<{ canonicalPutPayload: Uint8Array }>
    }
    const put = decode(mismatch.items[0]!.canonicalPutPayload) as unknown[]
    put[field] = replacement
    mismatch.items[0]!.canonicalPutPayload = encode(put, rfc8949EncodeOptions)
    mismatch.items[0]!.payloadLength = mismatch.items[0]!.canonicalPutPayload.byteLength
    mismatch.uploadedBytes = mismatch.items.reduce((sum, item) => sum + item.payloadLength, 0)
    await assert.rejects(
      () =>
        rehydrateEncryptedWalletBackupUploadBatch({
          batchId: '75'.repeat(16),
          keyHandle,
          store: uploadBatchReadOnlyStore(mismatch),
        }),
      message,
    )
  }
  const futureChunk = structuredClone(persistedRetryBatch.record) as {
    items: Array<{ canonicalPutPayload: Uint8Array; payloadLength: number }>
    uploadedBytes: number
  }
  const chunkItem = futureChunk.items.find((item) => {
    const value = decode(item.canonicalPutPayload) as unknown[]
    return value[3] === 1
  })!
  const chunkPut = decode(chunkItem.canonicalPutPayload) as unknown[]
  chunkPut[7] = head.generation + 1
  chunkItem.canonicalPutPayload = encode(chunkPut, rfc8949EncodeOptions)
  chunkItem.payloadLength = chunkItem.canonicalPutPayload.byteLength
  futureChunk.uploadedBytes = futureChunk.items.reduce((sum, item) => sum + item.payloadLength, 0)
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupUploadBatch({
        batchId: '75'.repeat(16),
        keyHandle,
        store: uploadBatchReadOnlyStore(futureChunk),
      }),
    /proof chunk generation exceeds target head/,
  )
  retryUploadStore.setNowUnixMilliseconds(
    persistedRetryBatch.record.executionLeaseExpiresAtUnixMilliseconds!,
  )
  const retryUploadClaimRenewed = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: retryUploadStore,
  })
  const retriedPayloads: string[] = []
  const retriedUpload = await uploadEncryptedWalletBackupBatch({
    batch: persistedRetryBatch,
    claim: retryUploadClaimRenewed!,
    store: retryUploadStore,
    keyHandle,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_010 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    objectUrl: (objectId) => `https://backup.example.test/v1/vault/objects/${objectId}`,
    remote: {
      async putObject({ canonicalPutPayload }) {
        retriedPayloads.push(toHex(canonicalPutPayload))
        return { status: 'already-stored' as const }
      },
    },
  })
  assert.equal(retriedUpload.record.state, 'acknowledged')
  assert.equal(
    isDeepStrictEqual(
      retriedPayloads.sort(),
      retryUploadBatch.record.items.map((item) => toHex(item.canonicalPutPayload)).sort(),
    ),
    true,
    'uncertain upload retry must reuse the exact persisted payload bytes',
  )
  assert.ok(firstPayloads.every((payload) => retriedPayloads.includes(payload)))
  const abandonedStore = inMemoryUploadBatchStore()
  const abandonedClaim = await uploadAttemptClaimForTest(
    keyHandle,
    head,
    abandonedStore,
    '78'.repeat(16),
  )
  const abandonedBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '77'.repeat(16),
    claim: abandonedClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, abandonedClaim.record.attemptId),
    store: abandonedStore,
  })
  const abandoned = await abandonEncryptedWalletBackupUploadAttempt({
    claim: abandonedClaim,
    store: abandonedStore,
    keyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/vault/upload-attempts/78:abort',
    clock: { nowUnixSeconds: () => 1_700_000_020 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    remote: {
      async abortUploadAttempt({ requestProof }) {
        assert.equal(requestProof.method, 'DELETE')
        return { status: 'abandoned' as const }
      },
    },
  })
  assert.equal(abandoned.record.lifecycle, 'abandoned')
  assert.deepEqual(abandonedStore.coordinatorRecordCounts(), {
    attempts: 0,
    batches: 0,
    casAttempts: 0,
  })
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        batchId: '73'.repeat(16),
        claim: uploadClaim,
        keyHandle,
        plannedBatch: {
          ...plannedUploadBatchForTest(keyHandle, head, uploadClaim.record.attemptId),
          repackedChunkCount: 5,
        },
        store: inMemoryUploadBatchStore(),
      }),
    /backup upload attempt claim is invalid/,
  )
  assert.equal(
    page.entries.every((entry) => entry.mint === vector.inputs.proof.mint),
    true,
  )
  assert.equal(
    page.entries.every((entry) => entry.unit === vector.inputs.proof.unit),
    true,
  )
  const tamperedPage = readPreparedEncryptedWalletBackupObject(manifest.pages[0]!)
  tamperedPage.body[20] ^= 1
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupManifestPage({
        keyHandle,
        seed: SEED,
        object: tamperedPage,
        headEvidence: authenticated,
      }),
    exactCorruptError,
  )
  assert.equal(head.generation, 1)
  assert.equal(head.objectCount, 3)
  assert.equal(head.proofCount, 4)
  assert.equal(JSON.stringify(head).includes(sorted[0]!.proofId), false)
  assert.equal(JSON.stringify(head).includes(sorted[0]!.commitment), false)
  assert.equal(authenticated?.head.manifestDigest, head.manifestDigest)
  assert.throws(
    () => readPreparedEncryptedWalletBackupManifestHead({ ...head }),
    /prepared manifest head is invalid/,
  )
  const corruptedHeadWire = structuredClone(headWire)
  corruptedHeadWire.canonicalReferenceSet[corruptedHeadWire.canonicalReferenceSet.length - 1] ^= 1
  await assert.rejects(
    () =>
      readAuthenticatedEncryptedWalletBackupHead({
        keyHandle,
        enrollmentEpoch: 1,
        requestProof: headRequest,
        remote: {
          async readCurrentHead() {
            return {
              status: 'found' as const,
              enrollmentEpoch: 1,
              head: corruptedHeadWire,
            }
          },
        },
      }),
    /manifest reference set|CBOR|encoding|invalid/i,
  )
  const unsortedHeadValue = structuredClone(decode(headWire.canonicalHead) as unknown[])
  const unsortedReferenceValue = structuredClone(
    decode(headWire.canonicalReferenceSet) as unknown[],
  )
  ;(unsortedHeadValue[9] as unknown[]).reverse()
  ;(unsortedReferenceValue[3] as unknown[]).reverse()
  const unsortedReferenceBytes = encode(unsortedReferenceValue, rfc8949EncodeOptions)
  unsortedHeadValue[12] = nobleSha256(unsortedReferenceBytes)
  await assert.rejects(
    () =>
      readAuthenticatedEncryptedWalletBackupHead({
        keyHandle,
        enrollmentEpoch: 1,
        requestProof: headRequest,
        remote: {
          async readCurrentHead() {
            return {
              status: 'found' as const,
              enrollmentEpoch: 1,
              head: {
                canonicalHead: encode(unsortedHeadValue, rfc8949EncodeOptions),
                canonicalReferenceSet: unsortedReferenceBytes,
              },
            }
          },
        },
      }),
    /chunk references are not canonical/,
  )
  const impossibleHeadValue = structuredClone(decode(headWire.canonicalHead) as unknown[])
  impossibleHeadValue[10] = 1_025
  await assert.rejects(
    () =>
      readAuthenticatedEncryptedWalletBackupHead({
        keyHandle,
        enrollmentEpoch: 1,
        requestProof: headRequest,
        remote: {
          async readCurrentHead() {
            return {
              status: 'found' as const,
              enrollmentEpoch: 1,
              head: {
                canonicalHead: encode(impossibleHeadValue, rfc8949EncodeOptions),
                canonicalReferenceSet: headWire.canonicalReferenceSet,
              },
            }
          },
        },
      }),
    /proof count does not match reference bounds/,
  )
})

test('finalization, abort races, aggregate partitions, and CAS recovery fail closed', async () => {
  const { keyHandle, chunks, chunkObjects, manifest, head, headRequest, authenticated, page } =
    await createManifestUploadFixtureForTest()
  const nextManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(83),
    parentEvidence: authenticated,
    parentPages: [page],
    chunks: [],
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(84), new Uint8Array(12).fill(85)]),
  })
  const nextHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: nextManifest,
    parent: authenticated!.head,
  })
  assert.deepEqual(nextHead.parent, {
    generation: 1,
    manifestDigest: head.manifestDigest,
  })
  const targetObservation = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: headRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(nextHead),
        }
      },
    },
  })
  const foreignManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(86),
    parentEvidence: authenticated,
    parentPages: [page],
    chunks: [],
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(87), new Uint8Array(12).fill(88)]),
  })
  const foreignHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: foreignManifest,
    parent: authenticated.head!,
  })
  const foreignObservation = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: headRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(foreignHead),
        }
      },
    },
  })
  const finalizedBundle = await finalizeTargetUploadsForTest({
    keyHandle,
    targetHead: nextHead,
  })
  const finalizedNextUploads = finalizedBundle.finalized
  const restartedKeyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: keyHandle.realm,
  })
  const restartedFinalizedUploads = await rehydrateEncryptedWalletBackupCasHandoffForTest({
    uploadAttemptId: finalizedNextUploads.uploadAttemptId,
    keyHandle: restartedKeyHandle,
    store: finalizedBundle.store,
  })
  const restartFinalizedAttempt = restartedFinalizedUploads.casAttempt
  assert.equal(restartFinalizedAttempt.record.targetHead.manifestDigest, nextHead.manifestDigest)
  const finalizedBatchAfterRestart = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: finalizedBundle.batchId,
    keyHandle: restartedKeyHandle,
    store: finalizedBundle.store,
  })
  const duplicateDigestBundle = await finalizeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: 'ed'.repeat(16),
    attemptId: 'ec'.repeat(16),
  })
  const duplicateDigestRaw = await duplicateDigestBundle.store.inspectUploadAttemptPartition(
    duplicateDigestBundle.finalized.uploadAttemptId,
    (raw: unknown) =>
      structuredClone(raw) as {
        attempt: Record<string, unknown>
        batches: Array<
          Record<string, unknown> & {
            items: Array<Record<string, unknown>>
          }
        >
      },
  )
  const duplicateReferenceSet = decode(
    duplicateDigestRaw.attempt.canonicalTargetReferenceSet as Uint8Array,
  ) as unknown[]
  const duplicateReferences = [
    ...(duplicateReferenceSet[2] as unknown[][]),
    ...(duplicateReferenceSet[3] as unknown[][]),
  ]
  duplicateReferences[1]![1] = structuredClone(duplicateReferences[0]![1])
  const duplicateReferenceBytes = encode(duplicateReferenceSet, rfc8949EncodeOptions)
  const duplicateHead = decode(
    duplicateDigestRaw.attempt.canonicalTargetHead as Uint8Array,
  ) as unknown[]
  duplicateHead[8] = duplicateReferenceSet[2]
  duplicateHead[9] = duplicateReferenceSet[3]
  duplicateHead[12] = nobleSha256(duplicateReferenceBytes)
  const duplicateHeadBytes = encode(duplicateHead, rfc8949EncodeOptions)
  const duplicateManifestDigest = toHex(nobleSha256(duplicateHeadBytes))
  duplicateDigestRaw.attempt.canonicalTargetHead = duplicateHeadBytes
  duplicateDigestRaw.attempt.canonicalTargetReferenceSet = duplicateReferenceBytes
  duplicateDigestRaw.attempt.targetManifestDigest = duplicateManifestDigest
  for (const batch of duplicateDigestRaw.batches) {
    batch.canonicalTargetHead = duplicateHeadBytes
    batch.canonicalTargetReferenceSet = duplicateReferenceBytes
    batch.targetManifestDigest = duplicateManifestDigest
    for (const item of batch.items) {
      const reference = duplicateReferences.find(
        (candidate) => toHex(candidate[0] as Uint8Array) === item.objectId,
      )
      item.objectDigest = toHex(reference![1] as Uint8Array)
    }
  }
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupCasHandoffForTest({
        uploadAttemptId: duplicateDigestBundle.finalized.uploadAttemptId,
        keyHandle,
        store: {
          ...duplicateDigestBundle.store,
          async sealOrReadLinkedCasAttempt<T>(
            _claim: Record<string, unknown>,
            _candidate: Record<string, unknown>,
            read: (raw: never) => T,
          ) {
            return read({
              ...structuredClone(duplicateDigestRaw),
              casAttempts: [structuredClone(duplicateDigestBundle.finalized.casAttempt.record)],
            } as never)
          },
        },
      }),
    /object digest is duplicated|object reference is duplicated/,
  )

  const inheritedPageRaw = await finalizedBundle.store.inspectUploadAttemptPartition(
    finalizedBundle.finalized.uploadAttemptId,
    (raw: unknown) =>
      structuredClone(raw) as {
        attempt: Record<string, unknown>
        batches: Array<Record<string, unknown>>
      },
  )
  const inheritedTarget = decode(
    inheritedPageRaw.attempt.canonicalTargetReferenceSet as Uint8Array,
  ) as unknown[]
  const inheritedPageBytes = encode(
    [1, 'reference-set', [(inheritedTarget[2] as unknown[])[0]], []],
    rfc8949EncodeOptions,
  )
  inheritedPageRaw.attempt.canonicalInheritedReferenceSet = inheritedPageBytes
  for (const batch of inheritedPageRaw.batches)
    batch.canonicalInheritedReferenceSet = inheritedPageBytes
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupCasHandoffForTest({
        uploadAttemptId: finalizedBundle.finalized.uploadAttemptId,
        keyHandle,
        store: {
          ...finalizedBundle.store,
          async sealOrReadLinkedCasAttempt<T>(
            _claim: Record<string, unknown>,
            _candidate: Record<string, unknown>,
            read: (raw: never) => T,
          ) {
            return read({
              ...structuredClone(inheritedPageRaw),
              casAttempts: [structuredClone(finalizedBundle.finalized.casAttempt.record)],
            } as never)
          },
        },
      }),
    /inherited references contain manifest pages/,
  )
  const substitutedFinalize = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: nextHead,
    batchId: 'ef'.repeat(16),
    attemptId: 'ee'.repeat(16),
  })
  const originalSubstitutedHandoff = substitutedFinalize.store.sealOrReadLinkedCasAttempt
  substitutedFinalize.store.sealOrReadLinkedCasAttempt = async function <T>(
    claim: Record<string, unknown>,
    candidate: Record<string, unknown>,
    commit: (value: never) => T,
  ): Promise<T> {
    return originalSubstitutedHandoff(
      claim,
      candidate,
      (raw: { attempt: Record<string, unknown>; batches: Record<string, unknown>[] }) => {
        const changed = structuredClone(raw)
        changed.attempt.canonicalInheritedReferenceSet = encode(
          [1, 'reference-set', [], []],
          rfc8949EncodeOptions,
        )
        return commit(changed as never)
      },
    )
  }
  await assert.rejects(
    () =>
      journalEncryptedWalletBackupCasHandoffForTest({
        keyHandle,
        claim: substitutedFinalize.claim,
        store: substitutedFinalize.store,
      }),
    /finalized backup upload batch set changed|aggregate batch partition/,
  )
  substitutedFinalize.store.sealOrReadLinkedCasAttempt = originalSubstitutedHandoff
  const rolledBackFinalize = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: substitutedFinalize.batchId,
    keyHandle,
    store: substitutedFinalize.store,
  })
  assert.equal(rolledBackFinalize.record.state, 'acknowledged')
  assert.equal(
    (
      await journalEncryptedWalletBackupCasHandoffForTest({
        keyHandle,
        claim: substitutedFinalize.claim,
        store: substitutedFinalize.store,
      })
    ).state,
    'cas-journaled',
  )
  let finalizedAbortCalls = 0
  await assert.rejects(
    () =>
      abandonEncryptedWalletBackupUploadAttempt({
        claim: finalizedBundle.claim,
        store: finalizedBundle.store,
        keyHandle,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/vault/upload-attempts/e2:abort',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {
          async abortUploadAttempt() {
            finalizedAbortCalls += 1
            return { status: 'abandoned' as const }
          },
        },
      }),
    /finalized|stale/i,
  )
  assert.equal(finalizedAbortCalls, 0)

  const finalizeWins = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: nextHead,
    batchId: 'f1'.repeat(16),
    attemptId: 'f2'.repeat(16),
  })
  let staleAbortCalls = 0
  const finalizeFirst = journalEncryptedWalletBackupCasHandoffForTest({
    keyHandle,
    claim: finalizeWins.claim,
    store: finalizeWins.store,
  })
  const staleAbort = abandonEncryptedWalletBackupUploadAttempt({
    claim: finalizeWins.claim,
    store: finalizeWins.store,
    keyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/vault/upload-attempts/f2:abort',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async abortUploadAttempt() {
        staleAbortCalls += 1
        return { status: 'abandoned' as const }
      },
    },
  })
  const [finalizeFirstResult, staleAbortResult] = await Promise.allSettled([
    finalizeFirst,
    staleAbort,
  ])
  assert.equal(finalizeFirstResult.status, 'fulfilled')
  assert.equal(staleAbortResult.status, 'rejected')
  assert.equal(staleAbortCalls, 0)

  const abortWins = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: nextHead,
    batchId: 'f3'.repeat(16),
    attemptId: 'f4'.repeat(16),
  })
  let uncertainAbortCalls = 0
  const abortFirst = abandonEncryptedWalletBackupUploadAttempt({
    claim: abortWins.claim,
    store: abortWins.store,
    keyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/vault/upload-attempts/f4:abort',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    remote: {
      async abortUploadAttempt() {
        uncertainAbortCalls += 1
        throw new Error('lost abort response')
      },
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  const finalizeAfterAbortJournal = journalEncryptedWalletBackupCasHandoffForTest({
    keyHandle,
    claim: abortWins.claim,
    store: abortWins.store,
  })
  const [abortFirstResult, finalizeAfterAbortResult] = await Promise.allSettled([
    abortFirst,
    finalizeAfterAbortJournal,
  ])
  assert.equal(abortFirstResult.status, 'rejected')
  assert.equal(finalizeAfterAbortResult.status, 'rejected')
  if (abortFirstResult.status === 'rejected') {
    assert.match(String(abortFirstResult.reason), /lost abort response/)
  }
  assert.equal(uncertainAbortCalls, 1)
  const abortUncertainAfterRestart = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: abortWins.batchId,
    keyHandle: restartedKeyHandle,
    store: abortWins.store,
  })
  const restartedAbortClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: restartedKeyHandle,
    store: abortWins.store,
  })
  const abandonedAfterRestart = await abandonEncryptedWalletBackupUploadAttempt({
    claim: restartedAbortClaim!,
    store: abortWins.store,
    keyHandle: restartedKeyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/vault/upload-attempts/f4:abort',
    clock: { nowUnixSeconds: () => 1_700_000_001 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    remote: {
      async abortUploadAttempt() {
        uncertainAbortCalls += 1
        return { status: 'already-abandoned' as const }
      },
    },
  })
  assert.equal(abandonedAfterRestart.record.lifecycle, 'abandoned')
  assert.equal(uncertainAbortCalls, 2)

  const multiBatchTarget = await createMultiBatchTargetForTest(keyHandle)
  const partitionPlan = prepareEncryptedWalletBackupUploadPlan({
    attemptId: 'f6'.repeat(16),
    keyHandle,
    targetHead: multiBatchTarget.head,
  })
  assert.deepEqual(
    partitionPlan.batches.map((batch) => batch.objectCount),
    [16, 2],
  )
  const partitionPagePayloadLength = preparedPutPayloadLengthForTest(
    'f6'.repeat(16),
    multiBatchTarget.objects[0]!,
  )
  const partitionChunkPayloadLength = preparedPutPayloadLengthForTest(
    'f6'.repeat(16),
    multiBatchTarget.objects[1]!,
  )
  assert.deepEqual(
    partitionPlan.batches.map((batch) => batch.uploadedBytes),
    [
      partitionPagePayloadLength + 15 * partitionChunkPayloadLength,
      2 * partitionChunkPayloadLength,
    ],
  )
  assert.equal(
    partitionPlan.batches.reduce((total, batch) => total + batch.objectCount, 0),
    partitionPlan.objectCount,
  )
  assert.equal(partitionPlan.batches[0]!.objectCount, ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX)
  const partitionStore = inMemoryUploadBatchStore()
  const partitionFirst = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: multiBatchTarget.head,
    batchId: 'f5'.repeat(16),
    attemptId: 'f6'.repeat(16),
    store: partitionStore,
    batchIndex: 0,
  })
  const partitionSecondSealed = await sealEncryptedWalletBackupUploadBatch({
    batchId: 'f7'.repeat(16),
    claim: partitionFirst.claim,
    keyHandle,
    plannedBatch: partitionPlan.batches[1]!,
    store: partitionStore,
  })
  await assert.rejects(
    () =>
      uploadEncryptedWalletBackupBatch({
        batch: partitionSecondSealed,
        claim: partitionFirst.claim,
        store: partitionStore,
        keyHandle,
        enrollmentEpoch: 1,
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
        remote: {
          async putObject() {
            throw new Error('lost second-batch response')
          },
        },
      }),
    /lost second-batch response/,
  )
  const partitionRestartKey = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: keyHandle.realm,
  })
  const partitionRestartBatch = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: partitionSecondSealed.record.batchId,
    keyHandle: partitionRestartKey,
    store: partitionStore,
  })
  assert.equal(partitionRestartBatch.record.state, 'put-uncertain')
  partitionStore.setNowUnixMilliseconds(
    partitionRestartBatch.record.executionLeaseExpiresAtUnixMilliseconds!,
  )
  const partitionRestartClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle: partitionRestartKey,
    store: partitionStore,
  })
  const partitionSecondAcknowledged = await uploadEncryptedWalletBackupBatch({
    batch: partitionRestartBatch,
    claim: partitionRestartClaim!,
    store: partitionStore,
    keyHandle: partitionRestartKey,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_001 },
    objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
    remote: {
      async putObject() {
        return { status: 'already-stored' as const }
      },
    },
  })
  assert.deepEqual(
    [...partitionFirst.acknowledged.record.items, ...partitionSecondAcknowledged.record.items]
      .map((item) => item.objectId)
      .sort(),
    multiBatchTarget.objects.map((object) => object.objectId).sort(),
  )
  let crossRowAbortCalls = 0
  const partitionFinalize = journalEncryptedWalletBackupCasHandoffForTest({
    keyHandle: partitionRestartKey,
    claim: partitionRestartClaim!,
    store: partitionStore,
  })
  const partitionStaleAbort = abandonEncryptedWalletBackupUploadAttempt({
    claim: partitionFirst.claim,
    store: partitionStore,
    keyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/vault/upload-attempts/f6:abort',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async abortUploadAttempt() {
        crossRowAbortCalls += 1
        return { status: 'abandoned' as const }
      },
    },
  })
  const [partitionFinalizeResult, partitionAbortResult] = await Promise.allSettled([
    partitionFinalize,
    partitionStaleAbort,
  ])
  assert.equal(partitionFinalizeResult.status, 'fulfilled')
  assert.equal(partitionAbortResult.status, 'rejected')
  assert.equal(crossRowAbortCalls, 0)

  const abortPartitionStore = inMemoryUploadBatchStore()
  const abortPartitionFirst = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: multiBatchTarget.head,
    batchId: 'f8'.repeat(16),
    attemptId: 'f9'.repeat(16),
    store: abortPartitionStore,
    batchIndex: 0,
  })
  const abortPartitionSecond = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: multiBatchTarget.head,
    batchId: 'fa'.repeat(16),
    attemptId: 'f9'.repeat(16),
    store: abortPartitionStore,
    claim: abortPartitionFirst.claim,
    batchIndex: 1,
  })
  const crossRowAbortFirst = abandonEncryptedWalletBackupUploadAttempt({
    claim: abortPartitionFirst.claim,
    store: abortPartitionStore,
    keyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/vault/upload-attempts/f9:abort',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    remote: {
      async abortUploadAttempt() {
        return { status: 'abandoned' as const }
      },
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  const crossRowFinalizeSecond = journalEncryptedWalletBackupCasHandoffForTest({
    keyHandle,
    claim: abortPartitionFirst.claim,
    store: abortPartitionStore,
  })
  const [crossRowAbortResult, crossRowFinalizeResult] = await Promise.allSettled([
    crossRowAbortFirst,
    crossRowFinalizeSecond,
  ])
  assert.equal(crossRowAbortResult.status, 'fulfilled')
  assert.equal(crossRowFinalizeResult.status, 'rejected')

  const duplicatePartitionStore = inMemoryUploadBatchStore()
  const duplicateFirst = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: multiBatchTarget.head,
    batchId: 'fb'.repeat(16),
    attemptId: 'fc'.repeat(16),
    store: duplicatePartitionStore,
    batchIndex: 0,
  })
  await assert.rejects(
    () =>
      acknowledgeTargetUploadsForTest({
        keyHandle,
        targetHead: multiBatchTarget.head,
        batchId: 'fd'.repeat(16),
        attemptId: 'fc'.repeat(16),
        store: duplicatePartitionStore,
        claim: duplicateFirst.claim,
        batchIndex: 0,
      }),
    /duplicated/,
  )
  const rolledBackDuplicate = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: duplicateFirst.batchId,
    keyHandle,
    store: duplicatePartitionStore,
  })
  assert.equal(rolledBackDuplicate.record.state, 'acknowledged')

  const mixedFinalized = structuredClone(finalizedBatchAfterRestart.record)
  const mixedAcknowledged = structuredClone(abortWins.acknowledged.record)
  mixedAcknowledged.attemptId = mixedFinalized.attemptId
  mixedAcknowledged.targetManifestDigest = mixedFinalized.targetManifestDigest
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupCasHandoffForTest({
        uploadAttemptId: mixedFinalized.attemptId,
        keyHandle: restartedKeyHandle,
        store: {
          ...finalizedBundle.store,
          async sealOrReadLinkedCasAttempt<T>(
            claim: Record<string, unknown>,
            candidate: Record<string, unknown>,
            read: (value: never) => T,
          ) {
            return read({
              attempt: {
                ...structuredClone(claim),
                lifecycle: 'cas-journaled',
                casAttemptId: candidate.attemptId,
                batchIds: [mixedFinalized.batchId, mixedAcknowledged.batchId],
              },
              batches: [mixedFinalized, mixedAcknowledged],
              casAttempts: [structuredClone(candidate)],
            } as never)
          },
        },
      }),
    /finalized backup upload batch set is invalid|aggregate batch partition/,
  )
})

test('upload ownership and execution leases survive takeover boundaries', async () => {
  const { keyHandle, head, authenticated, page, chunks, chunkObjects } =
    await createManifestUploadFixtureForTest()

  const leaseStore = inMemoryUploadBatchStore()
  const staleOwnerClaim = await sealEncryptedWalletBackupUploadAttempt({
    attemptId: '67'.repeat(16),
    ownerId: 'owner-one',
    leaseDurationMilliseconds: 10,
    keyHandle,
    targetHead: head,
    store: leaseStore,
  })
  leaseStore.setNowUnixMilliseconds(staleOwnerClaim.record.leaseExpiresAtUnixMilliseconds)
  const takeover = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'owner-two',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: leaseStore,
  })
  assert.equal(takeover!.record.ownerEpoch, staleOwnerClaim.record.ownerEpoch + 1)
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        batchId: '66'.repeat(16),
        claim: staleOwnerClaim,
        keyHandle,
        plannedBatch: plannedUploadBatchForTest(keyHandle, head, staleOwnerClaim.record.attemptId),
        store: leaseStore,
      }),
    /stale backup upload owner claim/,
  )
  const takeoverBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '65'.repeat(16),
    claim: takeover!,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, takeover!.record.attemptId),
    store: leaseStore,
  })
  let staleOwnerNetworkCalls = 0
  await assert.rejects(
    () =>
      uploadEncryptedWalletBackupBatch({
        batch: takeoverBatch,
        claim: staleOwnerClaim,
        store: leaseStore,
        keyHandle,
        enrollmentEpoch: 1,
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
        remote: {
          async putObject() {
            staleOwnerNetworkCalls += 1
            return { status: 'stored' as const }
          },
        },
      }),
    /stale backup upload owner claim/,
  )
  assert.equal(staleOwnerNetworkCalls, 0)

  const uniquenessStore = inMemoryUploadBatchStore()
  const firstVaultAttempt = await sealEncryptedWalletBackupUploadAttempt({
    attemptId: '61'.repeat(16),
    ownerId: 'single-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    targetHead: head,
    store: uniquenessStore,
  })
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '60'.repeat(16),
        ownerId: 'single-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: head,
        store: uniquenessStore,
      }),
    /live backup upload attempt already exists/,
  )
  const restartedSingle = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'single-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: uniquenessStore,
  })
  assert.equal(restartedSingle!.record.attemptId, firstVaultAttempt.record.attemptId)
  assert.equal(restartedSingle!.record.ownerEpoch, firstVaultAttempt.record.ownerEpoch + 1)
  const renewedSingle = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'single-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: uniquenessStore,
  })
  assert.equal(renewedSingle!.record.ownerEpoch, restartedSingle!.record.ownerEpoch + 1)
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        batchId: '5f'.repeat(16),
        claim: restartedSingle!,
        keyHandle,
        plannedBatch: plannedUploadBatchForTest(keyHandle, head, restartedSingle!.record.attemptId),
        store: uniquenessStore,
      }),
    /stale backup upload owner claim/,
  )

  const idempotentStore = inMemoryUploadBatchStore()
  const idempotentClaim = await uploadAttemptClaimForTest(
    keyHandle,
    head,
    idempotentStore,
    '63'.repeat(16),
  )
  const idempotentInput = {
    batchId: '62'.repeat(16),
    claim: idempotentClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, idempotentClaim.record.attemptId),
    store: idempotentStore,
  }
  const idempotentFirst = await sealEncryptedWalletBackupUploadBatch(idempotentInput)
  const idempotentRetry = await sealEncryptedWalletBackupUploadBatch(idempotentInput)
  assert.equal(
    isDeepStrictEqual(idempotentRetry.record, idempotentFirst.record),
    true,
    'idempotent batch retry must return the exact persisted record',
  )
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        ...idempotentInput,
        plannedBatch: { ...idempotentInput.plannedBatch },
      }),
    /prepared backup upload batch is invalid/,
  )
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        ...idempotentInput,
        batchId: '5e'.repeat(16),
      }),
    /prepared backup upload batch is invalid/,
  )

  const executionStore = inMemoryUploadBatchStore()
  const executionClaim = await uploadAttemptClaimForTest(
    keyHandle,
    head,
    executionStore,
    '5d'.repeat(16),
  )
  const executionBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '5c'.repeat(16),
    claim: executionClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, executionClaim.record.attemptId),
    store: executionStore,
  })
  let releaseFirstExecution!: () => void
  const holdFirstExecution = new Promise<void>((resolve) => {
    releaseFirstExecution = resolve
  })
  let observeFirstPut!: () => void
  const firstPutStarted = new Promise<void>((resolve) => {
    observeFirstPut = resolve
  })
  const firstExecution = uploadEncryptedWalletBackupBatch({
    batch: executionBatch,
    claim: executionClaim,
    store: executionStore,
    keyHandle,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
    remote: {
      async putObject() {
        observeFirstPut()
        await holdFirstExecution
        return { status: 'stored' as const }
      },
    },
  })
  await firstPutStarted
  const concurrentBatch = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: executionBatch.record.batchId,
    keyHandle,
    store: executionStore,
  })
  let concurrentPutCalls = 0
  await assert.rejects(
    () =>
      uploadEncryptedWalletBackupBatch({
        batch: concurrentBatch,
        claim: executionClaim,
        store: executionStore,
        keyHandle,
        enrollmentEpoch: 1,
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        runtime: {
          subtle: webcrypto.subtle,
          getRandomValues(target) {
            return webcrypto.getRandomValues(target)
          },
        },
        objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
        remote: {
          async putObject() {
            concurrentPutCalls += 1
            return { status: 'stored' as const }
          },
        },
      }),
    /execution lease is active/,
  )
  assert.equal(concurrentPutCalls, 0)
  releaseFirstExecution()
  assert.equal((await firstExecution).record.state, 'acknowledged')

  const delayedStore = inMemoryUploadBatchStore()
  const delayedClaim = await sealEncryptedWalletBackupUploadAttempt({
    attemptId: '5b'.repeat(16),
    ownerId: 'signing-owner',
    leaseDurationMilliseconds: 10,
    keyHandle,
    targetHead: head,
    store: delayedStore,
  })
  const delayedBatch = await sealEncryptedWalletBackupUploadBatch({
    batchId: '5a'.repeat(16),
    claim: delayedClaim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, delayedClaim.record.attemptId),
    store: delayedStore,
  })
  let releaseSigning!: () => void
  const signingGate = new Promise<void>((resolve) => {
    releaseSigning = resolve
  })
  let observeSigning!: () => void
  const signingStarted = new Promise<void>((resolve) => {
    observeSigning = resolve
  })
  const delayedSubtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      if (property === 'deriveBits') {
        return async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
          observeSigning()
          await signingGate
          return target.deriveBits(...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SubtleCrypto
  let delayedPutCalls = 0
  const delayedUpload = uploadEncryptedWalletBackupBatch({
    batch: delayedBatch,
    claim: delayedClaim,
    store: delayedStore,
    keyHandle,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: {
      subtle: delayedSubtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
    remote: {
      async putObject() {
        delayedPutCalls += 1
        return { status: 'stored' as const }
      },
    },
  })
  await signingStarted
  delayedStore.setNowUnixMilliseconds(delayedClaim.record.leaseExpiresAtUnixMilliseconds)
  const delayedTakeover = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'signing-takeover',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: delayedStore,
  })
  assert.equal(delayedTakeover!.record.ownerEpoch, delayedClaim.record.ownerEpoch + 1)
  releaseSigning()
  await assert.rejects(() => delayedUpload, /stale backup upload owner claim/)
  assert.equal(delayedPutCalls, 0)

  await assert.rejects(
    () =>
      prepareIncrementalEncryptedWalletBackupManifest({
        keyHandle,
        generation: 2,
        snapshotNonce: new Uint8Array(16).fill(111),
        parentEvidence: authenticated,
        parentPages: [page],
        chunks: [
          { chunk: chunks[0]!, object: chunkObjects[0]! },
          { chunk: chunks[0]!, object: chunkObjects[0]! },
        ],
        removedProofIds: [],
        snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
        snapshotStore: acceptingSnapshotSealStore(),
      }),
    /duplicated/,
  )
})

test('delayed CAS and abort signing cannot dispatch after owner takeover', async () => {
  const casFixture = await createCasRecoveryFixtureForTest()
  const casDelay = delayedSigningRuntimeForTest()
  let casDispatches = 0
  const casWork = synchronizeEncryptedWalletBackupManifestHead({
    attempt: casFixture.finalizedNextUploads.casAttempt,
    keyHandle: casFixture.keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: casDelay.runtime,
    remote: {
      async compareAndSwapCurrentHead() {
        casDispatches += 1
        return { status: 'committed' as const }
      },
      async readCurrentHead() {
        assert.fail('stale CAS owner must fail before head observation')
      },
    },
  })
  await casDelay.signingStarted
  casFixture.finalizedBundle.store.setNowUnixMilliseconds(
    casFixture.finalizedNextUploads.claim.record.leaseExpiresAtUnixMilliseconds,
  )
  const casTakeover = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'cas-takeover',
    leaseDurationMilliseconds: 60_000,
    keyHandle: casFixture.keyHandle,
    store: casFixture.finalizedBundle.store,
  })
  assert.notEqual(casTakeover, null)
  casDelay.releaseSigning()
  await assert.rejects(() => casWork, /stale backup upload owner claim/)
  assert.equal(casDispatches, 0)

  const preAbort = await createSealedUploadMutationFixtureForTest('89')
  const preAbortDelay = delayedSigningRuntimeForTest()
  let preAbortDispatches = 0
  const preAbortWork = abandonEncryptedWalletBackupUploadAttempt({
    claim: preAbort.claim,
    keyHandle: preAbort.keyHandle,
    store: preAbort.store,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/upload-attempts/abort',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: preAbortDelay.runtime,
    remote: {
      async abortUploadAttempt() {
        preAbortDispatches += 1
        return { status: 'abandoned' as const }
      },
    },
  })
  await preAbortDelay.signingStarted
  preAbort.store.setNowUnixMilliseconds(preAbort.claim.record.leaseExpiresAtUnixMilliseconds)
  const abortTakeover = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'abort-takeover',
    leaseDurationMilliseconds: 60_000,
    keyHandle: preAbort.keyHandle,
    store: preAbort.store,
  })
  assert.notEqual(abortTakeover, null)
  preAbortDelay.releaseSigning()
  await assert.rejects(() => preAbortWork, /stale backup upload owner claim/)
  assert.equal(preAbortDispatches, 0)

  const cleanupFixture = await createRejectedCasFixtureForTest()
  const cleanupDelay = delayedSigningRuntimeForTest()
  let cleanupDispatches = 0
  const cleanupWork = cleanUpRejectedEncryptedWalletBackupFork({
    claim: cleanupFixture.finalizedNextUploads.claim,
    keyHandle: cleanupFixture.keyHandle,
    store: cleanupFixture.finalizedBundle.store,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/upload-attempts/abort',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: cleanupDelay.runtime,
    remote: {
      async abortUploadAttempt() {
        cleanupDispatches += 1
        return { status: 'abandoned' as const }
      },
    },
  })
  await cleanupDelay.signingStarted
  cleanupFixture.finalizedBundle.store.setNowUnixMilliseconds(
    cleanupFixture.finalizedNextUploads.claim.record.leaseExpiresAtUnixMilliseconds,
  )
  const cleanupTakeover = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'cleanup-takeover',
    leaseDurationMilliseconds: 60_000,
    keyHandle: cleanupFixture.keyHandle,
    store: cleanupFixture.finalizedBundle.store,
  })
  assert.notEqual(cleanupTakeover, null)
  cleanupDelay.releaseSigning()
  await assert.rejects(() => cleanupWork, /stale backup upload owner claim/)
  assert.equal(cleanupDispatches, 0)
})

test('coordinator atomically journals deterministic CAS work and completes the aggregate', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const acknowledged = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: '6a'.repeat(16),
    attemptId: '6b'.repeat(16),
  })
  const expectedCasId = deriveEncryptedWalletBackupCasAttemptId({
    realm: acknowledged.claim.record.realm,
    vaultId: acknowledged.claim.record.vaultId,
    uploadAttemptId: acknowledged.claim.record.attemptId,
    targetManifestDigest: acknowledged.claim.record.targetManifestDigest,
  })
  assert.equal(expectedCasId, '4a8a1bdab0b4287332d047c6bff0be93')
  const separatedIds = new Set([
    expectedCasId,
    deriveEncryptedWalletBackupCasAttemptId({
      realm: `${acknowledged.claim.record.realm}-other`,
      vaultId: acknowledged.claim.record.vaultId,
      uploadAttemptId: acknowledged.claim.record.attemptId,
      targetManifestDigest: acknowledged.claim.record.targetManifestDigest,
    }),
    deriveEncryptedWalletBackupCasAttemptId({
      realm: acknowledged.claim.record.realm,
      vaultId: '01'.repeat(32),
      uploadAttemptId: acknowledged.claim.record.attemptId,
      targetManifestDigest: acknowledged.claim.record.targetManifestDigest,
    }),
    deriveEncryptedWalletBackupCasAttemptId({
      realm: acknowledged.claim.record.realm,
      vaultId: acknowledged.claim.record.vaultId,
      uploadAttemptId: '01'.repeat(16),
      targetManifestDigest: acknowledged.claim.record.targetManifestDigest,
    }),
    deriveEncryptedWalletBackupCasAttemptId({
      realm: acknowledged.claim.record.realm,
      vaultId: acknowledged.claim.record.vaultId,
      uploadAttemptId: acknowledged.claim.record.attemptId,
      targetManifestDigest: '01'.repeat(32),
    }),
  ])
  assert.equal(separatedIds.size, 5)
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: acknowledged.claim,
    keyHandle,
    store: acknowledged.store,
  })
  assert.equal(cas.record.attemptId, expectedCasId)
  const journaled = await acknowledged.store.readUploadAttempt(
    acknowledged.claim.record.attemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(journaled.lifecycle, 'cas-journaled')
  assert.equal(journaled.casAttemptId, expectedCasId)
  assert.equal(
    (
      await rehydrateEncryptedWalletBackupUploadBatch({
        batchId: acknowledged.batchId,
        keyHandle,
        store: acknowledged.store,
      })
    ).record.state,
    'finalized',
  )
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '6c'.repeat(16),
        ownerId: 'other-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: head,
        store: acknowledged.store,
      }),
    /live backup upload attempt already exists/,
  )
  const restartedClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: acknowledged.store,
  })
  assert.notEqual(restartedClaim, null)
  const rehydrated = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: restartedClaim!,
    keyHandle,
    store: acknowledged.store,
  })
  assert.equal(rehydrated.record.attemptId, expectedCasId)
  assert.equal(rehydrated.record.state, 'sealed')
  const completed = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: rehydrated,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async compareAndSwapCurrentHead() {
        return { status: 'committed' as const }
      },
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(head),
        }
      },
    },
  })
  assert.equal(completed.record.state, 'acknowledged')
  assert.deepEqual(acknowledged.store.coordinatorRecordCounts(), {
    attempts: 0,
    batches: 0,
    casAttempts: 0,
  })
  await sealEncryptedWalletBackupUploadAttempt({
    attemptId: '6c'.repeat(16),
    ownerId: 'other-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    targetHead: head,
    store: acknowledged.store,
  })
})

test('CAS signing and dispatch use only private persisted payload bytes', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const fixture = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: '7a'.repeat(16),
    attemptId: '7b'.repeat(16),
  })
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: fixture.claim,
    keyHandle,
    store: fixture.store,
  })
  const expectedPayload = cas.record.canonicalCasPayload.slice()
  cas.record.canonicalCasPayload.fill(0x41)
  const delayed = delayedSigningRuntimeForTest()
  let dispatches = 0
  const synchronization = synchronizeEncryptedWalletBackupManifestHead({
    attempt: cas,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: delayed.runtime,
    remote: {
      async compareAndSwapCurrentHead({ canonicalCasPayload }) {
        dispatches += 1
        assert.equal(
          isDeepStrictEqual(canonicalCasPayload, expectedPayload),
          true,
          'CAS dispatch must use the exact private persisted payload',
        )
        return { status: 'committed' as const }
      },
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(head),
        }
      },
    },
  })
  await delayed.signingStarted
  cas.record.canonicalCasPayload.fill(0x42)
  delayed.releaseSigning()
  const completed = await synchronization
  assert.equal(completed.record.state, 'acknowledged')
  assert.equal(dispatches, 1)
})

test('acknowledged CAS completion validates the exact finalized batch partition before deletion', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const fixture = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: '7e'.repeat(16),
    attemptId: '7f'.repeat(16),
  })
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: fixture.claim,
    keyHandle,
    store: fixture.store,
  })
  const retained = fixture.store.coordinatorRecordCounts()
  await assert.rejects(
    () =>
      synchronizeEncryptedWalletBackupManifestHead({
        attempt: cas,
        keyHandle,
        enrollmentEpoch: 1,
        casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
        headUrl: 'https://backup.example.test/v1/head',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {
          async compareAndSwapCurrentHead() {
            fixture.store.mutateUploadBatch(fixture.batchId, (batch) => {
              batch.targetManifestDigest = 'ff'.repeat(32)
            })
            return { status: 'committed' as const }
          },
          async readCurrentHead() {
            return {
              status: 'found' as const,
              enrollmentEpoch: 1,
              head: readPreparedEncryptedWalletBackupManifestHead(head),
            }
          },
        },
      }),
    /batch partition (?:changed|is incomplete)/,
  )
  assert.deepEqual(fixture.store.coordinatorRecordCounts(), retained)
  const persistedCas = await fixture.store.readCasAttempt(
    cas.record.attemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(persistedCas.state, 'cas-uncertain')
})

test('terminal CAS adapter callback faults roll back transition and deletion', async (t) => {
  const modes = ['wrong', 'incomplete', 'corrupt', 'multiple', 'late'] as const
  for (const mode of modes) {
    await t.test(mode, async () => {
      const { keyHandle, head } = await createManifestUploadFixtureForTest()
      const fixture = await acknowledgeTargetUploadsForTest({
        keyHandle,
        targetHead: head,
        batchId: '8c'.repeat(16),
        attemptId: '8d'.repeat(16),
      })
      const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: fixture.claim,
        keyHandle,
        store: fixture.store,
      })
      const retained = fixture.store.coordinatorRecordCounts()
      const original = fixture.store.completeLinkedCasAttempt
      let lateCallback: ((value: never) => unknown) | undefined
      let lateRaw: never | undefined
      fixture.store.completeLinkedCasAttempt = async function <T>(
        claim: Record<string, unknown>,
        expected: Record<string, unknown>,
        next: Record<string, unknown>,
        commit: (value: never) => T,
      ): Promise<T> {
        try {
          return await original(claim, expected, next, (raw: never) => {
            if (mode === 'multiple') {
              const first = commit(raw)
              commit(raw)
              return first
            }
            if (mode === 'late') {
              lateCallback = commit
              lateRaw = raw
              throw new Error('capture late terminal callback')
            }
            const changed = structuredClone(raw) as {
              batches: Array<Record<string, unknown>>
              casAttempts: Array<Record<string, unknown>>
            }
            if (mode === 'wrong') changed.casAttempts[0]!.state = 'cas-uncertain'
            else if (mode === 'incomplete') changed.batches.length = 0
            else changed.batches[0]!.localSnapshotRevision = -1
            return commit(changed as never)
          })
        } catch (error) {
          if (mode === 'late') return {} as T
          throw error
        }
      }
      await assert.rejects(
        () =>
          synchronizeEncryptedWalletBackupManifestHead({
            attempt: cas,
            keyHandle,
            enrollmentEpoch: 1,
            casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
            headUrl: 'https://backup.example.test/v1/head',
            clock: { nowUnixSeconds: () => 1_700_000_000 },
            remote: {
              async compareAndSwapCurrentHead() {
                return { status: 'committed' as const }
              },
              async readCurrentHead() {
                return {
                  status: 'found' as const,
                  enrollmentEpoch: 1,
                  head: readPreparedEncryptedWalletBackupManifestHead(head),
                }
              },
            },
          }),
        /callback is invalid|synchronous and exact|lifecycles are inconsistent|partition|snapshot revision/,
      )
      assert.deepEqual(fixture.store.coordinatorRecordCounts(), retained)
      const persistedCas = await fixture.store.readCasAttempt(
        cas.record.attemptId,
        (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
      )
      assert.equal(persistedCas.state, 'cas-uncertain')
      if (mode === 'late') assert.throws(() => lateCallback!(lateRaw!), /callback is invalid/)
    })
  }
})

test('removed two-step upload/CAS APIs are absent from public modules', () => {
  for (const name of [
    'finalizeEncryptedWalletBackupUploadSet',
    'rehydrateFinalizedEncryptedWalletBackupUploadSet',
    'finalizeZeroDeltaEncryptedWalletBackupUploadAttempt',
    'rehydrateFinalizedZeroDeltaEncryptedWalletBackupUploadAttempt',
  ]) {
    assert.equal(name in BackupSyncModule, false)
  }
  for (const name of [
    'sealEncryptedWalletBackupSyncAttempt',
    'rehydrateEncryptedWalletBackupSyncAttempt',
  ]) {
    assert.equal(name in BackupModule, false)
  }
})

test('coordinator handoff rolls back and deterministic CAS collisions fail closed', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const rollback = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: '6d'.repeat(16),
    attemptId: '6e'.repeat(16),
  })
  const originalRollbackHandoff = rollback.store.sealOrReadLinkedCasAttempt
  rollback.store.sealOrReadLinkedCasAttempt = async function <T>(
    claim: Record<string, unknown>,
    candidate: Record<string, unknown>,
    commit: (raw: never) => T,
  ): Promise<T> {
    return originalRollbackHandoff(claim, candidate, (raw: never) => {
      const first = commit(raw)
      commit(raw)
      return first
    })
  }
  await assert.rejects(
    () =>
      sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: rollback.claim,
        keyHandle,
        store: rollback.store,
      }),
    /callback is invalid/,
  )
  rollback.store.sealOrReadLinkedCasAttempt = originalRollbackHandoff
  assert.equal(
    (
      await rehydrateEncryptedWalletBackupUploadBatch({
        batchId: rollback.batchId,
        keyHandle,
        store: rollback.store,
      })
    ).record.state,
    'acknowledged',
  )
  const afterRollback = await rollback.store.readUploadAttempt(
    rollback.claim.record.attemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(afterRollback.lifecycle, 'active')
  assert.equal(afterRollback.casAttemptId, null)

  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: rollback.claim,
    keyHandle,
    store: rollback.store,
  })
  rollback.store.mutateCasAttempt(cas.record.attemptId, (record) => {
    record.localSnapshotRevision = Number(record.localSnapshotRevision) + 1
  })
  const restartedClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: rollback.store,
  })
  assert.notEqual(restartedClaim, null)
  await assert.rejects(
    () =>
      sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: restartedClaim!,
        keyHandle,
        store: rollback.store,
      }),
    /deterministic backup CAS id collision/,
  )
})

test('coordinator rejects aggregate authority mutation during a linked CAS transition', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const fixture = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: '71'.repeat(16),
    attemptId: '72'.repeat(16),
  })
  const originalHostileTransition = fixture.store.transitionLinkedCasAttempt
  fixture.store.transitionLinkedCasAttempt = async function <T>(
    claim: Record<string, unknown>,
    expected: Record<string, unknown>,
    next: Record<string, unknown>,
    lifecycle: string,
    commit: (value: never) => T,
  ): Promise<T> {
    return originalHostileTransition(
      claim,
      expected,
      next,
      lifecycle,
      (raw: { attempt: Record<string, unknown>; casAttempts: Record<string, unknown>[] }) => {
        const hostile = structuredClone(raw)
        hostile.attempt.ownerEpoch = Number(hostile.attempt.ownerEpoch) + 1
        return commit(hostile as never)
      },
    )
  }
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: fixture.claim,
    keyHandle,
    store: fixture.store,
  })
  await assert.rejects(
    () =>
      advanceEncryptedWalletBackupSyncAttempt({
        attempt: cas,
        event: { type: 'cas-dispatched' },
      }),
    /aggregate authority changed/,
  )
  const aggregate = await fixture.store.readUploadAttempt(
    fixture.claim.record.attemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(aggregate.lifecycle, 'cas-journaled')
  const persistedCas = await fixture.store.readCasAttempt(
    cas.record.attemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(persistedCas.state, 'sealed')
  fixture.store.transitionLinkedCasAttempt = originalHostileTransition
})

test('foreign-head cleanup retains the slot and already-finalized releases it without receipt', async () => {
  const { keyHandle, foreignObservation, finalizedNextUploads, finalizedBundle, nextHead } =
    await createCasRecoveryFixtureForTest()
  const uncertain = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: finalizedNextUploads.casAttempt,
    event: { type: 'cas-dispatched' },
  })
  const rejected = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: uncertain,
    event: { type: 'head-observed', observation: foreignObservation },
  })
  assert.equal(rejected.record.state, 'fork-rejected')
  const fenced = await finalizedBundle.store.readUploadAttempt(
    finalizedNextUploads.uploadAttemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(fenced.lifecycle, 'fork-cleanup-uncertain')
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '73'.repeat(16),
        ownerId: 'other-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: nextHead,
        store: finalizedBundle.store,
      }),
    /live backup upload attempt already exists/,
  )
  await assert.rejects(
    () =>
      cleanUpRejectedEncryptedWalletBackupFork({
        claim: finalizedNextUploads.claim,
        store: finalizedBundle.store,
        keyHandle,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/upload-attempts/cleanup',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {} as never,
      }),
    /cleanup port is invalid/,
  )
  const retainedCounts = finalizedBundle.store.coordinatorRecordCounts()
  await assert.rejects(
    () =>
      cleanUpRejectedEncryptedWalletBackupFork({
        claim: finalizedNextUploads.claim,
        store: finalizedBundle.store,
        keyHandle,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/upload-attempts/cleanup',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {
          async abortUploadAttempt() {
            throw new Error('network unavailable')
          },
        },
      }),
    /cleanup is unavailable/,
  )
  assert.deepEqual(finalizedBundle.store.coordinatorRecordCounts(), retainedCounts)
  const retained = await finalizedBundle.store.readUploadAttempt(
    finalizedNextUploads.uploadAttemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  assert.equal(retained.lifecycle, 'fork-cleanup-uncertain')
  const cleaned = await cleanUpRejectedEncryptedWalletBackupFork({
    claim: finalizedNextUploads.claim,
    store: finalizedBundle.store,
    keyHandle,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/upload-attempts/cleanup',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async abortUploadAttempt() {
        return { status: 'already-finalized' as const }
      },
    },
  })
  assert.equal(cleaned.state, 'complete')
  assert.equal(cleaned.receiptAuthority, 'none')
  await sealEncryptedWalletBackupUploadAttempt({
    attemptId: '73'.repeat(16),
    ownerId: 'other-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    targetHead: nextHead,
    store: finalizedBundle.store,
  })
})

test('fork cleanup binds immutable CAS identity and rejects callback protocol faults', async () => {
  const identityFixture = await createRejectedCasFixtureForTest()
  const identityStore = identityFixture.finalizedBundle.store
  const identityCasId = identityFixture.rejected.record.attemptId
  const baselineCas = await identityStore.readCasAttempt(
    identityCasId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  const delayed = delayedSigningRuntimeForTest()
  let remoteCalls = 0
  const cleanup = cleanUpRejectedEncryptedWalletBackupFork({
    claim: identityFixture.finalizedNextUploads.claim,
    keyHandle: identityFixture.keyHandle,
    store: identityStore,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/upload-attempts/cleanup',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: delayed.runtime,
    remote: {
      async abortUploadAttempt() {
        remoteCalls += 1
        return { status: 'abandoned' as const }
      },
    },
  })
  await delayed.signingStarted
  identityStore.mutateCasAttempt(identityCasId, (record) => {
    record.localSnapshotRevision = Number(record.localSnapshotRevision) + 1
  })
  delayed.releaseSigning()
  await assert.rejects(() => cleanup, /immutable identity changed|authority changed/)
  assert.equal(remoteCalls, 0)
  identityStore.replaceCasAttempt(identityCasId, baselineCas)

  const repeatedFixture = await createRejectedCasFixtureForTest()
  const repeatedStore = repeatedFixture.finalizedBundle.store
  const retainedCounts = repeatedStore.coordinatorRecordCounts()
  const originalCompletion = repeatedStore.completeForkCleanup
  repeatedStore.completeForkCleanup = async function <T>(
    claim: Record<string, unknown>,
    expected: Record<string, unknown>,
    outcome: string,
    commit: (value: never) => T,
  ): Promise<T> {
    return originalCompletion(claim, expected, outcome, (raw: never) => {
      const first = commit(raw)
      commit(raw)
      return first
    })
  }
  await assert.rejects(
    () =>
      cleanUpRejectedEncryptedWalletBackupFork({
        claim: repeatedFixture.finalizedNextUploads.claim,
        keyHandle: repeatedFixture.keyHandle,
        store: repeatedStore,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/upload-attempts/cleanup',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {
          async abortUploadAttempt() {
            return { status: 'abandoned' as const }
          },
        },
      }),
    /callback is invalid/,
  )
  assert.deepEqual(repeatedStore.coordinatorRecordCounts(), retainedCounts)
  repeatedStore.completeForkCleanup = originalCompletion

  let lateCallback: ((value: never) => unknown) | undefined
  let lateRaw: never | undefined
  repeatedStore.completeForkCleanup = async function <T>(
    claim: Record<string, unknown>,
    expected: Record<string, unknown>,
    outcome: string,
    commit: (value: never) => T,
  ): Promise<T> {
    lateCallback = commit
    try {
      await originalCompletion(claim, expected, outcome, (raw: never) => {
        lateRaw = raw
        throw new Error('capture terminal cleanup callback')
      })
    } catch {
      return {} as T
    }
    throw new Error('missing cleanup rollback')
  }
  await assert.rejects(
    () =>
      cleanUpRejectedEncryptedWalletBackupFork({
        claim: repeatedFixture.finalizedNextUploads.claim,
        keyHandle: repeatedFixture.keyHandle,
        store: repeatedStore,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/upload-attempts/cleanup',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {
          async abortUploadAttempt() {
            return { status: 'abandoned' as const }
          },
        },
      }),
    /synchronous and exact/,
  )
  assert.throws(() => lateCallback!(lateRaw!), /callback is invalid/)
  assert.deepEqual(repeatedStore.coordinatorRecordCounts(), retainedCounts)
  repeatedStore.completeForkCleanup = originalCompletion
})

test('zero-delta fork cleanup is automatic and deletes terminal coordinator rows', async () => {
  const fixture = await createManifestUploadFixtureForTest()
  const prepareEmptyChild = async (nonce: number) => {
    const manifest = await prepareIncrementalEncryptedWalletBackupManifest({
      keyHandle: fixture.keyHandle,
      generation: 2,
      snapshotNonce: new Uint8Array(16).fill(nonce),
      parentEvidence: fixture.authenticated,
      parentPages: [fixture.page],
      chunks: [],
      removedProofIds: fixture.page.entries.map((entry) => entry.proofId),
      snapshot: { snapshotId: `empty-${nonce}`, snapshotRevision: nonce },
      snapshotStore: acceptingSnapshotSealStore(),
    })
    return prepareEncryptedWalletBackupManifestHead({
      keyHandle: fixture.keyHandle,
      manifest,
      parent: fixture.authenticated.head,
    })
  }
  const targetHead = await prepareEmptyChild(91)
  const foreignHead = await prepareEmptyChild(92)
  assert.equal(targetHead.objectCount, 0)
  const foreignObservation = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: fixture.keyHandle,
    enrollmentEpoch: 1,
    requestProof: fixture.headRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(foreignHead),
        }
      },
    },
  })
  const store = inMemoryUploadBatchStore()
  const claim = await uploadAttemptClaimForTest(
    fixture.keyHandle,
    targetHead,
    store,
    '8b'.repeat(16),
  )
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim,
    keyHandle: fixture.keyHandle,
    store,
  })
  const uncertain = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: cas,
    event: { type: 'cas-dispatched' },
  })
  await advanceEncryptedWalletBackupSyncAttempt({
    attempt: uncertain,
    event: { type: 'head-observed', observation: foreignObservation },
  })
  const cleaned = await cleanUpRejectedEncryptedWalletBackupFork({
    claim,
    keyHandle: fixture.keyHandle,
    store,
    enrollmentEpoch: 1,
    url: 'https://backup.example.test/v1/upload-attempts/cleanup',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async abortUploadAttempt() {
        return { status: 'abandoned' as const }
      },
    },
  })
  assert.equal(cleaned.state, 'abandoned')
  assert.deepEqual(store.coordinatorRecordCounts(), {
    attempts: 0,
    batches: 0,
    casAttempts: 0,
  })
})

test('fork cleanup binds every duplicated CAS head field to canonical aggregate bytes before dispatch', async (t) => {
  const mutations = [
    {
      name: 'snapshot nonce',
      mutate(target: Record<string, unknown>) {
        target.snapshotNonce = '11'.repeat(16)
      },
    },
    {
      name: 'derived snapshot id',
      mutate(target: Record<string, unknown>) {
        target.snapshotId = '22'.repeat(32)
      },
    },
    {
      name: 'reference-set digest',
      mutate(target: Record<string, unknown>) {
        target.referenceSetDigest = '33'.repeat(32)
      },
    },
    {
      name: 'parent generation',
      mutate(target: Record<string, unknown>) {
        const parent = target.parent as Record<string, unknown>
        parent.generation = Number(parent.generation) + 1
      },
    },
  ] as const
  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const fixture = await createRejectedCasFixtureForTest()
      const store = fixture.finalizedBundle.store
      store.mutateCasAttempt(fixture.rejected.record.attemptId, (record) => {
        mutation.mutate(record.targetHead as Record<string, unknown>)
      })
      let remoteCalls = 0
      await assert.rejects(
        () =>
          cleanUpRejectedEncryptedWalletBackupFork({
            claim: fixture.finalizedNextUploads.claim,
            keyHandle: fixture.keyHandle,
            store,
            enrollmentEpoch: 1,
            url: 'https://backup.example.test/v1/upload-attempts/cleanup',
            clock: { nowUnixSeconds: () => 1_700_000_000 },
            remote: {
              async abortUploadAttempt() {
                remoteCalls += 1
                return { status: 'abandoned' as const }
              },
            },
          }),
        /canonical aggregate target|target does not match/,
      )
      assert.equal(remoteCalls, 0)
    })
  }
})

test('linked CAS retry, crash rehydration, and DB-time exhaustion remain exact', async () => {
  const { keyHandle, authenticated, finalizedNextUploads, finalizedBundle } =
    await createCasRecoveryFixtureForTest()
  let value = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: finalizedNextUploads.casAttempt,
    event: { type: 'cas-dispatched' },
  })
  const restartClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.notEqual(restartClaim, null)
  value = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: restartClaim!,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.equal(value.record.state, 'cas-uncertain')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    value = await advanceEncryptedWalletBackupSyncAttempt({
      attempt: value,
      event: { type: 'head-observed', observation: authenticated },
    })
    if (attempt < 3) {
      assert.equal(value.record.state, 'retry-cas')
      value = await advanceEncryptedWalletBackupSyncAttempt({
        attempt: value,
        event: { type: 'cas-dispatched' },
      })
    }
  }
  assert.equal(value.record.state, 'retry-exhausted')
  assert.equal(value.record.retryStreak, 1)
  const firstBoundary = value.record.retryNotBeforeUnixMilliseconds!
  const notReady = await resumeEncryptedWalletBackupSyncAttempt({
    attempt: value,
  })
  assert.equal(notReady.record.state, 'retry-exhausted')
  finalizedBundle.store.setNowUnixMilliseconds(firstBoundary)
  let resumed = await resumeEncryptedWalletBackupSyncAttempt({
    attempt: value,
  })
  assert.equal(resumed.record.state, 'reconcile-before-retry')
  assert.equal(resumed.record.casAttempts, 3)
  resumed = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: resumed,
    event: { type: 'head-observed', observation: authenticated },
  })
  assert.equal(resumed.record.state, 'sealed')
  assert.equal(resumed.record.retryStreak, 1)

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    resumed = await advanceEncryptedWalletBackupSyncAttempt({
      attempt: resumed,
      event: { type: 'cas-dispatched' },
    })
    resumed = await advanceEncryptedWalletBackupSyncAttempt({
      attempt: resumed,
      event: { type: 'head-observed', observation: authenticated },
    })
  }
  assert.equal(resumed.record.state, 'retry-exhausted')
  assert.equal(resumed.record.retryStreak, 2)
  const secondBoundary = resumed.record.retryNotBeforeUnixMilliseconds!
  assert.equal(
    secondBoundary,
    firstBoundary +
      planEncryptedWalletBackupRetry({
        realm: resumed.record.realm,
        vaultId: resumed.record.vaultId,
        attemptId: resumed.record.attemptId,
        currentStreak: 1,
        minimumDelayMilliseconds: 5_000,
      }).delayMilliseconds,
  )
  assert.ok(secondBoundary > firstBoundary + 5_000)

  const secondRestartClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.notEqual(secondRestartClaim, null)
  const secondRestart = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: secondRestartClaim!,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.equal(secondRestart.record.retryStreak, 2)
  assert.equal(secondRestart.record.retryNotBeforeUnixMilliseconds, secondBoundary)
  finalizedBundle.store.setNowUnixMilliseconds(secondBoundary)
  const secondResumed = await resumeEncryptedWalletBackupSyncAttempt({
    attempt: secondRestart,
  })
  assert.equal(secondResumed.record.state, 'reconcile-before-retry')
  assert.equal(secondResumed.record.retryStreak, 2)
})

test('head-CAS quota rejection persists backoff before observing the head', async () => {
  const { keyHandle, head, finalizedNextUploads, finalizedBundle } =
    await createCasRecoveryFixtureForTest()
  let casCalls = 0
  let headCalls = 0
  const value = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: finalizedNextUploads.casAttempt,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async compareAndSwapCurrentHead() {
        casCalls += 1
        return { status: 'quota-exceeded' as const }
      },
      async readCurrentHead() {
        headCalls += 1
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(head),
        }
      },
    },
  })
  assert.equal(casCalls, 1)
  assert.equal(headCalls, 1)
  assert.equal(value.record.state, 'retry-exhausted')
  assert.equal(value.record.casAttempts, 1)
  const boundary = value.record.retryNotBeforeUnixMilliseconds!
  assert.equal(value.record.retryStreak, 1)
  assert.equal(
    boundary,
    1_700_000_000_000 +
      planEncryptedWalletBackupRetry({
        realm: value.record.realm,
        vaultId: value.record.vaultId,
        attemptId: value.record.attemptId,
        currentStreak: 0,
        minimumDelayMilliseconds: 5_000,
      }).delayMilliseconds,
  )
  const notReady = await resumeEncryptedWalletBackupSyncAttempt({
    attempt: value,
  })
  assert.equal(notReady.record.state, 'retry-exhausted')
  assert.equal(notReady.record.casAttempts, 1)
  const restartClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.notEqual(restartClaim, null)
  const restarted = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: restartClaim!,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.equal(restarted.record.state, 'retry-exhausted')
  assert.equal(restarted.record.casAttempts, 1)
  assert.equal(restarted.record.retryNotBeforeUnixMilliseconds, boundary)
  assert.equal(restarted.record.retryStreak, 1)
  finalizedBundle.store.setNowUnixMilliseconds(boundary)
  const ready = await resumeEncryptedWalletBackupSyncAttempt({
    attempt: restarted,
  })
  assert.equal(ready.record.state, 'reconcile-before-retry')
  assert.equal(ready.record.casAttempts, 1)
})

test('head-CAS rate limit persists the validated server hint using DB time', async () => {
  const { keyHandle, head, finalizedNextUploads, finalizedBundle } =
    await createCasRecoveryFixtureForTest()
  const value = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: finalizedNextUploads.casAttempt,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async compareAndSwapCurrentHead() {
        return {
          status: 'rate-limited' as const,
          retryAfterSeconds: 17,
        }
      },
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(head),
        }
      },
    },
  })
  assert.equal(value.record.state, 'retry-exhausted')
  assert.equal(value.record.casAttempts, 1)
  const boundary = value.record.retryNotBeforeUnixMilliseconds!
  assert.equal(value.record.retryStreak, 1)
  assert.ok(boundary >= 1_700_000_017_000)
  assert.ok(boundary <= 1_700_000_020_400)
  finalizedBundle.store.setNowUnixMilliseconds(boundary - 1)
  assert.equal(
    (await resumeEncryptedWalletBackupSyncAttempt({ attempt: value })).record.state,
    'retry-exhausted',
  )
  finalizedBundle.store.setNowUnixMilliseconds(boundary)
  const ready = await resumeEncryptedWalletBackupSyncAttempt({
    attempt: value,
  })
  assert.equal(ready.record.state, 'reconcile-before-retry')
  assert.equal(ready.record.casAttempts, 1)
})

test('CAS backoff survives a failed head read and restart reconciles before redispatch', async () => {
  const { keyHandle, head, nextHead, finalizedNextUploads, finalizedBundle } =
    await createCasRecoveryFixtureForTest()
  const deferred = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: finalizedNextUploads.casAttempt,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async compareAndSwapCurrentHead() {
        return { status: 'rate-limited' as const, retryAfterSeconds: 17 }
      },
      async readCurrentHead() {
        return { status: 'unavailable' as const }
      },
    },
  })
  assert.equal(deferred.record.state, 'retry-exhausted')
  const boundary = deferred.record.retryNotBeforeUnixMilliseconds!
  assert.equal(deferred.record.retryStreak, 1)
  assert.ok(boundary >= 1_700_000_017_000)
  assert.ok(boundary <= 1_700_000_020_400)

  const restartClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: finalizedBundle.store,
  })
  assert.notEqual(restartClaim, null)
  const restarted = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: restartClaim!,
    keyHandle,
    store: finalizedBundle.store,
  })
  finalizedBundle.store.setNowUnixMilliseconds(boundary - 1)
  let earlyCalls = 0
  const notReady = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: restarted,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    remote: {
      async compareAndSwapCurrentHead() {
        earlyCalls += 1
        throw new Error('not-before boundary was bypassed')
      },
      async readCurrentHead() {
        earlyCalls += 1
        throw new Error('not-before boundary was bypassed')
      },
    },
  })
  assert.equal(notReady.record.state, 'retry-exhausted')
  assert.equal(earlyCalls, 0)

  finalizedBundle.store.setNowUnixMilliseconds(boundary)
  const order: string[] = []
  let headCalls = 0
  const acknowledged = await synchronizeEncryptedWalletBackupManifestHead({
    attempt: notReady,
    keyHandle,
    enrollmentEpoch: 1,
    casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
    headUrl: 'https://backup.example.test/v1/head',
    clock: { nowUnixSeconds: () => 1_700_000_017 },
    remote: {
      async compareAndSwapCurrentHead() {
        order.push('cas')
        return { status: 'committed' as const }
      },
      async readCurrentHead() {
        order.push('head')
        headCalls += 1
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(headCalls === 1 ? head : nextHead),
        }
      },
    },
  })
  assert.deepEqual(order, ['head', 'cas', 'head'])
  assert.equal(acknowledged.record.state, 'acknowledged')
  assert.equal(acknowledged.record.retryStreak, 0)
})

test('delayed CAS reconciliation accepts target and foreign heads', async (t) => {
  for (const expected of ['acknowledged', 'fork-rejected'] as const) {
    await t.test(expected, async () => {
      const fixture = await createCasRecoveryFixtureForTest()
      const uncertain = await advanceEncryptedWalletBackupSyncAttempt({
        attempt: fixture.finalizedNextUploads.casAttempt,
        event: { type: 'cas-dispatched' },
      })
      const deferred = await advanceEncryptedWalletBackupSyncAttempt({
        attempt: uncertain,
        event: { type: 'retry-deferred', delayMilliseconds: 5_000 },
      })
      fixture.finalizedBundle.store.setNowUnixMilliseconds(
        deferred.record.retryNotBeforeUnixMilliseconds!,
      )
      const resumed = await resumeEncryptedWalletBackupSyncAttempt({
        attempt: deferred,
      })
      assert.equal(resumed.record.state, 'reconcile-before-retry')
      assert.equal(resumed.record.casAttempts, 1)
      const reconciled = await advanceEncryptedWalletBackupSyncAttempt({
        attempt: resumed,
        event: {
          type: 'head-observed',
          observation:
            expected === 'acknowledged' ? fixture.targetObservation : fixture.foreignObservation,
        },
      })
      assert.equal(reconciled.record.state, expected)
      assert.equal(reconciled.record.casAttempts, 1)
    })
  }
})

test('one cycle deadline covers signing and every request across a CAS retry', async () => {
  const { keyHandle, head, finalizedNextUploads, finalizedBundle } =
    await createCasRecoveryFixtureForTest()
  const controller = new AbortController()
  const observedSignals: AbortSignal[] = []
  let casCalls = 0
  let headCalls = 0
  await assert.rejects(
    synchronizeEncryptedWalletBackupManifestHead({
      attempt: finalizedNextUploads.casAttempt,
      keyHandle,
      enrollmentEpoch: 1,
      casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
      headUrl: 'https://backup.example.test/v1/head',
      clock: { nowUnixSeconds: () => 1_700_000_000 },
      signal: controller.signal,
      remote: {
        async compareAndSwapCurrentHead(input) {
          observedSignals.push(input.signal!)
          casCalls += 1
          if (casCalls === 1) return { status: 'conflict' as const }
          controller.abort()
          return new Promise<never>(() => undefined)
        },
        async readCurrentHead(input) {
          observedSignals.push(input.signal!)
          headCalls += 1
          return {
            status: 'found' as const,
            enrollmentEpoch: 1,
            head: readPreparedEncryptedWalletBackupManifestHead(head),
          }
        },
      },
    }),
    EncryptedWalletBackupDeadlineError,
  )
  assert.equal(casCalls, 2)
  assert.equal(headCalls, 1)
  assert.equal(observedSignals.length, 3)
  assert.ok(observedSignals.every((signal) => signal === observedSignals[0]))
  assert.equal(
    (
      await finalizedBundle.store.readCasAttempt(
        finalizedNextUploads.casAttempt.record.attemptId,
        (raw: unknown) => structuredClone(raw) as { state: string },
      )
    ).state,
    'cas-uncertain',
  )
})

test('persisted CAS state/count and aggregate lifecycle combinations are exhaustive', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const fixture = await acknowledgeTargetUploadsForTest({
    keyHandle,
    targetHead: head,
    batchId: '7c'.repeat(16),
    attemptId: '7d'.repeat(16),
  })
  const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
    claim: fixture.claim,
    keyHandle,
    store: fixture.store,
  })
  const baseline = await fixture.store.readCasAttempt(
    cas.record.attemptId,
    (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
  )
  const states = [
    'sealed',
    'cas-uncertain',
    'retry-cas',
    'retry-exhausted',
    'reconcile-before-retry',
    'acknowledged',
    'fork-rejected',
  ] as const
  const lifecycles = [
    'active',
    'abort-uncertain',
    'cas-journaled',
    'fork-cleanup-uncertain',
    'abandoned',
    'complete',
  ] as const
  for (const lifecycle of lifecycles) {
    for (const state of states) {
      for (let count = 0; count <= 3; count += 1) {
        for (const retryBoundary of [null, 1_700_000_005_000] as const) {
          for (const retryStreak of [0, 1] as const) {
            const validShape =
              retryBoundary === null &&
              ((state === 'sealed' && count === 0) ||
                (state === 'cas-uncertain' && count >= 1) ||
                (state === 'retry-cas' && count >= 1 && count < 3) ||
                (state === 'reconcile-before-retry' && count >= 1) ||
                ((state === 'acknowledged' || state === 'fork-rejected') && count >= 1))
                ? true
                : state === 'retry-exhausted' && count >= 1 && count <= 3 && retryBoundary !== null
            const validStreak =
              state === 'acknowledged'
                ? retryStreak === 0
                : state === 'retry-exhausted' || state === 'reconcile-before-retry'
                  ? retryStreak >= 1
                  : true
            const validLifecycle =
              (lifecycle === 'cas-journaled' &&
                [
                  'sealed',
                  'cas-uncertain',
                  'retry-cas',
                  'retry-exhausted',
                  'reconcile-before-retry',
                ].includes(state)) ||
              ((lifecycle === 'fork-cleanup-uncertain' || lifecycle === 'abandoned') &&
                state === 'fork-rejected') ||
              (lifecycle === 'complete' && (state === 'acknowledged' || state === 'fork-rejected'))
            const validate = () => {
              validateEncryptedWalletBackupCasState({
                state,
                casAttempts: count,
                retryStreak,
                retryNotBeforeUnixMilliseconds: retryBoundary,
              })
              validateEncryptedWalletBackupAggregateCasLifecycle({
                lifecycle,
                state,
              })
            }
            if (validShape && validStreak && validLifecycle) assert.doesNotThrow(validate)
            else assert.throws(validate)
          }
        }
      }
    }
  }

  for (const state of states) {
    fixture.store.replaceCasAttempt(cas.record.attemptId, {
      ...baseline,
      state,
      casAttempts: state === 'sealed' ? 0 : 1,
      retryStreak: state === 'reconcile-before-retry' ? 1 : 0,
      retryNotBeforeUnixMilliseconds: null,
    })
    const operation = sealOrRehydrateEncryptedWalletBackupCasAttempt({
      claim: fixture.claim,
      keyHandle,
      store: fixture.store,
    })
    if (
      state === 'sealed' ||
      state === 'cas-uncertain' ||
      state === 'retry-cas' ||
      state === 'reconcile-before-retry'
    ) {
      assert.equal((await operation).record.state, state)
    } else {
      await assert.rejects(() => operation, /state and attempt count|lifecycles are inconsistent/)
    }
  }
  fixture.store.replaceCasAttempt(cas.record.attemptId, baseline)

  const invalidRetryRecords: Record<string, unknown>[] = []
  const missingRetryStreak = structuredClone(baseline)
  delete missingRetryStreak.retryStreak
  invalidRetryRecords.push(missingRetryStreak)
  invalidRetryRecords.push({ ...baseline, retryStreak: 33 })
  invalidRetryRecords.push({
    ...baseline,
    state: 'retry-exhausted',
    casAttempts: 1,
    retryStreak: 0,
    retryNotBeforeUnixMilliseconds: 1_700_000_005_000,
  })
  invalidRetryRecords.push({
    ...baseline,
    state: 'acknowledged',
    casAttempts: 1,
    retryStreak: 1,
  })
  for (const invalid of invalidRetryRecords) {
    fixture.store.replaceCasAttempt(cas.record.attemptId, invalid)
    await assert.rejects(
      () =>
        sealOrRehydrateEncryptedWalletBackupCasAttempt({
          claim: fixture.claim,
          keyHandle,
          store: fixture.store,
        }),
      /retry streak|state and attempt count/,
    )
  }
  fixture.store.replaceCasAttempt(cas.record.attemptId, baseline)
})

test('CAS rehydration rejects missing, foreign, and multiple persisted links', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const makeFixture = async (suffix: string) => {
    const fixture = await acknowledgeTargetUploadsForTest({
      keyHandle,
      targetHead: head,
      batchId: suffix.repeat(16),
      attemptId: (Number.parseInt(suffix, 16) + 1).toString(16).padStart(2, '0').repeat(16),
    })
    const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
      claim: fixture.claim,
      keyHandle,
      store: fixture.store,
    })
    return { fixture, cas }
  }

  const missing = await makeFixture('81')
  missing.fixture.store.deleteCasAttempt(missing.cas.record.attemptId)
  await assert.rejects(
    () =>
      sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: missing.fixture.claim,
        keyHandle,
        store: missing.fixture.store,
      }),
    /invalid linked CAS rows/,
  )

  const foreign = await makeFixture('83')
  foreign.fixture.store.mutateUploadAttempt(foreign.fixture.claim.record.attemptId, (attempt) => {
    attempt.casAttemptId = 'ff'.repeat(16)
  })
  const foreignClaim = await claimEncryptedWalletBackupUploadAttempt({
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    store: foreign.fixture.store,
  })
  assert.notEqual(foreignClaim, null)
  await assert.rejects(
    () =>
      sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: foreignClaim!,
        keyHandle,
        store: foreign.fixture.store,
      }),
    /CAS link is not deterministic/,
  )

  const multiple = await makeFixture('85')
  multiple.fixture.store.duplicateCasAttempt(multiple.cas.record.attemptId, 'fe'.repeat(16))
  await assert.rejects(
    () =>
      sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: multiple.fixture.claim,
        keyHandle,
        store: multiple.fixture.store,
      }),
    /invalid linked CAS rows|exactly one linked CAS row/,
  )
})

test('upload claim capabilities are bound to their exact originating store', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const originatingStore = inMemoryUploadBatchStore()
  const claim = await uploadAttemptClaimForTest(keyHandle, head, originatingStore, '87'.repeat(16))
  let delegatedCalls = 0
  const foreignStore = {
    ...originatingStore,
    async sealOrReadLinkedCasAttempt<T>(...args: never[]): Promise<T> {
      delegatedCalls += 1
      return originatingStore.sealOrReadLinkedCasAttempt(...args) as Promise<T>
    },
    async validateUploadAttemptClaim<T>(...args: never[]): Promise<T> {
      delegatedCalls += 1
      return originatingStore.validateUploadAttemptClaim(...args) as Promise<T>
    },
  }
  await assert.rejects(
    () =>
      sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim,
        keyHandle,
        store: foreignStore,
      }),
    /upload attempt claim is invalid/,
  )
  assert.equal(delegatedCalls, 0)
  await assert.rejects(
    () =>
      abandonEncryptedWalletBackupUploadAttempt({
        claim,
        keyHandle,
        store: foreignStore,
        enrollmentEpoch: 1,
        url: 'https://backup.example.test/v1/upload-attempts/abort',
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        remote: {
          async abortUploadAttempt() {
            assert.fail('foreign store must be rejected before dispatch')
          },
        },
      }),
    /upload attempt claim is invalid/,
  )
  assert.equal(delegatedCalls, 0)
})

test('rehydration rejects impossible execution history and quota-sized hostile heads', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()
  const store = inMemoryUploadBatchStore()
  const claim = await uploadAttemptClaimForTest(keyHandle, head, store, '41'.repeat(16))
  const sealed = await sealEncryptedWalletBackupUploadBatch({
    batchId: '42'.repeat(16),
    claim,
    keyHandle,
    plannedBatch: plannedUploadBatchForTest(keyHandle, head, claim.record.attemptId),
    store,
  })
  const impossibleFinalized = structuredClone(sealed.record)
  impossibleFinalized.state = 'finalized'
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupUploadBatch({
        batchId: impossibleFinalized.batchId,
        keyHandle,
        store: uploadBatchReadSubstitutionStore(store, impossibleFinalized),
      }),
    /execution history is invalid/,
  )

  const validBoundary = rewriteUploadBatchTargetReferenceCounts(sealed.record, 3, 255)
  const valid = await rehydrateEncryptedWalletBackupUploadBatch({
    batchId: validBoundary.batchId,
    keyHandle,
    store: uploadBatchReadSubstitutionStore(store, validBoundary),
  })
  assert.equal(valid.record.state, 'sealed')

  const quotaOverflow = rewriteUploadBatchTargetReferenceCounts(sealed.record, 3, 256)
  await assert.rejects(
    () =>
      rehydrateEncryptedWalletBackupUploadBatch({
        batchId: quotaOverflow.batchId,
        keyHandle,
        store: uploadBatchReadSubstitutionStore(store, quotaOverflow),
      }),
    /stored bytes|quota/,
  )
})

test('coordinator rejects unknown persisted target and parent fields', async () => {
  const fixture = await createCasRecoveryFixtureForTest()
  const store = fixture.finalizedBundle.store
  const claim = fixture.finalizedNextUploads.claim
  const original = store.sealOrReadLinkedCasAttempt
  for (const nested of ['target', 'parent'] as const) {
    store.sealOrReadLinkedCasAttempt = async function <T>(
      claimRecord: Record<string, unknown>,
      candidate: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<T> {
      return original(claimRecord, candidate, (raw: never) => {
        const changed = structuredClone(raw) as {
          casAttempts: Array<{
            targetHead: Record<string, unknown> & {
              parent: Record<string, unknown>
            }
          }>
        }
        if (nested === 'target') changed.casAttempts[0]!.targetHead.unknownField = true
        else changed.casAttempts[0]!.targetHead.parent.unknownField = true
        return commit(changed as never)
      })
    }
    await assert.rejects(
      () =>
        sealOrRehydrateEncryptedWalletBackupCasAttempt({
          claim,
          keyHandle: fixture.keyHandle,
          store,
        }),
      /unknown field/,
    )
  }
  store.sealOrReadLinkedCasAttempt = original
})

test('persisted child parent authority is exact and rejects corruption', async () => {
  const fixture = await createManifestUploadFixtureForTest()
  const childManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle: fixture.keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(39),
    parentEvidence: fixture.authenticated,
    parentPages: [fixture.page],
    chunks: [],
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(40), new Uint8Array(12).fill(41)]),
  })
  const childHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle: fixture.keyHandle,
    manifest: childManifest,
    parent: fixture.authenticated.head,
  })
  const store = inMemoryUploadBatchStore()
  const claim = await uploadAttemptClaimForTest(
    fixture.keyHandle,
    childHead,
    store,
    '3f'.repeat(16),
  )
  assert.equal(
    isDeepStrictEqual(claim.record.canonicalParentHead, fixture.headWire.canonicalHead),
    true,
    'persisted parent head must match exact canonical bytes',
  )
  await assert.rejects(
    () =>
      claimEncryptedWalletBackupUploadAttempt({
        ownerId: 'test-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        store: {
          ...store,
          async claimActiveUploadAttempt<T>(
            query: Record<string, unknown>,
            read: (value: never) => T,
          ): Promise<T> {
            return store.claimActiveUploadAttempt(query, (raw: never) => {
              const changed = structuredClone(raw) as {
                canonicalParentHead: Uint8Array
              }
              changed.canonicalParentHead[0] ^= 1
              return read(changed as never)
            })
          },
        },
      }),
    /parent head is invalid/,
  )
})

test('authoritative service quota refusal remains fail-closed after local planning', async () => {
  const fixture = await createSealedUploadMutationFixtureForTest('49')
  let remoteCalls = 0
  await assert.rejects(
    () =>
      uploadEncryptedWalletBackupBatch({
        batch: fixture.batch,
        claim: fixture.claim,
        keyHandle: fixture.keyHandle,
        store: fixture.store,
        enrollmentEpoch: 1,
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
        remote: {
          async putObject() {
            remoteCalls += 1
            return { status: 'quota-exceeded' as const }
          },
        },
      }),
    (error) =>
      error instanceof EncryptedWalletBackupRemoteBackoffError &&
      error.status === 'quota-exceeded' &&
      error.retryAfterSeconds === null &&
      error.delayMilliseconds() === 5_000,
  )
  assert.ok(remoteCalls >= 1)
  assert.equal(
    (
      await rehydrateEncryptedWalletBackupUploadBatch({
        batchId: fixture.batch.record.batchId,
        keyHandle: fixture.keyHandle,
        store: fixture.store,
      })
    ).record.state,
    'put-uncertain',
  )
})

test('parallel upload failures reduce deterministically without hiding fatal errors or shorter backoff', async () => {
  assert.throws(
    () => new EncryptedWalletBackupRemoteBackoffError('quota-exceeded', 1),
    /must not include retry-after/,
  )

  const backoffFixture = await createSealedUploadMutationFixtureForTest('59')
  const backoffResolvers: Array<
    (
      value:
        | { status: 'overloaded'; retryAfterSeconds: 7 }
        | { status: 'rate-limited'; retryAfterSeconds: 31 }
        | { status: 'unavailable'; retryAfterSeconds: null },
    ) => void
  > = []
  const backoffUpload = uploadEncryptedWalletBackupBatch({
    batch: backoffFixture.batch,
    claim: backoffFixture.claim,
    keyHandle: backoffFixture.keyHandle,
    store: backoffFixture.store,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
    remote: {
      async putObject() {
        return new Promise((resolve) => backoffResolvers.push(resolve))
      },
    },
  })
  await waitForArrayLength(backoffResolvers, 3)
  backoffResolvers[2]!({ status: 'unavailable', retryAfterSeconds: null })
  backoffResolvers[0]!({ status: 'overloaded', retryAfterSeconds: 7 })
  backoffResolvers[1]!({ status: 'rate-limited', retryAfterSeconds: 31 })
  await assert.rejects(
    backoffUpload,
    (error) =>
      error instanceof EncryptedWalletBackupRemoteBackoffError &&
      error.status === 'rate-limited' &&
      error.delayMilliseconds() === 31_000,
  )

  const fatalFixture = await createSealedUploadMutationFixtureForTest('69')
  const fatalResolvers: Array<
    (value: { status: 'overloaded'; retryAfterSeconds: 31 } | { status: 'forged' }) => void
  > = []
  const fatalUpload = uploadEncryptedWalletBackupBatch({
    batch: fatalFixture.batch,
    claim: fatalFixture.claim,
    keyHandle: fatalFixture.keyHandle,
    store: fatalFixture.store,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
    remote: {
      async putObject() {
        return new Promise((resolve) => fatalResolvers.push(resolve)) as never
      },
    },
  })
  await waitForArrayLength(fatalResolvers, 3)
  fatalResolvers[0]!({ status: 'overloaded', retryAfterSeconds: 31 })
  fatalResolvers[2]!({ status: 'overloaded', retryAfterSeconds: 31 })
  fatalResolvers[1]!({ status: 'forged' })
  await assert.rejects(fatalUpload, /object upload failed: forged/)
})

test('upload mutation adapters reject mutation, repeated, late, and wrong callbacks', async () => {
  const { keyHandle, head } = await createManifestUploadFixtureForTest()

  const mutatedBase = inMemoryUploadBatchStore()
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '43'.repeat(16),
        ownerId: 'expected-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: head,
        store: {
          ...mutatedBase,
          async sealActiveUploadAttempt<T>(
            candidate: Record<string, unknown>,
            lease: number,
            seal: (value: never) => T,
          ): Promise<T> {
            candidate.ownerId = 'mutated-owner'
            return mutatedBase.sealActiveUploadAttempt(candidate, lease, seal)
          },
        },
      }),
    /sealed upload attempt changed/,
  )
  assert.equal(
    await claimEncryptedWalletBackupUploadAttempt({
      ownerId: 'expected-owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle,
      store: mutatedBase,
    }),
    null,
  )

  const repeatedBase = inMemoryUploadBatchStore()
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '44'.repeat(16),
        ownerId: 'repeated-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: head,
        store: {
          ...repeatedBase,
          async sealActiveUploadAttempt<T>(
            candidate: Record<string, unknown>,
            lease: number,
            seal: (value: never) => T,
          ): Promise<T> {
            return repeatedBase.sealActiveUploadAttempt(candidate, lease, (record: never) => {
              const first = seal(record)
              seal(record)
              return first
            })
          },
        },
      }),
    /callback is invalid/,
  )
  assert.equal(
    await claimEncryptedWalletBackupUploadAttempt({
      ownerId: 'repeated-owner',
      leaseDurationMilliseconds: 60_000,
      keyHandle,
      store: repeatedBase,
    }),
    null,
  )

  let lateCallback: ((value: never) => unknown) | undefined
  let lateCandidate: Record<string, unknown> | undefined
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '45'.repeat(16),
        ownerId: 'late-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: head,
        store: {
          ...inMemoryUploadBatchStore(),
          async sealActiveUploadAttempt<T>(
            candidate: Record<string, unknown>,
            _lease: number,
            seal: (value: never) => T,
          ): Promise<T> {
            lateCandidate = structuredClone(candidate)
            lateCallback = seal
            return {} as T
          },
        },
      }),
    /synchronous and exact/,
  )
  assert.throws(() => lateCallback!(lateCandidate as never), /callback is invalid/)

  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadAttempt({
        attemptId: '46'.repeat(16),
        ownerId: 'wrong-return-owner',
        leaseDurationMilliseconds: 60_000,
        keyHandle,
        targetHead: head,
        store: {
          ...inMemoryUploadBatchStore(),
          async sealActiveUploadAttempt<T>(
            candidate: Record<string, unknown>,
            lease: number,
            seal: (value: never) => T,
          ): Promise<T> {
            const committed = {
              ...structuredClone(candidate),
              ownerEpoch: 1,
              leaseExpiresAtUnixMilliseconds: 1_700_000_000_000 + lease,
              batchIds: [],
              activeBatchId: null,
              casAttemptId: null,
              lifecycle: 'active',
            }
            seal(committed as never)
            return {} as T
          },
        },
      }),
    /synchronous and exact/,
  )

  const batchBase = inMemoryUploadBatchStore()
  const batchClaim = await uploadAttemptClaimForTest(keyHandle, head, batchBase, '47'.repeat(16))
  const plannedBatch = plannedUploadBatchForTest(keyHandle, head, batchClaim.record.attemptId)
  const originalHostileSeal = batchBase.sealUploadBatch
  batchBase.sealUploadBatch = async function <T>(
    claimRecord: Record<string, unknown>,
    batch: Record<string, unknown>,
    seal: (value: never) => T,
  ): Promise<T> {
    return originalHostileSeal(claimRecord, batch, (raw: never) => {
      const changed = structuredClone(raw) as {
        batch: Record<string, unknown>
      }
      changed.batch.state = 'finalized'
      return seal(changed as never)
    })
  }
  await assert.rejects(
    () =>
      sealEncryptedWalletBackupUploadBatch({
        batchId: '48'.repeat(16),
        claim: batchClaim,
        keyHandle,
        plannedBatch,
        store: batchBase,
      }),
    /execution history is invalid/,
  )
  batchBase.sealUploadBatch = originalHostileSeal
  const retriedAfterRollback = await sealEncryptedWalletBackupUploadBatch({
    batchId: '48'.repeat(16),
    claim: batchClaim,
    keyHandle,
    plannedBatch,
    store: batchBase,
  })
  assert.equal(retriedAfterRollback.record.state, 'sealed')
})

test('every upload mutation callback port fails closed and rolls back', async (t) => {
  const faults: Array<Readonly<{ name: string; run: () => Promise<void> }>> = [
    {
      name: 'claim renewal rejects a repeated callback',
      async run() {
        const fixture = await createSealedUploadMutationFixtureForTest('51')
        fixture.store.setNowUnixMilliseconds(fixture.claim.record.leaseExpiresAtUnixMilliseconds)
        await assert.rejects(
          () =>
            claimEncryptedWalletBackupUploadAttempt({
              ownerId: 'renewed-owner',
              leaseDurationMilliseconds: 60_000,
              keyHandle: fixture.keyHandle,
              store: {
                ...fixture.store,
                async claimActiveUploadAttempt<T>(
                  query: Record<string, unknown>,
                  claim: (value: never) => T,
                ): Promise<T> {
                  return fixture.store.claimActiveUploadAttempt(query, (record: never) => {
                    const first = claim(record)
                    claim(record)
                    return first
                  })
                },
              },
            }),
          /callback is invalid/,
        )
        const renewed = await claimEncryptedWalletBackupUploadAttempt({
          ownerId: 'renewed-owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store: fixture.store,
        })
        assert.equal(renewed!.record.ownerEpoch, 2)
      },
    },
    {
      name: 'execution claim rejects adapter input mutation',
      async run() {
        const fixture = await createSealedUploadMutationFixtureForTest('52')
        let remoteCalls = 0
        const originalExecutionClaim = fixture.store.claimUploadBatchExecution
        fixture.store.claimUploadBatchExecution = async function <T>(
          claim: Record<string, unknown>,
          batch: Record<string, unknown>,
          lease: number,
          commit: (value: never) => T,
        ): Promise<T> {
          batch.executionEpoch = 99
          return originalExecutionClaim(claim, batch, lease, commit)
        }
        await assert.rejects(
          () =>
            uploadEncryptedWalletBackupBatch({
              batch: fixture.batch,
              claim: fixture.claim,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
              enrollmentEpoch: 1,
              clock: { nowUnixSeconds: () => 1_700_000_000 },
              objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
              remote: {
                async putObject() {
                  remoteCalls += 1
                  return { status: 'stored' as const }
                },
              },
            }),
          /read only property/,
        )
        fixture.store.claimUploadBatchExecution = originalExecutionClaim
        assert.equal(remoteCalls, 0)
        assert.equal(
          (
            await rehydrateEncryptedWalletBackupUploadBatch({
              batchId: fixture.batch.record.batchId,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
            })
          ).record.state,
          'sealed',
        )
      },
    },
    {
      name: 'transition rejects a wrong callback return',
      async run() {
        const fixture = await createSealedUploadMutationFixtureForTest('53')
        const originalTransition = fixture.store.transitionUploadBatch
        fixture.store.transitionUploadBatch = async function <T>(
          claim: Record<string, unknown>,
          _expected: Record<string, unknown>,
          next: Record<string, unknown>,
          commit: (value: never) => T,
        ): Promise<T> {
          commit({
            attempt: { ...claim, activeBatchId: null },
            batch: next,
          } as never)
          return {} as T
        }
        await assert.rejects(
          () =>
            uploadEncryptedWalletBackupBatch({
              batch: fixture.batch,
              claim: fixture.claim,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
              enrollmentEpoch: 1,
              clock: { nowUnixSeconds: () => 1_700_000_000 },
              objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
              remote: {
                async putObject() {
                  return { status: 'stored' as const }
                },
              },
            }),
          /synchronous and exact/,
        )
        fixture.store.transitionUploadBatch = originalTransition
        assert.equal(
          (
            await rehydrateEncryptedWalletBackupUploadBatch({
              batchId: fixture.batch.record.batchId,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
            })
          ).record.state,
          'put-uncertain',
        )
      },
    },
    {
      name: 'abort fence rolls back callback rejection',
      async run() {
        const fixture = await createSealedUploadMutationFixtureForTest('54')
        let remoteCalls = 0
        const originalAbortFence = fixture.store.fenceUploadAttemptForAbort
        fixture.store.fenceUploadAttemptForAbort = async function <T>(
          claim: Record<string, unknown>,
          commit: (value: never) => T,
        ): Promise<T> {
          return originalAbortFence(claim, (raw: never) => {
            const changed = structuredClone(raw) as {
              batches: Array<Record<string, unknown>>
            }
            changed.batches[0]!.state = 'finalized'
            return commit(changed as never)
          })
        }
        await assert.rejects(
          () =>
            abandonEncryptedWalletBackupUploadAttempt({
              claim: fixture.claim,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
              enrollmentEpoch: 1,
              url: 'https://backup.example.test/attempt:abort',
              clock: { nowUnixSeconds: () => 1_700_000_000 },
              remote: {
                async abortUploadAttempt() {
                  remoteCalls += 1
                  return { status: 'abandoned' as const }
                },
              },
            }),
          /execution history is invalid/,
        )
        fixture.store.fenceUploadAttemptForAbort = originalAbortFence
        assert.equal(remoteCalls, 0)
        assert.equal(
          (
            await rehydrateEncryptedWalletBackupUploadBatch({
              batchId: fixture.batch.record.batchId,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
            })
          ).record.state,
          'sealed',
        )
      },
    },
    {
      name: 'abort completion rejects a late callback',
      async run() {
        const fixture = await createSealedUploadMutationFixtureForTest('56')
        await assert.rejects(
          () =>
            abandonEncryptedWalletBackupUploadAttempt({
              claim: fixture.claim,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
              enrollmentEpoch: 1,
              url: 'https://backup.example.test/attempt:abort',
              clock: { nowUnixSeconds: () => 1_700_000_000 },
              remote: {
                async abortUploadAttempt() {
                  throw new Error('lost abort response')
                },
              },
            }),
          /lost abort response/,
        )
        const reclaimed = await claimEncryptedWalletBackupUploadAttempt({
          ownerId: 'test-owner',
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store: fixture.store,
        })
        const abortUncertainPartition = await fixture.store.inspectUploadAttemptPartition(
          reclaimed!.record.attemptId,
          (raw: never) => structuredClone(raw),
        )
        let lateCommit: ((value: never) => unknown) | undefined
        let lateRaw: never | undefined
        const originalAbortCompletion = fixture.store.completeUploadAttemptAbort
        fixture.store.completeUploadAttemptAbort = async function <T>(
          claim: Record<string, unknown>,
          commit: (value: never) => T,
        ): Promise<T> {
          lateCommit = commit
          try {
            await originalAbortCompletion(claim, (raw: never) => {
              lateRaw = raw
              throw new Error('capture late abort completion')
            })
          } catch {
            return {} as T
          }
          throw new Error('missing abort rollback')
        }
        await assert.rejects(
          () =>
            abandonEncryptedWalletBackupUploadAttempt({
              claim: reclaimed!,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
              enrollmentEpoch: 1,
              url: 'https://backup.example.test/attempt:abort',
              clock: { nowUnixSeconds: () => 1_700_000_001 },
              remote: {
                async abortUploadAttempt() {
                  return { status: 'already-abandoned' as const }
                },
              },
            }),
          /synchronous and exact/,
        )
        fixture.store.completeUploadAttemptAbort = originalAbortCompletion
        const durableAbortUncertainPartition = await fixture.store.inspectUploadAttemptPartition(
          reclaimed!.record.attemptId,
          (raw: never) => structuredClone(raw),
        )
        assert.equal(
          isDeepStrictEqual(durableAbortUncertainPartition, abortUncertainPartition),
          true,
          'abort rollback must restore the exact bounded partition',
        )
        const durableAbortRecord = durableAbortUncertainPartition as {
          attempt: Record<string, unknown>
          batches: Array<{
            state: unknown
            executionEpoch: unknown
            executionLeaseExpiresAtUnixMilliseconds: unknown
            items: Array<{ canonicalPutPayload: unknown }>
          }>
        }
        assert.equal(durableAbortRecord.attempt.lifecycle, 'abort-uncertain')
        assert.equal(durableAbortRecord.batches.length, 1)
        assert.equal(durableAbortRecord.batches[0]!.state, 'abort-uncertain')
        assert.equal(durableAbortRecord.batches[0]!.executionEpoch, 0)
        assert.equal(durableAbortRecord.batches[0]!.executionLeaseExpiresAtUnixMilliseconds, null)
        assert.equal(
          durableAbortRecord.batches[0]!.items.every(
            (item) => item.canonicalPutPayload instanceof Uint8Array,
          ),
          true,
        )
        assert.throws(() => lateCommit!(lateRaw!), /callback is invalid/)
      },
    },
    {
      name: 'finalization rolls back a repeated callback',
      async run() {
        const fixture = await createSealedUploadMutationFixtureForTest('57')
        const acknowledged = await uploadEncryptedWalletBackupBatch({
          batch: fixture.batch,
          claim: fixture.claim,
          keyHandle: fixture.keyHandle,
          store: fixture.store,
          enrollmentEpoch: 1,
          clock: { nowUnixSeconds: () => 1_700_000_000 },
          objectUrl: (objectId) => `https://backup.example.test/${objectId}`,
          remote: {
            async putObject() {
              return { status: 'stored' as const }
            },
          },
        })
        const originalHandoff = fixture.store.sealOrReadLinkedCasAttempt
        fixture.store.sealOrReadLinkedCasAttempt = async function <T>(
          claim: Record<string, unknown>,
          candidate: Record<string, unknown>,
          commit: (value: never) => T,
        ): Promise<T> {
          return originalHandoff(claim, candidate, (raw: never) => {
            const first = commit(raw)
            commit(raw)
            return first
          })
        }
        await assert.rejects(
          () =>
            journalEncryptedWalletBackupCasHandoffForTest({
              keyHandle: fixture.keyHandle,
              claim: fixture.claim,
              store: fixture.store,
            }),
          /callback is invalid/,
        )
        fixture.store.sealOrReadLinkedCasAttempt = originalHandoff
        assert.equal(
          (
            await rehydrateEncryptedWalletBackupUploadBatch({
              batchId: acknowledged.record.batchId,
              keyHandle: fixture.keyHandle,
              store: fixture.store,
            })
          ).record.state,
          'acknowledged',
        )
      },
    },
  ]
  for (const fault of faults) await t.test(fault.name, fault.run)
})

test('every linked CAS callback port rejects wrong, multiple, and late callbacks', async (t) => {
  const modes = ['wrong', 'multiple', 'late'] as const

  for (const mode of modes) {
    await t.test(`validateLinkedCasAttempt rejects ${mode} callback`, async () => {
      const { keyHandle, head } = await createManifestUploadFixtureForTest()
      const fixture = await acknowledgeTargetUploadsForTest({
        keyHandle,
        targetHead: head,
        batchId: '91'.repeat(16),
        attemptId: '92'.repeat(16),
      })
      const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
        claim: fixture.claim,
        keyHandle,
        store: fixture.store,
      })
      const original = fixture.store.validateLinkedCasAttempt
      let lateCallback: ((value: never) => unknown) | undefined
      let lateRaw: never | undefined
      fixture.store.validateLinkedCasAttempt = async function <T>(
        claim: Record<string, unknown>,
        expected: Record<string, unknown>,
        read: (value: never) => T,
      ): Promise<T> {
        try {
          return await original(claim, expected, (raw: never) => {
            if (mode === 'wrong') {
              const changed = structuredClone(raw) as {
                casAttempts: Array<Record<string, unknown>>
              }
              changed.casAttempts[0]!.casAttempts = 0
              return read(changed as never)
            }
            if (mode === 'multiple') {
              const first = read(raw)
              read(raw)
              return first
            }
            lateCallback = read
            lateRaw = raw
            throw new Error('capture late linked CAS validation')
          })
        } catch (error) {
          if (mode === 'late') return {} as T
          throw error
        }
      }
      let remoteCalls = 0
      await assert.rejects(
        () =>
          synchronizeEncryptedWalletBackupManifestHead({
            attempt: cas,
            keyHandle,
            enrollmentEpoch: 1,
            casUrl: 'https://backup.example.test/v1/head:compare-and-swap',
            headUrl: 'https://backup.example.test/v1/head',
            clock: { nowUnixSeconds: () => 1_700_000_000 },
            remote: {
              async compareAndSwapCurrentHead() {
                remoteCalls += 1
                return { status: 'committed' as const }
              },
              async readCurrentHead() {
                assert.fail('validation fault must prevent head observation')
              },
            },
          }),
        /state and attempt count|callback is invalid|synchronous and exact/,
      )
      assert.equal(remoteCalls, 0)
      if (mode === 'late') assert.throws(() => lateCallback!(lateRaw!), /callback is invalid/)
    })
  }

  for (const mode of modes) {
    await t.test(`readLinkedCasAttempts rejects ${mode} callback`, async () => {
      const fixture = await createRejectedCasFixtureForTest()
      const store = fixture.finalizedBundle.store
      const original = store.readLinkedCasAttempts
      let lateCallback: ((value: never) => unknown) | undefined
      let lateRaw: never | undefined
      store.readLinkedCasAttempts = async function <T>(
        claim: Record<string, unknown>,
        read: (value: never) => T,
      ): Promise<T> {
        try {
          return await original(claim, (raw: never) => {
            if (mode === 'wrong') {
              const changed = structuredClone(raw) as {
                casAttempts: Array<Record<string, unknown>>
              }
              changed.casAttempts.length = 0
              return read(changed as never)
            }
            if (mode === 'multiple') {
              const first = read(raw)
              read(raw)
              return first
            }
            lateCallback = read
            lateRaw = raw
            throw new Error('capture late linked CAS read')
          })
        } catch (error) {
          if (mode === 'late') return {} as T
          throw error
        }
      }
      let remoteCalls = 0
      await assert.rejects(
        () =>
          cleanUpRejectedEncryptedWalletBackupFork({
            claim: fixture.finalizedNextUploads.claim,
            keyHandle: fixture.keyHandle,
            store,
            enrollmentEpoch: 1,
            url: 'https://backup.example.test/v1/upload-attempts/cleanup',
            clock: { nowUnixSeconds: () => 1_700_000_000 },
            remote: {
              async abortUploadAttempt() {
                remoteCalls += 1
                return { status: 'abandoned' as const }
              },
            },
          }),
        /exactly one linked CAS row|callback is invalid|synchronous and exact/,
      )
      assert.equal(remoteCalls, 0)
      if (mode === 'late') assert.throws(() => lateCallback!(lateRaw!), /callback is invalid/)
    })
  }

  const prepareExhaustion = async () => {
    const fixture = await createCasRecoveryFixtureForTest()
    let attempt = fixture.finalizedNextUploads.casAttempt
    for (let index = 0; index < 3; index += 1) {
      attempt = await advanceEncryptedWalletBackupSyncAttempt({
        attempt,
        event: { type: 'cas-dispatched' },
      })
      if (index < 2) {
        attempt = await advanceEncryptedWalletBackupSyncAttempt({
          attempt,
          event: {
            type: 'head-observed',
            observation: fixture.authenticated,
          },
        })
      }
    }
    return { fixture, attempt }
  }

  for (const mode of modes) {
    await t.test(`exhaustLinkedCasAttempt rejects ${mode} callback`, async () => {
      const { fixture, attempt } = await prepareExhaustion()
      const store = fixture.finalizedBundle.store
      const original = store.exhaustLinkedCasAttempt.bind(store)
      let lateCallback: ((value: never) => unknown) | undefined
      let lateRaw: never | undefined
      store.exhaustLinkedCasAttempt = async function <T>(
        claim: Record<string, unknown>,
        expected: Record<string, unknown>,
        next: Record<string, unknown>,
        delay: number,
        commit: (value: never) => T,
      ): Promise<T> {
        try {
          return await original(claim, expected, next, delay, (raw: never) => {
            if (mode === 'wrong') {
              const changed = structuredClone(raw) as {
                casAttempts: Array<Record<string, unknown>>
              }
              changed.casAttempts[0]!.retryNotBeforeUnixMilliseconds = null
              return commit(changed as never)
            }
            if (mode === 'multiple') {
              const first = commit(raw)
              commit(raw)
              return first
            }
            lateCallback = commit
            lateRaw = raw
            throw new Error('capture late CAS exhaustion')
          })
        } catch (error) {
          if (mode === 'late') return {} as T
          throw error
        }
      }
      await assert.rejects(
        () =>
          advanceEncryptedWalletBackupSyncAttempt({
            attempt,
            event: {
              type: 'head-observed',
              observation: fixture.authenticated,
            },
          }),
        /state and attempt count|callback is invalid|synchronous and exact/,
      )
      if (mode === 'late') assert.throws(() => lateCallback!(lateRaw!), /callback is invalid/)
      const persisted = await store.readCasAttempt(
        attempt.record.attemptId,
        (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
      )
      assert.equal(persisted.state, 'cas-uncertain')
    })
  }

  for (const mode of modes) {
    await t.test(`resumeLinkedCasAttempt rejects ${mode} callback`, async () => {
      const { fixture, attempt } = await prepareExhaustion()
      const exhausted = await advanceEncryptedWalletBackupSyncAttempt({
        attempt,
        event: {
          type: 'head-observed',
          observation: fixture.authenticated,
        },
      })
      const store = fixture.finalizedBundle.store
      store.setNowUnixMilliseconds(exhausted.record.retryNotBeforeUnixMilliseconds!)
      const original = store.resumeLinkedCasAttempt.bind(store)
      let lateCallback: ((value: never) => unknown) | undefined
      let lateRaw: never | undefined
      store.resumeLinkedCasAttempt = async function <T>(
        claim: Record<string, unknown>,
        expected: Record<string, unknown>,
        next: Record<string, unknown>,
        commit: (value: never) => T,
      ) {
        try {
          return await original(claim, expected, next, (raw: never) => {
            if (mode === 'wrong') {
              const changed = structuredClone(raw) as {
                casAttempts: Array<Record<string, unknown>>
              }
              changed.casAttempts[0]!.state = 'retry-exhausted'
              changed.casAttempts[0]!.casAttempts = 3
              changed.casAttempts[0]!.retryNotBeforeUnixMilliseconds = 1_700_000_005_000
              return commit(changed as never)
            }
            if (mode === 'multiple') {
              const first = commit(raw)
              commit(raw)
              return first
            }
            lateCallback = commit
            lateRaw = raw
            throw new Error('capture late CAS resume')
          })
        } catch (error) {
          if (mode === 'late') return { state: 'committed' as const, value: {} as T }
          throw error
        }
      }
      await assert.rejects(
        () => resumeEncryptedWalletBackupSyncAttempt({ attempt: exhausted }),
        /resumed CAS attempt changed|callback is invalid|synchronous and exact/,
      )
      if (mode === 'late') assert.throws(() => lateCallback!(lateRaw!), /callback is invalid/)
      const persisted = await store.readCasAttempt(
        exhausted.record.attemptId,
        (raw: unknown) => structuredClone(raw) as Record<string, unknown>,
      )
      assert.equal(persisted.state, 'retry-exhausted')
    })
  }
})

test('generation-one empty wallet is canonical and transactionally snapshot-sealed', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'empty-wallet',
  })
  let observedSeal: unknown
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(1),
    chunks: [],
    emptySnapshot: { snapshotId: 'empty-wallet-snapshot', snapshotRevision: 7 },
    snapshotStore: {
      async sealCommittedBackupSnapshot<T>(expected: unknown, seal: (value: never) => T) {
        observedSeal = structuredClone(expected)
        return seal(structuredClone(expected) as never)
      },
    },
  })
  assert.deepEqual(observedSeal, {
    schemaVersion: 1,
    snapshotId: 'empty-wallet-snapshot',
    snapshotRevision: 7,
    proofCount: 0,
    proofSetDigest: toHex(nobleSha256(encode([1, 'eligible-proof-set', []], rfc8949EncodeOptions))),
  })
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  })
  assert.deepEqual(
    {
      generation: head.generation,
      proofCount: head.proofCount,
      objectCount: head.objectCount,
      storedBytes: head.storedBytes,
    },
    { generation: 1, proofCount: 0, objectCount: 0, storedBytes: 0 },
  )
})

test('manifest preparation rejects rows from different committed wallet revisions', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
  })
  const first = await prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, 0, 1))
  const second = await prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, 1, 2))
  const chunks = [
    packEncryptedWalletBackupProofChunk([first]),
    packEncryptedWalletBackupProofChunk([second]),
  ]
  const objects = await Promise.all(
    chunks.map((chunk, index) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicRuntime([
          new Uint8Array(16).fill(index + 41),
          new Uint8Array(12).fill(index + 51),
        ]),
      }),
    ),
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupManifest({
        keyHandle,
        generation: 1,
        snapshotNonce: new Uint8Array(16).fill(61),
        chunks: chunks.map((chunk, index) => ({
          chunk,
          object: objects[index]!,
        })),
        snapshotStore: acceptingSnapshotSealStore(),
        runtime: deterministicRuntime([]),
      }),
    /committed wallet snapshot changed/,
  )
})

test('manifest authority requires final transactional proof-set revalidation', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'snapshot-fence',
  })
  const proof = await prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, 0))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 1,
    runtime: deterministicRuntime([new Uint8Array(16).fill(62), new Uint8Array(12).fill(63)]),
  })
  for (const mutate of [
    (seal: Record<string, unknown>) => ({ ...seal, proofCount: 2 }),
    (seal: Record<string, unknown>) => ({
      ...seal,
      proofSetDigest: 'ff'.repeat(32),
    }),
    (seal: Record<string, unknown>) => ({ ...seal, snapshotRevision: 2 }),
  ]) {
    await assert.rejects(
      () =>
        prepareEncryptedWalletBackupManifest({
          keyHandle,
          generation: 1,
          snapshotNonce: new Uint8Array(16).fill(64),
          chunks: [{ chunk, object }],
          snapshotStore: {
            async sealCommittedBackupSnapshot<T>(
              expected: unknown,
              seal: (value: never) => T,
            ): Promise<T> {
              return seal(mutate(expected as Record<string, unknown>) as never)
            },
          },
          runtime: deterministicRuntime([]),
        }),
      /committed wallet snapshot changed/,
    )
  }
})

test('delegated request proof binds exact HTTPS target, method, epoch, time, nonce, and body', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
    runtime: deterministicRuntime([]),
  })
  const payload = new TextEncoder().encode('{"head":"candidate"}')
  const proof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 3,
    method: 'POST',
    url: 'https://backup.example.test/v1/vault/head?mode=cas',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload,
    runtime: deterministicRuntime([new Uint8Array(16).fill(71), new Uint8Array(32).fill(72)]),
  })
  assert.equal(
    verifyEncryptedWalletBackupRequestProof({
      proof,
      expectedRealm: vector.inputs.realm,
      expectedVaultId: keyHandle.vaultId,
      expectedPublicKey: keyHandle.requestAuthPublicKey,
      expectedEnrollmentEpoch: 3,
      expectedMethod: 'POST',
      expectedUrl: 'https://backup.example.test/v1/vault/head?mode=cas',
      payload,
      serverNowUnixSeconds: 1_700_000_010,
    }),
    true,
  )
  for (const changed of [
    { expectedMethod: 'PUT' as const },
    { expectedUrl: 'https://backup.example.test/v1/vault/head?mode=other' },
    { expectedEnrollmentEpoch: 4 },
    { payload: new TextEncoder().encode('{"head":"different"}') },
    { serverNowUnixSeconds: 1_700_000_031 },
  ]) {
    assert.equal(
      verifyEncryptedWalletBackupRequestProof({
        proof,
        expectedRealm: vector.inputs.realm,
        expectedVaultId: keyHandle.vaultId,
        expectedPublicKey: keyHandle.requestAuthPublicKey,
        expectedEnrollmentEpoch: 3,
        expectedMethod: 'POST',
        expectedUrl: 'https://backup.example.test/v1/vault/head?mode=cas',
        payload,
        serverNowUnixSeconds: 1_700_000_010,
        ...changed,
      }),
      false,
    )
  }
  const seen = new Set<string>()
  const replayStore = {
    async consumeReplayNonce(input: { replayNonce: string }) {
      if (seen.has(input.replayNonce)) return 'replayed' as const
      seen.add(input.replayNonce)
      return 'consumed' as const
    },
  }
  const authenticationInput = {
    proof,
    expectedRealm: vector.inputs.realm,
    expectedVaultId: keyHandle.vaultId,
    expectedPublicKey: keyHandle.requestAuthPublicKey,
    expectedEnrollmentEpoch: 3,
    expectedMethod: 'POST' as const,
    expectedUrl: 'https://backup.example.test/v1/vault/head?mode=cas',
    payload,
    serverNowUnixSeconds: 1_700_000_010,
    replayStore,
  }
  await authenticateEncryptedWalletBackupRequest(authenticationInput)
  await assert.rejects(
    () => authenticateEncryptedWalletBackupRequest(authenticationInput),
    /request replayed/,
  )
  const concurrentSeen = new Set<string>()
  const concurrent = await Promise.allSettled(
    [0, 1].map(() =>
      authenticateEncryptedWalletBackupRequest({
        ...authenticationInput,
        replayStore: {
          async consumeReplayNonce(input: { replayNonce: string }) {
            if (concurrentSeen.has(input.replayNonce)) return 'replayed' as const
            concurrentSeen.add(input.replayNonce)
            await Promise.resolve()
            return 'consumed' as const
          },
        },
      }),
    ),
  )
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1)
})

test('realm separation and exact-object capability provenance fail closed', async () => {
  const first = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const second = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test-2',
  })
  assert.notEqual(first.vaultId, second.vaultId)
  assert.notEqual(first.requestAuthPublicKey, second.requestAuthPublicKey)
  const expectedProofId = deriveProofIdForTest(
    SEED,
    vector.inputs.proof.mint,
    vector.inputs.proof.unit,
    vector.inputs.proof.keysetId,
    SECRET,
  )
  const firstPreparedProof = await prepareEncryptedWalletBackupProof(proofInput(first))
  const secondPreparedProof = await prepareEncryptedWalletBackupProof(proofInput(second))
  assert.equal(firstPreparedProof.proofId, expectedProofId)
  assert.equal(secondPreparedProof.proofId, expectedProofId)
  assert.equal(firstPreparedProof.proofId, secondPreparedProof.proofId)
  const firstInput = proofInput(first)
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...firstInput,
        keyHandle: { ...first },
      }),
    /backup key handle is invalid/,
  )
  const proof = firstPreparedProof
  assert.throws(
    () => packEncryptedWalletBackupProofChunk([{ ...proof }]),
    /proof handle is invalid/,
  )
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle: first,
        chunk: { ...chunk },
        generation: 1,
      }),
    /proof chunk handle is invalid/,
  )
  const sameSeedNewHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle: sameSeedNewHandle,
        chunk,
        generation: 1,
      }),
    /different backup key/,
  )
  const foreignSeedHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(7),
    realm: 'test',
  })
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle: foreignSeedHandle,
        chunk,
        generation: 1,
      }),
    /different backup key/,
  )
  await assert.rejects(
    () => createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: 'test-' }),
    /backup realm is invalid/,
  )
  await assert.rejects(
    () =>
      createEncryptedWalletBackupKeyHandle({
        seed: SEED,
        realm: `a${'.'.repeat(63)}`,
      }),
    /backup realm is invalid/,
  )
  await assert.rejects(
    () =>
      createEncryptedWalletBackupKeyHandle({
        seed: new Uint8Array(63),
        realm: 'test',
      }),
    /backup seed is invalid/,
  )
  await assert.rejects(
    () =>
      createEncryptedWalletBackupKeyHandle({
        seed: new Uint8Array(65),
        realm: 'test',
      }),
    /backup seed is invalid/,
  )
  const valid64 = `a${'b'.repeat(62)}c`
  assert.equal(
    (await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: valid64 })).realm,
    valid64,
  )
})

test('request-auth scalar derivation rejects zero and out-of-range candidates and caps exhaustion', async () => {
  const order = fromHex('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
  const overOrder = fromHex('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  const validOne = fromHex(`${'00'.repeat(31)}01`)
  const accepted = scalarCandidateRuntime([new Uint8Array(32), order, overOrder, validOne])
  const handle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'scalar-test',
    runtime: accepted.runtime,
  })
  assert.equal(
    handle.requestAuthPublicKey,
    '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  )
  assert.equal(accepted.scalarCalls(), 4)

  const exhausted = scalarCandidateRuntime(new Array(256).fill(new Uint8Array(32)))
  await assert.rejects(
    () =>
      createEncryptedWalletBackupKeyHandle({
        seed: SEED,
        realm: 'scalar-exhaustion',
        runtime: exhausted.runtime,
      }),
    /scalar derivation exhausted/,
  )
  assert.equal(exhausted.scalarCalls(), 256)
})

test('preparation validates seed, counter, classifier facts, proof class, fields, and keyset wire', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        seed: new Uint8Array(64),
      }),
    /backup seed does not match key handle/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        counter: 8,
      }),
    /proof secret does not match deterministic derivation/,
  )
  for (const override of [
    { provenance: 'external' },
    { provenance: 'unknown' },
    { operationBinding: 'nonterminal' },
    { operationBinding: 'unknown' },
    { reserved: true },
    { ambiguousMintOperation: true },
    { derivationLocator: 'missing' },
  ]) {
    await assert.rejects(
      () =>
        prepareEncryptedWalletBackupProof(withProofStore(proofInput(keyHandle), null, override)),
      /proof is not backup eligible/,
    )
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        proof: { ...proofInput(keyHandle).proof, witness: 'secret-witness' },
      } as never),
    /unsupported proof field/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        proof: { ...proofInput(keyHandle).proof, p2pk_e: '02'.repeat(33) },
      } as never),
    /unsupported proof field/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        proof: { ...proofInput(keyHandle).proof, id: '01abcdefabcdefab' },
      }),
    /unresolved short modern keyset/,
  )

  for (const keysetId of ['009a1f293253e41e', '9mlfd5vCzgGl']) {
    const input = proofInputForKeyset(keyHandle, keysetId)
    const prepared = await prepareEncryptedWalletBackupProof(input)
    assert.match(prepared.proofId, /^[0-9a-f]{64}$/)
  }

  const padded = proofInputForKeyset(keyHandle, 'AQIDBA==')
  const unpadded = proofInputForKeyset(keyHandle, 'AQIDBA')
  assert.equal(padded.proof.secret, unpadded.proof.secret)
  const paddedPrepared = await prepareEncryptedWalletBackupProof(padded)
  const unpaddedPrepared = await prepareEncryptedWalletBackupProof(unpadded)
  assert.equal(paddedPrepared.proofId, unpaddedPrepared.proofId)
  assert.throws(
    () => packEncryptedWalletBackupProofChunk([paddedPrepared, unpaddedPrepared]),
    /proof id is duplicated/,
  )
  assert.throws(() => proofInputForKeyset(keyHandle, '+___'), /Unrecognized|mixes Base64 alphabets/)
})

test('CTF requires complete metadata, permits expired retention, and ordinary proof forbids it', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const ctfInput = ctfProofInput(keyHandle)
  const metadata = ctfInput.ctfMetadata
  await prepareEncryptedWalletBackupProof(withProofStore(ctfInput, verifiedConditionalEvidence()))
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        proofKind: 'ctf',
        ctfMetadata: null,
      }),
    /CTF metadata is invalid/,
  )
  await prepareEncryptedWalletBackupProof({
    ...withProofStore(ctfInput, verifiedConditionalEvidence()),
    effectiveNowUnixSeconds: metadata.finalExpiryUnixSeconds,
  })
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...ctfInput,
        ctfMetadata: { ...ctfInput.ctfMetadata, registeredAtUnixSeconds: null },
      } as never),
    /CTF registration time is invalid/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...proofInput(keyHandle),
        ctfMetadata: metadata,
      }),
    /ordinary proof cannot contain CTF metadata/,
  )
})

test('CTF terminal backup rejects a structurally cloned losing seal', async () => {
  await assert.rejects(
    () =>
      createVerifiableRestoreFixtureForTest({
        ctf: true,
        verifiedLosing: true,
        cloneTerminalEvidence: true,
      }),
    /terminal evidence|losing outcome evidence/,
  )
})

test('authoritative snapshot binds proof bytes and every validated conditional-keyset field', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const ctfInput = ctfProofInput(keyHandle)
  const conditional = verifiedConditionalEvidence()
  const bound = withProofStore(ctfInput, conditional)
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof(withProofStore(ctfInput)),
    /validated conditional keyset/,
  )
  for (const metadataOverride of [
    { conditionId: '33'.repeat(32) },
    { outcomeLabel: 'NO' },
    { outcomeCollectionId: '44'.repeat(32) },
    {
      registeredAtUnixSeconds: ctfInput.ctfMetadata.registeredAtUnixSeconds + 1,
    },
    // A later claimed expiry must not extend the cryptographically verified keyset lifetime.
    {
      finalExpiryUnixSeconds: ctfInput.ctfMetadata.finalExpiryUnixSeconds + 10_000,
    },
  ]) {
    const spoofed = {
      ...ctfInput,
      ctfMetadata: { ...ctfInput.ctfMetadata, ...metadataOverride },
    }
    await assert.rejects(
      () => prepareEncryptedWalletBackupProof(withProofStore(spoofed, conditional)),
      /proof does not match validated conditional keyset/,
    )
  }
  for (const proof of [
    { ...bound.proof, amount: '2' },
    { ...bound.proof, C: `03${bound.proof.C.slice(2)}` },
  ]) {
    await assert.rejects(
      () => prepareEncryptedWalletBackupProof({ ...bound, proof }),
      /proof commitment does not match authoritative storage snapshot/,
    )
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...bound,
        ctfMetadata: { ...bound.ctfMetadata, outcomeLabel: 'NO' },
      }),
    /proof commitment does not match authoritative storage snapshot/,
  )
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...withProofStore(ctfInput, { ...conditional }),
      }),
    /conditional keyset evidence is invalid/,
  )

  const foreignKeyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'foreign',
  })
  const foreignBound = proofInput(foreignKeyHandle)
  await assert.rejects(() =>
    prepareEncryptedWalletBackupProof({
      ...bound,
      proofSnapshotStore: foreignBound.proofSnapshotStore,
    }),
  )

  const context = conditionalContext()
  const foreignMintEvidence = verifyConditionalEvidence({
    ...context,
    mint: 'https://other-mint.example',
  })
  await assert.rejects(
    () => prepareEncryptedWalletBackupProof(withProofStore(ctfInput, foreignMintEvidence)),
    /validated conditional keyset/,
  )
  for (const changed of [
    { ...context, unit: 'usd' },
    { ...context, outcomeLabel: 'NO' },
    {
      ...context,
      registeredAtUnixSeconds: context.registeredAtUnixSeconds + 1,
    },
    {
      ...context,
      mintKeys: { ...CTF_MINT_KEYS, id: vector.inputs.proof.keysetId },
    },
    {
      ...context,
      mintKeys: { ...CTF_MINT_KEYS, id: `02${CTF_KEYSET_ID.slice(2)}` },
    },
    {
      ...context,
      mintKeys: {
        ...CTF_MINT_KEYS,
        final_expiry: CTF_MINT_KEYS.final_expiry + 1,
      },
    },
    {
      ...context,
      mintKeys: {
        ...CTF_MINT_KEYS,
        final_expiry: CTF_CONDITIONAL_METADATA.registeredAt,
      },
    },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, input_fee_ppk: -1 } },
    { ...context, mintKeys: { ...CTF_MINT_KEYS, keys: {} } },
    {
      ...context,
      mintKeys: { ...CTF_MINT_KEYS, keys: { 1: '04'.repeat(33) } },
    },
    {
      ...context,
      mintKeys: {
        ...CTF_MINT_KEYS,
        conditional: { ...CTF_CONDITIONAL_METADATA, outcomeCollection: 'NO' },
      },
    },
    {
      ...context,
      conditionalMetadata: {
        ...CTF_CONDITIONAL_METADATA,
        conditionId: '33'.repeat(32),
      },
    },
    {
      ...context,
      conditionalMetadata: {
        ...CTF_CONDITIONAL_METADATA,
        outcomeCollectionId: '44'.repeat(32),
      },
    },
    {
      ...context,
      conditionalMetadata: {
        ...CTF_CONDITIONAL_METADATA,
        registeredAt: 1_700_000_001,
      },
    },
  ]) {
    assert.throws(() => verifyConditionalEvidence(changed), /conditional|keyset/)
  }
})

test('proof-store transaction is the only synchronous exact-row authority boundary', async () => {
  assert.equal('prepareEncryptedWalletBackupStorageSnapshot' in BackupModule, false)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const valid = proofInput(keyHandle)
  const validStore = valid.proofSnapshotStore

  const doubleRead = {
    async withCommittedProofSnapshot<T>(
      stableProofId: string,
      read: (row: never) => T,
    ): Promise<T> {
      return validStore.withCommittedProofSnapshot(stableProofId, (row) => {
        const first = read(row as never)
        read(row as never)
        return first
      })
    },
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...valid,
        proofSnapshotStore: doubleRead,
      }),
    /transaction callback is invalid/,
  )

  const substitutedReturn = {
    async withCommittedProofSnapshot<T>(
      stableProofId: string,
      read: (row: never) => T,
    ): Promise<T> {
      return validStore.withCommittedProofSnapshot(stableProofId, (row) => {
        read(row as never)
        return {} as T
      })
    },
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...valid,
        proofSnapshotStore: substitutedReturn,
      }),
    /transaction must be synchronous and exact/,
  )

  let lateRead: ((row: never) => unknown) | undefined
  let capturedRow: never | undefined
  const lateStore = {
    async withCommittedProofSnapshot<T>(
      stableProofId: string,
      read: (row: never) => T,
    ): Promise<T> {
      lateRead = read
      return validStore.withCommittedProofSnapshot(stableProofId, (row) => {
        capturedRow = row as never
        return {} as T
      })
    },
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...valid,
        proofSnapshotStore: lateStore,
      }),
    /transaction must be synchronous and exact/,
  )
  assert.throws(() => lateRead!(capturedRow!), /transaction callback is invalid/)

  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof(withProofStore(valid, null, { proofId: 'ff'.repeat(32) })),
    /proof id does not match authoritative storage snapshot/,
  )
})

test('v3 BLS proof uses a full 02 keyset, 48-byte signature, and null DLEQ', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const keysetId = `02${'55'.repeat(32)}`
  const input = proofInputForKeyset(keyHandle, keysetId)
  const prepared = await prepareEncryptedWalletBackupProof({
    ...withProofStore({
      ...input,
      proof: { ...input.proof, C: 'aa'.repeat(48), dleq: undefined },
    }),
  })
  const runtime = deterministicRuntime([new Uint8Array(16).fill(3), new Uint8Array(12).fill(4)])
  const object = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([prepared]),
    generation: 1,
    runtime,
  })
  const restored = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(object),
  })
  assert.deepEqual(restored, { formatVersion: 1, kindCode: 1, recordCount: 1 })
})

test('an expired-at-restore CTF remains opaque and cannot advertise an active or selectable proof', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const ctfInput = ctfProofInput(keyHandle)
  const preparedProof = await prepareEncryptedWalletBackupProof(
    withProofStore(ctfInput, verifiedConditionalEvidence()),
  )
  const runtime = deterministicRuntime([new Uint8Array(16).fill(5), new Uint8Array(12).fill(6)])
  const preparedObject = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([preparedProof]),
    generation: 1,
    runtime,
  })

  // At a later restore time this CTF may already be expired. Commit 3 intentionally
  // exposes no proof body or disposition; commit 5 must verify and classify it.
  const decoded = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(preparedObject),
  })
  assert.deepEqual(decoded, { formatVersion: 1, kindCode: 1, recordCount: 1 })
  assert.equal('proof' in decoded, false)
  assert.equal('proofKind' in decoded, false)
  assert.equal('ctfMetadata' in decoded, false)
})

test('bounded manifest restore advances exact authenticated pages without materializing the vault', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  const initial = beginEncryptedWalletBackupManifestRestore({
    headEvidence: fixture.authenticated,
  })
  assert.deepEqual(initial, {
    formatVersion: 1,
    generation: 1,
    pageCount: 1,
    nextPageIndex: 0,
    restoredEntryCount: 0,
    complete: false,
  })
  const complete = advanceEncryptedWalletBackupManifestRestore({
    cursor: initial,
    manifestPage: fixture.page,
  })
  assert.deepEqual(complete, {
    formatVersion: 1,
    generation: 1,
    pageCount: 1,
    nextPageIndex: 1,
    restoredEntryCount: 1,
    complete: true,
  })
  assert.throws(
    () =>
      advanceEncryptedWalletBackupManifestRestore({
        cursor: initial,
        manifestPage: fixture.page,
      }),
    /restore cursor is stale/,
  )
  assert.throws(
    () =>
      advanceEncryptedWalletBackupManifestRestore({
        cursor: { ...initial },
        manifestPage: fixture.page,
      }),
    /restore cursor is invalid/,
  )
})

test('capacity: manifest restore crosses page boundaries with bounded sequential preparation', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'restore-capacity',
  })
  const proofs = []
  for (let counter = 0; counter < 513; counter += 1) {
    proofs.push(await prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, counter)))
  }
  proofs.sort((left, right) => compareLowerHex(left.proofId, right.proofId))
  const chunks = [
    packEncryptedWalletBackupProofChunk(proofs.slice(0, 256)),
    packEncryptedWalletBackupProofChunk(proofs.slice(256)),
  ]
  const chunkObjects = []
  for (let index = 0; index < chunks.length; index += 1) {
    chunkObjects.push(
      await prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk: chunks[index]!,
        generation: 1,
        runtime: deterministicRuntime([
          new Uint8Array(16).fill(208 + index),
          new Uint8Array(12).fill(220 + index),
        ]),
      }),
    )
  }
  const manifestRandom = []
  for (let index = 0; index < 16; index += 1) {
    manifestRandom.push(
      index % 2 === 0 ? new Uint8Array(16).fill(16 + index) : new Uint8Array(12).fill(16 + index),
    )
  }
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(230),
    chunks: chunks.map((chunk, index) => ({
      chunk,
      object: chunkObjects[index]!,
    })),
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime(manifestRandom),
  })
  assert.ok(manifest.pages.length > 1)
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  })
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/capacity-head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(240), new Uint8Array(32).fill(241)]),
  })
  const authenticated = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(head),
        }
      },
    },
  })
  let cursor = beginEncryptedWalletBackupManifestRestore({
    headEvidence: authenticated,
  })
  const outOfOrderPage = await decryptEncryptedWalletBackupManifestPage({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(manifest.pages[1]!),
    headEvidence: authenticated,
  })
  assert.throws(
    () =>
      advanceEncryptedWalletBackupManifestRestore({
        cursor,
        manifestPage: outOfOrderPage,
      }),
    /foreign or out of order/,
  )
  for (const object of manifest.pages) {
    const page = await decryptEncryptedWalletBackupManifestPage({
      keyHandle,
      seed: SEED,
      object: readPreparedEncryptedWalletBackupObject(object),
      headEvidence: authenticated,
    })
    cursor = advanceEncryptedWalletBackupManifestRestore({
      cursor,
      manifestPage: page,
    })
  }
  assert.equal(cursor.complete, true)
  assert.equal(cursor.restoredEntryCount, 513)
})

test('restored proof becomes durable only after membership, keyset, signature, NUT-07, and exact commit', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  const expectedProofId = deriveProofIdForTest(
    SEED,
    fixture.mint,
    'sat',
    fixture.keysetId,
    fixture.secret,
  )
  assert.equal(fixture.prepared.proofId, expectedProofId)
  const controller = new AbortController()
  const observedSignals: AbortSignal[] = []
  let persisted: readonly Record<string, unknown>[] = []
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'complete-origin',
    selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
    effectiveNowUnixSeconds: 1_700_000_010,
    signal: controller.signal,
    keysetPort: {
      async resolveKeysets(input) {
        observedSignals.push(input.signal)
        assert.deepEqual(input.requests, [
          {
            mint: fixture.mint,
            unit: 'sat',
            keysetId: fixture.keysetId,
          },
        ])
        return [
          {
            ...input.requests[0]!,
            mintKeys: fixture.mintKeys,
          },
        ]
      },
    },
    proofStatePort: {
      async checkProofStates(input) {
        observedSignals.push(input.signal)
        assert.equal(input.proofs.length, 1)
        assert.equal(input.proofs[0]!.proofId, fixture.prepared.proofId)
        assert.equal(input.proofs[0]!.mint, fixture.mint)
        assert.match(input.proofs[0]!.y, /^[0-9a-f]+$/)
        return input.proofs.map((proof) => ({
          proofId: proof.proofId,
          y: proof.y,
          state: 'UNSPENT' as const,
        }))
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        observedSignals.push(input.signal)
        persisted = structuredClone(input.expected)
        return commit(absentRestoreCurrentStates(input.expected))
      },
    },
  })
  assert.deepEqual(result, {
    formatVersion: 1,
    generation: 1,
    manifestDigest: fixture.authenticated.head!.manifestDigest,
    proofCount: 1,
    proofIds: [fixture.prepared.proofId],
  })
  assert.equal(result.proofIds[0], expectedProofId)
  assert.equal(observedSignals.length, 3)
  assert.equal(
    observedSignals.every((signal) => signal === controller.signal),
    true,
  )
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0]!.proofId, fixture.prepared.proofId)
  assert.equal((persisted[0]!.proof as { proof: { secret: string } }).proof.secret, fixture.secret)
  assert.equal((persisted[0]!.proof as { disposition: string }).disposition, 'selectable')
  assert.equal(
    (persisted[0]!.storageClassification as { storageClass: string }).storageClass,
    'remotely-backed-deterministic-proof',
  )
  assert.equal(JSON.stringify(result).includes(fixture.secret), false)
})

test('active CTF restore verifies conditional metadata and commits a selectable proof', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({ ctf: true })
  let persisted: readonly Record<string, unknown>[] = []
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'complete-origin',
    selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
    effectiveNowUnixSeconds: fixture.finalExpiry - 1,
    signal: AbortSignal.timeout(10_000),
    keysetPort: {
      async resolveKeysets(input) {
        return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
      },
    },
    proofStatePort: {
      async checkProofStates(input) {
        return input.proofs.map((proof) => ({
          proofId: proof.proofId,
          y: proof.y,
          state: 'UNSPENT' as const,
        }))
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        persisted = structuredClone(input.expected)
        return commit(absentRestoreCurrentStates(input.expected))
      },
    },
  })
  assert.equal(result.proofCount, 1)
  const persistedProof = persisted[0]!.proof as Record<string, unknown>
  assert.equal(persistedProof.proofKind, 'ctf')
  assert.deepEqual(persistedProof.ctfMetadata, {
    conditionId: 'ab'.repeat(32),
    outcomeLabel: 'YES',
    outcomeCollectionId: 'cd'.repeat(32),
    registeredAtUnixSeconds: 1_700_000_000,
    finalExpiryUnixSeconds: fixture.finalExpiry,
  })
  assert.equal(persistedProof.disposition, 'selectable')
  assert.equal(persistedProof.nonselectableReason, null)
})

test('expired CTF restore stays complete and nonselectable without mint availability', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({
    ctf: true,
    prepareAtOrAfterExpiry: true,
  })
  let keysetCalls = 0
  let stateCalls = 0
  let persisted: readonly Record<string, unknown>[] = []
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'complete-origin',
    selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
    effectiveNowUnixSeconds: fixture.finalExpiry,
    signal: AbortSignal.timeout(10_000),
    keysetPort: {
      async resolveKeysets() {
        keysetCalls += 1
        throw new Error('expired CTF must not require a live keyset')
      },
    },
    proofStatePort: {
      async checkProofStates() {
        stateCalls += 1
        throw new Error('expired CTF must not require NUT-07')
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        persisted = structuredClone(input.expected)
        return commit(absentRestoreCurrentStates(input.expected))
      },
    },
  })
  assert.equal(result.proofCount, 1)
  assert.equal(keysetCalls, 0)
  assert.equal(stateCalls, 0)
  const row = persisted[0]!
  assert.equal(
    (row.storageClassification as { storageClass: string }).storageClass,
    'user-retained-nonselectable-ctf',
  )
  const proof = row.proof as Record<string, unknown>
  assert.equal(proof.proofKind, 'ctf')
  assert.equal(proof.disposition, 'user-retained-nonselectable')
  assert.equal(proof.nonselectableReason, 'recorded-ctf-expiry-passed')
  assert.equal((proof.proof as { secret: string }).secret, fixture.secret)
})

test('verified losing CTF restore uses the compact exact-operation seal without mint calls', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({
    ctf: true,
    verifiedLosing: true,
  })
  let portCalls = 0
  let persisted: readonly Record<string, unknown>[] = []
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'complete-origin',
    selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
    effectiveNowUnixSeconds: fixture.finalExpiry - 1,
    signal: AbortSignal.timeout(10_000),
    keysetPort: {
      async resolveKeysets() {
        portCalls += 1
        throw new Error('verified losing proof must not resolve live keys')
      },
    },
    proofStatePort: {
      async checkProofStates() {
        portCalls += 1
        throw new Error('verified losing proof must not call NUT-07')
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        persisted = structuredClone(input.expected)
        return commit(absentRestoreCurrentStates(input.expected))
      },
    },
  })
  assert.equal(result.proofCount, 1)
  assert.equal(portCalls, 0)
  const row = persisted[0]!
  assert.equal(
    (row.storageClassification as { storageClass: string }).storageClass,
    'user-retained-nonselectable-ctf',
  )
  const proof = row.proof as Record<string, unknown>
  assert.equal(proof.disposition, 'user-retained-nonselectable')
  assert.equal(proof.nonselectableReason, 'verified-losing-outcome')
  assert.deepEqual(Object.keys(proof.terminalEvidence as object).sort(), [
    'classifiedAt',
    'failureCode',
    'operationIdDigest',
    'reason',
    'requestDigest',
  ])
})

test('verified losing CTF restore permits the exact monotonic seal augmentation', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({
    ctf: true,
    verifiedLosing: true,
    generationTwoFromActive: true,
  })
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'hydrate-existing',
    selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
    effectiveNowUnixSeconds: fixture.finalExpiry - 1,
    signal: AbortSignal.timeout(10_000),
    keysetPort: {
      async resolveKeysets() {
        throw new Error('unexpected')
      },
    },
    proofStatePort: {
      async checkProofStates() {
        throw new Error('unexpected')
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        const candidate = input.expected[0]!
        return commit([
          activePredecessorRestoreState(candidate, fixture.keyHandle.requestAuthPublicKey),
        ])
      },
    },
  })
  assert.equal(result.proofCount, 1)
})

test('verified losing CTF restore rejects mixed predecessor bindings and non-parent heads', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({
    ctf: true,
    verifiedLosing: true,
    generationTwoFromActive: true,
  })
  for (const mutation of [
    (current: ReturnType<typeof activePredecessorRestoreState>) => {
      current.storageClassification = {
        ...current.storageClassification,
        backupBinding: {
          ...current.storageClassification.backupBinding!,
          chunkDigest: 'dd'.repeat(32),
        },
      }
    },
    (current: ReturnType<typeof activePredecessorRestoreState>) => {
      current.storageClassification = {
        ...current.storageClassification,
        backupBinding: {
          ...current.storageClassification.backupBinding!,
          snapshotId: 'dd'.repeat(32),
        },
      }
    },
    (current: ReturnType<typeof activePredecessorRestoreState>) => {
      current.proof = {
        ...current.proof,
        manifestDigest: 'dd'.repeat(32),
      }
    },
  ]) {
    await assert.rejects(
      () =>
        restoreEncryptedWalletBackupProofs({
          keyHandle: fixture.keyHandle,
          headEvidence: fixture.authenticated,
          proofChunk: fixture.decryptedChunk,
          restoreMode: 'hydrate-existing',
          selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
          effectiveNowUnixSeconds: fixture.finalExpiry - 1,
          signal: AbortSignal.timeout(10_000),
          keysetPort: {
            async resolveKeysets() {
              throw new Error('unexpected')
            },
          },
          proofStatePort: {
            async checkProofStates() {
              throw new Error('unexpected')
            },
          },
          restoreStore: {
            async commitRestoredProofs(input, commit) {
              const current = activePredecessorRestoreState(
                input.expected[0]!,
                fixture.keyHandle.requestAuthPublicKey,
              )
              mutation(current)
              return commit([current])
            },
          },
        }),
      /current state conflicts/,
    )
  }
})

test('mixed active and terminal CTF restore sends only active proofs to live ports', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({
    ctf: true,
    count: 2,
    verifiedLosingCounter: 1,
  })
  const pageByProofId = new Map(
    fixture.pages.flatMap((page) => page.entries.map((entry) => [entry.proofId, page] as const)),
  )
  let keysetProofCount = 0
  let stateProofCount = 0
  let persisted: readonly Record<string, unknown>[] = []
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'complete-origin',
    selections: fixture.preparedProofs.map((proof) => ({
      manifestPage: pageByProofId.get(proof.proofId)!,
      proofId: proof.proofId,
    })),
    effectiveNowUnixSeconds: fixture.finalExpiry - 1,
    signal: AbortSignal.timeout(10_000),
    keysetPort: {
      async resolveKeysets(input) {
        keysetProofCount = input.requests.length
        return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
      },
    },
    proofStatePort: {
      async checkProofStates(input) {
        stateProofCount = input.proofs.length
        return input.proofs.map((proof) => ({
          proofId: proof.proofId,
          y: proof.y,
          state: 'UNSPENT' as const,
        }))
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        persisted = structuredClone(input.expected)
        return commit(absentRestoreCurrentStates(input.expected))
      },
    },
  })
  assert.equal(result.proofCount, 2)
  assert.equal(keysetProofCount, 1)
  assert.equal(stateProofCount, 1)
  assert.deepEqual(
    persisted.map((row) => (row.proof as { disposition: string }).disposition).sort(),
    ['selectable', 'user-retained-nonselectable'],
  )
})

test('expired CTF restore permits only the exact active-to-retained transition', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({ ctf: true })
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'hydrate-existing',
    selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
    effectiveNowUnixSeconds: fixture.finalExpiry,
    signal: AbortSignal.timeout(10_000),
    keysetPort: {
      async resolveKeysets() {
        throw new Error('unexpected')
      },
    },
    proofStatePort: {
      async checkProofStates() {
        throw new Error('unexpected')
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        const candidate = input.expected[0]!
        return commit([
          {
            proofId: candidate.proofId,
            storageClassification: {
              ...candidate.storageClassification,
              storageClass: 'remotely-backed-deterministic-proof',
            },
            proof: {
              ...candidate.proof,
              disposition: 'selectable',
              nonselectableReason: null,
            },
          },
        ])
      },
    },
  })
  assert.equal(result.proofCount, 1)
})

test('active CTF restore rejects a reverse retained-to-selectable transition', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({ ctf: true })
  await assert.rejects(
    () =>
      restoreEncryptedWalletBackupProofs({
        keyHandle: fixture.keyHandle,
        headEvidence: fixture.authenticated,
        proofChunk: fixture.decryptedChunk,
        restoreMode: 'hydrate-existing',
        selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
        effectiveNowUnixSeconds: fixture.finalExpiry - 1,
        signal: AbortSignal.timeout(10_000),
        keysetPort: {
          async resolveKeysets(input) {
            return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
          },
        },
        proofStatePort: {
          async checkProofStates(input) {
            return input.proofs.map((proof) => ({
              proofId: proof.proofId,
              y: proof.y,
              state: 'UNSPENT' as const,
            }))
          },
        },
        restoreStore: {
          async commitRestoredProofs(input, commit) {
            const candidate = input.expected[0]!
            return commit([
              {
                proofId: candidate.proofId,
                storageClassification: {
                  ...candidate.storageClassification,
                  storageClass: 'user-retained-nonselectable-ctf',
                },
                proof: {
                  ...candidate.proof,
                  disposition: 'user-retained-nonselectable',
                  nonselectableReason: 'recorded-ctf-expiry-passed',
                },
              },
            ])
          },
        },
      }),
    /current state conflicts/,
  )
})

test('restore transaction accepts only absent or exact resumable current proof state', async (t) => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  for (const scenario of [
    { name: 'body-missing', restoreMode: 'hydrate-existing' },
    { name: 'idempotent-hydration', restoreMode: 'hydrate-existing' },
    { name: 'idempotent-origin-resume', restoreMode: 'complete-origin' },
  ] as const) {
    await t.test(scenario.name, async () => {
      const result = await restoreEncryptedWalletBackupProofs({
        keyHandle: fixture.keyHandle,
        headEvidence: fixture.authenticated,
        proofChunk: fixture.decryptedChunk,
        restoreMode: scenario.restoreMode,
        selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
        effectiveNowUnixSeconds: 1_700_000_010,
        signal: AbortSignal.timeout(10_000),
        keysetPort: {
          async resolveKeysets(input) {
            return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
          },
        },
        proofStatePort: {
          async checkProofStates(input) {
            return input.proofs.map((proof) => ({
              proofId: proof.proofId,
              y: proof.y,
              state: 'UNSPENT' as const,
            }))
          },
        },
        restoreStore: {
          async commitRestoredProofs(input, commit) {
            return commit(
              input.expected.map((row) => ({
                proofId: row.proofId,
                storageClassification: row.storageClassification,
                proof: scenario.name === 'body-missing' ? null : row.proof,
              })),
            )
          },
        },
      })
      assert.equal(result.proofCount, 1)
    })
  }
})

test('restore transaction rejects reserved, nonterminal, stale-binding, and conflicting proof state', async (t) => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  for (const mode of [
    'absent',
    'reserved',
    'nonterminal',
    'stale-binding',
    'conflicting-proof',
  ] as const) {
    await t.test(mode, async () => {
      await assert.rejects(
        () =>
          restoreEncryptedWalletBackupProofs({
            keyHandle: fixture.keyHandle,
            headEvidence: fixture.authenticated,
            proofChunk: fixture.decryptedChunk,
            restoreMode: 'hydrate-existing',
            selections: [
              {
                manifestPage: fixture.page,
                proofId: fixture.prepared.proofId,
              },
            ],
            effectiveNowUnixSeconds: 1_700_000_010,
            signal: AbortSignal.timeout(10_000),
            keysetPort: {
              async resolveKeysets(input) {
                return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
              },
            },
            proofStatePort: {
              async checkProofStates(input) {
                return input.proofs.map((proof) => ({
                  proofId: proof.proofId,
                  y: proof.y,
                  state: 'UNSPENT' as const,
                }))
              },
            },
            restoreStore: {
              async commitRestoredProofs(input, commit) {
                const row = input.expected[0]!
                if (mode === 'absent') return commit(absentRestoreCurrentStates(input.expected))
                const pinned = classifyDurableWalletStorage({
                  schemaVersion: 1,
                  recordId: row.proofId,
                  kind: 'deterministic-proof',
                  provenance: 'wallet-seed',
                  proofKind: row.proof.proofKind,
                  ctfMetadata:
                    row.proof.ctfMetadata === null
                      ? null
                      : {
                          finalExpiryUnixSeconds: row.proof.ctfMetadata.finalExpiryUnixSeconds,
                        },
                  effectiveNowUnixSeconds: 1_700_000_010,
                  operationBinding: mode === 'nonterminal' ? 'nonterminal' : 'terminally-unlinked',
                  reserved: mode === 'reserved',
                  ambiguousMintOperation: false,
                  proofPins: {
                    openOrderCollateral: 'absent',
                    outbox: 'absent',
                    retryCursor: 'absent',
                    replayTombstone: 'absent',
                    dependentWork: 'absent',
                  },
                  derivationLocator: 'committed',
                  proofCommitment: {
                    state: 'verified',
                    digest: row.proof.proofCommitment,
                  },
                  backupReceiptEvidence: null,
                })
                const stale = structuredClone(row.storageClassification)
                if (mode === 'stale-binding') {
                  stale.proofCommitment = 'ff'.repeat(32)
                  stale.backupBinding!.proofCommitment = 'ff'.repeat(32)
                }
                return commit([
                  {
                    proofId: row.proofId,
                    storageClassification:
                      mode === 'reserved' || mode === 'nonterminal' ? pinned : stale,
                    proof:
                      mode === 'conflicting-proof'
                        ? { ...row.proof, counter: row.proof.counter + 1 }
                        : null,
                  },
                ])
              },
            },
          }),
        /current state conflicts/,
      )
    })
  }
})

test('spent proofs, foreign membership, and invalid keysets never reach restored storage', async () => {
  for (const mode of [
    'spent',
    'foreign-membership',
    'invalid-keyset',
    'invalid-signature',
  ] as const) {
    const fixture = await createVerifiableRestoreFixtureForTest({
      invalidSignature: mode === 'invalid-signature',
    })
    let stateCalls = 0
    let storeCalls = 0
    await assert.rejects(
      () =>
        restoreEncryptedWalletBackupProofs({
          keyHandle: fixture.keyHandle,
          headEvidence: fixture.authenticated,
          proofChunk: fixture.decryptedChunk,
          restoreMode: 'complete-origin',
          selections: [
            {
              manifestPage:
                mode === 'foreign-membership'
                  ? ({ ...fixture.page } as typeof fixture.page)
                  : fixture.page,
              proofId: fixture.prepared.proofId,
            },
          ],
          effectiveNowUnixSeconds: 1_700_000_010,
          signal: AbortSignal.timeout(10_000),
          keysetPort: {
            async resolveKeysets(input) {
              return [
                {
                  ...input.requests[0]!,
                  mintKeys:
                    mode === 'invalid-keyset'
                      ? { ...fixture.mintKeys, id: '02' + 'ff'.repeat(32) }
                      : fixture.mintKeys,
                },
              ]
            },
          },
          proofStatePort: {
            async checkProofStates(input) {
              stateCalls += 1
              return input.proofs.map((proof) => ({
                proofId: proof.proofId,
                y: proof.y,
                state: mode === 'spent' ? ('SPENT' as const) : ('UNSPENT' as const),
              }))
            },
          },
          restoreStore: {
            async commitRestoredProofs(input, commit) {
              storeCalls += 1
              return commit(absentRestoreCurrentStates(input.expected))
            },
          },
        }),
      /restore|restored proof|keyset|expired|membership|spendable/,
    )
    assert.equal(storeCalls, 0)
    if (mode === 'foreign-membership' || mode === 'invalid-keyset' || mode === 'invalid-signature')
      assert.equal(stateCalls, 0)
  }
})

test('restore cancellation stops before NUT-07 or storage and preserves the caller signal', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  const controller = new AbortController()
  let stateCalls = 0
  let storeCalls = 0
  await assert.rejects(
    () =>
      restoreEncryptedWalletBackupProofs({
        keyHandle: fixture.keyHandle,
        headEvidence: fixture.authenticated,
        proofChunk: fixture.decryptedChunk,
        restoreMode: 'complete-origin',
        selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
        effectiveNowUnixSeconds: 1_700_000_010,
        signal: controller.signal,
        keysetPort: {
          async resolveKeysets(input) {
            assert.equal(input.signal, controller.signal)
            controller.abort()
            return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
          },
        },
        proofStatePort: {
          async checkProofStates() {
            stateCalls += 1
            return []
          },
        },
        restoreStore: {
          async commitRestoredProofs(input, commit) {
            storeCalls += 1
            return commit(absentRestoreCurrentStates(input.expected))
          },
        },
      }),
    EncryptedWalletBackupDeadlineError,
  )
  assert.equal(stateCalls, 0)
  assert.equal(storeCalls, 0)
})

test('deadline after local commit is resolved by byte-identical retry', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  const firstController = new AbortController()
  let committed: readonly EncryptedWalletBackupRestoreProofRow[] | undefined
  let storeCalls = 0
  const restoreStore: EncryptedWalletBackupRestoreStore = {
    async commitRestoredProofs(input, commit) {
      storeCalls += 1
      if (committed === undefined) {
        const marker = commit(absentRestoreCurrentStates(input.expected))
        committed = structuredClone(input.expected)
        firstController.abort()
        return marker
      }
      return commit(
        committed.map((row) => ({
          proofId: row.proofId,
          storageClassification: row.storageClassification,
          proof: row.proof,
        })),
      )
    },
  }
  const attempt = (signal: AbortSignal) =>
    restoreEncryptedWalletBackupProofs({
      keyHandle: fixture.keyHandle,
      headEvidence: fixture.authenticated,
      proofChunk: fixture.decryptedChunk,
      restoreMode: 'complete-origin',
      selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
      effectiveNowUnixSeconds: 1_700_000_010,
      signal,
      keysetPort: {
        async resolveKeysets(input) {
          return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
        },
      },
      proofStatePort: {
        async checkProofStates(input) {
          return input.proofs.map((proof) => ({
            proofId: proof.proofId,
            y: proof.y,
            state: 'UNSPENT' as const,
          }))
        },
      },
      restoreStore,
    })
  await assert.rejects(() => attempt(firstController.signal), EncryptedWalletBackupDeadlineError)
  assert.equal(committed?.length, 1)
  const retried = await attempt(AbortSignal.timeout(10_000))
  assert.equal(retried.proofCount, 1)
  assert.equal(storeCalls, 2)
  assert.equal(committed?.length, 1)
})

test('restore cancellation closes the local transaction capability before a late callback', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  const controller = new AbortController()
  let lateCallback: ((records: readonly Record<string, unknown>[]) => unknown) | undefined
  let lateRecords: readonly Record<string, unknown>[] | undefined
  await assert.rejects(
    () =>
      restoreEncryptedWalletBackupProofs({
        keyHandle: fixture.keyHandle,
        headEvidence: fixture.authenticated,
        proofChunk: fixture.decryptedChunk,
        restoreMode: 'complete-origin',
        selections: [{ manifestPage: fixture.page, proofId: fixture.prepared.proofId }],
        effectiveNowUnixSeconds: 1_700_000_010,
        signal: controller.signal,
        keysetPort: {
          async resolveKeysets(input) {
            return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
          },
        },
        proofStatePort: {
          async checkProofStates(input) {
            return input.proofs.map((proof) => ({
              proofId: proof.proofId,
              y: proof.y,
              state: 'UNSPENT' as const,
            }))
          },
        },
        restoreStore: {
          async commitRestoredProofs(input, commit) {
            assert.equal(input.signal, controller.signal)
            lateCallback = commit as typeof lateCallback
            lateRecords = absentRestoreCurrentStates(input.expected)
            controller.abort()
            return new Promise<never>(() => {})
          },
        },
      }),
    EncryptedWalletBackupDeadlineError,
  )
  assert.throws(() => lateCallback!(lateRecords!), /commit callback is invalid/)
})

test('restore rejects non-exact keyset and NUT-07 responses before durable storage', async (t) => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  for (const mode of [
    'missing-keyset',
    'duplicate-keyset',
    'foreign-keyset',
    'unknown-keyset-field',
    'missing-state',
    'duplicate-state',
    'pending-state',
    'unknown-state',
    'foreign-state',
    'unknown-state-field',
  ] as const) {
    await t.test(mode, async () => {
      let stateCalls = 0
      let storeCalls = 0
      await assert.rejects(
        () =>
          restoreEncryptedWalletBackupProofs({
            keyHandle: fixture.keyHandle,
            headEvidence: fixture.authenticated,
            proofChunk: fixture.decryptedChunk,
            restoreMode: 'complete-origin',
            selections: [
              {
                manifestPage: fixture.page,
                proofId: fixture.prepared.proofId,
              },
            ],
            effectiveNowUnixSeconds: 1_700_000_010,
            signal: AbortSignal.timeout(10_000),
            keysetPort: {
              async resolveKeysets(input) {
                const valid = {
                  ...input.requests[0]!,
                  mintKeys: fixture.mintKeys,
                }
                if (mode === 'missing-keyset') return []
                if (mode === 'duplicate-keyset') return [valid, valid]
                if (mode === 'foreign-keyset')
                  return [{ ...valid, mint: 'https://foreign-mint.example' }]
                if (mode === 'unknown-keyset-field')
                  return [{ ...valid, unexpected: true }] as never
                return [valid]
              },
            },
            proofStatePort: {
              async checkProofStates(input) {
                stateCalls += 1
                const valid = {
                  proofId: input.proofs[0]!.proofId,
                  y: input.proofs[0]!.y,
                  state: 'UNSPENT' as const,
                }
                if (mode === 'missing-state') return []
                if (mode === 'duplicate-state') return [valid, valid]
                if (mode === 'pending-state') return [{ ...valid, state: 'PENDING' as const }]
                if (mode === 'unknown-state') return [{ ...valid, state: 'UNKNOWN' }] as never
                if (mode === 'foreign-state') return [{ ...valid, proofId: 'ff'.repeat(32) }]
                if (mode === 'unknown-state-field') return [{ ...valid, unexpected: true }] as never
                return [valid]
              },
            },
            restoreStore: {
              async commitRestoredProofs(input, commit) {
                storeCalls += 1
                return commit(absentRestoreCurrentStates(input.expected))
              },
            },
          }),
        /keyset response|state response|not spendable|unsupported proof field/,
      )
      assert.equal(storeCalls, 0)
      assert.equal(stateCalls, mode.endsWith('keyset') || mode === 'unknown-keyset-field' ? 0 : 1)
    })
  }
})

test('restore signature groups keep legacy keyset identities separate across mint units', () => {
  const sharedLegacyKeysetId = '00b1c9938f01121e'
  const records = [
    {
      mint: 'https://mint.example',
      unit: 'usd',
      keysetId: sharedLegacyKeysetId,
    },
    {
      mint: 'https://mint.example',
      unit: 'sat',
      keysetId: sharedLegacyKeysetId,
    },
    {
      mint: 'https://other-mint.example',
      unit: 'sat',
      keysetId: sharedLegacyKeysetId,
    },
  ].sort((left, right) =>
    compareEncryptedWalletBackupRestoreTupleText(
      `${left.mint}\0${left.unit}\0${left.keysetId}`,
      `${right.mint}\0${right.unit}\0${right.keysetId}`,
    ),
  )
  const groups = groupEncryptedWalletBackupRestoreRecordsByMintUnit(records)
  assert.deepEqual(
    groups.map((group) => group.map((record) => [record.mint, record.unit])),
    [
      [['https://mint.example', 'sat']],
      [['https://mint.example', 'usd']],
      [['https://other-mint.example', 'sat']],
    ],
  )
})

test('restore selection bound fails before any external port', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest()
  let portCalls = 0
  await assert.rejects(
    () =>
      restoreEncryptedWalletBackupProofs({
        keyHandle: fixture.keyHandle,
        headEvidence: fixture.authenticated,
        proofChunk: fixture.decryptedChunk,
        restoreMode: 'complete-origin',
        selections: Array.from({ length: 65 }, () => ({
          manifestPage: fixture.page,
          proofId: fixture.prepared.proofId,
        })),
        effectiveNowUnixSeconds: 1_700_000_010,
        signal: AbortSignal.timeout(10_000),
        keysetPort: {
          async resolveKeysets() {
            portCalls += 1
            return []
          },
        },
        proofStatePort: {
          async checkProofStates() {
            portCalls += 1
            return []
          },
        },
        restoreStore: {
          async commitRestoredProofs(input, commit) {
            portCalls += 1
            return commit(absentRestoreCurrentStates(input.expected))
          },
        },
      }),
    /selection is invalid/,
  )
  assert.equal(portCalls, 0)
})

test('capacity: 64 real BLS proofs verify in four-proof cooperative slices', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({ count: 64 })
  const pageByProofId = new Map(
    fixture.pages.flatMap((page) => page.entries.map((entry) => [entry.proofId, page] as const)),
  )
  const startedAt = performance.now()
  const result = await restoreEncryptedWalletBackupProofs({
    keyHandle: fixture.keyHandle,
    headEvidence: fixture.authenticated,
    proofChunk: fixture.decryptedChunk,
    restoreMode: 'complete-origin',
    selections: fixture.preparedProofs.map((proof) => ({
      manifestPage: pageByProofId.get(proof.proofId)!,
      proofId: proof.proofId,
    })),
    effectiveNowUnixSeconds: 1_700_000_010,
    signal: AbortSignal.timeout(15_000),
    keysetPort: {
      async resolveKeysets(input) {
        assert.equal(input.requests.length, 1)
        return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
      },
    },
    proofStatePort: {
      async checkProofStates(input) {
        assert.equal(input.proofs.length, 64)
        return input.proofs.map((proof) => ({
          proofId: proof.proofId,
          y: proof.y,
          state: 'UNSPENT' as const,
        }))
      },
    },
    restoreStore: {
      async commitRestoredProofs(input, commit) {
        return commit(absentRestoreCurrentStates(input.expected))
      },
    },
  })
  const elapsedMilliseconds = performance.now() - startedAt
  assert.equal(result.proofCount, 64)
  assert.ok(
    elapsedMilliseconds < 5_000,
    `64-proof verification exceeded 5 seconds: ${elapsedMilliseconds}`,
  )
})

test('cooperative restore aborts between real-crypto slices before NUT-07 or storage', async () => {
  const fixture = await createVerifiableRestoreFixtureForTest({ count: 8 })
  const pageByProofId = new Map(
    fixture.pages.flatMap((page) => page.entries.map((entry) => [entry.proofId, page] as const)),
  )
  const controller = new AbortController()
  let stateCalls = 0
  let storeCalls = 0
  const abortTimer = setTimeout(() => controller.abort(), 0)
  await assert.rejects(
    () =>
      restoreEncryptedWalletBackupProofs({
        keyHandle: fixture.keyHandle,
        headEvidence: fixture.authenticated,
        proofChunk: fixture.decryptedChunk,
        restoreMode: 'complete-origin',
        selections: fixture.preparedProofs.map((proof) => ({
          manifestPage: pageByProofId.get(proof.proofId)!,
          proofId: proof.proofId,
        })),
        effectiveNowUnixSeconds: 1_700_000_010,
        signal: controller.signal,
        keysetPort: {
          async resolveKeysets(input) {
            return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
          },
        },
        proofStatePort: {
          async checkProofStates() {
            stateCalls += 1
            return []
          },
        },
        restoreStore: {
          async commitRestoredProofs(input, commit) {
            storeCalls += 1
            return commit(absentRestoreCurrentStates(input.expected))
          },
        },
      }),
    EncryptedWalletBackupDeadlineError,
  )
  clearTimeout(abortTimer)
  assert.equal(stateCalls, 0)
  assert.equal(storeCalls, 0)
})

test('restore storage rejects wrong, repeated, and late transactional callbacks', async (t) => {
  for (const mode of ['wrong', 'unknown-field', 'reversed-time', 'multiple', 'late'] as const) {
    await t.test(mode, async () => {
      const fixture = await createVerifiableRestoreFixtureForTest()
      let lateCallback: ((records: readonly Record<string, unknown>[]) => unknown) | undefined
      let lateRecords: readonly Record<string, unknown>[] | undefined
      await assert.rejects(
        () =>
          restoreEncryptedWalletBackupProofs({
            keyHandle: fixture.keyHandle,
            headEvidence: fixture.authenticated,
            proofChunk: fixture.decryptedChunk,
            restoreMode: 'complete-origin',
            selections: [
              {
                manifestPage: fixture.page,
                proofId: fixture.prepared.proofId,
              },
            ],
            effectiveNowUnixSeconds: 1_700_000_010,
            signal: AbortSignal.timeout(10_000),
            keysetPort: {
              async resolveKeysets(input) {
                return [{ ...input.requests[0]!, mintKeys: fixture.mintKeys }]
              },
            },
            proofStatePort: {
              async checkProofStates(input) {
                return input.proofs.map((proof) => ({
                  proofId: proof.proofId,
                  y: proof.y,
                  state: 'UNSPENT' as const,
                }))
              },
            },
            restoreStore: {
              async commitRestoredProofs(input, commit) {
                const expected = input.expected
                const absent = absentRestoreCurrentStates(expected)
                if (mode === 'wrong') {
                  const changed = [
                    {
                      proofId: expected[0]!.proofId,
                      storageClassification: expected[0]!.storageClassification,
                      proof: {
                        ...structuredClone(expected[0]!.proof),
                        proofId: 'ff'.repeat(32),
                      },
                    },
                  ]
                  return commit(changed as never)
                }
                if (mode === 'unknown-field') {
                  const changed = structuredClone(absent) as Array<Record<string, unknown>>
                  changed[0]!.unexpected = true
                  return commit(changed as never)
                }
                if (mode === 'reversed-time') {
                  const changed = [
                    {
                      proofId: expected[0]!.proofId,
                      storageClassification: expected[0]!.storageClassification,
                      proof: {
                        ...structuredClone(expected[0]!.proof),
                        updatedAtUnixSeconds: 0,
                      },
                    },
                  ]
                  return commit(changed as never)
                }
                if (mode === 'multiple') {
                  const first = commit(absent)
                  commit(absent)
                  return first
                }
                lateCallback = commit as typeof lateCallback
                lateRecords = absent
                return {} as never
              },
            },
          }),
        /current state|callback is invalid|synchronous and exact|unsupported proof field|update time is invalid/,
      )
      if (mode === 'late') assert.throws(() => lateCallback!(lateRecords!), /callback is invalid/)
    })
  }
})

test('proof field, curve, amount, time, and keyset boundaries fail closed', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const base = proofInput(keyHandle)
  const invalidInputs = [
    { ...base, unit: '' },
    { ...base, unit: 'sat\u0000' },
    { ...base, unit: 'x'.repeat(65) },
    { ...base, counter: -1 },
    { ...base, counter: 2_147_483_648 },
    { ...base, createdAtUnixSeconds: -1 },
    { ...base, updatedAtUnixSeconds: base.createdAtUnixSeconds - 1 },
    { ...base, updatedAtUnixSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, proof: { ...base.proof, amount: '0' } },
    { ...base, proof: { ...base.proof, amount: '01' } },
    { ...base, proof: { ...base.proof, amount: '18446744073709551616' } },
    { ...base, proof: { ...base.proof, secret: SECRET.toUpperCase() } },
    { ...base, proof: { ...base.proof, C: '02'.repeat(32) } },
    {
      ...base,
      proof: {
        ...base.proof,
        dleq: { ...base.proof.dleq, e: '22'.repeat(31) },
      },
    },
    { ...base, proof: { ...base.proof, id: `00${'11'.repeat(32)}` } },
    { ...base, proof: { ...base.proof, id: '0111111111111111' } },
  ]
  for (const input of invalidInputs) {
    await assert.rejects(() => prepareEncryptedWalletBackupProof(input as never))
  }
  const ctf = {
    ...base,
    proofKind: 'ctf' as const,
    ctfMetadata: {
      conditionId: '11'.repeat(32),
      outcomeLabel: 'YES\u0000',
      outcomeCollectionId: '22'.repeat(32),
      registeredAtUnixSeconds: null,
      finalExpiryUnixSeconds: 1_800_000_000,
    },
  }
  await assert.rejects(() => prepareEncryptedWalletBackupProof(ctf), /outcome label is invalid/)
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupProof({
        ...ctf,
        ctfMetadata: { ...ctf.ctfMetadata, conditionId: '11'.repeat(31) },
      }),
    /condition id is invalid/,
  )
})

test('packing rejects duplicates, count and canonical-size overflow, and collision exhaustion', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  assert.throws(() => packEncryptedWalletBackupProofChunk([proof, proof]), /proof id is duplicated/)
  assert.throws(
    () => packEncryptedWalletBackupProofChunk(new Array(513).fill(proof)),
    /proof count/,
  )

  const runtime = deterministicRuntime(new Array(8).fill(fromHex(vector.inputs.objectIdHex)))
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk: packEncryptedWalletBackupProofChunk([proof]),
        generation: 1,
        runtime,
        objectIdExists: () => true,
      }),
    /object id collision limit exceeded/,
  )

  const repeatedId = new Uint8Array(16).fill(7)
  const internalRuntime = deterministicRuntime([
    repeatedId,
    new Uint8Array(12).fill(8),
    ...new Array(8).fill(repeatedId),
  ])
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 1,
    runtime: internalRuntime,
  })
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 2,
        runtime: internalRuntime,
      }),
    /object id collision limit exceeded/,
  )
  assert.equal(ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES_RESERVED, 65_536)
  assert.equal(ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES_RESERVED, 65_532)
})

test('concurrent object preparation reserves each candidate before asynchronous collision checks', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const firstId = new Uint8Array(16).fill(10)
  const secondId = new Uint8Array(16).fill(11)
  const runtime = deterministicRuntime([
    firstId,
    firstId,
    secondId,
    new Uint8Array(12).fill(12),
    new Uint8Array(12).fill(13),
  ])
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const objectIdExists = async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await barrier
    return false
  }

  const [first, second] = await Promise.all([
    prepareEncryptedWalletBackupObject({
      keyHandle,
      chunk,
      generation: 1,
      runtime,
      objectIdExists,
    }),
    prepareEncryptedWalletBackupObject({
      keyHandle,
      chunk,
      generation: 2,
      runtime,
      objectIdExists,
    }),
  ])
  assert.equal(first.objectId, toHex(firstId))
  assert.equal(second.objectId, toHex(secondId))
  assert.notEqual(first.objectId, second.objectId)
})

test('a failed collision callback releases its synchronous object-id reservation', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const reusableId = new Uint8Array(16).fill(14)
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicRuntime([reusableId]),
        objectIdExists: () => {
          throw new Error('lookup failed')
        },
      }),
    /lookup failed/,
  )
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 2,
    runtime: deterministicRuntime([reusableId, new Uint8Array(12).fill(15)]),
  })
  assert.equal(prepared.objectId, toHex(reusableId))
})

test('a crypto failure releases its synchronous object-id reservation', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
  })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const chunk = packEncryptedWalletBackupProofChunk([proof])
  const reusableId = new Uint8Array(16).fill(16)
  const failingBase = deterministicRuntime([reusableId, new Uint8Array(12).fill(17)])
  const failingRuntime: EncryptedWalletBackupRuntime = {
    ...failingBase,
    subtle: new Proxy(webcrypto.subtle, {
      get(target, property) {
        if (property === 'encrypt')
          return async () => {
            throw new Error('encrypt failed')
          }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SubtleCrypto,
  }
  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: failingRuntime,
      }),
    /encrypt failed/,
  )
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: 2,
    runtime: deterministicRuntime([reusableId, new Uint8Array(12).fill(18)]),
  })
  assert.equal(prepared.objectId, toHex(reusableId))
})

test('decrypt rejects metadata, body, AAD, tamper, truncation, padding, and noncanonical CBOR generically', async () => {
  const runtime = deterministicRuntime([
    fromHex(vector.inputs.objectIdHex),
    fromHex(vector.inputs.nonceHex),
  ])
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: 'test',
    runtime,
  })
  const proof = await prepareEncryptedWalletBackupProof(proofInput(keyHandle))
  const prepared = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk: packEncryptedWalletBackupProofChunk([proof]),
    generation: 1,
    runtime,
    objectIdExists: () => false,
  })
  const wire = readPreparedEncryptedWalletBackupObject(prepared)
  const cases = [
    { ...wire, realm: 'test-2' },
    { ...wire, generation: 2 },
    { ...wire, objectId: 'ff'.repeat(16) },
    { ...wire, digest: 'ff'.repeat(32) },
    { ...wire, aad: wire.aad.slice(1) },
    { ...wire, body: wire.body.slice(1) },
    { ...wire, body: mutate(wire.body, 100) },
  ]
  for (const object of cases) {
    await assert.rejects(
      () =>
        decryptEncryptedWalletBackupProofChunk({
          keyHandle,
          seed: SEED,
          object,
        }),
      exactCorruptError,
    )
  }

  for (const malformed of [
    Uint8Array.of(0x9f, 0x01, 0x01, 0x80, 0xff),
    Uint8Array.of(0x83, 0x18, 0x01, 0x01, 0x80),
    Uint8Array.of(0xa0),
    Uint8Array.of(0xc0, 0x80),
    Uint8Array.of(0xf4),
    Uint8Array.of(0xf7),
    Uint8Array.of(0xfb, 0, 0, 0, 0, 0, 0, 0, 0),
    Uint8Array.of(0x20),
    Uint8Array.of(0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    concat(fromHex(vector.expected.canonicalCborHex), Uint8Array.of(0)),
    encodeDeepArray(20),
    encode(new Array(20_000).fill(0), rfc8949EncodeOptions),
  ]) {
    const object = await encryptRawFrame(malformed, 0)
    await assert.rejects(
      () =>
        decryptEncryptedWalletBackupProofChunk({
          keyHandle,
          seed: SEED,
          object,
        }),
      exactCorruptError,
    )
  }
  const nonzeroPadding = await encryptRawFrame(fromHex(vector.expected.canonicalCborHex), 1)
  await assert.rejects(
    () =>
      decryptEncryptedWalletBackupProofChunk({
        keyHandle,
        seed: SEED,
        object: nonzeroPadding,
      }),
    exactCorruptError,
  )

  const decoded = decode(fromHex(vector.expected.canonicalCborHex)) as unknown[]
  const records = decoded[2] as unknown[][]
  const oversizedMint = structuredClone(records[0]!)
  oversizedMint[2] = `https://mint.example/${'a'.repeat(2_048)}`
  assert.throws(
    () => preflightEncryptedProofChunkCbor(encode([1, 1, [oversizedMint]], rfc8949EncodeOptions)),
    /mint shape/,
  )
  const nullCtfRegistration = structuredClone(records[0]!)
  nullCtfRegistration[10] = 1
  nullCtfRegistration[11] = [
    new Uint8Array(32),
    'YES',
    new Uint8Array(32),
    null,
    1_800_000_000,
    null,
  ]
  assert.throws(
    () =>
      preflightEncryptedProofChunkCbor(encode([1, 1, [nullCtfRegistration]], rfc8949EncodeOptions)),
    /registration shape/,
  )
  for (const mutation of [
    (record: unknown[]) => {
      record[2] = 'https://other-mint.example'
    },
    (record: unknown[]) => {
      record[3] = 'usd'
    },
    (record: unknown[]) => {
      record[4] = [2, `01${'22'.repeat(32)}`]
    },
    (record: unknown[]) => {
      record[6] = new TextEncoder().encode('11'.repeat(32))
    },
    (record: unknown[]) => {
      record[0] = new Uint8Array(32).fill(9)
    },
    (record: unknown[]) => {
      record[1] = new Uint8Array(32).fill(9)
    },
  ]) {
    const changed = structuredClone(records[0]!)
    mutation(changed)
    const object = await encryptRawFrame(encode([1, 1, [changed]], rfc8949EncodeOptions), 0)
    await assert.rejects(
      () =>
        decryptEncryptedWalletBackupProofChunk({
          keyHandle,
          seed: SEED,
          object,
        }),
      exactCorruptError,
    )
  }
})

const exactCorruptError = (error: unknown) => {
  assert.equal((error as Error).message, 'corrupt encrypted wallet backup object')
  assert.equal((error as Error).message.includes(SECRET), false)
  return true
}

function proofInput(keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>) {
  const proof = vector.inputs.proof
  const input = {
    keyHandle,
    seed: SEED,
    mint: proof.mint,
    unit: proof.unit,
    counter: proof.counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret: SECRET,
      C: proof.signatureHex,
      dleq: { ...proof.dleq },
    },
    proofKind: 'ordinary' as const,
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: 1_700_000_000,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
  } satisfies UnboundProofInput
  return withProofStore(input)
}

function proofInputAtCounter(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  counter: number,
  revision = 1,
) {
  const base = proofInput(keyHandle)
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (index: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(SEED, base.proof.id)
  const input = {
    ...base,
    counter,
    proof: {
      ...base.proof,
      secret: toHex(derive(counter).secret),
    },
  } satisfies UnboundProofInput
  return withProofStore(input, null, { revision })
}

function proofInputForKeyset(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  keysetId: string,
) {
  const counter = 1
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (counter: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(SEED, keysetId)
  const input = {
    ...proofInput(keyHandle),
    counter,
    proof: {
      ...proofInput(keyHandle).proof,
      id: keysetId,
      secret: toHex(derive(counter).secret),
    },
  }
  return withProofStore(input)
}

function ctfProofInput(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
) {
  return {
    ...proofInputForKeyset(keyHandle, CTF_KEYSET_ID),
    proofKind: 'ctf' as const,
    ctfMetadata: {
      conditionId: CTF_CONDITIONAL_METADATA.conditionId,
      outcomeLabel: CTF_CONDITIONAL_METADATA.outcomeCollection,
      outcomeCollectionId: CTF_CONDITIONAL_METADATA.outcomeCollectionId,
      registeredAtUnixSeconds: CTF_CONDITIONAL_METADATA.registeredAt,
      finalExpiryUnixSeconds: CTF_MINT_KEYS.final_expiry,
    },
    effectiveNowUnixSeconds: 1_700_000_001,
  }
}

function withProofStore(
  input: UnboundProofInput,
  conditionalKeysetEvidence: VerifiedEncryptedWalletBackupConditionalKeyset | null = null,
  rowOverrides: Record<string, unknown> = {},
  terminalOperationId: string | null = null,
) {
  const keysetId = input.proof.id
  const keysetKind = /^(?:01|02)[0-9a-f]{64}$/.test(keysetId)
    ? 2
    : /^00[0-9a-f]{14}$/.test(keysetId)
      ? 1
      : 0
  const identityKeyset = keysetKind === 0 ? `legacy:${toHex(fromBase64(keysetId))}` : keysetId
  const proofId = deriveProofIdForTest(
    input.seed,
    input.mint,
    input.unit,
    identityKeyset,
    input.proof.secret,
  )
  const ctf =
    input.ctfMetadata === null
      ? null
      : [
          fromHex(input.ctfMetadata.conditionId),
          input.ctfMetadata.outcomeLabel,
          fromHex(input.ctfMetadata.outcomeCollectionId),
          input.ctfMetadata.registeredAtUnixSeconds,
          input.ctfMetadata.finalExpiryUnixSeconds,
          input.terminalEvidence === null
            ? null
            : [
                1,
                nobleSha256(new TextEncoder().encode(input.terminalEvidence.operationId)),
                nobleSha256(
                  encode(
                    [
                      1,
                      'ctf-terminal-rejection',
                      nobleSha256(new TextEncoder().encode(input.terminalEvidence.operationId)),
                      input.mint,
                      keysetId,
                      13015,
                    ],
                    rfc8949EncodeOptions,
                  ),
                ),
                input.terminalEvidence.rejectionBody.code,
                input.updatedAtUnixSeconds,
              ],
        ]
  const signature = fromHex(input.proof.C)
  const dleq =
    input.proof.dleq === undefined
      ? null
      : [fromHex(input.proof.dleq.e), fromHex(input.proof.dleq.s), fromHex(input.proof.dleq.r)]
  const commitment = toHex(
    nobleSha256(
      encode(
        [
          1,
          'proof-record-commitment',
          input.mint,
          input.unit,
          [keysetKind, keysetId],
          input.proof.amount,
          new TextEncoder().encode(input.proof.secret),
          signature,
          dleq,
          input.counter,
          input.proofKind === 'ordinary' ? 0 : 1,
          ctf,
          input.createdAtUnixSeconds,
          input.updatedAtUnixSeconds,
        ],
        rfc8949EncodeOptions,
      ),
    ),
  )
  const row = Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: 'test-snapshot',
    revision: 1,
    proofId,
    proofCommitment: commitment,
    proofKind: input.proofKind,
    ctfMetadata: input.ctfMetadata,
    terminalOperationId,
    conditionalKeysetEvidence,
    provenance: 'wallet-seed' as const,
    operationBinding: 'terminally-unlinked' as const,
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: {
      openOrderCollateral: 'absent' as const,
      outbox: 'absent' as const,
      retryCursor: 'absent' as const,
      replayTombstone: 'absent' as const,
      dependentWork: 'absent' as const,
    },
    derivationLocator: 'committed' as const,
    ...rowOverrides,
  })
  return {
    ...input,
    proofSnapshotStore: {
      async withCommittedProofSnapshot<T>(
        stableProofId: string,
        read: (value: typeof row) => T,
      ): Promise<T> {
        assert.equal(stableProofId, proofId)
        return read(row)
      },
    },
  }
}

function conditionalContext() {
  return {
    mint: vector.inputs.proof.mint,
    unit: 'sat',
    outcomeLabel: CTF_CONDITIONAL_METADATA.outcomeCollection,
    registeredAtUnixSeconds: CTF_CONDITIONAL_METADATA.registeredAt,
    mintKeys: CTF_MINT_KEYS,
    conditionalMetadata: CTF_CONDITIONAL_METADATA,
  }
}

function verifyConditionalEvidence(
  input: Parameters<typeof verifyEncryptedWalletBackupConditionalKeyset>[0],
) {
  return verifyEncryptedWalletBackupConditionalKeyset(input)
}

function verifiedConditionalEvidence() {
  return verifyConditionalEvidence(conditionalContext())
}

function deriveProofIdForTest(
  seed: Uint8Array,
  mint: string,
  unit: string,
  keysetId: string,
  secret: string,
): string {
  return deriveDurableCustodyProofId({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(seed),
    }),
    normalizedMint: mint,
    unit,
    keysetId,
    secret,
  })
}

function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const text = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

function deterministicRuntime(values: Uint8Array[]): EncryptedWalletBackupRuntime {
  let offset = 0
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      const value = values[offset++]
      if (value === undefined || value.byteLength !== target.byteLength) {
        throw new Error('unexpected random request')
      }
      target.set(value)
      return target
    },
  }
}

async function waitForArrayLength(values: readonly unknown[], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (values.length === expected) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`expected ${expected} concurrent calls, observed ${values.length}`)
}

function delayedSigningRuntimeForTest(): {
  runtime: EncryptedWalletBackupRuntime
  signingStarted: Promise<void>
  releaseSigning(): void
} {
  let releaseSigning!: () => void
  const signingGate = new Promise<void>((resolve) => {
    releaseSigning = resolve
  })
  let observeSigning!: () => void
  const signingStarted = new Promise<void>((resolve) => {
    observeSigning = resolve
  })
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      if (property === 'deriveBits') {
        return async (...args: Parameters<SubtleCrypto['deriveBits']>) => {
          observeSigning()
          await signingGate
          return target.deriveBits(...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SubtleCrypto
  return {
    runtime: {
      subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    signingStarted,
    releaseSigning,
  }
}

function acceptingSnapshotSealStore() {
  return {
    async sealCommittedBackupSnapshot<T>(expected: unknown, seal: (value: never) => T): Promise<T> {
      return seal(expected as never)
    },
  }
}

async function finalizeTargetUploadsForTest(input: {
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  targetHead: ReturnType<typeof prepareEncryptedWalletBackupManifestHead>
}) {
  const acknowledgedBundle = await acknowledgeTargetUploadsForTest({
    ...input,
    batchId: 'e1'.repeat(16),
    attemptId: 'e2'.repeat(16),
  })
  const finalized = await journalEncryptedWalletBackupCasHandoffForTest({
    keyHandle: input.keyHandle,
    claim: acknowledgedBundle.claim,
    store: acknowledgedBundle.store,
  })
  return { finalized, ...acknowledgedBundle }
}

async function acknowledgeTargetUploadsForTest(input: {
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  targetHead: ReturnType<typeof prepareEncryptedWalletBackupManifestHead>
  batchId: string
  attemptId: string
  batchIndex?: number
  store?: ReturnType<typeof inMemoryUploadBatchStore>
  claim?: Awaited<ReturnType<typeof uploadAttemptClaimForTest>>
}) {
  const store = input.store ?? inMemoryUploadBatchStore()
  const claim =
    input.claim ??
    (await uploadAttemptClaimForTest(input.keyHandle, input.targetHead, store, input.attemptId))
  const batch = await sealEncryptedWalletBackupUploadBatch({
    batchId: input.batchId,
    claim,
    keyHandle: input.keyHandle,
    plannedBatch: plannedUploadBatchForTest(
      input.keyHandle,
      input.targetHead,
      claim.record.attemptId,
      input.batchIndex ?? 0,
    ),
    store,
  })
  const acknowledged = await uploadEncryptedWalletBackupBatch({
    batch,
    claim,
    store,
    keyHandle: input.keyHandle,
    enrollmentEpoch: 1,
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    runtime: {
      subtle: webcrypto.subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    objectUrl: (objectId) => `https://backup.example.test/v1/vault/objects/${objectId}`,
    remote: {
      async putObject() {
        return { status: 'stored' as const }
      },
    },
  })
  return { acknowledged, claim, store, batchId: batch.record.batchId }
}

async function uploadAttemptClaimForTest(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  targetHead: ReturnType<typeof prepareEncryptedWalletBackupManifestHead>,
  store: ReturnType<typeof inMemoryUploadBatchStore>,
  attemptId: string,
) {
  return sealEncryptedWalletBackupUploadAttempt({
    attemptId,
    ownerId: 'test-owner',
    leaseDurationMilliseconds: 60_000,
    keyHandle,
    targetHead,
    store,
  })
}

function plannedUploadBatchForTest(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  targetHead: ReturnType<typeof prepareEncryptedWalletBackupManifestHead>,
  attemptId: string,
  batchIndex = 0,
) {
  const plan = prepareEncryptedWalletBackupUploadPlan({
    attemptId,
    keyHandle,
    targetHead,
  })
  const batch = plan.batches[batchIndex]
  if (batch === undefined) throw new Error('test target has no upload batch')
  return batch
}

function preparedPutPayloadLengthForTest(
  attemptId: string,
  prepared: Awaited<ReturnType<typeof prepareEncryptedWalletBackupObject>>,
): number {
  const object = readPreparedEncryptedWalletBackupObject(prepared)
  return encode(
    [
      1,
      'object-put',
      fromHex(attemptId),
      object.kindCode,
      object.realm,
      fromHex(object.vaultId),
      fromHex(object.objectId),
      object.generation,
      object.paddedLength,
      fromHex(object.digest),
      object.aad,
      object.body,
    ],
    rfc8949EncodeOptions,
  ).byteLength
}

function uploadBatchReadSubstitutionStore(
  base: ReturnType<typeof inMemoryUploadBatchStore>,
  record: EncryptedWalletBackupUploadBatchRecord,
) {
  return {
    ...base,
    async readUploadBatch<T>(_batchId: string, read: (value: never) => T): Promise<T> {
      return read(structuredClone(record) as never)
    },
  }
}

function rewriteUploadBatchTargetReferenceCounts(
  source: EncryptedWalletBackupUploadBatchRecord,
  pageCount: number,
  chunkCount: number,
): EncryptedWalletBackupUploadBatchRecord {
  const record = structuredClone(source)
  const head = decode(record.canonicalTargetHead) as unknown[]
  const referenceSet = decode(record.canonicalTargetReferenceSet) as unknown[]
  const pageReferences = structuredClone(referenceSet[2] as unknown[][])
  const chunkReferences = structuredClone(referenceSet[3] as unknown[][])
  const ids = new Set(
    [...pageReferences, ...chunkReferences].map((reference) => toHex(reference[0] as Uint8Array)),
  )
  const digests = new Set(
    [...pageReferences, ...chunkReferences].map((reference) => toHex(reference[1] as Uint8Array)),
  )
  const appendReferences = (references: unknown[][], requiredCount: number, domain: number) => {
    let index = 1
    while (references.length < requiredCount) {
      const objectId = indexedReferenceBytes(domain, index, 16)
      const digest = indexedReferenceBytes(domain + 64, index, 32)
      index += 1
      if (ids.has(toHex(objectId)) || digests.has(toHex(digest))) continue
      ids.add(toHex(objectId))
      digests.add(toHex(digest))
      references.push([objectId, digest])
    }
  }
  appendReferences(pageReferences, pageCount, 1)
  appendReferences(chunkReferences, chunkCount, 2)
  chunkReferences.sort((left, right) =>
    compareLowerHex(toHex(left[0] as Uint8Array), toHex(right[0] as Uint8Array)),
  )
  const canonicalReferenceSet = encode(
    [1, 'reference-set', pageReferences, chunkReferences],
    rfc8949EncodeOptions,
  )
  head[8] = pageReferences
  head[9] = chunkReferences
  head[10] = chunkCount
  head[11] =
    pageCount * BackupModule.ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES +
    chunkCount * BackupModule.ENCRYPTED_WALLET_BACKUP_BODY_BYTES
  head[12] = nobleSha256(canonicalReferenceSet)
  const canonicalHead = encode(head, rfc8949EncodeOptions)
  record.canonicalTargetHead = canonicalHead
  record.canonicalTargetReferenceSet = canonicalReferenceSet
  record.targetManifestDigest = toHex(nobleSha256(canonicalHead))
  return record
}

function indexedReferenceBytes(domain: number, index: number, length: number): Uint8Array {
  const result = new Uint8Array(length)
  result[0] = domain
  new DataView(result.buffer).setUint32(length - 4, index, false)
  return result
}

async function createMultiBatchTargetForTest(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
) {
  const proofs = await Promise.all(
    Array.from({ length: 17 }, (_, index) =>
      prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, 100 + index)),
    ),
  )
  const chunks = proofs.map((proof) => packEncryptedWalletBackupProofChunk([proof]))
  const objects = await Promise.all(
    chunks.map((chunk, index) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicRuntime([
          new Uint8Array(16).fill(130 + index),
          new Uint8Array(12).fill(160 + index),
        ]),
      }),
    ),
  )
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(190),
    chunks: chunks.map((chunk, index) => ({
      chunk,
      object: objects[index]!,
    })),
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(191), new Uint8Array(12).fill(192)]),
  })
  return {
    head: prepareEncryptedWalletBackupManifestHead({
      keyHandle,
      manifest,
      parent: null,
    }),
    objects: [...manifest.pages, ...objects],
  }
}

async function createSealedUploadMutationFixtureForTest(suffix: string) {
  const fixture = await createManifestUploadFixtureForTest()
  const store = inMemoryUploadBatchStore()
  const attemptId = suffix.repeat(16)
  const claim = await uploadAttemptClaimForTest(fixture.keyHandle, fixture.head, store, attemptId)
  const batch = await sealEncryptedWalletBackupUploadBatch({
    batchId: `${suffix[1]}${suffix[0]}`.repeat(16),
    claim,
    keyHandle: fixture.keyHandle,
    plannedBatch: plannedUploadBatchForTest(fixture.keyHandle, fixture.head, attemptId),
    store,
  })
  return { ...fixture, store, claim, batch }
}

async function createManifestUploadFixtureForTest() {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
  })
  const proofs = await Promise.all(
    [0, 1, 2, 3].map((counter) =>
      prepareEncryptedWalletBackupProof(proofInputAtCounter(keyHandle, counter)),
    ),
  )
  const sorted = [...proofs].sort((left, right) => compareLowerHex(left.proofId, right.proofId))
  const chunks = [
    packEncryptedWalletBackupProofChunk([sorted[0]!, sorted[2]!]),
    packEncryptedWalletBackupProofChunk([sorted[1]!, sorted[3]!]),
  ]
  const chunkObjects = await Promise.all(
    chunks.map((chunk, index) =>
      prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicRuntime([
          new Uint8Array(16).fill(index + 1),
          new Uint8Array(12).fill(index + 11),
        ]),
      }),
    ),
  )
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: new Uint8Array(16).fill(33),
    chunks: chunks.map((chunk, index) => ({
      chunk,
      object: chunkObjects[index]!,
    })),
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(21), new Uint8Array(12).fill(31)]),
  })
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  })
  const headWire = readPreparedEncryptedWalletBackupManifestHead(head)
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(81), new Uint8Array(32).fill(82)]),
  })
  const authenticated = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: structuredClone(headWire),
        }
      },
    },
  })
  const page = await decryptEncryptedWalletBackupManifestPage({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(manifest.pages[0]!),
    headEvidence: authenticated,
  })
  return {
    keyHandle,
    proofs,
    sorted,
    chunks,
    chunkObjects,
    manifest,
    head,
    headWire,
    headRequest: requestProof,
    authenticated,
    page,
  }
}

async function createVerifiableRestoreFixtureForTest(
  options: {
    ctf?: boolean
    invalidSignature?: boolean
    count?: number
    prepareAtOrAfterExpiry?: boolean
    verifiedLosing?: boolean
    verifiedLosingCounter?: number
    cloneTerminalEvidence?: boolean
    generationTwoFromActive?: boolean
  } = {},
) {
  const cashu = Cashu as unknown as {
    blindMessageBls(secret: Uint8Array, r: bigint): { B_: unknown }
    createBlindSignatureBls(
      blinded: unknown,
      privateKey: Uint8Array,
      keysetId: string,
    ): { C_: unknown }
    unblindSignatureBls(signature: unknown, r: bigint): { toBytes(compressed: boolean): Uint8Array }
    getG2PubKeyFromPrivKey(privateKey: Uint8Array): Uint8Array
    getPubKeyFromPrivKey(privateKey: Uint8Array): Uint8Array
    pointFromBytes(bytes: Uint8Array): unknown
    blindMessage(secret: Uint8Array, r: bigint): { B_: unknown }
    createDLEQProof(blinded: unknown, privateKey: Uint8Array): { e: Uint8Array; s: Uint8Array }
    createBlindSignature(blinded: unknown, privateKey: Uint8Array, keysetId: string): unknown
    constructUnblindedSignature(
      blindSignature: unknown,
      r: bigint,
      secret: Uint8Array,
      publicKey: unknown,
    ): { C: { toHex(compressed: boolean): string } }
    hashToCurve(secret: Uint8Array): {
      multiply(scalar: bigint): { toHex(compressed: boolean): string }
    }
    deriveKeysetId(
      keys: Record<string, string>,
      options: { unit: string; versionByte: number },
    ): string
    deriveConditionalKeysetId(input: {
      keys: Record<string, string>
      unit: string
      final_expiry: number
      conditionId: string
      outcomeCollectionId: string
    }): string
    createSecretAndBlindingFactorDeriver(
      seed: Uint8Array,
      keyset: string,
    ): (counter: number) => { secret: Uint8Array }
  }
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: options.ctf ? 'restore-ctf' : 'restore-ordinary',
  })
  const mint = 'https://restore-mint.example'
  const privateKey = new Uint8Array(32)
  privateKey[31] = 2
  const conditionId = 'ab'.repeat(32)
  const outcomeCollectionId = 'cd'.repeat(32)
  const finalExpiry = 1_700_001_000
  let keysetId: string
  let mintKeys: Record<string, unknown>
  if (options.ctf) {
    const keys = { 1: toHex(cashu.getPubKeyFromPrivKey(privateKey)) }
    keysetId = cashu.deriveConditionalKeysetId({
      keys,
      unit: 'sat',
      final_expiry: finalExpiry,
      conditionId,
      outcomeCollectionId,
    })
    mintKeys = {
      id: keysetId,
      unit: 'sat',
      active: true,
      input_fee_ppk: 0,
      final_expiry: finalExpiry,
      keys,
      conditional: {
        conditionId,
        outcomeCollection: 'YES',
        outcomeCollectionId,
        registeredAt: 1_700_000_000,
      },
    }
  } else {
    const keys = { 1: toHex(cashu.getG2PubKeyFromPrivKey(privateKey)) }
    keysetId = cashu.deriveKeysetId(keys, {
      unit: 'sat',
      versionByte: 2,
    })
    mintKeys = { id: keysetId, unit: 'sat', keys }
  }
  const count = options.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 256)
    throw new Error('restore fixture count is invalid')
  const ctfMetadata = options.ctf
    ? {
        conditionId,
        outcomeLabel: 'YES',
        outcomeCollectionId,
        registeredAtUnixSeconds: 1_700_000_000,
        finalExpiryUnixSeconds: finalExpiry,
      }
    : null
  const conditionalEvidence = options.ctf
    ? verifyEncryptedWalletBackupConditionalKeyset({
        mint,
        unit: 'sat',
        outcomeLabel: 'YES',
        registeredAtUnixSeconds: 1_700_000_000,
        mintKeys,
        conditionalMetadata: mintKeys.conditional,
      })
    : null
  const preparedProofs = []
  const activePreparedProofs = []
  const secretsByProofId = new Map<string, string>()
  const deriveSecret = cashu.createSecretAndBlindingFactorDeriver(SEED, keysetId)
  for (let counter = 0; counter < count; counter += 1) {
    const secret = toHex(deriveSecret(counter).secret)
    const secretBytes = new TextEncoder().encode(secret)
    const r = 7n + BigInt(counter)
    let signature: string
    let dleq: { e: string; s: string; r: string } | undefined
    if (options.ctf) {
      const blinded = cashu.blindMessage(secretBytes, r)
      const proof = cashu.createDLEQProof(blinded.B_, privateKey)
      const blindSignature = cashu.createBlindSignature(blinded.B_, privateKey, keysetId)
      signature = cashu
        .constructUnblindedSignature(
          blindSignature,
          r,
          secretBytes,
          cashu.pointFromBytes(cashu.getPubKeyFromPrivKey(privateKey)),
        )
        .C.toHex(true)
      dleq = {
        e: toHex(proof.e),
        s: toHex(proof.s),
        r: r.toString(16).padStart(64, '0'),
      }
    } else {
      const blinded = cashu.blindMessageBls(secretBytes, r)
      const blindSignature = cashu.createBlindSignatureBls(blinded.B_, privateKey, keysetId)
      signature = toHex(cashu.unblindSignatureBls(blindSignature.C_, r).toBytes(true))
    }
    if (options.invalidSignature && counter === 0) signature = 'aa'.repeat(48)
    const unboundBase = {
      keyHandle,
      seed: SEED,
      mint,
      unit: 'sat',
      counter,
      proof: {
        id: keysetId,
        amount: '1',
        secret,
        C: signature,
        ...(dleq === undefined ? {} : { dleq }),
      },
      proofKind: options.ctf ? ('ctf' as const) : ('ordinary' as const),
      ctfMetadata,
      terminalEvidence: null,
      effectiveNowUnixSeconds: options.prepareAtOrAfterExpiry ? finalExpiry : 1_700_000_001,
      createdAtUnixSeconds: 1_700_000_001,
      updatedAtUnixSeconds: 1_700_000_001,
    } satisfies UnboundProofInput
    const terminal =
      options.verifiedLosing || options.verifiedLosingCounter === counter
        ? await createVerifiedLosingEvidenceForTest({
            mint,
            conditionId,
            outcome: 'YES',
            keysetId,
            proof: unboundBase.proof,
            cashu,
            privateKey,
          })
        : null
    const terminalEvidence = terminal?.evidence ?? null
    if (options.generationTwoFromActive) {
      if (terminal === null) {
        throw new Error('generation-two fixture requires terminal evidence')
      }
      activePreparedProofs.push(
        await prepareEncryptedWalletBackupProof(withProofStore(unboundBase, conditionalEvidence)),
      )
    }
    const unbound = {
      ...unboundBase,
      terminalEvidence:
        terminalEvidence !== null && options.cloneTerminalEvidence
          ? { ...terminalEvidence }
          : terminalEvidence,
    }
    const preparedProof = await prepareEncryptedWalletBackupProof(
      withProofStore(unbound, conditionalEvidence, {}, terminal?.operationId ?? null),
    )
    preparedProofs.push(preparedProof)
    secretsByProofId.set(preparedProof.proofId, secret)
  }
  preparedProofs.sort((left, right) => compareLowerHex(left.proofId, right.proofId))
  activePreparedProofs.sort((left, right) => compareLowerHex(left.proofId, right.proofId))
  const prepared = preparedProofs[0]!
  const secret = secretsByProofId.get(prepared.proofId)!
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: 'https://backup.example.test/v1/vault/head',
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(206), new Uint8Array(32).fill(207)]),
  })
  const chunk = packEncryptedWalletBackupProofChunk(preparedProofs)
  const chunkObject = await prepareEncryptedWalletBackupObject({
    keyHandle,
    chunk,
    generation: options.generationTwoFromActive ? 2 : 1,
    runtime: deterministicRuntime([new Uint8Array(16).fill(201), new Uint8Array(12).fill(202)]),
  })
  let manifest
  let head
  if (options.generationTwoFromActive) {
    const activeChunk = packEncryptedWalletBackupProofChunk(activePreparedProofs)
    const activeChunkObject = await prepareEncryptedWalletBackupObject({
      keyHandle,
      chunk: activeChunk,
      generation: 1,
      runtime: deterministicRuntime([new Uint8Array(16).fill(208), new Uint8Array(12).fill(209)]),
    })
    const activeManifest = await prepareEncryptedWalletBackupManifest({
      keyHandle,
      generation: 1,
      snapshotNonce: new Uint8Array(16).fill(210),
      chunks: [{ chunk: activeChunk, object: activeChunkObject }],
      snapshotStore: acceptingSnapshotSealStore(),
      runtime: deterministicRuntime([new Uint8Array(16).fill(211), new Uint8Array(12).fill(212)]),
    })
    const activeHead = prepareEncryptedWalletBackupManifestHead({
      keyHandle,
      manifest: activeManifest,
      parent: null,
    })
    const activeHeadWire = readPreparedEncryptedWalletBackupManifestHead(activeHead)
    const activeAuthenticated = await readAuthenticatedEncryptedWalletBackupHead({
      keyHandle,
      enrollmentEpoch: 1,
      requestProof,
      remote: {
        async readCurrentHead() {
          return {
            status: 'found' as const,
            enrollmentEpoch: 1,
            head: structuredClone(activeHeadWire),
          }
        },
      },
    })
    const activePages = []
    for (const pageObject of activeManifest.pages) {
      activePages.push(
        await decryptEncryptedWalletBackupManifestPage({
          keyHandle,
          seed: SEED,
          object: readPreparedEncryptedWalletBackupObject(pageObject),
          headEvidence: activeAuthenticated,
        }),
      )
    }
    manifest = await prepareIncrementalEncryptedWalletBackupManifest({
      keyHandle,
      generation: 2,
      snapshotNonce: new Uint8Array(16).fill(203),
      parentEvidence: activeAuthenticated,
      parentPages: activePages,
      chunks: [{ chunk, object: chunkObject }],
      removedProofIds: [],
      snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
      snapshotStore: acceptingSnapshotSealStore(),
      runtime: deterministicRuntime([new Uint8Array(16).fill(204), new Uint8Array(12).fill(205)]),
    })
    head = prepareEncryptedWalletBackupManifestHead({
      keyHandle,
      manifest,
      parent: activeAuthenticated.head,
    })
  } else {
    manifest = await prepareEncryptedWalletBackupManifest({
      keyHandle,
      generation: 1,
      snapshotNonce: new Uint8Array(16).fill(203),
      chunks: [{ chunk, object: chunkObject }],
      snapshotStore: acceptingSnapshotSealStore(),
      runtime: deterministicRuntime([new Uint8Array(16).fill(204), new Uint8Array(12).fill(205)]),
    })
    head = prepareEncryptedWalletBackupManifestHead({
      keyHandle,
      manifest,
      parent: null,
    })
  }
  const headWire = readPreparedEncryptedWalletBackupManifestHead(head)
  const authenticated = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: structuredClone(headWire),
        }
      },
    },
  })
  const pages = []
  for (const pageObject of manifest.pages) {
    pages.push(
      await decryptEncryptedWalletBackupManifestPage({
        keyHandle,
        seed: SEED,
        object: readPreparedEncryptedWalletBackupObject(pageObject),
        headEvidence: authenticated,
      }),
    )
  }
  const page = pages[0]!
  const decryptedChunk = await decryptEncryptedWalletBackupProofChunk({
    keyHandle,
    seed: SEED,
    object: readPreparedEncryptedWalletBackupObject(chunkObject),
  })
  return {
    keyHandle,
    mint,
    keysetId,
    mintKeys,
    finalExpiry,
    secret,
    prepared,
    preparedProofs,
    authenticated,
    page,
    pages,
    decryptedChunk,
  }
}

async function createVerifiedLosingEvidenceForTest(input: {
  mint: string
  conditionId: string
  outcome: string
  keysetId: string
  proof: {
    id: string
    amount: string
    secret: string
    C: string
    dleq?: { e: string; s: string; r: string }
  }
  cashu: {
    getG2PubKeyFromPrivKey(privateKey: Uint8Array): Uint8Array
    deriveKeysetId(
      keys: Record<string, string>,
      options: { unit: string; versionByte: number },
    ): string
  }
  privateKey: Uint8Array
}) {
  let record: CtfProofOperationRecord | null = null
  const store: CtfProofOperationStore = {
    async getProofOperation(operationId) {
      return record?.operationId === operationId ? record : null
    },
    async prepareProofOperation(prepared: CtfPrepareProofOperationInput) {
      record = {
        ...prepared,
        metadata: prepared.metadata ?? {},
        state: 'prepared',
        createdAt: 1,
        updatedAt: 1,
      }
      return record
    },
    async markProofOperationMintSubmitted(_operationId, redeemBinding) {
      record = {
        ...record!,
        state: 'mint-submitted',
        metadata:
          redeemBinding === undefined
            ? record!.metadata
            : {
                ...record!.metadata,
                redeemMintSubmissionVersion: redeemBinding.schemaVersion,
                redeemMintSubmissionRequestDigest: redeemBinding.requestDigest,
              },
        updatedAt: 2,
      }
      return record
    },
    async markProofOperationCompleted(_operationId, resultProofs) {
      record = {
        ...record!,
        state: 'completed',
        resultProofs,
        updatedAt: 3,
      }
      return record
    },
    async markProofOperationFailed(_operationId, lastError) {
      record = {
        ...record!,
        state: 'Failed',
        lastError,
        failureCode: 13_015,
        updatedAt: 3,
      }
      return record
    },
  }
  const regularKeys = {
    1: toHex(input.cashu.getG2PubKeyFromPrivKey(input.privateKey)),
  }
  const regularKeyset = {
    id: input.cashu.deriveKeysetId(regularKeys, {
      unit: 'sat',
      versionByte: 2,
    }),
    unit: 'sat',
    active: true,
    input_fee_ppk: 0,
    keys: regularKeys,
  }
  const outcomeKeyset = {
    ...regularKeyset,
    id: input.keysetId,
    final_expiry: 1_754_296_607,
  }
  const operationId = `losing:${input.proof.secret}`
  await redeemOutcomeLegWithOperation({
    mintUrl: input.mint,
    operationId,
    wallet: {
      mint: {
        mintUrl: input.mint,
        async getKeys(keysetId?: string) {
          return {
            keysets: [keysetId === input.keysetId ? outcomeKeyset : regularKeyset] as never[],
          }
        },
      },
      async loadMint() {},
      async redeemOutcomeProofs() {
        throw { code: 13_015 }
      },
    },
    proofOperationStore: store,
    conditionId: input.conditionId,
    outcome: input.outcome,
    outcomeKeysetId: input.keysetId,
    unit: 'sat',
    oracleWitness: '{"attested":true}',
    proofs: [{ ...input.proof, amount: 1 } as never],
    regularKeyset: regularKeyset as never,
  })
  return {
    operationId,
    evidence: await readVerifiedCtfLosingOutcomeEvidence({
      store: {
        async withCommittedProofOperation<T>(requestedId, read) {
          assert.equal(requestedId, operationId)
          return read(structuredClone(record!))
        },
      },
      operationId,
      proof: input.proof,
    }),
  }
}

function absentRestoreCurrentStates(expected: readonly Readonly<{ proofId: string }>[]) {
  return expected.map((row) => ({
    proofId: row.proofId,
    storageClassification: null,
    proof: null,
  }))
}

function activePredecessorRestoreState(
  candidate: EncryptedWalletBackupRestoreProofRow,
  backupPublicKey: string,
) {
  assert.notEqual(candidate.proof.parentGeneration, null)
  assert.notEqual(candidate.proof.parentManifestDigest, null)
  assert.notEqual(candidate.proof.ctfMetadata, null)
  const keysetId = candidate.proof.proof.id
  const keysetKind = /^(?:01|02)[0-9a-f]{64}$/.test(keysetId)
    ? 2
    : /^00[0-9a-f]{14}$/.test(keysetId)
      ? 1
      : 0
  const metadata = candidate.proof.ctfMetadata!
  const dleq = candidate.proof.proof.dleq
  const proofWithoutCommitment = {
    ...candidate.proof,
    generation: candidate.proof.parentGeneration!,
    manifestDigest: candidate.proof.parentManifestDigest!,
    parentGeneration: null,
    parentManifestDigest: null,
    chunkObjectId: 'ee'.repeat(16),
    chunkDigest: 'cc'.repeat(32),
    terminalEvidence: null,
    disposition: 'selectable' as const,
    nonselectableReason: null,
  }
  const oldCommitment = toHex(
    nobleSha256(
      encode(
        [
          1,
          'proof-record-commitment',
          proofWithoutCommitment.mint,
          proofWithoutCommitment.unit,
          [keysetKind, keysetId],
          proofWithoutCommitment.proof.amount,
          new TextEncoder().encode(proofWithoutCommitment.proof.secret),
          fromHex(proofWithoutCommitment.proof.C),
          dleq === undefined ? null : [fromHex(dleq.e), fromHex(dleq.s), fromHex(dleq.r)],
          proofWithoutCommitment.counter,
          1,
          [
            fromHex(metadata.conditionId),
            metadata.outcomeLabel,
            fromHex(metadata.outcomeCollectionId),
            metadata.registeredAtUnixSeconds,
            metadata.finalExpiryUnixSeconds,
            null,
          ],
          proofWithoutCommitment.createdAtUnixSeconds,
          proofWithoutCommitment.updatedAtUnixSeconds,
        ],
        rfc8949EncodeOptions,
      ),
    ),
  )
  return {
    proofId: candidate.proofId,
    storageClassification: {
      ...candidate.storageClassification,
      storageClass: 'remotely-backed-deterministic-proof' as const,
      proofCommitment: oldCommitment,
      backupBinding: {
        snapshotId: deriveDurableWalletBackupSnapshotId({
          formatVersion: 1,
          realm: proofWithoutCommitment.realm,
          backupPublicKey,
          generation: proofWithoutCommitment.generation,
          manifestDigest: proofWithoutCommitment.manifestDigest,
        }),
        chunkDigest: proofWithoutCommitment.chunkDigest,
        proofCommitment: oldCommitment,
      },
    },
    proof: { ...proofWithoutCommitment, proofCommitment: oldCommitment },
  }
}

async function createCasRecoveryFixtureForTest() {
  const fixture = await createManifestUploadFixtureForTest()
  const nextManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle: fixture.keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(83),
    parentEvidence: fixture.authenticated,
    parentPages: [fixture.page],
    chunks: [],
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(84), new Uint8Array(12).fill(85)]),
  })
  const nextHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle: fixture.keyHandle,
    manifest: nextManifest,
    parent: fixture.authenticated.head,
  })
  const targetObservation = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: fixture.keyHandle,
    enrollmentEpoch: 1,
    requestProof: fixture.headRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(nextHead),
        }
      },
    },
  })
  const foreignManifest = await prepareIncrementalEncryptedWalletBackupManifest({
    keyHandle: fixture.keyHandle,
    generation: 2,
    snapshotNonce: new Uint8Array(16).fill(86),
    parentEvidence: fixture.authenticated,
    parentPages: [fixture.page],
    chunks: [],
    removedProofIds: [],
    snapshot: { snapshotId: 'test-snapshot', snapshotRevision: 1 },
    snapshotStore: acceptingSnapshotSealStore(),
    runtime: deterministicRuntime([new Uint8Array(16).fill(87), new Uint8Array(12).fill(88)]),
  })
  const foreignHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle: fixture.keyHandle,
    manifest: foreignManifest,
    parent: fixture.authenticated.head,
  })
  const foreignObservation = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: fixture.keyHandle,
    enrollmentEpoch: 1,
    requestProof: fixture.headRequest,
    remote: {
      async readCurrentHead() {
        return {
          status: 'found' as const,
          enrollmentEpoch: 1,
          head: readPreparedEncryptedWalletBackupManifestHead(foreignHead),
        }
      },
    },
  })
  const finalizedBundle = await finalizeTargetUploadsForTest({
    keyHandle: fixture.keyHandle,
    targetHead: nextHead,
  })
  return {
    ...fixture,
    nextHead,
    targetObservation,
    foreignObservation,
    finalizedBundle,
    finalizedNextUploads: finalizedBundle.finalized,
  }
}

async function createRejectedCasFixtureForTest() {
  const fixture = await createCasRecoveryFixtureForTest()
  const uncertain = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: fixture.finalizedNextUploads.casAttempt,
    event: { type: 'cas-dispatched' },
  })
  const rejected = await advanceEncryptedWalletBackupSyncAttempt({
    attempt: uncertain,
    event: { type: 'head-observed', observation: fixture.foreignObservation },
  })
  return { ...fixture, rejected }
}

function assertExactPersistedRecord(actual: unknown, expected: unknown, boundary: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${boundary} changed the persisted record`)
  }
}

function inMemoryUploadBatchStore() {
  const batches = new Map<string, Record<string, unknown>>()
  const attempts = new Map<string, Record<string, unknown>>()
  const casAttempts = new Map<string, Record<string, unknown>>()
  let databaseNow = 1_700_000_000_000
  const partition = (attemptId: unknown, targetManifestDigest: unknown) =>
    [...batches.values()].filter(
      (record) =>
        record.attemptId === attemptId && record.targetManifestDigest === targetManifestDigest,
    )
  return {
    setNowUnixMilliseconds(value: number) {
      databaseNow = value
    },
    async sealActiveUploadAttempt<T>(
      candidate: Record<string, unknown>,
      lease: number,
      seal: (value: never) => T,
    ): Promise<T> {
      if (
        [...attempts.values()].some(
          (value) =>
            value.realm === candidate.realm &&
            value.vaultId === candidate.vaultId &&
            value.lifecycle !== 'abandoned' &&
            value.lifecycle !== 'complete',
        )
      ) {
        throw new Error('live backup upload attempt already exists')
      }
      const record = {
        ...structuredClone(candidate),
        ownerEpoch: 1,
        leaseExpiresAtUnixMilliseconds: databaseNow + lease,
        batchIds: [],
        activeBatchId: null,
        casAttemptId: null,
        lifecycle: 'active',
      }
      const attemptId = String(record.attemptId)
      attempts.set(attemptId, record)
      try {
        return seal(structuredClone(record) as never)
      } catch (error) {
        attempts.delete(attemptId)
        throw error
      }
    },
    async claimActiveUploadAttempt<T>(
      query: Record<string, unknown>,
      claim: (value: never) => T,
    ): Promise<T> {
      const eligible = [...attempts.values()].filter(
        (record) =>
          record.realm === query.realm &&
          record.vaultId === query.vaultId &&
          ['active', 'abort-uncertain', 'cas-journaled', 'fork-cleanup-uncertain'].includes(
            String(record.lifecycle),
          ),
      )
      if (eligible.length > 1) throw new Error('multiple live backup upload attempts')
      const record = eligible[0]
      if (
        record === undefined ||
        (record.ownerId !== query.ownerId &&
          databaseNow < Number(record.leaseExpiresAtUnixMilliseconds))
      ) {
        return claim(null as never)
      }
      const before = structuredClone(record)
      record.ownerEpoch = Number(record.ownerEpoch) + 1
      record.ownerId = query.ownerId
      record.leaseExpiresAtUnixMilliseconds = databaseNow + Number(query.leaseDurationMilliseconds)
      try {
        return claim(structuredClone(record) as never)
      } catch (error) {
        attempts.set(String(before.attemptId), before)
        throw error
      }
    },
    async validateUploadAttemptClaim<T>(
      claimRecord: Record<string, unknown>,
      read: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, [
        'active',
        'abort-uncertain',
        'cas-journaled',
        'fork-cleanup-uncertain',
      ])
      return read(structuredClone(attempts.get(String(claimRecord.attemptId))) as never)
    },
    async sealUploadBatch<T>(
      claimRecord: Record<string, unknown>,
      batch: Record<string, unknown>,
      seal: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['active'])
      const existing = batches.get(String(batch.batchId))
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, batch)) {
          throw new Error('backup upload batch id conflicts with different content')
        }
        return seal({
          attempt: structuredClone(attempts.get(String(batch.attemptId))),
          batch: structuredClone(existing),
        } as never)
      }
      const attempt = attempts.get(String(batch.attemptId))!
      if (attempt.activeBatchId !== null)
        throw new Error('backup upload foreground batch is active')
      if (
        partition(batch.attemptId, batch.targetManifestDigest).some((record) =>
          ['abort-uncertain', 'finalized', 'abandoned'].includes(String(record.state)),
        )
      ) {
        throw new Error('backup upload attempt is fenced')
      }
      const existingItems = partition(batch.attemptId, batch.targetManifestDigest).flatMap(
        (record) => record.items as Array<{ objectId: string; objectDigest: string }>,
      )
      for (const item of batch.items as Array<{
        objectId: string
        objectDigest: string
      }>) {
        if (
          existingItems.some(
            (value) => value.objectId === item.objectId || value.objectDigest === item.objectDigest,
          )
        )
          throw new Error('backup attempt object is duplicated')
      }
      const copy = structuredClone(batch)
      const beforeAttempt = structuredClone(attempt)
      batches.set(String(copy.batchId), copy)
      attempt.batchIds = [...(attempt.batchIds as string[]), String(copy.batchId)]
      attempt.activeBatchId = String(copy.batchId)
      try {
        return seal({
          attempt: structuredClone(attempt),
          batch: structuredClone(copy),
        } as never)
      } catch (error) {
        batches.delete(String(copy.batchId))
        attempts.set(String(beforeAttempt.attemptId), beforeAttempt)
        throw error
      }
    },
    async readUploadBatch<T>(batchId: string, read: (value: never) => T): Promise<T> {
      const batch = batches.get(batchId)
      if (batch === undefined) throw new Error('missing upload batch')
      return read(structuredClone(batch) as never)
    },
    async claimUploadBatchExecution<T>(
      claimRecord: Record<string, unknown>,
      batch: Record<string, unknown>,
      lease: number,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['active'])
      const current = batches.get(String(batch.batchId))!
      assertExactPersistedRecord(current, batch, 'backup upload execution claim')
      if (current.state !== 'sealed' && current.state !== 'put-uncertain')
        throw new Error('backup upload batch is not executable')
      if (
        current.executionLeaseExpiresAtUnixMilliseconds !== null &&
        databaseNow < Number(current.executionLeaseExpiresAtUnixMilliseconds)
      ) {
        throw new Error('backup upload execution lease is active')
      }
      const before = structuredClone(current)
      const next = {
        ...structuredClone(current),
        state: 'put-uncertain',
        executionEpoch: Number(current.executionEpoch) + 1,
        executionLeaseExpiresAtUnixMilliseconds: databaseNow + lease,
      }
      batches.set(String(next.batchId), next)
      try {
        return commit({
          attempt: structuredClone(attempts.get(String(claimRecord.attemptId))),
          batch: structuredClone(next),
        } as never)
      } catch (error) {
        batches.set(String(before.batchId), before)
        throw error
      }
    },
    async validateUploadBatchExecution<T>(
      claimRecord: Record<string, unknown>,
      batch: Record<string, unknown>,
      read: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['active'])
      const current = batches.get(String(batch.batchId))!
      assertExactPersistedRecord(current, batch, 'backup upload execution validation')
      if (
        current.executionLeaseExpiresAtUnixMilliseconds === null ||
        databaseNow >= Number(current.executionLeaseExpiresAtUnixMilliseconds)
      ) {
        throw new Error('backup upload execution lease expired')
      }
      return read({
        attempt: structuredClone(attempts.get(String(claimRecord.attemptId))),
        batch: structuredClone(current),
      } as never)
    },
    async transitionUploadBatch<T>(
      claimRecord: Record<string, unknown>,
      expected: Record<string, unknown>,
      next: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, next.state === 'abandoned' ? ['abort-uncertain'] : ['active'])
      const current = batches.get(String(expected.batchId))
      assertExactPersistedRecord(current, expected, 'backup upload transition')
      const beforeAttempt = structuredClone(attempts.get(String(claimRecord.attemptId)))
      const copy = structuredClone(next)
      const attempt = attempts.get(String(claimRecord.attemptId))!
      if (copy.state === 'acknowledged') attempt.activeBatchId = null
      batches.set(String(copy.batchId), copy)
      try {
        return commit({
          attempt: structuredClone(attempt),
          batch: structuredClone(copy),
        } as never)
      } catch (error) {
        attempts.set(String(claimRecord.attemptId), beforeAttempt)
        batches.set(String(expected.batchId), structuredClone(current))
        throw error
      }
    },
    async fenceUploadAttemptForAbort<T>(
      claimRecord: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['active'])
      const rows = partition(claimRecord.attemptId, claimRecord.targetManifestDigest)
      if (rows.some((record) => record.state === 'finalized'))
        throw new Error('backup upload attempt is finalized')
      const next = rows.map((row) => ({
        ...structuredClone(row),
        state: 'abort-uncertain',
        executionLeaseExpiresAtUnixMilliseconds: null,
      }))
      const beforeAttempt = structuredClone(attempts.get(String(claimRecord.attemptId)))
      for (const row of next) batches.set(String(row.batchId), row)
      attempts.get(String(claimRecord.attemptId))!.lifecycle = 'abort-uncertain'
      attempts.get(String(claimRecord.attemptId))!.activeBatchId = null
      try {
        return commit({
          attempt: structuredClone(attempts.get(String(claimRecord.attemptId))),
          batches: structuredClone(next),
        } as never)
      } catch (error) {
        attempts.set(String(claimRecord.attemptId), beforeAttempt)
        for (const row of rows) batches.set(String(row.batchId), row)
        throw error
      }
    },
    async completeUploadAttemptAbort<T>(
      claimRecord: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['abort-uncertain'])
      const next = partition(claimRecord.attemptId, claimRecord.targetManifestDigest).map(
        (row) => ({
          ...structuredClone(row),
          state: 'abandoned',
          executionLeaseExpiresAtUnixMilliseconds: null,
          items: (row.items as Array<Record<string, unknown>>).map((item) => ({
            ...item,
            canonicalPutPayload: null,
          })),
        }),
      )
      const beforeRows = partition(claimRecord.attemptId, claimRecord.targetManifestDigest).map(
        (row) => structuredClone(row),
      )
      const beforeAttempt = structuredClone(attempts.get(String(claimRecord.attemptId)))
      for (const row of next) batches.set(String(row.batchId), row)
      attempts.get(String(claimRecord.attemptId))!.lifecycle = 'abandoned'
      attempts.get(String(claimRecord.attemptId))!.activeBatchId = null
      try {
        const result = commit({
          attempt: structuredClone(attempts.get(String(claimRecord.attemptId))),
          batches: structuredClone(next),
        } as never)
        attempts.delete(String(claimRecord.attemptId))
        for (const row of next) batches.delete(String(row.batchId))
        return result
      } catch (error) {
        attempts.set(String(claimRecord.attemptId), beforeAttempt)
        for (const row of beforeRows) batches.set(String(row.batchId), row)
        throw error
      }
    },
    async inspectUploadAttemptPartition<T>(
      uploadAttemptId: string,
      read: (value: never) => T,
    ): Promise<T> {
      const attempt = attempts.get(uploadAttemptId)!
      const records = [...batches.values()].filter(
        (record) =>
          record.attemptId === uploadAttemptId &&
          record.targetManifestDigest === attempt.targetManifestDigest,
      )
      return read({
        attempt: structuredClone(attempt),
        batches: structuredClone(records),
      } as never)
    },
    async sealOrReadLinkedCasAttempt<T>(
      claimRecord: Record<string, unknown>,
      candidate: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['active', 'cas-journaled'])
      const attemptId = String(claimRecord.attemptId)
      const attempt = attempts.get(attemptId)!
      const rows = partition(claimRecord.attemptId, claimRecord.targetManifestDigest)
      if (attempt.activeBatchId !== null) throw new Error('backup upload batch remains active')
      const rehydrate = attempt.lifecycle === 'cas-journaled'
      if (rehydrate && attempt.casAttemptId !== String(candidate.attemptId)) {
        throw new Error('persisted backup CAS link is foreign')
      }
      if (
        rows.some((row) => (rehydrate ? row.state !== 'finalized' : row.state !== 'acknowledged'))
      ) {
        throw new Error('backup upload partition is incomplete')
      }
      const linkedBefore = linkedCasRows(attemptId)
      if ((rehydrate && linkedBefore.length !== 1) || (!rehydrate && linkedBefore.length !== 0)) {
        throw new Error('backup upload attempt has invalid linked CAS rows')
      }
      const existing = casAttempts.get(String(candidate.attemptId))
      if (existing !== undefined) {
        const immutableExisting = {
          ...structuredClone(existing),
          casAttempts: 0,
          retryStreak: 0,
          retryNotBeforeUnixMilliseconds: null,
          state: 'sealed',
        }
        if (!isDeepStrictEqual(immutableExisting, candidate))
          throw new Error('deterministic backup CAS id collision')
      }
      const beforeAttempt = structuredClone(attempt)
      const beforeRows = rows.map((row) => structuredClone(row))
      const beforeCas = existing === undefined ? undefined : structuredClone(existing)
      const nextRows = rows.map((row) => ({
        ...structuredClone(row),
        state: 'finalized',
        executionLeaseExpiresAtUnixMilliseconds: null,
      }))
      for (const row of nextRows) batches.set(String(row.batchId), row)
      if (existing === undefined)
        casAttempts.set(String(candidate.attemptId), structuredClone(candidate))
      if (!rehydrate) {
        attempt.activeBatchId = null
        attempt.casAttemptId = candidate.attemptId
        attempt.lifecycle = 'cas-journaled'
      }
      try {
        return commit({
          attempt: structuredClone(attempt),
          batches: structuredClone(nextRows),
          casAttempts: structuredClone(linkedCasRows(attemptId)),
        } as never)
      } catch (error) {
        attempts.set(attemptId, beforeAttempt)
        for (const row of beforeRows) batches.set(String(row.batchId), row)
        if (beforeCas === undefined) casAttempts.delete(String(candidate.attemptId))
        else casAttempts.set(String(candidate.attemptId), beforeCas)
        throw error
      }
    },
    async readLinkedCasAttempts<T>(
      claimRecord: Record<string, unknown>,
      read: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['cas-journaled', 'fork-cleanup-uncertain'])
      const attempt = attempts.get(String(claimRecord.attemptId))!
      return read({
        attempt: structuredClone(attempt),
        casAttempts: structuredClone(linkedCasRows(String(attempt.attemptId))),
      } as never)
    },
    async validateLinkedCasAttempt<T>(
      claimRecord: Record<string, unknown>,
      expected: Record<string, unknown>,
      read: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['cas-journaled'])
      const attempt = attempts.get(String(claimRecord.attemptId))!
      const current = casAttempts.get(String(attempt.casAttemptId))
      assertExactPersistedRecord(current, expected, 'linked CAS validation')
      return read({
        attempt: structuredClone(attempt),
        casAttempts: structuredClone(linkedCasRows(String(attempt.attemptId))),
      } as never)
    },
    async transitionLinkedCasAttempt<T>(
      claimRecord: Record<string, unknown>,
      expected: Record<string, unknown>,
      next: Record<string, unknown>,
      lifecycle: string,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['cas-journaled'])
      const attemptId = String(claimRecord.attemptId)
      const attempt = attempts.get(attemptId)!
      const casId = String(attempt.casAttemptId)
      const current = casAttempts.get(casId)
      assertExactPersistedRecord(current, expected, 'linked CAS transition')
      const beforeAttempt = structuredClone(attempt)
      const beforeCas = structuredClone(current)
      const copy = structuredClone(next)
      casAttempts.set(casId, copy)
      attempt.lifecycle = lifecycle
      try {
        const result = commit({
          attempt: structuredClone(attempt),
          casAttempts: structuredClone(linkedCasRows(attemptId)),
        } as never)
        return result
      } catch (error) {
        attempts.set(attemptId, beforeAttempt)
        casAttempts.set(casId, beforeCas)
        throw error
      }
    },
    async completeLinkedCasAttempt<T>(
      claimRecord: Record<string, unknown>,
      expected: Record<string, unknown>,
      next: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['cas-journaled'])
      const attemptId = String(claimRecord.attemptId)
      const attempt = attempts.get(attemptId)!
      const casId = String(attempt.casAttemptId)
      const current = casAttempts.get(casId)
      assertExactPersistedRecord(current, expected, 'linked CAS completion')
      const rows = partition(attemptId, attempt.targetManifestDigest)
      const beforeAttempt = structuredClone(attempt)
      const beforeCas = structuredClone(current)
      casAttempts.set(casId, structuredClone(next))
      attempt.lifecycle = 'complete'
      try {
        const result = commit({
          attempt: structuredClone(attempt),
          batches: structuredClone(rows),
          casAttempts: structuredClone(linkedCasRows(attemptId)),
        } as never)
        attempts.delete(attemptId)
        casAttempts.delete(casId)
        for (const row of rows) batches.delete(String(row.batchId))
        return result
      } catch (error) {
        attempts.set(attemptId, beforeAttempt)
        casAttempts.set(casId, beforeCas)
        throw error
      }
    },
    async exhaustLinkedCasAttempt<T>(
      claimRecord: Record<string, unknown>,
      expected: Record<string, unknown>,
      next: Record<string, unknown>,
      delayMilliseconds: number,
      commit: (value: never) => T,
    ): Promise<T> {
      const stamped = {
        ...structuredClone(next),
        retryNotBeforeUnixMilliseconds: databaseNow + delayMilliseconds,
      }
      return this.transitionLinkedCasAttempt(
        claimRecord,
        expected,
        stamped,
        'cas-journaled',
        commit,
      )
    },
    async resumeLinkedCasAttempt<T>(
      claimRecord: Record<string, unknown>,
      expected: Record<string, unknown>,
      next: Record<string, unknown>,
      commit: (value: never) => T,
    ): Promise<Readonly<{ state: 'not-ready' }> | Readonly<{ state: 'committed'; value: T }>> {
      validateClaim(claimRecord, ['cas-journaled'])
      if (databaseNow < Number(expected.retryNotBeforeUnixMilliseconds))
        return { state: 'not-ready' }
      return {
        state: 'committed',
        value: await this.transitionLinkedCasAttempt(
          claimRecord,
          expected,
          next,
          'cas-journaled',
          commit,
        ),
      }
    },
    async completeForkCleanup<T>(
      claimRecord: Record<string, unknown>,
      expectedCasAttempt: Record<string, unknown>,
      outcome: string,
      commit: (value: never) => T,
    ): Promise<T> {
      validateClaim(claimRecord, ['fork-cleanup-uncertain'])
      const attemptId = String(claimRecord.attemptId)
      const attempt = attempts.get(attemptId)!
      const casAttempt = casAttempts.get(String(attempt.casAttemptId))!
      assertExactPersistedRecord(casAttempt, expectedCasAttempt, 'fork cleanup CAS authority')
      const rows = partition(claimRecord.attemptId, claimRecord.targetManifestDigest)
      const beforeAttempt = structuredClone(attempt)
      const beforeRows = rows.map((row) => structuredClone(row))
      const nextRows = rows.map((row) =>
        outcome === 'already-finalized'
          ? structuredClone(row)
          : {
              ...structuredClone(row),
              state: 'abandoned',
              items: (row.items as Array<Record<string, unknown>>).map((item) => ({
                ...item,
                canonicalPutPayload: null,
              })),
            },
      )
      for (const row of nextRows) batches.set(String(row.batchId), row)
      attempt.lifecycle = outcome === 'already-finalized' ? 'complete' : 'abandoned'
      try {
        const result = commit({
          attempt: structuredClone(attempt),
          batches: structuredClone(nextRows),
          casAttempts: structuredClone(linkedCasRows(attemptId)),
        } as never)
        attempts.delete(attemptId)
        casAttempts.delete(String(attempt.casAttemptId))
        for (const row of nextRows) batches.delete(String(row.batchId))
        return result
      } catch (error) {
        attempts.set(attemptId, beforeAttempt)
        for (const row of beforeRows) batches.set(String(row.batchId), row)
        throw error
      }
    },
    async readUploadAttempt<T>(attemptId: string, read: (value: never) => T): Promise<T> {
      const record = attempts.get(attemptId)
      if (record === undefined) throw new Error('missing upload attempt')
      return read(structuredClone(record) as never)
    },
    async readCasAttempt<T>(attemptId: string, read: (value: never) => T): Promise<T> {
      const record = casAttempts.get(attemptId)
      if (record === undefined) throw new Error('missing CAS attempt')
      return read(structuredClone(record) as never)
    },
    mutateCasAttempt(attemptId: string, mutate: (value: Record<string, unknown>) => void) {
      const record = casAttempts.get(attemptId)
      if (record === undefined) throw new Error('missing CAS attempt')
      mutate(record)
    },
    replaceCasAttempt(attemptId: string, replacement: Record<string, unknown>) {
      if (!casAttempts.has(attemptId)) throw new Error('missing CAS attempt')
      casAttempts.set(attemptId, structuredClone(replacement))
    },
    mutateUploadAttempt(attemptId: string, mutate: (value: Record<string, unknown>) => void) {
      const record = attempts.get(attemptId)
      if (record === undefined) throw new Error('missing upload attempt')
      mutate(record)
    },
    mutateUploadBatch(batchId: string, mutate: (value: Record<string, unknown>) => void) {
      const record = batches.get(batchId)
      if (record === undefined) throw new Error('missing upload batch')
      mutate(record)
    },
    deleteCasAttempt(attemptId: string) {
      casAttempts.delete(attemptId)
    },
    duplicateCasAttempt(attemptId: string, duplicateId: string) {
      const record = casAttempts.get(attemptId)
      if (record === undefined) throw new Error('missing CAS attempt')
      casAttempts.set(duplicateId, structuredClone(record))
    },
    coordinatorRecordCounts() {
      return {
        attempts: attempts.size,
        batches: batches.size,
        casAttempts: casAttempts.size,
      }
    },
  }
  function linkedCasRows(uploadAttemptId: string) {
    return [...casAttempts.values()].filter((record) => record.uploadAttemptId === uploadAttemptId)
  }
  function validateClaim(claim: Record<string, unknown>, lifecycles: string[]) {
    const current = attempts.get(String(claim.attemptId))
    if (
      current === undefined ||
      !isDeepStrictEqual(current, claim) ||
      databaseNow >= Number(current.leaseExpiresAtUnixMilliseconds) ||
      !lifecycles.includes(String(current.lifecycle))
    )
      throw new Error('stale backup upload owner claim')
  }
}

function uploadBatchReadOnlyStore(record: Record<string, unknown>) {
  return {
    async sealActiveUploadAttempt() {
      throw new Error('unused')
    },
    async claimActiveUploadAttempt() {
      throw new Error('unused')
    },
    async claimUploadBatchExecution() {
      throw new Error('unused')
    },
    async validateUploadBatchExecution() {
      throw new Error('unused')
    },
    async validateUploadAttemptClaim() {
      throw new Error('unused')
    },
    async sealUploadBatch() {
      throw new Error('unused')
    },
    async readUploadBatch<T>(_batchId: string, read: (value: never) => T): Promise<T> {
      return read(structuredClone(record) as never)
    },
    async transitionUploadBatch() {
      throw new Error('unused')
    },
    async fenceUploadAttemptForAbort() {
      throw new Error('unused')
    },
    async completeUploadAttemptAbort() {
      throw new Error('unused')
    },
    async readUploadAttempt() {
      throw new Error('unused')
    },
  }
}

function scalarCandidateRuntime(candidates: Uint8Array[]): {
  runtime: EncryptedWalletBackupRuntime
  scalarCalls(): number
} {
  let scalarCalls = 0
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, property) {
      if (property === 'deriveBits') {
        return async (algorithm: HkdfParams, key: CryptoKey, length: number) => {
          const info = new TextDecoder().decode(toBytes(algorithm.info))
          if (info.includes('request-auth-scalar')) {
            const candidate = candidates[scalarCalls++]
            if (candidate === undefined) throw new Error('missing scalar candidate')
            return candidate.slice().buffer
          }
          return target.deriveBits(algorithm, key, length)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as SubtleCrypto
  return {
    runtime: {
      subtle,
      getRandomValues(target) {
        return webcrypto.getRandomValues(target)
      },
    },
    scalarCalls: () => scalarCalls,
  }
}

function toBytes(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

async function encryptRawFrame(cbor: Uint8Array, paddingByte: number) {
  const frame = new Uint8Array(262_144)
  new DataView(frame.buffer).setUint32(0, cbor.byteLength, false)
  frame.set(cbor, 4)
  if (paddingByte !== 0) frame.fill(paddingByte, 4 + cbor.byteLength)
  const aad = fromHex(vector.expected.aadHex)
  const nonce = fromHex(vector.inputs.nonceHex)
  const key = await webcrypto.subtle.importKey(
    'raw',
    fromHex(vector.expected.objectKeyHex),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const encrypted = new Uint8Array(
    await webcrypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aad,
        tagLength: 128,
      },
      key,
      frame,
    ),
  )
  const body = concat(nonce, encrypted)
  const digest = toHex(await sha256(concat(uint32(aad.byteLength), aad, body)))
  return {
    formatVersion: 1 as const,
    kindCode: 1 as const,
    realm: vector.inputs.realm,
    vaultId: vector.expected.vaultIdHex,
    objectId: vector.inputs.objectIdHex,
    generation: vector.inputs.generation,
    paddedLength: 262_144 as const,
    digest,
    aad,
    body,
  }
}

function encodeDeepArray(depth: number): Uint8Array {
  const bytes = new Uint8Array(depth + 1)
  bytes.fill(0x81, 0, depth)
  bytes[depth] = 0
  return bytes
}

function mutate(value: Uint8Array, index: number) {
  const result = value.slice()
  result[index] ^= 1
  return result
}

async function sha256(value: Uint8Array) {
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', value))
}

function uint32(value: number) {
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

function concat(...values: Uint8Array[]) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function toHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function compareLowerHex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

interface BackupVector {
  inputs: {
    seedHex: string
    realm: string
    objectIdHex: string
    nonceHex: string
    generation: number
    request: {
      enrollmentEpoch: number
      method: 'POST'
      url: string
      issuedAtUnixSeconds: number
      expiresAtUnixSeconds: number
      replayNonceHex: string
      auxiliaryRandomnessHex: string
      payloadHex: string
    }
    proof: {
      mint: string
      unit: string
      keysetId: string
      amount: string
      counter: number
      signatureHex: string
      dleq: { e: string; s: string; r: string }
      proofKind: string
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }
  }
  expected: Record<string, string | number> & {
    derivedSecretHex: string
    vaultIdHex: string
    requestAuthPublicKeyHex: string
    proofIdHex: string
    commitmentHex: string
    canonicalCborHex: string
    aadHex: string
    bodySha256Hex: string
    objectDigestHex: string
    objectKeyHex: string
    tagHex: string
    bodyLength: number
  }
}
