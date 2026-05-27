import { getEncodedToken, type Proof } from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { createP2PKWitness } from '@bitcaster/swap-protocol/p2pk'
import { hexToBytes } from '@bitcaster/swap-protocol/ecdh'
import {
  addProofs,
  getReservedProofs,
  markProofOperationCompleted,
  prepareProofOperation,
  removeProofs,
} from '@/stores/proof-db'
import { usePartialLockFailuresStore } from '@/stores/partialLockFailures'
import { usePendingTradesStore } from '@/stores/pendingTrades'
import { useWalletStore } from '@/stores/wallet'

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
  const pending = usePendingTradesStore.getState().get(record.orderId)
  if (!pending) return

  const locked = await getReservedProofs(tradeId)
  if (locked.length === 0) {
    usePartialLockFailuresStore.getState().remove(tradeId)
    return
  }

  const operationId = `${tradeId}:partial-lock-refund`
  await prepareProofOperation({
    operationId,
    kind: 'swap-refund',
    mintUrl: record.mintUrl,
    inputs: locked,
    outputs: {},
    metadata: {
      tradeId,
      refundLocktime: record.refundLocktime,
      affectedKeysets: record.affectedKeysets,
    },
  })

  try {
    const wallet = await useWalletStore.getState().getWallet(record.mintUrl)
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
        mint: record.mintUrl,
        unit: 'sat',
        proofs: witnessed as Proof[],
      }),
    )
    await addProofs(
      fresh.map((proof) => ({
        ...proof,
        mintUrl: record.mintUrl,
        ...metadataForRefundedProof(proof, locked),
      })),
    )
    await removeProofs(locked.map((proof) => proof.secret))
    await markProofOperationCompleted(operationId, { refund: fresh })
    usePartialLockFailuresStore.getState().remove(tradeId)
  } catch (error) {
    if (!isAlreadySpentError(error)) throw error
    await removeProofs(locked.map((proof) => proof.secret))
    usePartialLockFailuresStore.getState().remove(tradeId)
  }
}

function isAlreadySpentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already spent|proof.*spent|token.*spent|inputs?.*spent/i.test(message)
}

function metadataForRefundedProof(
  proof: Proof,
  locked: Awaited<ReturnType<typeof getReservedProofs>>,
): {
  conditionId?: string
  outcomeCollection?: string
  marketId?: string
} {
  const source = locked.find((row) => row.id === proof.id)
  if (!source) {
    throw new Error(`No locked-proof metadata for keyset ${proof.id ?? '<missing>'}`)
  }
  return {
    conditionId: source.conditionId,
    outcomeCollection: source.outcomeCollection,
    marketId: source.marketId,
  }
}
