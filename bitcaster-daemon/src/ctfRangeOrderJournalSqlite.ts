import type { DatabaseSync } from 'node:sqlite'
import {
  decodeCanonicalMintOrigin,
  encodeBoundedDurableArtifact,
} from '@bitcaster-market/client-sdk'

export const CTF_RANGE_PREPARATION_BYTES_MAX = 256 * 1_024
const ID_BYTES_MAX = 16_384
const PAGE_LIMIT_MAX = 256
const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type RangePreparationLifecycle =
  | 'prepared'
  | 'capability-bound'
  | 'order-submitted'
  | 'submission-rejected'
  | 'terminal'

export interface RangePreparationCapability {
  readonly artifactId: string
  readonly bindingDigest: string
  readonly artifactDigest: string
  readonly orderId: string
}

export interface InsertRangePreparation {
  readonly scopeId: string
  readonly rangeOperationId: string
  readonly sourceOperationId: string
  readonly sourceKind: 'wallet-prepared' | 'residual-change'
  readonly predecessorRangeOperationId: string | null
  readonly authorizationId: string
  readonly clientOrderId: string
  readonly marketId: string
  readonly normalizedMint: string
  readonly conditionId: string
  readonly unit: 'msat'
  readonly tokenSide: 'Outcome' | 'Complement'
  readonly side: 'Buy' | 'Sell'
  readonly priceSubunits: number
  readonly amountSubunits: number
  readonly divisibility: 10_000 | 1_000_000
  readonly authorizationExpiresAtUnixSeconds: number
  readonly preparationBytes: Uint8Array
  readonly createdAtMs: number
}

export interface RangePreparationRecord extends InsertRangePreparation {
  readonly lifecycleState: RangePreparationLifecycle
  readonly revision: number
  readonly capability: RangePreparationCapability | null
  readonly updatedAtMs: number
}

export interface RangePreparationPageCursor {
  readonly updatedAtMs: number
  readonly rangeOperationId: string
}

export interface RangePreparationPage {
  readonly preparations: readonly RangePreparationRecord[]
  readonly nextCursor: RangePreparationPageCursor | null
}

export interface RangePreparationSourceLink {
  readonly scopeId: string
  readonly rangeOperationId: string
  readonly sourceOperationId: string
  readonly reservationId: string
}

export interface RangePreparationConsolidationLink {
  readonly scopeId: string
  readonly rangeOperationId: string
  readonly round: number
  readonly operationId: string
  readonly reservationId: string
}

export interface RangePreparationOperationLinks {
  readonly source: RangePreparationSourceLink | null
  readonly consolidations: readonly RangePreparationConsolidationLink[]
}

export function encodeCanonicalRangePreparation(value: unknown): Uint8Array {
  let unaliased: unknown
  try {
    unaliased = JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error('daemon CTF range preparation is not JSON serializable')
  }
  return encodeBoundedDurableArtifact(unaliased, CTF_RANGE_PREPARATION_BYTES_MAX)
}

export function decodeCanonicalRangePreparation(bytes: Uint8Array): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > CTF_RANGE_PREPARATION_BYTES_MAX
  ) {
    throw new Error('daemon CTF range preparation bytes exceed their bound')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('daemon CTF range preparation bytes are not canonical JSON')
  }
  if (!sameBytes(bytes, encodeCanonicalRangePreparation(parsed))) {
    throw new Error('daemon CTF range preparation bytes are not canonical')
  }
  return parsed
}

