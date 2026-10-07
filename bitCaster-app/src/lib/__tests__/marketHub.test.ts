import { beforeEach, describe, expect, it, vi } from "vitest";

const signalrMock = vi.hoisted(() => {
  const connection = {
    state: "Disconnected",
    start: vi.fn(async () => {
      connection.state = "Connected";
    }),
    stop: vi.fn(async () => {
      connection.state = "Disconnected";
    }),
    invoke: vi.fn(async (_method: string, ..._args: unknown[]) => undefined),
    on: vi.fn(),
    onreconnected: vi.fn((handler: () => void) => {
      connection.reconnectedHandler = handler;
    }),
    reconnectedHandler: undefined as undefined | (() => void),
  };

  const registeredHandlers = new Map<string, (payload: unknown) => void>();
  connection.on.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
    registeredHandlers.set(eventName, handler);
  });

  return { connection, registeredHandlers };
});

vi.mock("@microsoft/signalr", () => ({
  HubConnectionBuilder: class {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    build() {
      return signalrMock.connection;
    }
  },
  HubConnectionState: {
    Connected: "Connected",
    Disconnected: "Disconnected",
    Reconnecting: "Reconnecting",
  },
}));

import {
  applyConfirmedTradeDelta,
  disconnect,
  joinMarket,
  onConfirmedTradeRecorded,
  onMarketCommentsChanged,
  onMarketFundingUpdated,
  onMarketRejoined,
  observePortfolioValuations,
  parseConfirmedTradeRecorded,
  parseMarketFundingUpdated,
  refreshMarketSnapshot,
  leaveMarket,
  type ConfirmedTradeRecordedMessage,
  type LatestConfirmedTrade,
  type MarketFundingUpdatedMessage,
} from "../marketHub";

function confirmedTrade(overrides: Partial<LatestConfirmedTrade> = {}): LatestConfirmedTrade {
  return {
    primitiveOutcomeId: "YES",
    fillId: "00000000-0000-0000-0000-000000000001",
    executedAt: "2026-08-18T00:00:00Z",
    eventOrder: "0001",
    priceTick: 620,
    divisibility: 1_000,
    faceAmountSubunits: 1000,
    ...overrides,
  };
}

function tradeMessage(
  trade: LatestConfirmedTrade,
  conditionId = "cond",
): ConfirmedTradeRecordedMessage {
  return { conditionId, latestConfirmedTrade: trade };
}

function fundingMessage(
  overrides: Partial<MarketFundingUpdatedMessage> = {},
): MarketFundingUpdatedMessage {
  return {
    conditionId: "cond",
    ammBotBudgetSubunits: 5_000,
    fundingRevision: "0001",
    ...overrides,
  };
}

const ALLOWED_OUTCOME_IDS = ["YES", "NO"] as const;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function flushTaskQueue(): Promise<void> {
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
}

beforeEach(async () => {
  await disconnect();
  signalrMock.connection.state = "Disconnected";
  signalrMock.connection.start.mockClear();
  signalrMock.connection.stop.mockClear();
  signalrMock.connection.invoke.mockReset();
  signalrMock.connection.invoke.mockImplementation(async () => undefined);
  signalrMock.connection.on.mockClear();
  signalrMock.connection.onreconnected.mockClear();
  signalrMock.connection.reconnectedHandler = undefined;
  signalrMock.registeredHandlers.clear();
});

