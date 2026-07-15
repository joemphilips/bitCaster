import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  decodeDurableCustodyRecord,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  readDurableCustodyRecoveryPage,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyTransaction,
} from '@bitcaster-market/client-sdk/durableCustody'
import { openProfileDatabase, profileDatabasePath } from '../src/profile.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'
import {
  DaemonCustodyUnitOfWork,
  setDaemonCustodyUnitOfWorkFaultHookForTest,
} from '../src/durableCustodyUnitOfWork.ts'
import { emptyDaemonState, readState, writeState } from '../src/state.ts'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)
const FINGERPRINT_C = 'c'.repeat(64)

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-custody-store-'))
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

function profileScope(walletId = FINGERPRINT_A): DurableCustodyScope {
  return {
    scopeKind: 'wallet',
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
  }
}

function marketScope(input: {
  marketId: string
  inventoryAccountId: string
}): DurableCustodyScope {
  const value = {
    scopeKind: 'market' as const,
    marketId: input.marketId,
    inventoryAccountId: input.inventoryAccountId,
    normalizedMint: 'https://mint.example',
    unit: 'sat',
  }
  return { ...value, scopeId: deriveDurableCustodyScopeId(value) }
}

function custodyTransactionInput(
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  ...operations: Array<DurableCustodyRecord | string>
) {
  return {
    scope,
    owner,
    operationIds: operations.map((operation) =>
      typeof operation === 'string'
        ? operation
        : operation.operation.operationId,
    ),
  }
}

function record(
  scope: DurableCustodyScope,
  input: {
    tradeId?: string
    retainedOperationKey?: string
    sessionId?: string
    proofId?: string
  } = {},
): DurableCustodyRecord {
  const tradeId = input.tradeId ?? 'trade-001'
  const retainedOperationKey = input.retainedOperationKey ?? 'seller-lock-001'
  const sessionId = input.sessionId ?? `session-${tradeId}`
  const proofId = input.proofId ?? FINGERPRINT_A
  const operationId = deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey,
    binding: { kind: 'trade', tradeId, role: 'seller', stage: 'lock' },
  })
  const context =
    scope.scopeKind === 'wallet'
      ? {
          normalizedMint: 'https://mint.example',
          unit: 'sat',
          inventoryAccountId: null,
        }
      : {
          normalizedMint: scope.normalizedMint,
          unit: scope.unit,
          inventoryAccountId: scope.inventoryAccountId,
        }
  return decodeDurableCustodyRecord({
    schemaVersion: 1,
    revision: 0,
    scope,
    operation: {
      operationId,
      retainedOperationKey,
      binding: {
        kind: 'trade',
        tradeId,
        role: 'seller',
        stage: 'lock',
        sessionId,
        immutableTradeFingerprint: FINGERPRINT_A,
        hasDependentOperation: false,
      },
      semanticKind: 'swap-lock',
      state: 'dispatch-intent',
      terminalReplayEvidenceRequired: true,
      custodyContext: context,
      reservation: {
        reservationId: `reservation-${tradeId}`,
        parentReservationId: null,
        inputs: [{ proofId, keysetId: 'keyset-001', curve: 'secp256k1' }],
      },
      exactRequest: {
        requestId: `request-${tradeId}`,
        requestFingerprint: FINGERPRINT_A,
        payloadHandle: `request-payload-${tradeId}`,
        inputProofIds: [proofId],
        outputPlanFingerprint: FINGERPRINT_B,
      },
      outputPlan: {
        outputPlanId: `output-plan-${tradeId}`,
        outputPlanFingerprint: FINGERPRINT_B,
        outputMaterialHandle: `output-material-${tradeId}`,
      },
      privateMaterial: {
        materialHandle: `private-material-${tradeId}`,
        useId: `${tradeId}/seller/lock`,
        publicFingerprint: FINGERPRINT_A,
      },
      result: {
        state: 'none',
        resultHandle: null,
        resultFingerprint: null,
        outputPlanFingerprint: null,
      },
      verification: {
        outputPlanFingerprint: FINGERPRINT_B,
        hasOutputs: true,
        keysetBindings: [
          {
            keysetId: 'keyset-001',
            curve: 'secp256k1',
            keysetFingerprint: FINGERPRINT_B,
            requireDleq: true,
          },
        ],
        outputKeysets: [{ keysetId: 'keyset-001', curve: 'secp256k1' }],
      },
      delivery: {
        deliveryKind: 'none',
        deliveryId: null,
        payloadHandle: null,
        payloadFingerprint: null,
        expiresAtMs: null,
        state: 'none',
      },
      retry: { attempt: 0, nextAttemptAtMs: null, reason: 'none' },
      horizon: {
        notBeforeMs: null,
        notAfterMs: 10_000,
        safetyMarginMs: 0,
        keysetExpiryMs: null,
      },
    },
    terminalTombstone: null,
  })
}

function tradeBinding(record: DurableCustodyRecord) {
  if (record.operation.binding.kind !== 'trade') assert.fail('expected trade binding')
  return record.operation.binding
}

async function claimedStore(scope = profileScope()) {
  const store = new SqliteDurableCustodyStore()
  await store.registerScope(scope)
  const state = await store.claimScope({
    scope,
    incarnationId: 'worker-001',
    observedAtMs: 1,
    leaseExpiresAtMs: 10_000,
  })
  return {
    store,
    scope,
    owner: {
      incarnationId: 'worker-001',
      fencingEpoch: state.fencingEpoch,
      observedAtMs: 2,
    },
  }
}

