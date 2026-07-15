/**
 * Canonical, persistence-neutral durable custody state. Adapters own their
 * transactions and physical layout; this module owns the record shape and the
 * decisions that must agree across them.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const DURABLE_CUSTODY_SCHEMA_VERSION = 1 as const
export const DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX = 16 * 1_024

type CustodyScopeKind = 'wallet' | 'market'
type CustodyRole = 'buyer' | 'seller'
type CustodyTradeStage =
  | 'lock'
  | 'claim'
  | 'refund'
  | 'receive'
  | 'send'
  | 'ctf-split'
  | 'ctf-merge'
  | 'ctf-redeem'

type CustodyWalletStage =
  | 'send'
  | 'receive'
  | 'ctf-split'
  | 'ctf-merge'
  | 'ctf-redeem'

export type DurableCustodySemanticKind =
  | 'swap-lock'
  | 'swap-claim'
  | 'swap-refund'
  | 'conditional-keyset-swap'
  | 'generic-receive'
  | 'generic-send'
  | 'ctf-split'
  | 'ctf-merge'
  | 'ctf-redeem'

export type DurableCustodyOperationState =
  | 'dispatch-intent'
  | 'transport-attempted'
  | 'reconciled'
  | 'aborted'

export type DurableCustodyCurve = 'secp256k1' | 'bls12-381'

export type DurableCustodyScope =
  | {
    scopeKind: 'wallet'
    walletId: string
    scopeId: string
  }
  | {
    scopeKind: 'market'
    marketId: string
    inventoryAccountId: string
    normalizedMint: string
    unit: string
    scopeId: string
  }

export type DurableCustodyScopeInput =
  | { scopeKind: 'wallet'; walletId: string }
  | {
    scopeKind: 'market'
    marketId: string
    inventoryAccountId: string
    normalizedMint: string
    unit: string
  }

export interface DurableCustodyOperationIdentity {
  retainedOperationKey: string
  binding:
    | {
        kind: 'trade'
        tradeId: string
        role: CustodyRole
        stage: CustodyTradeStage
      }
    | {
        kind: 'wallet'
        activityId: string
        stage: CustodyWalletStage
      }
}

export type DurableCustodyBinding =
  | {
      kind: 'trade'
      tradeId: string
      role: CustodyRole
      stage: CustodyTradeStage
      sessionId: string
      immutableTradeFingerprint: string
      hasDependentOperation: boolean
    }
  | {
      kind: 'wallet'
      activityId: string
      stage: CustodyWalletStage
    }

export interface DurableProofOperationKeysetFactsInput {
  keysetId: string
  unit: string
  curve: DurableCustodyCurve
  publicKeys: Readonly<Record<string, string>>
  keysetExpiryMs: number | null
  requireDleq: boolean
  usedByInputs: boolean
  usedByOutputs: boolean
}

/**
 * Exact verification and authority facts prepared by code that has the real
 * mint keys. Persistence adapters consume this value; they must never infer a
 * curve, hash a keyset id in place of the public keys, or choose a DLEQ policy.
 */
export interface DurableProofOperationFacts {
  unit: string
  binding: DurableCustodyBinding
  horizon: DurableCustodyRecord['operation']['horizon']
  verification: {
    hasOutputs: boolean
    keysetBindings: DurableCustodyRecord['operation']['verification']['keysetBindings']
    inputKeysets: Array<{
      keysetId: string
      curve: DurableCustodyCurve
    }>
    outputKeysets: DurableCustodyRecord['operation']['verification']['outputKeysets']
  }
}

export interface DurableProofOperationFactsInput {
  unit: string
  binding: DurableCustodyBinding
  horizon: Omit<DurableCustodyRecord['operation']['horizon'], 'keysetExpiryMs'>
  hasOutputs: boolean
  inputKeysetRequirement: 'required' | 'none'
  keysets: readonly DurableProofOperationKeysetFactsInput[]
}

export interface DurableCustodyDispatchIntentInput {
  scope: DurableCustodyScope
  retainedOperationKey: string
  semanticKind: DurableCustodySemanticKind
  facts: DurableProofOperationFacts
  normalizedMint: string
  inventoryAccountId: string | null
  reservation: DurableCustodyRecord['operation']['reservation']
  exactRequest: DurableCustodyRecord['operation']['exactRequest']
  outputPlan: DurableCustodyRecord['operation']['outputPlan']
  privateMaterial: DurableCustodyRecord['operation']['privateMaterial']
}

export interface DurableCustodySemanticPolicy {
  stage: CustodyTradeStage | CustodyWalletStage
  bindingKind: DurableCustodyBinding['kind'] | 'either'
  terminalReplayEvidenceRequired: boolean
  requireNotBefore: boolean
  requireNotAfter: boolean
}

/** Input to the global active-proof identity; the secret is never persisted in this record. */
export interface DurableCustodyProofIdentityInput {
  normalizedMint: string
  unit: string
  keysetId: string
  secret: string
}

export interface DurableCustodyRecord {
  schemaVersion: typeof DURABLE_CUSTODY_SCHEMA_VERSION
  revision: number
  scope: DurableCustodyScope
  operation: {
    operationId: string
    retainedOperationKey: string
    binding: DurableCustodyBinding
    semanticKind: DurableCustodySemanticKind
    state: DurableCustodyOperationState
    terminalReplayEvidenceRequired: boolean
    custodyContext: {
      normalizedMint: string
      unit: string
      inventoryAccountId: string | null
    }
    reservation: {
      reservationId: string
      parentReservationId: string | null
      inputs: Array<{
        proofId: string
        keysetId: string
        curve: DurableCustodyCurve
      }>
    }
    exactRequest: {
      requestId: string
      requestFingerprint: string
      payloadHandle: string
      inputProofIds: string[]
      outputPlanFingerprint: string
    }
    outputPlan: {
      outputPlanId: string
      outputPlanFingerprint: string
      outputMaterialHandle: string
    }
    privateMaterial: {
      materialHandle: string
      useId: string
      publicFingerprint: string
    }
    result: {
      state: 'none' | 'verified-staged' | 'applied'
      resultHandle: string | null
      resultFingerprint: string | null
      outputPlanFingerprint: string | null
    }
    verification: {
      outputPlanFingerprint: string
      hasOutputs: boolean
      keysetBindings: Array<{
        keysetId: string
        curve: DurableCustodyCurve
        keysetFingerprint: string
        requireDleq: boolean
      }>
      outputKeysets: Array<{
        keysetId: string
        curve: DurableCustodyCurve
      }>
    }
    delivery: {
      deliveryKind: 'none' | 'outbox'
      deliveryId: string | null
      payloadHandle: string | null
      payloadFingerprint: string | null
      expiresAtMs: number | null
      state: 'none' | 'pending' | 'acknowledged' | 'expired'
    }
    retry: {
      attempt: number
      nextAttemptAtMs: number | null
      reason: 'none' | 'pending-or-mixed' | 'mint-response-unknown' | 'rate-limited' | 'reservation-race'
    }
    horizon: {
      notBeforeMs: number | null
      notAfterMs: number | null
      safetyMarginMs: number
      keysetExpiryMs: number | null
    }
  }
  terminalTombstone: null | {
    tombstoneId: string
    tradeId: string
    authenticatedTerminalStatus: boolean
    replayCutoffObserved: boolean
  }
}

/**
 * The one authoritative mutable row for a custody scope. It is deliberately
 * separate from operation records: a takeover must fence every operation in
 * the scope without rewriting a variable number of operation rows.
 */
export interface DurableCustodyScopeState {
  schemaVersion: typeof DURABLE_CUSTODY_SCHEMA_VERSION
  scope: DurableCustodyScope
  /** Monotonic fencing authority retained even while the scope is unowned. */
  fencingEpoch: number
  /** `null` is the only canonical state before an adapter has granted a lease. */
  owner: null | {
    incarnationId: string
    leaseExpiresAtMs: number
  }
  effectiveClock: {
    highWaterMarkMs: number
  }
}

export interface DurableCustodyState {
  scopeState: DurableCustodyScopeState
  operation: DurableCustodyRecord
}

export type DurableCustodyRecoveryClassification =
  | 'all-inputs-unspent'
  | 'spent-restorable'
  | 'pending-or-mixed'
  | 'mint-response-unknown'
  | 'rate-limited'
  | 'reservation-race'
  | 'engine-terminal'
  | 'corrupt'
  | 'foreign'

export interface DurableCustodySafeAbortEvidence {
  operationState: DurableCustodyOperationState
  submissionState: 'not-submitted' | 'submitted' | 'unknown'
  exactInputStates: readonly ('unspent' | 'spent' | 'pending' | 'unknown')[]
  exactRequestDisposition: 'deterministically-rejected' | 'not-rejected' | 'unknown'
  hasDependentJournaledIntent: boolean
  hasStagedResult: boolean
  deliveryState: 'none' | 'pending' | 'acknowledged' | 'expired'
}

/** One canonical safe-abort predicate used by both decisions and transitions. */
export function isDurableCustodySafeAbortEligible(
  evidence: DurableCustodySafeAbortEvidence,
): boolean {
  return evidence.operationState === 'dispatch-intent'
    && evidence.submissionState === 'not-submitted'
    && evidence.exactInputStates.length > 0
    && evidence.exactInputStates.every((state) => state === 'unspent')
    && evidence.exactRequestDisposition === 'deterministically-rejected'
    && evidence.hasDependentJournaledIntent === false
    && evidence.hasStagedResult === false
    && evidence.deliveryState === 'none'
}

export type DurableCustodyRetryReason =
  | 'pending-or-mixed'
  | 'mint-response-unknown'
  | 'rate-limited'
  | 'reservation-race'

export interface DurableCustodyOwnerAuthorization {
  incarnationId: string
  fencingEpoch: number
  observedAtMs: number
}

/**
 * Storage-neutral transaction surface. The callback is intentionally
 * synchronous: an adapter must finish all awaits and reducer decisions before
 * it enters its physical transaction, so Dexie cannot auto-commit around a
 * foreign await.
 */
