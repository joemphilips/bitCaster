/**
 * Persistence-neutral storage accounting for custody admission. These values
 * are conservative client accounting/headroom targets, never browser quota
 * guarantees. Only a later successful adapter transaction proves writability.
 */

import {
  decodeDurableCustodyOperationId,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeId,
  decodeDurableCustodyScopeState,
  decideTerminalTombstoneDrain,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
} from './durableCustody.ts'

export const DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION = 1 as const
export const DURABLE_STORAGE_OPERATION_LIMIT_MAX = 256 as const
export const DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX = 256 as const
export const DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX = 64 * 1_024
export const DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX = 4_096
export const DURABLE_STORAGE_SWAP_BYTES_LIMIT_MAX = 16 * 1_024 * 1_024
export const DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX =
  1 + (4 * DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX)
export const DURABLE_STORAGE_OPERATION_BYTES_LIMIT_MAX = 5 * DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX
export const DURABLE_STORAGE_MAINTENANCE_ROW_LIMIT_MAX = 256 as const
export const DURABLE_STORAGE_MAINTENANCE_BYTES_LIMIT_MAX = 1 * 1_024 * 1_024
export const DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX = 64 * 1_024
export const DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES =
  DURABLE_STORAGE_MAINTENANCE_BYTES_LIMIT_MAX + DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX

export interface DurableStorageComponentBudget {
  count: number
  bytes: number
}

export interface DurableSwapStorageBudgetInput {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  scopeId: string
  swapId: string
  session: DurableStorageComponentBudget
  operations: Array<{
    semanticOperationId: string
    exactOperation: DurableStorageComponentBudget
    proofReferences: DurableStorageComponentBudget
    privateMaterial: DurableStorageComponentBudget
    ciphers: DurableStorageComponentBudget
    transitionOverhead: DurableStorageComponentBudget
  }>
}

export interface DurableSwapStorageBudget {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  scopeId: string
  swapId: string
  session: DurableStorageComponentBudget
  operations: Array<DurableSwapStorageBudgetInput['operations'][number] & {
    artifactCount: number
    bytes: number
  }>
  totalArtifactCount: number
  totalBytes: number
  /** The adapter must persist the intent and reservation in one real transaction. */
  requiresAtomicAdapterTransaction: true
  /** IndexedDB and other physical stores expose no reservation guarantee. */
  isBrowserQuotaGuarantee: false
}

export interface DurableStorageReservationPlan {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  scopeId: string
  reservationId: string
  swapId: string
  sharedArtifactCount: number
  sharedBytes: number
  totalArtifactCount: number
  totalBytes: number
  operations: Array<{
    semanticOperationId: string
    artifactCount: number
    bytes: number
    state: 'reserved' | 'consumed'
  }>
  requiresAtomicAdapterTransaction: true
  isBrowserQuotaGuarantee: false
}

export interface DurableStorageMaintenanceCursor {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  cursor: string | null
  examinedRows: number
  examinedBytes: number
}

export interface DurableStoragePinReference {
  pinId: string
  proofId: string
  reason: 'proof-operation' | 'open-order-collateral'
  referenceId: string
}

export interface DurableStorageReleaseEvidence {
  readonly scopeId: string
  readonly semanticOperationId: string
  readonly disposition: 'safe-abort' | 'terminal-purge'
}

interface AuthorizedDurableStorageReleaseEvidence extends DurableStorageReleaseEvidence {
  readonly proofIds: readonly string[]
}

const durableStorageReleaseEvidenceAuthority = new WeakMap<
  object,
  AuthorizedDurableStorageReleaseEvidence
>()

export interface DurableStorageAccountingState {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  revision: number
  scopeId: string
  accountingLimitBytes: number
  accountedBytes: number
  emergencyHeadroom: {
    recordId: 'durable-storage-emergency-headroom'
    targetBytes: typeof DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES
    state: 'ready' | 'released-for-maintenance'
  }
  reservations: DurableStorageReservationPlan[]
  pinReferences: DurableStoragePinReference[]
  maintenanceCursor: DurableStorageMaintenanceCursor | null
}

