import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DaemonTakerFillRecovery } from '../src/takerFillRecovery.ts'
import { emptyDaemonState, readState, writeState } from '../src/state.ts'

test('maker-collateral failure re-submits one durable daemon taker replacement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-taker-recovery-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['taker-order'] = {
      orderId: 'taker-order',
      marketId: 'condition-YES',
      tokenSide: 'Outcome',
      side: 'Buy',
      priceSubunits: 5_000,
      amountSubunits: 10_000,
      timeInForce: 'FAK',
      recoveryAttempt: 0,
      status: 'filled',
      tradeIds: ['failed-trade'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    state.swaps['failed-trade'] = {
      tradeId: 'failed-trade',
      marketId: 'condition-YES',
      orderId: 'taker-order',
      isTaker: true,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      fillAmountSubunits: 4_000,
      failureReason: 'maker-collateral-failure',
      messages: {},
      step: 'Failed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }
    await writeState(state)

    const requests: Array<{ marketId: string; request: unknown }> = []
    const recovery = new DaemonTakerFillRecovery({
      submitOrder: async (marketId, request) => {
        requests.push({ marketId, request })
        return {
          orderId: 'replacement-order',
          status: 'resting',
          remainingAmountSubunits: 4_000,
          fills: [],
          baseAsset: 'sat',
          divisibility: 10_000,
        }
      },
      newClientOrderId: () => 'replacement-client-order',
    })

    await recovery.recoverTrade('failed-trade')
    await recovery.recoverTrade('failed-trade')

    assert.deepEqual(requests, [
      {
        marketId: 'condition-YES',
        request: {
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 5_000,
          amountSubunits: 4_000,
          timeInForce: 'FAK',
          clientOrderId: 'replacement-client-order',
        },
      },
    ])
    const persisted = await readState()
    assert.equal(persisted?.orders['replacement-order']?.recoveryAttempt, 1)
    assert.deepEqual(persisted?.swaps['failed-trade']?.takerRecovery, {
      clientOrderId: 'replacement-client-order',
      status: 'submitted',
      replacementOrderId: 'replacement-order',
    })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
