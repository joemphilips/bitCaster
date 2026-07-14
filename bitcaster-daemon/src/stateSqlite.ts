import { DatabaseSync } from 'node:sqlite'
import {
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  deriveDurableCustodyProofId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  isCollateralUnitOf,
  parseCashuProofUnit,
} from '@bitcaster-market/client-sdk/marketUnits'
import { ensureDaemonSecretsSchema } from './secrets.ts'
import type {
  CashuProofRecord,
  DaemonState,
  LocalOrderRecord,
  LocalSwapRecord,
  ProofOperationRecord,
  StoredProofRecord,
  WalletBalance,
} from './state.ts'

const STATE_SCHEMA_VERSION = 1
const OPAQUE_ARTIFACT_MAX_BYTES = 4 * 1_024 * 1_024
export const DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX =
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX
const DAEMON_WALLET_PROOF_CANDIDATE_QUERY_LIMIT =
  DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX + 1
const DAEMON_WALLET_DENOMINATION_TARGET = 3
const DAEMON_WALLET_DENOMINATION_LIMIT_MAX = 256

const STATE_TABLES = [
  'daemon_state_metadata',
  'daemon_wallet_proofs',
  'daemon_keyset_counters',
  'daemon_trade_sessions',
  'daemon_trade_expected_operations',
  'daemon_trade_planned_operations',
  'daemon_proof_operations',
  'daemon_trade_proof_links',
  'daemon_trade_ciphers',
  'daemon_orders',
  'daemon_order_trades',
  'daemon_swaps',
] as const

export interface DaemonStateRowScope {
  wallet?: boolean
  walletProofs?: readonly DaemonWalletProofSelector[] | 'all'
  keysetCounterKeys?: readonly string[] | 'all'
  proofOperationIds?: readonly string[] | 'all'
  durableOperationIds?: readonly string[] | 'all'
  tradeIds?: readonly string[] | 'all'
  orderIds?: readonly string[] | 'all'
  /** Reads orders referenced by the selected swaps in the same SQLite snapshot. */
  orderIdsFromSwapIds?: readonly string[]
  orderTradeIds?: readonly string[]
  orderEphemeralPubkeys?: readonly string[]
  swapIdsFromOrderIds?: readonly string[]
  swapIds?: readonly string[] | 'all'
}

export interface DaemonWalletProofSelector {
  mintUrl?: string
  unit?: string
  proofIds?: readonly string[]
  state?: StoredProofRecord['state']
  reservedBy?: string
  assetKind?: StoredProofRecord['asset']['kind']
  conditionId?: string
  outcomeSetId?: string
  baseAsset?: string
  /** Selects a bounded deterministic spend-candidate prefix. */
  candidateLimit?: boolean
}

export interface DaemonStateRowChanges {
  walletProofDeleteIds?: readonly string[]
  walletProofUpserts?: readonly StoredProofRecord[]
}

export interface DaemonWalletHoldingTotals {
  baseUnitProofs: number
  outcomeAmountsBySet: Record<string, number>
}

export interface DaemonWalletProofAmountSample {
  amount: number
}

export interface DaemonIdPageInput {
  cursor: string | null
  limit: number
}

export interface DaemonIdPage {
  ids: string[]
  nextCursor: string | null
}

export interface DaemonStateCounts {
  proofs: number
  proofOperations: number
  orders: number
  swaps: number
}

const DAEMON_ID_PAGE_LIMIT_MAX = 256

export const FULL_DAEMON_STATE_ROW_SCOPE: DaemonStateRowScope = {
  wallet: true,
  proofOperationIds: 'all',
  tradeIds: 'all',
  orderIds: 'all',
  swapIds: 'all',
}

export function daemonStateSchemaExists(database: DatabaseSync): boolean {
  return tableExists(database, 'daemon_state_metadata')
}

export function ensureDaemonStateSchema(database: DatabaseSync): void {
  ensureDaemonSecretsSchema(database)
  const present = STATE_TABLES.filter((table) => tableExists(database, table))
  if (present.length === 0) {
    if (tableExists(database, 'daemon_state')) {
      throw new Error('legacy daemon SQLite state schema is unsupported')
    }
    createStateSchema(database)
    return
  }
  if (present.length !== STATE_TABLES.length) {
    throw new Error('daemon SQLite state schema is incomplete')
  }
  assertDaemonStateSchema(database)
}

export function assertDaemonStateSchema(
  database: DatabaseSync,
  verifyForeignKeys = true,
): void {
  if (
    JSON.stringify(readStateSchemaObjects(database)) !==
    JSON.stringify(expectedStateSchemaObjects())
  ) {
    throw new Error('daemon SQLite state schema is unsupported')
  }
  if (verifyForeignKeys) {
    const foreignKeyFailures = database
      .prepare('PRAGMA foreign_key_check')
      .all() as Array<Record<string, unknown>>
    if (foreignKeyFailures.length > 0) {
      throw new Error('daemon SQLite state foreign keys are corrupt')
    }
  }
  const marker = database
    .prepare(
      'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
    )
    .get() as { schema_version?: unknown } | undefined
  if (marker !== undefined && marker.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error('daemon SQLite state schema is unsupported')
  }
}

let cachedExpectedStateSchemaObjects: Array<Record<string, string>> | undefined

function expectedStateSchemaObjects(): Array<Record<string, string>> {
  if (cachedExpectedStateSchemaObjects !== undefined) {
    return cachedExpectedStateSchemaObjects
  }
  const reference = new DatabaseSync(':memory:')
  try {
    createStateSchema(reference)
    cachedExpectedStateSchemaObjects = readStateSchemaObjects(reference)
    return cachedExpectedStateSchemaObjects
  } finally {
    reference.close()
  }
}