export type DurableStorageAccountingTransition =
  | {
    kind: 'reserve-multi-fill'
    expectedRevision: number
    reservation: DurableStorageReservationPlan
  }
  | {
    kind: 'consume-operation'
    expectedRevision: number
    reservationId: string
    semanticOperationId: string
  }
  | {
    kind: 'release-operation'
    expectedRevision: number
    reservationId: string
    evidence: DurableStorageReleaseEvidence
  }
  | { kind: 'release-emergency-headroom'; expectedRevision: number; reason: 'quota-recovery' }
  | { kind: 'restore-emergency-headroom'; expectedRevision: number }
  | { kind: 'add-pin-reference'; expectedRevision: number; pin: DurableStoragePinReference }
  | {
    kind: 'release-pin-reference'
    expectedRevision: number
    pinId: string
    evidence: DurableStorageReleaseEvidence
  }
  | {
    kind: 'advance-maintenance-cursor'
    expectedRevision: number
    cursor: DurableStorageMaintenanceCursor | null
  }

export function createDurableStorageReleaseEvidence(
  recordValue: DurableCustodyRecord,
  scopeStateValue?: DurableCustodyScopeState,
): DurableStorageReleaseEvidence {
  const record = decodeDurableCustodyRecord(recordValue)
  const scopeId = record.scope.scopeId
  const semanticOperationId = record.operation.operationId
  let disposition: DurableStorageReleaseEvidence['disposition']
  if (record.operation.state === 'aborted') {
    disposition = 'safe-abort'
  } else {
    if (record.operation.state !== 'reconciled') throw new Error('custody is not releasable')
    if (scopeStateValue === undefined) throw new Error('custody scope state is required for terminal release')
    const scopeState = decodeDurableCustodyScopeState(scopeStateValue, record.scope)
    if (decideTerminalTombstoneDrain(record, scopeState).kind !== 'delete') {
      throw new Error('terminal custody must be retained')
    }
    disposition = 'terminal-purge'
  }
  const evidence = Object.freeze({
    scopeId,
    semanticOperationId,
    disposition,
  })
  durableStorageReleaseEvidenceAuthority.set(evidence, Object.freeze({
    scopeId,
    semanticOperationId,
    disposition,
    proofIds: Object.freeze(record.operation.reservation.inputs.map((input) => input.proofId)),
  }))
  return evidence
}

