import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  addAvailableSatProofs,
  assertProofOperationCustodyBound,
  completeProofOperationWithWalletUpdate,
  decideProofOperationCustodyRecovery,
  emptyDaemonState,
  ensureState,
  initializeState,
  listLocalOrders,
  listLocalSwaps,
  listProofOperations,
  markProofOperationCompleted,
  markProofOperationMintSubmitted,
  prepareProofOperation as prepareProofOperationWithCustody,
  prepareProofOperationStateProjectionForTest as prepareProofOperation,
  readState,
  readStateScope,
  readActiveTradeRuntimeState,
  readPendingTakerRecoveryState,
  readWalletHoldingTotals,
  selectAvailableSatProofsForSend,
  setStateWriteFaultHookForTest,
  statePath,
  updateState,
  writeState,
  type LocalOrderRecord,
  type LocalSwapRecord,
} from '../src/state.ts'
import { deriveDaemonWalletProofIdFromProof } from '../src/stateSqlite.ts'

const SQLITE_TEST_CREATED_AT = '2026-07-14T00:00:00.000Z'

function localOrder(orderId: string, status: string): LocalOrderRecord {
  return {
    orderId,
    marketId: 'condition-YES',
    status,
    tradeIds: [],
    createdAt: SQLITE_TEST_CREATED_AT,
    updatedAt: SQLITE_TEST_CREATED_AT,
  }
}

function localSwap(
  tradeId: string,
  orderId: string,
  step: LocalSwapRecord['step'],
): LocalSwapRecord {
  return {
    tradeId,
    orderId,
    marketId: 'condition-YES',
    messages: {},
    step,
    createdAt: SQLITE_TEST_CREATED_AT,
    updatedAt: SQLITE_TEST_CREATED_AT,
  }
}

function assertQueryUsesIndex(
  database: DatabaseSync,
  sql: string,
  indexName: string,
): void {
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
    detail: string
  }>
  assert.equal(plan.some((row) => row.detail.includes(indexName)), true)
  assert.equal(
    plan.some((row) => row.detail.includes('USE TEMP B-TREE')),
    false,
  )
}

function assertQuerySearchesIndex(
  database: DatabaseSync,
  sql: string,
  indexName: string,
  params: Array<string | number>,
): void {
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string
  }>
  assert.equal(
    plan.some(
      (row) => row.detail.includes('SEARCH') && row.detail.includes(indexName),
    ),
    true,
  )
  assert.equal(plan.some((row) => row.detail.includes('USE TEMP B-TREE')), false)
}

function registerProofIdFunction(
  database: DatabaseSync,
  mintUrl: string,
  keysetId: string,
  unit = 'sat',
): void {
  database.function('derive_proof_id', { deterministic: true }, (secret) =>
    deriveDaemonWalletProofIdFromProof(mintUrl, unit, {
      id: keysetId,
      secret: String(secret),
    }),
  )
}

async function insertEphemeralKeyAuthority(keyId: string): Promise<void> {
  await initializeState()
  const database = new DatabaseSync(statePath())
  try {
    database
      .prepare(
        `INSERT INTO daemon_order_ephemeral_keys (
        key_id, schema_version, order_id, trade_id, market_id,
        private_key_hex, public_key_hex, created_at
      ) VALUES (?, 1, ?, NULL, 'test-market', ?, ?, ?)`,
      )
      .run(
        keyId,
        keyId,
        '01'.padStart(64, '0'),
        `02${'01'.repeat(32)}`,
        SQLITE_TEST_CREATED_AT,
      )
  } finally {
    database.close()
  }
}

async function withDaemonHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-state-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run(home)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

test('a fresh daemon profile creates only a durable SQLite state database', async () => {
  await withDaemonHome(async (home) => {
    const state = await initializeState()
    assert.deepEqual(state, emptyDaemonState())
    assert.equal(statePath(), join(home, 'daemon-state.sqlite'))
    assert.equal(
      (await readFile(statePath())).subarray(0, 16).toString(),
      'SQLite format 3\u0000',
    )
    if (process.platform !== 'win32') {
      assert.equal((await stat(statePath())).mode & 0o777, 0o600)
    }

    const database = new DatabaseSync(statePath())
    try {
      assert.equal(
        database.prepare('PRAGMA journal_mode').get().journal_mode,
        'wal',
      )
      const tables = database
        .prepare(
          `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name GLOB 'daemon_*' ORDER BY name`,
        )
        .all() as Array<{ name: string; sql: string }>
      assert.equal(
        tables.some((table) => table.name === 'daemon_state'),
        false,
      )
      assert.equal(tables.length, 17)
      assert.equal(
        tables.some((table) => table.name === 'daemon_seed_recovery_jobs'),
        true,
      )
      assert.equal(
        tables.some(
          (table) => table.name === 'daemon_seed_recovery_keysets',
        ),
        true,
      )
      assert.equal(
        tables.some(
          (table) => table.name === 'daemon_proof_operation_group_counts',
        ),
        true,
      )
      assert.equal(
        tables.every((table) => table.sql.includes('STRICT')),
        true,
      )
      const walletColumns = database
        .prepare('PRAGMA table_info(daemon_wallet_proofs)')
        .all() as Array<{ name: string; notnull: number; pk: number }>
      assert.deepEqual(
        walletColumns
          .filter((column) => column.pk > 0)
          .map((column) => column.name),
        ['proof_id'],
      )
      assert.equal(
        walletColumns.find((column) => column.name === 'proof_id')?.notnull,
        1,
      )
      const indexedColumns = (
        database
          .prepare(
            `SELECT name FROM sqlite_schema
          WHERE type = 'index' AND tbl_name = 'daemon_wallet_proofs'`,
          )
          .all() as Array<{ name: string }>
      ).flatMap((index) =>
        (
          database.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
            name: string
          }>
        ).map((column) => column.name),
      )
      assert.equal(indexedColumns.includes('proof_secret'), false)
      const jsonColumns = tables
        .flatMap((table) =>
          (
            database
              .prepare(`PRAGMA table_info(${table.name})`)
              .all() as Array<{ name: string }>
          )
            .map((column) => column.name)
            .filter((name) => name.endsWith('_json')),
        )
        .sort()
      assert.deepEqual(jsonColumns, [
        'buyer_locked_proofs_json',
        'buyer_pre_sigs_json',
        'dleq_json',
        'engine_status_json',
        'failure_json',
        'inputs_json',
        'metadata_json',
        'outputs_json',
        'result_proofs_json',
        'seller_pre_sigs_json',
        'witness_json',
      ])
    } finally {
      database.close()
    }
  })
})

