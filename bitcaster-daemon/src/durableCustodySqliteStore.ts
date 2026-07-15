import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  applyDurableCustodyTransaction,
  claimDurableCustodyScope,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  decodeDurableCustodyTransactionOperationIds,
  deriveDurableCustodyArtifactFingerprint,
  isDurableCustodyActiveRecoveryRecord,
  isDurableCustodyProofReservationActive,
  releaseDurableCustodyScope,
  reduceDurableCustodyState,
  renewDurableCustodyScope,
  validateDurableCustodyScopeRegistration,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyBinding,
  type DurableCustodyOperationTransition,
  type DurableCustodyRecord,
  type DurableCustodyRecoveryPage,
  type DurableCustodyRecoveryPageInput,
  type DurableCustodyScope,
  type DurableCustodyScopeClaimInput,
  type DurableCustodyScopeLeaseInput,
  type DurableCustodyScopeReleaseInput,
  type DurableCustodyScopeState,
  type DurableCustodyStore,
  type DurableCustodyTransaction,
  type DurableCustodyTransactionInput,
  type DurableCustodyTransactionWork,
  DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX,
} from '@bitcaster-market/client-sdk/durableCustody'
import { openProfileDatabase, tableExists } from './profile.ts'

const CUSTODY_SCHEMA_VERSION = 1
const CUSTODY_TABLES = [
  'custody_schema_metadata',
  'custody_scopes',
  'custody_scope_state',
  'custody_operations',
  'custody_operation_inputs',
  'custody_session_links',
  'custody_proof_reservations',
  'custody_order_collateral_pins',
  'custody_order_collateral_proofs',
  'custody_order_collateral_allocations',
  'custody_order_collateral_transforms',
  'custody_order_collateral_fills',
  'custody_verification_bindings',
  'custody_active_work',
] as const

/**
 * Creates the custody schema and exact wallet scope inside the caller's
 * profile-bootstrap transaction. Runtime startup validates this authority; it
 * never creates or repairs it.
 */
export function initializeDurableCustodyInDatabase(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  scope = canonicalizeScope(scope)
  assertForeignKeysEnabled(database)
  const presentTables = CUSTODY_TABLES.filter((table) =>
    tableExists(database, table),
  )
  if (presentTables.length === 0) {
    createSchema(database)
    database
      .prepare(
        `INSERT INTO custody_schema_metadata (singleton, schema_version)
         VALUES (1, ?)`,
      )
      .run(CUSTODY_SCHEMA_VERSION)
  } else {
    assertSchema(database)
  }
  return registerScopeInDatabase(database, scope)
}

/** Persistence primitive used only by the daemon's combined SQLite UoW. */
export function applyDurableCustodyWorkInDatabase<T>(
  database: DatabaseSync,
  input: DurableCustodyTransactionInput,
  apply: DurableCustodyTransactionWork<T>,
): T {
  const scope = canonicalizeScope(input.scope)
  const operationIds = decodeDurableCustodyTransactionOperationIds(
    input.operationIds,
  )
  assertForeignKeysEnabled(database)
  assertSchema(database)
  assertRegisteredScope(database, scope)
  const authorizedState = authorizeScopeOwner(
    readScopeState(database, scope),
    input.owner,
  )
  writeScopeState(database, authorizedState)
  const transaction = new SqliteDurableCustodyTransaction(
    database,
    scope,
    authorizedState,
    input.owner,
    operationIds,
  )
  const result = applyDurableCustodyTransaction(transaction, apply)
  transaction.assertIntegrity()
  return result
}

/**
 * SQLite physical adapter for the shared custody port. Canonical record
 * validation remains in the SDK; this file owns only SQLite layout and the
 * single physical transaction that makes logical rows visible together.
 */
