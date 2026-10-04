import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDlcConditionId } from "@bitcaster/client-sdk";
import {
  publishOracleOutcome,
  retryOraclePublication,
} from "@bitcaster/client-sdk/oraclePublication";
import {
  readSignedOracleEvent,
  createOracleExplanationTemplate,
  verifyOracleResolutionExplanation,
} from "@bitcaster/client-sdk/oracleResolutionExplanation";
import {
  createCreatorMarketsStore,
  creatorOraclePublicationStore,
  mergeCreatorMarket,
  type StoredCreatorMarket,
} from "@/stores/creatorMarkets";
import {
  publicCreatorMarket,
  fetchNip78CreatorMarkets,
  CREATOR_MARKETS_KIND,
  CREATOR_MARKETS_D_TAG,
} from "../nip78CreatorMarkets";
import { __setKormirModuleForTest } from "../kormir";
import * as wasm from "../kormir-wasm-pkg/kormir_wasm";
import {
  oracleEventToWire,
  oracleWireEventJson,
  retainedOracleAuthority as readRetainedOracleAuthority,
  verifyRetainedOracleAttestation as verifyOracleArtifact,
  verifiedEngineOracleEvidence,
  publishBrowserOracleOutcome,
  readBrowserResolutionExplanation,
} from "../oracleAttestation";
import fixture from "./fixtures/oraclePublication.json";
import { useSettingsStore } from "@/stores/settings";

const { fetchAnnouncement, fetchCompanions } = vi.hoisted(() => ({
  fetchAnnouncement: vi.fn(),
  fetchCompanions: vi.fn(),
}));

vi.mock("../nostr", async () => {
  const { default: NDK } = await import("@nostr-dev-kit/ndk");
  return {
    withTemporaryRelayNdk: async (
      _options: unknown,
      _signer: unknown,
      action: (ndk: InstanceType<typeof NDK>) => Promise<unknown>,
    ) =>
      action(
        Object.assign(new NDK({ explicitRelayUrls: [] }), {
          fetchEvent: fetchAnnouncement,
          fetchEvents: fetchCompanions,
        }),
      ),
  };
});

const conditionId = deriveDlcConditionId({
  eventId: fixture.eventId,
  outcomeCount: 2,
  oraclePublicKeys: [fixture.oraclePubkey],
});
const binding = {
  conditionId,
  oracleEventId: fixture.eventId,
  oraclePubkey: fixture.oraclePubkey,
  outcomes: ["YES", "NO"],
  announcementEventJson: fixture.announcementEventJson,
};
const artifact = {
  attestationHex: fixture.attestationHex,
  eventJson: fixture.attestationEventJson,
};
const authoritySource = { announcementTlvHex: fixture.announcementHex };
const retainedOracleAuthority = (request: Parameters<typeof readRetainedOracleAuthority>[0]) =>
  readRetainedOracleAuthority(request, authoritySource);
const verifyRetainedOracleAttestation = (
  request: Parameters<typeof verifyOracleArtifact>[0],
  outcome: string,
  saved: typeof artifact,
) => verifyOracleArtifact(request, outcome, saved, authoritySource);
let registeredAuthority: {
  eventId: string;
  outcomes: string[];
  threshold: number;
  oracles: { oraclePublicKey: string; noncePoint: string; announcementIdentity: string }[];
};

function market(): StoredCreatorMarket {
  return {
    conditionId,
    title: "Public DLC fixture",
    thumbnailUrl: null,
    createdAt: "2026-10-04T00:00:00.000Z",
    baseAsset: "sat",
    divisibility: 1000,
    creatorFeePercent: 0,
    oracle: {
      type: "self",
      eventId: fixture.eventId,
      outcomes: ["YES", "NO"],
      announcementHex: fixture.announcementHex,
      announcementEventId: JSON.parse(fixture.announcementEventJson).id,
      announcementEventJson: fixture.announcementEventJson,
      oraclePubkey: fixture.oraclePubkey,
    },
  };
}