describe("joinMarket reconnect recovery", () => {
  it("does not treat reservation-time Matched as a confirmed trade", async () => {
    await joinMarket("cond-YES");

    expect(signalrMock.registeredHandlers.has("Matched")).toBe(false);
  });

  it("tracks desired joins before invoking so failed reconnecting joins are retried after reconnect", async () => {
    await joinMarket("cond-YES");
    signalrMock.connection.invoke.mockClear();
    signalrMock.connection.invoke.mockRejectedValueOnce(new Error("reconnecting"));
    signalrMock.connection.state = "Reconnecting";

    await expect(joinMarket("cond-NO")).rejects.toThrow("reconnecting");

    signalrMock.connection.invoke.mockResolvedValue(undefined);
    signalrMock.connection.state = "Connected";
    signalrMock.connection.reconnectedHandler?.();
    await Promise.resolve();

    expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", "cond-YES");
    expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", "cond-NO");
  });

  it("invokes the authoritative REST repair seam after reconnect and rejoin", async () => {
    await joinMarket("cond-YES");
    const refreshMarket = vi.fn();
    onMarketRejoined("cond-YES", refreshMarket);

    signalrMock.connection.reconnectedHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(signalrMock.connection.invoke).toHaveBeenCalledWith("JoinMarket", "cond-YES");
    expect(refreshMarket).toHaveBeenCalledTimes(1);
  });

  it("refreshes an existing group snapshot without incrementing the join reference count", async () => {
    await joinMarket("cond-YES");
    signalrMock.connection.invoke.mockClear();

    await refreshMarketSnapshot("cond-YES");
    await leaveMarket("cond-YES");

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["JoinMarket", "cond-YES"],
      ["LeaveMarket", "cond-YES"],
    ]);
  });

  it("drains each in-flight wake into a later snapshot without changing the subscription count", async () => {
    await joinMarket("cond-YES");
    signalrMock.connection.invoke.mockClear();
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    let invocation = 0;
    signalrMock.connection.invoke.mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) {
        await new Promise<undefined>((resolve) => {
          resolveFirst = () => resolve(undefined);
        });
      } else if (invocation === 2) {
        await new Promise<undefined>((resolve) => {
          resolveSecond = () => resolve(undefined);
        });
      }
      return undefined;
    });

    const first = refreshMarketSnapshot("cond-YES");
    await Promise.resolve();
    expect(signalrMock.connection.invoke).toHaveBeenCalledOnce();
    const secondWake = refreshMarketSnapshot("cond-YES");
    resolveFirst?.();
    await flushMicrotasks();
    expect(signalrMock.connection.invoke).toHaveBeenCalledTimes(2);
    const thirdWake = refreshMarketSnapshot("cond-YES");
    resolveSecond?.();
    await Promise.all([first, secondWake, thirdWake]);
    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["JoinMarket", "cond-YES"],
      ["JoinMarket", "cond-YES"],
      ["JoinMarket", "cond-YES"],
    ]);
    await leaveMarket("cond-YES");
    expect(signalrMock.connection.invoke).toHaveBeenLastCalledWith("LeaveMarket", "cond-YES");
  });

  it("cancels a requested trailing snapshot when the last subscriber leaves", async () => {
    await joinMarket("cond-YES");
    signalrMock.connection.invoke.mockClear();
    let resolveInvoke: (() => void) | undefined;
    signalrMock.connection.invoke.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInvoke = () => resolve(undefined);
        }),
    );

    const first = refreshMarketSnapshot("cond-YES");
    await Promise.resolve();
    const duplicate = refreshMarketSnapshot("cond-YES");
    await leaveMarket("cond-YES");
    resolveInvoke?.();
    await Promise.all([first, duplicate]);

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["JoinMarket", "cond-YES"],
      ["LeaveMarket", "cond-YES"],
    ]);
  });

  it("does not create a group when asked to refresh a market this client did not join", async () => {
    await refreshMarketSnapshot("cond-YES");

    expect(signalrMock.connection.start).not.toHaveBeenCalled();
    expect(signalrMock.connection.invoke).not.toHaveBeenCalled();
  });
});

