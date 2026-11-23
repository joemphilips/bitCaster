import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { writeState, emptyDaemonState } from '../src/state.ts'
import type { DaemonServerOptions } from '../src/server.ts'
import type { ResolvedConditionDiscovery } from '../src/managedConditionRetirement.ts'

const CONDITION = 'ab'.repeat(32)
const REGULAR_SEND = { method: 'wallet.send', params: { amountMsat: 1_000 } } as const
const ORDER_SUBMIT = { method: 'order.submit', params: { timeInForce: 'FOK' } } as const

test('a failed discovery does not hold funds, but an unfinished retirement does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-retirement-gate-')),
    directory = join(root, 'profile')
  const previousArgv = process.argv,
    previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  let options: DaemonServerOptions | undefined
  const exits: number[] = [],
    signals = new Map<string, () => void>()
  // The real dispatcher checks the readiness of the daemon that this test starts.
  const realRetirement = await import('../src/managedConditionRetirement.ts')
  const { dispatch } = await import('../src/server.ts')
  let discovery: ResolvedConditionDiscovery = {
    results: [],
    awaitingAttestation: [],
    // The engine is down: the read failed before a retirement started.
    discoveryFailures: [{ conditionId: CONDITION, error: 'engine request failed (HTTP 503)' }],
  }
  const scheduled: Array<() => void> = []
  const nextSchedule = () => new Promise<void>((resolve) => scheduled.push(resolve))
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'http://localhost:8085',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    await writeState(emptyDaemonState())
    updateNativeConfig((config) => ({
      ...config,
      daemon: { ...config.daemon, recoveryIndexRealm: 'disabled' },
    }))
    class Hub {
      async start() {}
      async stop() {}
      async trackOrder() {}
      async trackMarket() {}
      async setManagedMarkets() {}
    }
    mock.module(new URL('../src/orderHubConnection.ts', import.meta.url).href, {
      namedExports: { SignalROrderLifecycleConnection: Hub },
    })
    mock.module(new URL('../src/marketHubConnection.ts', import.meta.url).href, {
      namedExports: { SignalRMarketHubConnection: Hub },
    })
    class Range {
      async recover() {
        return { recovered: [], pending: [] }
      }
      recoveryStatus() {
        return { pending: [] }
      }
    }
    mock.module(new URL('../src/ctfRangeOrderCoordinator.ts', import.meta.url).href, {
      namedExports: { DaemonCtfRangeOrderCoordinator: Range },
    })
    mock.module(new URL('../src/managedConditionRetirement.ts', import.meta.url).href, {
      namedExports: {
        ...realRetirement,
        resumeDaemonConditionRetirements: async () => [],
        retireResolvedDaemonConditions: async () => discovery,
      },
    })
    // Each scheduled retry tells the test that the wake has set the readiness.
    mock.module(new URL('../src/conditionRetirementRetry.ts', import.meta.url).href, {
      namedExports: {
        createConditionRetirementRetry: () => ({
          schedule() {
            for (const resolve of scheduled.splice(0)) resolve()
          },
          reset() {},
          stop() {},
        }),
      },
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
      throw new Error('this test sends no network request')
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
    const firstScan = nextSchedule()
    await bounded(import('../src/main.ts'), 'daemon startup did not finish')
    assert.ok(options, 'main did not compose daemon server')
    await bounded(firstScan, 'the failed discovery did not schedule a retry')
    const gate = {
      isCustodyReady: options.isCustodyReady,
      getCustodyFence: options.getCustodyFence,
    }
    // After the gate, the command can fail for another reason, here the absent mint.
    const gateCode = (command: { readonly method: string }) =>
      dispatch(command as Parameters<typeof dispatch>[0], gate).then(
        (response) => response.code,
        (error: unknown) => `failed after the gate: ${String(error)}`,
      )
    assert.equal(options.isCustodyReady!(), true)
    for (const command of [REGULAR_SEND, ORDER_SUBMIT]) {
      assert.notEqual(await gateCode(command), 'custody-recovery-pending', command.method)
    }

    // A retirement that started and failed is unfinished work. It still holds funds.
    discovery = {
      results: [{ conditionId: CONDITION, error: 'mint request failed (HTTP 502)' }],
      awaitingAttestation: [],
      discoveryFailures: [],
    }
    const secondScan = nextSchedule()
    options.triggerSettlementRecovery!()
    await bounded(secondScan, 'the unfinished retirement did not schedule a retry')
    assert.equal(options.isCustodyReady!(), false)
    for (const command of [REGULAR_SEND, ORDER_SUBMIT]) {
      assert.equal(await gateCode(command), 'custody-recovery-pending', command.method)
    }

    signals.get('SIGTERM')!()
    await bounded(
      new Promise<void>((resolve) => {
        const check = () => (exits.length > 0 ? resolve() : setImmediate(check))
        check()
      }),
      'daemon shutdown did not finish',
    )
    assert.deepEqual(exits, [0])
  } finally {
    process.argv = previousArgv
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    mock.restoreAll()
    await rm(root, { recursive: true, force: true })
  }
})

/** A failed wait ends after 10 seconds instead of holding the test. */
async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