function readStateSchemaObjects(
  database: DatabaseSync,
): Array<Record<string, string>> {
  const placeholders = STATE_TABLES.map(() => '?').join(', ')
  return (
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
          WHERE tbl_name IN (${placeholders})
            AND sql IS NOT NULL
          ORDER BY type, name`,
      )
      .all(...STATE_TABLES) as Array<Record<string, unknown>>
  ).map((row) => ({
    type: requireText(row.type, 'state schema object type'),
    name: requireText(row.name, 'state schema object name'),
    table: requireText(row.tbl_name, 'state schema object table'),
    sql: requireText(row.sql, 'state schema object SQL')
      .replace(/\s+/g, ' ')
      .trim(),
  }))
}

export function readDaemonStateRows(
  database: DatabaseSync,
  scope: DaemonStateRowScope = FULL_DAEMON_STATE_ROW_SCOPE,
): unknown | null {
  assertDaemonStateSchema(database, isFullStateScope(scope))
  const marker = database
    .prepare(
      'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
    )
    .get() as { schema_version?: unknown } | undefined
  if (marker === undefined) return null
  if (marker.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error('daemon SQLite state schema is unsupported')
  }

  const walletProofRows =
    scope.wallet || scope.walletProofs === 'all'
      ? (database
          .prepare('SELECT * FROM daemon_wallet_proofs ORDER BY proof_id')
          .all() as Array<Record<string, unknown>>)
      : selectWalletProofRows(database, scope.walletProofs ?? [])
  const counterSelection = scope.wallet ? 'all' : scope.keysetCounterKeys
  const keysetCounterRows =
    counterSelection === 'all'
      ? (database
          .prepare(
            'SELECT counter_key, counter_value FROM daemon_keyset_counters ORDER BY counter_key',
          )
          .all() as Array<Record<string, unknown>>)
      : selectRowsByIds(
          database,
          'daemon_keyset_counters',
          'counter_key',
          counterSelection ?? [],
        )
  const keysetCounters = Object.fromEntries(
    keysetCounterRows.map((row) => [
      requireText(row.counter_key, 'keyset counter key'),
      row.counter_value,
    ]),
  )

  const localOperationRows = selectScopedRows(
    database,
    'daemon_proof_operations',
    'operation_id',
    scope.proofOperationIds,
  )
  const durableOperationRows = selectScopedRows(
    database,
    'daemon_proof_operations',
    'durable_operation_id',
    scope.durableOperationIds,
  )
  const requestedOperationRows = [
    ...localOperationRows,
    ...durableOperationRows,
  ]
  const requestedTradeIds = new Set<string>()
  if (scope.tradeIds !== undefined && scope.tradeIds !== 'all') {
    for (const tradeId of scope.tradeIds) requestedTradeIds.add(tradeId)
  }
  for (const row of requestedOperationRows) {
    if (typeof row.durable_trade_id === 'string') {
      requestedTradeIds.add(row.durable_trade_id)
    }
  }
  const sessionRows =
    scope.tradeIds === 'all'
      ? selectScopedRows(database, 'daemon_trade_sessions', 'trade_id', 'all')
      : selectScopedRows(database, 'daemon_trade_sessions', 'trade_id', [
          ...requestedTradeIds,
        ])
  const selectedTradeIds = sessionRows.map((row) =>
    requireText(row.trade_id, 'durable trade id'),
  )
  const relatedOperationRows =
    selectedTradeIds.length === 0
      ? []
      : selectRowsByIds(
          database,
          'daemon_proof_operations',
          'durable_trade_id',
          selectedTradeIds,
        )
  const operationRowsById = new Map<string, Record<string, unknown>>()
  for (const row of [...requestedOperationRows, ...relatedOperationRows]) {
    operationRowsById.set(
      requireText(row.operation_id, 'proof operation id'),
      row,
    )
  }
  const childRows = {
    expected: groupRowsByParent(
      selectRowsByIds(
        database,
        'daemon_trade_expected_operations',
        'trade_id',
        selectedTradeIds,
      ),
      'trade_id',
    ),
    planned: groupRowsByParent(
      selectRowsByIds(
        database,
        'daemon_trade_planned_operations',
        'trade_id',
        selectedTradeIds,
      ),
      'trade_id',
    ),
    links: groupRowsByParent(
      selectRowsByIds(
        database,
        'daemon_trade_proof_links',
        'trade_id',
        selectedTradeIds,
      ),
      'trade_id',
    ),
    ciphers: groupRowsByParent(
      selectRowsByIds(
        database,
        'daemon_trade_ciphers',
        'trade_id',
        selectedTradeIds,
      ),
      'trade_id',
    ),
  }
  const sessions = Object.fromEntries(
    sessionRows.map((row) => {
      const tradeId = requireText(row.trade_id, 'durable trade id')
      const expected = childRows.expected.get(tradeId) ?? []
      const planned = childRows.planned.get(tradeId) ?? []
      const links = childRows.links.get(tradeId) ?? []
      const ciphers = childRows.ciphers.get(tradeId) ?? []
      const hasExpectedOperations = decodeDatabaseBoolean(
        row.has_expected_operations,
        'expected operation marker',
      )
      const hasPlannedOperations = decodeDatabaseBoolean(
        row.has_planned_operations,
        'planned operation marker',
      )
      if (!hasExpectedOperations && expected.length > 0) {
        throw new Error('expected operation marker hides persisted rows')
      }
      if (!hasPlannedOperations && planned.length > 0) {
        throw new Error('planned operation marker hides persisted rows')
      }
      const receivedCiphers: Record<string, unknown> = {}
      const outboundCiphers: Record<string, unknown> = {}
      for (const cipher of ciphers) {
        let target: Record<string, unknown>
        if (cipher.direction === 'received') {
          target = receivedCiphers
        } else if (cipher.direction === 'outbound') {
          target = outboundCiphers
        } else {
          throw new Error('durable cipher direction row is invalid')
        }
        target[
          requireText(cipher.message_type, 'durable cipher message type')
        ] = {
          ciphertext: cipher.ciphertext,
          sha256: cipher.sha256,
        }
      }
      return [
        tradeId,
        {
          schemaVersion: row.schema_version,
          revision: row.revision,
          tradeId,
          role: row.role,
          localProtocolPubkey: row.local_protocol_pubkey,
          counterpartyProtocolPubkey: row.counterparty_protocol_pubkey,
          mintUrl: row.mint_url,
          sellerLocktimeSecs: row.seller_locktime_secs,
          buyerLocktimeSecs: row.buyer_locktime_secs,
          ephemeralKeyHandle: {
            keyId: row.key_id,
            tradeId: row.key_trade_id,
            role: row.key_role,
            localProtocolPubkey: row.key_local_protocol_pubkey,
            counterpartyProtocolPubkey: row.key_counterparty_protocol_pubkey,
            mintUrl: row.key_mint_url,
            sellerLocktimeSecs: row.key_seller_locktime_secs,
            buyerLocktimeSecs: row.key_buyer_locktime_secs,
          },
          stage: row.stage,
          ...(hasExpectedOperations
            ? {
                expectedProofOperations: expected.map(
                  decodeExpectedOperationRow,
                ),
              }
            : {}),
          ...(hasPlannedOperations
            ? { plannedProofOperations: planned.map(decodePlannedOperationRow) }
            : {}),
          proofOperations: links.map(decodeProofLinkRow),
          receivedCiphers,
          outboundCiphers,
        },
      ]
    }),
  )

  const operations = Object.fromEntries(
    [...operationRowsById.values()].map((row) => {
      const operationId = requireText(row.operation_id, 'proof operation id')
      assertDurableProofLinkColumns(row)
      const durableTradeRecovery =
        row.durable_trade_id === null ? undefined : decodeProofLinkColumns(row)
      const hasResultProofs = decodeDatabaseBoolean(
        row.has_result_proofs,
        'proof operation result marker',
      )
      assertOptionalPayloadPresence(
        hasResultProofs,
        row.result_proofs_json,
        'proof operation result',
      )
      const operationState = requireText(row.state, 'proof operation state')
      if ((operationState === 'completed') !== hasResultProofs) {
        throw new Error('proof operation completion result row is invalid')
      }
      if (row.failure_code !== null && operationState !== 'Failed') {
        throw new Error('proof operation failure code row is invalid')
      }
      return [
        operationId,
        {
          operationId,
          ...(durableTradeRecovery === undefined
            ? {}
            : { durableTradeRecovery }),
          kind: row.kind,
          state: operationState,
          mintUrl: row.mint_url,
          inputs: decodeArtifact(row.inputs_json, 'proof operation inputs'),
          outputs: decodeArtifact(row.outputs_json, 'proof operation outputs'),
          metadata: decodeArtifact(
            row.metadata_json,
            'proof operation metadata',
          ),
          ...(hasResultProofs
            ? {
                resultProofs: decodeArtifact(
                  row.result_proofs_json,
                  'proof operation result proofs',
                ),
              }
            : {}),
          lastError: row.last_error,
          ...(row.failure_code === null
            ? {}
            : { failureCode: row.failure_code }),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      ]
    }),
  )

  const orderRows = selectOrderRows(database, scope)
  const orderTradeRows = groupRowsByParent(
    selectRowsByIds(
      database,
      'daemon_order_trades',
      'order_id',
      orderRows.map((row) => requireText(row.order_id, 'local order id')),
    ),
    'order_id',
  )
  const orders = Object.fromEntries(
    orderRows.map((row) => {
      const orderId = requireText(row.order_id, 'local order id')
      const tradeIds = (orderTradeRows.get(orderId) ?? []).map(
        (item) => item.trade_id,
      )
      return [orderId, decodeOrderRow(row, tradeIds)]
    }),
  )

  const swapsFromOrders =
    scope.swapIdsFromOrderIds === undefined
      ? []
      : selectRowsByIds(
          database,
          'daemon_order_trades',
          'order_id',
          scope.swapIdsFromOrderIds,
        ).map((row) => requireText(row.trade_id, 'local order trade id'))
  const selectedSwapIds =
    scope.swapIds === 'all'
      ? 'all'
      : [...new Set([...(scope.swapIds ?? []), ...swapsFromOrders])]
  const swaps = Object.fromEntries(
    selectScopedRows(database, 'daemon_swaps', 'trade_id', selectedSwapIds).map(
      (row) => {
        const tradeId = requireText(row.trade_id, 'local swap id')
        return [tradeId, decodeSwapRow(row)]
      },
    ),
  )

  return {
    version: 1,
    wallet: {
      proofs: walletProofRows.map(decodeWalletProofRow),
      keysetCounters,
    },
    proofOperations: operations,
    durableTradeSessions: sessions,
    orders,
    swaps,
  }
}

/** Reads only the capped denomination counts cashu-ts uses for output shaping. */
export function readDaemonWalletProofAmountSample(
  database: DatabaseSync,
  input: { mintUrl: string; unit: string },
): DaemonWalletProofAmountSample[] {
  assertDaemonStateSchema(database, false)
  if (input.mintUrl.length === 0 || parseCashuProofUnit(input.unit) === null) {
    throw new Error('wallet proof amount sample scope is invalid')
  }
  const rows = database
    .prepare(
      `SELECT amount, COUNT(*) AS proof_count
         FROM daemon_wallet_proofs INDEXED BY daemon_wallet_proofs_denomination_idx
        WHERE mint_url = ? AND unit = ?
        GROUP BY amount
        ORDER BY amount
        LIMIT ?`,
    )
    .all(
      input.mintUrl,
      input.unit,
      DAEMON_WALLET_DENOMINATION_LIMIT_MAX + 1,
    ) as Array<Record<string, unknown>>
  if (rows.length > DAEMON_WALLET_DENOMINATION_LIMIT_MAX) {
    throw new Error('wallet proof denominations exceed the supported limit')
  }
  return rows.flatMap((row) => {
    const amount = requireNonnegativeInteger(row.amount, 'wallet proof amount')
    const count = Math.min(
      requireNonnegativeInteger(row.proof_count, 'wallet proof amount count'),
      DAEMON_WALLET_DENOMINATION_TARGET,
    )
    return Array.from({ length: count }, () => ({ amount }))
  })
}

/** Aggregates order-backing balances without hydrating bearer proof bodies. */
export function readDaemonWalletHoldingTotals(
  database: DatabaseSync,
  input: { mintUrl: string; conditionId: string; baseAsset: string },
): DaemonWalletHoldingTotals {
  assertDaemonStateSchema(database, false)
  const rows = database
    .prepare(
      `SELECT asset_kind, asset_outcome_set_id, SUM(amount) AS total_amount
       FROM daemon_wallet_proofs
      WHERE mint_url = ? AND state = 'available' AND base_asset = ?
        AND (
          (asset_kind = 'sats'
            AND asset_condition_id IS NULL
            AND asset_outcome_set_id IS NULL)
          OR
          (asset_kind = 'Outcome' AND asset_condition_id = ?)
        )
      GROUP BY asset_kind, asset_outcome_set_id
      ORDER BY asset_kind, asset_outcome_set_id`,
    )
    .all(input.mintUrl, input.baseAsset, input.conditionId) as Array<
    Record<string, unknown>
  >
  let baseUnitProofs = 0
  const outcomeAmountsBySet: Record<string, number> = {}
  for (const row of rows) {
    const amount = requireNonnegativeInteger(
      row.total_amount,
      'wallet holding total',
    )
    if (row.asset_kind === 'sats') {
      if (row.asset_outcome_set_id !== null) {
        throw new Error('wallet holding sats row is invalid')
      }
      baseUnitProofs = amount
      continue
    }
    if (row.asset_kind !== 'Outcome') {
      throw new Error('wallet holding asset row is invalid')
    }
    outcomeAmountsBySet[
      requireText(row.asset_outcome_set_id, 'wallet holding outcome set')
    ] = amount
  }
  return { baseUnitProofs, outcomeAmountsBySet }
}

/** Enumerates only legacy nonterminal swaps for the bounded startup sweep. */
export function readDaemonActiveSwapIdsPage(
  database: DatabaseSync,
  input: DaemonIdPageInput,
): DaemonIdPage {
  assertDaemonStateSchema(database, false)
  validateIdPageInput(input)
  const rows = (
    input.cursor === null
      ? database
          .prepare(
            `SELECT trade_id
         FROM daemon_swaps
        WHERE step IN ('awaiting-trade-created', 'opened', 'seller-opened', 'buyer-responded', 'settling', 'awaiting-confirmation')
        ORDER BY trade_id
        LIMIT ?`,
          )
          .all(input.limit + 1)
      : database
          .prepare(
            `SELECT trade_id
         FROM daemon_swaps
        WHERE step IN ('awaiting-trade-created', 'opened', 'seller-opened', 'buyer-responded', 'settling', 'awaiting-confirmation')
          AND trade_id > ?
        ORDER BY trade_id
        LIMIT ?`,
          )
          .all(input.cursor, input.limit + 1)
  ) as Array<Record<string, unknown>>
  return idPageFromRows(rows, input.limit, 'active swap id')
}

/** Produces the RPC balance projection without hydrating bearer proof bodies. */
export function readDaemonWalletBalance(database: DatabaseSync): WalletBalance {
  assertDaemonStateSchema(database, false)
  const rows = database
    .prepare(
      `SELECT mint_url, state, asset_kind, asset_condition_id,
            asset_outcome_set_id, SUM(amount) AS total_amount
       FROM daemon_wallet_proofs
      WHERE base_asset = 'sat'
      GROUP BY mint_url, state, asset_kind, asset_condition_id, asset_outcome_set_id
      ORDER BY mint_url, asset_kind, asset_condition_id, asset_outcome_set_id, state`,
    )
    .all() as Array<Record<string, unknown>>
  const byMint = new Map<string, WalletBalance['byMint'][number]>()
  const outcomes = new Map<string, WalletBalance['outcomePositions'][number]>()
  for (const row of rows) {
    const mintUrl = requireText(row.mint_url, 'wallet balance mint URL')
    const state = requireWalletProofState(row.state)
    const amount = requireNonnegativeInteger(
      row.total_amount,
      'wallet balance amount',
    )
    const mint = byMint.get(mintUrl) ?? {
      mintUrl,
      availableSats: 0,
      reservedSats: 0,
      lockedSats: 0,
    }
    addBalanceAmount(mint, state, amount)
    byMint.set(mintUrl, mint)
    if (row.asset_kind === 'sats') continue
    if (row.asset_kind !== 'Outcome') {
      throw new Error('wallet balance asset kind is corrupt')
    }
    const conditionId = requireText(
      row.asset_condition_id,
      'wallet balance condition id',
    )
    const outcomeSetId = requireText(
      row.asset_outcome_set_id,
      'wallet balance outcome set id',
    )
    const key = `${mintUrl}\n${conditionId}\n${outcomeSetId}`
    const outcome = outcomes.get(key) ?? {
      mintUrl,
      conditionId,
      outcomeSetId,
      availableSats: 0,
      reservedSats: 0,
      lockedSats: 0,
    }
    addBalanceAmount(outcome, state, amount)
    outcomes.set(key, outcome)
  }
  const mintRows = [...byMint.values()]
  return {
    totalAvailableSats: mintRows.reduce(
      (sum, row) => sum + row.availableSats,
      0,
    ),
    totalReservedSats: mintRows.reduce((sum, row) => sum + row.reservedSats, 0),
    totalLockedSats: mintRows.reduce((sum, row) => sum + row.lockedSats, 0),
    byMint: mintRows,
    outcomePositions: [...outcomes.values()],
  }
}

/** Counts normalized rows without decoding opaque authority payloads. */
export function readDaemonStateCounts(
  database: DatabaseSync,
): DaemonStateCounts {
  assertDaemonStateSchema(database, false)
  const row = database
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM daemon_wallet_proofs) AS proofs,
       (SELECT COUNT(*) FROM daemon_proof_operations) AS proof_operations,
       (SELECT COUNT(*) FROM daemon_orders) AS orders,
       (SELECT COUNT(*) FROM daemon_swaps) AS swaps`,
    )
    .get() as Record<string, unknown>
  return {
    proofs: requireNonnegativeInteger(row.proofs, 'wallet proof count'),
    proofOperations: requireNonnegativeInteger(
      row.proof_operations,
      'proof operation count',
    ),
    orders: requireNonnegativeInteger(row.orders, 'order count'),
    swaps: requireNonnegativeInteger(row.swaps, 'swap count'),
  }
}

