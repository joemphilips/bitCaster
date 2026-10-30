import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { useSettingsStore } from "@/stores/settings";
import { advanceNostrSignerRevision } from "../nostrSignerRevision";
import { runBrowserOracleRecoveryPass, startBrowserOracleRecovery } from "../browserOracleRecovery";
import type { OracleBackupScanCursor } from "@bitcaster/client-sdk/oracleBackupAccess";
import type { BrowserOracleBackupDeliveryOptions } from "../browserOracleBackupDelivery";
import type { BrowserOracleAuthorityReadiness } from "../browserOracleBackup";
import type { BrowserOracleBackupAccessOptions } from "../browserOracleBackupAccess";
import type { BrowserOracleOwner } from "@/stores/creatorMarkets";

vi.mock("../browserOracleBackup", () => ({ browserOracleAuthorityReadiness: vi.fn() }));
vi.mock("../browserOracleBackupAccess", () => ({
  listBrowserOracleBackups: vi.fn(),
  restoreBrowserOracleBackup: vi.fn(),
}));
vi.mock("../browserOracleBackupDelivery", () => ({ deliverBrowserOracleBackup: vi.fn() }));
const pubkey = getPublicKey(generateSecretKey());
const conditionId = "aa".repeat(32);
const controller = () => new AbortController();
function page(index: number) {
  return {
    schemaVersion: 1 as const,
    author: pubkey,
    relayUrls: ["wss://relay.example"],
    relayIndex: 0,
    until: index,
  };
}
function descriptor() {
  return {
    conditionId,
    oraclePubkey: pubkey,
    oracleEventId: "event",
    announcementEventId: "bb".repeat(32),
    backupEventId: "cc".repeat(32),
    createdAt: 1,
    sourceRelay: "wss://original.example",
    outcomes: ["YES", "NO"],
    destinations: {
      mintUrl: "https://mint.example",
      engineUrl: "https://engine.example",
      relayUrls: [],
    },
    state: "unresolved" as const,
  };
}
function result(cursor = null as ReturnType<typeof page> | null) {
  return {
    descriptors: [descriptor()],
    cursor,
    discovery: "relay-dependent" as const,
    partialReasons: [
      "relay-dependent-history",
    ] as import("@bitcaster/client-sdk/oracleBackupAccess").OracleBackupScanPartialReason[],
    observedRelayComplete: cursor === null,
  };
}
function dependencies() {
  return {
    owners: vi.fn(async (): Promise<BrowserOracleOwner[]> => []),
    readiness: vi.fn(async (): Promise<BrowserOracleAuthorityReadiness> => "needs-restore"),
    deliver: vi.fn(async (_id: string, _options?: BrowserOracleBackupDeliveryOptions) => ({
      failures: [],
      state: null,
    })),
    list: vi.fn(
      async (
        _cursor?: OracleBackupScanCursor | null,
        _options?: BrowserOracleBackupAccessOptions,
      ) => result(),
    ),
    restore: vi.fn(),
  };
}
function pass(requireCurrent: () => void = vi.fn()) {
  return {
    publicKey: pubkey,
    relayUrls: ["wss://relay.example"],
    signal: controller().signal,
    requireCurrent,
  };
}
beforeEach(() => {
  useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null, relays: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("restores only missing authority using the exact original source and continues cursors", async () => {
  const deps = dependencies();
  deps.list.mockResolvedValueOnce(result(page(100))).mockResolvedValueOnce(result());
  const checkpoint = { ownerOffset: 0, cursor: null };
  await runBrowserOracleRecoveryPass(pass(), checkpoint, deps);
  expect(deps.list).toHaveBeenCalledTimes(2);
  expect(deps.list.mock.calls[1][0]).toEqual(page(100));
  expect(deps.restore).toHaveBeenCalledWith(
    "cc".repeat(32),
    "wss://original.example",
    expect.objectContaining({ relayUrls: ["wss://relay.example"] }),
  );
  expect(deps.deliver).not.toHaveBeenCalled();
});

it.each(["ready", "unavailable"] as const)("does not restore %s authority", async (state) => {
  const deps = dependencies();
  deps.readiness.mockResolvedValue(state);
  await runBrowserOracleRecoveryPass(pass(), { ownerOffset: 0, cursor: null }, deps);
  expect(deps.restore).not.toHaveBeenCalled();
});

it.each(["incomplete", "failure", "unchanged", "budget"] as const)(
  "bounds discovery at %s",
  async (boundary) => {
    const deps = dependencies();
    const checkpoint = { ownerOffset: 0, cursor: page(100) as ReturnType<typeof page> | null };
    let count = 0;
    deps.list.mockImplementation(async () => {
      count++;
      const response = result(boundary === "unchanged" ? page(100) : page(100 + count));
      if (boundary === "incomplete") {
        response.observedRelayComplete = false;
        response.partialReasons.push("query-failed");
      }
      if (boundary === "failure") throw new Error("fixed failure");
      return response;
    });
    await runBrowserOracleRecoveryPass(pass(), checkpoint, deps).catch(() => undefined);
    expect(deps.list).toHaveBeenCalledTimes(boundary === "budget" ? 4 : 1);
    if (boundary === "incomplete" || boundary === "failure")
      expect(deps.restore).not.toHaveBeenCalled();
    if (boundary === "budget") expect(checkpoint.cursor?.until).toBe(104);
  },
);

it("cancellation during a query starts no readiness check or restore", async () => {
  const deps = dependencies();
  let current = true;
  deps.list.mockImplementation(async () => {
    current = false;
    return result();
  });
  const checkpoint = { ownerOffset: 0, cursor: page(100) };
  await expect(
    runBrowserOracleRecoveryPass(
      pass(() => {
        if (!current) throw new Error("cancelled");
      }),
      checkpoint,
      deps,
    ),
  ).rejects.toThrow("cancelled");
  expect(checkpoint.cursor.until).toBe(100);
  expect(deps.readiness).not.toHaveBeenCalled();
  expect(deps.restore).not.toHaveBeenCalled();
});

function login() {
  useSettingsStore.setState({
    nostrSignerMode: "nsec",
    nsecSecret: nip19.nsecEncode(generateSecretKey()),
    relays: [{ url: "wss://relay.example", connectionStatus: "disconnected" }],
  });
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

it("starts on later local login, ignores render/store noise and wakes on reconnect or signer revision", async () => {
  const runPass = vi.fn(async () => {});
  const stop = startBrowserOracleRecovery({ runPass });
  await flush();
  expect(runPass).not.toHaveBeenCalled();
  useSettingsStore.setState({ nostrSignerMode: "nip07" });
  await flush();
  expect(runPass).not.toHaveBeenCalled();
  login();
  await flush();
  expect(runPass).toHaveBeenCalledTimes(1);
  useSettingsStore.setState({ theme: "dark" });
  await flush();
  expect(runPass).toHaveBeenCalledTimes(1);
  globalThis.dispatchEvent(new Event("online"));
  globalThis.dispatchEvent(new Event("online"));
  await flush();
  expect(runPass).toHaveBeenCalledTimes(2);
  advanceNostrSignerRevision();
  await flush();
  expect(runPass).toHaveBeenCalledTimes(3);
  stop();
});

it("coalesces in-flight wakes and invalidates A-to-B-to-A before subsequent work", async () => {
  login();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runPass = vi.fn(async (active) => {
    if (runPass.mock.calls.length === 1) {
      await held;
      active.requireCurrent();
    }
  });
  const stop = startBrowserOracleRecovery({ runPass });
  await flush();
  const original = useSettingsStore.getState().nsecSecret;
  login();
  useSettingsStore.setState({ nsecSecret: original });
  globalThis.dispatchEvent(new Event("online"));
  globalThis.dispatchEvent(new Event("online"));
  expect(runPass).toHaveBeenCalledTimes(1);
  expect(runPass.mock.calls[0][0].signal.aborted).toBe(true);
  release();
  await flush();
  expect(runPass).toHaveBeenCalledTimes(2);
  stop();
});

it("a failed pass waits for reconnect and restart retries without publishing any outcome", async () => {
  login();
  const runPass = vi.fn(async () => {
    throw new Error("fixed unavailable");
  });
  let stop = startBrowserOracleRecovery({ runPass });
  await flush();
  expect(runPass).toHaveBeenCalledTimes(1);
  await flush();
  expect(runPass).toHaveBeenCalledTimes(1);
  stop();
  stop = startBrowserOracleRecovery({ runPass });
  await flush();
  expect(runPass).toHaveBeenCalledTimes(2);
  stop();
});

it("automatically yields and continues more than four cursor pages without another wake", async () => {
  login();
  const deps = dependencies();
  let count = 0;
  deps.list.mockImplementation(async () => {
    count++;
    return result(count < 7 ? page(100 + count) : null);
  });
  const runPass = vi.fn((active, checkpoint) =>
    runBrowserOracleRecoveryPass(active, checkpoint, deps),
  );
  const stop = startBrowserOracleRecovery({ runPass });
  await flush();
  await flush();
  expect(count).toBe(7);
  expect(runPass).toHaveBeenCalledTimes(2);
  await flush();
  expect(count).toBe(7);
  stop();
});

it("continues more than eighty saved owner retries once each and does not rescan finished history", async () => {
  login();
  const activeKey = getPublicKey(
    nip19.decode(useSettingsStore.getState().nsecSecret!).data as Uint8Array,
  );
  const deps = dependencies();
  const owners: BrowserOracleOwner[] = Array.from({ length: 85 }, (_, index) => ({
    kind: "imported",
    oracle: {
      binding: {
        conditionId: index.toString(16).padStart(64, "0"),
        oraclePubkey: activeKey,
        oracleEventId: "event-" + index,
        outcomes: ["YES", "NO"],
        announcementEventJson: "{}",
      },
      announcementHex: "00",
      destinations: descriptor().destinations,
      publication: null,
      importComplete: true,
      backupDelivery: {
        current: { mode: "initial" },
      } as import("@bitcaster/client-sdk/oracleBackupDelivery").OracleBackupDeliveryState,
    },
  }));
  deps.owners.mockResolvedValue(owners);
  deps.list.mockResolvedValue({ ...result(), descriptors: [] });
  const runPass = vi.fn((active, checkpoint) =>
    runBrowserOracleRecoveryPass(active, checkpoint, deps),
  );
  const stop = startBrowserOracleRecovery({ runPass });
  await flush();
  await flush();
  expect(deps.deliver).toHaveBeenCalledTimes(85);
  expect(deps.list).toHaveBeenCalledTimes(1);
  expect(new Set(deps.deliver.mock.calls.map((args) => args[0])).size).toBe(85);
  expect(deps.readiness).not.toHaveBeenCalled();
  stop();
});
