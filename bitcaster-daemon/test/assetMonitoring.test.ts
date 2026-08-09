import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDaemonAssetMonitoringHoldings,
  createDaemonAssetMonitoring,
} from '../src/assetMonitoring.ts'

const scopeId = 'custody:wallet:test'
const proofId = 'a'.repeat(64)

test('native asset monitoring reads metadata only and counts available and pending exact units', async () => {
  let query = ''
  const holdings = await buildDaemonAssetMonitoringHoldings(
    async (action) =>
      action({
        prepare: (sql: string) => ({
          all: () => {
            query = sql
            return [
              row({ proofId, amount: 7, state: 'available' }),
              row({ proofId: 'b'.repeat(64), amount: 11, state: 'reserved' }),
            ]
          },
        }),
      } as never),
    {
      scopeId,
      engineBaseUrl: 'https://engine.example',
      fetchImpl: async () => new Response(JSON.stringify({ markets: [] })),
    },
  )
  assert.equal(/proof_body|secret|signature/i.test(query), false)
  assert.deepEqual(
    holdings?.map((holding) => [holding.availableSubunits, holding.pendingOutgoingSubunits]),
    [[7, 11]],
  )
})

test('native asset monitoring skips a complete report on duplicate metadata conflict', async () => {
  const holdings = await buildDaemonAssetMonitoringHoldings(
    async (action) =>
      action({
        prepare: () => ({
          all: () => [
            row({ proofId, amount: 7, state: 'available' }),
            row({ proofId, amount: 8, state: 'available' }),
          ],
        }),
      } as never),
    {
      scopeId,
      engineBaseUrl: 'https://engine.example',
      fetchImpl: async () => new Response(JSON.stringify({ markets: [] })),
    },
  )
  assert.equal(holdings, null)
})

test('native asset monitoring submits after startup and each successful scoped commit', async () => {
  let onCommit: (() => void) | undefined
  let amount = 7
  const requests: unknown[] = []
  const monitoring = createDaemonAssetMonitoring({
    directory: '/profile-a',
    scopeId,
    walletId: 'b'.repeat(64),
    engineBaseUrl: 'https://engine.example',
    remote: {
      submitAssetMonitoringReport: async (request) => {
        requests.push(request)
      },
    },
    fetchImpl: async () => new Response(JSON.stringify({ markets: [] })),
    hasPendingSubmittedOrder: async () => false,
    storage: monitoringStorage(() => amount),
    subscribeToCommits: (callback) => {
      onCommit = callback
      return () => {
        onCommit = undefined
      }
    },
  })

  monitoring.start()
  await waitFor(() => requests.length === 1)
  amount = 8
  onCommit?.()
  await waitFor(() => requests.length === 2)
  await new Promise((resolve) => setTimeout(resolve, 0))
  onCommit?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(requests.length, 2)
  monitoring.stop()
})

test('native asset monitoring ignores rolled-back changes and stops future commit activity', async () => {
  let onCommit: (() => void) | undefined
  let requests = 0
  const monitoring = createDaemonAssetMonitoring({
    directory: '/profile-a',
    scopeId,
    walletId: 'b'.repeat(64),
    engineBaseUrl: 'https://engine.example',
    remote: { submitAssetMonitoringReport: async () => void (requests += 1) },
    fetchImpl: async () => new Response(JSON.stringify({ markets: [] })),
    hasPendingSubmittedOrder: async () => false,
    storage: monitoringStorage(),
    subscribeToCommits: (callback) => {
      onCommit = callback
      return () => {
        onCommit = undefined
      }
    },
  })

  monitoring.start()
  await waitFor(() => requests === 1)
  // A rolled-back custody transaction does not invoke the successful-commit observer.
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(requests, 1)
  monitoring.stop()
  onCommit?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(requests, 1)
})

function row(overrides: { proofId: string; amount: number; state: string }) {
  return {
    ...overrides,
    normalizedMint: 'https://mint.example',
    unit: 'msat',
    keysetId: `00${'a'.repeat(14)}`,
    baseAsset: 'sat',
    conditionId: null,
    outcomeSetId: null,
    source: 'target',
    selectability: null,
    nut07State: null,
  }
}

function monitoringStorage(amount: () => number = () => 7) {
  return {
    read: async <T>(action: (database: never) => T) =>
      action({
        prepare: () => ({ all: () => [row({ proofId, amount: amount(), state: 'available' })] }),
      } as never),
    transaction: async <T>(_action: (database: never) => T) => {
      throw new Error('monitoring must not mutate custody storage')
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition did not become true')
}
