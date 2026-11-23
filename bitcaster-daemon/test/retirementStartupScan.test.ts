import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { addAvailableProofs, writeState, emptyDaemonState } from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import type { DaemonServerOptions } from '../src/server.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const MINT = 'http://localhost:8085'
const HELD = 'ab'.repeat(32)
const HISTORY = 'cd'.repeat(32)
const BOUGHT = 'ef'.repeat(32)
const KEYSET_ID = canonicalTestKeysetId('retirement-startup-scan')

test('the daemon listens before the automatic retirement reads the engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-retirement-startup-')),
    directory = join(root, 'profile')
  const previousArgv = process.argv,
    previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  let options: DaemonServerOptions | undefined
  const managedMarkets: string[][] = []
  const attestationReads: string[] = []
  const otherRequests: string[] = []
  const exits: number[] = [],
    signals = new Map<string, () => void>()
  let releaseEngine!: () => void
  const engineReleased = new Promise<void>((resolve) => (releaseEngine = resolve))
  let markEngineRead!: () => void
  const engineRead = new Promise<void>((resolve) => (markEngineRead = resolve))
  let markBoughtRead!: () => void
  const boughtRead = new Promise<void>((resolve) => (markBoughtRead = resolve))
  const hubOptions: Array<Record<string, unknown>> = []
  let retryRun: (() => void) | undefined
  let retrySchedules = 0
  const scheduleWaiters: Array<() => void> = []
  const scheduledAfter = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => (retrySchedules > count ? resolve() : scheduleWaiters.push(check))
      check()
    })
  const readWaiters: Array<{ conditionId: string; resolve: () => void }> = []
  const nextRead = (conditionId: string) =>
    new Promise<void>((resolve) => readWaiters.push({ conditionId, resolve }))
  let imported: Promise<unknown> | undefined
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: MINT,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    await writeState(emptyDaemonState())
    for (const [conditionId, secret] of [
      [HELD, 'held-proof'],
      [HISTORY, 'history-proof'],
    ] as const) {
      await addAvailableProofs(
        MINT,
        [{ id: KEYSET_ID, amount: 1, secret, C: `02${'11'.repeat(32)}` }],
        {
          kind: 'Outcome',
          conditionId,
          outcomeSetId: 'YES',
          baseAsset: 'sat',
          unit: 'msat',
        },
      )
    }
    // A retained losing proof is history: the scan and the market watch ignore it.
    const database = await openDaemonStateSqlite(directory)
    try {
      database
        .prepare(
          `UPDATE target_wallet_proofs SET state = 'locked', reserved_by = 'retained:history'
           WHERE condition_id = ?`,
        )
        .run(HISTORY)
    } finally {
      database.close()
    }
    // The default turns the automatic retirement on. The realm setting keeps
    // the backup writer off the network.
    updateNativeConfig((config) => ({
      ...config,
      daemon: { ...config.daemon, recoveryIndexRealm: 'disabled' },
    }))
    class Hub {
      constructor(options: Record<string, unknown>) {
        hubOptions.push(options)
      }
      async start() {}
      async stop() {}
      async trackOrder() {}
      async trackMarket() {}
      async setManagedMarkets(marketIds: readonly string[]) {
        managedMarkets.push([...marketIds])
      }
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
    // The test runs each retry itself instead of waiting 30 seconds.
    mock.module(new URL('../src/conditionRetirementRetry.ts', import.meta.url).href, {
      namedExports: {
        createConditionRetirementRetry: (input: { run: () => void }) => {
          retryRun = input.run
          return {
            schedule() {
              retrySchedules += 1
              for (const check of scheduleWaiters.splice(0)) check()
            },
            reset() {},
            stop() {},
          }
        },
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
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const match = /^\/api\/v1\/conditions\/([0-9a-f]{64})\/attestation$/.exec(url.pathname)
      if (match === null) {
        otherRequests.push(url.pathname)
        throw new Error('unexpected startup request')
      }
      attestationReads.push(match[1]!)
      if (match[1] === BOUGHT) markBoughtRead()
      for (const waiter of readWaiters.splice(0)) {
        if (waiter.conditionId === match[1]) waiter.resolve()
        else readWaiters.push(waiter)
      }
      markEngineRead()
      // The barrier holds the engine read until the test has checked the listen.
      await engineReleased
      return new Response(null, { status: 404 })
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
    imported = import('../src/main.ts')
    await bounded(engineRead, 'the automatic retirement did not read the engine')
    assert.ok(options, 'the daemon must listen before the engine read ends')
    // Discovery is new work, not the recovery of unfinished work, so it does not block funds.
    assert.equal(options.isCustodyReady!(), true)
    releaseEngine()
    await bounded(imported, 'daemon startup did not finish')
    assert.deepEqual(attestationReads, [HELD])
    assert.deepEqual(managedMarkets.at(-1), [`${HELD}-YES`])

    // An order fill adds a position while the daemon runs. The next automatic
    // wake, here after a settlement recovery pass, watches its market too.
    await addAvailableProofs(
      MINT,
      [{ id: KEYSET_ID, amount: 1, secret: 'bought-proof', C: `02${'11'.repeat(32)}` }],
      { kind: 'Outcome', conditionId: BOUGHT, outcomeSetId: 'YES', baseAsset: 'sat', unit: 'msat' },
    )
    options.triggerSettlementRecovery!()
    await bounded(boughtRead, 'the wake after a recovery pass did not read the bought condition')
    assert.deepEqual(managedMarkets.at(-1), [`${HELD}-YES`, `${BOUGHT}-YES`])

    // The engine reports the close before the attestation is readable. The
    // scan does not skip the condition: it schedules a retry, which reads it again.
    const marketHub = hubOptions.find((hub) => 'onMarketStatusChanged' in hub) as {
      onMarketStatusChanged: (status: unknown) => Promise<void>
    }
    const schedulesBefore = retrySchedules
    await marketHub.onMarketStatusChanged({
      conditionId: HELD,
      state: 'closed',
      closedAt: new Date().toISOString(),
      finalOutcome: null,
    })
    // The wake can join a pass that still runs. The retry comes when that pass ends.
    await bounded(scheduledAfter(schedulesBefore), 'the closed condition did not get a retry')
    const retried = nextRead(HELD)
    retryRun!()
    await bounded(retried, 'the retry did not read the closed condition again')
    assert.deepEqual(otherRequests, [])
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
    releaseEngine()
    await imported?.catch(() => undefined)
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
