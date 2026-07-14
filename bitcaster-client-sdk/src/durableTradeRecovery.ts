import {
  isSwapCipherMessageType,
  type SwapCipherMessageType,
  type SwapRole,
} from './tradeSession.ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'

export const DURABLE_TRADE_SESSION_SCHEMA_VERSION = 2 as const

const DURABLE_OUTBOUND_MESSAGE_ORDER: readonly SwapCipherMessageType[] = [
  'adaptor-point',
  'locked-proofs-seller',
  'locked-proofs-buyer',
]

export type DurableTradeSessionStage =
  | 'intent'
  | 'proof-reserved'
  | 'mint-submitted'
  | 'awaiting-dependent-operation'
  | 'reconciliation-complete'

/** Routes an exact operation to its retained local recovery adapter. */
export type DurableProofOperationKind =
  | 'cashu-atomic'
  | 'condition-ctf-merge'

export type DurableProofOperationStage =
  | 'proof-reservation'
  | 'mint-submission'
  | 'claim'
  | 'refund'

export type DurableProofOperationState =
  | 'prepared'
  | 'mint-submitted'
  | 'reconciled'

export interface DurableTradeCipher {
  ciphertext: string
  sha256: string
}

export interface DurableEphemeralKeyHandle {
  keyId: string
  tradeId: string
  role: SwapRole
  localProtocolPubkey: string
  counterpartyProtocolPubkey: string
  mintUrl: string
  sellerLocktimeSecs: number
  buyerLocktimeSecs: number
}

export interface DurableTradeProofOperationLink {
  operationId: string
  /**
   * Client-local operation identifier bound into the SDK recovery identity.
   * It permits a client to retain its established database key without making
   * that key the cross-client recovery authority.
   */
  operationKey?: string
  /** Present for v2 dependent-operation flows; legacy atomic links omit it. */
  kind?: DurableProofOperationKind
  tradeId: string
  role: SwapRole
  stage: DurableProofOperationStage
  state: DurableProofOperationState
}

/**
 * A write-ahead session binding for an operation that may be persisted in a
 * separate proof ledger. It is deliberately immutable and has no state: its
 * only job is to authenticate a later orphan relink.
 */
export interface DurableTradeExpectedProofOperation {
  operationId: string
  operationKey: string
  stage: DurableProofOperationStage
  kind?: DurableProofOperationKind
}

/**
 * Immutable adapter-owned commitments for a dependent custody operation.
 * The SDK validates its shape; adapters additionally validate the opaque
 * commitments against their exact local ledger rows before activation.
 */
export interface DurableDependentOperationContext {
  contextVersion: 1
  tradeId: string
  role: SwapRole
  localProtocolPubkey: string
  counterpartyProtocolPubkey: string
  mintUrl: string
  sellerLocktimeSecs: number
  buyerLocktimeSecs: number
  conditionId: string
  ammScopeId: string
  inventoryAccountId: string
  baseAsset: string
  unit: string
  outcomeSetCommitment: string
  keysetCommitment: string
  feeCommitment: string
  mergeInputCommitment: string
  expectedOutputCommitment: string
  mergeOperationKey: string
  lockOperationKey: string
}

/** A deterministic operation that must not be queried or created yet. */
export interface DurableTradePlannedProofOperation {
  operationId: string
  operationKey: string
  kind: DurableProofOperationKind
  stage: DurableProofOperationStage
  dependsOnOperationId: string
  context: DurableDependentOperationContext
}

export interface DurableTradeSession {
  schemaVersion: number
  revision: number
  tradeId: string
  role: SwapRole
  localProtocolPubkey: string
  counterpartyProtocolPubkey: string
  mintUrl: string
  sellerLocktimeSecs: number
  buyerLocktimeSecs: number
  ephemeralKeyHandle: DurableEphemeralKeyHandle
  stage: DurableTradeSessionStage
  /** Required before a new adapter creates an independently persisted operation. */
  expectedProofOperations?: DurableTradeExpectedProofOperation[]
  /** Deferred operations; never scanned as missing until explicitly activated. */
  plannedProofOperations?: DurableTradePlannedProofOperation[]
  proofOperations: DurableTradeProofOperationLink[]
  receivedCiphers: Partial<Record<SwapCipherMessageType, DurableTradeCipher>>
  outboundCiphers: Partial<Record<SwapCipherMessageType, DurableTradeCipher>>
}

/** A client-owned durable session plus its adapter-specific private payload. */
export interface DurableTradeSessionRecord<TAdapterState> {
  session: DurableTradeSession
  adapterState: TAdapterState
  updatedAt: number
}

/**
 * Durable pre-session binding retained after an order receives a trade id but
 * before TradeCreated supplies role, counterparty, and locktimes.
 */
export interface DurableTradePendingIntent {
  schemaVersion: number
  tradeId: string
  orderId: string
  marketId: string
  localProtocolPubkey: string
  deadline: string
}

export interface DurableTradeSessionRepository {
  get(tradeId: string): Promise<DurableTradeSession | null>
  listRecoverable(): Promise<DurableTradeSession[]>
  create(session: DurableTradeSession): Promise<DurableTradeSession>
  compareAndSwap(
    tradeId: string,
    expectedRevision: number,
    next: DurableTradeSession,
  ): Promise<DurableTradeSession | null>
  remove(tradeId: string, expectedRevision: number): Promise<boolean>
}

export interface DurableProofOperationRepository {
  get(operationId: string): Promise<DurableTradeProofOperationLink | null>
  listByTrade(tradeId: string): Promise<DurableTradeProofOperationLink[]>
  /** Enumerates every non-terminal operation retained by this client installation. */
  listRecoverable(): Promise<DurableTradeProofOperationLink[]>
  prepare(operation: DurableTradeProofOperationLink): Promise<DurableTradeProofOperationLink>
  markMintSubmitted(operationId: string): Promise<DurableTradeProofOperationLink>
  markReconciled(operationId: string): Promise<DurableTradeProofOperationLink>
}

/**
 * Pre-TradeCreated state has a distinct lifecycle from a fully bound swap
 * session. Adapters retain it in the same durable store, but must not invent a
 * session from an intent during recovery.
 */
export interface DurableTradePendingIntentRepository {
  get(tradeId: string): Promise<DurableTradePendingIntent | null>
  listRecoverable(): Promise<DurableTradePendingIntent[]>
  put(intent: DurableTradePendingIntent): Promise<DurableTradePendingIntent>
  remove(tradeId: string): Promise<boolean>
}

export type DurableTradeMintRecoveryState =
  | 'prepared-unspent'
  | 'prepared-spent-restorable'
  | 'pending-or-mixed'
  | 'mint-response-unknown'
  | 'rate-limited'
  | 'reservation-race'
  | 'engine-terminal'
  | 'expired-refund-salvage'
  | 'corrupt'
  | 'foreign'

/** The adapter maps NUT-07/NUT-09 observations into this SDK-owned input. */
export interface DurableTradeMintInspection {
  kind: DurableTradeMintRecoveryState
  /** Server-provided delay. It is still clamped to the local locktime deadline. */
  retryAfterMs?: number
}

/**
 * This is the only custody-facing recovery port. Its implementation owns the
 * concrete prepared inputs/outputs and Cashu transport, while the SDK decides
 * whether an exact action is permitted.
 */
export interface DurableTradeMintRecoveryPort {
  inspect(operation: DurableTradeProofOperationLink): Promise<DurableTradeMintInspection>
  /**
   * Restores the operation's exact persisted outputs into the local proof
   * store. It MUST atomically deduplicate by operation id/output identity, so
   * a crash before `markReconciled` may safely invoke it again.
   */
  restoreExactPersistedOutputs(operation: DurableTradeProofOperationLink): Promise<void>
  /**
   * Submits the already persisted request and atomically applies/deduplicates
   * its exact outputs before resolving. Throw when the mint response is
   * indeterminate; the coordinator will retain `mint-submitted` for NUT-07/09.
   */
  resumeExactPreparedOperation(operation: DurableTradeProofOperationLink): Promise<void>
  salvageExpiredRefund?(operation: DurableTradeProofOperationLink): Promise<void>
  /** Dereferences the local private key handle for the strictly validated refund path. */
  getRefundSalvageEvidence?(
    operation: DurableTradeProofOperationLink,
  ): Promise<(DurableRefundSalvageEvidence & { privateKeyHex: string }) | null>
}

export interface DurableTradeRecoveryClock {
  nowMs(): number
  /** Optional deterministic entropy source for bounded retry jitter. */
  random?(): number
}

export interface DurableTradeRetryRequest {
  tradeId: string
  operationId: string
  delayMs: number
  reason: 'pending-or-mixed' | 'mint-response-unknown' | 'rate-limited' | 'reservation-race'
}

/**
 * Optional adapter transaction for split durable stores. When supplied, the
 * adapter advances its session projection and proof-operation ledger in one
 * commit; the coordinator still validates both returned records.
 */
export interface DurableTradeAtomicTransitionPort {
  advance(input: {
    session: DurableTradeSession
    operation: DurableTradeProofOperationLink
    state: 'mint-submitted' | 'reconciled'
  }): Promise<{
    session: DurableTradeSession
    operation: DurableTradeProofOperationLink
  } | null>
}

