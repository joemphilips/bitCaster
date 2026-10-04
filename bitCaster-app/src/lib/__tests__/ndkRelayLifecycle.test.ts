import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import NDK, { normalizeRelayUrl } from "@nostr-dev-kit/ndk";
import { FakeRelayWebSocket as Socket } from "@/test/fakeRelayWebSocket";
import { subscribeNip17DMs } from "../nip17";

const commonJs = createRequire(import.meta.url)(
  "@nostr-dev-kit/ndk",
) as typeof import("@nostr-dev-kit/ndk");
const instances: NDK[] = [];
function instance(urls: string[], constructor: typeof NDK = NDK): NDK {
  const ndk = new constructor({
    explicitRelayUrls: urls,
    enableOutboxModel: false,
    autoConnectUserRelays: false,
    outboxRelayUrls: [],
  });
  instances.push(ndk);
  return ndk;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network I/O is not permitted")));
  Socket.instances.length = 0;
});
afterEach(() => {
  for (const ndk of instances.splice(0)) ndk.explicitRelayUrls = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  { name: "ESM", constructor: NDK, normalize: normalizeRelayUrl },
  { name: "CommonJS", constructor: commonJs.default, normalize: commonJs.normalizeRelayUrl },
])("installed NDK $name", ({ constructor, normalize }) => {
  it("preserves exact paths and query order while deduplicating equivalent roots", () => {
    const urls = [
      "wss://CUSTOM.example/",
      "wss://custom.example",
      "wss://custom.example/Path",
      "wss://custom.example/Path/",
      "wss://custom.example/Path?B=2&A=Case",
      "wss://custom.example/npub1-custom?A=1&B=2",
    ];
    const expected = [
      "wss://custom.example",
      "wss://custom.example/Path",
      "wss://custom.example/Path/",
      "wss://custom.example/Path?B=2&A=Case",
      "wss://custom.example/npub1-custom?A=1&B=2",
    ];
    expect(normalize(urls[4]!)).toBe(expected[3]);
    const ndk = instance([], constructor);
    ndk.explicitRelayUrls = urls;
    expect([...ndk.pool.relays.keys()]).toEqual(expected);
    void ndk.connect();
    expect(Socket.instances.map(({ url }) => url)).toEqual(expected);
  });

  it.each(["connecting", "connected", "backoff", "flapping"] as const)(
    "terminally removes a %s relay and only connects a new object on re-add",
    async (state) => {
      const url = "wss://custom.example/Path?Key=Case";
      const ndk = instance([url], constructor);
      const old = ndk.pool.relays.get(url)!;
      const pending = ndk.connect(30_000);
      const socket = Socket.instances[0]!;
      const lateOpen = socket.onopen;
      if (state !== "connecting") socket.open();
      if (state === "backoff") socket.remoteClose();
      if (state === "flapping") old.emit("flapping", old.connectionStats);
      ndk.explicitRelayUrls = [];
      await pending;
      expect(old.connectivity.isDisposed).toBe(true);
      expect(ndk.pool.autoConnectRelays.size).toBe(0);
      expect(socket.closeCount).toBeGreaterThan(0);
      lateOpen?.(new Event("open"));
      await old.connect();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(Socket.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      ndk.explicitRelayUrls = [url];
      const replacement = ndk.pool.relays.get(url)!;
      expect(replacement).not.toBe(old);
      expect(replacement.connectivity.isDisposed).toBe(false);
      const reconnect = ndk.connect(30_000);
      Socket.instances[1]!.open();
      await reconnect;
      expect(Socket.instances.map(({ url }) => url)).toEqual([url, url]);
    },
  );

  it("retains an unchanged live relay object and its subscription when another relay is removed", async () => {
    const ndk = instance(["wss://keep.example/Path", "wss://remove.example"], constructor);
    const keep = ndk.pool.relays.get("wss://keep.example/Path")!;
    const pending = ndk.connect(30_000);
    Socket.instances.forEach((socket) => socket.open());
    await pending;
    const subscription = ndk.subscribe({ kinds: [1] }, { closeOnEose: false, groupable: false });
    await vi.advanceTimersByTimeAsync(0);
    ndk.explicitRelayUrls = ["wss://keep.example/Path"];
    expect(ndk.pool.relays.get("wss://keep.example/Path")).toBe(keep);
    expect(keep.connectivity.isDisposed).toBe(false);
    expect(Socket.instances[0]!.closeCount).toBe(0);
    expect(ndk.subManager.subscriptions.has(subscription.internalId)).toBe(true);
    subscription.stop();
  });

  it("cancels cache-delayed admission and does not revive that relay after re-add", async () => {
    const ndk = instance([], constructor);
    const blockedUntil = Date.now() + 60_000;
    ndk.cacheAdapter = {
      getRelayStatus: () => ({ dontConnectBefore: blockedUntil }),
    } as unknown as typeof ndk.cacheAdapter;
    ndk.explicitRelayUrls = ["wss://delayed.example/Path"];
    expect(ndk.pool.relays.size).toBe(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ndk.explicitRelayUrls = [];
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(Socket.instances).toHaveLength(0);
    ndk.cacheAdapter = undefined;
    ndk.explicitRelayUrls = ["wss://delayed.example/Path"];
    const pending = ndk.connect(30_000);
    Socket.instances[0]!.open();
    await pending;
    expect(Socket.instances).toHaveLength(1);
  });

  it("rejects pending publish and count exactly once during idempotent disposal", async () => {
    const ndk = instance(["wss://custom.example"], constructor);
    const pending = ndk.connect(30_000);
    Socket.instances[0]!.open();
    await pending;
    const relay = ndk.pool.relays.get("wss://custom.example")!;
    const publish = relay.connectivity.publish({
      id: "11".repeat(32),
      pubkey: "22".repeat(32),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "fixture",
      sig: "33".repeat(64),
    });
    const count = relay.connectivity.count([{ kinds: [1] }], {});
    const refusedPublish = expect(publish).rejects.toThrow("Relay was disposed");
    const refusedCount = expect(count).rejects.toThrow("Relay was disposed");
    ndk.explicitRelayUrls = [];
    relay.dispose();
    await Promise.all([refusedPublish, refusedCount]);
    expect(Socket.instances[0]!.closeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("cancels an active monitoring probe and every relay timer on terminal removal", async () => {
  const ndk = instance(["wss://custom.example"]);
  const pending = ndk.connect(30_000);
  Socket.instances[0]!.open();
  await pending;
  await vi.advanceTimersByTimeAsync(120_000);
  ndk.explicitRelayUrls = [];
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(Socket.instances).toHaveLength(1);
});

it("settles actual NIP-17 pre-ready cancellation without subscription or reconnect", async () => {
  const controller = new AbortController();
  const subscribe = vi.spyOn(NDK.prototype, "subscribe");
  const pending = subscribeNip17DMs(
    "11".repeat(32),
    "22".repeat(32),
    vi.fn(),
    ["wss://custom.example/Path?Key=Case"],
    controller.signal,
  );
  const socket = Socket.instances[0]!;
  const lateOpen = socket.onopen;
  controller.abort();
  expect(socket.closeCount).toBe(1);
  const unsubscribe = await pending;
  unsubscribe();
  lateOpen?.(new Event("open"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(subscribe).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts and stops actual NIP-17 when the caller omits its optional signal", async () => {
  const pending = subscribeNip17DMs("11".repeat(32), "22".repeat(32), vi.fn(), [
    "wss://custom.example",
  ]);
  Socket.instances[0]!.open();
  const unsubscribe = await pending;
  unsubscribe();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(Socket.instances[0]!.closeCount).toBe(1);
  expect(Socket.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
