import type { PaymentRequestPayload } from "@cashu/cashu-ts";
import { deriveNostrKeyPair, subscribeNip17DMs } from "./nip17";
import { encodeToken } from "./cashu";
import {
  ingressReceiveCashuToken,
  parseInboundCashuUnit,
} from "./walletOps";
import { normalizeUrl } from "./url";
import { usePaymentRequestInbox } from "@/stores/paymentRequestInbox";
import { useWalletStore } from "@/stores/wallet";

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
 * - Redeemed payments are projected from their durable wallet operation. The
 *   payment-request inbox is keyed by `payload.id` so the Receive view can
 *   react even if the DM arrived before it was mounted.
 */

interface ListenerHandle {
  unsub: () => void;
  mnemonic: string;
  relayKey: string;
  startedAt: number;
  generation: number;
}

interface ListenerGeneration {
  generation: number;
  mnemonic: string;
}

let _current: ListenerHandle | null = null;
let _listenerGeneration = 0;
let _requestedMnemonic: string | null = null;
const _processedEvents = new Set<string>();
const _processingEvents = new Set<string>();
const MAX_PROCESSED = 5000;

async function handleIncomingDM(
  content: string,
  listener?: ListenerGeneration,
): Promise<void> {
  if (!isActiveListenerGeneration(listener)) return;
  let payload: PaymentRequestPayload;
  try {
    payload = JSON.parse(content) as PaymentRequestPayload;
  } catch {
    // Not a JSON payload — ignore silently (other NIP-17 traffic).
    return;
  }
  if (!payload?.proofs || !payload.mint) return;

  // Dedup on payload.id + first proof secret (payload itself has no id of
  // its own — use this composite to survive a retransmitted DM without
  // double-crediting). payload.id is the PaymentRequest id, optional.
  const dedupKey = `${payload.id ?? ""}|${payload.proofs[0]?.secret ?? ""}`;
  if (_processedEvents.has(dedupKey) || _processingEvents.has(dedupKey)) return;
  _processingEvents.add(dedupKey);

  try {
    if (!isActiveListenerGeneration(listener)) return;
    const normalizedMint = normalizeUrl(payload.mint);
    const unit = parseInboundCashuUnit(payload.unit);
    const token = encodeToken(payload.proofs, normalizedMint, unit);
    const received = await ingressReceiveCashuToken(token, "nip17", {
      mintUrl: normalizedMint,
    });
    if (!isActiveListenerGeneration(listener)) return;
    markProcessed(dedupKey);
    if (payload.id) {
      usePaymentRequestInbox
        .getState()
        .markReceived(payload.id, received.amountSats);
    }
  } catch {
    console.warn("[nip17-listener] payment payload redemption failed");
  } finally {
    _processingEvents.delete(dedupKey);
  }
}

function isActiveListenerGeneration(
  listener: ListenerGeneration | undefined,
): boolean {
  return (
    listener === undefined ||
    (listener.generation === _listenerGeneration &&
      listener.mnemonic === _requestedMnemonic &&
      listener.mnemonic === useWalletStore.getState().mnemonic)
  );
}

function markProcessed(dedupKey: string): void {
  _processedEvents.add(dedupKey);
  if (_processedEvents.size <= MAX_PROCESSED) return;
  const first = _processedEvents.values().next().value;
  if (first) _processedEvents.delete(first);
}

/**
 * Start (or restart) the listener. Idempotent — re-invoking with the same
 * mnemonic + relay set is a no-op. Re-invoking with a different set stops
 * the previous subscription before starting a new one.
 */
export async function startNip17Listener(
  mnemonic: string,
  relays: string[],
): Promise<void> {
  if (!mnemonic || useWalletStore.getState().mnemonic !== mnemonic) return;
  const relayKey = [...relays].sort().join("|");
  if (
    _current &&
    _current.mnemonic === mnemonic &&
    _current.relayKey === relayKey
  ) {
    return;
  }
  const listener = {
    generation: (_listenerGeneration += 1),
    mnemonic,
  };
  _requestedMnemonic = mnemonic;
  const previous = _current;
  _current = null;
  previous?.unsub();

  const kp = deriveNostrKeyPair(mnemonic);
  const unsub = await subscribeNip17DMs(
    kp.privateKeyHex,
    kp.publicKey,
    (content) => {
      if (!isActiveListenerGeneration(listener)) return;
      void handleIncomingDM(content, listener);
    },
    relays.length > 0 ? relays : undefined,
  );
  if (!isActiveListenerGeneration(listener)) {
    unsub();
    return;
  }
  _current = {
    unsub,
    mnemonic,
    relayKey,
    startedAt: Date.now(),
    generation: listener.generation,
  };
}

export function stopNip17Listener(): void {
  _listenerGeneration += 1;
  _requestedMnemonic = null;
  const previous = _current;
  _current = null;
  previous?.unsub();
}

/** Test helper — exposes the running listener handle. */
export function __getNip17ListenerHandleForTests(): ListenerHandle | null {
  return _current;
}

export function getNip17ListenerDiagnostics(): {
  active: boolean;
  relayKey: string | null;
  startedAt: number | null;
} {
  return {
    active: _current !== null,
    relayKey: _current?.relayKey ?? null,
    startedAt: _current?.startedAt ?? null,
  };
}

/** Test helper — reset dedup state between tests. */
export function __resetProcessedEventsForTests(): void {
  _processedEvents.clear();
  _processingEvents.clear();
}

/**
 * Test helper — directly run the content handler without any relay I/O.
 * Mirrors what `subscribeNip17DMs` would deliver on success.
 */
export function __handleIncomingDMForTests(content: string): Promise<void> {
  return handleIncomingDM(content);
}
