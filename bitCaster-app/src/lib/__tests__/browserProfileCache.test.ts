import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { withBrowserProfileEditSession } from "../browserProfileCache";

const profile = (created_at: number, identity = 1) =>
  finalizeEvent(
    { kind: 0, created_at, tags: [], content: '{"name":"Alice","custom":{"keep":true}}' },
    new Uint8Array(32).fill(identity),
  );

function locks() {
  const request = vi.fn(async (_name, _options, action) => action());
  vi.stubGlobal("navigator", { locks: { request } });
  return request;
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("retained public Nostr profile", () => {
  it("retains newest signed metadata across A/B/A reads and unrelated stale Settings writes", async () => {
    locks();
    const a = profile(20);
    const b = profile(10, 2);
    await withBrowserProfileEditSession(a.pubkey, async (session) => session.retain(a));
    await withBrowserProfileEditSession(b.pubkey, async (session) => session.retain(b));
    localStorage.setItem("bitcaster-settings", JSON.stringify({ state: { nostrProfile: null } }));
    await withBrowserProfileEditSession(a.pubkey, async (session) => {
      session.retain(profile(10));
      expect(session.read()?.id).toBe(a.id);
    });
    await withBrowserProfileEditSession(b.pubkey, async (session) =>
      expect(session.read()?.id).toBe(b.id),
    );
  });

  it("does not silently erase corrupt, wrong-owner or oversized retained metadata", async () => {
    locks();
    const a = profile(20);
    const key = `bitcaster-nostr-profile:${a.pubkey}`;
    for (const value of ["{", JSON.stringify(profile(10, 2)), "x".repeat(131_073)]) {
      localStorage.setItem(key, value);
      await expect(
        withBrowserProfileEditSession(a.pubkey, async (session) => session.retain(a)),
      ).rejects.toThrow();
      expect(localStorage.getItem(key) === value).toBe(true);
    }
  });

  it("propagates retention failure instead of promising a saved record", async () => {
    locks();
    const a = profile(20);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await expect(
      withBrowserProfileEditSession(a.pubkey, async (session) => session.retain(a)),
    ).rejects.toThrow();
  });

  it("refuses unavailable locks and cancellation before editor admission", async () => {
    vi.stubGlobal("navigator", {});
    const action = vi.fn();
    await expect(withBrowserProfileEditSession(profile(20).pubkey, action)).rejects.toThrow(
      /coordinate/,
    );
    locks();
    await expect(
      withBrowserProfileEditSession(profile(20).pubkey, action, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });
});