export interface DurableTradeRecoveryPorts {
  sessions: DurableTradeSessionRepository
  operations: DurableProofOperationRepository
  /** Present once an adapter persists pre-TradeCreated intents. */
  pendingIntents?: DurableTradePendingIntentRepository
  mint: DurableTradeMintRecoveryPort
  transport: DurableTradeResumePorts
  clock: DurableTradeRecoveryClock
  hashCiphertext: (ciphertext: string) => Promise<string>
  scheduleRetry?: (request: DurableTradeRetryRequest) => Promise<void>
  atomicTransition?: DurableTradeAtomicTransitionPort
}

export type DurableTradeRecoveryAction =
  | { action: 'resume-exact-prepared-operation' }
  | { action: 'restore-exact-persisted-outputs' }
  | {
    action: 'backoff'
    reason: 'pending-or-mixed' | 'mint-response-unknown' | 'rate-limited' | 'reservation-race'
  }
  | { action: 'await-refund-salvage' }
  | { action: 'salvage-expired-refund' }
  | { action: 'fail-closed'; reason: 'corrupt' | 'foreign' }

export type DurableTradeSessionRecoveryResult =
  | { kind: 'ready'; tradeId: string }
  | { kind: 'replayed'; tradeId: string; sentMessageTypes: SwapCipherMessageType[] }
  | {
    kind: 'awaiting-dependent-operation'
    tradeId: string
    operationIds: string[]
  }
  | { kind: 'retry-scheduled'; tradeId: string; operationId: string }
  | { kind: 'awaiting-refund-salvage'; tradeId: string; operationId: string }
  | { kind: 'mint-response-unknown'; tradeId: string; operationId: string }
  | { kind: 'transport-ack-unknown'; tradeId: string }
  | {
    kind: 'failed-closed'
    tradeId: string
    reason: 'invalid-session' | 'invalid-cipher' | 'missing-proof-operation' |
      'foreign-proof-operation' | 'session-cas-conflict' | 'storage-unavailable'
  }

export type DurableTradeOrphanRecoveryResult =
  | { kind: 'relinked'; operationId: string; tradeId: string }
  | {
    kind: 'failed-closed'
    operationId: string
    reason: 'invalid-operation' | 'missing-session' | 'invalid-session' | 'session-cas-conflict'
  }

export interface DurableTradeRecoveryResult {
  sessions: DurableTradeSessionRecoveryResult[]
  orphans: DurableTradeOrphanRecoveryResult[]
  pendingIntents?: Array<{ tradeId: string; kind: 'valid' | 'failed-closed' }>
}

export type DurableTradeSessionEvent =
  | {
    /** Atomically records the active predecessor and its deferred successor. */
    kind: 'dependent-operations-planned'
    active: DurableTradeExpectedProofOperation
    plan: DurableTradePlannedProofOperation
  }
  | {
    /** Promotes one dependency-satisfied plan into an active write-ahead row. */
    kind: 'dependent-operation-activated'
    operationId: string
  }
  | {
    kind: 'proof-operation-prepared'
    operation: DurableTradeProofOperationLink
  }
  | {
    kind: 'mint-submitted'
    operationId: string
  }
  | {
    kind: 'proof-operation-reconciled'
    operationId: string
  }
  | {
    kind: 'received-cipher-recorded'
    messageType: SwapCipherMessageType
    ciphertext: string
    sha256: string
  }
  | {
    kind: 'outbound-cipher-journaled'
    messageType: SwapCipherMessageType
    ciphertext: string
    sha256: string
  }

export interface DurableTradeRecoveryScan {
  missingOperations: string[]
  orphanOperations: string[]
}

/** Ports required to resume an already journalled protocol outbox. */
export interface DurableTradeResumePorts {
  joinTrade(tradeId: string): Promise<void>
  sendCipher(
    tradeId: string,
    messageType: SwapCipherMessageType,
    ciphertext: string,
  ): Promise<void>
}

export type DurableTradeResumeResult =
  | { kind: 'invalid-session'; reason: string }
  | { kind: 'ready'; session: DurableTradeSession }
  | { kind: 'replayed'; session: DurableTradeSession; sentMessageTypes: SwapCipherMessageType[] }

export interface DurableRefundSalvageEvidence {
  tradeId: string
  role: SwapRole
  localProtocolPubkey: string
  counterpartyProtocolPubkey: string
  mintUrl: string
  sellerLocktimeSecs: number
  buyerLocktimeSecs: number
  keyHandle: DurableEphemeralKeyHandle
  proofOperation: DurableTradeProofOperationLink
}

/**
 * Makes the split-store operation key idempotent and independently discoverable
 * from either the session repository or a proof-operation ledger.
 */
export function deriveDurableProofOperationId(
  tradeId: string,
  role: SwapRole,
  stage: DurableProofOperationStage,
  operationKey?: string,
  kind?: DurableProofOperationKind,
): string {
  if (!isIdentifier(tradeId)) throw new Error('trade id must be a durable identifier')
  if (operationKey !== undefined && !isOperationKey(operationKey)) {
    throw new Error('durable proof operation key is invalid')
  }
  if (kind !== undefined && !isProofOperationKind(kind)) {
    throw new Error('durable proof operation kind is invalid')
  }
  const suffix = operationKey === undefined ? '' : `:${encodeURIComponent(operationKey)}`
  const kindPrefix = kind === undefined ? '' : `:${kind}`
  return `trade-recovery:${tradeId}:${role}:${stage}${kindPrefix}${suffix}`
}

/** Builds the SDK-owned identity stored beside a client proof operation. */
export function createDurableTradeProofOperationLink(input: {
  tradeId: string
  role: SwapRole
  stage: DurableProofOperationStage
  state: DurableProofOperationState
  /** Required for new records; absent values are accepted only when reading legacy rows. */
  operationKey: string
  kind?: DurableProofOperationKind
}): DurableTradeProofOperationLink {
  if (!isOperationKey(input.operationKey)) {
    throw new Error('durable proof operation key is invalid')
  }
  const operation: DurableTradeProofOperationLink = {
    operationId: deriveDurableProofOperationId(
      input.tradeId,
      input.role,
      input.stage,
      input.operationKey,
      input.kind,
    ),
    operationKey: input.operationKey,
    tradeId: input.tradeId,
    role: input.role,
    stage: input.stage,
    state: input.state,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  }
  const error = validateDurableProofOperationLink(operation)
  if (error) throw new Error(error)
  return operation
}

/** Creates the session-side write-ahead binding before a proof row is prepared. */
export function createDurableTradeExpectedProofOperation(input: {
  tradeId: string
  role: SwapRole
  stage: DurableProofOperationStage
  operationKey: string
  kind?: DurableProofOperationKind
}): DurableTradeExpectedProofOperation {
  if (!isOperationKey(input.operationKey)) {
    throw new Error('durable proof operation key is invalid')
  }
  return {
    operationId: deriveDurableProofOperationId(
      input.tradeId,
      input.role,
      input.stage,
      input.operationKey,
      input.kind,
    ),
    operationKey: input.operationKey,
    stage: input.stage,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  }
}