test('production proof lifecycle fails closed without the custody coordinator', async () => {
  await withDaemonHome(async () => {
    const operation = {
      operationId: 'missing-coordinator',
      kind: 'wallet-send' as const,
      state: 'prepared' as const,
      mintUrl: 'https://mint.example',
      inputs: [],
      outputs: {},
      metadata: {},
      resultProofs: undefined,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const coordinatorUnavailable = /coordinator is not installed/

    await assert.rejects(
      () => prepareProofOperationWithCustody({
        operationId: operation.operationId,
        kind: operation.kind,
        mintUrl: operation.mintUrl,
        inputs: [],
        outputs: {},
      }),
      coordinatorUnavailable,
    )
    await assert.rejects(
      () => markProofOperationMintSubmitted(operation.operationId),
      coordinatorUnavailable,
    )
    await assert.rejects(
      () => markProofOperationCompleted(operation.operationId, {}),
      coordinatorUnavailable,
    )
    await assert.rejects(
      () => completeProofOperationWithWalletUpdate({
        operationId: operation.operationId,
        resultProofs: {},
        walletProofs: [],
        walletDelta: () => ({ deleteProofIds: [], upsertProofs: [] }),
      }),
      coordinatorUnavailable,
    )
    await assert.rejects(
      () => assertProofOperationCustodyBound(operation),
      coordinatorUnavailable,
    )
    await assert.rejects(
      () => decideProofOperationCustodyRecovery(
        operation,
        'all-inputs-unspent',
      ),
      coordinatorUnavailable,
    )
  })
})

test('an existing SQLite database with a missing state row fails closed', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    const database = new DatabaseSync(statePath())
    try {
      database.exec('DELETE FROM daemon_state_metadata')
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /state row is missing/)
    await assert.rejects(() => ensureState(), /state row is missing/)
  })
})

test('a malformed typed proof row never normalizes into an empty or usable state', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: {
        id: 'keyset-1',
        amount: 1,
        secret: 'bearer-secret',
        C: 'signature',
      },
            mintUrl: 'https://mint.example',
            unit: 'sat',
            state: 'available',
            asset: { kind: 'sats', baseAsset: 'sat' },
            createdAt: '2026-07-12T00:00:00.000Z',
            updatedAt: '2026-07-12T00:00:00.000Z',
    })
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_wallet_proofs SET amount = -1
         WHERE mint_url = ? AND proof_secret = ?`,
        )
        .run('https://mint.example', 'bearer-secret')
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /stored proof amount is invalid/)
  })
})

test('a malformed persisted local swap never normalizes private recovery material', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    }
    await writeState(state)

    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_swaps SET seller_adaptor_secret_hex = ?
         WHERE trade_id = ?`,
        )
        .run('not-hex', 'trade-1')
    } finally {
      database.close()
    }

    await assert.rejects(
      () => readState(),
      /seller adaptor material row is incomplete/,
    )
  })
})

