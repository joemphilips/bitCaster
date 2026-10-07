import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  deriveDlcConditionId,
  deriveDurableCustodyScopeId,
  type MarketCreationRecord,
  type MarketCreationPreparation,
} from "@bitcaster/client-sdk";
import { useSettingsStore } from "@/stores/settings";
import {
  prepareBrowserMarketCreation,
  completeBrowserMarketCreation,
} from "../browserMarketCreation";
import { getKormir, resetKormir, restoreKormirWithNsec } from "../kormir";

const state = vi.hoisted(() => ({
  artifact: null as { artifactHex: string; eventJson: string } | null,
  eventId: "",
  prepareFee: vi.fn(),
  deliverFee: vi.fn(),
  publish: vi.fn(),
  registerEngine: vi.fn(),
}));
vi.mock("../kormir", async (original) => ({
  ...(await original<typeof import("../kormir")>()),
  ensureKormirNsec: vi.fn(async () => {}),
  prepareEnumAnnouncement: vi.fn(async () => state.artifact!),
}));
vi.mock("../slug", async (original) => ({
  ...(await original<typeof import("../slug")>()),
  buildEventId: () => state.eventId,
}));
vi.mock("../marketRegistrationFee", async (original) => ({
  ...(await original<typeof import("../marketRegistrationFee")>()),
  prepareConditionRegistrationFee: state.prepareFee,
  deliverPreparedConditionRegistrationFee: state.deliverFee,
}));
vi.mock("../nostr", async (original) => ({
  ...(await original<typeof import("../nostr")>()),
  withTemporaryRelayNdk: state.publish,
}));
vi.mock("../markets", async (original) => ({
  ...(await original<typeof import("../markets")>()),
  createPreparedMarket: state.registerEngine,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetKormir();
  useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function fixture() {
  await restoreKormirWithNsec("11".repeat(32));
  state.eventId = `creation-size-${crypto.randomUUID()}`;
  const core = await getKormir([]);
  const exact = await core.prepare_enum_event(
    state.eventId,
    ["Yes", "No"],
    1_800_000_000,
    "Test",
    "Test",
  );
  state.artifact = { artifactHex: exact.artifact_hex, eventJson: exact.nostr_event_json };
  exact.free();
  const pubkey = JSON.parse(state.artifact.eventJson).pubkey;
  const walletId = "22".repeat(32);
  const binding = {
    creatorId: pubkey,
    walletId,
    walletScopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
    mintUrl: "https://mint.original.example",
    engineBaseUrl: "https://engine.original.example",
  };
  // Each URL is supported by the creation record. Their combined private envelope exceeds NIP-44.
  const relayUrls = Array.from(
    { length: 64 },
    (_, index) => `wss://relay.original.example/${index}/${"a".repeat(1100)}`,
  );
  const preparation: MarketCreationPreparation = {
    ...binding,
    creationId: `creation-${crypto.randomUUID()}`,
    eventId: state.eventId,
    relayUrls,
    metadata: {
      title: "Test",
      description: "Test",
      outcomes: [{ name: "Yes" }, { name: "No" }],
      outcomeType: "yesno",
      baseAsset: "sat",
      categoryTags: [],
      oracleAnnouncementHex: state.artifact.artifactHex,
    },
    announcement: {
      conditionId: deriveDlcConditionId({
        eventId: state.eventId,
        outcomeCount: 2,
        oraclePublicKeys: [pubkey],
      }),
      announcementTlvHex: state.artifact.artifactHex,
      announcementNostrEventJson: state.artifact.eventJson,
    },
    registration: { feeAmount: 0, feeUnit: "msat", feeOperationRef: null },
    thumbnail: null,
  };
  let retained: MarketCreationRecord | null = null;
  const reserve = vi.fn(
    async (input: MarketCreationPreparation) =>
      (retained ??= { ...input, mintConfirmed: false, engineResult: null }),
  );
  const session = {
    binding,
    requireBinding: () => {},
    store: {
      read: async () => retained,
      reserve,
      confirmMint: vi.fn(),
      confirmEngine: vi.fn(),
    },
  } as unknown as Parameters<typeof prepareBrowserMarketCreation>[0];
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  return {
    session,
    preparation,
    relayUrls,
    reserve,
    network,
    retain: () => {
      retained = { ...preparation, mintConfirmed: false, engineResult: null };
    },
  };
}

function assertNoExternalEffects(f: Awaited<ReturnType<typeof fixture>>) {
  expect(state.prepareFee).not.toHaveBeenCalled();
  expect(state.deliverFee).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
  expect(state.registerEngine).not.toHaveBeenCalled();
  expect(f.network).not.toHaveBeenCalled();
}

it("refuses an oversized portable envelope before fresh creation can deliver a fee or publish or register", async () => {
  const f = await fixture();
  await expect(
    prepareBrowserMarketCreation(f.session, {
      creationId: f.preparation.creationId,
      relayUrls: f.relayUrls,
      feeAmount: 0,
      market: {
        title: "Test",
        description: "Test",
        outcomeType: "yesno",
        outcomeDetails: [{ name: "Yes" }, { name: "No" }],
        maturityEpoch: 1_800_000_000,
        categoryTags: [],
        baseAsset: "sat",
      },
    }),
  ).rejects.toThrow("Private oracle backup: oversized.");
  expect(f.reserve).not.toHaveBeenCalled();
  assertNoExternalEffects(f);
  expect((await getKormir([])).get_public_key()).toBe(JSON.parse(state.artifact!.eventJson).pubkey);
});

it("rechecks an already retained unpaid preparation before resume can bypass the portable limit", async () => {
  const f = await fixture();
  f.retain();
  await expect(completeBrowserMarketCreation(f.session, f.preparation)).rejects.toThrow(
    "Private oracle backup: oversized.",
  );
  assertNoExternalEffects(f);
  expect((await f.session.store.read(f.preparation.creationId))?.mintConfirmed).toBe(false);
});