export function validateDurableTradeSession(
  session: DurableTradeSession,
): string | null {
  if (!isObjectRecord(session)) return 'durable trade session is not an object'
  if (!Array.isArray(session.proofOperations)) {
    return 'durable trade session proof operations are invalid'
  }
  if (
    session.plannedProofOperations !== undefined &&
    !Array.isArray(session.plannedProofOperations)
  ) {
    return 'durable trade session planned proof operations are invalid'
  }
  if (!isObjectRecord(session.receivedCiphers) || !isObjectRecord(session.outboundCiphers)) {
    return 'durable trade session cipher journals are invalid'
  }
  if (!isObjectRecord(session.ephemeralKeyHandle)) {
    return 'durable trade session key handle is invalid'
  }
  if (session.expectedProofOperations !== undefined && !Array.isArray(session.expectedProofOperations)) {
    return 'durable trade session expected proof operations are invalid'
  }
  if (session.schemaVersion !== DURABLE_TRADE_SESSION_SCHEMA_VERSION) {
    return `unsupported durable trade session schema version '${session.schemaVersion}'`
  }
  if (!Number.isSafeInteger(session.revision) || session.revision < 0) {
    return 'durable trade session revision must be a non-negative safe integer'
  }
  if (!isIdentifier(session.tradeId)) return 'durable trade session trade id is invalid'
  if (session.role !== 'seller' && session.role !== 'buyer') {
    return 'durable trade session role is invalid'
  }
  if (!isProtocolPubkey(session.localProtocolPubkey)) {
    return 'durable trade session local protocol public key is invalid'
  }
  if (!isProtocolPubkey(session.counterpartyProtocolPubkey)) {
    return 'durable trade session counterparty protocol public key is invalid'
  }
  if (session.localProtocolPubkey === session.counterpartyProtocolPubkey) {
    return 'durable trade session protocol public keys must differ'
  }
  if (!isMintUrl(session.mintUrl)) return 'durable trade session mint URL is invalid'
  if (
    !isLocktime(session.sellerLocktimeSecs) ||
    !isLocktime(session.buyerLocktimeSecs) ||
    session.sellerLocktimeSecs <= session.buyerLocktimeSecs
  ) {
    return 'durable trade session locktime ordering is invalid'
  }
  if (!isKeyHandleBoundToSession(session, session.ephemeralKeyHandle)) {
    return 'durable trade session key handle binding is invalid'
  }
  if (!isSessionStage(session.stage)) return 'durable trade session stage is invalid'

  const expectedOperationIds = new Set<string>()
  const operationKeys = new Set<string>()
  for (const expected of session.expectedProofOperations ?? []) {
    const error = validateExpectedProofOperation(session, expected)
    if (error) return error
    if (expectedOperationIds.has(expected.operationId)) {
      return 'durable trade session contains duplicate expected proof operation ids'
    }
    if (operationKeys.has(expected.operationKey)) {
      return 'durable trade session contains duplicate expected proof operation keys'
    }
    expectedOperationIds.add(expected.operationId)
    operationKeys.add(expected.operationKey)
  }

  const operationIds = new Set<string>()
  for (const operation of session.proofOperations) {
    const error = validateDurableProofOperationLink(operation)
    if (error) return error
    if (operation.tradeId !== session.tradeId || operation.role !== session.role) {
      return 'durable proof operation does not belong to its session'
    }
    if (operationIds.has(operation.operationId)) {
      return 'durable trade session contains duplicate proof operation ids'
    }
    const matchingExpected = session.expectedProofOperations?.find(
      (expected) => sameExpectedOperationIdentity(expected, operation),
    )
    if (
      operation.operationKey && operationKeys.has(operation.operationKey) &&
      !matchingExpected
    ) {
      return 'durable trade session contains duplicate active proof operation keys'
    }
    operationIds.add(operation.operationId)
    if (operation.operationKey) operationKeys.add(operation.operationKey)
    if (session.expectedProofOperations !== undefined && !expectedOperationIds.has(operation.operationId)) {
      return 'durable proof operation is not bound by a session write-ahead identity'
    }
  }

  const plannedOperationIds = new Set<string>()
  const plannedOperations = session.plannedProofOperations ?? []
  if (plannedOperations.length > 0 && plannedOperations.length !== 1) {
    return 'durable dependent session requires exactly one planned lock'
  }
  if (plannedOperations.length > 0 && expectedOperationIds.size !== 1) {
    return 'durable dependent session requires exactly one active merge'
  }
  for (const plan of plannedOperations) {
    const error = validatePlannedProofOperation(session, plan)
    if (error) return error
    if (plannedOperationIds.has(plan.operationId) || expectedOperationIds.has(plan.operationId) ||
      operationIds.has(plan.operationId)) {
      return 'durable trade session contains duplicate active or planned operation ids'
    }
    if (operationKeys.has(plan.operationKey)) {
      return 'durable trade session contains duplicate active or planned operation keys'
    }
    plannedOperationIds.add(plan.operationId)
    operationKeys.add(plan.operationKey)
  }
  for (const plan of plannedOperations) {
    if (!expectedOperationIds.has(plan.dependsOnOperationId)) {
      return 'durable planned proof operation dependency must be active'
    }
    const dependency = session.expectedProofOperations?.find(
      (expected) => expected.operationId === plan.dependsOnOperationId,
    )
    if (
      dependency?.kind !== 'condition-ctf-merge' ||
      dependency.stage !== 'proof-reservation' ||
      plan.kind !== 'cashu-atomic' ||
      plan.stage !== 'proof-reservation' ||
      plan.context.mergeOperationKey !== dependency.operationKey
    ) {
      return 'durable planned proof operation pair is invalid'
    }
    if (plan.dependsOnOperationId === plan.operationId) {
      return 'durable planned proof operation cannot depend on itself'
    }
  }

  if (
    (session.stage === 'proof-reserved' || session.stage === 'mint-submitted') &&
    session.proofOperations.length === 0
  ) {
    return 'durable trade session stage requires a proof operation'
  }
  if (
    session.stage === 'mint-submitted' &&
    !session.proofOperations.some((operation) => operation.state === 'mint-submitted')
  ) {
    return 'durable trade session mint-submitted stage requires a mint-submitted operation'
  }
  if (
    session.stage === 'reconciliation-complete' &&
    (session.proofOperations.some((operation) => operation.state !== 'reconciled') ||
      (session.plannedProofOperations?.length ?? 0) > 0)
  ) {
    return 'durable trade session completed reconciliation has pending proof operations'
  }
  if (
    session.stage === 'awaiting-dependent-operation' &&
    (plannedOperations.length !== 1 || expectedOperationIds.size !== 1 ||
      session.proofOperations.length !== 1 ||
      !session.proofOperations.every((operation) => operation.state === 'reconciled') ||
      session.proofOperations[0]?.operationId !== plannedOperations[0]?.dependsOnOperationId)
  ) {
    return 'durable trade session awaiting dependent operation is invalid'
  }

  return validateCipherJournal(session.receivedCiphers) ??
    validateCipherJournal(session.outboundCiphers)
}

export function validateDurableTradePendingIntent(
  intent: DurableTradePendingIntent,
): string | null {
  if (!isObjectRecord(intent)) return 'durable pending trade intent is not an object'
  if (intent.schemaVersion !== DURABLE_TRADE_SESSION_SCHEMA_VERSION) {
    return `unsupported durable pending trade intent schema version '${intent.schemaVersion}'`
  }
  if (!isIdentifier(intent.tradeId)) return 'durable pending trade intent trade id is invalid'
  if (!isIdentifier(intent.orderId)) return 'durable pending trade intent order id is invalid'
  if (typeof intent.marketId !== 'string' || intent.marketId.length === 0 || intent.marketId.length > 512) {
    return 'durable pending trade intent market id is invalid'
  }
  if (!isProtocolPubkey(intent.localProtocolPubkey)) {
    return 'durable pending trade intent local protocol public key is invalid'
  }
  if (!Number.isFinite(Date.parse(intent.deadline))) {
    return 'durable pending trade intent deadline is invalid'
  }
  return null
}

/** Verifies that adapter-held private material is bound to the protocol key. */
export function validateDurableTradePrivateKeyBinding(
  privateKeyHex: string,
  publicKeyHex: string,
): string | null {
  if (!/^[a-f0-9]{64}$/i.test(privateKeyHex)) {
    return 'durable trade private key is invalid'
  }
  if (!isProtocolPubkey(publicKeyHex)) {
    return 'durable trade public key is invalid'
  }
  try {
    const privateKey = Uint8Array.from(
      privateKeyHex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
    )
    const actual = Array.from(secp256k1.getPublicKey(privateKey, true))
      .map((part) => part.toString(16).padStart(2, '0'))
      .join('')
    return actual === publicKeyHex.toLowerCase()
      ? null
      : 'durable trade private key does not match its public key'
  } catch {
    return 'durable trade private key is invalid'
  }
}

export async function verifyDurableTradeSessionCipherIntegrity(
  session: DurableTradeSession,
  hashCiphertext: (ciphertext: string) => Promise<string>,
): Promise<string | null> {
  const shapeError = validateDurableTradeSession(session)
  if (shapeError) return shapeError

  for (const cipher of [
    ...Object.values(session.receivedCiphers),
    ...Object.values(session.outboundCiphers),
  ]) {
    if (!cipher) continue
    const actualHash = await hashCiphertext(cipher.ciphertext)
    if (actualHash.toLowerCase() !== cipher.sha256) {
      return 'durable trade session cipher hash mismatch'
    }
  }
  return null
}

/**
 * Rejoins the trade before replaying the exact durable outbox. This deliberately
 * never generates a new cipher, starts a mint operation, or turns a failed
 * delivery acknowledgement into a terminal client decision.
 */
export async function resumeDurableTradeSession(
  session: DurableTradeSession,
  ports: DurableTradeResumePorts,
): Promise<DurableTradeResumeResult> {
  const validationError = validateDurableTradeSession(session)
  if (validationError) return { kind: 'invalid-session', reason: validationError }

  await ports.joinTrade(session.tradeId)
  const sentMessageTypes: SwapCipherMessageType[] = []
  for (const messageType of DURABLE_OUTBOUND_MESSAGE_ORDER) {
    const cipher = session.outboundCiphers[messageType]
    if (!cipher) continue
    await ports.sendCipher(session.tradeId, messageType, cipher.ciphertext)
    sentMessageTypes.push(messageType)
  }
  return sentMessageTypes.length === 0
    ? { kind: 'ready', session }
    : { kind: 'replayed', session, sentMessageTypes }
}

/**
 * Pure recovery policy for prepared Cashu operations. Keep this table in the
 * SDK so GUI, CLI, daemon, and wallet-service cannot diverge on an ambiguous
 * mint response.
 */
export function classifyDurableTradeRecoveryDisposition(
  state: DurableTradeMintRecoveryState,
): DurableTradeRecoveryAction {
  switch (state) {
    case 'prepared-unspent':
      return { action: 'resume-exact-prepared-operation' }
    case 'prepared-spent-restorable':
      return { action: 'restore-exact-persisted-outputs' }
    case 'pending-or-mixed':
    case 'mint-response-unknown':
    case 'rate-limited':
    case 'reservation-race':
      return { action: 'backoff', reason: state }
    case 'engine-terminal':
      return { action: 'await-refund-salvage' }
    case 'expired-refund-salvage':
      return { action: 'salvage-expired-refund' }
    case 'corrupt':
    case 'foreign':
      return { action: 'fail-closed', reason: state }
  }
}