test('trade runtime startup reads only indexed live orders and swaps', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.orders['active-order'] = localOrder('active-order', 'resting')
    state.orders['terminal-order'] = localOrder('terminal-order', 'filled')
    state.orders['taker-order'] = localOrder('taker-order', 'filled')
    state.swaps['active-trade'] = localSwap(
      'active-trade',
      'active-order',
      'opened',
    )
    state.swaps['terminal-trade'] = localSwap(
      'terminal-trade',
      'terminal-order',
      'confirmed',
    )
    state.swaps['taker-pending'] = {
      ...localSwap('taker-pending', 'taker-order', 'Failed'),
      isTaker: true,
      failureReason: 'maker-collateral-failure',
    }
    await writeState(state)

    const runtime = await readActiveTradeRuntimeState()
    assert.deepEqual(Object.keys(runtime.orders), ['active-order'])
    assert.deepEqual(Object.keys(runtime.swaps), ['active-trade'])
    const takerRecovery = await readPendingTakerRecoveryState()
    assert.deepEqual(Object.keys(takerRecovery.orders), ['taker-order'])
    assert.deepEqual(Object.keys(takerRecovery.swaps), ['taker-pending'])

    const database = new DatabaseSync(statePath())
    try {
      assertQueryUsesIndex(
        database,
        `SELECT order_id FROM daemon_orders
          WHERE status NOT IN ('Filled', 'filled', 'cancelled', 'Failed', 'failed')
          ORDER BY order_id`,
        'daemon_orders_active_runtime_idx',
      )
      assertQueryUsesIndex(
        database,
        `SELECT trade_id FROM daemon_swaps
          WHERE is_taker = 1
            AND failure_reason = 'maker-collateral-failure'
            AND (taker_recovery_status IS NULL OR taker_recovery_status = 'pending')
          ORDER BY trade_id`,
        'daemon_swaps_taker_recovery_idx',
      )
    } finally {
      database.close()
    }
  })
})

test('local history pages use bounded index seeks and reject invalid input', async () => {
  await withDaemonHome(async () => {
    await initializeState()
    const database = new DatabaseSync(statePath())
    try {
      const queries = [
        [
          `SELECT order_id FROM daemon_orders
            WHERE (updated_at, order_id) < (?, ?)
            ORDER BY updated_at DESC, order_id DESC LIMIT ?`,
          'daemon_orders_history_idx',
          [SQLITE_TEST_CREATED_AT, 'order-cursor', 101],
        ],
        [
          `SELECT trade_id FROM daemon_swaps
            WHERE (updated_at, trade_id) < (?, ?)
            ORDER BY updated_at DESC, trade_id DESC LIMIT ?`,
          'daemon_swaps_history_idx',
          [SQLITE_TEST_CREATED_AT, 'trade-cursor', 101],
        ],
        [
          `SELECT operation_id FROM daemon_proof_operations
            WHERE (updated_at, operation_id) < (?, ?)
            ORDER BY updated_at DESC, operation_id DESC LIMIT ?`,
          'daemon_proof_operations_history_idx',
          [Date.parse(SQLITE_TEST_CREATED_AT), 'operation-cursor', 101],
        ],
      ] as const
      for (const [sql, index, params] of queries) {
        assertQuerySearchesIndex(database, sql, index, [...params])
      }
    } finally {
      database.close()
    }

    await assert.rejects(
      () => listLocalOrders({ cursor: 'not-a-canonical-cursor' }),
      /order history cursor is invalid/,
    )
    await assert.rejects(
      () => listLocalOrders({ limit: 101 }),
      /daemon history page limit is invalid/,
    )
    await assert.rejects(
      () => listLocalOrders({ cursor: 42 as unknown as string }),
      /order history cursor is invalid/,
    )
    const swapCursor = Buffer.from(JSON.stringify({
      version: 1,
      kind: 'swap',
      sort: SQLITE_TEST_CREATED_AT,
      id: 'trade-cursor',
    })).toString('base64url')
    await assert.rejects(
      () => listLocalOrders({ cursor: swapCursor }),
      /order history cursor is invalid/,
    )
    await assert.rejects(
      () => listProofOperations({ kind: 'future-kind' }),
      /proof operation kind filter is invalid/,
    )
    await assert.rejects(
      () => listLocalSwaps({ step: 'future-step' }),
      /swap step filter is invalid/,
    )

    await prepareProofOperation({
      operationId: 'corrupt-history-operation',
      kind: 'wallet-send',
      mintUrl: 'https://mint.example',
      inputs: [{ amount: 1, secret: 'proof-secret', C: 'proof-signature' }],
      outputs: {},
    })
    const corrupt = new DatabaseSync(statePath())
    try {
      assert.throws(
        () => corrupt.prepare(
          `UPDATE daemon_proof_operations SET outputs_json = '[]'
            WHERE operation_id = 'corrupt-history-operation'`,
        ).run(),
        /CHECK constraint failed/,
      )
      corrupt.exec('PRAGMA ignore_check_constraints = ON')
      corrupt
        .prepare(
          `UPDATE daemon_proof_operations
              SET input_count = -1
            WHERE operation_id = 'corrupt-history-operation'`,
        )
        .run()
    } finally {
      corrupt.close()
    }
    await assert.rejects(
      () => listProofOperations(),
      /input count is invalid/,
    )
  })
})

test('a maximum-size history id round-trips through its continuation cursor', async () => {
  await withDaemonHome(async () => {
    const boundaryId = '"'.repeat(512)
    const state = emptyDaemonState()
    state.orders[boundaryId] = {
      ...localOrder(boundaryId, 'resting'),
      updatedAt: '2026-07-12T00:00:01.000Z',
    }
    state.orders.older = {
      ...localOrder('older', 'resting'),
      updatedAt: '2026-07-12T00:00:00.000Z',
    }
    await writeState(state)

    const first = await listLocalOrders({ limit: 1 })
    assert.equal(first.items[0]?.orderId, boundaryId)
    assert.equal(typeof first.nextCursor, 'string')
    assert.ok(first.nextCursor!.length > 1_024)

    const second = await listLocalOrders({
      limit: 1,
      cursor: first.nextCursor!,
    })
    assert.equal(second.items[0]?.orderId, 'older')
    assert.equal(second.nextCursor, null)
  })
})

