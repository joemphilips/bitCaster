import { Mint as CashuMint, type MintKeys } from '@cashu/cashu-ts'
import type {
  DurableCustodySemanticKind,
  DurableProofOperationFacts,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  durableCustodyProofOperationSemanticKind,
  resolveDurableCustodyProofOperationFacts,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import type { DurableTradeSession } from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { readStateScope, type PrepareProofOperationInput } from './state.ts'

export type DaemonMintKeyResolver = (
  mintUrl: string,
  keysetIds: readonly string[],
) => Promise<ReadonlyMap<string, MintKeys>>

export async function resolveDaemonProofOperationFacts(
  operation: PrepareProofOperationInput,
  resolveMintKeys: DaemonMintKeyResolver = fetchMintKeys,
): Promise<DurableProofOperationFacts> {
  return resolveDurableCustodyProofOperationFacts({
    operation,
    session: await readBoundTradeSession(operation),
    resolveMintKeys,
    requireDleq: false,
  })
}

export function daemonCustodySemanticKind(
  kind: PrepareProofOperationInput['kind'],
): DurableCustodySemanticKind {
  return durableCustodyProofOperationSemanticKind(kind)
}

async function readBoundTradeSession(
  operation: PrepareProofOperationInput,
): Promise<DurableTradeSession | null> {
  const link = operation.durableTradeRecovery
  if (link === undefined) return null
  const state = await readStateScope({ tradeIds: [link.tradeId] })
  const session = state?.durableTradeSessions[link.tradeId]
  if (session === undefined) {
    throw new Error('durable proof operation has no trade session')
  }
  return session
}

async function fetchMintKeys(
  mintUrl: string,
  keysetIds: readonly string[],
): Promise<ReadonlyMap<string, MintKeys>> {
  const mint = new CashuMint(mintUrl)
  const result = new Map<string, MintKeys>()
  for (const keysetId of keysetIds) {
    const response = await mint.getKeys(keysetId)
    const keyset = response.keysets.find((candidate) => candidate.id === keysetId)
    if (keyset === undefined) throw new Error('mint did not return an exact keyset')
    result.set(keysetId, keyset)
  }
  return result
}