function readReservationOwner(proofId: string): string | undefined {
  const database = openProfileDatabase()
  try {
    const row = database
      .prepare(
        'SELECT operation_id FROM custody_proof_reservations WHERE proof_id = ?',
      )
      .get(proofId) as { operation_id?: unknown } | undefined
    return typeof row?.operation_id === 'string' ? row.operation_id : undefined
  } finally {
    database.close()
  }
}

test('SQLite custody store registers scopes with canonical market isolation constraints', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    const first = await store.registerScope(profileScope())
    assert.equal(first.owner, null)
    assert.equal(
      (await store.registerScope(profileScope())).scope.scopeId,
      first.scope.scopeId,
    )
    await assert.rejects(
      () =>
        store.registerScope({
          scopeKind: 'wallet',
          walletId: FINGERPRINT_B,
          scopeId: first.scope.scopeId,
        }),
      /scope id is invalid/,
    )

    const database = openProfileDatabase()
    try {
      assert.equal(
        database.prepare('PRAGMA foreign_keys').get()?.foreign_keys,
        1,
      )
      const tables = database
        .prepare(
          `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name GLOB 'custody_*' ORDER BY name`,
        )
        .all() as Array<{ name: string; sql: string }>
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          'custody_active_work',
          'custody_operation_inputs',
          'custody_operations',
          'custody_order_collateral_allocations',
          'custody_order_collateral_fills',
          'custody_order_collateral_pins',
          'custody_order_collateral_proofs',
          'custody_order_collateral_transforms',
          'custody_proof_reservations',
          'custody_schema_metadata',
          'custody_scope_state',
          'custody_scopes',
          'custody_session_links',
          'custody_verification_bindings',
        ],
      )
      assert.equal(
        tables.every((table) => table.sql.includes('STRICT')),
        true,
      )
      for (const [table, column] of [
        ['custody_schema_metadata', 'singleton'],
        ['custody_scopes', 'scope_id'],
        ['custody_scope_state', 'scope_id'],
        ['custody_operations', 'input_count'],
        ['custody_operations', 'input_authority_fingerprint'],
        ['custody_operation_inputs', 'proof_id'],
        ['custody_operation_inputs', 'keyset_id'],
        ['custody_session_links', 'session_id'],
        ['custody_proof_reservations', 'proof_id'],
        ['custody_order_collateral_pins', 'scope_id'],
        ['custody_order_collateral_pins', 'pin_id'],
        ['custody_order_collateral_pins', 'unit'],
        ['custody_order_collateral_pins', 'outcome_id'],
        ['custody_order_collateral_pins', 'token_side'],
        ['custody_order_collateral_pins', 'order_side'],
        ['custody_order_collateral_pins', 'order_price'],
        ['custody_order_collateral_pins', 'time_in_force'],
        ['custody_order_collateral_proofs', 'proof_id'],
        ['custody_order_collateral_allocations', 'operation_id'],
        ['custody_order_collateral_fills', 'trade_id'],
        ['custody_order_collateral_transforms', 'transform_id'],
      ] as const) {
        const columns = database
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Array<{ name: string; notnull: number }>
      assert.equal(
          columns.find((candidate) => candidate.name === column)?.notnull,
          1,
          `${table}.${column} must be explicitly NOT NULL`,
        )
      }
      const sessionLinkIndexes = database
        .prepare('PRAGMA index_list(custody_session_links)')
        .all() as Array<{ name: string; unique: number }>
      assert.equal(
        sessionLinkIndexes.some(
          (index) =>
            index.name === 'custody_session_links_operation_idx' &&
            index.unique === 1,
        ),
        true,
      )
      const collateralIndexes = database
        .prepare('PRAGMA index_list(custody_order_collateral_pins)')
        .all() as Array<{ name: string; unique: number }>
      assert.equal(
        collateralIndexes.some(
          (index) =>
            index.name === 'custody_order_collateral_pins_active_idx' &&
            index.unique === 0,
        ),
        true,
      )
      assert.throws(
        () =>
          database
            .prepare(
              'INSERT INTO custody_active_work (scope_id, operation_id) VALUES (?, ?)',
            )
            .run(first.scope.scopeId, 'foreign-operation'),
        /FOREIGN KEY constraint failed/,
      )
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO custody_operation_inputs (
                scope_id, operation_id, proof_id, input_position, keyset_id, curve
              ) VALUES (?, ?, 'not-a-proof-id', 0, 'keyset-001', 'secp256k1')`,
            )
            .run(first.scope.scopeId, 'foreign-operation'),
        /CHECK constraint failed/,
      )
      const reservationForeignKeys = database
        .prepare('PRAGMA foreign_key_list(custody_proof_reservations)')
        .all() as Array<{
          id: number
          seq: number
          table: string
          from: string
          to: string
        }>
      const inputAuthorityForeignKey = reservationForeignKeys
        .filter((foreignKey) => foreignKey.table === 'custody_operation_inputs')
        .sort((left, right) => left.seq - right.seq)
      assert.equal(
        new Set(inputAuthorityForeignKey.map(({ id }) => id)).size,
        1,
      )
      assert.deepEqual(
        inputAuthorityForeignKey.map(({ from, to }) => [from, to]),
        [
          ['scope_id', 'scope_id'],
          ['operation_id', 'operation_id'],
          ['proof_id', 'proof_id'],
          ['input_position', 'input_position'],
          ['keyset_id', 'keyset_id'],
          ['curve', 'curve'],
        ],
      )
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO custody_operation_inputs (
                scope_id, operation_id, proof_id, input_position, keyset_id, curve
              ) VALUES (?, ?, ?, 0, 'keyset-001', 'secp256k1')`,
            )
            .run(first.scope.scopeId, 'foreign-operation', FINGERPRINT_A),
        /FOREIGN KEY constraint failed/,
      )
      assert.throws(
        () =>
          database.prepare(
            `INSERT INTO custody_order_collateral_pins (
              scope_id, pin_id, schema_version, revision, client_order_id,
              market_id, mint_url, unit, order_amount, required_amount,
              remaining_order_amount, outcome_id, token_side, order_side,
              order_price, time_in_force, pin_state
            ) VALUES (?, 'pin-without-preflight', 1, 0, 'client-order',
              'condition-YES', 'https://mint.example', 'sat', 100, 100,
              100, 'YES', 'Outcome', 'Buy', 50, 'GTC', 'preparing')`,
          ).run(first.scope.scopeId),
        /CHECK constraint failed/,
      )
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO custody_verification_bindings (
                scope_id, operation_id, keyset_id, curve, keyset_fingerprint,
                require_dleq, is_output
              ) VALUES (?, ?, 'keyset-001', 'secp256k1', ?, 1, 1)`,
            )
            .run(first.scope.scopeId, 'foreign-operation', FINGERPRINT_B),
        /FOREIGN KEY constraint failed/,
      )
      assert.throws(
        () =>
          database
            .prepare(
              'UPDATE custody_schema_metadata SET schema_version = ? WHERE singleton = 1',
            )
            .run('one'),
        /cannot store TEXT value in INTEGER column|datatype mismatch/,
      )
    } finally {
      database.close()
    }

    const market = marketScope({
      marketId: 'cond-YES',
      inventoryAccountId: 'inventory-A',
    })
    await store.registerScope(market)
    await assert.rejects(
      () =>
        store.registerScope(
          marketScope({
            marketId: 'cond-YES',
            inventoryAccountId: 'inventory-B',
          }),
        ),
      /market custody scope registration conflicts/,
    )
    await assert.rejects(
      () =>
        store.registerScope(
          marketScope({
            marketId: 'other-NO',
            inventoryAccountId: 'inventory-A',
          }),
        ),
      /market custody scope registration conflicts/,
    )
  })
})

test('SQLite custody leases renew and release without resetting fencing epochs', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    const scope = profileScope()
    await store.registerScope(scope)
    const first = await store.claimScope({
      scope,
      incarnationId: 'worker-001',
      observedAtMs: 1_000,
      leaseExpiresAtMs: 10_000,
    })
    const firstOwner = {
      scope,
      incarnationId: 'worker-001',
      fencingEpoch: first.fencingEpoch,
      observedAtMs: 2_000,
    }
    const renewed = await store.renewScope({
      ...firstOwner,
      leaseExpiresAtMs: 20_000,
    })
    assert.equal(renewed.fencingEpoch, 1)
    assert.equal(renewed.owner?.leaseExpiresAtMs, 20_000)
    const released = await store.releaseScope(firstOwner)
    assert.equal(released.fencingEpoch, 1)
    assert.equal(released.owner, null)
    const second = await store.claimScope({
      scope,
      incarnationId: 'worker-002',
      observedAtMs: 2_001,
      leaseExpiresAtMs: 30_000,
    })
    assert.equal(second.fencingEpoch, 2)
    await assert.rejects(
      () => store.renewScope({ ...firstOwner, leaseExpiresAtMs: 40_000 }),
      /custody owner epoch is foreign/,
    )
    await assert.rejects(
      () => store.releaseScope(firstOwner),
      /custody owner epoch is foreign/,
    )
  })
})

test('SQLite custody schema stores canonical records in typed rows, never JSON serialized columns', async () => {
  await withDaemonHome(async () => {
    const store = new SqliteDurableCustodyStore()
    await store.registerScope(profileScope())
    const database = openProfileDatabase()
    try {
      const tableNames = [
        'custody_scopes',
        'custody_scope_state',
        'custody_operations',
        'custody_operation_inputs',
        'custody_session_links',
        'custody_proof_reservations',
        'custody_verification_bindings',
      ]
      for (const tableName of tableNames) {
        const columns = database
          .prepare(`PRAGMA table_info(${tableName})`)
          .all() as Array<{
          name: string
          type: string
        }>
        assert.equal(
          columns.some((column) => /json/i.test(column.name)),
          false,
        )
        assert.equal(
          columns.some((column) => /json/i.test(column.type)),
          false,
        )
        assert.equal(
          columns.some((column) =>
            [
              'scope_payload',
              'state_payload',
              'record_payload',
              'link_payload',
            ].includes(column.name),
          ),
          false,
        )
      }
    } finally {
      database.close()
    }
  })
})

test('SQLite custody transaction commits canonical operation, session, reservation, and active index together', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const operation = record(scope)

    await store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
      transaction.putOperation(operation)
      transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      })
      transaction.rebuildActiveWorkIndex()
    })

    assert.equal(
      (await store.listRecoverable(scope))[0]?.operation.operationId,
      operation.operation.operationId,
    )
    await store.transact(
      custodyTransactionInput(scope, { ...owner, observedAtMs: 3 }, operation),
      (transaction) => {
        transaction.transitionOperation({
          operationId: operation.operation.operationId,
          transition: {
            kind: 'retry-scheduled',
            reason: 'storage-unavailable',
            nextAttemptAtMs: 5_000,
          },
        })
        transaction.rebuildActiveWorkIndex()
      },
    )
    assert.equal(
      (await store.listRecoverable(scope))[0]?.operation.retry.reason,
      'storage-unavailable',
    )
    const database = openProfileDatabase()
    try {
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO custody_session_links (
                scope_id, session_id, operation_id, schema_version, link_kind,
                trade_id, trade_role, trade_stage, immutable_trade_fingerprint,
                has_dependent_operation
              ) VALUES (?, ?, ?, 1, 'trade', ?, 'seller', 'lock', ?, 0)`,
            )
            .run(
              scope.scopeId,
              'second-session-for-operation',
              operation.operation.operationId,
              tradeBinding(operation).tradeId,
              tradeBinding(operation).immutableTradeFingerprint,
            ),
        /UNIQUE constraint failed/,
      )
    } finally {
      database.close()
    }
    const conflicting = record(scope, {
      tradeId: 'trade-002',
      retainedOperationKey: 'seller-lock-002',
      sessionId: 'session-trade-002',
      proofId: FINGERPRINT_A,
    })
    await assert.rejects(
      () =>
        store.transact(custodyTransactionInput(scope, owner, conflicting), (transaction) => {
          transaction.putOperation(conflicting)
          transaction.reserveExactInputs({
            operationId: conflicting.operation.operationId,
            reservationId: 'reservation-trade-002',
            proofIds: [FINGERPRINT_A],
          })
        }),
      /proof reservation is already owned/,
    )
    const forgedExactRequest = structuredClone(operation)
    forgedExactRequest.operation.exactRequest.payloadHandle =
      'different-persisted-request'
    await assert.rejects(
      () =>
        store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
          transaction.putOperation(forgedExactRequest)
        }),
      /existing custody operations must advance through an SDK reducer transition/,
    )
    const handoffOwner = { ...owner, observedAtMs: 3 }
    let effectiveClock = -1
    await store.transact(custodyTransactionInput(
      scope,
      handoffOwner,
      operation,
    ), (transaction) => {
      transaction.transitionOperation({
        operationId: operation.operation.operationId,
        transition: { kind: 'transport-attempted' },
      })
      effectiveClock =
        transaction.getScopeState().effectiveClock.highWaterMarkMs
      transaction.rebuildActiveWorkIndex()
    })
    assert.equal(effectiveClock, 3)
    assert.equal(
      (await store.listRecoverable(scope))[0]?.operation.state,
      'transport-attempted',
    )
    await assert.rejects(
      () =>
        store.transact(custodyTransactionInput(
          scope,
          handoffOwner,
          operation,
        ), (transaction) => {
          transaction.transitionOperation({
            operationId: operation.operation.operationId,
            transition: {
              kind: 'abort-no-transport',
              classification: 'all-inputs-unspent',
            },
          })
        }),
      /abort is only legal before transport handoff/,
    )

    const corruptionDatabase = openProfileDatabase()
    try {
      corruptionDatabase
        .prepare('DELETE FROM custody_active_work WHERE scope_id = ?')
        .run(scope.scopeId)
    } finally {
      corruptionDatabase.close()
    }
    await assert.rejects(
      () => store.listRecoverable(scope),
      /active-work index is missing or stale/,
    )
    assert.equal(await store.rebuildActiveWorkIndex(scope), 'rebuilt')
    assert.equal((await store.listRecoverable(scope)).length, 1)
  })
})

