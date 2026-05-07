/**
 * NDK singleton and helpers for bitCaster.
 *
 * Responsibilities:
 *  - Provide a shared NDK instance wired to well-known public relays
 *  - Support NIP-07 browser-extension signer and plain nsec login
 *  - Expose a helper to attach an NWC wallet for Lightning/Cashu top-ups
 *  - Provide typed filters for DLC oracle announcement events (kind 88)
 */

import NDK, {
  NDKNip07Signer,
  NDKPrivateKeySigner,
  type NDKSigner,
  type NDKFilter,
  type NDKEvent,
} from "@nostr-dev-kit/ndk";
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";
import { nip19 } from "nostr-tools";
import * as nip49 from "nostr-tools/nip49";
import { setPendingKormirNsec } from "./kormir";
import { useSettingsStore } from "@/stores/settings";
import { PRODUCTION_NOSTR_RELAYS } from "./relayDefaults";

// ---------------------------------------------------------------------------
// Singleton NDK instance
// ---------------------------------------------------------------------------

export const DEFAULT_RELAYS: string[] = import.meta.env.VITE_NOSTR_RELAYS
  ? (import.meta.env.VITE_NOSTR_RELAYS as string).split(",").map((r: string) => r.trim())
  : [...PRODUCTION_NOSTR_RELAYS];

let _ndk: NDK | null = null;
// Snapshot of the user-relay set last reconciled into the singleton NDK.
// `getNdk()` is on hot paths (every login, profile fetch, oracle subscribe);
// the snapshot lets us skip the pool walk when the user hasn't added or
// removed a relay since the previous call.
let _lastReconciledRelaysKey = "";

/**
 * Merge user-configured relays from the settings store with the static
 * {@link DEFAULT_RELAYS} list, deduplicating while preserving order. The
 * profile-fetch surface specifically needs this — a kind:0 published only to
 * a user-added relay would never resolve when the NDK pool is restricted to
 * the defaults. Returns DEFAULT_RELAYS alone when settings hasn't hydrated
 * (or has no relays configured) so module-load callers don't crash.
 */
function mergedRelayUrls(): string[] {
  try {
    const userRelays = useSettingsStore.getState().relays.map((r) => r.url);
    const merged = [...DEFAULT_RELAYS];
    for (const url of userRelays) {
      if (!merged.includes(url)) merged.push(url);
    }
    return merged;
  } catch {
    return DEFAULT_RELAYS;
  }
}

function reconcileRelays(ndk: NDK, urls: string[]): void {
  const known = new Set(ndk.pool.relays.keys());
  const desired = new Set(urls);
  // Add any desired relay not already in the pool.
  for (const url of urls) {
    if (known.has(url)) continue;
    try {
      ndk.addExplicitRelay(url, undefined, true);
    } catch {
      // Bad URL or already-known race — ignore; profile fetch can still
      // succeed via the other relays.
    }
  }
  // P8 codex review #4: reconcile must also remove relays the user dropped
  // from settings. Without this, removed relays stay connected and continue
  // to receive subscriptions / leak the user's queries to a relay they
  // explicitly tried to disconnect.
  for (const url of known) {
    if (desired.has(url)) continue;
    try {
      const relay = ndk.pool.relays.get(url);
      if (relay) {
        relay.disconnect?.();
        ndk.pool.relays.delete(url);
      }
    } catch {
      // Best-effort teardown — leave the next reconciliation pass to retry.
    }
  }
}

export function getNdk(): NDK {
  const urls = mergedRelayUrls();
  if (!_ndk) {
    _ndk = new NDK({ explicitRelayUrls: urls });
    _lastReconciledRelaysKey = urls.slice().sort().join("|");
    return _ndk;
  }
  // `addExplicitRelay` is idempotent on URL — but the pool walk plus Set
  // construction is wasted work on every call. Short-circuit when the merged
  // URL set (order-independent) hasn't changed since the previous
  // reconciliation. Sorted join makes the cache key set-equal: re-hydration
  // of settings with a different iteration order does not trigger a spurious
  // pool walk.
  const key = urls.slice().sort().join("|");
  if (key !== _lastReconciledRelaysKey) {
    reconcileRelays(_ndk, urls);
    _lastReconciledRelaysKey = key;
  }
  return _ndk;
}

// ---------------------------------------------------------------------------
// NIP-07 detection
// ---------------------------------------------------------------------------

/** Check whether a NIP-07 browser extension (e.g. Alby, nos2x) is available. */
export function isNip07Available(): boolean {
  const ext = (window as { nostr?: { getPublicKey?: unknown } }).nostr
  return !!ext && typeof ext.getPublicKey === 'function'
}

// ---------------------------------------------------------------------------
// Signer helpers
// ---------------------------------------------------------------------------

