/**
 * NDK singleton and helpers for bitCaster.
 *
 * Responsibilities:
 *  - Provide a shared NDK instance wired to configured default relays
 *  - Support NIP-07 browser-extension signer and plain nsec login
 *  - Expose a helper to attach an NWC wallet for Lightning/Cashu top-ups
 *  - Provide typed filters for DLC oracle announcement events (kind 88)
 */

import NDK, {
  NDKNip07Signer,
  NDKPrivateKeySigner,
  type NDKSigner,
  type NDKUser,
  type NDKFilter,
  type NDKEvent,
  type NDKConstructorParams,
} from "@nostr-dev-kit/ndk";
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";
import { decodePrivateNostrSignerKey } from "@bitcaster/client-sdk";
import { setPendingKormirNsec } from "./kormir";
import { useSettingsStore } from "@/stores/settings";
import { DEFAULT_NOSTR_RELAYS, effectiveRelayUrls } from "./relayDefaults";
import { selectNostrRelayUrls } from "@bitcaster/client-sdk/nostrRelays";
import { awaitAbortable } from "@bitcaster/client-sdk/engineClient";
import { beginNostrIdentityAttempt, type NostrIdentityAttempt } from "./nostrIdentityAttempt";
import type { BrowserProfileSelection } from "./browserNostrProfile";

// ---------------------------------------------------------------------------
// Singleton NDK instance
// ---------------------------------------------------------------------------

export const DEFAULT_RELAYS: string[] = [...DEFAULT_NOSTR_RELAYS];

let _ndk: NDK | null = null;
// Snapshot of the user-relay set last reconciled into the singleton NDK.
// `getNdk()` is on hot paths (every login, profile fetch, oracle subscribe);
// the snapshot lets us skip the pool walk when the user hasn't added or
// removed a relay since the previous call.
let _lastReconciledRelaysKey = "";

type TeardownCapableSigner = NDKSigner & {
  destroy?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};

export { getNostrSignerRevision, subscribeToNostrSignerRevision } from "./nostrSignerRevision";
import { advanceNostrSignerRevision } from "./nostrSignerRevision";

// NDK schedules activeUser after signer.user(). Ignore its late callback after
// replacement or disconnect. Both supported adapters cache their authorized user.
const authorizedUsers = new WeakMap<NDKSigner, NDKUser>();
class BrowserIdentityNdk extends NDK {
  override get activeUser(): NDKUser | undefined {
    return super.activeUser;
  }
  override set activeUser(user: NDKUser | undefined) {
    if (user && (!this.signer || authorizedUsers.get(this.signer) !== user)) return;
    super.activeUser = user;
  }
}

export interface NostrLoginOptions {
  attempt?: NostrIdentityAttempt;
  /** Commit persisted identity synchronously with the live signer. */
  onCommit?: (nsec: string | null, publicKey: string) => void;
}

async function authorizeAndInstall(
  signer: NDKSigner,
  nsec: string | null,
  options: NostrLoginOptions,
): Promise<NDKSigner> {
  const attempt = options.attempt ?? beginNostrIdentityAttempt();
  attempt.requireCurrent();
  const user = await awaitAbortable(signer.user(), attempt.signal);
  attempt.requireCurrent();
  if (!/^[0-9a-f]{64}$/.test(user.pubkey)) throw new Error("Invalid Nostr public key.");
  const ndk = getNdk();
  const previous = ndk.signer;
  authorizedUsers.set(signer, user);
  ndk.signer = signer;
  attempt.requireCurrent();
  ndk.activeUser = user;
  attempt.requireCurrent();
  options.onCommit?.(nsec, user.pubkey);
  attempt.requireCurrent();
  _installedNsec = nsec;
  setPendingKormirNsec(nsec);
  advanceNostrSignerRevision();
  void teardownSigner(previous);
  void ndk.connect().catch(() => {});
  return signer;
}

export function hasInstalledNostrSigner(): boolean {
  return _ndk?.signer !== undefined && _ndk?.signer !== null;
}