export function calculateDurableSwapStorageBudget(
  inputValue: DurableSwapStorageBudgetInput,
): DurableSwapStorageBudget {
  const input = requireRecord(inputValue, 'durable swap storage budget input')
  requireKnownFields(input, ['schemaVersion', 'scopeId', 'swapId', 'session', 'operations'])
  requireSchemaVersion(input.schemaVersion)
  const scopeId = decodeDurableCustodyScopeId(input.scopeId)
  const swapId = requireIdentifier(input.swapId, 'swap id')
  const session = decodeComponent(input.session, 'session', { exactCount: 1 })
  const rawOperations = requireArray(input.operations, 'storage budget operations')
  if (rawOperations.length === 0 || rawOperations.length > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error('storage budget operation count exceeds the limit')
  }
  const operations = rawOperations.map((value) => decodeOperationBudget(value, scopeId))
  const operationIds = new Set(operations.map((operation) => operation.semanticOperationId))
  if (operationIds.size !== operations.length) throw new Error('semantic operation id is duplicated')

  let totalArtifactCount = session.count
  let totalBytes = session.bytes
  for (const operation of operations) {
    totalArtifactCount = safeAdd(totalArtifactCount, operation.artifactCount, 'storage artifact count')
    totalBytes = safeAdd(totalBytes, operation.bytes, 'storage budget bytes')
  }
  if (totalArtifactCount > DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX) {
    throw new Error('storage artifact count exceeds the limit')
  }
  if (totalBytes > DURABLE_STORAGE_SWAP_BYTES_LIMIT_MAX) {
    throw new Error('storage budget bytes exceed the limit')
  }
  const budget: DurableSwapStorageBudget = {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId,
    swapId,
    session,
    operations,
    totalArtifactCount,
    totalBytes,
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
  requireEncodedRecordLimit(budget, 'durable swap storage budget')
  return budget
}

export function createDurableStorageReservationPlan(inputValue: {
  reservationId: string
  budget: DurableSwapStorageBudget
}): DurableStorageReservationPlan {
  const input = requireRecord(inputValue, 'storage reservation plan input')
  requireKnownFields(input, ['reservationId', 'budget'])
  const budget = decodeDurableSwapStorageBudget(input.budget)
  const reservation: DurableStorageReservationPlan = {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId: budget.scopeId,
    reservationId: requireIdentifier(input.reservationId, 'storage reservation id'),
    swapId: budget.swapId,
    sharedArtifactCount: budget.session.count,
    sharedBytes: budget.session.bytes,
    totalArtifactCount: budget.totalArtifactCount,
    totalBytes: budget.totalBytes,
    operations: budget.operations.map((operation) => ({
      semanticOperationId: operation.semanticOperationId,
      artifactCount: operation.artifactCount,
      bytes: operation.bytes,
      state: 'reserved',
    })),
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
  requireEncodedRecordLimit(reservation, 'storage reservation')
  return reservation
}

export function createDurableStorageAccountingState(inputValue: {
  scopeId: string
  accountingLimitBytes: number
}): DurableStorageAccountingState {
  const input = requireRecord(inputValue, 'storage accounting state input')
  requireKnownFields(input, ['scopeId', 'accountingLimitBytes'])
  const accountingLimitBytes = requireNonNegativeInteger(
    input.accountingLimitBytes,
    'storage accounting limit',
  )
  if (accountingLimitBytes < DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES) {
    throw new Error('storage accounting limit cannot hold emergency headroom')
  }
  const state: DurableStorageAccountingState = {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    revision: 0,
    scopeId: decodeDurableCustodyScopeId(input.scopeId),
    accountingLimitBytes,
    accountedBytes: 0,
    emergencyHeadroom: {
      recordId: 'durable-storage-emergency-headroom',
      targetBytes: DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
      state: 'ready',
    },
    reservations: [],
    pinReferences: [],
    maintenanceCursor: null,
  }
  requireEncodedRecordLimit(state, 'durable storage accounting state')
  return state
}

export function reduceDurableStorageAccountingState(
  stateValue: DurableStorageAccountingState,
  transitionValue: DurableStorageAccountingTransition,
): DurableStorageAccountingState {
  const state = decodeDurableStorageAccountingState(stateValue)
  const transition = requireRecord(transitionValue, 'storage accounting transition')
  const kind = requireIdentifier(transition.kind, 'storage accounting transition kind')
  const expectedRevision = requireNonNegativeInteger(transition.expectedRevision, 'expected storage revision')
  if (expectedRevision !== state.revision) throw new Error('storage accounting revision is stale')

  switch (kind) {
    case 'reserve-multi-fill': {
      requireKnownFields(transition, ['kind', 'expectedRevision', 'reservation'])
      if (state.emergencyHeadroom.state !== 'ready') throw new Error('emergency headroom is unavailable')
      const reservation = decodeDurableStorageReservationPlan(transition.reservation)
      if (reservation.scopeId !== state.scopeId) throw new Error('storage reservation scope is foreign')
      if (state.reservations.some((existing) => existing.reservationId === reservation.reservationId)) {
        throw new Error('storage reservation id is duplicated')
      }
      const activeOperationIds = new Set(state.reservations.flatMap((existing) =>
        existing.operations.map((operation) => operation.semanticOperationId)))
      if (reservation.operations.some((operation) => activeOperationIds.has(operation.semanticOperationId))) {
        throw new Error('semantic operation is already reserved')
      }
      if (activeOperationIds.size + reservation.operations.length > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
        throw new Error('active semantic operation count exceeds the limit')
      }
      const accountedBytes = safeAdd(state.accountedBytes, reservation.totalBytes, 'accounted storage bytes')
      const requiredBytes = safeAdd(
        accountedBytes,
        state.emergencyHeadroom.targetBytes,
        'accounted storage and headroom bytes',
      )
      if (requiredBytes > state.accountingLimitBytes) throw new Error('storage accounting capacity is insufficient')
      return nextState(state, { reservations: [...state.reservations, reservation], accountedBytes })
    }
    case 'consume-operation':
    case 'release-operation': {
      requireKnownFields(
        transition,
        kind === 'consume-operation'
          ? ['kind', 'expectedRevision', 'reservationId', 'semanticOperationId']
          : ['kind', 'expectedRevision', 'reservationId', 'evidence'],
      )
      const reservationId = requireIdentifier(transition.reservationId, 'storage reservation id')
      const evidence = kind === 'release-operation' ? requireReleaseEvidence(transition.evidence) : null
      const semanticOperationId = kind === 'consume-operation'
        ? decodeDurableCustodyOperationId(transition.semanticOperationId, state.scopeId)
        : evidence!.semanticOperationId
      if (evidence !== null && evidence.scopeId !== state.scopeId) {
        throw new Error('storage release evidence scope is foreign')
      }
      const reservationIndex = state.reservations.findIndex((item) => item.reservationId === reservationId)
      if (reservationIndex < 0) throw new Error('storage reservation is missing')
      const reservation = state.reservations[reservationIndex]!
      const operationIndex = reservation.operations.findIndex(
        (operation) => operation.semanticOperationId === semanticOperationId,
      )
      if (operationIndex < 0) throw new Error('semantic operation reservation is missing')
      const operation = reservation.operations[operationIndex]!
      if (kind === 'consume-operation') {
        if (operation.state !== 'reserved') throw new Error('semantic operation is already consumed')
        const operations = reservation.operations.map((item, index) =>
          index === operationIndex ? { ...item, state: 'consumed' as const } : item)
        const reservations = state.reservations.map((item, index) =>
          index === reservationIndex ? { ...item, operations } : item)
        return nextState(state, { reservations })
      }
      if (evidence!.disposition === 'safe-abort' && operation.state !== 'reserved') {
        throw new Error('safe-abort release requires reserved accounting')
      }
      if (evidence!.disposition === 'terminal-purge' && operation.state !== 'consumed') {
        throw new Error('terminal purge release requires consumed accounting')
      }
      const operations = reservation.operations.filter((_, index) => index !== operationIndex)
      const reservations = operations.length === 0
        ? state.reservations.filter((_, index) => index !== reservationIndex)
        : state.reservations.map((item, index) => index === reservationIndex
          ? {
            ...item,
            operations,
            totalArtifactCount: item.totalArtifactCount - operation.artifactCount,
            totalBytes: item.totalBytes - operation.bytes,
          }
          : item)
      return nextState(state, {
        reservations,
        accountedBytes: state.accountedBytes - operation.bytes
          - (operations.length === 0 ? reservation.sharedBytes : 0),
      })
    }
    case 'release-emergency-headroom':
      requireKnownFields(transition, ['kind', 'expectedRevision', 'reason'])
      if (transition.reason !== 'quota-recovery') throw new Error('headroom release reason is invalid')
      if (state.emergencyHeadroom.state !== 'ready') throw new Error('emergency headroom is not ready')
      return nextState(state, {
        emergencyHeadroom: { ...state.emergencyHeadroom, state: 'released-for-maintenance' },
      })
    case 'restore-emergency-headroom': {
      requireKnownFields(transition, ['kind', 'expectedRevision'])
      if (state.emergencyHeadroom.state !== 'released-for-maintenance') {
        throw new Error('emergency headroom is not released')
      }
      if (safeAdd(state.accountedBytes, state.emergencyHeadroom.targetBytes, 'headroom restore bytes')
        > state.accountingLimitBytes) {
        throw new Error('storage accounting capacity cannot restore emergency headroom')
      }
      return nextState(state, { emergencyHeadroom: { ...state.emergencyHeadroom, state: 'ready' } })
    }
    case 'add-pin-reference': {
      requireKnownFields(transition, ['kind', 'expectedRevision', 'pin'])
      const pin = decodePinReference(transition.pin, state.scopeId)
      const sameId = state.pinReferences.find((existing) => existing.pinId === pin.pinId)
      if (sameId !== undefined) {
        // Exact retry is a semantic no-op: it returns the decoded state at the same revision.
        if (sameId.proofId === pin.proofId && sameId.reason === pin.reason
          && sameId.referenceId === pin.referenceId) return state
        throw new Error('storage pin id is duplicated')
      }
      if (state.pinReferences.some((existing) => existing.proofId === pin.proofId)) {
        throw new Error('proof already has an active storage pin')
      }
      if (state.pinReferences.length >= DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX) {
        throw new Error('storage pin reference count exceeds the limit')
      }
      return nextState(state, { pinReferences: [...state.pinReferences, pin] })
    }
    case 'release-pin-reference': {
      requireKnownFields(transition, ['kind', 'expectedRevision', 'pinId', 'evidence'])
      const pinId = requireIdentifier(transition.pinId, 'storage pin id')
      const pin = state.pinReferences.find((candidate) => candidate.pinId === pinId)
      if (pin === undefined) throw new Error('storage pin is missing')
      if (pin.reason === 'open-order-collateral') {
        throw new Error('open-order collateral release authority is unavailable')
      }
      const evidence = requireReleaseEvidence(transition.evidence)
      if (evidence.scopeId !== state.scopeId) throw new Error('pin release scope is foreign')
      if (evidence.semanticOperationId !== pin.referenceId) {
        throw new Error('pin release operation is foreign')
      }
      if (!evidence.proofIds.includes(pin.proofId)) throw new Error('pin release proof is foreign')
      return nextState(state, { pinReferences: state.pinReferences.filter((pin) => pin.pinId !== pinId) })
    }
    case 'advance-maintenance-cursor':
      requireKnownFields(transition, ['kind', 'expectedRevision', 'cursor'])
      return nextState(state, {
        maintenanceCursor: transition.cursor === null
          ? null
          : decodeDurableStorageMaintenanceCursor(
            transition.cursor,
            state.maintenanceCursor?.cursor ?? null,
          ),
      })
    default:
      throw new Error('storage accounting transition kind is invalid')
  }
}

export function decodeDurableStorageMaintenanceCursor(
  value: unknown,
  previousCursor: string | null = null,
): DurableStorageMaintenanceCursor {
  const cursor = requireRecord(value, 'storage maintenance cursor')
  requireKnownFields(cursor, ['schemaVersion', 'cursor', 'examinedRows', 'examinedBytes'])
  requireSchemaVersion(cursor.schemaVersion)
  const examinedRows = requireNonNegativeInteger(cursor.examinedRows, 'maintenance row count')
  const examinedBytes = requireNonNegativeInteger(cursor.examinedBytes, 'maintenance byte count')
  if (examinedRows > DURABLE_STORAGE_MAINTENANCE_ROW_LIMIT_MAX) {
    throw new Error('maintenance row count exceeds the limit')
  }
  if (examinedBytes > DURABLE_STORAGE_MAINTENANCE_BYTES_LIMIT_MAX) {
    throw new Error('maintenance byte count exceeds the limit')
  }
  const nextCursor = cursor.cursor === null ? null : requireIdentifier(cursor.cursor, 'maintenance cursor')
  if (nextCursor !== null && nextCursor === previousCursor) {
    throw new Error('maintenance cursor did not advance')
  }
  if (nextCursor !== null && examinedRows === 0 && examinedBytes === 0) {
    throw new Error('maintenance continuation has no progress')
  }
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    cursor: nextCursor,
    examinedRows,
    examinedBytes,
  }
}

export function decodeDurableStorageAccountingState(value: unknown): DurableStorageAccountingState {
  requireEncodedRecordLimit(value, 'durable storage accounting state')
  const state = requireRecord(value, 'durable storage accounting state')
  requireKnownFields(state, [
    'schemaVersion', 'revision', 'scopeId', 'accountingLimitBytes', 'accountedBytes',
    'emergencyHeadroom', 'reservations', 'pinReferences', 'maintenanceCursor',
  ])
  requireSchemaVersion(state.schemaVersion, 'unsupported durable storage accounting schema version')
  const scopeId = decodeDurableCustodyScopeId(state.scopeId)
  const emergencyHeadroom = decodeEmergencyHeadroom(state.emergencyHeadroom)
  const reservations = requireArray(state.reservations, 'storage reservations').map(
    (reservation) => decodeDurableStorageReservationPlan(reservation, scopeId),
  )
  if (reservations.length > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error('storage reservation count exceeds the limit')
  }
  if (reservations.some((reservation) => reservation.scopeId !== scopeId)) {
    throw new Error('storage reservation scope is foreign')
  }
  const pinReferences = requireArray(state.pinReferences, 'storage pin references').map(
    (pin) => decodePinReference(pin, scopeId),
  )
  if (pinReferences.length > DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX) {
    throw new Error('storage pin reference count exceeds the limit')
  }
  if (new Set(reservations.map((reservation) => reservation.reservationId)).size !== reservations.length) {
    throw new Error('storage reservation id is duplicated')
  }
  const operationIds = reservations.flatMap((reservation) =>
    reservation.operations.map((operation) => operation.semanticOperationId))
  if (operationIds.length > DURABLE_STORAGE_OPERATION_LIMIT_MAX
    || new Set(operationIds).size !== operationIds.length) {
    throw new Error('active semantic operation id is duplicated or exceeds the limit')
  }
  if (new Set(pinReferences.map((pin) => pin.pinId)).size !== pinReferences.length) {
    throw new Error('storage pin id is duplicated')
  }
  if (new Set(pinReferences.map((pin) => pin.proofId)).size !== pinReferences.length) {
    throw new Error('proof already has an active storage pin')
  }
  const pinIdentities = pinReferences.map((pin) => `${pin.proofId}:${pin.reason}:${pin.referenceId}`)
  if (new Set(pinIdentities).size !== pinIdentities.length) {
    throw new Error('storage pin reference identity is duplicated')
  }
  const accountedBytes = requireNonNegativeInteger(state.accountedBytes, 'accounted storage bytes')
  const derivedAccountedBytes = reservations.reduce(
    (total, reservation) => safeAdd(total, reservation.totalBytes, 'accounted storage bytes'),
    0,
  )
  if (accountedBytes !== derivedAccountedBytes) throw new Error('accounted storage bytes are inconsistent')
  const accountingLimitBytes = requireNonNegativeInteger(state.accountingLimitBytes, 'storage accounting limit')
  if (accountedBytes > accountingLimitBytes) throw new Error('accounted storage bytes exceed the limit')
  if (emergencyHeadroom.state === 'ready'
    && safeAdd(accountedBytes, emergencyHeadroom.targetBytes, 'accounted storage and headroom bytes')
      > accountingLimitBytes) {
    throw new Error('ready emergency headroom exceeds the accounting limit')
  }
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    revision: requireNonNegativeInteger(state.revision, 'storage accounting revision'),
    scopeId,
    accountingLimitBytes,
    accountedBytes,
    emergencyHeadroom,
    reservations,
    pinReferences,
    maintenanceCursor: state.maintenanceCursor === null
      ? null
      : decodeDurableStorageMaintenanceCursor(state.maintenanceCursor),
  }
}

