/**
 * NIP-17 Direct Message helpers for Cashu Payment Requests.
 *
 * Implements gift-wrapped encrypted DMs (NIP-17) using nostr-tools:
 *   kind 14 (rumor) → kind 13 (seal, NIP-44 encrypted) → kind 1059 (gift wrap)
 *
 * Key derivation matches cashu.me's `walletSeedGenerateKeyPair`:
 *   BIP-39 mnemonic → seed → first 32 bytes = secp256k1 private key
 *
 * Reference: cashu.me/src/stores/nostr.ts lines 231-471
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { nip19, nip44 } from "nostr-tools";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash,
  verifyEvent,
} from "nostr-tools/pure";
import type { UnsignedEvent, EventTemplate } from "nostr-tools/core";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { NDKPrivateKeySigner, NDKEvent, NDKRelayStatus, type NDKFilter } from "@nostr-dev-kit/ndk";
import { createExplicitRelayNdk, DEFAULT_RELAYS } from "./nostr";

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export interface NostrKeyPair {
  privateKey: Uint8Array;
  privateKeyHex: string;
  publicKey: string; // hex
}

/**
 * Derive a Nostr keypair from a BIP-39 mnemonic.
 * Uses the first 32 bytes of the seed as the secp256k1 private key,
 * matching cashu.me's `walletSeedGenerateKeyPair`.
 */
export function deriveNostrKeyPair(mnemonic: string): NostrKeyPair {
  const seed = mnemonicToSeedSync(mnemonic);
  const privateKey = seed.slice(0, 32);
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    privateKeyHex: bytesToHex(privateKey),
    publicKey,
  };
}

/**
 * Encode a public key + relay list as an nprofile bech32 string.
 */
export function getNostrNprofile(pubkey: string, relays?: string[]): string {
  return nip19.nprofileEncode({
    pubkey,
    relays: relays ?? DEFAULT_RELAYS,
  });
}

/**
 * Decode an nprofile bech32 string to pubkey + relays.
 */
export function decodeNprofile(nprofile: string): { pubkey: string; relays: string[] } {
  const { data } = nip19.decode(nprofile);
  const profile = data as { pubkey: string; relays?: string[] };
  return {
    pubkey: profile.pubkey,
    relays: profile.relays ?? DEFAULT_RELAYS,
  };
}

// ---------------------------------------------------------------------------
// NIP-17 send
// ---------------------------------------------------------------------------

function randomTimeUpTo2DaysInThePast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800);
}

/**
 * Send a NIP-17 gift-wrapped direct message.
 *
 * Flow: kind 14 rumor → kind 13 seal (NIP-44) → kind 1059 gift wrap (NIP-44)
 */
