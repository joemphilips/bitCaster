import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from '../src/durableCustodyUnitOfWork.ts'
import { createDaemonStateSqliteSession, openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { createSeedRecoveryProfile } from './seedRecoveryTestSupport.ts'
import type { CustodyScopeFence } from '../src/profileFencing.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-read-snapshot-'))
  const { fence } = await createSeedRecoveryProfile({
    directory,
    walletSeedHex: 'a1'.repeat(64),
    nostrSecretKeyHex: 'b2'.repeat(32),
    incarnationId: 'read-snapshot-original-owner',
  })
  const storage = createDaemonStateSqliteSession(directory)
  await storage.read(() => undefined)
  return { directory, fence, storage }
}

test('one read snapshot survives real fence takeover but cannot authorize a later write', async () => {
  const { directory, fence, storage } = await fixture()
  try {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    let successor: CustodyScopeFence | undefined
    const observed = await withDurableCustodyFencedRead(
      storage,
      fence,
      3,
      (database) => {
        const before = database
          .prepare('SELECT fencing_epoch AS epoch FROM custody_scope_state')
          .get()!.epoch
        // This synchronous test barrier invokes the production writer on a second connection.
        const child = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            join(import.meta.dirname, 'fixtures/readSnapshotTakeover.ts'),
            directory,
            fence.scopeId,
            String(fence.leaseExpiresAtMs + 1),
          ],
          { env, timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8' },
        )
        assert.ifError(child.error)
        assert.equal(child.status, 0, child.stderr)
        successor = JSON.parse(child.stdout) as CustodyScopeFence
        const after = database
          .prepare('SELECT fencing_epoch AS epoch FROM custody_scope_state')
          .get()!.epoch
        return { before, after }
      },
      { snapshot: true },
    )
    assert.deepEqual(observed, { before: fence.fencingEpoch, after: fence.fencingEpoch })
    assert.equal(successor!.fencingEpoch, fence.fencingEpoch + 1)
    await assert.rejects(
      withDurableCustodyUnitOfWork(storage, fence, fence.leaseExpiresAtMs + 2, (database) =>
        database.exec('UPDATE custody_scope_state SET high_water_mark_ms=999999'),
      ),
      /stale or expired authority/,
    )
    assert.equal(
      await withDurableCustodyFencedRead(
        storage,
        successor!,
        fence.leaseExpiresAtMs + 2,
        (database) =>
          database.prepare('SELECT fencing_epoch AS epoch FROM custody_scope_state').get()!.epoch,
        { snapshot: true },
      ),
      successor!.fencingEpoch,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('snapshot failures roll back and async callbacks refuse before invocation', async () => {
  const { directory, fence, storage } = await fixture()
  try {
    let called = false
    await assert.rejects(
      withDurableCustodyFencedRead(
        storage,
        fence,
        3,
        async () => {
          called = true
        },
        { snapshot: true },
      ),
      /synchronous callback/,
    )
    assert.equal(called, false)
    await assert.rejects(
      withDurableCustodyFencedRead(storage, fence, 3, () => Promise.resolve('not synchronous'), {
        snapshot: true,
      }),
      /synchronous callback/,
    )
    await assert.rejects(
      withDurableCustodyFencedRead(
        storage,
        fence,
        3,
        () => Promise.reject(new Error('rejected callback work')),
        { snapshot: true },
      ),
      /synchronous callback/,
    )
    await assert.rejects(
      withDurableCustodyFencedRead(
        storage,
        fence,
        3,
        () => {
          throw new Error('read failed')
        },
        { snapshot: true },
      ),
      /read failed/,
    )
    await withDurableCustodyUnitOfWork(storage, fence, 4, () => undefined)
    assert.equal(
      await withDurableCustodyFencedRead(storage, fence, 4, () => 'readable', { snapshot: true }),
      'readable',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('nested snapshot refusal preserves the transaction owned by its caller', async () => {
  const { directory, fence } = await fixture()
  const database = await openDaemonStateSqlite(directory)
  try {
    database.exec('BEGIN')
    const nested = {
      read: async <T>(action: (db: typeof database) => T) => action(database),
      transaction: async () => {
        throw new Error('unexpected transaction')
      },
    }
    await assert.rejects(
      withDurableCustodyFencedRead(nested, fence, 3, () => undefined, { snapshot: true }),
      /within a transaction/,
    )
    // This must succeed: the refused nested BEGIN did not roll back our transaction.
    database.exec('ROLLBACK')
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('the shared fenced-read default retains its existing caller-owned transaction behavior', async () => {
  const { directory, fence, storage } = await fixture()
  try {
    assert.equal(
      await withDurableCustodyFencedRead(storage, fence, 3, (database) => {
        database.exec('BEGIN')
        database.exec('ROLLBACK')
        return 'default unchanged'
      }),
      'default unchanged',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
