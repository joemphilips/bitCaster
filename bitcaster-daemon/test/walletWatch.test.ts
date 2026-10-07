import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveDurableCustodyWalletId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  decodeAssetMonitoringPortfolioResponse,
  type AssetMonitoringAssetResponse,
} from '@bitcaster-market/client-sdk'
import { BitcasterEngineClient } from '../../bitcaster-client-sdk/src/engineClient.ts'
import {
  createWalletWatch,
  type WalletWatchDependencies,
  type WalletWatchSnapshot,
} from '../src/walletWatch.ts'
import type { WalletBalance } from '../src/state.ts'

const BINARY = 'ab'.repeat(32)
const CATEGORY = 'cd'.repeat(32)
const MINT = 'https://mint.example'
const metadata = { valuationRevision: 'price-1', stale: false, incomplete: false, building: false }

function portfolio(assets: AssetMonitoringAssetResponse[] = [], revision = 'price-1') {
  const current = { ...metadata, valuationRevision: revision }
  return decodeAssetMonitoringPortfolioResponse({
    summary: {
      ...current,
      collateralUnit: 'msat',
      availableValueMsat: 1234,
      pendingOutgoingValueMsat: 10,
      estimatedTotalValueMsat: 1244,
      unvaluedAssetCount: 0,
      unvaluedAvailableSubunits: 0,
      unvaluedPendingOutgoingSubunits: 0,
    },
    assets: { ...current, assets, nextCursor: null },
    history: {
      ...current,
      timeframe: '1W',
      points: [{ asOf: '2026-10-02T00:00:00Z', estimatedTotalValueMsat: 1244 }],
    },
  })
}

function position(conditionId: string, outcomeSetId: string, availableSats = 2) {
  return { mintUrl: MINT, conditionId, outcomeSetId, availableSats, reservedSats: 1, lockedSats: 0 }
}
function asset(
  conditionId: string,
  internalOutcomeSetId: string,
  value = 720,
): AssetMonitoringAssetResponse {
  return {
    asset: {
      kind: 'conditional',
      canonicalMintUrl: MINT,
      cashuUnit: 'msat',
      displayBaseAsset: 'sat',
      conditionId,
      parentConditionId: '0'.repeat(64),
      outcomeUniverseDigest: 'de'.repeat(32),
      internalOutcomeSetId,
    },
    availableSubunits: 1000,
    pendingOutgoingSubunits: 0,
    estimatedValueMsat: value,
    valuationStatus: 'valued',
    recoveryHint: null,
  }
}

class FakeHub {
  readonly calls: string[] = []
  readonly replacements: string[][] = []
  readonly owners = new Map<object, readonly string[]>()
  connected = true
  startup = Promise.resolve()
  replacing = Promise.resolve()
  releasing = Promise.resolve()
  start() {
    this.calls.push('start')
    return this.startup
  }
  isConnected() {
    this.calls.push('connected')
    return this.connected
  }
  async setPortfolioValuationConditions(owner: object, ids: readonly string[]) {
    this.calls.push('replace')
    this.replacements.push([...ids])
    this.owners.set(owner, ids)
    await this.replacing
  }
  async releasePortfolioValuationConditions(owner: object) {
    this.calls.push('release')
    this.owners.delete(owner)
    await this.releasing
  }
}

function fixture() {
  const hub = new FakeHub()
  const controller = new AbortController()
  const listeners = new Set<() => void>()
  const trace: string[] = []
  const state = {
    enabled: true,
    portfolio: portfolio(),
    localReads: 0,
    portfolioReads: 0,
    unsubscribed: 0,
    local: {
      totalAvailableSats: 7,
      totalReservedSats: 0,
      totalLockedSats: 0,
      byMint: [{ mintUrl: MINT, availableSats: 7, reservedSats: 0, lockedSats: 0 }],
      outcomePositions: [],
    } as WalletBalance,
  }
  const input: WalletWatchDependencies = {
    hub,
    readLocal: async (signal) => {
      assert.equal(signal, controller.signal)
      state.localReads++
      trace.push('local')
      return { localHoldings: structuredClone(state.local), monitoringEnabled: state.enabled }
    },
    readPortfolio: async (signal) => {
      assert.equal(signal, controller.signal)
      state.portfolioReads++
      trace.push('portfolio')
      return state.portfolio
    },
    subscribeToLocalChanges: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
        state.unsubscribed++
      }
    },
  }
  const watch = createWalletWatch(input)
  const reader = watch.watch(controller.signal)
  return {
    hub,
    controller,
    state,
    input,
    watch,
    reader,
    trace,
    listeners,
    commit: () => {
      for (const callback of listeners) callback()
    },
  }
}