test('state round-trips through SQLite and ignores a legacy JSON state file', async () => {
  await withDaemonHome(async (home) => {
    await writeFile(
      join(home, 'daemon-state.json'),
      JSON.stringify({ version: 1, wallet: { proofs: ['legacy'] } }),
    )
    assert.equal(await readState(), null)

    const state = emptyDaemonState()
    state.wallet.keysetCounters['https://mint.example/keyset'] = 3
    await writeState(state)

    assert.deepEqual((await readState())?.wallet.keysetCounters, {
      'https://mint.example/keyset': 3,
    })
  })
})

test('a legacy monolithic SQLite state row is rejected instead of migrated', async () => {
  await withDaemonHome(async () => {
    const database = new DatabaseSync(statePath())
    try {
      database.exec(`
        CREATE TABLE daemon_state (
          singleton INTEGER PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          payload TEXT NOT NULL
        ) STRICT
      `)
    } finally {
      database.close()
    }
    await assert.rejects(
      () => writeState(emptyDaemonState()),
      /legacy daemon SQLite state schema is unsupported/,
    )
  })
})

test('an unknown custody column fails closed before it can be erased', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: {
        id: 'keyset-1',
        amount: 1,
        secret: 'unknown-column-proof',
        C: 'signature',
      },
      mintUrl: 'https://mint.example',
      unit: 'sat',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    })
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      database.exec(
        'ALTER TABLE daemon_wallet_proofs ADD COLUMN future_custody_authority TEXT',
      )
      database
        .prepare('UPDATE daemon_wallet_proofs SET future_custody_authority = ?')
        .run('must-not-be-erased')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readState(),
      /daemon SQLite state schema is unsupported/,
    )
    await assert.rejects(
      () => writeState(emptyDaemonState()),
      /daemon SQLite state schema is unsupported/,
    )
  })
})

test('an orphan custody child row fails foreign-key validation', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA foreign_keys = OFF')
      database
        .prepare(
          `INSERT INTO daemon_trade_ciphers (
          trade_id, direction, message_type, ciphertext, sha256
        ) VALUES (?, 'received', 'adaptor-point', ?, ?)`,
        )
        .run('missing-trade', 'ciphertext', 'ab'.repeat(32))
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /state foreign keys are corrupt/)
  })
})

