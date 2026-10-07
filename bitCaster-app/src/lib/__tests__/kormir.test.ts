import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { useSettingsStore } from "@/stores/settings";
import { withCreatorDocumentLock } from "../browserCreatorDocumentLock";
import {
  __setKormirModuleForTest,
  browserOracleBackupValidator,
  BrowserOracleMutationError,
  prepareBrowserOracleMutation,
  prepareEnumAnnouncement,
  prepareEnumAttestation,
  setPendingKormirNsec,
  withBrowserOracleMutation,
  type Kormir,
} from "../kormir";

const signer = vi.hoisted(() => ({ revision: 0 }));
vi.mock("../nostrSignerRevision", () => ({ getNostrSignerRevision: () => signer.revision }));
const keyA = "11".repeat(32);
const keyB = "22".repeat(32);
const pubkeyA = getPublicKey(new Uint8Array(32).fill(0x11));

function fakeProvider() {
  const origin = { key: keyA, retained: false };
  const calls = { local: 0, freed: 0 };
  const restore = vi.fn(async (key: string) => {
    if (origin.retained && origin.key !== key) throw 7;
    origin.key = key;
  });
  const construct = vi.fn(async (_relays: string[]) => {
    const installed = origin.key;
    return {
      get_public_key: () => getPublicKey(new Uint8Array(32).fill(installed === keyA ? 0x11 : 0x22)),
      import_enum_event: async () => {
        calls.local += 1;
        return "event";
      },
      prepare_enum_event: async () => ({
        artifact_hex: "artifact",
        nostr_event_json: "event-json",
        free() {},
      }),
      prepare_enum_attestation: async () => ({
        artifact_hex: "attestation",
        nostr_event_json: "attestation-json",
        free() {},
      }),
      free: () => {
        calls.freed += 1;
      },
    } as unknown as Kormir;
  });
  const validate = vi.fn();
  const module = {
    Kormir: { restore, new: construct, validate_enum_authority: validate },
    JsError: { SigningKeyConflict: 7 },
  } as unknown as NonNullable<Parameters<typeof __setKormirModuleForTest>[0]>;
  __setKormirModuleForTest(module);
  return { origin, calls, restore, construct, validate };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installLock(beforeAdmission?: () => Promise<void>) {
  let active = false;
  const request = vi.fn(async (_name: string, action: () => Promise<unknown>) => {
    await beforeAdmission?.();
    active = true;
    try {
      return await action();
    } finally {
      active = false;
    }
  });
  vi.stubGlobal("navigator", { locks: { request } });
  return { request, isActive: () => active };
}

describe("captured browser oracle mutation", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __setKormirModuleForTest(null);
    signer.revision = 0;
    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: keyA });
  });
  it("stages a login without loading WASM or installing a key", () => {
    const provider = fakeProvider();
    setPendingKormirNsec(keyA);
    expect(provider.restore.mock.calls.length).toBe(0);
    expect(provider.construct.mock.calls.length).toBe(0);
  });
  it.each(["none", "nip07"] as const)("refuses %s before private preparation", async (mode) => {
    const provider = fakeProvider();
    useSettingsStore.setState({ nostrSignerMode: mode });
    await expect(prepareBrowserOracleMutation(pubkeyA)).rejects.toBeInstanceOf(
      BrowserOracleMutationError,
    );
    expect(provider.restore.mock.calls.length).toBe(0);
  });
  it("validates private authority without constructing or changing a core", async () => {
    const provider = fakeProvider();
    provider.validate.mockReturnValue(JSON.stringify({ eventId: "event" }));
    expect(
      (await browserOracleBackupValidator.validateAuthority("private-input", pubkeyA)).eventId,
    ).toBe("event");
    expect(provider.restore.mock.calls.length).toBe(0);
    expect(provider.construct.mock.calls.length).toBe(0);
    provider.validate.mockImplementation(() => {
      throw new Error("private authority detail");
    });
    await expect(
      browserOracleBackupValidator.validateAuthority("private-input", pubkeyA),
    ).rejects.toThrow("Private oracle backup: invalid-record.");
  });
  it("installs then constructs a fresh local core under the existing document lock", async () => {
    const provider = fakeProvider();
    const lock = installLock();
    const order: string[] = [];
    provider.restore.mockImplementation(async (key) => {
      expect(lock.isActive()).toBe(true);
      order.push("install");
      provider.origin.key = key;
    });
    const construct = provider.construct.getMockImplementation()!;
    provider.construct.mockImplementation(async (relays) => {
      expect(lock.isActive()).toBe(true);
      expect(relays.length).toBe(0);
      order.push("construct");
      return construct(relays);
    });
    await withBrowserOracleMutation(pubkeyA, async (core) => {
      expect(lock.isActive()).toBe(true);
      await core.import_enum_event("public-artifact");
      order.push("handoff");
    });
    expect(order).toEqual(["install", "construct", "handoff"]);
    expect(lock.request.mock.calls.length).toBe(1);
    expect(lock.request.mock.calls[0]?.[0]).toBe("bitcaster-creator-markets");
    expect(provider.calls.freed).toBe(1);
  });
  it("does not trust a stale tab core when origin-wide retained authority has another key", async () => {
    const provider = fakeProvider();
    const stale = await provider.construct([]);
    provider.construct.mockClear();
    provider.origin.key = keyB;
    provider.origin.retained = true;
    const operation = vi.fn(async (_core: Kormir) => {});
    installLock();
    await expect(withBrowserOracleMutation(pubkeyA, operation)).rejects.toMatchObject({
      reason: "key-conflict",
    });
    expect(stale.get_public_key() === pubkeyA).toBe(true);
    expect(provider.origin.key === keyB).toBe(true);
    expect(provider.origin.retained).toBe(true);
    expect(provider.construct.mock.calls.length).toBe(0);
    expect(operation.mock.calls.length).toBe(0);
  });
  it.each(["different-key", "A-B-A", "signer-revision"])(
    "cancels %s before lock admission",
    async (change) => {
      const provider = fakeProvider();
      const gate = deferred<void>();
      installLock(() => gate.promise);
      const admission = await prepareBrowserOracleMutation(pubkeyA);
      const pending = withCreatorDocumentLock(() => admission.withCoreLocked(async () => {}));
      if (change === "signer-revision") signer.revision += 1;
      else {
        useSettingsStore.setState({ nsecSecret: keyB });
        if (change === "A-B-A") useSettingsStore.setState({ nsecSecret: keyA });
      }
      gate.resolve();
      await expect(pending).rejects.toMatchObject({ reason: "identity-changed" });
      expect(provider.restore.mock.calls.length).toBe(0);
      expect(provider.construct.mock.calls.length).toBe(0);
    },
  );
  it("finishes admitted local writes for the captured owner and blocks subsequent work", async () => {
    const provider = fakeProvider();
    installLock();
    const admitted = deferred<void>();
    const finish = deferred<void>();
    const publish = vi.fn();
    const pending = withBrowserOracleMutation(pubkeyA, async (core) => {
      admitted.resolve();
      await finish.promise;
      await core.import_enum_event("public-artifact");
      expect(core.get_public_key() === pubkeyA).toBe(true);
    }).then(() => {
      publish();
    });
    await admitted.promise;
    useSettingsStore.setState({ nsecSecret: keyB });
    finish.resolve();
    await expect(pending).rejects.toMatchObject({ reason: "identity-changed" });
    expect(provider.calls.local).toBe(1);
    expect(provider.origin.key === keyA).toBe(true);
    expect(publish.mock.calls.length).toBe(0);
  });
  it("expires the core and single-use admission after its bounded callback", async () => {
    fakeProvider();
    installLock();
    const admission = await prepareBrowserOracleMutation(pubkeyA);
    let lease!: Kormir;
    await withCreatorDocumentLock(() =>
      admission.withCoreLocked(async (core) => {
        lease = core;
      }),
    );
    expect(() => lease.get_public_key()).toThrow("The local oracle mutation has expired.");
    await expect(
      withCreatorDocumentLock(() => admission.withCoreLocked(async () => {})),
    ).rejects.toMatchObject({ reason: "expired" });
  });
  it("prepares announcement and attestation through the same admitted core", async () => {
    const provider = fakeProvider();
    installLock();
    await withBrowserOracleMutation(pubkeyA, async (core) => {
      expect(
        (await prepareEnumAnnouncement(core, "event", ["Yes", "No"], 1800000000)).artifactHex,
      ).toBe("artifact");
      expect(
        (await prepareEnumAttestation(core, "event", "Yes", "event-json", "public-artifact"))
          .artifactHex,
      ).toBe("attestation");
    });
    expect(provider.construct.mock.calls.length).toBe(1);
    expect(provider.calls.local).toBe(1);
  });
});
