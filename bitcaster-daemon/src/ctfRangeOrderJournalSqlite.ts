import type { DatabaseSync } from 'node:sqlite'
import {
  decodeSettlementOrderContinuationReference,
  type SettlementOrderContinuationReference,
} from '@bitcaster-market/client-sdk/engineClient'
import {
  assertCtfRangeOrderPreparationTransition,
  bindCtfRangeOrderPreparationCapability,
  decodeCtfRangeOrderPreparationArtifact,
  decodeCtfRangeOrderPreparationCapability,
  decodeCtfRangeOrderPreparationIdentity,
  decodeCtfRangeOrderPreparationPageCursor,
  decodeCtfRangeOrderPreparationPageLimit,
  decodeCtfRangeOrderPreparationRecord,
  encodeCtfRangeOrderPreparationArtifact,
  sameCtfRangeOrderPreparationIdentity,
  type CtfRangeOrderPreparationCapability,
  type CtfRangeOrderPreparationIdentity,
  type CtfRangeOrderPreparationLifecycle,
  type CtfRangeOrderPreparationPageCursor,
  type CtfRangeOrderPreparationRecord,
} from '@bitcaster-market/client-sdk/ctfRangeOrderJournal'

const ID_BYTES_MAX = 16_384
const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'

export type RangePreparationLifecycle = CtfRangeOrderPreparationLifecycle
export type RangePreparationCapability = CtfRangeOrderPreparationCapability
export type InsertRangePreparation = CtfRangeOrderPreparationIdentity & {
  readonly consolidateProofs: boolean
}
export type RangePreparationRecord = CtfRangeOrderPreparationRecord & {
  readonly consolidateProofs: boolean
}
export type RangePreparationPageCursor = CtfRangeOrderPreparationPageCursor

