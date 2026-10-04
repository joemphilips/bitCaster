import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NDK, { NDKEvent } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { FakeRelayWebSocket as Socket } from "@/test/fakeRelayWebSocket";
import { useSettingsStore } from "@/stores/settings";
import { useBookmarkStore } from "@/stores/bookmarks";
import { useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useActivityLogStore } from "@/stores/activity-log";
import { useBookmarkSync } from "@/stores/useBookmarkSync";
import { useCreatorSync } from "@/stores/useCreatorSync";
import { useActivityLogSync } from "@/stores/useActivityLogSync";
import { BOOKMARK_KIND, BOOKMARK_D_TAG, fetchBookmarks, publishBookmarks } from "../nip78Bookmarks";
import { fetchNip78CreatorMarkets, publishNip78CreatorMarkets } from "../nip78CreatorMarkets";
import { fetchNip78ActivityLog, publishNip78ActivityLog } from "../nip78ActivityLog";

const privateKey = new Uint8Array(32).fill(17);
const privateKeyHex = "11".repeat(32);
const publicKey = getPublicKey(privateKey);
const custom = "wss://custom.example/Path?B=2&A=Case";
const adapters = [
  {
    name: "bookmarks",
    fetch: (signal?: AbortSignal) => fetchBookmarks(publicKey, { signal }),
    publish: (signal?: AbortSignal) =>
      publishBookmarks(privateKeyHex, ["condition-Alpha"], { signal }),
    hook: useBookmarkSync,
  },
  {
    name: "creator markets",
    fetch: (signal?: AbortSignal) => fetchNip78CreatorMarkets(publicKey, { signal }),
    publish: (signal?: AbortSignal) => publishNip78CreatorMarkets(privateKeyHex, [], { signal }),
    hook: useCreatorSync,
  },
  {
    name: "private activity",
    fetch: (signal?: AbortSignal) => fetchNip78ActivityLog(publicKey, privateKeyHex, { signal }),
    publish: (signal?: AbortSignal) => publishNip78ActivityLog(privateKeyHex, [], { signal }),
    hook: useActivityLogSync,
  },
];
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function captureBookmarkPublications() {
  const events: NDKEvent[] = [];
  const publish = vi
    .spyOn(NDKEvent.prototype, "publishReplaceable")
    .mockImplementation(async function (this: NDKEvent) {
      events.push(this);
      return new Set();
    });
  return { publish, events };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network I/O is not permitted")));
  Socket.instances.length = 0;
  useSettingsStore.setState({
    nostrSignerMode: "nsec",
    nsecSecret: nip19.nsecEncode(privateKey),
    relays: [{ url: custom, connectionStatus: "disconnected" }],
  });
  useBookmarkStore.setState({ markets: [] });
  useCreatorMarketsStore.setState({ markets: [] });
  useActivityLogStore.setState({ items: [] });
});

describe("bookmark payload boundary", () => {
  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["array root", "[]"],
    ["missing markets", "{}"],
    ["non-array markets", '{"markets":"condition-Alpha"}'],
    ["mixed market types", '{"markets":["condition-Alpha",2]}'],
  ])("returns no remote state for %s and still disposes the relay", async (_, content) => {
    vi.spyOn(NDK.prototype, "fetchEvent").mockResolvedValue(new NDKEvent(undefined, { content }));
    const pending = fetchBookmarks(publicKey);
    Socket.instances[0]!.open();
    expect(await pending).toBeNull();
    expect(Socket.instances[0]!.closeCount).toBe(1);
  });

  it("uses the old exported wire constants and the real shared duplicate-tolerant decoder", async () => {
    const fetchEvent = vi.spyOn(NDK.prototype, "fetchEvent").mockResolvedValue(
      new NDKEvent(undefined, {
        content: '{"markets":["condition-Alpha","condition-Alpha","condition-Beta"]}',
      }),
    );
    const pending = fetchBookmarks(publicKey);
    Socket.instances[0]!.open();
    expect(await pending).toEqual(["condition-Alpha", "condition-Beta"]);
    expect(BOOKMARK_KIND).toBe(30078);
    expect(BOOKMARK_D_TAG).toBe("bitcaster:bookmarks");
    expect(fetchEvent.mock.calls[0]![0]).toEqual({
      kinds: [30078],
      authors: [publicKey],
      "#d": ["bitcaster:bookmarks"],
    });
    expect(Socket.instances[0]!.closeCount).toBe(1);
  });

  it("publishes the existing public JSON event once with a normalized set and releases the relay", async () => {
    const { publish, events } = captureBookmarkPublications();
    const pending = publishBookmarks(privateKeyHex, [
      "condition-Alpha",
      "condition-Alpha",
      "condition-Beta",
    ]);
    Socket.instances[0]!.open();
    await pending;
    expect(publish).toHaveBeenCalledOnce();
    const event = events[0]!;
    expect(event.kind).toBe(30078);
    expect(event.tags).toEqual([["d", "bitcaster:bookmarks"]]);
    expect(event.content).toBe('{"markets":["condition-Alpha","condition-Beta"]}');
    expect(Socket.instances[0]!.closeCount).toBe(1);
  });
});

