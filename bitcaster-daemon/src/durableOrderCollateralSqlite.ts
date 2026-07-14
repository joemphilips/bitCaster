import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  DURABLE_ORDER_COLLATERAL_PROOF_LIMIT_MAX,
  decodeDurableOrderCollateralPin,
  reduceDurableOrderCollateralPin,
  type DurableOrderCollateralProof,
  type DurableOrderCollateralPin,
} from '@bitcaster-market/client-sdk/durableOrderCollateral'

export interface PreparedOrderCollateralPage {
  pins: DurableOrderCollateralPin[]
  nextCursor: string | null
}

export function readPreparedOrderCollateralPageInDatabase(
  database: DatabaseSync,
  input: { scopeId: string; cursor?: string | null; limit: number },
): PreparedOrderCollateralPage {
  if (!Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > DURABLE_ORDER_COLLATERAL_PROOF_LIMIT_MAX) {
    throw new Error('prepared order collateral page limit is invalid')
  }
  if (input.cursor !== undefined && input.cursor !== null
    && input.cursor.length === 0) {
    throw new Error('prepared order collateral cursor is invalid')
  }
  const rows = database.prepare(
    `SELECT * FROM custody_order_collateral_pins
      WHERE scope_id = ? AND pin_state = 'prepared' AND pin_id > ?
      ORDER BY pin_id LIMIT ?`,
  ).all(
    input.scopeId,
    input.cursor ?? '',
    input.limit + 1,
  ) as Array<Record<string, unknown> & { pin_id: string }>
  const hasMore = rows.length > input.limit
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows
  const proofsByPin = readPreparedPageProofs(
    database,
    input.scopeId,
    input.cursor ?? '',
    pageRows.at(-1)?.pin_id,
  )
  const pins = pageRows.map((row) =>
    decodePinRow(row, proofsByPin.get(row.pin_id) ?? []))
  return {
    pins,
    nextCursor: hasMore ? pageRows.at(-1)?.pin_id ?? null : null,
  }
}

function readPreparedPageProofs(
  database: DatabaseSync,
  scopeId: string,
  cursor: string,
  lastPinId: string | undefined,
): Map<string, Array<Record<string, unknown>>> {
  if (lastPinId === undefined) return new Map()
  const rows = database.prepare(
    `SELECT proof.* FROM custody_order_collateral_proofs AS proof
      JOIN custody_order_collateral_pins AS pin
        ON pin.scope_id = proof.scope_id AND pin.pin_id = proof.pin_id
      WHERE pin.scope_id = ? AND pin.pin_state = 'prepared'
        AND pin.pin_id > ? AND pin.pin_id <= ?
      ORDER BY proof.pin_id, proof.proof_position`,
  ).all(scopeId, cursor, lastPinId) as Array<Record<string, unknown>>
  const byPin = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const pinId = row.pin_id as string
    const proofs = byPin.get(pinId) ?? []
    proofs.push(row)
    byPin.set(pinId, proofs)
  }
  return byPin
}

export function readOrderCollateralPinInDatabase(
  database: DatabaseSync,
  scopeId: string,
  pinId: string,
): DurableOrderCollateralPin | null {
  const row = database
    .prepare(
      `SELECT * FROM custody_order_collateral_pins
        WHERE scope_id = ? AND pin_id = ?`,
    )
    .get(scopeId, pinId) as Record<string, unknown> | undefined
  if (row === undefined) return null
  const proofs = database
    .prepare(
      `SELECT * FROM custody_order_collateral_proofs
        WHERE scope_id = ? AND pin_id = ?
        ORDER BY proof_position`,
    )
    .all(scopeId, pinId) as Array<Record<string, unknown>>
  return decodePinRow(row, proofs)
}

export function insertOrderCollateralPinInDatabase(
  database: DatabaseSync,
  pinValue: DurableOrderCollateralPin,
): DurableOrderCollateralPin {
  const pin = decodeDurableOrderCollateralPin(pinValue)
  const existing = readOrderCollateralPinInDatabase(
    database,
    pin.scopeId,
    pin.pinId,
  )
  if (existing !== null) {
    if (!isDeepStrictEqual(existing, pin)) {
      throw new Error('order collateral pin already has foreign authority')
    }
    return existing
  }
  assertProofsAvailableForOrderPin(database, pin)
  insertPinRow(database, pin)
  insertProofRows(database, pin)
  return pin
}

