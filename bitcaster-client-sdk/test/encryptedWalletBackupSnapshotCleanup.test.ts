import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceEncryptedWalletBackupSnapshotCleanup,
  decodeEncryptedWalletBackupSnapshotCleanupJob,
  startEncryptedWalletBackupSnapshotCleanup,
} from '../src/encryptedWalletBackupSnapshotCleanup.ts'

const vaultId = '11'.repeat(32)

function job() {
  return decodeEncryptedWalletBackupSnapshotCleanupJob({
    schemaVersion: 1,
    realm: 'cleanup.test',
    vaultId,
    acknowledgedGeneration: 2,
    localSnapshotId: 'current',
    localSnapshotRevision: 3,
    phase: 'snapshot-pins',
    cursor: null,
  })
}

test('cleanup state rejects malformed and substituted authority', () => {
  assert.throws(
    () =>
      decodeEncryptedWalletBackupSnapshotCleanupJob({
        schemaVersion: 1,
        realm: 'cleanup.test',
        vaultId,
        acknowledgedGeneration: 2,
        localSnapshotId: 'current',
        localSnapshotRevision: 3,
        phase: 'snapshot-pins',
        cursor: {
          phase: 'manifest-pages',
          generation: 1,
          snapshotId: 'obsolete',
          snapshotRevision: 0,
          pageIndex: 0,
        },
      }),
    /cursor phase/,
  )
  assert.throws(() => startEncryptedWalletBackupSnapshotCleanup({} as never), /acknowledgement/)
})

test('cleanup state keeps the exact persisted cursor and rejects a rewind', () => {
  const first = advanceEncryptedWalletBackupSnapshotCleanup(job(), {
    readRows: 1,
    deletedRows: 1,
    readBytes: 32,
    phaseComplete: false,
    nextCursor: {
      phase: 'snapshot-pins',
      generation: 1,
      snapshotId: 'obsolete',
      snapshotRevision: 0,
      recordId: '22'.repeat(32),
      commitment: '33'.repeat(32),
    },
  })
  assert.notEqual(first, null)
  assert.equal(first.cursor?.phase, 'snapshot-pins')
  assert.throws(
    () =>
      advanceEncryptedWalletBackupSnapshotCleanup(first, {
        readRows: 1,
        deletedRows: 0,
        readBytes: 1,
        phaseComplete: false,
        nextCursor: first.cursor,
      }),
    /did not advance/,
  )
})

test('cleanup cursor order matches IndexedDB string-key order', () => {
  const current = decodeEncryptedWalletBackupSnapshotCleanupJob({
    schemaVersion: 1,
    realm: 'cleanup.test',
    vaultId,
    acknowledgedGeneration: 2,
    localSnapshotId: 'current',
    localSnapshotRevision: 3,
    phase: 'snapshot-controls',
    cursor: {
      phase: 'snapshot-controls',
      generation: 1,
      snapshotId: 'Z',
      snapshotRevision: 0,
    },
  })
  const advanced = advanceEncryptedWalletBackupSnapshotCleanup(current, {
    readRows: 1,
    deletedRows: 0,
    readBytes: 1,
    phaseComplete: false,
    nextCursor: {
      phase: 'snapshot-controls',
      generation: 1,
      snapshotId: 'a',
      snapshotRevision: 0,
    },
  })
  assert.equal(advanced?.cursor?.snapshotId, 'a')
})