export function insertRangePreparation(
  database: DatabaseSync,
  input: InsertRangePreparation,
): RangePreparationRecord {
  validateInsert(input)
  database
    .prepare(
      `INSERT INTO daemon_ctf_range_preparations (
         scope_id, range_operation_id, source_operation_id, source_kind,
         predecessor_range_operation_id, authorization_id,
         client_order_id, market_id, normalized_mint, condition_id, unit,
         token_side, side, price_subunits, amount_subunits, divisibility,
         authorization_expires_at_unix_seconds, preparation_body, lifecycle_state, revision,
         capability_artifact_id, capability_binding_digest, capability_artifact_digest,
         engine_order_id, created_at_ms, updated_at_ms
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'msat', ?, ?, ?, ?, ?, ?, ?, 'prepared', 0,
         NULL, NULL, NULL, NULL, ?, ?
       )
       ON CONFLICT DO NOTHING`,
    )
    .run(
      input.scopeId,
      input.rangeOperationId,
      input.sourceOperationId,
      input.sourceKind,
      input.predecessorRangeOperationId,
      input.authorizationId,
      input.clientOrderId,
      input.marketId,
      input.normalizedMint,
      input.conditionId,
      input.tokenSide,
      input.side,
      input.priceSubunits,
      input.amountSubunits,
      input.divisibility,
      input.authorizationExpiresAtUnixSeconds,
      input.preparationBytes,
      input.createdAtMs,
      input.createdAtMs,
    )
  const record = readRangePreparation(database, input.scopeId, input.rangeOperationId)
  if (record === null || !sameInsert(record, input)) {
    throw new Error('daemon CTF range preparation conflicts with its persisted authority')
  }
  return record
}

export function readRangePreparation(
  database: DatabaseSync,
  scopeId: string,
  rangeOperationId: string,
): RangePreparationRecord | null {
  requireText(scopeId, 'scope id')
  requireText(rangeOperationId, 'range operation id')
  const row = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_preparations
       WHERE scope_id = ? AND range_operation_id = ?`,
    )
    .get(scopeId, rangeOperationId) as Record<string, unknown> | undefined
  return row === undefined ? null : decodePreparationRow(row)
}

export function readActiveRangePreparationByClientOrderId(
  database: DatabaseSync,
  scopeId: string,
  clientOrderId: string,
): RangePreparationRecord | null {
  requireText(scopeId, 'scope id')
  requireText(clientOrderId, 'client order id', 1_024)
  const rows = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_preparations
       WHERE scope_id = ? AND client_order_id = ?
         AND lifecycle_state <> 'terminal'
       ORDER BY created_at_ms DESC, range_operation_id DESC
       LIMIT 2`,
    )
    .all(scopeId, clientOrderId) as Array<Record<string, unknown>>
  if (rows.length > 1) {
    throw new Error('daemon CTF range client order has overlapping active preparations')
  }
  return rows.length === 0 ? null : decodePreparationRow(rows[0]!)
}

export function bindRangePreparationCapability(
  database: DatabaseSync,
  input: {
    readonly scopeId: string
    readonly rangeOperationId: string
    readonly expectedRevision: number
    readonly capability: RangePreparationCapability
    readonly updatedAtMs: number
  },
): RangePreparationRecord {
  validateCapability(input.capability)
  requireRevision(input.expectedRevision)
  requireTimestamp(input.updatedAtMs, 'updated time')
  const current = requirePreparation(database, input.scopeId, input.rangeOperationId)
  if (
    current.lifecycleState !== 'prepared' ||
    current.revision !== input.expectedRevision ||
    input.updatedAtMs < current.updatedAtMs
  ) {
    if (current.capability !== null && sameCapability(current.capability, input.capability)) {
      return current
    }
    throw new Error('daemon CTF range preparation revision or lifecycle changed')
  }
  const result = database
    .prepare(
      `UPDATE daemon_ctf_range_preparations
       SET lifecycle_state = 'capability-bound',
           capability_artifact_id = ?, capability_binding_digest = ?,
           capability_artifact_digest = ?, engine_order_id = ?,
           revision = revision + 1, updated_at_ms = ?
       WHERE scope_id = ? AND range_operation_id = ?
         AND lifecycle_state = 'prepared' AND revision = ?`,
    )
    .run(
      input.capability.artifactId,
      input.capability.bindingDigest,
      input.capability.artifactDigest,
      input.capability.orderId,
      input.updatedAtMs,
      input.scopeId,
      input.rangeOperationId,
      input.expectedRevision,
    )
  if (result.changes !== 1) {
    throw new Error('daemon CTF range preparation revision or lifecycle changed')
  }
  return requirePreparation(database, input.scopeId, input.rangeOperationId)
}