describe("Portfolio valuation subscriptions", () => {
  it("sorts and deduplicates exact-case IDs on the condition-only hub method", async () => {
    const onRefresh = vi.fn();
    const observer = observePortfolioValuations(onRefresh);

    await observer.replaceConditionIds(["b", "A", "b"]);

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", ["A", "b"]],
    ]);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("accepts a 200-entry raw set and a 128-character hexadecimal ID", async () => {
    const conditionIds = [
      "F".repeat(128),
      ...Array.from({ length: 199 }, (_, index) => (index + 1).toString(16)),
    ];
    const observer = observePortfolioValuations(vi.fn());

    await observer.replaceConditionIds(conditionIds);

    expect(signalrMock.connection.invoke).toHaveBeenCalledOnce();
    expect(signalrMock.connection.invoke.mock.calls[0]?.[0]).toBe(
      "SetPortfolioValuationSubscriptions",
    );
    expect(signalrMock.connection.invoke.mock.calls[0]?.[1]).toHaveLength(200);
    expect(signalrMock.connection.invoke.mock.calls[0]?.[1]).toContain("F".repeat(128));
  });

  it("accepts an empty replacement and removes it when the current observer leaves", async () => {
    const observer = observePortfolioValuations(vi.fn());

    await observer.replaceConditionIds([]);
    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", []],
    ]);

    await observer.replaceConditionIds(["ab"]);
    signalrMock.connection.invoke.mockClear();
    observer.dispose();
    await flushTaskQueue();

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", []],
    ]);
  });

  it("rejects oversized raw sets and malformed IDs before starting the connection", () => {
    const observer = observePortfolioValuations(vi.fn());
    const invalidSets = [
      Array.from({ length: 201 }, () => "a"),
      [""],
      ["not-hex"],
      ["a".repeat(129)],
    ];

    for (const conditionIds of invalidSets) {
      expect(() => observer.replaceConditionIds(conditionIds)).toThrow();
    }
    expect(signalrMock.connection.start).not.toHaveBeenCalled();
    expect(signalrMock.connection.invoke).not.toHaveBeenCalled();
  });

  it("serializes replacements and coalesces pending changes to the latest set", async () => {
    let finishFirstInvoke: (() => void) | undefined;
    let firstInvokeStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstInvokeStarted = resolve;
    });
    signalrMock.connection.invoke.mockImplementationOnce(() => {
      firstInvokeStarted();
      return new Promise<undefined>((resolve) => {
        finishFirstInvoke = () => resolve(undefined);
      });
    });
    const onRefresh = vi.fn();
    const observer = observePortfolioValuations(onRefresh);

    const first = observer.replaceConditionIds(["a"]);
    await firstStarted;
    const second = observer.replaceConditionIds(["b"]);
    const third = observer.replaceConditionIds(["cc"]);
    finishFirstInvoke?.();
    await Promise.all([first, second, third]);

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", ["a"]],
      ["SetPortfolioValuationSubscriptions", ["cc"]],
    ]);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("does not invoke or reconcile again for an unchanged set on the same connection", async () => {
    const onRefresh = vi.fn();
    const observer = observePortfolioValuations(onRefresh);
    await observer.replaceConditionIds(["b", "A"]);
    signalrMock.connection.invoke.mockClear();
    onRefresh.mockClear();

    await observer.replaceConditionIds(["A", "b", "A"]);

    expect(signalrMock.connection.invoke).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("resends the desired set and notifies after reconnect completion", async () => {
    const onRefresh = vi.fn();
    const observer = observePortfolioValuations(onRefresh);
    await observer.replaceConditionIds(["a", "B"]);
    signalrMock.connection.invoke.mockClear();
    onRefresh.mockClear();

    signalrMock.connection.reconnectedHandler?.();
    await flushTaskQueue();

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", ["B", "a"]],
    ]);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("reuses confirmed-trade and market-status handlers without joining order books", async () => {
    const onRefresh = vi.fn();
    const observer = observePortfolioValuations(onRefresh);
    await observer.replaceConditionIds(["a"]);
    signalrMock.connection.invoke.mockClear();
    onRefresh.mockClear();

    signalrMock.registeredHandlers.get("ConfirmedTradeRecorded")?.(
      tradeMessage(confirmedTrade(), "a"),
    );
    signalrMock.registeredHandlers.get("MarketStatusChanged")?.({ conditionId: "a" });

    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(signalrMock.connection.invoke).not.toHaveBeenCalled();
  });

  it("ignores an older observer cleanup after a newer observer takes ownership", async () => {
    const oldObserver = observePortfolioValuations(vi.fn());
    await oldObserver.replaceConditionIds(["a"]);
    const newRefresh = vi.fn();
    const newObserver = observePortfolioValuations(newRefresh);
    const replacement = newObserver.replaceConditionIds(["b"]);
    oldObserver.dispose();
    await replacement;
    signalrMock.connection.invoke.mockClear();

    newObserver.dispose();
    await flushTaskQueue();

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", []],
    ]);
    expect(newRefresh).toHaveBeenCalledOnce();
  });

  it("reuses an applied set when a new observer replaces a queued unsubscribe", async () => {
    const oldObserver = observePortfolioValuations(vi.fn());
    await oldObserver.replaceConditionIds(["a"]);
    signalrMock.connection.invoke.mockClear();
    oldObserver.dispose();

    const newRefresh = vi.fn();
    const newObserver = observePortfolioValuations(newRefresh);
    await newObserver.replaceConditionIds(["a"]);
    await flushTaskQueue();

    expect(signalrMock.connection.invoke).not.toHaveBeenCalled();
    expect(newRefresh).toHaveBeenCalledOnce();
  });

  it("reuses same-set membership when a new observer replaces a queued cleanup", async () => {
    let finishFirstInvoke: (() => void) | undefined;
    let firstInvokeStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstInvokeStarted = resolve;
    });
    signalrMock.connection.invoke.mockImplementationOnce(() => {
      firstInvokeStarted();
      return new Promise<undefined>((resolve) => {
        finishFirstInvoke = () => resolve(undefined);
      });
    });
    const oldObserver = observePortfolioValuations(vi.fn());
    const oldReplacement = oldObserver.replaceConditionIds(["a"]);
    await firstStarted;
    oldObserver.dispose();

    const newRefresh = vi.fn();
    const newObserver = observePortfolioValuations(newRefresh);
    const newReplacement = newObserver.replaceConditionIds(["a"]);
    finishFirstInvoke?.();
    await Promise.all([oldReplacement, newReplacement]);
    await flushTaskQueue();

    expect(signalrMock.connection.invoke.mock.calls).toEqual([
      ["SetPortfolioValuationSubscriptions", ["a"]],
    ]);
    expect(newRefresh).toHaveBeenCalledOnce();
  });

  it("rejects a failed current replacement without notifying the observer", async () => {
    signalrMock.connection.invoke.mockRejectedValueOnce(new Error("subscription failed"));
    const onRefresh = vi.fn();
    const observer = observePortfolioValuations(onRefresh);

    await expect(observer.replaceConditionIds(["a"])).rejects.toThrow("subscription failed");

    expect(onRefresh).not.toHaveBeenCalled();
    expect(signalrMock.connection.invoke).toHaveBeenCalledWith(
      "SetPortfolioValuationSubscriptions",
      ["a"],
    );
  });
});

