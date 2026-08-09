import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connections, connectedState, disconnectedState, mockGenerateNip98Header } = vi.hoisted(
  () => ({
    connections: [] as FakeConnection[],
    connectedState: "Connected",
    disconnectedState: "Disconnected",
    mockGenerateNip98Header: vi.fn(),
  }),
);

type FakeConnection = {
  state: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  onclose: ReturnType<typeof vi.fn>;
  onreconnecting: ReturnType<typeof vi.fn>;
};

vi.mock("@microsoft/signalr", () => ({
  HubConnectionState: {
    Connected: connectedState,
    Disconnected: disconnectedState,
  },
  HttpTransportType: { WebSockets: 1 },
  HubConnectionBuilder: class {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    build() {
      const connection = connections.shift();
      if (!connection) throw new Error("missing fake SignalR connection");
      return connection;
    }
  },
}));

vi.mock("@/lib/markets", () => ({
  generateNip98Header: mockGenerateNip98Header,
}));

import { generateTradeHubAccessToken, useTradeHub } from "../useTradeHub";

function makeConnection(failInitialStarts = 0): FakeConnection {
  const connection: FakeConnection = {
    state: disconnectedState,
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    onclose: vi.fn(),
    onreconnecting: vi.fn(),
  };

  let attempts = 0;
  connection.start.mockImplementation(async () => {
    attempts += 1;
    if (attempts <= failInitialStarts) {
      throw new Error("negotiate failed");
    }
    connection.state = connectedState;
  });

  return connection;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateNip98Header.mockResolvedValue("Nostr signed-token");
  connections.length = 0;
});

describe("generateTradeHubAccessToken", () => {
  it("returns the raw NIP-98 token for SignalR Bearer transport", async () => {
    const token = await generateTradeHubAccessToken("https://example.com/hubs/trade");

    expect(token).not.toMatch(/^Nostr\s+/);
    expect(token).toBe("signed-token");
    expect(mockGenerateNip98Header).toHaveBeenCalledWith("https://example.com/hubs/trade", "GET");
  });
});

describe("useTradeHub", () => {
  it("retries an initial negotiation failure while mounted", async () => {
    const connection = makeConnection(1);
    connections.push(connection);
    const onError = vi.fn();

    renderHook(() => useTradeHub(true, { onError }));

    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(connection.state).toBe(connectedState);
  });

  it("invokes JoinOrder after the connection is established", async () => {
    const connection = makeConnection();
    connections.push(connection);

    const { result } = renderHook(() => useTradeHub(true, {}));

    await waitFor(() => expect(connection.state).toBe(connectedState));
    await result.current.joinOrder("cond-YES", "order-1");

    expect(connection.invoke).toHaveBeenCalledWith("JoinOrder", "cond-YES", "order-1");
  });

  it("maps the canonical 16-argument TradeCreated payload including collateral unit", async () => {
    const connection = makeConnection();
    connections.push(connection);
    const onTradeCreated = vi.fn();

    renderHook(() => useTradeHub(true, { onTradeCreated }));

    await waitFor(() =>
      expect(connection.on).toHaveBeenCalledWith("TradeCreated", expect.any(Function)),
    );

    const handler = connection.on.mock.calls.find(([event]) => event === "TradeCreated")?.[1] as
      | ((...args: unknown[]) => void)
      | undefined;
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("TradeCreated handler was not registered");

    handler(
      "trade-1",
      "seller-pubkey",
      "buyer-pubkey",
      "2026-06-01T00:00:10Z",
      "2026-06-01T00:00:00Z",
      "cond-YES",
      5_000,
      5_000,
      3_500,
      "Mint",
      "NO",
      "YES",
      "sat",
      "msat",
      10_000,
      "Complement",
    );

    expect(onTradeCreated).toHaveBeenCalledWith({
      tradeId: "trade-1",
      sellerPubkey: "seller-pubkey",
      buyerPubkey: "buyer-pubkey",
      sellerLocktime: "2026-06-01T00:00:10Z",
      buyerLocktime: "2026-06-01T00:00:00Z",
      marketId: "cond-YES",
      fillAmountSubunits: 5_000,
      outcomeFaceAmountSubunits: 5_000,
      quotePaymentSubunits: 3_500,
      settlementKind: "Mint",
      sellerKeepOutcomeSetId: "NO",
      sellerLockOutcomeSetId: "YES",
      baseAsset: "sat",
      collateralUnit: "msat",
      divisibility: 10_000,
      tokenSide: "Complement",
    });
  });

  it("decodes owner settlement-group updates through the SDK contract", async () => {
    const connection = makeConnection();
    connections.push(connection);
    const onSettlementGroupStateChanged = vi.fn();

    renderHook(() => useTradeHub(true, { onSettlementGroupStateChanged }));

    await waitFor(() =>
      expect(connection.on).toHaveBeenCalledWith(
        "SettlementGroupStateChanged",
        expect.any(Function),
      ),
    );
    const handler = connection.on.mock.calls.find(
      ([event]) => event === "SettlementGroupStateChanged",
    )?.[1] as ((value: unknown) => void) | undefined;
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("SettlementGroupStateChanged handler was not registered");

    handler({
      orderId: "11111111-1111-4111-8111-111111111111",
      marketId: "condition-YES",
      settlementGroup: {
        groupId: "22222222-2222-4222-8222-222222222222",
        status: "Confirmed",
        revision: 3,
        coalescingDeadline: "2026-08-08T00:00:00.000Z",
        frozenAt: "2026-08-08T00:00:01.000Z",
      },
    });

    expect(onSettlementGroupStateChanged).toHaveBeenCalledWith({
      orderId: "11111111-1111-4111-8111-111111111111",
      marketId: "condition-YES",
      settlementGroup: {
        groupId: "22222222-2222-4222-8222-222222222222",
        status: "Confirmed",
        revision: 3,
        coalescingDeadline: "2026-08-08T00:00:00.000Z",
        frozenAt: "2026-08-08T00:00:01.000Z",
      },
    });
  });

  it("decodes only canonical portfolio invalidations", async () => {
    const connection = makeConnection();
    connections.push(connection);
    const onPortfolioInvalidated = vi.fn();
    const onError = vi.fn();

    renderHook(() => useTradeHub(true, { onPortfolioInvalidated, onError }));

    await waitFor(() =>
      expect(connection.on).toHaveBeenCalledWith("PortfolioInvalidated", expect.any(Function)),
    );
    const handler = connection.on.mock.calls.find(
      ([event]) => event === "PortfolioInvalidated",
    )?.[1] as ((value: unknown) => void) | undefined;
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("PortfolioInvalidated handler was not registered");

    handler({ walletId: "a".repeat(64) });
    handler({ walletId: "A".repeat(64) });

    expect(onPortfolioInvalidated).toHaveBeenCalledExactlyOnceWith({ walletId: "a".repeat(64) });
    expect(onError).toHaveBeenCalledWith(new Error("Portfolio invalidation is invalid."));
  });
});
