import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import * as Cashu from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  createEncryptedWalletBackupKeyHandle,
  ENCRYPTED_WALLET_BACKUP_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
  decryptEncryptedWalletBackupManifestPage,
  packEncryptedWalletBackupProofChunk,
  prepareEncryptedWalletBackupRequestProof,
  prepareIncrementalEncryptedWalletBackupManifest,
  prepareEncryptedWalletBackupManifest,
  prepareEncryptedWalletBackupManifestHead,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupProof,
  readAuthenticatedEncryptedWalletBackupHead,
  readPreparedEncryptedWalletBackupManifestHead,
  readPreparedEncryptedWalletBackupObject,
  type EncryptedWalletBackupRuntime,
  type EncryptedWalletBackupWireObject,
} from '../src/encryptedWalletBackup.ts'
import {
  ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX,
  ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX,
  prepareEncryptedWalletBackupUploadPlan,
} from '../src/encryptedWalletBackupSync.ts'
import { deriveDurableCustodyProofId, deriveDurableCustodyScopeId } from '../src/durableCustody.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as {
  inputs: {
    seedHex: string
    proof: {
      mint: string
      unit: string
      keysetId: string
      amount: string
      signatureHex: string
      dleq: { e: string; s: string; r: string }
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }
  }
  expected: { canonicalCborHex: string }
}

test('50k ordinary proofs plus 1k market CTF proofs fit the 64 MiB lifecycle ceiling', () => {
  const root = decode(fromHex(vector.expected.canonicalCborHex)) as unknown[]
  const template = structuredClone((root[2] as unknown[][])[0]!)
  const proofRootFixedBytes = encodeCanonical([1, 1, []]).byteLength - 1
  let chunkCount = 0
  let chunkRecordCount = 0
  let chunkRecordBytes = 0
  let pageCount = 0
  let pageEntryCount = 0
  let pageEntryBytes = 0
  for (let index = 0; index < 51_000; index += 1) {
    const ctfIndex = index - 50_000
    const proofId = indexedBytes(index, 32)
    const commitment = indexedBytes(index + 51_000, 32)
    const record = structuredClone(template)
    record[0] = proofId
    record[1] = commitment
    record[9] = index
    if (ctfIndex >= 0) {
      record[10] = 1
      record[11] = [
        indexedBytes(ctfIndex + 1, 32),
        `OUTCOME-${ctfIndex}`,
        indexedBytes(ctfIndex + 2_001, 32),
        1_700_000_000,
        1_800_000_000,
      ]
    }
    const recordBytes = encodeCanonical(record).byteLength
    const candidateRecordCount = chunkRecordCount + 1
    const candidateChunkBytes =
      proofRootFixedBytes +
      cborArrayHeaderBytes(candidateRecordCount) +
      chunkRecordBytes +
      recordBytes
    if (
      candidateRecordCount > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX ||
      candidateChunkBytes > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES
    ) {
      assert.ok(chunkRecordCount > 0)
      chunkCount += 1
      chunkRecordCount = 1
      chunkRecordBytes = recordBytes
    } else {
      chunkRecordCount = candidateRecordCount
      chunkRecordBytes += recordBytes
    }
    const chunkIndex = chunkCount
    const entry = [
      record[0],
      record[1],
      indexedBytes(chunkIndex + 1, 16),
      indexedBytes(chunkIndex + 10_001, 32),
      record[2],
      record[3],
      record[5],
      record[10],
      record[11],
      record[12],
      record[13],
    ]
    const entryBytes = encodeCanonical(entry).byteLength
    const candidateEntryCount = pageEntryCount + 1
    const candidatePageBytes =
      manifestPageFixedBytes(pageCount) +
      cborArrayHeaderBytes(candidateEntryCount) +
      pageEntryBytes +
      entryBytes
    if (
      candidateEntryCount > ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX ||
      candidatePageBytes > ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES
    ) {
      assert.ok(pageEntryCount > 0)
      pageCount += 1
      pageEntryCount = 1
      pageEntryBytes = entryBytes
    } else {
      pageEntryCount = candidateEntryCount
      pageEntryBytes += entryBytes
    }
  }
  chunkCount += 1
  pageCount += 1

  const pageReferences = Array.from({ length: pageCount }, (_, index) => [
    indexedBytes(index + 20_001, 16),
    indexedBytes(index + 30_001, 32),
  ])
  const chunkReferences = Array.from({ length: chunkCount }, (_, index) => [
    indexedBytes(index + 1, 16),
    indexedBytes(index + 10_001, 32),
  ])
  const referenceSetBytes = encodeCanonical([
    1,
    'reference-set',
    pageReferences,
    chunkReferences,
  ]).byteLength
  const currentObjects = pageCount + chunkCount
  const currentStoredBytes =
    pageCount * ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES +
    chunkCount * ENCRYPTED_WALLET_BACKUP_BODY_BYTES
  // One current head plus one staged/replacement manifest, at most four
  // repacked chunks, and the former manifest pages awaiting bounded GC.
  const lifecyclePeakBytes =
    chunkCount * ENCRYPTED_WALLET_BACKUP_BODY_BYTES +
    4 * ENCRYPTED_WALLET_BACKUP_BODY_BYTES +
    2 * pageCount * ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES
  const replacementObjects = chunkCount + 4 + pageCount

  assert.deepEqual(
    {
      chunks: chunkCount,
      pages: pageCount,
      currentObjects,
      replacementObjects,
      referenceSetBytes,
      currentStoredBytes,
      lifecyclePeakBytes,
    },
    {
      chunks: 100,
      pages: 126,
      currentObjects: 226,
      replacementObjects: 230,
      referenceSetBytes: 11_772,
      currentStoredBytes: 34_478_264,
      lifecyclePeakBytes: 43_788_016,
    },
  )
  assert.ok(currentObjects <= ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX)
  assert.ok(replacementObjects <= ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX)
  assert.ok(referenceSetBytes <= ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES)
  assert.ok(lifecyclePeakBytes <= 64 * 1_024 * 1_024)
})