export function replaceOrderCollateralPinInDatabase(
  database: DatabaseSync,
  previousValue: DurableOrderCollateralPin,
  nextValue: DurableOrderCollateralPin,
): DurableOrderCollateralPin {
  const previous = decodeDurableOrderCollateralPin(previousValue)
  const next = decodeDurableOrderCollateralPin(nextValue)
  if (previous.scopeId !== next.scopeId || previous.pinId !== next.pinId) {
    throw new Error('order collateral identity cannot change')
  }
  const current = readOrderCollateralPinInDatabase(
    database,
    previous.scopeId,
    previous.pinId,
  )
  if (current === null || !isDeepStrictEqual(current, previous)) {
    throw new Error('order collateral changed before compare-and-swap')
  }
  database
    .prepare(
      `UPDATE custody_order_collateral_pins
          SET revision = ?, remaining_order_amount = ?, pin_state = ?,
              order_id = ?, release_reason = ?
        WHERE scope_id = ? AND pin_id = ? AND revision = ?`,
    )
    .run(
      next.revision,
      next.remainingOrderAmount,
      next.state,
      next.orderId,
      next.releaseReason,
      next.scopeId,
      next.pinId,
      previous.revision,
    )
  if (next.state === 'released') {
    database
      .prepare(
        `DELETE FROM custody_order_collateral_proofs
          WHERE scope_id = ? AND pin_id = ?`,
      )
      .run(next.scopeId, next.pinId)
    return decodeDurableOrderCollateralPin({ ...next, proofs: [] })
  }
  if (!isDeepStrictEqual(previous.proofs, next.proofs)) {
    assertProofsAvailableForOrderPin(database, next)
    database
      .prepare(
        `DELETE FROM custody_order_collateral_proofs
          WHERE scope_id = ? AND pin_id = ?`,
      )
      .run(next.scopeId, next.pinId)
    insertProofRows(database, next)
  }
  return next
}

export function bindOrderCollateralOperationInDatabase(
  database: DatabaseSync,
  input: {
    scopeId: string
    pinId: string
    operationId: string
    proofIds: readonly string[]
  },
): void {
  assertOrderCollateralPinOwnsProofs(
    database,
    input.scopeId,
    input.pinId,
    input.proofIds,
  )
  const reservation = database.prepare(
    `SELECT scope_id, operation_id
       FROM custody_proof_reservations
      WHERE proof_id = ?`,
  )
  const existing = database.prepare(
    `SELECT scope_id, pin_id, operation_id
       FROM custody_order_collateral_allocations
      WHERE proof_id = ?`,
  )
  const insert = database.prepare(
    `INSERT INTO custody_order_collateral_allocations (
       scope_id, pin_id, operation_id, proof_id, schema_version
     ) VALUES (?, ?, ?, ?, 1)`,
  )
  for (const proofId of input.proofIds) {
    const reserved = reservation.get(proofId) as
      | { scope_id: string; operation_id: string }
      | undefined
    if (reserved?.scope_id !== input.scopeId
      || reserved.operation_id !== input.operationId) {
      throw new Error('custody operation does not own the pinned proof')
    }
    const allocated = existing.get(proofId) as
      | { scope_id: string; pin_id: string; operation_id: string }
      | undefined
    if (allocated !== undefined) {
      if (allocated.scope_id !== input.scopeId
        || allocated.pin_id !== input.pinId
        || allocated.operation_id !== input.operationId) {
        throw new Error('order collateral proof has foreign allocation')
      }
      continue
    }
    insert.run(input.scopeId, input.pinId, input.operationId, proofId)
  }
}