async function initial(f: ReturnType<typeof fixture>) {
  let snapshot: WalletWatchSnapshot | undefined
  for (let i = 0; i < 3; i++) {
    const frame = (await f.reader.next()).value!
    if (frame.event === 'wallet.snapshot') snapshot = frame.data as WalletWatchSnapshot
    else {
      assert.equal(frame.event, 'wallet.connection')
      assert.deepEqual(frame.data, { state: 'connected' })
      return snapshot!
    }
  }
  throw new Error('initial wallet snapshots did not reach a connection message')
}

test('privacy-disabled local watch performs no valuation hub, authorization, or monitoring I/O', async () => {
  const f = fixture()
  f.state.enabled = false
  f.state.local.outcomePositions = [position(CATEGORY, '1|3')]
  f.input.readPortfolio = async () => {
    throw new Error('private monitoring must not run')
  }
  let authCalls = 0
  // The selected-wallet client is constructed only inside this forbidden callback.
  f.input.hub.start = async () => {
    authCalls++
    throw new Error('private hub must not start')
  }
  const first = (await f.reader.next()).value!
  assert.equal(first.event, 'wallet.snapshot')
  assert.deepEqual(first.data, { localHoldings: f.state.local, monitoring: { status: 'disabled' } })
  assert.equal(first.sourceRevision, undefined)
  f.state.local.totalAvailableSats = 8
  f.commit()
  assert.equal(
    ((await f.reader.next()).value!.data as WalletWatchSnapshot).localHoldings.totalAvailableSats,
    8,
  )
  f.watch.reconnected()
  f.watch.invalidate(CATEGORY)
  f.watch.refreshPortfolio()
  const idle = f.reader.next()
  const rejected = assert.rejects(idle, /aborted/)
  await tick()
  assert.equal(f.state.localReads, 2)
  f.controller.abort()
  await rejected
  assert.equal(f.hub.calls.length, 0)
  assert.equal(authCalls, 0)
  assert.equal(f.state.portfolioReads, 0)
  assert.equal(f.state.unsubscribed, 1)
  assert.equal(f.listeners.size, 0)
})

test('accepted reports refresh display estimates without conditional price events and coalesce', async () => {
  const f = fixture()
  await initial(f)
  f.state.local.totalAvailableSats = 8
  f.commit()
  const early = (await f.reader.next()).value!
  assert.equal((early.data as WalletWatchSnapshot).localHoldings.totalAvailableSats, 8)
  assert.equal(early.sourceRevision, 'price-1')
  const reads = f.state.portfolioReads
  f.state.portfolio = portfolio([], 'accepted-report')
  for (let i = 0; i < 10000; i++) f.watch.refreshPortfolio()
  assert.equal(f.state.portfolioReads, reads)
  const fresh = (await f.reader.next()).value!
  assert.equal(fresh.sourceRevision, 'accepted-report')
  assert.equal(f.state.portfolioReads, reads + 1)
  assert.deepEqual(f.hub.replacements.at(-1), [])
  await f.reader.return()
  f.watch.refreshPortfolio()
  assert.equal(f.state.portfolioReads, reads + 1)
})

test('an unavailable display portfolio retains local holdings and does not report zero estimates', async () => {
  const f = fixture()
  f.input.readPortfolio = async () => {
    throw new Error('fixture private upstream details')
  }
  const snapshot = await initial(f)
  assert.deepEqual(snapshot.localHoldings, f.state.local)
  assert.deepEqual(snapshot.monitoring, { status: 'unavailable' })
  assert.equal(JSON.stringify(snapshot).includes('fixture private upstream details'), false)
  f.state.local.totalAvailableSats = 9
  f.commit()
  const frame = (await f.reader.next()).value!
  assert.equal((frame.data as WalletWatchSnapshot).localHoldings.totalAvailableSats, 9)
  assert.deepEqual((frame.data as WalletWatchSnapshot).monitoring, { status: 'unavailable' })
  await f.reader.return()
})

test('categorical Yes and complement estimates pass through the SDK portfolio without custody calculations', async () => {
  const f = fixture()
  f.state.local.outcomePositions = [
    position(CATEGORY, '2'),
    position(CATEGORY, '1|3'),
    position(BINARY, '1'),
  ]
  f.state.portfolio = portfolio([
    asset(CATEGORY, '2', 280),
    asset(CATEGORY, '1|3', 720),
    asset(BINARY, '1', 600),
  ])
  const snapshot = await initial(f)
  assert.deepEqual(snapshot.localHoldings, f.state.local)
  assert.deepEqual(snapshot.monitoring, { status: 'available', portfolio: f.state.portfolio })
  assert.deepEqual(f.hub.replacements, [
    [BINARY, CATEGORY],
    [BINARY, CATEGORY],
  ])
  assert.deepEqual(f.trace, ['local', 'portfolio', 'local', 'portfolio'])
  assert.equal(f.state.localReads, 2)
  await f.reader.return()
})