/** Checks endpoint-mutation eligibility without materializing durable state. */
export function readDaemonStateIsEmpty(database: DatabaseSync): boolean {
  assertDaemonStateSchema(database, false)
  const row = database
    .prepare(
      `SELECT
        NOT EXISTS (SELECT 1 FROM daemon_wallet_proofs LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daemon_keyset_counters LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daemon_proof_operations LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daemon_trade_sessions LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daemon_orders LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daemon_swaps LIMIT 1)
        AS is_empty`,
    )
    .get() as Record<string, unknown>
  return decodeDatabaseBoolean(row.is_empty, 'daemon state empty marker')
}

export function writeDaemonStateRows(
  database: DatabaseSync,
  state: DaemonState,
  scope: DaemonStateRowScope = FULL_DAEMON_STATE_ROW_SCOPE,
  changes: DaemonStateRowChanges = {},
): void {
  if (isFullStateScope(scope)) {
    clearStateRows(database)
    database
      .prepare(
        'INSERT INTO daemon_state_metadata (singleton, schema_version) VALUES (1, 1)',
      )
      .run()
  } else {
    clearScopedStateRows(database, state, scope, changes)
  }

  if (scope.wallet) {
    for (const proof of state.wallet.proofs) insertWalletProof(database, proof)
  } else if (scope.walletProofs !== undefined) {
    for (const proof of changes.walletProofUpserts ?? []) {
      insertWalletProof(database, proof)
    }
  }
  if (scope.wallet || scope.keysetCounterKeys !== undefined) {
    for (const [key, counter] of Object.entries(state.wallet.keysetCounters)) {
      database
        .prepare(
          'INSERT INTO daemon_keyset_counters (counter_key, counter_value) VALUES (?, ?)',
        )
        .run(key, counter)
    }
  }
  if (
    scope.tradeIds !== undefined ||
    scope.proofOperationIds !== undefined ||
    scope.durableOperationIds !== undefined
  ) {
    for (const session of Object.values(state.durableTradeSessions)) {
      insertTradeSession(database, session)
    }
    for (const operation of Object.values(state.proofOperations)) {
      insertProofOperation(database, operation)
    }
    for (const session of Object.values(state.durableTradeSessions)) {
      insertTradeSessionChildren(database, session)
    }
  }
  if (
    scope.orderIds !== undefined ||
    scope.orderTradeIds !== undefined ||
    scope.orderEphemeralPubkeys !== undefined
  ) {
    for (const order of Object.values(state.orders))
      insertOrder(database, order)
  }
  if (scope.swapIds !== undefined || scope.swapIdsFromOrderIds !== undefined) {
    for (const swap of Object.values(state.swaps)) insertSwap(database, swap)
  }
}

