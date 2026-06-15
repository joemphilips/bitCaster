/**
 * Shared NIP-78 helpers for private bitCaster client state.
 *
 * NIP-78 gives us a user-owned replaceable event. We encrypt the event
 * content with NIP-44 to the user's own pubkey so relays do not learn
 * private client-side records such as portfolio activity.
 */

import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { nip44 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { createExplicitRelayNdk, DEFAULT_RELAYS } from "./nostr";

export const BITCASTER_PRIVATE_STATE_KIND = 30078 as const;

export function encryptSelfNip44(
  privateKeyHex: string,
  plaintext: string,
): string {
  const privateKey = hexToBytes(privateKeyHex);
  const publicKey = getPublicKey(privateKey);
  const conversationKey = nip44.v2.utils.getConversationKey(
    privateKey,
    publicKey,
  );
  return nip44.v2.encrypt(plaintext, conversationKey);
}

export function decryptSelfNip44(
  privateKeyHex: string,
  publicKey: string,
  ciphertext: string,
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(
    hexToBytes(privateKeyHex),
    publicKey,
  );
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

export async function publishPrivateNip78(
  privateKeyHex: string,
  dTag: string,
  plaintext: string,
): Promise<void> {
  const ndk = createExplicitRelayNdk({
    explicitRelayUrls: DEFAULT_RELAYS,
    signer: new NDKPrivateKeySigner(privateKeyHex),
  });
  await ndk.connect();

  const event = new NDKEvent(ndk);
  event.kind = BITCASTER_PRIVATE_STATE_KIND;
  event.tags = [
    ["d", dTag],
    ["encrypted", "nip44"],
  ];
  event.content = encryptSelfNip44(privateKeyHex, plaintext);

  try {
    await event.publishReplaceable();
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}

export async function fetchPrivateNip78Content(
  pubkey: string,
  dTag: string,
  privateKeyHex: string,
): Promise<string | null> {
  const ndk = createExplicitRelayNdk({ explicitRelayUrls: DEFAULT_RELAYS });
  await ndk.connect();

  try {
    const event = await ndk.fetchEvent({
      kinds: [BITCASTER_PRIVATE_STATE_KIND as number],
      authors: [pubkey],
      "#d": [dTag],
    });
    if (!event) return null;

    try {
      return decryptSelfNip44(privateKeyHex, pubkey, event.content);
    } catch {
      // Backward compatibility for pre-P11 plaintext NIP-78 events. Once the
      // next publish succeeds, the relay copy is rewritten encrypted.
      return event.content;
    }
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}
