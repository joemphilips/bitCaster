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
  onreconnected: ReturnType<typeof vi.fn>;
};

vi.mock("@microsoft/signalr", () => ({
  HubConnectionState: { Connected: connectedState, Disconnected: disconnectedState },
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

vi.mock("@/lib/markets", () => ({ generateNip98Header: mockGenerateNip98Header }));

import { generateOrderHubAccessToken, useOrderHub } from "../useOrderHub";

function makeConnection(): FakeConnection {
  const connection: FakeConnection = {
    state: disconnectedState,
    start: vi.fn().mockImplementation(async () => {
      connection.state = connectedState;
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    invoke: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    onclose: vi.fn(),
    onreconnecting: vi.fn(),
    onreconnected: vi.fn(),
  };
  return connection;
}

beforeEach(() => {
  vi.clearAllMocks();
  connections.length = 0;
  mockGenerateNip98Header.mockResolvedValue("Nostr signed-token");
});

describe("useOrderHub", () => {
  it("uses the temporary trade hub route and joins an owned order", async () => {
    const connection = makeConnection();
    connections.push(connection);
    const { result } = renderHook(() => useOrderHub(true, {}));

    await waitFor(() => expect(connection.state).toBe(connectedState));
    await result.current.joinOrder("condition-YES", "order-1");

    expect(connection.invoke).toHaveBeenCalledWith("JoinOrder", "condition-YES", "order-1");
  });

  it("retries an initial connection failure", async () => {
    const connection = makeConnection();
    connection.start
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockImplementationOnce(async () => {
        connection.state = connectedState;
      });
    connections.push(connection);

    renderHook(() => useOrderHub(true, {}));

    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(2));
    expect(connection.state).toBe(connectedState);
  });

  it("restarts after automatic reconnect is exhausted", async () => {
    const connection = makeConnection();
    const onReconnected = vi.fn();
    connections.push(connection);
    renderHook(() => useOrderHub(true, { onReconnected }));

    await waitFor(() => expect(connection.start).toHaveBeenCalledOnce());
    connection.state = disconnectedState;
    const onClose = connection.onclose.mock.calls[0]?.[0] as ((error?: Error) => void) | undefined;
    expect(onClose).toBeTypeOf("function");
    onClose?.(new Error("automatic reconnect exhausted"));

    await waitFor(() => expect(connection.start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onReconnected).toHaveBeenCalledOnce());
  });

  it("accepts only settlement-group notifications", async () => {
    const connection = makeConnection();
    connections.push(connection);
    renderHook(() => useOrderHub(true, {}));

    await waitFor(() => expect(connection.start).toHaveBeenCalledOnce());
    expect(connection.on).toHaveBeenCalledWith("SettlementGroupStateChanged", expect.any(Function));
    expect(connection.on).not.toHaveBeenCalledWith("TradeCreated", expect.any(Function));
    expect(connection.on).not.toHaveBeenCalledWith("SwapMessageReceived", expect.any(Function));
    expect(connection.on).not.toHaveBeenCalledWith("TradeStateChanged", expect.any(Function));
  });

  it("returns the raw NIP-98 token for the SignalR transport", async () => {
    await expect(generateOrderHubAccessToken("https://example.com/hubs/trade")).resolves.toBe(
      "signed-token",
    );
    expect(mockGenerateNip98Header).toHaveBeenCalledWith("https://example.com/hubs/trade", "GET");
  });
});