test('portfolio reads use the selected canonical wallet ID, authorization, and cancellation', async () => {
  const ids: string[] = []
  for (const seedByte of [17, 34]) {
    const f = fixture()
    const walletId = deriveDurableCustodyWalletId(new Uint8Array(64).fill(seedByte))
    ids.push(walletId)
    let reads = 0,
      authorized = 0
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      authorization: async ({ url, method }) => {
        authorized++
        assert.equal(method, 'GET')
        assert.equal(new URL(url).searchParams.get('walletId'), walletId)
        return `Bearer selected-${seedByte}`
      },
      fetchImpl: async (input, init) => {
        reads++
        const url = new URL(String(input))
        assert.equal(url.pathname, '/api/v1/portfolio')
        assert.equal(url.searchParams.get('walletId'), walletId)
        assert.equal(url.searchParams.get('pageSize'), '200')
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer selected-${seedByte}`)
        assert.equal(init?.signal, f.controller.signal)
        return Response.json(f.state.portfolio)
      },
    })
    f.input.readPortfolio = (signal) => client.getPortfolio({ walletId, pageSize: 200 }, signal)
    await initial(f)
    assert.equal(reads, 1)
    assert.equal(authorized, 1)
    await f.reader.return()
  }
  assert.notEqual(ids[0], ids[1])
})

test('holding changes replace valuation ownership only after a fresh snapshot and refresh new memberships', async () => {
  const f = fixture()
  f.state.local.outcomePositions = [position(BINARY, '1')]
  await initial(f)
  f.state.local.outcomePositions = [position(CATEGORY, '1|3')]
  f.state.portfolio = portfolio([asset(CATEGORY, '1|3')], 'price-2')
  f.commit()
  const first = (await f.reader.next()).value!
  assert.equal(first.event, 'wallet.snapshot')
  assert.equal(first.sourceRevision, 'price-2')
  assert.deepEqual(f.hub.replacements.at(-1), [CATEGORY])
  assert.deepEqual(
    (first.data as WalletWatchSnapshot).localHoldings.outcomePositions,
    f.state.local.outcomePositions,
  )
  const reads = f.state.portfolioReads
  // A new subscription can miss this price change before its acknowledgement.
  f.state.portfolio = portfolio([asset(CATEGORY, '1|3', 730)], 'price-3')
  assert.equal((await f.reader.next()).value!.sourceRevision, 'price-3')
  assert.equal(f.state.portfolioReads, reads + 1)
  const idle = f.reader.next()
  const rejected = assert.rejects(idle, /aborted/)
  f.watch.invalidate(BINARY)
  await tick()
  assert.equal(f.state.portfolioReads, reads + 1)
  f.controller.abort()
  await rejected
  assert.equal(f.hub.owners.size, 0)
})

for (const [operation, available, positions] of [
  ['conditional receive', 7, [position(CATEGORY, '1|3', 3)]],
  ['winner claim', 10, []],
  ['loser removal', 7, []],
] as const) {
  test(`a ${operation} local commit invalidates the complete holding view`, async () => {
    const f = fixture()
    f.state.enabled = false
    f.state.local.outcomePositions = [position(BINARY, '1')]
    await f.reader.next()
    f.state.local.totalAvailableSats = available
    f.state.local.outcomePositions = [...positions]
    f.commit()
    assert.deepEqual(
      ((await f.reader.next()).value!.data as WalletWatchSnapshot).localHoldings,
      f.state.local,
    )
    assert.equal(f.state.portfolioReads, 0)
    await f.reader.return()
  })
}

test('a paused consumer coalesces local commits and valuation invalidations without reading ahead', async () => {
  const f = fixture()
  f.state.local.outcomePositions = [position(CATEGORY, '1|3')]
  await initial(f)
  const reads = f.state.localReads
  for (let i = 0; i < 10000; i++) {
    f.commit()
    f.watch.invalidate(CATEGORY)
    f.watch.invalidate(BINARY)
  }
  assert.equal(f.state.localReads, reads)
  f.state.portfolio = portfolio([], 'price-new')
  assert.equal((await f.reader.next()).value!.sourceRevision, 'price-new')
  assert.equal(f.state.localReads, reads + 1)
  const idle = f.reader.next()
  const rejected = assert.rejects(idle, /aborted/)
  await tick()
  assert.equal(f.state.localReads, reads + 1)
  f.controller.abort()
  await rejected
})

test('disconnect preserves local updates and reconnect reads a fresh snapshot before connected', async () => {
  const f = fixture()
  f.state.local.outcomePositions = [position(BINARY, '1')]
  await initial(f)
  f.hub.connected = false
  f.watch.disconnected()
  const reads = f.state.portfolioReads
  const unavailable = (await f.reader.next()).value!.data as WalletWatchSnapshot
  assert.deepEqual(unavailable.monitoring, { status: 'unavailable' })
  assert.deepEqual((await f.reader.next()).value!.data, { state: 'reconnecting' })
  f.state.local.totalAvailableSats = 12
  f.commit()
  assert.equal(
    ((await f.reader.next()).value!.data as WalletWatchSnapshot).localHoldings.totalAvailableSats,
    12,
  )
  assert.equal(f.state.portfolioReads, reads)
  f.state.portfolio = portfolio([], 'fresh-reconnect')
  f.hub.connected = true
  f.watch.reconnected()
  const fresh = (await f.reader.next()).value!
  assert.equal(fresh.event, 'wallet.snapshot')
  assert.equal(fresh.sourceRevision, 'fresh-reconnect')
  assert.deepEqual((await f.reader.next()).value!.data, { state: 'connected' })
  await f.reader.return()
})

for (const observed of [true, false]) {
  test(`a portfolio read spanning reconnect is discarded (disconnect observed: ${observed})`, async () => {
    const f = fixture()
    await initial(f)
    const blocked = deferred(),
      entered = deferred()
    const old = f.input.readPortfolio
    f.input.readPortfolio = async (signal) => {
      const result = await old(signal)
      entered.resolve()
      await blocked.promise
      return result
    }
    f.commit()
    const pending = f.reader.next()
    await entered.promise
    if (observed) f.watch.disconnected()
    f.state.portfolio = portfolio([], 'after-reconnect')
    f.input.readPortfolio = old
    f.watch.reconnected()
    blocked.resolve()
    assert.equal((await pending).value!.sourceRevision, 'after-reconnect')
    assert.deepEqual((await f.reader.next()).value!.data, { state: 'connected' })
    await f.reader.return()
  })
}

test('the adjacent 200-condition bound never truncates an overflow or blocks local custody updates', async () => {
  const f = fixture()
  const ids = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(64, '0'))
  f.state.local.outcomePositions = ids.slice(0, 200).map((id) => position(id, '1'))
  await initial(f)
  assert.equal(f.hub.replacements.at(-1)!.length, 200)
  f.state.local.outcomePositions.push(position(ids[200]!, '1'))
  f.commit()
  const snapshot = (await f.reader.next()).value!.data as WalletWatchSnapshot
  assert.equal(snapshot.localHoldings.outcomePositions.length, 201)
  assert.deepEqual(snapshot.monitoring, { status: 'unavailable' })
  assert.deepEqual(f.hub.replacements.at(-1), [])
  f.state.local.totalAvailableSats = 11
  f.commit()
  assert.equal(
    ((await f.reader.next()).value!.data as WalletWatchSnapshot).localHoldings.totalAvailableSats,
    11,
  )
  await f.reader.return()
})

for (const stage of ['local', 'startup', 'portfolio', 'replacement', 'idle'] as const) {
  test(`cancellation during ${stage} releases the listener and valuation owner without waiting for I/O`, async () => {
    const f = fixture()
    const blocked = deferred(),
      entered = deferred()
    if (stage === 'local')
      f.input.readLocal = async () => {
        entered.resolve()
        await blocked.promise
        return { localHoldings: f.state.local, monitoringEnabled: true }
      }
    if (stage === 'portfolio')
      f.input.readPortfolio = async () => {
        entered.resolve()
        await blocked.promise
        return f.state.portfolio
      }
    if (stage === 'startup') f.hub.startup = blocked.promise
    if (stage === 'replacement') f.hub.replacing = blocked.promise
    let pending = f.reader.next()
    if (stage === 'idle') {
      await pending
      await f.reader.next()
      pending = f.reader.next()
    }
    const rejected = assert.rejects(pending, /aborted/)
    if (stage === 'local' || stage === 'portfolio') await entered.promise
    else await tick()
    f.hub.releasing = blocked.promise
    f.controller.abort()
    await rejected
    assert.equal(f.listeners.size, 0)
    assert.equal(f.hub.owners.size, 0)
    assert.equal(f.state.unsubscribed, 1)
    blocked.resolve()
    await tick()
    assert.equal(f.hub.owners.size, 0)
  })
}

test('hub setup and replacement failures produce unavailable display data while local reads continue', async () => {
  for (const stage of ['start', 'replace']) {
    const f = fixture()
    if (stage === 'start')
      f.hub.start = async () => {
        throw new Error('fixture start failure')
      }
    else
      f.hub.setPortfolioValuationConditions = async () => {
        throw new Error('fixture replacement failure')
      }
    const first = (await f.reader.next()).value!.data as WalletWatchSnapshot
    assert.deepEqual(first.localHoldings, f.state.local)
    assert.deepEqual(first.monitoring, { status: 'unavailable' })
    f.state.local.totalAvailableSats = 13
    f.commit()
    assert.equal(
      ((await f.reader.next()).value!.data as WalletWatchSnapshot).localHoldings.totalAvailableSats,
      13,
    )
    await f.reader.return()
    assert.equal(f.listeners.size, 0)
  }
})

test('a refused subscription replacement retains invalidation ownership until a successful retry', async () => {
  const f = fixture()
  f.state.local.outcomePositions = [position(BINARY, '1')]
  await initial(f)
  const replace = f.hub.setPortfolioValuationConditions.bind(f.hub)
  f.hub.setPortfolioValuationConditions = async () => {
    throw new Error('owner union exceeds its bound')
  }
  f.state.local.outcomePositions = [position(CATEGORY, '1')]
  f.commit()
  assert.deepEqual(((await f.reader.next()).value!.data as WalletWatchSnapshot).monitoring, {
    status: 'unavailable',
  })
  assert.deepEqual([...f.hub.owners.values()], [[BINARY]])
  f.hub.setPortfolioValuationConditions = replace
  f.watch.invalidate(BINARY)
  assert.equal(
    ((await f.reader.next()).value!.data as WalletWatchSnapshot).monitoring.status,
    'available',
  )
  assert.deepEqual([...f.hub.owners.values()], [[CATEGORY]])
  await f.reader.return()
})

test('a failed local custody read closes the watch and releases its commit listener', async () => {
  const f = fixture()
  f.input.readLocal = async () => {
    throw new Error('local read failed')
  }
  await assert.rejects(f.reader.next(), /local read failed/)
  assert.equal(f.state.portfolioReads, 0)
  assert.equal(f.hub.calls.length, 0)
  assert.equal(f.listeners.size, 0)
})

test('turning monitoring off releases only this owner and does not perform another portfolio read', async () => {
  const f = fixture()
  f.state.local.outcomePositions = [position(BINARY, '1')]
  await initial(f)
  const other = {}
  await f.hub.setPortfolioValuationConditions(other, [CATEGORY])
  const reads = f.state.portfolioReads
  f.state.enabled = false
  f.commit()
  assert.deepEqual(((await f.reader.next()).value!.data as WalletWatchSnapshot).monitoring, {
    status: 'disabled',
  })
  assert.equal(f.state.portfolioReads, reads)
  assert.deepEqual([...f.hub.owners.keys()], [other])
  await f.reader.return()
  assert.equal(f.state.unsubscribed, 1)
})

test('a release transport failure cannot turn disabled local custody reads into failures', async () => {
  const f = fixture()
  await initial(f)
  f.hub.releasing = Promise.reject(new Error('fixture release transport failed'))
  void f.hub.releasing.catch(() => undefined)
  f.state.enabled = false
  f.commit()
  assert.deepEqual(((await f.reader.next()).value!.data as WalletWatchSnapshot).monitoring, {
    status: 'disabled',
  })
  f.state.local.totalAvailableSats = 17
  f.commit()
  assert.equal(
    ((await f.reader.next()).value!.data as WalletWatchSnapshot).localHoldings.totalAvailableSats,
    17,
  )
  await f.reader.return()
  assert.equal(f.hub.owners.size, 0)
})

test('a disposed profile listener cannot revive a replaced wallet watch', async () => {
  const old = fixture()
  old.state.enabled = false
  await old.reader.next()
  const staleCommit = [...old.listeners][0]!
  await old.reader.return()
  const replacement = fixture()
  replacement.state.enabled = false
  replacement.state.local.totalAvailableSats = 21
  const frame = (await replacement.reader.next()).value!
  assert.equal((frame.data as WalletWatchSnapshot).localHoldings.totalAvailableSats, 21)
  staleCommit()
  old.watch.reconnected()
  old.watch.invalidate(BINARY)
  assert.equal(old.state.localReads, 1)
  assert.equal(old.listeners.size, 0)
  assert.equal(replacement.state.localReads, 1)
  await replacement.reader.return()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function tick() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}
