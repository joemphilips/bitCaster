import { describe, expect, it } from "vitest";
import type { OrderStatusResponse } from "../orderStatus";
import {
  buildOrderLifecycleNotifications,
  buildOrderStatusNotifications,
  mapConfirmedTradeActivities,
  splitMarketId,
} from "../orderStatus";

const trade = {
  orderId: "11111111-1111-4111-8111-111111111111",
  marketId: "condition-YES",
  baseAsset: "sat" as const,
  divisibility: 1_000 as const,
  amountSubunits: 10,
};

const walletId = "a".repeat(64);

function fill(
  id: string,
  overrides: Partial<OrderStatusResponse["fills"][number]> = {},
): OrderStatusResponse["fills"][number] {
  return {
    id,
    takerOrderId: trade.orderId,
    makerOrderId: "22222222-2222-4222-8222-222222222222",
    amountSubunits: 2_500,
    executionPrice: 400,
    path: "Complementary",
    status: "Filled",
    baseAsset: "sat",
    divisibility: 1_000,
    quotePaymentSubunits: 1_000,
    outcomeFaceAmountSubunits: 2_500,
    tokenSide: "Outcome",
    filledAt: "2026-09-27T12:00:00.000Z",
    settlementGroup: {
      groupId: "33333333-3333-4333-8333-333333333333",
      status: "Confirmed",
      revision: 2,
      coalescingDeadline: "2026-09-27T11:59:00.000Z",
      frozenAt: "2026-09-27T11:59:01.000Z",
    },
    ...overrides,
  };
}

function orderStatus(overrides: Partial<OrderStatusResponse> = {}): OrderStatusResponse {
  return {
    orderId: trade.orderId,
    marketId: trade.marketId,
    status: "partially_filled",
    remainingAmountSubunits: 2_500,
    filledAmountSubunits: 2_500,
    fills: [fill("44444444-4444-4444-8444-444444444444")],
    amountSubunits: 5_000,
    outcomeId: "YES",
    side: "Buy",
    price: 400,
    placedAt: "2026-09-27T11:58:00.000Z",
    timeInForce: "FOK",
    expiresAt: null,
    tokenSide: "Outcome",
    baseAsset: "sat",
    divisibility: 1_000,
    activeSettlementGroup: null,
    ...overrides,
  };
}

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

describe("mapConfirmedTradeActivities", () => {
  it("maps each confirmed fill with stable identity and exact quote and face values", () => {
    const firstFillId = "44444444-4444-4444-8444-444444444444";
    const secondFillId = "55555555-5555-4555-8555-555555555555";
    const status = orderStatus({
      fills: [
        fill(firstFillId, { quotePaymentSubunits: 1_001, outcomeFaceAmountSubunits: 2_500 }),
        fill(secondFillId, {
          takerOrderId: "66666666-6666-4666-8666-666666666666",
          makerOrderId: trade.orderId,
          quotePaymentSubunits: 997,
          outcomeFaceAmountSubunits: 2_000,
          filledAt: "2026-09-27T12:01:00.000Z",
        }),
      ],
      side: "Sell",
      tokenSide: "Outcome",
    });

    expect(mapConfirmedTradeActivities(status, { walletId, ...trade })).toEqual([
      expect.objectContaining({
        id: `trade:${walletId}:${firstFillId}`,
        walletId,
        type: "Sell",
        amountSubunits: 1_001,
        baseAsset: "sat",
        date: "2026-09-27T12:00:00.000Z",
        status: "completed",
        marketId: trade.marketId,
        tradeDetails: {
          orderId: trade.orderId,
          fillId: firstFillId,
          outcomeId: "YES",
          tokenSide: "Outcome",
          faceAmountSubunits: 2_500,
          divisibility: 1_000,
        },
      }),
      expect.objectContaining({
        id: `trade:${walletId}:${secondFillId}`,
        amountSubunits: 997,
        date: "2026-09-27T12:01:00.000Z",
        tradeDetails: expect.objectContaining({ faceAmountSubunits: 2_000 }),
      }),
    ]);
  });

  it.each([
    ["matched fill", fill("44444444-4444-4444-8444-444444444444", { status: "Matched" })],
    ["failed fill", fill("44444444-4444-4444-8444-444444444444", { status: "Failed" })],
    [
      "matched fill in a confirmed group",
      fill("44444444-4444-4444-8444-444444444444", {
        status: "Matched",
        settlementGroup: {
          groupId: "33333333-3333-4333-8333-333333333333",
          status: "Confirmed",
          revision: 2,
          coalescingDeadline: "2026-09-27T11:59:00.000Z",
          frozenAt: "2026-09-27T11:59:01.000Z",
        },
      }),
    ],
    [
      "fill for another order",
      fill("44444444-4444-4444-8444-444444444444", {
        takerOrderId: "66666666-6666-4666-8666-666666666666",
        makerOrderId: "77777777-7777-4777-8777-777777777777",
      }),
    ],
  ] as const)("does not map a %s as completed activity", (_name, notConfirmed) => {
    expect(
      mapConfirmedTradeActivities(orderStatus({ fills: [notConfirmed] }), {
        walletId,
        ...trade,
      }),
    ).toEqual([]);
  });

  it.each([
    ["different order", orderStatus({ orderId: "88888888-8888-4888-8888-888888888888" })],
    ["different market", orderStatus({ marketId: "condition-NO" })],
  ] as const)("rejects a response for a %s", (_name, response) => {
    expect(mapConfirmedTradeActivities(response, { walletId, ...trade })).toEqual([]);
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