export function transitionRangePreparation(
  database: DatabaseSync,
  input: {
    readonly scopeId: string
    readonly rangeOperationId: string
    readonly expectedRevision: number
    readonly from: RangePreparationLifecycle
    readonly to: RangePreparationLifecycle
    readonly updatedAtMs: number
  },
): RangePreparationRecord {
  requireTransition(input.from, input.to)
  requireRevision(input.expectedRevision)
  requireTimestamp(input.updatedAtMs, 'updated time')
  const current = requirePreparation(database, input.scopeId, input.rangeOperationId)
  if (input.updatedAtMs < current.updatedAtMs) {
    throw new Error('daemon CTF range preparation update time moved backward')
  }
  const result = database
    .prepare(
      `UPDATE daemon_ctf_range_preparations
       SET lifecycle_state = ?, revision = revision + 1, updated_at_ms = ?
       WHERE scope_id = ? AND range_operation_id = ?
         AND lifecycle_state = ? AND revision = ?`,
    )
    .run(
      input.to,
      input.updatedAtMs,
      input.scopeId,
      input.rangeOperationId,
      input.from,
      input.expectedRevision,
    )
  if (result.changes !== 1) {
    throw new Error('daemon CTF range preparation revision or lifecycle changed')
  }
  return requirePreparation(database, input.scopeId, input.rangeOperationId)
}