export interface RangePreparationPage {
  readonly preparations: readonly RangePreparationRecord[]
  readonly nextCursor: RangePreparationPageCursor | null
  readonly deferredCount: number
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

export interface RangeSuccessorIntent {
  readonly scopeId: string
  readonly predecessorRangeOperationId: string
  readonly successorRangeOperationId: string
  readonly successorAuthorizationId: string
  readonly successorClientOrderId: string
  readonly remainingAmountSubunits: number
  readonly continuation: SettlementOrderContinuationReference
  readonly createdAtMs: number
}

export const encodeCanonicalRangePreparation = encodeCtfRangeOrderPreparationArtifact
export const decodeCanonicalRangePreparation = decodeCtfRangeOrderPreparationArtifact

export function insertRangePreparation(
  database: DatabaseSync,
  input: InsertRangePreparation,
): RangePreparationRecord {
  const sdkIdentity = withoutConsolidationPolicy(input)
  decodeCtfRangeOrderPreparationIdentity(sdkIdentity)
  database
    .prepare(
      `INSERT INTO daemon_ctf_range_preparations (
         scope_id, range_operation_id, source_operation_id, source_kind,
         predecessor_range_operation_id, authorization_id,
         client_order_id, order_route_id, normalized_mint, condition_id, unit,
         token_side, side, price_subunits, amount_subunits,
         minimum_fill_amount_subunits, continue_after_partial_fill, consolidate_proofs,
         continuation_predecessor_order_id, continuation_settlement_group_id,
         continuation_settlement_group_revision, continuation_revision, divisibility,
         authorization_expires_at_unix_seconds, preparation_body, lifecycle_state, revision,
         capability_artifact_id, capability_binding_digest, capability_artifact_digest,
         engine_order_id, created_at_ms, updated_at_ms
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'msat', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0,
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
      input.orderRouteId,
      input.normalizedMint,
      input.conditionId,
      input.tokenSide,
      input.side,
      input.priceSubunits,
      input.amountSubunits,
      input.minimumFillAmountSubunits,
      input.continueAfterPartialFill ? 1 : 0,
      input.consolidateProofs ? 1 : 0,
      input.continuation?.predecessorOrderId ?? null,
      input.continuation?.settlementGroupId ?? null,
      input.continuation?.settlementGroupRevision ?? null,
      input.continuation?.continuationRevision ?? null,
      input.divisibility,
      input.authorizationExpiresAtUnixSeconds,
      input.preparationBytes,
      input.createdAtMs,
      input.createdAtMs,
    )
  const record = readRangePreparation(database, input.scopeId, input.rangeOperationId)
  if (
    record === null ||
    record.consolidateProofs !== input.consolidateProofs ||
    !sameCtfRangeOrderPreparationIdentity(withoutConsolidationPolicy(record), sdkIdentity)
  ) {
    throw new Error('daemon CTF range preparation conflicts with its persisted authority')
  }
  return record
}

function withoutConsolidationPolicy<T extends { readonly consolidateProofs: boolean }>(
  value: T,
): Omit<T, 'consolidateProofs'> {
  const { consolidateProofs: _, ...sdkValue } = value
  return sdkValue
}

export function toSdkRangePreparationRecord(
  record: RangePreparationRecord,
): CtfRangeOrderPreparationRecord {
  return withoutConsolidationPolicy(record)
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

export function readResidualRangePreparationByPredecessor(
  database: DatabaseSync,
  scopeId: string,
  predecessorRangeOperationId: string,
): RangePreparationRecord | null {
  requireText(scopeId, 'scope id')
  requireText(predecessorRangeOperationId, 'predecessor range operation id')
  const row = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_preparations
       WHERE scope_id = ? AND predecessor_range_operation_id = ?`,
    )
    .get(scopeId, predecessorRangeOperationId) as Record<string, unknown> | undefined
  return row === undefined ? null : decodePreparationRow(row)
}

export function insertRangeSuccessorIntent(
  database: DatabaseSync,
  input: RangeSuccessorIntent,
): RangeSuccessorIntent {
  const intent = decodeRangeSuccessorIntent(input)
  database
    .prepare(
      `INSERT INTO daemon_ctf_range_successor_intents (
         scope_id, predecessor_range_operation_id, successor_range_operation_id,
         successor_authorization_id, successor_client_order_id, remaining_amount_subunits,
         continuation_predecessor_order_id, continuation_settlement_group_id,
         continuation_settlement_group_revision, continuation_revision, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      intent.scopeId,
      intent.predecessorRangeOperationId,
      intent.successorRangeOperationId,
      intent.successorAuthorizationId,
      intent.successorClientOrderId,
      intent.remainingAmountSubunits,
      intent.continuation.predecessorOrderId,
      intent.continuation.settlementGroupId,
      intent.continuation.settlementGroupRevision,
      intent.continuation.continuationRevision,
      intent.createdAtMs,
    )
  const persisted = readRangeSuccessorIntent(
    database,
    intent.scopeId,
    intent.predecessorRangeOperationId,
  )
  if (persisted === null || !sameRangeSuccessorIntent(persisted, intent)) {
    throw new Error('daemon CTF range successor intent conflicts with persisted authority')
  }
  return persisted
}

export function readRangeSuccessorIntent(
  database: DatabaseSync,
  scopeId: string,
  predecessorRangeOperationId: string,
): RangeSuccessorIntent | null {
  requireText(scopeId, 'scope id')
  requireText(predecessorRangeOperationId, 'predecessor range operation id')
  const row = database
    .prepare(
      `SELECT * FROM daemon_ctf_range_successor_intents
       WHERE scope_id = ? AND predecessor_range_operation_id = ?`,
    )
    .get(scopeId, predecessorRangeOperationId) as Record<string, unknown> | undefined
  if (row === undefined) return null
  return {
    scopeId: requireText(row.scope_id, 'successor scope id'),
    predecessorRangeOperationId: requireText(
      row.predecessor_range_operation_id,
      'successor predecessor operation id',
    ),
    successorRangeOperationId: requireText(
      row.successor_range_operation_id,
      'successor operation id',
    ),
    successorAuthorizationId: requireText(
      row.successor_authorization_id,
      'successor authorization id',
    ),
    successorClientOrderId: requireText(row.successor_client_order_id, 'successor client order id'),
    remainingAmountSubunits: requirePositiveSafeInteger(
      row.remaining_amount_subunits,
      'successor remaining amount',
    ),
    continuation: decodeSettlementOrderContinuationReference({
      predecessorOrderId: row.continuation_predecessor_order_id,
      settlementGroupId: row.continuation_settlement_group_id,
      settlementGroupRevision: row.continuation_settlement_group_revision,
      continuationRevision: row.continuation_revision,
    }),
    createdAtMs: requireNonnegativeSafeInteger(row.created_at_ms, 'successor created time'),
  }
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
  decodeCtfRangeOrderPreparationCapability(input.capability)
  requireRevision(input.expectedRevision)
  requireTimestamp(input.updatedAtMs, 'updated time')
  const current = requirePreparation(database, input.scopeId, input.rangeOperationId)
  const next = bindCtfRangeOrderPreparationCapability({
    current: toSdkRangePreparationRecord(current),
    ...input,
  })
  if (next.revision === current.revision) return current
  const capability = next.capability
  if (capability === null) {
    throw new Error('daemon CTF range capability binding lacks exact authority')
  }
  const result = database
    .prepare(
      `UPDATE daemon_ctf_range_preparations
       SET lifecycle_state = 'capability-bound',
           capability_artifact_id = ?, capability_binding_digest = ?,
           capability_artifact_digest = ?, engine_order_id = ?,
           revision = revision + 1, updated_at_ms = ?
       WHERE scope_id = ? AND range_operation_id = ?
         AND lifecycle_state = 'capability-requested' AND revision = ?`,
    )
    .run(
      capability.artifactId,
      capability.bindingDigest,
      capability.artifactDigest,
      capability.orderId,
      next.updatedAtMs,
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
  decodeCtfRangeOrderPreparationPageLimit(input.limit)
  if (input.after !== undefined) decodeCtfRangeOrderPreparationPageCursor(input.after)
  const cursorSql =
    input.after === undefined
      ? ''
      : `AND (
           preparation.created_at_ms > ?
           OR (
             preparation.created_at_ms = ?
             AND preparation.range_operation_id > ?
           )
         )`
  const parameters: Array<string | number> = [input.scopeId]
  if (input.after !== undefined) {
    parameters.push(input.after.createdAtMs, input.after.createdAtMs, input.after.rangeOperationId)
  }
  parameters.push(input.limit + 1)
  const rows = database
    .prepare(
      `SELECT preparation.*, count(*) OVER () AS active_page_total
       FROM daemon_ctf_range_preparations AS preparation
       WHERE preparation.scope_id = ?
         AND preparation.lifecycle_state <> 'terminal'
         ${cursorSql}
       ORDER BY preparation.created_at_ms, preparation.range_operation_id
       LIMIT ?`,
    )
    .all(...parameters) as Array<Record<string, unknown>>
  const pageRows = rows.slice(0, input.limit)
  const preparations = pageRows.map(decodePreparationRow)
  const last = pageRows.at(-1)
  const total =
    rows.length === 0 ? 0 : requireSafeInteger(rows[0]!.active_page_total, 'active page total')
  const deferredCount = Math.max(0, total - pageRows.length)
  return {
    preparations,
    nextCursor:
      deferredCount > 0 && last !== undefined
        ? {
            createdAtMs: requireSafeInteger(last.created_at_ms, 'created time'),
            rangeOperationId: requireText(last.range_operation_id, 'range operation id'),
          }
        : null,
    deferredCount,
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
  const record = decodeCtfRangeOrderPreparationRecord({
    scopeId: requireText(row.scope_id, 'scope id'),
    rangeOperationId: requireText(row.range_operation_id, 'range operation id'),
    sourceOperationId: requireText(row.source_operation_id, 'source operation id'),
    sourceKind: row.source_kind,
    predecessorRangeOperationId:
      row.predecessor_range_operation_id === null
        ? null
        : requireText(row.predecessor_range_operation_id, 'predecessor range operation id'),
    authorizationId: requireText(row.authorization_id, 'authorization id'),
    clientOrderId: requireText(row.client_order_id, 'client order id'),
    orderRouteId: requireText(row.order_route_id, 'order route id'),
    normalizedMint: row.normalized_mint,
    conditionId: requireText(row.condition_id, 'condition id'),
    unit: row.unit,
    tokenSide: row.token_side,
    side: row.side,
    priceSubunits: row.price_subunits,
    amountSubunits: row.amount_subunits,
    minimumFillAmountSubunits: row.minimum_fill_amount_subunits,
    continueAfterPartialFill: decodeSqliteBoolean(
      row.continue_after_partial_fill,
      'continuation policy',
    ),
    continuation: decodeContinuation(row),
    divisibility: row.divisibility,
    authorizationExpiresAtUnixSeconds: row.authorization_expires_at_unix_seconds,
    preparationBytes: row.preparation_body,
    createdAtMs: row.created_at_ms,
    lifecycleState: row.lifecycle_state,
    revision: row.revision,
    capability: decodeCapability(row),
    updatedAtMs: row.updated_at_ms,
  })
  return {
    ...record,
    consolidateProofs: decodeSqliteBoolean(row.consolidate_proofs, 'proof consolidation policy'),
  }
}

function decodeContinuation(row: Record<string, unknown>): RangePreparationRecord['continuation'] {
  const values = [
    row.continuation_predecessor_order_id,
    row.continuation_settlement_group_id,
    row.continuation_settlement_group_revision,
    row.continuation_revision,
  ]
  if (values.every((value) => value === null)) return null
  if (values.some((value) => value === null)) {
    throw new Error('daemon CTF range continuation authority is partial')
  }
  return {
    predecessorOrderId: requireText(values[0], 'continuation predecessor order id'),
    settlementGroupId: requireText(values[1], 'continuation settlement group id'),
    settlementGroupRevision: requirePositiveSafeInteger(values[2], 'continuation group revision'),
    continuationRevision: requirePositiveSafeInteger(values[3], 'continuation revision'),
  }
}

function decodeRangeSuccessorIntent(value: RangeSuccessorIntent): RangeSuccessorIntent {
  const scopeId = requireText(value.scopeId, 'successor scope id')
  const predecessorRangeOperationId = requireText(
    value.predecessorRangeOperationId,
    'successor predecessor operation id',
  )
  const successorRangeOperationId = requireText(
    value.successorRangeOperationId,
    'successor operation id',
  )
  if (successorRangeOperationId === predecessorRangeOperationId) {
    throw new Error('daemon CTF range successor operation is not fresh')
  }
  return {
    scopeId,
    predecessorRangeOperationId,
    successorRangeOperationId,
    successorAuthorizationId: requireText(
      value.successorAuthorizationId,
      'successor authorization id',
    ),
    successorClientOrderId: requireText(value.successorClientOrderId, 'successor client order id'),
    remainingAmountSubunits: requirePositiveSafeInteger(
      value.remainingAmountSubunits,
      'successor remaining amount',
    ),
    continuation: decodeSettlementOrderContinuationReference(value.continuation),
    createdAtMs: requireNonnegativeSafeInteger(value.createdAtMs, 'successor created time'),
  }
}

function sameRangeSuccessorIntent(
  left: RangeSuccessorIntent,
  right: RangeSuccessorIntent,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.predecessorRangeOperationId === right.predecessorRangeOperationId &&
    left.successorRangeOperationId === right.successorRangeOperationId &&
    left.successorAuthorizationId === right.successorAuthorizationId &&
    left.successorClientOrderId === right.successorClientOrderId &&
    left.remainingAmountSubunits === right.remainingAmountSubunits &&
    left.createdAtMs === right.createdAtMs &&
    left.continuation.predecessorOrderId === right.continuation.predecessorOrderId &&
    left.continuation.settlementGroupId === right.continuation.settlementGroupId &&
    left.continuation.settlementGroupRevision === right.continuation.settlementGroupRevision &&
    left.continuation.continuationRevision === right.continuation.continuationRevision
  )
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
  return decodeCtfRangeOrderPreparationCapability(capability)
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
  assertCtfRangeOrderPreparationTransition(from, to)
}

function requireText(value: unknown, label: string, maximum = ID_BYTES_MAX): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`daemon CTF range ${label} is invalid`)
  }
  return value
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

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const result = requireSafeInteger(value, label)
  if (result <= 0) throw new Error(`daemon CTF range ${label} is invalid`)
  return result
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  const result = requireSafeInteger(value, label)
  if (result < 0) throw new Error(`daemon CTF range ${label} is invalid`)
  return result
}

function decodeSqliteBoolean(value: unknown, label: string): boolean {
  if (value === 0) return false
  if (value === 1) return true
  throw new Error(`daemon CTF range ${label} is invalid`)
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