test('SQLite custody releases active proof ownership after safe abort and reconciliation', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const aborted = record(scope, {
      tradeId: 'trade-aborted',
      retainedOperationKey: 'seller-lock-aborted',
    })
    await store.transact(custodyTransactionInput(scope, owner, aborted), (transaction) => {
      transaction.putOperation(aborted)
      transaction.putSessionLink(
        aborted.operation.operationId,
        tradeBinding(aborted),
      )
      transaction.reserveExactInputs({
        operationId: aborted.operation.operationId,
        reservationId: aborted.operation.reservation.reservationId,
        proofIds: [FINGERPRINT_A],
      })
      transaction.rebuildActiveWorkIndex()
    })
    await store.transact(custodyTransactionInput(
      scope,
      { ...owner, observedAtMs: 3 },
      aborted,
    ), (transaction) => {
      transaction.transitionOperation({
        operationId: aborted.operation.operationId,
        transition: {
          kind: 'abort-no-transport',
          classification: 'all-inputs-unspent',
          exactRequestDisposition: 'deterministically-rejected',
        },
      })
      transaction.rebuildActiveWorkIndex()
    })
    assert.equal(readReservationOwner(FINGERPRINT_A), undefined)

    const reconciled = record(scope, {
      tradeId: 'trade-reconciled',
      retainedOperationKey: 'seller-lock-reconciled',
    })
    await store.transact(custodyTransactionInput(
      scope,
      { ...owner, observedAtMs: 4 },
      reconciled,
    ), (transaction) => {
      transaction.putOperation(reconciled)
      transaction.putSessionLink(
        reconciled.operation.operationId,
        tradeBinding(reconciled),
      )
      transaction.reserveExactInputs({
        operationId: reconciled.operation.operationId,
        reservationId: reconciled.operation.reservation.reservationId,
        proofIds: [FINGERPRINT_A],
      })
      transaction.rebuildActiveWorkIndex()
    })
    await store.transact(custodyTransactionInput(
      scope,
      { ...owner, observedAtMs: 5 },
      reconciled,
    ), (transaction) => {
      const result = {
        operationId: reconciled.operation.operationId,
        outputPlanFingerprint:
          reconciled.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-trade-reconciled',
        resultFingerprint: FINGERPRINT_A,
      }
      transaction.stageVerifiedResult(result)
      transaction.applyVerifiedResult(result)
      transaction.rebuildActiveWorkIndex()
    })
    assert.equal(readReservationOwner(FINGERPRINT_A), undefined)

    const next = record(scope, {
      tradeId: 'trade-next',
      retainedOperationKey: 'seller-lock-next',
    })
    await store.transact(custodyTransactionInput(
      scope,
      { ...owner, observedAtMs: 6 },
      next,
    ), (transaction) => {
      transaction.putOperation(next)
      transaction.putSessionLink(next.operation.operationId, tradeBinding(next))
      transaction.reserveExactInputs({
        operationId: next.operation.operationId,
        reservationId: next.operation.reservation.reservationId,
        proofIds: [FINGERPRINT_A],
      })
      transaction.rebuildActiveWorkIndex()
    })
    assert.equal(readReservationOwner(FINGERPRINT_A), next.operation.operationId)
  })
})

