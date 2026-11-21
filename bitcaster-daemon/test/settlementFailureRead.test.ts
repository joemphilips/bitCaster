import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  OrderSettlementFailureResponse,
  ParticipationScoreHistoryResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { dispatch, type EngineClientLike } from '../src/server.ts'

const MARKET_ID = 'condition-1-YES'
const ORDER_ID = '44444444-4444-4444-8444-444444444444'
const FAILURE: OrderSettlementFailureResponse = {
  orderId: ORDER_ID,
  failure: {
    groupId: '77777777-7777-4777-8777-777777777777',
    reason: 'OwnOutputReused',
    failedAt: '2026-08-21T00:00:00.011+00:00',
  },
}
const HISTORY: ParticipationScoreHistoryResponse = {
  balance: -100,
  entries: [
    {
      kind: 'reused-output-penalty',
      amountScore: -100,
      balanceAfter: -100,
      occurredAt: '2026-08-21T00:00:00.011+00:00',
    },
  ],
}

test('order settlement failure returns the engine reason for one order', async () => {
  await withProfile(async () => {
    const reads: Array<[string, string]> = []
    const engine = {
      getOrderSettlementFailure: async (marketId: string, orderId: string) => {
        reads.push([marketId, orderId])
        return orderId === ORDER_ID ? FAILURE : null
      },
    } as unknown as EngineClientLike

    const found = await dispatch(
      { method: 'order.settlement-failure', params: { marketId: MARKET_ID, orderId: ORDER_ID } },
      { createEngineClient: () => engine },
    )
    const missing = await dispatch(
      {
        method: 'order.settlement-failure',
        params: { marketId: MARKET_ID, orderId: '55555555-5555-4555-8555-555555555555' },
      },
      { createEngineClient: () => engine },
    )

    assert.deepEqual(found, { ok: true, result: FAILURE })
    assert.deepEqual(missing, { ok: true, result: null })
    assert.deepEqual(reads, [
      [MARKET_ID, ORDER_ID],
      [MARKET_ID, '55555555-5555-4555-8555-555555555555'],
    ])
  })
})

test('Score history returns the engine rows, and a failed read has a stable code', async () => {
  await withProfile(async () => {
    let fail = false
    const engine = {
      getParticipationScoreHistory: async () => {
        if (fail) throw new Error('engine down')
        return HISTORY
      },
    } as unknown as EngineClientLike

    assert.deepEqual(
      await dispatch({ method: 'score.history' }, { createEngineClient: () => engine }),
      { ok: true, result: HISTORY },
    )
    fail = true
    assert.deepEqual(
      await dispatch({ method: 'score.history' }, { createEngineClient: () => engine }),
      { ok: false, code: 'score-unavailable', error: 'Participation Score is unavailable' },
    )
  })
})

async function withProfile(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-settlement-failure-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}
