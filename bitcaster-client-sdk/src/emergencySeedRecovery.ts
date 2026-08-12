// Re-authored from the ordinary emergency recovery cursor at 7e1385c.
import { advanceSeedScanCursor, classifySeedRecoveryMintState } from './seedRecoveryCore.ts'
import { decodeCanonicalMintOrigin, decodeDurableCustodyScopeId } from './durableCustody.ts'

export const EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION = 1 as const
export const EMERGENCY_SEED_RECOVERY_BATCH_SIZE = 300 as const
export const EMERGENCY_SEED_RECOVERY_GAP_LIMIT = 300 as const
declare const validatedRecoveryCoCommit: unique symbol

export interface EmergencySeedRecoveryCursor {
  schemaVersion: typeof EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION
  recoveryId: string
  walletScopeId: string
  mintUrl: string
  unit: string
  keysetId: string
  nextCounter: number
  trailingEmptyCounters: number
  revision: number
  state: 'active' | 'completed'
}

export interface EmergencySeedRecoveryBatchObservation {
  expectedRevision: number
  startCounter: number
  requestedCount: number
  lastCounterWithSignature: number | null
  scanThroughCounter: number
}

export interface EmergencySeedRecoveryLeaseAuthority {
  walletScopeId: string
  incarnationId: string
  fencingEpoch: number
  observedAtMs: number
  leaseExpiresAtMs: number
  effectiveClockHighWaterMarkMs: number
}

export interface EmergencySeedRecoveryCoCommit {
  readonly [validatedRecoveryCoCommit]: true
  walletScopeId: string
  authority: EmergencySeedRecoveryLeaseAuthority
  expectedCursor: EmergencySeedRecoveryCursor
  expectedCursorRevision: number
  nextCursor: EmergencySeedRecoveryCursor
  observation: EmergencySeedRecoveryBatchObservation
  recoveredProofIds: readonly string[]
  recoveryJobId: string
}

/**
 * Adapter capability: one physical fenced transaction must co-commit the
 * cursor CAS, recovered proofs, deterministic counter range, and recovery job.
 * It must compare the exact scope/incarnation/epoch/lease authority against
 * the durable scope row in that same transaction.
 */
export interface EmergencySeedRecoveryCasStore {
  commitRecoveryBatch(input: EmergencySeedRecoveryCoCommit): Promise<void>
}

export type EmergencySeedRecoveryProofDisposition =
  | 'import-selectable'
  | 'retain-nonselectable'
  | 'ignore-spent'
  | 'fail-closed'

export function createEmergencySeedRecoveryCursor(input: {
  recoveryId: string
  walletScopeId: string
  mintUrl: string
  unit: string
  keysetId: string
}): EmergencySeedRecoveryCursor {
  return validateEmergencySeedRecoveryCursor({
    schemaVersion: EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION,
    ...input,
    nextCounter: 0,
    trailingEmptyCounters: 0,
    revision: 0,
    state: 'active',
  })
}

export function advanceEmergencySeedRecoveryCursor(
  input: EmergencySeedRecoveryCursor,
  observation: EmergencySeedRecoveryBatchObservation,
): EmergencySeedRecoveryCursor {
  const cursor = validateEmergencySeedRecoveryCursor(input)
  if (!safeNonnegativeInteger(observation.scanThroughCounter)) {
    throw new Error('emergency seed recovery scan-through counter is invalid')
  }
  if (cursor.state !== 'active' && observation.scanThroughCounter <= cursor.nextCounter) {
    throw new Error('emergency seed recovery cursor is already completed')
  }
  if (observation.expectedRevision !== cursor.revision) {
    throw new Error('emergency seed recovery cursor revision is stale')
  }
  const last = observation.lastCounterWithSignature
  const advanced = advanceSeedScanCursor(
    {
      nextCounter: cursor.nextCounter,
      consecutiveEmptyOutputs: cursor.trailingEmptyCounters,
    },
    {
      startCounter: observation.startCounter,
      requestedCount: observation.requestedCount,
      returnedCounterOffsets: last === null ? [] : [last - observation.startCounter],
    },
    EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
  )
  return {
    ...cursor,
    nextCounter: advanced.nextCounter,
    trailingEmptyCounters: advanced.consecutiveEmptyOutputs,
    revision: cursor.revision + 1,
    state:
      advanced.consecutiveEmptyOutputs >= EMERGENCY_SEED_RECOVERY_GAP_LIMIT &&
      advanced.nextCounter >= observation.scanThroughCounter
        ? 'completed'
        : 'active',
  }
}