/** Login with a NIP-07 browser extension (e.g. Alby, nos2x). */
export async function loginWithExtension(): Promise<NDKSigner> {
  const signer = new NDKNip07Signer();
  const ndk = getNdk();
  ndk.signer = signer;
  // Don't block login on relay connectivity — connect in background
  ndk.connect();
  // NIP-07 keeps the secret key inside the extension, so kormir (which needs
  // the raw secret to produce DLC signatures locally) cannot use it. Forget
  // any previously-staged nsec so the oracle flow will refuse to sign with a
  // stale key after the user switches to an extension signer.
  setPendingKormirNsec(null);
  return signer;
}

/**
 * Login with a raw nsec private key (hex or bech32).
 *
 * The same key is also staged for the kormir-wasm oracle store so that the
 * DLC oracle identity stays unified with the Nostr identity (same secp256k1
 * secret key is used for both announcement Schnorr signatures and Nostr
 * events). `setPendingKormirNsec` only remembers the key — the actual wasm
 * load and IndexedDB write happen lazily on the first oracle operation, so
 * users who only use Nostr for DMs never pay the 3MB wasm download cost.
 */
export async function loginWithNsec(nsec: string): Promise<NDKSigner> {
  const signer = new NDKPrivateKeySigner(nsec);
  const ndk = getNdk();
  ndk.signer = signer;
  // Don't block login on relay connectivity — connect in background
  ndk.connect();
  setPendingKormirNsec(nsec);
  return signer;
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
): Promise<{ signer: NDKSigner; nsec: string }> {
  const trimmed = input.trim();
  let nsec: string;
  if (trimmed.startsWith("ncryptsec1")) {
    if (!passphrase) {
      throw new Error("A passphrase is required to decrypt an ncryptsec key.");
    }
    // nip49.decrypt returns the 32-byte secret key as Uint8Array.
    const secretKey = nip49.decrypt(trimmed, passphrase);
    nsec = nip19.nsecEncode(secretKey);
  } else {
    nsec = trimmed;
  }
  const signer = await loginWithNsec(nsec);
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
 * Also re-fetches the Nostr profile: `nostrProfile` is intentionally not
 * persisted (the relay is source of truth), so after a reload the profile
 * rehydrates as `null` and `ShellRoutes` falls back to "Anon" / no avatar.
 * Kick off the fetch here so the user doesn't see the connected-but-anon
 * state flicker.
 */
export async function rehydrateNostrSigner(): Promise<void> {
  const settings = useSettingsStore.getState();
  const { nostrSignerMode, nsecSecret } = settings;
  if (nostrSignerMode !== "nsec" || !nsecSecret) return;
  // Identity-binding guard (P04): only short-circuit when the live NDK
  // signer is in fact the private-key one. A mode-switch nsec → nip07 →
  // nsec-with-same-string would otherwise leave the NIP-07 signer attached
  // and we'd publish under the wrong identity.
  if (_installedNsec === nsecSecret && getNdk().signer instanceof NDKPrivateKeySigner) return;
  try {
    await loginWithNsec(nsecSecret);
    _installedNsec = nsecSecret;
    fetchAndStoreNostrProfile().catch(() => {});
  } catch {
    // Stored nsec is corrupt — reset signer mode so the UI reflects reality.
    // `setSignerMode` also wipes `nsecSecret` when leaving nsec mode, so we
    // don't need a separate `setNsecSecret(null)` call.
    _installedNsec = null;
    settings.setSignerMode("none");
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
  const settings = useSettingsStore.getState();
  try {
    const ndk = getNdk();
    const signer = ndk.signer;
    if (!signer) {
      settings.setProfile(null, "not-found");
      return;
    }
    const user = await signer.user();
    const cached = settings.nostrProfile?.pubkey === user.pubkey
      ? settings.nostrProfile
      : null;
    settings.setProfile(cached, "fetching");
    await Promise.race([
      user.fetchProfile(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8000)
      ),
    ]).catch(() => {
      /* timeout or relay error — profile stays null */
    });
    const profile = user.profile;
    if (profile) {
      settings.setProfile(
        {
          pubkey: user.pubkey,
          displayName:
            profile.displayName ?? profile.name ?? user.pubkey.slice(0, 8),
          avatar: profile.image ?? "",
          nip05: profile.nip05 ?? "",
          nip05verified: !!profile.nip05,
          bio: profile.bio ?? profile.about ?? "",
        },
        "found"
      );
    } else if (cached) {
      settings.setProfile(cached, "found");
    } else {
      settings.setProfile(null, "not-found");
    }
  } catch {
    const current = useSettingsStore.getState().nostrProfile;
    if (current) {
      settings.setProfile(current, "found");
    } else {
      settings.setProfile(null, "not-found");
    }
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
export async function connectNwcWallet(
  pairingCode: string
): Promise<NDKNWCWallet> {
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
export function oracleAnnouncementFilter(
  oraclePubkey: string
): NDKFilter {
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
  onEvent: (event: NDKEvent) => void
): ReturnType<NDK["subscribe"]> {
  const ndk = getNdk();
  const filter = oracleAnnouncementFilter(oraclePubkey);
  const sub = ndk.subscribe(filter, { closeOnEose: false });
  sub.on("event", onEvent);
  return sub;
}
