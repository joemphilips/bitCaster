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
import type { ProofOperationKind, ProofOperationRecord } from './state.ts'

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
  if (!ledgerLink || !sameDurableOperationIdentity(ledgerLink, input.operation)) {
    return 'durable proof operation is not bound to its ledger record'
  }
  if (input.record.operationId !== input.operation.operationKey) {
    return 'durable proof operation key does not match its ledger record'
  }
  const prefix = `${input.operation.tradeId}/`
  if (!input.operation.operationKey?.startsWith(prefix) ||
    input.operation.operationKey.length <= prefix.length) {
    return 'durable proof operation key is outside its trade namespace'
  }
  if (input.record.mintUrl !== input.session.mintUrl) {
    return 'durable proof operation mint does not match its session'
  }
  if (input.operation.tradeId !== input.session.tradeId ||
    input.operation.role !== input.session.role) {
    return 'durable proof operation identity does not match its session'
  }
  const sessionLink = input.session.proofOperations.find(
    (candidate) => candidate.operationId === input.operation.operationId,
  )
  if (!sessionLink && !input.allowUnlinkedSessionOperation) {
    return 'durable proof operation is not bound to its session'
  }
  if (sessionLink && !sameDurableOperationIdentity(sessionLink, input.operation)) {
    return 'durable proof operation is not bound to its session'
  }
  const expected = durableBindingForDaemonProofOperation(input.record.kind)
  if (input.operation.stage !== expected.stage || input.operation.kind !== expected.kind) {
    return 'durable proof operation kind or stage does not match its ledger record'
  }
  return null
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