test('SQLite custody session owns multiple exact proof operations', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const first = record(scope, { proofId: FINGERPRINT_A })
    const secondRaw = record(scope, {
      retainedOperationKey: 'seller-lock-002',
      proofId: FINGERPRINT_B,
    })
    secondRaw.operation.reservation.reservationId = 'reservation-trade-001-002'
    secondRaw.operation.exactRequest.requestId = 'request-trade-001-002'
    secondRaw.operation.outputPlan.outputPlanId = 'output-plan-trade-001-002'
    const second = decodeDurableCustodyRecord(secondRaw)

    for (const operation of [first, second]) {
      await store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
        transaction.putOperation(operation)
        transaction.reserveExactInputs({
          operationId: operation.operation.operationId,
          reservationId: operation.operation.reservation.reservationId,
          proofIds: operation.operation.reservation.inputs.map(
            ({ proofId }) => proofId,
          ),
        })
        transaction.rebuildActiveWorkIndex()
      })
    }

    await store.transact(custodyTransactionInput(scope, owner, first, second), (transaction) => {
      assert.deepEqual(
        transaction.getSessionLink(
          tradeBinding(first).sessionId,
          first.operation.operationId,
        ),
        tradeBinding(first),
      )
      assert.deepEqual(
        transaction.getSessionLink(
          tradeBinding(second).sessionId,
          second.operation.operationId,
        ),
        tradeBinding(second),
      )
    })
  })
})

