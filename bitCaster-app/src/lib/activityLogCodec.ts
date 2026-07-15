import type { ActivityItem } from "@/types/portfolio";

export const ACTIVITY_LOG_ITEM_LIMIT = 500;

const REQUIRED_FIELDS = [
  "id",
  "type",
  "amountSats",
  "date",
  "status",
  "txId",
  "lightningInvoice",
] as const;
const OPTIONAL_FIELDS = [
  "baseAsset",
  "failureReason",
  "marketId",
  "marketTitle",
  "positionId",
] as const;
const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const ACTIVITY_TYPES = new Set<ActivityItem["type"]>([
  "deposit",
  "withdrawal",
  "Buy",
  "Sell",
  "payout_claimed",
  "creator_fee_claimed",
]);
const ACTIVITY_STATUSES = new Set<ActivityItem["status"]>([
  "pending",
  "completed",
  "Failed",
]);
const BASE_ASSETS = new Set<NonNullable<ActivityItem["baseAsset"]>>([
  "sat",
  "usd",
  "jpy",
]);

export function decodeActivityItem(value: unknown): ActivityItem | null {
  if (!isRecord(value) || !hasExactActivityFields(value)) return null;
  if (
    !isBoundedText(value.id, 1, 512) ||
    typeof value.type !== "string" ||
    !ACTIVITY_TYPES.has(value.type as ActivityItem["type"]) ||
    !Number.isSafeInteger(value.amountSats) ||
    (value.amountSats as number) < 0 ||
    !isCanonicalIsoDate(value.date) ||
    typeof value.status !== "string" ||
    !ACTIVITY_STATUSES.has(value.status as ActivityItem["status"]) ||
    !isNullableBoundedText(value.txId, 4_096) ||
    !isNullableBoundedText(value.lightningInvoice, 16_384) ||
    !isOptionalBaseAsset(value.baseAsset) ||
    !isOptionalBoundedText(value.failureReason, 4_096) ||
    !isOptionalBoundedText(value.marketId, 512) ||
    !isOptionalBoundedText(value.marketTitle, 4_096) ||
    !isOptionalBoundedText(value.positionId, 512)
  ) {
    return null;
  }
  return {
    id: value.id,
    type: value.type as ActivityItem["type"],
    amountSats: value.amountSats as number,
    ...(value.baseAsset === undefined
      ? {}
      : { baseAsset: value.baseAsset as ActivityItem["baseAsset"] }),
    date: value.date as string,
    status: value.status as ActivityItem["status"],
    txId: value.txId as string | null,
    lightningInvoice: value.lightningInvoice as string | null,
    ...(value.failureReason === undefined
      ? {}
      : { failureReason: value.failureReason as string }),
    ...(value.marketId === undefined
      ? {}
      : { marketId: value.marketId as string }),
    ...(value.marketTitle === undefined
      ? {}
      : { marketTitle: value.marketTitle as string }),
    ...(value.positionId === undefined
      ? {}
      : { positionId: value.positionId as string }),
  };
}

/** Invalid items and duplicate ids are omitted; an invalid/oversized list is rejected. */
export function decodeActivityItems(value: unknown): ActivityItem[] | null {
  if (!Array.isArray(value) || value.length > ACTIVITY_LOG_ITEM_LIMIT) {
    return null;
  }
  const decoded: ActivityItem[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const item = decodeActivityItem(candidate);
    if (!item || ids.has(item.id)) continue;
    ids.add(item.id);
    decoded.push(item);
  }
  return decoded;
}

/** Invalid wallet keys and invalid/oversized partitions are omitted. */
export function decodeActivityPartitions(
  value: unknown,
): Record<string, ActivityItem[]> {
  if (!isRecord(value)) return {};
  const partitions: Record<string, ActivityItem[]> = {};
  for (const [walletId, candidate] of Object.entries(value)) {
    if (!/^[0-9a-f]{64}$/.test(walletId)) continue;
    const items = decodeActivityItems(candidate);
    if (items !== null) partitions[walletId] = items;
  }
  return partitions;
}

export function decodePersistedActivityState(value: unknown): {
  itemsByWalletId: Record<string, ActivityItem[]>;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !("itemsByWalletId" in value)
  ) {
    return { itemsByWalletId: {} };
  }
  return { itemsByWalletId: decodeActivityPartitions(value.itemsByWalletId) };
}

function hasExactActivityFields(value: Record<string, unknown>): boolean {
  return (
    REQUIRED_FIELDS.every((field) => field in value) &&
    Object.keys(value).every((field) => KNOWN_FIELDS.has(field))
  );
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isOptionalBaseAsset(
  value: unknown,
): value is ActivityItem["baseAsset"] {
  return (
    value === undefined ||
    (typeof value === "string" &&
      BASE_ASSETS.has(value as NonNullable<ActivityItem["baseAsset"]>))
  );
}

function isOptionalBoundedText(value: unknown, maximum: number): boolean {
  return value === undefined || isBoundedText(value, 0, maximum);
}

function isNullableBoundedText(value: unknown, maximum: number): boolean {
  return value === null || isBoundedText(value, 0, maximum);
}

function isBoundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
