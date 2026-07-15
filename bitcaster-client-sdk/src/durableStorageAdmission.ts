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
} from './durableCustody.ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION = 2 as const
export const DURABLE_STORAGE_OPERATION_LIMIT_MAX = 256 as const
export const DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX = 256 as const
export const DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX = 1 * 1_024 * 1_024
export const DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX = 4_096
export const DURABLE_STORAGE_SWAP_BYTES_LIMIT_MAX = 16 * 1_024 * 1_024
export const DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX = 1 + 4 * DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX
export const DURABLE_STORAGE_OPERATION_BYTES_LIMIT_MAX = 5 * DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX
export const DURABLE_STORAGE_MAINTENANCE_ROW_LIMIT_MAX = 256 as const
export const DURABLE_STORAGE_MAINTENANCE_BYTES_LIMIT_MAX = 1 * 1_024 * 1_024
export const DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX = 128 * 1_024
export const DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES =
  DURABLE_STORAGE_MAINTENANCE_BYTES_LIMIT_MAX + DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX

export interface DurableStorageComponentBudget {
  artifacts: DurableStorageArtifactCommitment[]
  count: number
  bytes: number
}

export interface DurableStorageArtifactCommitment {
  artifactId: string
  encoding: DurableStoragePlannedArtifact['encoding']
  artifactRole: DurableStorageArtifactRole
  byteLength: number
  sha256: string
}

export type DurableStorageArtifactRole =
  | 'trade-session'
  | 'exact-operation'
  | 'proof-post-image'
  | 'private-material'
  | 'cipher'
  | 'operation-overhead'
  | 'transaction-only-retained'

export type DurableStoragePlannedArtifact =
  | {
      artifactId: string
      encoding: 'json-utf8'
      artifactRole: DurableStorageArtifactRole
      encodedJson: string
    }
  | {
      artifactId: string
      encoding: 'binary'
      artifactRole: DurableStorageArtifactRole
      bytes: Uint8Array
    }

export interface DurableSwapStorageBudgetInput {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  scopeId: string
  swapId: string
  session: DurableStoragePlannedArtifact
  operations: Array<{
    semanticOperationId: string
    exactOperation: DurableStoragePlannedArtifact
    proofReferences: DurableStoragePlannedArtifact[]
    privateMaterial: DurableStoragePlannedArtifact[]
    ciphers: DurableStoragePlannedArtifact[]
    transitionOverhead: DurableStoragePlannedArtifact[]
  }>
}

export interface DurableSwapStorageBudget {
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
    artifacts: DurableStorageArtifactCommitment[]
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
  sharedArtifacts: DurableStorageArtifactCommitment[]
  sharedArtifactCount: number
  sharedBytes: number
  totalArtifactCount: number
  totalBytes: number
  operations: Array<{
    semanticOperationId: string
    exactOperation: DurableStorageComponentBudget
    proofReferences: DurableStorageComponentBudget
    privateMaterial: DurableStorageComponentBudget
    ciphers: DurableStorageComponentBudget
    transitionOverhead: DurableStorageComponentBudget
    artifactCount: number
    bytes: number
    state: 'reserved' | 'consumed'
  }>
  requiresAtomicAdapterTransaction: true
  isBrowserQuotaGuarantee: false
}

export interface DurableStorageAdmissionBatchPlan {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  scopeId: string
  batchId: string
  reservations: DurableStorageReservationPlan[]
  transactionOnlyArtifacts: DurableStorageArtifactCommitment[]
  totalArtifactCount: number
  totalBytes: number
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
  scopeId: string
  pinId: string
  proofId: string
  reason: 'proof-operation' | 'open-order-collateral'
  referenceId: string
}

export type DurableStorageReleaseDisposition = 'safe-abort' | 'terminal-purge'

const durableStorageBudgetAuthorities = new WeakMap<object, string>()
const durableStorageReservationAuthorities = new WeakMap<object, string>()
const durableStorageAdmissionBatchAuthorities = new WeakMap<object, string>()

export interface DurableStorageAccountingState {
  schemaVersion: typeof DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION
  recordId: 'durable-storage-origin-accounting'
  revision: number
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
  /** Logical origin-wide accounting cannot reserve browser quota. */
  isBrowserQuotaGuarantee: false
}

export interface DurableStorageReleaseQuery {
  readonly recordId: 'durable-storage-origin-accounting'
  readonly expectedAccountingRevision: number
  readonly scopeId: string
  readonly reservationId: string
  readonly semanticOperationId: string
}

export interface DurableStorageCommittedReleaseRows {
  accounting: unknown
  custodyRecord: unknown
  scopeState: unknown | null
}

export interface DurableStorageCommittedReleaseResult {
  readonly nextAccounting: DurableStorageAccountingState
  readonly releaseDisposition: DurableStorageReleaseDisposition
  readonly artifactActions: readonly DurableStorageArtifactReleaseAction[]
}

export interface DurableStorageArtifactReleaseAction {
  readonly artifactId: string
  readonly artifactRole: DurableStorageArtifactRole
  readonly action: 'delete' | 'retain'
}

export interface DurableStorageReleaseStore {
  /**
   * In one physical transaction, CAS-read the exact query rows, invoke `apply`
   * once as a synchronous function while that transaction is active, persist
   * its identical `nextAccounting`, apply only the returned `artifactActions`
   * within `query.scopeId`, and commit the revision CAS. `delete` removes the
   * exact operation-owned row; `retain` must never delete its CAS-validated
   * post-image. Any exception, thenable callback, mismatch, or quota failure
   * must roll back all reads and writes.
   */
  commitRelease(
    query: DurableStorageReleaseQuery,
    apply: (rows: DurableStorageCommittedReleaseRows) => DurableStorageCommittedReleaseResult,
  ): Promise<DurableStorageCommittedReleaseResult>
}

export type DurableStorageAccountingTransition =
  | {
      kind: 'reserve-batch'
      expectedRevision: number
      reservations: DurableStorageReservationPlan[]
    }
  | {
      kind: 'consume-operation'
      expectedRevision: number
      scopeId: string
      reservationId: string
      semanticOperationId: string
    }
  | {
      kind: 'release-emergency-headroom'
      expectedRevision: number
      reason: 'quota-recovery'
    }
  | { kind: 'restore-emergency-headroom'; expectedRevision: number }
  | {
      kind: 'add-pin-reference'
      expectedRevision: number
      pin: DurableStoragePinReference
    }
  | {
      kind: 'advance-maintenance-cursor'
      expectedRevision: number
      cursor: DurableStorageMaintenanceCursor | null
    }

export function createDurableStorageJsonArtifact(inputValue: {
  artifactId: string
  artifactRole: DurableStorageArtifactRole
  value: unknown
}): Extract<DurableStoragePlannedArtifact, { encoding: 'json-utf8' }> {
  const input = requireRecord(inputValue, 'planned JSON storage artifact input')
  requireKnownFields(input, ['artifactId', 'artifactRole', 'value'])
  preflightPlannedJsonValue(input.value)
  let encodedJson: string | undefined
  try {
    encodedJson = JSON.stringify(input.value)
  } catch {
    throw new Error('planned JSON storage artifact is invalid')
  }
  if (encodedJson === undefined) throw new Error('planned JSON storage artifact is invalid')
  const artifact = decodePlannedArtifact({
    artifactId: input.artifactId,
    encoding: 'json-utf8',
    artifactRole: input.artifactRole,
    encodedJson,
  })
  if (artifact.encoding !== 'json-utf8') throw new Error('planned JSON storage artifact is invalid')
  return artifact
}