test('real prepared 255-chunk plus 3-page target is capability-planned below 64 MiB', async () => {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'capacity-boundary',
  })
  const proof = vector.inputs.proof
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: keyHandle.vaultId,
  })
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (counter: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(seed, proof.keysetId)
  const preparedProofs: Awaited<ReturnType<typeof prepareEncryptedWalletBackupProof>>[] = []
  for (let counter = 0; counter < 1_537; counter += 1) {
    const secret = bytesToHex(derive(counter).secret)
    const proofId = deriveDurableCustodyProofId({
      scopeId,
      normalizedMint: proof.mint,
      unit: proof.unit,
      keysetId: proof.keysetId,
      secret,
    })
    const commitment = capacityProofCommitment({
      counter,
      secret,
      proof,
    })
    const row = Object.freeze({
      schemaVersion: 1 as const,
      snapshotId: 'capacity-snapshot',
      revision: 1,
      proofId,
      proofCommitment: commitment,
      proofKind: 'ordinary' as const,
      ctfMetadata: null,
      conditionalKeysetEvidence: null,
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
    })
    preparedProofs.push(
      await prepareEncryptedWalletBackupProof({
        keyHandle,
        seed,
        mint: proof.mint,
        unit: proof.unit,
        counter,
        proof: {
          id: proof.keysetId,
          amount: proof.amount,
          secret,
          C: proof.signatureHex,
          dleq: { ...proof.dleq },
        },
        proofKind: 'ordinary',
        ctfMetadata: null,
        effectiveNowUnixSeconds: proof.createdAtUnixSeconds,
        createdAtUnixSeconds: proof.createdAtUnixSeconds,
        updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
        proofSnapshotStore: {
          async withCommittedProofSnapshot<T>(
            stableProofId: string,
            read: (value: typeof row) => T,
          ): Promise<T> {
            assert.equal(stableProofId, proofId)
            return read(row)
          },
        },
      }),
    )
  }

  const chunks: ReturnType<typeof packEncryptedWalletBackupProofChunk>[] = []
  let proofOffset = 0
  for (let index = 0; index < 255; index += 1) {
    const chunkProofCount = index < 5 ? 5 : 4
    chunks.push(
      packEncryptedWalletBackupProofChunk(
        preparedProofs.slice(proofOffset, Math.min(proofOffset + chunkProofCount, 1_025)),
      ),
    )
    proofOffset += chunkProofCount
  }
  assert.equal(proofOffset, 1_025)

  const objects: Awaited<ReturnType<typeof prepareEncryptedWalletBackupObject>>[] = []
  for (const [index, chunk] of chunks.entries()) {
    objects.push(
      await prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicCapacityRuntime([
          indexedDomainBytes(1, index + 1, 16),
          indexedDomainBytes(2, index + 1, 12),
        ]),
      }),
    )
  }
  const manifestRandomness: Uint8Array[] = []
  for (let index = 0; index < 8; index += 1) {
    manifestRandomness.push(
      indexedDomainBytes(3, index + 1, 16),
      indexedDomainBytes(4, index + 1, 12),
    )
  }
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: indexedDomainBytes(5, 1, 16),
    chunks: chunks.map((chunk, index) => ({ chunk, object: objects[index]! })),
    snapshotStore: {
      async sealCommittedBackupSnapshot<T>(expected: unknown, seal: (value: never) => T) {
        return seal(expected as never)
      },
    },
    runtime: deterministicCapacityRuntime(manifestRandomness),
  })
  const head = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest,
    parent: null,
  })
  assert.deepEqual(
    {
      proofCount: head.proofCount,
      chunkCount: manifest.chunkObjects.length,
      pageCount: manifest.pages.length,
      objectCount: head.objectCount,
      storedBytes: head.storedBytes,
    },
    {
      proofCount: 1_025,
      chunkCount: 255,
      pageCount: 3,
      objectCount: 258,
      storedBytes: 67_050_552,
    },
  )
  assert.ok(head.storedBytes <= ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX)

  const attemptId = '55'.repeat(16)
  const plan = prepareEncryptedWalletBackupUploadPlan({
    attemptId,
    keyHandle,
    targetHead: head,
  })
  assert.deepEqual(
    plan.batches.map((batch) => batch.objectCount),
    [16, ...Array.from({ length: 16 }, () => 15), 2],
  )
  assert.equal(plan.objectCount, 258)
  assert.equal(
    plan.batches.reduce((total, batch) => total + batch.objectCount, 0),
    plan.objectCount,
  )
  assert.equal(
    plan.batches.every((batch) => batch.repackedChunkCount === 0),
    true,
  )
  const pagePayloadLength = capacityPutPayloadLength(
    attemptId,
    readPreparedEncryptedWalletBackupObject(manifest.pages[0]!),
  )
  const chunkPayloadLength = capacityPutPayloadLength(
    attemptId,
    readPreparedEncryptedWalletBackupObject(objects[0]!),
  )
  assert.equal(plan.batches[0]!.uploadedBytes, 3 * pagePayloadLength + 13 * chunkPayloadLength)
  for (const batch of plan.batches.slice(1, -1)) {
    assert.equal(batch.objectCount, 15)
    assert.equal(batch.uploadedBytes, 15 * chunkPayloadLength)
    assert.ok(
      batch.uploadedBytes + chunkPayloadLength > ENCRYPTED_WALLET_BACKUP_CYCLE_UPLOAD_BYTES_MAX,
    )
  }
  assert.equal(
    plan.batches.reduce((total, batch) => total + batch.uploadedBytes, 0),
    3 * pagePayloadLength + 255 * chunkPayloadLength,
  )
  assert.equal(plan.batches[0]!.objectCount, ENCRYPTED_WALLET_BACKUP_CYCLE_REQUEST_MAX)

  const overQuotaChunks: ReturnType<typeof packEncryptedWalletBackupProofChunk>[] = []
  proofOffset = 0
  for (let index = 0; index < 255; index += 1) {
    const chunkProofCount = index < 7 ? 7 : 6
    overQuotaChunks.push(
      packEncryptedWalletBackupProofChunk(
        preparedProofs.slice(proofOffset, proofOffset + chunkProofCount),
      ),
    )
    proofOffset += chunkProofCount
  }
  assert.equal(proofOffset, preparedProofs.length)
  const overQuotaObjects: typeof objects = []
  for (const [index, chunk] of overQuotaChunks.entries()) {
    overQuotaObjects.push(
      await prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicCapacityRuntime([
          indexedDomainBytes(6, index + 1, 16),
          indexedDomainBytes(7, index + 1, 12),
        ]),
      }),
    )
  }
  const overQuotaManifest = await prepareEncryptedWalletBackupManifest({
    keyHandle,
    generation: 1,
    snapshotNonce: indexedDomainBytes(8, 1, 16),
    chunks: overQuotaChunks.map((chunk, index) => ({
      chunk,
      object: overQuotaObjects[index]!,
    })),
    snapshotStore: {
      async sealCommittedBackupSnapshot<T>(expected: unknown, seal: (value: never) => T) {
        return seal(expected as never)
      },
    },
    runtime: deterministicCapacityRuntime(
      Array.from({ length: 8 }, (_, index) => [
        indexedDomainBytes(9, index + 1, 16),
        indexedDomainBytes(10, index + 1, 12),
      ]).flat(),
    ),
  })
  assert.equal(overQuotaManifest.chunkObjects.length, 255)
  assert.equal(overQuotaManifest.pages.length, 4)
  assert.throws(
    () =>
      prepareEncryptedWalletBackupManifestHead({
        keyHandle,
        manifest: overQuotaManifest,
        parent: null,
      }),
    /target exceeds the stored byte quota/,
  )
})

