import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NDKPrivateKeySigner, type NDKSigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { finalizeEvent, verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { useSettingsStore } from "@/stores/settings";
import { withBrowserProfileEditSession } from "../browserProfileCache";
import { advanceNostrSignerRevision } from "../nostrSignerRevision";
import { loadBrowserNostrProfileEdit, saveBrowserNostrProfileEdit } from "../browserNostrProfile";

const key = new Uint8Array(32).fill(1);
const nsec = nip19.nsecEncode(key);
const base = finalizeEvent(
  {
    kind: 0,
    created_at: 10,
    tags: [],
    content:
      '{"name":"Old","about":"Bio","display_name":"Alias","bio":"Other bio","image":"other.png","nested":{"keep":true},"nip05":"claim@example.test"}',
  },
  key,
);
const relays = ["wss://first.example/Path?Case=YES", "wss://second.example"];
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
let ndk: NDK;

interface Script {
  event?: NostrEvent;
  floodRead?: boolean;
  oversizedRead?: boolean;
  floodPublish?: boolean;
  closedReads?: readonly string[];
  statuses?: readonly ("accepted" | "rejected" | "unacknowledged")[];
  beforeOpen?: (connection: number) => void;
  beforeEose?: () => void;
  onPublish?: (event: NostrEvent, url: string) => Promise<void> | void;
  acknowledgment?: (event: NostrEvent) => unknown[];
}

function transport(script: Script = {}) {
  const sockets: FakeSocket[] = [];
  const publications: { event: NostrEvent; url: string }[] = [];
  class FakeSocket {
    readonly url: string;
    readyState = 0;
    onopen: WebSocket["onopen"] = null;
    onclose: WebSocket["onclose"] = null;
    onerror: WebSocket["onerror"] = null;
    onmessage: WebSocket["onmessage"] = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      const connection = sockets.length;
      queueMicrotask(() => {
        script.beforeOpen?.(connection);
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.onopen?.call(this as unknown as WebSocket, new Event("open"));
      });
    }
    deliver(frame: unknown[]) {
      this.onmessage?.call(
        this as unknown as WebSocket,
        new MessageEvent("message", { data: JSON.stringify(frame) }),
      );
    }
    send(raw: string) {
      const frame = JSON.parse(raw);
      if (frame[0] === "REQ")
        queueMicrotask(() => {
          script.beforeEose?.();
          if (script.oversizedRead) this.deliver(["NOTICE", "x".repeat(131_072)]);
          if (script.floodRead) for (let i = 0; i < 65; i++) this.deliver(["NOTICE", "ignored"]);
          if (script.closedReads?.includes(this.url))
            this.deliver(["CLOSED", frame[1], "private reason"]);
          else {
            this.deliver(["EVENT", frame[1], script.event ?? base]);
            this.deliver(["EOSE", frame[1]]);
          }
        });
      if (frame[0] === "EVENT")
        void (async () => {
          const event = frame[1] as NostrEvent;
          publications.push({ event, url: this.url });
          await script.onPublish?.(event, this.url);
          if (script.floodPublish) for (let i = 0; i < 65; i++) this.deliver(["NOTICE", "ignored"]);
          const status = script.statuses?.[relays.indexOf(this.url)] ?? "accepted";
          if (status !== "unacknowledged")
            this.deliver(
              script.acknowledgment?.(event) ?? [
                "OK",
                event.id,
                status === "accepted",
                "private reason",
              ],
            );
        })();
    }
    close() {
      this.readyState = 3;
    }
  }
  return {
    publications,
    sockets,
    getNdk: () => ndk,
    websocketImplementation: FakeSocket as unknown as typeof WebSocket,
    nowSeconds: () => 20,
    publishTimeoutMs: 20,
  };
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    nostrSignerMode: "nsec",
    nsecSecret: nsec,
    nostrProfile: null,
    relays: relays.map((url) => ({ url, connectionStatus: "disconnected" })),
  });
  ndk = { signer: new NDKPrivateKeySigner(nsec) } as unknown as NDK;
  let queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, action: () => Promise<unknown>) => {
        const running = queue.catch(() => {}).then(action);
        queue = running.then(
          () => {},
          () => {},
        );
        return running;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
  localStorage.clear();
});