export async function releaseCommittedDurableStorageOperation(inputValue: {
  store: DurableStorageReleaseStore
  expectedAccountingRevision: number
  scopeId: string
  reservationId: string
  semanticOperationId: string
}): Promise<DurableStorageCommittedReleaseResult> {
  const input = requireRecord(inputValue, 'committed storage release input')
  requireKnownFields(input, [
    'store',
    'expectedAccountingRevision',
    'scopeId',
    'reservationId',
    'semanticOperationId',
  ])
  const store = requireReleaseStore(input.store)
  const authorityQuery = decodeReleaseQuery({
    recordId: 'durable-storage-origin-accounting',
    expectedAccountingRevision: input.expectedAccountingRevision,
    scopeId: input.scopeId,
    reservationId: input.reservationId,
    semanticOperationId: input.semanticOperationId,
  })
  let callbackOpen = true
  let callbackCalls = 0
  let callbackRejected = false
  let issued: DurableStorageCommittedReleaseResult | undefined
  let returned: DurableStorageCommittedReleaseResult
  try {
    const adapterQuery = Object.freeze({ ...authorityQuery })
    returned = await store.commitRelease(adapterQuery, (rows) => {
      if (!callbackOpen || callbackCalls !== 0) {
        callbackRejected = true
        throw new Error('committed storage release callback is invalid')
      }
      callbackCalls += 1
      issued = freezeCommittedRelease(reduceCommittedRelease(authorityQuery, rows))
      return issued
    })
  } finally {
    callbackOpen = false
  }
  if (callbackRejected || callbackCalls !== 1 || issued === undefined || returned !== issued) {
    throw new Error('committed storage release result is invalid')
  }
  return returned
}

function reduceCommittedRelease(
  query: DurableStorageReleaseQuery,
  rowsValue: DurableStorageCommittedReleaseRows,
): DurableStorageCommittedReleaseResult {
  const rows = requireRecord(rowsValue, 'committed storage release rows')
  requireKnownFields(rows, ['accounting', 'custodyRecord', 'scopeState'])
  const state = decodeDurableStorageAccountingState(rows.accounting)
  if (state.revision !== query.expectedAccountingRevision) {
    throw new Error('committed storage release accounting revision is stale')
  }
  const context = findReservedOperation(
    state,
    query.scopeId,
    query.reservationId,
    query.semanticOperationId,
  )
  if (context.reservation.scopeId !== query.scopeId) {
    throw new Error('committed storage release scope is foreign')
  }
  const record = decodeDurableCustodyRecord(rows.custodyRecord)
  if (record.scope.scopeId !== query.scopeId
    || record.operation.operationId !== query.semanticOperationId) {
    throw new Error('committed storage release custody row is foreign')
  }
  const disposition = classifyCommittedRelease(record, rows.scopeState)
  requireReleaseDisposition(context.operation.state, disposition)
  return buildCommittedReleaseResult(state, context, record, disposition)
}

function classifyCommittedRelease(
  record: DurableCustodyRecord,
  scopeStateValue: unknown,
): DurableStorageReleaseDisposition {
  if (record.operation.state === 'aborted') return 'safe-abort'
  if (record.operation.state !== 'reconciled') throw new Error('custody is not releasable')
  if (scopeStateValue === null) throw new Error('custody scope state is required for terminal release')
  const scopeState = decodeDurableCustodyScopeState(scopeStateValue, record.scope)
  if (decideTerminalTombstoneDrain(record, scopeState).kind !== 'delete') {
    throw new Error('terminal custody must be retained')
  }
  return 'terminal-purge'
}

function buildCommittedReleaseResult(
  state: DurableStorageAccountingState,
  context: ReturnType<typeof findReservedOperation>,
  record: DurableCustodyRecord,
  releaseDisposition: DurableStorageReleaseDisposition,
): DurableStorageCommittedReleaseResult {
  const operations = context.reservation.operations.filter(
    (_, index) => index !== context.operationIndex,
  )
  const reservations = removeReservedOperation(state, context, operations)
  const inputProofIds = new Set(
    record.operation.reservation.inputs.map((input) => input.proofId),
  )
  const pinReferences = state.pinReferences.filter((pin) => {
    if (pin.reason !== 'proof-operation'
      || pin.referenceId !== record.operation.operationId) return true
    if (pin.scopeId !== record.scope.scopeId || !inputProofIds.has(pin.proofId)) {
      throw new Error('committed storage release proof pin is foreign')
    }
    return false
  })
  const sharedArtifacts = operations.length === 0
    ? context.reservation.sharedArtifacts
    : []
  const sharedBytes = operations.length === 0 ? context.reservation.sharedBytes : 0
  return {
    nextAccounting: nextState(state, {
      reservations,
      pinReferences,
      accountedBytes: state.accountedBytes - context.operation.bytes - sharedBytes,
    }),
    releaseDisposition,
    artifactActions: releaseArtifactActions([
      ...reservationOperationArtifacts(context.operation),
      ...sharedArtifacts,
    ]),
  }
}

function releaseArtifactActions(
  artifacts: DurableStorageArtifactCommitment[],
): DurableStorageArtifactReleaseAction[] {
  return artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    artifactRole: artifact.artifactRole,
    action: isRetainedArtifactRole(artifact.artifactRole) ? 'retain' : 'delete',
  }))
}

function isRetainedArtifactRole(role: DurableStorageArtifactRole): boolean {
  return role === 'proof-post-image' || role === 'transaction-only-retained'
}

function freezeCommittedRelease(
  result: DurableStorageCommittedReleaseResult,
): DurableStorageCommittedReleaseResult {
  freezeRecursively(result.nextAccounting)
  for (const action of result.artifactActions) Object.freeze(action)
  Object.freeze(result.artifactActions)
  return Object.freeze(result)
}

function freezeRecursively(value: object): void {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
      freezeRecursively(child)
    }
  }
  Object.freeze(value)
}

function decodeReleaseQuery(value: unknown): DurableStorageReleaseQuery {
  const query = requireRecord(value, 'committed storage release query')
  requireKnownFields(query, [
    'recordId',
    'expectedAccountingRevision',
    'scopeId',
    'reservationId',
    'semanticOperationId',
  ])
  if (query.recordId !== 'durable-storage-origin-accounting') {
    throw new Error('committed storage release record id is invalid')
  }
  const scopeId = decodeDurableCustodyScopeId(query.scopeId)
  return {
    recordId: 'durable-storage-origin-accounting',
    expectedAccountingRevision: requireNonNegativeInteger(
      query.expectedAccountingRevision,
      'expected storage accounting revision',
    ),
    scopeId,
    reservationId: requireIdentifier(query.reservationId, 'storage reservation id'),
    semanticOperationId: decodeDurableCustodyOperationId(
      query.semanticOperationId,
      scopeId,
    ),
  }
}

function requireReleaseStore(value: unknown): DurableStorageReleaseStore {
  const store = requireRecord(value, 'committed storage release store')
  if (typeof store.commitRelease !== 'function') {
    throw new Error('committed storage release store is invalid')
  }
  return store as unknown as DurableStorageReleaseStore
}

export function calculateDurableSwapStorageBudget(inputValue: DurableSwapStorageBudgetInput): DurableSwapStorageBudget {
  const input = requireRecord(inputValue, 'durable swap storage budget input')
  requireKnownFields(input, [
    'schemaVersion',
    'scopeId',
    'swapId',
    'session',
    'operations',
  ])
  requireSchemaVersion(input.schemaVersion)
  const scopeId = decodeDurableCustodyScopeId(input.scopeId)
  const swapId = requireIdentifier(input.swapId, 'swap id')
  const session = measureComponent([input.session], 'session', {
    exactCount: 1,
    artifactRoles: ['trade-session'],
  })
  const { operations, totalArtifactCount, totalBytes } = decodePlannedOperations(
    input.operations,
    scopeId,
    session,
  )
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
  durableStorageBudgetAuthorities.set(budget, encodeRecord(budget, 'durable swap storage budget'))
  return budget
}

function decodePlannedOperations(
  value: unknown,
  scopeId: string,
  shared: DurableStorageComponentBudget,
): Pick<DurableSwapStorageBudget, 'operations' | 'totalArtifactCount' | 'totalBytes'> {
  const raw = requireBoundedArray(value, 'storage budget operations', DURABLE_STORAGE_OPERATION_LIMIT_MAX)
  requireOperationCount(raw.length, 'storage budget operation count')
  const operations: DurableSwapStorageBudget['operations'] = []
  const operationIds = new Set<string>()
  const artifactIds = new Set(shared.artifacts.map((artifact) => artifact.artifactId))
  let totalArtifactCount = shared.count
  let totalBytes = shared.bytes
  for (const item of raw) {
    const operation = decodeOperationBudget(item, scopeId)
    if (operationIds.has(operation.semanticOperationId)) throw new Error('semantic operation id is duplicated')
    operationIds.add(operation.semanticOperationId)
    requireNewArtifactIds(artifactIds, operation.artifacts)
    totalArtifactCount = safeAdd(totalArtifactCount, operation.artifactCount, 'storage artifact count')
    totalBytes = safeAdd(totalBytes, operation.bytes, 'storage budget bytes')
    requireSwapTotals(totalArtifactCount, totalBytes)
    operations.push(operation)
  }
  return { operations, totalArtifactCount, totalBytes }
}

