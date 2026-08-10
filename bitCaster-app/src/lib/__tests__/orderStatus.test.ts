import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationsStore } from "@/stores/notifications";
import { usePendingTradesStore } from "@/stores/pendingTrades";

const { mockGenerateNip98Header } = vi.hoisted(() => ({
  mockGenerateNip98Header: vi.fn(),
}));

vi.mock("../markets", () => ({
  generateNip98Header: mockGenerateNip98Header,
}));

import {
  buildOrderStatusNotifications,
  fetchOrderStatus,
  splitMarketId,
  usePendingTradesPoller,
  type OrderStatusResponse,
} from "../orderStatus";

describe("fetchOrderStatus", () => {
  beforeEach(() => {
    mockGenerateNip98Header.mockReset();
    mockGenerateNip98Header.mockResolvedValue("Nostr token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("signs the private order-status poll with NIP-98", async () => {
    const body: OrderStatusResponse = {
      orderId: "bfe9f76c-0993-47c1-a301-a7d4022f8272",
      marketId: "deadbeef-YES",
      status: "resting",
      remainingAmountSubunits: 100,
      filledAmountSubunits: 0,
      fills: [],
      amountSubunits: 100,
      outcomeId: "YES",
      side: "Buy",
      price: 5_000,
      placedAt: "2026-07-31T00:00:00Z",
      timeInForce: "FAK",
      tokenSide: "Outcome",
      baseAsset: "sat",
      divisibility: 10_000,
      activeSettlementGroup: null,
      continuation: null,
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchOrderStatus("deadbeef-YES", body.orderId);
    const url = `${window.location.origin}/api/v1/deadbeef-YES/orders/${body.orderId}`;

    expect(result).toEqual(body);
    expect(mockGenerateNip98Header).toHaveBeenCalledWith(url, "GET");
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Authorization: "Nostr token" },
    });
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
    expect(splitMarketId("no-separator-at-start".replace(/-/g, ""))).toBeNull();
    expect(splitMarketId("-leadingDash")).toBeNull();
    expect(splitMarketId("trailingDash-")).toBeNull();
    expect(splitMarketId("")).toBeNull();
  });
});

describe("buildOrderStatusNotifications", () => {
  it("notifies on a mint match-shaped settlement handle", () => {
    const status = {
      ...orderStatusWithFillIds("fill-a"),
      status: "matched",
      remainingAmountSubunits: 100,
      filledAmountSubunits: 100,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 0, 123);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "order-1-matched-1",
      kind: "Matched",
      filledAmountSubunits: 100,
      remainingAmountSubunits: 100,
      occurredAt: 123,
    });
  });

  it("does not notify again for the same fill snapshot", () => {
    const status = {
      ...orderStatusWithFillIds("fill-a"),
      filledAmountSubunits: 100,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 1, 123);

    expect(notifications).toEqual([]);
  });

  it("notifies when an order is cancelled by market close", () => {
    const status = {
      ...orderStatusWithFillIds(),
      status: "cancelled",
      remainingAmountSubunits: 100,
      filledAmountSubunits: 0,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 0, 123);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "order-1-cancelled",
      kind: "cancelled",
      remainingAmountSubunits: 100,
      occurredAt: 123,
    });
  });

  it("notifies when an order settlement fails terminally", () => {
    const status = {
      ...orderStatusWithFillIds("fill-a"),
      status: "failed",
      remainingAmountSubunits: 0,
      filledAmountSubunits: 0,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 1, 123);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "order-1-failed",
      kind: "Failed",
      filledAmountSubunits: 0,
      remainingAmountSubunits: 0,
      occurredAt: 123,
    });
  });

  it("preserves a capacity rejection as a distinct terminal reason", () => {
    const status = {
      ...orderStatusWithFillIds(),
      status: "rejected_capacity",
      remainingAmountSubunits: 100,
      filledAmountSubunits: 0,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 0, 123);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "order-1-rejected_capacity",
      kind: "rejected_capacity",
      remainingAmountSubunits: 100,
      occurredAt: 123,
    });
  });

  it("carries the sat product unit onto the notification", () => {
    const status = {
      ...orderStatusWithFillIds("fill-a"),
      status: "filled",
      filledAmountSubunits: 50,
      remainingAmountSubunits: 0,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 0, 123);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "Filled",
      unit: "sat",
    });
  });

  it("treats lower-case filled status from the wire contract as terminal", () => {
    const status = {
      ...orderStatusWithFillIds("fill-a"),
      status: "filled",
      filledAmountSubunits: 100,
      remainingAmountSubunits: 0,
    } as OrderStatusResponse;

    const notifications = buildOrderStatusNotifications(status, pendingTrade(), 0, 123);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: "order-1-filled",
      kind: "Filled",
      filledAmountSubunits: 100,
      remainingAmountSubunits: 0,
      occurredAt: 123,
    });
  });
});

describe("usePendingTradesPoller", () => {
  beforeEach(() => {
    mockGenerateNip98Header.mockReset();
    mockGenerateNip98Header.mockResolvedValue("Nostr token");
    useNotificationsStore.setState({ items: [] });
    usePendingTradesStore.setState({ byOrderId: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retains a terminal order with fills until settlement recovery completes", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const orderId = "11111111-1111-4111-8111-111111111111";
    const settlementGroup = {
      groupId: "44444444-4444-4444-8444-444444444444",
      status: "Confirmed" as const,
      revision: 1,
      coalescingDeadline: "2026-08-10T00:00:00.000Z",
      frozenAt: "2026-08-10T00:00:01.000Z",
    };
    const status: OrderStatusResponse = {
      orderId,
      marketId: "condition-YES",
      status: "filled",
      remainingAmountSubunits: 0,
      filledAmountSubunits: 10,
      fills: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          makerOrderId: orderId,
          takerOrderId: "22222222-2222-4222-8222-222222222222",
          amountSubunits: 10,
          executionPrice: 5_000,
          path: "Complementary",
          status: "Filled",
          filledAt: "2026-08-10T00:00:02.000Z",
          settlementGroup,
          baseAsset: "sat",
          divisibility: 10_000,
          tokenSide: "Outcome",
          quotePaymentSubunits: 5,
          outcomeFaceAmountSubunits: 10,
        },
      ],
      amountSubunits: 10,
      outcomeId: "YES",
      side: "Buy",
      price: 5_000,
      placedAt: "2026-08-10T00:00:00.000Z",
      timeInForce: "FAK",
      tokenSide: "Outcome",
      baseAsset: "sat",
      divisibility: 10_000,
      activeSettlementGroup: settlementGroup,
      continuation: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify(status), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    usePendingTradesStore.getState().add({
      ...pendingTrade(),
      orderId,
      marketId: "condition-YES",
      submittedAt: Date.now(),
    });
    const { unmount } = renderHook(() => usePendingTradesPoller());

    await waitFor(() =>
      expect(
        useNotificationsStore.getState().items.some((item) => item.id === `${orderId}-filled`),
      ).toBe(true),
    );
    expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
    unmount();
  });
});

function pendingTrade() {
  return {
    orderId: "order-1",
    clientOrderId: "client-order-1",
    marketId: "market-1",
    baseAsset: "sat" as const,
    divisibility: 10_000 as const,
  };
}

function orderStatusWithFillIds(...fillIds: string[]): OrderStatusResponse {
  return {
    orderId: "order-1",
    marketId: "market-1",
    status: "partially_filled",
    remainingAmountSubunits: 100,
    filledAmountSubunits: fillIds.length * 10,
    fills: fillIds.map((id) => ({ id })),
  } as unknown as OrderStatusResponse;
}
