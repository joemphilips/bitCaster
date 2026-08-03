import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES,
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupProof,
} from '../src/encryptedWalletBackup.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../src/durableCustody.ts'
import {
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  rehydratePreparedEncryptedWalletBackupRecord,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../src/encryptedWalletBackupPreparedRecordPersistence.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'

const vector = JSON.parse(
  await readFile(
    new URL('../../test-vectors/encrypted-wallet-backup-v1.json', import.meta.url),
    'utf8',
  ),
) as {
  inputs: {
    seedHex: string
    realm: string
    proof: {
      mint: string
      unit: string
      keysetId: string
      amount: string
      counter: number
      signatureHex: string
      dleq: { e: string; s: string; r: string }
      createdAtUnixSeconds: number
      updatedAtUnixSeconds: number
    }
  }
  expected: {
    derivedSecretHex: string
    proofIdHex: string
    commitmentHex: string
  }
}

test('a deterministic proof preparation survives a process restart', async () => {
  const fixture = await preparedProofFixture()
  const proof = vector.inputs.proof
  const expectedProofId = deriveDurableCustodyProofId({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(fixture.seed),
    }),
    normalizedMint: proof.mint,
    unit: proof.unit,
    keysetId: proof.keysetId,
    secret: vector.expected.derivedSecretHex,
  })
  assert.equal(fixture.record.proofId, expectedProofId)
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture)
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(
        new URL('./encryptedWalletBackupPreparedRecordPersistenceChild.ts', import.meta.url),
      ),
    ],
    {
      input: JSON.stringify({
        seed: [...fixture.seed],
        realm: fixture.realm,
        persisted: {
          ...persisted,
          canonicalRecord: [...persisted.canonicalRecord],
          canonicalManifestEntry: [...persisted.canonicalManifestEntry],
          authenticationTag: [...persisted.authenticationTag],
        },
        snapshot: fixture.snapshot,
      }),
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  assert.equal(child.status, 0, child.stderr || child.stdout)
  const rehydrated = JSON.parse(child.stdout) as Array<{ proofId: string; commitment: string }>
  assert.deepEqual(rehydrated, [
    {
      proofId: fixture.snapshot.recordId,
      commitment: fixture.snapshot.commitment,
    },
  ])
  assert.equal(rehydrated[0]!.proofId, expectedProofId)
})

test('changed capability fields and stale snapshots fail closed', async () => {
  const fixture = await preparedProofFixture()
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture)
  const mutations: Array<(row: Record<string, unknown>) => void> = [
    (row) => {
      row.realm = 'foreign-realm'
    },
    (row) => {
      row.realm = 'Upper-Realm'
    },
    (row) => {
      row.realm = 'bad\u0001realm'
    },
    (row) => {
      row.snapshotId = 'é'.repeat(65)
    },
    (row) => {
      row.recordId = '13'.repeat(32)
    },
    (row) => {
      row.recordKindCode = 1
    },
    (row) => {
      ;(row.canonicalRecord as Uint8Array)[0] ^= 1
    },
    (row) => {
      ;(row.canonicalManifestEntry as Uint8Array)[0] ^= 1
    },
    (row) => {
      ;(row.authenticationTag as Uint8Array)[0] ^= 1
    },
    (row) => {
      row.unexpected = true
    },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(persisted) as unknown as Record<string, unknown>
    mutate(changed)
    await assert.rejects(
      rehydratePreparedEncryptedWalletBackupRecord({
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        persisted: changed as unknown as PersistedPreparedEncryptedWalletBackupRecord,
        snapshotStore: fixture.snapshotStore,
      }),
    )
  }
  await assert.rejects(
    rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      persisted,
      snapshotStore: exactSnapshotStore({
        ...fixture.snapshot,
        snapshotRevision: fixture.snapshot.snapshotRevision + 1,
      }),
    }),
    /snapshot changed/,
  )
})

test('changed manifest entry length without a new authentication tag fails closed', async () => {
  const fixture = await preparedProofFixture()
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture)
  const changed = structuredClone(persisted)
  const manifest = new Uint8Array(persisted.canonicalManifestEntry.byteLength + 1)
  manifest.set(persisted.canonicalManifestEntry)
  changed.canonicalManifestEntry = manifest
  await assert.rejects(
    rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      persisted: changed,
      snapshotStore: fixture.snapshotStore,
    }),
    /capability/,
  )
})

test('prepared source descriptor is canonical, strict, and changes with its body', async () => {
  const fixture = await preparedProofFixture()
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture)
  const descriptor = encodeEncryptedWalletBackupPreparedSourceDescriptor(persisted)
  const decoded = decodeEncryptedWalletBackupPreparedSourceDescriptor(descriptor)
  assert.equal(decoded.realm, persisted.realm)
  assert.equal(decoded.vaultId, persisted.vaultId)
  assert.equal(decoded.revision, persisted.snapshotRevision)
  assert.equal(decoded.recordId, persisted.recordId)
  assert.equal(decoded.commitment, persisted.commitment)
  assert.equal(decoded.canonicalManifestEntryBytes, persisted.canonicalManifestEntry.byteLength)
  const changed = structuredClone(persisted)
  changed.authenticationTag[0]! ^= 1
  const changedDescriptor = encodeEncryptedWalletBackupPreparedSourceDescriptor(changed)
  assert.notEqual(
    decoded.bodyReference,
    decodeEncryptedWalletBackupPreparedSourceDescriptor(changedDescriptor).bodyReference,
  )
  for (const invalid of [Uint8Array.of(1), Uint8Array.from([...descriptor, 0])]) {
    assert.throws(() => decodeEncryptedWalletBackupPreparedSourceDescriptor(invalid))
  }
})

