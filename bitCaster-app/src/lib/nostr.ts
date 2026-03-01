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

// ---------------------------------------------------------------------------
// Singleton NDK instance
// ---------------------------------------------------------------------------

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
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
// Signer helpers
// ---------------------------------------------------------------------------

/** Login with a NIP-07 browser extension (e.g. Alby, nos2x). */
export async function loginWithExtension(): Promise<NDKSigner> {
  const signer = new NDKNip07Signer();
  const ndk = getNdk();
  ndk.signer = signer;
  await ndk.connect();
  return signer;
}

/** Login with a raw nsec private key (hex or bech32). */
export async function loginWithNsec(nsec: string): Promise<NDKSigner> {
  const signer = new NDKPrivateKeySigner(nsec);
  const ndk = getNdk();
  ndk.signer = signer;
  await ndk.connect();
  return signer;
}

/** Ensure NDK is connected without a signer (read-only mode). */
export async function connectReadOnly(): Promise<void> {
  await getNdk().connect();
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
