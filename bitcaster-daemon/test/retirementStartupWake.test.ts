import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { writeState, emptyDaemonState } from '../src/state.ts'
import type { DaemonServerOptions } from '../src/server.ts'

test('a wake before the listen only records itself, and the first scan after the listen serves it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-retirement-startup-wake-')),
    directory = join(root, 'profile')
  const previousArgv = process.argv,
    previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  let options: DaemonServerOptions | undefined
  let listening = false
  const exits: number[] = [],
    signals = new Map<string, () => void>()
  const realRetirement = await import('../src/managedConditionRetirement.ts')
  // The startup range recovery defers work, so its loop runs again at once and
  // wakes the retirement scan while startup still resumes the retirements.
  let rangePasses = 0
  let markRangeRerun!: () => void
  const rangeRerun = new Promise<void>((resolve) => (markRangeRerun = resolve))
  const discoveryListening: boolean[] = []
  let markDiscovered!: () => void
  const discovered = new Promise<void>((resolve) => (markDiscovered = resolve))
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
        rangePasses += 1
        if (rangePasses === 1) return { recovered: [], pending: [], deferredCount: 1 }
        // The loop calls its result handler in the same microtask chain, before this callback.
        setImmediate(markRangeRerun)
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
        // Startup waits here until the range loop has run again and has woken the scan.
        resumeDaemonConditionRetirements: async () => {
          await rangeRerun
          return []
        },
        retireResolvedDaemonConditions: async () => {
          discoveryListening.push(listening)
          markDiscovered()
          return {
            results: [],
            awaitingAttestation: [],
            discoveryFailures: [],
            nextMaturityMs: null,
          }
        },
      },
    })
    mock.module(new URL('../src/conditionRetirementRetry.ts', import.meta.url).href, {
      namedExports: {
        createConditionRetirementRetry: () => ({
          schedule() {},
          wakeAt() {},
          reset() {},
          stop() {},
        }),
      },
    })
    mock.module(new URL('../src/server.ts', import.meta.url).href, {
      namedExports: {
        startDaemonServer: async (input: DaemonServerOptions) => {
          options = input
          listening = true
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
    await bounded(import('../src/main.ts'), 'daemon startup did not finish')
    assert.ok(options, 'main did not compose daemon server')
    assert.ok(rangePasses >= 2, 'the startup range loop did not run again')
    await bounded(discovered, 'no retirement scan ran after the listen')
    assert.deepEqual(
      discoveryListening.filter((afterListen) => !afterListen),
      [],
      'a retirement scan read the mint before the listen',
    )

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
    markRangeRerun()
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