function decodeDurableSwapStorageBudget(value: unknown): DurableSwapStorageBudget {
  requireEncodedRecordLimit(value, 'durable swap storage budget')
  const budget = requireRecord(value, 'durable swap storage budget')
  requireKnownFields(budget, [
    'schemaVersion', 'scopeId', 'swapId', 'session', 'operations', 'totalArtifactCount', 'totalBytes',
    'requiresAtomicAdapterTransaction', 'isBrowserQuotaGuarantee',
  ])
  if (budget.requiresAtomicAdapterTransaction !== true || budget.isBrowserQuotaGuarantee !== false) {
    throw new Error('storage budget authority markers are invalid')
  }
  const rawOperations = requireArray(budget.operations, 'storage budget operations')
  const operationInputs = rawOperations.map((value) => {
    const operation = requireRecord(value, 'persisted storage operation budget')
    requireKnownFields(operation, [
      'semanticOperationId', 'exactOperation', 'proofReferences', 'privateMaterial', 'ciphers',
      'transitionOverhead', 'artifactCount', 'bytes',
    ])
    return {
      semanticOperationId: operation.semanticOperationId,
      exactOperation: operation.exactOperation,
      proofReferences: operation.proofReferences,
      privateMaterial: operation.privateMaterial,
      ciphers: operation.ciphers,
      transitionOverhead: operation.transitionOverhead,
    } as DurableSwapStorageBudgetInput['operations'][number]
  })
  const recalculated = calculateDurableSwapStorageBudget({
    schemaVersion: requireSchemaVersion(budget.schemaVersion),
    scopeId: decodeDurableCustodyScopeId(budget.scopeId),
    swapId: requireIdentifier(budget.swapId, 'swap id'),
    session: budget.session as DurableStorageComponentBudget,
    operations: operationInputs,
  })
  if (budget.totalArtifactCount !== recalculated.totalArtifactCount || budget.totalBytes !== recalculated.totalBytes) {
    throw new Error('storage budget totals are inconsistent')
  }
  for (let index = 0; index < rawOperations.length; index += 1) {
    const persisted = rawOperations[index] as Record<string, unknown>
    const expected = recalculated.operations[index]!
    if (persisted.artifactCount !== expected.artifactCount || persisted.bytes !== expected.bytes) {
      throw new Error('storage operation budget totals are inconsistent')
    }
  }
  return recalculated
}