export function createEmergencySeedRecoveryCoCommit(input: {
  cursor: EmergencySeedRecoveryCursor
  observation: EmergencySeedRecoveryBatchObservation
  recoveredProofIds: readonly string[]
  recoveryJobId: string
  authority: EmergencySeedRecoveryLeaseAuthority
}): EmergencySeedRecoveryCoCommit {
  const expectedCursor = validateEmergencySeedRecoveryCursor(input.cursor)
  const nextCursor = advanceEmergencySeedRecoveryCursor(expectedCursor, input.observation)
  return validateEmergencySeedRecoveryCoCommit({
    walletScopeId: expectedCursor.walletScopeId,
    authority: structuredClone(input.authority),
    expectedCursor,
    expectedCursorRevision: input.observation.expectedRevision,
    nextCursor,
    observation: structuredClone(input.observation),
    recoveredProofIds: [...input.recoveredProofIds],
    recoveryJobId: input.recoveryJobId,
  })
}

export async function commitEmergencySeedRecoveryBatch(
  store: EmergencySeedRecoveryCasStore,
  input: EmergencySeedRecoveryCoCommit,
): Promise<void> {
  await store.commitRecoveryBatch(validateEmergencySeedRecoveryCoCommit(input))
}

export function validateEmergencySeedRecoveryCoCommit(
  value: unknown,
): EmergencySeedRecoveryCoCommit {
  if (!isRecord(value)) {
    throw new Error('emergency seed recovery co-commit is invalid')
  }
  exactKeys(value, [
    'walletScopeId',
    'authority',
    'expectedCursor',
    'expectedCursorRevision',
    'nextCursor',
    'observation',
    'recoveredProofIds',
    'recoveryJobId',
  ])
  const expected = validateEmergencySeedRecoveryCursor(value.expectedCursor)
  const next = validateEmergencySeedRecoveryCursor(value.nextCursor)
  if (
    value.walletScopeId !== expected.walletScopeId ||
    next.walletScopeId !== expected.walletScopeId ||
    next.recoveryId !== expected.recoveryId ||
    next.mintUrl !== expected.mintUrl ||
    next.unit !== expected.unit ||
    next.keysetId !== expected.keysetId
  ) {
    throw new Error('emergency seed recovery co-commit scope is foreign')
  }
  if (!isRecord(value.authority)) {
    throw new Error('emergency seed recovery lease authority is invalid')
  }
  exactKeys(value.authority, [
    'walletScopeId',
    'incarnationId',
    'fencingEpoch',
    'observedAtMs',
    'leaseExpiresAtMs',
    'effectiveClockHighWaterMarkMs',
  ])
  boundedText(value.authority.incarnationId, 'incarnation id')
  if (
    value.authority.walletScopeId !== expected.walletScopeId ||
    !safeNonnegativeInteger(value.authority.fencingEpoch) ||
    (value.authority.fencingEpoch as number) === 0 ||
    !safeNonnegativeInteger(value.authority.observedAtMs) ||
    !safeNonnegativeInteger(value.authority.leaseExpiresAtMs) ||
    !safeNonnegativeInteger(value.authority.effectiveClockHighWaterMarkMs) ||
    (value.authority.observedAtMs as number) <
      (value.authority.effectiveClockHighWaterMarkMs as number) ||
    (value.authority.observedAtMs as number) >= (value.authority.leaseExpiresAtMs as number)
  ) {
    throw new Error('emergency seed recovery lease authority is not live')
  }
  if (!isRecord(value.observation)) {
    throw new Error('emergency seed recovery batch observation is invalid')
  }
  exactKeys(value.observation, [
    'expectedRevision',
    'startCounter',
    'requestedCount',
    'lastCounterWithSignature',
    'scanThroughCounter',
  ])
  const observation = value.observation as unknown as EmergencySeedRecoveryBatchObservation
  if (!safeNonnegativeInteger(observation.scanThroughCounter)) {
    throw new Error('emergency seed recovery scan-through counter is invalid')
  }
  if (
    value.expectedCursorRevision !== expected.revision ||
    observation.expectedRevision !== expected.revision ||
    next.revision !== expected.revision + 1
  ) {
    throw new Error('emergency seed recovery co-commit cursor CAS is invalid')
  }
  const recomputed = advanceEmergencySeedRecoveryCursor(expected, observation)
  if (!emergencySeedRecoveryCursorsEqual(recomputed, next)) {
    throw new Error('emergency seed recovery co-commit cursor is inconsistent')
  }
  boundedText(value.recoveryJobId, 'job id')
  if (
    !Array.isArray(value.recoveredProofIds) ||
    value.recoveredProofIds.length > EMERGENCY_SEED_RECOVERY_BATCH_SIZE
  ) {
    throw new Error('emergency seed recovery proof batch is invalid')
  }
  const proofIds = value.recoveredProofIds.map((proofId) => {
    if (typeof proofId !== 'string' || !/^[0-9a-f]{64}$/.test(proofId)) {
      throw new Error('emergency seed recovery proof id is invalid')
    }
    return proofId
  })
  if (proofIds.length > observation.requestedCount || new Set(proofIds).size !== proofIds.length) {
    throw new Error('emergency seed recovery proof batch is inconsistent')
  }
  return structuredClone(value) as unknown as EmergencySeedRecoveryCoCommit
}

