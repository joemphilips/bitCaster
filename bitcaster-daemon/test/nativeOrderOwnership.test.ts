import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  EngineClientError,
  type OrderStatusResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import type { AssetMonitoringReportRequest } from '@bitcaster-market/client-sdk'
import { createDaemonAssetMonitoring } from '../src/assetMonitoring.ts'
import { DaemonCtfRangeOrderCoordinator } from '../src/ctfRangeOrderCoordinator.ts'
import { NATIVE_RANGE_ORDER_OWNERSHIP_SQL } from '../src/ctfRangeOrderJournalSqlite.ts'
import { NativeActivitySqlite } from '../src/nativeActivitySqlite.ts'
import { claimCustodyScopeLease, releaseCustodyScopeLease } from '../src/profileFencing.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { readSecrets } from '../src/secrets.ts'
import { dispatch, type DispatchDependencies, type EngineClientLike } from '../src/server.ts'
import { readState, recordSubmittedOrder } from '../src/state.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { retainNativeOrderLink } from './support/nativeOrderOwnership.ts'

const ORDER_ID = '44444444-4444-4444-8444-444444444444'
const MARKET_ID = 'condition-1-YES'
const CLIENT_ID = 'client-a'
const status = {
  orderId: ORDER_ID,
  marketId: MARKET_ID,
  clientOrderId: CLIENT_ID,
  status: 'matched',
  baseAsset: 'sat',
  divisibility: 1_000,
  remainingAmountSubunits: 1_000,
  filledAmountSubunits: 0,
  fills: [],
  amountSubunits: 1_000,
  outcomeId: 'YES',
  side: 'Buy',
  price: 500,
  placedAt: '2026-10-04T00:00:00.000Z',
  timeInForce: 'FOK',
  activeSettlementGroup: null,
  tokenSide: 'Outcome',
} satisfies OrderStatusResponse & { clientOrderId: string }

test('confirmed order fills enter only the linked wallet Activity feed once', async () => {
  await withWallets(async (a, b) => {
    const fillId = '55555555-5555-4555-8555-555555555555'
    const filled = {
      ...status,
      status: 'filled' as const,
      filledAmountSubunits: 1_000,
      remainingAmountSubunits: 0,
      fills: [
        {
          id: fillId,
          makerOrderId: '66666666-6666-4666-8666-666666666666',
          takerOrderId: ORDER_ID,
          amountSubunits: 1_000,
          executionPrice: 500,
          path: 'Mint' as const,
          status: 'Filled' as const,
          filledAt: '2026-10-04T00:00:01.000Z',
          settlementGroup: {
            groupId: '77777777-7777-4777-8777-777777777777',
            status: 'Confirmed' as const,
            revision: 1,
            coalescingDeadline: '2026-10-04T00:00:00.000Z',
            frozenAt: '2026-10-04T00:00:00.000Z',
          },
          baseAsset: 'sat' as const,
          divisibility: 1_000 as const,
          tokenSide: 'Outcome' as const,
          quotePaymentSubunits: 500,
          outcomeFaceAmountSubunits: 1_000,
        },
      ],
    }
    process.env.BITCASTER_DAEMON_HOME = a.directory
    await retainNativeOrderLink(a.directory, a.scopeId, ORDER_ID, MARKET_ID, CLIENT_ID)
    await recordSubmittedOrder(
      MARKET_ID,
      CLIENT_ID,
      filled,
      null,
      'Outcome',
      'Buy',
      500,
      1_000,
      'sat',
      1_000,
    )
    const first = await createDaemonStateSqliteSession(a.directory).read((database) =>
      new NativeActivitySqlite(database).page({
        walletId: a.scopeId.slice('custody:wallet:'.length),
      }),
    )
    assert.equal(first.items.length, 1)
    assert.equal(first.items[0]?.id, `trade:${a.scopeId.slice('custody:wallet:'.length)}:${fillId}`)
    assert.equal(first.items[0]?.amountSubunits, 500)
    assert.equal(first.items[0]?.tradeDetails?.faceAmountSubunits, 1_000)
    await recordSubmittedOrder(MARKET_ID, CLIENT_ID, filled)
    const repeated = await createDaemonStateSqliteSession(a.directory).read((database) =>
      new NativeActivitySqlite(database).page({
        walletId: a.scopeId.slice('custody:wallet:'.length),
      }),
    )
    assert.equal(repeated.items.length, 1)

    process.env.BITCASTER_DAEMON_HOME = b.directory
    await recordSubmittedOrder(MARKET_ID, CLIENT_ID, filled)
    const foreign = await createDaemonStateSqliteSession(b.directory).read((database) =>
      new NativeActivitySqlite(database).page({
        walletId: b.scopeId.slice('custody:wallet:'.length),
      }),
    )
    assert.equal(foreign.items.length, 0)
  })
})

