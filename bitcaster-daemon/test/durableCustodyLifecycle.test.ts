import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { DurableCustodyStore } from '@bitcaster-market/client-sdk/durableCustody'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'
import { profileDatabasePath } from '../src/profile.ts'

const WALLET_SEED_HEX = '07'.repeat(32)

test('daemon custody ownership is seed-scoped and preserves fencing across release', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    const scope = daemonWalletCustodyScope(WALLET_SEED_HEX)
    await store.registerScope(scope)
    let now = 1_000
    const first = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: WALLET_SEED_HEX,
      incarnationId: 'process-one',
      nowMs: () => now,
      leaseDurationMs: 1_000,
      renewAfterMs: 500,
    })
    assert.equal(first.authorization().fencingEpoch, 1)
    await first.stopAndRelease()

    now += 1
    const second = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: WALLET_SEED_HEX,
      incarnationId: 'process-two',
      nowMs: () => now,
      leaseDurationMs: 1_000,
      renewAfterMs: 500,
    })
    assert.equal(second.authorization().fencingEpoch, 2)
    await second.stopAndRelease()
  })
})

test('daemon startup waits fail-closed for a crashed owner lease before takeover', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    await store.registerScope(daemonWalletCustodyScope(WALLET_SEED_HEX))
    let now = 1_000
    await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: WALLET_SEED_HEX,
      incarnationId: 'crashed-process',
      nowMs: () => now,
      leaseDurationMs: 1_000,
      renewAfterMs: 500,
    })
    const waits: number[] = []

    const successor = await DaemonDurableCustodyLease.claimAfterPreviousLease({
      store,
      walletSeedHex: WALLET_SEED_HEX,
      incarnationId: 'successor-process',
      nowMs: () => now,
      leaseDurationMs: 1_000,
      renewAfterMs: 500,
      sleep: async (delayMs) => {
        waits.push(delayMs)
        now += delayMs
      },
    })

    assert.deepEqual(waits, [500, 500])
    assert.equal(successor.authorization().fencingEpoch, 2)
    assert.equal(successor.incarnationId, 'successor-process')
    await successor.stopAndRelease()
  })
})

test('daemon takeover never recreates missing seed-scoped fencing authority', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    const scope = daemonWalletCustodyScope(WALLET_SEED_HEX)
    await store.registerScope(scope)
    const first = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: WALLET_SEED_HEX,
    })
    assert.equal(first.authorization().fencingEpoch, 1)
    await first.stopAndRelease()
    const database = new DatabaseSync(profileDatabasePath())
    database.exec('PRAGMA foreign_keys = ON')
    database.prepare('DELETE FROM custody_scope_state WHERE scope_id = ?').run(
      scope.scopeId,
    )
    database.prepare('DELETE FROM custody_scopes WHERE scope_id = ?').run(
      scope.scopeId,
    )
    database.close()

    await assert.rejects(
      DaemonDurableCustodyLease.claimAfterPreviousLease({
        store,
        walletSeedHex: WALLET_SEED_HEX,
      }),
      /custody scope is missing/,
    )
    assert.equal(await store.readScope(scope), null)
  })
})

test('daemon takeover rejects non-finite timing before polling custody state', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    await store.registerScope(daemonWalletCustodyScope(WALLET_SEED_HEX))
    await assert.rejects(
      DaemonDurableCustodyLease.claimAfterPreviousLease({
        store,
        walletSeedHex: WALLET_SEED_HEX,
        takeoverTimeoutMs: Number.NaN,
      }),
      /takeover timeout is invalid/,
    )
  })
})

test('daemon custody effects fail closed after lease renewal is lost', async () => {
  await withDaemonHome(async () => {
    const baseStore = new SqliteDurableCustodyStore()
    await baseStore.registerScope(daemonWalletCustodyScope(WALLET_SEED_HEX))
    const store = new Proxy(baseStore, {
      get(target, property, receiver) {
        if (property === 'renewScope') {
          return async () => {
            throw new Error('injected renewal failure')
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as DurableCustodyStore
    const lease = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: WALLET_SEED_HEX,
      nowMs: () => 1_000,
      leaseDurationMs: 100,
      renewAfterMs: 5,
    })
    let renewalFailure: Error | undefined
    lease.startRenewal((error) => {
      renewalFailure = error
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.match(renewalFailure?.message ?? '', /renewal failure/)
    assert.throws(() => lease.authorization(), /renewal failure/)
    await lease.stopAndRelease()
  })
})

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-lease-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}
