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
    invoke: vi.fn(async () => undefined),
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
  onMarketRejoined,
  parseConfirmedTradeRecorded,
  type ConfirmedTradeRecordedMessage,
  type LatestConfirmedTrade,
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

const ALLOWED_OUTCOME_IDS = ["YES", "NO"] as const;

beforeEach(async () => {
  await disconnect();
  signalrMock.connection.state = "Disconnected";
  signalrMock.connection.start.mockClear();
  signalrMock.connection.stop.mockClear();
  signalrMock.connection.invoke.mockClear();
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