for (const method of ['order.status', 'order.cancel'] as const) {
  test(`${method} keeps account access separate from two wallet seeds and restart`, async () => {
    await withWallets(async (a, b) => {
      const tracked: string[] = []
      const deps = engineDeps(tracked)
      process.env.BITCASTER_DAEMON_HOME = a.directory
      await retainNativeOrderLink(a.directory, a.scopeId, ORDER_ID, MARKET_ID, CLIENT_ID)
      await recordSubmittedOrder(MARKET_ID, CLIENT_ID, status)
      const account = (await readSecrets())!.nostrPublicKeyHex
      process.env.BITCASTER_DAEMON_HOME = b.directory
      assert.equal((await readSecrets())!.nostrPublicKeyHex, account)
      for (let restart = 0; restart < 2; restart++) {
        const response = await dispatch(
          { method, params: { marketId: MARKET_ID, orderId: ORDER_ID } },
          deps,
        )
        assert.equal(response.ok, true)
        assert.equal((response.result as { local: unknown }).local, null)
        if (method === 'order.status')
          assert.equal((response.result as { engine: unknown }).engine, status)
        else assert.equal((response.result as { cancelled: boolean }).cancelled, true)
        assert.deepEqual((await dispatch({ method: 'order.list', params: {} })).result, [])
        assert.deepEqual(tracked, [])
        assert.equal((await readState())?.orders[ORDER_ID], undefined)
        await assertBaseline(b.directory, b.scopeId, true)
      }
      process.env.BITCASTER_DAEMON_HOME = a.directory
      const own = await dispatch(
        { method, params: { marketId: MARKET_ID, orderId: ORDER_ID } },
        deps,
      )
      assert.equal(own.ok, true)
      assert.equal((own.result as { local: { orderId: string } }).local.orderId, ORDER_ID)
      assert.equal(
        (await readState())?.orders[ORDER_ID]?.status,
        method === 'order.cancel' ? 'cancelled' : 'matched',
      )
      assert.equal(
        ((await dispatch({ method: 'order.list', params: {} })).result as unknown[]).length,
        1,
      )
      assert.deepEqual(tracked, method === 'order.status' ? [ORDER_ID] : [])
    })
  })
}

test('unbound cache rows survive storage but do not list, track, or suppress a baseline', async () => {
  await withWallets(async (_a, b) => {
    process.env.BITCASTER_DAEMON_HOME = b.directory
    await recordSubmittedOrder(MARKET_ID, CLIENT_ID, status)
    for (let restart = 0; restart < 2; restart++) {
      const tracked: string[] = []
      const response = await dispatch(
        { method: 'order.status', params: { marketId: MARKET_ID, orderId: ORDER_ID } },
        engineDeps(tracked),
      )
      assert.equal((response.result as { local: unknown }).local, null)
      assert.deepEqual((await dispatch({ method: 'order.list', params: {} })).result, [])
      assert.deepEqual(tracked, [])
      assert.equal((await readState())?.orders[ORDER_ID]?.status, 'matched')
      await assertBaseline(b.directory, b.scopeId, true)
    }
    await retainNativeOrderLink(b.directory, b.scopeId, ORDER_ID, MARKET_ID, CLIENT_ID, true)
    await assertBaseline(b.directory, b.scopeId, false)
    const wrongRoute = await dispatch(
      { method: 'order.cancel', params: { marketId: 'condition-1-NO', orderId: ORDER_ID } },
      engineDeps([]),
    )
    assert.equal((wrongRoute.result as { local: unknown }).local, null)
    assert.equal((await readState())?.orders[ORDER_ID]?.marketId, MARKET_ID)
  })
})

for (const mismatch of ['route', 'client', 'missing-client'] as const) {
  test(`a cached ${mismatch} mismatch is not a wallet submission link`, async () => {
    await withWallets(async (a) => {
      process.env.BITCASTER_DAEMON_HOME = a.directory
      await retainNativeOrderLink(a.directory, a.scopeId, ORDER_ID, MARKET_ID, CLIENT_ID)
      await recordSubmittedOrder(
        mismatch === 'route' ? 'condition-1-NO' : MARKET_ID,
        mismatch === 'client' ? 'another-client' : CLIENT_ID,
        status,
      )
      if (mismatch === 'missing-client') {
        await createDaemonStateSqliteSession(a.directory).transaction((database) => {
          database
            .prepare(
              'UPDATE daemon_orders SET client_order_id = NULL WHERE scope_id = ? AND order_id = ?',
            )
            .run(a.scopeId, ORDER_ID)
        })
      }
      const before = JSON.stringify((await readState())?.orders)
      const tracked: string[] = []
      for (const method of ['order.status', 'order.cancel'] as const) {
        const response = await dispatch(
          { method, params: { marketId: MARKET_ID, orderId: ORDER_ID } },
          engineDeps(tracked),
        )
        assert.equal(response.ok, true)
        assert.equal((response.result as { local: unknown }).local, null)
      }
      assert.deepEqual((await dispatch({ method: 'order.list', params: {} })).result, [])
      assert.deepEqual(tracked, [])
      assert.equal(JSON.stringify((await readState())?.orders), before)
    })
  })
}

