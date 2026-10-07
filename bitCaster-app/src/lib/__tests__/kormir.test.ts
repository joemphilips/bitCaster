import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setKormirModuleForTest,
  browserOracleBackupValidator,
  createEnumAnnouncement,
  ensureKormirNsec,
  getKormir,
  getOraclePublicKey,
  importEnumAnnouncement,
  prepareEnumAnnouncement,
  prepareEnumAttestation,
  resetKormir,
  restoreKormirWithNsec,
  setPendingKormirNsec,
} from "../kormir";
import { getPublicKey } from "nostr-tools/pure";

// ---------------------------------------------------------------------------
// Fake kormir-wasm module used in place of the real dynamic import.
// ---------------------------------------------------------------------------

interface FakeKormir {
  instanceId: number;
  create_enum_event: ReturnType<typeof vi.fn>;
  prepare_enum_event: ReturnType<typeof vi.fn>;
  prepare_enum_attestation: ReturnType<typeof vi.fn>;
  sign_enum_event: ReturnType<typeof vi.fn>;
  import_enum_event: ReturnType<typeof vi.fn>;
  list_events: ReturnType<typeof vi.fn>;
  get_public_key: ReturnType<typeof vi.fn>;
}

function buildFakeModule(publicKey = "02abc") {
  const defaultInit = vi.fn().mockResolvedValue({});
  const restore = vi.fn().mockResolvedValue(undefined);
  const validateAuthority = vi.fn();
  let nextId = 0;
  const newFn = vi.fn().mockImplementation(async (_relays: string[]) => {
    nextId += 1;
    const fake: FakeKormir = {
      instanceId: nextId,
      create_enum_event: vi.fn().mockResolvedValue("deadbeef"),
      prepare_enum_event: vi.fn(),
      prepare_enum_attestation: vi.fn(),
      sign_enum_event: vi.fn().mockResolvedValue("beeff00d"),
      import_enum_event: vi.fn().mockResolvedValue("event_1"),
      list_events: vi.fn().mockResolvedValue([]),
      get_public_key: vi.fn().mockReturnValue(publicKey),
    };
    return fake;
  });

  return {
    module: {
      default: defaultInit,
      Kormir: {
        restore,
        validate_enum_authority: validateAuthority,
        new: newFn,
      },
    } as unknown as Parameters<typeof __setKormirModuleForTest>[0],
    init: defaultInit,
    restore,
    validateAuthority,
    newFn,
  };
}

