import { readPendingCashuPaymentRequestMessage } from "@bitcaster/client-sdk/paymentRequest";
import { normalizeNostrRelayUrls } from "@bitcaster/client-sdk/nostrRelays";
import { deriveNostrKeyPair, subscribeNip17DMs } from "./nip17";
import { encodeToken } from "./cashu";
import { ingressReceiveCashuToken } from "./walletOps";
import { useActivityLogStore } from "@/stores/activity-log";
import { usePaymentRequestInbox } from "@/stores/paymentRequestInbox";
import { useWalletStore } from "@/stores/wallet";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";

/**
 * Continuous NIP-17 listener. Runs for the lifetime of the tab once the
 * wallet has a mnemonic, not just while the "Receive via request" view is
 * mounted — that was the regression behind P5 item 5. Parity with
 * cashu.me (`src/stores/nostr.ts::subscribeToNip17DirectMessages`).
 *
 * - Single module-scope subscription; `start()` is idempotent and cheap to
 *   call on every wallet/relay change in App.tsx.
 * - Accepts only the exact mint bound to an outstanding local request before
 *   any mint network access; unsolicited DMs are ignored.
 * - Payload mint URL is normalized before matching / storage so it lines
 *   up with `activeMintUrl` in balance queries.
 * - Redeemed payments are recorded both in the activity log AND the
 *   payment-request inbox store keyed by `payload.id` so the Receive view
 *   can react even if the DM arrived before it was mounted.
 */

interface ListenerHandle {
  unsub: () => void;
  mnemonic: string;
  scopeId: string;
  relayKey: string;
  startedAt: number;
}

interface ListenerStart {
  generation: number;
  mnemonic: string;
  relayKey: string;
  promise: Promise<void>;
  controller: AbortController;
}

let _current: ListenerHandle | null = null;
let _starting: ListenerStart | null = null;
let _generation = 0;
const _processedEvents = new Set<string>();
const _processingEvents = new Set<string>();
const MAX_PROCESSED = 5000;

function isCurrentWalletScope(scopeId: string): boolean {
  const currentMnemonic = useWalletStore.getState().mnemonic;
  return (
    browserWalletScopeIdFromMnemonic(currentMnemonic) === scopeId &&
    activeBrowserWalletScopeId() === scopeId
  );
}

function isCurrentListenerContext(generation: number, scopeId: string): boolean {
  return generation === _generation && isCurrentWalletScope(scopeId);
}

async function handleIncomingDM(
  content: string,
  generation: number,
  scopeId: string,
  walletId: string,
): Promise<void> {
  if (!isCurrentListenerContext(generation, scopeId)) return;

  const message = readPendingCashuPaymentRequestMessage({
    content,
    walletScopeId: scopeId,
    readPending: (id) => usePaymentRequestInbox.getState().pending[id],
  });
  if (message === null) return;
  const { payload, normalizedMint, unit } = message;

  const dedupKey = `${scopeId}|${payload.id}|${payload.proofs[0]?.secret ?? ""}`;
  if (_processedEvents.has(dedupKey) || _processingEvents.has(dedupKey)) return;
  _processingEvents.add(dedupKey);

  try {
    const token = encodeToken(payload.proofs, normalizedMint, unit);
    if (
      !isCurrentListenerContext(generation, scopeId) ||
      browserWalletIdFromMnemonic(useWalletStore.getState().mnemonic) !== walletId
    ) {
      return;
    }
    const received = await ingressReceiveCashuToken(token, "nip17", {
      mintUrl: normalizedMint,
    });
    useActivityLogStore.getState().addActivity({
      walletId,
      type: "deposit",
      amountSubunits: received.amountSubunits,
      baseAsset: received.baseAsset,
      status: "completed",
    });

    _processedEvents.add(dedupKey);
    if (_processedEvents.size > MAX_PROCESSED) {
      const first = _processedEvents.values().next().value;
      if (first) _processedEvents.delete(first);
    }

    if (
      !isCurrentListenerContext(generation, scopeId) ||
      browserWalletIdFromMnemonic(useWalletStore.getState().mnemonic) !== walletId
    ) {
      return;
    }

    const currentPending = usePaymentRequestInbox.getState().pending[payload.id];
    if (
      !currentPending ||
      currentPending.walletScopeId !== scopeId ||
      currentPending.mintUrl !== normalizedMint
    ) {
      return;
    }
    usePaymentRequestInbox
      .getState()
      .markReceived(payload.id, received.amountSubunits, received.baseAsset, scopeId);
  } catch (e) {
    console.warn("[nip17-listener] failed to redeem payment payload:", (e as Error).message);
  } finally {
    _processingEvents.delete(dedupKey);
  }
}

/**
 * Start (or restart) the listener. Idempotent — re-invoking with the same
 * mnemonic + relay set is a no-op. Re-invoking with a different set stops
 * the previous subscription before starting a new one.
 */
export async function startNip17Listener(mnemonic: string, relays: string[]): Promise<void> {
  if (relays.length === 0) {
    stopNip17Listener();
    return;
  }
  const selectedRelays = normalizeNostrRelayUrls(relays);
  if (!mnemonic) return;
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  const walletId = browserWalletIdFromMnemonic(mnemonic);
  if (scopeId === null || walletId === null || !isCurrentWalletScope(scopeId)) return;
  const relayKey = JSON.stringify([...selectedRelays].sort());
  if (
    _current &&
    _current.mnemonic === mnemonic &&
    _current.scopeId === scopeId &&
    _current.relayKey === relayKey
  ) {
    return;
  }

  if (_starting && _starting.mnemonic === mnemonic && _starting.relayKey === relayKey) {
    return _starting.promise;
  }

  const generation = ++_generation;
  _starting?.controller.abort();
  _current?.unsub();
  _current = null;
  _starting = null;

  const pendingStart: ListenerStart = {
    generation,
    mnemonic,
    relayKey,
    promise: Promise.resolve(),
    controller: new AbortController(),
  };
  _starting = pendingStart;
  pendingStart.promise = (async () => {
    const kp = deriveNostrKeyPair(mnemonic);
    const unsub = await subscribeNip17DMs(
      kp.privateKeyHex,
      kp.publicKey,
      (content) => {
        void handleIncomingDM(content, generation, scopeId, walletId);
      },
      selectedRelays,
      pendingStart.controller.signal,
    );
    if (!isCurrentListenerContext(generation, scopeId)) {
      unsub();
      return;
    }
    _current = { unsub, mnemonic, scopeId, relayKey, startedAt: Date.now() };
  })().finally(() => {
    if (_starting?.generation === generation) _starting = null;
  });
  return pendingStart.promise;
}

export function stopNip17Listener(): void {
  _generation += 1;
  _starting?.controller.abort();
  _current?.unsub();
  _current = null;
  _starting = null;
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
  const mnemonic = useWalletStore.getState().mnemonic;
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  const walletId = browserWalletIdFromMnemonic(mnemonic);
  if (scopeId === null || walletId === null) return Promise.resolve();
  return handleIncomingDM(content, _generation, scopeId, walletId);
}
