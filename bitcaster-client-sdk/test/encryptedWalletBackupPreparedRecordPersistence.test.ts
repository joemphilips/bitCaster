import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupProof,
} from '../src/encryptedWalletBackup.ts'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '../src/durableCustody.ts'
import {
  rehydratePreparedEncryptedWalletBackupRecord,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../src/encryptedWalletBackupPreparedRecordPersistence.ts'

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