test('SQLite custody stores wallet work without fabricating a trade session', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const raw = structuredClone(record(scope))
    const operation = raw.operation
    operation.retainedOperationKey = 'wallet-send-001'
    operation.binding = {
      kind: 'wallet',
      activityId: 'activity-001',
      stage: 'send',
    }
    operation.operationId = deriveDurableCustodyOperationId(scope.scopeId, {
      retainedOperationKey: operation.retainedOperationKey,
      binding: operation.binding,
    })
    operation.semanticKind = 'generic-send'
    operation.terminalReplayEvidenceRequired = false
    operation.horizon.notAfterMs = null
    const walletOperation = decodeDurableCustodyRecord(raw)

    await store.transact(custodyTransactionInput(scope, owner, walletOperation), (transaction) => {
      transaction.putOperation(walletOperation)
      transaction.reserveExactInputs({
        operationId: walletOperation.operation.operationId,
        reservationId: walletOperation.operation.reservation.reservationId,
        proofIds: walletOperation.operation.reservation.inputs.map(({ proofId }) => proofId),
      })
      transaction.rebuildActiveWorkIndex()
    })

    assert.equal((await store.listRecoverable(scope))[0]?.operation.binding.kind, 'wallet')
    assert.equal(await store.transact(custodyTransactionInput(
      scope,
      owner,
      walletOperation,
    ), (transaction) =>
      transaction.getSessionLink(
        'activity-001',
        walletOperation.operation.operationId,
      )), null)
    const database = openProfileDatabase()
    try {
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM custody_session_links').get()?.count,
        0,
      )
    } finally {
      database.close()
    }
  })
})

test('daemon custody UoW commits and rolls back canonical custody with exact daemon rows', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    await writeState(emptyDaemonState())
    const unitOfWork = new DaemonCustodyUnitOfWork()
    const committed = record(scope, { tradeId: 'trade-commit' })

    await unitOfWork.transact(
      {
        scope,
        owner,
        operationIds: [committed.operation.operationId],
        stateScope: {
          proofOperationIds: [committed.operation.operationId],
        },
      },
      ({ custody, state }) => {
        putCustodyIntent(custody, committed)
        state.putProofOperation(daemonProofOperation(committed))
      },
    )
    assert.equal(
      (await store.listRecoverable(scope))[0]?.operation.operationId,
      committed.operation.operationId,
    )
    assert.equal(
      (await readState())?.proofOperations[committed.operation.operationId]
        ?.operationId,
      committed.operation.operationId,
    )

    const rolledBack = record(scope, {
      tradeId: 'trade-rollback',
      proofId: FINGERPRINT_C,
    })
    setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
      if (stage === 'before-commit') throw new Error('injected crash')
    })
    try {
      await assert.rejects(
        () =>
          unitOfWork.transact(
            {
              scope,
              owner: { ...owner, observedAtMs: 3 },
              operationIds: [rolledBack.operation.operationId],
              stateScope: {
                proofOperationIds: [rolledBack.operation.operationId],
              },
            },
            ({ custody, state }) => {
              putCustodyIntent(custody, rolledBack)
              state.putProofOperation(daemonProofOperation(rolledBack))
            },
          ),
        /injected crash/,
      )
    } finally {
      setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
    }
    assert.equal(
      (await store.listRecoverable(scope)).some(
        (candidate) =>
          candidate.operation.operationId ===
          rolledBack.operation.operationId,
      ),
      false,
    )
    assert.equal(
      (await readState())?.proofOperations[rolledBack.operation.operationId],
      undefined,
    )
  })
})

