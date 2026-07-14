import type {
  DurableProofOperationKind,
  DurableProofOperationStage,
  DurableTradeProofOperationLink,
  DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import {
  validateDurableProofOperationLink,
  validateDurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import type { OrderEphemeralSecret } from './secrets.ts'
import type {
  LocalSwapRecord,
  ProofOperationKind,
  ProofOperationRecord,
} from './state.ts'

export interface DaemonTradeAuthorityFacts {
  tradeId: unknown
  sessionTradeId: unknown
  swapTradeId: unknown
  sessionRole: unknown
  swapRole: unknown
  sessionLocalProtocolPubkey: unknown
  retainedKeyPublicKey: unknown
  sessionCounterpartyProtocolPubkey: unknown
  swapCounterpartyPubkey: unknown
  sessionSellerLocktimeSecs: unknown
  swapSellerLocktimeSecs: unknown
  sessionBuyerLocktimeSecs: unknown
  swapBuyerLocktimeSecs: unknown
  sessionMintUrl: unknown
  profileMintUrl: unknown
  sessionKeyId: unknown
  retainedKeyId: unknown
  retainedKeyOrderId: unknown
  swapOrderId: unknown
  retainedKeyTradeId: unknown
  retainedKeyMarketId: unknown
  swapMarketId: unknown
}

/**
 * Cross-checks every independently persisted fact that authorizes daemon trade
 * custody or transport. Callers must not select proofs, journal an outbox row,
 * or send until these facts agree exactly.
 */
export function validateDaemonTradeAuthorityFacts(
  facts: DaemonTradeAuthorityFacts,
): string | null {
  const requiredText = [
    facts.tradeId,
    facts.sessionTradeId,
    facts.swapTradeId,
    facts.sessionRole,
    facts.swapRole,
    facts.sessionLocalProtocolPubkey,
    facts.retainedKeyPublicKey,
    facts.sessionCounterpartyProtocolPubkey,
    facts.swapCounterpartyPubkey,
    facts.sessionMintUrl,
    facts.profileMintUrl,
    facts.sessionKeyId,
    facts.retainedKeyId,
    facts.retainedKeyOrderId,
    facts.swapOrderId,
    facts.retainedKeyMarketId,
    facts.swapMarketId,
  ]
  if (
    requiredText.some(
      (value) => typeof value !== 'string' || value.length === 0,
    ) ||
    !isNonnegativeSafeInteger(facts.sessionSellerLocktimeSecs) ||
    !isNonnegativeSafeInteger(facts.swapSellerLocktimeSecs) ||
    !isNonnegativeSafeInteger(facts.sessionBuyerLocktimeSecs) ||
    !isNonnegativeSafeInteger(facts.swapBuyerLocktimeSecs)
  ) {
    return 'durable trade authority is incomplete'
  }
  if (facts.sessionRole !== 'seller' && facts.sessionRole !== 'buyer') {
    return 'durable trade session role is invalid'
  }
  if (facts.swapRole !== 'seller' && facts.swapRole !== 'buyer') {
    return 'durable trade swap role is invalid'
  }
  if (
    facts.tradeId !== facts.sessionTradeId ||
    facts.tradeId !== facts.swapTradeId
  ) {
    return 'durable trade identity does not match its swap and session'
  }
  if (
    facts.sessionRole !== facts.swapRole ||
    facts.sessionLocalProtocolPubkey !== facts.retainedKeyPublicKey ||
    facts.sessionCounterpartyProtocolPubkey !== facts.swapCounterpartyPubkey ||
    facts.sessionSellerLocktimeSecs !== facts.swapSellerLocktimeSecs ||
    facts.sessionBuyerLocktimeSecs !== facts.swapBuyerLocktimeSecs
  ) {
    return 'durable trade protocol facts do not match its swap and retained key'
  }
  if (facts.sessionMintUrl !== facts.profileMintUrl) {
    return 'durable trade mint does not match its profile'
  }
  if (
    facts.sessionKeyId !== facts.retainedKeyId ||
    facts.retainedKeyOrderId !== facts.swapOrderId ||
    facts.retainedKeyMarketId !== facts.swapMarketId
  ) {
    return 'durable trade retained key does not match its swap'
  }
  if (
    facts.retainedKeyTradeId !== null &&
    facts.retainedKeyTradeId !== undefined &&
    facts.retainedKeyTradeId !== facts.tradeId
  ) {
    return 'durable trade retained key belongs to another trade'
  }
  if (
    facts.retainedKeyId !== facts.retainedKeyOrderId &&
    facts.retainedKeyId !== facts.retainedKeyTradeId
  ) {
    return 'durable trade retained key identity is invalid'
  }
  return null
}

export function validateDaemonTradeAuthorityBinding(input: {
  tradeId: string
  session: DurableTradeSession
  swap: LocalSwapRecord
  retainedKeyId: string
  retainedKey: OrderEphemeralSecret
  profileMintUrl: string
}): string | null {
  const sessionError = validateDurableTradeSession(input.session)
  if (sessionError) return sessionError
  return validateDaemonTradeAuthorityFacts({
    tradeId: input.tradeId,
    sessionTradeId: input.session.tradeId,
    swapTradeId: input.swap.tradeId,
    sessionRole: input.session.role,
    swapRole: input.swap.role,
    sessionLocalProtocolPubkey: input.session.localProtocolPubkey,
    retainedKeyPublicKey: input.retainedKey.publicKeyHex,
    sessionCounterpartyProtocolPubkey: input.session.counterpartyProtocolPubkey,
    swapCounterpartyPubkey: input.swap.counterpartyPubkey,
    sessionSellerLocktimeSecs: input.session.sellerLocktimeSecs,
    swapSellerLocktimeSecs: input.swap.sellerLocktime,
    sessionBuyerLocktimeSecs: input.session.buyerLocktimeSecs,
    swapBuyerLocktimeSecs: input.swap.buyerLocktime,
    sessionMintUrl: input.session.mintUrl,
    profileMintUrl: input.profileMintUrl,
    sessionKeyId: input.session.ephemeralKeyHandle.keyId,
    retainedKeyId: input.retainedKeyId,
    retainedKeyOrderId: input.retainedKey.orderId,
    swapOrderId: input.swap.orderId,
    retainedKeyTradeId: input.retainedKey.tradeId,
    retainedKeyMarketId: input.retainedKey.marketId,
    swapMarketId: input.swap.marketId,
  })
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function durableBindingForDaemonProofOperation(
  kind: ProofOperationKind,
): { stage: DurableProofOperationStage; kind: DurableProofOperationKind } {
  switch (kind) {
    case 'swap-lock':
      return { stage: 'proof-reservation', kind: 'cashu-atomic' }
    case 'conditional-keyset-swap':
      return { stage: 'proof-reservation', kind: 'condition-ctf-merge' }
    case 'swap-claim':
      return { stage: 'claim', kind: 'cashu-atomic' }
    case 'swap-refund':
      return { stage: 'refund', kind: 'cashu-atomic' }
    case 'ctf-split':
    case 'ctf-merge':
    case 'ctf-consolidation':
    case 'ctf-redeem':
    case 'regular-split':
    case 'wallet-send':
    case 'proof-split':
      return { stage: 'mint-submission', kind: 'cashu-atomic' }
    case 'ctf-condition-registration':
      throw new Error('condition registration is not a trade-bound operation')
  }
}

/**
 * Binds SDK recovery identity to the exact daemon ledger record before a
 * mint inspection, resend, or state transition. A durable operation key is a
 * local routing key, never an authority to redirect work across trades.
 */
export function validateDaemonDurableOperationBinding(input: {
  session: DurableTradeSession
  record: ProofOperationRecord
  operation: DurableTradeProofOperationLink
  allowUnlinkedSessionOperation?: boolean
}): string | null {
  const sessionError = validateDurableTradeSession(input.session)
  if (sessionError) return sessionError
  const operationError = validateDurableProofOperationLink(input.operation)
  if (operationError) return operationError
  const ledgerLink = input.record.durableTradeRecovery
  if (
    !ledgerLink ||
    !sameDurableOperationIdentity(ledgerLink, input.operation)
  ) {
    return 'durable proof operation is not bound to its ledger record'
  }
  if (input.record.operationId !== input.operation.operationKey) {
    return 'durable proof operation key does not match its ledger record'
  }
  const prefix = `${input.operation.tradeId}/`
  if (
    !input.operation.operationKey?.startsWith(prefix) ||
    input.operation.operationKey.length <= prefix.length
  ) {
    return 'durable proof operation key is outside its trade namespace'
  }
  if (input.record.mintUrl !== input.session.mintUrl) {
    return 'durable proof operation mint does not match its session'
  }
  if (
    input.operation.tradeId !== input.session.tradeId ||
    input.operation.role !== input.session.role
  ) {
    return 'durable proof operation identity does not match its session'
  }
  const sessionLink = input.session.proofOperations.find(
    (candidate) => candidate.operationId === input.operation.operationId,
  )
  if (!sessionLink && !input.allowUnlinkedSessionOperation) {
    return 'durable proof operation is not bound to its session'
  }
  if (
    sessionLink &&
    !sameDurableOperationIdentity(sessionLink, input.operation)
  ) {
    return 'durable proof operation is not bound to its session'
  }
  const expected = durableBindingForDaemonProofOperation(input.record.kind)
  if (
    input.operation.stage !== expected.stage ||
    input.operation.kind !== expected.kind
  ) {
    return 'durable proof operation kind or stage does not match its ledger record'
  }
  return null
}

function sameDurableOperationIdentity(
  left: DurableTradeProofOperationLink,
  right: DurableTradeProofOperationLink,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.operationKey === right.operationKey &&
    left.tradeId === right.tradeId &&
    left.role === right.role &&
    left.stage === right.stage &&
    left.kind === right.kind
  )
}
