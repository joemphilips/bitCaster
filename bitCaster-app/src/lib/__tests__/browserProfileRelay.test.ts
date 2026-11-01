import { expect, it, vi } from "vitest";
import { queryBrowserProfileRelay } from "../browserProfileRelay";

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

function boundedRead(bounds: { maxFrameBytes?: number; maxFrames?: number }) {
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
  await expect(large.read).rejects.toThrow("incomplete");
  expect(large.events).toHaveLength(0);
});