const STATE_SCHEMA_SQL = `
    CREATE TABLE daemon_state_metadata (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1)
    ) STRICT;

    CREATE TABLE daemon_wallet_proofs (
      proof_id TEXT PRIMARY KEY NOT NULL CHECK (length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'),
      mint_url TEXT NOT NULL CHECK (length(mint_url) > 0),
      unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat', 'usd')),
      proof_secret TEXT NOT NULL CHECK (length(proof_secret) > 0),
      keyset_id TEXT NOT NULL CHECK (length(keyset_id) > 0),
      amount INTEGER NOT NULL CHECK (amount >= 0),
      signature TEXT NOT NULL CHECK (length(signature) > 0),
      witness_present INTEGER NOT NULL CHECK (witness_present IN (0, 1)),
      witness_json TEXT CHECK (witness_json IS NULL OR (json_valid(witness_json) AND length(CAST(witness_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      dleq_present INTEGER NOT NULL CHECK (dleq_present IN (0, 1)),
      dleq_json TEXT CHECK (dleq_json IS NULL OR (json_valid(dleq_json) AND length(CAST(dleq_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      proof_condition_id TEXT CHECK (proof_condition_id IS NULL OR length(proof_condition_id) > 0),
      proof_outcome_collection TEXT CHECK (proof_outcome_collection IS NULL OR length(proof_outcome_collection) > 0),
      state TEXT NOT NULL CHECK (state IN ('available', 'reserved', 'locked')),
      reserved_by TEXT CHECK (reserved_by IS NULL OR length(reserved_by) > 0),
      asset_kind TEXT NOT NULL CHECK (asset_kind IN ('sats', 'Outcome')),
      asset_condition_id TEXT CHECK (asset_condition_id IS NULL OR length(asset_condition_id) > 0),
      asset_outcome_set_id TEXT CHECK (asset_outcome_set_id IS NULL OR length(asset_outcome_set_id) > 0),
      base_asset TEXT NOT NULL CHECK (length(base_asset) > 0),
      created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
      updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
      CHECK ((witness_present = 0 AND witness_json IS NULL) OR (witness_present = 1 AND witness_json IS NOT NULL)),
      CHECK ((dleq_present = 0 AND dleq_json IS NULL) OR (dleq_present = 1 AND dleq_json IS NOT NULL)),
      CHECK (length(CAST(COALESCE(witness_json, '') AS BLOB)) + length(CAST(COALESCE(dleq_json, '') AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      CHECK ((proof_condition_id IS NULL AND proof_outcome_collection IS NULL) OR (proof_condition_id IS NOT NULL AND proof_outcome_collection IS NOT NULL)),
      CHECK ((state = 'available' AND reserved_by IS NULL) OR (state IN ('reserved', 'locked') AND reserved_by IS NOT NULL)),
      CHECK (
        (unit IN ('sat', 'msat') AND base_asset = 'sat')
        OR (unit = 'usd' AND base_asset = 'usd')
      ),
      CHECK (
        (asset_kind = 'sats' AND asset_condition_id IS NULL AND asset_outcome_set_id IS NULL)
        OR
        (asset_kind = 'Outcome' AND asset_condition_id IS NOT NULL AND asset_outcome_set_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE daemon_keyset_counters (
      counter_key TEXT PRIMARY KEY NOT NULL CHECK (length(counter_key) > 0),
      counter_value INTEGER NOT NULL CHECK (counter_value >= 0)
    ) STRICT;

    CREATE TABLE daemon_trade_sessions (
      trade_id TEXT PRIMARY KEY NOT NULL CHECK (length(trade_id) > 0),
      schema_version INTEGER NOT NULL CHECK (schema_version = 2),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      role TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
      local_protocol_pubkey TEXT NOT NULL CHECK (length(local_protocol_pubkey) > 0),
      counterparty_protocol_pubkey TEXT NOT NULL CHECK (length(counterparty_protocol_pubkey) > 0),
      mint_url TEXT NOT NULL CHECK (length(mint_url) > 0),
      seller_locktime_secs INTEGER NOT NULL CHECK (seller_locktime_secs >= 0),
      buyer_locktime_secs INTEGER NOT NULL CHECK (buyer_locktime_secs >= 0),
      key_id TEXT NOT NULL REFERENCES daemon_order_ephemeral_keys(key_id) ON DELETE RESTRICT CHECK (length(key_id) > 0),
      key_trade_id TEXT NOT NULL CHECK (length(key_trade_id) > 0),
      key_role TEXT NOT NULL CHECK (key_role IN ('seller', 'buyer')),
      key_local_protocol_pubkey TEXT NOT NULL CHECK (length(key_local_protocol_pubkey) > 0),
      key_counterparty_protocol_pubkey TEXT NOT NULL CHECK (length(key_counterparty_protocol_pubkey) > 0),
      key_mint_url TEXT NOT NULL CHECK (length(key_mint_url) > 0),
      key_seller_locktime_secs INTEGER NOT NULL CHECK (key_seller_locktime_secs >= 0),
      key_buyer_locktime_secs INTEGER NOT NULL CHECK (key_buyer_locktime_secs >= 0),
      stage TEXT NOT NULL CHECK (stage IN ('intent', 'proof-reserved', 'mint-submitted', 'awaiting-dependent-operation', 'reconciliation-complete')),
      has_expected_operations INTEGER NOT NULL CHECK (has_expected_operations IN (0, 1)),
      has_planned_operations INTEGER NOT NULL CHECK (has_planned_operations IN (0, 1)),
      CHECK (key_trade_id = trade_id),
      CHECK (key_role = role),
      CHECK (key_local_protocol_pubkey = local_protocol_pubkey),
      CHECK (key_counterparty_protocol_pubkey = counterparty_protocol_pubkey),
      CHECK (key_mint_url = mint_url),
      CHECK (key_seller_locktime_secs = seller_locktime_secs),
      CHECK (key_buyer_locktime_secs = buyer_locktime_secs)
    ) STRICT;

    CREATE TABLE daemon_trade_expected_operations (
      trade_id TEXT NOT NULL REFERENCES daemon_trade_sessions(trade_id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 0),
      operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
      operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
      stage TEXT NOT NULL CHECK (stage IN ('proof-reservation', 'mint-submission', 'claim', 'refund')),
      kind TEXT CHECK (kind IN ('cashu-atomic', 'condition-ctf-merge')),
      PRIMARY KEY (trade_id, position),
      UNIQUE (trade_id, operation_id)
    ) STRICT;

    CREATE TABLE daemon_trade_planned_operations (
      trade_id TEXT NOT NULL REFERENCES daemon_trade_sessions(trade_id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 0),
      operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
      operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('cashu-atomic', 'condition-ctf-merge')),
      stage TEXT NOT NULL CHECK (stage IN ('proof-reservation', 'mint-submission', 'claim', 'refund')),
      depends_on_operation_id TEXT NOT NULL CHECK (length(depends_on_operation_id) > 0),
      context_version INTEGER NOT NULL CHECK (context_version = 1),
      context_role TEXT NOT NULL CHECK (context_role IN ('seller', 'buyer')),
      local_protocol_pubkey TEXT NOT NULL CHECK (length(local_protocol_pubkey) > 0),
      counterparty_protocol_pubkey TEXT NOT NULL CHECK (length(counterparty_protocol_pubkey) > 0),
      mint_url TEXT NOT NULL CHECK (length(mint_url) > 0),
      seller_locktime_secs INTEGER NOT NULL CHECK (seller_locktime_secs >= 0),
      buyer_locktime_secs INTEGER NOT NULL CHECK (buyer_locktime_secs >= 0),
      condition_id TEXT NOT NULL CHECK (length(condition_id) > 0),
      amm_scope_id TEXT NOT NULL CHECK (length(amm_scope_id) > 0),
      inventory_account_id TEXT NOT NULL CHECK (length(inventory_account_id) > 0),
      base_asset TEXT NOT NULL CHECK (length(base_asset) > 0),
      unit TEXT NOT NULL CHECK (length(unit) > 0),
      outcome_set_commitment TEXT NOT NULL CHECK (length(outcome_set_commitment) > 0),
      keyset_commitment TEXT NOT NULL CHECK (length(keyset_commitment) > 0),
      fee_commitment TEXT NOT NULL CHECK (length(fee_commitment) > 0),
      merge_input_commitment TEXT NOT NULL CHECK (length(merge_input_commitment) > 0),
      expected_output_commitment TEXT NOT NULL CHECK (length(expected_output_commitment) > 0),
      merge_operation_key TEXT NOT NULL CHECK (length(merge_operation_key) > 0),
      lock_operation_key TEXT NOT NULL CHECK (length(lock_operation_key) > 0),
      PRIMARY KEY (trade_id, position),
      UNIQUE (trade_id, operation_id)
    ) STRICT;

    CREATE TABLE daemon_proof_operations (
      operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('swap-lock', 'swap-claim', 'conditional-keyset-swap', 'ctf-split', 'ctf-merge', 'ctf-consolidation', 'ctf-redeem', 'regular-split', 'wallet-send', 'proof-split', 'swap-refund')),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'mint-submitted', 'completed', 'Failed')),
      mint_url TEXT NOT NULL CHECK (length(mint_url) > 0),
      durable_trade_id TEXT REFERENCES daemon_trade_sessions(trade_id) ON DELETE RESTRICT CHECK (durable_trade_id IS NULL OR length(durable_trade_id) > 0),
      durable_operation_id TEXT CHECK (durable_operation_id IS NULL OR length(durable_operation_id) > 0),
      durable_operation_key TEXT CHECK (durable_operation_key IS NULL OR length(durable_operation_key) > 0),
      durable_kind TEXT CHECK (durable_kind IN ('cashu-atomic', 'condition-ctf-merge')),
      durable_role TEXT CHECK (durable_role IN ('seller', 'buyer')),
      durable_stage TEXT CHECK (durable_stage IN ('proof-reservation', 'mint-submission', 'claim', 'refund')),
      durable_state TEXT CHECK (durable_state IN ('prepared', 'mint-submitted', 'reconciled')),
      inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json) AND length(CAST(inputs_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json) AND length(CAST(outputs_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      has_result_proofs INTEGER NOT NULL CHECK (has_result_proofs IN (0, 1)),
      result_proofs_json TEXT CHECK (result_proofs_json IS NULL OR (json_valid(result_proofs_json) AND length(CAST(result_proofs_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      last_error TEXT CHECK (last_error IS NULL OR length(last_error) > 0),
      failure_code INTEGER CHECK (failure_code >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (durable_trade_id IS NULL AND durable_operation_id IS NULL AND durable_operation_key IS NULL AND durable_kind IS NULL AND durable_role IS NULL AND durable_stage IS NULL AND durable_state IS NULL)
        OR
        (durable_trade_id IS NOT NULL AND durable_operation_id IS NOT NULL AND durable_operation_key IS NOT NULL AND durable_role IS NOT NULL AND durable_stage IS NOT NULL AND durable_state IS NOT NULL)
      ),
      CHECK ((has_result_proofs = 0 AND result_proofs_json IS NULL) OR (has_result_proofs = 1 AND result_proofs_json IS NOT NULL)),
      CHECK ((state = 'completed' AND has_result_proofs = 1) OR (state <> 'completed' AND has_result_proofs = 0)),
      CHECK (failure_code IS NULL OR state = 'Failed'),
      CHECK (
        length(CAST(inputs_json AS BLOB)) +
        length(CAST(outputs_json AS BLOB)) +
        length(CAST(metadata_json AS BLOB)) +
        length(CAST(COALESCE(result_proofs_json, '') AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}
      ),
      UNIQUE (durable_operation_id)
    ) STRICT;

    CREATE TABLE daemon_trade_proof_links (
      trade_id TEXT NOT NULL REFERENCES daemon_trade_sessions(trade_id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 0),
      operation_id TEXT NOT NULL REFERENCES daemon_proof_operations(durable_operation_id) ON DELETE RESTRICT,
      operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
      kind TEXT CHECK (kind IN ('cashu-atomic', 'condition-ctf-merge')),
      role TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
      stage TEXT NOT NULL CHECK (stage IN ('proof-reservation', 'mint-submission', 'claim', 'refund')),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'mint-submitted', 'reconciled')),
      PRIMARY KEY (trade_id, position),
      UNIQUE (trade_id, operation_id)
    ) STRICT;

    CREATE TABLE daemon_trade_ciphers (
      trade_id TEXT NOT NULL REFERENCES daemon_trade_sessions(trade_id) ON DELETE RESTRICT,
      direction TEXT NOT NULL CHECK (direction IN ('received', 'outbound')),
      message_type TEXT NOT NULL CHECK (message_type IN ('adaptor-point', 'locked-proofs-seller', 'locked-proofs-buyer')),
      ciphertext TEXT NOT NULL CHECK (length(ciphertext) > 0 AND length(CAST(ciphertext AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
      PRIMARY KEY (trade_id, direction, message_type)
    ) STRICT;

    CREATE TABLE daemon_orders (
      order_id TEXT PRIMARY KEY NOT NULL CHECK (length(order_id) > 0),
      market_id TEXT NOT NULL CHECK (length(market_id) > 0),
      token_side TEXT CHECK (token_side IN ('Outcome', 'Complement')),
      side TEXT CHECK (side IN ('Buy', 'Sell')),
      price_subunits INTEGER CHECK (price_subunits >= 0),
      amount_subunits INTEGER CHECK (amount_subunits >= 0),
      time_in_force TEXT CHECK (time_in_force IN ('FAK', 'FOK', 'GTC')),
      recovery_attempt INTEGER CHECK (recovery_attempt >= 0),
      status TEXT NOT NULL CHECK (length(status) > 0),
      ephemeral_pubkey TEXT CHECK (ephemeral_pubkey IS NULL OR length(ephemeral_pubkey) > 0),
      client_order_id TEXT CHECK (client_order_id IS NULL OR length(client_order_id) > 0),
      preflight_reservation_id TEXT CHECK (preflight_reservation_id IS NULL OR length(preflight_reservation_id) > 0),
      preflight_condition_id TEXT CHECK (preflight_condition_id IS NULL OR length(preflight_condition_id) > 0),
      preflight_keep_outcome_set_id TEXT CHECK (preflight_keep_outcome_set_id IS NULL OR length(preflight_keep_outcome_set_id) > 0),
      preflight_lock_outcome_set_id TEXT CHECK (preflight_lock_outcome_set_id IS NULL OR length(preflight_lock_outcome_set_id) > 0),
      preflight_amount_sats INTEGER CHECK (preflight_amount_sats > 0),
      base_asset TEXT CHECK (base_asset IS NULL OR length(base_asset) > 0),
      divisibility INTEGER CHECK (divisibility > 0),
      engine_status_present INTEGER NOT NULL CHECK (engine_status_present IN (0, 1)),
      engine_status_json TEXT CHECK (engine_status_json IS NULL OR (json_valid(engine_status_json) AND length(CAST(engine_status_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
      updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
      CHECK (
        (preflight_reservation_id IS NULL AND preflight_condition_id IS NULL AND preflight_keep_outcome_set_id IS NULL AND preflight_lock_outcome_set_id IS NULL AND preflight_amount_sats IS NULL)
        OR
        (preflight_reservation_id IS NOT NULL AND preflight_condition_id IS NOT NULL AND preflight_keep_outcome_set_id IS NOT NULL AND preflight_lock_outcome_set_id IS NOT NULL AND preflight_amount_sats IS NOT NULL)
      ),
      CHECK ((engine_status_present = 0 AND engine_status_json IS NULL) OR (engine_status_present = 1 AND engine_status_json IS NOT NULL))
    ) STRICT;

    CREATE TABLE daemon_order_trades (
      order_id TEXT NOT NULL REFERENCES daemon_orders(order_id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 0),
      trade_id TEXT NOT NULL CHECK (length(trade_id) > 0),
      PRIMARY KEY (order_id, position),
      UNIQUE (order_id, trade_id)
    ) STRICT;

    CREATE TABLE daemon_swaps (
      trade_id TEXT PRIMARY KEY NOT NULL CHECK (length(trade_id) > 0),
      market_id TEXT CHECK (market_id IS NULL OR length(market_id) > 0),
      order_id TEXT CHECK (order_id IS NULL OR length(order_id) > 0),
      role TEXT CHECK (role IN ('seller', 'buyer')),
      counterparty_pubkey TEXT CHECK (counterparty_pubkey IS NULL OR length(counterparty_pubkey) > 0),
      seller_locktime INTEGER CHECK (seller_locktime >= 0),
      buyer_locktime INTEGER CHECK (buyer_locktime >= 0),
      fill_amount_sats INTEGER CHECK (fill_amount_sats >= 0),
      fill_amount_subunits INTEGER CHECK (fill_amount_subunits >= 0),
      outcome_face_amount_sats INTEGER CHECK (outcome_face_amount_sats >= 0),
      outcome_face_amount_subunits INTEGER CHECK (outcome_face_amount_subunits >= 0),
      quote_payment_sats INTEGER CHECK (quote_payment_sats >= 0),
      base_asset TEXT CHECK (base_asset IS NULL OR length(base_asset) > 0),
      divisibility INTEGER CHECK (divisibility > 0),
      quote_payment_subunits INTEGER CHECK (quote_payment_subunits >= 0),
      settlement_kind TEXT CHECK (settlement_kind IN ('Mint', 'DirectSwap')),
      seller_keep_outcome_set_id TEXT CHECK (seller_keep_outcome_set_id IS NULL OR length(seller_keep_outcome_set_id) > 0),
      seller_lock_outcome_set_id TEXT CHECK (seller_lock_outcome_set_id IS NULL OR length(seller_lock_outcome_set_id) > 0),
      is_taker INTEGER CHECK (is_taker IN (0, 1)),
      adaptor_point_cipher TEXT CHECK (adaptor_point_cipher IS NULL OR length(CAST(adaptor_point_cipher AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      locked_proofs_seller_cipher TEXT CHECK (locked_proofs_seller_cipher IS NULL OR length(CAST(locked_proofs_seller_cipher AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      locked_proofs_buyer_cipher TEXT CHECK (locked_proofs_buyer_cipher IS NULL OR length(CAST(locked_proofs_buyer_cipher AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}),
      seller_adaptor_secret_hex TEXT CHECK (seller_adaptor_secret_hex IS NULL OR (length(seller_adaptor_secret_hex) > 0 AND seller_adaptor_secret_hex NOT GLOB '*[^0-9a-fA-F]*')),
      seller_adaptor_point_hex TEXT CHECK (seller_adaptor_point_hex IS NULL OR (length(seller_adaptor_point_hex) > 0 AND seller_adaptor_point_hex NOT GLOB '*[^0-9a-fA-F]*')),
      buyer_pre_sigs_json TEXT CHECK (buyer_pre_sigs_json IS NULL OR (json_valid(buyer_pre_sigs_json) AND length(CAST(buyer_pre_sigs_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      buyer_locked_proofs_json TEXT CHECK (buyer_locked_proofs_json IS NULL OR (json_valid(buyer_locked_proofs_json) AND length(CAST(buyer_locked_proofs_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      seller_pre_sigs_json TEXT CHECK (seller_pre_sigs_json IS NULL OR (json_valid(seller_pre_sigs_json) AND length(CAST(seller_pre_sigs_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      engine_state TEXT CHECK (engine_state IS NULL OR length(engine_state) > 0),
      failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) > 0),
      taker_client_order_id TEXT CHECK (taker_client_order_id IS NULL OR length(taker_client_order_id) > 0),
      taker_recovery_status TEXT CHECK (taker_recovery_status IN ('pending', 'submitted')),
      taker_replacement_order_id TEXT CHECK (taker_replacement_order_id IS NULL OR length(taker_replacement_order_id) > 0),
      step TEXT NOT NULL CHECK (step IN ('awaiting-trade-created', 'opened', 'seller-opened', 'buyer-responded', 'settling', 'awaiting-confirmation', 'confirmed', 'refunded', 'Failed')),
      error TEXT CHECK (error IS NULL OR length(error) > 0),
      failure_json TEXT CHECK (failure_json IS NULL OR (json_valid(failure_json) AND length(CAST(failure_json AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES})),
      created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
      updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z'),
      CHECK ((seller_adaptor_secret_hex IS NULL AND seller_adaptor_point_hex IS NULL) OR (seller_adaptor_secret_hex IS NOT NULL AND seller_adaptor_point_hex IS NOT NULL)),
      CHECK (
        (taker_client_order_id IS NULL AND taker_recovery_status IS NULL AND taker_replacement_order_id IS NULL)
        OR
        (taker_client_order_id IS NOT NULL AND taker_recovery_status = 'pending' AND taker_replacement_order_id IS NULL)
        OR
        (taker_client_order_id IS NOT NULL AND taker_recovery_status = 'submitted' AND taker_replacement_order_id IS NOT NULL)
      ),
      CHECK (
        (buyer_pre_sigs_json IS NULL AND buyer_locked_proofs_json IS NULL AND seller_pre_sigs_json IS NULL)
        OR
        (buyer_pre_sigs_json IS NOT NULL AND buyer_locked_proofs_json IS NOT NULL AND seller_pre_sigs_json IS NOT NULL)
      ),
      CHECK (
        length(CAST(COALESCE(adaptor_point_cipher, '') AS BLOB)) +
        length(CAST(COALESCE(locked_proofs_seller_cipher, '') AS BLOB)) +
        length(CAST(COALESCE(locked_proofs_buyer_cipher, '') AS BLOB)) +
        length(CAST(COALESCE(buyer_pre_sigs_json, '') AS BLOB)) +
        length(CAST(COALESCE(buyer_locked_proofs_json, '') AS BLOB)) +
        length(CAST(COALESCE(seller_pre_sigs_json, '') AS BLOB)) +
        length(CAST(COALESCE(failure_json, '') AS BLOB)) <= ${OPAQUE_ARTIFACT_MAX_BYTES}
      )
    ) STRICT;

    CREATE INDEX daemon_wallet_proofs_selection_idx
      ON daemon_wallet_proofs (
        mint_url, unit, state, asset_kind, base_asset, asset_condition_id,
        asset_outcome_set_id, amount DESC, proof_id
      );

    CREATE INDEX daemon_wallet_proofs_denomination_idx
      ON daemon_wallet_proofs (mint_url, unit, amount);

    CREATE INDEX daemon_proof_operations_recovery_idx
      ON daemon_proof_operations (durable_trade_id, state, operation_id);

    CREATE INDEX daemon_orders_listing_idx
      ON daemon_orders (market_id, status, updated_at DESC, order_id);

    CREATE INDEX daemon_orders_ephemeral_pubkey_idx
      ON daemon_orders (ephemeral_pubkey, order_id);

    CREATE INDEX daemon_order_trades_trade_idx
      ON daemon_order_trades (trade_id, order_id);

    CREATE INDEX daemon_swaps_listing_idx
      ON daemon_swaps (market_id, step, updated_at DESC, trade_id);

    CREATE INDEX daemon_swaps_order_idx
      ON daemon_swaps (order_id, updated_at DESC, trade_id);

    CREATE INDEX daemon_swaps_active_recovery_idx
      ON daemon_swaps (trade_id)
      WHERE step IN ('awaiting-trade-created', 'opened', 'seller-opened', 'buyer-responded', 'settling', 'awaiting-confirmation');

    CREATE INDEX daemon_wallet_proofs_reservation_idx
      ON daemon_wallet_proofs (reserved_by, state, mint_url, proof_id);
  `