/** Disconnect invalidates pending authorization and captured oracle/profile work. */
export function disconnectNostrSigner(): void {
  beginNostrIdentityAttempt();
  const previous = _ndk?.signer;
  if (_ndk) {
    _ndk.signer = undefined;
    _ndk.activeUser = undefined;
  }
  _installedNsec = null;
  setPendingKormirNsec(null);
  advanceNostrSignerRevision();
  void teardownSigner(previous);
}

export function createExplicitRelayNdk(opts: NDKConstructorParams = {}): NDK {
  return new NDK({
    ...opts,
    enableOutboxModel: false,
    autoConnectUserRelays: false,
    outboxRelayUrls: [],
  });
}

/**
 * Read the user's exact relay selection. Only missing settings use defaults.
 */
export function selectedRelayUrls(): string[] {
  try {
    return effectiveRelayUrls(useSettingsStore.getState().relays);
  } catch {
    return [];
  }
}

function reconcileRelays(ndk: NDK, urls: string[]): void {
  // The maintained dependency setter retains unchanged objects and disposes removals.
  ndk.explicitRelayUrls = urls;
}

export interface RelayOperationOptions {
  relays?: readonly string[];
  signal?: AbortSignal;
}

/** A temporary operation owns cancellation from connection setup through completion. */
export async function withTemporaryRelayNdk<T>(
  options: RelayOperationOptions,
  signer: NDKSigner | undefined,
  action: (ndk: NDK) => Promise<T>,
): Promise<T | undefined> {
  const relays = selectNostrRelayUrls(options.relays, selectedRelayUrls());
  if (relays.length === 0) return undefined;
  const signal = options.signal ?? new AbortController().signal;
  const ndk = createExplicitRelayNdk({ explicitRelayUrls: relays, signer });
  const dispose = () => {
    for (const subscription of ndk.subManager.subscriptions.values()) subscription.stop();
    ndk.explicitRelayUrls = [];
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    signal.throwIfAborted();
    await awaitAbortable(ndk.connect(), signal);
    signal.throwIfAborted();
    return await awaitAbortable(action(ndk), signal);
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}

export function getNdk(): NDK {
  const urls = selectedRelayUrls();
  if (!_ndk) {
    _ndk = new BrowserIdentityNdk({
      explicitRelayUrls: urls,
      enableOutboxModel: false,
      autoConnectUserRelays: false,
      outboxRelayUrls: [],
    });
    _lastReconciledRelaysKey = JSON.stringify(urls.slice().sort());
    // Settings removal must disconnect existing relays before another NDK call.
    // This subscription has the same tab lifetime as the singleton.
    useSettingsStore.subscribe((state, previous) => {
      if (!_ndk || state.relays === previous.relays) return;
      const selected = effectiveRelayUrls(state.relays);
      const selectedKey = JSON.stringify(selected.slice().sort());
      if (selectedKey === _lastReconciledRelaysKey) return;
      reconcileRelays(_ndk, selected);
      _lastReconciledRelaysKey = selectedKey;
    });
    return _ndk;
  }
  // Pool reconciliation is idempotent but it still walks the current set.
  // Short-circuit when the selected
  // URL set (order-independent) hasn't changed since the previous
  // reconciliation. Sorted serialization makes the cache key set-equal: re-hydration
  // of settings with a different iteration order does not trigger a spurious
  // pool walk.
  const key = JSON.stringify(urls.slice().sort());
  if (key !== _lastReconciledRelaysKey) {
    reconcileRelays(_ndk, urls);
    _lastReconciledRelaysKey = key;
  }
  return _ndk;
}

async function teardownSigner(value: NDKSigner | undefined): Promise<void> {
  const signer = value as TeardownCapableSigner | undefined;
  try {
    if (typeof signer?.destroy === "function") {
      await signer.destroy();
      return;
    }
    if (typeof signer?.stop === "function") {
      await signer.stop();
    }
  } catch {
    // Best-effort: signer replacement must still proceed if an optional
    // teardown hook fails or belongs to an older NDK implementation.
  }
}

// ---------------------------------------------------------------------------
// NIP-07 detection
// ---------------------------------------------------------------------------

/** Check whether a NIP-07 browser extension (e.g. Alby, nos2x) is available. */
export function isNip07Available(): boolean {
  const ext = (window as { nostr?: { getPublicKey?: unknown } }).nostr;
  return !!ext && typeof ext.getPublicKey === "function";
}

// ---------------------------------------------------------------------------
// Signer helpers
// ---------------------------------------------------------------------------

/** Authorize the extension before installing its signer. Relay reads are separate. */
export async function loginWithExtension(options: NostrLoginOptions = {}): Promise<NDKSigner> {
  const attempt = options.attempt ?? beginNostrIdentityAttempt();
  return authorizeAndInstall(new NDKNip07Signer(), null, { ...options, attempt });
}

/** Install a local signer without changing retained oracle authority. */
export async function loginWithNsec(
  nsec: string,
  options: NostrLoginOptions = {},
): Promise<NDKSigner> {
  const attempt = options.attempt ?? beginNostrIdentityAttempt();
  return authorizeAndInstall(new NDKPrivateKeySigner(nsec), nsec, { ...options, attempt });
}

/**
 * Login with either a raw nsec (hex / bech32 `nsec1...`) or an encrypted
 * NIP-49 `ncryptsec1...`. When the input is an ncryptsec, `passphrase` must
 * be supplied so the key can be decrypted before installation.
 *
 * Returns the decrypted nsec in bech32 form so callers can persist it for
 * rehydration on reload (see {@link rehydrateNostrSigner}).
 */
export async function loginWithNsecOrNcryptsec(
  input: string,
  passphrase?: string,
  options: NostrLoginOptions = {},
): Promise<{ signer: NDKSigner; nsec: string }> {
  const attempt = options.attempt ?? beginNostrIdentityAttempt();
  const { nsec } = decodePrivateNostrSignerKey(input, passphrase);
  const signer = await loginWithNsec(nsec, { ...options, attempt });
  return { signer, nsec };
}

// Track the last nsec we installed onto the singleton NDK so repeated calls
// (StrictMode double-invoke, persist re-hydration, manual retries) don't
// reinstall the signer or refetch the profile when the input hasn't changed.
let _installedNsec: string | null = null;

/**
 * Re-install the Nostr signer on app startup using the nsec persisted in
 * the settings store. `NDK.signer` lives in module-level state that's
 * cleared on every page load, so without this call a user who logged in
 * with nsec before a reload would appear connected (mode still `'nsec'`)
 * but have no live signer — every signing attempt would throw.
 *
 * Refresh the persisted display profile from the selected relays. Keep a
 * matching cached display while the verified public read is in progress.
 */
export async function rehydrateNostrSigner(
  attempt: NostrIdentityAttempt = beginNostrIdentityAttempt(),
): Promise<void> {
  if (!attempt.isCurrent()) return;
  const settings = useSettingsStore.getState();
  const { nostrSignerMode, nsecSecret } = settings;
  if (nostrSignerMode === "none") return;
  if (nostrSignerMode === "nsec" && !nsecSecret) return;
  if (
    nostrSignerMode === "nsec" &&
    _installedNsec === nsecSecret &&
    getNdk().signer instanceof NDKPrivateKeySigner
  )
    return;
  settings.setSignerConnectionStatus("connecting");
  try {
    const options = {
      attempt,
      onCommit: (_nsec: string | null, publicKey: string) => {
        useSettingsStore.getState().confirmNostrIdentity(publicKey);
      },
    };
    if (nostrSignerMode === "nip07") await loginWithExtension(options);
    else if (nostrSignerMode === "nsec" && nsecSecret) await loginWithNsec(nsecSecret, options);
    if (attempt.isCurrent()) void fetchAndStoreNostrProfile();
  } catch {
    if (!attempt.isCurrent()) return;
    // Keep persisted provenance for retry. Cached settings do not prove authorization.
    useSettingsStore.getState().setSignerConnectionStatus("disconnected");
  }
}

/**
 * Fetch the current signer's Nostr profile from relays and store it in the
 * settings store. Best-effort: a relay timeout / miss sets status
 * `'not-found'` rather than throwing, so UI callers can await without
 * wrapping in try/catch.
 *
 * Shared by {@link rehydrateNostrSigner} (reload path) and the Settings
 * page's nsec / NIP-07 connect flows so the shaping of `NostrProfile` is
 * defined in exactly one place.
 */
export async function fetchAndStoreNostrProfile(): Promise<void> {
  let selection: BrowserProfileSelection | undefined;
  let cached: ReturnType<typeof useSettingsStore.getState>["nostrProfile"] = null;
  try {
    const { captureBrowserNostrProfileSelection, readBrowserSignerProfile } =
      await import("./browserNostrProfile");
    selection = await captureBrowserNostrProfileSelection({ getNdk });
    const settings = useSettingsStore.getState();
    cached =
      settings.nostrProfile?.pubkey === selection.publicKey
        ? { ...settings.nostrProfile, nip05verified: false }
        : null;
    selection.requireCurrent();
    settings.setProfile(cached, "fetching");
    const result = await readBrowserSignerProfile(selection);
    selection.requireCurrent();
    const profile = result.profile ?? cached;
    useSettingsStore.getState().setProfile(profile, profile ? "found" : "not-found");
  } catch {
    if (!selection) return;
    try {
      selection.requireCurrent();
    } catch {
      return;
    }
    useSettingsStore.getState().setProfile(cached, cached ? "found" : "not-found");
  } finally {
    selection?.dispose();
  }
}

export interface PublicNostrProfile {
  pubkey: string;
  displayName: string;
  avatar: string;
}

export async function fetchPublicNostrProfile(pubkey: string): Promise<PublicNostrProfile | null> {
  try {
    const ndk = getNdk();
    const user = ndk.getUser({ pubkey });
    await Promise.race([
      user.fetchProfile(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]).catch(() => {});
    const profile = user.profile;
    if (!profile) return null;
    const displayName = typeof profile.displayName === "string" ? profile.displayName.trim() : "";
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    return {
      pubkey,
      displayName: displayName || name || pubkey.slice(0, 8),
      avatar: typeof profile.image === "string" ? profile.image.trim() : "",
    };
  } catch {
    return null;
  }
}

/** Ensure NDK is connected without a signer (read-only mode). */
export async function connectReadOnly(): Promise<void> {
  getNdk().connect();
}

// ---------------------------------------------------------------------------
// NWC wallet
// ---------------------------------------------------------------------------

/**
 * Attach a Nostr Wallet Connect wallet to the NDK instance.
 *
 * @param pairingCode - nostr+walletconnect:// URI from the user's wallet
 * @returns the NDKNWCWallet instance (already assigned to ndk.wallet)
 */
export async function connectNwcWallet(pairingCode: string): Promise<NDKNWCWallet> {
  const ndk = getNdk();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NDK version mismatch between ndk and ndk-wallet
  const wallet = new NDKNWCWallet(ndk as any, { pairingCode, timeout: 30_000 });

  ndk.wallet = wallet;

  // Resolve once the wallet is ready
  await new Promise<void>((resolve, reject) => {
    wallet.once("ready", resolve);
    // Reject after 30 s if the wallet never becomes ready
    setTimeout(() => reject(new Error("NWC wallet timed out")), 30_000);
  });

  return wallet;
}

// ---------------------------------------------------------------------------
// Oracle / DLC event subscriptions
// ---------------------------------------------------------------------------

/**
 * DLC oracle announcement event kind.
 * Follows the convention used by DLC Oracle implementations on Nostr.
 */
export const KIND_DLC_ANNOUNCEMENT = 88 as const;

/** Filter for DLC oracle announcements published by a specific oracle pubkey. */
export function oracleAnnouncementFilter(oraclePubkey: string): NDKFilter {
  return {
    kinds: [KIND_DLC_ANNOUNCEMENT as number],
    authors: [oraclePubkey],
  };
}

/**
 * Subscribe to DLC oracle announcements.
 *
 * @param oraclePubkey - hex pubkey of the oracle
 * @param onEvent - callback fired for each announcement event
 */
export function subscribeOracleAnnouncements(
  oraclePubkey: string,
  onEvent: (event: NDKEvent) => void,
): ReturnType<NDK["subscribe"]> {
  const ndk = getNdk();
  const filter = oracleAnnouncementFilter(oraclePubkey);
  const sub = ndk.subscribe(filter, { closeOnEose: false });
  sub.on("event", onEvent);
  return sub;
}
