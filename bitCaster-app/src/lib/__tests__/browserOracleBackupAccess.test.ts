import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  listBrowserOracleBackups,
  restoreBrowserOracleBackup,
  localBrowserOracleBackupStatuses,
  queryBrowserOracleBackupRelay,
} from "../browserOracleBackupAccess";
import { useSettingsStore } from "@/stores/settings";
import { generateSecretKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { useCreatorMarketsStore, type BrowserOracleOwner } from "@/stores/creatorMarkets";

const admission = vi.hoisted(() => ({ current: true, imported: vi.fn() }));
vi.mock("../kormir", () => ({
  browserOracleBackupValidator: { validateAuthority: vi.fn() },
  prepareBrowserOracleMutation: async () => ({
    requireCurrent() {
      if (!admission.current) throw new Error("Oracle identity changed.");
    },
  }),
}));
vi.mock("../browserOracleBackup", () => ({
  importBrowserOracleBackupEnvelope: (...args: unknown[]) => admission.imported(...args),
  browserOracleAuthorityReadiness: async () => "unavailable",
}));
class QuerySocket {
  static readonly OPEN = 1;
  static sockets: QuerySocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    QuerySocket.sockets.push(this);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(kind: string, value?: unknown) {
    const subscription = JSON.parse(this.sent[0])[1];
    this.onmessage?.({
      data: JSON.stringify(
        value === undefined ? [kind, subscription] : [kind, subscription, value],
      ),
    });
  }
}
beforeEach(() => {
  QuerySocket.sockets = [];
  vi.stubGlobal("WebSocket", QuerySocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function query(maxEvents = 2, maxBytes = 256 * 1024) {
  const controller = new AbortController();
  const result = queryBrowserOracleBackupRelay({
    relayUrl: "wss://relay.example",
    filter: { kinds: [30078], authors: ["11".repeat(32)], "#v": ["1"], limit: maxEvents },
    signal: controller.signal,
    maxEvents,
    maxBytes,
  });
  const socket = QuerySocket.sockets[0];
  socket.open();
  return { result, socket, controller };
}

it("owns the exact requested filter and closes its subscription at EOSE", async () => {
  const { result, socket } = query();
  const sent = JSON.parse(socket.sent[0]);
  expect(sent[0]).toBe("REQ");
  expect(sent[2]).toEqual({
    kinds: [30078],
    authors: ["11".repeat(32)],
    "#v": ["1"],
    limit: 2,
  });
  socket.receive("EVENT", { id: "not-yet-validated" });
  socket.receive("EOSE");
  const received = await result;
  expect(received.complete).toBe(true);
  expect(received.events.length).toBe(1);
  expect(socket.closed).toBe(true);
  expect(JSON.parse(socket.sent[1])[0]).toBe("CLOSE");
});

it("counts invalid and duplicate raw events before filtering", async () => {
  const { result, socket } = query();
  socket.receive("EVENT", { id: "invalid" });
  socket.receive("EVENT", { id: "invalid" });
  socket.receive("EVENT", { id: "invalid" });
  const received = await result;
  expect(received.complete).toBe(false);
  expect(received.events.length).toBe(2);
  expect(socket.closed).toBe(true);
});

it.each(["abort", "closed", "oversized", "bytes", "malformed"] as const)(
  "returns an incomplete query and closes after %s",
  async (boundary) => {
    const { result, socket, controller } = query(2, boundary === "bytes" ? 8 : 256 * 1024);
    switch (boundary) {
      case "abort":
        controller.abort();
        break;
      case "closed":
        socket.close();
        break;
      case "oversized":
        socket.onmessage?.({ data: "x".repeat(128 * 1024 + 1) });
        break;
      case "bytes":
        socket.receive("EVENT", { id: "too-large-for-test-budget" });
        break;
      case "malformed":
        socket.onmessage?.({ data: "{" });
        break;
    }
    expect((await result).complete).toBe(false);
    expect(socket.closed).toBe(true);
  },
);

it("returns no raw socket diagnostic when the connection fails", async () => {
  const { result, socket } = query();
  socket.onerror?.();
  await expect(result).rejects.toThrow("Oracle backup relay query is unavailable.");
  expect(socket.closed).toBe(true);
});

it("projects only the selected bounded local page from one owner snapshot", async () => {
  let preparations = 0;
  const owners: BrowserOracleOwner[] = Array.from({ length: 45 }, (_, index) => ({
    kind: "created",
    market: {
      conditionId: (index + 1).toString(16).padStart(64, "0"),
      title: "Legacy owner",
      thumbnailUrl: null,
      createdAt: "2026-10-06T00:00:00Z",
      baseAsset: "sat",
      divisibility: 1000,
      creatorFeePercent: 0,
      get oracle() {
        preparations++;
        return undefined;
      },
    },
  }));
  const read = vi
    .spyOn(useCreatorMarketsStore.getState(), "readOracleOwners")
    .mockResolvedValue(owners);
  const first = await localBrowserOracleBackupStatuses();
  expect(first.rows).toHaveLength(20);
  expect(first.nextOffset).toBe(20);
  expect(preparations).toBe(20);
  const last = await localBrowserOracleBackupStatuses({ localOffset: 40 });
  expect(last.rows).toHaveLength(5);
  expect(last.nextOffset).toBeNull();
  expect(last.rows[0].conditionId).toBe(
    owners[40].kind === "created" ? owners[40].market.conditionId : "",
  );
  expect(preparations).toBe(25);
  expect(read).toHaveBeenCalledTimes(2);
  await expect(localBrowserOracleBackupStatuses({ localOffset: -1 })).rejects.toThrow(
    "page is invalid",
  );
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(["discovery", "exact restore"] as const)(
  "refuses stale %s after the relay response without private import",
  async (operation) => {
    admission.current = true;
    admission.imported.mockClear();
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      nsecSecret: nip19.nsecEncode(generateSecretKey()),
    });
    const eventId = "ab".repeat(32);
    const queryRelay = async () => {
      admission.current = false;
      return { events: [{ id: eventId }], complete: true };
    };
    const action =
      operation === "discovery"
        ? listBrowserOracleBackups(null, { queryRelay, relayUrls: ["wss://relay.example"] })
        : restoreBrowserOracleBackup(eventId, "wss://relay.example", { queryRelay });
    await expect(action).rejects.toThrow("Oracle identity changed.");
    expect(admission.imported).not.toHaveBeenCalled();
  },
);