function createStateSchema(database: DatabaseSync): void {
  database.exec(STATE_SCHEMA_SQL)
}

function clearStateRows(database: DatabaseSync): void {
  for (const table of [
    'daemon_trade_ciphers',
    'daemon_trade_proof_links',
    'daemon_trade_planned_operations',
    'daemon_trade_expected_operations',
    'daemon_proof_operations',
    'daemon_order_trades',
    'daemon_swaps',
    'daemon_orders',
    'daemon_trade_sessions',
    'daemon_wallet_proofs',
    'daemon_keyset_counters',
    'daemon_state_metadata',
  ]) {
    database.exec(`DELETE FROM ${table}`)
  }
}

function clearScopedStateRows(
  database: DatabaseSync,
  state: DaemonState,
  scope: DaemonStateRowScope,
  changes: DaemonStateRowChanges,
): void {
  if (scope.wallet) {
    database.exec('DELETE FROM daemon_wallet_proofs')
    database.exec('DELETE FROM daemon_keyset_counters')
  } else {
    if (scope.walletProofs !== undefined) {
      const statement = database.prepare(
        'DELETE FROM daemon_wallet_proofs WHERE proof_id = ?',
      )
      for (const proofId of changes.walletProofDeleteIds ?? []) {
        statement.run(proofId)
      }
    }
    if (scope.keysetCounterKeys === 'all') {
      database.exec('DELETE FROM daemon_keyset_counters')
    } else {
      deleteRowsByIds(
        database,
        'daemon_keyset_counters',
        'counter_key',
        scope.keysetCounterKeys ?? [],
      )
    }
  }

  if (
    scope.tradeIds === 'all' ||
    scope.proofOperationIds === 'all' ||
    scope.durableOperationIds === 'all'
  ) {
    throw new Error('unbounded runtime daemon state replacement is unsupported')
  }
  const tradeIds = new Set(scope.tradeIds ?? [])
  const operationIds = new Set(scope.proofOperationIds ?? [])
  for (const tradeId of Object.keys(state.durableTradeSessions))
    tradeIds.add(tradeId)
  for (const operation of Object.values(state.proofOperations)) {
    operationIds.add(operation.operationId)
    if (operation.durableTradeRecovery) {
      tradeIds.add(operation.durableTradeRecovery.tradeId)
    }
  }
  if (tradeIds.size > 0) {
    const values = [...tradeIds]
    deleteRowsByIds(database, 'daemon_trade_ciphers', 'trade_id', values)
    deleteRowsByIds(database, 'daemon_trade_proof_links', 'trade_id', values)
    deleteRowsByIds(
      database,
      'daemon_trade_planned_operations',
      'trade_id',
      values,
    )
    deleteRowsByIds(
      database,
      'daemon_trade_expected_operations',
      'trade_id',
      values,
    )
    deleteRowsByIds(
      database,
      'daemon_proof_operations',
      'durable_trade_id',
      values,
    )
    deleteRowsByIds(database, 'daemon_trade_sessions', 'trade_id', values)
  }
  deleteRowsByIds(database, 'daemon_proof_operations', 'operation_id', [
    ...operationIds,
  ])

  if (scope.orderIds === 'all' || scope.swapIds === 'all') {
    throw new Error(
      'unbounded runtime daemon history replacement is unsupported',
    )
  }
  const orderIds = new Set(scope.orderIds ?? [])
  for (const orderId of Object.keys(state.orders)) orderIds.add(orderId)
  deleteRowsByIds(database, 'daemon_order_trades', 'order_id', [...orderIds])
  deleteRowsByIds(database, 'daemon_orders', 'order_id', [...orderIds])

  const swapIds = new Set(scope.swapIds ?? [])
  for (const tradeId of Object.keys(state.swaps)) swapIds.add(tradeId)
  deleteRowsByIds(database, 'daemon_swaps', 'trade_id', [...swapIds])
}

function isFullStateScope(scope: DaemonStateRowScope): boolean {
  return (
    scope.wallet === true &&
    scope.proofOperationIds === 'all' &&
    scope.tradeIds === 'all' &&
    scope.orderIds === 'all' &&
    scope.swapIds === 'all'
  )
}

function selectWalletProofRows(
  database: DatabaseSync,
  selectors: readonly DaemonWalletProofSelector[],
): Array<Record<string, unknown>> {
  const selected = new Map<string, Record<string, unknown>>()
  for (const selector of selectors) {
    const proofIds =
      selector.proofIds === undefined
        ? [undefined]
        : chunks([...new Set(selector.proofIds)], 400)
    if (proofIds.length === 0) continue
    for (const proofIdChunk of proofIds) {
      const clauses: string[] = []
      const params: Array<string | number> = []
      if (selector.mintUrl !== undefined) {
        clauses.push('mint_url = ?')
        params.push(selector.mintUrl)
      }
      if (selector.unit !== undefined) {
        clauses.push('unit = ?')
        params.push(selector.unit)
      }
      if (proofIdChunk !== undefined) {
        clauses.push(`proof_id IN (${proofIdChunk.map(() => '?').join(', ')})`)
        params.push(...proofIdChunk)
      }
      if (selector.state !== undefined) {
        clauses.push('state = ?')
        params.push(selector.state)
      }
      if (selector.reservedBy !== undefined) {
        clauses.push('reserved_by = ?')
        params.push(selector.reservedBy)
      }
      if (selector.assetKind !== undefined) {
        clauses.push('asset_kind = ?')
        params.push(selector.assetKind)
        if (selector.assetKind === 'sats') {
          clauses.push('asset_condition_id IS NULL')
          clauses.push('asset_outcome_set_id IS NULL')
        }
      }
      if (selector.conditionId !== undefined) {
        clauses.push('asset_condition_id = ?')
        params.push(selector.conditionId)
      }
      if (selector.outcomeSetId !== undefined) {
        clauses.push('asset_outcome_set_id = ?')
        params.push(selector.outcomeSetId)
      }
      if (selector.baseAsset !== undefined) {
        clauses.push('base_asset = ?')
        params.push(selector.baseAsset)
      }
      if (clauses.length === 0) {
        throw new Error('unbounded daemon wallet proof selector is unsupported')
      }
      const candidateLimit = selector.candidateLimit === true
      if (candidateLimit) params.push(DAEMON_WALLET_PROOF_CANDIDATE_QUERY_LIMIT)
      const rows = database
        .prepare(
          `SELECT * FROM daemon_wallet_proofs
          WHERE ${clauses.join(' AND ')}
          ORDER BY ${candidateLimit ? 'amount DESC, proof_id' : 'proof_id'}
          ${candidateLimit ? 'LIMIT CAST(? AS INTEGER)' : ''}`,
        )
        .all(...params) as Array<Record<string, unknown>>
      for (const row of rows) {
        const key = requireProofId(row.proof_id)
        selected.set(key, row)
      }
    }
  }
  return [...selected.values()].sort(
    selectors.some((selector) => selector.candidateLimit)
      ? compareWalletProofCandidateRows
      : compareWalletProofRows,
  )
}

function compareWalletProofCandidateRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftAmount = requireNonnegativeInteger(left.amount, 'proof amount')
  const rightAmount = requireNonnegativeInteger(right.amount, 'proof amount')
  return rightAmount - leftAmount || compareWalletProofRows(left, right)
}

function compareWalletProofRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return requireProofId(left.proof_id).localeCompare(
    requireProofId(right.proof_id),
  )
}

function selectOrderRows(
  database: DatabaseSync,
  scope: DaemonStateRowScope,
): Array<Record<string, unknown>> {
  if (scope.orderIds === 'all') {
    return selectScopedRows(database, 'daemon_orders', 'order_id', 'all')
  }
  const selected = new Map<string, Record<string, unknown>>()
  const collect = (rows: Array<Record<string, unknown>>): void => {
    for (const row of rows) {
      selected.set(requireText(row.order_id, 'local order id'), row)
    }
  }
  collect(
    selectRowsByIds(
      database,
      'daemon_orders',
      'order_id',
      scope.orderIds ?? [],
    ),
  )
  if (scope.orderTradeIds !== undefined) {
    const tradeRows = selectRowsByIds(
      database,
      'daemon_order_trades',
      'trade_id',
      scope.orderTradeIds,
    )
    collect(
      selectRowsByIds(
        database,
        'daemon_orders',
        'order_id',
        tradeRows.map((row) => requireText(row.order_id, 'local order id')),
      ),
    )
  }
  if (scope.orderIdsFromSwapIds !== undefined) {
    for (const tradeIds of chunks(
      [...new Set(scope.orderIdsFromSwapIds)],
      400,
    )) {
      if (tradeIds.length === 0) continue
      const placeholders = tradeIds.map(() => '?').join(', ')
      collect(
        database
          .prepare(
            `SELECT orders.*
           FROM daemon_orders AS orders
           JOIN daemon_swaps AS swaps ON swaps.order_id = orders.order_id
          WHERE swaps.trade_id IN (${placeholders})
          ORDER BY orders.order_id`,
          )
          .all(...tradeIds) as Array<Record<string, unknown>>,
      )
    }
  }
  if (scope.orderEphemeralPubkeys !== undefined) {
    collect(
      selectRowsByIds(
        database,
        'daemon_orders',
        'ephemeral_pubkey',
        scope.orderEphemeralPubkeys,
      ),
    )
  }
  return [...selected.values()].sort((left, right) =>
    requireText(left.order_id, 'local order id').localeCompare(
      requireText(right.order_id, 'local order id'),
    ),
  )
}

function selectScopedRows(
  database: DatabaseSync,
  table: string,
  column: string,
  selection: readonly string[] | 'all' | undefined,
): Array<Record<string, unknown>> {
  if (selection === undefined) return []
  if (selection === 'all') {
    return database
      .prepare(`SELECT * FROM ${table} ORDER BY ${column}`)
      .all() as Array<Record<string, unknown>>
  }
  return selectRowsByIds(database, table, column, selection)
}

function selectRowsByIds(
  database: DatabaseSync,
  table: string,
  column: string,
  ids: readonly string[],
): Array<Record<string, unknown>> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return []
  return chunks(uniqueIds, 400).flatMap((chunk) => {
    const placeholders = chunk.map(() => '?').join(', ')
    return database
      .prepare(
        `SELECT * FROM ${table} WHERE ${column} IN (${placeholders}) ORDER BY ${column}, rowid`,
      )
      .all(...chunk) as Array<Record<string, unknown>>
  })
}

function deleteRowsByIds(
  database: DatabaseSync,
  table: string,
  column: string,
  ids: readonly string[],
): void {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return
  for (const chunk of chunks(uniqueIds, 400)) {
    const placeholders = chunk.map(() => '?').join(', ')
    database
      .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
      .run(...chunk)
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size))
  }
  return result
}

function groupRowsByParent(
  rows: Array<Record<string, unknown>>,
  parentColumn: 'trade_id' | 'order_id',
): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const rawParent = row[parentColumn]
    const parent = requireText(rawParent, 'state child parent')
    const current = grouped.get(parent) ?? []
    current.push(row)
    grouped.set(parent, current)
  }
  return grouped
}