/**
 * Recovers every retained session and operation in a client installation.
 *
 * An operation is never synthesized by this routine: it may relink an
 * independently persisted record to a valid session, but a missing record is
 * surfaced fail-closed. Before an exact prepared request is resent, the
 * session and operation are advanced to `mint-submitted`; a crash after that
 * point therefore returns to NUT-07/NUT-09 inspection rather than a blind
 * retry.
 */
export async function recoverDurableTradeSessions(
  ports: DurableTradeRecoveryPorts,
): Promise<DurableTradeRecoveryResult> {
  let rawSessions: unknown[]
  let rawOperations: unknown[]
  let rawPendingIntents: unknown[] | undefined
  try {
    const loaded = await Promise.all([
      ports.sessions.listRecoverable(),
      ports.operations.listRecoverable(),
      ports.pendingIntents?.listRecoverable() ?? Promise.resolve(undefined),
    ])
    rawSessions = loaded[0]
    rawOperations = loaded[1]
    rawPendingIntents = loaded[2]
  } catch {
    // Callers must treat this as a hard stop before they begin new custody work.
    throw new Error('durable trade recovery storage is unavailable')
  }

  const sessionResults: DurableTradeSessionRecoveryResult[] = []
  const orphanResults: DurableTradeOrphanRecoveryResult[] = []
  const referencedOperationIds = new Set<string>()
  const sessions: DurableTradeSession[] = []
  const operations: DurableTradeProofOperationLink[] = []

  for (const [index, rawSession] of rawSessions.entries()) {
    if (!isObjectRecord(rawSession)) {
      sessionResults.push({
        kind: 'failed-closed',
        tradeId: invalidRecoveryRecordId('session', index),
        reason: 'invalid-session',
      })
      continue
    }
    const session = rawSession as unknown as DurableTradeSession
    if (validateDurableTradeSession(session) !== null) {
      sessionResults.push({
        kind: 'failed-closed',
        tradeId: typeof session.tradeId === 'string'
          ? session.tradeId
          : invalidRecoveryRecordId('session', index),
        reason: 'invalid-session',
      })
      continue
    }
    sessions.push(session)
  }
  for (const [index, rawOperation] of rawOperations.entries()) {
    if (!isObjectRecord(rawOperation)) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: invalidRecoveryRecordId('operation', index),
        reason: 'invalid-operation',
      })
      continue
    }
    const operation = rawOperation as unknown as DurableTradeProofOperationLink
    if (validateDurableProofOperationLink(operation) !== null) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: typeof operation.operationId === 'string'
          ? operation.operationId
          : invalidRecoveryRecordId('operation', index),
        reason: 'invalid-operation',
      })
      continue
    }
    operations.push(operation)
  }

  const sessionByTradeId = new Map(sessions.map((session) => [session.tradeId, session]))
  const operationById = new Map(operations.map((operation) => [operation.operationId, operation]))

  for (const storedSession of [...sessions].sort((left, right) =>
    left.tradeId.localeCompare(right.tradeId))) {
    let initialSession = storedSession
    const sessionError = validateDurableTradeSession(initialSession)
    if (sessionError) {
      sessionResults.push({
        kind: 'failed-closed',
        tradeId: initialSession.tradeId,
        reason: 'invalid-session',
      })
      continue
    }
    let cipherError: string | null
    try {
      cipherError = await verifyDurableTradeSessionCipherIntegrity(
        initialSession,
        ports.hashCiphertext,
      )
    } catch {
      cipherError = 'durable trade session cipher integrity check failed'
    }
    if (cipherError) {
      sessionResults.push({
        kind: 'failed-closed',
        tradeId: initialSession.tradeId,
        reason: 'invalid-cipher',
      })
      continue
    }
    let expectedRelinkFailure: DurableTradeSessionRecoveryResult | null = null
    for (const expected of initialSession.expectedProofOperations ?? []) {
      if (initialSession.proofOperations.some((operation) => operation.operationId === expected.operationId)) {
        continue
      }
      let operation = operationById.get(expected.operationId)
      if (!operation) {
        try {
          operation = await ports.operations.get(expected.operationId) ?? undefined
        } catch {
          expectedRelinkFailure = {
            kind: 'failed-closed',
            tradeId: initialSession.tradeId,
            reason: 'storage-unavailable',
          }
          break
        }
      }
      if (!operation) {
        expectedRelinkFailure = {
          kind: 'failed-closed',
          tradeId: initialSession.tradeId,
          reason: 'missing-proof-operation',
        }
        break
      }
      if (validateDurableProofOperationLink(operation) !== null ||
        !isOperationKey(operation.operationKey) ||
        !sameExpectedOperationIdentity(expected, operation)) {
        expectedRelinkFailure = {
          kind: 'failed-closed',
          tradeId: initialSession.tradeId,
          reason: 'foreign-proof-operation',
        }
        break
      }
      let relinked: DurableTradeSession | null
      try {
        relinked = await ports.sessions.compareAndSwap(
          initialSession.tradeId,
          initialSession.revision,
          relinkOperationIntoSession(initialSession, operation),
        )
      } catch {
        relinked = null
      }
      if (!relinked) {
        expectedRelinkFailure = {
          kind: 'failed-closed',
          tradeId: initialSession.tradeId,
          reason: 'session-cas-conflict',
        }
        break
      }
      initialSession = relinked
      sessionByTradeId.set(relinked.tradeId, relinked)
      operationById.set(operation.operationId, operation)
    }
    if (expectedRelinkFailure) {
      sessionResults.push(expectedRelinkFailure)
      continue
    }

    let activeSession = initialSession
    let blocked: DurableTradeSessionRecoveryResult | null = null
    for (const sessionLink of activeSession.proofOperations) {
      referencedOperationIds.add(sessionLink.operationId)
      let persistedOperation: DurableTradeProofOperationLink | null | undefined =
        operationById.get(sessionLink.operationId)
      if (!persistedOperation) {
        try {
          persistedOperation = await ports.operations.get(sessionLink.operationId)
        } catch {
          blocked = {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'storage-unavailable',
          }
          break
        }
      }
      if (!persistedOperation) {
        blocked = {
          kind: 'failed-closed',
          tradeId: activeSession.tradeId,
          reason: 'missing-proof-operation',
        }
        break
      }
      operationById.set(persistedOperation.operationId, persistedOperation)
      const operationError = validateDurableProofOperationLink(persistedOperation)
      if (operationError || !isOperationKey(persistedOperation.operationKey) ||
        !sameDurableOperationIdentity(sessionLink, persistedOperation)) {
        blocked = {
          kind: 'failed-closed',
          tradeId: activeSession.tradeId,
          reason: 'foreign-proof-operation',
        }
        break
      }

      const synchronized = await synchronizeSessionOperationState(
        ports,
        activeSession,
        persistedOperation,
      )
      if (!synchronized) {
        blocked = {
          kind: 'failed-closed',
          tradeId: activeSession.tradeId,
          reason: 'session-cas-conflict',
        }
        break
      }
      activeSession = synchronized

      const operationResult = await recoverDurableProofOperation(
        ports,
        activeSession,
        persistedOperation,
      )
      if (operationResult.kind === 'blocked') {
        blocked = operationResult.result
        break
      }
      activeSession = operationResult.session
      operationById.set(operationResult.operation.operationId, operationResult.operation)
    }

    if (blocked) {
      sessionResults.push(blocked)
      continue
    }

    if (activeSession.stage === 'awaiting-dependent-operation') {
      sessionResults.push({
        kind: 'awaiting-dependent-operation',
        tradeId: activeSession.tradeId,
        operationIds: (activeSession.plannedProofOperations ?? []).map(
          (plan) => plan.operationId,
        ),
      })
      continue
    }

    try {
      const replay = await resumeDurableTradeSession(activeSession, ports.transport)
      if (replay.kind === 'ready') {
        sessionResults.push({ kind: 'ready', tradeId: activeSession.tradeId })
      } else if (replay.kind === 'replayed') {
        sessionResults.push({
          kind: 'replayed',
          tradeId: activeSession.tradeId,
          sentMessageTypes: replay.sentMessageTypes,
        })
      } else {
        sessionResults.push({
          kind: 'failed-closed',
          tradeId: activeSession.tradeId,
          reason: 'invalid-session',
        })
      }
    } catch {
      // The exact outbox stays journalled. A later coordinator run may replay it.
      sessionResults.push({ kind: 'transport-ack-unknown', tradeId: activeSession.tradeId })
    }
  }

  for (const operation of [...operationById.values()].sort((left, right) =>
    left.operationId.localeCompare(right.operationId))) {
    if (referencedOperationIds.has(operation.operationId)) continue
    const operationError = validateDurableProofOperationLink(operation)
    if (operationError) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: operation.operationId,
        reason: 'invalid-operation',
      })
      continue
    }
    const session = sessionByTradeId.get(operation.tradeId) ??
      await ports.sessions.get(operation.tradeId)
    if (!session) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: operation.operationId,
        reason: 'missing-session',
      })
      continue
    }
    if (validateDurableTradeSession(session) !== null) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: operation.operationId,
        reason: 'invalid-session',
      })
      continue
    }
    const expected = session.expectedProofOperations?.find((candidate) =>
      candidate.operationId === operation.operationId)
    if (session.role !== operation.role || !expected ||
      !sameExpectedOperationIdentity(expected, operation) ||
      session.proofOperations.some((link) => link.operationId === operation.operationId)) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: operation.operationId,
        reason: 'invalid-operation',
      })
      continue
    }
    const relinked = relinkOperationIntoSession(session, operation)
    let updated: DurableTradeSession | null
    try {
      updated = await ports.sessions.compareAndSwap(
        session.tradeId,
        session.revision,
        relinked,
      )
    } catch {
      updated = null
    }
    if (!updated) {
      orphanResults.push({
        kind: 'failed-closed',
        operationId: operation.operationId,
        reason: 'session-cas-conflict',
      })
      continue
    }
    sessionByTradeId.set(updated.tradeId, updated)
    orphanResults.push({
      kind: 'relinked',
      operationId: operation.operationId,
      tradeId: operation.tradeId,
    })
  }

  const result: DurableTradeRecoveryResult = { sessions: sessionResults, orphans: orphanResults }
  if (rawPendingIntents) {
    result.pendingIntents = rawPendingIntents.map((intent, index) => ({
      tradeId: isObjectRecord(intent) && typeof intent.tradeId === 'string'
        ? intent.tradeId
        : invalidRecoveryRecordId('intent', index),
      kind: isObjectRecord(intent) &&
        validateDurableTradePendingIntent(intent as unknown as DurableTradePendingIntent) === null
        ? 'valid'
        : 'failed-closed',
    }))
  }
  return result
}