export class SqliteDurableCustodyStore implements DurableCustodyStore {
  async listRecoverablePage(
    input: DurableCustodyRecoveryPageInput,
  ): Promise<DurableCustodyRecoveryPage> {
    const scope = canonicalizeScope(input.scope)
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX
    ) {
      throw new Error('custody recovery page limit is invalid')
    }
    if (
      input.cursor !== null &&
      (typeof input.cursor !== 'string' || input.cursor.length === 0)
    ) {
      throw new Error('custody recovery page cursor is invalid')
    }
    const database = this.openDatabase()
    try {
      assertRegisteredScope(database, scope)
      const rows = (
        input.cursor === null
          ? database
        .prepare(
          `SELECT operation.*
             FROM custody_active_work AS active
             JOIN custody_operations AS operation
               ON operation.scope_id = active.scope_id
              AND operation.operation_id = active.operation_id
            WHERE active.scope_id = ?
            ORDER BY active.operation_id
            LIMIT ?`,
        )
              .all(scope.scopeId, input.limit + 1)
          : database
              .prepare(
                `SELECT operation.*
             FROM custody_active_work AS active
             JOIN custody_operations AS operation
               ON operation.scope_id = active.scope_id
              AND operation.operation_id = active.operation_id
            WHERE active.scope_id = ? AND active.operation_id > ?
            ORDER BY active.operation_id
            LIMIT ?`,
              )
              .all(scope.scopeId, input.cursor, input.limit + 1)
      ) as Array<Record<string, unknown>>
      const hasMore = rows.length > input.limit
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows
      const relations = readOperationRelations(database, scope, pageRows)
      const records = pageRows.map((row) =>
        decodeOperationRow(database, row, scope, relations),
      )
      return {
        records,
        nextCursor:
          hasMore && records.length > 0
            ? records[records.length - 1]!.operation.operationId
            : null,
      }
    } finally {
      database.close()
    }
  }

  async registerScope(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState> {
    scope = canonicalizeScope(scope)
    const database = this.openDatabase()
    try {
      return inImmediateTransaction(database, () =>
        registerScopeInDatabase(database, scope),
      )
    } finally {
      database.close()
    }
  }

  async readScope(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState | null> {
    scope = canonicalizeScope(scope)
    const database = this.openDatabase()
    try {
      const existing = readScope(database, scope.scopeId)
      if (existing === null) return null
      validateDurableCustodyScopeRegistration(existing, scope)
      return readScopeState(database, scope)
    } finally {
      database.close()
    }
  }

  async claimScope(
    input: DurableCustodyScopeClaimInput,
  ): Promise<DurableCustodyScopeState> {
    input = { ...input, scope: canonicalizeScope(input.scope) }
    const database = this.openDatabase()
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, input.scope)
        const previous = readScopeState(database, input.scope)
        const next = claimDurableCustodyScope(previous, {
          kind: 'owner-claimed',
          nextIncarnationId: input.incarnationId,
          nextFencingEpoch: previous.fencingEpoch + 1,
          observedAtMs: input.observedAtMs,
          nextLeaseExpiresAtMs: input.leaseExpiresAtMs,
        })
        writeScopeState(database, next)
        return next
      })
    } finally {
      database.close()
    }
  }

  async renewScope(
    input: DurableCustodyScopeLeaseInput,
  ): Promise<DurableCustodyScopeState> {
    input = { ...input, scope: canonicalizeScope(input.scope) }
    const database = this.openDatabase()
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, input.scope)
        const next = renewDurableCustodyScope(
          readScopeState(database, input.scope),
          {
            kind: 'owner-renewed',
            incarnationId: input.incarnationId,
            fencingEpoch: input.fencingEpoch,
            observedAtMs: input.observedAtMs,
            nextLeaseExpiresAtMs: input.leaseExpiresAtMs,
          },
        )
        writeScopeState(database, next)
        return next
      })
    } finally {
      database.close()
    }
  }

  async releaseScope(
    input: DurableCustodyScopeReleaseInput,
  ): Promise<DurableCustodyScopeState> {
    input = { ...input, scope: canonicalizeScope(input.scope) }
    const database = this.openDatabase()
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, input.scope)
        const next = releaseDurableCustodyScope(
          readScopeState(database, input.scope),
          {
            kind: 'owner-released',
            incarnationId: input.incarnationId,
            fencingEpoch: input.fencingEpoch,
            observedAtMs: input.observedAtMs,
          },
        )
        writeScopeState(database, next)
        return next
      })
    } finally {
      database.close()
    }
  }

  async transact<T>(
    input: DurableCustodyTransactionInput,
    apply: DurableCustodyTransactionWork<T>,
  ): Promise<T> {
    input = { ...input, scope: canonicalizeScope(input.scope) }
    const database = this.openDatabase()
    try {
      return inImmediateTransaction(database, () =>
        applyDurableCustodyWorkInDatabase(database, input, apply),
      )
    } finally {
      database.close()
    }
  }

  async listRecoverable(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyRecord[]> {
    scope = canonicalizeScope(scope)
    const database = this.openDatabase()
    try {
      assertRegisteredScope(database, scope)
      assertScopeIntegrity(database, scope)
      const rows = database
        .prepare(
          `SELECT operation.*
         FROM custody_active_work AS active
         JOIN custody_operations AS operation
           ON operation.scope_id = active.scope_id
          AND operation.operation_id = active.operation_id
         WHERE active.scope_id = ?
         ORDER BY active.operation_id`,
        )
        .all(scope.scopeId) as Array<Record<string, unknown>>
      return rows.map((row) => decodeOperationRow(database, row, scope))
    } finally {
      database.close()
    }
  }

  async rebuildActiveWorkIndex(
    scope: DurableCustodyScope,
  ): Promise<'rebuilt' | 'unavailable'> {
    scope = canonicalizeScope(scope)
    const database = this.openDatabase()
    try {
      return inImmediateTransaction(database, () => {
        assertRegisteredScope(database, scope)
        rebuildActiveWorkIndex(database, scope)
        assertScopeIntegrity(database, scope)
        return 'rebuilt'
      })
    } finally {
      database.close()
    }
  }

  private openDatabase(): DatabaseSync {
    const database = openProfileDatabase()
    try {
      ensureSchema(database)
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }
}

class SqliteDurableCustodyTransaction implements DurableCustodyTransaction {
  private readonly database: DatabaseSync
  private readonly scope: DurableCustodyScope
  private scopeState: DurableCustodyScopeState
  private readonly owner: DurableCustodyOwnerAuthorization
  private readonly selectedOperationIds: ReadonlySet<string>
  private readonly touchedOperationIds = new Set<string>()

  constructor(
    database: DatabaseSync,
    scope: DurableCustodyScope,
    scopeState: DurableCustodyScopeState,
    owner: DurableCustodyOwnerAuthorization,
    operationIds: readonly string[],
  ) {
    this.database = database
    this.scope = scope
    this.scopeState = scopeState
    this.owner = owner
    this.selectedOperationIds = new Set(operationIds)
  }

  getScopeState(): DurableCustodyScopeState {
    return structuredClone(this.scopeState)
  }

  putScopeState(state: DurableCustodyScopeState): void {
    const decoded = decodeDurableCustodyScopeState(state, this.scope)
    if (!sameOwner(this.scopeState.owner, decoded.owner)) {
      throw new Error('custody owner changes require claimScope')
    }
    if (
      decoded.effectiveClock.highWaterMarkMs <
      this.scopeState.effectiveClock.highWaterMarkMs
    ) {
      throw new Error('custody effective clock moves backwards')
    }
    this.scopeState = decoded
    writeScopeState(this.database, this.scopeState)
  }

  getOperation(operationId: string): DurableCustodyRecord | null {
    this.assertOperationSelected(operationId)
    const row = this.database
      .prepare(
        `SELECT * FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(this.scope.scopeId, operationId) as
      | Record<string, unknown>
      | undefined
    return row === undefined
      ? null
      : decodeOperationRow(this.database, row, this.scope)
  }

  putOperation(record: DurableCustodyRecord): void {
    const decoded = decodeDurableCustodyRecord(record, this.scope)
    const existing = this.getOperation(decoded.operation.operationId)
    if (existing !== null) {
      if (isDeepStrictEqual(existing, decoded)) return
      throw new Error(
        'existing custody operations must advance through an SDK reducer transition',
      )
    }
    assertInitialOperation(decoded)
    const foreign = this.database
      .prepare('SELECT scope_id FROM custody_operations WHERE operation_id = ?')
      .get(decoded.operation.operationId) as { scope_id?: unknown } | undefined
    if (foreign !== undefined && foreign.scope_id !== this.scope.scopeId) {
      throw new Error('custody operation belongs to a foreign scope')
    }

    if (decoded.operation.binding.kind === 'trade') {
      const currentLink = readSessionLinkRow(
        this.database,
        this.scope.scopeId,
        decoded.operation.binding.sessionId,
        decoded.operation.operationId,
      )
      if (currentLink !== undefined) {
        assertSessionLinkMatches(decoded, currentLink)
      }
    }

    insertOperationRow(this.database, decoded)
    this.touchedOperationIds.add(decoded.operation.operationId)
  }

  getSessionLink(
    sessionId: string,
    operationId: string,
  ): Extract<DurableCustodyBinding, { kind: 'trade' }> | null {
    this.assertOperationSelected(operationId)
    const row = readSessionLinkRow(
      this.database,
      this.scope.scopeId,
      sessionId,
      operationId,
    )
    if (row === undefined) return null
    if (
      row.scope_id !== this.scope.scopeId ||
      typeof row.operation_id !== 'string'
    ) {
      throw new Error('custody session link is foreign')
    }
    const record = this.getOperation(row.operation_id)
    if (record === null)
      throw new Error('custody session link operation is missing')
    assertSessionLinkMatches(record, row)
    return structuredClone(requireTradeBinding(record))
  }

  putSessionLink(
    operationId: string,
    link: Extract<DurableCustodyBinding, { kind: 'trade' }>,
  ): void {
    const record = this.getOperation(operationId)
    if (record === null)
      throw new Error('custody session link has no matching operation')
    if (!sameSessionLink(requireTradeBinding(record), link)) {
      throw new Error('custody session link is foreign')
    }
    const existing = readSessionLinkRow(
      this.database,
      this.scope.scopeId,
      link.sessionId,
      operationId,
    )
    if (existing !== undefined) {
      if (
        existing.scope_id !== this.scope.scopeId ||
        existing.operation_id !== record.operation.operationId
      ) {
        throw new Error(
          'custody session link is already owned by another operation',
        )
      }
      assertSessionLinkMatches(record, existing)
      this.touchedOperationIds.add(record.operation.operationId)
      return
    }
    this.database
      .prepare(
        `INSERT INTO custody_session_links (
          scope_id, session_id, operation_id, schema_version, link_kind,
          trade_id, trade_role, trade_stage, immutable_trade_fingerprint,
          has_dependent_operation
        ) VALUES (?, ?, ?, 1, 'trade', ?, ?, ?, ?, ?)`,
      )
      .run(
        this.scope.scopeId,
        link.sessionId,
        record.operation.operationId,
        link.tradeId,
        link.role,
        link.stage,
        link.immutableTradeFingerprint,
        link.hasDependentOperation ? 1 : 0,
      )
    this.touchedOperationIds.add(record.operation.operationId)
  }

  reserveExactInputs(input: {
    operationId: string
    reservationId: string
    proofIds: readonly string[]
  }): void {
    const record = this.getOperation(input.operationId)
    if (record === null)
      throw new Error('custody reservation operation is missing')
    if (!isDurableCustodyProofReservationActive(record)) {
      throw new Error('terminal custody operation cannot reserve proofs')
    }
    if (record.operation.reservation.reservationId !== input.reservationId) {
      throw new Error('custody reservation id is foreign')
    }
    const expectedProofIds = record.operation.reservation.inputs.map(
      (proof) => proof.proofId,
    )
    if (
      !sameOrderedValues(expectedProofIds, input.proofIds) ||
      new Set(input.proofIds).size !== input.proofIds.length
    ) {
      throw new Error('custody reservation inputs are not exact')
    }
    const existingRows = this.database
      .prepare(
        `SELECT proof_id, reservation_id, input_position, keyset_id, curve
         FROM custody_proof_reservations
       WHERE scope_id = ? AND operation_id = ? ORDER BY proof_id`,
      )
      .all(this.scope.scopeId, input.operationId) as Array<{
      proof_id?: unknown
      reservation_id?: unknown
      input_position?: unknown
      keyset_id?: unknown
      curve?: unknown
    }>
    if (existingRows.length > 0) {
      const existingProofIds = existingRows.map((row) => row.proof_id)
      if (
        !sameUnorderedStringValues(expectedProofIds, existingProofIds) ||
        existingRows.some((row) => {
          const exactInput = record.operation.reservation.inputs.find(
            (candidate) => candidate.proofId === row.proof_id,
          )
          return (
            row.reservation_id !== input.reservationId ||
            exactInput === undefined ||
            row.input_position !==
              record.operation.reservation.inputs.indexOf(exactInput) ||
            row.keyset_id !== exactInput.keysetId ||
            row.curve !== exactInput.curve
          )
        })
      ) {
        throw new Error('custody reservation is incomplete or foreign')
      }
      this.touchedOperationIds.add(input.operationId)
      return
    }
    for (const [inputPosition, proofId] of expectedProofIds.entries()) {
      const exactInput = record.operation.reservation.inputs[inputPosition]
      if (exactInput === undefined)
        throw new Error('custody reservation input is missing')
      const owner = this.database
        .prepare(
          `SELECT scope_id, operation_id, reservation_id, input_position, keyset_id, curve
           FROM custody_proof_reservations
         WHERE proof_id = ?`,
        )
        .get(proofId) as
        | {
            scope_id?: unknown
            operation_id?: unknown
            reservation_id?: unknown
            input_position?: unknown
            keyset_id?: unknown
            curve?: unknown
          }
        | undefined
      if (owner !== undefined) {
        if (
          owner.scope_id !== this.scope.scopeId ||
          owner.operation_id !== input.operationId ||
          owner.reservation_id !== input.reservationId ||
          owner.input_position !== inputPosition ||
          owner.keyset_id !== exactInput.keysetId ||
          owner.curve !== exactInput.curve
        ) {
          throw new Error('proof reservation is already owned')
        }
        continue
      }
      this.database
        .prepare(
          `INSERT INTO custody_proof_reservations (
          proof_id, scope_id, operation_id, reservation_id, schema_version,
          input_position, keyset_id, curve
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          proofId,
          this.scope.scopeId,
          input.operationId,
          input.reservationId,
          inputPosition,
          exactInput.keysetId,
          exactInput.curve,
        )
    }
    this.touchedOperationIds.add(input.operationId)
  }

  transitionOperation(input: {
    operationId: string
    transition: DurableCustodyOperationTransition
  }): void {
    assertOperationTransition(input.transition)
    this.reduceOperation(input.operationId, {
      ...input.transition,
      ...this.owner,
    })
  }

  stageVerifiedResult(input: {
    operationId: string
    outputPlanFingerprint: string
    resultHandle: string
    resultFingerprint: string
  }): void {
    this.transitionOperation({
      operationId: input.operationId,
      transition: {
        kind: 'verified-result-staged',
        outputPlanFingerprint: input.outputPlanFingerprint,
        resultHandle: input.resultHandle,
        resultFingerprint: input.resultFingerprint,
      },
    })
  }

  applyVerifiedResult(input: {
    operationId: string
    outputPlanFingerprint: string
    resultHandle: string
    resultFingerprint: string
  }): void {
    const record = this.requireOperation(input.operationId)
    if (
      record.operation.result.state !== 'verified-staged' ||
      record.operation.result.outputPlanFingerprint !==
        input.outputPlanFingerprint ||
      record.operation.result.resultHandle !== input.resultHandle ||
      record.operation.result.resultFingerprint !== input.resultFingerprint
    ) {
      throw new Error('verified result is foreign or not staged')
    }
    const recoverySource =
      record.operation.state === 'transport-attempted'
        ? 'transport-attempted'
        : 'verified-result-staged'
    this.transitionOperation({
      operationId: input.operationId,
      transition: { kind: 'reconciled', recoverySource },
    })
  }

  putDelivery(input: {
    operationId: string
    deliveryKind: 'cipher' | 'settlement' | 'wallet-send'
    payloadHandle: string
    payloadFingerprint: string
    expiresAtMs: number | null
    state: 'pending' | 'acknowledged' | 'expired'
  }): void {
    assertDeliveryKind(input.deliveryKind)
    if (input.expiresAtMs === null) {
      throw new Error('outbox delivery expiry is required')
    }
    const current = this.requireOperation(input.operationId)
    const deliveryId = `delivery:${current.operation.operationId}:${input.deliveryKind}`
    if (current.operation.delivery.deliveryKind === 'none') {
      if (input.state !== 'pending') {
        throw new Error('outbox delivery must begin pending')
      }
      const next = structuredClone(current)
      next.revision += 1
      next.operation.delivery = {
        deliveryKind: 'outbox',
        deliveryId,
        payloadHandle: input.payloadHandle,
        payloadFingerprint: input.payloadFingerprint,
        expiresAtMs: input.expiresAtMs,
        state: 'pending',
    }
      this.updateOperation(next)
      return
    }
    if (
      current.operation.delivery.deliveryId !== deliveryId ||
      current.operation.delivery.payloadHandle !== input.payloadHandle ||
      current.operation.delivery.payloadFingerprint !==
        input.payloadFingerprint ||
      current.operation.delivery.expiresAtMs !== input.expiresAtMs
    ) {
      throw new Error('outbox delivery is foreign')
      }
    if (input.state === 'pending') {
      if (current.operation.delivery.state !== 'pending') {
        throw new Error('outbox delivery cannot return to pending')
      }
      return
    }
    this.transitionOperation({
      operationId: input.operationId,
      transition: { kind: 'delivery-resolved', deliveryState: input.state },
    })
  }

  rebuildActiveWorkIndex(): void {
    for (const operationId of this.touchedOperationIds) {
      synchronizeActiveWorkIndexForOperation(
        this.database,
        this.scope,
        operationId,
      )
    }
  }

  assertIntegrity(): void {
    for (const operationId of this.touchedOperationIds) {
      assertOperationIntegrity(this.database, this.scope, operationId)
    }
  }

  private requireOperation(operationId: string): DurableCustodyRecord {
    const record = this.getOperation(operationId)
    if (record === null) throw new Error('custody operation is missing')
    return record
  }

  private assertOperationSelected(operationId: string): void {
    if (!this.selectedOperationIds.has(operationId)) {
      throw new Error('custody transaction operation was not selected')
    }
  }

  private reduceOperation(
    operationId: string,
    transition: Parameters<typeof reduceDurableCustodyState>[1],
  ): void {
    const record = this.requireOperation(operationId)
    const reduced = reduceDurableCustodyState(
      { scopeState: this.scopeState, operation: record },
      transition,
    )
    this.putScopeState(reduced.scopeState)
    this.updateOperation(reduced.operation)
  }

  private updateOperation(record: DurableCustodyRecord): void {
    const decoded = decodeDurableCustodyRecord(record, this.scope)
    const previous = this.requireOperation(decoded.operation.operationId)
    assertOperationMutation(previous, decoded)
    updateOperationRow(this.database, decoded)
    synchronizeProofReservationForOperation(this.database, decoded)
    this.touchedOperationIds.add(decoded.operation.operationId)
  }
}

function ensureSchema(database: DatabaseSync): void {
  assertForeignKeysEnabled(database)
  const presentTables = CUSTODY_TABLES.filter((table) =>
    tableExists(database, table),
  )
  if (presentTables.length === 0) {
    if (tableExists(database, 'daemon_profile_initialization')) {
      throw new Error('custody SQLite schema is missing; refusing repair')
    }
    inImmediateTransaction(database, () => {
      const racingTables = CUSTODY_TABLES.filter((table) =>
        tableExists(database, table),
      )
      if (racingTables.length !== 0) {
        throw new Error(
          'custody SQLite schema initialization raced with another writer',
        )
      }
      createSchema(database)
      database
        .prepare(
          `INSERT INTO custody_schema_metadata (singleton, schema_version)
         VALUES (1, ?)`,
        )
        .run(CUSTODY_SCHEMA_VERSION)
    })
    return
  }
  assertSchema(database)
}

function assertForeignKeysEnabled(database: DatabaseSync): void {
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as
    | { foreign_keys?: unknown }
    | undefined
  if (foreignKeys?.foreign_keys !== 1)
    throw new Error('SQLite foreign-key enforcement is unavailable')
}

function assertSchema(database: DatabaseSync): void {
  const presentTables = CUSTODY_TABLES.filter((table) =>
    tableExists(database, table),
  )
  if (presentTables.length !== CUSTODY_TABLES.length) {
    throw new Error('custody SQLite schema is incomplete; refusing repair')
  }
  const marker = database
    .prepare(
      'SELECT schema_version FROM custody_schema_metadata WHERE singleton = 1',
    )
    .get() as { schema_version?: unknown } | undefined
  if (marker?.schema_version !== CUSTODY_SCHEMA_VERSION) {
    throw new Error('custody SQLite schema version is unsupported')
  }
  for (const table of CUSTODY_TABLES) {
    const row = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) as { sql?: unknown } | undefined
    if (typeof row?.sql !== 'string' || !row.sql.includes('STRICT')) {
      throw new Error('custody SQLite schema shape is unsupported')
    }
  }
  assertForeignKey(database, 'custody_scope_state', 'custody_scopes', [
    ['scope_id', 'scope_id'],
  ])
  assertForeignKey(database, 'custody_operations', 'custody_scopes', [
    ['scope_id', 'scope_id'],
  ])
  assertForeignKey(
    database,
    'custody_operations',
    'custody_order_collateral_pins',
    [
      ['scope_id', 'scope_id'],
      ['parent_reservation_id', 'pin_id'],
    ],
  )
  assertForeignKey(database, 'custody_operation_inputs', 'custody_operations', [
    ['scope_id', 'scope_id'],
    ['operation_id', 'operation_id'],
  ])
  assertForeignKey(database, 'custody_session_links', 'custody_operations', [
    ['scope_id', 'scope_id'],
    ['operation_id', 'operation_id'],
  ])
  assertForeignKey(
    database,
    'custody_proof_reservations',
    'custody_operations',
    [
      ['scope_id', 'scope_id'],
      ['operation_id', 'operation_id'],
      ['reservation_id', 'reservation_id'],
    ],
  )
  assertForeignKey(
    database,
    'custody_proof_reservations',
    'custody_operation_inputs',
    [
      ['scope_id', 'scope_id'],
      ['operation_id', 'operation_id'],
      ['proof_id', 'proof_id'],
      ['input_position', 'input_position'],
      ['keyset_id', 'keyset_id'],
      ['curve', 'curve'],
    ],
  )
  assertForeignKey(
    database,
    'custody_order_collateral_pins',
    'custody_scopes',
    [['scope_id', 'scope_id']],
  )
  assertForeignKey(
    database,
    'custody_order_collateral_proofs',
    'custody_order_collateral_pins',
    [
      ['scope_id', 'scope_id'],
      ['pin_id', 'pin_id'],
    ],
  )
  assertForeignKey(
    database,
    'custody_order_collateral_allocations',
    'custody_order_collateral_proofs',
    [
      ['scope_id', 'scope_id'],
      ['pin_id', 'pin_id'],
      ['proof_id', 'proof_id'],
    ],
  )
  assertForeignKey(
    database,
    'custody_order_collateral_allocations',
    'custody_operation_inputs',
    [
      ['scope_id', 'scope_id'],
      ['operation_id', 'operation_id'],
      ['proof_id', 'proof_id'],
    ],
  )
  assertForeignKey(
    database,
    'custody_order_collateral_transforms',
    'custody_order_collateral_pins',
    [
      ['scope_id', 'scope_id'],
      ['pin_id', 'pin_id'],
    ],
  )
  assertForeignKey(
    database,
    'custody_order_collateral_fills',
    'custody_order_collateral_pins',
    [
      ['scope_id', 'scope_id'],
      ['pin_id', 'pin_id'],
    ],
  )
  assertForeignKey(
    database,
    'custody_verification_bindings',
    'custody_operations',
    [
      ['scope_id', 'scope_id'],
      ['operation_id', 'operation_id'],
    ],
  )
  assertForeignKey(database, 'custody_active_work', 'custody_operations', [
    ['scope_id', 'scope_id'],
    ['operation_id', 'operation_id'],
  ])
  assertNamedIndex(
    database,
    'custody_session_links',
    'custody_session_links_operation_idx',
    true,
    ['scope_id', 'operation_id'],
  )
  assertNamedIndex(
    database,
    'custody_proof_reservations',
    'custody_proof_reservations_operation_idx',
    false,
    ['scope_id', 'operation_id', 'proof_id'],
  )
  assertNamedIndex(
    database,
    'custody_order_collateral_pins',
    'custody_order_collateral_pins_active_idx',
    false,
    ['scope_id', 'pin_state', 'pin_id'],
  )
  assertNotNullColumns(database, 'custody_operations', [
    'input_count',
    'input_authority_fingerprint',
    'verification_has_outputs',
  ])
  assertNotNullColumns(database, 'custody_operation_inputs', [
    'proof_id',
    'keyset_id',
    'curve',
  ])
}

