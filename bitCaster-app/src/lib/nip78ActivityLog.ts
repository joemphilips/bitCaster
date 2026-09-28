/**
 * Encrypted NIP-78 portfolio activity sync for bitCaster.
 *
 * Activity history is user-private operational metadata. Keep it in
 * localStorage for fast reloads, and mirror it to NIP-78 with NIP-44
 * self-encryption so it can be restored on a fresh browser profile.
 */

import type { ActivityItem } from "@/types/portfolio";
import { decodeActivityItem } from "@/stores/activity-log";
import { fetchPrivateNip78Content, publishPrivateNip78 } from "./nip78Private";

export const ACTIVITY_LOG_D_TAG = "bitcaster:activity-log" as const;

interface ActivityLogPayload {
  items: ActivityItem[];
}

export async function publishNip78ActivityLog(
  privateKeyHex: string,
  items: ActivityItem[],
): Promise<void> {
  const decodedItems = items.flatMap((item) => {
    const decoded = decodeActivityItem(item);
    return decoded === null ? [] : [decoded];
  });
  if (decodedItems.length !== items.length) {
    throw new Error("Activity log contains an invalid item.");
  }
  await publishPrivateNip78(
    privateKeyHex,
    ACTIVITY_LOG_D_TAG,
    JSON.stringify({ items: decodedItems } satisfies ActivityLogPayload),
  );
}

export async function fetchNip78ActivityLog(
  pubkey: string,
  privateKeyHex: string,
): Promise<ActivityItem[] | null> {
  const content = await fetchPrivateNip78Content(pubkey, ACTIVITY_LOG_D_TAG, privateKeyHex);
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as Partial<ActivityLogPayload>;
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items.flatMap((item) => {
      const decoded = decodeActivityItem(item);
      return decoded === null ? [] : [decoded];
    });
  } catch {
    return null;
  }
}
