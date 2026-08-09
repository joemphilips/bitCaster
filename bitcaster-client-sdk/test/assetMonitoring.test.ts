import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASSET_MONITORING_ASSETS_MAX,
  ASSET_MONITORING_HISTORY_POINTS_MAX,
  ASSET_MONITORING_RECOVERY_COUNTERS_MAX,
  ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX,
  ASSET_MONITORING_RESPONSE_BYTES_MAX,
  canonicalizeAssetMonitoringReportRequest,
  decodeAssetMonitoringAssetsQuery,
  decodeAssetMonitoringAssetsResponse,
  decodeAssetMonitoringHistoryResponse,
  decodeAssetMonitoringPortfolioQuery,
  decodeAssetMonitoringReportRequest,
  decodeAssetMonitoringSummaryResponse,
  type AssetMonitoringAssetReference,
  type AssetMonitoringReportRequest,
} from '../src/assetMonitoring.ts'
import { BitcasterEngineClient, type EngineAuthorizationRequest } from '../src/engineClient.ts'

const WALLET_ID = 'a'.repeat(64)
const REPORT_ID = '11111111-1111-4111-8111-111111111111'
const CONDITIONAL_ASSET: AssetMonitoringAssetReference = {
  canonicalMintUrl: 'https://mint.example',
  kind: 'conditional',
  cashuUnit: 'msat',
  displayBaseAsset: 'sat',
  conditionId: 'ab',
  parentConditionId: 'cd',
  outcomeUniverseDigest: 'b'.repeat(64),
  internalOutcomeSetId: 'NO|YES',
}

function collateralAsset(mint = 'https://mint.example'): AssetMonitoringAssetReference {
  return { canonicalMintUrl: mint, kind: 'collateral', cashuUnit: 'msat', displayBaseAsset: 'sat' }
}

function validReport(): AssetMonitoringReportRequest {
  return {
    walletId: WALLET_ID,
    reportId: REPORT_ID,
    startsNewInterval: true,
    holdings: [
      {
        asset: CONDITIONAL_ASSET,
        availableSubunits: 10,
        pendingOutgoingSubunits: 1,
        recoveryHint: {
          keysetIds: ['00' + 'a'.repeat(14)],
          counterIntervals: [{ start: 0, count: 1 }],
        },
      },
    ],
  }
}

function summaryResponse() {
  return {
    collateralUnit: 'msat',
    availableValueMsat: 10,
    pendingOutgoingValueMsat: null,
    estimatedTotalValueMsat: 10,
    unvaluedAssetCount: 0,
    unvaluedAvailableSubunits: null,
    unvaluedPendingOutgoingSubunits: null,
    asOf: '2026-08-09T00:00:00.000Z',
    intervalRevision: 1,
    coverageBoundary: null,
    valuationRevision: 'revision-1',
    stale: false,
    incomplete: false,
    building: false,
  }
}

function assetsResponse() {
  return {
    assets: [
      {
        asset: collateralAsset(),
        availableSubunits: 10,
        pendingOutgoingSubunits: 1,
        availableValueMsat: 10,
        pendingOutgoingValueMsat: null,
        estimatedValueMsat: 10,
        valuationStatus: 'valued',
        recoveryHint: null,
      },
    ],
    nextCursor: 'next-cursor',
    asOf: '2026-08-09T00:00:00.000Z',
    intervalRevision: 1,
    coverageBoundary: null,
    valuationRevision: 'revision-1',
    stale: false,
    incomplete: false,
    building: false,
  }
}

function historyResponse() {
  return {
    timeframe: 'ALL',
    points: [{ asOf: '2026-08-09T00:00:00.000Z', estimatedTotalValueMsat: null }],
    asOf: null,
    intervalRevision: null,
    coverageBoundary: null,
    valuationRevision: 'revision-1',
    stale: false,
    incomplete: false,
    building: false,
  }
}

test('asset-monitoring codecs round-trip valid bounded wire values and preserve nulls', () => {
  const report = decodeAssetMonitoringReportRequest(validReport())
  assert.deepEqual(report, validReport())
  assert.deepEqual(decodeAssetMonitoringSummaryResponse(summaryResponse()), summaryResponse())
  assert.deepEqual(decodeAssetMonitoringAssetsResponse(assetsResponse()), assetsResponse())
  assert.deepEqual(decodeAssetMonitoringHistoryResponse(historyResponse()), historyResponse())
})

