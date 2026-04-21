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

// ---------------------------------------------------------------------------
// Singleton NDK instance
// ---------------------------------------------------------------------------

export const DEFAULT_RELAYS: string[] = import.meta.env.VITE_NOSTR_RELAYS
  ? (import.meta.env.VITE_NOSTR_RELAYS as string).split(",").map((r: string) => r.trim())
  : [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.primal.net",
      "wss://nostr.bitcoiner.social",
    ];

let _ndk: NDK | null = null;

export function getNdk(): NDK {
  if (!_ndk) {
    _ndk = new NDK({ explicitRelayUrls: DEFAULT_RELAYS });
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

/**
 * Re-install the Nostr signer on app startup using the nsec persisted in
 * the settings store. `NDK.signer` lives in module-level state that's
 * cleared on every page load, so without this call a user who logged in
 * with nsec before a reload would appear connected (mode still `'nsec'`)
 * but have no live signer — every signing attempt would throw.
 */
export async function rehydrateNostrSigner(): Promise<void> {
  const settings = useSettingsStore.getState();
  const { nostrSignerMode, nsecSecret } = settings;
  if (nostrSignerMode !== "nsec" || !nsecSecret) return;
  try {
    await loginWithNsec(nsecSecret);
  } catch {
    // Stored nsec is corrupt — reset signer mode so the UI reflects reality.
    // `setSignerMode` also wipes `nsecSecret` when leaving nsec mode, so we
    // don't need a separate `setNsecSecret(null)` call.
    settings.setSignerMode("none");
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