function registerScopeInDatabase(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  const existing = readScope(database, scope.scopeId)
  if (existing !== null) {
    validateDurableCustodyScopeRegistration(existing, scope)
    return readScopeState(database, scope)
  }

  if (scope.scopeKind === 'market') {
    const conflictingRows = database
      .prepare(
        `SELECT scope_id, schema_version, scope_kind, wallet_id, market_id,
                inventory_account_id, normalized_mint, unit
           FROM custody_scopes
          WHERE market_id = ?
             OR (normalized_mint = ? AND unit = ? AND inventory_account_id = ?)`,
      )
      .all(
        scope.marketId,
        scope.normalizedMint,
        scope.unit,
        scope.inventoryAccountId,
      ) as Array<Parameters<typeof decodeScopeRow>[0]>
    for (const row of conflictingRows) {
      validateDurableCustodyScopeRegistration(decodeScopeRow(row), scope)
    }
  }

  insertScope(database, scope)
  const state: DurableCustodyScopeState = {
    schemaVersion: 1,
    scope,
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  }
  insertScopeState(database, state)
  return state
}

function assertForeignKey(
  database: DatabaseSync,
  table: string,
  referencedTable: string,
  columns: ReadonlyArray<readonly [string, string]>,
): void {
  const rows = database
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as Array<{
    id?: unknown
    seq?: unknown
    table?: unknown
    from?: unknown
    to?: unknown
  }>
  const groups = new Map<number, typeof rows>()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.seq)) continue
    const id = row.id as number
    groups.set(id, [...(groups.get(id) ?? []), row])
  }
  const supported = [...groups.values()].some((group) => {
    const ordered = [...group].sort((left, right) =>
      (left.seq as number) - (right.seq as number))
    return ordered.length === columns.length
      && ordered.every((row, index) =>
        row.table === referencedTable
        && row.seq === index
        && row.from === columns[index]?.[0]
        && row.to === columns[index]?.[1])
  })
  if (!supported) {
    throw new Error('custody SQLite schema foreign key is unsupported')
  }
}

function assertNamedIndex(
  database: DatabaseSync,
  table: string,
  name: string,
  unique: boolean,
  columns: readonly string[],
): void {
  const indexes = database
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{
    name?: unknown
    unique?: unknown
  }>
  const index = indexes.find((candidate) => candidate.name === name)
  if (index?.unique !== (unique ? 1 : 0)) {
    throw new Error('custody SQLite schema index is unsupported')
    }
  const actualColumns = database
    .prepare(`PRAGMA index_info(${name})`)
    .all() as Array<{ seqno?: unknown; name?: unknown }>
  if (
    actualColumns.length !== columns.length ||
    actualColumns.some(
      (column, position) =>
        column.seqno !== position || column.name !== columns[position],
    )
  ) {
    throw new Error('custody SQLite schema index is unsupported')
  }
}

