import { getOrCreateOrderEphemeralKeypair } from './secrets.ts'

/**
 * The pending-pubkey transport boundary: durable key retention always happens
 * before the public key can cross the network boundary.
 */
export async function submitPersistedPendingPubkey(input: {
  tradeId: string
  orderId: string
  marketId: string
  submit: (publicKeyHex: string) => Promise<void>
}): Promise<string> {
  const keypair = await getOrCreateOrderEphemeralKeypair({
    tradeId: input.tradeId,
    orderId: input.orderId,
    marketId: input.marketId,
  })
  await input.submit(keypair.publicKeyHex)
  return keypair.publicKeyHex
}