test('real child replacement peak accepts 127 chunks and rejects 128 chunks', async () => {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'child-capacity-boundary',
  })
  const proof = vector.inputs.proof
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: keyHandle.vaultId,
  })
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (counter: number) => { secret: Uint8Array }
    }
  ).createSecretAndBlindingFactorDeriver(seed, proof.keysetId)
  const preparedProofs: Awaited<ReturnType<typeof prepareEncryptedWalletBackupProof>>[] = []
  for (let counter = 0; counter < 128; counter += 1) {
    const secret = bytesToHex(derive(counter).secret)
    const proofId = deriveDurableCustodyProofId({
      scopeId,
      normalizedMint: proof.mint,
      unit: proof.unit,
      keysetId: proof.keysetId,
      secret,
    })
    const proofCommitment = capacityProofCommitment({ counter, secret, proof })
    const row = Object.freeze({
      schemaVersion: 1 as const,
      snapshotId: 'child-capacity-snapshot',
      revision: 1,
      proofId,
      proofCommitment,
      proofKind: 'ordinary' as const,
      ctfMetadata: null,
      conditionalKeysetEvidence: null,
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
    })
    preparedProofs.push(
      await prepareEncryptedWalletBackupProof({
        keyHandle,
        seed,
        mint: proof.mint,
        unit: proof.unit,
        counter,
        proof: {
          id: proof.keysetId,
          amount: proof.amount,
          secret,
          C: proof.signatureHex,
          dleq: { ...proof.dleq },
        },
        proofKind: 'ordinary',
        ctfMetadata: null,
        effectiveNowUnixSeconds: proof.createdAtUnixSeconds,
        createdAtUnixSeconds: proof.createdAtUnixSeconds,
        updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
        proofSnapshotStore: {
          async withCommittedProofSnapshot<T>(
            stableProofId: string,
            read: (value: typeof row) => T,
          ): Promise<T> {
            assert.equal(stableProofId, proofId)
            return read(row)
          },
        },
      }),
    )
  }
  const chunks = preparedProofs.map((prepared) => packEncryptedWalletBackupProofChunk([prepared]))
  const parentObjects: Awaited<ReturnType<typeof prepareEncryptedWalletBackupObject>>[] = []
  const childObjects: typeof parentObjects = []
  for (const [index, chunk] of chunks.entries()) {
    parentObjects.push(
      await prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 1,
        runtime: deterministicCapacityRuntime([
          indexedDomainBytes(11, index + 1, 16),
          indexedDomainBytes(12, index + 1, 12),
        ]),
      }),
    )
    childObjects.push(
      await prepareEncryptedWalletBackupObject({
        keyHandle,
        chunk,
        generation: 2,
        runtime: deterministicCapacityRuntime([
          indexedDomainBytes(13, index + 1, 16),
          indexedDomainBytes(14, index + 1, 12),
        ]),
      }),
    )
  }
  const prepareParentManifest = (count: number, domain: number) =>
    prepareEncryptedWalletBackupManifest({
      keyHandle,
      generation: 1,
      snapshotNonce: indexedDomainBytes(domain, count, 16),
      chunks: chunks.slice(0, count).map((chunk, index) => ({
        chunk,
        object: parentObjects[index]!,
      })),
      snapshotStore: {
        async sealCommittedBackupSnapshot<T>(expected: unknown, seal: (value: never) => T) {
          return seal(expected as never)
        },
      },
      runtime: deterministicCapacityRuntime([
        indexedDomainBytes(domain + 1, count, 16),
        indexedDomainBytes(domain + 2, count, 12),
      ]),
    })
  const authenticateParent = async (
    head: ReturnType<typeof prepareEncryptedWalletBackupManifestHead>,
    manifest: Awaited<ReturnType<typeof prepareEncryptedWalletBackupManifest>>,
    domain: number,
  ) => {
    const requestProof = await prepareEncryptedWalletBackupRequestProof({
      keyHandle,
      enrollmentEpoch: 1,
      method: 'GET',
      url: `https://backup.example.test/capacity-parent-${domain}`,
      issuedAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_000_030,
      payload: new Uint8Array(),
      runtime: deterministicCapacityRuntime([
        indexedDomainBytes(domain, 1, 16),
        indexedDomainBytes(domain + 1, 1, 32),
      ]),
    })
    const evidence = await readAuthenticatedEncryptedWalletBackupHead({
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
    const page = await decryptEncryptedWalletBackupManifestPage({
      keyHandle,
      seed,
      object: readPreparedEncryptedWalletBackupObject(manifest.pages[0]!),
      headEvidence: evidence,
    })
    return { evidence, page }
  }
  const prepareChildManifest = (
    count: number,
    domain: number,
    parent: Awaited<ReturnType<typeof authenticateParent>>,
  ) =>
    prepareIncrementalEncryptedWalletBackupManifest({
      keyHandle,
      generation: 2,
      snapshotNonce: indexedDomainBytes(domain, count, 16),
      parentEvidence: parent.evidence,
      parentPages: [parent.page],
      chunks: chunks.slice(0, count).map((chunk, index) => ({
        chunk,
        object: childObjects[index]!,
      })),
      removedProofIds: [],
      snapshot: {
        snapshotId: 'child-capacity-snapshot',
        snapshotRevision: 1,
      },
      snapshotStore: {
        async sealCommittedBackupSnapshot<T>(expected: unknown, seal: (value: never) => T) {
          return seal(expected as never)
        },
      },
      runtime: deterministicCapacityRuntime([
        indexedDomainBytes(domain + 1, count, 16),
        indexedDomainBytes(domain + 2, count, 12),
      ]),
    })

  const parent127Manifest = await prepareParentManifest(127, 15)
  const parent127 = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: parent127Manifest,
    parent: null,
  })
  const authenticated127 = await authenticateParent(parent127, parent127Manifest, 18)
  const child127Manifest = await prepareChildManifest(127, 20, authenticated127)
  const child127 = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: child127Manifest,
    parent: authenticated127.evidence.head,
  })
  assert.equal(parent127Manifest.pages.length, 1)
  assert.equal(child127Manifest.pages.length, 1)
  assert.equal(parent127.storedBytes + child127.storedBytes, 66_722_816)
  const child127Plan = prepareEncryptedWalletBackupUploadPlan({
    attemptId: '7f'.repeat(16),
    keyHandle,
    targetHead: child127,
  })
  assert.equal(child127Plan.batches.length, 32)
  assert.deepEqual(
    child127Plan.batches.map((batch) => batch.repackedChunkCount),
    [...Array.from({ length: 31 }, () => 4), 3],
  )
  assert.equal(
    child127Plan.batches.reduce((total, batch) => total + batch.objectCount, 0),
    child127.objectCount,
  )

  const parent128Manifest = await prepareParentManifest(128, 23)
  const parent128 = prepareEncryptedWalletBackupManifestHead({
    keyHandle,
    manifest: parent128Manifest,
    parent: null,
  })
  const authenticated128 = await authenticateParent(parent128, parent128Manifest, 26)
  const child128Manifest = await prepareChildManifest(128, 28, authenticated128)
  assert.equal(
    parent128.storedBytes +
      128 * ENCRYPTED_WALLET_BACKUP_BODY_BYTES +
      ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
    67_247_160,
  )
  assert.throws(
    () =>
      prepareEncryptedWalletBackupManifestHead({
        keyHandle,
        manifest: child128Manifest,
        parent: authenticated128.evidence.head,
      }),
    /parent and target delta exceed the stored byte quota/,
  )
})

