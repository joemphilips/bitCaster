/**
 * Encrypted NIP-78 portfolio activity sync for bitCaster.
 *
 * Activity history is user-private operational metadata. Keep it in
 * localStorage for fast reloads, and mirror it to NIP-78 with NIP-44
 * self-encryption so it can be restored on a fresh browser profile.
 */

import type { ActivityItem, ActivityStatus, ActivityType } from "@/types/portfolio";
import { fetchPrivateNip78Content, publishPrivateNip78 } from "./nip78Private";

export const ACTIVITY_LOG_D_TAG = "bitcaster:activity-log" as const;

interface ActivityLogPayload {
  items: ActivityItem[];
}

const ACTIVITY_TYPES = new Set<ActivityType>([
  "deposit",
  "withdrawal",
  "Buy",
  "Sell",
  "payout_claimed",
  "creator_fee_claimed",
]);

const ACTIVITY_STATUSES = new Set<ActivityStatus>(["pending", "completed", "Failed"]);

function isActivityItem(value: unknown): value is ActivityItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.type === "string" &&
    ACTIVITY_TYPES.has(item.type as ActivityType) &&
    typeof item.amountSats === "number" &&
    typeof item.date === "string" &&
    typeof item.status === "string" &&
    ACTIVITY_STATUSES.has(item.status as ActivityStatus) &&
    (item.txId === null || typeof item.txId === "string") &&
    (item.lightningInvoice === null || typeof item.lightningInvoice === "string") &&
    (item.failureReason === undefined || typeof item.failureReason === "string") &&
    (item.marketId === undefined || typeof item.marketId === "string") &&
    (item.marketTitle === undefined || typeof item.marketTitle === "string") &&
    (item.positionId === undefined || typeof item.positionId === "string")
  );
}

export async function publishNip78ActivityLog(
  privateKeyHex: string,
  items: ActivityItem[],
): Promise<void> {
  await publishPrivateNip78(
    privateKeyHex,
    ACTIVITY_LOG_D_TAG,
    JSON.stringify({ items } satisfies ActivityLogPayload),
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
    return parsed.items.filter(isActivityItem);
  } catch {
    return null;
  }
}