export function pageActiveRangePreparations(
  database: DatabaseSync,
  input: {
    readonly scopeId: string
    readonly limit: number
    readonly after?: RangePreparationPageCursor
  },
): RangePreparationPage {
  requireText(input.scopeId, 'scope id')
  requirePageLimit(input.limit)
  if (input.after !== undefined) validatePageCursor(input.after)
  const cursorSql =
    input.after === undefined
      ? ''
      : `AND (
           preparation.updated_at_ms > ?
           OR (
             preparation.updated_at_ms = ?
             AND preparation.range_operation_id > ?
           )
         )`
  const parameters: Array<string | number> = [input.scopeId]
  if (input.after !== undefined) {
    parameters.push(input.after.updatedAtMs, input.after.updatedAtMs, input.after.rangeOperationId)
  }
  parameters.push(input.limit + 1)
  const rows = database
    .prepare(
      `SELECT preparation.*
       FROM daemon_ctf_range_preparations AS preparation
       WHERE preparation.scope_id = ?
         AND preparation.lifecycle_state <> 'terminal'
         ${cursorSql}
       ORDER BY preparation.updated_at_ms, preparation.range_operation_id
       LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, unknown>>
  const pageRows = rows.slice(0, input.limit)
  const preparations = pageRows.map(decodePreparationRow)
  const last = pageRows.at(-1)
  return {
    preparations,
    nextCursor:
      rows.length > input.limit && last !== undefined
        ? {
            updatedAtMs: requireSafeInteger(last.updated_at_ms, 'updated time'),
            rangeOperationId: requireText(last.range_operation_id, 'range operation id'),
          }
        : null,
  }
}

export function linkRangePreparationSource(
  database: DatabaseSync,
  input: RangePreparationSourceLink,
): RangePreparationSourceLink {
  validateSourceLink(input)
  const preparation = requirePreparation(database, input.scopeId, input.rangeOperationId)
  if (preparation.sourceOperationId !== input.sourceOperationId) {
    throw new Error('daemon CTF range source differs from its preparation')
  }
  bindProofOperationReservation(
    database,
    input.scopeId,
    input.sourceOperationId,
    input.reservationId,
    SOURCE_PURPOSE,
  )
  database
    .prepare(
      `INSERT INTO daemon_ctf_range_sources (
         scope_id, range_operation_id, source_operation_id,
         reservation_id, operation_purpose
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      input.scopeId,
      input.rangeOperationId,
      input.sourceOperationId,
      input.reservationId,
      SOURCE_PURPOSE,
    )
  const persisted = readSourceLink(database, input.scopeId, input.rangeOperationId)
  if (persisted === null || !sameSourceLink(persisted, input)) {
    throw new Error('daemon CTF range source conflicts with its persisted link')
  }
  return persisted
}

export function appendRangePreparationConsolidation(
  database: DatabaseSync,
  input: RangePreparationConsolidationLink,
): RangePreparationConsolidationLink {
  validateConsolidationLink(input)
  requirePreparation(database, input.scopeId, input.rangeOperationId)
  bindProofOperationReservation(
    database,
    input.scopeId,
    input.operationId,
    input.reservationId,
    CONSOLIDATION_PURPOSE,
  )
  database
    .prepare(
      `INSERT INTO daemon_ctf_range_consolidations (
         scope_id, range_operation_id, round, operation_id,
         reservation_id, operation_purpose
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      input.scopeId,
      input.rangeOperationId,
      input.round,
      input.operationId,
      input.reservationId,
      CONSOLIDATION_PURPOSE,
    )
  const persisted = readConsolidationLink(
    database,
    input.scopeId,
    input.rangeOperationId,
    input.round,
  )
  if (persisted === null || !sameConsolidationLink(persisted, input)) {
    throw new Error('daemon CTF range consolidation conflicts with its persisted link')
  }
  return persisted
}

export function readRangePreparationOperationLinks(
  database: DatabaseSync,
  scopeId: string,
  rangeOperationId: string,
): RangePreparationOperationLinks {
  requirePreparation(database, scopeId, rangeOperationId)
  const rows = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_consolidations
       WHERE scope_id = ? AND range_operation_id = ?
       ORDER BY round`,
    )
    .all(scopeId, rangeOperationId) as Array<Record<string, unknown>>
  return {
    source: readSourceLink(database, scopeId, rangeOperationId),
    consolidations: rows.map(decodeConsolidationLink),
  }
}

function decodePreparationRow(row: Record<string, unknown>): RangePreparationRecord {
  const capability = decodeCapability(row)
  const lifecycleState = requireLifecycle(row.lifecycle_state)
  if (
    (lifecycleState === 'prepared' && capability !== null) ||
    ((lifecycleState === 'capability-bound' || lifecycleState === 'order-submitted') &&
      capability === null)
  ) {
    throw new Error('daemon CTF range preparation lifecycle authority is invalid')
  }
  const record: RangePreparationRecord = {
    scopeId: requireText(row.scope_id, 'scope id'),
    rangeOperationId: requireText(row.range_operation_id, 'range operation id'),
    sourceOperationId: requireText(row.source_operation_id, 'source operation id'),
    sourceKind: requireClosed(
      row.source_kind,
      ['wallet-prepared', 'residual-change'],
      'source kind',
    ),
    predecessorRangeOperationId:
      row.predecessor_range_operation_id === null
        ? null
        : requireText(row.predecessor_range_operation_id, 'predecessor range operation id'),
    authorizationId: requireText(row.authorization_id, 'authorization id'),
    clientOrderId: requireText(row.client_order_id, 'client order id'),
    marketId: requireText(row.market_id, 'market id'),
    normalizedMint: decodeCanonicalMintOrigin(row.normalized_mint),
    conditionId: requireText(row.condition_id, 'condition id'),
    unit: requireExact(row.unit, 'msat', 'unit'),
    tokenSide: requireClosed(row.token_side, ['Outcome', 'Complement'], 'token side'),
    side: requireClosed(row.side, ['Buy', 'Sell'], 'side'),
    priceSubunits: requirePositiveInteger(row.price_subunits, 'price'),
    amountSubunits: requirePositiveInteger(row.amount_subunits, 'amount'),
    divisibility: requireDivisibility(row.divisibility),
    authorizationExpiresAtUnixSeconds: requirePositiveInteger(
      row.authorization_expires_at_unix_seconds,
      'authorization expiry',
    ),
    preparationBytes: requireCanonicalBytes(row.preparation_body),
    createdAtMs: requireTimestamp(row.created_at_ms, 'created time'),
    lifecycleState,
    revision: requireRevision(row.revision),
    capability,
    updatedAtMs: requireTimestamp(row.updated_at_ms, 'updated time'),
  }
  if (record.priceSubunits >= record.divisibility || record.updatedAtMs < record.createdAtMs) {
    throw new Error('daemon CTF range preparation numeric authority is invalid')
  }
  return record
}

function decodeCapability(row: Record<string, unknown>): RangePreparationCapability | null {
  const values = [
    row.capability_artifact_id,
    row.capability_binding_digest,
    row.capability_artifact_digest,
    row.engine_order_id,
  ]
  if (values.every((value) => value === null)) return null
  if (values.some((value) => value === null)) {
    throw new Error('daemon CTF range capability authority is partial')
  }
  const capability = {
    artifactId: requireText(values[0], 'capability artifact id'),
    bindingDigest: requireText(values[1], 'capability binding digest'),
    artifactDigest: requireText(values[2], 'capability artifact digest'),
    orderId: requireText(values[3], 'engine order id'),
  }
  validateCapability(capability)
  return capability
}

function bindProofOperationReservation(
  database: DatabaseSync,
  scopeId: string,
  operationId: string,
  reservationId: string,
  purpose: typeof SOURCE_PURPOSE | typeof CONSOLIDATION_PURPOSE,
): void {
  const row = database
    .prepare(
      `SELECT reservation_id, purpose FROM target_proof_operations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(scopeId, operationId) as Record<string, unknown> | undefined
  if (row === undefined || row.purpose !== purpose) {
    throw new Error('daemon CTF range proof operation authority is invalid')
  }
  if (row.reservation_id !== null && row.reservation_id !== reservationId) {
    throw new Error('daemon CTF range proof reservation conflicts with its operation')
  }
  if (row.reservation_id === null) {
    const updated = database
      .prepare(
        `UPDATE target_proof_operations
         SET reservation_id = ?
         WHERE scope_id = ? AND operation_id = ? AND reservation_id IS NULL`,
      )
      .run(reservationId, scopeId, operationId)
    if (updated.changes !== 1) {
      throw new Error('daemon CTF range proof reservation changed concurrently')
    }
  }
}

function readSourceLink(
  database: DatabaseSync,
  scopeId: string,
  rangeOperationId: string,
): RangePreparationSourceLink | null {
  const row = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_sources
       WHERE scope_id = ? AND range_operation_id = ?`,
    )
    .get(scopeId, rangeOperationId) as Record<string, unknown> | undefined
  return row === undefined
    ? null
    : {
        scopeId: requireText(row.scope_id, 'source scope id'),
        rangeOperationId: requireText(row.range_operation_id, 'source range operation id'),
        sourceOperationId: requireText(row.source_operation_id, 'source operation id'),
        reservationId: requireText(row.reservation_id, 'source reservation id'),
      }
}

function readConsolidationLink(
  database: DatabaseSync,
  scopeId: string,
  rangeOperationId: string,
  round: number,
): RangePreparationConsolidationLink | null {
  const row = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_consolidations
       WHERE scope_id = ? AND range_operation_id = ? AND round = ?`,
    )
    .get(scopeId, rangeOperationId, round) as Record<string, unknown> | undefined
  return row === undefined ? null : decodeConsolidationLink(row)
}

function decodeConsolidationLink(row: Record<string, unknown>): RangePreparationConsolidationLink {
  return {
    scopeId: requireText(row.scope_id, 'consolidation scope id'),
    rangeOperationId: requireText(row.range_operation_id, 'consolidation range operation id'),
    round: requireRound(row.round),
    operationId: requireText(row.operation_id, 'consolidation operation id'),
    reservationId: requireText(row.reservation_id, 'consolidation reservation id'),
  }
}

function validateInsert(input: InsertRangePreparation): void {
  requireText(input.scopeId, 'scope id')
  requireText(input.rangeOperationId, 'range operation id')
  requireText(input.sourceOperationId, 'source operation id')
  requireClosed(input.sourceKind, ['wallet-prepared', 'residual-change'], 'source kind')
  if (
    (input.sourceKind === 'wallet-prepared' && input.predecessorRangeOperationId !== null) ||
    (input.sourceKind === 'residual-change' &&
      (input.predecessorRangeOperationId === null ||
        input.predecessorRangeOperationId === input.rangeOperationId))
  ) {
    throw new Error('daemon CTF range predecessor authority is invalid')
  }
  if (input.predecessorRangeOperationId !== null) {
    requireText(input.predecessorRangeOperationId, 'predecessor range operation id')
  }
  requireText(input.authorizationId, 'authorization id')
  requireText(input.clientOrderId, 'client order id', 1_024)
  requireText(input.marketId, 'market id', 1_024)
  decodeCanonicalMintOrigin(input.normalizedMint)
  requireText(input.conditionId, 'condition id', 1_024)
  requireExact(input.unit, 'msat', 'unit')
  requireClosed(input.tokenSide, ['Outcome', 'Complement'], 'token side')
  requireClosed(input.side, ['Buy', 'Sell'], 'side')
  requireDivisibility(input.divisibility)
  const price = requirePositiveInteger(input.priceSubunits, 'price')
  if (price > input.divisibility) throw new Error('daemon CTF range price exceeds divisibility')
  requirePositiveInteger(input.amountSubunits, 'amount')
  requirePositiveInteger(input.authorizationExpiresAtUnixSeconds, 'authorization expiry')
  requireCanonicalBytes(input.preparationBytes)
  requireTimestamp(input.createdAtMs, 'created time')
}

function validateCapability(capability: RangePreparationCapability): void {
  if (
    !UUID_PATTERN.test(capability.artifactId) ||
    !SHA256_PATTERN.test(capability.bindingDigest) ||
    !SHA256_PATTERN.test(capability.artifactDigest) ||
    !UUID_PATTERN.test(capability.orderId)
  ) {
    throw new Error('daemon CTF range capability authority is invalid')
  }
}

function validateSourceLink(input: RangePreparationSourceLink): void {
  requireText(input.scopeId, 'source scope id')
  requireText(input.rangeOperationId, 'source range operation id')
  requireText(input.sourceOperationId, 'source operation id')
  requireText(input.reservationId, 'source reservation id')
}

function validateConsolidationLink(input: RangePreparationConsolidationLink): void {
  requireText(input.scopeId, 'consolidation scope id')
  requireText(input.rangeOperationId, 'consolidation range operation id')
  requireRound(input.round)
  requireText(input.operationId, 'consolidation operation id')
  requireText(input.reservationId, 'consolidation reservation id')
}

function requirePreparation(
  database: DatabaseSync,
  scopeId: string,
  rangeOperationId: string,
): RangePreparationRecord {
  const record = readRangePreparation(database, scopeId, rangeOperationId)
  if (record === null) throw new Error('daemon CTF range preparation is missing')
  return record
}

function requireTransition(from: RangePreparationLifecycle, to: RangePreparationLifecycle): void {
  const legal =
    (from === 'prepared' && to === 'terminal') ||
    (from === 'capability-bound' &&
      (to === 'order-submitted' || to === 'submission-rejected' || to === 'terminal')) ||
    ((from === 'order-submitted' || from === 'submission-rejected') && to === 'terminal')
  if (!legal) throw new Error('daemon CTF range preparation lifecycle transition is invalid')
}

function requireCanonicalBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error('daemon CTF range preparation body is invalid')
  }
  decodeCanonicalRangePreparation(value)
  return Uint8Array.from(value)
}

function requireText(value: unknown, label: string, maximum = ID_BYTES_MAX): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`daemon CTF range ${label} is invalid`)
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireSafeInteger(value, label)
  if (integer < 1) throw new Error(`daemon CTF range ${label} is invalid`)
  return integer
}

function requireTimestamp(value: unknown, label: string): number {
  const timestamp = requireSafeInteger(value, label)
  if (timestamp < 0) throw new Error(`daemon CTF range ${label} is invalid`)
  return timestamp
}

function requireRevision(value: unknown): number {
  const revision = requireSafeInteger(value, 'revision')
  if (revision < 0) throw new Error('daemon CTF range revision is invalid')
  return revision
}

function requireRound(value: unknown): number {
  const round = requireSafeInteger(value, 'consolidation round')
  if (round < 0 || round > 255) {
    throw new Error('daemon CTF range consolidation round is invalid')
  }
  return round
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`daemon CTF range ${label} is invalid`)
  }
  return value
}

function requireDivisibility(value: unknown): 10_000 | 1_000_000 {
  if (value !== 10_000 && value !== 1_000_000) {
    throw new Error('daemon CTF range divisibility is invalid')
  }
  return value
}

function requireLifecycle(value: unknown): RangePreparationLifecycle {
  return requireClosed(
    value,
    ['prepared', 'capability-bound', 'order-submitted', 'submission-rejected', 'terminal'],
    'lifecycle state',
  )
}

function requireExact<const T extends string>(value: unknown, exact: T, label: string): T {
  if (value !== exact) throw new Error(`daemon CTF range ${label} is invalid`)
  return exact
}

function requireClosed<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`daemon CTF range ${label} is invalid`)
  }
  return value as T
}

function requirePageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
    throw new Error('daemon CTF range page limit is invalid')
  }
}

function validatePageCursor(cursor: RangePreparationPageCursor): void {
  requireTimestamp(cursor.updatedAtMs, 'page cursor time')
  requireText(cursor.rangeOperationId, 'page cursor operation id')
}

function sameInsert(record: RangePreparationRecord, input: InsertRangePreparation): boolean {
  return (
    record.scopeId === input.scopeId &&
    record.rangeOperationId === input.rangeOperationId &&
    record.sourceOperationId === input.sourceOperationId &&
    record.sourceKind === input.sourceKind &&
    record.predecessorRangeOperationId === input.predecessorRangeOperationId &&
    record.authorizationId === input.authorizationId &&
    record.clientOrderId === input.clientOrderId &&
    record.marketId === input.marketId &&
    record.normalizedMint === input.normalizedMint &&
    record.conditionId === input.conditionId &&
    record.unit === input.unit &&
    record.tokenSide === input.tokenSide &&
    record.side === input.side &&
    record.priceSubunits === input.priceSubunits &&
    record.amountSubunits === input.amountSubunits &&
    record.divisibility === input.divisibility &&
    record.authorizationExpiresAtUnixSeconds === input.authorizationExpiresAtUnixSeconds &&
    record.createdAtMs === input.createdAtMs &&
    sameBytes(record.preparationBytes, input.preparationBytes)
  )
}

function sameCapability(
  left: RangePreparationCapability,
  right: RangePreparationCapability,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.bindingDigest === right.bindingDigest &&
    left.artifactDigest === right.artifactDigest &&
    left.orderId === right.orderId
  )
}

function sameSourceLink(
  left: RangePreparationSourceLink,
  right: RangePreparationSourceLink,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.rangeOperationId === right.rangeOperationId &&
    left.sourceOperationId === right.sourceOperationId &&
    left.reservationId === right.reservationId
  )
}

function sameConsolidationLink(
  left: RangePreparationConsolidationLink,
  right: RangePreparationConsolidationLink,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.rangeOperationId === right.rangeOperationId &&
    left.round === right.round &&
    left.operationId === right.operationId &&
    left.reservationId === right.reservationId
  )
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}
