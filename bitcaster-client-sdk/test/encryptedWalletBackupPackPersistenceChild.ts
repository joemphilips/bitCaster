import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createEncryptedWalletBackupKeyHandle } from '../src/encryptedWalletBackup.ts'
import {
  rehydrateEncryptedWalletBackupStagedPackObject,
  type EncryptedWalletBackupPackPersistenceStore,
  type EncryptedWalletBackupPackPersistenceTransaction,
  type PersistedEncryptedWalletBackupBuildCursor,
  type PersistedEncryptedWalletBackupPackControl,
  type PersistedEncryptedWalletBackupStagedObject,
} from '../src/encryptedWalletBackupPackPersistence.ts'

interface RestartWire {
  readonly seed: number[]
  readonly realm: string
  readonly build: PersistedEncryptedWalletBackupBuildCursor
  readonly pack: PersistedEncryptedWalletBackupPackControl
  readonly rows: readonly {
    recordId: string
    binding: number[]
    prepared: number[]
  }[]
  readonly snapshots: readonly {
    schemaVersion: 1
    snapshotId: string
    snapshotRevision: number
    recordId: string
    commitment: string
    recordKindCode: 0
  }[]
  readonly staged: Omit<PersistedEncryptedWalletBackupStagedObject, 'aad' | 'body'> & {
    readonly aad: number[]
    readonly body: number[]
  }
}

const wire = JSON.parse(readFileSync(0, 'utf8')) as RestartWire
const seed = Uint8Array.from(wire.seed)
const keyHandle = await createEncryptedWalletBackupKeyHandle({
  seed,
  realm: wire.realm,
  runtime: {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      return webcrypto.getRandomValues(target)
    },
  },
})
const staged: PersistedEncryptedWalletBackupStagedObject = {
  ...wire.staged,
  aad: Uint8Array.from(wire.staged.aad),
  body: Uint8Array.from(wire.staged.body),
}
const store: EncryptedWalletBackupPackPersistenceStore = {
  async withExactVersionTransaction(expected, use) {
    if (
      expected.buildId !== wire.build.buildId ||
      expected.buildVersion !== wire.build.version ||
      expected.packId !== wire.pack.packId ||
      expected.packVersion !== wire.pack.version ||
      expected.realm !== wire.build.realm ||
      expected.vaultId !== wire.build.vaultId ||
      expected.snapshotId !== wire.build.snapshotId ||
      expected.snapshotRevision !== wire.build.snapshotRevision
    )
      throw new Error('restart CAS identity changed')
    const transaction: EncryptedWalletBackupPackPersistenceTransaction = {
      readBuildCursor: async () => structuredClone(wire.build),
      readPackControl: async () => structuredClone(wire.pack),
      readPackRecordPage: async (_buildId, _packId, afterRecordId, limit, maxBytes) => {
        const result: { binding: Uint8Array; prepared: Uint8Array }[] = []
        let serializedBytes = 0
        for (const row of wire.rows) {
          if (afterRecordId !== null && row.recordId <= afterRecordId) continue
          if (result.length === limit) break
          const nextBytes = row.binding.length + row.prepared.length
          if (serializedBytes + nextBytes > maxBytes) break
          serializedBytes += nextBytes
          result.push({
            binding: Uint8Array.from(row.binding),
            prepared: Uint8Array.from(row.prepared),
          })
        }
        return { rows: result, serializedBytes }
      },
      readStagedObject: async () => structuredClone(staged),
      insertPreparedRecord: async () => {
        throw new Error('restart attempted a write')
      },
      insertPackBinding: async () => {
        throw new Error('restart attempted a write')
      },
      writeBuildCursor: async () => {
        throw new Error('restart attempted a write')
      },
      writePackControl: async () => {
        throw new Error('restart attempted a write')
      },
      insertStagedObject: async () => {
        throw new Error('restart attempted a write')
      },
    }
    return use(transaction)
  },
}
const snapshotStore = {
  async withCommittedPreparedRecordSnapshotBatch(
    recordIds: readonly string[],
    read: (
      rows: readonly {
        schemaVersion: 1
        snapshotId: string
        snapshotRevision: number
        recordId: string
        commitment: string
        recordKindCode: 0
      }[],
    ) => unknown,
  ) {
    return read(
      recordIds.map((recordId) => {
        const snapshot = wire.snapshots.find((candidate) => candidate.recordId === recordId)
        if (snapshot === undefined) throw new Error('restart snapshot is missing')
        return structuredClone(snapshot)
      }),
    )
  },
}
const result = await rehydrateEncryptedWalletBackupStagedPackObject({
  store,
  keyHandle,
  seed,
  snapshotStore,
  buildId: wire.build.buildId,
  packId: wire.pack.packId,
  snapshotId: wire.build.snapshotId,
  snapshotRevision: wire.build.snapshotRevision,
  expectedBuildVersion: wire.build.version,
  expectedPackVersion: wire.pack.version,
})
process.stdout.write(
  JSON.stringify({
    buildId: result.buildId,
    packId: result.packId,
    objectId: result.object.objectId,
    digest: result.object.digest,
  }),
)