describe("verified browser profile editing", () => {
  it("loads canonical raw fields and preserves retained edits after reload and stale relay replies", async () => {
    expect((await loadBrowserNostrProfileEdit(undefined, transport())).fields).toEqual({
      name: "Old",
      about: "Bio",
      picture: "",
    });
    const first = transport();
    const result = await saveBrowserNostrProfileEdit(
      { picture: "https://image.example/a", about: "New bio" },
      undefined,
      first,
    );
    expect(result.status).toBe("saved");
    expect(result.retained).toBe(true);
    expect(first.publications.every(({ event }) => verifyEvent(event))).toBe(true);
    const reloaded = await loadBrowserNostrProfileEdit(undefined, transport());
    expect(reloaded.fields).toEqual({
      name: "Old",
      about: "New bio",
      picture: "https://image.example/a",
    });
    const next = transport();
    const saved = await saveBrowserNostrProfileEdit({ name: "Next" }, undefined, next);
    expect(saved.event.created_at).toBe(21);
    expect(JSON.parse(saved.event.content)).toEqual({
      ...JSON.parse(base.content),
      name: "Next",
      about: "New bio",
      picture: "https://image.example/a",
    });
    expect(useSettingsStore.getState().nostrProfile?.nip05verified).toBe(false);
    expect(JSON.stringify(saved).includes(nsec)).toBe(false);
  });

  it("keeps the save lock through ACK and retention before the next edit reads its base", async () => {
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const first = transport({ onPublish: () => gate });
    const pending = saveBrowserNostrProfileEdit({ about: "First edit" }, undefined, {
      ...first,
      publishTimeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(first.publications).toHaveLength(1));
    const second = transport();
    const waiting = saveBrowserNostrProfileEdit({ picture: "next.png" }, undefined, second);
    await Promise.resolve();
    expect(second.sockets).toHaveLength(0);
    acknowledge();
    await pending;
    const saved = await waiting;
    expect(JSON.parse(saved.event.content).about).toBe("First edit");
    expect(JSON.parse(saved.event.content).picture).toBe("next.png");
  });

  it.each(["rejected", "unacknowledged"] as const)(
    "reports partial %s delivery truthfully and retains an accepted event",
    async (status) => {
      const io = transport({ statuses: ["accepted", status] });
      const saved = await saveBrowserNostrProfileEdit({ name: "New" }, undefined, io);
      expect(saved.status).toBe("saved");
      expect(saved.acceptedRelays).toEqual([relays[0]]);
      expect(saved.rejectedRelays).toEqual(status === "rejected" ? [relays[1]] : []);
      expect(saved.unacknowledgedRelays).toEqual(status === "unacknowledged" ? [relays[1]] : []);
      expect(io.sockets.every((socket) => socket.readyState === 3)).toBe(true);
    },
  );

  it("refuses an oversized transport frame before any signing", async () => {
    const signing = vi.spyOn(ndk.signer!, "sign");
    const io = transport({ oversizedRead: true });
    await expect(
      saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, io),
    ).rejects.toMatchObject({ code: "read-failed" });
    expect(signing).not.toHaveBeenCalled();
    expect(io.publications).toHaveLength(0);
  });

  it("keeps a truthful saved result when the optional display cache write fails", async () => {
    const setProfile = useSettingsStore.getState().setProfile;
    useSettingsStore.setState({
      setProfile: () => {
        throw new Error("display persistence failure");
      },
    });
    try {
      const saved = await saveBrowserNostrProfileEdit({ name: "Saved" }, undefined, transport());
      expect(saved.status).toBe("saved");
      expect(saved.retained).toBe(true);
      await withBrowserProfileEditSession(base.pubkey, async (session) =>
        expect(session.read()?.id).toBe(saved.event.id),
      );
    } finally {
      useSettingsStore.setState({ setProfile });
    }
  });

  it("refuses flooded reads and ignores ACKs after the frame bound", async () => {
    const read = transport({ floodRead: true });
    await expect(
      saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, read),
    ).rejects.toMatchObject({ code: "read-failed" });
    expect(read.publications).toHaveLength(0);
    const write = await saveBrowserNostrProfileEdit(
      { name: "Draft" },
      undefined,
      transport({ floodPublish: true }),
    );
    expect(write.status).toBe("not-acknowledged");
    expect(write.acceptedRelays).toEqual([]);
    expect(write.unacknowledgedRelays).toEqual(relays);
    expect(write.published).toBe(false);
    expect(write.retained).toBe(false);
  });

  it.each(["rejected", "unacknowledged"] as const)(
    "does not retain or claim publication when all relays are %s",
    async (status) => {
      const saved = await saveBrowserNostrProfileEdit(
        { name: "Draft" },
        undefined,
        transport({ statuses: [status, status] }),
      );
      expect(saved.status).toBe("not-acknowledged");
      expect(saved.published).toBe(false);
      expect(saved.retained).toBe(false);
      expect(saved.acceptedRelays).toEqual([]);
      await withBrowserProfileEditSession(base.pubkey, async (session) =>
        expect(session.read()).toBeNull(),
      );
    },
  );

  it("refuses incomplete or unusable fresh reads before signing", async () => {
    const signing = vi.spyOn(ndk.signer!, "sign");
    for (const script of [
      { closedReads: [relays[1]!] },
      { event: finalizeEvent({ kind: 0, created_at: 99, tags: [], content: "{" }, key) },
    ]) {
      const io = transport(script);
      await expect(
        saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, io),
      ).rejects.toMatchObject({ code: "base-unavailable" });
      expect(io.publications).toHaveLength(0);
    }
    expect(signing).not.toHaveBeenCalled();
  });

  it.each(["cancel", "identity"] as const)(
    "releases a pending extension signature on %s without publishing a late response",
    async (change) => {
      useSettingsStore.setState({ nostrSignerMode: "nip07", nsecSecret: null });
      let resolve!: (signature: string) => void;
      let request: Parameters<NDKSigner["sign"]>[0] | undefined;
      const sign = vi.fn((event: Parameters<NDKSigner["sign"]>[0]) => {
        request = event;
        return new Promise<string>((done) => {
          resolve = done;
        });
      });
      ndk.signer = { user: async () => ({ pubkey: base.pubkey }), sign } as unknown as NDKSigner;
      const controller = new AbortController();
      const io = transport();
      const pending = saveBrowserNostrProfileEdit({ name: "Draft" }, controller.signal, io);
      const expected = expect(pending).rejects.toMatchObject({
        code: change === "cancel" ? "cancelled" : "selection-changed",
      });
      await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
      if (change === "cancel") controller.abort();
      else advanceNostrSignerRevision();
      await expected;
      await withBrowserProfileEditSession(base.pubkey, async (session) =>
        expect(session.read()).toBeNull(),
      );
      resolve(
        finalizeEvent(
          {
            kind: request!.kind!,
            created_at: request!.created_at!,
            tags: request!.tags,
            content: request!.content,
          },
          key,
        ).sig,
      );
      await Promise.resolve();
      expect(io.publications).toHaveLength(0);
    },
  );

  it("refuses extension signing refusal and altered signature response without requesting a key", async () => {
    useSettingsStore.setState({ nostrSignerMode: "nip07", nsecSecret: null });
    const sign = vi.fn().mockRejectedValue(new Error("private extension reason"));
    ndk.signer = { user: async () => ({ pubkey: base.pubkey }), sign } as unknown as NDKSigner;
    const io = transport();
    await expect(
      saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, io),
    ).rejects.toMatchObject({ code: "signing-failed" });
    sign.mockImplementation(async (event) => finalizeEvent({ ...event, content: "{}" }, key).sig);
    await expect(
      saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, io),
    ).rejects.toMatchObject({ code: "signing-failed" });
    sign.mockImplementation(async (event) => finalizeEvent(event, key).sig);
    expect((await saveBrowserNostrProfileEdit({ name: "Extension" }, undefined, io)).status).toBe(
      "saved",
    );
    expect(io.publications).toHaveLength(2);
  });

  it("retains an exact ACK under the original identity after cancellation and fences later sends", async () => {
    const controller = new AbortController();
    const io = transport({ onPublish: () => controller.abort() });
    const saved = await saveBrowserNostrProfileEdit({ name: "Accepted" }, controller.signal, io);
    expect(saved.status).toBe("cancelled");
    expect(saved.published).toBe(true);
    expect(saved.retained).toBe(true);
    expect(saved.unsentRelays).toEqual([relays[1]]);
    expect(io.publications).toHaveLength(1);
    const retained = await withBrowserProfileEditSession(base.pubkey, async (session) =>
      session.read(),
    );
    expect(retained?.id).toBe(saved.event.id);
  });

  it("A/B/A settings and signer revisions prevent stale publication even after returning to A", async () => {
    const io = transport({
      beforeEose: () => {
        useSettingsStore.setState({ nostrSignerMode: "none" });
        useSettingsStore.setState({ nostrSignerMode: "nsec" });
      },
    });
    await expect(
      saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, io),
    ).rejects.toMatchObject({ code: "selection-changed" });
    expect(io.publications).toHaveLength(0);
    const changed = transport({
      beforeOpen: (connection) => {
        if (connection === 3) advanceNostrSignerRevision();
      },
    });
    const result = await saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, changed);
    expect(result.status).toBe("selection-changed");
    expect(result.unsentRelays).toEqual(relays);
    expect(changed.publications).toHaveLength(0);
  });

  it("identity changes after an issued send retain ACKs without updating the new identity's display", async () => {
    const io = transport({
      onPublish: () => {
        useSettingsStore.setState({ nostrSignerMode: "none" });
      },
    });
    const result = await saveBrowserNostrProfileEdit({ name: "Original" }, undefined, io);
    expect(result.status).toBe("selection-changed");
    expect(result.retained).toBe(true);
    expect(useSettingsStore.getState().nostrProfile).toBeNull();
    expect(io.publications).toHaveLength(1);
  });

  it("reports local retention failure after publication and never fabricates acceptance from malformed OK", async () => {
    const io = transport();
    const failed = await saveBrowserNostrProfileEdit({ name: "Published" }, undefined, {
      ...io,
      withSession: (owner, action, signal) =>
        withBrowserProfileEditSession(
          owner,
          (session) =>
            action({
              read: session.read,
              retain: () => {
                throw new Error("private storage reason");
              },
            }),
          signal,
        ),
    });
    expect(failed.status).toBe("published-retention-failed");
    expect(failed.published).toBe(true);
    expect(failed.retained).toBe(false);
    const malformed = transport({ acknowledgment: (event) => ["OK", event.id, true, "", "extra"] });
    const rejected = await saveBrowserNostrProfileEdit({ name: "Draft" }, undefined, malformed);
    expect(rejected.status).toBe("not-acknowledged");
    expect(rejected.acceptedRelays).toEqual([]);
    expect(rejected.unacknowledgedRelays).toEqual(relays);
  });
});