test('asset-monitoring report canonicalizes holding and recovery-hint order', () => {
  const report = canonicalizeAssetMonitoringReportRequest({
    ...validReport(),
    holdings: [
      {
        asset: collateralAsset('https://z-mint.example'),
        availableSubunits: 1,
        pendingOutgoingSubunits: 0,
        recoveryHint: {
          keysetIds: ['00' + 'b'.repeat(14), '00' + 'a'.repeat(14)],
          counterIntervals: [
            { start: 2, count: 2 },
            { start: 0, count: 2 },
          ],
        },
      },
      {
        asset: collateralAsset('https://a-mint.example'),
        availableSubunits: 1,
        pendingOutgoingSubunits: 0,
        recoveryHint: null,
      },
    ],
  })

  assert.deepEqual(
    report.holdings.map((holding) => holding.asset.canonicalMintUrl),
    ['https://a-mint.example', 'https://z-mint.example'],
  )
  assert.deepEqual(report.holdings[1].recoveryHint, {
    keysetIds: ['00' + 'a'.repeat(14), '00' + 'b'.repeat(14)],
    counterIntervals: [{ start: 0, count: 4 }],
  })
})

test('asset-monitoring codecs reject duplicate identities, unknown fields, and noncanonical identifiers', () => {
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [validReport().holdings[0], validReport().holdings[0]],
      }),
    /identities are duplicated/,
  )
  assert.throws(
    () => decodeAssetMonitoringSummaryResponse({ ...summaryResponse(), foreign: true }),
    /fields are invalid/,
  )
  assert.throws(
    () => decodeAssetMonitoringReportRequest({ ...validReport(), walletId: 'A'.repeat(64) }),
    /wallet id is invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        reportId: '11111111-1111-0111-8111-111111111111',
      }),
    /report id is invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [
          {
            ...validReport().holdings[0],
            asset: { ...CONDITIONAL_ASSET, canonicalMintUrl: 'https://mint.example/' },
          },
        ],
      }),
    /mint URL is invalid/,
  )
  assert.throws(
    () => decodeAssetMonitoringHistoryResponse({ ...historyResponse(), timeframe: '2Y' }),
    /timeframe is invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringAssetsResponse({
        ...assetsResponse(),
        assets: [{ ...assetsResponse().assets[0], valuationStatus: 'unknown' }],
      }),
    /valuation status is invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [
          { ...validReport().holdings[0], asset: { ...CONDITIONAL_ASSET, cashuUnit: 'usd' } },
        ],
      }),
    /unit is invalid/,
  )
  for (const internalOutcomeSetId of ['YES|NO', 'YES|YES', 'YES|NO!', 'A|B|C|D|E|F|G|H']) {
    assert.throws(
      () =>
        decodeAssetMonitoringReportRequest({
          ...validReport(),
          holdings: [
            {
              ...validReport().holdings[0],
              asset: { ...CONDITIONAL_ASSET, internalOutcomeSetId },
            },
          ],
        }),
      /internal outcome set id is invalid/,
    )
  }
})

test('asset-monitoring codecs enforce asset, history, amount, and recovery-hint bounds', () => {
  const holding = validReport().holdings[0]
  const holdingsAtBound = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      asset: collateralAsset(`https://mint-${index}.example`),
      availableSubunits: 0,
      pendingOutgoingSubunits: 0,
    }))
  assert.doesNotThrow(() =>
    decodeAssetMonitoringReportRequest({
      ...validReport(),
      holdings: holdingsAtBound(ASSET_MONITORING_ASSETS_MAX),
    }),
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: holdingsAtBound(ASSET_MONITORING_ASSETS_MAX + 1),
      }),
    /holdings are invalid/,
  )
  assert.doesNotThrow(() =>
    decodeAssetMonitoringHistoryResponse({
      ...historyResponse(),
      points: Array.from(
        { length: ASSET_MONITORING_HISTORY_POINTS_MAX },
        () => historyResponse().points[0],
      ),
    }),
  )
  assert.throws(
    () =>
      decodeAssetMonitoringHistoryResponse({
        ...historyResponse(),
        points: Array.from(
          { length: ASSET_MONITORING_HISTORY_POINTS_MAX + 1 },
          () => historyResponse().points[0],
        ),
      }),
    /points are invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [{ ...holding, availableSubunits: -1 }],
      }),
    /available subunits is invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [{ ...holding, pendingOutgoingSubunits: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    /pending outgoing subunits is invalid/,
  )
  const recoveryHint = {
    keysetIds: Array.from(
      { length: ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX + 1 },
      (_, index) => `00${index.toString(16).padStart(14, '0')}`,
    ),
    counterIntervals: [{ start: 0, count: 1 }],
  }
  assert.doesNotThrow(() =>
    decodeAssetMonitoringReportRequest({
      ...validReport(),
      holdings: [
        {
          ...holding,
          recoveryHint: {
            keysetIds: Array.from(
              { length: ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX },
              (_, index) => `00${index.toString(16).padStart(14, '0')}`,
            ),
            counterIntervals: Array.from(
              { length: ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX },
              (_, index) => ({ start: index * 2, count: 1 }),
            ),
          },
        },
      ],
    }),
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [{ ...holding, recoveryHint }],
      }),
    /keyset ids are invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [
          {
            ...holding,
            recoveryHint: {
              keysetIds: [],
              counterIntervals: [{ start: 0, count: ASSET_MONITORING_RECOVERY_COUNTERS_MAX + 1 }],
            },
          },
        ],
      }),
    /counter intervals are invalid/,
  )
  assert.throws(
    () =>
      decodeAssetMonitoringReportRequest({
        ...validReport(),
        holdings: [
          {
            ...holding,
            recoveryHint: {
              keysetIds: [],
              counterIntervals: [
                { start: 0, count: 1 },
                { start: 0, count: 1 },
              ],
            },
          },
        ],
      }),
    /counter intervals are invalid/,
  )
})

