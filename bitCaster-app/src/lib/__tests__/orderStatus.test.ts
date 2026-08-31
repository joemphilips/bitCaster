import { describe, expect, it } from "vitest";
import type { OrderStatusResponse } from "../orderStatus";
import {
  buildOrderLifecycleNotifications,
  buildOrderStatusNotifications,
  splitMarketId,
} from "../orderStatus";

const trade = {
  orderId: "11111111-1111-4111-8111-111111111111",
  marketId: "condition-YES",
  baseAsset: "sat" as const,
  divisibility: 1_000 as const,
  amountSubunits: 10,
};

function status(
  value: OrderStatusResponse["status"],
  filledAmountSubunits: number,
  remainingAmountSubunits: number,
): OrderStatusResponse {
  return { status: value, filledAmountSubunits, remainingAmountSubunits } as OrderStatusResponse;
}

describe("order lifecycle notifications", () => {
  it.each([
    ["matched", "Matched", 3, 7],
    ["partially_filled", "partially_filled", 4, 6],
    ["filled", "Filled", 10, 0],
    ["failed", "Failed", 2, 8],
    ["evicted_capacity", "evicted_capacity", 0, 10],
    ["rejected_capacity", "rejected_capacity", 0, 10],
  ] as const)(
    "maps %s from the authoritative status response",
    (value, kind, filled, remaining) => {
      expect(buildOrderStatusNotifications(status(value, filled, remaining), trade, 1)).toEqual([
        expect.objectContaining({
          kind,
          filledAmountSubunits: filled,
          remainingAmountSubunits: remaining,
        }),
      ]);
    },
  );

  it("derives filled amount from a lifecycle delta", () => {
    expect(buildOrderLifecycleNotifications("partially_filled", 6, trade, 1)).toEqual([
      expect.objectContaining({ filledAmountSubunits: 4, remainingAmountSubunits: 6 }),
    ]);
  });
});

describe("splitMarketId", () => {
  it("splits on the last hyphen so condition ids with hyphens survive", () => {
    expect(splitMarketId("deadbeef-Alice")).toEqual({
      conditionId: "deadbeef",
      outcomeName: "Alice",
    });
    expect(splitMarketId("cond-123-Alice")).toEqual({
      conditionId: "cond-123",
      outcomeName: "Alice",
    });
  });

  it("returns null for inputs without a usable separator", () => {
    expect(splitMarketId("noseparator")).toBeNull();
    expect(splitMarketId("-leadingDash")).toBeNull();
    expect(splitMarketId("trailingDash-")).toBeNull();
  });
});