export async function sendNip17DM(
  senderPrivKeyHex: string,
  senderPubKey: string,
  recipientPubKey: string,
  message: string,
  relays?: string[],
): Promise<void> {
  const resolvedRelays = relays ?? DEFAULT_RELAYS;

  // 1. Create kind 14 rumor (unsigned DM)
  const rumor: UnsignedEvent = {
    kind: 14,
    content: message,
    tags: [["p", recipientPubKey]],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: senderPubKey,
  };
  (rumor as UnsignedEvent & { id: string }).id = getEventHash(rumor);
  const rumorString = JSON.stringify(rumor);

  // 2. Create kind 13 seal — encrypt rumor with sender's key for recipient
  const senderPrivKey = hexToBytes(senderPrivKeyHex);
  const sealConvKey = nip44.v2.utils.getConversationKey(senderPrivKey, recipientPubKey);
  const sealContent = nip44.v2.encrypt(rumorString, sealConvKey);

  const sealTemplate: EventTemplate = {
    kind: 13,
    content: sealContent,
    tags: [],
    created_at: randomTimeUpTo2DaysInThePast(),
  };
  const sealEvent = finalizeEvent(sealTemplate, senderPrivKey);
  const sealString = JSON.stringify(sealEvent);

  // 3. Create kind 1059 gift wrap — encrypt seal with random key for recipient
  const randomPrivKey = generateSecretKey();
  const randomPubKey = getPublicKey(randomPrivKey);

  const wrapConvKey = nip44.v2.utils.getConversationKey(randomPrivKey, recipientPubKey);
  const wrapContent = nip44.v2.encrypt(sealString, wrapConvKey);

  const wrapTemplate: EventTemplate = {
    kind: 1059,
    content: wrapContent,
    tags: [["p", recipientPubKey]],
    created_at: randomTimeUpTo2DaysInThePast(),
  };
  const wrapEvent = finalizeEvent(wrapTemplate, randomPrivKey);

  // 4. Publish via a temporary NDK instance
  const ndk = createExplicitRelayNdk({
    explicitRelayUrls: resolvedRelays,
    signer: new NDKPrivateKeySigner(bytesToHex(randomPrivKey)),
  });
  await ndk.connect();

  const ndkEvent = new NDKEvent(ndk);
  ndkEvent.kind = wrapEvent.kind;
  ndkEvent.content = wrapEvent.content;
  ndkEvent.tags = wrapEvent.tags;
  ndkEvent.created_at = wrapEvent.created_at;
  ndkEvent.pubkey = randomPubKey;
  ndkEvent.id = wrapEvent.id;
  ndkEvent.sig = wrapEvent.sig;

  try {
    await ndkEvent.publish();
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// NIP-17 subscribe
// ---------------------------------------------------------------------------

/**
 * Subscribe to incoming NIP-17 gift-wrapped DMs.
 *
 * Unwraps: kind 1059 → decrypt → kind 13 seal → decrypt → kind 14 rumor
 * Returns an unsubscribe function for cleanup.
 */
export async function subscribeNip17DMs(
  privateKeyHex: string,
  publicKey: string,
  onMessage: (content: string, senderPubkey: string) => void,
  relays?: string[],
): Promise<() => void> {
  const resolvedRelays = relays ?? DEFAULT_RELAYS;
  const privKey = hexToBytes(privateKeyHex);
  const seenIds = new Set<string>();
  const MAX_SEEN_IDS = 5000;

  const ndk = createExplicitRelayNdk({
    explicitRelayUrls: resolvedRelays,
  });

  // NDK connect is best-effort — it will keep retrying failed relays internally
  await ndk.connect().catch((e) => {
    console.warn("[nip17] NDK connect error (will retry):", e);
  });

  // Wait briefly for at least one relay to connect
  await new Promise<void>((resolve) => {
    let resolved = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const checkConnected = () => {
      for (const relay of ndk.pool.relays.values()) {
        if (relay.status >= NDKRelayStatus.CONNECTED) {
          if (!resolved) {
            resolved = true;
            if (interval) clearInterval(interval);
            if (timeout) clearTimeout(timeout);
            resolve();
          }
          return;
        }
      }
    };
    checkConnected();
    if (!resolved) {
      interval = setInterval(() => {
        checkConnected();
      }, 500);
      timeout = setTimeout(() => {
        if (interval) clearInterval(interval);
        if (!resolved) {
          resolved = true;
          console.warn("[nip17] No relay connected within 5s, subscribing anyway");
          resolve();
        }
      }, 5000);
    }
  });

  // Extended since window: 7 days to catch messages while user was offline
  const since = Math.floor(Date.now() / 1000) - 604800;
  const filter: NDKFilter = {
    kinds: [1059 as number],
    "#p": [publicKey],
    since,
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false, groupable: false });

  sub.on("event", (wrapEvent: NDKEvent) => {
    if (seenIds.has(wrapEvent.id)) return;
    seenIds.add(wrapEvent.id);
    if (seenIds.size > MAX_SEEN_IDS) seenIds.clear();

    try {
      // Unwrap: decrypt gift wrap → seal
      const wrapConvKey = nip44.v2.utils.getConversationKey(privKey, wrapEvent.pubkey);
      const sealString = nip44.v2.decrypt(wrapEvent.content, wrapConvKey);
      const sealEvent = JSON.parse(sealString);

      // Verify seal signature (NIP-17 requires valid Schnorr sig)
      if (!verifyEvent(sealEvent)) {
        console.warn("[nip17] Seal signature verification failed, ignoring");
        return;
      }

      // Unwrap seal: decrypt → rumor
      const sealConvKey = nip44.v2.utils.getConversationKey(privKey, sealEvent.pubkey);
      const rumorString = nip44.v2.decrypt(sealEvent.content, sealConvKey);
      const rumor = JSON.parse(rumorString);

      // Verify sender consistency: seal pubkey must match rumor pubkey
      if (sealEvent.pubkey !== rumor.pubkey) {
        console.warn("[nip17] Seal/rumor pubkey mismatch, ignoring");
        return;
      }

      onMessage(rumor.content, rumor.pubkey);
    } catch (e) {
      // Ignore events we can't decrypt (not for us, or malformed)
      console.warn("[nip17] Failed to decrypt DM:", (e as Error).message);
    }
  });

  return () => {
    sub.stop();
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  };
}