export interface DurableCustodyStore extends DurableCustodyActiveRecoveryPageStore {
  /**
   * Atomically registers the scope before it owns any proof. Market adapters
   * must enforce both `marketId` uniqueness and
   * `(normalizedMint, unit, inventoryAccountId)` uniqueness in this call.
   */
  registerScope(scope: DurableCustodyScope): Promise<DurableCustodyScopeState>
  /** Reads existing fencing authority without creating missing custody state. */
  readScope(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState | null>
  /** Claims an unowned or expired scope and advances its fencing epoch. */
  claimScope(input: DurableCustodyScopeClaimInput): Promise<DurableCustodyScopeState>
  /** Extends the exact current owner's lease without advancing its epoch. */
  renewScope(input: DurableCustodyScopeLeaseInput): Promise<DurableCustodyScopeState>
  /** Clears the exact current owner while preserving its fencing epoch. */
  releaseScope(input: DurableCustodyScopeReleaseInput): Promise<DurableCustodyScopeState>
  transact<T>(
    input: DurableCustodyTransactionInput,
    apply: DurableCustodyTransactionWork<T>,
  ): Promise<T>
  rebuildActiveWorkIndex(scope: DurableCustodyScope): Promise<'rebuilt' | 'unavailable'>
}

/** Isolated compatibility surface; never accepted by canonical recovery coordinators. */
export interface LegacyUnboundedDurableCustodyStore {
  listRecoverable(scope: DurableCustodyScope): Promise<DurableCustodyRecord[]>
}

export const DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX = 256 as const
export const DURABLE_CUSTODY_RECORD_MAX_BYTES = 64 * 1_024
export const DURABLE_CUSTODY_RECOVERY_PAGE_MAX_BYTES = 4 * 1_024 * 1_024
export const DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX = 256 as const
export const DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX = 256 as const
export const DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX = 256 as const

export interface DurableCustodyRecoveryPageInput {
  scope: DurableCustodyScope
  cursor: string | null
  limit: number
}

export interface DurableCustodyRecoveryPage {
  records: DurableCustodyRecord[]
  nextCursor: string | null
}

/** Minimal canonical active-recovery capability implemented by every migrated adapter. */
export interface DurableCustodyActiveRecoveryPageStore {
  listRecoverablePage(input: DurableCustodyRecoveryPageInput): Promise<DurableCustodyRecoveryPage>
}

/**
 * Reads and validates one bounded page. Missing capability throws and never
 * invokes the deprecated unbounded scan.
 */
export async function readDurableCustodyRecoveryPage(
  store: DurableCustodyActiveRecoveryPageStore,
  input: DurableCustodyRecoveryPageInput,
): Promise<DurableCustodyRecoveryPage> {
  const listPage = (store as Partial<DurableCustodyActiveRecoveryPageStore>).listRecoverablePage
  if (typeof listPage !== 'function') {
    throw new Error('bounded durable custody recovery is unavailable')
  }
  const limit = requireNonNegativeInteger(input.limit, 'recovery page limit')
  if (limit < 1 || limit > DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX) {
    throw new Error('recovery page limit is invalid')
  }
  const cursor = input.cursor === null ? null : requireIdentifier(input.cursor, 'recovery page cursor')
  const scope = decodeScope(input.scope)
  const rawPage = requireRecord(await listPage.call(store, { scope, cursor, limit }), 'recovery page')
  requireJsonByteLimit(rawPage, DURABLE_CUSTODY_RECOVERY_PAGE_MAX_BYTES, 'recovery page')
  requireKnownFields(rawPage, ['records', 'nextCursor'])
  if (!Array.isArray(rawPage.records)) throw new Error('recovery page records are invalid')
  if (rawPage.records.length > limit) throw new Error('recovery page exceeds requested limit')
  for (const rawRecord of rawPage.records) {
    requireJsonByteLimit(rawRecord, DURABLE_CUSTODY_RECORD_MAX_BYTES, 'durable custody record')
  }
  const records = rawPage.records.map((record) => decodeDurableCustodyRecordWithinLimit(record, scope))
  const operationIds = new Set(records.map((record) => record.operation.operationId))
  if (operationIds.size !== records.length) {
    throw new Error('recovery page operation id is duplicated')
  }
  if (records.some((record) => !isDecodedDurableCustodyActiveRecoveryRecord(record))) {
    throw new Error('recovery page contains inactive record')
  }
  const nextCursor = rawPage.nextCursor === null
    ? null
    : requireIdentifier(rawPage.nextCursor, 'next recovery page cursor')
  if (records.length === 0 && nextCursor !== null) {
    throw new Error('empty recovery page cannot advance a cursor')
  }
  if (nextCursor !== null && nextCursor === cursor) {
    throw new Error('recovery page cursor did not advance')
  }
  return { records, nextCursor }
}

/** True only while a record still needs recovery, delivery, or tombstone work. */
export function isDurableCustodyActiveRecoveryRecord(record: DurableCustodyRecord): boolean {
  const decoded = decodeDurableCustodyRecord(record)
  return isDecodedDurableCustodyActiveRecoveryRecord(decoded)
}

/** True only while exact input proofs remain owned by an in-flight operation. */
export function isDurableCustodyProofReservationActive(
  record: DurableCustodyRecord,
): boolean {
  const decoded = decodeDurableCustodyRecord(record)
  switch (decoded.operation.state) {
    case 'dispatch-intent':
    case 'transport-attempted':
      return true
    case 'aborted':
    case 'reconciled':
      return false
  }
}

function isDecodedDurableCustodyActiveRecoveryRecord(decoded: DurableCustodyRecord): boolean {
  switch (decoded.operation.state) {
    case 'dispatch-intent':
    case 'transport-attempted':
      return true
    case 'aborted':
      return false
    case 'reconciled':
      return decoded.operation.delivery.state === 'pending'
        || (decoded.operation.terminalReplayEvidenceRequired
          && (decoded.terminalTombstone === null
            || !decoded.terminalTombstone.authenticatedTerminalStatus
            || !decoded.terminalTombstone.replayCutoffObserved))
  }
}

export interface DurableCustodyScopeClaimInput {
  scope: DurableCustodyScope
  incarnationId: string
  observedAtMs: number
  leaseExpiresAtMs: number
}

export interface DurableCustodyScopeLeaseInput
  extends DurableCustodyOwnerAuthorization {
  scope: DurableCustodyScope
  leaseExpiresAtMs: number
}

export interface DurableCustodyScopeReleaseInput
  extends DurableCustodyOwnerAuthorization {
  scope: DurableCustodyScope
}

export interface DurableCustodyTransactionInput {
  scope: DurableCustodyScope
  owner: DurableCustodyOwnerAuthorization
  /** Exact bounded operation rows the synchronous callback may read or write. */
  operationIds: readonly string[]
}

/** Validates the bounded operation row set before an adapter enters storage. */
export function decodeDurableCustodyTransactionOperationIds(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error('custody transaction operation ids are invalid')
  }
  if (value.length > DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX) {
    throw new Error('custody transaction operation limit is exceeded')
  }
  const operationIds = value.map((operationId) =>
    requireIdentifier(operationId, 'custody transaction operation id'),
  )
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error('custody transaction operation id is duplicated')
  }
  return operationIds
}

/**
 * Logical rows that every adapter must apply in one physical transaction.
 * Payload handles are opaque: secret bearer material never becomes an SDK log,
 * metric, storage key, or error value.
 */
export interface DurableCustodyTransaction {
  getScopeState(): DurableCustodyScopeState
  putScopeState(state: DurableCustodyScopeState): void
  getOperation(operationId: string): DurableCustodyRecord | null
  putOperation(record: DurableCustodyRecord): void
  getSessionLink(
    sessionId: string,
    operationId: string,
  ): Extract<DurableCustodyBinding, { kind: 'trade' }> | null
  putSessionLink(
    operationId: string,
    link: Extract<DurableCustodyBinding, { kind: 'trade' }>,
  ): void
  reserveExactInputs(input: {
    operationId: string
    reservationId: string
    proofIds: readonly string[]
  }): void
  /** Applies one SDK-validated operation transition using this transaction's fenced owner. */
  transitionOperation(input: {
    operationId: string
    transition: DurableCustodyOperationTransition
  }): void
  stageVerifiedResult(input: {
    operationId: string
    outputPlanFingerprint: string
    resultHandle: string
    resultFingerprint: string
  }): void
  applyVerifiedResult(input: {
    operationId: string
    outputPlanFingerprint: string
    resultHandle: string
    resultFingerprint: string
  }): void
  putDelivery(input: {
    operationId: string
    deliveryKind: 'cipher' | 'settlement' | 'wallet-send'
    payloadHandle: string
    payloadFingerprint: string
    expiresAtMs: number | null
    state: 'pending' | 'acknowledged' | 'expired'
  }): void
  rebuildActiveWorkIndex(): void
}

export type DurableCustodyTransactionWork<T> = (transaction: DurableCustodyTransaction) => T

/**
 * Adapters invoke this inside their physical transaction callback. It rejects
 * foreign awaits before an IndexedDB/Dexie transaction can be split into
 * multiple commits.
 */
export function applyDurableCustodyTransaction<T>(
  transaction: DurableCustodyTransaction,
  apply: DurableCustodyTransactionWork<T>,
): T {
  const result = apply(transaction)
  if (isThenable(result)) {
    throw new Error('durable custody transaction callback must not await')
  }
  return result
}

export type DurableCustodyRecoveryInput = DurableCustodyOwnerAuthorization & {
  classification: DurableCustodyRecoveryClassification
  exactRequestDisposition: 'not-rejected' | 'deterministically-rejected' | 'unknown'
  scopeId: string
  operationId: string
  requestFingerprint: string
  outputPlanFingerprint: string
}

export type DurableCustodyRecoveryDecision =
  | {
    kind: 'reissue-exact-operation'
    effectiveNowMs: number
    exact: DurableCustodyExactOperationReference
  }
  | { kind: 'abort-no-transport'; effectiveNowMs: number }
  | {
    kind: 'reconcile-exact-operation'
    reason: 'transport-attempted' | 'spent-restorable' | 'verified-result-staged' | 'unclassified'
    exact: DurableCustodyExactOperationReference
  }
  | { kind: 'retry-later'; effectiveNowMs: number }
  | { kind: 'fail-closed'; reason: 'corrupt' | 'foreign' }

/** The only persisted material a recovery dispatcher may dereference. */
export interface DurableCustodyExactOperationReference {
  scopeId: string
  operationId: string
  requestFingerprint: string
  requestPayloadHandle: string
  outputPlanFingerprint: string
  outputMaterialHandle: string
  privateMaterial: {
    materialHandle: string
    useId: string
    publicFingerprint: string
  }
  stagedResult: null | {
    resultHandle: string
    resultFingerprint: string
    outputPlanFingerprint: string
  }
}

export type DurableCustodyTransition =
  | ({
    kind: 'owner-claimed'
    nextIncarnationId: string
    nextFencingEpoch: number
    nextLeaseExpiresAtMs: number
  } & Pick<DurableCustodyOwnerAuthorization, 'observedAtMs'>)
  | ({
    kind: 'owner-renewed'
    nextLeaseExpiresAtMs: number
  } & DurableCustodyOwnerAuthorization)
  | ({ kind: 'owner-released' } & DurableCustodyOwnerAuthorization)
  | ({ kind: 'transport-attempted' } & DurableCustodyOwnerAuthorization)
  | ({
    kind: 'retry-scheduled'
    reason: DurableCustodyRetryReason
    nextAttemptAtMs: number
  } & DurableCustodyOwnerAuthorization)
  | ({
    kind: 'verified-result-staged'
    resultHandle: string
    resultFingerprint: string
    outputPlanFingerprint: string
  } & DurableCustodyOwnerAuthorization)
  | ({
    kind: 'abort-no-transport'
    classification: 'all-inputs-unspent'
    exactRequestDisposition: 'deterministically-rejected'
  } & DurableCustodyOwnerAuthorization)
  | ({
    kind: 'reconciled'
    recoverySource: 'transport-attempted' | 'spent-restorable' | 'verified-result-staged'
  } & DurableCustodyOwnerAuthorization)
  | ({
    kind: 'delivery-resolved'
    deliveryState: 'acknowledged' | 'expired'
  } & DurableCustodyOwnerAuthorization)
  | ({ kind: 'terminal-tombstone-created'; tombstoneId: string } & DurableCustodyOwnerAuthorization)
  | ({ kind: 'terminal-tombstone-confirmed'; authenticatedTradeId: string } & DurableCustodyOwnerAuthorization)

/** Operation transition input after the adapter has bound its fenced transaction owner. */
export type DurableCustodyOperationTransition =
  | { kind: 'transport-attempted' }
  | {
    kind: 'retry-scheduled'
    reason: DurableCustodyRetryReason
    nextAttemptAtMs: number
  }
  | {
    kind: 'verified-result-staged'
    resultHandle: string
    resultFingerprint: string
    outputPlanFingerprint: string
  }
  | {
    kind: 'abort-no-transport'
    classification: 'all-inputs-unspent'
    exactRequestDisposition: 'deterministically-rejected'
  }
  | {
    kind: 'reconciled'
    recoverySource: 'transport-attempted' | 'spent-restorable' | 'verified-result-staged'
  }
  | { kind: 'delivery-resolved'; deliveryState: 'acknowledged' | 'expired' }
  | { kind: 'terminal-tombstone-created'; tombstoneId: string }
  | { kind: 'terminal-tombstone-confirmed'; authenticatedTradeId: string }

