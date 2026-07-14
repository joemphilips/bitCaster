import type { DatabaseSync } from 'node:sqlite'
import type {
  DaemonHistoryPage,
  ListLocalOrdersParams,
  ListLocalSwapsParams,
  ListProofOperationsParams,
  LocalOrderSummary,
  LocalSwapSummary,
  ProofOperationSummary,
} from './state.ts'
import {
  DAEMON_PROOF_OPERATION_GROUP_LABEL_BYTES_MAX,
  DAEMON_PROOF_OPERATION_GROUP_LIMIT_MAX,
  DAEMON_PROOF_OPERATION_GROUP_PROOF_COUNT_MAX,
  DAEMON_PROOF_OPERATION_INPUT_LIMIT_MAX,
} from './stateSqlite.ts'
import {
  DAEMON_PROOF_OPERATION_KINDS,
  DAEMON_PROOF_OPERATION_STATES,
  DAEMON_SWAP_STEPS,
} from './daemonStateValues.ts'

const DAEMON_HISTORY_PAGE_LIMIT_DEFAULT = 100
const DAEMON_HISTORY_PAGE_LIMIT_MAX = 100
const HISTORY_ID_BYTES_MAX = 512
const HISTORY_CURSOR_CHARS_MAX = 8 * 1_024
const HISTORY_STATUS_BYTES_MAX = 256
const HISTORY_URL_BYTES_MAX = 2_048
const LOCAL_SWAP_SUMMARY_COLUMNS = `trade_id AS id, market_id, order_id, role,
  step, is_taker, taker_recovery_status, taker_replacement_order_id,
  created_at, updated_at`

// Filters apply to one bounded global scan window. An empty items array with a
// continuation cursor is expected and avoids multiplying hot-write indexes for
// every optional CLI filter combination.

export function readLocalOrderHistoryPage(
  database: DatabaseSync,
  params: ListLocalOrdersParams,
): DaemonHistoryPage<LocalOrderSummary> {
  validateOrderHistoryParams(params)
  const page = readStringHistoryWindow(
    database,
    'order',
    params.cursor,
    params.limit,
    'order_id',
    `SELECT order_id AS id, market_id, token_side, side, price_subunits,
            amount_subunits, time_in_force, recovery_attempt, status,
            ephemeral_pubkey, client_order_id, base_asset, divisibility,
            created_at, updated_at
       FROM daemon_orders INDEXED BY daemon_orders_history_idx`,
  )
  return {
    items: page.rows
      .filter(
        (row) =>
          params.marketId === undefined || row.market_id === params.marketId,
      )
      .filter(
        (row) => params.status === undefined || row.status === params.status,
      )
      .map(decodeOrderSummary),
    nextCursor: page.nextCursor,
  }
}

export function readLocalSwapHistoryPage(
  database: DatabaseSync,
  params: ListLocalSwapsParams,
): DaemonHistoryPage<LocalSwapSummary> {
  validateSwapHistoryParams(params)
  const page = readStringHistoryWindow(
    database,
    'swap',
    params.cursor,
    params.limit,
    'trade_id',
    `SELECT ${LOCAL_SWAP_SUMMARY_COLUMNS}
       FROM daemon_swaps INDEXED BY daemon_swaps_history_idx`,
  )
  return {
    items: page.rows
      .filter(
        (row) =>
          params.marketId === undefined || row.market_id === params.marketId,
      )
      .filter(
        (row) =>
          params.orderId === undefined || row.order_id === params.orderId,
      )
      .filter((row) => params.step === undefined || row.step === params.step)
      .map(decodeSwapSummary),
    nextCursor: page.nextCursor,
  }
}

