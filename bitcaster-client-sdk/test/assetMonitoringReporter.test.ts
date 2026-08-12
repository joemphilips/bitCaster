import assert from 'node:assert/strict'
import test from 'node:test'
import { EngineClientError } from '../src/engineClient.ts'
import {
  AssetMonitoringReporter,
  fetchAssetMonitoringCatalogue,
} from '../src/assetMonitoringReporter.ts'

const conditionId = 'a'.repeat(64)
const walletId = 'b'.repeat(64)
const holdings = [
  {
    asset: {
      canonicalMintUrl: 'https://mint.example',
      kind: 'collateral' as const,
      cashuUnit: 'msat' as const,
      displayBaseAsset: 'sat' as const,
    },
    availableSubunits: 1,
    pendingOutgoingSubunits: 0,
  },
]

test('asset-monitoring reporter coalesces changes and retries only a safe 409 interval', async () => {
  const requests: Array<{ startsNewInterval: boolean }> = []
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => holdings,
    remote: {
      submitAssetMonitoringReport: async (request) => {
        requests.push(request)
        if (calls++ === 0) throw new EngineClientError(409, 'interval')
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    createReportId: (() => {
      let id = 0
      return () => `report-${++id}`
    })(),
  })
  reporter.request()
  reporter.request()
  await waitFor(() => requests.length === 2)
  assert.deepEqual(
    requests.map((request) => request.startsNewInterval),
    [false, true],
  )
  reporter.stop()
})

test('asset-monitoring reporter retries a transient failure without another wallet change', async () => {
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => holdings,
    remote: {
      submitAssetMonitoringReport: async () => {
        calls += 1
        if (calls === 1) throw new EngineClientError(503, 'unavailable')
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    retryDelayMs: () => 1,
  })
  reporter.request()
  await waitFor(() => calls === 2)
  reporter.stop()
})

test('asset-monitoring reporter retries a transient snapshot failure independently', async () => {
  let builds = 0
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => (++builds === 1 ? null : holdings),
    remote: {
      submitAssetMonitoringReport: async () => {
        calls += 1
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    retryDelayMs: () => 1,
  })
  reporter.request()
  await waitFor(() => calls === 1)
  assert.equal(builds, 2)
  reporter.stop()
})

test('asset-monitoring reporter stop cancels a pending retry', async () => {
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => holdings,
    remote: {
      submitAssetMonitoringReport: async () => {
        calls += 1
        throw new EngineClientError(503, 'unavailable')
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    retryDelayMs: () => 20,
  })
  reporter.request()
  await waitFor(() => calls === 1)
  reporter.stop()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 1)
})

test('asset-monitoring reporter does not retry a permanent HTTP failure', async () => {
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => holdings,
    remote: {
      submitAssetMonitoringReport: async () => {
        calls += 1
        throw new EngineClientError(403, 'forbidden')
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    retryDelayMs: () => 1,
  })
  reporter.request()
  await waitFor(() => calls === 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls, 1)
  reporter.stop()
})

test('asset-monitoring reporter does not retry a permanent catalogue failure', async () => {
  let builds = 0
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => {
      builds += 1
      await fetchAssetMonitoringCatalogue([conditionId], {
        engineBaseUrl: 'https://engine.example',
        fetchImpl: async () => new Response(null, { status: 403 }),
      })
      return holdings
    },
    remote: {
      submitAssetMonitoringReport: async () => {
        calls += 1
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    retryDelayMs: () => 1,
  })
  reporter.request()
  await waitFor(() => builds === 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(builds, 1)
  assert.equal(calls, 0)
  reporter.stop()
})

test('asset-monitoring reporter does not submit an unchanged accepted snapshot again', async () => {
  let builds = 0
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => {
      builds += 1
      return holdings
    },
    remote: {
      submitAssetMonitoringReport: async () => {
        calls += 1
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
  })
  reporter.request()
  await waitFor(() => calls === 1)
  reporter.request()
  await waitFor(() => builds === 2)
  assert.equal(calls, 1)
  reporter.stop()
})

test('asset-monitoring catalogue bounds pages and rejects noncanonical outcomes', async () => {
  const ids = Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(64, '0'))
  const urls: URL[] = []
  await fetchAssetMonitoringCatalogue(ids, {
    engineBaseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      urls.push(new URL(String(input)))
      return new Response(JSON.stringify({ markets: [] }))
    },
  })
  assert.equal(urls.length, 2)
  assert.equal(urls[0]!.searchParams.get('ids')!.split(',').length, 50)
  await assert.rejects(() =>
    fetchAssetMonitoringCatalogue([conditionId], {
      engineBaseUrl: 'https://engine.example',
      fetchImpl: async () =>
        new Response(JSON.stringify({ markets: [{ conditionId, outcomes: ['YES', 'NO'] }] })),
    }),
  )
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}