function assertNotNullColumns(
  database: DatabaseSync,
  table: string,
  required: readonly string[],
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name?: unknown; notnull?: unknown }>
  if (required.some((name) =>
    !columns.some((column) => column.name === name && column.notnull === 1))) {
    throw new Error('custody SQLite schema column is unsupported')
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE custody_schema_metadata (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_scopes (
      scope_id TEXT PRIMARY KEY NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('wallet', 'market')),
      wallet_id TEXT CHECK (wallet_id IS NULL OR (length(wallet_id) = 64 AND wallet_id NOT GLOB '*[^0-9a-f]*')),
      market_id TEXT UNIQUE,
      inventory_account_id TEXT,
      normalized_mint TEXT,
      unit TEXT,
      CHECK (
        (scope_kind = 'wallet'
          AND wallet_id IS NOT NULL
          AND market_id IS NULL
          AND inventory_account_id IS NULL
          AND normalized_mint IS NULL
          AND unit IS NULL)
        OR
        (scope_kind = 'market'
          AND wallet_id IS NULL
          AND market_id IS NOT NULL
          AND inventory_account_id IS NOT NULL
          AND normalized_mint IS NOT NULL
          AND unit IS NOT NULL)
      ),
      UNIQUE (normalized_mint, unit, inventory_account_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_scope_state (
      scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
      owner_incarnation_id TEXT,
      lease_expires_at_ms INTEGER,
      high_water_mark_ms INTEGER NOT NULL CHECK (high_water_mark_ms >= 0),
      CHECK (
        (owner_incarnation_id IS NULL AND lease_expires_at_ms IS NULL)
        OR
        (owner_incarnation_id IS NOT NULL AND length(owner_incarnation_id) > 0 AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms >= 0)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_operations (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      retained_operation_key TEXT NOT NULL,
      binding_kind TEXT NOT NULL CHECK (binding_kind IN ('trade', 'wallet')),
      wallet_activity_id TEXT,
      wallet_stage TEXT,
      semantic_kind TEXT NOT NULL CHECK (semantic_kind IN (
        'swap-lock', 'swap-claim', 'swap-refund', 'conditional-keyset-swap',
        'generic-receive', 'generic-send', 'ctf-split', 'ctf-merge', 'ctf-redeem'
      )),
      operation_state TEXT NOT NULL CHECK (operation_state IN ('dispatch-intent', 'transport-attempted', 'reconciled', 'aborted')),
      terminal_replay_evidence_required INTEGER NOT NULL CHECK (terminal_replay_evidence_required IN (0, 1)),
      normalized_mint TEXT NOT NULL,
      unit TEXT NOT NULL,
      inventory_account_id TEXT,
      reservation_id TEXT NOT NULL,
      parent_reservation_id TEXT CHECK (
        parent_reservation_id IS NULL
        OR length(parent_reservation_id) BETWEEN 1 AND 1024
      ),
      input_count INTEGER NOT NULL CHECK (input_count BETWEEN 1 AND 256),
      input_authority_fingerprint TEXT NOT NULL CHECK (
        length(input_authority_fingerprint) = 64
        AND input_authority_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
      request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      request_payload_handle TEXT NOT NULL,
      request_output_plan_fingerprint TEXT NOT NULL,
      output_plan_id TEXT NOT NULL,
      output_plan_fingerprint TEXT NOT NULL,
      output_material_handle TEXT NOT NULL,
      private_material_handle TEXT NOT NULL,
      private_material_use_id TEXT NOT NULL,
      private_material_public_fingerprint TEXT NOT NULL,
      result_state TEXT NOT NULL CHECK (result_state IN ('none', 'verified-staged', 'applied')),
      result_handle TEXT CHECK (result_handle IS NULL OR length(result_handle) > 0),
      result_fingerprint TEXT CHECK (result_fingerprint IS NULL OR (length(result_fingerprint) = 64 AND result_fingerprint NOT GLOB '*[^0-9a-f]*')),
      result_output_plan_fingerprint TEXT CHECK (result_output_plan_fingerprint IS NULL OR (length(result_output_plan_fingerprint) = 64 AND result_output_plan_fingerprint NOT GLOB '*[^0-9a-f]*')),
      verification_output_plan_fingerprint TEXT NOT NULL,
      verification_has_outputs INTEGER NOT NULL CHECK (verification_has_outputs IN (0, 1)),
      delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('none', 'outbox')),
      delivery_id TEXT CHECK (delivery_id IS NULL OR length(delivery_id) > 0),
      delivery_payload_handle TEXT CHECK (delivery_payload_handle IS NULL OR length(delivery_payload_handle) > 0),
      delivery_payload_fingerprint TEXT CHECK (delivery_payload_fingerprint IS NULL OR (length(delivery_payload_fingerprint) = 64 AND delivery_payload_fingerprint NOT GLOB '*[^0-9a-f]*')),
      delivery_expires_at_ms INTEGER CHECK (delivery_expires_at_ms IS NULL OR delivery_expires_at_ms >= 0),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('none', 'pending', 'acknowledged', 'expired')),
      retry_attempt INTEGER NOT NULL CHECK (retry_attempt >= 0),
      retry_next_attempt_at_ms INTEGER CHECK (retry_next_attempt_at_ms IS NULL OR retry_next_attempt_at_ms >= 0),
      retry_reason TEXT NOT NULL,
      not_before_ms INTEGER CHECK (not_before_ms IS NULL OR not_before_ms >= 0),
      not_after_ms INTEGER CHECK (not_after_ms IS NULL OR not_after_ms >= 0),
      safety_margin_ms INTEGER NOT NULL CHECK (safety_margin_ms >= 0),
      keyset_expiry_ms INTEGER CHECK (keyset_expiry_ms IS NULL OR keyset_expiry_ms >= 0),
      tombstone_id TEXT CHECK (tombstone_id IS NULL OR length(tombstone_id) > 0),
      tombstone_trade_id TEXT CHECK (tombstone_trade_id IS NULL OR length(tombstone_trade_id) > 0),
      tombstone_authenticated_terminal INTEGER CHECK (tombstone_authenticated_terminal IS NULL OR tombstone_authenticated_terminal IN (0, 1)),
      tombstone_replay_cutoff INTEGER CHECK (tombstone_replay_cutoff IS NULL OR tombstone_replay_cutoff IN (0, 1)),
      PRIMARY KEY (scope_id, operation_id),
      UNIQUE (scope_id, operation_id, reservation_id),
      FOREIGN KEY (scope_id) REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
      FOREIGN KEY (scope_id, parent_reservation_id)
        REFERENCES custody_order_collateral_pins(scope_id, pin_id)
        ON DELETE RESTRICT,
      CHECK (
        (binding_kind = 'trade'
          AND wallet_activity_id IS NULL
          AND wallet_stage IS NULL)
        OR
        (binding_kind = 'wallet'
          AND wallet_activity_id IS NOT NULL
          AND length(wallet_activity_id) > 0
          AND wallet_stage IS NOT NULL
          AND length(wallet_stage) > 0)
      ),
      CHECK (
        (result_state = 'none'
          AND result_handle IS NULL
          AND result_fingerprint IS NULL
          AND result_output_plan_fingerprint IS NULL)
        OR
        (result_state IN ('verified-staged', 'applied')
          AND result_handle IS NOT NULL
          AND result_fingerprint IS NOT NULL
          AND result_output_plan_fingerprint IS NOT NULL)
      ),
      CHECK (
        (delivery_kind = 'none'
          AND delivery_id IS NULL
          AND delivery_payload_handle IS NULL
          AND delivery_payload_fingerprint IS NULL
          AND delivery_expires_at_ms IS NULL
          AND delivery_state = 'none')
        OR
        (delivery_kind = 'outbox'
          AND delivery_id IS NOT NULL
          AND delivery_payload_handle IS NOT NULL
          AND delivery_payload_fingerprint IS NOT NULL
          AND delivery_expires_at_ms IS NOT NULL
          AND delivery_state IN ('pending', 'acknowledged', 'expired'))
      ),
      CHECK (
        (retry_attempt = 0 AND retry_next_attempt_at_ms IS NULL AND retry_reason = 'none')
        OR
        (retry_attempt > 0 AND retry_next_attempt_at_ms IS NOT NULL
          AND retry_reason IN (
            'pending-or-mixed', 'mint-response-unknown', 'rate-limited',
            'reservation-race', 'storage-unavailable'
          ))
      ),
      CHECK (not_before_ms IS NULL OR not_after_ms IS NULL OR not_before_ms <= not_after_ms),
      CHECK (
        (tombstone_id IS NULL
          AND tombstone_trade_id IS NULL
          AND tombstone_authenticated_terminal IS NULL
          AND tombstone_replay_cutoff IS NULL)
        OR
        (tombstone_id IS NOT NULL
          AND tombstone_trade_id IS NOT NULL
          AND tombstone_authenticated_terminal IS NOT NULL
          AND tombstone_replay_cutoff IS NOT NULL
          AND terminal_replay_evidence_required = 1
          AND operation_state = 'reconciled'
          AND result_state = 'applied')
      ),
      CHECK (
        (operation_state = 'reconciled' AND result_state = 'applied')
        OR
        (operation_state <> 'reconciled' AND result_state <> 'applied')
      ),
      CHECK (operation_state <> 'aborted' OR result_state = 'none')
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_session_links (
      scope_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      link_kind TEXT NOT NULL CHECK (link_kind = 'trade'),
      trade_id TEXT NOT NULL,
      trade_role TEXT NOT NULL CHECK (trade_role IN ('buyer', 'seller')),
      trade_stage TEXT NOT NULL,
      immutable_trade_fingerprint TEXT NOT NULL,
      has_dependent_operation INTEGER NOT NULL CHECK (has_dependent_operation IN (0, 1)),
      PRIMARY KEY (scope_id, session_id, operation_id),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_operation_inputs (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      proof_id TEXT NOT NULL CHECK (
        length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'
      ),
      input_position INTEGER NOT NULL CHECK (input_position >= 0),
      keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
      curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
      PRIMARY KEY (scope_id, operation_id, proof_id),
      UNIQUE (scope_id, operation_id, input_position),
      UNIQUE (
        scope_id, operation_id, proof_id, input_position, keyset_id, curve
      ),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_proof_reservations (
      proof_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'
      ),
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      input_position INTEGER NOT NULL CHECK (input_position >= 0),
      keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
      curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
      UNIQUE (scope_id, operation_id, proof_id),
      FOREIGN KEY (scope_id, operation_id, reservation_id)
        REFERENCES custody_operations(scope_id, operation_id, reservation_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (
        scope_id, operation_id, proof_id, input_position, keyset_id, curve
      ) REFERENCES custody_operation_inputs(
        scope_id, operation_id, proof_id, input_position, keyset_id, curve
      )
        ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_order_collateral_pins (
      scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 1024),
      pin_id TEXT NOT NULL CHECK (length(pin_id) BETWEEN 1 AND 1024),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      client_order_id TEXT NOT NULL CHECK (length(client_order_id) BETWEEN 1 AND 1024),
      market_id TEXT NOT NULL CHECK (length(market_id) BETWEEN 1 AND 1024),
      mint_url TEXT NOT NULL CHECK (length(mint_url) BETWEEN 1 AND 1024),
      unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat', 'usd')),
      order_amount INTEGER NOT NULL CHECK (order_amount > 0),
      required_amount INTEGER NOT NULL CHECK (required_amount > 0),
      remaining_order_amount INTEGER NOT NULL CHECK (remaining_order_amount >= 0),
      outcome_id TEXT NOT NULL CHECK (length(outcome_id) BETWEEN 1 AND 1024),
      token_side TEXT NOT NULL CHECK (token_side IN ('Outcome', 'Complement')),
      order_side TEXT NOT NULL CHECK (order_side IN ('Buy', 'Sell')),
      order_price INTEGER NOT NULL CHECK (order_price > 0),
      time_in_force TEXT NOT NULL CHECK (time_in_force = 'GTC'),
      preflight_reservation_id TEXT CHECK (
        preflight_reservation_id IS NULL
        OR length(preflight_reservation_id) BETWEEN 1 AND 1024
      ),
      preflight_condition_id TEXT CHECK (
        preflight_condition_id IS NULL
        OR length(preflight_condition_id) BETWEEN 1 AND 1024
      ),
      preflight_keep_outcome_set_id TEXT CHECK (
        preflight_keep_outcome_set_id IS NULL
        OR length(preflight_keep_outcome_set_id) BETWEEN 1 AND 1024
      ),
      preflight_lock_outcome_set_id TEXT CHECK (
        preflight_lock_outcome_set_id IS NULL
        OR length(preflight_lock_outcome_set_id) BETWEEN 1 AND 1024
      ),
      preflight_amount_sats INTEGER CHECK (
        preflight_amount_sats IS NULL OR preflight_amount_sats > 0
      ),
      pin_state TEXT NOT NULL CHECK (pin_state IN ('preparing', 'prepared', 'active', 'released')),
      order_id TEXT CHECK (order_id IS NULL OR length(order_id) BETWEEN 1 AND 1024),
      release_reason TEXT CHECK (release_reason IN ('pre-submit-rejected', 'filled', 'cancelled', 'failed', 'expired')),
      PRIMARY KEY (scope_id, pin_id),
      UNIQUE (scope_id, client_order_id),
      FOREIGN KEY (scope_id) REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
      CHECK (remaining_order_amount <= order_amount),
      CHECK (
        (preflight_reservation_id IS NULL
          AND preflight_condition_id IS NULL
          AND preflight_keep_outcome_set_id IS NULL
          AND preflight_lock_outcome_set_id IS NULL
          AND preflight_amount_sats IS NULL)
        OR (preflight_reservation_id = pin_id
          AND preflight_condition_id IS NOT NULL
          AND preflight_keep_outcome_set_id IS NOT NULL
          AND preflight_lock_outcome_set_id IS NOT NULL
          AND preflight_keep_outcome_set_id <> preflight_lock_outcome_set_id
          AND preflight_amount_sats = order_amount
          AND order_side = 'Buy')
      ),
      CHECK (
        (pin_state IN ('preparing', 'prepared') AND order_id IS NULL AND release_reason IS NULL AND remaining_order_amount = order_amount)
        OR (pin_state = 'active' AND order_id IS NOT NULL AND release_reason IS NULL)
        OR (pin_state = 'released' AND release_reason IS NOT NULL AND remaining_order_amount = 0)
      ),
      CHECK (pin_state <> 'preparing' OR preflight_reservation_id IS NOT NULL),
      CHECK (release_reason <> 'pre-submit-rejected' OR order_id IS NULL)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_order_collateral_proofs (
      proof_id TEXT PRIMARY KEY NOT NULL CHECK (length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'),
      scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 1024),
      pin_id TEXT NOT NULL CHECK (length(pin_id) BETWEEN 1 AND 1024),
      proof_position INTEGER NOT NULL CHECK (proof_position >= 0),
      keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
      amount INTEGER NOT NULL CHECK (amount > 0),
      asset_kind TEXT NOT NULL CHECK (asset_kind IN ('base', 'outcome')),
      condition_id TEXT CHECK (condition_id IS NULL OR length(condition_id) BETWEEN 1 AND 1024),
      outcome_set_id TEXT CHECK (outcome_set_id IS NULL OR length(outcome_set_id) BETWEEN 1 AND 1024),
      UNIQUE (scope_id, pin_id, proof_position),
      UNIQUE (scope_id, pin_id, proof_id),
      FOREIGN KEY (scope_id, pin_id)
        REFERENCES custody_order_collateral_pins(scope_id, pin_id) ON DELETE RESTRICT,
      CHECK (
        (asset_kind = 'base' AND condition_id IS NULL AND outcome_set_id IS NULL)
        OR (asset_kind = 'outcome' AND condition_id IS NOT NULL AND outcome_set_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_order_collateral_allocations (
      scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 1024),
      pin_id TEXT NOT NULL CHECK (length(pin_id) BETWEEN 1 AND 1024),
      operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1024),
      proof_id TEXT PRIMARY KEY NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      FOREIGN KEY (scope_id, pin_id, proof_id)
        REFERENCES custody_order_collateral_proofs(scope_id, pin_id, proof_id) ON DELETE RESTRICT,
      FOREIGN KEY (scope_id, operation_id, proof_id)
        REFERENCES custody_operation_inputs(scope_id, operation_id, proof_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_order_collateral_fills (
      scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 1024),
      pin_id TEXT NOT NULL CHECK (length(pin_id) BETWEEN 1 AND 1024),
      trade_id TEXT NOT NULL CHECK (length(trade_id) BETWEEN 1 AND 1024),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      fill_order_amount INTEGER NOT NULL CHECK (fill_order_amount > 0),
      remaining_order_amount INTEGER NOT NULL CHECK (remaining_order_amount >= 0),
      effect_fingerprint TEXT NOT NULL CHECK (
        length(effect_fingerprint) = 64
        AND effect_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (scope_id, pin_id, trade_id),
      FOREIGN KEY (scope_id, pin_id)
        REFERENCES custody_order_collateral_pins(scope_id, pin_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_order_collateral_transforms (
      scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 1024),
      pin_id TEXT NOT NULL CHECK (length(pin_id) BETWEEN 1 AND 1024),
      transform_id TEXT NOT NULL CHECK (length(transform_id) BETWEEN 1 AND 1024),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      effect_fingerprint TEXT NOT NULL CHECK (
        length(effect_fingerprint) = 64
        AND effect_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
      PRIMARY KEY (scope_id, pin_id, transform_id),
      FOREIGN KEY (scope_id, pin_id)
        REFERENCES custody_order_collateral_pins(scope_id, pin_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX custody_order_collateral_pins_active_idx
      ON custody_order_collateral_pins(scope_id, pin_state, pin_id);

    CREATE TABLE IF NOT EXISTS custody_verification_bindings (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      keyset_id TEXT NOT NULL,
      curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
      keyset_fingerprint TEXT NOT NULL,
      require_dleq INTEGER NOT NULL CHECK (require_dleq IN (0, 1)),
      is_output INTEGER NOT NULL CHECK (is_output IN (0, 1)),
      PRIMARY KEY (scope_id, operation_id, keyset_id, curve),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS custody_active_work (
      scope_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      PRIMARY KEY (scope_id, operation_id),
      FOREIGN KEY (scope_id, operation_id)
        REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE UNIQUE INDEX custody_session_links_operation_idx
      ON custody_session_links (scope_id, operation_id);

    CREATE INDEX custody_proof_reservations_operation_idx
      ON custody_proof_reservations (scope_id, operation_id, proof_id);
  `)
}

function insertScope(database: DatabaseSync, scope: DurableCustodyScope): void {
  if (scope.scopeKind === 'wallet') {
    database
      .prepare(
        `INSERT INTO custody_scopes (
        scope_id, schema_version, scope_kind, wallet_id, market_id,
        inventory_account_id, normalized_mint, unit
      ) VALUES (?, 1, 'wallet', ?, NULL, NULL, NULL, NULL)`,
      )
      .run(scope.scopeId, scope.walletId)
    return
  }
  database
    .prepare(
      `INSERT INTO custody_scopes (
      scope_id, schema_version, scope_kind, wallet_id, market_id,
      inventory_account_id, normalized_mint, unit
    ) VALUES (?, 1, 'market', NULL, ?, ?, ?, ?)`,
    )
    .run(
      scope.scopeId,
      scope.marketId,
      scope.inventoryAccountId,
      scope.normalizedMint,
      scope.unit,
    )
}

function readScope(
  database: DatabaseSync,
  scopeId: string,
): DurableCustodyScope | null {
  const row = database
    .prepare(
      `SELECT scope_id, schema_version, scope_kind, wallet_id, market_id,
            inventory_account_id, normalized_mint, unit
     FROM custody_scopes WHERE scope_id = ?`,
    )
    .get(scopeId) as
    | {
        schema_version?: unknown
        scope_kind?: unknown
        wallet_id?: unknown
        market_id?: unknown
        inventory_account_id?: unknown
        normalized_mint?: unknown
        unit?: unknown
        scope_id?: unknown
      }
    | undefined
  if (row === undefined) return null
  if (row.schema_version !== 1)
    throw new Error('unsupported durable custody schema version')
  const scope = decodeScopeRow(row)
  if (scope.scopeId !== scopeId || row.scope_kind !== scope.scopeKind) {
    throw new Error('custody scope row is corrupt')
  }
  if (scope.scopeKind === 'wallet') {
    if (
      row.wallet_id !== scope.walletId ||
      row.market_id !== null ||
      row.inventory_account_id !== null ||
      row.normalized_mint !== null ||
      row.unit !== null
    ) {
      throw new Error('custody scope row is corrupt')
    }
  } else if (
    row.wallet_id !== null ||
    row.market_id !== scope.marketId ||
    row.inventory_account_id !== scope.inventoryAccountId ||
    row.normalized_mint !== scope.normalizedMint ||
    row.unit !== scope.unit
  ) {
    throw new Error('custody scope row is corrupt')
  }
  return scope
}

function assertRegisteredScope(
  database: DatabaseSync,
  requested: DurableCustodyScope,
): void {
  const stored = readScope(database, requested.scopeId)
  if (stored === null) throw new Error('custody scope is not registered')
  validateDurableCustodyScopeRegistration(stored, requested)
}

function readScopeState(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  const row = database
    .prepare(
      `SELECT schema_version, fencing_epoch, owner_incarnation_id,
            lease_expires_at_ms,
            high_water_mark_ms
     FROM custody_scope_state WHERE scope_id = ?`,
    )
    .get(scope.scopeId) as
    | {
        schema_version?: unknown
        fencing_epoch?: unknown
        owner_incarnation_id?: unknown
        lease_expires_at_ms?: unknown
        high_water_mark_ms?: unknown
      }
    | undefined
  if (row === undefined) throw new Error('custody scope state is missing')
  if (row.schema_version !== 1)
    throw new Error('unsupported durable custody schema version')
  const state = decodeScopeStateRow(row, scope)
  const owner = state.owner
  if (
    row.fencing_epoch !== state.fencingEpoch ||
    row.owner_incarnation_id !== (owner?.incarnationId ?? null) ||
    row.lease_expires_at_ms !== (owner?.leaseExpiresAtMs ?? null) ||
    row.high_water_mark_ms !== state.effectiveClock.highWaterMarkMs
  ) {
    throw new Error('custody scope state row is corrupt')
  }
  return state
}

function writeScopeState(
  database: DatabaseSync,
  state: DurableCustodyScopeState,
): void {
  const decoded = decodeDurableCustodyScopeState(state, state.scope)
  const owner = decoded.owner
  const result = database
    .prepare(
      `UPDATE custody_scope_state SET
       schema_version = 1,
       fencing_epoch = ?,
       owner_incarnation_id = ?,
       lease_expires_at_ms = ?,
       high_water_mark_ms = ?
     WHERE scope_id = ?`,
    )
    .run(
      decoded.fencingEpoch,
      owner?.incarnationId ?? null,
      owner?.leaseExpiresAtMs ?? null,
      decoded.effectiveClock.highWaterMarkMs,
      decoded.scope.scopeId,
    )
  if (result.changes !== 1) throw new Error('custody scope state is missing')
}

function insertScopeState(
  database: DatabaseSync,
  state: DurableCustodyScopeState,
): void {
  const decoded = decodeDurableCustodyScopeState(state, state.scope)
  const owner = decoded.owner
  database
    .prepare(
      `INSERT INTO custody_scope_state (
       scope_id, schema_version, fencing_epoch, owner_incarnation_id,
       lease_expires_at_ms,
       high_water_mark_ms
     ) VALUES (?, 1, ?, ?, ?, ?)`,
    )
    .run(
      decoded.scope.scopeId,
      decoded.fencingEpoch,
      owner?.incarnationId ?? null,
      owner?.leaseExpiresAtMs ?? null,
      decoded.effectiveClock.highWaterMarkMs,
    )
}

function decodeScopeRow(row: {
  schema_version?: unknown
  scope_kind?: unknown
  wallet_id?: unknown
  market_id?: unknown
  inventory_account_id?: unknown
  normalized_mint?: unknown
  unit?: unknown
  scope_id?: unknown
}): DurableCustodyScope {
  if (row.schema_version !== 1) {
    throw new Error('unsupported durable custody schema version')
  }
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope:
      row.scope_kind === 'wallet'
      ? {
            scopeKind: 'wallet',
        walletId: row.wallet_id,
        scopeId: row.scope_id,
      }
      : {
        scopeKind: row.scope_kind,
        marketId: row.market_id,
        inventoryAccountId: row.inventory_account_id,
        normalizedMint: row.normalized_mint,
        unit: row.unit,
        scopeId: row.scope_id,
      },
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  }).scope
}

function canonicalizeScope(scope: DurableCustodyScope): DurableCustodyScope {
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope,
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 0 },
  }).scope
}

function decodeScopeStateRow(
  row: {
    schema_version?: unknown
    fencing_epoch?: unknown
    owner_incarnation_id?: unknown
    lease_expires_at_ms?: unknown
    high_water_mark_ms?: unknown
  },
  scope: DurableCustodyScope,
): DurableCustodyScopeState {
  return decodeDurableCustodyScopeState(
    {
      schemaVersion: row.schema_version,
      scope,
      fencingEpoch: row.fencing_epoch,
      owner:
        row.owner_incarnation_id === null &&
        row.lease_expires_at_ms === null
        ? null
        : {
          incarnationId: row.owner_incarnation_id,
          leaseExpiresAtMs: row.lease_expires_at_ms,
        },
      effectiveClock: { highWaterMarkMs: row.high_water_mark_ms },
    },
    scope,
  )
}

function decodeOperationRow(
  database: DatabaseSync,
  row: Record<string, unknown>,
  scope: DurableCustodyScope,
  preloaded?: CustodyOperationRelations,
): DurableCustodyRecord {
  if (row.schema_version !== 1) {
    throw new Error('unsupported durable custody schema version')
  }
  const operationId = requireDatabaseText(
    row.operation_id,
    'custody operation id',
  )
  const relations = preloaded ?? readOperationRelations(database, scope, [row])
  const inputRows = relations.inputs.get(operationId) ?? []
  for (const [position, input] of inputRows.entries()) {
    if (input.input_position !== position) {
      throw new Error('custody operation input position is corrupt')
    }
  }
  assertOperationInputAuthority(row, inputRows)
  const verificationRows = relations.verifications.get(operationId) ?? []
  const binding = decodeOperationBindingRow(
    row,
    relations.sessionLinks.get(operationId) ?? [],
  )
  const tombstone =
    row.tombstone_id === null
    ? null
    : {
      tombstoneId: row.tombstone_id,
      tradeId: row.tombstone_trade_id,
      authenticatedTerminalStatus: decodeDatabaseBoolean(
        row.tombstone_authenticated_terminal,
            'custody tombstone terminal marker',
      ),
      replayCutoffObserved: decodeDatabaseBoolean(
        row.tombstone_replay_cutoff,
            'custody tombstone cutoff marker',
      ),
        }
  return decodeDurableCustodyRecord(
    {
    schemaVersion: row.schema_version,
    revision: row.revision,
    scope,
    operation: {
      operationId,
      retainedOperationKey: row.retained_operation_key,
      binding,
      semanticKind: row.semantic_kind,
      state: row.operation_state,
      terminalReplayEvidenceRequired: decodeDatabaseBoolean(
        row.terminal_replay_evidence_required,
          'custody terminal replay requirement',
      ),
      custodyContext: {
        normalizedMint: row.normalized_mint,
        unit: row.unit,
        inventoryAccountId: row.inventory_account_id,
      },
      reservation: {
        reservationId: row.reservation_id,
        parentReservationId: row.parent_reservation_id,
        inputs: inputRows.map((input) => ({
          proofId: input.proof_id,
          keysetId: input.keyset_id,
          curve: input.curve,
        })),
      },
      exactRequest: {
        requestId: row.request_id,
        requestFingerprint: row.request_fingerprint,
        payloadHandle: row.request_payload_handle,
        inputProofIds: inputRows.map((input) => input.proof_id),
        outputPlanFingerprint: row.request_output_plan_fingerprint,
      },
      outputPlan: {
        outputPlanId: row.output_plan_id,
        outputPlanFingerprint: row.output_plan_fingerprint,
        outputMaterialHandle: row.output_material_handle,
      },
      privateMaterial: {
        materialHandle: row.private_material_handle,
        useId: row.private_material_use_id,
        publicFingerprint: row.private_material_public_fingerprint,
      },
      result: {
        state: row.result_state,
        resultHandle: row.result_handle,
        resultFingerprint: row.result_fingerprint,
        outputPlanFingerprint: row.result_output_plan_fingerprint,
      },
      verification: {
        outputPlanFingerprint: row.verification_output_plan_fingerprint,
        hasOutputs: decodeDatabaseBoolean(
          row.verification_has_outputs,
          'custody output marker',
        ),
        keysetBindings: verificationRows.map((binding) => ({
          keysetId: binding.keyset_id,
          curve: binding.curve,
          keysetFingerprint: binding.keyset_fingerprint,
            requireDleq: decodeDatabaseBoolean(
              binding.require_dleq,
              'custody DLEQ marker',
            ),
        })),
        outputKeysets: verificationRows
          .filter((binding) => decodeDatabaseBoolean(
            binding.is_output,
            'custody output keyset marker',
          ))
          .map((binding) => ({
            keysetId: binding.keyset_id,
            curve: binding.curve,
          })),
      },
      delivery: {
        deliveryKind: row.delivery_kind,
        deliveryId: row.delivery_id,
        payloadHandle: row.delivery_payload_handle,
        payloadFingerprint: row.delivery_payload_fingerprint,
        expiresAtMs: row.delivery_expires_at_ms,
        state: row.delivery_state,
      },
      retry: {
        attempt: row.retry_attempt,
        nextAttemptAtMs: row.retry_next_attempt_at_ms,
        reason: row.retry_reason,
      },
      horizon: {
        notBeforeMs: row.not_before_ms,
        notAfterMs: row.not_after_ms,
        safetyMarginMs: row.safety_margin_ms,
        keysetExpiryMs: row.keyset_expiry_ms,
      },
    },
    terminalTombstone: tombstone,
    },
    scope,
  )
}

function decodeOperationBindingRow(
  row: Record<string, unknown>,
  links: readonly Record<string, unknown>[],
): unknown {
  if (row.binding_kind === 'wallet') {
    return {
      kind: 'wallet',
      activityId: row.wallet_activity_id,
      stage: row.wallet_stage,
    }
  }
  if (row.binding_kind !== 'trade') {
    throw new Error('custody operation binding kind is corrupt')
  }
  if (links.length !== 1) {
    throw new Error('custody operation session link is missing or ambiguous')
  }
  return decodeSessionLinkRow(links[0]!)
}

interface CustodyOperationRelations {
  inputs: Map<string, Array<Record<string, unknown>>>
  verifications: Map<string, Array<Record<string, unknown>>>
  sessionLinks: Map<string, Array<Record<string, unknown>>>
}

function readOperationRelations(
  database: DatabaseSync,
  scope: DurableCustodyScope,
  operationRows: readonly Record<string, unknown>[],
): CustodyOperationRelations {
  const operationIds = operationRows.map((row) =>
    requireDatabaseText(row.operation_id, 'custody operation id'),
  )
  if (operationIds.length === 0) return emptyOperationRelations()
  const placeholders = operationIds.map(() => '?').join(', ')
  const params = [scope.scopeId, ...operationIds]
  return {
    inputs: groupOperationRows(database.prepare(
      `SELECT operation_id, proof_id, input_position, keyset_id, curve
         FROM custody_operation_inputs
        WHERE scope_id = ? AND operation_id IN (${placeholders})
        ORDER BY operation_id, input_position`,
    ).all(...params) as Array<Record<string, unknown>>),
    verifications: groupOperationRows(database.prepare(
      `SELECT operation_id, keyset_id, curve, keyset_fingerprint, require_dleq, is_output
         FROM custody_verification_bindings
        WHERE scope_id = ? AND operation_id IN (${placeholders})
        ORDER BY operation_id, keyset_id, curve`,
    ).all(...params) as Array<Record<string, unknown>>),
    sessionLinks: groupOperationRows(database.prepare(
      `SELECT operation_id, scope_id, session_id, link_kind, trade_id,
              trade_role, trade_stage, immutable_trade_fingerprint,
              has_dependent_operation
         FROM custody_session_links
        WHERE scope_id = ? AND operation_id IN (${placeholders})
        ORDER BY operation_id`,
    ).all(...params) as Array<Record<string, unknown>>),
  }
}

function emptyOperationRelations(): CustodyOperationRelations {
  return { inputs: new Map(), verifications: new Map(), sessionLinks: new Map() }
}

function groupOperationRows(
  rows: readonly Record<string, unknown>[],
): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const operationId = requireDatabaseText(row.operation_id, 'custody operation id')
    grouped.set(operationId, [...(grouped.get(operationId) ?? []), row])
  }
  return grouped
}

function assertOperationInputAuthority(
  operationRow: Record<string, unknown>,
  inputRows: readonly Record<string, unknown>[],
): void {
  const expectedCount = operationRow.input_count
  const expectedFingerprint = operationRow.input_authority_fingerprint
  if (typeof expectedCount !== 'number'
    || !Number.isSafeInteger(expectedCount)
    || expectedCount < 1
    || expectedCount !== inputRows.length
    || typeof expectedFingerprint !== 'string'
    || !/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
    throw new Error('custody operation input authority is corrupt')
  }
  const actual = deriveOperationInputAuthority(inputRows.map((row) => ({
    proofId: row.proof_id,
    keysetId: row.keyset_id,
    curve: row.curve,
  })))
  if (actual.fingerprint !== expectedFingerprint) {
    throw new Error('custody operation input authority is corrupt')
  }
}

function deriveOperationInputAuthority(
  inputs: readonly {
    proofId: unknown
    keysetId: unknown
    curve: unknown
  }[],
): { count: number; fingerprint: string } {
  return {
    count: inputs.length,
    fingerprint: deriveDurableCustodyArtifactFingerprint(
      inputs.map((input, position) => ({
        position,
        proofId: input.proofId,
        keysetId: input.keysetId,
        curve: input.curve,
      })),
    ),
  }
}

function decodeSessionLinkRow(row: Record<string, unknown>): unknown {
  return {
    kind: row.link_kind,
    sessionId: row.session_id,
    tradeId: row.trade_id,
    role: row.trade_role,
    stage: row.trade_stage,
    immutableTradeFingerprint: row.immutable_trade_fingerprint,
    hasDependentOperation: decodeDatabaseBoolean(
      row.has_dependent_operation,
      'custody session dependency marker',
    ),
  }
}

function insertOperationRow(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): void {
  persistOperationRow(database, record)
}

function updateOperationRow(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): void {
  persistOperationRow(database, record)
}

function persistOperationRow(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): void {
  const operation = record.operation
  const binding = operation.binding
  const tombstone = record.terminalTombstone
  const inputAuthority = deriveOperationInputAuthority(
    operation.reservation.inputs,
  )
  database
    .prepare(
    `INSERT INTO custody_operations (
      scope_id, operation_id, schema_version, revision, retained_operation_key,
      binding_kind, wallet_activity_id, wallet_stage, semantic_kind, operation_state,
      terminal_replay_evidence_required,
      normalized_mint, unit, inventory_account_id, reservation_id,
      parent_reservation_id,
      input_count, input_authority_fingerprint,
      request_id, request_fingerprint, request_payload_handle, request_output_plan_fingerprint,
      output_plan_id, output_plan_fingerprint, output_material_handle,
      private_material_handle, private_material_use_id, private_material_public_fingerprint,
      result_state, result_handle, result_fingerprint, result_output_plan_fingerprint,
      verification_output_plan_fingerprint, verification_has_outputs,
      delivery_kind, delivery_id, delivery_payload_handle, delivery_payload_fingerprint,
      delivery_expires_at_ms, delivery_state,
      retry_attempt, retry_next_attempt_at_ms, retry_reason,
      not_before_ms, not_after_ms, safety_margin_ms, keyset_expiry_ms,
      tombstone_id, tombstone_trade_id, tombstone_authenticated_terminal, tombstone_replay_cutoff
    ) VALUES (
      ?, ?, 1, ?, ?,
      ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(scope_id, operation_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      revision = excluded.revision,
      retained_operation_key = excluded.retained_operation_key,
      binding_kind = excluded.binding_kind,
      wallet_activity_id = excluded.wallet_activity_id,
      wallet_stage = excluded.wallet_stage,
      semantic_kind = excluded.semantic_kind,
      operation_state = excluded.operation_state,
      terminal_replay_evidence_required = excluded.terminal_replay_evidence_required,
      normalized_mint = excluded.normalized_mint,
      unit = excluded.unit,
      inventory_account_id = excluded.inventory_account_id,
      reservation_id = excluded.reservation_id,
      parent_reservation_id = excluded.parent_reservation_id,
      input_count = excluded.input_count,
      input_authority_fingerprint = excluded.input_authority_fingerprint,
      request_id = excluded.request_id,
      request_fingerprint = excluded.request_fingerprint,
      request_payload_handle = excluded.request_payload_handle,
      request_output_plan_fingerprint = excluded.request_output_plan_fingerprint,
      output_plan_id = excluded.output_plan_id,
      output_plan_fingerprint = excluded.output_plan_fingerprint,
      output_material_handle = excluded.output_material_handle,
      private_material_handle = excluded.private_material_handle,
      private_material_use_id = excluded.private_material_use_id,
      private_material_public_fingerprint = excluded.private_material_public_fingerprint,
      result_state = excluded.result_state,
      result_handle = excluded.result_handle,
      result_fingerprint = excluded.result_fingerprint,
      result_output_plan_fingerprint = excluded.result_output_plan_fingerprint,
      verification_output_plan_fingerprint = excluded.verification_output_plan_fingerprint,
      verification_has_outputs = excluded.verification_has_outputs,
      delivery_kind = excluded.delivery_kind,
      delivery_id = excluded.delivery_id,
      delivery_payload_handle = excluded.delivery_payload_handle,
      delivery_payload_fingerprint = excluded.delivery_payload_fingerprint,
      delivery_expires_at_ms = excluded.delivery_expires_at_ms,
      delivery_state = excluded.delivery_state,
      retry_attempt = excluded.retry_attempt,
      retry_next_attempt_at_ms = excluded.retry_next_attempt_at_ms,
      retry_reason = excluded.retry_reason,
      not_before_ms = excluded.not_before_ms,
      not_after_ms = excluded.not_after_ms,
      safety_margin_ms = excluded.safety_margin_ms,
      keyset_expiry_ms = excluded.keyset_expiry_ms,
      tombstone_id = excluded.tombstone_id,
      tombstone_trade_id = excluded.tombstone_trade_id,
      tombstone_authenticated_terminal = excluded.tombstone_authenticated_terminal,
      tombstone_replay_cutoff = excluded.tombstone_replay_cutoff`,
    )
    .run(
    record.scope.scopeId,
    operation.operationId,
    record.revision,
    operation.retainedOperationKey,
    binding.kind,
    binding.kind === 'wallet' ? binding.activityId : null,
    binding.kind === 'wallet' ? binding.stage : null,
    operation.semanticKind,
    operation.state,
    operation.terminalReplayEvidenceRequired ? 1 : 0,
    operation.custodyContext.normalizedMint,
    operation.custodyContext.unit,
    operation.custodyContext.inventoryAccountId,
    operation.reservation.reservationId,
    operation.reservation.parentReservationId,
    inputAuthority.count,
    inputAuthority.fingerprint,
    operation.exactRequest.requestId,
    operation.exactRequest.requestFingerprint,
    operation.exactRequest.payloadHandle,
    operation.exactRequest.outputPlanFingerprint,
    operation.outputPlan.outputPlanId,
    operation.outputPlan.outputPlanFingerprint,
    operation.outputPlan.outputMaterialHandle,
    operation.privateMaterial.materialHandle,
    operation.privateMaterial.useId,
    operation.privateMaterial.publicFingerprint,
    operation.result.state,
    operation.result.resultHandle,
    operation.result.resultFingerprint,
    operation.result.outputPlanFingerprint,
    operation.verification.outputPlanFingerprint,
    operation.verification.hasOutputs ? 1 : 0,
    operation.delivery.deliveryKind,
    operation.delivery.deliveryId,
    operation.delivery.payloadHandle,
    operation.delivery.payloadFingerprint,
    operation.delivery.expiresAtMs,
    operation.delivery.state,
    operation.retry.attempt,
    operation.retry.nextAttemptAtMs,
    operation.retry.reason,
    operation.horizon.notBeforeMs,
    operation.horizon.notAfterMs,
    operation.horizon.safetyMarginMs,
    operation.horizon.keysetExpiryMs,
    tombstone?.tombstoneId ?? null,
    tombstone?.tradeId ?? null,
    tombstone === null ? null : tombstone.authenticatedTerminalStatus ? 1 : 0,
    tombstone === null ? null : tombstone.replayCutoffObserved ? 1 : 0,
    )
  persistSessionLink(database, record)
  persistOperationInputs(database, record)
  database
    .prepare(
      'DELETE FROM custody_verification_bindings WHERE scope_id = ? AND operation_id = ?',
    )
    .run(record.scope.scopeId, operation.operationId)
  for (const binding of operation.verification.keysetBindings) {
    const isOutput = operation.verification.outputKeysets.some(
      (output) => output.keysetId === binding.keysetId && output.curve === binding.curve,
    )
    database
      .prepare(
      `INSERT INTO custody_verification_bindings (
        scope_id, operation_id, keyset_id, curve, keyset_fingerprint, require_dleq, is_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
      record.scope.scopeId,
      operation.operationId,
      binding.keysetId,
      binding.curve,
      binding.keysetFingerprint,
      binding.requireDleq ? 1 : 0,
      isOutput ? 1 : 0,
      )
  }
}

function persistOperationInputs(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): void {
  const operation = record.operation
  const rows = database
    .prepare(
      `SELECT proof_id, input_position, keyset_id, curve
         FROM custody_operation_inputs
        WHERE scope_id = ? AND operation_id = ?
        ORDER BY input_position`,
    )
    .all(record.scope.scopeId, operation.operationId) as Array<{
    proof_id?: unknown
    input_position?: unknown
    keyset_id?: unknown
    curve?: unknown
  }>
  if (rows.length > 0) {
    if (
      rows.length !== operation.reservation.inputs.length ||
      rows.some((row, position) => {
        const input = operation.reservation.inputs[position]
        return (
          input === undefined ||
          row.proof_id !== input.proofId ||
          row.input_position !== position ||
          row.keyset_id !== input.keysetId ||
          row.curve !== input.curve
        )
      })
    ) {
      throw new Error('custody operation input history is missing or foreign')
    }
    return
  }
  const insert = database.prepare(
    `INSERT INTO custody_operation_inputs (
      scope_id, operation_id, proof_id, input_position, keyset_id, curve
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const [inputPosition, input] of operation.reservation.inputs.entries()) {
    insert.run(
      record.scope.scopeId,
      operation.operationId,
      input.proofId,
      inputPosition,
      input.keysetId,
      input.curve,
    )
  }
}

function synchronizeProofReservationForOperation(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): void {
  if (isDurableCustodyProofReservationActive(record)) return
  database
    .prepare(
      `DELETE FROM custody_proof_reservations
        WHERE scope_id = ? AND operation_id = ?`,
    )
    .run(record.scope.scopeId, record.operation.operationId)
}

function persistSessionLink(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): void {
  if (record.operation.binding.kind === 'wallet') {
    const foreign = database
      .prepare(
        `SELECT session_id FROM custody_session_links
         WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(record.scope.scopeId, record.operation.operationId)
    if (foreign !== undefined) {
      throw new Error('wallet custody operation has a trade session link')
    }
    return
  }
  const link = record.operation.binding
  const existing = readSessionLinkRow(
    database,
    record.scope.scopeId,
    link.sessionId,
    record.operation.operationId,
  )
  if (existing === undefined) {
    database
      .prepare(
        `INSERT INTO custody_session_links (
          scope_id, session_id, operation_id, schema_version, link_kind,
          trade_id, trade_role, trade_stage, immutable_trade_fingerprint,
          has_dependent_operation
        ) VALUES (?, ?, ?, 1, 'trade', ?, ?, ?, ?, ?)`,
      )
      .run(
        record.scope.scopeId,
        link.sessionId,
        record.operation.operationId,
        link.tradeId,
        link.role,
        link.stage,
        link.immutableTradeFingerprint,
        link.hasDependentOperation ? 1 : 0,
      )
    return
  }
  assertSessionLinkMatches(record, existing)
}

function readSessionLinkRow(
  database: DatabaseSync,
  scopeId: string,
  sessionId: string,
  operationId: string,
): Record<string, unknown> | undefined {
  return database
    .prepare(
      `SELECT scope_id, session_id, operation_id, link_kind, trade_id,
              trade_role, trade_stage, immutable_trade_fingerprint,
              has_dependent_operation
         FROM custody_session_links
        WHERE scope_id = ? AND session_id = ? AND operation_id = ?`,
    )
    .get(scopeId, sessionId, operationId) as Record<string, unknown> | undefined
}

function synchronizeActiveWorkIndexForOperation(
  database: DatabaseSync,
  scope: DurableCustodyScope,
  operationId: string,
): void {
  const row = database
    .prepare(
      `SELECT * FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(scope.scopeId, operationId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error('custody operation is missing')
  const record = decodeOperationRow(database, row, scope)
  if (isDurableCustodyActiveRecoveryRecord(record)) {
    database
      .prepare(
        `INSERT INTO custody_active_work (scope_id, operation_id)
         VALUES (?, ?)
         ON CONFLICT(scope_id, operation_id) DO NOTHING`,
      )
      .run(scope.scopeId, operationId)
    return
  }
  database
    .prepare(
      `DELETE FROM custody_active_work
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .run(scope.scopeId, operationId)
}

function assertOperationIntegrity(
  database: DatabaseSync,
  scope: DurableCustodyScope,
  operationId: string,
): void {
  const operationRow = database
    .prepare(
      `SELECT * FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(scope.scopeId, operationId) as Record<string, unknown> | undefined
  if (operationRow === undefined)
    throw new Error('custody operation is missing')
  const record = decodeOperationRow(database, operationRow, scope)

  const sessionRows = database
    .prepare(
      `SELECT session_id, operation_id, link_kind, trade_id, trade_role, trade_stage,
              immutable_trade_fingerprint, has_dependent_operation
         FROM custody_session_links
        WHERE scope_id = ? AND operation_id = ?
        LIMIT 2`,
    )
    .all(scope.scopeId, operationId) as Array<Record<string, unknown>>
  const expectedSessionCount = record.operation.binding.kind === 'trade' ? 1 : 0
  if (sessionRows.length !== expectedSessionCount) {
    throw new Error('custody operation session link is missing or ambiguous')
  }
  if (record.operation.binding.kind === 'trade') {
    assertSessionLinkMatches(record, sessionRows[0])
  }

  const reservationRows = database
    .prepare(
      `SELECT proof_id, reservation_id, input_position, keyset_id, curve
         FROM custody_proof_reservations
        WHERE scope_id = ? AND operation_id = ?
        ORDER BY proof_id`,
    )
    .all(scope.scopeId, operationId) as Array<Record<string, unknown>>
  const expectedInputs = isDurableCustodyProofReservationActive(record)
    ? record.operation.reservation.inputs
    : []
  const expectedProofIds = expectedInputs.map((proof) => proof.proofId)
  if (
    !sameUnorderedStringValues(
      expectedProofIds,
      reservationRows.map((row) => row.proof_id),
    ) ||
    reservationRows.some(
      (row) =>
        row.reservation_id !== record.operation.reservation.reservationId,
    )
  ) {
    throw new Error('custody operation reservation is missing or foreign')
  }
  for (const reservation of reservationRows) {
    const expectedInput = expectedInputs.find(
      (input) => input.proofId === reservation.proof_id,
    )
    if (
      expectedInput === undefined ||
      reservation.input_position !==
        expectedInputs.indexOf(expectedInput) ||
      reservation.keyset_id !== expectedInput.keysetId ||
      reservation.curve !== expectedInput.curve
    ) {
      throw new Error('custody operation reservation is missing or foreign')
    }
  }

  const activeRow = database
    .prepare(
      `SELECT operation_id FROM custody_active_work
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(scope.scopeId, operationId) as { operation_id?: unknown } | undefined
  if ((activeRow !== undefined) !== isDurableCustodyActiveRecoveryRecord(record)) {
    throw new Error('custody active-work index is missing or stale')
  }
}

function rebuildActiveWorkIndex(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): void {
  database
    .prepare('DELETE FROM custody_active_work WHERE scope_id = ?')
    .run(scope.scopeId)
  const rows = database
    .prepare(
      `SELECT * FROM custody_operations
     WHERE scope_id = ? ORDER BY operation_id`,
    )
    .all(scope.scopeId) as Array<Record<string, unknown>>
  for (const row of rows) {
    const record = decodeOperationRow(database, row, scope)
    if (!isDurableCustodyActiveRecoveryRecord(record)) continue
    database
      .prepare(
        `INSERT INTO custody_active_work (scope_id, operation_id) VALUES (?, ?)`,
      )
      .run(scope.scopeId, record.operation.operationId)
  }
}

function assertScopeIntegrity(
  database: DatabaseSync,
  scope: DurableCustodyScope,
): void {
  const operationRows = database
    .prepare(
      `SELECT * FROM custody_operations
     WHERE scope_id = ? ORDER BY operation_id`,
    )
    .all(scope.scopeId) as Array<Record<string, unknown>>
  const records = operationRows.map((row) =>
    decodeOperationRow(database, row, scope),
  )
  const recordsByOperation = new Map(
    records.map((record) => [record.operation.operationId, record]),
  )
  const sessionRows = database
    .prepare(
      `SELECT session_id, operation_id, link_kind, trade_id, trade_role, trade_stage,
              immutable_trade_fingerprint, has_dependent_operation
       FROM custody_session_links
     WHERE scope_id = ?`,
    )
    .all(scope.scopeId) as Array<{
    session_id?: unknown
    operation_id?: unknown
    link_kind?: unknown
    trade_id?: unknown
    trade_role?: unknown
    trade_stage?: unknown
    immutable_trade_fingerprint?: unknown
    has_dependent_operation?: unknown
  }>
  const sessionsByOperation = new Map<
    string,
    {
      session_id?: unknown
      link_kind?: unknown
      trade_id?: unknown
      trade_role?: unknown
      trade_stage?: unknown
      immutable_trade_fingerprint?: unknown
      has_dependent_operation?: unknown
    }
  >()
  for (const row of sessionRows) {
    if (
      typeof row.operation_id !== 'string' ||
      typeof row.session_id !== 'string'
    ) {
      throw new Error('custody session link row is corrupt')
    }
    const record = recordsByOperation.get(row.operation_id)
    if (record === undefined || record.operation.binding.kind !== 'trade'
      || record.operation.binding.sessionId !== row.session_id) {
      throw new Error('custody session link is foreign')
    }
    assertSessionLinkMatches(record, row)
    if (sessionsByOperation.has(row.operation_id))
      throw new Error('custody operation has multiple session links')
    sessionsByOperation.set(row.operation_id, row)
  }

  const reservationRows = database
    .prepare(
      `SELECT proof_id, operation_id, reservation_id, input_position, keyset_id, curve
         FROM custody_proof_reservations
     WHERE scope_id = ?`,
    )
    .all(scope.scopeId) as Array<{
    proof_id?: unknown
    operation_id?: unknown
    reservation_id?: unknown
    input_position?: unknown
    keyset_id?: unknown
    curve?: unknown
  }>
  const reservationsByOperation = new Map<
    string,
    Array<{
      proof_id?: unknown
      reservation_id?: unknown
      input_position?: unknown
      keyset_id?: unknown
      curve?: unknown
    }>
  >()
  for (const row of reservationRows) {
    if (
      typeof row.operation_id !== 'string' ||
      typeof row.proof_id !== 'string'
    ) {
      throw new Error('custody proof reservation row is corrupt')
    }
    const entries = reservationsByOperation.get(row.operation_id) ?? []
    entries.push(row)
    reservationsByOperation.set(row.operation_id, entries)
  }

  const indexedRows = database
    .prepare('SELECT operation_id FROM custody_active_work WHERE scope_id = ?')
    .all(scope.scopeId) as Array<{ operation_id?: unknown }>
  const indexed = new Set(
    indexedRows.map((row) => {
      if (typeof row.operation_id !== 'string')
        throw new Error('custody active-work row is corrupt')
      return row.operation_id
    }),
  )

  for (const record of records) {
    const operationId = record.operation.operationId
    if (sessionsByOperation.has(operationId) !== (record.operation.binding.kind === 'trade')) {
      throw new Error('custody operation session link is missing')
    }
    const reservations = reservationsByOperation.get(operationId) ?? []
    const expectedInputs = isDurableCustodyProofReservationActive(record)
      ? record.operation.reservation.inputs
      : []
    const expectedProofIds = expectedInputs.map((proof) => proof.proofId)
    if (
      !sameUnorderedStringValues(
        expectedProofIds,
        reservations.map((row) => row.proof_id),
      ) ||
      reservations.some(
        (row) =>
          row.reservation_id !== record.operation.reservation.reservationId,
      )
    ) {
      throw new Error('custody operation reservation is missing or foreign')
    }
    for (const reservation of reservations) {
      const expectedInput = expectedInputs.find(
        (input) => input.proofId === reservation.proof_id,
      )
      if (
        expectedInput === undefined ||
        reservation.input_position !==
          expectedInputs.indexOf(expectedInput) ||
        reservation.keyset_id !== expectedInput.keysetId ||
        reservation.curve !== expectedInput.curve
      ) {
        throw new Error('custody operation reservation is missing or foreign')
      }
    }
    if (indexed.has(operationId) !== isDurableCustodyActiveRecoveryRecord(record)) {
      throw new Error('custody active-work index is missing or stale')
    }
    indexed.delete(operationId)
  }
  if (indexed.size !== 0)
    throw new Error('custody active-work index is foreign')
}

function authorizeScopeOwner(
  state: DurableCustodyScopeState,
  owner: DurableCustodyOwnerAuthorization,
): DurableCustodyScopeState {
  if (state.owner === null) throw new Error('custody scope is unclaimed')
  if (
    state.owner.incarnationId !== owner.incarnationId ||
    state.fencingEpoch !== owner.fencingEpoch
  ) {
    throw new Error('custody owner epoch is foreign')
  }
  const effectiveNowMs = Math.max(
    state.effectiveClock.highWaterMarkMs,
    owner.observedAtMs,
  )
  if (effectiveNowMs >= state.owner.leaseExpiresAtMs) {
    throw new Error('custody owner lease has expired')
  }
  const next = structuredClone(state)
  next.effectiveClock.highWaterMarkMs = effectiveNowMs
  return next
}

function assertInitialOperation(record: DurableCustodyRecord): void {
  if (
    record.revision !== 0 ||
    record.operation.state !== 'dispatch-intent' ||
    record.operation.result.state !== 'none' ||
    record.operation.delivery.deliveryKind !== 'none' ||
    record.operation.retry.attempt !== 0 ||
    record.operation.retry.nextAttemptAtMs !== null ||
    record.operation.retry.reason !== 'none' ||
    record.terminalTombstone !== null
  ) {
    throw new Error('new custody operation is not a dispatch intent')
  }
}

function assertOperationMutation(
  previous: DurableCustodyRecord,
  next: DurableCustodyRecord,
): void {
  if (!sameImmutableOperation(previous, next)) {
    throw new Error('custody operation immutable bindings changed')
  }
  if (next.revision !== previous.revision + 1) {
    throw new Error('custody operation revision is not monotonic')
  }
}

function sameImmutableOperation(
  left: DurableCustodyRecord,
  right: DurableCustodyRecord,
): boolean {
  return isDeepStrictEqual(
    {
      scope: left.scope,
      operation: {
        operationId: left.operation.operationId,
        retainedOperationKey: left.operation.retainedOperationKey,
        binding: left.operation.binding,
        semanticKind: left.operation.semanticKind,
        terminalReplayEvidenceRequired:
          left.operation.terminalReplayEvidenceRequired,
        custodyContext: left.operation.custodyContext,
        reservation: left.operation.reservation,
        exactRequest: left.operation.exactRequest,
        outputPlan: left.operation.outputPlan,
        privateMaterial: left.operation.privateMaterial,
        verification: left.operation.verification,
      },
    },
    {
      scope: right.scope,
      operation: {
        operationId: right.operation.operationId,
        retainedOperationKey: right.operation.retainedOperationKey,
        binding: right.operation.binding,
        semanticKind: right.operation.semanticKind,
        terminalReplayEvidenceRequired:
          right.operation.terminalReplayEvidenceRequired,
        custodyContext: right.operation.custodyContext,
        reservation: right.operation.reservation,
        exactRequest: right.operation.exactRequest,
        outputPlan: right.operation.outputPlan,
        privateMaterial: right.operation.privateMaterial,
        verification: right.operation.verification,
      },
    },
  )
}

function assertDeliveryKind(
  value: unknown,
): asserts value is 'cipher' | 'settlement' | 'wallet-send' {
  switch (value) {
    case 'cipher':
    case 'settlement':
    case 'wallet-send':
      return
    default:
      throw new Error('outbox delivery kind is invalid')
  }
}

function assertOperationTransition(
  value: DurableCustodyOperationTransition,
): void {
  switch (value.kind) {
    case 'transport-attempted':
    case 'retry-scheduled':
    case 'verified-result-staged':
    case 'abort-no-transport':
    case 'reconciled':
    case 'delivery-resolved':
    case 'terminal-tombstone-created':
    case 'terminal-tombstone-confirmed':
      return
    default:
      throw new Error('durable custody operation transition is invalid')
  }
}

function assertSessionLinkMatches(
  record: DurableCustodyRecord,
  row: unknown,
): void {
  if (!sameSessionLinkRow(requireTradeBinding(record), row)) {
    throw new Error('custody session link is foreign')
  }
}

function sameSessionLink(
  left: Extract<DurableCustodyBinding, { kind: 'trade' }>,
  right: unknown,
): boolean {
  if (typeof right !== 'object' || right === null || Array.isArray(right))
    return false
  const candidate = right as Record<string, unknown>
  return (
    candidate.kind === left.kind &&
    candidate.sessionId === left.sessionId &&
    candidate.tradeId === left.tradeId &&
    candidate.role === left.role &&
    candidate.stage === left.stage &&
    candidate.immutableTradeFingerprint === left.immutableTradeFingerprint &&
    candidate.hasDependentOperation === left.hasDependentOperation &&
    Object.keys(candidate).length === 7
  )
}

function sameSessionLinkRow(
  left: Extract<DurableCustodyBinding, { kind: 'trade' }>,
  right: unknown,
): boolean {
  if (typeof right !== 'object' || right === null || Array.isArray(right)) {
    return false
  }
  const row = right as Record<string, unknown>
  return (
    row.link_kind === left.kind &&
    row.session_id === left.sessionId &&
    row.trade_id === left.tradeId &&
    row.trade_role === left.role &&
    row.trade_stage === left.stage &&
    row.immutable_trade_fingerprint === left.immutableTradeFingerprint &&
    decodeDatabaseBoolean(
      row.has_dependent_operation,
      'custody session dependency marker',
    ) === left.hasDependentOperation
  )
}

function requireTradeBinding(
  record: DurableCustodyRecord,
): Extract<DurableCustodyBinding, { kind: 'trade' }> {
  if (record.operation.binding.kind !== 'trade') {
    throw new Error('custody operation requires trade binding')
  }
  return record.operation.binding
}

function sameOwner(
  left: DurableCustodyScopeState['owner'],
  right: DurableCustodyScopeState['owner'],
): boolean {
  return (
    left?.incarnationId === right?.incarnationId &&
    left?.leaseExpiresAtMs === right?.leaseExpiresAtMs
  )
}

function sameOrderedValues(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
  )
}

function sameUnorderedStringValues(
  expected: readonly string[],
  actual: readonly unknown[],
): boolean {
  if (expected.length !== actual.length) return false
  const expectedValues = [...expected].sort()
  const actualValues = actual
    .map((value) => {
      if (typeof value !== 'string')
        throw new Error('custody row contains an invalid identifier')
      return value
    })
    .sort()
  return expectedValues.every((value, index) => value === actualValues[index])
}

function requireDatabaseText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is corrupt`)
  }
  return value
}

function decodeDatabaseBoolean(value: unknown, name: string): boolean {
  switch (value) {
    case 0:
      return false
    case 1:
      return true
    default:
      throw new Error(`${name} is corrupt`)
  }
}

function inImmediateTransaction<T>(database: DatabaseSync, apply: () => T): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = apply()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The transaction may already have completed after an external fault.
    }
    throw error
  }
}
