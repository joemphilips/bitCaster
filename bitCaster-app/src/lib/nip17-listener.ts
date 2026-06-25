import type { PaymentRequestPayload } from '@cashu/cashu-ts'
import { deriveNostrKeyPair, subscribeNip17DMs } from './nip17'
import { encodeToken } from './cashu'
import { ingressReceiveCashuToken } from './walletOps'
import { normalizeUrl } from './url'
import { normalizeMarketBaseAsset } from '@bitcaster/client-sdk/marketUnits'
import { addProofs, type StoredProof } from '@/stores/proof-db'
import { useActivityLogStore } from '@/stores/activity-log'
import { usePaymentRequestInbox } from '@/stores/paymentRequestInbox'

/**
 * Continuous NIP-17 listener. Runs for the lifetime of the tab once the
 * wallet has a mnemonic, not just while the "Receive via request" view is
 * mounted — that was the regression behind P5 item 5. Parity with
 * cashu.me (`src/stores/nostr.ts::subscribeToNip17DirectMessages`).
 *
 * - Single module-scope subscription; `start()` is idempotent and cheap to
 *   call on every wallet/relay change in App.tsx.
 * - Auto-adds the payer's mint if it isn't configured (cashu.me parity).
 * - Payload mint URL is normalized before matching / storage so it lines
 *   up with `activeMintUrl` in balance queries.
 * - Redeemed payments are recorded both in the activity log AND the
 *   payment-request inbox store keyed by `payload.id` so the Receive view
 *   can react even if the DM arrived before it was mounted.
 */

interface ListenerHandle {
  unsub: () => void
  mnemonic: string
  relayKey: string
  startedAt: number
}

let _current: ListenerHandle | null = null
const _processedEvents = new Set<string>()
const MAX_PROCESSED = 5000

async function handleIncomingDM(content: string): Promise<void> {
  let payload: PaymentRequestPayload
  try {
    payload = JSON.parse(content) as PaymentRequestPayload
  } catch {
    // Not a JSON payload — ignore silently (other NIP-17 traffic).
    return
  }
  if (!payload?.proofs || !payload.mint) return

  // Dedup on payload.id + first proof secret (payload itself has no id of
  // its own — use this composite to survive a retransmitted DM without
  // double-crediting). payload.id is the PaymentRequest id, optional.
  const dedupKey = `${payload.id ?? ''}|${payload.proofs[0]?.secret ?? ''}`
  if (_processedEvents.has(dedupKey)) return
  _processedEvents.add(dedupKey)
  if (_processedEvents.size > MAX_PROCESSED) {
    // Crude LRU — avoid unbounded growth on long-running tabs.
    const first = _processedEvents.values().next().value
    if (first) _processedEvents.delete(first)
  }

  const normalizedMint = normalizeUrl(payload.mint)

  try {
    const token = encodeToken(payload.proofs, normalizedMint)
    const received = await ingressReceiveCashuToken(token, 'nip17', {
      mintUrl: normalizedMint,
    })
    const stored: StoredProof[] = received.proofs.map((p) => ({
      ...p,
      mintUrl: normalizedMint,
      baseAsset: normalizeMarketBaseAsset(received.unit),
      unit: received.unit,
    }))
    await addProofs(stored)

    useActivityLogStore.getState().addActivity({
      type: 'deposit',
      amountSats: received.amountSats,
      status: 'completed',
    })

    if (payload.id) {
      usePaymentRequestInbox.getState().markReceived(payload.id, received.amountSats)
    }
  } catch (e) {
    console.warn(
      '[nip17-listener] failed to redeem payment payload:',
      (e as Error).message
    )
  }
}

/**
 * Start (or restart) the listener. Idempotent — re-invoking with the same
 * mnemonic + relay set is a no-op. Re-invoking with a different set stops
 * the previous subscription before starting a new one.
 */
export async function startNip17Listener(
  mnemonic: string,
  relays: string[]
): Promise<void> {
  if (!mnemonic) return
  const relayKey = [...relays].sort().join('|')
  if (
    _current &&
    _current.mnemonic === mnemonic &&
    _current.relayKey === relayKey
  ) {
    return
  }
  _current?.unsub()
  _current = null

  const kp = deriveNostrKeyPair(mnemonic)
  const unsub = await subscribeNip17DMs(
    kp.privateKeyHex,
    kp.publicKey,
    (content) => {
      void handleIncomingDM(content)
    },
    relays.length > 0 ? relays : undefined
  )
  _current = { unsub, mnemonic, relayKey, startedAt: Date.now() }
}

export function stopNip17Listener(): void {
  _current?.unsub()
  _current = null
}

/** Test helper — exposes the running listener handle. */
export function __getNip17ListenerHandleForTests(): ListenerHandle | null {
  return _current
}

export function getNip17ListenerDiagnostics(): {
  active: boolean
  relayKey: string | null
  startedAt: number | null
} {
  return {
    active: _current !== null,
    relayKey: _current?.relayKey ?? null,
    startedAt: _current?.startedAt ?? null,
  }
}

/** Test helper — reset dedup state between tests. */
export function __resetProcessedEventsForTests(): void {
  _processedEvents.clear()
}

/**
 * Test helper — directly run the content handler without any relay I/O.
 * Mirrors what `subscribeNip17DMs` would deliver on success.
 */
export function __handleIncomingDMForTests(content: string): Promise<void> {
  return handleIncomingDM(content)
}