function insertWalletProof(
  database: DatabaseSync,
  record: StoredProofRecord,
): void {
  const proof = record.proof
  if (proof.id === undefined || proof.id.length === 0) {
    throw new Error('stored proof keyset id is required')
  }
  const witnessPresent = Object.hasOwn(proof, 'witness')
  const dleqPresent = Object.hasOwn(proof, 'dleq')
  database
    .prepare(
      `INSERT INTO daemon_wallet_proofs (
      proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
      witness_present, witness_json, dleq_present, dleq_json,
      proof_condition_id, proof_outcome_collection, state, reserved_by,
      asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deriveDaemonWalletProofId(record),
      record.mintUrl,
      record.unit,
      proof.secret,
      proof.id,
      requireNonnegativeInteger(proof.amount, 'proof amount'),
      proof.C,
      witnessPresent ? 1 : 0,
      witnessPresent ? encodeArtifact(proof.witness, 'proof witness') : null,
      dleqPresent ? 1 : 0,
      dleqPresent ? encodeArtifact(proof.dleq, 'proof DLEQ') : null,
      proof.conditionId ?? null,
      proof.outcomeCollection ?? null,
      record.state,
      record.reservedBy ?? null,
      record.asset.kind,
      record.asset.kind === 'Outcome' ? record.asset.conditionId : null,
      record.asset.kind === 'Outcome' ? record.asset.outcomeSetId : null,
      record.asset.baseAsset,
      record.createdAt,
      record.updatedAt,
    )
}

function insertTradeSession(
  database: DatabaseSync,
  session: DaemonState['durableTradeSessions'][string],
): void {
  const key = session.ephemeralKeyHandle
  database
    .prepare(
      `INSERT INTO daemon_trade_sessions (
      trade_id, schema_version, revision, role, local_protocol_pubkey,
      counterparty_protocol_pubkey, mint_url, seller_locktime_secs, buyer_locktime_secs,
      key_id, key_trade_id, key_role, key_local_protocol_pubkey,
      key_counterparty_protocol_pubkey, key_mint_url,
      key_seller_locktime_secs, key_buyer_locktime_secs, stage,
      has_expected_operations, has_planned_operations
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.tradeId,
      session.schemaVersion,
      session.revision,
      session.role,
      session.localProtocolPubkey,
      session.counterpartyProtocolPubkey,
      session.mintUrl,
      session.sellerLocktimeSecs,
      session.buyerLocktimeSecs,
      key.keyId,
      key.tradeId,
      key.role,
      key.localProtocolPubkey,
      key.counterpartyProtocolPubkey,
      key.mintUrl,
      key.sellerLocktimeSecs,
      key.buyerLocktimeSecs,
      session.stage,
      session.expectedProofOperations === undefined ? 0 : 1,
      session.plannedProofOperations === undefined ? 0 : 1,
    )
}

function insertProofOperation(
  database: DatabaseSync,
  operation: ProofOperationRecord,
): void {
  const link = operation.durableTradeRecovery
  database
    .prepare(
      `INSERT INTO daemon_proof_operations (
      operation_id, kind, state, mint_url, durable_trade_id, durable_operation_id,
      durable_operation_key,
      durable_kind, durable_role, durable_stage, durable_state,
      inputs_json, outputs_json, metadata_json, has_result_proofs,
      result_proofs_json, last_error, failure_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      operation.operationId,
      operation.kind,
      operation.state,
      operation.mintUrl,
      link?.tradeId ?? null,
      link?.operationId ?? null,
      link?.operationKey ?? null,
      link?.kind ?? null,
      link?.role ?? null,
      link?.stage ?? null,
      link?.state ?? null,
      encodeArtifact(operation.inputs, 'proof operation inputs'),
      encodeArtifact(operation.outputs, 'proof operation outputs'),
      encodeArtifact(operation.metadata, 'proof operation metadata'),
      operation.resultProofs === undefined ? 0 : 1,
      operation.resultProofs === undefined
        ? null
        : encodeArtifact(
            operation.resultProofs,
            'proof operation result proofs',
          ),
      operation.lastError ?? null,
      operation.failureCode ?? null,
      operation.createdAt,
      operation.updatedAt,
    )
}

function insertTradeSessionChildren(
  database: DatabaseSync,
  session: DaemonState['durableTradeSessions'][string],
): void {
  for (const [position, operation] of (
    session.expectedProofOperations ?? []
  ).entries()) {
    database
      .prepare(
        `INSERT INTO daemon_trade_expected_operations (
        trade_id, position, operation_id, operation_key, stage, kind
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.tradeId,
        position,
        operation.operationId,
        operation.operationKey,
        operation.stage,
        operation.kind ?? null,
      )
  }
  for (const [position, operation] of (
    session.plannedProofOperations ?? []
  ).entries()) {
    const context = operation.context
    database
      .prepare(
        `INSERT INTO daemon_trade_planned_operations (
        trade_id, position, operation_id, operation_key, kind, stage,
        depends_on_operation_id, context_version, context_role,
        local_protocol_pubkey, counterparty_protocol_pubkey, mint_url,
        seller_locktime_secs, buyer_locktime_secs, condition_id, amm_scope_id,
        inventory_account_id, base_asset, unit, outcome_set_commitment,
        keyset_commitment, fee_commitment, merge_input_commitment,
        expected_output_commitment, merge_operation_key, lock_operation_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.tradeId,
        position,
        operation.operationId,
        operation.operationKey,
        operation.kind,
        operation.stage,
        operation.dependsOnOperationId,
        context.contextVersion,
        context.role,
        context.localProtocolPubkey,
        context.counterpartyProtocolPubkey,
        context.mintUrl,
        context.sellerLocktimeSecs,
        context.buyerLocktimeSecs,
        context.conditionId,
        context.ammScopeId,
        context.inventoryAccountId,
        context.baseAsset,
        context.unit,
        context.outcomeSetCommitment,
        context.keysetCommitment,
        context.feeCommitment,
        context.mergeInputCommitment,
        context.expectedOutputCommitment,
        context.mergeOperationKey,
        context.lockOperationKey,
      )
  }
  for (const [position, operation] of session.proofOperations.entries()) {
    database
      .prepare(
        `INSERT INTO daemon_trade_proof_links (
        trade_id, position, operation_id, operation_key, kind, role, stage, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.tradeId,
        position,
        operation.operationId,
        operation.operationKey ?? null,
        operation.kind ?? null,
        operation.role,
        operation.stage,
        operation.state,
      )
  }
  for (const [direction, ciphers] of [
    ['received', session.receivedCiphers],
    ['outbound', session.outboundCiphers],
  ] as const) {
    for (const [messageType, cipher] of Object.entries(ciphers)) {
      if (cipher === undefined) continue
      database
        .prepare(
          `INSERT INTO daemon_trade_ciphers (
          trade_id, direction, message_type, ciphertext, sha256
        ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          session.tradeId,
          direction,
          messageType,
          cipher.ciphertext,
          cipher.sha256,
        )
    }
  }
}

function insertOrder(database: DatabaseSync, order: LocalOrderRecord): void {
  const preflight = order.preflightSplit
  const engineStatusPresent = Object.hasOwn(order, 'engineStatus')
  database
    .prepare(
      `INSERT INTO daemon_orders (
      order_id, market_id, token_side, side, price_subunits, amount_subunits,
      time_in_force, recovery_attempt, status, ephemeral_pubkey, client_order_id,
      preflight_reservation_id, preflight_condition_id, preflight_keep_outcome_set_id,
      preflight_lock_outcome_set_id, preflight_amount_sats, base_asset, divisibility,
      engine_status_present, engine_status_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      order.orderId,
      order.marketId,
      order.tokenSide ?? null,
      order.side ?? null,
      order.priceSubunits ?? null,
      order.amountSubunits ?? null,
      order.timeInForce ?? null,
      order.recoveryAttempt ?? null,
      order.status,
      order.ephemeralPubkey ?? null,
      order.clientOrderId ?? null,
      preflight?.reservationId ?? null,
      preflight?.conditionId ?? null,
      preflight?.keepOutcomeSetId ?? null,
      preflight?.lockOutcomeSetId ?? null,
      preflight?.amountSats ?? null,
      order.baseAsset ?? null,
      order.divisibility ?? null,
      engineStatusPresent ? 1 : 0,
      engineStatusPresent
        ? encodeArtifact(order.engineStatus, 'order engine status')
        : null,
      order.createdAt,
      order.updatedAt,
    )
  for (const [position, tradeId] of order.tradeIds.entries()) {
    database
      .prepare(
        'INSERT INTO daemon_order_trades (order_id, position, trade_id) VALUES (?, ?, ?)',
      )
      .run(order.orderId, position, tradeId)
  }
}

function insertSwap(database: DatabaseSync, swap: LocalSwapRecord): void {
  const taker = swap.takerRecovery
  database
    .prepare(
      `INSERT INTO daemon_swaps (
      trade_id, market_id, order_id, role, counterparty_pubkey,
      seller_locktime, buyer_locktime, fill_amount_sats, fill_amount_subunits,
      outcome_face_amount_sats, outcome_face_amount_subunits, quote_payment_sats,
      base_asset, divisibility, quote_payment_subunits, settlement_kind,
      seller_keep_outcome_set_id, seller_lock_outcome_set_id, is_taker,
      adaptor_point_cipher, locked_proofs_seller_cipher, locked_proofs_buyer_cipher,
      seller_adaptor_secret_hex, seller_adaptor_point_hex, buyer_pre_sigs_json,
      buyer_locked_proofs_json, seller_pre_sigs_json, engine_state, failure_reason,
      taker_client_order_id, taker_recovery_status, taker_replacement_order_id,
      step, error, failure_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      swap.tradeId,
      swap.marketId ?? null,
      swap.orderId ?? null,
      swap.role ?? null,
      swap.counterpartyPubkey ?? null,
      swap.sellerLocktime ?? null,
      swap.buyerLocktime ?? null,
      swap.fillAmountSats ?? null,
      swap.fillAmountSubunits ?? null,
      swap.outcomeFaceAmountSats ?? null,
      swap.outcomeFaceAmountSubunits ?? null,
      swap.quotePaymentSats ?? null,
      swap.baseAsset ?? null,
      swap.divisibility ?? null,
      swap.quotePaymentSubunits ?? null,
      swap.settlementKind ?? null,
      swap.sellerKeepOutcomeSetId ?? null,
      swap.sellerLockOutcomeSetId ?? null,
      swap.isTaker === undefined ? null : swap.isTaker ? 1 : 0,
      swap.messages.adaptorPoint ?? null,
      swap.messages.lockedProofsSeller ?? null,
      swap.messages.lockedProofsBuyer ?? null,
      swap.sellerAdaptorSecretHex ?? null,
      swap.sellerAdaptorPointHex ?? null,
      swap.buyerPreSigsHex === undefined
        ? null
        : encodeArtifact(swap.buyerPreSigsHex, 'buyer pre-signatures'),
      swap.buyerLockedProofs === undefined
        ? null
        : encodeArtifact(swap.buyerLockedProofs, 'buyer locked proofs'),
      swap.sellerPreSigsHex === undefined
        ? null
        : encodeArtifact(swap.sellerPreSigsHex, 'seller pre-signatures'),
      swap.engineState ?? null,
      swap.failureReason ?? null,
      taker?.clientOrderId ?? null,
      taker?.status ?? null,
      taker?.replacementOrderId ?? null,
      swap.step,
      swap.error ?? null,
      swap.failure === undefined
        ? null
        : encodeArtifact(swap.failure, 'swap failure'),
      swap.createdAt,
      swap.updatedAt,
    )
}

function decodeWalletProofRow(row: Record<string, unknown>): StoredProofRecord {
  const witnessPresent = decodeDatabaseBoolean(
    row.witness_present,
    'proof witness marker',
  )
  const dleqPresent = decodeDatabaseBoolean(
    row.dleq_present,
    'proof DLEQ marker',
  )
  assertOptionalPayloadPresence(
    witnessPresent,
    row.witness_json,
    'proof witness',
  )
  assertOptionalPayloadPresence(dleqPresent, row.dleq_json, 'proof DLEQ')
  assertAllNullOrPresent(
    [row.proof_condition_id, row.proof_outcome_collection],
    'proof condition metadata',
  )
  const assetKind = requireText(row.asset_kind, 'proof asset kind')
  if (assetKind !== 'sats' && assetKind !== 'Outcome') {
    throw new Error('proof asset kind row is invalid')
  }
  const assetMetadataPresent =
    row.asset_condition_id !== null && row.asset_outcome_set_id !== null
  if (
    (assetKind === 'sats' &&
      (row.asset_condition_id !== null || row.asset_outcome_set_id !== null)) ||
    (assetKind === 'Outcome' && !assetMetadataPresent)
  ) {
    throw new Error('proof asset metadata row is invalid')
  }
  const proofState = requireText(row.state, 'proof state')
  if (
    proofState !== 'available' &&
    proofState !== 'reserved' &&
    proofState !== 'locked'
  ) {
    throw new Error('proof state row is invalid')
  }
  if (
    (proofState === 'available' && row.reserved_by !== null) ||
    ((proofState === 'reserved' || proofState === 'locked') &&
      row.reserved_by === null)
  ) {
    throw new Error('proof reservation row is invalid')
  }
  const keysetId = requireText(row.keyset_id, 'proof keyset id')
  const baseAsset = requireText(row.base_asset, 'proof base asset')
  const unit = parseCashuProofUnit(
    typeof row.unit === 'string' ? row.unit : undefined,
  )
  if (unit === null || !isCollateralUnitOf(unit, baseAsset)) {
    throw new Error('proof unit row is invalid')
  }
  const proofId = requireProofId(row.proof_id)
  const expectedProofId = deriveDurableCustodyProofId({
    normalizedMint: requireText(row.mint_url, 'proof mint URL'),
    unit,
    keysetId,
    secret: requireText(row.proof_secret, 'proof secret'),
  })
  if (proofId !== expectedProofId) {
    throw new Error('proof identity row is invalid')
  }
  const proof: Record<string, unknown> = {
    amount: row.amount,
    secret: row.proof_secret,
    C: row.signature,
    id: keysetId,
    ...(witnessPresent
      ? { witness: decodeArtifact(row.witness_json, 'proof witness') }
      : {}),
    ...(dleqPresent
      ? { dleq: decodeArtifact(row.dleq_json, 'proof DLEQ') }
      : {}),
    ...(row.proof_condition_id === null
      ? {}
      : { conditionId: row.proof_condition_id }),
    ...(row.proof_outcome_collection === null
      ? {}
      : { outcomeCollection: row.proof_outcome_collection }),
  }
  const asset =
    assetKind === 'Outcome'
      ? {
          kind: 'Outcome' as const,
          conditionId: row.asset_condition_id,
          outcomeSetId: row.asset_outcome_set_id,
          baseAsset,
        }
      : {
          kind: 'sats' as const,
          baseAsset,
        }
  return {
    proof: proof as unknown as CashuProofRecord,
    mintUrl: row.mint_url as string,
    unit,
    state: proofState as StoredProofRecord['state'],
    asset: asset as StoredProofRecord['asset'],
    ...(row.reserved_by === null
      ? {}
      : { reservedBy: row.reserved_by as string }),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function decodeExpectedOperationRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operationId: row.operation_id,
    operationKey: row.operation_key,
    stage: row.stage,
    ...(row.kind === null ? {} : { kind: row.kind }),
  }
}

function decodePlannedOperationRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operationId: row.operation_id,
    operationKey: row.operation_key,
    kind: row.kind,
    stage: row.stage,
    dependsOnOperationId: row.depends_on_operation_id,
    context: {
      contextVersion: row.context_version,
      tradeId: row.trade_id,
      role: row.context_role,
      localProtocolPubkey: row.local_protocol_pubkey,
      counterpartyProtocolPubkey: row.counterparty_protocol_pubkey,
      mintUrl: row.mint_url,
      sellerLocktimeSecs: row.seller_locktime_secs,
      buyerLocktimeSecs: row.buyer_locktime_secs,
      conditionId: row.condition_id,
      ammScopeId: row.amm_scope_id,
      inventoryAccountId: row.inventory_account_id,
      baseAsset: row.base_asset,
      unit: row.unit,
      outcomeSetCommitment: row.outcome_set_commitment,
      keysetCommitment: row.keyset_commitment,
      feeCommitment: row.fee_commitment,
      mergeInputCommitment: row.merge_input_commitment,
      expectedOutputCommitment: row.expected_output_commitment,
      mergeOperationKey: row.merge_operation_key,
      lockOperationKey: row.lock_operation_key,
    },
  }
}

function decodeProofLinkRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return decodeProofLinkColumns({
    durable_operation_id: row.operation_id,
    durable_operation_key: row.operation_key,
    durable_kind: row.kind,
    durable_trade_id: row.trade_id,
    durable_role: row.role,
    durable_stage: row.stage,
    durable_state: row.state,
  })
}

function decodeProofLinkColumns(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operationId: row.durable_operation_id,
    ...(row.durable_operation_key === null
      ? {}
      : { operationKey: row.durable_operation_key }),
    ...(row.durable_kind === null ? {} : { kind: row.durable_kind }),
    tradeId: row.durable_trade_id,
    role: row.durable_role,
    stage: row.durable_stage,
    state: row.durable_state,
  }
}

function decodeOrderRow(
  row: Record<string, unknown>,
  tradeIds: unknown[],
): LocalOrderRecord {
  assertAllNullOrPresent(
    [
      row.preflight_reservation_id,
      row.preflight_condition_id,
      row.preflight_keep_outcome_set_id,
      row.preflight_lock_outcome_set_id,
      row.preflight_amount_sats,
    ],
    'order preflight split',
  )
  const hasEngineStatus = decodeDatabaseBoolean(
    row.engine_status_present,
    'engine status marker',
  )
  assertOptionalPayloadPresence(
    hasEngineStatus,
    row.engine_status_json,
    'order engine status',
  )
  const preflight =
    row.preflight_reservation_id === null
      ? undefined
      : {
          reservationId: row.preflight_reservation_id,
          conditionId: row.preflight_condition_id,
          keepOutcomeSetId: row.preflight_keep_outcome_set_id,
          lockOutcomeSetId: row.preflight_lock_outcome_set_id,
          amountSats: row.preflight_amount_sats,
        }
  return {
    orderId: row.order_id,
    marketId: row.market_id,
    ...(row.token_side === null ? {} : { tokenSide: row.token_side }),
    ...(row.side === null ? {} : { side: row.side }),
    ...(row.price_subunits === null
      ? {}
      : { priceSubunits: row.price_subunits }),
    ...(row.amount_subunits === null
      ? {}
      : { amountSubunits: row.amount_subunits }),
    ...(row.time_in_force === null ? {} : { timeInForce: row.time_in_force }),
    ...(row.recovery_attempt === null
      ? {}
      : { recoveryAttempt: row.recovery_attempt }),
    status: row.status,
    ...(row.ephemeral_pubkey === null
      ? {}
      : { ephemeralPubkey: row.ephemeral_pubkey }),
    ...(row.client_order_id === null
      ? {}
      : { clientOrderId: row.client_order_id }),
    ...(preflight === undefined ? {} : { preflightSplit: preflight }),
    ...(row.base_asset === null ? {} : { baseAsset: row.base_asset }),
    ...(row.divisibility === null ? {} : { divisibility: row.divisibility }),
    tradeIds,
    ...(hasEngineStatus
      ? {
          engineStatus: decodeArtifact(
            row.engine_status_json,
            'order engine status',
          ),
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as LocalOrderRecord
}

function decodeSwapRow(row: Record<string, unknown>): LocalSwapRecord {
  assertAllNullOrPresent(
    [
      row.buyer_pre_sigs_json,
      row.buyer_locked_proofs_json,
      row.seller_pre_sigs_json,
    ],
    'buyer recovery artifacts',
  )
  assertAllNullOrPresent(
    [row.seller_adaptor_secret_hex, row.seller_adaptor_point_hex],
    'seller adaptor material',
  )
  assertTakerRecoveryColumns(row)
  const optional = (
    column: string,
    property: string,
  ): Record<string, unknown> =>
    row[column] === null ? {} : { [property]: row[column] }
  const taker =
    row.taker_client_order_id === null
      ? undefined
      : {
          clientOrderId: row.taker_client_order_id,
          status: row.taker_recovery_status,
          ...(row.taker_replacement_order_id === null
            ? {}
            : { replacementOrderId: row.taker_replacement_order_id }),
        }
  return {
    tradeId: row.trade_id,
    ...optional('market_id', 'marketId'),
    ...optional('order_id', 'orderId'),
    ...optional('role', 'role'),
    ...optional('counterparty_pubkey', 'counterpartyPubkey'),
    ...optional('seller_locktime', 'sellerLocktime'),
    ...optional('buyer_locktime', 'buyerLocktime'),
    ...optional('fill_amount_sats', 'fillAmountSats'),
    ...optional('fill_amount_subunits', 'fillAmountSubunits'),
    ...optional('outcome_face_amount_sats', 'outcomeFaceAmountSats'),
    ...optional('outcome_face_amount_subunits', 'outcomeFaceAmountSubunits'),
    ...optional('quote_payment_sats', 'quotePaymentSats'),
    ...optional('base_asset', 'baseAsset'),
    ...optional('divisibility', 'divisibility'),
    ...optional('quote_payment_subunits', 'quotePaymentSubunits'),
    ...optional('settlement_kind', 'settlementKind'),
    ...optional('seller_keep_outcome_set_id', 'sellerKeepOutcomeSetId'),
    ...optional('seller_lock_outcome_set_id', 'sellerLockOutcomeSetId'),
    ...(row.is_taker === null
      ? {}
      : {
          isTaker: decodeDatabaseBoolean(
            row.is_taker,
            'local swap taker marker',
          ),
        }),
    messages: {
      ...optional('adaptor_point_cipher', 'adaptorPoint'),
      ...optional('locked_proofs_seller_cipher', 'lockedProofsSeller'),
      ...optional('locked_proofs_buyer_cipher', 'lockedProofsBuyer'),
    },
    ...optional('seller_adaptor_secret_hex', 'sellerAdaptorSecretHex'),
    ...optional('seller_adaptor_point_hex', 'sellerAdaptorPointHex'),
    ...(row.buyer_pre_sigs_json === null
      ? {}
      : {
          buyerPreSigsHex: decodeArtifact(
            row.buyer_pre_sigs_json,
            'buyer pre-signatures',
          ),
        }),
    ...(row.buyer_locked_proofs_json === null
      ? {}
      : {
          buyerLockedProofs: decodeArtifact(
            row.buyer_locked_proofs_json,
            'buyer locked proofs',
          ),
        }),
    ...(row.seller_pre_sigs_json === null
      ? {}
      : {
          sellerPreSigsHex: decodeArtifact(
            row.seller_pre_sigs_json,
            'seller pre-signatures',
          ),
        }),
    ...optional('engine_state', 'engineState'),
    ...optional('failure_reason', 'failureReason'),
    ...(taker === undefined ? {} : { takerRecovery: taker }),
    step: row.step,
    ...optional('error', 'error'),
    ...(row.failure_json === null
      ? {}
      : { failure: decodeArtifact(row.failure_json, 'swap failure') }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as LocalSwapRecord
}

function encodeArtifact(value: unknown, name: string): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error(`${name} is not serializable`)
  if (Buffer.byteLength(encoded, 'utf8') > OPAQUE_ARTIFACT_MAX_BYTES) {
    throw new Error(`${name} exceeds the SQLite artifact limit`)
  }
  return encoded
}

function decodeArtifact(value: unknown, name: string): unknown {
  if (typeof value !== 'string') throw new Error(`${name} row is invalid`)
  if (Buffer.byteLength(value, 'utf8') > OPAQUE_ARTIFACT_MAX_BYTES) {
    throw new Error(`${name} exceeds the SQLite artifact limit`)
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${name} row is corrupt`)
  }
}

function decodeDatabaseBoolean(value: unknown, name: string): boolean {
  if (value === 0) return false
  if (value === 1) return true
  throw new Error(`${name} row is invalid`)
}

function assertOptionalPayloadPresence(
  present: boolean,
  payload: unknown,
  name: string,
): void {
  if (present !== (payload !== null)) {
    throw new Error(`${name} presence row is invalid`)
  }
}

function assertAllNullOrPresent(values: unknown[], name: string): void {
  const present = values.filter((value) => value !== null).length
  if (present !== 0 && present !== values.length) {
    throw new Error(`${name} row is incomplete`)
  }
}

function assertTakerRecoveryColumns(row: Record<string, unknown>): void {
  const clientOrderId = row.taker_client_order_id
  const status = row.taker_recovery_status
  const replacementOrderId = row.taker_replacement_order_id
  const absent =
    clientOrderId === null && status === null && replacementOrderId === null
  const pending =
    clientOrderId !== null &&
    status === 'pending' &&
    replacementOrderId === null
  const submitted =
    clientOrderId !== null &&
    status === 'submitted' &&
    replacementOrderId !== null
  if (!absent && !pending && !submitted) {
    throw new Error('taker recovery row is invalid')
  }
}

function assertDurableProofLinkColumns(row: Record<string, unknown>): void {
  const columns = [
    row.durable_trade_id,
    row.durable_operation_id,
    row.durable_operation_key,
    row.durable_kind,
    row.durable_role,
    row.durable_stage,
    row.durable_state,
  ]
  if (row.durable_trade_id === null) {
    if (columns.some((value) => value !== null)) {
      throw new Error('durable proof operation row is incomplete')
    }
    return
  }
  for (const value of [
    row.durable_operation_id,
    row.durable_operation_key,
    row.durable_role,
    row.durable_stage,
    row.durable_state,
  ]) {
    if (value === null)
      throw new Error('durable proof operation row is incomplete')
  }
}

function validateIdPageInput(input: DaemonIdPageInput): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > DAEMON_ID_PAGE_LIMIT_MAX
  ) {
    throw new Error('daemon SQLite page limit is invalid')
  }
  if (
    input.cursor !== null &&
    (typeof input.cursor !== 'string' || input.cursor.length === 0)
  ) {
    throw new Error('daemon SQLite page cursor is invalid')
  }
}

function idPageFromRows(
  rows: Array<Record<string, unknown>>,
  limit: number,
  name: string,
  column = 'trade_id',
): DaemonIdPage {
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  const ids = pageRows.map((row) => requireText(row[column], name))
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]!.localeCompare(ids[index]!) >= 0) {
      throw new Error(`${name} page is not strictly ordered`)
    }
  }
  return {
    ids,
    nextCursor: hasMore && ids.length > 0 ? ids[ids.length - 1]! : null,
  }
}