function decodeDurableStorageReservationPlan(
  value: unknown,
  expectedScopeId?: string,
): DurableStorageReservationPlan {
  requireEncodedRecordLimit(value, 'storage reservation')
  const reservation = requireRecord(value, 'storage reservation')
  requireKnownFields(reservation, [
    'schemaVersion', 'scopeId', 'reservationId', 'swapId', 'sharedArtifactCount', 'sharedBytes',
    'totalArtifactCount', 'totalBytes', 'operations',
    'requiresAtomicAdapterTransaction', 'isBrowserQuotaGuarantee',
  ])
  requireSchemaVersion(reservation.schemaVersion)
  if (reservation.requiresAtomicAdapterTransaction !== true || reservation.isBrowserQuotaGuarantee !== false) {
    throw new Error('storage reservation authority markers are invalid')
  }
  const scopeId = decodeDurableCustodyScopeId(reservation.scopeId)
  if (expectedScopeId !== undefined && scopeId !== expectedScopeId) {
    throw new Error('storage reservation scope is foreign')
  }
  const operations = requireArray(reservation.operations, 'storage reservation operations').map((value) => {
    const operation = requireRecord(value, 'storage reservation operation')
    requireKnownFields(operation, ['semanticOperationId', 'artifactCount', 'bytes', 'state'])
    if (operation.state !== 'reserved' && operation.state !== 'consumed') {
      throw new Error('storage reservation operation state is invalid')
    }
    const state: 'reserved' | 'consumed' = operation.state
    const artifactCount = requirePositiveInteger(operation.artifactCount, 'reserved artifact count')
    const bytes = requireNonNegativeInteger(operation.bytes, 'reserved bytes')
    if (bytes === 0) throw new Error('reserved artifact count and bytes are inconsistent')
    return {
      semanticOperationId: decodeDurableCustodyOperationId(operation.semanticOperationId, scopeId),
      artifactCount,
      bytes,
      state,
    }
  })
  if (operations.length === 0 || operations.length > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error('storage reservation operation count exceeds the limit')
  }
  if (operations.some((operation) =>
    operation.artifactCount > DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX
    || operation.bytes > DURABLE_STORAGE_OPERATION_BYTES_LIMIT_MAX)) {
    throw new Error('storage reservation operation exceeds the limit')
  }
  if (new Set(operations.map((operation) => operation.semanticOperationId)).size !== operations.length) {
    throw new Error('semantic operation id is duplicated')
  }
  const sharedArtifactCount = requirePositiveInteger(
    reservation.sharedArtifactCount,
    'shared reserved artifact count',
  )
  const sharedBytes = requireNonNegativeInteger(reservation.sharedBytes, 'shared reserved bytes')
  if (sharedBytes === 0) throw new Error('shared reserved artifact count and bytes are inconsistent')
  const totalArtifactCount = operations.reduce(
    (total, operation) => safeAdd(total, operation.artifactCount, 'reserved artifact count'),
    sharedArtifactCount,
  )
  const totalBytes = operations.reduce(
    (total, operation) => safeAdd(total, operation.bytes, 'reserved bytes'),
    sharedBytes,
  )
  if (reservation.totalArtifactCount !== totalArtifactCount || reservation.totalBytes !== totalBytes) {
    throw new Error('storage reservation totals are inconsistent')
  }
  if (totalArtifactCount > DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX
    || totalBytes > DURABLE_STORAGE_SWAP_BYTES_LIMIT_MAX) {
    throw new Error('storage reservation exceeds the limit')
  }
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId,
    reservationId: requireIdentifier(reservation.reservationId, 'storage reservation id'),
    swapId: requireIdentifier(reservation.swapId, 'swap id'),
    sharedArtifactCount,
    sharedBytes,
    totalArtifactCount,
    totalBytes,
    operations,
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
}