test('prepared source descriptor rejects every closed-field violation', async () => {
  const fixture = await preparedProofFixture()
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture)
  const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(
    encodeEncryptedWalletBackupPreparedSourceDescriptor(persisted),
  )
  const valid = sourceWire(descriptor)
  const cases: readonly unknown[][] = [
    [2, ...valid.slice(1)],
    [1, 'wrong-domain', ...valid.slice(2)],
    [...valid.slice(0, 6), 1, ...valid.slice(7)],
    [1, valid[1], '', ...valid.slice(3)],
    [1, valid[1], 'x'.repeat(65), ...valid.slice(3)],
    [1, valid[1], new Uint8Array(31), ...valid.slice(3)],
    [1, valid[1], valid[2], new Uint8Array(31), ...valid.slice(4)],
    [1, valid[1], valid[2], valid[3], -1, ...valid.slice(5)],
    [1, valid[1], valid[2], valid[3], 1.5, ...valid.slice(5)],
    [...valid.slice(0, 7), new Uint8Array(31), ...valid.slice(8)],
    [...valid.slice(0, 8), new Uint8Array(31), ...valid.slice(9)],
    [...valid, 0],
  ]
  for (const wire of cases) {
    assert.throws(() =>
      decodeEncryptedWalletBackupPreparedSourceDescriptor(encodeCanonicalBackupCbor(wire)),
    )
  }
})

test('prepared source descriptors require bounded manifest entry lengths', async () => {
  const fixture = await preparedProofFixture()
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture)
  const descriptor = decodeEncryptedWalletBackupPreparedSourceDescriptor(
    encodeEncryptedWalletBackupPreparedSourceDescriptor(persisted),
  )
  const valid = sourceWire(descriptor)
  for (const entryBytes of [
    undefined,
    'wrong',
    0,
    Number.MAX_SAFE_INTEGER + 1,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES + 1,
  ] as const) {
    const wire = valid.slice()
    if (entryBytes === undefined) wire.pop()
    else wire[9] = entryBytes
    assert.throws(() =>
      decodeEncryptedWalletBackupPreparedSourceDescriptor(encodeCanonicalBackupCbor(wire)),
    )
  }
  assert.throws(() =>
    encodeEncryptedWalletBackupPreparedSourceDescriptor({
      ...persisted,
      canonicalManifestEntry: new Uint8Array(ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES + 1),
    }),
  )
})

function sourceWire(
  value: ReturnType<typeof decodeEncryptedWalletBackupPreparedSourceDescriptor>,
): unknown[] {
  return [
    1,
    'prepared-proof-source',
    value.realm,
    fromHex(value.vaultId),
    fromHex(value.bodyReference),
    value.revision,
    value.recordKindCode,
    fromHex(value.recordId),
    fromHex(value.commitment),
    value.canonicalManifestEntryBytes,
  ]
}

async function preparedProofFixture() {
  const seed = fromHex(vector.inputs.seedHex)
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: vector.inputs.realm,
    runtime: cryptoRuntime(),
  })
  const snapshot = {
    schemaVersion: 1 as const,
    snapshotId: 'prepared-record-snapshot',
    snapshotRevision: 1,
    recordId: vector.expected.proofIdHex,
    commitment: vector.expected.commitmentHex,
    recordKindCode: 0 as const,
  }
  const proof = vector.inputs.proof
  const record = await prepareEncryptedWalletBackupProof({
    keyHandle,
    seed,
    mint: proof.mint,
    unit: proof.unit,
    counter: proof.counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret: vector.expected.derivedSecretHex,
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
      async withCommittedProofSnapshot(proofId, read) {
        assert.equal(proofId, snapshot.recordId)
        return read({
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          revision: snapshot.snapshotRevision,
          proofId: snapshot.recordId,
          proofCommitment: snapshot.commitment,
          proofKind: 'ordinary',
          ctfMetadata: null,
          terminalOperationId: null,
          conditionalKeysetEvidence: null,
          provenance: 'wallet-seed',
          operationBinding: 'terminally-unlinked',
          reserved: false,
          ambiguousMintOperation: false,
          proofPins: {
            openOrderCollateral: 'absent',
            outbox: 'absent',
            retryCursor: 'absent',
            replayTombstone: 'absent',
            dependentWork: 'absent',
          },
          derivationLocator: 'committed',
        })
      },
    },
  })
  return {
    keyHandle,
    seed,
    realm: vector.inputs.realm,
    record,
    snapshot,
    snapshotStore: exactSnapshotStore(snapshot),
  }
}

function exactSnapshotStore(
  snapshot: EncryptedWalletBackupPreparedRecordSnapshot,
): EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      assert.equal(recordId, snapshot.recordId)
      return read(structuredClone(snapshot))
    },
  }
}

function cryptoRuntime() {
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target: Uint8Array) {
      return webcrypto.getRandomValues(target)
    },
  }
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16))
}
