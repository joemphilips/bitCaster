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

import { disconnect, joinMarket, onTradeExecuted, parseTradeExecuted } from "../marketHub";

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

describe("market execution dispatch", () => {
  it("de-dupes duplicate execution pushes by tradeId", async () => {
    const executed = vi.fn();

    onTradeExecuted("cond-YES", executed);
    await joinMarket("cond-YES");

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