export function createDurableStorageReservationPlan(inputValue: {
  reservationId: string
  budget: DurableSwapStorageBudget
}): DurableStorageReservationPlan {
  const input = requireRecord(inputValue, 'storage reservation plan input')
  requireKnownFields(input, ['reservationId', 'budget'])
  const budget = requireIssuedDurableSwapStorageBudget(input.budget)
  const reservation: DurableStorageReservationPlan = {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId: budget.scopeId,
    reservationId: requireIdentifier(input.reservationId, 'storage reservation id'),
    swapId: budget.swapId,
    sharedArtifacts: budget.session.artifacts.map(copyArtifactCommitment),
    sharedArtifactCount: budget.session.count,
    sharedBytes: budget.session.bytes,
    totalArtifactCount: budget.totalArtifactCount,
    totalBytes: budget.totalBytes,
    operations: budget.operations.map((operation) => ({
      semanticOperationId: operation.semanticOperationId,
      exactOperation: copyComponentBudget(operation.exactOperation),
      proofReferences: copyComponentBudget(operation.proofReferences),
      privateMaterial: copyComponentBudget(operation.privateMaterial),
      ciphers: copyComponentBudget(operation.ciphers),
      transitionOverhead: copyComponentBudget(operation.transitionOverhead),
      artifactCount: operation.artifactCount,
      bytes: operation.bytes,
      state: 'reserved',
    })),
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
  requireEncodedRecordLimit(reservation, 'storage reservation')
  durableStorageReservationAuthorities.set(
    reservation,
    encodeRecord(reservation, 'storage reservation'),
  )
  return reservation
}

/**
 * Binds one real adapter transaction across one or more reservations. A
 * transaction-only artifact must be the exact post-image of a pre-existing
 * row that the adapter CAS-read in the same transaction. It is verified but
 * is neither persistently charged nor granted any later deletion authority.
 */
export function createDurableStorageAdmissionBatchPlan(inputValue: {
  batchId: string
  reservations: DurableStorageReservationPlan[]
  transactionOnlyArtifacts: DurableStoragePlannedArtifact[]
}): DurableStorageAdmissionBatchPlan {
  const input = requireRecord(inputValue, 'storage admission batch input')
  requireKnownFields(input, ['batchId', 'reservations', 'transactionOnlyArtifacts'])
  const rawReservations = requireBoundedArray(
    input.reservations,
    'storage admission batch reservations',
    DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  )
  if (rawReservations.length === 0) throw new Error('storage admission batch is empty')
  const decodedReservations = rawReservations.map(
    requireIssuedDurableStorageReservationPlan,
  )
  const scopeId = requireSameBatchScope(decodedReservations)
  validateReservationIdentities(decodedReservations)
  const transactionOnly = measureComponent(
    input.transactionOnlyArtifacts,
    'transaction-only',
    {
      maxCount: DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX,
      artifactRoles: ['transaction-only-retained'],
    },
  )
  const committedReservationArtifacts = decodedReservations.flatMap(reservationArtifacts)
  requireUniqueArtifacts([...committedReservationArtifacts, ...transactionOnly.artifacts])
  return issueDurableStorageAdmissionBatch({
    batchId: input.batchId,
    scopeId,
    reservations: rawReservations as DurableStorageReservationPlan[],
    reservationArtifacts: committedReservationArtifacts,
    transactionOnly,
  })
}

function issueDurableStorageAdmissionBatch(input: {
  batchId: unknown
  scopeId: string
  reservations: DurableStorageReservationPlan[]
  reservationArtifacts: DurableStorageArtifactCommitment[]
  transactionOnly: DurableStorageComponentBudget
}): DurableStorageAdmissionBatchPlan {
  const totalArtifactCount = safeAdd(
    input.reservationArtifacts.length,
    input.transactionOnly.count,
    'storage admission batch artifact count',
  )
  const totalBytes = artifactCommitmentBytes(
    [...input.reservationArtifacts, ...input.transactionOnly.artifacts],
    'storage admission batch bytes',
  )
  requireSwapTotals(totalArtifactCount, totalBytes)
  const batch: DurableStorageAdmissionBatchPlan = {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId: input.scopeId,
    batchId: requireIdentifier(input.batchId, 'storage admission batch id'),
    reservations: input.reservations,
    transactionOnlyArtifacts: input.transactionOnly.artifacts,
    totalArtifactCount,
    totalBytes,
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
  durableStorageAdmissionBatchAuthorities.set(
    batch,
    encodeRecord(batch, 'storage admission batch'),
  )
  return batch
}

/** Verifies the physical post-images and returns the one accounting revision. */
export function applyDurableStorageAdmissionBatch(inputValue: {
  state: DurableStorageAccountingState
  batch: DurableStorageAdmissionBatchPlan
  artifacts: DurableStoragePlannedArtifact[]
}): DurableStorageAccountingState {
  const input = requireRecord(inputValue, 'storage admission batch apply input')
  requireKnownFields(input, ['state', 'batch', 'artifacts'])
  const state = decodeDurableStorageAccountingState(input.state)
  const batch = requireIssuedDurableStorageAdmissionBatchPlan(input.batch)
  verifyDurableStorageArtifactSet(
    input.artifacts,
    batchArtifacts(batch),
    batch.totalBytes,
  )
  return reduceDurableStorageAccountingState(state, {
    kind: 'reserve-batch',
    expectedRevision: state.revision,
    reservations: batch.reservations,
  })
}

/**
 * Recomputes the exact reservation artifact set immediately before an adapter
 * writes it. Adapters must call this inside the same transaction that persists
 * the artifacts, reservation, and origin-global accounting revision.
 */
export function verifyDurableStorageReservationArtifacts(inputValue: {
  reservation: DurableStorageReservationPlan
  artifacts: DurableStoragePlannedArtifact[]
}): void {
  const input = requireRecord(inputValue, 'storage reservation artifact verification input')
  requireKnownFields(input, ['reservation', 'artifacts'])
  const reservation = requireIssuedDurableStorageReservationPlan(input.reservation)
  verifyDurableStorageArtifactSet(
    input.artifacts,
    reservationArtifacts(reservation),
    reservation.totalBytes,
  )
}

export function createDurableStorageAccountingState(inputValue: {
  accountingLimitBytes: number
}): DurableStorageAccountingState {
  const input = requireRecord(inputValue, 'storage accounting state input')
  requireKnownFields(input, ['accountingLimitBytes'])
  const accountingLimitBytes = requireNonNegativeInteger(input.accountingLimitBytes, 'storage accounting limit')
  if (accountingLimitBytes < DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES) {
    throw new Error('storage accounting limit cannot hold emergency headroom')
  }
  const state: DurableStorageAccountingState = {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    recordId: 'durable-storage-origin-accounting',
    revision: 0,
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
    isBrowserQuotaGuarantee: false,
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
    case 'reserve-batch':
      requireKnownFields(transition, ['kind', 'expectedRevision', 'reservations'])
      return reserveBatch(state, transition.reservations)
    case 'consume-operation':
      return consumeReservedOperation(state, transition)
    case 'release-emergency-headroom':
      return releaseEmergencyHeadroom(state, transition)
    case 'restore-emergency-headroom':
      return restoreEmergencyHeadroom(state, transition)
    case 'add-pin-reference':
      return addPinReference(state, transition)
    case 'advance-maintenance-cursor':
      requireKnownFields(transition, ['kind', 'expectedRevision', 'cursor'])
      return nextState(state, {
        maintenanceCursor:
          transition.cursor === null
            ? null
            : decodeDurableStorageMaintenanceCursor(transition.cursor, state.maintenanceCursor?.cursor ?? null),
      })
    default:
      throw new Error('storage accounting transition kind is invalid')
  }
}

function consumeReservedOperation(
  state: DurableStorageAccountingState,
  transition: Record<string, unknown>,
): DurableStorageAccountingState {
  requireKnownFields(transition, ['kind', 'expectedRevision', 'scopeId', 'reservationId', 'semanticOperationId'])
  const context = findReservedOperation(
    state,
    transition.scopeId,
    transition.reservationId,
    requireIdentifier(transition.semanticOperationId, 'custody operation id'),
  )
  if (context.operation.state !== 'reserved') {
    throw new Error('semantic operation is already consumed')
  }
  const operations = context.reservation.operations.map((item, index) =>
    index === context.operationIndex ? { ...item, state: 'consumed' as const } : item,
  )
  const reservations = state.reservations.map((item, index) =>
    index === context.reservationIndex ? { ...item, operations } : item,
  )
  return nextState(state, { reservations })
}

function findReservedOperation(
  state: DurableStorageAccountingState,
  scopeIdValue: unknown,
  reservationIdValue: unknown,
  semanticOperationId: string,
) {
  const scopeId = decodeDurableCustodyScopeId(scopeIdValue)
  const reservationId = requireIdentifier(reservationIdValue, 'storage reservation id')
  const reservationIndex = state.reservations.findIndex(
    (item) => item.scopeId === scopeId && item.reservationId === reservationId,
  )
  if (reservationIndex < 0) throw new Error('storage reservation is missing')
  const reservation = state.reservations[reservationIndex]!
  decodeDurableCustodyOperationId(semanticOperationId, scopeId)
  const operationIndex = reservation.operations.findIndex(
    (operation) => operation.semanticOperationId === semanticOperationId,
  )
  if (operationIndex < 0) throw new Error('semantic operation reservation is missing')
  return {
    reservation,
    reservationIndex,
    operation: reservation.operations[operationIndex]!,
    operationIndex,
  }
}

function requireReleaseDisposition(
  state: 'reserved' | 'consumed',
  disposition: DurableStorageReleaseDisposition,
): void {
  if (disposition === 'safe-abort' && state !== 'reserved') {
    throw new Error('safe-abort release requires reserved accounting')
  }
  if (disposition === 'terminal-purge' && state !== 'consumed') {
    throw new Error('terminal purge release requires consumed accounting')
  }
}

function removeReservedOperation(
  state: DurableStorageAccountingState,
  context: ReturnType<typeof findReservedOperation>,
  operations: DurableStorageReservationPlan['operations'],
): DurableStorageReservationPlan[] {
  if (operations.length === 0) {
    return state.reservations.filter((_, index) => index !== context.reservationIndex)
  }
  return state.reservations.map((item, index) =>
    index === context.reservationIndex
      ? {
          ...item,
          operations,
          totalArtifactCount: item.totalArtifactCount - context.operation.artifactCount,
          totalBytes: item.totalBytes - context.operation.bytes,
        }
      : item,
  )
}

function releaseEmergencyHeadroom(
  state: DurableStorageAccountingState,
  transition: Record<string, unknown>,
): DurableStorageAccountingState {
  requireKnownFields(transition, ['kind', 'expectedRevision', 'reason'])
  if (transition.reason !== 'quota-recovery') throw new Error('headroom release reason is invalid')
  if (state.emergencyHeadroom.state !== 'ready') throw new Error('emergency headroom is not ready')
  return nextState(state, {
    emergencyHeadroom: {
      ...state.emergencyHeadroom,
      state: 'released-for-maintenance',
    },
  })
}

function restoreEmergencyHeadroom(
  state: DurableStorageAccountingState,
  transition: Record<string, unknown>,
): DurableStorageAccountingState {
  requireKnownFields(transition, ['kind', 'expectedRevision'])
  if (state.emergencyHeadroom.state !== 'released-for-maintenance') {
    throw new Error('emergency headroom is not released')
  }
  if (
    safeAdd(state.accountedBytes, state.emergencyHeadroom.targetBytes, 'headroom restore bytes') >
    state.accountingLimitBytes
  ) {
    throw new Error('storage accounting capacity cannot restore emergency headroom')
  }
  return nextState(state, {
    emergencyHeadroom: { ...state.emergencyHeadroom, state: 'ready' },
  })
}

function addPinReference(
  state: DurableStorageAccountingState,
  transition: Record<string, unknown>,
): DurableStorageAccountingState {
  requireKnownFields(transition, ['kind', 'expectedRevision', 'pin'])
  const pin = decodePinReference(transition.pin)
  const sameId = state.pinReferences.find(
    (existing) => existing.scopeId === pin.scopeId && existing.pinId === pin.pinId,
  )
  if (sameId !== undefined) {
    if (samePinReference(sameId, pin)) return state
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

function samePinReference(left: DurableStoragePinReference, right: DurableStoragePinReference): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.proofId === right.proofId &&
    left.reason === right.reason &&
    left.referenceId === right.referenceId
  )
}

function reserveBatch(state: DurableStorageAccountingState, value: unknown): DurableStorageAccountingState {
  if (state.emergencyHeadroom.state !== 'ready') {
    throw new Error('emergency headroom is unavailable')
  }
  const reservations = requireBoundedArray(
    value,
    'storage reservation batch',
    DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  ).map((reservation) =>
    requireIssuedDurableStorageReservationPlan(reservation),
  )
  if (reservations.length === 0 || reservations.length > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error('storage reservation batch count exceeds the limit')
  }
  const scopeId = reservations[0]!.scopeId
  if (reservations.some((reservation) => reservation.scopeId !== scopeId)) {
    throw new Error('storage reservation batch scope is foreign')
  }
  validateReservationIdentities([...state.reservations, ...reservations])
  const operationCount = [...state.reservations, ...reservations].reduce(
    (total, reservation) => safeAdd(total, reservation.operations.length, 'active semantic operation count'),
    0,
  )
  if (operationCount > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error('active semantic operation count exceeds the limit')
  }
  const addedBytes = reservations.reduce(
    (total, reservation) => safeAdd(total, reservation.totalBytes, 'accounted storage bytes'),
    0,
  )
  const accountedBytes = safeAdd(state.accountedBytes, addedBytes, 'accounted storage bytes')
  const requiredBytes = safeAdd(
    accountedBytes,
    state.emergencyHeadroom.targetBytes,
    'accounted storage and headroom bytes',
  )
  if (requiredBytes > state.accountingLimitBytes) {
    throw new Error('storage accounting capacity is insufficient')
  }
  return nextState(state, {
    reservations: [...state.reservations, ...reservations],
    accountedBytes,
  })
}

function validateReservationIdentities(combined: DurableStorageReservationPlan[]): void {
  requireUniqueValues(
    combined.map((reservation) => `${reservation.scopeId}:${reservation.reservationId}`),
    'storage reservation id is duplicated',
  )
  const swaps = combined.map((reservation) => `${reservation.scopeId}:${reservation.swapId}`)
  requireUniqueValues(swaps, 'storage reservation swap id is duplicated')
  requireUniqueValues(
    combined.flatMap((reservation) => reservation.operations.map((operation) => operation.semanticOperationId)),
    'active semantic operation id is duplicated',
  )
  requireUniqueValues(
    combined.flatMap((reservation) =>
      reservationArtifactIds(reservation).map((artifactId) => `${reservation.scopeId}:${artifactId}`),
    ),
    'storage artifact id is duplicated',
  )
}

function reservationArtifactIds(reservation: DurableStorageReservationPlan): string[] {
  return reservationArtifacts(reservation).map((artifact) => artifact.artifactId)
}

function reservationArtifacts(reservation: DurableStorageReservationPlan): DurableStorageArtifactCommitment[] {
  return [
    ...reservation.sharedArtifacts,
    ...reservation.operations.flatMap(reservationOperationArtifacts),
  ]
}

function reservationOperationArtifacts(
  operation: DurableStorageReservationPlan['operations'][number],
): DurableStorageArtifactCommitment[] {
  return [
    ...operation.exactOperation.artifacts,
    ...operation.proofReferences.artifacts,
    ...operation.privateMaterial.artifacts,
    ...operation.ciphers.artifacts,
    ...operation.transitionOverhead.artifacts,
  ]
}

function batchArtifacts(
  batch: DurableStorageAdmissionBatchPlan,
): DurableStorageArtifactCommitment[] {
  return [
    ...batch.reservations.flatMap(reservationArtifacts),
    ...batch.transactionOnlyArtifacts,
  ]
}

function verifyDurableStorageArtifactSet(
  artifactsValue: unknown,
  expected: DurableStorageArtifactCommitment[],
  expectedBytes: number,
): void {
  const actual = requireBoundedArray(
    artifactsValue,
    'storage transaction artifacts',
    DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX,
  ).map(decodePlannedArtifact).map(commitPlannedArtifact)
  requireUniqueArtifacts(actual)
  if (!sameArtifactCommitmentSets(actual, expected)) {
    throw new Error('storage transaction artifacts do not match the committed plan')
  }
  if (artifactCommitmentBytes(actual, 'storage transaction bytes') !== expectedBytes) {
    throw new Error('storage transaction bytes do not match the committed plan')
  }
}

function requireSameBatchScope(
  reservations: DurableStorageReservationPlan[],
): string {
  const scopeId = reservations[0]!.scopeId
  if (reservations.some((reservation) => reservation.scopeId !== scopeId)) {
    throw new Error('storage admission batch scope is foreign')
  }
  return scopeId
}

function requireIssuedDurableStorageAdmissionBatchPlan(
  value: unknown,
): DurableStorageAdmissionBatchPlan {
  if (typeof value !== 'object' || value === null) {
    throw new Error('storage admission batch is not SDK-issued')
  }
  const issuedEncoding = durableStorageAdmissionBatchAuthorities.get(value)
  if (
    issuedEncoding === undefined ||
    issuedEncoding !== encodeRecord(value, 'storage admission batch')
  ) {
    throw new Error('storage admission batch is not SDK-issued')
  }
  return value as DurableStorageAdmissionBatchPlan
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
  const state = requireRecord(value, 'durable storage accounting state')
  requireKnownFields(state, [
    'schemaVersion',
    'recordId',
    'revision',
    'accountingLimitBytes',
    'accountedBytes',
    'emergencyHeadroom',
    'reservations',
    'pinReferences',
    'maintenanceCursor',
    'isBrowserQuotaGuarantee',
  ])
  requireSchemaVersion(state.schemaVersion, 'unsupported durable storage accounting schema version')
  if (state.recordId !== 'durable-storage-origin-accounting') {
    throw new Error('durable storage accounting record id is invalid')
  }
  if (state.isBrowserQuotaGuarantee !== false) {
    throw new Error('durable storage accounting authority marker is invalid')
  }
  const emergencyHeadroom = decodeEmergencyHeadroom(state.emergencyHeadroom)
  const { reservations, pinReferences } = decodeAccountingCollections(state)
  const { accountedBytes, accountingLimitBytes } = decodeAccountingCapacity(state, reservations, emergencyHeadroom)
  const maintenanceCursor = state.maintenanceCursor === null
    ? null
    : decodeDurableStorageMaintenanceCursor(state.maintenanceCursor)
  requireEncodedRecordLimit(value, 'durable storage accounting state')
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    recordId: 'durable-storage-origin-accounting',
    revision: requireNonNegativeInteger(state.revision, 'storage accounting revision'),
    accountingLimitBytes,
    accountedBytes,
    emergencyHeadroom,
    reservations,
    pinReferences,
    maintenanceCursor,
    isBrowserQuotaGuarantee: false,
  }
}

function decodeAccountingCollections(state: Record<string, unknown>): {
  reservations: DurableStorageReservationPlan[]
  pinReferences: DurableStoragePinReference[]
} {
  const reservations = requireBoundedArray(
    state.reservations,
    'storage reservations',
    DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  ).map(decodeDurableStorageReservationPlan)
  const pinReferences = requireBoundedArray(
    state.pinReferences,
    'storage pin references',
    DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
  ).map(decodePinReference)
  validateReservationIdentities(reservations)
  const operationCount = reservations.reduce(
    (total, reservation) => safeAdd(total, reservation.operations.length, 'active semantic operation count'),
    0,
  )
  if (operationCount > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error('active semantic operation count exceeds the limit')
  }
  requireUniqueValues(
    pinReferences.map((pin) => `${pin.scopeId}:${pin.pinId}`),
    'storage pin id is duplicated',
  )
  requireUniqueValues(pinReferences.map((pin) => pin.proofId), 'proof already has an active storage pin')
  requireUniqueValues(
    pinReferences.map((pin) => `${pin.scopeId}:${pin.proofId}:${pin.reason}:${pin.referenceId}`),
    'storage pin reference identity is duplicated',
  )
  return { reservations, pinReferences }
}

function decodeAccountingCapacity(
  state: Record<string, unknown>,
  reservations: DurableStorageReservationPlan[],
  emergencyHeadroom: DurableStorageAccountingState['emergencyHeadroom'],
): { accountedBytes: number; accountingLimitBytes: number } {
  const accountedBytes = requireNonNegativeInteger(state.accountedBytes, 'accounted storage bytes')
  const derivedBytes = reservations.reduce(
    (total, reservation) => safeAdd(total, reservation.totalBytes, 'accounted storage bytes'),
    0,
  )
  if (accountedBytes !== derivedBytes) throw new Error('accounted storage bytes are inconsistent')
  const accountingLimitBytes = requireNonNegativeInteger(state.accountingLimitBytes, 'storage accounting limit')
  if (accountedBytes > accountingLimitBytes) throw new Error('accounted storage bytes exceed the limit')
  const readyBytes = safeAdd(accountedBytes, emergencyHeadroom.targetBytes, 'accounted storage and headroom bytes')
  if (emergencyHeadroom.state === 'ready' && readyBytes > accountingLimitBytes) {
    throw new Error('ready emergency headroom exceeds the accounting limit')
  }
  return { accountedBytes, accountingLimitBytes }
}

function decodeDurableSwapStorageBudget(value: unknown): DurableSwapStorageBudget {
  const budget = requireRecord(value, 'durable swap storage budget')
  requireKnownFields(budget, [
    'schemaVersion',
    'scopeId',
    'swapId',
    'session',
    'operations',
    'totalArtifactCount',
    'totalBytes',
    'requiresAtomicAdapterTransaction',
    'isBrowserQuotaGuarantee',
  ])
  if (budget.requiresAtomicAdapterTransaction !== true || budget.isBrowserQuotaGuarantee !== false) {
    throw new Error('storage budget authority markers are invalid')
  }
  requireSchemaVersion(budget.schemaVersion)
  const scopeId = decodeDurableCustodyScopeId(budget.scopeId)
  const session = decodeMeasuredComponent(budget.session, 'session', {
    exactCount: 1,
    artifactRoles: ['trade-session'],
  })
  const operations = decodePersistedOperations(budget.operations, scopeId)
  requireOperationCount(operations.length, 'storage budget operation count')
  requireUniqueValues(
    operations.map((operation) => operation.semanticOperationId),
    'semantic operation id is duplicated',
  )
  requireUniqueArtifacts([...session.artifacts, ...operations.flatMap((operation) => operation.artifacts)])
  const { totalArtifactCount, totalBytes } = calculateStorageBudgetTotals(session, operations)
  requireSwapTotals(totalArtifactCount, totalBytes)
  if (budget.totalArtifactCount !== totalArtifactCount || budget.totalBytes !== totalBytes) {
    throw new Error('storage budget totals are inconsistent')
  }
  requireEncodedRecordLimit(value, 'durable swap storage budget')
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId,
    swapId: requireIdentifier(budget.swapId, 'swap id'),
    session,
    operations,
    totalArtifactCount,
    totalBytes,
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
}

function decodePersistedOperations(
  value: unknown,
  scopeId: string,
): DurableSwapStorageBudget['operations'] {
  return requireBoundedArray(
    value,
    'storage budget operations',
    DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  ).map((operation) => decodePersistedOperationBudget(operation, scopeId))
}

function calculateStorageBudgetTotals(
  session: DurableStorageComponentBudget,
  operations: DurableSwapStorageBudget['operations'],
): { totalArtifactCount: number; totalBytes: number } {
  return {
    totalArtifactCount: operations.reduce(
      (total, operation) => safeAdd(total, operation.artifactCount, 'storage artifact count'),
      session.count,
    ),
    totalBytes: operations.reduce(
      (total, operation) => safeAdd(total, operation.bytes, 'storage budget bytes'),
      session.bytes,
    ),
  }
}

function requireIssuedDurableSwapStorageBudget(value: unknown): DurableSwapStorageBudget {
  if (typeof value !== 'object' || value === null) {
    throw new Error('durable swap storage budget is not SDK-issued')
  }
  const issuedEncoding = durableStorageBudgetAuthorities.get(value)
  if (issuedEncoding === undefined || issuedEncoding !== encodeRecord(value, 'durable swap storage budget')) {
    throw new Error('durable swap storage budget is not SDK-issued')
  }
  return decodeDurableSwapStorageBudget(value)
}

function decodeDurableStorageReservationPlan(value: unknown): DurableStorageReservationPlan {
  const reservation = requireRecord(value, 'storage reservation')
  requireKnownFields(reservation, [
    'schemaVersion',
    'scopeId',
    'reservationId',
    'swapId',
    'sharedArtifacts',
    'sharedArtifactCount',
    'sharedBytes',
    'totalArtifactCount',
    'totalBytes',
    'operations',
    'requiresAtomicAdapterTransaction',
    'isBrowserQuotaGuarantee',
  ])
  requireSchemaVersion(reservation.schemaVersion)
  if (reservation.requiresAtomicAdapterTransaction !== true || reservation.isBrowserQuotaGuarantee !== false) {
    throw new Error('storage reservation authority markers are invalid')
  }
  const scopeId = decodeDurableCustodyScopeId(reservation.scopeId)
  const operations = decodeReservationOperations(reservation.operations, scopeId)
  const shared = decodeSharedReservationBudget(reservation)
  const { totalArtifactCount, totalBytes } = calculateReservationTotals(operations, shared)
  if (reservation.totalArtifactCount !== totalArtifactCount || reservation.totalBytes !== totalBytes) {
    throw new Error('storage reservation totals are inconsistent')
  }
  requireSwapTotals(totalArtifactCount, totalBytes)
  requireUniqueArtifacts([
    ...shared.artifacts,
    ...operations.flatMap(reservationOperationArtifacts),
  ])
  requireEncodedRecordLimit(value, 'storage reservation')
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId,
    reservationId: requireIdentifier(reservation.reservationId, 'storage reservation id'),
    swapId: requireIdentifier(reservation.swapId, 'swap id'),
    sharedArtifacts: shared.artifacts,
    sharedArtifactCount: shared.count,
    sharedBytes: shared.bytes,
    totalArtifactCount,
    totalBytes,
    operations,
    requiresAtomicAdapterTransaction: true,
    isBrowserQuotaGuarantee: false,
  }
}