export function reconcileOrderCollateralFillInDatabase(
  database: DatabaseSync,
  input: {
    scopeId: string
    pinId: string
    orderId: string
    tradeId: string
    fillOrderAmount: number
    operationKeys: readonly string[]
    releaseProofIds: readonly string[]
    replacementProofs: readonly DurableOrderCollateralProof[]
  },
): DurableOrderCollateralPin {
  const effectFingerprint = fillEffectFingerprint(input)
  const existing = readFill(database, input)
  const storedPin = readOrderCollateralPinInDatabase(
    database,
    input.scopeId,
    input.pinId,
  )
  if (storedPin === null) throw new Error('order collateral pin is missing')
  if (existing !== undefined) {
    if (existing.effect_fingerprint !== effectFingerprint
      || existing.fill_order_amount !== input.fillOrderAmount) {
      throw new Error('order collateral fill has foreign exact effects')
    }
    return storedPin
  }
  const current = requireActivePin(storedPin, input.orderId)
  if (!Number.isSafeInteger(input.fillOrderAmount) || input.fillOrderAmount <= 0) {
    throw new Error('order collateral fill amount is invalid')
  }
  const allocatedProofIds = requireReconciledAllocations(database, input)
  const removedProofIds = new Set([
    ...allocatedProofIds,
    ...input.releaseProofIds,
  ])
  assertRemovedProofsBelongToPin(current, removedProofIds)
  const priorFillAmount = readRecordedFillAmount(database, input.scopeId, input.pinId)
  const filledAmount = safeAdd(priorFillAmount, input.fillOrderAmount)
  if (filledAmount > current.orderAmount) {
    throw new Error('order collateral fills exceed the order amount')
  }
  const next = reduceDurableOrderCollateralPin(current, {
    kind: 'record-fill',
    expectedRevision: current.revision,
    remainingOrderAmount: current.orderAmount - filledAmount,
    proofs: [
      ...current.proofs.filter((proof) => !removedProofIds.has(proof.proofId)),
      ...input.replacementProofs,
    ],
  })
  deleteAllocations(database, input, allocatedProofIds)
  const stored = replaceOrderCollateralPinInDatabase(database, current, next)
  database.prepare(
    `INSERT INTO custody_order_collateral_fills (
       scope_id, pin_id, trade_id, schema_version, fill_order_amount,
       remaining_order_amount, effect_fingerprint
     ) VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    input.scopeId,
    input.pinId,
    input.tradeId,
    input.fillOrderAmount,
    stored.remainingOrderAmount,
    effectFingerprint,
  )
  return stored
}

export function reconcileOrderCollateralTransformInDatabase(
  database: DatabaseSync,
  input: {
    scopeId: string
    pinId: string
    transformId: string
    operationKeys: readonly string[]
    replacementProofs: readonly DurableOrderCollateralProof[]
  },
): DurableOrderCollateralPin {
  const effectFingerprint = transformEffectFingerprint(input)
  const existing = database.prepare(
    `SELECT effect_fingerprint
       FROM custody_order_collateral_transforms
      WHERE scope_id = ? AND pin_id = ? AND transform_id = ?`,
  ).get(input.scopeId, input.pinId, input.transformId) as
    | { effect_fingerprint: string }
    | undefined
  const storedPin = readOrderCollateralPinInDatabase(
    database,
    input.scopeId,
    input.pinId,
  )
  if (storedPin === null) throw new Error('order collateral pin is missing')
  if (existing !== undefined) {
    if (existing.effect_fingerprint !== effectFingerprint) {
      throw new Error('order collateral transform has foreign exact effects')
    }
    return storedPin
  }
  const current = requireActivePin(storedPin, storedPin.orderId ?? '')
  const allocatedProofIds = requireReconciledAllocations(database, input)
  const removedProofIds = new Set(allocatedProofIds)
  assertRemovedProofsBelongToPin(current, removedProofIds)
  const next = reduceDurableOrderCollateralPin(current, {
    kind: 'replace-proofs',
    expectedRevision: current.revision,
    proofs: [
      ...current.proofs.filter((proof) => !removedProofIds.has(proof.proofId)),
      ...input.replacementProofs,
    ],
  })
  deleteAllocations(database, input, allocatedProofIds)
  const result = replaceOrderCollateralPinInDatabase(database, current, next)
  database.prepare(
    `INSERT INTO custody_order_collateral_transforms (
       scope_id, pin_id, transform_id, schema_version, effect_fingerprint
     ) VALUES (?, ?, ?, 1, ?)`,
  ).run(input.scopeId, input.pinId, input.transformId, effectFingerprint)
  return result
}

export function assertOrderCollateralPinOwnsProofs(
  database: DatabaseSync,
  scopeId: string,
  pinId: string,
  proofIds: readonly string[],
): void {
  if (proofIds.length === 0 || new Set(proofIds).size !== proofIds.length) {
    throw new Error('order collateral proof selection is invalid')
  }
  const pin = readOrderCollateralPinInDatabase(database, scopeId, pinId)
  if (pin === null || pin.state === 'released') {
    throw new Error('order collateral pin is not active')
  }
  const owned = new Set(pin.proofs.map((proof) => proof.proofId))
  if (proofIds.some((proofId) => !owned.has(proofId))) {
    throw new Error('proof is not owned by the order collateral pin')
  }
}

function assertProofsAvailableForOrderPin(
  database: DatabaseSync,
  pin: DurableOrderCollateralPin,
): void {
  const operationOwner = database.prepare(
    'SELECT operation_id FROM custody_proof_reservations WHERE proof_id = ?',
  )
  const pinOwner = database.prepare(
    'SELECT pin_id FROM custody_order_collateral_proofs WHERE proof_id = ?',
  )
  for (const proof of pin.proofs) {
    if (operationOwner.get(proof.proofId) !== undefined) {
      throw new Error('proof is reserved by a custody operation')
    }
    const existingPin = pinOwner.get(proof.proofId) as
      | { pin_id: string }
      | undefined
    if (existingPin !== undefined && existingPin.pin_id !== pin.pinId) {
      throw new Error('proof is already pinned to order collateral')
    }
  }
}

function requireActivePin(
  pin: DurableOrderCollateralPin,
  orderId: string,
): DurableOrderCollateralPin {
  if (pin.state !== 'active' || pin.orderId !== orderId) {
    throw new Error('order collateral fill has no active order authority')
  }
  return pin
}

function readFill(
  database: DatabaseSync,
  input: { scopeId: string; pinId: string; tradeId: string },
) {
  return database.prepare(
    `SELECT fill_order_amount, effect_fingerprint
       FROM custody_order_collateral_fills
      WHERE scope_id = ? AND pin_id = ? AND trade_id = ?`,
  ).get(input.scopeId, input.pinId, input.tradeId) as
    | { fill_order_amount: number; effect_fingerprint: string }
    | undefined
}

function requireReconciledAllocations(
  database: DatabaseSync,
  input: {
    scopeId: string
    pinId: string
    operationKeys: readonly string[]
  },
): string[] {
  if (input.operationKeys.length === 0
    || new Set(input.operationKeys).size !== input.operationKeys.length) {
    throw new Error('order collateral fill operation set is invalid')
  }
  const placeholders = input.operationKeys.map(() => '?').join(', ')
  const rows = database.prepare(
    `SELECT allocation.proof_id, operation.retained_operation_key,
            operation.operation_state
       FROM custody_order_collateral_allocations AS allocation
       JOIN custody_operations AS operation
         ON operation.scope_id = allocation.scope_id
        AND operation.operation_id = allocation.operation_id
      WHERE allocation.scope_id = ? AND allocation.pin_id = ?
        AND operation.retained_operation_key IN (${placeholders})`,
  ).all(input.scopeId, input.pinId, ...input.operationKeys) as Array<{
    proof_id: string
    retained_operation_key: string
    operation_state: string
  }>
  const foundKeys = new Set(rows.map((row) => row.retained_operation_key))
  if (input.operationKeys.some((key) => !foundKeys.has(key))
    || rows.some((row) => row.operation_state !== 'reconciled')) {
    throw new Error('order collateral fill operation is not reconciled')
  }
  return rows.map((row) => row.proof_id)
}

function assertRemovedProofsBelongToPin(
  pin: DurableOrderCollateralPin,
  proofIds: ReadonlySet<string>,
): void {
  const owned = new Set(pin.proofs.map((proof) => proof.proofId))
  if (proofIds.size === 0 || [...proofIds].some((proofId) => !owned.has(proofId))) {
    throw new Error('order collateral fill removes a foreign proof')
  }
}

function readRecordedFillAmount(
  database: DatabaseSync,
  scopeId: string,
  pinId: string,
): number {
  const row = database.prepare(
    `SELECT COALESCE(SUM(fill_order_amount), 0) AS total
       FROM custody_order_collateral_fills
      WHERE scope_id = ? AND pin_id = ?`,
  ).get(scopeId, pinId) as { total: number }
  return row.total
}

function deleteAllocations(
  database: DatabaseSync,
  input: { scopeId: string; pinId: string },
  proofIds: readonly string[],
): void {
  const remove = database.prepare(
    `DELETE FROM custody_order_collateral_allocations
      WHERE scope_id = ? AND pin_id = ? AND proof_id = ?`,
  )
  for (const proofId of proofIds) remove.run(input.scopeId, input.pinId, proofId)
}

function fillEffectFingerprint(input: {
  orderId: string
  tradeId: string
  fillOrderAmount: number
  operationKeys: readonly string[]
  releaseProofIds: readonly string[]
  replacementProofs: readonly DurableOrderCollateralProof[]
}): string {
  return createHash('sha256').update(JSON.stringify({
    orderId: input.orderId,
    tradeId: input.tradeId,
    fillOrderAmount: input.fillOrderAmount,
    operationKeys: [...input.operationKeys].sort(),
    releaseProofIds: [...input.releaseProofIds].sort(),
    replacementProofs: [...input.replacementProofs]
      .sort((left, right) => left.proofId.localeCompare(right.proofId)),
  })).digest('hex')
}

function transformEffectFingerprint(input: {
  transformId: string
  operationKeys: readonly string[]
  replacementProofs: readonly DurableOrderCollateralProof[]
}): string {
  return createHash('sha256').update(JSON.stringify({
    transformId: input.transformId,
    operationKeys: [...input.operationKeys].sort(),
    replacementProofs: [...input.replacementProofs]
      .sort((left, right) => left.proofId.localeCompare(right.proofId)),
  })).digest('hex')
}

function safeAdd(left: number, right: number): number {
  const value = left + right
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('order collateral fill amount exceeds safe integer range')
  }
  return value
}

function insertPinRow(database: DatabaseSync, pin: DurableOrderCollateralPin): void {
  database.prepare(
    `INSERT INTO custody_order_collateral_pins (
      scope_id, pin_id, schema_version, revision, client_order_id, market_id,
      mint_url, unit, order_amount, required_amount, remaining_order_amount,
      outcome_id, token_side, order_side, order_price, time_in_force,
      preflight_reservation_id, preflight_condition_id,
      preflight_keep_outcome_set_id, preflight_lock_outcome_set_id,
      preflight_amount_sats,
      pin_state, order_id, release_reason
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pin.scopeId,
    pin.pinId,
    pin.revision,
    pin.clientOrderId,
    pin.marketId,
    pin.mintUrl,
    pin.unit,
    pin.orderAmount,
    pin.requiredAmount,
    pin.remainingOrderAmount,
    pin.submissionRequest.outcomeId,
    pin.submissionRequest.tokenSide,
    pin.submissionRequest.side,
    pin.submissionRequest.price,
    pin.submissionRequest.timeInForce,
    pin.preflightSplit?.reservationId ?? null,
    pin.preflightSplit?.conditionId ?? null,
    pin.preflightSplit?.keepOutcomeSetId ?? null,
    pin.preflightSplit?.lockOutcomeSetId ?? null,
    pin.preflightSplit?.amountSats ?? null,
    pin.state,
    pin.orderId,
    pin.releaseReason,
  )
}

function insertProofRows(database: DatabaseSync, pin: DurableOrderCollateralPin): void {
  const insert = database.prepare(
    `INSERT INTO custody_order_collateral_proofs (
      proof_id, scope_id, pin_id, proof_position, keyset_id, amount,
      asset_kind, condition_id, outcome_set_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const [position, proof] of pin.proofs.entries()) {
    insert.run(
      proof.proofId,
      pin.scopeId,
      pin.pinId,
      position,
      proof.keysetId,
      proof.amount,
      proof.asset.kind,
      proof.asset.kind === 'outcome' ? proof.asset.conditionId : null,
      proof.asset.kind === 'outcome' ? proof.asset.outcomeSetId : null,
    )
  }
}

function decodePinRow(
  row: Record<string, unknown>,
  proofRows: Array<Record<string, unknown>>,
): DurableOrderCollateralPin {
  return decodeDurableOrderCollateralPin({
    schemaVersion: row.schema_version,
    revision: row.revision,
    scopeId: row.scope_id,
    pinId: row.pin_id,
    clientOrderId: row.client_order_id,
    marketId: row.market_id,
    mintUrl: row.mint_url,
    unit: row.unit,
    orderAmount: row.order_amount,
    requiredAmount: row.required_amount,
    remainingOrderAmount: row.remaining_order_amount,
    submissionRequest: {
      clientOrderId: row.client_order_id,
      outcomeId: row.outcome_id,
      tokenSide: row.token_side,
      side: row.order_side,
      price: row.order_price,
      amountSubunits: row.order_amount,
      timeInForce: row.time_in_force,
    },
    preflightSplit: row.preflight_reservation_id === null
      ? null
      : {
          reservationId: row.preflight_reservation_id,
          conditionId: row.preflight_condition_id,
          keepOutcomeSetId: row.preflight_keep_outcome_set_id,
          lockOutcomeSetId: row.preflight_lock_outcome_set_id,
          amountSats: row.preflight_amount_sats,
        },
    state: row.pin_state,
    orderId: row.order_id,
    releaseReason: row.release_reason,
    proofs: proofRows.map((proof) => ({
      proofId: proof.proof_id,
      keysetId: proof.keyset_id,
      amount: proof.amount,
      asset: proof.asset_kind === 'base'
        ? { kind: 'base' }
        : {
            kind: 'outcome',
            conditionId: proof.condition_id,
            outcomeSetId: proof.outcome_set_id,
          },
    })),
  })
}