export function readLocalSwapHistoryItem(
  database: DatabaseSync,
  tradeId: unknown,
): LocalSwapSummary | null {
  const id = requireHistoryText(
    tradeId,
    'swap history id',
    HISTORY_ID_BYTES_MAX,
  )
  const row = database
    .prepare(
      `SELECT ${LOCAL_SWAP_SUMMARY_COLUMNS}
       FROM daemon_swaps
      WHERE trade_id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined
  return row === undefined ? null : decodeSwapSummary(row)
}

export function readProofOperationHistoryPage(
  database: DatabaseSync,
  params: ListProofOperationsParams,
): DaemonHistoryPage<ProofOperationSummary> {
  validateProofOperationHistoryParams(params)
  const limit = historyLimit(params.limit)
  const cursor = decodeHistoryCursor(params.cursor, 'proof-operation', 'number')
  const rows = selectProofOperationHistoryRows(database, cursor, limit)
  const page = buildHistoryWindow(rows, limit, 'proof-operation')
  return {
    items: page.rows
      .filter((row) => params.kind === undefined || row.kind === params.kind)
      .filter((row) => params.state === undefined || row.state === params.state)
      .map(decodeProofOperationSummary),
    nextCursor: page.nextCursor,
  }
}

function selectProofOperationHistoryRows(
  database: DatabaseSync,
  cursor: HistoryCursor | null,
  limit: number,
): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT operation_id AS id, kind, state, mint_url,
            input_count, input_amount_sats,
            COALESCE((
              SELECT json_group_object(group_label, proof_count)
                FROM daemon_proof_operation_group_counts AS counts
               WHERE counts.operation_id = daemon_proof_operations.operation_id
                 AND group_kind = 'planned-output'
            ), '{}') AS output_counts_json,
            COALESCE((
              SELECT json_group_object(group_label, proof_count)
                FROM daemon_proof_operation_group_counts AS counts
               WHERE counts.operation_id = daemon_proof_operations.operation_id
                 AND group_kind = 'result-proof'
            ), '{}') AS result_counts_json,
            created_at, updated_at
       FROM daemon_proof_operations
            INDEXED BY daemon_proof_operations_history_idx
      ${cursor === null ? '' : 'WHERE (updated_at, operation_id) < (?, ?)'}
      ORDER BY updated_at DESC, operation_id DESC
      LIMIT ?`,
    )
    .all(...historyParameters(cursor, limit)) as Record<string, unknown>[]
}

function readStringHistoryWindow(
  database: DatabaseSync,
  kind: 'order' | 'swap',
  cursorInput: string | undefined,
  limitInput: number | undefined,
  idColumn: 'order_id' | 'trade_id',
  selectSql: string,
): { rows: Record<string, unknown>[]; nextCursor: string | null } {
  const limit = historyLimit(limitInput)
  const cursor = decodeHistoryCursor(cursorInput, kind, 'string')
  const rows = database
    .prepare(
      `${selectSql}
      ${cursor === null ? '' : `WHERE (updated_at, ${idColumn}) < (?, ?)`}
      ORDER BY updated_at DESC, ${idColumn} DESC
      LIMIT ?`,
    )
    .all(...historyParameters(cursor, limit)) as Record<string, unknown>[]
  return buildHistoryWindow(rows, limit, kind)
}

type HistoryKind = 'order' | 'swap' | 'proof-operation'

function buildHistoryWindow(
  rows: Record<string, unknown>[],
  limit: number,
  kind: HistoryKind,
): { rows: Record<string, unknown>[]; nextCursor: string | null } {
  const window = rows.slice(0, limit)
  if (rows.length <= limit) return { rows: window, nextCursor: null }
  const last = window.at(-1)
  const sort =
    kind === 'proof-operation'
      ? requireNonNegativeInteger(last?.updated_at, `${kind} history timestamp`)
      : requireTimestamp(last?.updated_at, `${kind} history timestamp`)
  return {
    rows: window,
    nextCursor: encodeHistoryCursor(
      kind,
      sort,
      requireHistoryText(last?.id, `${kind} history id`, HISTORY_ID_BYTES_MAX),
    ),
  }
}

interface HistoryCursor {
  sort: string | number
  id: string
}

function historyParameters(
  cursor: HistoryCursor | null,
  limit: number,
): Array<string | number> {
  return cursor === null ? [limit + 1] : [cursor.sort, cursor.id, limit + 1]
}

function encodeHistoryCursor(
  kind: HistoryKind,
  sort: string | number,
  id: string,
): string {
  const cursor = Buffer.from(
    JSON.stringify({ version: 1, kind, sort, id }),
  ).toString(
    'base64url',
  )
  if (cursor.length > HISTORY_CURSOR_CHARS_MAX) {
    throw new Error(`${kind} history cursor exceeds its encoded limit`)
  }
  return cursor
}

function decodeHistoryCursor(
  input: unknown,
  expectedKind: HistoryKind,
  sortType: 'string' | 'number',
): HistoryCursor | null {
  if (input === undefined) return null
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > HISTORY_CURSOR_CHARS_MAX ||
    !/^[A-Za-z0-9_-]+$/.test(input) ||
    Buffer.from(input, 'base64url').toString('base64url') !== input
  ) {
    throw new Error(`${expectedKind} history cursor is invalid`)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'))
  } catch {
    throw new Error(`${expectedKind} history cursor is invalid`)
  }
  if (!isRecord(value))
    throw new Error(`${expectedKind} history cursor is invalid`)
  if (
    value.version !== 1 ||
    value.kind !== expectedKind ||
    typeof value.sort !== sortType ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    Buffer.byteLength(value.id, 'utf8') > HISTORY_ID_BYTES_MAX ||
    Object.keys(value).some(
      (key) => !['version', 'kind', 'sort', 'id'].includes(key),
    )
  ) {
    throw new Error(`${expectedKind} history cursor is invalid`)
  }
  if (
    sortType === 'number' &&
    (!Number.isSafeInteger(value.sort) || (value.sort as number) < 0)
  ) {
    throw new Error(`${expectedKind} history cursor is invalid`)
  }
  if (sortType === 'string')
    requireTimestamp(value.sort, `${expectedKind} cursor`)
  return { sort: value.sort as string | number, id: value.id }
}