function requireIssuedDurableStorageReservationPlan(
  value: unknown,
): DurableStorageReservationPlan {
  if (typeof value !== 'object' || value === null) {
    throw new Error('storage reservation is not SDK-issued')
  }
  const issuedEncoding = durableStorageReservationAuthorities.get(value)
  if (issuedEncoding === undefined || issuedEncoding !== encodeRecord(value, 'storage reservation')) {
    throw new Error('storage reservation is not SDK-issued')
  }
  return decodeDurableStorageReservationPlan(value)
}

function decodeReservationOperations(
  value: unknown,
  scopeId: string,
): DurableStorageReservationPlan['operations'] {
  const operations = requireBoundedArray(
    value,
    'storage reservation operations',
    DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  ).map((operation) =>
    decodeReservationOperation(operation, scopeId),
  )
  requireOperationCount(operations.length, 'storage reservation operation count')
  requireUniqueValues(
    operations.map((operation) => operation.semanticOperationId),
    'semantic operation id is duplicated',
  )
  return operations
}

function decodeReservationOperation(
  value: unknown,
  scopeId: string,
): DurableStorageReservationPlan['operations'][number] {
  const operation = requireRecord(value, 'storage reservation operation')
  requireKnownFields(operation, [
    'semanticOperationId',
    'exactOperation',
    'proofReferences',
    'privateMaterial',
    'ciphers',
    'transitionOverhead',
    'artifactCount',
    'bytes',
    'state',
  ])
  if (operation.state !== 'reserved' && operation.state !== 'consumed') {
    throw new Error('storage reservation operation state is invalid')
  }
  const components = decodeReservationOperationComponents(operation)
  const summary = summarizeOperationComponents(Object.values(components))
  if (
    operation.artifactCount !== summary.artifactCount ||
    operation.bytes !== summary.bytes
  ) {
    throw new Error('storage reservation operation totals are inconsistent')
  }
  return {
    semanticOperationId: decodeDurableCustodyOperationId(operation.semanticOperationId, scopeId),
    ...components,
    artifactCount: summary.artifactCount,
    bytes: summary.bytes,
    state: operation.state,
  }
}

