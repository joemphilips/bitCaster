import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import {
  disconnectDaemonSigner,
  hasUnfinishedDaemonAccountWork,
  readSecrets,
} from '../src/secrets.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import type { DaemonServerOptions } from '../src/server.ts'

test('actual disconnected main retains pending account work and starts no authenticated background owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-signer-startup-')),
    directory = join(root, 'profile')
  const previousArgv = process.argv,
    previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  let options: DaemonServerOptions | undefined
  let hubStarts = 0,
    monitoringStarts = 0,
    rangeCalls = 0,
    fetchCalls = 0
  const exits: number[] = [],
    signals = new Map<string, () => void>()
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'http://localhost:8085',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    await createDaemonStateSqliteSession(directory).transaction((db) =>
      db
        .prepare(
          `INSERT INTO daemon_ctf_range_preparations
          (scope_id,range_operation_id,source_operation_id,authorization_id,client_order_id,order_route_id,
          normalized_mint,condition_id,unit,token_side,side,price_subunits,amount_subunits,minimum_fill_amount_subunits,
          consolidate_proofs,divisibility,authorization_expires_at_unix_seconds,preparation_body,lifecycle_state,revision,created_at_ms,updated_at_ms)
          VALUES (?,'range','source','authorization','client','condition-Yes','http://localhost:8085','condition','msat','Outcome','Buy',500,1000,1000,0,1000,2000000000,?,'prepared',0,0,0)`,
        )
        .run(profile.walletScopeId, Buffer.from('{}')),
    )
    updateNativeConfig((config) => ({
      ...config,
      daemon: {
        ...config.daemon,
        assetMonitoringEnabled: true,
        autoRetireResolvedConditionInventory: true,
      },
    }))
    await disconnectDaemonSigner(0)
    class Hub {
      async start() {
        hubStarts++
      }
      async stop() {}
      async trackOrder() {}
    }
    mock.module(new URL('../src/orderHubConnection.ts', import.meta.url).href, {
      namedExports: { SignalROrderLifecycleConnection: Hub },
    })
    mock.module(new URL('../src/marketHubConnection.ts', import.meta.url).href, {
      namedExports: { SignalRMarketHubConnection: Hub },
    })
    mock.module(new URL('../src/assetMonitoring.ts', import.meta.url).href, {
      namedExports: {
        createDaemonAssetMonitoring: () => ({
          start() {
            monitoringStarts++
          },
          stop() {},
        }),
      },
    })
    class Range {
      async recover() {
        rangeCalls++
        throw new Error('disconnected range recovery authenticated')
      }
    }
    mock.module(new URL('../src/ctfRangeOrderCoordinator.ts', import.meta.url).href, {
      namedExports: { DaemonCtfRangeOrderCoordinator: Range },
    })
    mock.module(new URL('../src/server.ts', import.meta.url).href, {
      namedExports: {
        startDaemonServer: async (input: DaemonServerOptions) => {
          options = input
          return {
            close(done: () => void) {
              done()
            },
          }
        },
      },
    })
    mock.method(globalThis, 'fetch', async () => {
      fetchCalls++
      throw new Error('disconnected startup attempted network I/O')
    })
    const once = process.once
    mock.method(
      process,
      'once',
      function (this: typeof process, event: string, listener: () => void) {
        if (event === 'SIGTERM' || event === 'SIGINT') {
          signals.set(event, listener)
          return this
        }
        return once.call(this, event, listener)
      },
    )
    mock.method(process, 'exit', (code: number) => {
      exits.push(code)
    })
    process.argv = [
      process.argv[0],
      new URL('../src/main.ts', import.meta.url).pathname,
      '--datadir',
      directory,
      'run',
    ]
    await import('../src/main.ts')
    assert.ok(options, 'main did not compose daemon server')
    assert.equal(options.isCustodyReady!(), false)
    assert.equal(await hasUnfinishedDaemonAccountWork(), true)
    await options.trackOwnedOrder!('condition-Yes', 'order')
    assert.equal(hubStarts, 0)
    assert.equal(monitoringStarts, 0)
    assert.equal(rangeCalls, 0)
    assert.equal(fetchCalls, 0)
    assert.ok(
      (await readSecrets())!.walletSeedHex === '11'.repeat(64),
      'startup changed wallet identity',
    )
    signals.get('SIGTERM')!()
    const deadline = Date.now() + 5000
    while (exits.length === 0) {
      assert.ok(Date.now() < deadline, 'main shutdown did not finish')
      await new Promise<void>((r) => setTimeout(r, 5))
    }
    assert.deepEqual(exits, [0])
    assert.equal(await hasUnfinishedDaemonAccountWork(), true)
  } finally {
    process.argv = previousArgv
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    mock.restoreAll()
    await rm(root, { recursive: true, force: true })
  }
})