describe("MarketCommentsChanged invalidation", () => {
  it("routes opaque committed positions and removes each subscription", async () => {
    await joinMarket("cond-YES");
    const handler = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const removeFirst = onMarketCommentsChanged("cond", handler);
    const removeSecond = onMarketCommentsChanged("cond", second);
    const removeOther = onMarketCommentsChanged("other", other);
    const notify = signalrMock.registeredHandlers.get("MarketCommentsChanged")!;
    for (const payload of [
      null,
      {},
      { conditionId: "cond" },
      { conditionId: "cond", eventOrder: "" },
    ])
      notify(payload);
    expect(handler).not.toHaveBeenCalled();
    const message = { conditionId: "cond", eventOrder: "opaque z/a" };
    notify(message);
    expect(handler).toHaveBeenCalledWith(message);
    expect(second).toHaveBeenCalledWith(message);
    expect(other).not.toHaveBeenCalled();
    removeFirst();
    notify(message);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    removeSecond();
    removeOther();
    notify(message);
    expect(second).toHaveBeenCalledTimes(2);
    await disconnect();
  });
});

describe("ConfirmedTradeRecorded live deltas", () => {
  it("subscribes to the committed event and dispatches only the matching condition", async () => {
    await joinMarket("cond-YES");
    const handler = vi.fn();
    onConfirmedTradeRecorded("cond", handler);
    const trade = confirmedTrade();

    signalrMock.registeredHandlers.get("ConfirmedTradeRecorded")?.(tradeMessage(trade));
    signalrMock.registeredHandlers.get("ConfirmedTradeRecorded")?.({
      ...tradeMessage(trade, "other-condition"),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(tradeMessage(trade));
  });

  it("deduplicates by fill ID, ignores older event order, and accepts a newer event", () => {
    const first = confirmedTrade();
    const current = applyConfirmedTradeDelta("cond", ALLOWED_OUTCOME_IDS, [], tradeMessage(first));
    const duplicate = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      current,
      tradeMessage(first),
    );
    const older = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      duplicate,
      tradeMessage({ ...first, eventOrder: "0000", priceTick: 1000 }),
    );
    const newerTrade = {
      ...first,
      fillId: "00000000-0000-0000-0000-000000000002",
      eventOrder: "0002",
      priceTick: 700,
    };
    const newer = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      older,
      tradeMessage(newerTrade),
    );
    const conflictingDuplicate = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      newer,
      tradeMessage({ ...newerTrade, eventOrder: "0003", priceTick: 800 }),
    );

    expect(current).toEqual([first]);
    expect(duplicate).toEqual([first]);
    expect(older).toEqual([first]);
    expect(newer).toEqual([newerTrade]);
    expect(conflictingDuplicate).toEqual([newerTrade]);
  });

  it("keeps accepted deltas in wrapper event order and ignores another condition", () => {
    const later = confirmedTrade({
      primitiveOutcomeId: "NO",
      fillId: "fill-2",
      eventOrder: "0002",
    });
    const earlier = confirmedTrade({
      primitiveOutcomeId: "YES",
      fillId: "fill-1",
      eventOrder: "0001",
    });
    const current = applyConfirmedTradeDelta("cond", ALLOWED_OUTCOME_IDS, [], tradeMessage(later));
    const ordered = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      current,
      tradeMessage(earlier),
    );
    const wrongCondition = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      ordered,
      tradeMessage(confirmedTrade({ fillId: "fill-3", eventOrder: "0003" }), "other"),
    );

    expect(ordered.map((trade) => trade.fillId)).toEqual(["fill-1", "fill-2"]);
    expect(wrongCondition).toEqual(ordered);
  });

  it("keeps one latest record per primitive outcome while accepting distinct outcomes", () => {
    let current: LatestConfirmedTrade[] = [];
    for (let index = 1; index <= 25; index += 1) {
      current = applyConfirmedTradeDelta(
        "cond",
        ALLOWED_OUTCOME_IDS,
        current,
        tradeMessage(
          confirmedTrade({
            fillId: `yes-fill-${index}`,
            eventOrder: String(index).padStart(4, "0"),
            priceTick: 100 + index,
          }),
        ),
      );
    }
    current = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      current,
      tradeMessage(
        confirmedTrade({ primitiveOutcomeId: "NO", fillId: "no-fill", eventOrder: "0026" }),
      ),
    );

    expect(current).toHaveLength(2);
    expect(current.find((trade) => trade.primitiveOutcomeId === "YES")?.fillId).toBe("yes-fill-25");
    expect(current.find((trade) => trade.primitiveOutcomeId === "NO")?.fillId).toBe("no-fill");
  });

  it("rejects unknown primitive outcomes without growing the bounded overlay", () => {
    const yes = confirmedTrade({ fillId: "yes-fill", eventOrder: "0001" });
    let current = applyConfirmedTradeDelta("cond", ALLOWED_OUTCOME_IDS, [], tradeMessage(yes));

    for (let index = 1; index <= 100; index += 1) {
      current = applyConfirmedTradeDelta(
        "cond",
        ALLOWED_OUTCOME_IDS,
        current,
        tradeMessage(
          confirmedTrade({
            primitiveOutcomeId: `unknown-${index}`,
            fillId: `unknown-fill-${index}`,
            eventOrder: String(index + 1).padStart(4, "0"),
          }),
        ),
      );
    }

    expect(current).toEqual([yes]);
    expect(current.length).toBeLessThanOrEqual(ALLOWED_OUTCOME_IDS.length);
  });

  it("filters existing overlay records outside the registered outcome universe", () => {
    const yes = confirmedTrade({ fillId: "yes-fill", eventOrder: "0001" });
    const unknown = confirmedTrade({
      primitiveOutcomeId: "unknown",
      fillId: "unknown-fill",
      eventOrder: "0002",
    });
    const current = applyConfirmedTradeDelta(
      "cond",
      ALLOWED_OUTCOME_IDS,
      [yes, unknown],
      tradeMessage(yes),
    );

    expect(current).toEqual([yes]);
  });

  it("fails closed for empty or duplicate registered outcome allowlists", () => {
    const yes = confirmedTrade();

    expect(applyConfirmedTradeDelta("cond", [], [yes], tradeMessage(yes))).toEqual([]);
    expect(applyConfirmedTradeDelta("cond", ["YES"], [yes], tradeMessage(yes))).toEqual([]);
    expect(
      applyConfirmedTradeDelta(
        "cond",
        ["YES", "NO", "A", "B", "C", "D", "E", "F", "G"],
        [yes],
        tradeMessage(yes),
      ),
    ).toEqual([]);
    expect(applyConfirmedTradeDelta("cond", ["YES", "YES"], [yes], tradeMessage(yes))).toEqual([]);
  });

  it("fails closed for malformed or out-of-bound committed fill payloads", () => {
    expect(parseConfirmedTradeRecorded(null)).toBeNull();
    expect(parseConfirmedTradeRecorded(tradeMessage(confirmedTrade({ priceTick: 0 })))).toBeNull();
    expect(
      parseConfirmedTradeRecorded(tradeMessage(confirmedTrade({ priceTick: 1_000 }))),
    ).toBeNull();
    expect(
      parseConfirmedTradeRecorded(tradeMessage(confirmedTrade({ eventOrder: "" }))),
    ).toBeNull();
  });
});