function decodeReservationOperationComponents(
  operation: Record<string, unknown>,
): Pick<
  DurableStorageReservationPlan['operations'][number],
  'exactOperation' | 'proofReferences' | 'privateMaterial' | 'ciphers' | 'transitionOverhead'
> {
  const exactOperation = decodeMeasuredComponent(
    operation.exactOperation,
    'exact operation',
    { exactCount: 1, artifactRoles: ['exact-operation'] },
  )
  const proofReferences = decodeMeasuredComponent(
    operation.proofReferences,
    'proof references',
    {
      maxCount: DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
      artifactRoles: ['proof-post-image'],
    },
  )
  const privateMaterial = decodeMeasuredComponent(
    operation.privateMaterial,
    'private material',
    { artifactRoles: ['private-material'] },
  )
  const ciphers = decodeMeasuredComponent(operation.ciphers, 'ciphers', {
    artifactRoles: ['cipher'],
  })
  const transitionOverhead = decodeMeasuredComponent(
    operation.transitionOverhead,
    'transition overhead',
    { artifactRoles: ['operation-overhead'] },
  )
  return {
    exactOperation,
    proofReferences,
    privateMaterial,
    ciphers,
    transitionOverhead,
  }
}

function decodeSharedReservationBudget(
  reservation: Record<string, unknown>,
): DurableStorageComponentBudget {
  const artifacts = decodeArtifactCommitments(reservation.sharedArtifacts, 'shared artifacts', 1)
  requireCommitmentArtifactRoles(artifacts, 'shared', [
    'trade-session',
  ])
  const count = requirePositiveInteger(reservation.sharedArtifactCount, 'shared reserved artifact count')
  if (count !== artifacts.length) throw new Error('shared reserved artifact count is inconsistent')
  const bytes = requirePositiveInteger(reservation.sharedBytes, 'shared reserved bytes')
  if (bytes !== artifactCommitmentBytes(artifacts, 'shared reserved bytes')) {
    throw new Error('shared reserved bytes are inconsistent')
  }
  return { artifacts, count, bytes }
}

