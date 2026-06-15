/**
 * NIP-78 bookmark sync for bitCaster.
 *
 * Stores the user's bookmarked markets as a parameterized replaceable event
 * (kind 30078, d-tag "bitcaster:bookmarks") on the configured bitCaster relay
 * so bookmarks follow the user's Nostr identity across devices.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/78.md
 */

import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { createExplicitRelayNdk, DEFAULT_RELAYS } from "./nostr";

export const BOOKMARK_KIND = 30078 as const;
export const BOOKMARK_D_TAG = "bitcaster:bookmarks" as const;

interface BookmarkPayload {
  markets: string[];
}

/**
 * Publish the user's current bookmark set as a NIP-78 replaceable event.
 * Uses a short-lived NDK instance so we don't keep extra relay connections
 * open on the shared singleton.
 */
export async function publishBookmarks(
  privateKeyHex: string,
  marketIds: string[],
): Promise<void> {
  const ndk = createExplicitRelayNdk({
    explicitRelayUrls: DEFAULT_RELAYS,
    signer: new NDKPrivateKeySigner(privateKeyHex),
  });
  await ndk.connect();

  const event = new NDKEvent(ndk);
  event.kind = BOOKMARK_KIND;
  event.tags = [["d", BOOKMARK_D_TAG]];
  event.content = JSON.stringify({ markets: marketIds } satisfies BookmarkPayload);

  try {
    await event.publishReplaceable();
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}

/**
 * Fetch the most recent bookmark event for a pubkey.
 *
 * Returns `null` if no event exists or the content cannot be parsed.
 */
export async function fetchBookmarks(pubkey: string): Promise<string[] | null> {
  const ndk = createExplicitRelayNdk({ explicitRelayUrls: DEFAULT_RELAYS });
  await ndk.connect();

  try {
    const event = await ndk.fetchEvent({
      kinds: [BOOKMARK_KIND as number],
      authors: [pubkey],
      "#d": [BOOKMARK_D_TAG],
    });
    if (!event) return null;
    try {
      const parsed = JSON.parse(event.content) as Partial<BookmarkPayload>;
      if (
        Array.isArray(parsed.markets) &&
        parsed.markets.every((m) => typeof m === "string")
      ) {
        return parsed.markets;
      }
      return null;
    } catch {
      return null;
    }
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}
