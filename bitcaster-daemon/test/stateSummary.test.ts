import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  addAvailableProofs,
  addAvailableSatProofs,
  emptyDaemonState,
  initializeState,
  readActiveSwapIdsPage,
  readDaemonStatusSnapshot,
  readState,
  readWalletBalance,
  readWalletProofAmountSample,
  statePath,
  summarizeWalletBalance,
  type CashuProofRecord,
  type DaemonState,
} from '../src/state.ts'
import {
  TEST_SESSION_PUBLIC_KEY,
  writeStateWithDurableSessionKeys,
} from './durableSessionTestStore.ts'

const MINT_URL = 'https://mint.example'
const CREATED_AT = '2026-07-14T00:00:00.000Z'
const COUNTERPARTY_PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-summary-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

test('daemon status and wallet balance aggregate without decoding bearer proofs', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    await addAvailableSatProofs(MINT_URL, [proof(4, 'sat-proof')])
    await addAvailableProofs(MINT_URL, [proof(7, 'outcome-proof')], {
      kind: 'Outcome',
      conditionId: 'condition-1',
      outcomeSetId: 'YES',
      baseAsset: 'sat',
    }, 'sat')
    const fullState = await readState()
    assert.ok(fullState)
    const expected = summarizeWalletBalance(fullState)

    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_wallet_proofs
            SET proof_secret = ''
          WHERE mint_url = ? AND amount = ?`,
        )
        .run(MINT_URL, 4)
    } finally {
      database.close()
    }

    await assert.rejects(() => readState(), /proof|secret|identity/i)
    assert.deepEqual(await readWalletBalance(), expected)
    assert.deepEqual(await readDaemonStatusSnapshot(), {
      counts: { proofs: 2, proofOperations: 0, orders: 0, swaps: 0 },
      wallet: expected,
    })
  })
})

test('wallet receive denomination sample is indexed, payload-free, and count-capped', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    await addAvailableSatProofs(MINT_URL, [
      ...Array.from({ length: 5 }, (_, index) => proof(1, `one-${index}`)),
      ...Array.from({ length: 2 }, (_, index) => proof(2, `two-${index}`)),
    ])
    const database = new DatabaseSync(statePath())
    try {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT amount, COUNT(*) AS proof_count
             FROM daemon_wallet_proofs INDEXED BY daemon_wallet_proofs_denomination_idx
            WHERE mint_url = ? AND unit = ?
            GROUP BY amount
            ORDER BY amount
            LIMIT ?`,
        )
        .all(MINT_URL, 'sat', 257) as Array<{ detail: string }>
      assert.equal(
        plan.some((row) => row.detail.includes('daemon_wallet_proofs_denomination_idx')),
        true,
      )
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare('UPDATE daemon_wallet_proofs SET signature = ? WHERE proof_secret = ?')
        .run('', 'one-0')
    } finally {
      database.close()
    }

    assert.deepEqual(
      await readWalletProofAmountSample({ mintUrl: MINT_URL, unit: 'sat' }),
      [{ amount: 1 }, { amount: 1 }, { amount: 1 }, { amount: 2 }, { amount: 2 }],
    )
  })
})

test('daemon legacy swap recovery pages only active normalized rows', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    const state = emptyDaemonState()
    addTrade(state, 'trade-a', 'intent', 'opened')
    addTrade(state, 'trade-b', 'reconciliation-complete', 'confirmed')
    // Proof reconciliation can finish before transport replay/engine terminal
    // state. This session must remain recoverable while its swap is active.
    addTrade(state, 'trade-c', 'reconciliation-complete', 'settling')
    await writeStateWithDurableSessionKeys(state)

    assert.deepEqual(await readActiveSwapIdsPage({ cursor: null, limit: 1 }), {
      ids: ['trade-a'],
      nextCursor: 'trade-a',
    })
    assert.deepEqual(
      await readActiveSwapIdsPage({ cursor: 'trade-a', limit: 1 }),
      {
        ids: ['trade-c'],
        nextCursor: null,
      },
    )
  })
})

test('daemon legacy swap recovery cursor uses a partial range index', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    const database = new DatabaseSync(statePath())
    try {
      const swapPlan = database
        .prepare(
          `EXPLAIN QUERY PLAN
         SELECT trade_id FROM daemon_swaps
          WHERE step IN ('awaiting-trade-created', 'opened', 'seller-opened', 'buyer-responded', 'settling', 'awaiting-confirmation')
            AND trade_id > ?
          ORDER BY trade_id LIMIT ?`,
        )
        .all('cursor', 65) as Array<{ detail: string }>
      assert.equal(
        swapPlan.some(
          (row) =>
            row.detail.includes('daemon_swaps_active_recovery_idx') &&
            row.detail.includes('trade_id>?'),
        ),
        true,
      )
    } finally {
      database.close()
    }
  })
})

function addTrade(
  state: DaemonState,
  tradeId: string,
  sessionStage: DaemonState['durableTradeSessions'][string]['stage'],
  swapStep: DaemonState['swaps'][string]['step'],
): void {
  const orderId = `order-${tradeId}`
  const marketId = `market-${tradeId}`
  state.durableTradeSessions[tradeId] = {
    schemaVersion: 2,
    revision: 0,
    tradeId,
    role: 'seller',
    localProtocolPubkey: TEST_SESSION_PUBLIC_KEY,
    counterpartyProtocolPubkey: COUNTERPARTY_PUBLIC_KEY,
    mintUrl: MINT_URL,
    sellerLocktimeSecs: 2_000_000_000,
    buyerLocktimeSecs: 1_999_999_900,
    ephemeralKeyHandle: {
      keyId: tradeId,
      tradeId,
      role: 'seller',
      localProtocolPubkey: TEST_SESSION_PUBLIC_KEY,
      counterpartyProtocolPubkey: COUNTERPARTY_PUBLIC_KEY,
      mintUrl: MINT_URL,
      sellerLocktimeSecs: 2_000_000_000,
      buyerLocktimeSecs: 1_999_999_900,
    },
    stage: sessionStage,
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
  state.swaps[tradeId] = {
    tradeId,
    marketId,
    orderId,
    role: 'seller',
    counterpartyPubkey: COUNTERPARTY_PUBLIC_KEY,
    sellerLocktime: 2_000_000_000,
    buyerLocktime: 1_999_999_900,
    messages: {},
    step: swapStep,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
}

function proof(amount: number, secret: string): CashuProofRecord {
  return { id: 'keyset-1', amount, secret, C: `signature-${secret}` }
}
