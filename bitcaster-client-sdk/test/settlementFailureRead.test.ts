import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BitcasterEngineClient,
  decodeOrderSettlementFailureResponse,
  decodeParticipationScoreHistoryResponse,
} from '../src/engineClient.ts'
import type { components } from '../src/generated/api.ts'

const ORDER_ID = '11111111-1111-4111-8111-111111111111'
const GROUP_ID = '57e2c029-25f6-8546-9afe-3ea5a8c0049f'
const FAILED_AT = '2026-08-21T00:00:00.011+00:00'

// The engine's wire shape, typed by the generated contract.
const OWN: components['schemas']['OrderSettlementFailureResponse'] = {
  orderId: ORDER_ID,
  failure: { groupId: GROUP_ID, reason: 'OwnOutputReused', failedAt: FAILED_AT },
}

const HISTORY: components['schemas']['ParticipationScoreHistoryResponse'] = {
  balance: -97,
  entries: [
    {
      kind: 'reused-output-penalty',
      amountScore: -100,
      balanceAfter: -97,
      occurredAt: '2026-08-21T00:00:03Z',
    },
    {
      kind: 'invalid-capability-validation',
      amountScore: -15,
      balanceAfter: 3,
      occurredAt: '2026-08-21T00:00:02Z',
    },
    {
      kind: 'capability-binding',
      amountScore: -2,
      balanceAfter: 18,
      occurredAt: '2026-08-21T00:00:01Z',
    },
    { kind: 'purchase', amountScore: 20, balanceAfter: 20, occurredAt: '2026-08-21T00:00:00Z' },
  ],
}

test('settlement failure decoder keeps each reason of the wire contract', () => {
  assert.deepEqual(decodeOrderSettlementFailureResponse(OWN, ORDER_ID), OWN)
  const group = { ...OWN, failure: { ...OWN.failure!, reason: 'GroupOutputReused' } }
  assert.deepEqual(decodeOrderSettlementFailureResponse(group, ORDER_ID), group)
  assert.deepEqual(
    decodeOrderSettlementFailureResponse({ orderId: ORDER_ID, failure: null }, ORDER_ID),
    {
      orderId: ORDER_ID,
      failure: null,
    },
  )
})

test('settlement failure decoder refuses an unknown reason, another order and extra fields', () => {
  const cases: unknown[] = [
    { ...OWN, failure: { ...OWN.failure!, reason: 'SomethingElse' } },
    { ...OWN, orderId: '22222222-2222-4222-8222-222222222222' },
    { ...OWN, extra: true },
    { ...OWN, failure: { ...OWN.failure!, proof: 'secret' } },
    { orderId: ORDER_ID },
    { ...OWN, failure: { ...OWN.failure!, failedAt: 'yesterday' } },
    { ...OWN, failure: { ...OWN.failure!, groupId: 'not-a-uuid' } },
  ]
  for (const value of cases) {
    assert.throws(() => decodeOrderSettlementFailureResponse(value, ORDER_ID), Error)
  }
})

test('settlement failure read calls the new route and maps 404 to null', async () => {
  const urls: string[] = []
  let status = 200
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (url) => {
      urls.push(String(url))
      return status === 200
        ? Response.json(OWN)
        : new Response(JSON.stringify({ code: 'order-not-found' }), { status })
    },
  })

  assert.deepEqual(await client.getOrderSettlementFailure('condition-Alpha', ORDER_ID), OWN)
  status = 404
  assert.equal(await client.getOrderSettlementFailure('condition-Alpha', ORDER_ID), null)
  assert.deepEqual(urls, [
    `https://engine.example/api/v1/condition-Alpha/orders/${ORDER_ID}/settlement-failure`,
    `https://engine.example/api/v1/condition-Alpha/orders/${ORDER_ID}/settlement-failure`,
  ])
})

test('Score history decoder keeps every kind, newest first, and a negative balance', () => {
  assert.deepEqual(decodeParticipationScoreHistoryResponse(HISTORY), HISTORY)
  assert.deepEqual(decodeParticipationScoreHistoryResponse({ balance: 0, entries: [] }), {
    balance: 0,
    entries: [],
  })
})

test('Score history decoder refuses an unknown kind, extra fields and an oversized list', () => {
  const entry = HISTORY.entries[0]!
  const cases: unknown[] = [
    { ...HISTORY, entries: [{ ...entry, kind: 'promotional-grant' }] },
    { ...HISTORY, entries: [{ ...entry, referenceId: GROUP_ID }] },
    { ...HISTORY, extra: 1 },
    { ...HISTORY, entries: Array.from({ length: 51 }, () => entry) },
    { ...HISTORY, balance: 1.5 },
    { ...HISTORY, entries: [{ ...entry, amountScore: '1' }] },
  ]
  for (const value of cases) {
    assert.throws(() => decodeParticipationScoreHistoryResponse(value), Error)
  }
})

test('Score history read calls the new route', async () => {
  const urls: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (url) => {
      urls.push(String(url))
      return Response.json(HISTORY)
    },
  })

  assert.deepEqual(await client.getParticipationScoreHistory(), HISTORY)
  assert.deepEqual(urls, ['https://engine.example/api/v1/participation-score/history'])
})