beforeAll(async () => {
  wasm.initSync({
    module: readFileSync("src/lib/kormir-wasm-pkg/kormir_wasm_bg.wasm"),
  });
  __setKormirModuleForTest(wasm);
  const authority = await retainedOracleAuthority(binding);
  registeredAuthority = {
    eventId: fixture.eventId,
    outcomes: authority.outcomes,
    threshold: authority.threshold,
    oracles: authority.oracles,
  };
});
beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
  fetchAnnouncement.mockReset();
  fetchCompanions.mockReset();
});

describe("retained browser oracle authority", () => {
  it("reads only a verified same-oracle exact88-root/exact89-parent explanation", async () => {
    const context = {
      oraclePubkey: fixture.oraclePubkey,
      announcementEventJson: fixture.announcementEventJson,
      attestationEventJson: artifact.eventJson,
    };
    const template = createOracleExplanationTemplate(
      context,
      "<b>Public explanation</b>",
      1700000001,
    );
    const valid = finalizeEvent(structuredClone(template), hexToBytes("11".repeat(32)));
    const foreign = finalizeEvent(structuredClone(template), hexToBytes("22".repeat(32)));
    expect(
      verifyOracleResolutionExplanation(
        context,
        JSON.stringify(new NDKEvent(undefined, valid).rawEvent()),
      ).content,
    ).toBe("<b>Public explanation</b>");
    fetchAnnouncement.mockResolvedValue(
      new NDKEvent(undefined, JSON.parse(fixture.announcementEventJson)),
    );
    fetchCompanions.mockResolvedValue(
      new Set([new NDKEvent(undefined, foreign), new NDKEvent(undefined, valid)]),
    );
    const read = async () => ({
      conditionId,
      attestedOutcome: "YES",
      oracleWitness: {},
      registeredAuthority,
      attestationEvent: oracleEventToWire(artifact.eventJson),
    });
    await expect(
      readBrowserResolutionExplanation(conditionId, ["wss://relay.example"], read),
    ).resolves.toBe("<b>Public explanation</b>");
    expect(fetchAnnouncement.mock.calls[0]?.[0]).toMatchObject({
      ids: [JSON.parse(fixture.announcementEventJson).id],
      kinds: [88],
      authors: [fixture.oraclePubkey],
      limit: 1,
    });
    expect(fetchCompanions.mock.calls[0]?.[0]).toMatchObject({
      "#e": [JSON.parse(artifact.eventJson).id],
      limit: 12,
    });
    for (const changed of [
      { ...template, kind: 1 },
      { ...template, content: "あ".repeat(1366) },
      {
        ...template,
        tags: template.tags.map((tag) =>
          tag[0] === "E" ? ["E", "00".repeat(32), "", fixture.oraclePubkey] : tag,
        ),
      },
      {
        ...template,
        tags: template.tags.map((tag) =>
          tag[0] === "e" ? ["e", "00".repeat(32), "", fixture.oraclePubkey] : tag,
        ),
      },
    ]) {
      fetchCompanions.mockResolvedValue(
        new Set([new NDKEvent(undefined, finalizeEvent(changed, hexToBytes("11".repeat(32))))]),
      );
      await expect(
        readBrowserResolutionExplanation(conditionId, ["wss://relay.example"], read),
      ).resolves.toBeNull();
    }
  });

  it("verifies independently generated real DLC and preserves exact wire event bytes", async () => {
    const verified = await verifyRetainedOracleAttestation(binding, "YES", artifact);
    expect(verified.attestationEventId).toBe(readSignedOracleEvent(artifact.eventJson, 89).id);
    const authority = await retainedOracleAuthority(binding);
    expect(authority.oracles[0]!.noncePoint).toHaveLength(64);
    expect(authority.oracles[0]!.announcementIdentity).toBe(
      createHash("sha256").update(Buffer.from(fixture.announcementHex, "hex")).digest("hex"),
    );
    expect(authority.oracles[0]!.announcementIdentity).not.toBe(
      JSON.parse(fixture.announcementEventJson).id,
    );
    expect(JSON.parse(oracleWireEventJson(oracleEventToWire(artifact.eventJson)))).toEqual(
      JSON.parse(artifact.eventJson),
    );
  });

  it.each([
    ["wrong condition", { ...binding, conditionId: "00".repeat(32) }, "YES"],
    ["wrong event", { ...binding, oracleEventId: "foreign" }, "YES"],
    ["wrong oracle", { ...binding, oraclePubkey: "00".repeat(32) }, "YES"],
    ["wrong outcomes", { ...binding, outcomes: ["A", "B"] }, "YES"],
    ["wrong choice", binding, "NO"],
  ] as const)("rejects %s without a new signing path", async (_name, request, outcome) => {
    await expect(verifyRetainedOracleAttestation(request, outcome, artifact)).rejects.toThrow();
  });

  it("does not equate a generic or foreign engine response with confirmation", async () => {
    const response = {
      conditionId,
      attestedOutcome: "YES",
      oracleWitness: {},
      registeredAuthority,
      attestationEvent: oracleEventToWire(artifact.eventJson),
    };
    await expect(
      verifiedEngineOracleEvidence(binding, artifact, "YES", async () => response),
    ).resolves.toMatchObject({ conditionId, outcome: "YES" });
    await expect(
      verifiedEngineOracleEvidence(binding, artifact, "YES", async () => null),
    ).rejects.toThrow(/unavailable/);
    await expect(
      verifiedEngineOracleEvidence(binding, artifact, "YES", async () => ({
        ...response,
        attestedOutcome: "NO",
      })),
    ).rejects.toThrow(/unavailable/);
    await expect(
      verifiedEngineOracleEvidence(binding, artifact, "YES", async () => ({
        ...response,
        attestationEvent: { ...response.attestationEvent, createdAt: 0 },
      })),
    ).rejects.toThrow();
    for (const changed of [
      {},
      { ...registeredAuthority, eventId: "foreign" },
      { ...registeredAuthority, threshold: 2 },
      { ...registeredAuthority, outcomes: ["A", "B"] },
      {
        ...registeredAuthority,
        oracles: [{ ...registeredAuthority.oracles[0], noncePoint: "00".repeat(32) }],
      },
    ]) {
      await expect(
        verifiedEngineOracleEvidence(binding, artifact, "YES", async () => ({
          ...response,
          registeredAuthority: changed,
        })),
      ).rejects.toThrow();
    }
    await expect(
      verifiedEngineOracleEvidence(
        binding,
        artifact,
        "YES",
        async () => ({
          ...response,
          registeredAuthority: {
            ...registeredAuthority,
            oracles: [{ ...registeredAuthority.oracles[0], announcementIdentity: "00".repeat(32) }],
          },
        }),
        fixture.announcementHex,
      ),
    ).rejects.toThrow(/identity/);
  });
});

