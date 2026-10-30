import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { FakeRelayWebSocket } from "@/test/fakeRelayWebSocket";
import { publishRetainedOracleEvent } from "../oracleRelayTransport";

// The oracle relay operation limit. Every relay outcome must settle inside it.
const RELAY_OPERATION_LIMIT_MS = 8_000;
const reachable = "wss://reachable.example";
const stalled = "wss://stalled.example";
const refused = "wss://refused.example";
const announcement = finalizeEvent(
  { kind: 88, created_at: 1_700_000_000, tags: [], content: "announcement" },
  new Uint8Array(32).fill(0x11),
);

/** A reachable relay acknowledges each published event. */
class AcknowledgingRelaySocket extends FakeRelayWebSocket {
  override send(message: string): void {
    super.send(message);
    const [type, event] = JSON.parse(message) as [string, { id: string }];
    if (type === "EVENT" && this.url.startsWith(reachable))
      queueMicrotask(() => this.message(JSON.stringify(["OK", event.id, true, ""])));
  }
}

function sockets(url: string) {
  return FakeRelayWebSocket.instances.filter((socket) => socket.url.startsWith(url));
}

function publishedTo(url: string) {
  return sockets(url).flatMap((socket) =>
    socket.sent.filter((message) => message.startsWith('["EVENT"')),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", AcknowledgingRelaySocket);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network I/O is not permitted")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  FakeRelayWebSocket.instances.length = 0;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("publishes to the reachable relay while other relays never finish connecting", async () => {
  const pending = publishRetainedOracleEvent(
    [stalled, refused, reachable],
    JSON.stringify(announcement),
  );
  const settled = pending.then(
    (eventId) => ({ eventId }),
    (error: unknown) => ({ error }),
  );
  sockets(reachable)[0]!.open();
  sockets(refused)[0]!.remoteClose();
  await vi.advanceTimersByTimeAsync(RELAY_OPERATION_LIMIT_MS);
  expect(await settled).toEqual({ eventId: announcement.id });
  expect(publishedTo(reachable)).toHaveLength(1);
  expect(publishedTo(stalled)).toEqual([]);
  expect(publishedTo(refused)).toEqual([]);
  expect(FakeRelayWebSocket.instances.every((socket) => socket.closeCount > 0)).toBe(true);
});

it("fails inside the relay operation limit when no relay connects, and a retry also settles", async () => {
  for (const attempt of [1, 2]) {
    const pending = publishRetainedOracleEvent([stalled, refused], JSON.stringify(announcement));
    const settled = pending.then(
      () => "published",
      () => "failed",
    );
    sockets(refused).at(-1)!.remoteClose();
    await vi.advanceTimersByTimeAsync(RELAY_OPERATION_LIMIT_MS);
    expect(await settled, `attempt ${attempt}`).toBe("failed");
    expect(publishedTo(stalled)).toEqual([]);
    expect(FakeRelayWebSocket.instances.every((socket) => socket.closeCount > 0)).toBe(true);
  }
});