test('durable operation presence markers cannot hide persisted child rows', async () => {
  await withDaemonHome(async () => {
    await insertEphemeralKeyAuthority('marker-key')
    const state = emptyDaemonState()
    state.durableTradeSessions['marker-trade'] = {
      schemaVersion: 2,
      revision: 0,
      tradeId: 'marker-trade',
      role: 'seller',
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
      ephemeralKeyHandle: {
        keyId: 'marker-key',
        tradeId: 'marker-trade',
        role: 'seller',
        localProtocolPubkey: 'a'.repeat(64),
        counterpartyProtocolPubkey: 'b'.repeat(64),
        mintUrl: 'https://mint.example',
        sellerLocktimeSecs: 120,
        buyerLocktimeSecs: 100,
      },
      stage: 'intent',
      proofOperations: [],
      receivedCiphers: {},
      outboundCiphers: {},
    }
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      database
        .prepare(
          `INSERT INTO daemon_trade_expected_operations (
          trade_id, position, operation_id, operation_key, stage, kind
        ) VALUES (?, 0, ?, ?, 'claim', 'cashu-atomic')`,
        )
        .run('marker-trade', 'expected-op', 'expected-key')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readState(),
      /expected operation marker hides persisted rows/,
    )

    const plannedDatabase = new DatabaseSync(statePath())
    try {
      plannedDatabase
        .prepare(
          'DELETE FROM daemon_trade_expected_operations WHERE trade_id = ?',
        )
        .run('marker-trade')
      plannedDatabase
        .prepare(
          `INSERT INTO daemon_trade_planned_operations (
          trade_id, position, operation_id, operation_key, kind, stage,
          depends_on_operation_id, context_version, context_role,
          local_protocol_pubkey, counterparty_protocol_pubkey, mint_url,
          seller_locktime_secs, buyer_locktime_secs, condition_id, amm_scope_id,
          inventory_account_id, base_asset, unit, outcome_set_commitment,
          keyset_commitment, fee_commitment, merge_input_commitment,
          expected_output_commitment, merge_operation_key, lock_operation_key
        ) VALUES (?, 0, ?, ?, 'condition-ctf-merge', 'claim', ?, 1, 'seller',
          ?, ?, ?, 120, 100, ?, ?, ?, 'sat', 'sat', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'marker-trade',
          'planned-op',
          'planned-key',
          'depends-on',
          'a'.repeat(64),
          'b'.repeat(64),
          'https://mint.example',
          'condition-1',
          'amm-1',
          'inventory-1',
          'outcome-commitment',
          'keyset-commitment',
          'fee-commitment',
          'input-commitment',
          'output-commitment',
          'merge-key',
          'lock-key',
        )
    } finally {
      plannedDatabase.close()
    }
    await assert.rejects(
      () => readState(),
      /planned operation marker hides persisted rows/,
    )
  })
})

test('an unknown cipher direction never becomes outbound resend authority', async () => {
  await withDaemonHome(async () => {
    await insertEphemeralKeyAuthority('cipher-direction-key')
    const state = emptyDaemonState()
    state.durableTradeSessions['cipher-direction-trade'] = {
      schemaVersion: 2,
      revision: 0,
      tradeId: 'cipher-direction-trade',
      role: 'seller',
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
      ephemeralKeyHandle: {
        keyId: 'cipher-direction-key',
        tradeId: 'cipher-direction-trade',
        role: 'seller',
        localProtocolPubkey: 'a'.repeat(64),
        counterpartyProtocolPubkey: 'b'.repeat(64),
        mintUrl: 'https://mint.example',
        sellerLocktimeSecs: 120,
        buyerLocktimeSecs: 100,
      },
      stage: 'intent',
      proofOperations: [],
      receivedCiphers: {},
      outboundCiphers: {},
    }
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `INSERT INTO daemon_trade_ciphers (
          trade_id, direction, message_type, ciphertext, sha256
        ) VALUES (?, ?, 'adaptor-point', ?, ?)`,
        )
        .run(
          'cipher-direction-trade',
          'foreign-direction',
          'ciphertext',
          'digest',
        )
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /cipher direction row is invalid/)
  })
})

test('a SQLite storage fault rolls back a typed state replacement without erasing custody', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: {
        id: 'keyset-1',
        amount: 1,
        secret: 'disk-full-proof',
        C: '02'.padEnd(1_000, '0'),
      },
      mintUrl: 'https://mint.example',
      unit: 'sat',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    })
    setStateWriteFaultHookForTest((stage) => {
      if (stage === 'before-commit')
        throw new Error('injected storage exhaustion')
    })
    try {
      await assert.rejects(
        () => writeState(state),
        /injected storage exhaustion/,
      )
    } finally {
      setStateWriteFaultHookForTest(undefined)
    }
    assert.deepEqual(await readState(), emptyDaemonState())
  })
})

test('a terminal CTF failure code survives a SQLite restart', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.proofOperations['losing-ctf-redeem'] = {
      operationId: 'losing-ctf-redeem',
      kind: 'ctf-redeem',
      state: 'Failed',
      mintUrl: 'https://mint.example',
      inputs: [],
      outputs: {},
      metadata: {},
      lastError: 'oracle did not attest this outcome',
      failureCode: 13015,
      createdAt: 1,
      updatedAt: 2,
    }
    await writeState(state)
    assert.equal(
      (await readState())?.proofOperations['losing-ctf-redeem']?.failureCode,
      13015,
    )
  })
})

test('a keyed swap update never hydrates or rewrites an unrelated large proof pool', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.swaps['bounded-swap'] = {
      tradeId: 'bounded-swap',
      messages: {},
      step: 'opened',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      registerProofIdFunction(database, 'https://mint.example', 'keyset-1')
      database.exec(`
        WITH RECURSIVE proof_rows(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM proof_rows WHERE value < 20000
        )
        INSERT INTO daemon_wallet_proofs (
          proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
          witness_present, witness_json, dleq_present, dleq_json,
          proof_condition_id, proof_outcome_collection, state, reserved_by,
          asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
          created_at, updated_at
        )
        SELECT
          derive_proof_id('proof-' || value),
          'https://mint.example', 'sat', 'proof-' || value, 'keyset-1', 1, 'C-' || value,
          0, NULL, 0, NULL, NULL, NULL, 'available', NULL,
          'sats', NULL, NULL, 'sat',
          '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
        FROM proof_rows
      `)
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_wallet_proofs SET amount = -1 WHERE proof_secret = ?',
        )
        .run('proof-20000')
    } finally {
      database.close()
    }

    await updateState({ swapIds: ['bounded-swap'] }, (current, now) => {
      current.swaps['bounded-swap']!.error = 'bounded update completed'
      current.swaps['bounded-swap']!.updatedAt = now
    })

    const verify = new DatabaseSync(statePath())
    try {
      assert.equal(
        verify
          .prepare('SELECT COUNT(*) AS count FROM daemon_wallet_proofs')
          .get().count,
        20_000,
      )
      assert.equal(
        verify
          .prepare(
            'SELECT amount FROM daemon_wallet_proofs WHERE proof_secret = ?',
          )
          .get('proof-20000').amount,
        -1,
      )
      assert.equal(
        verify
          .prepare('SELECT error FROM daemon_swaps WHERE trade_id = ?')
          .get('bounded-swap').error,
        'bounded update completed',
      )
    } finally {
      verify.close()
    }
    await assert.rejects(() => readState(), /stored proof amount is invalid/)
  })
})

test('a keyed proof insert never hydrates unrelated proof history', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    const database = new DatabaseSync(statePath())
    try {
      registerProofIdFunction(
        database,
        'https://history.example',
        'keyset-history',
      )
      database.exec(`
        WITH RECURSIVE proof_rows(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM proof_rows WHERE value < 20000
        )
        INSERT INTO daemon_wallet_proofs (
          proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
          witness_present, witness_json, dleq_present, dleq_json,
          proof_condition_id, proof_outcome_collection, state, reserved_by,
          asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
          created_at, updated_at
        )
        SELECT
          derive_proof_id('proof-' || value),
          'https://history.example', 'sat', 'proof-' || value, 'keyset-history', 1, 'C-' || value,
          0, NULL, 0, NULL, NULL, NULL, 'available', NULL,
          'sats', NULL, NULL, 'sat',
          '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
        FROM proof_rows
      `)
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_wallet_proofs SET amount = -1
          WHERE mint_url = 'https://history.example' AND proof_secret = 'proof-1'`,
        )
        .run()
    } finally {
      database.close()
    }

    await addAvailableSatProofs('https://active.example', [
      {
        id: 'keyset-active',
        amount: 1,
        secret: 'new-proof',
        C: 'new-signature',
      },
    ])

    const verified = new DatabaseSync(statePath())
    try {
      assert.equal(
        verified
          .prepare('SELECT COUNT(*) AS count FROM daemon_wallet_proofs')
          .get().count,
        20001,
      )
    } finally {
      verified.close()
    }
    await assert.rejects(() => readState(), /stored proof amount is invalid/)
  })
})

