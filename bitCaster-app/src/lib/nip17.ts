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
} from "nostr-tools/pure";
import type { UnsignedEvent, EventTemplate } from "nostr-tools/core";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import NDK, {
  NDKPrivateKeySigner,
  NDKEvent,
  type NDKFilter,
} from "@nostr-dev-kit/ndk";
import { DEFAULT_RELAYS } from "./nostr";

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
export function getNostrNprofile(
  pubkey: string,
  relays?: string[]
): string {
  return nip19.nprofileEncode({
    pubkey,
    relays: relays ?? DEFAULT_RELAYS,
  });
}

/**
 * Decode an nprofile bech32 string to pubkey + relays.
 */
export function decodeNprofile(
  nprofile: string
): { pubkey: string; relays: string[] } {
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
  relays?: string[]
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
  const sealConvKey = nip44.v2.utils.getConversationKey(
    senderPrivKey,
    recipientPubKey
  );
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

  const wrapConvKey = nip44.v2.utils.getConversationKey(
    randomPrivKey,
    recipientPubKey
  );
  const wrapContent = nip44.v2.encrypt(sealString, wrapConvKey);

  const wrapTemplate: EventTemplate = {
    kind: 1059,
    content: wrapContent,
    tags: [["p", recipientPubKey]],
    created_at: randomTimeUpTo2DaysInThePast(),
  };
  const wrapEvent = finalizeEvent(wrapTemplate, randomPrivKey);

  // 4. Publish via a temporary NDK instance
  const ndk = new NDK({
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

  await ndkEvent.publish();
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
  relays?: string[]
): Promise<() => void> {
  const resolvedRelays = relays ?? DEFAULT_RELAYS;
  const privKey = hexToBytes(privateKeyHex);
  const seenIds = new Set<string>();

  const ndk = new NDK({ explicitRelayUrls: resolvedRelays });
  await ndk.connect();

  const since = Math.floor(Date.now() / 1000) - 172800; // last 2 days
  const filter: NDKFilter = {
    kinds: [1059 as number],
    "#p": [publicKey],
    since,
  };

  const sub = ndk.subscribe(filter, { closeOnEose: false, groupable: false });

  sub.on("event", (wrapEvent: NDKEvent) => {
    if (seenIds.has(wrapEvent.id)) return;
    seenIds.add(wrapEvent.id);

    try {
      // Unwrap: decrypt gift wrap → seal
      const wrapConvKey = nip44.v2.utils.getConversationKey(
        privKey,
        wrapEvent.pubkey
      );
      const sealString = nip44.v2.decrypt(wrapEvent.content, wrapConvKey);
      const sealEvent = JSON.parse(sealString);

      // Unwrap seal: decrypt → rumor
      const sealConvKey = nip44.v2.utils.getConversationKey(
        privKey,
        sealEvent.pubkey
      );
      const rumorString = nip44.v2.decrypt(sealEvent.content, sealConvKey);
      const rumor = JSON.parse(rumorString);

      onMessage(rumor.content, rumor.pubkey);
    } catch (e) {
      // Ignore events we can't decrypt (not for us, or malformed)
      console.warn("Failed to decrypt NIP-17 DM:", e);
    }
  });

  return () => {
    sub.stop();
  };
}
