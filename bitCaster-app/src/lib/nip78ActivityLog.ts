/**
 * Encrypted NIP-78 portfolio activity sync for bitCaster.
 *
 * Activity history is user-private operational metadata. Keep it in
 * localStorage for fast reloads, and mirror it to NIP-78 with NIP-44
 * self-encryption so it can be restored on a fresh browser profile.
 */

import type { ActivityItem } from "@/types/portfolio";
import {
  ACTIVITY_LOG_D_TAG,
  decodeActivityLogPayload,
  encodeActivityLogPayload,
} from "@bitcaster/client-sdk/activityLog";
import { fetchPrivateNip78Content, publishPrivateNip78 } from "./nip78Private";
import type { RelayOperationOptions } from "./nostr";

export { ACTIVITY_LOG_D_TAG } from "@bitcaster/client-sdk/activityLog";

export async function publishNip78ActivityLog(
  privateKeyHex: string,
  items: ActivityItem[],
  options?: RelayOperationOptions,
): Promise<void> {
  await publishPrivateNip78(
    privateKeyHex,
    ACTIVITY_LOG_D_TAG,
    encodeActivityLogPayload(items),
    options,
  );
}

export async function fetchNip78ActivityLog(
  pubkey: string,
  privateKeyHex: string,
  options?: RelayOperationOptions,
): Promise<ActivityItem[] | null> {
  const content = await fetchPrivateNip78Content(
    pubkey,
    ACTIVITY_LOG_D_TAG,
    privateKeyHex,
    options,
  );
  if (!content) return null;

  return decodeActivityLogPayload(content);
}
