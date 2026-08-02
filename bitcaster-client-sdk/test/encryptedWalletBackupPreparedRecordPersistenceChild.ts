import { webcrypto } from 'node:crypto'
import {
  createEncryptedWalletBackupKeyHandle,
  packEncryptedWalletBackupProofChunk,
} from '../src/encryptedWalletBackup.ts'
import {
  rehydratePreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from '../src/encryptedWalletBackupPreparedRecordPersistence.ts'

interface ChildInput {
  readonly seed: number[]
  readonly realm: string
  readonly persisted: Omit<
    PersistedPreparedEncryptedWalletBackupRecord,
    'canonicalRecord' | 'canonicalManifestEntry' | 'authenticationTag'
  > & {
    readonly canonicalRecord: number[]
    readonly canonicalManifestEntry: number[]
    readonly authenticationTag: number[]
  }
  readonly snapshot: EncryptedWalletBackupPreparedRecordSnapshot
}

const chunks: Buffer[] = []
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk))
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChildInput
const seed = Uint8Array.from(input.seed)
const keyHandle = await createEncryptedWalletBackupKeyHandle({
  seed,
  realm: input.realm,
  runtime: {
    subtle: webcrypto.subtle,
    getRandomValues(target) {
      return webcrypto.getRandomValues(target)
    },
  },
})
const record = await rehydratePreparedEncryptedWalletBackupRecord({
  keyHandle,
  seed,
  persisted: {
    ...input.persisted,
    canonicalRecord: Uint8Array.from(input.persisted.canonicalRecord),
    canonicalManifestEntry: Uint8Array.from(input.persisted.canonicalManifestEntry),
    authenticationTag: Uint8Array.from(input.persisted.authenticationTag),
  },
  snapshotStore: {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      if (recordId !== input.snapshot.recordId) {
        throw new Error('record id changed')
      }
      return read(structuredClone(input.snapshot))
    },
  },
})
process.stdout.write(JSON.stringify(packEncryptedWalletBackupProofChunk([record]).bindings))