function historyLimit(value: number | undefined): number {
  const limit = value ?? DAEMON_HISTORY_PAGE_LIMIT_DEFAULT
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DAEMON_HISTORY_PAGE_LIMIT_MAX
  ) {
    throw new Error('daemon history page limit is invalid')
  }
  return limit
}

function decodeOrderSummary(row: Record<string, unknown>): LocalOrderSummary {
  return {
    orderId: requireHistoryText(
      row.id,
      'order history id',
      HISTORY_ID_BYTES_MAX,
    ),
    marketId: requireHistoryText(
      row.market_id,
      'order history market id',
      HISTORY_ID_BYTES_MAX,
    ),
    status: requireHistoryText(
      row.status,
      'order history status',
      HISTORY_STATUS_BYTES_MAX,
    ),
    ...optionalEnum(row.token_side, ['Outcome', 'Complement'], 'tokenSide'),
    ...optionalEnum(row.side, ['Buy', 'Sell'], 'side'),
    ...optionalInteger(row.price_subunits, 'priceSubunits'),
    ...optionalInteger(row.amount_subunits, 'amountSubunits'),
    ...optionalEnum(row.time_in_force, ['FAK', 'FOK', 'GTC'], 'timeInForce'),
    ...optionalInteger(row.recovery_attempt, 'recoveryAttempt'),
    ...optionalText(
      row.ephemeral_pubkey,
      'ephemeralPubkey',
      HISTORY_STATUS_BYTES_MAX,
    ),
    ...optionalText(row.client_order_id, 'clientOrderId'),
    ...(row.base_asset === null
      ? {}
      : {
          baseAsset: requireHistoryText(
            row.base_asset,
            'base asset',
            HISTORY_STATUS_BYTES_MAX,
          ),
        }),
    ...optionalInteger(row.divisibility, 'divisibility'),
    createdAt: requireTimestamp(
      row.created_at,
      'order history created timestamp',
    ),
    updatedAt: requireTimestamp(
      row.updated_at,
      'order history updated timestamp',
    ),
  }
}

function decodeSwapSummary(row: Record<string, unknown>): LocalSwapSummary {
  return {
    tradeId: requireHistoryText(
      row.id,
      'swap history id',
      HISTORY_ID_BYTES_MAX,
    ),
    ...optionalText(row.market_id, 'marketId'),
    ...optionalText(row.order_id, 'orderId'),
    ...optionalEnum(row.role, ['seller', 'buyer'], 'role'),
    step: requireEnum(row.step, DAEMON_SWAP_STEPS, 'swap history step'),
    ...(row.is_taker === null
      ? {}
      : { isTaker: requireBoolean(row.is_taker, 'swap taker marker') }),
    ...optionalEnum(
      row.taker_recovery_status,
      ['pending', 'submitted'],
      'takerRecoveryStatus',
    ),
    ...optionalText(row.taker_replacement_order_id, 'takerReplacementOrderId'),
    createdAt: requireTimestamp(
      row.created_at,
      'swap history created timestamp',
    ),
    updatedAt: requireTimestamp(
      row.updated_at,
      'swap history updated timestamp',
    ),
  }
}

function decodeProofOperationSummary(
  row: Record<string, unknown>,
): ProofOperationSummary {
  return {
    operationId: requireHistoryText(
      row.id,
      'proof operation history id',
      HISTORY_ID_BYTES_MAX,
    ),
    kind: requireEnum(
      row.kind,
      DAEMON_PROOF_OPERATION_KINDS,
      'proof operation kind',
    ),
    state: requireEnum(
      row.state,
      DAEMON_PROOF_OPERATION_STATES,
      'proof operation state',
    ),
    mintUrl: requireHistoryText(
      row.mint_url,
      'proof operation mint URL',
      HISTORY_URL_BYTES_MAX,
    ),
    inputAmountSats: requireNonNegativeInteger(
      row.input_amount_sats,
      'input amount',
    ),
    inputCount: requireBoundedInteger(
      row.input_count,
      'input count',
      DAEMON_PROOF_OPERATION_INPUT_LIMIT_MAX,
    ),
    outputCounts: decodeCountRecord(row.output_counts_json, 'output counts'),
    resultProofCounts: decodeCountRecord(
      row.result_counts_json,
      'result counts',
    ),
    createdAt: requireNonNegativeInteger(
      row.created_at,
      'operation created time',
    ),
    updatedAt: requireNonNegativeInteger(
      row.updated_at,
      'operation updated time',
    ),
  }
}