test('asset-monitoring assets accepts a cursor and portfolio rejects it', () => {
  assert.deepEqual(
    decodeAssetMonitoringAssetsQuery({ walletId: WALLET_ID, pageSize: 200, cursor: 'cursor' }),
    {
      walletId: WALLET_ID,
      pageSize: 200,
      cursor: 'cursor',
    },
  )
  assert.throws(
    () => decodeAssetMonitoringAssetsQuery({ walletId: WALLET_ID, pageSize: 201 }),
    /page size is invalid/,
  )
  assert.throws(
    () => decodeAssetMonitoringPortfolioQuery({ walletId: WALLET_ID, cursor: 'not-allowed' }),
    /fields are invalid/,
  )
})

test('asset-monitoring client uses bounded reads, exact paths, and authorization binding', async () => {
  const auth: EngineAuthorizationRequest[] = []
  const requests: Array<{ url: string; method: string; body: string | undefined }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example/',
    authorization: (request) => {
      auth.push(request)
      return 'Bearer test'
    },
    fetchImpl: async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      requests.push({ url, method, body })
      if (url.includes('/reports')) return new Response(null, { status: 204 })
      if (url.includes('/summary')) return jsonResponse(summaryResponse())
      if (url.includes('/assets')) return jsonResponse(assetsResponse())
      if (url.includes('/history')) return jsonResponse({ ...historyResponse(), timeframe: '1W' })
      return jsonResponse({
        summary: summaryResponse(),
        assets: assetsResponse(),
        history: historyResponse(),
      })
    },
  })

  await client.submitAssetMonitoringReport({
    ...validReport(),
    holdings: [
      { ...validReport().holdings[0], asset: collateralAsset('https://z-mint.example') },
      { ...validReport().holdings[0], asset: collateralAsset('https://a-mint.example') },
    ],
  })
  await client.getAssetMonitoringSummary(WALLET_ID)
  await client.getAssetMonitoringAssets({ walletId: WALLET_ID, pageSize: 2, cursor: 'next page' })
  await client.getAssetMonitoringHistory({ walletId: WALLET_ID, timeframe: '1W' })
  await client.getPortfolio({ walletId: WALLET_ID, timeframe: 'ALL', pageSize: 50 })

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://engine.example/api/v1/asset-monitoring/reports',
      `https://engine.example/api/v1/asset-monitoring/summary?walletId=${WALLET_ID}`,
      `https://engine.example/api/v1/asset-monitoring/assets?walletId=${WALLET_ID}&pageSize=2&cursor=next+page`,
      `https://engine.example/api/v1/asset-monitoring/history?walletId=${WALLET_ID}&timeframe=1W`,
      `https://engine.example/api/v1/portfolio?walletId=${WALLET_ID}&timeframe=ALL&pageSize=50`,
    ],
  )
  assert.equal(auth[0].method, 'POST')
  assert.equal(auth[0].url, requests[0].url)
  assert.equal(auth[0].bodyText, requests[0].body)
  assert.equal(
    auth.slice(1).every((request) => request.method === 'GET' && request.bodyText === undefined),
    true,
  )
  const posted = JSON.parse(requests[0].body ?? '') as AssetMonitoringReportRequest
  assert.deepEqual(
    posted.holdings.map((holding) => holding.asset.canonicalMintUrl),
    ['https://a-mint.example', 'https://z-mint.example'],
  )
})

test('asset-monitoring client rejects an oversized response before parsing', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(ASSET_MONITORING_RESPONSE_BYTES_MAX + 1) },
      }),
  })
  await assert.rejects(
    () => client.getAssetMonitoringSummary(WALLET_ID),
    /response byte limit exceeded/,
  )
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