describe("production creator row and shared coordinator", () => {
  it.each(["signed public pair", "legacy hex only"])(
    "recovers %s with exact88 and exact89 before retry, without another signature",
    async (source) => {
      const restored = market();
      delete restored.oracle!.announcementEventJson;
      restored.oracle = {
        ...restored.oracle!,
        attestationHex: artifact.attestationHex,
        attestedOutcome: "YES",
        ...(source === "signed public pair" ? { attestationEventJson: artifact.eventJson } : {}),
      };
      const writer = createCreatorMarketsStore(() => localStorage);
      writer.getState().addCreatedMarket(restored);
      fetchAnnouncement.mockResolvedValue(
        new NDKEvent(undefined, JSON.parse(fixture.announcementEventJson)),
      );
      const publish = vi
        .spyOn(NDKEvent.prototype, "publish")
        .mockResolvedValue(new Set([{}]) as unknown as Awaited<ReturnType<NDKEvent["publish"]>>);
      const network = vi.fn(async () => {
        throw new Error("lost response");
      });
      vi.stubGlobal("fetch", network);
      try {
        const result = await publishBrowserOracleOutcome(
          conditionId,
          "YES",
          undefined,
          ["wss://relay.example"],
          writer,
          async () => ({
            conditionId,
            attestedOutcome: "YES",
            oracleWitness: {},
            registeredAuthority,
            attestationEvent: oracleEventToWire(artifact.eventJson),
          }),
        );
        expect(result.failures).toEqual([]);
        expect(result.record.attestation).toEqual(artifact);
        expect(result.record.chosenOutcome).toBe("YES");
        expect(result.record.engineEvidence).not.toBeNull();
        expect(publish).toHaveBeenCalledTimes(1);
        expect(network).toHaveBeenCalledTimes(source === "signed public pair" ? 1 : 0);
        expect(fetchAnnouncement.mock.calls[0]?.[0]).toMatchObject({
          ids: [JSON.parse(fixture.announcementEventJson).id],
          kinds: [88],
          limit: 1,
        });
        const reader = createCreatorMarketsStore(() => localStorage);
        expect((await reader.getState().readOraclePublication(conditionId))?.attestation).toEqual(
          artifact,
        );
        const recoveredJson = JSON.stringify(
          new NDKEvent(undefined, JSON.parse(fixture.announcementEventJson)).rawEvent(),
        );
        expect(reader.getState().markets[0]?.oracle?.announcementEventJson).toBe(recoveredJson);
        expect(JSON.parse(recoveredJson)).toEqual(JSON.parse(fixture.announcementEventJson));
      } finally {
        publish.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );
  it("refuses the actual browser adapter before recovery or delivery when startup storage is unavailable", async () => {
    const store = createCreatorMarketsStore(() => {
      throw new Error("unavailable");
    });
    store.setState({ markets: [market()] });
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    try {
      await expect(
        publishBrowserOracleOutcome(conditionId, "YES", undefined, ["wss://relay.example"], store),
      ).rejects.toThrow(/storage/);
      expect(fetchAnnouncement).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("validates the real signed public mirror and discards only an invalid optional companion", async () => {
    const publicRecord = market();
    publicRecord.oracle = {
      ...publicRecord.oracle!,
      attestedOutcome: "YES",
      attestationHex: artifact.attestationHex,
      attestationEventJson: artifact.eventJson,
      explanationEventJson: "invalid",
    };
    const event = finalizeEvent(
      {
        kind: CREATOR_MARKETS_KIND,
        created_at: 1700000002,
        content: JSON.stringify({ markets: [publicRecord] }),
        tags: [["d", CREATOR_MARKETS_D_TAG]],
      },
      hexToBytes("11".repeat(32)),
    );
    fetchAnnouncement.mockResolvedValue(new NDKEvent(undefined, event));
    const received = await fetchNip78CreatorMarkets(fixture.oraclePubkey, {
      relays: ["wss://relay.example"],
    });
    expect(received).toHaveLength(1);
    expect(received?.[0]?.oracle?.attestationEventJson).toBe(artifact.eventJson);
    expect(received?.[0]?.oracle?.explanationEventJson).toBeUndefined();
    expect(received?.[0]?.oracle?.chosenOutcome).toBeUndefined();
    fetchAnnouncement.mockResolvedValue(new NDKEvent(undefined, { ...event, content: "changed" }));
    await expect(
      fetchNip78CreatorMarkets(fixture.oraclePubkey, { relays: ["wss://relay.example"] }),
    ).resolves.toBeNull();
  });
  it("browser adapter reconciles a lost engine response and cold-retries exact89 without a signer", async () => {
    const writer = createCreatorMarketsStore(() => localStorage);
    writer.getState().addCreatedMarket(market());
    await writer.getState().saveOraclePublication(conditionId, {
      binding,
      chosenOutcome: "YES",
      attestation: artifact,
      relayPublished: false,
      engineEvidence: null,
      explanationEventJson: null,
      explanationRelayPublished: false,
    });
    const publish = vi
      .spyOn(NDKEvent.prototype, "publish")
      .mockRejectedValueOnce(new Error("relay down"));
    const network = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("lost POST response");
    });
    vi.stubGlobal("fetch", network);
    const response = {
      conditionId,
      attestedOutcome: "YES",
      oracleWitness: {},
      registeredAuthority,
      attestationEvent: oracleEventToWire(artifact.eventJson),
    };
    try {
      const first = await publishBrowserOracleOutcome(
        conditionId,
        "YES",
        undefined,
        ["wss://relay.example"],
        writer,
        async () => response,
      );
      expect(first.failures).toEqual(["relay"]);
      expect(first.record.engineEvidence).not.toBeNull();
      expect(network).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(network.mock.calls[0]?.[1]?.body))).toEqual(
        oracleEventToWire(artifact.eventJson),
      );
      publish.mockResolvedValueOnce(
        new Set([{}]) as unknown as Awaited<ReturnType<NDKEvent["publish"]>>,
      );
      const reader = createCreatorMarketsStore(() => localStorage);
      const resumed = await publishBrowserOracleOutcome(
        conditionId,
        "YES",
        undefined,
        ["wss://relay.example"],
        reader,
        async () => response,
      );
      expect(resumed.failures).toEqual([]);
      expect(network).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(2);
      expect((await reader.getState().readOraclePublication(conditionId))?.attestation).toEqual(
        artifact,
      );
    } finally {
      publish.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("original companion preparation failure cold-retries one1111 without another oracle signature", async () => {
    const writer = createCreatorMarketsStore(() => localStorage);
    writer.getState().addCreatedMarket(market());
    await writer.getState().saveOracleExplanationDraft(conditionId, "Original public explanation.");
    const oracleSign = vi.fn(async () => artifact);
    const evidence = await verifyRetainedOracleAttestation(binding, "YES", artifact);
    const relay = vi.fn(async (json: string) => ({ eventId: JSON.parse(json).id as string }));
    const ports = {
      store: creatorOraclePublicationStore(writer),
      prepareAttestation: oracleSign,
      verifyAttestation: verifyRetainedOracleAttestation,
      publishRelay: relay,
      submitEngine: async () => evidence,
      prepareExplanation: async () => {
        throw new Error("companion preparation interrupted");
      },
    };
    const first = await publishOracleOutcome(ports, binding, "YES", "Original public explanation.");
    expect(first.failures).toEqual(["explanation-preparation"]);
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
    const reader = createCreatorMarketsStore(() => localStorage);
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const publish = vi
      .spyOn(NDKEvent.prototype, "publish")
      .mockResolvedValue(new Set([{}]) as unknown as Awaited<ReturnType<NDKEvent["publish"]>>);
    try {
      const resumed = await publishBrowserOracleOutcome(
        conditionId,
        "YES",
        "Changed input must not replace draft",
        ["wss://relay.example"],
        reader,
      );
      expect(resumed.failures).toEqual([]);
      expect(resumed.record.attestation).toEqual(artifact);
      expect(JSON.parse(resumed.record.explanationEventJson!).content).toBe(
        "Original public explanation.",
      );
      const json = resumed.record.explanationEventJson;
      await publishBrowserOracleOutcome(
        conditionId,
        "YES",
        undefined,
        ["wss://relay.example"],
        createCreatorMarketsStore(() => localStorage),
      );
      expect(
        (await reader.getState().readOraclePublication(conditionId))?.explanationEventJson,
      ).toBe(json);
      expect(oracleSign).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally {
      publish.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("cold-reads the exact saved event and retries only the unconfirmed destination", async () => {
    const writer = createCreatorMarketsStore(() => localStorage);
    writer.getState().addCreatedMarket(market());
    const prepare = vi.fn(async () => {
      const saved = JSON.parse(localStorage.getItem("bitcaster-creator-markets")!).state.markets[0]
        .oracle;
      expect(saved.chosenOutcome).toBe("YES");
      expect(saved.attestationEventJson).toBeUndefined();
      return artifact;
    });
    const relay = vi.fn(async () => ({
      eventId: readSignedOracleEvent(artifact.eventJson, 89).id,
    }));
    const engine = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const base = {
      prepareAttestation: prepare,
      verifyAttestation: verifyRetainedOracleAttestation,
      publishRelay: relay,
      submitEngine: engine,
      prepareExplanation: vi.fn(),
    };
    const first = await publishOracleOutcome(
      { ...base, store: creatorOraclePublicationStore(writer) },
      binding,
      "YES",
    );
    expect(first.failures).toEqual(["engine"]);
    expect(first.record.relayPublished).toBe(true);
    const reader = createCreatorMarketsStore(() => localStorage);
    const recovered = await reader.getState().readOraclePublication(conditionId);
    expect(recovered?.attestation).toEqual(artifact);
    const evidence = await verifyRetainedOracleAttestation(binding, "YES", artifact);
    const resumedEngine = vi.fn(async (_binding: typeof binding, _json: string) => evidence);
    const resumed = await retryOraclePublication(
      {
        ...base,
        store: creatorOraclePublicationStore(reader),
        submitEngine: resumedEngine,
      },
      binding,
    );
    expect(resumed.failures).toEqual([]);
    expect(resumed.record.engineEvidence).toEqual(evidence);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(resumedEngine.mock.calls[0]?.[1]).toBe(artifact.eventJson);
    await expect(
      publishOracleOutcome(
        { ...base, store: creatorOraclePublicationStore(reader) },
        binding,
        "NO",
      ),
    ).rejects.toThrow();
  });

  it("attempts the engine despite relay and optional explanation failure", async () => {
    const writer = createCreatorMarketsStore(() => localStorage);
    writer.getState().addCreatedMarket(market());
    const evidence = await verifyRetainedOracleAttestation(binding, "YES", artifact);
    const engine = vi.fn(async () => evidence);
    const result = await publishOracleOutcome(
      {
        store: creatorOraclePublicationStore(writer),
        prepareAttestation: async () => artifact,
        verifyAttestation: verifyRetainedOracleAttestation,
        publishRelay: async () => {
          throw new Error("relay down");
        },
        submitEngine: engine,
        prepareExplanation: async () => {
          throw new Error("companion failure");
        },
      },
      binding,
      "YES",
      "optional public text",
    );
    expect(result.failures).toEqual(["explanation-preparation", "relay"]);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(result.record.engineEvidence).toEqual(evidence);
  });

  it.each(["startup getter", "choice write", "signed-event write"])(
    "fails closed on %s failure before external delivery",
    async (failure) => {
      const prepare = vi.fn(async () => artifact);
      const relay = vi.fn();
      const engine = vi.fn();
      let writes = 0;
      const storage = {
        getItem: (key: string) => localStorage.getItem(key),
        removeItem: (key: string) => localStorage.removeItem(key),
        setItem(key: string, value: string) {
          writes++;
          if (writes === (failure === "signed-event write" ? 3 : 2))
            throw new Error("storage refused");
          localStorage.setItem(key, value);
        },
      };
      const store = createCreatorMarketsStore(() => {
        if (failure === "startup getter") throw new Error("storage unavailable");
        return storage;
      });
      store.getState().addCreatedMarket(market());
      await expect(
        publishOracleOutcome(
          {
            store: creatorOraclePublicationStore(store),
            prepareAttestation: prepare,
            verifyAttestation: verifyRetainedOracleAttestation,
            publishRelay: relay,
            submitEngine: engine,
            prepareExplanation: vi.fn(),
          },
          binding,
          "YES",
        ),
      ).rejects.toThrow();
      expect(prepare).toHaveBeenCalledTimes(failure === "signed-event write" ? 1 : 0);
      expect(relay).not.toHaveBeenCalled();
      expect(engine).not.toHaveBeenCalled();
    },
  );

  it("publishes a strict public projection and preserves local immutable recovery on merge", () => {
    const local = market();
    local.oracle = {
      ...local.oracle!,
      chosenOutcome: "YES",
      chosenAt: "private",
      explanationDraft: "private draft",
      publicationFailures: ["engine"],
      relayPublished: true,
      engineBaseUrl: "https://private.example",
    };
    const projected = publicCreatorMarket(local);
    expect(JSON.stringify(projected)).not.toMatch(
      /private|chosenOutcome|publicationFailures|relayPublished|engineBaseUrl/,
    );
    const remote = {
      ...market(),
      createdAt: "2099-01-01T00:00:00Z",
      oracle: { ...market().oracle!, outcomes: ["A", "B"] },
    };
    expect(mergeCreatorMarket(local, remote).oracle).toEqual(local.oracle);
  });
});