describe("kormir wrapper", () => {
  beforeEach(() => {
    __setKormirModuleForTest(null);
    resetKormir();
  });

  it("validates private authority without opening or changing the oracle store", async () => {
    const { module, validateAuthority, restore, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);
    const summary = {
      eventId: "event_1",
      oraclePubkey: "a".repeat(64),
      outcomes: ["YES", "NO"],
      noncePoint: "b".repeat(64),
    };
    validateAuthority.mockReturnValue(JSON.stringify(summary));

    await expect(
      browserOracleBackupValidator.validateAuthority("private DTO", summary.oraclePubkey),
    ).resolves.toEqual(summary);
    expect(validateAuthority).toHaveBeenCalledWith("private DTO", summary.oraclePubkey);
    expect(restore).not.toHaveBeenCalled();
    expect(newFn).not.toHaveBeenCalled();
  });

  it("replaces nested private validation errors with a fixed diagnostic", async () => {
    const { module, validateAuthority } = buildFakeModule();
    __setKormirModuleForTest(module);
    validateAuthority.mockImplementation(() => {
      throw new Error("private scalar must not escape");
    });
    await expect(
      browserOracleBackupValidator.validateAuthority("private DTO", "a".repeat(64)),
    ).rejects.toThrow("Private oracle backup: invalid-record.");
  });

  it("caches the Kormir instance across getKormir calls", async () => {
    const { module, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);

    const first = await getKormir(["wss://a"]);
    const second = await getKormir(["wss://a"]);

    expect(first).toBe(second);
    expect(newFn).toHaveBeenCalledTimes(1);
    expect(newFn).toHaveBeenCalledWith(["wss://a"]);
  });

  it("resetKormir drops the cached instance so the next call rebuilds it", async () => {
    const { module, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);

    await getKormir(["wss://a"]);
    resetKormir();
    await getKormir(["wss://b"]);

    expect(newFn).toHaveBeenCalledTimes(2);
    expect(newFn).toHaveBeenNthCalledWith(1, ["wss://a"]);
    expect(newFn).toHaveBeenNthCalledWith(2, ["wss://b"]);
  });

  it("rebuilds the instance when the relay list changes", async () => {
    const { module, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);

    const first = await getKormir(["wss://a"]);
    const second = await getKormir(["wss://b"]);

    expect(first).not.toBe(second);
    expect(newFn).toHaveBeenCalledTimes(2);
    expect(newFn).toHaveBeenNthCalledWith(1, ["wss://a"]);
    expect(newFn).toHaveBeenNthCalledWith(2, ["wss://b"]);
  });

  it("does not rebuild when the relay list is reused", async () => {
    const { module, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);

    await getKormir(["wss://a", "wss://b"]);
    await getKormir(["wss://a", "wss://b"]);

    expect(newFn).toHaveBeenCalledTimes(1);
  });

  it("clears the cache when construction fails so a retry can re-attempt", async () => {
    const defaultInit = vi.fn().mockResolvedValue({});
    const restore = vi.fn().mockResolvedValue(undefined);
    const newFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ instanceId: 1 });
    const module = {
      default: defaultInit,
      Kormir: { restore, new: newFn },
    } as unknown as Parameters<typeof __setKormirModuleForTest>[0];
    __setKormirModuleForTest(module);

    await expect(getKormir(["wss://a"])).rejects.toThrow("boom");
    // After the failure the cached promise must be cleared so the next call
    // rebuilds instead of resurfacing the stale rejection forever.
    const second = await getKormir(["wss://a"]);
    expect(second).toBeDefined();
    expect(newFn).toHaveBeenCalledTimes(2);
  });

  it("restoreKormirWithNsec pushes the key into kormir and clears the cached instance", async () => {
    const { module, restore, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);

    await getKormir(["wss://a"]);
    expect(newFn).toHaveBeenCalledTimes(1);

    await restoreKormirWithNsec("nsec1example");
    expect(restore).toHaveBeenCalledWith("nsec1example");

    await getKormir(["wss://a"]);
    expect(newFn).toHaveBeenCalledTimes(2);
  });

  it("setPendingKormirNsec defers restore until the next getKormir call", async () => {
    const { module, restore, newFn } = buildFakeModule();
    __setKormirModuleForTest(module);

    setPendingKormirNsec("11".repeat(32));
    // No kormir calls yet — the nsec should be remembered, not applied.
    expect(restore).not.toHaveBeenCalled();
    expect(newFn).not.toHaveBeenCalled();

    await getKormir(["wss://a"]);

    expect(restore).toHaveBeenCalledWith("11".repeat(32));
    expect(newFn).toHaveBeenCalledTimes(2);
    expect(newFn.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
  });

  it("setPendingKormirNsec is a one-shot: a second getKormir does not re-restore", async () => {
    const { module, restore } = buildFakeModule();
    __setKormirModuleForTest(module);

    setPendingKormirNsec("11".repeat(32));
    await getKormir(["wss://a"]);
    // Reset the in-memory instance so the next call rebuilds, but no new
    // pending nsec has been set.
    resetKormir();
    await getKormir(["wss://a"]);

    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("setPendingKormirNsec keeps existing kormir storage when the key already matches", async () => {
    const nsecHex = "11".repeat(32);
    const { module, restore, newFn } = buildFakeModule(`02${getPublicKey(hexToBytes(nsecHex))}`);
    __setKormirModuleForTest(module);

    setPendingKormirNsec(nsecHex);
    await getKormir(["wss://a"]);

    expect(restore).not.toHaveBeenCalled();
    expect(newFn).toHaveBeenCalledTimes(1);
  });

  it("setPendingKormirNsec(null) forgets a previously-staged key", async () => {
    const { module, restore } = buildFakeModule();
    __setKormirModuleForTest(module);

    setPendingKormirNsec("nsec1deferred");
    setPendingKormirNsec(null);
    await getKormir(["wss://a"]);

    expect(restore).not.toHaveBeenCalled();
  });

  it("createEnumAnnouncement delegates to the instance and returns the announcement hex", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const hex = await createEnumAnnouncement(
      ["wss://a"],
      "what_is_the_bitcoin_price",
      ["Yes", "No"],
      1_750_000_000,
      "What is the Bitcoin price?",
      "Resolve based on the reference exchange close.",
    );

    expect(hex).toBe("deadbeef");
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    expect(instance.create_enum_event).toHaveBeenCalledWith(
      "what_is_the_bitcoin_price",
      ["Yes", "No"],
      1_750_000_000,
      "What is the Bitcoin price?",
      "Resolve based on the reference exchange close.",
    );
  });

  it("prepares the exact announcement envelope without publishing", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    const prepared = {
      artifact_hex: "deadbeef",
      nostr_event_json: '{ "kind": 88, "content": "exact signed announcement" }',
      free: vi.fn(),
    };
    instance.prepare_enum_event.mockResolvedValue(prepared);

    await expect(
      prepareEnumAnnouncement(
        ["wss://a"],
        "event_1",
        ["Alpha", "Beta"],
        1_750_000_000,
        "Event title",
        "Event description",
      ),
    ).resolves.toEqual({
      artifactHex: "deadbeef",
      eventJson: prepared.nostr_event_json,
    });
    expect(instance.prepare_enum_event).toHaveBeenCalledWith(
      "event_1",
      ["Alpha", "Beta"],
      1_750_000_000,
      "Event title",
      "Event description",
    );
    expect(instance.create_enum_event).not.toHaveBeenCalled();
    expect(prepared.free).toHaveBeenCalledOnce();
  });

  it("imports then prepares an attestation against the retained announcement without publishing", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    const announcementEventJson = '{ "kind": 88, "id": "retained announcement" }';
    const prepared = {
      artifact_hex: "beeff00d",
      nostr_event_json: '{ "kind": 89, "content": "exact signed attestation" }',
      free: vi.fn(),
    };
    instance.prepare_enum_attestation.mockResolvedValue(prepared);

    await expect(
      prepareEnumAttestation(["wss://a"], "event_1", "Alpha", announcementEventJson, "deadbeef"),
    ).resolves.toEqual({
      artifactHex: "beeff00d",
      eventJson: prepared.nostr_event_json,
    });
    expect(instance.import_enum_event).toHaveBeenCalledWith("deadbeef");
    expect(instance.import_enum_event.mock.invocationCallOrder[0]).toBeLessThan(
      instance.prepare_enum_attestation.mock.invocationCallOrder[0],
    );
    expect(instance.prepare_enum_attestation).toHaveBeenCalledWith(
      "event_1",
      "Alpha",
      announcementEventJson,
    );
    expect(instance.sign_enum_event).not.toHaveBeenCalled();
    expect(prepared.free).toHaveBeenCalledOnce();
  });

  it("preserves a preparation refusal without falling back to an unrelated stored attestation", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    instance.prepare_enum_attestation.mockRejectedValue(new Error("Conflicting outcome"));
    instance.list_events.mockResolvedValue([{ event_name: "event_1", attestation: "beeff00d" }]);

    await expect(
      prepareEnumAttestation(["wss://a"], "event_1", "Beta", '{"kind":88}'),
    ).rejects.toThrow("Conflicting outcome");
    expect(instance.list_events).not.toHaveBeenCalled();
    expect(instance.sign_enum_event).not.toHaveBeenCalled();
    expect(instance.import_enum_event).not.toHaveBeenCalled();
  });

  it("importEnumAnnouncement delegates to the instance and returns the recovered event id", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const eventId = await importEnumAnnouncement(["wss://a"], "annhex");

    expect(eventId).toBe("event_1");
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    expect(instance.import_enum_event).toHaveBeenCalledWith("annhex");
  });

  it("getOraclePublicKey returns the key from the kormir instance", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const key = await getOraclePublicKey(["wss://a"]);

    expect(key).toBe("02abc");
  });

  it("ensureKormirNsec does not restore when kormir already uses the requested key", async () => {
    const nsecHex = "11".repeat(32);
    const publicKey = `02${getPublicKey(hexToBytes(nsecHex))}`;
    const { module, restore } = buildFakeModule(publicKey);
    __setKormirModuleForTest(module);

    await ensureKormirNsec(["wss://a"], nsecHex);

    expect(restore).not.toHaveBeenCalled();
  });

  it("ensureKormirNsec restores and rebuilds when kormir uses a different key", async () => {
    const { module, restore, newFn } = buildFakeModule(`02${"22".repeat(32)}`);
    __setKormirModuleForTest(module);

    await ensureKormirNsec(["wss://a"], "11".repeat(32));

    expect(restore).toHaveBeenCalledWith("11".repeat(32));
    expect(newFn).toHaveBeenCalledTimes(1);
    await getKormir(["wss://a"]);
    expect(newFn).toHaveBeenCalledTimes(2);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
