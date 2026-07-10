import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  validateDurableTradeSession,
  verifyDurableTradeSessionCipherIntegrity,
  type DurableTradeSession,
  type DurableTradeSessionRecord,
} from '@bitcaster/client-sdk/durableTradeRecovery'
import type { ActiveSwap } from './activeSwaps'
import { db, type SwapSessionRecord } from './proof-db'

export type GuiSwapSessionRecord = DurableTradeSessionRecord<ActiveSwap> & {
  tradeId: string
}

export const MAX_ACTIVE_GUI_SWAP_SESSIONS = 32

/**
 * Persist the GUI protocol payload with the shared SDK envelope before the
 * next irreversible protocol action. The browser record is client-local and
 * contains no Nostr identity.
 */
export async function persistGuiSwapSession(swap: ActiveSwap, mintUrl: string): Promise<void> {
  const session = await durableSessionFromActiveSwap(swap, mintUrl)
  if (!session) {
    throw new Error('Cannot persist a swap session before trade role and locktimes are known')
  }
  const record: GuiSwapSessionRecord = {
    tradeId: swap.tradeId,
    session,
    adapterState: swap,
    updatedAt: Date.now(),
  }
  const existing = await db.swapSessions.toArray()
  const alreadyPersisted = existing.some((item) => item.tradeId === swap.tradeId)
  const activeCount = existing.filter((item) => {
    if (!isGuiSwapSessionRecord(item)) return false
    return item.adapterState.step !== 'completed'
  }).length
  if (!alreadyPersisted && activeCount >= MAX_ACTIVE_GUI_SWAP_SESSIONS) {
    throw new Error('Durable swap session capacity is exhausted')
  }
  await db.swapSessions.put(record satisfies SwapSessionRecord)
}

export async function loadRecoverableGuiSwapSessions(): Promise<ActiveSwap[]> {
  const rows = await db.swapSessions.toArray()
  const recovered: ActiveSwap[] = []
  for (const row of rows) {
    if (!isGuiSwapSessionRecord(row)) continue
    if (row.adapterState.step === 'completed') continue
    if (validateDurableTradeSession(row.session) !== null) continue
    if (await verifyDurableTradeSessionCipherIntegrity(row.session, sha256Hex) !== null) continue
    if (!isAdapterStateBoundToSession(row.adapterState, row.session)) continue
    recovered.push(row.adapterState)
  }
  return recovered
}

export async function removeGuiSwapSession(tradeId: string): Promise<void> {
  await db.swapSessions.delete(tradeId)
}

async function durableSessionFromActiveSwap(
  swap: ActiveSwap,
  mintUrl: string,
): Promise<DurableTradeSession | null> {
  if (
    !swap.role ||
    !swap.counterpartyPubkey ||
    swap.sellerLocktime === null ||
    swap.buyerLocktime === null
  ) {
    return null
  }
  const receivedCiphers = await journalCiphers([
    ['adaptor-point', swap.role === 'buyer' ? swap.messages.adaptorPoint : undefined],
    ['locked-proofs-seller', swap.role === 'buyer' ? swap.messages.lockedProofsSeller : undefined],
    ['locked-proofs-buyer', swap.role === 'seller' ? swap.messages.lockedProofsBuyer : undefined],
  ])
  const outboundCiphers = await journalCiphers([
    ['adaptor-point', swap.role === 'seller' ? swap.sellerState?.adaptorPointCipher : undefined],
    ['locked-proofs-seller', swap.role === 'seller' ? swap.sellerState?.lockedProofsCipher : undefined],
    ['locked-proofs-buyer', swap.role === 'buyer' ? swap.buyerState?.lockedProofsCipher : undefined],
  ])
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: swap.tradeId,
    role: swap.role,
    localProtocolPubkey: swap.ephemeralPubkeyHex.toLowerCase(),
    counterpartyProtocolPubkey: swap.counterpartyPubkey.toLowerCase(),
    mintUrl,
    sellerLocktimeSecs: swap.sellerLocktime,
    buyerLocktimeSecs: swap.buyerLocktime,
    ephemeralKeyHandle: {
      keyId: `gui-swap-session:${swap.tradeId}`,
      tradeId: swap.tradeId,
      role: swap.role,
      localProtocolPubkey: swap.ephemeralPubkeyHex.toLowerCase(),
      counterpartyProtocolPubkey: swap.counterpartyPubkey.toLowerCase(),
      mintUrl,
      sellerLocktimeSecs: swap.sellerLocktime,
      buyerLocktimeSecs: swap.buyerLocktime,
    },
    stage: swap.step === 'awaiting-confirmation' ? 'reconciliation-complete' : 'intent',
    proofOperations: [],
    receivedCiphers,
    outboundCiphers,
  }
}

async function journalCiphers(
  input: Array<[keyof DurableTradeSession['receivedCiphers'], string | undefined]>,
): Promise<DurableTradeSession['receivedCiphers']> {
  const output: DurableTradeSession['receivedCiphers'] = {}
  for (const [messageType, ciphertext] of input) {
    if (!ciphertext) continue
    output[messageType] = { ciphertext, sha256: await sha256Hex(ciphertext) }
  }
  return output
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('')
}

function isGuiSwapSessionRecord(value: SwapSessionRecord): value is GuiSwapSessionRecord {
  return typeof value.tradeId === 'string' &&
    typeof value.updatedAt === 'number' &&
    typeof value.adapterState === 'object' &&
    value.adapterState !== null
}

function isAdapterStateBoundToSession(
  swap: ActiveSwap,
  session: DurableTradeSession,
): boolean {
  return swap.tradeId === session.tradeId &&
    swap.role === session.role &&
    swap.ephemeralPubkeyHex.toLowerCase() === session.localProtocolPubkey &&
    swap.counterpartyPubkey?.toLowerCase() === session.counterpartyProtocolPubkey &&
    swap.sellerLocktime === session.sellerLocktimeSecs &&
    swap.buyerLocktime === session.buyerLocktimeSecs
}
