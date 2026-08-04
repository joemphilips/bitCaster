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
  packEncryptedWalletBackupProofChunk,
  prepareBoundedEncryptedWalletBackupManifestTarget,
  prepareEncryptedWalletBackupManifestPage,
  prepareEncryptedWalletBackupRequestProof,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupProof,
  readPreparedEncryptedWalletBackupProofChunkManifestEntries,
  readAuthenticatedEncryptedWalletBackupHead,
  type EncryptedWalletBackupRuntime,
  type PreparedEncryptedWalletBackupObject,
  type PreparedEncryptedWalletBackupProof,
} from '../src/encryptedWalletBackup.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../src/durableCustody.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from '../src/encryptedWalletBackupCbor.ts'
import { issueBoundedManifestTargetCapabilityForTest } from '../src/encryptedWalletBackupManifestTargetAuthority.ts'
import {
  finalManifestEntryBytes,
  issueEncryptedWalletBackupManifestEntryCapability,
  registerEncryptedWalletBackupManifestPassABoundaries,
} from '../src/encryptedWalletBackupManifestPageAuthority.ts'
import {
  measureEncryptedWalletBackupManifestPageCbor,
  readEncryptedWalletBackupManifestPassABoundary,
} from '../src/encryptedWalletBackupManifestPassA.ts'
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from '../src/encryptedWalletBackupSnapshotAuthority.ts'

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

