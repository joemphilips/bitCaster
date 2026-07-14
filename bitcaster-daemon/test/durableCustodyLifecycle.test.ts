import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { DurableCustodyStore } from '@bitcaster-market/client-sdk/durableCustody'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'

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
