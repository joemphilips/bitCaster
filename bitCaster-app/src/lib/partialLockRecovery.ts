import { getEncodedToken, type Proof } from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { createP2PKWitness } from '@bitcaster/swap-protocol/p2pk'
import { hexToBytes } from '@bitcaster/swap-protocol/ecdh'
import {
  getReservedProofs,
  markProofOperationCompleted,
  prepareProofOperation,
  removeProofs,
  replaceProofs,
} from '@/stores/proof-db'
import { usePartialLockFailuresStore } from '@/stores/partialLockFailures'
import { usePendingTradesStore } from '@/stores/pendingTrades'
import { useWalletStore } from '@/stores/wallet'
import type { PartialLockHeldRecord } from '@bitcaster/client-sdk/swapFailure'
import { parseCashuProofUnit, type CashuProofUnit } from '@bitcaster/client-sdk/marketUnits'

const PARTIAL_LOCK_REFUND_MARGIN_SECS = 60

export async function sweepElapsedPartialLockFailures(): Promise<void> {
  const nowSecs = Math.floor(Date.now() / 1000)
  const records = usePartialLockFailuresStore
    .getState()
    .list()
    .filter(
      (record) =>
        record.refundLocktime + PARTIAL_LOCK_REFUND_MARGIN_SECS <= nowSecs,
    )
    .sort((a, b) => a.tradeId.localeCompare(b.tradeId))

  for (const record of records) {
    await sweepOnePartialLockFailure(record.tradeId).catch((error) => {
      console.warn('[swap.partial-lock-refund]', {
        tradeId: record.tradeId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}

async function sweepOnePartialLockFailure(tradeId: string): Promise<void> {
  const record = usePartialLockFailuresStore.getState().byTradeId[tradeId]
  if (!record) return
  if (!record.orderId || !record.mintUrl) return
  const mintUrl = record.mintUrl
  const pending = usePendingTradesStore.getState().get(record.orderId)
  if (!pending) return

  const locked = await getReservedProofs(tradeId)
  if (locked.length === 0) {
    usePartialLockFailuresStore.getState().remove(tradeId)
    return
  }
  const unit = unitForLockedProofs(locked)

  const operationId = `${tradeId}:partial-lock-refund`
  await prepareProofOperation({
    operationId,
    kind: 'swap-refund',
    mintUrl,
    inputs: locked,
    outputs: {},
    metadata: {
      tradeId,
      refundLocktime: record.refundLocktime,
      affectedKeysets: record.affectedKeysets,
      unit,
    },
  })

  try {
    const wallet = await useWalletStore.getState().getWallet(mintUrl)
    const refundKey = hexToBytes(pending.ephemeralPrivkey)
    const witnessed = locked.map((proof) => ({
      ...proof,
      witness: createP2PKWitness(
        refundKey,
        sha256(new TextEncoder().encode(proof.secret)),
      ),
    }))
    const fresh = await wallet.receive(
      getEncodedToken({
        mint: mintUrl,
        unit,
        proofs: witnessed as Proof[],
      }),
    )
    await replaceProofs(
      locked.map((proof) => proof.secret),
      fresh.map((proof) => ({
        ...proof,
        mintUrl,
        unit,
        ...metadataForRefundedProof(proof, record),
      })),
    )
    await markProofOperationCompleted(operationId, { refund: fresh })
    usePartialLockFailuresStore.getState().remove(tradeId)
  } catch (error) {
    if (!isAlreadySpentError(error)) throw error
    await removeProofs(locked.map((proof) => proof.secret))
    await markProofOperationCompleted(operationId, { alreadySpent: [] })
    usePartialLockFailuresStore.getState().remove(tradeId)
  }
}

function unitForLockedProofs(proofs: Array<Proof & { unit?: unknown }>): CashuProofUnit {
  const units = new Set<CashuProofUnit>()
  for (const proof of proofs) {
    const unit = typeof proof.unit === 'string' ? parseCashuProofUnit(proof.unit) : null
    if (!unit) {
      throw new Error(
        `Cannot refund partial lock without exact Cashu unit for keyset ${proof.id ?? '<missing>'}`,
      )
    }
    units.add(unit)
  }
  if (units.size !== 1) {
    throw new Error(`Cannot refund partial lock with mixed Cashu units: ${[...units].join(',')}`)
  }
  const unit = [...units][0]
  if (!unit) throw new Error('Cannot refund partial lock without locked proofs')
  return unit
}

function isAlreadySpentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already spent|proof.*spent|token.*spent|inputs?.*spent/i.test(message)
}

function metadataForRefundedProof(
  proof: Proof,
  record: PartialLockHeldRecord,
): {
  conditionId?: string
  outcomeCollection?: string
  marketId?: string
} {
  const source = record.outcomeByKeyset[proof.id ?? '']
  if (!source) {
    throw new Error(`No locked-proof metadata for keyset ${proof.id ?? '<missing>'}`)
  }
  return {
    conditionId: source.conditionId,
    outcomeCollection: source.outcomeCollection,
    marketId: source.marketId,
  }
}
