import assert from 'node:assert/strict'
import test from 'node:test'
import { BitcasterEngineClient, EngineClientError } from '../src/engineClient.ts'
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

test('asset-monitoring reporter coalesces changes and retries a baseline-required interval', async (t) => {
  const requests: Array<{ startsNewInterval: boolean }> = []
  let calls = 0
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => holdings,
    remote: {
      submitAssetMonitoringReport: async (request) => {
        requests.push(request)
        if (calls++ === 0) {
          throw new EngineClientError(409, 'interval', 'asset-monitoring-baseline-required')
        }
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => true,
    createReportId: (() => {
      let id = 0
      return () => `report-${++id}`
    })(),
  })
  t.after(() => reporter.stop())
  reporter.request()
  reporter.request()
  await waitFor(() => requests.length === 2)
  assert.deepEqual(
    requests.map((request) => request.startsNewInterval),
    [false, true],
  )
})

test('asset-monitoring reporter restarts only for the baseline-required ProblemDetails code', async (t) => {
  const scenarios = [
    {
      name: 'baseline required without a pending order',
      code: 'asset-monitoring-baseline-required',
      pendingOrder: false,
      expectedStartsNewInterval: [false, true],
      expectedPendingChecks: 1,
      expectedAccepted: 1,
    },
    {
      name: 'baseline required with a pending order',
      code: 'asset-monitoring-baseline-required',
      pendingOrder: true,
      expectedStartsNewInterval: [false],
      expectedPendingChecks: 1,
      expectedAccepted: 0,
    },
    {
      name: 'changed-content conflict',
      code: 'asset-monitoring-report-conflict',
      pendingOrder: false,
      expectedStartsNewInterval: [false],
      expectedPendingChecks: 0,
      expectedAccepted: 0,
    },
    {
      name: 'unknown conflict code',
      code: 'other-conflict',
      pendingOrder: false,
      expectedStartsNewInterval: [false],
      expectedPendingChecks: 0,
      expectedAccepted: 0,
    },
    {
      name: 'uncoded conflict',
      code: undefined,
      pendingOrder: false,
      expectedStartsNewInterval: [false],
      expectedPendingChecks: 0,
      expectedAccepted: 0,
    },
  ] as const

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const requests: Array<{ startsNewInterval: boolean }> = []
      let pendingChecks = 0
      let accepted = 0
      const client = new BitcasterEngineClient({
        baseUrl: 'https://engine.example',
        fetchImpl: async (_input, init) => {
          assert.equal(typeof init?.body, 'string')
          requests.push(JSON.parse(init!.body as string) as { startsNewInterval: boolean })
          if (requests.length === 1) {
            return new Response(
              JSON.stringify({ status: 409, code: scenario.code, detail: 'report refused' }),
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            )
          }
          return new Response(null, { status: 204 })
        },
      })
      const reporter = new AssetMonitoringReporter({
        walletId,
        buildHoldings: async () => holdings,
        remote: {
          submitAssetMonitoringReport: (request) => client.submitAssetMonitoringReport(request),
        },
        hasPendingSubmittedOrder: async () => {
          pendingChecks += 1
          return scenario.pendingOrder
        },
        isCurrent: () => true,
        onAccepted: () => {
          accepted += 1
        },
      })
      subtest.after(() => reporter.stop())

      reporter.request()
      if (scenario.expectedAccepted > 0) {
        await waitFor(() => accepted === scenario.expectedAccepted)
      } else {
        await waitFor(() => requests.length === 1)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      assert.deepEqual(
        requests.map((request) => request.startsNewInterval),
        scenario.expectedStartsNewInterval,
      )
      assert.equal(pendingChecks, scenario.expectedPendingChecks)
      assert.equal(accepted, scenario.expectedAccepted)
    })
  }
})

test('asset-monitoring reporter retries a transient failure without another wallet change', async (t) => {
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
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => calls === 2)
})