function decodeOperationBudget(
  value: unknown,
  scopeId: string,
): DurableSwapStorageBudget['operations'][number] {
  const operation = requireRecord(value, 'storage operation budget')
  requireKnownFields(operation, [
    'semanticOperationId', 'exactOperation', 'proofReferences', 'privateMaterial', 'ciphers',
    'transitionOverhead',
  ])
  const exactOperation = decodeComponent(operation.exactOperation, 'exact operation', { exactCount: 1 })
  const proofReferences = decodeComponent(operation.proofReferences, 'proof references', {
    maxCount: DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
  })
  const privateMaterial = decodeComponent(operation.privateMaterial, 'private material')
  const ciphers = decodeComponent(operation.ciphers, 'ciphers')
  const transitionOverhead = decodeComponent(operation.transitionOverhead, 'transition overhead')
  const components = [exactOperation, proofReferences, privateMaterial, ciphers, transitionOverhead]
  const artifactCount = components.reduce(
    (total, component) => safeAdd(total, component.count, 'operation artifact count'),
    0,
  )
  const bytes = components.reduce(
    (total, component) => safeAdd(total, component.bytes, 'operation storage bytes'),
    0,
  )
  return {
    semanticOperationId: decodeDurableCustodyOperationId(operation.semanticOperationId, scopeId),
    exactOperation,
    proofReferences,
    privateMaterial,
    ciphers,
    transitionOverhead,
    artifactCount,
    bytes,
  }
}