test('an unbound account cache row cannot read, apply, or acknowledge a range result', async () => {
  await withWallets(async (_a, b) => {
    process.env.BITCASTER_DAEMON_HOME = b.directory
    await recordSubmittedOrder(MARKET_ID, CLIENT_ID, status)
    const before = JSON.stringify(await readState())
    const fence = await claimCustodyScopeLease(b.directory, {
      scopeId: b.scopeId,
      incarnationId: 'unbound-cache-recovery',
      observedAtMs: Date.now(),
    })
    let resultReads = 0
    let acknowledgements = 0
    try {
      const client: EngineClientLike = {
        ...engineClient(),
        getSettlementCapabilityResultByOperation: async () => {
          resultReads++
          throw new Error('foreign result read')
        },
        acknowledgeSettlementCapabilityResult: async () => {
          acknowledgements++
          throw new Error('foreign acknowledgement')
        },
      }
      const coordinator = new DaemonCtfRangeOrderCoordinator(b.directory, () => fence)
      assert.deepEqual(await coordinator.recover('33'.repeat(64), client), {
        recovered: [],
        pending: [],
      })
      assert.equal(resultReads, 0)
      assert.equal(acknowledgements, 0)
      assert.equal(JSON.stringify(await readState()), before)
    } finally {
      await releaseCustodyScopeLease(b.directory, fence, Date.now())
    }
  })
})

test('the wallet ownership predicate uses the existing unique client-order lookup', async () => {
  await withWallets(async (a) => {
    process.env.BITCASTER_DAEMON_HOME = a.directory
    await retainNativeOrderLink(a.directory, a.scopeId, ORDER_ID, MARKET_ID, CLIENT_ID)
    await recordSubmittedOrder(MARKET_ID, CLIENT_ID, status)
    const plan = await createDaemonStateSqliteSession(a.directory).read(
      (database) =>
        database
          .prepare(
            `EXPLAIN QUERY PLAN SELECT wallet_order.*
        FROM daemon_orders AS wallet_order
        WHERE wallet_order.scope_id = ? AND ${NATIVE_RANGE_ORDER_OWNERSHIP_SQL}`,
          )
          .all(a.scopeId) as Array<{ detail: string }>,
    )
    assert.ok(
      plan.some(({ detail }) => /SEARCH preparation.*scope_id=.*client_order_id=/.test(detail)),
      'ownership must resolve the existing unique scope and client-order index',
    )
  })
})

function engineDeps(tracked: string[]): DispatchDependencies {
  return {
    createEngineClient: () => engineClient(),
    trackOwnedOrder: async (_marketId, orderId) => {
      tracked.push(orderId)
    },
  }
}

function engineClient(): EngineClientLike {
  return {
    getParticipationScore: async () => {
      throw new Error('unused Score read')
    },
    submitOrder: async () => {
      throw new Error('unused submit')
    },
    getOrderStatus: async () => status,
    cancelOrder: async () => true,
    getMarket: async () => ({ conditionId: 'condition-1', baseAsset: 'sat', divisibility: 1_000 }),
    getOrderBook: async () => {
      throw new Error('unused book')
    },
    queryMarkets: async () => {
      throw new Error('unused query')
    },
  }
}

async function assertBaseline(
  directory: string,
  scopeId: string,
  expected: boolean,
): Promise<void> {
  const reports: AssetMonitoringReportRequest[] = []
  let inspected = false
  const storage = createDaemonStateSqliteSession(directory)
  const monitoring = createDaemonAssetMonitoring({
    directory,
    scopeId,
    walletId: scopeId.slice('custody:wallet:'.length),
    engineBaseUrl: 'https://engine.example',
    storage: {
      ...storage,
      read: async (action) => {
        const result = await storage.read(action)
        if (typeof result === 'boolean') inspected = true
        return result
      },
    },
    remote: {
      submitAssetMonitoringReport: async (request) => {
        reports.push(request)
        if (!request.startsNewInterval)
          throw new EngineClientError(
            409,
            'baseline required',
            'asset-monitoring-baseline-required',
          )
      },
    },
    fetchImpl: async () => new Response(JSON.stringify({ markets: [] })),
    subscribeToCommits: () => () => {},
  })
  try {
    monitoring.start()
    for (let attempt = 0; attempt < 100 && !inspected; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 2))
    assert.equal(inspected, true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(
      reports.map((report) => report.startsNewInterval),
      expected ? [false, true] : [false],
    )
  } finally {
    monitoring.stop()
  }
}

interface WalletFixture {
  directory: string
  scopeId: string
}
async function withWallets(
  action: (a: WalletFixture, b: WalletFixture) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-native-order-ownership-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  try {
    const wallets: WalletFixture[] = []
    for (const [name, seed] of [
      ['a', '11'],
      ['b', '33'],
    ]) {
      const walletDirectory = join(directory, name!)
      const profile = await bootstrapFreshDaemonProfile({
        directory: walletDirectory,
        engineBaseUrl: 'https://engine.example',
        mintUrl: 'https://mint.example',
        walletSeedHex: seed!.repeat(64),
        nostrSecretKeyHex: '22'.repeat(32),
      })
      wallets.push({ directory: walletDirectory, scopeId: profile.walletScopeId })
    }
    await action(wallets[0]!, wallets[1]!)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}