function decodeCountRecord(
  value: unknown,
  label: string,
): Record<string, number> {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} is invalid`)
  }
  if (!isRecord(parsed)) throw new Error(`${label} is invalid`)
  const entries = Object.entries(parsed)
  if (entries.length > DAEMON_PROOF_OPERATION_GROUP_LIMIT_MAX) {
    throw new Error(`${label} is invalid`)
  }
  return Object.fromEntries(
    entries.map(([key, count]) => {
      if (
        key.length === 0 ||
        Buffer.byteLength(key, 'utf8') >
          DAEMON_PROOF_OPERATION_GROUP_LABEL_BYTES_MAX
      ) {
        throw new Error(`${label} is invalid`)
      }
      return [
        key,
        requireBoundedInteger(
          count,
          label,
          DAEMON_PROOF_OPERATION_GROUP_PROOF_COUNT_MAX,
        ),
      ]
    }),
  )
}

function validateOrderHistoryParams(params: ListLocalOrdersParams): void {
  requireHistoryFields(params, ['marketId', 'status', 'cursor', 'limit'])
  requireOptionalHistoryText(
    params.marketId,
    'order market filter',
    HISTORY_ID_BYTES_MAX,
  )
  requireOptionalHistoryText(
    params.status,
    'order status filter',
    HISTORY_STATUS_BYTES_MAX,
  )
}

function validateSwapHistoryParams(params: ListLocalSwapsParams): void {
  requireHistoryFields(params, [
    'marketId',
    'orderId',
    'step',
    'cursor',
    'limit',
  ])
  requireOptionalHistoryText(
    params.marketId,
    'swap market filter',
    HISTORY_ID_BYTES_MAX,
  )
  requireOptionalHistoryText(
    params.orderId,
    'swap order filter',
    HISTORY_ID_BYTES_MAX,
  )
  requireOptionalHistoryEnum(params.step, DAEMON_SWAP_STEPS, 'swap step filter')
}

function validateProofOperationHistoryParams(
  params: ListProofOperationsParams,
): void {
  requireHistoryFields(params, ['kind', 'state', 'cursor', 'limit'])
  requireOptionalHistoryEnum(
    params.kind,
    DAEMON_PROOF_OPERATION_KINDS,
    'proof operation kind filter',
  )
  requireOptionalHistoryEnum(
    params.state,
    DAEMON_PROOF_OPERATION_STATES,
    'proof operation state filter',
  )
}

function requireHistoryFields(
  params: object,
  allowed: readonly string[],
): void {
  if (!isRecord(params))
    throw new Error('daemon history parameters are invalid')
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new Error('daemon history parameters are invalid')
  }
}

function requireOptionalHistoryText(
  value: unknown,
  label: string,
  bytesMax: number,
): void {
  if (value === undefined) return
  requireHistoryText(value, label, bytesMax)
}

function requireHistoryText(
  value: unknown,
  label: string,
  bytesMax: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > bytesMax
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireOptionalHistoryEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): void {
  if (value === undefined) return
  requireEnum(value, allowed, label)
}

function optionalText(
  value: unknown,
  key: string,
  bytesMax = HISTORY_ID_BYTES_MAX,
): Record<string, string> {
  return value === null
    ? {}
    : { [key]: requireHistoryText(value, key, bytesMax) }
}

function optionalInteger(value: unknown, key: string): Record<string, number> {
  return value === null ? {} : { [key]: requireNonNegativeInteger(value, key) }
}

function optionalEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): Record<string, T> {
  if (value === null) return {}
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${key} is invalid`)
  }
  return { [key]: value as T }
}

function requireEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`)
  }
  return value as T
}

function requireBoolean(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`${label} is invalid`)
  return value === 1
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireText(value, label)
  const milliseconds = Date.parse(timestamp)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    throw new Error(`${label} is invalid`)
  }
  return timestamp
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireBoundedInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const decoded = requireNonNegativeInteger(value, label)
  if (decoded > maximum) throw new Error(`${label} is invalid`)
  return decoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
