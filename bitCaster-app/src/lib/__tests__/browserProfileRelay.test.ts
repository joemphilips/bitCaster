import { expect, it, vi } from "vitest";
import { NostrRelayFrameTooLargeError } from "@bitcaster/client-sdk/nostrProfile";
import { queryBrowserProfileRelay, queryBrowserProfileRelayFilters } from "../browserProfileRelay";

it("does not create a socket for an already cancelled profile read", async () => {
  const controller = new AbortController();
  controller.abort();
  const socket = vi.fn();
  await expect(
    queryBrowserProfileRelay("wss://example.com", { kinds: [0] }, vi.fn(), {
      signal: controller.signal,
      requireCurrent: () => {},
      websocketImplementation: socket as unknown as typeof WebSocket,
    }),
  ).rejects.toThrow("incomplete");
  expect(socket).not.toHaveBeenCalled();
});

class BoundedSocket {
  static last: BoundedSocket | undefined;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    BoundedSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  subscription() {
    return (JSON.parse(this.sent[0]!) as [string, string])[1];
  }
}

function boundedRead(bounds: {
  maxFrameBytes?: number;
  maxFrames?: number;
  maxTotalBytes?: number;
}) {
  const events: unknown[] = [];
  const read = queryBrowserProfileRelay(
    "wss://example.com",
    { kinds: [3] },
    (e) => events.push(e),
    {
      requireCurrent: () => {},
      websocketImplementation: BoundedSocket as unknown as typeof WebSocket,
      ...bounds,
    },
  );
  const socket = BoundedSocket.last!;
  socket.open();
  return { read, socket, events };
}

it("accepts a frame above the default bound when the caller raises the frame bound", async () => {
  const { read, socket, events } = boundedRead({ maxFrameBytes: 400_000, maxFrames: 4 });
  const event = { kind: 3, content: "x".repeat(200_000) };
  socket.onmessage?.({ data: JSON.stringify(["EVENT", socket.subscription(), event]) });
  socket.onmessage?.({ data: JSON.stringify(["EOSE", socket.subscription()]) });
  await expect(read).resolves.toBeUndefined();
  expect(events).toHaveLength(1);
});

it("rejects a read when frames exceed the caller's frame or byte bound", async () => {
  const many = boundedRead({ maxFrames: 2 });
  for (let i = 0; i < 3; i++)
    many.socket.onmessage?.({
      data: JSON.stringify(["EVENT", many.socket.subscription(), { kind: 3 }]),
    });
  await expect(many.read).rejects.toThrow("incomplete");
  const large = boundedRead({ maxFrameBytes: 1_000 });
  large.socket.onmessage?.({
    data: JSON.stringify(["EVENT", large.socket.subscription(), { content: "x".repeat(1_000) }]),
  });
  await expect(large.read).rejects.toBeInstanceOf(NostrRelayFrameTooLargeError);
  expect(large.events).toHaveLength(0);
});

it("rejects a read when the frames together exceed the caller's total byte bound", async () => {
  const total = boundedRead({ maxFrameBytes: 1_000, maxTotalBytes: 1_500 });
  const frame = JSON.stringify([
    "EVENT",
    total.socket.subscription(),
    { content: "x".repeat(700) },
  ]);
  total.socket.onmessage?.({ data: frame });
  total.socket.onmessage?.({ data: frame });
  await expect(total.read).rejects.toThrow("incomplete");
  expect(total.events).toHaveLength(1);
});

it("sends one REQ with every filter and rejects the read when the event handler throws", async () => {
  const filters = [{ kinds: [0] }, { kinds: [3] }, { kinds: [1], limit: 10 }];
  const read = queryBrowserProfileRelayFilters(
    "wss://example.com",
    filters,
    () => {
      throw new Error("filter bound");
    },
    {
      requireCurrent: () => {},
      websocketImplementation: BoundedSocket as unknown as typeof WebSocket,
    },
  );
  const socket = BoundedSocket.last!;
  socket.open();
  const [verb, subscription, ...sent] = JSON.parse(socket.sent[0]!) as unknown[];
  expect(verb).toBe("REQ");
  expect(sent).toEqual(filters);
  socket.onmessage?.({ data: JSON.stringify(["EVENT", subscription, { kind: 1 }]) });
  await expect(read).rejects.toThrow("incomplete");
});
