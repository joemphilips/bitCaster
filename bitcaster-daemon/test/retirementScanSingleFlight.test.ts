import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { writeState, emptyDaemonState } from '../src/state.ts'
import type { DaemonServerOptions } from '../src/server.ts'

const CONDITION = 'ab'.repeat(32)
const MINT_FAILURE = 'mint request failed (HTTP 502)'

test('overlapping wakes run one retirement scan at a time and keep an unfinished retirement pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-retirement-single-flight-')),
    directory = join(root, 'profile')
  const previousArgv = process.argv,
    previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  let options: DaemonServerOptions | undefined
  const exits: number[] = [],
    signals = new Map<string, () => void>()
  const realRetirement = await import('../src/managedConditionRetirement.ts')
  // The first discovery starts the retirement of the condition and waits on a
  // barrier. It then fails at the mint, so the retirement stays unfinished.
  let releaseFirst!: () => void
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve))
  let markFirstCalled!: () => void
  const firstCalled = new Promise<void>((resolve) => (markFirstCalled = resolve))
  let unfinished = false
  let discoveries = 0
  let running = 0
  let maxRunning = 0
  // Each scan pass ends with a schedule or a reset of the retry.
  let passes = 0
  let schedules = 0
  let resets = 0
  let discoveryThrows = false
  const passWaiters: Array<() => void> = []
  const passesDone = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => (passes >= count ? resolve() : passWaiters.push(check))
      check()
    })
  const passDone = () => {
    passes += 1
    for (const check of passWaiters.splice(0)) check()
  }
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
    const hubOptions: Array<Record<string, unknown>> = []
    class Hub {
      constructor(hubOption: Record<string, unknown>) {
        hubOptions.push(hubOption)
      }
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
        // A started retirement is listed as retiring, so each later resume retries it.
        resumeDaemonConditionRetirements: async () =>
          unfinished ? [{ conditionId: CONDITION, error: MINT_FAILURE }] : [],
        retireResolvedDaemonConditions: async () => {
          if (discoveryThrows) throw new Error('condition store is unavailable')
          discoveries += 1
          running += 1
          maxRunning = Math.max(maxRunning, running)
          try {
            if (discoveries === 1) {
              markFirstCalled()
              await firstReleased
              unfinished = true
              return {
                results: [{ conditionId: CONDITION, error: MINT_FAILURE }],
                awaitingAttestation: [],
                discoveryFailures: [],
              }
            }
            // The proofs of the condition are reserved, so a scan does not discover it again.
            return { results: [], awaitingAttestation: [], discoveryFailures: [] }
          } finally {
            running -= 1
          }
        },
      },
    })
    mock.module(new URL('../src/conditionRetirementRetry.ts', import.meta.url).href, {
      namedExports: {
        createConditionRetirementRetry: () => ({
          schedule: () => {
            schedules += 1
            passDone()
          },
          reset: () => {
            resets += 1
            passDone()
          },
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
    await bounded(import('../src/main.ts'), 'daemon startup did not finish')
    assert.ok(options, 'main did not compose daemon server')
    // The first wake after the listen is in its discovery. A market close wakes
    // the scan again now. That wake ends before the first pass ends.
    await bounded(firstCalled, 'the first scan did not start')
    const marketHub = hubOptions.find((hub) => 'onMarketStatusChanged' in hub) as {
      onMarketStatusChanged: (status: unknown) => Promise<void>
    }
    await bounded(
      marketHub.onMarketStatusChanged({
        conditionId: CONDITION,
        state: 'closed',
        closedAt: new Date().toISOString(),
        finalOutcome: null,
      }),
      'the second wake did not end',
    )
    releaseFirst()
    // Both wakes end: the first pass, then one more pass for the wake during it.
    await bounded(passesDone(2), 'the scans did not finish')
    assert.equal(maxRunning, 1, 'two retirement scans ran at the same time')
    assert.equal(discoveries, 2)
    // The unfinished retirement holds the funds commands until a retry finishes it.
    assert.equal(options.isCustodyReady!(), false)
    // Each pass, also the last one, found unfinished work, so each scheduled the retry.
    assert.deepEqual({ schedules, resets }, { schedules: 2, resets: 0 })

    // A clean pass opens the gate and resets the retry.
    unfinished = false
    const close = {
      conditionId: CONDITION,
      state: 'closed',
      closedAt: new Date().toISOString(),
      finalOutcome: null,
    }
    // A wake can join a drain that still ends its last pass, so the test waits
    // for the passes, not for the wake.
    void marketHub.onMarketStatusChanged(close).catch(() => undefined)
    await bounded(passesDone(3), 'the clean pass did not end')
    assert.deepEqual({ schedules, resets }, { schedules: 2, resets: 1 })
    assert.equal(options.isCustodyReady!(), true)

    // A pass that throws keeps the gate closed and schedules the retry.
    discoveryThrows = true
    void marketHub.onMarketStatusChanged(close).catch(() => undefined)
    await bounded(passesDone(4), 'the throwing pass did not end')
    assert.deepEqual({ schedules, resets }, { schedules: 3, resets: 1 })
    assert.equal(options.isCustodyReady!(), false)

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
    releaseFirst()
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
