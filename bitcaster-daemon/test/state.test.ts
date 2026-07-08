import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readState } from '../src/state.ts'

test('readState normalizes pre-P48 lowercase persisted enum values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-state-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await writeFile(
      join(home, 'daemon-state.json'),
      JSON.stringify({
        version: 1,
        wallet: {
          proofs: [
            {
              proof: { amount: 100, id: 'keyset', secret: 's', C: 'sig' },
              mintUrl: 'https://mint.example',
              state: 'available',
              asset: {
                kind: 'outcome',
                conditionId: 'cond',
                outcomeSetId: 'YES',
              },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          keysetCounters: {},
        },
        proofOperations: {
          'op-1': {
            operationId: 'op-1',
            kind: 'regular-split',
            state: 'failed',
            mintUrl: 'https://mint.example',
            inputs: [],
            outputs: {},
            metadata: {},
            createdAt: 1,
            updatedAt: 2,
          },
        },
        orders: {
          'order-1': {
            orderId: 'order-1',
            marketId: 'cond-YES',
            tokenSide: 'outcome',
            side: 'buy',
            status: 'open',
            tradeIds: ['trade-1'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        swaps: {
          'trade-1': {
            tradeId: 'trade-1',
            messages: {},
            step: 'failed',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    )

    const state = await readState()

    assert.equal(state?.wallet.proofs[0].asset.kind, 'Outcome')
    assert.equal(state?.proofOperations['op-1']?.state, 'Failed')
    assert.equal(state?.orders['order-1']?.tokenSide, 'Outcome')
    assert.equal(state?.orders['order-1']?.side, 'Buy')
    assert.equal(state?.swaps['trade-1']?.step, 'Failed')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