function decodeComponent(
  value: unknown,
  name: string,
  bounds: { exactCount?: number; maxCount?: number } = {},
): DurableStorageComponentBudget {
  const component = requireRecord(value, `${name} storage component`)
  requireKnownFields(component, ['count', 'bytes'])
  const count = requireNonNegativeInteger(component.count, `${name} count`)
  const bytes = requireNonNegativeInteger(component.bytes, `${name} bytes`)
  if (bounds.exactCount !== undefined && count !== bounds.exactCount) {
    throw new Error(`${name} count is invalid`)
  }
  if (count > (bounds.maxCount ?? DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX)) {
    throw new Error(`${name} count exceeds the limit`)
  }
  if (bytes > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
    throw new Error(`${name} bytes exceed the limit`)
  }
  if ((count === 0) !== (bytes === 0)) throw new Error(`${name} count and bytes are inconsistent`)
  return { count, bytes }
}

function decodeEmergencyHeadroom(value: unknown): DurableStorageAccountingState['emergencyHeadroom'] {
  const headroom = requireRecord(value, 'emergency headroom')
  requireKnownFields(headroom, ['recordId', 'targetBytes', 'state'])
  if (headroom.recordId !== 'durable-storage-emergency-headroom'
    || headroom.targetBytes !== DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES
    || (headroom.state !== 'ready' && headroom.state !== 'released-for-maintenance')) {
    throw new Error('emergency headroom record is invalid')
  }
  return {
    recordId: 'durable-storage-emergency-headroom',
    targetBytes: DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
    state: headroom.state,
  }
}