function putCustodyIntent(
  transaction: DurableCustodyTransaction,
  operation: DurableCustodyRecord,
): void {
  transaction.putOperation(operation)
  transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
  transaction.reserveExactInputs({
    operationId: operation.operation.operationId,
    reservationId: operation.operation.reservation.reservationId,
    proofIds: operation.operation.reservation.inputs.map(
      (input) => input.proofId,
    ),
  })
  transaction.rebuildActiveWorkIndex()
}

function daemonProofOperation(operation: DurableCustodyRecord) {
  return {
    operationId: operation.operation.operationId,
    kind: 'swap-lock' as const,
    state: 'prepared' as const,
    mintUrl: operation.operation.custodyContext.normalizedMint,
    inputs: [
      {
        id: 'keyset-001',
        amount: 1,
        secret: 'exact-daemon-proof',
        C: 'exact-daemon-signature',
      },
    ],
    outputs: {},
    metadata: {},
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

test('SQLite custody recovery pages use an exclusive bounded operation cursor', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const operations = [
      record(scope, {
        tradeId: 'trade-page-a',
        retainedOperationKey: 'seller-lock-page-a',
        sessionId: 'session-page-a',
        proofId: FINGERPRINT_A,
      }),
      record(scope, {
        tradeId: 'trade-page-b',
        retainedOperationKey: 'seller-lock-page-b',
        sessionId: 'session-page-b',
        proofId: FINGERPRINT_B,
      }),
      record(scope, {
        tradeId: 'trade-page-c',
        retainedOperationKey: 'seller-lock-page-c',
        sessionId: 'session-page-c',
        proofId: FINGERPRINT_C,
      }),
    ]
    await store.transact(custodyTransactionInput(scope, owner, ...operations), (transaction) => {
      for (const operation of operations) {
        transaction.putOperation(operation)
        transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
        transaction.reserveExactInputs({
          operationId: operation.operation.operationId,
          reservationId: operation.operation.reservation.reservationId,
          proofIds: operation.operation.reservation.inputs.map(
            (input) => input.proofId,
          ),
        })
      }
      transaction.rebuildActiveWorkIndex()
    })

    const database = openProfileDatabase()
    try {
      const cursorPlan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT operation.*
             FROM custody_active_work AS active
             JOIN custody_operations AS operation
               ON operation.scope_id = active.scope_id
              AND operation.operation_id = active.operation_id
            WHERE active.scope_id = ? AND active.operation_id > ?
            ORDER BY active.operation_id
            LIMIT ?`,
        )
        .all(scope.scopeId, operations[0]!.operation.operationId, 3) as Array<{
        detail: string
      }>
      assert.equal(
        cursorPlan.some((row) => row.detail.includes('operation_id>?')),
        true,
      )
      assert.equal(
        cursorPlan.some(
          (row) =>
            row.detail.includes('SCAN ') ||
            row.detail.includes('USE TEMP B-TREE'),
        ),
        false,
      )

      const sessionPlan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM custody_session_links
            WHERE scope_id = ? AND session_id = ?`,
        )
        .all(scope.scopeId, tradeBinding(operations[0]!).sessionId) as Array<{
        detail: string
      }>
      assert.equal(
        sessionPlan.some(
          (row) =>
            row.detail.includes('custody_session_links') &&
            row.detail.includes('session_id=?'),
        ),
        true,
      )
      assert.equal(
        sessionPlan.some((row) => row.detail.includes('SCAN ')),
        false,
      )
    } finally {
      database.close()
      }

    const measured = await countCustodyPageRelationQueries(() =>
      readDurableCustodyRecoveryPage(store, {
        scope,
        cursor: null,
        limit: 2,
      }),
    )
    const first = measured.result
    assert.deepEqual(measured.counts, { inputs: 1, verification: 1, sessions: 1 })
    assert.equal(first.records.length, 2)
    assert.notEqual(first.nextCursor, null)
    assert.deepEqual(
      first.records.map((item) => item.operation.operationId),
      [...first.records].map((item) => item.operation.operationId).sort(),
    )
    const second = await readDurableCustodyRecoveryPage(store, {
      scope,
      cursor: first.nextCursor,
      limit: 2,
    })
    assert.equal(second.records.length, 1)
    assert.equal(second.nextCursor, null)
    assert.deepEqual(
      [...first.records, ...second.records]
        .map((item) => item.operation.operationId)
        .sort(),
      operations.map((item) => item.operation.operationId).sort(),
    )
    await assert.rejects(
      () => store.listRecoverablePage({ scope, cursor: null, limit: 257 }),
      /page limit is invalid/,
    )
  })
})