test('wallet holding totals aggregate typed columns without hydrating proof payloads', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push(
      {
        proof: {
          id: 'keyset-sat',
          amount: 5,
          secret: 'sat-proof',
          C: 'sat-signature',
        },
        mintUrl: 'https://mint.example',
        unit: 'sat',
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat' },
        createdAt: SQLITE_TEST_CREATED_AT,
        updatedAt: SQLITE_TEST_CREATED_AT,
      },
      {
        proof: {
          id: 'keyset-yes',
          amount: 2,
          secret: 'yes-proof',
          C: 'yes-signature',
        },
        mintUrl: 'https://mint.example',
        unit: 'sat',
        state: 'available',
        asset: {
          kind: 'Outcome',
          conditionId: 'condition-1',
          outcomeSetId: 'YES',
          baseAsset: 'sat',
        },
        createdAt: SQLITE_TEST_CREATED_AT,
        updatedAt: SQLITE_TEST_CREATED_AT,
      },
      {
        proof: {
          id: 'keyset-no',
          amount: 3,
          secret: 'no-proof',
          C: 'no-signature',
        },
        mintUrl: 'https://mint.example',
        unit: 'sat',
        state: 'available',
        asset: {
          kind: 'Outcome',
          conditionId: 'condition-1',
          outcomeSetId: 'NO',
          baseAsset: 'sat',
        },
        createdAt: SQLITE_TEST_CREATED_AT,
        updatedAt: SQLITE_TEST_CREATED_AT,
      },
    )
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database.prepare('UPDATE daemon_wallet_proofs SET signature = ?').run('')
    } finally {
      database.close()
    }

    assert.deepEqual(
      await readWalletHoldingTotals({
        mintUrl: 'https://mint.example',
        conditionId: 'condition-1',
        baseAsset: 'sat',
      }),
      {
        baseUnitProofs: 5,
        outcomeAmountsBySet: { NO: 3, YES: 2 },
      },
    )
    await assert.rejects(() => readState(), /stored proof signature is invalid/)
  })
})

test('concurrent conflicting prepares cannot overwrite an exact persisted operation', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    const operationId = 'exact-operation-race'
    const prepare = (secret: string) =>
      prepareProofOperation({
      operationId,
      kind: 'wallet-send',
      mintUrl: 'https://mint.example',
      inputs: [{ amount: 1, secret, C: `C-${secret}` }],
      outputs: {},
    })
    const results = await Promise.allSettled([
      prepare('first'),
      prepare('second'),
    ])
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof prepare>>
      > => result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(String(rejected[0]?.reason), /does not match this swap step/)
    assert.equal(
      (await readState())?.proofOperations[operationId]?.inputs[0]?.secret,
      fulfilled[0]?.value.inputs[0]?.secret,
    )
  })
})

