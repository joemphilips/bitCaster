import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Proof } from '@cashu/cashu-ts'
import type { ActivityItem, ClaimRecoveryDetails } from '@bitcaster-market/client-sdk/activityLog'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { NativeActivitySqlite } from './nativeActivitySqlite.ts'

/** The successful source owner calls this inside its custody transaction. */
export function writeNativeCompletedActivity(
  database: DatabaseSync,
  input: {
    readonly scopeId: string
    readonly sourceKind: string
    readonly sourceId: string
    readonly type: 'deposit' | 'withdrawal' | 'payout_claimed'
    readonly amountMsat: number
    readonly completedAtMs: number
    readonly txId?: string | null
    readonly lightningInvoice?: string | null
    readonly claimRecovery?: ClaimRecoveryDetails
  },
): void {
  const walletId = input.scopeId.slice('custody:wallet:'.length)
  if (input.scopeId !== `custody:wallet:${walletId}` || !/^[0-9a-f]{64}$/.test(walletId))
    throw new Error('native Activity source wallet is invalid')
  const sourceId = `${input.sourceKind}:${boundedSourceIdentity(input.sourceId)}`
  const id = `${input.type}:${walletId}:${sourceId}`
  const previous = database
    .prepare(
      `SELECT item_json AS itemJson FROM daemon_activity_feed
       WHERE scope_id = ? AND activity_id = ? AND origin = 'native' AND source_id = ?`,
    )
    .get(input.scopeId, id, sourceId) as { readonly itemJson: string } | undefined
  const item: ActivityItem = {
    id,
    walletId,
    type: input.type,
    amountSubunits: input.amountMsat,
    baseAsset: 'sat',
    date:
      previous === undefined
        ? new Date(input.completedAtMs).toISOString()
        : (JSON.parse(previous.itemJson) as ActivityItem).date,
    status: 'completed',
    txId: boundedOptionalText(input.txId, 1_024),
    lightningInvoice: boundedOptionalText(input.lightningInvoice, 4_096),
    ...(input.claimRecovery === undefined ? {} : { claimRecovery: input.claimRecovery }),
  }
  new NativeActivitySqlite(database).upsert({ walletId, item, origin: 'native', sourceId })
}

export function creditedProofAmountMsat(
  proofs: readonly Pick<Proof, 'amount'>[],
  unit: 'sat' | 'msat',
): number {
  const scale = activityUnitScale(unit)
  const amount = proofs.reduce(
    (sum, proof) => sum + BigInt(amountToNumber(proof.amount)) * scale,
    0n,
  )
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('native Activity credited amount is invalid')
  return Number(amount)
}

function boundedOptionalText(value: string | null | undefined, limit: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(JSON.stringify(value)) <= limit
    ? value
    : null
}

function boundedSourceIdentity(value: string): string {
  if (value.length === 0) throw new Error('native Activity source identity is missing')
  return Buffer.byteLength(value) <= 512
    ? value
    : `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function activityUnitScale(unit: 'sat' | 'msat'): bigint {
  switch (unit) {
    case 'sat':
      return 1_000n
    case 'msat':
      return 1n
  }
  const unexpected: never = unit
  throw new Error(`native Activity unit is invalid: ${unexpected}`)
}

/** Custody admission supplies the exact new set. Activity is never admission authority. */
export function writeNativeRecoveredClaimActivity(
  database: DatabaseSync,
  input: {
    readonly scopeId: string
    readonly targetOperationId: string
    readonly admittedProofIds: readonly string[]
    readonly amountMsat: number
    readonly completedAtMs: number
  },
): void {
  const sourceId = createHash('sha256')
    .update(JSON.stringify([input.targetOperationId, [...input.admittedProofIds].sort()]))
    .digest('hex')
  writeNativeCompletedActivity(database, {
    scopeId: input.scopeId,
    sourceKind: 'retained-claim-payout',
    sourceId,
    type: 'payout_claimed',
    amountMsat: input.amountMsat,
    completedAtMs: input.completedAtMs,
    txId: input.targetOperationId,
    claimRecovery: {
      kind: 'retained-claim-payout',
      originalOperationId: input.targetOperationId,
      originalStatus: 'Failed',
      originalFailureCode: 13015,
    },
  })
}