function calculateReservationTotals(
  operations: DurableStorageReservationPlan['operations'],
  shared: DurableStorageComponentBudget,
): { totalArtifactCount: number; totalBytes: number } {
  return {
    totalArtifactCount: operations.reduce(
      (total, operation) => safeAdd(total, operation.artifactCount, 'reserved artifact count'),
      shared.count,
    ),
    totalBytes: operations.reduce(
      (total, operation) => safeAdd(total, operation.bytes, 'reserved bytes'),
      shared.bytes,
    ),
  }
}

function decodePersistedOperationBudget(
  value: unknown,
  scopeId: string,
): DurableSwapStorageBudget['operations'][number] {
  const operation = requireRecord(value, 'persisted storage operation budget')
  requireKnownFields(operation, [
    'semanticOperationId',
    'exactOperation',
    'proofReferences',
    'privateMaterial',
    'ciphers',
    'transitionOverhead',
    'artifacts',
    'artifactCount',
    'bytes',
  ])
  const components = decodeReservationOperationComponents(operation)
  const summary = summarizeOperationComponents(Object.values(components))
  if (!sameArtifactCommitments(
    decodeArtifactCommitments(
      operation.artifacts,
      'operation artifacts',
      DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX,
    ),
    summary.artifacts,
  )) {
    throw new Error('storage operation artifacts are inconsistent')
  }
  if (operation.artifactCount !== summary.artifactCount || operation.bytes !== summary.bytes) {
    throw new Error('storage operation budget totals are inconsistent')
  }
  return {
    semanticOperationId: decodeDurableCustodyOperationId(operation.semanticOperationId, scopeId),
    ...components,
    ...summary,
  }
}