describe("bookmark synchronization with shared set handling", () => {
  it("keeps local-first union order and publishes missing local bookmarks once", async () => {
    useBookmarkStore.setState({ markets: ["local-Alpha"] });
    vi.spyOn(NDK.prototype, "fetchEvent").mockResolvedValue(
      new NDKEvent(undefined, { content: '{"markets":["remote-Beta","remote-Beta"]}' }),
    );
    const { publish, events } = captureBookmarkPublications();
    renderHook(useBookmarkSync);
    Socket.instances[0]!.open();
    await act(flush);
    expect(useBookmarkStore.getState().markets).toEqual(["local-Alpha", "remote-Beta"]);
    expect(Socket.instances.map(({ url }) => url)).toEqual([custom, custom]);
    Socket.instances[1]!.open();
    await act(flush);
    expect(publish).toHaveBeenCalledOnce();
    expect(events[0]!.content).toBe('{"markets":["local-Alpha","remote-Beta"]}');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(Socket.instances.every((socket) => socket.closeCount === 1)).toBe(true);
  });

  it("avoids an initial publication for duplicate-equivalent sets, then debounces unlike and ignores an idempotent replacement", async () => {
    useBookmarkStore.setState({ markets: ["condition-Alpha"] });
    vi.spyOn(NDK.prototype, "fetchEvent").mockResolvedValue(
      new NDKEvent(undefined, { content: '{"markets":["condition-Alpha","condition-Alpha"]}' }),
    );
    const { publish, events } = captureBookmarkPublications();
    renderHook(useBookmarkSync);
    Socket.instances[0]!.open();
    await act(flush);
    expect(publish).not.toHaveBeenCalled();
    act(() => useBookmarkStore.getState().toggle("condition-Alpha"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(Socket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    Socket.instances[1]!.open();
    await act(flush);
    expect(publish).toHaveBeenCalledOnce();
    expect(events[0]!.content).toBe('{"markets":[]}');
    act(() => useBookmarkStore.getState().replace([]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(2);
  });

  it("cancels outgoing identity work and ignores its late metadata after replacement", async () => {
    let resolveOld!: (event: NDKEvent) => void;
    const old = new Promise<NDKEvent>((resolve) => {
      resolveOld = resolve;
    });
    const fetch = vi
      .spyOn(NDK.prototype, "fetchEvent")
      .mockReturnValueOnce(old)
      .mockResolvedValue(new NDKEvent(undefined, { content: '{"markets":["new-market"]}' }));
    const publish = vi.spyOn(NDKEvent.prototype, "publishReplaceable");
    renderHook(useBookmarkSync);
    Socket.instances[0]!.open();
    await act(flush);
    const nextKey = new Uint8Array(32).fill(18);
    act(() => useSettingsStore.setState({ nsecSecret: nip19.nsecEncode(nextKey) }));
    expect(Socket.instances[0]!.closeCount).toBe(1);
    Socket.instances[1]!.open();
    await act(flush);
    await act(async () => {
      resolveOld(new NDKEvent(undefined, { content: '{"markets":["stale-market"]}' }));
      await flush();
    });
    expect(fetch.mock.calls[1]![0]).toEqual({
      kinds: [30078],
      authors: [getPublicKey(nextKey)],
      "#d": ["bitcaster:bookmarks"],
    });
    expect(useBookmarkStore.getState().markets).toEqual(["new-market"]);
    expect(publish).not.toHaveBeenCalled();
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(adapters)("actual $name relay owner", ({ fetch, publish, hook }) => {
  it("uses only the selected custom URL and terminally disposes after fetch", async () => {
    const timersBefore = vi.getTimerCount();
    vi.spyOn(NDK.prototype, "fetchEvent").mockResolvedValue(null);
    const pending = fetch();
    expect(Socket.instances.map(({ url }) => url)).toEqual([custom]);
    Socket.instances[0]!.open();
    await pending;
    expect(Socket.instances[0]!.closeCount).toBe(1);
    // Full app imports also queue non-relay jobs. All relay timers must be removed.
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("makes no connection, fetch, or publication for an explicit empty selection", async () => {
    useSettingsStore.setState({ relays: [] });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const fetchEvent = vi.spyOn(NDK.prototype, "fetchEvent");
    const publishEvent = vi.spyOn(NDKEvent.prototype, "publishReplaceable");
    await fetch();
    await publish();
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    renderHook(hook);
    await flush();
    expect(Socket.instances).toHaveLength(0);
    expect(fetchEvent).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it.each(["fetch", "publish"])(
    "cancels %s before readiness and ignores a late open",
    async (operation) => {
      const controller = new AbortController();
      const fetchEvent = vi.spyOn(NDK.prototype, "fetchEvent");
      const publishEvent = vi.spyOn(NDKEvent.prototype, "publishReplaceable");
      const pending = operation === "fetch" ? fetch(controller.signal) : publish(controller.signal);
      const refusal = expect(pending).rejects.toThrow("request aborted");
      const socket = Socket.instances[0]!;
      const lateOpen = socket.onopen;
      controller.abort();
      expect(socket.closeCount).toBe(1);
      await refusal;
      lateOpen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(Socket.instances).toHaveLength(1);
      expect(fetchEvent).not.toHaveBeenCalled();
      expect(publishEvent).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["fetch", "publish"])(
    "cancels pending %s after readiness and disposes its socket",
    async (operation) => {
      const controller = new AbortController();
      const stalled = new Promise<null>(() => {});
      const fetchEvent = vi.spyOn(NDK.prototype, "fetchEvent").mockReturnValue(stalled);
      const publishEvent = vi
        .spyOn(NDKEvent.prototype, "publishReplaceable")
        .mockReturnValue(new Promise(() => {}));
      const pending = operation === "fetch" ? fetch(controller.signal) : publish(controller.signal);
      const refusal = expect(pending).rejects.toThrow("request aborted");
      Socket.instances[0]!.open();
      await flush();
      expect(operation === "fetch" ? fetchEvent : publishEvent).toHaveBeenCalledOnce();
      controller.abort();
      await refusal;
      expect(Socket.instances[0]!.closeCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["opt out", "unmount"])(
    "cancels live synchronization during connection on %s",
    async (action) => {
      const subscribe = vi.spyOn(NDK.prototype, "subscribe");
      const view = renderHook(hook);
      expect(Socket.instances.map(({ url }) => url)).toEqual([custom]);
      const socket = Socket.instances[0]!;
      const lateOpen = socket.onopen;
      act(() => {
        if (action === "opt out") useSettingsStore.setState({ relays: [] });
        else view.unmount();
      });
      expect(socket.closeCount).toBe(1);
      await act(async () => {
        await flush();
        lateOpen?.(new Event("open"));
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(subscribe).not.toHaveBeenCalled();
      expect(Socket.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels the real pending fetch subscription when current settings become empty", async () => {
    const subscribe = vi.spyOn(NDK.prototype, "subscribe");
    renderHook(hook);
    Socket.instances[0]!.open();
    await act(flush);
    expect(subscribe).toHaveBeenCalledOnce();
    const subscription = subscribe.mock.results[0]!.value;
    const stop = vi.spyOn(subscription, "stop");
    act(() => useSettingsStore.setState({ relays: [] }));
    expect(stop).toHaveBeenCalled();
    expect(Socket.instances[0]!.closeCount).toBe(1);
    await act(async () => {
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(Socket.instances).toHaveLength(1);
  });

  it("cancels live pending publication when current settings become empty", async () => {
    useBookmarkStore.setState({ markets: ["condition-Alpha"] });
    useCreatorMarketsStore.setState({
      markets: [
        {
          conditionId: "condition",
          title: "fixture",
          thumbnailUrl: null,
          createdAt: "2026-10-02T00:00:00Z",
          baseAsset: "sat",
          divisibility: 1000,
          creatorFeePercent: 0,
        },
      ],
    });
    vi.spyOn(NDK.prototype, "fetchEvent").mockResolvedValue(null);
    const publishEvent = vi
      .spyOn(NDKEvent.prototype, "publishReplaceable")
      .mockReturnValue(new Promise(() => {}));
    renderHook(hook);
    Socket.instances[0]!.open();
    await act(flush);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(Socket.instances.map(({ url }) => url)).toEqual([custom, custom]);
    Socket.instances[1]!.open();
    await act(flush);
    expect(publishEvent).toHaveBeenCalledOnce();
    act(() => useSettingsStore.setState({ relays: [] }));
    expect(Socket.instances[1]!.closeCount).toBe(1);
    await act(async () => {
      await flush();
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(Socket.instances).toHaveLength(2);
    expect(publishEvent).toHaveBeenCalledOnce();
  });
});