test('proof operation lifecycle rows fail closed without exact terminal payloads', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    await prepareProofOperation({
      operationId: 'strict-lifecycle-operation',
      kind: 'wallet-send',
      mintUrl: 'https://mint.example',
      inputs: [],
      outputs: {},
      metadata: {},
    })

    const database = new DatabaseSync(statePath())
    try {
      assert.throws(
        () =>
          database
            .prepare(
              `UPDATE daemon_proof_operations
              SET state = 'completed'
            WHERE operation_id = ?`,
            )
            .run('strict-lifecycle-operation'),
        /CHECK constraint failed/,
      )
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_proof_operations
            SET state = 'completed'
          WHERE operation_id = ?`,
        )
        .run('strict-lifecycle-operation')
    } finally {
      database.close()
    }

    await assert.rejects(
      () =>
        readStateScope({ proofOperationIds: ['strict-lifecycle-operation'] }),
      /completion result row is invalid/,
    )
    await assert.rejects(() => readState(), /completion result row is invalid/)

    const failureDatabase = new DatabaseSync(statePath())
    try {
      failureDatabase.exec('PRAGMA ignore_check_constraints = ON')
      failureDatabase
        .prepare(
          `UPDATE daemon_proof_operations
            SET state = 'prepared', failure_code = 13015
          WHERE operation_id = ?`,
        )
        .run('strict-lifecycle-operation')
    } finally {
      failureDatabase.close()
    }
    await assert.rejects(
      () =>
        readStateScope({ proofOperationIds: ['strict-lifecycle-operation'] }),
      /failure code row is invalid/,
    )
    await assert.rejects(() => readState(), /failure code row is invalid/)
  })
})

test('completed proof operation result groups and counts fail closed in full and keyed reads', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.proofOperations['malformed-completed-result'] = {
      operationId: 'malformed-completed-result',
      kind: 'wallet-send',
      state: 'completed',
      mintUrl: 'https://mint.example',
      inputs: [{ id: 'keyset-1', amount: 2, secret: 'input', C: 'input-C' }],
      outputs: {
        send: [
          {
            blindedMessage: { amount: 1, id: 'keyset-1', B_: 'send-B' },
            blindingFactor: 'send-r',
            secret: 'send-secret',
          },
        ],
        keep: [
          {
            blindedMessage: { amount: 1, id: 'keyset-1', B_: 'keep-B' },
            blindingFactor: 'keep-r',
            secret: 'keep-secret',
          },
        ],
      },
      metadata: { unselectedProofs: [] },
      resultProofs: {
        send: [
          { id: 'keyset-1', amount: 1, secret: 'send-result', C: 'send-C' },
        ],
        keep: [
          { id: 'keyset-1', amount: 1, secret: 'keep-result', C: 'keep-C' },
        ],
      },
      lastError: null,
      createdAt: 1,
      updatedAt: 2,
    }
    await writeState(state)

    const database = new DatabaseSync(statePath())
    try {
      database
        .prepare(
          `UPDATE daemon_proof_operations
            SET result_proofs_json = '{}'
          WHERE operation_id = ?`,
        )
        .run('malformed-completed-result')
    } finally {
      database.close()
    }

    await assert.rejects(
      () =>
        readStateScope({ proofOperationIds: ['malformed-completed-result'] }),
      /proof operation completed result groups are invalid/,
    )
    await assert.rejects(
      () => readState(),
      /proof operation completed result groups are invalid/,
    )

    const countDatabase = new DatabaseSync(statePath())
    try {
      countDatabase
        .prepare(
          `UPDATE daemon_proof_operations
            SET result_proofs_json = ?
          WHERE operation_id = ?`,
        )
        .run(
          JSON.stringify({
            send: [
              { id: 'keyset-1', amount: 1, secret: 'send-result', C: 'send-C' },
            ],
            keep: [],
          }),
          'malformed-completed-result',
        )
    } finally {
      countDatabase.close()
    }

    await assert.rejects(
      () =>
        readStateScope({ proofOperationIds: ['malformed-completed-result'] }),
      /proof operation completed result counts are invalid/,
    )
    await assert.rejects(
      () => readState(),
      /proof operation completed result counts are invalid/,
    )
  })
})

test('presence markers cannot hide persisted custody or protocol payloads', async () => {
  await withDaemonHome(async () => {
    const operationState = emptyDaemonState()
    operationState.proofOperations['completed-operation'] = {
      operationId: 'completed-operation',
      kind: 'wallet-send',
      state: 'completed',
      mintUrl: 'https://mint.example',
      inputs: [],
      outputs: {
        send: [
          {
            blindedMessage: { amount: 1, id: 'keyset-1', B_: 'B-successor' },
            blindingFactor: 'blind-successor',
            secret: 'output-successor',
          },
        ],
        keep: [],
      },
      metadata: { unselectedProofs: [] },
      resultProofs: {
        send: [
          { id: 'keyset-1', amount: 1, secret: 'successor', C: 'signature' },
        ],
        keep: [],
      },
      lastError: null,
      createdAt: 1,
      updatedAt: 2,
    }
    await writeState(operationState)
    let database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_proof_operations SET has_result_proofs = 0 WHERE operation_id = ?',
        )
        .run('completed-operation')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readState(),
      /proof operation result presence row is invalid/,
    )
    await assert.rejects(
      () => readStateScope({ proofOperationIds: ['completed-operation'] }),
      /proof operation result presence row is invalid/,
    )

    const proofState = emptyDaemonState()
    proofState.wallet.proofs.push({
      proof: {
        id: 'keyset-1',
        amount: 1,
        secret: 'witness-proof',
        C: 'signature',
        witness: { signatures: ['witness-signature'] },
        dleq: { e: 'challenge', s: 'response', r: 'blind' },
      },
      mintUrl: 'https://mint.example',
      unit: 'sat',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    })
    await writeState(proofState)
    const witnessProofId = deriveDaemonWalletProofIdFromProof(
      'https://mint.example',
      'sat',
      { id: 'keyset-1', secret: 'witness-proof' },
    )
    database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_wallet_proofs SET witness_present = 0 WHERE proof_id = ?',
        )
        .run(witnessProofId)
    } finally {
      database.close()
    }
    await assert.rejects(
      () =>
        readStateScope({
          walletProofs: [
            {
              mintUrl: 'https://mint.example',
              proofIds: [witnessProofId],
            },
          ],
        }),
      /proof witness presence row is invalid/,
    )

    await writeState(proofState)
    database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_wallet_proofs SET dleq_present = 0 WHERE proof_id = ?',
        )
        .run(witnessProofId)
    } finally {
      database.close()
    }
    await assert.rejects(
      () =>
        readStateScope({
          walletProofs: [
            {
              mintUrl: 'https://mint.example',
              proofIds: [witnessProofId],
            },
          ],
        }),
      /proof DLEQ presence row is invalid/,
    )

    const orderState = emptyDaemonState()
    orderState.orders['order-with-status'] = {
      orderId: 'order-with-status',
      marketId: 'cond-YES',
      status: 'resting',
      tradeIds: [],
      engineStatus: { status: 'Open' },
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }
    await writeState(orderState)
    database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_orders SET engine_status_present = 0 WHERE order_id = ?',
        )
        .run('order-with-status')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readStateScope({ orderIds: ['order-with-status'] }),
      /order engine status presence row is invalid/,
    )
  })
})

test('partial swap recovery tuples fail closed in full and keyed reads', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.swaps['recovery-tuple'] = {
      tradeId: 'recovery-tuple',
      messages: {},
      buyerPreSigsHex: ['buyer-presig'],
      buyerLockedProofs: [
        { id: 'keyset-1', amount: 1, secret: 'buyer-proof', C: 'signature' },
      ],
      sellerPreSigsHex: ['seller-presig'],
      takerRecovery: {
        clientOrderId: 'replacement-client-order',
        status: 'submitted',
        replacementOrderId: 'replacement-order',
      },
      step: 'buyer-responded',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }
    await writeState(state)
    let database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_swaps SET buyer_locked_proofs_json = NULL WHERE trade_id = ?',
        )
        .run('recovery-tuple')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readState(),
      /buyer recovery artifacts row is incomplete/,
    )
    await assert.rejects(
      () => readStateScope({ swapIds: ['recovery-tuple'] }),
      /buyer recovery artifacts row is incomplete/,
    )

    await writeState(state)
    database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_swaps SET taker_replacement_order_id = NULL WHERE trade_id = ?',
        )
        .run('recovery-tuple')
    } finally {
      database.close()
    }
    await assert.rejects(() => readState(), /taker recovery row is invalid/)
    await assert.rejects(
      () => readStateScope({ swapIds: ['recovery-tuple'] }),
      /taker recovery row is invalid/,
    )
  })
})

test('available proof selection reads a bounded indexed prefix at 50000 proofs', async () => {
  await withDaemonHome(async () => {
    await writeState(emptyDaemonState())
    const database = new DatabaseSync(statePath())
    try {
      registerProofIdFunction(
        database,
        'https://mint.example',
        'keyset-1',
        'msat',
      )
      database.exec(`
        WITH RECURSIVE proof_rows(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM proof_rows WHERE value < 50000
        )
        INSERT INTO daemon_wallet_proofs (
          proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
          witness_present, witness_json, dleq_present, dleq_json,
          proof_condition_id, proof_outcome_collection, state, reserved_by,
          asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
          created_at, updated_at
        )
        SELECT
          derive_proof_id('proof-' || value),
          'https://mint.example', 'msat', 'proof-' || value, 'keyset-1', 50001 - value,
          'C-' || value, 0, NULL, 0, NULL, NULL, NULL, 'available', NULL,
          'sats', NULL, NULL, 'sat',
          '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
        FROM proof_rows
      `)
      const queryPlan = database
        .prepare(
          `EXPLAIN QUERY PLAN
         SELECT * FROM daemon_wallet_proofs
          WHERE mint_url = ? AND unit = 'msat'
            AND state = 'available' AND asset_kind = 'sats'
            AND base_asset = ? AND asset_condition_id IS NULL
            AND asset_outcome_set_id IS NULL
          ORDER BY amount DESC, proof_id
          LIMIT 257`,
        )
        .all('https://mint.example', 'sat') as Array<{ detail: string }>
      assert.equal(
        queryPlan.some((row) => row.detail.includes('USE TEMP B-TREE')),
        false,
      )
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          'UPDATE daemon_wallet_proofs SET signature = ? WHERE proof_secret = ?',
        )
        .run('', 'proof-50000')
    } finally {
      database.close()
    }

    const selected = await selectAvailableSatProofsForSend({
      mintUrl: 'https://mint.example',
      amountSats: 1,
    })
    assert.deepEqual(
      selected.map((proof) => proof.secret),
      ['proof-1'],
    )

    const verify = new DatabaseSync(statePath())
    try {
      assert.equal(
        verify
          .prepare(
            `SELECT COUNT(*) AS count FROM daemon_wallet_proofs
            WHERE state = 'reserved'`,
          )
          .get().count,
        0,
      )
    } finally {
      verify.close()
    }
    const corruptProofId = deriveDaemonWalletProofIdFromProof(
      'https://mint.example',
      'msat',
      { id: 'keyset-1', secret: 'proof-50000' },
    )
    await assert.rejects(
      () => readStateScope({ walletProofs: [{ proofIds: [corruptProofId] }] }),
      /proof signature/,
    )
  })
})