function decodeMeasuredComponent(
  value: unknown,
  name: string,
  bounds: {
    exactCount?: number
    maxCount?: number
    artifactRoles?: DurableStorageArtifactRole[]
  } = {},
): DurableStorageComponentBudget {
  const component = requireRecord(value, `${name} storage component`)
  requireKnownFields(component, ['artifacts', 'count', 'bytes'])
  const artifacts = decodeArtifactCommitments(
    component.artifacts,
    `${name} artifacts`,
    bounds.exactCount ?? bounds.maxCount ?? DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
  )
  const count = requireNonNegativeInteger(component.count, `${name} count`)
  const bytes = requireNonNegativeInteger(component.bytes, `${name} bytes`)
  if (count !== artifacts.length) throw new Error(`${name} count is inconsistent`)
  if (bytes !== artifactCommitmentBytes(artifacts, `${name} bytes`)) {
    throw new Error(`${name} bytes are inconsistent`)
  }
  requireComponentBounds(name, count, bytes, bounds)
  requireCommitmentArtifactRoles(artifacts, name, bounds.artifactRoles)
  return { artifacts, count, bytes }
}

function decodeOperationBudget(value: unknown, scopeId: string): DurableSwapStorageBudget['operations'][number] {
  const operation = requireRecord(value, 'storage operation budget')
  requireKnownFields(operation, [
    'semanticOperationId',
    'exactOperation',
    'proofReferences',
    'privateMaterial',
    'ciphers',
    'transitionOverhead',
  ])
  const exactOperation = measureComponent([operation.exactOperation], 'exact operation', {
    exactCount: 1,
    artifactRoles: ['exact-operation'],
  })
  const proofReferences = measureComponent(operation.proofReferences, 'proof references', {
    maxCount: DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
    artifactRoles: ['proof-post-image'],
  })
  const privateMaterial = measureComponent(operation.privateMaterial, 'private material', {
    artifactRoles: ['private-material'],
  })
  const ciphers = measureComponent(operation.ciphers, 'ciphers', {
    artifactRoles: ['cipher'],
  })
  const transitionOverhead = measureComponent(operation.transitionOverhead, 'transition overhead', {
    artifactRoles: ['operation-overhead'],
  })
  const components = [exactOperation, proofReferences, privateMaterial, ciphers, transitionOverhead]
  const summary = summarizeOperationComponents(components)
  return {
    semanticOperationId: decodeDurableCustodyOperationId(operation.semanticOperationId, scopeId),
    exactOperation,
    proofReferences,
    privateMaterial,
    ciphers,
    transitionOverhead,
    ...summary,
  }
}

function summarizeOperationComponents(components: DurableStorageComponentBudget[]): {
  artifacts: DurableStorageArtifactCommitment[]
  artifactCount: number
  bytes: number
} {
  const artifacts = components.flatMap((component) => component.artifacts)
  requireUniqueArtifacts(artifacts)
  const artifactCount = components.reduce(
    (total, component) => safeAdd(total, component.count, 'operation artifact count'),
    0,
  )
  const bytes = components.reduce(
    (total, component) => safeAdd(total, component.bytes, 'operation storage bytes'),
    0,
  )
  if (artifactCount > DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX || bytes > DURABLE_STORAGE_OPERATION_BYTES_LIMIT_MAX) {
    throw new Error('storage operation budget exceeds the limit')
  }
  return { artifacts, artifactCount, bytes }
}

function measureComponent(
  value: unknown,
  name: string,
  bounds: {
    exactCount?: number
    maxCount?: number
    artifactRoles?: DurableStorageArtifactRole[]
  } = {},
): DurableStorageComponentBudget {
  const rawArtifacts = requireBoundedArray(
    value,
    `${name} planned storage artifacts`,
    bounds.maxCount ?? DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
  )
  const count = rawArtifacts.length
  requireComponentCountBounds(name, count, bounds)
  const commitments: DurableStorageArtifactCommitment[] = []
  let bytes = 0
  for (const rawArtifact of rawArtifacts) {
    const artifact = decodePlannedArtifact(rawArtifact)
    requireArtifactRoles([artifact], name, bounds.artifactRoles)
    const commitment = commitPlannedArtifact(artifact)
    bytes = safeAdd(bytes, commitment.byteLength, `${name} bytes`)
    if (bytes > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
      throw new Error(`${name} bytes exceed the limit`)
    }
    commitments.push(commitment)
  }
  requireComponentBounds(name, count, bytes, bounds)
  requireUniqueArtifacts(commitments)
  return { artifacts: commitments, count, bytes }
}

function requireComponentCountBounds(
  name: string,
  count: number,
  bounds: { exactCount?: number; maxCount?: number },
): void {
  if (bounds.exactCount !== undefined && count !== bounds.exactCount) {
    throw new Error(`${name} count is invalid`)
  }
  if (count > (bounds.maxCount ?? DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX)) {
    throw new Error(`${name} count exceeds the limit`)
  }
}

function requireComponentBounds(
  name: string,
  count: number,
  bytes: number,
  bounds: { exactCount?: number; maxCount?: number },
): void {
  requireComponentCountBounds(name, count, bounds)
  if (bytes > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
    throw new Error(`${name} bytes exceed the limit`)
  }
  if (count > 0 && bytes === 0) throw new Error(`${name} artifact bytes are empty`)
  if (count === 0 && bytes !== 0) throw new Error(`${name} count and bytes are inconsistent`)
}

function requireArtifactRoles(
  artifacts: DurableStoragePlannedArtifact[],
  name: string,
  allowed: DurableStorageArtifactRole[] | undefined,
): void {
  if (allowed === undefined) return
  if (artifacts.some((artifact) => !allowed.includes(artifact.artifactRole))) {
    throw new Error(`${name} artifact role is invalid`)
  }
}

function requireCommitmentArtifactRoles(
  artifacts: DurableStorageArtifactCommitment[],
  name: string,
  allowed: DurableStorageArtifactRole[] | undefined,
): void {
  if (allowed === undefined) return
  if (artifacts.some((artifact) => !allowed.includes(artifact.artifactRole))) {
    throw new Error(`${name} artifact role is invalid`)
  }
}

function decodePlannedArtifact(value: unknown): DurableStoragePlannedArtifact {
  const artifact = requireRecord(value, 'planned storage artifact')
  const artifactId = requireIdentifier(artifact.artifactId, 'planned storage artifact id')
  const artifactRole = decodeArtifactRole(artifact.artifactRole)
  if (artifact.encoding === 'json-utf8') {
    requireKnownFields(artifact, ['artifactId', 'encoding', 'artifactRole', 'encodedJson'])
    const encodedJson = requireNonEmptyString(artifact.encodedJson, 'planned JSON storage artifact')
    if (encodedJson.length > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
      throw new Error('planned JSON storage artifact exceeds the byte limit')
    }
    let canonical: string | undefined
    try {
      canonical = JSON.stringify(JSON.parse(encodedJson))
    } catch {
      throw new Error('planned JSON storage artifact is invalid')
    }
    if (canonical !== encodedJson) throw new Error('planned JSON storage artifact is not canonical')
    return { artifactId, encoding: 'json-utf8', artifactRole, encodedJson }
  }
  requireKnownFields(artifact, ['artifactId', 'encoding', 'artifactRole', 'bytes'])
  if (artifact.encoding !== 'binary' || !(artifact.bytes instanceof Uint8Array)) {
    throw new Error('planned storage artifact encoding is invalid')
  }
  if (artifact.bytes.byteLength === 0 || artifact.bytes.byteLength > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
    throw new Error('planned binary storage artifact exceeds the byte limit')
  }
  return { artifactId, encoding: 'binary', artifactRole, bytes: artifact.bytes }
}

function decodeArtifactRole(
  value: unknown,
): DurableStorageArtifactRole {
  if (
    value !== 'trade-session' &&
    value !== 'exact-operation' &&
    value !== 'proof-post-image' &&
    value !== 'private-material' &&
    value !== 'cipher' &&
    value !== 'operation-overhead' &&
    value !== 'transaction-only-retained'
  ) {
    throw new Error('planned storage artifact role is invalid')
  }
  return value
}