test('asset-monitoring reporter calls onAccepted only for accepted reports', async (t) => {
  const scenarios = [
    {
      name: 'normal success',
      firstErrorStatus: undefined,
      firstErrorCode: undefined,
      expectedCalls: 1,
      expectedAccepted: 1,
    },
    {
      name: 'baseline-required conflict',
      firstErrorStatus: 409,
      firstErrorCode: 'asset-monitoring-baseline-required',
      expectedCalls: 2,
      expectedAccepted: 1,
    },
    {
      name: 'permanent failure',
      firstErrorStatus: 403,
      firstErrorCode: undefined,
      expectedCalls: 1,
      expectedAccepted: 0,
    },
  ] as const

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      let builds = 0
      let calls = 0
      let accepted = 0
      const reporter = new AssetMonitoringReporter({
        walletId,
        buildHoldings: async () => {
          builds += 1
          return holdings
        },
        remote: {
          submitAssetMonitoringReport: async () => {
            calls += 1
            if (calls === 1 && scenario.firstErrorStatus !== undefined) {
              throw new EngineClientError(
                scenario.firstErrorStatus,
                'test response',
                scenario.firstErrorCode,
              )
            }
          },
        },
        hasPendingSubmittedOrder: async () => false,
        isCurrent: () => true,
        onAccepted: () => {
          accepted += 1
        },
      })
      subtest.after(() => reporter.stop())

      reporter.request()
      await waitFor(() => calls === scenario.expectedCalls)
      if (scenario.expectedAccepted > 0) {
        await waitFor(() => accepted === scenario.expectedAccepted)

        // A second request with the same holdings is coalesced after the
        // accepted snapshot and must not publish another acceptance.
        reporter.request()
        await waitFor(() => builds === 2)
        await new Promise((resolve) => setTimeout(resolve, 0))
        assert.equal(calls, scenario.expectedCalls)
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(accepted, scenario.expectedAccepted)
    })
  }
})

test('asset-monitoring reporter suppresses onAccepted for an obsolete profile response', async (t) => {
  let current = true
  let submit: (() => void) | undefined
  const accepted: string[] = []
  const reporter = new AssetMonitoringReporter({
    walletId,
    buildHoldings: async () => holdings,
    remote: {
      submitAssetMonitoringReport: async () => {
        await new Promise<void>((resolve) => {
          submit = resolve
        })
      },
    },
    hasPendingSubmittedOrder: async () => false,
    isCurrent: () => current,
    onAccepted: () => accepted.push('accepted'),
  })
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => submit !== undefined)
  current = false
  submit!()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(accepted, [])
})

test('asset-monitoring reporter retries a transient snapshot failure independently', async (t) => {
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
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => calls === 1)
  assert.equal(builds, 2)
})

test('asset-monitoring reporter stop cancels a pending retry', async (t) => {
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
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => calls === 1)
  reporter.stop()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 1)
})

test('asset-monitoring reporter does not retry a permanent HTTP failure', async (t) => {
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
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => calls === 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(calls, 1)
})

test('asset-monitoring reporter does not retry a permanent catalogue failure', async (t) => {
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
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => builds === 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(builds, 1)
  assert.equal(calls, 0)
})

test('asset-monitoring reporter does not submit an unchanged accepted snapshot again', async (t) => {
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
  t.after(() => reporter.stop())
  reporter.request()
  await waitFor(() => calls === 1)
  reporter.request()
  await waitFor(() => builds === 2)
  assert.equal(calls, 1)
})

test('asset-monitoring catalogue bounds pages', async () => {
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
})

test('asset-monitoring catalogue canonicalizes a copied display-order outcome universe', async () => {
  for (const [displayOutcomes, expectedOutcomes] of [
    [
      ['YES', 'NO'],
      ['NO', 'YES'],
    ],
    [
      ['Zulu', 'alpha', 'Beta'],
      ['Beta', 'Zulu', 'alpha'],
    ],
  ] as const) {
    const result = await fetchAssetMonitoringCatalogue([conditionId], {
      engineBaseUrl: 'https://engine.example',
      fetchImpl: async () =>
        new Response(JSON.stringify({ markets: [{ conditionId, outcomes: displayOutcomes }] })),
    })

    assert.deepEqual(result, [{ conditionId, outcomes: expectedOutcomes }])
  }
})

test('asset-monitoring catalogue rejects duplicate outcome labels', async () => {
  await assert.rejects(() =>
    fetchAssetMonitoringCatalogue([conditionId], {
      engineBaseUrl: 'https://engine.example',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ markets: [{ conditionId, outcomes: ['YES', 'NO', 'YES'] }] }),
        ),
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