test('50k ordinary proofs plus four CTF proofs in 1k markets fit the 64 MiB lifecycle ceiling', () => {
  const root = decode(fromHex(vector.expected.canonicalCborHex)) as unknown[]
  const template = structuredClone((root[2] as unknown[][])[0]!)
  const proofRootFixedBytes = encodeCanonical([1, 1, []]).byteLength - 1
  let chunkCount = 0
  let chunkRecordCount = 0
  let chunkRecordBytes = 0
  let pageCount = 0
  let pageEntryCount = 0
  let pageEntryBytes = 0
  for (let index = 0; index < 54_000; index += 1) {
    const ctfIndex = index - 50_000
    const proofId = indexedBytes(index, 32)
    const commitment = indexedBytes(index + 54_000, 32)
    const record = structuredClone(template)
    record[0] = proofId
    record[1] = commitment
    record[9] = index
    if (ctfIndex >= 0) {
      const marketIndex = Math.floor(ctfIndex / 4)
      const outcomeIndex = ctfIndex % 4
      record[10] = 1
      record[11] = [
        indexedBytes(marketIndex + 1, 32),
        `OUTCOME-${outcomeIndex}`,
        indexedBytes(ctfIndex + 2_001, 32),
        1_700_000_000,
        1_800_000_000,
        [
          1,
          indexedBytes(ctfIndex + 60_001, 32),
          indexedBytes(ctfIndex + 64_001, 32),
          13_015,
          1_800_000_001,
        ],
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
      chunks: 107,
      pages: 142,
      currentObjects: 249,
      replacementObjects: 253,
      referenceSetBytes: 12_968,
      currentStoredBytes: 37_362_492,
      lifecyclePeakBytes: 47_721_268,
    },
  )
  assert.ok(currentObjects <= ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX)
  assert.ok(replacementObjects <= ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX)
  assert.ok(referenceSetBytes <= ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES)
  assert.ok(lifecyclePeakBytes <= 64 * 1_024 * 1_024)
})

test('real prepared 255-chunk plus 3-page target fits below the stored-byte quota', async () => {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: 'capacity-boundary',
  })
  const proof = vector.inputs.proof
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(seed),
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
      terminalOperationId: null,
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
        terminalEvidence: null,
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
  const target = await prepareBoundedCapacityTarget({
    keyHandle,
    generation: 1,
    snapshotNonce: indexedDomainBytes(5, 1, 16),
    snapshotId: 'capacity-snapshot',
    snapshotRevision: 1,
    chunks: chunks.map((chunk, index) => ({ chunk, object: objects[index]! })),
    parentEvidence: await authenticateNoBoundedParent(keyHandle, 3),
    randomnessDomain: 4,
    expectedPageCount: 3,
  })
  assert.deepEqual(
    {
      proofCount: target.target.head.proofCount,
      chunkCount: objects.length,
      pageCount: target.pages.length,
      objectCount: target.target.head.objectCount,
      storedBytes: target.target.head.storedBytes,
    },
    {
      proofCount: 1_025,
      chunkCount: 255,
      pageCount: 3,
      objectCount: 258,
      storedBytes: 67_050_552,
    },
  )
  assert.ok(target.target.head.storedBytes <= ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX)

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
  await assert.rejects(
    prepareBoundedCapacityTarget({
      keyHandle,
      generation: 1,
      snapshotNonce: indexedDomainBytes(8, 1, 16),
      snapshotId: 'capacity-snapshot',
      snapshotRevision: 1,
      chunks: overQuotaChunks.map((chunk, index) => ({
        chunk,
        object: overQuotaObjects[index]!,
      })),
      parentEvidence: await authenticateNoBoundedParent(keyHandle, 9),
      randomnessDomain: 10,
      expectedPageCount: 4,
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
    walletId: deriveDurableCustodyWalletId(seed),
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
      terminalOperationId: null,
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
        terminalEvidence: null,
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
  const prepareParentTarget = async (count: number, domain: number) =>
    prepareBoundedCapacityTarget({
      keyHandle,
      generation: 1,
      snapshotNonce: indexedDomainBytes(domain, count, 16),
      snapshotId: 'child-capacity-snapshot',
      snapshotRevision: 1,
      chunks: chunks.slice(0, count).map((chunk, index) => ({
        chunk,
        object: parentObjects[index]!,
      })),
      parentEvidence: await authenticateNoBoundedParent(keyHandle, domain + 1),
      randomnessDomain: domain + 2,
    })
  const prepareChildTarget = async (
    count: number,
    domain: number,
    parent: Awaited<ReturnType<typeof prepareParentTarget>>,
  ) =>
    prepareBoundedCapacityTarget({
      keyHandle,
      generation: 2,
      snapshotNonce: indexedDomainBytes(domain, count, 16),
      snapshotId: 'child-capacity-snapshot',
      snapshotRevision: 1,
      chunks: chunks.slice(0, count).map((chunk, index) => ({
        chunk,
        object: childObjects[index]!,
      })),
      parentEvidence: await authenticateBoundedParent(keyHandle, parent.target, domain + 1),
      randomnessDomain: domain + 2,
    })
  const parent127 = await prepareParentTarget(127, 15)
  const child127 = await prepareChildTarget(127, 20, parent127)
  assert.equal(parent127.pages.length, 1)
  assert.equal(child127.pages.length, 1)
  assert.equal(parent127.target.head.storedBytes + child127.target.head.storedBytes, 66_722_816)

  const parent128 = await prepareParentTarget(128, 23)
  assert.equal(
    parent128.target.head.storedBytes +
      128 * ENCRYPTED_WALLET_BACKUP_BODY_BYTES +
      ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
    67_247_160,
  )
  await assert.rejects(
    prepareChildTarget(128, 28, parent128),
    /parent and target delta exceed the stored byte quota/,
  )
})

type CapacityChunkBinding = Readonly<{
  chunk: ReturnType<typeof packEncryptedWalletBackupProofChunk>
  object: PreparedEncryptedWalletBackupObject
}>

type CapacityManifestEntry = Readonly<{
  proofId: string
  commitment: string
  canonicalPreparedEntry: Uint8Array
  object: PreparedEncryptedWalletBackupObject
}>

async function prepareBoundedCapacityTarget(input: {
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  generation: number
  snapshotNonce: Uint8Array
  snapshotId: string
  snapshotRevision: number
  chunks: readonly CapacityChunkBinding[]
  parentEvidence: Awaited<ReturnType<typeof readAuthenticatedEncryptedWalletBackupHead>>
  randomnessDomain: number
  expectedPageCount?: number
}) {
  const pages = await prepareCapacityManifestPages(input)
  if (input.expectedPageCount !== undefined) assert.equal(pages.length, input.expectedPageCount)
  const parent = input.parentEvidence.head
  const control = issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    {
      realm: input.keyHandle.realm,
      vaultId: input.keyHandle.vaultId,
      enrollmentEpoch: 1,
      parentGeneration: parent?.generation ?? null,
      parentManifestDigest: parent?.manifestDigest ?? null,
      parentReferenceSetDigest:
        parent?.referenceSetDigest ?? ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: input.generation,
      snapshotNonce: bytesToHex(input.snapshotNonce),
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
    },
  )
  const target = prepareBoundedEncryptedWalletBackupManifestTarget({
    keyHandle: input.keyHandle,
    capability: issueBoundedManifestTargetCapabilityForTest({
      keyHandle: input.keyHandle,
      control,
      parentEvidence: input.parentEvidence,
      pages,
      chunkReferences: input.chunks.map(({ object }) => ({
        objectId: object.objectId,
        digest: object.digest,
      })),
      proofCount: capacityManifestEntries(input.chunks).length,
    }),
  })
  return Object.freeze({ target, pages })
}

async function prepareCapacityManifestPages(input: {
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>
  generation: number
  snapshotNonce: Uint8Array
  snapshotId: string
  snapshotRevision: number
  chunks: readonly CapacityChunkBinding[]
  randomnessDomain: number
}): Promise<readonly PreparedEncryptedWalletBackupObject[]> {
  const entries = capacityManifestEntries(input.chunks)
  const groups = capacityManifestEntryGroups(entries, input.generation)
  const result = Object.freeze({})
  const snapshotNonce = bytesToHex(input.snapshotNonce)
  registerEncryptedWalletBackupManifestPassABoundaries({
    result,
    resultDigest: '11'.repeat(32),
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    snapshotId: input.snapshotId,
    snapshotRevision: input.snapshotRevision,
    sealedControlVersion: 1,
    sealRunRevision: 1,
    sealedControlDigest: '22'.repeat(32),
    generation: input.generation,
    snapshotNonce,
    boundaries: groups.map((group, pageIndex) => ({
      entryCount: group.length,
      canonicalEntryBytes: capacityManifestEntryBytes(group),
      plannedCanonicalPageBytes: measureEncryptedWalletBackupManifestPageCbor({
        generation: input.generation,
        pageIndex,
        pageCount: groups.length,
        entryCount: group.length,
        canonicalEntryBytes: capacityManifestEntryBytes(group),
      }),
    })),
  })
  const pages: PreparedEncryptedWalletBackupObject[] = []
  for (const [pageIndex, group] of groups.entries()) {
    const boundary = readCapacityManifestPageBoundary(result, pageIndex)
    pages.push(
      await prepareEncryptedWalletBackupManifestPage({
        keyHandle: input.keyHandle,
        boundary,
        entries: group.map((entry, ordinal) =>
          issueEncryptedWalletBackupManifestEntryCapability({
            canonicalPreparedEntry: entry.canonicalPreparedEntry,
            chunkObjectId: hexToBytes(entry.object.objectId),
            chunkDigest: hexToBytes(entry.object.digest),
            boundary,
            ordinal,
            pinKey: encodeCanonical([0, hexToBytes(entry.proofId), hexToBytes(entry.commitment)]),
            commitment: entry.commitment,
            chunkGeneration: entry.object.generation,
          }),
        ),
        runtime: deterministicCapacityRuntime([
          indexedDomainBytes(input.randomnessDomain, pageIndex + 1, 16),
          indexedDomainBytes(input.randomnessDomain + 1, pageIndex + 1, 12),
        ]),
      }),
    )
  }
  return Object.freeze(pages)
}

function capacityManifestEntries(chunks: readonly CapacityChunkBinding[]): CapacityManifestEntry[] {
  const entries = chunks.flatMap(({ chunk, object }) =>
    readPreparedEncryptedWalletBackupProofChunkManifestEntries(chunk).map((entry) =>
      Object.freeze({
        proofId: entry.recordId,
        commitment: entry.commitment,
        canonicalPreparedEntry: entry.canonicalManifestEntry,
        object,
      }),
    ),
  )
  entries.sort((left, right) => compareCapacityHex(left.proofId, right.proofId))
  return entries
}

function compareCapacityHex(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function capacityManifestEntryGroups(
  entries: readonly CapacityManifestEntry[],
  generation: number,
): CapacityManifestEntry[][] {
  const groups: CapacityManifestEntry[][] = []
  let current: CapacityManifestEntry[] = []
  for (const entry of entries) {
    const candidate = [...current, entry]
    const candidateBytes = capacityManifestEntryBytes(candidate)
    if (
      candidate.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX ||
      measureEncryptedWalletBackupManifestPageCbor({
        generation,
        pageIndex: groups.length,
        pageCount: 1_024,
        entryCount: candidate.length,
        canonicalEntryBytes: candidateBytes,
      }) > ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES
    ) {
      assert.ok(current.length > 0)
      groups.push(current)
      current = [entry]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function capacityManifestEntryBytes(entries: readonly CapacityManifestEntry[]): number {
  return entries.reduce(
    (total, entry) =>
      total +
      finalManifestEntryBytes(
        entry.canonicalPreparedEntry,
        hexToBytes(entry.object.objectId),
        hexToBytes(entry.object.digest),
      ).byteLength,
    0,
  )
}

function readCapacityManifestPageBoundary(result: object, pageIndex: number) {
  return readEncryptedWalletBackupManifestPassABoundary(result, pageIndex)
}

async function authenticateNoBoundedParent(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  domain: number,
) {
  return authenticateBoundedHead(keyHandle, null, domain)
}

async function authenticateBoundedParent(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  parent: ReturnType<typeof prepareBoundedEncryptedWalletBackupManifestTarget>,
  domain: number,
) {
  return authenticateBoundedHead(keyHandle, parent.wire, domain)
}

async function authenticateBoundedHead(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  head: ReturnType<typeof prepareBoundedEncryptedWalletBackupManifestTarget>['wire'] | null,
  domain: number,
) {
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: `https://backup.example.test/capacity-parent-${domain}`,
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    signal: AbortSignal.timeout(60_000),
    runtime: deterministicCapacityRuntime([
      indexedDomainBytes(domain, 1, 16),
      indexedDomainBytes(domain + 1, 1, 32),
    ]),
  })
  return readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return head === null
          ? { status: 'not-found' as const }
          : { status: 'found' as const, enrollmentEpoch: 1, head }
      },
    },
  })
}

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
