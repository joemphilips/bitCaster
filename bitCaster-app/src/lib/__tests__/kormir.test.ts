import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setKormirModuleForTest,
  createEnumAnnouncement,
  ensureKormirNsec,
  getKormir,
  getOracleAnnouncementEventId,
  getOraclePublicKey,
  importEnumAnnouncement,
  resetKormir,
  restoreKormirWithNsec,
  setPendingKormirNsec,
  signEnumAttestation,
} from "../kormir";
import { getPublicKey } from "nostr-tools/pure";

// ---------------------------------------------------------------------------
// Fake kormir-wasm module used in place of the real dynamic import.
// ---------------------------------------------------------------------------

interface FakeKormir {
  instanceId: number;
  create_enum_event: ReturnType<typeof vi.fn>;
  sign_enum_event: ReturnType<typeof vi.fn>;
  import_enum_event: ReturnType<typeof vi.fn>;
  list_events: ReturnType<typeof vi.fn>;
  get_public_key: ReturnType<typeof vi.fn>;
}

function buildFakeModule(publicKey = "02abc") {
  const defaultInit = vi.fn().mockResolvedValue({});
  const restore = vi.fn().mockResolvedValue(undefined);
  let nextId = 0;
  const newFn = vi.fn().mockImplementation(async (_relays: string[]) => {
    nextId += 1;
    const fake: FakeKormir = {
      instanceId: nextId,
      create_enum_event: vi.fn().mockResolvedValue("deadbeef"),
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
        new: newFn,
      },
    } as unknown as Parameters<typeof __setKormirModuleForTest>[0],
    init: defaultInit,
    restore,
    newFn,
  };
}

describe("kormir wrapper", () => {
  beforeEach(() => {
    __setKormirModuleForTest(null);
    resetKormir();
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

  it("signEnumAttestation delegates to the instance and returns the attestation hex", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const hex = await signEnumAttestation(["wss://a"], "event_1", "Yes");

    expect(hex).toBe("beeff00d");
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    expect(instance.sign_enum_event).toHaveBeenCalledWith("event_1", "Yes");
  });

  it("importEnumAnnouncement delegates to the instance and returns the recovered event id", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const eventId = await importEnumAnnouncement(["wss://a"], "annhex");

    expect(eventId).toBe("event_1");
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    expect(instance.import_enum_event).toHaveBeenCalledWith("annhex");
  });

  it("signEnumAttestation re-imports the announcement BEFORE signing on a fresh profile", async () => {
    // Simulates the fresh-profile flow: restore(nsec) wiped the nonce-index
    // store, so the announcement hex must be re-imported before sign succeeds.
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const hex = await signEnumAttestation(["wss://a"], "event_1", "Yes", "annhex");

    expect(hex).toBe("beeff00d");
    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    expect(instance.import_enum_event).toHaveBeenCalledWith("annhex");
    expect(instance.sign_enum_event).toHaveBeenCalledWith("event_1", "Yes");
    // Import must run before signing — otherwise sign_enum_event hits NotFound.
    expect(instance.import_enum_event.mock.invocationCallOrder[0]).toBeLessThan(
      instance.sign_enum_event.mock.invocationCallOrder[0],
    );
  });

  it("signEnumAttestation does not import when no announcement hex is supplied", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    await signEnumAttestation(["wss://a"], "event_1", "Yes");

    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    expect(instance.import_enum_event).not.toHaveBeenCalled();
    expect(instance.sign_enum_event).toHaveBeenCalledWith("event_1", "Yes");
  });

  it("signEnumAttestation surfaces a clear error when re-import fails", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    instance.import_enum_event.mockRejectedValueOnce(new Error("bad nonce scan"));

    await expect(signEnumAttestation(["wss://a"], "event_1", "Yes", "annhex")).rejects.toThrow(
      /re-import DLC oracle announcement.*bad nonce scan/,
    );
    // Signing is never attempted if the import fails.
    expect(instance.sign_enum_event).not.toHaveBeenCalled();
  });

  it("signEnumAttestation falls back to the locally stored attestation when relay publishing fails", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    instance.sign_enum_event.mockRejectedValueOnce("relay publish failed");
    instance.list_events.mockResolvedValueOnce([
      {
        event_name: "event_1",
        attestation: "f00dbabe",
      },
    ]);

    const hex = await signEnumAttestation(["wss://a"], "event_1", "Yes");

    expect(hex).toBe("f00dbabe");
  });

  it("getOracleAnnouncementEventId reads the stored kind-88 Nostr event id", async () => {
    const { module } = buildFakeModule();
    __setKormirModuleForTest(module);

    const instance = (await getKormir(["wss://a"])) as unknown as FakeKormir;
    instance.list_events.mockResolvedValueOnce([
      {
        event_name: "event_1",
        announcement_event_id: "c".repeat(64),
      },
    ]);

    await expect(getOracleAnnouncementEventId(["wss://a"], "event_1")).resolves.toBe(
      "c".repeat(64),
    );
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