type DurableProofOperationRecoveryResult =
  | {
    kind: 'continued'
    session: DurableTradeSession
    operation: DurableTradeProofOperationLink
  }
  | { kind: 'blocked'; result: DurableTradeSessionRecoveryResult }

/** Returns undefined only when no adapter transaction port was supplied. */
async function advanceAtomicallyWhenAvailable(
  ports: DurableTradeRecoveryPorts,
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
  state: 'mint-submitted' | 'reconciled',
): Promise<{ session: DurableTradeSession; operation: DurableTradeProofOperationLink } | null | undefined> {
  if (!ports.atomicTransition) return undefined
  let advanced: { session: DurableTradeSession; operation: DurableTradeProofOperationLink } | null
  try {
    advanced = await ports.atomicTransition.advance({ session, operation, state })
  } catch {
    return null
  }
  if (!advanced ||
    validateDurableTradeSession(advanced.session) !== null ||
    validateDurableProofOperationLink(advanced.operation) !== null ||
    advanced.operation.state !== state ||
    !sameDurableOperationIdentity(operation, advanced.operation) ||
    !isExactDurableTradeSessionTransition(session, operation, state, advanced.session)) {
    return null
  }
  return advanced
}

/** Atomic adapters may only return the SDK reducer's exact next session. */
function isExactDurableTradeSessionTransition(
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
  state: 'mint-submitted' | 'reconciled',
  candidate: DurableTradeSession,
): boolean {
  try {
    const expected = reduceDurableTradeSession(
      session,
      state === 'mint-submitted'
        ? { kind: 'mint-submitted', operationId: operation.operationId }
        : {
            kind: 'proof-operation-reconciled',
            operationId: operation.operationId,
          },
    )
    return canonicalDurableSessionJson(candidate) ===
      canonicalDurableSessionJson(expected)
  } catch {
    return false
  }
}

function canonicalDurableSessionJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDurableSessionJson).join(',')}]`
  }
  if (isObjectRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalDurableSessionJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function recoverDurableProofOperation(
  ports: DurableTradeRecoveryPorts,
  session: DurableTradeSession,
  initialOperation: DurableTradeProofOperationLink,
): Promise<DurableProofOperationRecoveryResult> {
  let activeSession = session
  let operation = initialOperation

  if (operation.state === 'reconciled') {
    return { kind: 'continued', session: activeSession, operation }
  }

  let inspection: DurableTradeMintInspection
  try {
    inspection = await ports.mint.inspect(operation)
  } catch {
    return {
      kind: 'blocked',
      result: {
        kind: 'failed-closed',
        tradeId: activeSession.tradeId,
        reason: 'storage-unavailable',
      },
    }
  }
  if (!isObjectRecord(inspection) || !isDurableTradeMintRecoveryState(inspection.kind)) {
    return {
      kind: 'blocked',
      result: {
        kind: 'failed-closed',
        tradeId: activeSession.tradeId,
        reason: 'foreign-proof-operation',
      },
    }
  }
  const disposition = classifyDurableTradeRecoveryDisposition(inspection.kind)
  switch (disposition.action) {
    case 'resume-exact-prepared-operation': {
      const atomicallySubmitted = operation.state === 'prepared'
        ? await advanceAtomicallyWhenAvailable(
          ports, activeSession, operation, 'mint-submitted',
        )
        : undefined
      if (atomicallySubmitted === null) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      if (atomicallySubmitted) {
        activeSession = atomicallySubmitted.session
        operation = atomicallySubmitted.operation
      } else {
        const submitted = await advanceSessionToMintSubmitted(
          ports.sessions,
          activeSession,
          operation.operationId,
        )
        if (!submitted) {
          return {
            kind: 'blocked',
            result: {
              kind: 'failed-closed',
              tradeId: activeSession.tradeId,
              reason: 'session-cas-conflict',
            },
          }
        }
        activeSession = submitted
        if (operation.state === 'prepared') {
          try {
            operation = await ports.operations.markMintSubmitted(operation.operationId)
          } catch {
            return {
              kind: 'blocked',
              result: {
                kind: 'failed-closed',
                tradeId: activeSession.tradeId,
                reason: 'storage-unavailable',
              },
            }
          }
          if (validateDurableProofOperationLink(operation) !== null ||
            operation.state !== 'mint-submitted' ||
            !sameDurableOperationIdentity(initialOperation, operation)) {
            return {
              kind: 'blocked',
              result: {
                kind: 'failed-closed',
                tradeId: activeSession.tradeId,
                reason: 'foreign-proof-operation',
              },
            }
          }
        }
      }
      try {
        await ports.mint.resumeExactPreparedOperation(operation)
      } catch {
        // The write-ahead mint-submitted state is retained for NUT-07/NUT-09.
        return {
          kind: 'blocked',
          result: {
            kind: 'mint-response-unknown',
            tradeId: activeSession.tradeId,
            operationId: operation.operationId,
          },
        }
      }
      const atomicallyReconciled = await advanceAtomicallyWhenAvailable(
        ports, activeSession, operation, 'reconciled',
      )
      if (atomicallyReconciled === null) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      if (atomicallyReconciled) {
        return { kind: 'continued', session: atomicallyReconciled.session, operation: atomicallyReconciled.operation }
      }
      try {
        operation = await ports.operations.markReconciled(operation.operationId)
      } catch {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'storage-unavailable',
          },
        }
      }
      if (validateDurableProofOperationLink(operation) !== null ||
        operation.state !== 'reconciled' ||
        !sameDurableOperationIdentity(initialOperation, operation)) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'foreign-proof-operation',
          },
        }
      }
      const reconciled = await advanceSessionToReconciled(
        ports.sessions,
        activeSession,
        operation.operationId,
      )
      if (!reconciled) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      return { kind: 'continued', session: reconciled, operation }
    }
    case 'restore-exact-persisted-outputs': {
      try {
        await ports.mint.restoreExactPersistedOutputs(operation)
      } catch {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'storage-unavailable',
          },
        }
      }
      const atomicallyReconciled = await advanceAtomicallyWhenAvailable(
        ports, activeSession, operation, 'reconciled',
      )
      if (atomicallyReconciled === null) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      if (atomicallyReconciled) {
        return { kind: 'continued', session: atomicallyReconciled.session, operation: atomicallyReconciled.operation }
      }
      try {
        operation = await ports.operations.markReconciled(operation.operationId)
      } catch {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'storage-unavailable',
          },
        }
      }
      if (validateDurableProofOperationLink(operation) !== null ||
        operation.state !== 'reconciled' ||
        !sameDurableOperationIdentity(initialOperation, operation)) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'foreign-proof-operation',
          },
        }
      }
      const reconciled = await advanceSessionToReconciled(
        ports.sessions,
        activeSession,
        operation.operationId,
      )
      if (!reconciled) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      return { kind: 'continued', session: reconciled, operation }
    }
    case 'backoff': {
      const delayMs = durableRecoveryBackoffMs({
        session: activeSession,
        nowMs: ports.clock.nowMs(),
        retryAfterMs: inspection.retryAfterMs,
        random: ports.clock.random?.(),
      })
      if (delayMs === null || !ports.scheduleRetry) {
        return {
          kind: 'blocked',
          result: {
            kind: 'awaiting-refund-salvage',
            tradeId: activeSession.tradeId,
            operationId: operation.operationId,
          },
        }
      }
      try {
        await ports.scheduleRetry({
          tradeId: activeSession.tradeId,
          operationId: operation.operationId,
          delayMs,
          reason: disposition.reason,
        })
      } catch {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'storage-unavailable',
          },
        }
      }
      return {
        kind: 'blocked',
        result: {
          kind: 'retry-scheduled',
          tradeId: activeSession.tradeId,
          operationId: operation.operationId,
        },
      }
    }
    case 'await-refund-salvage':
      return {
        kind: 'blocked',
        result: {
          kind: 'awaiting-refund-salvage',
          tradeId: activeSession.tradeId,
          operationId: operation.operationId,
        },
    }
    case 'salvage-expired-refund': {
      if (!ports.mint.salvageExpiredRefund || !ports.mint.getRefundSalvageEvidence) {
        return {
          kind: 'blocked',
          result: {
            kind: 'awaiting-refund-salvage',
            tradeId: activeSession.tradeId,
            operationId: operation.operationId,
          },
        }
      }
      let evidence: (DurableRefundSalvageEvidence & { privateKeyHex: string }) | null
      try {
        evidence = await ports.mint.getRefundSalvageEvidence(operation)
      } catch {
        evidence = null
      }
      if (!evidence ||
        !isRefundEvidenceBoundToSession(evidence, activeSession, operation) ||
        validateDurableTradePrivateKeyBinding(
          evidence.privateKeyHex,
          evidence.localProtocolPubkey,
        ) !== null ||
        !canSalvageDurableRefund(evidence, Math.floor(ports.clock.nowMs() / 1_000))) {
        return {
          kind: 'blocked',
          result: {
            kind: 'awaiting-refund-salvage',
            tradeId: activeSession.tradeId,
            operationId: operation.operationId,
          },
        }
      }
      try {
        await ports.mint.salvageExpiredRefund(operation)
      } catch {
        return {
          kind: 'blocked',
          result: {
            kind: 'awaiting-refund-salvage',
            tradeId: activeSession.tradeId,
            operationId: operation.operationId,
          },
        }
      }
      const atomicallyReconciled = await advanceAtomicallyWhenAvailable(
        ports, activeSession, operation, 'reconciled',
      )
      if (atomicallyReconciled === null) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      if (atomicallyReconciled) {
        return { kind: 'continued', session: atomicallyReconciled.session, operation: atomicallyReconciled.operation }
      }
      try {
        operation = await ports.operations.markReconciled(operation.operationId)
      } catch {
        return {
          kind: 'blocked',
          result: {
            kind: 'awaiting-refund-salvage',
            tradeId: activeSession.tradeId,
            operationId: operation.operationId,
          },
        }
      }
      if (validateDurableProofOperationLink(operation) !== null ||
        operation.state !== 'reconciled' ||
        !sameDurableOperationIdentity(initialOperation, operation)) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'foreign-proof-operation',
          },
        }
      }
      const reconciled = await advanceSessionToReconciled(
        ports.sessions,
        activeSession,
        operation.operationId,
      )
      if (!reconciled) {
        return {
          kind: 'blocked',
          result: {
            kind: 'failed-closed',
            tradeId: activeSession.tradeId,
            reason: 'session-cas-conflict',
          },
        }
      }
      return { kind: 'continued', session: reconciled, operation }
    }
    case 'fail-closed':
      return {
        kind: 'blocked',
        result: {
          kind: 'failed-closed',
          tradeId: activeSession.tradeId,
          reason: 'foreign-proof-operation',
        },
      }
  }
}

/** Returns null after the local participant's own locktime; never schedules past it. */
export function durableRecoveryBackoffMs(input: {
  session: DurableTradeSession
  nowMs: number
  retryAfterMs?: number
  random?: number
}): number | null {
  if (!Number.isFinite(input.nowMs)) return null
  const deadlineMs = (input.session.role === 'seller'
    ? input.session.sellerLocktimeSecs
    : input.session.buyerLocktimeSecs) * 1_000
  const remainingMs = deadlineMs - input.nowMs
  if (remainingMs <= 0) return null
  const baseMs = input.retryAfterMs === undefined
    ? 1_000
    : Math.max(250, Math.floor(input.retryAfterMs))
  const boundedRandom = input.random === undefined
    ? 0
    : Math.min(1, Math.max(0, input.random))
  const jitteredMs = baseMs + Math.floor(baseMs * boundedRandom * 0.2)
  return Math.min(remainingMs, jitteredMs)
}

async function synchronizeSessionOperationState(
  ports: DurableTradeRecoveryPorts,
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
): Promise<DurableTradeSession | null> {
  const sessionOperation = requireOperation(session, operation.operationId)
  const sessionRank = operationStateRank(sessionOperation.state)
  const persistedRank = operationStateRank(operation.state)
  if (sessionRank === persistedRank) return session

  if (sessionRank > persistedRank) {
    // The session is the write-ahead record. The caller advances the operation
    // before it can make another mint request, never downgrading the session.
    return session
  }

  if (operation.state === 'prepared') return null

  let next: DurableTradeSession
  try {
    next = operation.state === 'mint-submitted'
      ? reduceDurableTradeSession(session, {
        kind: 'mint-submitted',
        operationId: operation.operationId,
      })
      : reduceDurableTradeSession(session, {
        kind: 'proof-operation-reconciled',
        operationId: operation.operationId,
      })
  } catch {
    return null
  }
  const atomic = await advanceAtomicallyWhenAvailable(
    ports,
    session,
    operation,
    operation.state,
  )
  if (atomic !== undefined) return atomic?.session ?? null
  try {
    return await ports.sessions.compareAndSwap(session.tradeId, session.revision, next)
  } catch {
    return null
  }
}

async function advanceSessionToMintSubmitted(
  repository: DurableTradeSessionRepository,
  session: DurableTradeSession,
  operationId: string,
): Promise<DurableTradeSession | null> {
  const operation = requireOperation(session, operationId)
  if (operation.state === 'mint-submitted') return session
  let next: DurableTradeSession
  try {
    next = reduceDurableTradeSession(session, { kind: 'mint-submitted', operationId })
  } catch {
    return null
  }
  try {
    return await repository.compareAndSwap(session.tradeId, session.revision, next)
  } catch {
    return null
  }
}

async function advanceSessionToReconciled(
  repository: DurableTradeSessionRepository,
  session: DurableTradeSession,
  operationId: string,
): Promise<DurableTradeSession | null> {
  const operation = requireOperation(session, operationId)
  if (operation.state === 'reconciled') return session
  let next: DurableTradeSession
  try {
    next = reduceDurableTradeSession(session, { kind: 'proof-operation-reconciled', operationId })
  } catch {
    return null
  }
  try {
    return await repository.compareAndSwap(session.tradeId, session.revision, next)
  } catch {
    return null
  }
}

function relinkOperationIntoSession(
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
): DurableTradeSession {
  const proofOperations = [...session.proofOperations, operation]
  const stage = proofOperations.some((item) => item.state === 'mint-submitted')
    ? 'mint-submitted'
    : proofOperations.every((item) => item.state === 'reconciled')
      ? (session.plannedProofOperations?.length ?? 0) > 0
        ? 'awaiting-dependent-operation'
        : 'reconciliation-complete'
      : 'proof-reserved'
  const next = {
    ...session,
    revision: session.revision + 1,
    stage,
    proofOperations,
  } satisfies DurableTradeSession
  if (validateDurableTradeSession(next) !== null) {
    throw new Error('cannot relink an operation into this durable trade session')
  }
  return next
}

function sameDurableOperationIdentity(
  left: DurableTradeProofOperationLink,
  right: DurableTradeProofOperationLink,
): boolean {
  return left.operationId === right.operationId &&
    left.operationKey === right.operationKey &&
    left.tradeId === right.tradeId &&
    left.role === right.role &&
    left.stage === right.stage &&
    left.kind === right.kind
}

function sameExpectedOperationIdentity(
  expected: DurableTradeExpectedProofOperation,
  operation: DurableTradeProofOperationLink,
): boolean {
  return expected.operationId === operation.operationId &&
    expected.operationKey === operation.operationKey &&
    expected.stage === operation.stage &&
    expected.kind === operation.kind
}

function isRefundEvidenceBoundToSession(
  evidence: DurableRefundSalvageEvidence,
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
): boolean {
  return isObjectRecord(evidence) && isObjectRecord(evidence.keyHandle) &&
    isObjectRecord(evidence.proofOperation) && evidence.tradeId === session.tradeId &&
    evidence.role === session.role &&
    evidence.localProtocolPubkey === session.localProtocolPubkey &&
    evidence.counterpartyProtocolPubkey === session.counterpartyProtocolPubkey &&
    evidence.mintUrl === session.mintUrl &&
    evidence.sellerLocktimeSecs === session.sellerLocktimeSecs &&
    evidence.buyerLocktimeSecs === session.buyerLocktimeSecs &&
    evidence.keyHandle.keyId === session.ephemeralKeyHandle.keyId &&
    evidence.proofOperation.operationId === operation.operationId
}

function operationStateRank(state: DurableProofOperationState): number {
  switch (state) {
    case 'prepared': return 0
    case 'mint-submitted': return 1
    case 'reconciled': return 2
  }
}

export function reduceDurableTradeSession(
  session: DurableTradeSession,
  event: DurableTradeSessionEvent,
): DurableTradeSession {
  const validationError = validateDurableTradeSession(session)
  if (validationError) throw new Error(validationError)

  switch (event.kind) {
    case 'dependent-operations-planned':
      return reduceDependentOperationsPlanned(session, event.active, event.plan)
    case 'dependent-operation-activated':
      return reduceDependentOperationActivated(session, event.operationId)
    case 'proof-operation-prepared':
      return reducePreparedOperation(session, event.operation)
    case 'mint-submitted':
      return reduceMintSubmitted(session, event.operationId)
    case 'proof-operation-reconciled':
      return reduceProofOperationReconciled(session, event.operationId)
    case 'received-cipher-recorded':
      return reduceCipherJournal(session, 'receivedCiphers', event)
    case 'outbound-cipher-journaled':
      return reduceCipherJournal(session, 'outboundCiphers', event)
  }
}

/**
 * Promotes the single dependency-satisfied planned operation. Keeping this
 * narrow wrapper public prevents adapters from reconstructing the dependent
 * transition (and accidentally activating a lock before its merge is
 * reconciled).
 */
export function activateDurableTradeDependentOperation(
  session: DurableTradeSession,
  operationId: string,
): DurableTradeSession {
  return reduceDurableTradeSession(session, {
    kind: 'dependent-operation-activated',
    operationId,
  })
}

export function isDurableTradeSessionPurgeEligible(
  session: DurableTradeSession,
): boolean {
  return session.stage === 'reconciliation-complete' &&
    session.proofOperations.every((operation) => operation.state === 'reconciled') &&
    (session.plannedProofOperations?.length ?? 0) === 0
}

/**
 * The coordinator must scan both durable stores after a crash. A session link
 * missing its ledger row and an operation missing its session link are both
 * repairable states, not reasons to forget locked material.
 */
export function scanDurableTradeRecoveryLinks(input: {
  sessions: readonly DurableTradeSession[]
  operations: readonly DurableTradeProofOperationLink[]
}): DurableTradeRecoveryScan {
  const sessionOperationIds = new Set<string>()
  for (const session of input.sessions) {
    for (const operation of session.proofOperations) {
      sessionOperationIds.add(operation.operationId)
    }
  }
  const operationIds = new Set(input.operations.map((operation) => operation.operationId))

  return {
    missingOperations: [...sessionOperationIds]
      .filter((operationId) => !operationIds.has(operationId))
      .sort(),
    orphanOperations: [...operationIds]
      .filter((operationId) => !sessionOperationIds.has(operationId))
      .sort(),
  }
}

/**
 * This path deliberately does not trust a corrupt session. It relies solely
 * on independently loaded proof-operation and key-handle bindings, and only
 * becomes available after the caller's own protocol locktime.
 */
export function canSalvageDurableRefund(
  evidence: DurableRefundSalvageEvidence,
  nowSecs: number,
): boolean {
  if (!isObjectRecord(evidence) || !isObjectRecord(evidence.proofOperation) ||
    !Number.isSafeInteger(nowSecs)) return false
  if (!isProtocolPubkey(evidence.localProtocolPubkey) ||
    !isProtocolPubkey(evidence.counterpartyProtocolPubkey) ||
    evidence.localProtocolPubkey === evidence.counterpartyProtocolPubkey ||
    !isMintUrl(evidence.mintUrl) ||
    !isLocktime(evidence.sellerLocktimeSecs) ||
    !isLocktime(evidence.buyerLocktimeSecs) ||
    evidence.sellerLocktimeSecs <= evidence.buyerLocktimeSecs) {
    return false
  }
  if (!isKeyHandleBoundToEvidence(evidence)) return false

  const operation = evidence.proofOperation
  if (
    operation.tradeId !== evidence.tradeId ||
    operation.role !== evidence.role ||
    operation.stage !== 'refund' ||
    operation.state !== 'mint-submitted' ||
    validateDurableProofOperationLink(operation) !== null
  ) {
    return false
  }

  const ownLocktimeSecs = evidence.role === 'seller'
    ? evidence.sellerLocktimeSecs
    : evidence.buyerLocktimeSecs
  return nowSecs >= ownLocktimeSecs
}

function reduceDependentOperationsPlanned(
  session: DurableTradeSession,
  active: DurableTradeExpectedProofOperation,
  plan: DurableTradePlannedProofOperation,
): DurableTradeSession {
  if (session.stage !== 'intent' || session.proofOperations.length !== 0 ||
    (session.expectedProofOperations?.length ?? 0) !== 0 ||
    (session.plannedProofOperations?.length ?? 0) !== 0) {
    throw new Error('dependent operations must be planned before custody work begins')
  }
  if (validateExpectedProofOperation(session, active) !== null ||
    validatePlannedProofOperation(session, plan) !== null ||
    active.kind !== 'condition-ctf-merge' ||
    active.stage !== 'proof-reservation' ||
    plan.kind !== 'cashu-atomic' ||
    plan.stage !== 'proof-reservation' ||
    plan.dependsOnOperationId !== active.operationId ||
    plan.context.mergeOperationKey !== active.operationKey) {
    throw new Error('dependent operation plan is invalid')
  }
  return {
    ...session,
    revision: session.revision + 1,
    expectedProofOperations: [active],
    plannedProofOperations: [plan],
  }
}

function reduceDependentOperationActivated(
  session: DurableTradeSession,
  operationId: string,
): DurableTradeSession {
  if (session.stage !== 'awaiting-dependent-operation') {
    throw new Error('dependent operation activation requires a waiting session')
  }
  if (
    session.plannedProofOperations?.length !== 1 ||
    session.expectedProofOperations?.length !== 1 ||
    session.proofOperations.length !== 1
  ) {
    throw new Error('dependent operation activation requires one merge and one planned lock')
  }
  const plan = session.plannedProofOperations?.find((item) => item.operationId === operationId)
  if (!plan) throw new Error('dependent operation plan is missing')
  const dependency = session.proofOperations.find(
    (item) => item.operationId === plan.dependsOnOperationId,
  )
  const expectedDependency = session.expectedProofOperations?.find(
    (item) => item.operationId === plan.dependsOnOperationId,
  )
  if (!dependency || dependency.state !== 'reconciled') {
    throw new Error('dependent operation activation requires a reconciled dependency')
  }
  if (
    expectedDependency?.kind !== 'condition-ctf-merge' ||
    expectedDependency.stage !== 'proof-reservation' ||
    plan.kind !== 'cashu-atomic' ||
    plan.stage !== 'proof-reservation' ||
    plan.context.mergeOperationKey !== expectedDependency.operationKey
  ) {
    throw new Error('dependent operation activation has invalid condition binding')
  }
  const expected: DurableTradeExpectedProofOperation = {
    operationId: plan.operationId,
    operationKey: plan.operationKey,
    stage: plan.stage,
    kind: plan.kind,
  }
  return {
    ...session,
    revision: session.revision + 1,
    stage: 'proof-reserved',
    expectedProofOperations: [...(session.expectedProofOperations ?? []), expected],
    plannedProofOperations: session.plannedProofOperations?.filter(
      (item) => item.operationId !== operationId,
    ),
  }
}

function reducePreparedOperation(
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
): DurableTradeSession {
  const operationError = validateDurableProofOperationLink(operation)
  if (operationError) throw new Error(operationError)
  const resumesAfterReconciliation =
    session.stage === 'reconciliation-complete' &&
    session.proofOperations.every((item) => item.state === 'reconciled') &&
    (session.plannedProofOperations?.length ?? 0) === 0
  if (
    session.stage !== 'intent' &&
    session.stage !== 'proof-reserved' &&
    !resumesAfterReconciliation
  ) {
    throw new Error('proof operations may only be prepared before mint submission')
  }
  if (operation.tradeId !== session.tradeId || operation.role !== session.role) {
    throw new Error('proof operation does not belong to durable trade session')
  }
  if (session.expectedProofOperations !== undefined && !session.expectedProofOperations.some((expected) =>
    sameExpectedOperationIdentity(expected, operation))) {
    throw new Error('proof operation is not bound by a session write-ahead identity')
  }
  if (session.proofOperations.some((item) => item.operationId === operation.operationId)) {
    throw new Error('durable trade session already contains this proof operation')
  }
  if (operation.state !== 'prepared') {
    throw new Error('proof operation must be prepared before session advance')
  }

  return {
    ...session,
    revision: session.revision + 1,
    stage: 'proof-reserved',
    proofOperations: [...session.proofOperations, operation],
  }
}

function reduceMintSubmitted(
  session: DurableTradeSession,
  operationId: string,
): DurableTradeSession {
  if (session.stage !== 'proof-reserved') {
    throw new Error('mint submission requires a proof-reserved session')
  }
  const operation = requireOperation(session, operationId)
  if (operation.state !== 'prepared') {
    throw new Error('mint submission requires a prepared proof operation')
  }
  return {
    ...session,
    revision: session.revision + 1,
    stage: 'mint-submitted',
    proofOperations: session.proofOperations.map((item) =>
      item.operationId === operationId ? { ...item, state: 'mint-submitted' } : item,
    ),
  }
}

function reduceProofOperationReconciled(
  session: DurableTradeSession,
  operationId: string,
): DurableTradeSession {
  if (session.stage !== 'mint-submitted' && session.stage !== 'proof-reserved') {
    throw new Error('proof reconciliation requires an active durable trade session')
  }
  const operation = requireOperation(session, operationId)
  if (operation.state === 'reconciled') return session

  const proofOperations = session.proofOperations.map((item) =>
    item.operationId === operationId ? { ...item, state: 'reconciled' as const } : item,
  )
  return {
    ...session,
    revision: session.revision + 1,
    stage: proofOperations.every((item) => item.state === 'reconciled')
      ? (session.plannedProofOperations?.length ?? 0) > 0
        ? 'awaiting-dependent-operation'
        : 'reconciliation-complete'
      : session.stage,
    proofOperations,
  }
}

function reduceCipherJournal(
  session: DurableTradeSession,
  journalName: 'receivedCiphers' | 'outboundCiphers',
  event: Extract<
    DurableTradeSessionEvent,
    { kind: 'received-cipher-recorded' | 'outbound-cipher-journaled' }
  >,
): DurableTradeSession {
  const journal = session[journalName]
  const existing = journal[event.messageType]
  if (existing) {
    if (existing.ciphertext === event.ciphertext && existing.sha256 === event.sha256) {
      return session
    }
    throw new Error('durable trade session already contains a different ciphertext')
  }
  const cipherError = validateCipher(event.ciphertext, event.sha256)
  if (cipherError) throw new Error(cipherError)
  return {
    ...session,
    revision: session.revision + 1,
    [journalName]: {
      ...journal,
      [event.messageType]: {
        ciphertext: event.ciphertext,
        sha256: event.sha256,
      },
    },
  }
}

function requireOperation(
  session: DurableTradeSession,
  operationId: string,
): DurableTradeProofOperationLink {
  const operation = session.proofOperations.find((item) => item.operationId === operationId)
  if (!operation) throw new Error('durable trade session does not contain this proof operation')
  return operation
}

export function validateDurableProofOperationLink(
  operation: DurableTradeProofOperationLink,
): string | null {
  if (!isObjectRecord(operation)) return 'durable proof operation is not an object'
  if (!isIdentifier(operation.tradeId)) return 'durable proof operation trade id is invalid'
  if (operation.role !== 'seller' && operation.role !== 'buyer') {
    return 'durable proof operation role is invalid'
  }
  if (!isProofOperationStage(operation.stage)) {
    return 'durable proof operation stage is invalid'
  }
  if (operation.kind !== undefined && !isProofOperationKind(operation.kind)) {
    return 'durable proof operation kind is invalid'
  }
  if (!isProofOperationState(operation.state)) {
    return 'durable proof operation state is invalid'
  }
  const expectedId = deriveDurableProofOperationId(
    operation.tradeId,
    operation.role,
    operation.stage,
    operation.operationKey,
    operation.kind,
  )
  if (operation.operationId !== expectedId) {
    return 'durable proof operation id is not bound to trade, role, and stage'
  }
  return null
}

function validateExpectedProofOperation(
  session: DurableTradeSession,
  expected: DurableTradeExpectedProofOperation,
): string | null {
  if (!isObjectRecord(expected) || !isOperationKey(expected.operationKey)) {
    return 'durable expected proof operation key is invalid'
  }
  if (!isProofOperationStage(expected.stage)) {
    return 'durable expected proof operation stage is invalid'
  }
  if (expected.kind !== undefined && !isProofOperationKind(expected.kind)) {
    return 'durable expected proof operation kind is invalid'
  }
  const operationId = deriveDurableProofOperationId(
    session.tradeId,
    session.role,
    expected.stage,
    expected.operationKey,
    expected.kind,
  )
  return expected.operationId === operationId
    ? null
    : 'durable expected proof operation id is not bound to session identity'
}

function validatePlannedProofOperation(
  session: DurableTradeSession,
  plan: DurableTradePlannedProofOperation,
): string | null {
  if (!isObjectRecord(plan) || !isOperationKey(plan.operationKey)) {
    return 'durable planned proof operation key is invalid'
  }
  if (!isProofOperationKind(plan.kind) || !isProofOperationStage(plan.stage)) {
    return 'durable planned proof operation kind or stage is invalid'
  }
  if (!isOperationKey(plan.dependsOnOperationId)) {
    return 'durable planned proof operation dependency is invalid'
  }
  const expectedId = deriveDurableProofOperationId(
    session.tradeId,
    session.role,
    plan.stage,
    plan.operationKey,
    plan.kind,
  )
  if (plan.operationId !== expectedId) {
    return 'durable planned proof operation id is not bound to semantic identity'
  }
  return validateDurableDependentOperationContext(session, plan)
}

/**
 * Structural validation for immutable buyer collateral context. Adapters must
 * additionally compare the commitments with their exact local ledger rows
 * before calling the activation reducer event.
 */
export function validateDurableDependentOperationContext(
  session: DurableTradeSession,
  plan: DurableTradePlannedProofOperation,
): string | null {
  const context = plan.context
  if (!isObjectRecord(context) || context.contextVersion !== 1 ||
    context.tradeId !== session.tradeId || context.role !== session.role ||
    context.localProtocolPubkey !== session.localProtocolPubkey ||
    context.counterpartyProtocolPubkey !== session.counterpartyProtocolPubkey ||
    context.mintUrl !== session.mintUrl ||
    context.sellerLocktimeSecs !== session.sellerLocktimeSecs ||
    context.buyerLocktimeSecs !== session.buyerLocktimeSecs ||
    !isIdentifier(context.conditionId) || !isIdentifier(context.ammScopeId) ||
    !isOperationKey(context.inventoryAccountId) ||
    !isIdentifier(context.baseAsset) || !isIdentifier(context.unit) ||
    !isCommitment(context.outcomeSetCommitment) ||
    !isCommitment(context.keysetCommitment) ||
    !isCommitment(context.feeCommitment) ||
    !isCommitment(context.mergeInputCommitment) ||
    !isCommitment(context.expectedOutputCommitment) ||
    !isOperationKey(context.mergeOperationKey) ||
    context.lockOperationKey !== plan.operationKey) {
    return 'durable planned proof operation context is invalid'
  }
  return null
}

function validateCipherJournal(
  journal: Partial<Record<SwapCipherMessageType, DurableTradeCipher>>,
): string | null {
  if (!isObjectRecord(journal)) return 'durable trade session cipher journal is invalid'
  for (const [messageType, cipher] of Object.entries(journal)) {
    if (!isSwapCipherMessageType(messageType) || !cipher) {
      return 'durable trade session cipher journal is invalid'
    }
    const cipherError = validateCipher(cipher.ciphertext, cipher.sha256)
    if (cipherError) return cipherError
  }
  return null
}

function validateCipher(ciphertext: string, sha256: string): string | null {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    return 'durable trade session ciphertext is invalid'
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return 'durable trade session ciphertext hash is invalid'
  }
  return null
}

function isKeyHandleBoundToSession(
  session: DurableTradeSession,
  handle: DurableEphemeralKeyHandle,
): boolean {
  return isObjectRecord(handle) &&
    typeof handle.keyId === 'string' && handle.keyId.length > 0 &&
    handle.tradeId === session.tradeId &&
    handle.role === session.role &&
    handle.localProtocolPubkey === session.localProtocolPubkey &&
    handle.counterpartyProtocolPubkey === session.counterpartyProtocolPubkey &&
    handle.mintUrl === session.mintUrl &&
    handle.sellerLocktimeSecs === session.sellerLocktimeSecs &&
    handle.buyerLocktimeSecs === session.buyerLocktimeSecs
}

function isKeyHandleBoundToEvidence(evidence: DurableRefundSalvageEvidence): boolean {
  return isObjectRecord(evidence.keyHandle) &&
    typeof evidence.keyHandle.keyId === 'string' && evidence.keyHandle.keyId.length > 0 &&
    evidence.keyHandle.tradeId === evidence.tradeId &&
    evidence.keyHandle.role === evidence.role &&
    evidence.keyHandle.localProtocolPubkey === evidence.localProtocolPubkey &&
    evidence.keyHandle.counterpartyProtocolPubkey === evidence.counterpartyProtocolPubkey &&
    evidence.keyHandle.mintUrl === evidence.mintUrl &&
    evidence.keyHandle.sellerLocktimeSecs === evidence.sellerLocktimeSecs &&
    evidence.keyHandle.buyerLocktimeSecs === evidence.buyerLocktimeSecs
}

function isIdentifier(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidRecoveryRecordId(kind: 'session' | 'operation' | 'intent', index: number): string {
  return `invalid-${kind}-${index}`
}

function isOperationKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function isProtocolPubkey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value) || /^0[23][a-f0-9]{64}$/.test(value)
}

function isMintUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isLocktime(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isSessionStage(value: string): value is DurableTradeSessionStage {
  return value === 'intent' ||
    value === 'proof-reserved' ||
    value === 'mint-submitted' ||
    value === 'awaiting-dependent-operation' ||
    value === 'reconciliation-complete'
}

function isProofOperationKind(value: unknown): value is DurableProofOperationKind {
  return value === 'cashu-atomic' || value === 'condition-ctf-merge'
}

function isCommitment(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isProofOperationStage(value: string): value is DurableProofOperationStage {
  return value === 'proof-reservation' ||
    value === 'mint-submission' ||
    value === 'claim' ||
    value === 'refund'
}

function isProofOperationState(value: string): value is DurableProofOperationState {
  return value === 'prepared' || value === 'mint-submitted' || value === 'reconciled'
}

function isDurableTradeMintRecoveryState(value: unknown): value is DurableTradeMintRecoveryState {
  return value === 'prepared-unspent' ||
    value === 'prepared-spent-restorable' ||
    value === 'pending-or-mixed' ||
    value === 'mint-response-unknown' ||
    value === 'rate-limited' ||
    value === 'reservation-race' ||
    value === 'engine-terminal' ||
    value === 'expired-refund-salvage' ||
    value === 'corrupt' ||
    value === 'foreign'
}
