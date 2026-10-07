import { isCanonicalActivityWalletId, type ActivityItem } from './activityLog.ts'
import { deriveDurableCustodyArtifactFingerprint } from './durableCustody.ts'
import {
  decodeDurableOutgoingCashuTransfer,
  type DurableOutgoingCashuTransfer,
} from './durableOutgoingCashuTransfer.ts'

/** Map retained bearer authority without treating presentation or reclaim as payment. */
export function mapOutgoingCashuWithdrawalActivity(input: {
  readonly walletId: string
  readonly transfer: DurableOutgoingCashuTransfer
  readonly createdAtMs: number
}): ActivityItem | null {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  switch (transfer.deliveryIntent.policy) {
    case 'durable-recipient-ack':
      return null
    case 'bearer-spend-classification':
      break
    default:
      return assertUnknownActivityVariant(transfer.deliveryIntent)
  }
  if (
    !isCanonicalActivityWalletId(input.walletId) ||
    transfer.walletScopeId !== `custody:wallet:${input.walletId}` ||
    transfer.unit !== 'msat' ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0 ||
    !Number.isFinite(new Date(input.createdAtMs).getTime())
  ) {
    throw new Error('Cashu withdrawal Activity context is invalid')
  }
  const disposition = outgoingCashuActivityDisposition(transfer)
  const identity = deriveDurableCustodyArtifactFingerprint([input.walletId, transfer.transferId])
  return {
    id: `cashu-withdrawal:${identity}`,
    walletId: input.walletId,
    type: 'withdrawal',
    baseAsset: 'sat',
    ...disposition,
    date: new Date(input.createdAtMs).toISOString(),
    txId:
      new TextEncoder().encode(transfer.transferId).byteLength <= 512 ? transfer.transferId : null,
    lightningInvoice: null,
  }
}

function outgoingCashuActivityDisposition(
  transfer: DurableOutgoingCashuTransfer,
): Pick<ActivityItem, 'amountSubunits' | 'status' | 'failureReason'> {
  const principal = BigInt(transfer.requestedAmount)
  switch (transfer.deliveryState) {
    case 'prepared':
    case 'delivery-pending':
    case 'bearer-partial':
    case 'reclaim-prepared':
      return { amountSubunits: activityPrincipal(principal), status: 'pending' }
    case 'bearer-spent':
      return { amountSubunits: activityPrincipal(principal), status: 'completed' }
    case 'reclaimed': {
      if (transfer.reclaim === null) throw new Error('Cashu withdrawal reclaim is missing')
      // Reclaim fees reduce returned value. They are not recipient payment principal.
      const reclaimedPrincipal = transfer.reclaim.proofs.reduce(
        (sum, proof) => sum + BigInt(proof.amount),
        0n,
      )
      const amountSubunits = activityPrincipal(principal - reclaimedPrincipal)
      return amountSubunits === 0
        ? { amountSubunits, status: 'Failed', failureReason: 'Cancelled; funds reclaimed' }
        : { amountSubunits, status: 'completed' }
    }
    case 'recipient-acknowledged':
      throw new Error('Cashu bearer withdrawal has recipient acknowledgement')
    default:
      return assertUnknownActivityVariant(transfer.deliveryState)
  }
}

function activityPrincipal(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Cashu withdrawal Activity amount is invalid')
  }
  return Number(value)
}

function assertUnknownActivityVariant(_value: never): never {
  throw new Error('Cashu withdrawal Activity variant is invalid')
}
