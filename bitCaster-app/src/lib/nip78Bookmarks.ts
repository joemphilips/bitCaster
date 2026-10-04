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
import {
  BOOKMARK_KIND,
  BOOKMARK_D_TAG,
  bookmarkEventTemplate,
  parseBookmarkPayload,
} from "@bitcaster/client-sdk/bookmarks";
import { withTemporaryRelayNdk, type RelayOperationOptions } from "./nostr";

export { BOOKMARK_KIND, BOOKMARK_D_TAG } from "@bitcaster/client-sdk/bookmarks";

/**
 * Publish the user's current bookmark set as a NIP-78 replaceable event.
 * Uses a short-lived NDK instance so we don't keep extra relay connections
 * open on the shared singleton.
 */
export async function publishBookmarks(
  privateKeyHex: string,
  marketIds: string[],
  options: RelayOperationOptions = {},
): Promise<void> {
  await withTemporaryRelayNdk(options, new NDKPrivateKeySigner(privateKeyHex), async (ndk) => {
    const event = new NDKEvent(
      ndk,
      bookmarkEventTemplate(marketIds, Math.floor(Date.now() / 1000)),
    );

    await event.publishReplaceable();
  });
}

/**
 * Fetch the most recent bookmark event for a pubkey.
 *
 * Returns `null` if no event exists or the content cannot be parsed.
 */
export async function fetchBookmarks(
  pubkey: string,
  options: RelayOperationOptions = {},
): Promise<string[] | null> {
  return (
    (await withTemporaryRelayNdk(options, undefined, async (ndk) => {
      const event = await ndk.fetchEvent({
        kinds: [BOOKMARK_KIND as number],
        authors: [pubkey],
        "#d": [BOOKMARK_D_TAG],
      });
      if (!event) return null;
      return parseBookmarkPayload(event.content);
    })) ?? null
  );
}