/** Pure scope-only claim reducer used by every physical adapter. */
export function claimDurableCustodyScope(
  scopeState: DurableCustodyScopeState,
  transition: Extract<DurableCustodyTransition, { kind: 'owner-claimed' }>,
): DurableCustodyScopeState {
  validateScopeState(scopeState, scopeState.scope)
  return claimOwner(scopeState, transition)
}

/** Extends only the exact current owner's live lease. */
export function renewDurableCustodyScope(
  scopeState: DurableCustodyScopeState,
  transition: Extract<DurableCustodyTransition, { kind: 'owner-renewed' }>,
): DurableCustodyScopeState {
  validateScopeState(scopeState, scopeState.scope)
  return renewOwner(scopeState, transition)
}

/** Releases only the exact current owner and preserves the fencing epoch. */
export function releaseDurableCustodyScope(
  scopeState: DurableCustodyScopeState,
  transition: Extract<DurableCustodyTransition, { kind: 'owner-released' }>,
): DurableCustodyScopeState {
  validateScopeState(scopeState, scopeState.scope)
  return releaseOwner(scopeState, transition)
}

const SCOPE_KINDS: readonly CustodyScopeKind[] = ['wallet', 'market']
const ROLES: readonly CustodyRole[] = ['buyer', 'seller']
const STAGES: readonly CustodyTradeStage[] = [
  'lock', 'claim', 'refund', 'receive', 'send', 'ctf-split', 'ctf-merge', 'ctf-redeem',
]
const WALLET_STAGES: readonly CustodyWalletStage[] = [
  'send', 'receive', 'ctf-split', 'ctf-merge', 'ctf-redeem',
]
const SEMANTIC_KINDS: readonly DurableCustodySemanticKind[] = [
  'swap-lock', 'swap-claim', 'swap-refund', 'generic-receive', 'generic-send',
  'conditional-keyset-swap', 'ctf-split', 'ctf-merge', 'ctf-redeem',
]
const STATES: readonly DurableCustodyOperationState[] = [
  'dispatch-intent', 'transport-attempted', 'reconciled', 'aborted',
]
const CURVES: readonly DurableCustodyCurve[] = ['secp256k1', 'bls12-381']
const RETRY_REASONS: readonly DurableCustodyRetryReason[] = [
  'pending-or-mixed', 'mint-response-unknown', 'rate-limited', 'reservation-race',
]

const SEMANTIC_STAGE_BINDINGS: Readonly<Record<
  DurableCustodySemanticKind,
  CustodyTradeStage | CustodyWalletStage
>> = {
  'swap-lock': 'lock',
  'swap-claim': 'claim',
  'swap-refund': 'refund',
  'conditional-keyset-swap': 'lock',
  'generic-receive': 'receive',
  'generic-send': 'send',
  'ctf-split': 'ctf-split',
  'ctf-merge': 'ctf-merge',
  'ctf-redeem': 'ctf-redeem',
}

const SEMANTIC_TERMINAL_REPLAY_REQUIREMENTS: Readonly<Record<DurableCustodySemanticKind, boolean>> = {
  'swap-lock': true,
  'swap-claim': true,
  'swap-refund': true,
  'conditional-keyset-swap': true,
  'generic-receive': false,
  'generic-send': false,
  'ctf-split': false,
  'ctf-merge': false,
  'ctf-redeem': false,
}

const SEMANTIC_BINDING_KINDS: Readonly<Record<
  DurableCustodySemanticKind,
  DurableCustodyBinding['kind'] | 'either'
>> = {
  'swap-lock': 'trade',
  'swap-claim': 'trade',
  'swap-refund': 'trade',
  'conditional-keyset-swap': 'trade',
  'generic-receive': 'wallet',
  'generic-send': 'either',
  'ctf-split': 'either',
  'ctf-merge': 'either',
  'ctf-redeem': 'wallet',
}

const SEMANTIC_HORIZON_RULES: Readonly<Record<DurableCustodySemanticKind, {
  requireNotBefore: boolean
  requireNotAfter: boolean
}>> = {
  'swap-lock': { requireNotBefore: false, requireNotAfter: true },
  'swap-claim': { requireNotBefore: false, requireNotAfter: true },
  'swap-refund': { requireNotBefore: true, requireNotAfter: false },
  'conditional-keyset-swap': { requireNotBefore: false, requireNotAfter: true },
  'generic-receive': { requireNotBefore: false, requireNotAfter: false },
  'generic-send': { requireNotBefore: false, requireNotAfter: false },
  'ctf-split': { requireNotBefore: false, requireNotAfter: false },
  'ctf-merge': { requireNotBefore: false, requireNotAfter: false },
  'ctf-redeem': { requireNotBefore: false, requireNotAfter: false },
}

const CUSTODY_WALLET_ID_DOMAIN = new TextEncoder().encode(
  'bitcaster/durable-custody-wallet-id/v1\0',
)

/** Returns the one SDK-owned policy for a persisted custody semantic. */
export function durableCustodySemanticPolicy(
  semanticKind: DurableCustodySemanticKind,
): DurableCustodySemanticPolicy {
  requireOneOf(semanticKind, SEMANTIC_KINDS, 'operation semantic kind')
  return {
    stage: SEMANTIC_STAGE_BINDINGS[semanticKind],
    bindingKind: SEMANTIC_BINDING_KINDS[semanticKind],
    terminalReplayEvidenceRequired:
      SEMANTIC_TERMINAL_REPLAY_REQUIREMENTS[semanticKind],
    ...SEMANTIC_HORIZON_RULES[semanticKind],
  }
}

/**
 * Derives the non-secret, authentication-independent wallet scope identifier
 * from the exact Cashu seed root supplied to the client wallet.
 */
export function deriveDurableCustodyWalletId(seed: Uint8Array): string {
  if (!(seed instanceof Uint8Array) || (seed.length !== 32 && seed.length !== 64)) {
    throw new Error('custody wallet seed root must be 32 or 64 bytes')
  }
  const input = new Uint8Array(CUSTODY_WALLET_ID_DOMAIN.length + seed.length)
  input.set(CUSTODY_WALLET_ID_DOMAIN)
  input.set(seed, CUSTODY_WALLET_ID_DOMAIN.length)
  return bytesToHex(sha256(input))
}

/** Creates the deterministic scope identifier used only as non-secret metadata. */
export function deriveDurableCustodyScopeId(input: DurableCustodyScopeInput): string {
  if (input.scopeKind === 'wallet') {
    const walletId = requireFingerprint(input.walletId, 'custody wallet id')
    return `custody:wallet:${walletId}`
  }
  const marketId = requireIdentifier(input.marketId, 'market id')
  const inventoryAccountId = requireIdentifier(input.inventoryAccountId, 'inventory account id')
  const normalizedMint = requireNormalizedMint(input.normalizedMint)
  const unit = requireIdentifier(input.unit, 'scope unit')
  return requireCompositeIdentifier([
    'custody',
    'market',
    encodeURIComponent(marketId),
    encodeURIComponent(inventoryAccountId),
    encodeURIComponent(normalizedMint),
    encodeURIComponent(unit),
  ].join(':'), 'custody scope id')
}

/** Validates and returns one exact canonical custody scope identifier. */
export function decodeDurableCustodyScopeId(value: unknown): string {
  const scopeId = requireCompositeIdentifier(value, 'custody scope id')
  const parts = scopeId.split(':')
  try {
    if (parts.length === 3 && parts[0] === 'custody' && parts[1] === 'wallet') {
      const walletId = parts[2]!
      if (scopeId === deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId })) return scopeId
    }
    if (parts.length === 6 && parts[0] === 'custody' && parts[1] === 'market') {
      const input: DurableCustodyScopeInput = {
        scopeKind: 'market',
        marketId: decodeURIComponent(parts[2]!),
        inventoryAccountId: decodeURIComponent(parts[3]!),
        normalizedMint: decodeURIComponent(parts[4]!),
        unit: decodeURIComponent(parts[5]!),
      }
      if (scopeId === deriveDurableCustodyScopeId(input)) return scopeId
    }
  } catch {
    // Normalize all malformed components to one non-secret validation error.
  }
  throw new Error('custody scope id is invalid')
}

/**
 * Checks the two immutable market ownership keys. Adapters call it while they
 * hold the physical registration row/unique constraint; it never permits a
 * market to rebind its inventory or a second market to share that inventory.
 */
export function validateDurableCustodyScopeRegistration(
  existing: DurableCustodyScope,
  requested: DurableCustodyScope,
): void {
  if (existing.scopeKind !== requested.scopeKind) {
    throw new Error('custody scope registration is foreign')
  }
  if (existing.scopeKind === 'wallet' && requested.scopeKind === 'wallet') {
    if (existing.scopeId !== requested.scopeId) throw new Error('custody scope registration is foreign')
    return
  }
  if (existing.scopeKind !== 'market' || requested.scopeKind !== 'market') {
    throw new Error('custody scope registration is foreign')
  }
  const sameMarket = existing.marketId === requested.marketId
  const sameInventory = existing.normalizedMint === requested.normalizedMint
    && existing.unit === requested.unit
    && existing.inventoryAccountId === requested.inventoryAccountId
  if ((sameMarket && existing.scopeId !== requested.scopeId) || (!sameMarket && sameInventory)) {
    throw new Error('market custody scope registration conflicts')
  }
}

/** Binds an operation to one custody scope and immutable retained identity. */
export function deriveDurableCustodyOperationId(
  scopeId: string,
  identity: DurableCustodyOperationIdentity,
): string {
  const canonicalScopeId = decodeDurableCustodyScopeId(scopeId)
  requireIdentifier(identity.retainedOperationKey, 'retained operation key')
  const binding = decodeOperationIdentityBinding(identity.binding)
  const parts = binding.kind === 'trade'
    ? [
        'custody-operation',
        encodeURIComponent(canonicalScopeId),
        'trade',
        encodeURIComponent(binding.tradeId),
        binding.role,
        binding.stage,
        encodeURIComponent(identity.retainedOperationKey),
      ]
    : [
        'custody-operation',
        encodeURIComponent(canonicalScopeId),
        'wallet',
        encodeURIComponent(binding.activityId),
        binding.stage,
        encodeURIComponent(identity.retainedOperationKey),
      ]
  return requireCompositeIdentifier(parts.join(':'), 'custody operation id')
}

/** Validates an operation identifier against its exact canonical custody scope. */
export function decodeDurableCustodyOperationId(value: unknown, expectedScopeId: string): string {
  const operationId = requireCompositeIdentifier(value, 'custody operation id')
  const scopeId = decodeDurableCustodyScopeId(expectedScopeId)
  const parts = operationId.split(':')
  try {
    if (parts[0] === 'custody-operation') {
      const encodedScopeId = decodeURIComponent(parts[1]!)
      const identity: DurableCustodyOperationIdentity =
        parts.length === 7 && parts[2] === 'trade'
          ? {
              retainedOperationKey: decodeURIComponent(parts[6]!),
              binding: {
                kind: 'trade',
                tradeId: decodeURIComponent(parts[3]!),
                role: parts[4] as CustodyRole,
                stage: parts[5] as CustodyTradeStage,
              },
            }
          : parts.length === 6 && parts[2] === 'wallet'
            ? {
                retainedOperationKey: decodeURIComponent(parts[5]!),
                binding: {
                  kind: 'wallet',
                  activityId: decodeURIComponent(parts[3]!),
                  stage: parts[4] as CustodyWalletStage,
                },
              }
            : (() => {
                throw new Error('invalid operation identity')
              })()
      if (encodedScopeId === scopeId
        && operationId === deriveDurableCustodyOperationId(scopeId, identity)) return operationId
    }
  } catch {
    // Normalize malformed or foreign identifiers without reflecting their contents.
  }
  throw new Error('custody operation id is invalid')
}

/**
 * Derives the versioned global proof identity from the canonical mint identity
 * and exact bearer secret. The domain-separated hash is safe to store as a
 * primary key but must never be emitted as an observability dimension.
 */