async function countCustodyPageRelationQueries<T>(
  run: () => Promise<T>,
): Promise<{
  result: T
  counts: { inputs: number; verification: number; sessions: number }
}> {
  const original = DatabaseSync.prototype.prepare
  const counts = { inputs: 0, verification: 0, sessions: 0 }
  DatabaseSync.prototype.prepare = function prepare(sql: string) {
    if (sql.includes('FROM custody_operation_inputs')) counts.inputs += 1
    if (sql.includes('FROM custody_verification_bindings')) counts.verification += 1
    if (sql.includes('FROM custody_session_links')) counts.sessions += 1
    return original.call(this, sql)
  }
  try {
    return { result: await run(), counts }
  } finally {
    DatabaseSync.prototype.prepare = original
  }
}

test('SQLite custody transaction validates only operations touched under its writer lock', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const historical = record(scope, {
      tradeId: 'trade-historical',
      retainedOperationKey: 'seller-lock-historical',
      sessionId: 'session-historical',
      proofId: FINGERPRINT_A,
    })
    const current = record(scope, {
      tradeId: 'trade-current',
      retainedOperationKey: 'seller-lock-current',
      sessionId: 'session-current',
      proofId: FINGERPRINT_B,
    })
    await store.transact(custodyTransactionInput(
      scope,
      owner,
      historical,
      current,
    ), (transaction) => {
      for (const operation of [historical, current]) {
        transaction.putOperation(operation)
        transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
        transaction.reserveExactInputs({
          operationId: operation.operation.operationId,
          reservationId: operation.operation.reservation.reservationId,
          proofIds: operation.operation.reservation.inputs.map(
            (input) => input.proofId,
          ),
        })
      }
      transaction.rebuildActiveWorkIndex()
    })

    let database = openProfileDatabase()
    try {
      database
        .prepare(
          `UPDATE custody_operations
              SET result_state = 'verified-staged',
                  result_handle = 'corrupt-historical-result',
                  result_fingerprint = ?,
                  result_output_plan_fingerprint = ?
            WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(
          FINGERPRINT_A,
          FINGERPRINT_C,
          scope.scopeId,
          historical.operation.operationId,
        )
      database
        .prepare(
          `DELETE FROM custody_active_work
            WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(scope.scopeId, historical.operation.operationId)
    } finally {
      database.close()
    }

    await store.transact(custodyTransactionInput(scope, owner, current), (transaction) => {
      transaction.transitionOperation({
        operationId: current.operation.operationId,
        transition: { kind: 'transport-attempted' },
      })
      transaction.rebuildActiveWorkIndex()
    })

    database = openProfileDatabase()
    try {
      assert.equal(
        database
          .prepare(
            `SELECT operation_state FROM custody_operations
              WHERE scope_id = ? AND operation_id = ?`,
          )
          .get(scope.scopeId, current.operation.operationId)?.operation_state,
        'transport-attempted',
      )
      assert.equal(
        database
          .prepare(
            `SELECT result_handle FROM custody_operations
              WHERE scope_id = ? AND operation_id = ?`,
          )
          .get(scope.scopeId, historical.operation.operationId)?.result_handle,
        'corrupt-historical-result',
      )
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM custody_active_work
              WHERE scope_id = ? AND operation_id = ?`,
          )
          .get(scope.scopeId, historical.operation.operationId)?.count,
        0,
      )
    } finally {
      database.close()
    }
    await assert.rejects(() => store.listRecoverable(scope), /result/i)
  })
})

test('SQLite custody store rolls back foreign awaits and fails closed on corrupt canonical rows', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    await assert.rejects(
      () => store.transact(custodyTransactionInput(scope, owner), async () => undefined),
      /transaction callback must not await/,
    )
    await assert.rejects(
      () =>
        store.transact(custodyTransactionInput(scope, owner), (transaction) => {
          transaction.putScopeState({
            ...transaction.getScopeState(),
            owner: {
              incarnationId: 'foreign-worker',
              leaseExpiresAtMs: 20_000,
            },
          })
        }),
      /owner changes require claimScope/,
    )
    assert.deepEqual(await store.listRecoverable(scope), [])

    const operation = record(scope)
    await store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
      transaction.putOperation(operation)
      transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      })
      transaction.rebuildActiveWorkIndex()
    })
    await assert.rejects(
      () => store.transact(
        custodyTransactionInput(scope, owner),
        (transaction) => transaction.getOperation(
          operation.operation.operationId,
        ),
      ),
      /operation was not selected/,
    )

    const database = new DatabaseSync(profileDatabasePath())
    try {
      database
        .prepare(
          `UPDATE custody_operations
              SET result_state = 'verified-staged',
                  result_handle = 'corrupt-result',
                  result_fingerprint = ?,
                  result_output_plan_fingerprint = ?
         WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(
          FINGERPRINT_A,
          FINGERPRINT_C,
          scope.scopeId,
          operation.operation.operationId,
        )
    } finally {
      database.close()
    }
    await assert.rejects(() => store.listRecoverable(scope), /result/i)
  })
})

