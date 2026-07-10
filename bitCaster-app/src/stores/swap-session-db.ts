import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  resumeDurableTradeSession,
  validateDurableTradeSession,
  verifyDurableTradeSessionCipherIntegrity,
  type DurableTradeResumePorts,
  type DurableTradeResumeResult,
  type DurableTradeSession,
  type DurableTradeSessionRecord,
} from '@bitcaster/client-sdk/durableTradeRecovery'
import type { ActiveSwap } from './activeSwaps'
import {
  db,
  ensureDurableSwapStorage,
  markProofOperationCompleted,
  prepareProofOperation,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
  type SwapSessionRecord,
} from './proof-db'

export type GuiSwapSessionRecord = DurableTradeSessionRecord<ActiveSwap> & SwapSessionRecord

export const MAX_ACTIVE_GUI_SWAP_SESSIONS = 32
const FALLBACK_LEASE_MS = 120_000
const localLeaseOwnerId = globalThis.crypto?.randomUUID?.() ?? `gui-${Math.random().toString(36).slice(2)}`

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
  await ensureDurableSwapStorage()
  await db.transaction('rw', db.swapSessions, async () => {
    await putGuiSwapSessionInTransaction(swap, session)
  })
}

/** Atomically writes the mint-operation intent and its GUI recovery session. */
export async function prepareGuiProofOperationWithSession(
  input: PrepareProofOperationInput,
  swap: ActiveSwap,
): Promise<ProofOperationRecord> {
  const session = await durableSessionFromActiveSwap(swap, input.mintUrl)
  if (!session) throw new Error('Cannot prepare proof operation without a durable swap session')
  await ensureDurableSwapStorage()
  return db.transaction('rw', db.proofOperations, db.swapSessions, async () => {
    const operation = await prepareProofOperation(input)
    await putGuiSwapSessionInTransaction(swap, session)
    return operation
  })
}

/** Atomically records fresh mint outputs and the session reconciliation cursor. */
export async function completeGuiProofOperationWithSession(
  operationId: string,
  resultProofs: Record<string, import('@cashu/cashu-ts').Proof[]>,
  swap: ActiveSwap,
  mintUrl: string,
): Promise<ProofOperationRecord> {
  const session = await durableSessionFromActiveSwap(swap, mintUrl)
  if (!session) throw new Error('Cannot complete proof operation without a durable swap session')
  await ensureDurableSwapStorage()
  return db.transaction('rw', db.proofOperations, db.swapSessions, async () => {
    const operation = await markProofOperationCompleted(operationId, resultProofs)
    await putGuiSwapSessionInTransaction(swap, session)
    return operation
  })
}

async function putGuiSwapSessionInTransaction(
  swap: ActiveSwap,
  session: DurableTradeSession,
): Promise<void> {
    const existing = await db.swapSessions.toArray()
    const prior = existing.find((item) => item.tradeId === swap.tradeId)
    const activeCount = existing.filter((item) => {
      if (!isGuiSwapSessionRecord(item)) return false
      return item.adapterState.step !== 'completed'
    }).length
    if (!prior && activeCount >= MAX_ACTIVE_GUI_SWAP_SESSIONS) {
      throw new Error('Durable swap session capacity is exhausted')
    }
    const revision = isGuiSwapSessionRecord(prior) ? prior.session.revision + 1 : 0
    await db.swapSessions.put({
      tradeId: swap.tradeId,
      session: { ...session, revision },
      adapterState: structuredClone(swap),
      updatedAt: Date.now(),
      lease: isGuiSwapSessionRecord(prior) ? prior.lease : undefined,
    } satisfies SwapSessionRecord)
}

/**
 * One coordinator owns a trade while it can lock/mint/send. Web Locks covers
 * modern browsers; the durable lease keeps the same invariant for browsers
 * without that API and releases after a crash timeout.
 */
export async function withGuiSwapSessionOwnership<T>(
  tradeId: string,
  action: () => Promise<T>,
): Promise<T | null> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`bitcaster-swap:${tradeId}`, { mode: 'exclusive' }, action)
  }
  const acquired = await acquireFallbackLease(tradeId)
  if (!acquired) return null
  try {
    return await action()
  } finally {
    await releaseFallbackLease(tradeId)
  }
}

export async function loadRecoverableGuiSwapSessions(): Promise<ActiveSwap[]> {
  await ensureDurableSwapStorage()
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

/** Rejoins a persisted session and replays only its SDK-owned durable outbox. */
export async function resumeGuiSwapSession(
  tradeId: string,
  ports: DurableTradeResumePorts,
): Promise<DurableTradeResumeResult | null> {
  await ensureDurableSwapStorage()
  const row = await db.swapSessions.get(tradeId)
  if (!isGuiSwapSessionRecord(row)) return null
  const validationError = validateDurableTradeSession(row.session)
  if (validationError) return { kind: 'invalid-session', reason: validationError }
  const integrityError = await verifyDurableTradeSessionCipherIntegrity(row.session, sha256Hex)
  if (integrityError) return { kind: 'invalid-session', reason: integrityError }
  return resumeDurableTradeSession(row.session, ports)
}

export async function removeGuiSwapSession(tradeId: string): Promise<void> {
  await ensureDurableSwapStorage()
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

function isGuiSwapSessionRecord(value: unknown): value is GuiSwapSessionRecord {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as SwapSessionRecord).tradeId === 'string' &&
    typeof (value as SwapSessionRecord).updatedAt === 'number' &&
    typeof (value as SwapSessionRecord).adapterState === 'object' &&
    (value as SwapSessionRecord).adapterState !== null
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

async function acquireFallbackLease(tradeId: string): Promise<boolean> {
  return db.transaction('rw', db.swapSessions, async () => {
    const record = await db.swapSessions.get(tradeId)
    if (!isGuiSwapSessionRecord(record)) return false
    const now = Date.now()
    if (record.lease && record.lease.ownerId !== localLeaseOwnerId && record.lease.expiresAt > now) {
      return false
    }
    await db.swapSessions.put({
      ...record,
      lease: { ownerId: localLeaseOwnerId, expiresAt: now + FALLBACK_LEASE_MS },
    })
    return true
  })
}

async function releaseFallbackLease(tradeId: string): Promise<void> {
  await db.transaction('rw', db.swapSessions, async () => {
    const record = await db.swapSessions.get(tradeId)
    if (!isGuiSwapSessionRecord(record) || record.lease?.ownerId !== localLeaseOwnerId) return
    await db.swapSessions.put({ ...record, lease: undefined })
  })
}