export function deriveDurableCustodyProofId(input: DurableCustodyProofIdentityInput): string {
  const normalizedMint = requireNormalizedMint(input.normalizedMint)
  const unit = requireIdentifier(input.unit, 'proof unit')
  const keysetId = canonicalDurableCustodyKeysetIdentity(
    requireIdentifier(input.keysetId, 'proof keyset id'),
  )
  const secret = requireSecret(input.secret)
  return bytesToHex(sha256(encodeProofIdentity([
    'bitcaster/custody-proof-id/v1',
    normalizedMint,
    unit,
    keysetId,
    secret,
  ])))
}

/** Canonicalizes Cashu legacy Base64/Base64url aliases without rewriting modern hex IDs. */
export function canonicalDurableCustodyKeysetIdentity(keysetId: string): string {
  if (/^[0-9a-fA-F]+$/.test(keysetId)) return keysetId
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(keysetId)) return keysetId
  if (/[+/]/.test(keysetId) && /[-_]/.test(keysetId)) {
    throw new Error('proof keyset id mixes Base64 alphabets')
  }
  const normalized = keysetId.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return keysetId
  try {
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    const decodedText = atob(padded)
    const decoded = Uint8Array.from(decodedText, (character) => character.charCodeAt(0))
    let standardText = ''
    for (const byte of decoded) standardText += String.fromCharCode(byte)
    if (btoa(standardText).replace(/=+$/, '') !== normalized) return keysetId
    return `legacy:${bytesToHex(decoded)}`
  } catch {
    return keysetId
  }
}

/** Hashes the canonical public-key table, not the forgeable keyset label. */
export function deriveDurableCustodyKeysetFingerprint(input: {
  keysetId: string
  unit: string
  curve: DurableCustodyCurve
  publicKeys: Readonly<Record<string, string>>
}): string {
  const keysetId = canonicalDurableCustodyKeysetIdentity(
    requireIdentifier(input.keysetId, 'keyset id'),
  )
  const unit = requireIdentifier(input.unit, 'keyset unit')
  requireOneOf(input.curve, CURVES, 'keyset curve')
  const entries = Object.entries(input.publicKeys)
  if (entries.length === 0 || entries.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    throw new Error('keyset public keys are invalid')
  }
  const expectedHexLength = input.curve === 'bls12-381' ? 192 : 66
  const canonicalEntries = entries.map(([amount, publicKey]) => {
    const amountValue = Number(amount)
    if (!/^[1-9][0-9]*$/.test(amount)
      || !Number.isSafeInteger(amountValue)
      || amountValue <= 0) {
      throw new Error('keyset amount is invalid')
    }
    const key = requireString(publicKey, 'keyset public key').toLowerCase()
    if (key.length !== expectedHexLength || !/^[a-f0-9]+$/.test(key)) {
      throw new Error('keyset public key is invalid')
    }
    return { amount: amountValue, amountText: amount, publicKey: key }
  })
  canonicalEntries.sort((left, right) => left.amount - right.amount)
  return bytesToHex(sha256(encodeProofIdentity([
    'bitcaster/custody-keyset-fingerprint/v1',
    keysetId,
    unit,
    input.curve,
    ...canonicalEntries.flatMap(({ amountText, publicKey }) => [amountText, publicKey]),
  ])))
}

/** Canonical bounded JSON digest used to bind exact opaque artifact handles. */
export function deriveDurableCustodyArtifactFingerprint(value: unknown): string {
  const canonical = canonicalCustodyArtifactJson(value)
  const bytes = new TextEncoder().encode(canonical)
  if (bytes.length === 0 || bytes.length > DURABLE_CUSTODY_RECOVERY_PAGE_MAX_BYTES) {
    throw new Error('custody artifact exceeds the byte limit')
  }
  return bytesToHex(sha256(bytes))
}

function canonicalCustodyArtifactJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('custody artifact number is invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCustodyArtifactJson).join(',')}]`
  }
  if (typeof value !== 'object') throw new Error('custody artifact is invalid')
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${canonicalCustodyArtifactJson(item)}`).join(',')}}`
}

/**
 * Constructs the complete operation facts without semantic defaults. Every
 * referenced input and output keyset must be backed by the exact public keys.
 */
export function createDurableProofOperationFacts(
  input: DurableProofOperationFactsInput,
): DurableProofOperationFacts {
  const unit = requireIdentifier(input.unit, 'proof operation unit')
  const binding = decodeBinding(input.binding)
  const horizon = decodeProofOperationFactsHorizon(input.horizon)
  if (input.keysets.length === 0
    || input.keysets.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    throw new Error('proof operation keysets are invalid')
  }
  const inputKeysetRequirement = input.inputKeysetRequirement
  requireOneOf(
    inputKeysetRequirement,
    ['required', 'none'] as const,
    'input keyset requirement',
  )
  const verification = decodeProofOperationKeysetFacts(
    input.keysets,
    unit,
    requireBoolean(input.hasOutputs, 'proof operation output marker'),
    inputKeysetRequirement,
  )
  return {
    unit,
    binding,
    horizon: { ...horizon, keysetExpiryMs: minimumKnownKeysetExpiry(input.keysets) },
    verification,
  }
}