function decodePinReference(value: unknown, scopeId: string): DurableStoragePinReference {
  const pin = requireRecord(value, 'storage pin reference')
  requireKnownFields(pin, ['pinId', 'proofId', 'reason', 'referenceId'])
  if (pin.reason !== 'proof-operation' && pin.reason !== 'open-order-collateral') {
    throw new Error('storage pin reason is invalid')
  }
  const referenceId = pin.reason === 'proof-operation'
    ? decodeDurableCustodyOperationId(pin.referenceId, scopeId)
    : requireIdentifier(pin.referenceId, 'storage pin reference id')
  return {
    pinId: requireIdentifier(pin.pinId, 'storage pin id'),
    proofId: requireLowerHex32(pin.proofId, 'storage pin proof id'),
    reason: pin.reason,
    referenceId,
  }
}

function nextState(
  state: DurableStorageAccountingState,
  changes: Partial<Omit<DurableStorageAccountingState, 'schemaVersion' | 'revision' | 'scopeId'>>,
): DurableStorageAccountingState {
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('storage accounting revision overflow')
  const next: DurableStorageAccountingState = {
    ...state,
    ...changes,
    revision: state.revision + 1,
  }
  requireEncodedRecordLimit(next, 'durable storage accounting state')
  return next
}

function requireSchemaVersion(
  value: unknown,
  message = 'unsupported durable storage admission schema version',
): typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION {
  if (value !== DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION) throw new Error(message)
  return DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} overflow`)
  return result
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireKnownFields(record: Record<string, unknown>, expected: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) throw new Error(`unknown field '${key}'`)
  }
  for (const key of expected) {
    if (!(key in record)) throw new Error(`missing required field '${key}'`)
  }
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireLowerHex32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function requireReleaseEvidence(value: unknown): AuthorizedDurableStorageReleaseEvidence {
  if (typeof value !== 'object' || value === null) {
    throw new Error('durable storage release evidence is invalid')
  }
  const authority = durableStorageReleaseEvidenceAuthority.get(value)
  if (authority === undefined) throw new Error('durable storage release evidence is invalid')
  return authority
}

function requireEncodedRecordLimit(value: unknown, name: string): void {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error(`${name} is invalid`)
  }
  if (encoded === undefined
    || new TextEncoder().encode(encoded).byteLength > DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX) {
    throw new Error(`${name} exceeds the encoded byte limit`)
  }
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requirePositiveInteger(value: unknown, name: string): number {
  const result = requireNonNegativeInteger(value, name)
  if (result === 0) throw new Error(`${name} is invalid`)
  return result
}