function capacityProofCommitment(input: {
  counter: number
  secret: string
  proof: {
    mint: string
    unit: string
    keysetId: string
    amount: string
    signatureHex: string
    dleq: { e: string; s: string; r: string }
    createdAtUnixSeconds: number
    updatedAtUnixSeconds: number
  }
}): string {
  return bytesToHex(
    sha256(
      encodeCanonical([
        1,
        'proof-record-commitment',
        input.proof.mint,
        input.proof.unit,
        [2, input.proof.keysetId],
        input.proof.amount,
        new TextEncoder().encode(input.secret),
        hexToBytes(input.proof.signatureHex),
        [
          hexToBytes(input.proof.dleq.e),
          hexToBytes(input.proof.dleq.s),
          hexToBytes(input.proof.dleq.r),
        ],
        input.counter,
        0,
        null,
        input.proof.createdAtUnixSeconds,
        input.proof.updatedAtUnixSeconds,
      ]),
    ),
  )
}

function capacityPutPayloadLength(
  attemptId: string,
  object: EncryptedWalletBackupWireObject,
): number {
  return encodeCanonical([
    1,
    'object-put',
    hexToBytes(attemptId),
    object.kindCode,
    object.realm,
    hexToBytes(object.vaultId),
    hexToBytes(object.objectId),
    object.generation,
    object.paddedLength,
    hexToBytes(object.digest),
    object.aad,
    object.body,
  ]).byteLength
}

function deterministicCapacityRuntime(values: readonly Uint8Array[]): EncryptedWalletBackupRuntime {
  let offset = 0
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      const value = values[offset++]
      if (value === undefined || value.byteLength !== target.byteLength) {
        throw new Error('unexpected capacity randomness request')
      }
      target.set(value)
      return target
    },
  }
}

function indexedDomainBytes(domain: number, value: number, length: number): Uint8Array {
  const result = new Uint8Array(length)
  result[0] = domain
  new DataView(result.buffer).setUint32(length - 4, value, false)
  return result
}

function indexedBytes(value: number, length: number): Uint8Array {
  const result = new Uint8Array(length)
  new DataView(result.buffer).setUint32(length - 4, value, false)
  return result
}

function manifestPageFixedBytes(pageIndex: number): number {
  return encodeCanonical([1, 2, 1, new Uint8Array(16), pageIndex, 1_024, []]).byteLength - 1
}

function cborArrayHeaderBytes(length: number): number {
  if (length < 24) return 1
  if (length <= 0xff) return 2
  if (length <= 0xffff) return 3
  return 5
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}