function requireWalletProofState(value: unknown): StoredProofRecord['state'] {
  switch (value) {
    case 'available':
    case 'reserved':
    case 'locked':
      return value
    default:
      throw new Error('wallet balance proof state is corrupt')
  }
}

function addBalanceAmount(
  row: {
    availableSats: number
    reservedSats: number
    lockedSats: number
  },
  state: StoredProofRecord['state'],
  amount: number,
): void {
  switch (state) {
    case 'available':
      row.availableSats += amount
      return
    case 'reserved':
      row.reservedSats += amount
      return
    case 'locked':
      row.lockedSats += amount
      return
  }
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} row is invalid`)
  }
  return value
}

function requireProofId(value: unknown): string {
  const proofId = requireText(value, 'proof id')
  if (!/^[0-9a-f]{64}$/.test(proofId)) {
    throw new Error('proof id row is invalid')
  }
  return proofId
}

export function deriveDaemonWalletProofId(record: StoredProofRecord): string {
  return deriveDaemonWalletProofIdFromProof(
    record.mintUrl,
    record.unit,
    record.proof,
  )
}

export function deriveDaemonWalletProofIdFromProof(
  mintUrl: string,
  unitInput: string | null | undefined,
  proof: Pick<CashuProofRecord, 'id' | 'secret'>,
): string {
  if (!proof.id) throw new Error('stored proof keyset id is required')
  const unit = parseCashuProofUnit(unitInput)
  if (unit === null) throw new Error('stored proof unit is invalid')
  return deriveDurableCustodyProofId({
    normalizedMint: mintUrl,
    unit,
    keysetId: proof.id,
    secret: proof.secret,
  })
}

function requireNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} row is invalid`)
  }
  return value
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== undefined
  )
}
