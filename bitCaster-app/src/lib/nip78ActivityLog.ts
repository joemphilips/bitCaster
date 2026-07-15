/**
 * Encrypted NIP-78 portfolio activity sync for bitCaster.
 *
 * Activity history is user-private operational metadata. Keep it in
 * localStorage for fast reloads, and mirror it to NIP-78 with NIP-44
 * self-encryption so it can be restored on a fresh browser profile.
 */

import type { ActivityItem } from "@/types/portfolio";
import { decodeActivityItems } from "./activityLogCodec";
import { fetchPrivateNip78Content, publishPrivateNip78 } from "./nip78Private";

export const ACTIVITY_LOG_D_TAG_PREFIX = "bitcaster:activity-log" as const;

export function activityLogDTag(walletId: string): string {
  if (!/^[0-9a-f]{64}$/.test(walletId)) {
    throw new Error("Activity sync requires a seed-derived wallet id");
  }
  return `${ACTIVITY_LOG_D_TAG_PREFIX}:${walletId}`;
}

interface ActivityLogPayload {
  items: ActivityItem[];
}

export async function publishNip78ActivityLog(
  privateKeyHex: string,
  walletId: string,
  items: ActivityItem[],
): Promise<void> {
  await publishPrivateNip78(
    privateKeyHex,
    activityLogDTag(walletId),
    JSON.stringify({ items } satisfies ActivityLogPayload),
  );
}

export async function fetchNip78ActivityLog(
  pubkey: string,
  privateKeyHex: string,
  walletId: string,
): Promise<ActivityItem[] | null> {
  const content = await fetchPrivateNip78Content(
    pubkey,
    activityLogDTag(walletId),
    privateKeyHex,
  );
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !("items" in parsed)
    ) {
      return null;
    }
    return decodeActivityItems((parsed as ActivityLogPayload).items);
  } catch {
    return null;
  }
}
