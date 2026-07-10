import {
  isSwapCipherMessageType,
  type SwapCipherMessageType,
  type SwapRole,
} from './tradeSession.ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'

export const DURABLE_TRADE_SESSION_SCHEMA_VERSION = 1 as const

const DURABLE_OUTBOUND_MESSAGE_ORDER: readonly SwapCipherMessageType[] = [
  'adaptor-point',
  'locked-proofs-seller',
  'locked-proofs-buyer',
]

export type DurableTradeSessionStage =
  | 'intent'
  | 'proof-reserved'
  | 'mint-submitted'
  | 'reconciliation-complete'

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
  tradeId: string
  role: SwapRole
  stage: DurableProofOperationStage
  state: DurableProofOperationState
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
  prepare(operation: DurableTradeProofOperationLink): Promise<DurableTradeProofOperationLink>
  markMintSubmitted(operationId: string): Promise<DurableTradeProofOperationLink>
  markReconciled(operationId: string): Promise<DurableTradeProofOperationLink>
}

export type DurableTradeSessionEvent =
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
): string {
  if (!isIdentifier(tradeId)) throw new Error('trade id must be a durable identifier')
  if (operationKey !== undefined && !isOperationKey(operationKey)) {
    throw new Error('durable proof operation key is invalid')
  }
  const suffix = operationKey === undefined ? '' : `:${encodeURIComponent(operationKey)}`
  return `trade-recovery:${tradeId}:${role}:${stage}${suffix}`
}

/** Builds the SDK-owned identity stored beside a client proof operation. */
export function createDurableTradeProofOperationLink(input: {
  tradeId: string
  role: SwapRole
  stage: DurableProofOperationStage
  state: DurableProofOperationState
  operationKey?: string
}): DurableTradeProofOperationLink {
  const operation: DurableTradeProofOperationLink = {
    operationId: deriveDurableProofOperationId(
      input.tradeId,
      input.role,
      input.stage,
      input.operationKey,
    ),
    operationKey: input.operationKey,
    tradeId: input.tradeId,
    role: input.role,
    stage: input.stage,
    state: input.state,
  }
  const error = validateDurableProofOperationLink(operation)
  if (error) throw new Error(error)
  return operation
}

export function validateDurableTradeSession(
  session: DurableTradeSession,
): string | null {
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
    operationIds.add(operation.operationId)
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
    session.proofOperations.some((operation) => operation.state !== 'reconciled')
  ) {
    return 'durable trade session completed reconciliation has pending proof operations'
  }

  return validateCipherJournal(session.receivedCiphers) ??
    validateCipherJournal(session.outboundCiphers)
}

export function validateDurableTradePendingIntent(
  intent: DurableTradePendingIntent,
): string | null {
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

export function reduceDurableTradeSession(
  session: DurableTradeSession,
  event: DurableTradeSessionEvent,
): DurableTradeSession {
  const validationError = validateDurableTradeSession(session)
  if (validationError) throw new Error(validationError)

  switch (event.kind) {
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

export function isDurableTradeSessionPurgeEligible(
  session: DurableTradeSession,
): boolean {
  return session.stage === 'reconciliation-complete' &&
    session.proofOperations.every((operation) => operation.state === 'reconciled')
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
  if (!Number.isSafeInteger(nowSecs)) return false
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

function reducePreparedOperation(
  session: DurableTradeSession,
  operation: DurableTradeProofOperationLink,
): DurableTradeSession {
  const operationError = validateDurableProofOperationLink(operation)
  if (operationError) throw new Error(operationError)
  if (session.stage !== 'intent' && session.stage !== 'proof-reserved') {
    throw new Error('proof operations may only be prepared before mint submission')
  }
  if (operation.tradeId !== session.tradeId || operation.role !== session.role) {
    throw new Error('proof operation does not belong to durable trade session')
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
      ? 'reconciliation-complete'
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

function validateDurableProofOperationLink(
  operation: DurableTradeProofOperationLink,
): string | null {
  if (!isIdentifier(operation.tradeId)) return 'durable proof operation trade id is invalid'
  if (operation.role !== 'seller' && operation.role !== 'buyer') {
    return 'durable proof operation role is invalid'
  }
  if (!isProofOperationStage(operation.stage)) {
    return 'durable proof operation stage is invalid'
  }
  if (!isProofOperationState(operation.state)) {
    return 'durable proof operation state is invalid'
  }
  const expectedId = deriveDurableProofOperationId(
    operation.tradeId,
    operation.role,
    operation.stage,
    operation.operationKey,
  )
  if (operation.operationId !== expectedId) {
    return 'durable proof operation id is not bound to trade, role, and stage'
  }
  return null
}

function validateCipherJournal(
  journal: Partial<Record<SwapCipherMessageType, DurableTradeCipher>>,
): string | null {
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
  return handle.keyId.length > 0 &&
    handle.tradeId === session.tradeId &&
    handle.role === session.role &&
    handle.localProtocolPubkey === session.localProtocolPubkey &&
    handle.counterpartyProtocolPubkey === session.counterpartyProtocolPubkey &&
    handle.mintUrl === session.mintUrl &&
    handle.sellerLocktimeSecs === session.sellerLocktimeSecs &&
    handle.buyerLocktimeSecs === session.buyerLocktimeSecs
}

function isKeyHandleBoundToEvidence(evidence: DurableRefundSalvageEvidence): boolean {
  return evidence.keyHandle.keyId.length > 0 &&
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

function isOperationKey(value: string): boolean {
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
    value === 'reconciliation-complete'
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
