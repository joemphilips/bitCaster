/**
 * Shared NIP-78 helpers for private bitCaster client state.
 *
 * NIP-78 gives us a user-owned replaceable event. We encrypt the event
 * content with NIP-44 to the user's own pubkey so relays do not learn
 * private client-side records such as portfolio activity.
 */

import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import {
  BITCASTER_PRIVATE_STATE_KIND,
  createPrivateNip78Content,
  decryptSelfNip44,
} from "@bitcaster/client-sdk/privateNip78";
import { withTemporaryRelayNdk, type RelayOperationOptions } from "./nostr";

export {
  BITCASTER_PRIVATE_STATE_KIND,
  encryptSelfNip44,
  decryptSelfNip44,
} from "@bitcaster/client-sdk/privateNip78";

export async function publishPrivateNip78(
  privateKeyHex: string,
  dTag: string,
  plaintext: string,
  options: RelayOperationOptions = {},
): Promise<void> {
  await withTemporaryRelayNdk(options, new NDKPrivateKeySigner(privateKeyHex), async (ndk) => {
    const event = new NDKEvent(ndk);
    const payload = createPrivateNip78Content(privateKeyHex, dTag, plaintext);
    event.kind = payload.kind;
    event.tags = payload.tags;
    event.content = payload.content;

    await event.publishReplaceable();
  });
}

export async function fetchPrivateNip78Content(
  pubkey: string,
  dTag: string,
  privateKeyHex: string,
  options: RelayOperationOptions = {},
): Promise<string | null> {
  return (
    (await withTemporaryRelayNdk(options, undefined, async (ndk) => {
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
    })) ?? null
  );
}