test('SQLite custody reservations cannot diverge from exact input or reservation authority', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const operation = record(scope)
    await store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
      transaction.putOperation(operation)
      transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      })
      transaction.rebuildActiveWorkIndex()
    })

    const database = openProfileDatabase()
    try {
      for (const mutation of [
        "input_position = input_position + 1",
        "keyset_id = 'foreign-keyset'",
        "curve = 'bls12-381'",
        "reservation_id = 'foreign-reservation'",
      ]) {
        assert.throws(
          () => database.prepare(
            `UPDATE custody_proof_reservations SET ${mutation}
              WHERE proof_id = ?`,
          ).run(operation.operation.reservation.inputs[0]?.proofId),
          /FOREIGN KEY constraint failed/,
        )
      }
    } finally {
      database.close()
    }
    assert.equal((await store.listRecoverable(scope)).length, 1)
  })
})

test('SQLite custody input authority prevents active deletion and detects terminal deletion', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const operation = record(scope)
    await store.transact(
      custodyTransactionInput(scope, owner, operation),
      (transaction) => putCustodyIntent(transaction, operation),
    )

    const activeDatabase = openProfileDatabase()
    try {
      assert.throws(
        () => activeDatabase.prepare(
          `DELETE FROM custody_operation_inputs
            WHERE scope_id = ? AND operation_id = ?`,
        ).run(scope.scopeId, operation.operation.operationId),
        /FOREIGN KEY constraint failed/,
      )
    } finally {
      activeDatabase.close()
    }

    await store.transact(
      custodyTransactionInput(
        scope,
        { ...owner, observedAtMs: owner.observedAtMs + 1 },
        operation,
      ),
      (transaction) => {
        transaction.transitionOperation({
          operationId: operation.operation.operationId,
          transition: {
            kind: 'abort-no-transport',
            classification: 'all-inputs-unspent',
            exactRequestDisposition: 'deterministically-rejected',
          },
        })
        transaction.rebuildActiveWorkIndex()
      },
    )
    const terminalDatabase = openProfileDatabase()
    try {
      terminalDatabase.prepare(
        `DELETE FROM custody_operation_inputs
          WHERE scope_id = ? AND operation_id = ?`,
      ).run(scope.scopeId, operation.operation.operationId)
    } finally {
      terminalDatabase.close()
    }
    await assert.rejects(
      () => store.transact(
        custodyTransactionInput(scope, owner, operation),
        (transaction) => transaction.getOperation(
          operation.operation.operationId,
        ),
      ),
      /input authority is corrupt/,
    )
  })
})

test('SQLite custody input authority detects terminal proof substitution', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const operation = record(scope)
    await store.transact(
      custodyTransactionInput(scope, owner, operation),
      (transaction) => putCustodyIntent(transaction, operation),
    )
    await store.transact(
      custodyTransactionInput(
        scope,
        { ...owner, observedAtMs: owner.observedAtMs + 1 },
        operation,
      ),
      (transaction) => {
        transaction.transitionOperation({
          operationId: operation.operation.operationId,
          transition: {
            kind: 'abort-no-transport',
            classification: 'all-inputs-unspent',
            exactRequestDisposition: 'deterministically-rejected',
          },
        })
        transaction.rebuildActiveWorkIndex()
      },
    )
    const database = openProfileDatabase()
    try {
      database.prepare(
        `UPDATE custody_operation_inputs SET proof_id = ?
          WHERE scope_id = ? AND operation_id = ?`,
      ).run(FINGERPRINT_B, scope.scopeId, operation.operation.operationId)
    } finally {
      database.close()
    }
    await assert.rejects(
      () => store.transact(
        custodyTransactionInput(scope, owner, operation),
        (transaction) => transaction.getOperation(
          operation.operation.operationId,
        ),
      ),
      /input authority is corrupt/,
    )
  })
})

test('SQLite custody store never repairs a partial schema and retains pending delivery work', async () => {
  await withDaemonHome(async () => {
    const { store, scope, owner } = await claimedStore()
    const operation = record(scope)
    await store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
      transaction.putOperation(operation)
      transaction.putSessionLink(operation.operation.operationId, tradeBinding(operation))
      transaction.reserveExactInputs({
        operationId: operation.operation.operationId,
        reservationId: operation.operation.reservation.reservationId,
        proofIds: operation.operation.reservation.inputs.map(
          (input) => input.proofId,
        ),
      })
      transaction.putDelivery({
        operationId: operation.operation.operationId,
        deliveryKind: 'cipher',
        payloadHandle: 'cipher-payload-001',
        payloadFingerprint: FINGERPRINT_A,
        expiresAtMs: 5_000,
        state: 'pending',
      })
      transaction.stageVerifiedResult({
        operationId: operation.operation.operationId,
        outputPlanFingerprint:
          operation.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-001',
        resultFingerprint: FINGERPRINT_A,
      })
      transaction.applyVerifiedResult({
        operationId: operation.operation.operationId,
        outputPlanFingerprint:
          operation.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-001',
        resultFingerprint: FINGERPRINT_A,
      })
      transaction.rebuildActiveWorkIndex()
    })
    assert.equal((await store.listRecoverable(scope)).length, 1)
    await assert.rejects(
      () =>
        store.transact(custodyTransactionInput(scope, owner, operation), (transaction) => {
          transaction.putDelivery({
            operationId: operation.operation.operationId,
            deliveryKind: 'cipher',
            payloadHandle: 'cipher-payload-001',
            payloadFingerprint: FINGERPRINT_A,
            expiresAtMs: 5_000,
            state: 'expired',
          })
        }),
      /delivery expiry is premature/,
    )

    const database = openProfileDatabase()
    try {
      database.exec('DROP TABLE custody_active_work')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => store.listRecoverable(scope),
      /schema is incomplete; refusing repair/,
    )
  })
})