function commitPlannedArtifact(artifact: DurableStoragePlannedArtifact): DurableStorageArtifactCommitment {
  const bytes = artifact.encoding === 'binary'
    ? artifact.bytes
    : new TextEncoder().encode(artifact.encodedJson)
  if (bytes.byteLength === 0 || bytes.byteLength > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
    throw new Error('planned storage artifact exceeds the byte limit')
  }
  return {
    artifactId: artifact.artifactId,
    encoding: artifact.encoding,
    artifactRole: artifact.artifactRole,
    byteLength: bytes.byteLength,
    sha256: bytesToHex(sha256(bytes)),
  }
}

function decodeArtifactCommitments(
  value: unknown,
  name: string,
  maximum: number,
): DurableStorageArtifactCommitment[] {
  const raw = requireBoundedArray(value, name, maximum)
  const artifacts = raw.map((item): DurableStorageArtifactCommitment => {
    const artifact = requireRecord(item, 'storage artifact commitment')
    requireKnownFields(artifact, ['artifactId', 'encoding', 'artifactRole', 'byteLength', 'sha256'])
    const encoding = artifact.encoding
    if (encoding !== 'json-utf8' && encoding !== 'binary') {
      throw new Error('storage artifact commitment encoding is invalid')
    }
    const byteLength = requirePositiveInteger(artifact.byteLength, 'storage artifact commitment byte length')
    if (byteLength > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
      throw new Error('storage artifact commitment byte length exceeds the limit')
    }
    return {
      artifactId: requireIdentifier(artifact.artifactId, 'storage artifact id'),
      encoding,
      artifactRole: decodeArtifactRole(artifact.artifactRole),
      byteLength,
      sha256: requireLowerHex32(artifact.sha256, 'storage artifact commitment digest'),
    }
  })
  requireUniqueArtifacts(artifacts)
  return artifacts
}

function artifactCommitmentBytes(artifacts: DurableStorageArtifactCommitment[], name: string): number {
  return artifacts.reduce((total, artifact) => safeAdd(total, artifact.byteLength, name), 0)
}

function requireUniqueArtifacts(artifacts: DurableStorageArtifactCommitment[]): void {
  requireUniqueValues(artifacts.map((artifact) => artifact.artifactId), 'storage artifact id is duplicated')
}

function requireNewArtifactIds(
  existing: Set<string>,
  artifacts: DurableStorageArtifactCommitment[],
): void {
  for (const artifact of artifacts) {
    if (existing.has(artifact.artifactId)) throw new Error('storage artifact id is duplicated')
    existing.add(artifact.artifactId)
  }
}

function copyArtifactCommitment(artifact: DurableStorageArtifactCommitment): DurableStorageArtifactCommitment {
  return { ...artifact }
}

function copyComponentBudget(
  component: DurableStorageComponentBudget,
): DurableStorageComponentBudget {
  return {
    artifacts: component.artifacts.map(copyArtifactCommitment),
    count: component.count,
    bytes: component.bytes,
  }
}

function requireUniqueValues(values: string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message)
}

function sameArtifactCommitments(
  left: DurableStorageArtifactCommitment[],
  right: DurableStorageArtifactCommitment[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const expected = right[index]
    return expected !== undefined
      && value.artifactId === expected.artifactId
      && value.encoding === expected.encoding
      && value.artifactRole === expected.artifactRole
      && value.byteLength === expected.byteLength
      && value.sha256 === expected.sha256
  })
}

function sameArtifactCommitmentSets(
  left: DurableStorageArtifactCommitment[],
  right: DurableStorageArtifactCommitment[],
): boolean {
  if (left.length !== right.length) return false
  const expected = new Map(right.map((artifact) => [artifact.artifactId, artifact]))
  return left.every((artifact) => {
    const match = expected.get(artifact.artifactId)
    return match !== undefined
      && artifact.encoding === match.encoding
      && artifact.artifactRole === match.artifactRole
      && artifact.byteLength === match.byteLength
      && artifact.sha256 === match.sha256
  })
}

function requireOperationCount(count: number, name: string): void {
  if (count === 0 || count > DURABLE_STORAGE_OPERATION_LIMIT_MAX) {
    throw new Error(`${name} exceeds the limit`)
  }
}

function requireSwapTotals(artifactCount: number, bytes: number): void {
  if (artifactCount > DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX) {
    throw new Error('storage artifact count exceeds the limit')
  }
  if (bytes > DURABLE_STORAGE_SWAP_BYTES_LIMIT_MAX) {
    throw new Error('storage budget bytes exceed the limit')
  }
}

function decodeEmergencyHeadroom(value: unknown): DurableStorageAccountingState['emergencyHeadroom'] {
  const headroom = requireRecord(value, 'emergency headroom')
  requireKnownFields(headroom, ['recordId', 'targetBytes', 'state'])
  if (
    headroom.recordId !== 'durable-storage-emergency-headroom' ||
    headroom.targetBytes !== DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES ||
    (headroom.state !== 'ready' && headroom.state !== 'released-for-maintenance')
  ) {
    throw new Error('emergency headroom record is invalid')
  }
  return {
    recordId: 'durable-storage-emergency-headroom',
    targetBytes: DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
    state: headroom.state,
  }
}

function decodePinReference(value: unknown): DurableStoragePinReference {
  const pin = requireRecord(value, 'storage pin reference')
  requireKnownFields(pin, ['scopeId', 'pinId', 'proofId', 'reason', 'referenceId'])
  if (pin.reason !== 'proof-operation' && pin.reason !== 'open-order-collateral') {
    throw new Error('storage pin reason is invalid')
  }
  const scopeId = decodeDurableCustodyScopeId(pin.scopeId)
  const referenceId =
    pin.reason === 'proof-operation'
      ? decodeDurableCustodyOperationId(pin.referenceId, scopeId)
      : requireIdentifier(pin.referenceId, 'storage pin reference id')
  return {
    scopeId,
    pinId: requireIdentifier(pin.pinId, 'storage pin id'),
    proofId: requireLowerHex32(pin.proofId, 'storage pin proof id'),
    reason: pin.reason,
    referenceId,
  }
}

function nextState(
  state: DurableStorageAccountingState,
  changes: Partial<
    Omit<DurableStorageAccountingState, 'schemaVersion' | 'recordId' | 'revision' | 'isBrowserQuotaGuarantee'>
  >,
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
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`missing required field '${key}'`)
    }
  }
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function requireBoundedArray(value: unknown, name: string, maximum: number): unknown[] {
  const items = requireArray(value, name)
  if (items.length > maximum) throw new Error(`${name} count exceeds the limit`)
  return items
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is invalid`)
  return value
}

function preflightPlannedJsonValue(value: unknown): void {
  const pending = [value]
  const seen = new WeakSet<object>()
  let nodes = 0
  let characters = 0
  while (pending.length > 0) {
    const item = pending.pop()
    nodes += 1
    if (nodes > DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX) {
      throw new Error('planned JSON storage artifact structure exceeds the limit')
    }
    if (typeof item === 'string') {
      characters = safeAdd(characters, item.length, 'planned JSON storage artifact size')
    } else if (item === null || typeof item === 'boolean') {
      continue
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('planned JSON storage artifact is invalid')
    } else if (typeof item === 'object') {
      if (seen.has(item)) throw new Error('planned JSON storage artifact is invalid')
      seen.add(item)
      if (Array.isArray(item)) {
        if (item.length > DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX) {
          throw new Error('planned JSON storage artifact structure exceeds the limit')
        }
        pending.push(...item)
      } else {
        const prototype = Object.getPrototypeOf(item)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('planned JSON storage artifact is invalid')
        }
        const entries = Object.entries(item)
        if (entries.length > DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX) {
          throw new Error('planned JSON storage artifact structure exceeds the limit')
        }
        for (const [key, child] of entries) {
          characters = safeAdd(characters, key.length, 'planned JSON storage artifact size')
          pending.push(child)
        }
      }
    } else {
      throw new Error('planned JSON storage artifact is invalid')
    }
    if (characters > DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX) {
      throw new Error('planned JSON storage artifact exceeds the byte limit')
    }
  }
}

function requireLowerHex32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function requireEncodedRecordLimit(value: unknown, name: string): void {
  encodeRecord(value, name)
}

function encodeRecord(value: unknown, name: string): string {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error(`${name} is invalid`)
  }
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX
  ) {
    throw new Error(`${name} exceeds the encoded byte limit`)
  }
  return encoded
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
