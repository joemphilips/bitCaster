import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureImplicitWallet: vi.fn().mockResolvedValue(undefined),
  invalidateOracle: vi.fn(),
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: () => ({ ensureImplicitWallet: mocks.ensureImplicitWallet }) },
}));
vi.mock("../kormir", () => ({ setPendingKormirNsec: mocks.invalidateOracle }));
vi.mock("@nostr-dev-kit/ndk-wallet", () => ({ NDKNWCWallet: class {} }));
vi.mock("../browserNostrProfile", () => ({
  captureBrowserNostrProfileSelection: vi.fn().mockRejectedValue(new Error("No relay fixture")),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const publicKey = "22".repeat(32);
const privateKey = "11".repeat(32);

describe("identity lifecycle with real NDK and settings", () => {
  let identity: typeof import("../identityOps");
  let nostr: typeof import("../nostr");
  let store: typeof import("@/stores/settings").useSettingsStore;
  let extension: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    mocks.ensureImplicitWallet.mockReset().mockResolvedValue(undefined);
    mocks.invalidateOracle.mockClear();
    extension = vi.fn().mockResolvedValue(publicKey);
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: { getPublicKey: extension },
    });
    const { default: NDK } = await import("@nostr-dev-kit/ndk");
    vi.spyOn(NDK.prototype, "connect").mockResolvedValue(undefined);
    store = (await import("@/stores/settings")).useSettingsStore;
    store.setState({ relays: [] });
    nostr = await import("../nostr");
    identity = await import("../identityOps");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for extension authorization before changing mode or reporting success", async () => {
    const pending = deferred<string>();
    extension.mockReturnValue(pending.promise);
    const result = identity.userConnectNostrSignerMode("nip07");
    expect(store.getState().nostrSignerMode).toBe("none");
    expect(store.getState().signerConnectionStatus).toBe("connecting");
    expect(nostr.getNdk().signer).toBeUndefined();
    pending.resolve(publicKey);
    expect(await result).toEqual({ ok: true });
    expect(store.getState().nostrSignerMode).toBe("nip07");
    expect(store.getState().signerConnectionStatus).toBe("connected");
    expect(nostr.getNdk().activeUser?.pubkey).toBe(publicKey);
  });

  it.each(["", "bad", "z".repeat(64)])("refuses invalid extension identity %s", async (key) => {
    extension.mockResolvedValue(key);
    expect((await identity.userConnectNostrSignerMode("nip07")).ok).toBe(false);
    expect(nostr.getNdk().signer).toBeUndefined();
    expect(store.getState().nostrSignerMode).toBe("none");
  });

  it("preserves local generated-key provenance after rejected replacement", async () => {
    await identity.createGeneratedNostrIdentity();
    const old = store.getState();
    const signer = nostr.getNdk().signer;
    extension.mockRejectedValue(new Error("Denied"));
    expect((await identity.userConnectNostrSignerMode("nip07")).ok).toBe(false);
    expect(nostr.getNdk().signer).toBe(signer);
    expect(store.getState().nsecSecret === old.nsecSecret).toBe(true);
    expect(store.getState().signerSource).toBe("implicit-generated");
    expect(store.getState().signerBackupState).toBe("needs_backup");
    expect(store.getState().signerConnectionStatus).toBe("connected");
  });

  it("ignores late extension success after disconnect", async () => {
    const pending = deferred<string>();
    extension.mockReturnValue(pending.promise);
    const result = identity.userConnectNostrSignerMode("nip07");
    identity.disconnectNostrIdentity();
    pending.resolve(publicKey);
    expect(await result).toEqual({ ok: false, superseded: true });
    expect(nostr.getNdk().signer).toBeUndefined();
    expect(nostr.getNdk().activeUser).toBeUndefined();
    expect(store.getState().nostrSignerMode).toBe("none");
  });

  it("settles a cancelled extension request without waiting for the extension", async () => {
    extension.mockReturnValue(new Promise<string>(() => {}));
    const result = identity.userConnectNostrSignerMode("nip07");
    identity.disconnectNostrIdentity();
    expect(await result).toEqual({ ok: false, superseded: true });
    expect(store.getState().signerConnectionStatus).toBe("disconnected");
  });

  it("rejects an absent extension without committing an identity", async () => {
    Object.defineProperty(window, "nostr", { configurable: true, value: undefined });
    expect((await identity.userConnectNostrSignerMode("nip07")).ok).toBe(false);
    expect(nostr.getNdk().signer).toBeUndefined();
    expect(store.getState().nostrSignerMode).toBe("none");
    expect(store.getState().signerConnectionStatus).toBe("disconnected");
  });

  it("keeps persisted extension provenance unverified after reload rejection", async () => {
    store.setState({
      nostrSignerMode: "nip07",
      signerSource: "nip07",
      signerBackupState: "confirmed",
    });
    extension.mockRejectedValue(new Error("Denied"));
    await identity.rehydratePersistedNostrIdentity();
    expect(store.getState().signerConnectionStatus).toBe("disconnected");
    expect(store.getState().signerSource).toBe("nip07");
    expect(nostr.getNdk().signer).toBeUndefined();
  });

  it("does not wait for optional old-signer teardown before installing an authorized replacement", async () => {
    await identity.userConnectNsecIdentity(privateKey);
    const teardown = deferred<void>();
    const destroy = vi.fn(() => teardown.promise);
    Object.assign(nostr.getNdk().signer!, { destroy });
    expect(await identity.userConnectNostrSignerMode("nip07")).toEqual({ ok: true });
    expect(destroy).toHaveBeenCalledOnce();
    expect(nostr.getNdk().activeUser?.pubkey).toBe(publicKey);
    teardown.resolve();
  });

  it.each([true, false])(
    "ignores late extension completion after local replacement (success=%s)",
    async (success) => {
      const pending = deferred<string>();
      extension.mockReturnValue(pending.promise);
      const result = identity.userConnectNostrSignerMode("nip07");
      await identity.userConnectNsecIdentity(privateKey);
      const selected = nostr.getNdk().signer;
      if (success) pending.resolve(publicKey);
      else pending.reject(new Error("Denied"));
      expect(await result).toEqual({ ok: false, superseded: true });
      expect(nostr.getNdk().signer).toBe(selected);
      expect(store.getState().nostrSignerMode).toBe("nsec");
      expect(store.getState().signerConnectionStatus).toBe("connected");
    },
  );

  it("does not revive an older request when the newest request fails", async () => {
    const pending = deferred<string>();
    extension.mockReturnValue(pending.promise);
    const result = identity.userConnectNostrSignerMode("nip07");
    expect((await identity.userConnectNsecIdentity("invalid")).ok).toBe(false);
    pending.resolve(publicKey);
    expect(await result).toEqual({ ok: false, superseded: true });
    expect(nostr.getNdk().signer).toBeUndefined();
  });

  it("prevents the real NDK activeUser microtask from restoring a disconnected identity", async () => {
    const unsubscribe = nostr.subscribeToNostrSignerRevision(() => {
      if (nostr.getNdk().signer) identity.disconnectNostrIdentity();
    });
    const result = await identity.userConnectNsecIdentity(privateKey);
    await Promise.resolve();
    unsubscribe();
    expect(result).toEqual({ ok: false, superseded: true });
    expect(nostr.getNdk().signer).toBeUndefined();
    expect(nostr.getNdk().activeUser).toBeUndefined();
    expect(store.getState().nostrSignerMode).toBe("none");
  });

  it("retains an imported key after invalid replacement", async () => {
    expect(await identity.userConnectNsecIdentity(privateKey)).toEqual({ ok: true });
    const secret = store.getState().nsecSecret;
    expect(store.getState().signerSource).toBe("user-nsec");
    expect(store.getState().signerBackupState).toBe("confirmed");
    expect((await identity.userConnectNsecIdentity("invalid")).ok).toBe(false);
    expect(store.getState().nsecSecret === secret).toBe(true);
    expect(store.getState().nostrSignerMode).toBe("nsec");
  });

  it("rehydrates persisted extension mode without treating cached mode as authorization", async () => {
    store.setState({ nostrSignerMode: "nip07", signerSource: "nip07" });
    const pending = deferred<string>();
    extension.mockReturnValue(pending.promise);
    const result = identity.rehydratePersistedNostrIdentity();
    await Promise.resolve();
    expect(store.getState().signerConnectionStatus).toBe("connecting");
    expect(nostr.getNdk().signer).toBeUndefined();
    pending.resolve(publicKey);
    await result;
    expect(store.getState().signerConnectionStatus).toBe("connected");
  });

  it.each([true, false])(
    "rehydration atomically keeps only the authorized identity's cached profile (matching=%s)",
    async (matching) => {
      const profile = {
        pubkey: matching ? publicKey : "33".repeat(32),
        displayName: "Cached profile",
        avatar: "",
        bio: "",
        nip05: "",
        nip05verified: false,
      };
      store.setState({
        nostrSignerMode: "nip07",
        nostrProfile: profile,
        nostrProfileFetchStatus: "found",
      });
      const connectedProfiles: Array<string | null> = [];
      const unsubscribe = store.subscribe((state) => {
        if (state.signerConnectionStatus === "connected") {
          connectedProfiles.push(state.nostrProfile?.pubkey ?? null);
        }
      });
      await identity.rehydratePersistedNostrIdentity();
      unsubscribe();
      expect(connectedProfiles.length).toBeGreaterThan(0);
      expect(connectedProfiles.every((key) => key === (matching ? publicKey : null))).toBe(true);
      expect(store.getState().nostrProfile).toEqual(matching ? profile : null);
      expect(store.getState().nostrProfileFetchStatus).toBe(matching ? "found" : "idle");
    },
  );

  it("ignores a rejected reload attempt after an explicit local connection", async () => {
    store.setState({ nostrSignerMode: "nip07" });
    const pending = deferred<string>();
    extension.mockReturnValue(pending.promise);
    const result = identity.rehydratePersistedNostrIdentity();
    await Promise.resolve();
    await identity.userConnectNsecIdentity(privateKey);
    pending.reject(new Error("Denied"));
    await result;
    expect(store.getState().nostrSignerMode).toBe("nsec");
    expect(store.getState().signerConnectionStatus).toBe("connected");
  });

  it("does not start deferred hydration after a newer disconnect", async () => {
    store.setState({ nostrSignerMode: "nip07" });
    let hydrated!: () => void;
    vi.spyOn(store.persist, "hasHydrated").mockReturnValue(false);
    vi.spyOn(store.persist, "onFinishHydration").mockImplementation((callback) => {
      hydrated = () => callback(store.getState());
      return () => {};
    });
    const result = identity.rehydratePersistedNostrIdentity();
    identity.disconnectNostrIdentity();
    hydrated();
    await result;
    expect(extension).not.toHaveBeenCalled();
  });

  it("preserves generated-key provenance on local rehydration", async () => {
    store.setState({
      nostrSignerMode: "nsec",
      nsecSecret: privateKey,
      signerSource: "implicit-generated",
      signerBackupState: "needs_backup",
    });
    await identity.rehydratePersistedNostrIdentity();
    expect(store.getState().signerSource).toBe("implicit-generated");
    expect(store.getState().signerBackupState).toBe("needs_backup");
    expect(store.getState().signerConnectionStatus).toBe("connected");
  });

  it("does not persist runtime connection status", async () => {
    await identity.userConnectNsecIdentity(privateKey);
    const persisted = JSON.parse(localStorage.getItem("bitcaster-settings") ?? "{}");
    expect(persisted.state).toBeDefined();
    expect(persisted.state.signerConnectionStatus).toBeUndefined();
  });

  it("creates an implicit wallet and a generated identity", async () => {
    expect(await identity.createImplicitWalletAndNostrIdentity()).toEqual({ ok: true });
    expect(mocks.ensureImplicitWallet).toHaveBeenCalledOnce();
    expect(store.getState().signerSource).toBe("implicit-generated");
    expect(store.getState().signerBackupState).toBe("needs_backup");
  });

  it("does not generate an identity after explicit selection during wallet creation", async () => {
    const pending = deferred<void>();
    mocks.ensureImplicitWallet.mockReturnValue(pending.promise);
    const result = identity.createImplicitWalletAndNostrIdentity();
    await identity.userConnectNsecIdentity(privateKey);
    pending.resolve();
    expect(await result).toEqual({ ok: false, superseded: true });
    expect(store.getState().signerSource).toBe("user-nsec");
  });

  it("does not replace an existing identity during implicit wallet creation", async () => {
    await identity.userConnectNostrSignerMode("nip07");
    const signer = nostr.getNdk().signer;
    expect(await identity.createImplicitWalletAndNostrIdentity()).toEqual({ ok: true });
    expect(nostr.getNdk().signer).toBe(signer);
  });

  it("resolves the active local identity, not a wallet mnemonic", () => {
    const resolved = identity.resolveNsecIdentity(privateKey);
    expect(resolved?.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved?.privateKeyHex === privateKey).toBe(true);
    expect(identity.resolveCreatorPubkey({ nostrSignerMode: "nsec", nsecSecret: privateKey })).toBe(
      resolved?.publicKey,
    );
    expect(identity.resolveCreatorPubkey({ nostrSignerMode: "none", nsecSecret: null })).toBeNull();
  });
});