describe("MarketFundingUpdated snapshots", () => {
  it("dispatches a valid update only to handlers registered for its condition", async () => {
    await joinMarket("cond-YES");
    const handler = vi.fn();
    onMarketFundingUpdated("cond", handler);
    const update = fundingMessage();

    signalrMock.registeredHandlers.get("MarketFundingUpdated")?.(update);
    signalrMock.registeredHandlers.get("MarketFundingUpdated")?.(
      fundingMessage({ conditionId: "other-condition" }),
    );
    signalrMock.registeredHandlers.get("MarketFundingUpdated")?.({
      ...update,
      fundingRevision: " ",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(update);
  });

  it.each([
    null,
    [],
    {},
    { conditionId: " ", ammBotBudgetSubunits: 1, fundingRevision: "0001" },
    { conditionId: "cond", ammBotBudgetSubunits: 0, fundingRevision: "0001" },
    { conditionId: "cond", ammBotBudgetSubunits: -1, fundingRevision: "0001" },
    { conditionId: "cond", ammBotBudgetSubunits: 1.5, fundingRevision: "0001" },
    {
      conditionId: "cond",
      ammBotBudgetSubunits: Number.MAX_SAFE_INTEGER + 1,
      fundingRevision: "0001",
    },
    { conditionId: "cond", ammBotBudgetSubunits: 1, fundingRevision: " " },
    { conditionId: "cond", ammBotBudgetSubunits: 1, fundingRevision: null },
    { conditionId: "cond", ammBotBudgetSubunits: 1, fundingRevision: "0001", extra: true },
    { ConditionId: "cond", AmmBotBudgetSubunits: 1, FundingRevision: "0001" },
  ])("rejects malformed funding event %#", (payload) => {
    expect(parseMarketFundingUpdated(payload)).toBeNull();
  });

  it("parses a valid event as one total-and-revision observation", () => {
    expect(parseMarketFundingUpdated(fundingMessage())).toEqual(fundingMessage());
  });
});