export function classifyEmergencySeedRecoveryProof(
  state: unknown,
): EmergencySeedRecoveryProofDisposition {
  switch (classifySeedRecoveryMintState(state)) {
    case 'selectable':
      return 'import-selectable'
    case 'spent':
      return 'ignore-spent'
    case 'retain-nonselectable':
      return 'retain-nonselectable'
    case 'fail-closed':
      return 'fail-closed'
  }
}

export function validateEmergencySeedRecoveryCursor(value: unknown): EmergencySeedRecoveryCursor {
  if (!isRecord(value)) {
    throw new Error('emergency seed recovery cursor is invalid')
  }
  const fields = [
    'schemaVersion',
    'recoveryId',
    'walletScopeId',
    'mintUrl',
    'unit',
    'keysetId',
    'nextCounter',
    'trailingEmptyCounters',
    'revision',
    'state',
  ]
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new Error('emergency seed recovery cursor contains foreign fields')
  }
  if (value.schemaVersion !== EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION) {
    throw new Error('emergency seed recovery schema is unsupported')
  }
  for (const [label, text] of [
    ['recovery id', value.recoveryId],
    ['mint URL', value.mintUrl],
    ['mint unit', value.unit],
    ['keyset id', value.keysetId],
  ] as const) {
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      new TextEncoder().encode(text).length > 4_096
    ) {
      throw new Error(`emergency seed recovery ${label} is invalid`)
    }
  }
  decodeDurableCustodyScopeId(value.walletScopeId)
  decodeCanonicalMintOrigin(value.mintUrl)
  for (const [label, count] of [
    ['next counter', value.nextCounter],
    ['trailing empty counter count', value.trailingEmptyCounters],
    ['cursor revision', value.revision],
  ] as const) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`emergency seed recovery ${label} is invalid`)
    }
  }
  if ((value.trailingEmptyCounters as number) > (value.nextCounter as number)) {
    throw new Error('emergency seed recovery cursor counters are inconsistent')
  }
  if (
    (value.state !== 'active' && value.state !== 'completed') ||
    (value.state === 'completed' &&
      (value.trailingEmptyCounters as number) < EMERGENCY_SEED_RECOVERY_GAP_LIMIT)
  ) {
    throw new Error('emergency seed recovery completion state is inconsistent')
  }
  return structuredClone(value) as unknown as EmergencySeedRecoveryCursor
}

export const decodeEmergencySeedRecoveryCursor = validateEmergencySeedRecoveryCursor

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new Error('emergency seed recovery value contains foreign fields')
  }
}

function boundedText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > 4_096
  ) {
    throw new Error(`emergency seed recovery ${label} is invalid`)
  }
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function emergencySeedRecoveryCursorsEqual(
  left: EmergencySeedRecoveryCursor,
  right: EmergencySeedRecoveryCursor,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.recoveryId === right.recoveryId &&
    left.walletScopeId === right.walletScopeId &&
    left.mintUrl === right.mintUrl &&
    left.unit === right.unit &&
    left.keysetId === right.keysetId &&
    left.nextCounter === right.nextCounter &&
    left.trailingEmptyCounters === right.trailingEmptyCounters &&
    left.revision === right.revision &&
    left.state === right.state
  )
}
