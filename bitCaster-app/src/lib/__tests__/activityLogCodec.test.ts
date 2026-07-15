import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@/types/portfolio";
import {
  ACTIVITY_LOG_ITEM_LIMIT,
  decodeActivityItem,
  decodeActivityItems,
  decodeActivityPartitions,
} from "../activityLogCodec";

const WALLET_ID = "a".repeat(64);

function activity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "activity-1",
    type: "deposit",
    amountSats: 1,
    baseAsset: "sat",
    date: "2026-07-15T00:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    ...overrides,
  };
}

describe("activity log codec", () => {
  it("preserves every valid activity variant and optional field", () => {
    expect(
      decodeActivityItem(
        activity({
          type: "payout_claimed",
          status: "Failed",
          baseAsset: "usd",
          failureReason: "mint unavailable",
          marketId: "market-1",
          marketTitle: "Market title",
          positionId: "position-1",
          txId: "tx-1",
          lightningInvoice: "lnbc1invoice",
        }),
      ),
    ).toEqual(
      activity({
        type: "payout_claimed",
        status: "Failed",
        baseAsset: "usd",
        failureReason: "mint unavailable",
        marketId: "market-1",
        marketTitle: "Market title",
        positionId: "position-1",
        txId: "tx-1",
        lightningInvoice: "lnbc1invoice",
      }),
    );
  });

  it.each([
    ["unknown asset", { baseAsset: "btc" }],
    ["negative amount", { amountSats: -1 }],
    ["fractional amount", { amountSats: 1.5 }],
    ["invalid date", { date: "yesterday" }],
    ["non-canonical date", { date: "2026-07-15T00:00:00Z" }],
    ["oversized id", { id: "i".repeat(513) }],
    ["oversized text", { marketTitle: "m".repeat(4_097) }],
    ["extra field", { unexpected: true }],
  ])("rejects %s", (_name, override) => {
    expect(
      decodeActivityItem({ ...activity(), ...(override as object) }),
    ).toBeNull();
  });

  it("omits invalid items but rejects an oversized remote list", () => {
    expect(
      decodeActivityItems([
        activity({ id: "valid" }),
        activity({ id: "invalid", baseAsset: "btc" as "sat" }),
      ]),
    ).toEqual([activity({ id: "valid" })]);
    expect(
      decodeActivityItems(
        Array.from({ length: ACTIVITY_LOG_ITEM_LIMIT + 1 }, (_, index) =>
          activity({ id: `activity-${index}` }),
        ),
      ),
    ).toBeNull();
  });

  it("omits invalid wallet keys and oversized partitions", () => {
    expect(
      decodeActivityPartitions({
        [WALLET_ID]: [activity()],
        invalid: [activity({ id: "foreign" })],
        ["b".repeat(64)]: Array.from(
          { length: ACTIVITY_LOG_ITEM_LIMIT + 1 },
          (_, index) => activity({ id: `oversized-${index}` }),
        ),
      }),
    ).toEqual({ [WALLET_ID]: [activity()] });
  });
});
