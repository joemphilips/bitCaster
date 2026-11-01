import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import { addOrderSubmitNotifications } from "../orderNotifications";
import {
  buildOrderLifecycleNotifications,
  buildOrderStatusNotifications,
  type OrderStatusResponse,
} from "../orderStatus";

describe("one bell entry for each order transition", () => {
  const orderId = "881ac8f5-0000-4000-8000-000000000000";
  const trade = {
    orderId,
    marketId: `${"c".repeat(64)}-Yes`,
    baseAsset: "sat" as const,
    divisibility: 1_000 as const,
    amountSubunits: 10_000,
  };

  beforeEach(() => {
    useNotificationsStore.setState({ items: [] });
  });

  // The submit response, the order hub delta and the status read all report
  // the same transition. The bell must show it once.
  it.each([
    ["matched", "Matched", 0],
    ["partially_filled", "partially_filled", 4_000],
  ] as const)(
    "keeps one %s entry when the hub and the status read repeat the submit result",
    (status, kind, remainingAmountSubunits) => {
      const add = useNotificationsStore.getState().add;
      addOrderSubmitNotifications({
        add,
        orderId,
        marketId: trade.marketId,
        requestedAmountSubunits: trade.amountSubunits,
        remainingAmountSubunits,
        fillCount: 1,
        status,
        now: 1,
      });
      for (const notification of buildOrderLifecycleNotifications(
        status,
        remainingAmountSubunits,
        trade,
        2,
      ))
        add(notification);
      for (const notification of buildOrderStatusNotifications(
        {
          status,
          remainingAmountSubunits,
          filledAmountSubunits: trade.amountSubunits - remainingAmountSubunits,
        } as OrderStatusResponse,
        trade,
        3,
      ))
        add(notification);

      const items = useNotificationsStore.getState().items;
      expect(items.filter((item) => item.kind === kind)).toHaveLength(1);
      expect(items.filter((item) => item.kind === "accepted")).toHaveLength(1);
    },
  );
});

describe("addOrderSubmitNotifications", () => {
  it("adds accepted plus filled notification for an immediately matched order", () => {
    const add = vi.fn<(notification: Notification) => void>();

    addOrderSubmitNotifications({
      add,
      orderId: "order-1",
      marketId: "cond-YES",
      requestedAmountSubunits: 100,
      remainingAmountSubunits: 0,
      fillCount: 1,
      now: 123,
    });

    expect(add.mock.calls.map(([notification]) => notification.kind)).toEqual([
      "accepted",
      "Filled",
    ]);
    expect(add.mock.calls[1][0]).toMatchObject({
      id: "order-1-filled",
      filledAmountSubunits: 100,
      remainingAmountSubunits: 0,
    });
  });

  it("adds accepted plus partial-fill notification when the order keeps resting", () => {
    const add = vi.fn<(notification: Notification) => void>();

    addOrderSubmitNotifications({
      add,
      orderId: "order-1",
      marketId: "cond-YES",
      requestedAmountSubunits: 200,
      remainingAmountSubunits: 100,
      fillCount: 1,
      now: 123,
    });

    expect(add.mock.calls.map(([notification]) => notification.kind)).toEqual([
      "accepted",
      "partially_filled",
    ]);
    expect(add.mock.calls[1][0]).toMatchObject({
      id: "order-1-partially_filled-100",
      filledAmountSubunits: 100,
      remainingAmountSubunits: 100,
    });
  });

  it("adds accepted plus matched notification for a pending reservation", () => {
    const add = vi.fn<(notification: Notification) => void>();

    addOrderSubmitNotifications({
      add,
      orderId: "order-1",
      marketId: "cond-YES",
      requestedAmountSubunits: 100,
      remainingAmountSubunits: 0,
      fillCount: 1,
      status: "matched",
      now: 123,
    });

    expect(add.mock.calls.map(([notification]) => notification.kind)).toEqual([
      "accepted",
      "Matched",
    ]);
    expect(add.mock.calls[1][0]).toMatchObject({
      id: "order-1-matched-0",
      filledAmountSubunits: 100,
      remainingAmountSubunits: 0,
    });
  });

  it("does not invent a fill notification for a resting order", () => {
    const add = vi.fn<(notification: Notification) => void>();

    addOrderSubmitNotifications({
      add,
      orderId: "order-1",
      marketId: "cond-YES",
      requestedAmountSubunits: 200,
      remainingAmountSubunits: 200,
      fillCount: 0,
      now: 123,
    });

    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0][0].kind).toBe("accepted");
  });
});
