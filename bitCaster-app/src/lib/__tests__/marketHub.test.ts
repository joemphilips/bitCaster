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
  disconnect,
  joinMarket,
  onMatched,
  onTradeExecuted,
  parseMatched,
  parseTradeExecuted,
} from "../marketHub";

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

describe("parseTradeExecuted", () => {
  it("accepts canonical AmountSubunits payloads from the engine", () => {
    expect(
      parseTradeExecuted({
        TradeId: "trade-1",
        MarketId: "cond-YES",
        ExecutionPrice: 420,
        AmountSubunits: 5_000,
        Side: "Buy",
        Timestamp: "2026-06-01T00:00:00Z",
      }),
    ).toEqual({
      marketId: "cond-YES",
      trade: {
        tradeId: "trade-1",
        executionPrice: 420,
        amountSubunits: 5_000,
        side: "Buy",
        timestamp: "2026-06-01T00:00:00Z",
      },
    });
  });

  it("rejects match-time payloads that lack a confirmed tradeId", () => {
    expect(
      parseTradeExecuted({
        MarketId: "cond-YES",
        ExecutionPrice: 420,
        AmountSubunits: 5_000,
        Side: "Buy",
        Timestamp: "2026-06-01T00:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("parseMatched", () => {
  it("accepts canonical matched payloads from the engine", () => {
    expect(
      parseMatched({
        MarketId: "cond-YES",
        TradeId: "trade-1",
        MakerOrderId: "maker-1",
        TakerOrderId: "taker-1",
        ExecutionPrice: 420,
        AmountSubunits: 5_000,
        Path: "Complementary",
        MatchedAt: "2026-06-01T00:00:00Z",
      }),
    ).toEqual({
      marketId: "cond-YES",
      match: {
        tradeId: "trade-1",
        makerOrderId: "maker-1",
        takerOrderId: "taker-1",
        executionPrice: 420,
        amountSubunits: 5_000,
        deadline: "2026-06-01T00:00:00Z",
        path: "Complementary",
        matchedAt: "2026-06-01T00:00:00Z",
      },
    });
  });
});

describe("joinMarket reconnect recovery", () => {
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
});

describe("market trade lifecycle dispatch", () => {
  it("keeps Matched and TradeExecuted separate but de-dupes duplicate settlement pushes by tradeId", async () => {
    const matched = vi.fn();
    const executed = vi.fn();

    onMatched("cond-YES", matched);
    onTradeExecuted("cond-YES", executed);
    await joinMarket("cond-YES");

    signalrMock.registeredHandlers.get("Matched")?.({
      MarketId: "cond-YES",
      TradeId: "trade-1",
      MakerOrderId: "maker-1",
      TakerOrderId: "taker-1",
      ExecutionPrice: 420,
      AmountSubunits: 5_000,
      Path: "Complementary",
      MatchedAt: "2026-06-01T00:00:00Z",
    });
    signalrMock.registeredHandlers.get("TradeExecuted")?.({
      MarketId: "cond-YES",
      TradeId: "trade-1",
      ExecutionPrice: 420,
      AmountSubunits: 5_000,
      Side: "Buy",
      Timestamp: "2026-06-01T00:00:10Z",
    });
    signalrMock.registeredHandlers.get("TradeExecuted")?.({
      MarketId: "cond-YES",
      TradeId: "trade-1",
      ExecutionPrice: 420,
      AmountSubunits: 5_000,
      Side: "Buy",
      Timestamp: "2026-06-01T00:00:10Z",
    });

    expect(matched).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith({
      tradeId: "trade-1",
      executionPrice: 420,
      amountSubunits: 5_000,
      side: "Buy",
      timestamp: "2026-06-01T00:00:10Z",
    });
  });
});
