import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { deriveDlcConditionId } from "@bitcaster/client-sdk";
import { announcementContentFromTlv } from "@bitcaster/client-sdk/oracleAnnouncementEncoding";
import { createCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { __setKormirModuleForTest, type Kormir } from "@/lib/kormir";
import { advanceNostrSignerRevision } from "@/lib/nostrSignerRevision";
import fixture from "@/lib/__tests__/fixtures/oraclePublication.json";
import {
  browserOracleAuthoritiesReadiness,
  browserOracleAuthorityReadiness,
} from "../browserOracleBackup";
import { localBrowserOracleBackupStatuses } from "../browserOracleBackupAccess";

const secret = new Uint8Array(32).fill(0x11);
const pubkey = getPublicKey(secret);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let onStage: ((id: string) => Promise<void>) | undefined;
let stageErrors = new Map<string, unknown>();
let badExports = new Set<string>();
let restore: ReturnType<typeof vi.fn>,
  construct: ReturnType<typeof vi.fn>,
  free: ReturnType<typeof vi.fn>;
let staged: ReturnType<typeof vi.fn>,
  exported: ReturnType<typeof vi.fn>,
  validate: ReturnType<typeof vi.fn>;
let records = new Map<string, { dto: Record<string, unknown>; id: string }>();
let lockBarrier: ReturnType<typeof gate> | undefined;
let lockEntered: ReturnType<typeof gate> | undefined;
let locks: { request<T>(name: string, action: () => Promise<T>): Promise<T> };

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
  records = new Map();
  stageErrors = new Map();
  badExports = new Set();
  onStage = undefined;
  lockBarrier = undefined;
  lockEntered = undefined;
  locks = {
    async request(_name, action) {
      lockEntered?.resolve();
      await lockBarrier?.promise;
      return action();
    },
  };
  restore = vi.fn(async () => {});
  free = vi.fn();
  staged = vi.fn(async (id: string) => {
    await onStage?.(id);
    if (stageErrors.has(id)) throw stageErrors.get(id);
    return {};
  });
  exported = vi.fn(async (id: string) => {
    if (badExports.has(id)) return "{";
    return JSON.stringify(records.get(id)!.dto);
  });
  validate = vi.fn((json: string, expected: string) => {
    const dto = JSON.parse(json);
    const record = [...records.entries()].find(
      ([, r]) => r.dto.announcementTlvHex === dto.announcementTlvHex,
    )!;
    if (expected !== pubkey) throw new Error("wrong fixture owner");
    return JSON.stringify({
      eventId: record[0],
      oraclePubkey: pubkey,
      outcomes: ["YES", "NO"],
      noncePoint: "1d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b4",
    });
  });
  construct = vi.fn(
    async () =>
      ({
        get_public_key: () => pubkey,
        staged_enum_publication: staged,
        export_enum_authority: exported,
        free,
      }) as unknown as Kormir,
  );
  __setKormirModuleForTest({
    Kormir: { restore, new: construct, validate_enum_authority: validate },
    JsError: { SigningKeyConflict: 7 },
  } as unknown as NonNullable<Parameters<typeof __setKormirModuleForTest>[0]>);
});
afterEach(() => {
  __setKormirModuleForTest(null);
  vi.restoreAllMocks();
});

