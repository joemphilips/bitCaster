import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { useSettingsStore } from "@/stores/settings";
import { advanceNostrSignerRevision } from "../nostrSignerRevision";
import {
  runBrowserOraclePublicationPass,
  runBrowserOracleRecoveryPass,
  startBrowserOracleRecovery,
} from "../browserOracleRecovery";
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
vi.mock("../oracleAttestation", () => ({ publishBrowserOracleOutcome: vi.fn() }));
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

const noPublication = async () => {};
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
  const stop = startBrowserOracleRecovery({ runPass, runPublicationPass: noPublication });
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
  const stop = startBrowserOracleRecovery({ runPass, runPublicationPass: noPublication });
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
  let stop = startBrowserOracleRecovery({ runPass, runPublicationPass: noPublication });
  await flush();
  expect(runPass).toHaveBeenCalledTimes(1);
  await flush();
  expect(runPass).toHaveBeenCalledTimes(1);
  stop();
  stop = startBrowserOracleRecovery({ runPass, runPublicationPass: noPublication });
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
  const stop = startBrowserOracleRecovery({ runPass, runPublicationPass: noPublication });
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
  const stop = startBrowserOracleRecovery({ runPass, runPublicationPass: noPublication });
  await flush();
  await flush();
  expect(deps.deliver).toHaveBeenCalledTimes(85);
  expect(deps.list).toHaveBeenCalledTimes(1);
  expect(new Set(deps.deliver.mock.calls.map((args) => args[0])).size).toBe(85);
  expect(deps.readiness).not.toHaveBeenCalled();
  stop();
});

import { creatorOracleMetadata, creatorOraclePublication } from "@/test/creatorOracleFixture";
import { fixtureOraclePrivateKey } from "@/test/creatorOracleFixture";
import type { OraclePublicationRecord } from "@bitcaster/client-sdk/oraclePublication";

function importedOwner(
  conditionId: string,
  publication: OraclePublicationRecord | null,
): BrowserOracleOwner {
  return {
    kind: "imported",
    oracle: {
      ...creatorOracleMetadata,
      binding: { ...creatorOracleMetadata.binding, conditionId },
      publication: publication && {
        ...publication,
        binding: { ...publication.binding, conditionId },
      },
      importComplete: true,
    },
  };
}

it("resends each saved result once per wake, signing an interrupted choice only with its own key", async () => {
  const evidence = {
    conditionId: creatorOracleMetadata.binding.conditionId,
    oracleEventId: creatorOracleMetadata.binding.oracleEventId,
    oraclePubkey: creatorOracleMetadata.binding.oraclePubkey,
    outcome: "YES",
    announcementEventId: JSON.parse(creatorOracleMetadata.binding.announcementEventJson).id,
    attestationEventId: JSON.parse(creatorOraclePublication.attestation!.eventJson).id,
  };
  const unsigned = { ...creatorOraclePublication, attestation: null };
  const owners = [
    importedOwner("01".repeat(32), creatorOraclePublication),
    importedOwner("02".repeat(32), {
      ...creatorOraclePublication,
      relayPublished: true,
      engineEvidence: evidence,
    }),
    importedOwner("03".repeat(32), unsigned),
    importedOwner("04".repeat(32), null),
    importedOwner("05".repeat(32), { ...creatorOraclePublication, relayPublished: true }),
  ];
  const publish = vi.fn(async (conditionId: string, ..._request: unknown[]) => {
    if (conditionId === "01".repeat(32)) throw new Error("engine unavailable");
    return { failures: [], record: creatorOraclePublication };
  });
  const requireCurrent = vi.fn();
  const pass = (signerPublicKey: string | null) => ({
    signerPublicKey,
    relayUrls: ["wss://configured.example"],
    requireCurrent,
  });
  await runBrowserOraclePublicationPass(pass(null), { owners: async () => owners, publish });
  expect(publish.mock.calls.map((call) => call[0])).toEqual(["01".repeat(32), "05".repeat(32)]);
  for (const call of publish.mock.calls) {
    expect(call[1]).toBe("YES");
    expect(call[2]).toBeUndefined();
    expect(call[3]).toEqual(["wss://configured.example"]);
    expect(call[6]).toEqual({ engineDelivery: "synchronize", requireCurrent });
  }
  publish.mockClear();
  await runBrowserOraclePublicationPass(pass(getPublicKey(generateSecretKey())), {
    owners: async () => owners,
    publish,
  });
  expect(publish.mock.calls.map((call) => call[0])).not.toContain("03".repeat(32));
  publish.mockClear();
  await runBrowserOraclePublicationPass(pass(getPublicKey(fixtureOraclePrivateKey)), {
    owners: async () => owners,
    publish,
  });
  expect(publish.mock.calls.map((call) => call[0])).toEqual([
    "01".repeat(32),
    "03".repeat(32),
    "05".repeat(32),
  ]);
});

/** Resolve when a driver pass has run the given number of times. */
function passRecorder() {
  const calls: { signerPublicKey: string | null; relayUrls: readonly string[] }[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const run = vi.fn(
    async (pass: { signerPublicKey?: string | null; relayUrls: readonly string[] }) => {
      calls.push({ signerPublicKey: pass.signerPublicKey ?? null, relayUrls: pass.relayUrls });
      for (const waiter of waiters.filter((item) => calls.length >= item.count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
  );
  const reached = (count: number) =>
    calls.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ count, resolve }));
  return { calls, run, reached };
}

it("runs the publication pass without a signer on start, online, a visible tab, and signer or relay changes", async () => {
  const recovery = passRecorder();
  const publication = passRecorder();
  const stop = startBrowserOracleRecovery({
    runPass: recovery.run,
    runPublicationPass: publication.run,
  });
  try {
    await publication.reached(1);
    expect(publication.calls[0].signerPublicKey).toBeNull();
    globalThis.dispatchEvent(new Event("online"));
    await publication.reached(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await publication.reached(3);
    useSettingsStore.setState({
      relays: [{ url: "wss://changed.example", connectionStatus: "disconnected" }],
    });
    await publication.reached(4);
    expect(publication.calls[3].relayUrls).toEqual(["wss://changed.example"]);
    login();
    await publication.reached(5);
    await recovery.reached(1);
    const key = getPublicKey(
      nip19.decode(useSettingsStore.getState().nsecSecret!).data as Uint8Array,
    );
    expect(publication.calls[4].signerPublicKey).toBe(key);
    document.dispatchEvent(new Event("visibilitychange"));
    await publication.reached(6);
    // A visible tab resends saved results. It does not restart backup discovery.
    expect(recovery.calls).toHaveLength(1);
  } finally {
    stop();
  }
});