/** Creates one canonical initial operation after a client resolves exact artifacts. */
export function createDurableCustodyDispatchIntent(
  input: DurableCustodyDispatchIntentInput,
): DurableCustodyRecord {
  const policy = durableCustodySemanticPolicy(input.semanticKind)
  const operationId = deriveDurableCustodyOperationId(input.scope.scopeId, {
    retainedOperationKey: input.retainedOperationKey,
    binding: operationIdentityBinding(input.facts.binding),
  })
  return decodeDurableCustodyRecord({
    schemaVersion: DURABLE_CUSTODY_SCHEMA_VERSION,
    revision: 0,
    scope: input.scope,
    operation: {
      operationId,
      retainedOperationKey: input.retainedOperationKey,
      binding: input.facts.binding,
      semanticKind: input.semanticKind,
      state: 'dispatch-intent',
      terminalReplayEvidenceRequired: policy.terminalReplayEvidenceRequired,
      custodyContext: {
        normalizedMint: input.normalizedMint,
        unit: input.facts.unit,
        inventoryAccountId: input.inventoryAccountId,
      },
      reservation: input.reservation,
      exactRequest: input.exactRequest,
      outputPlan: input.outputPlan,
      privateMaterial: input.privateMaterial,
      result: {
        state: 'none',
        resultHandle: null,
        resultFingerprint: null,
        outputPlanFingerprint: null,
      },
      verification: {
        outputPlanFingerprint: input.outputPlan.outputPlanFingerprint,
        hasOutputs: input.facts.verification.hasOutputs,
        keysetBindings: input.facts.verification.keysetBindings,
        outputKeysets: input.facts.verification.outputKeysets,
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
      horizon: input.facts.horizon,
    },
    terminalTombstone: null,
  })
}

function decodeProofOperationFactsHorizon(
  input: DurableProofOperationFactsInput['horizon'],
): DurableProofOperationFactsInput['horizon'] {
  const notBeforeMs = input.notBeforeMs === null
    ? null
    : requireNonNegativeInteger(input.notBeforeMs, 'not-before horizon')
  const notAfterMs = input.notAfterMs === null
    ? null
    : requireNonNegativeInteger(input.notAfterMs, 'not-after horizon')
  if (notBeforeMs !== null && notAfterMs !== null && notBeforeMs > notAfterMs) {
    throw new Error('horizon window is invalid')
  }
  return {
    notBeforeMs,
    notAfterMs,
    safetyMarginMs: requireNonNegativeInteger(input.safetyMarginMs, 'safety margin'),
  }
}

function decodeProofOperationKeysetFacts(
  keysets: readonly DurableProofOperationKeysetFactsInput[],
  unit: string,
  hasOutputs: boolean,
  inputKeysetRequirement: DurableProofOperationFactsInput['inputKeysetRequirement'],
): DurableProofOperationFacts['verification'] {
  const seen = new Set<string>()
  const inputKeysets: DurableProofOperationFacts['verification']['inputKeysets'] = []
  const outputKeysets: DurableProofOperationFacts['verification']['outputKeysets'] = []
  const keysetBindings = keysets.map((keyset) => {
    const usage = decodeProofOperationKeysetUsage(keyset, unit, seen)
    if (keyset.usedByInputs) inputKeysets.push(usage)
    if (keyset.usedByOutputs) outputKeysets.push(usage)
    return {
      ...usage,
      keysetFingerprint: deriveDurableCustodyKeysetFingerprint(keyset),
      requireDleq: keyset.requireDleq,
    }
  })
  if (
    (inputKeysetRequirement === 'required' && inputKeysets.length === 0) ||
    (inputKeysetRequirement === 'none' && inputKeysets.length !== 0)
  ) {
    throw new Error('input keysets do not match the declared requirement')
  }
  assertOutputKeysetAuthority(hasOutputs, outputKeysets)
  return { hasOutputs, keysetBindings, inputKeysets, outputKeysets }
}

function decodeProofOperationKeysetUsage(
  keyset: DurableProofOperationKeysetFactsInput,
  unit: string,
  seen: Set<string>,
): { keysetId: string; curve: DurableCustodyCurve } {
  const keysetId = requireIdentifier(keyset.keysetId, 'keyset id')
  requireOneOf(keyset.curve, CURVES, 'keyset curve')
  if (requireIdentifier(keyset.unit, 'keyset unit') !== unit) {
    throw new Error('keyset unit does not match proof operation unit')
  }
  if (typeof keyset.requireDleq !== 'boolean'
    || typeof keyset.usedByInputs !== 'boolean'
    || typeof keyset.usedByOutputs !== 'boolean'
    || (!keyset.usedByInputs && !keyset.usedByOutputs)) {
    throw new Error('keyset verification policy is incomplete')
  }
  const identity = `${canonicalDurableCustodyKeysetIdentity(keysetId)}:${keyset.curve}`
  if (seen.has(identity)) throw new Error('proof operation keyset is duplicated')
  seen.add(identity)
  return { keysetId, curve: keyset.curve }
}

function minimumKnownKeysetExpiry(
  keysets: readonly DurableProofOperationKeysetFactsInput[],
): number | null {
  const expiries = keysets.map((keyset) => keyset.keysetExpiryMs)
  for (const expiry of expiries) {
    if (expiry !== null) requireNonNegativeInteger(expiry, 'keyset expiry')
  }
  return expiries.some((expiry) => expiry === null)
    ? null
    : Math.min(...expiries as number[])
}

/** Decodes the complete persisted record and rejects any ambiguous data. */
export function decodeDurableCustodyRecord(
  value: unknown,
  expectedScope?: DurableCustodyScope,
): DurableCustodyRecord {
  requireJsonByteLimit(value, DURABLE_CUSTODY_RECORD_MAX_BYTES, 'durable custody record')
  return decodeDurableCustodyRecordWithinLimit(value, expectedScope)
}

function decodeDurableCustodyRecordWithinLimit(
  value: unknown,
  expectedScope?: DurableCustodyScope,
): DurableCustodyRecord {
  const root = requireRecord(value, 'durable custody record')
  requireKnownFields(root, [
    'schemaVersion', 'revision', 'scope', 'operation', 'terminalTombstone',
  ])
  if (root.schemaVersion !== DURABLE_CUSTODY_SCHEMA_VERSION) {
    throw new Error('unsupported durable custody schema version')
  }
  const record = {
    schemaVersion: DURABLE_CUSTODY_SCHEMA_VERSION,
    revision: requireNonNegativeInteger(root.revision, 'revision'),
    scope: decodeScope(root.scope),
    operation: decodeOperation(root.operation),
    terminalTombstone: decodeTombstone(root.terminalTombstone),
  } satisfies DurableCustodyRecord

  if (expectedScope !== undefined && record.scope.scopeId !== expectedScope.scopeId) {
    throw new Error('foreign custody scope')
  }
  validateRecordBindings(record)
  return record
}

/** Decodes the single authoritative claim and clock row for a custody scope. */
export function decodeDurableCustodyScopeState(
  value: unknown,
  expectedScope?: DurableCustodyScope,
): DurableCustodyScopeState {
  const root = requireRecord(value, 'durable custody scope state')
  requireKnownFields(root, [
    'schemaVersion', 'scope', 'fencingEpoch', 'owner', 'effectiveClock',
  ])
  if (root.schemaVersion !== DURABLE_CUSTODY_SCHEMA_VERSION) {
    throw new Error('unsupported durable custody schema version')
  }
  const state = {
    schemaVersion: DURABLE_CUSTODY_SCHEMA_VERSION,
    scope: decodeScope(root.scope),
    fencingEpoch: requireNonNegativeInteger(
      root.fencingEpoch,
      'custody fencing epoch',
    ),
    owner: decodeOwner(root.owner),
    effectiveClock: decodeClock(root.effectiveClock),
  } satisfies DurableCustodyScopeState
  if (expectedScope !== undefined && state.scope.scopeId !== expectedScope.scopeId) {
    throw new Error('foreign custody scope')
  }
  validateScopeState(state, state.scope)
  return state
}

/** Pure transition reducer. Adapters must persist both returned rows atomically. */
export function reduceDurableCustodyState(
  state: DurableCustodyState,
  transition: DurableCustodyTransition,
): DurableCustodyState {
  const { operation: record, scopeState } = state
  validateRecordBindings(record)
  validateScopeState(scopeState, record.scope)
  if (transition.kind === 'owner-claimed') {
    return {
      operation: record,
      scopeState: claimOwner(scopeState, transition),
    }
  }
  if (transition.kind === 'owner-renewed') {
    return {
      operation: record,
      scopeState: renewOwner(scopeState, transition),
    }
  }
  if (transition.kind === 'owner-released') {
    return {
      operation: record,
      scopeState: releaseOwner(scopeState, transition),
    }
  }
  const effectiveNowMs = authorizeOwner(scopeState, transition)
  const nextOperation = structuredClone(record)
  const nextScopeState = structuredClone(scopeState)
  nextOperation.revision += 1
  nextScopeState.effectiveClock.highWaterMarkMs = effectiveNowMs
  validateDeliveryExpiry(record.operation.delivery, effectiveNowMs)

  switch (transition.kind) {
    case 'transport-attempted':
      if (record.operation.state !== 'dispatch-intent') {
        throw new Error('transport handoff requires dispatch intent')
      }
      if (!isDispatchOpen(record.operation.horizon, effectiveNowMs)) {
        throw new Error('dispatch authority has expired')
      }
      nextOperation.operation.state = 'transport-attempted'
      nextOperation.operation.retry = { attempt: 0, nextAttemptAtMs: null, reason: 'none' }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'retry-scheduled':
      if (record.operation.state !== 'dispatch-intent' && record.operation.state !== 'transport-attempted') {
        throw new Error('retry requires recoverable operation state')
      }
      if (record.operation.result.state !== 'none') {
        throw new Error('retry requires no staged result')
      }
      requireOneOf(transition.reason, RETRY_REASONS, 'retry reason')
      const nextAttemptAtMs = requireNonNegativeInteger(transition.nextAttemptAtMs, 'next retry time')
      if (nextAttemptAtMs < effectiveNowMs) {
        throw new Error('next retry time is before effective clock')
      }
      if (record.operation.retry.nextAttemptAtMs !== null
        && nextAttemptAtMs < record.operation.retry.nextAttemptAtMs) {
        throw new Error('next retry time moves backwards')
      }
      if (record.operation.retry.attempt >= Number.MAX_SAFE_INTEGER) {
        throw new Error('retry attempt has overflowed')
      }
      nextOperation.operation.retry = {
        attempt: record.operation.retry.attempt + 1,
        nextAttemptAtMs,
        reason: transition.reason,
      }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'verified-result-staged':
      if (record.operation.state !== 'dispatch-intent' && record.operation.state !== 'transport-attempted') {
        throw new Error('result staging requires recoverable operation state')
      }
      if (record.operation.result.state !== 'none') {
        throw new Error('verified result is already staged')
      }
      if (transition.outputPlanFingerprint !== record.operation.outputPlan.outputPlanFingerprint) {
        throw new Error('verified result output plan is foreign')
      }
      nextOperation.operation.result = {
        state: 'verified-staged',
        resultHandle: requireIdentifier(transition.resultHandle, 'verified result handle'),
        resultFingerprint: requireFingerprint(transition.resultFingerprint, 'verified result fingerprint'),
        outputPlanFingerprint: transition.outputPlanFingerprint,
      }
      nextOperation.operation.retry = { attempt: 0, nextAttemptAtMs: null, reason: 'none' }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'abort-no-transport':
      if (!isAbortEligible(record, transition.classification, transition.exactRequestDisposition)) {
        throw new Error(record.operation.state !== 'dispatch-intent'
          ? 'abort is only legal before transport handoff'
          : 'abort is not eligible')
      }
      nextOperation.operation.state = 'aborted'
      nextOperation.operation.retry = { attempt: 0, nextAttemptAtMs: null, reason: 'none' }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'reconciled':
      if (record.operation.state === 'transport-attempted'
        && transition.recoverySource !== 'transport-attempted') {
        throw new Error('transport reconciliation source is invalid')
      }
      if (record.operation.state === 'dispatch-intent'
        && transition.recoverySource !== 'spent-restorable'
        && transition.recoverySource !== 'verified-result-staged') {
        throw new Error('dispatch-intent reconciliation source is invalid')
      }
      if (transition.recoverySource === 'verified-result-staged'
        && record.operation.result.state !== 'verified-staged') {
        throw new Error('staged-result reconciliation source is invalid')
      }
      if (record.operation.state !== 'transport-attempted' && record.operation.state !== 'dispatch-intent') {
        throw new Error('reconciliation requires recoverable operation state')
      }
      if (record.operation.result.state !== 'verified-staged') {
        throw new Error('reconciliation requires verified staged result')
      }
      nextOperation.operation.state = 'reconciled'
      nextOperation.operation.result = {
        ...record.operation.result,
        state: 'applied',
      }
      nextOperation.operation.retry = { attempt: 0, nextAttemptAtMs: null, reason: 'none' }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'delivery-resolved':
      if (record.operation.delivery.deliveryKind !== 'outbox' || record.operation.delivery.state !== 'pending') {
        throw new Error('delivery resolution requires pending outbox')
      }
      if (transition.deliveryState === 'expired'
        && record.operation.delivery.expiresAtMs !== null
        && effectiveNowMs < record.operation.delivery.expiresAtMs) {
        throw new Error('delivery expiry is premature')
      }
      nextOperation.operation.delivery = {
        ...record.operation.delivery,
        state: transition.deliveryState,
      }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'terminal-tombstone-created':
      if (!record.operation.terminalReplayEvidenceRequired) {
        throw new Error('terminal tombstone is not permitted')
      }
      if (record.operation.state !== 'reconciled') {
        throw new Error('terminal tombstone requires reconciled operation')
      }
      if (record.terminalTombstone !== null) throw new Error('terminal tombstone already exists')
      if (!isDeliveryTerminalAt(record.operation.delivery, effectiveNowMs)) {
        throw new Error('terminal tombstone requires resolved delivery')
      }
      requireIdentifier(transition.tombstoneId, 'tombstone id')
      nextOperation.terminalTombstone = {
        tombstoneId: transition.tombstoneId,
        tradeId: requireTradeBinding(record).tradeId,
        authenticatedTerminalStatus: false,
        replayCutoffObserved: false,
      }
      return { operation: nextOperation, scopeState: nextScopeState }
    case 'terminal-tombstone-confirmed':
      if (record.terminalTombstone === null) throw new Error('terminal tombstone is missing')
      if (transition.authenticatedTradeId !== record.terminalTombstone.tradeId) {
        throw new Error('terminal tombstone trade id is foreign')
      }
      nextOperation.terminalTombstone = {
        ...record.terminalTombstone,
        authenticatedTerminalStatus: true,
        replayCutoffObserved: true,
      }
      return { operation: nextOperation, scopeState: nextScopeState }
  }
}

/** Decides recovery without selecting proofs, outputs, or fresh protocol material. */
export function decideDurableCustodyRecovery(
  record: DurableCustodyRecord,
  scopeState: DurableCustodyScopeState,
  input: DurableCustodyRecoveryInput,
): DurableCustodyRecoveryDecision {
  validateRecordBindings(record)
  validateScopeState(scopeState, record.scope)
  if (input.scopeId !== record.scope.scopeId || input.operationId !== record.operation.operationId) {
    return { kind: 'fail-closed', reason: 'foreign' }
  }
  if (input.requestFingerprint !== record.operation.exactRequest.requestFingerprint
    || input.outputPlanFingerprint !== record.operation.outputPlan.outputPlanFingerprint) {
    return { kind: 'fail-closed', reason: 'corrupt' }
  }
  const effectiveNowMs = authorizeOwner(scopeState, input)
  if (record.operation.result.state === 'verified-staged') {
    return {
      kind: 'reconcile-exact-operation',
      reason: 'verified-result-staged',
      exact: exactOperationReference(record),
    }
  }
  switch (input.classification) {
    case 'corrupt':
      return { kind: 'fail-closed', reason: 'corrupt' }
    case 'foreign':
      return { kind: 'fail-closed', reason: 'foreign' }
    case 'spent-restorable':
      return { kind: 'reconcile-exact-operation', reason: 'spent-restorable', exact: exactOperationReference(record) }
    case 'pending-or-mixed':
    case 'mint-response-unknown':
    case 'rate-limited':
    case 'reservation-race':
      return { kind: 'retry-later', effectiveNowMs }
    case 'engine-terminal':
      return { kind: 'reconcile-exact-operation', reason: 'unclassified', exact: exactOperationReference(record) }
    case 'all-inputs-unspent':
      if (record.operation.state === 'transport-attempted') {
        return isDispatchOpen(record.operation.horizon, effectiveNowMs)
          ? {
              kind: 'reissue-exact-operation',
              effectiveNowMs,
              exact: exactOperationReference(record),
            }
          : {
              kind: 'reconcile-exact-operation',
              reason: 'transport-attempted',
              exact: exactOperationReference(record),
            }
      }
      if (record.operation.state !== 'dispatch-intent') {
        return { kind: 'reconcile-exact-operation', reason: 'unclassified', exact: exactOperationReference(record) }
      }
      if (isAbortEligible(record, input.classification, input.exactRequestDisposition)) {
        return { kind: 'abort-no-transport', effectiveNowMs }
      }
      if (isDispatchBeforeWindow(record.operation.horizon, effectiveNowMs)) {
        return { kind: 'retry-later', effectiveNowMs }
      }
      if (!isDispatchOpen(record.operation.horizon, effectiveNowMs)) {
        return { kind: 'reconcile-exact-operation', reason: 'unclassified', exact: exactOperationReference(record) }
      }
      return { kind: 'reissue-exact-operation', effectiveNowMs, exact: exactOperationReference(record) }
  }
}

/** Tombstones may drain only after matching authenticated terminal evidence. */
export function decideTerminalTombstoneDrain(
  record: DurableCustodyRecord,
  scopeState: DurableCustodyScopeState,
): { kind: 'retain' } | { kind: 'delete' } {
  validateRecordBindings(record)
  validateScopeState(scopeState, record.scope)
  validateDeliveryExpiry(record.operation.delivery, scopeState.effectiveClock.highWaterMarkMs)
  const tombstone = record.terminalTombstone
  return tombstone !== null && tombstone.authenticatedTerminalStatus && tombstone.replayCutoffObserved
    && isDeliveryTerminalAt(record.operation.delivery, scopeState.effectiveClock.highWaterMarkMs)
    ? { kind: 'delete' }
    : { kind: 'retain' }
}

function decodeScope(value: unknown): DurableCustodyScope {
  const scope = requireRecord(value, 'scope')
  const scopeKind = requireString(scope.scopeKind, 'scope kind') as CustodyScopeKind
  requireOneOf(scopeKind, SCOPE_KINDS, 'scope kind')
  if (scopeKind === 'wallet') {
    requireKnownFields(scope, ['scopeKind', 'walletId', 'scopeId'])
    const walletId = requireFingerprint(scope.walletId, 'custody wallet id')
    const scopeId = decodeDurableCustodyScopeId(scope.scopeId)
    if (scopeId !== deriveDurableCustodyScopeId({ scopeKind, walletId })) {
      throw new Error('custody scope id is invalid')
    }
    return { scopeKind, walletId, scopeId }
  }
  requireKnownFields(scope, ['scopeKind', 'marketId', 'inventoryAccountId', 'normalizedMint', 'unit', 'scopeId'])
  const marketId = requireIdentifier(scope.marketId, 'market id')
  const inventoryAccountId = requireIdentifier(scope.inventoryAccountId, 'inventory account id')
  const normalizedMint = requireNormalizedMint(scope.normalizedMint)
  const unit = requireIdentifier(scope.unit, 'scope unit')
  const scopeId = decodeDurableCustodyScopeId(scope.scopeId)
  if (scopeId !== deriveDurableCustodyScopeId({
    scopeKind,
    marketId,
    inventoryAccountId,
    normalizedMint,
    unit,
  })) {
    throw new Error('custody scope id is invalid')
  }
  return { scopeKind, marketId, inventoryAccountId, normalizedMint, unit, scopeId }
}

function decodeOperation(value: unknown): DurableCustodyRecord['operation'] {
  const operation = requireRecord(value, 'operation')
  requireKnownFields(operation, [
    'operationId', 'retainedOperationKey', 'binding', 'semanticKind', 'state',
    'terminalReplayEvidenceRequired', 'custodyContext', 'reservation',
    'exactRequest', 'outputPlan', 'privateMaterial', 'result', 'verification',
    'delivery', 'retry', 'horizon',
  ])
  const binding = decodeBinding(operation.binding)
  const retainedOperationKey = requireIdentifier(operation.retainedOperationKey, 'retained operation key')
  const semanticKind = requireString(operation.semanticKind, 'semantic kind') as DurableCustodySemanticKind
  requireOneOf(semanticKind, SEMANTIC_KINDS, 'semantic kind')
  const allowsEmptyInputs = semanticKind === 'generic-receive'
  const state = requireString(operation.state, 'operation state') as DurableCustodyOperationState
  requireOneOf(state, STATES, 'operation state')
  const decoded = {
    operationId: requireCompositeIdentifier(operation.operationId, 'operation id'),
    retainedOperationKey,
    binding,
    semanticKind,
    state,
    terminalReplayEvidenceRequired: requireBoolean(
      operation.terminalReplayEvidenceRequired,
      'terminal replay evidence requirement',
    ),
    custodyContext: decodeCustodyContext(operation.custodyContext),
    reservation: decodeReservation(operation.reservation, allowsEmptyInputs),
    exactRequest: decodeExactRequest(operation.exactRequest, allowsEmptyInputs),
    outputPlan: decodeOutputPlan(operation.outputPlan),
    privateMaterial: decodePrivateMaterial(operation.privateMaterial),
    result: decodeResult(operation.result),
    verification: decodeVerification(operation.verification),
    delivery: decodeDelivery(operation.delivery),
    retry: decodeRetry(operation.retry),
    horizon: decodeHorizon(operation.horizon),
  } satisfies DurableCustodyRecord['operation']
  return decoded
}

function decodeOperationIdentityBinding(
  value: unknown,
): DurableCustodyOperationIdentity['binding'] {
  const binding = requireRecord(value, 'operation identity binding')
  const kind = requireString(binding.kind, 'operation binding kind')
  if (kind === 'trade') {
    requireKnownFields(binding, ['kind', 'tradeId', 'role', 'stage'])
    return decodeTradeIdentityFields(binding)
  }
  if (kind !== 'wallet') throw new Error('operation binding kind is invalid')
  requireKnownFields(binding, ['kind', 'activityId', 'stage'])
  return decodeWalletIdentityFields(binding)
}

function decodeBinding(value: unknown): DurableCustodyBinding {
  const binding = requireRecord(value, 'operation binding')
  const kind = requireString(binding.kind, 'operation binding kind')
  if (kind === 'wallet') {
    requireKnownFields(binding, ['kind', 'activityId', 'stage'])
    return decodeWalletIdentityFields(binding)
  }
  if (kind !== 'trade') throw new Error('operation binding kind is invalid')
  requireKnownFields(binding, [
    'kind', 'tradeId', 'role', 'stage', 'sessionId',
    'immutableTradeFingerprint', 'hasDependentOperation',
  ])
  return {
    ...decodeTradeIdentityFields(binding),
    sessionId: requireIdentifier(binding.sessionId, 'session id'),
    immutableTradeFingerprint: requireFingerprint(
      binding.immutableTradeFingerprint,
      'immutable trade fingerprint',
    ),
    hasDependentOperation: requireBoolean(
      binding.hasDependentOperation,
      'dependent operation marker',
    ),
  }
}

function decodeTradeIdentityFields(
  binding: Record<string, unknown>,
): Extract<DurableCustodyOperationIdentity['binding'], { kind: 'trade' }> {
  const role = requireString(binding.role, 'trade role') as CustodyRole
  const stage = requireString(binding.stage, 'trade stage') as CustodyTradeStage
  requireOneOf(role, ROLES, 'trade role')
  requireOneOf(stage, STAGES, 'trade stage')
  return {
    kind: 'trade',
    tradeId: requireIdentifier(binding.tradeId, 'trade id'),
    role,
    stage,
  }
}

function decodeWalletIdentityFields(
  binding: Record<string, unknown>,
): Extract<DurableCustodyOperationIdentity['binding'], { kind: 'wallet' }> {
  const stage = requireString(binding.stage, 'wallet stage') as CustodyWalletStage
  requireOneOf(stage, WALLET_STAGES, 'wallet stage')
  return {
    kind: 'wallet',
    activityId: requireIdentifier(binding.activityId, 'wallet activity id'),
    stage,
  }
}

function decodeCustodyContext(value: unknown): DurableCustodyRecord['operation']['custodyContext'] {
  const context = requireRecord(value, 'custody context')
  requireKnownFields(context, ['normalizedMint', 'unit', 'inventoryAccountId'])
  return {
    normalizedMint: requireNormalizedMint(context.normalizedMint),
    unit: requireIdentifier(context.unit, 'custody unit'),
    inventoryAccountId: context.inventoryAccountId === null
      ? null
      : requireIdentifier(context.inventoryAccountId, 'inventory account id'),
  }
}

function decodeReservation(
  value: unknown,
  allowsEmptyInputs: boolean,
): DurableCustodyRecord['operation']['reservation'] {
  const reservation = requireRecord(value, 'reservation')
  requireKnownFields(reservation, ['reservationId', 'parentReservationId', 'inputs'])
  const rawInputs = requireArray(reservation.inputs, 'reservation inputs')
  if (rawInputs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
    throw new Error('reservation inputs exceed the limit')
  }
  const inputs = rawInputs.map((input) => {
    const decoded = requireRecord(input, 'reservation input')
    requireKnownFields(decoded, ['proofId', 'keysetId', 'curve'])
    const curve = requireString(decoded.curve, 'curve') as DurableCustodyCurve
    requireOneOf(curve, CURVES, 'curve')
    return {
      proofId: requireFingerprint(decoded.proofId, 'proof id'),
      keysetId: requireIdentifier(decoded.keysetId, 'keyset id'),
      curve,
    }
  })
  if (!allowsEmptyInputs && inputs.length === 0) {
    throw new Error('reservation inputs must not be empty')
  }
  return {
    reservationId: requireIdentifier(reservation.reservationId, 'reservation id'),
    parentReservationId: reservation.parentReservationId === null
      ? null
      : requireIdentifier(reservation.parentReservationId, 'parent reservation id'),
    inputs,
  }
}

function decodeExactRequest(
  value: unknown,
  allowsEmptyInputs: boolean,
): DurableCustodyRecord['operation']['exactRequest'] {
  const request = requireRecord(value, 'exact request')
  requireKnownFields(request, ['requestId', 'requestFingerprint', 'payloadHandle', 'inputProofIds', 'outputPlanFingerprint'])
  const rawInputProofIds = requireArray(request.inputProofIds, 'request input proof ids')
  if (rawInputProofIds.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
    throw new Error('request input proof ids exceed the limit')
  }
  const inputProofIds = rawInputProofIds
    .map((proofId) => requireFingerprint(proofId, 'request input proof id'))
  if (!allowsEmptyInputs && inputProofIds.length === 0) {
    throw new Error('request input proof ids must not be empty')
  }
  return {
    requestId: requireIdentifier(request.requestId, 'request id'),
    requestFingerprint: requireFingerprint(request.requestFingerprint, 'request fingerprint'),
    payloadHandle: requireIdentifier(request.payloadHandle, 'request payload handle'),
    inputProofIds,
    outputPlanFingerprint: requireFingerprint(request.outputPlanFingerprint, 'request output plan fingerprint'),
  }
}

function decodeOutputPlan(value: unknown): DurableCustodyRecord['operation']['outputPlan'] {
  const outputPlan = requireRecord(value, 'output plan')
  requireKnownFields(outputPlan, ['outputPlanId', 'outputPlanFingerprint', 'outputMaterialHandle'])
  return {
    outputPlanId: requireIdentifier(outputPlan.outputPlanId, 'output plan id'),
    outputPlanFingerprint: requireFingerprint(outputPlan.outputPlanFingerprint, 'output plan fingerprint'),
    outputMaterialHandle: requireIdentifier(outputPlan.outputMaterialHandle, 'output material handle'),
  }
}

function decodePrivateMaterial(value: unknown): DurableCustodyRecord['operation']['privateMaterial'] {
  const material = requireRecord(value, 'private material')
  requireKnownFields(material, ['materialHandle', 'useId', 'publicFingerprint'])
  return {
    materialHandle: requireIdentifier(material.materialHandle, 'private material handle'),
    useId: requireIdentifier(material.useId, 'private material use id'),
    publicFingerprint: requireFingerprint(material.publicFingerprint, 'private material public fingerprint'),
  }
}

function decodeResult(value: unknown): DurableCustodyRecord['operation']['result'] {
  const result = requireRecord(value, 'operation result')
  requireKnownFields(result, ['state', 'resultHandle', 'resultFingerprint', 'outputPlanFingerprint'])
  if (result.state === 'none') {
    if (result.resultHandle !== null || result.resultFingerprint !== null || result.outputPlanFingerprint !== null) {
      throw new Error('empty operation result contains data')
    }
    return { state: 'none', resultHandle: null, resultFingerprint: null, outputPlanFingerprint: null }
  }
  if (result.state !== 'verified-staged' && result.state !== 'applied') {
    throw new Error('operation result state is invalid')
  }
  return {
    state: result.state,
    resultHandle: requireIdentifier(result.resultHandle, 'result handle'),
    resultFingerprint: requireFingerprint(result.resultFingerprint, 'result fingerprint'),
    outputPlanFingerprint: requireFingerprint(result.outputPlanFingerprint, 'result output plan fingerprint'),
  }
}

function decodeVerification(value: unknown): DurableCustodyRecord['operation']['verification'] {
  const verification = requireRecord(value, 'verification')
  requireKnownFields(verification, [
    'outputPlanFingerprint', 'hasOutputs', 'keysetBindings', 'outputKeysets',
  ])
  const hasOutputs = requireBoolean(verification.hasOutputs, 'verification output marker')
  const rawKeysetBindings = requireArray(verification.keysetBindings, 'keyset bindings')
  if (rawKeysetBindings.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    throw new Error('keyset bindings exceed the limit')
  }
  const keysetBindings = rawKeysetBindings.map((binding) => {
    const decoded = requireRecord(binding, 'keyset binding')
    requireKnownFields(decoded, ['keysetId', 'curve', 'keysetFingerprint', 'requireDleq'])
    const curve = requireString(decoded.curve, 'curve') as DurableCustodyCurve
    requireOneOf(curve, CURVES, 'curve')
    return {
      keysetId: requireIdentifier(decoded.keysetId, 'keyset id'),
      curve,
      keysetFingerprint: requireFingerprint(decoded.keysetFingerprint, 'keyset fingerprint'),
      requireDleq: requireBoolean(decoded.requireDleq, 'DLEQ requirement'),
    }
  })
  if (keysetBindings.length === 0) throw new Error('keyset bindings must not be empty')
  const rawOutputKeysets = requireArray(verification.outputKeysets, 'output keysets')
  if (rawOutputKeysets.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    throw new Error('output keysets exceed the limit')
  }
  const outputKeysets = rawOutputKeysets.map((outputKeyset) => {
    const decoded = requireRecord(outputKeyset, 'output keyset')
    requireKnownFields(decoded, ['keysetId', 'curve'])
    const curve = requireString(decoded.curve, 'output keyset curve') as DurableCustodyCurve
    requireOneOf(curve, CURVES, 'output keyset curve')
    return {
      keysetId: requireIdentifier(decoded.keysetId, 'output keyset id'),
      curve,
    }
  })
  assertOutputKeysetAuthority(hasOutputs, outputKeysets)
  return {
    outputPlanFingerprint: requireFingerprint(verification.outputPlanFingerprint, 'verification output plan fingerprint'),
    hasOutputs,
    keysetBindings,
    outputKeysets,
  }
}

function assertOutputKeysetAuthority(
  hasOutputs: boolean,
  outputKeysets: readonly unknown[],
): void {
  if (hasOutputs && outputKeysets.length === 0) {
    throw new Error('output keysets must not be empty')
  }
  if (!hasOutputs && outputKeysets.length !== 0) {
    throw new Error('zero-output operation cannot bind output keysets')
  }
}

function decodeDelivery(value: unknown): DurableCustodyRecord['operation']['delivery'] {
  const delivery = requireRecord(value, 'delivery')
  requireKnownFields(delivery, [
    'deliveryKind', 'deliveryId', 'payloadHandle', 'payloadFingerprint', 'expiresAtMs', 'state',
  ])
  if (delivery.deliveryKind === 'none') {
    if (delivery.deliveryId !== null || delivery.payloadHandle !== null || delivery.payloadFingerprint !== null
      || delivery.expiresAtMs !== null || delivery.state !== 'none') {
      throw new Error('empty delivery contains data')
    }
    return {
      deliveryKind: 'none',
      deliveryId: null,
      payloadHandle: null,
      payloadFingerprint: null,
      expiresAtMs: null,
      state: 'none',
    }
  }
  if (delivery.deliveryKind !== 'outbox') {
    throw new Error('delivery kind is invalid')
  }
  const state = requireString(delivery.state, 'delivery state')
  if (state !== 'pending' && state !== 'acknowledged' && state !== 'expired') {
    throw new Error('delivery state is invalid')
  }
  return {
    deliveryKind: 'outbox',
    deliveryId: requireIdentifier(delivery.deliveryId, 'delivery id'),
    payloadHandle: requireIdentifier(delivery.payloadHandle, 'delivery payload handle'),
    payloadFingerprint: requireFingerprint(delivery.payloadFingerprint, 'delivery payload fingerprint'),
    expiresAtMs: requireNonNegativeInteger(delivery.expiresAtMs, 'delivery expiry'),
    state,
  }
}

function decodeRetry(value: unknown): DurableCustodyRecord['operation']['retry'] {
  const retry = requireRecord(value, 'retry')
  requireKnownFields(retry, ['attempt', 'nextAttemptAtMs', 'reason'])
  const reason = requireString(retry.reason, 'retry reason') as DurableCustodyRecord['operation']['retry']['reason']
  requireOneOf(reason, ['none', 'pending-or-mixed', 'mint-response-unknown', 'rate-limited', 'reservation-race'], 'retry reason')
  return {
    attempt: requireNonNegativeInteger(retry.attempt, 'retry attempt'),
    nextAttemptAtMs: retry.nextAttemptAtMs === null ? null : requireNonNegativeInteger(retry.nextAttemptAtMs, 'next retry time'),
    reason,
  }
}

function decodeHorizon(value: unknown): DurableCustodyRecord['operation']['horizon'] {
  const horizon = requireRecord(value, 'horizon')
  requireKnownFields(horizon, ['notBeforeMs', 'notAfterMs', 'safetyMarginMs', 'keysetExpiryMs'])
  const notBeforeMs = horizon.notBeforeMs === null ? null : requireNonNegativeInteger(horizon.notBeforeMs, 'not-before horizon')
  const notAfterMs = horizon.notAfterMs === null ? null : requireNonNegativeInteger(horizon.notAfterMs, 'not-after horizon')
  const keysetExpiryMs = horizon.keysetExpiryMs === null ? null : requireNonNegativeInteger(horizon.keysetExpiryMs, 'keyset expiry')
  const safetyMarginMs = requireNonNegativeInteger(horizon.safetyMarginMs, 'safety margin')
  if (notBeforeMs !== null && notAfterMs !== null && notBeforeMs > notAfterMs) {
    throw new Error('horizon window is invalid')
  }
  return { notBeforeMs, notAfterMs, safetyMarginMs, keysetExpiryMs }
}

function decodeOwner(value: unknown): DurableCustodyScopeState['owner'] {
  if (value === null) return null
  const owner = requireRecord(value, 'owner')
  requireKnownFields(owner, ['incarnationId', 'leaseExpiresAtMs'])
  return {
    incarnationId: requireIdentifier(
      owner.incarnationId,
      'owner incarnation id',
    ),
    leaseExpiresAtMs: requireNonNegativeInteger(owner.leaseExpiresAtMs, 'owner lease expiry'),
  }
}

function decodeClock(value: unknown): DurableCustodyScopeState['effectiveClock'] {
  const clock = requireRecord(value, 'effective clock')
  requireKnownFields(clock, ['highWaterMarkMs'])
  return { highWaterMarkMs: requireNonNegativeInteger(clock.highWaterMarkMs, 'effective clock high-water mark') }
}

function decodeTombstone(value: unknown): DurableCustodyRecord['terminalTombstone'] {
  if (value === null) return null
  const tombstone = requireRecord(value, 'terminal tombstone')
  requireKnownFields(tombstone, ['tombstoneId', 'tradeId', 'authenticatedTerminalStatus', 'replayCutoffObserved'])
  return {
    tombstoneId: requireIdentifier(tombstone.tombstoneId, 'tombstone id'),
    tradeId: requireIdentifier(tombstone.tradeId, 'tombstone trade id'),
    authenticatedTerminalStatus: requireBoolean(tombstone.authenticatedTerminalStatus, 'terminal status marker'),
    replayCutoffObserved: requireBoolean(tombstone.replayCutoffObserved, 'replay cutoff marker'),
  }
}

function validateRecordBindings(record: DurableCustodyRecord): void {
  const identity: DurableCustodyOperationIdentity = {
    retainedOperationKey: record.operation.retainedOperationKey,
    binding: operationIdentityBinding(record.operation.binding),
  }
  if (record.operation.operationId !== deriveDurableCustodyOperationId(record.scope.scopeId, identity)) {
    throw new Error('custody operation identity is invalid')
  }
  if (SEMANTIC_STAGE_BINDINGS[record.operation.semanticKind] !== record.operation.binding.stage) {
    throw new Error('operation semantic stage binding is invalid')
  }
  const requiredBindingKind = SEMANTIC_BINDING_KINDS[record.operation.semanticKind]
  if (requiredBindingKind !== 'either' && requiredBindingKind !== record.operation.binding.kind) {
    throw new Error(`operation semantic requires ${requiredBindingKind} binding`)
  }
  if (record.operation.terminalReplayEvidenceRequired
    !== SEMANTIC_TERMINAL_REPLAY_REQUIREMENTS[record.operation.semanticKind]) {
    throw new Error('terminal replay requirement is invalid')
  }
  if (!record.operation.terminalReplayEvidenceRequired && record.terminalTombstone !== null) {
    throw new Error('terminal tombstone is not permitted')
  }
  validateCustodyContext(record)
  validateSemanticHorizon(record.operation.semanticKind, record.operation.horizon)
  if (record.operation.exactRequest.outputPlanFingerprint !== record.operation.outputPlan.outputPlanFingerprint
    || record.operation.verification.outputPlanFingerprint !== record.operation.outputPlan.outputPlanFingerprint) {
    throw new Error('output plan binding is invalid')
  }
  if (record.operation.result.state !== 'none'
    && record.operation.result.outputPlanFingerprint !== record.operation.outputPlan.outputPlanFingerprint) {
    throw new Error('result output plan binding is invalid')
  }
  if (record.operation.state === 'reconciled' && record.operation.result.state !== 'applied') {
    throw new Error('reconciled operation result is invalid')
  }
  if (record.operation.state !== 'reconciled' && record.operation.result.state === 'applied') {
    throw new Error('applied result requires reconciled operation')
  }
  if (record.operation.state === 'aborted' && record.operation.result.state !== 'none') {
    throw new Error('aborted operation result is invalid')
  }
  if (record.operation.state === 'aborted'
    && ((record.operation.binding.kind === 'trade' && record.operation.binding.hasDependentOperation)
      || record.operation.delivery.deliveryKind !== 'none'
      || record.operation.delivery.state !== 'none'
      || record.operation.retry.attempt !== 0
      || record.operation.retry.nextAttemptAtMs !== null
      || record.operation.retry.reason !== 'none'
      || record.terminalTombstone !== null)) {
    throw new Error('aborted operation lifecycle is invalid')
  }
  const reservationProofs = new Set(record.operation.reservation.inputs.map((input) => input.proofId))
  const requestProofs = new Set(record.operation.exactRequest.inputProofIds)
  if (
    reservationProofs.size === 0 &&
    (record.operation.semanticKind !== 'generic-receive' ||
      !record.operation.verification.hasOutputs ||
      record.operation.verification.outputKeysets.length === 0)
  ) {
    throw new Error('inputless custody operation is invalid')
  }
  if (reservationProofs.size !== record.operation.reservation.inputs.length
    || requestProofs.size !== record.operation.exactRequest.inputProofIds.length
    || reservationProofs.size !== requestProofs.size
    || [...reservationProofs].some((proofId) => !requestProofs.has(proofId))) {
    throw new Error('exact request input binding is invalid')
  }
  const verificationBindings = new Set(record.operation.verification.keysetBindings.map(
    (binding) => `${binding.keysetId}:${binding.curve}`,
  ))
  if (verificationBindings.size !== record.operation.verification.keysetBindings.length) {
    throw new Error('keyset verification binding is duplicated')
  }
  for (const input of record.operation.reservation.inputs) {
    if (!verificationBindings.has(`${input.keysetId}:${input.curve}`)) {
      throw new Error('keyset verification binding is invalid')
    }
  }
  const outputKeysets = new Set(record.operation.verification.outputKeysets.map(
    (binding) => `${binding.keysetId}:${binding.curve}`,
  ))
  if (outputKeysets.size !== record.operation.verification.outputKeysets.length) {
    throw new Error('output keyset binding is duplicated')
  }
  for (const outputKeyset of outputKeysets) {
    if (!verificationBindings.has(outputKeyset)) {
      throw new Error('output keyset verification binding is invalid')
    }
  }
  if (record.terminalTombstone !== null
    && record.terminalTombstone.tradeId !== requireTradeBinding(record).tradeId) {
    throw new Error('terminal tombstone trade id is invalid')
  }
  if (record.terminalTombstone !== null
    && (record.operation.state !== 'reconciled' || record.operation.result.state !== 'applied')) {
    throw new Error('terminal tombstone lifecycle is invalid')
  }
}

function validateCustodyContext(record: DurableCustodyRecord): void {
  const context = record.operation.custodyContext
  if (record.scope.scopeKind === 'wallet') {
    if (context.inventoryAccountId !== null) throw new Error('wallet custody context inventory is invalid')
    return
  }
  if (context.inventoryAccountId !== record.scope.inventoryAccountId
    || context.normalizedMint !== record.scope.normalizedMint
    || context.unit !== record.scope.unit) {
    throw new Error('market custody context is foreign')
  }
}

function validateSemanticHorizon(
  semanticKind: DurableCustodySemanticKind,
  horizon: DurableCustodyRecord['operation']['horizon'],
): void {
  const rule = SEMANTIC_HORIZON_RULES[semanticKind]
  if (rule.requireNotBefore && horizon.notBeforeMs === null) {
    throw new Error('operation semantic horizon requires not-before')
  }
  if (rule.requireNotAfter && horizon.notAfterMs === null) {
    throw new Error('operation semantic horizon requires not-after')
  }
}

function exactOperationReference(record: DurableCustodyRecord): DurableCustodyExactOperationReference {
  return {
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    requestPayloadHandle: record.operation.exactRequest.payloadHandle,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    outputMaterialHandle: record.operation.outputPlan.outputMaterialHandle,
    privateMaterial: { ...record.operation.privateMaterial },
    stagedResult: record.operation.result.state === 'none'
      ? null
      : {
        resultHandle: record.operation.result.resultHandle!,
        resultFingerprint: record.operation.result.resultFingerprint!,
        outputPlanFingerprint: record.operation.result.outputPlanFingerprint!,
      },
  }
}

function validateScopeState(
  scopeState: DurableCustodyScopeState,
  expectedScope: DurableCustodyScope,
): void {
  if (scopeState.schemaVersion !== DURABLE_CUSTODY_SCHEMA_VERSION) {
    throw new Error('foreign custody scope')
  }
  const canonicalScope = decodeScope(scopeState.scope)
  if (canonicalScope.scopeId !== expectedScope.scopeId) {
    throw new Error('foreign custody scope')
  }
  requireNonNegativeInteger(scopeState.fencingEpoch, 'custody fencing epoch')
  requireNonNegativeInteger(scopeState.effectiveClock.highWaterMarkMs, 'effective clock high-water mark')
  if (scopeState.owner === null) return
  requireIdentifier(scopeState.owner.incarnationId, 'custody owner incarnation id')
  requireNonNegativeInteger(scopeState.owner.leaseExpiresAtMs, 'custody owner lease expiry')
}

function claimOwner(
  scopeState: DurableCustodyScopeState,
  transition: Extract<DurableCustodyTransition, { kind: 'owner-claimed' }>,
): DurableCustodyScopeState {
  const observedAtMs = requireNonNegativeInteger(transition.observedAtMs, 'owner claim observed time')
  const effectiveNowMs = Math.max(scopeState.effectiveClock.highWaterMarkMs, observedAtMs)
  const nextIncarnationId = requireIdentifier(
    transition.nextIncarnationId,
    'next owner incarnation id',
  )
  const nextFencingEpoch = requireNonNegativeInteger(
    transition.nextFencingEpoch,
    'next fencing epoch',
  )
  const nextLeaseExpiresAtMs = requireNonNegativeInteger(transition.nextLeaseExpiresAtMs, 'next owner lease expiry')
  if (scopeState.owner !== null && effectiveNowMs < scopeState.owner.leaseExpiresAtMs) {
    throw new Error('custody owner lease has not expired')
  }
  if (nextFencingEpoch !== scopeState.fencingEpoch + 1) {
    throw new Error('custody owner epoch is not monotonic')
  }
  if (nextLeaseExpiresAtMs <= effectiveNowMs) {
    throw new Error('next custody owner lease is invalid')
  }
  const next = structuredClone(scopeState)
  next.fencingEpoch = nextFencingEpoch
  next.owner = {
    incarnationId: nextIncarnationId,
    leaseExpiresAtMs: nextLeaseExpiresAtMs,
  }
  next.effectiveClock.highWaterMarkMs = effectiveNowMs
  return next
}

function renewOwner(
  scopeState: DurableCustodyScopeState,
  transition: Extract<DurableCustodyTransition, { kind: 'owner-renewed' }>,
): DurableCustodyScopeState {
  const effectiveNowMs = authorizeOwner(scopeState, transition)
  const nextLeaseExpiresAtMs = requireNonNegativeInteger(
    transition.nextLeaseExpiresAtMs,
    'next owner lease expiry',
  )
  if (
    scopeState.owner === null ||
    nextLeaseExpiresAtMs <= scopeState.owner.leaseExpiresAtMs ||
    nextLeaseExpiresAtMs <= effectiveNowMs
  ) {
    throw new Error('next custody owner lease is invalid')
  }
  const next = structuredClone(scopeState)
  next.owner!.leaseExpiresAtMs = nextLeaseExpiresAtMs
  next.effectiveClock.highWaterMarkMs = effectiveNowMs
  return next
}

function releaseOwner(
  scopeState: DurableCustodyScopeState,
  transition: Extract<DurableCustodyTransition, { kind: 'owner-released' }>,
): DurableCustodyScopeState {
  const effectiveNowMs = authorizeOwner(scopeState, transition)
  const next = structuredClone(scopeState)
  next.owner = null
  next.effectiveClock.highWaterMarkMs = effectiveNowMs
  return next
}

function authorizeOwner(scopeState: DurableCustodyScopeState, authorization: DurableCustodyOwnerAuthorization): number {
  const incarnationId = requireIdentifier(
    authorization.incarnationId,
    'custody owner incarnation id',
  )
  const fencingEpoch = requireNonNegativeInteger(
    authorization.fencingEpoch,
    'custody fencing epoch',
  )
  const observedAtMs = requireNonNegativeInteger(authorization.observedAtMs, 'custody owner observed time')
  const effectiveNowMs = Math.max(scopeState.effectiveClock.highWaterMarkMs, observedAtMs)
  if (scopeState.owner === null) {
    throw new Error('custody scope is unclaimed')
  }
  if (
    incarnationId !== scopeState.owner.incarnationId ||
    fencingEpoch !== scopeState.fencingEpoch
  ) {
    throw new Error('custody owner epoch is foreign')
  }
  if (effectiveNowMs >= scopeState.owner.leaseExpiresAtMs) {
    throw new Error('custody owner lease has expired')
  }
  return effectiveNowMs
}

function isDispatchOpen(horizon: DurableCustodyRecord['operation']['horizon'], nowMs: number): boolean {
  if (horizon.notBeforeMs !== null && nowMs < horizon.notBeforeMs) return false
  const deadlineMs = minimumDefined(horizon.notAfterMs, horizon.keysetExpiryMs)
  return deadlineMs === null || nowMs < deadlineMs - horizon.safetyMarginMs
}

function isDispatchBeforeWindow(horizon: DurableCustodyRecord['operation']['horizon'], nowMs: number): boolean {
  return horizon.notBeforeMs !== null && nowMs < horizon.notBeforeMs
}

function isAbortEligible(
  record: DurableCustodyRecord,
  classification: DurableCustodyRecoveryClassification,
  exactRequestDisposition: DurableCustodyRecoveryInput['exactRequestDisposition'],
): boolean {
  const exactInputStates: DurableCustodySafeAbortEvidence['exactInputStates'] =
    classification === 'all-inputs-unspent'
      ? record.operation.reservation.inputs.map(() => 'unspent' as const)
      : record.operation.reservation.inputs.map(() => 'unknown' as const)
  return isDurableCustodySafeAbortEligible({
    operationState: record.operation.state,
    submissionState: record.operation.state === 'dispatch-intent'
      ? 'not-submitted'
      : record.operation.state === 'transport-attempted' ? 'submitted' : 'unknown',
    exactInputStates,
    exactRequestDisposition,
    hasDependentJournaledIntent: record.operation.binding.kind === 'trade'
      && record.operation.binding.hasDependentOperation,
    hasStagedResult: record.operation.result.state !== 'none',
    deliveryState: record.operation.delivery.state,
  })
}

function requireTradeBinding(
  record: DurableCustodyRecord,
): Extract<DurableCustodyBinding, { kind: 'trade' }> {
  if (record.operation.binding.kind !== 'trade') {
    throw new Error('operation requires trade binding')
  }
  return record.operation.binding
}

function operationIdentityBinding(
  binding: DurableCustodyBinding,
): DurableCustodyOperationIdentity['binding'] {
  return binding.kind === 'trade'
    ? {
        kind: binding.kind,
        tradeId: binding.tradeId,
        role: binding.role,
        stage: binding.stage,
      }
    : {
        kind: binding.kind,
        activityId: binding.activityId,
        stage: binding.stage,
      }
}

function validateDeliveryExpiry(
  delivery: DurableCustodyRecord['operation']['delivery'],
  effectiveNowMs: number,
): void {
  if (delivery.deliveryKind === 'outbox' && delivery.state === 'expired'
    && delivery.expiresAtMs !== null && effectiveNowMs < delivery.expiresAtMs) {
    throw new Error('delivery expiry is premature')
  }
}

function isDeliveryTerminalAt(
  delivery: DurableCustodyRecord['operation']['delivery'],
  effectiveNowMs: number,
): boolean {
  return delivery.deliveryKind === 'none'
    || delivery.state === 'acknowledged'
    || (delivery.state === 'expired' && delivery.expiresAtMs !== null && delivery.expiresAtMs <= effectiveNowMs)
}

function minimumDefined(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function requireIdentifier(value: unknown, name: string): string {
  const text = requireString(value, name)
  if (text.length === 0 || text.length > 512) throw new Error(`${name} is invalid`)
  return text
}

function requireCompositeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0
    || value.length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireSecret(value: unknown): string {
  const secret = requireString(value, 'proof secret')
  if (secret.length === 0 || secret.length > 16_384) throw new Error('proof secret is invalid')
  return secret
}

function requireNormalizedMint(value: unknown): string {
  const mint = requireString(value, 'normalized mint')
  let parsed: URL
  try {
    parsed = new URL(mint)
  } catch {
    throw new Error('normalized mint is invalid')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || /%[0-9a-f]{2}/i.test(parsed.pathname)) {
    throw new Error('normalized mint is invalid')
  }
  const normalized = parsed.href.replace(/\/+$/, '')
  if (normalized.length === 0 || normalized !== mint || normalized.length > 2_048) {
    throw new Error('normalized mint is invalid')
  }
  return normalized
}

function requireFingerprint(value: unknown, name: string): string {
  const text = requireString(value, name)
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`${name} is invalid`)
  return text.toLowerCase()
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireJsonByteLimit(value: unknown, limit: number, name: string): void {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error(`${name} is invalid`)
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > limit) {
    throw new Error(`${name} exceeds the byte limit`)
  }
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function requireOneOf<T extends string>(value: string, values: readonly T[], name: string): asserts value is T {
  if (!values.includes(value as T)) throw new Error(`${name} is invalid`)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
}

function encodeProofIdentity(parts: readonly string[]): Uint8Array {
  const encoder = new TextEncoder()
  const encoded = parts.map((part) => encoder.encode(part))
  const length = encoded.reduce((total, bytes) => total + 4 + bytes.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const bytes of encoded) {
    new DataView(output.buffer).setUint32(offset, bytes.length, false)
    offset += 4
    output.set(bytes, offset)
    offset += bytes.length
  }
  return output
}