async function owners(count: number) {
  const store = createCreatorMarketsStore(
    () => localStorage,
    () => locks,
  );
  const ids: string[] = [],
    events: string[] = [];
  for (let i = 0; i < count; i++) {
    const eventId = fixture.eventId.slice(0, -2) + String(i).padStart(2, "0");
    const oldHex = Array.from(new TextEncoder().encode(fixture.eventId), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const newHex = Array.from(new TextEncoder().encode(eventId), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    // Native/WASM is the controlled boundary. Keep real signed Nostr, TLV
    // shape, SDK envelope checks and actual creator document locking.
    const tlv = fixture.announcementHex.replace(oldHex, newHex);
    const event = finalizeEvent(
      { kind: 88, created_at: 1_800_000_000, tags: [], content: announcementContentFromTlv(tlv)! },
      secret,
    );
    const id = deriveDlcConditionId({ eventId, outcomeCount: 2, oraclePublicKeys: [pubkey] });
    records.set(eventId, {
      id,
      dto: {
        schemaVersion: 1,
        announcementTlvHex: tlv,
        announcementEventJson: JSON.stringify(event),
        nonceScalarHex: "01".repeat(32),
        signedOutcome: null,
        attestationHex: null,
        attestationEventJson: null,
        publicationRecordJson: null,
      },
    });
    await store.getState().addCreatedMarket({
      conditionId: id,
      title: "Fixture " + i,
      createdAt: "2026-10-06T00:00:00Z",
      thumbnailUrl: null,
      baseAsset: "sat",
      divisibility: 1000,
      creatorFeePercent: 0,
      oracle: {
        type: "self",
        eventId,
        oraclePubkey: pubkey,
        outcomes: ["YES", "NO"],
        announcementHex: tlv,
        announcementEventJson: JSON.stringify(event),
        destinations: {
          mintUrl: "https://mint.example",
          engineUrl: "https://engine.example",
          relayUrls: ["wss://relay.example"],
        },
      },
    });
    ids.push(id);
    events.push(eventId);
  }
  return { store, ids, events };
}

it("uses one real admission/core for twenty valid owners and starts a new lifetime on next page", async () => {
  const { store, ids } = await owners(20);
  const result = await browserOracleAuthoritiesReadiness(ids, store);
  expect(result.map((r) => r.readiness)).toEqual(Array(20).fill("ready"));
  expect(result.map((r) => r.conditionId)).toEqual(ids);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(construct).toHaveBeenCalledTimes(1);
  expect(free).toHaveBeenCalledTimes(1);
  expect(staged).toHaveBeenCalledTimes(20);
  expect(exported).toHaveBeenCalledTimes(20);
  expect(validate).toHaveBeenCalledTimes(40);
  expect(await browserOracleAuthoritiesReadiness(ids, store)).toHaveLength(20);
  expect(restore).toHaveBeenCalledTimes(2);
  expect(free).toHaveBeenCalledTimes(2);
});
it("refuses duplicate/oversized pages and initializes nothing for empty page", async () => {
  expect(await browserOracleAuthoritiesReadiness([])).toEqual([]);
  await expect(browserOracleAuthoritiesReadiness(["x", "x"])).rejects.toThrow();
  await expect(
    browserOracleAuthoritiesReadiness(Array.from({ length: 21 }, (_, i) => String(i))),
  ).rejects.toThrow();
  expect(restore).not.toHaveBeenCalled();
  expect(construct).not.toHaveBeenCalled();
});
it("isolates missing events and bad exports while retaining valid neighbors", async () => {
  const { store, ids, events } = await owners(4);
  stageErrors.set(events[1], 2);
  badExports.add(events[2]);
  expect((await browserOracleAuthoritiesReadiness(ids, store)).map((r) => r.readiness)).toEqual([
    "ready",
    "needs-restore",
    "unavailable",
    "ready",
  ]);
  expect(free).toHaveBeenCalledTimes(1);
  expect(await browserOracleAuthorityReadiness(ids[0], store)).toBe("ready");
});
it("real signer changes while queued refuse before core construction", async () => {
  const { store, ids } = await owners(2);
  lockEntered = gate();
  lockBarrier = gate();
  const pending = browserOracleAuthoritiesReadiness(ids, store);
  const rejected = expect(pending).rejects.toThrow();
  await lockEntered.promise;
  useSettingsStore.setState({ nsecSecret: "22".repeat(32) });
  advanceNostrSignerRevision();
  lockBarrier.resolve();
  await rejected;
  expect(construct).not.toHaveBeenCalled();
  expect(exported).not.toHaveBeenCalled();
});
it("signer change during staged read does not export or release earlier ready rows", async () => {
  const { store, ids, events } = await owners(3);
  const entered = gate(),
    release = gate();
  onStage = async (id) => {
    if (id === events[1]) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = browserOracleAuthoritiesReadiness(ids, store);
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  useSettingsStore.setState({ nsecSecret: "22".repeat(32) });
  advanceNostrSignerRevision();
  release.resolve();
  await rejected;
  expect(exported).toHaveBeenCalledTimes(1);
  expect(staged).toHaveBeenCalledTimes(2);
  expect(free).toHaveBeenCalledTimes(1);
});
it("actual access page composes all twenty valid rows with one core", async () => {
  const { store } = await owners(20);
  const result = await localBrowserOracleBackupStatuses({ store });
  expect(result.rows).toHaveLength(20);
  expect(result.rows.every((r) => r.available && r.readiness === "ready")).toBe(true);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(free).toHaveBeenCalledTimes(1);
});
it("isolates wrong-owner, malformed owner and incomplete import beside a valid owner", async () => {
  const { store, ids } = await owners(4);
  const saved = JSON.parse(localStorage.getItem("bitcaster-creator-markets")!);
  const owner = (id: string) =>
    saved.state.markets.find((m: { conditionId: string }) => m.conditionId === id);
  owner(ids[1]).oracle.oraclePubkey = "22".repeat(32);
  owner(ids[2]).oracle.outcomes = [];
  owner(ids[3]).oracle.importComplete = false;
  localStorage.setItem("bitcaster-creator-markets", JSON.stringify(saved));
  expect((await browserOracleAuthoritiesReadiness(ids, store)).map((r) => r.readiness)).toEqual([
    "ready",
    "unavailable",
    "unavailable",
    "needs-restore",
  ]);
  expect(free).toHaveBeenCalledTimes(1);
});
it("final lock-release signer invalidation refuses all previously ready results", async () => {
  const { store, ids } = await owners(2);
  locks.request = async (_name, action) => {
    const result = await action();
    advanceNostrSignerRevision();
    return result;
  };
  await expect(browserOracleAuthoritiesReadiness(ids, store)).rejects.toThrow();
  expect(exported).toHaveBeenCalledTimes(2);
  expect(free).toHaveBeenCalledTimes(1);
});
