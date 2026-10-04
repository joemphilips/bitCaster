import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";

// Hoisted state lets `vi.mock` factories close over live references.
const mocks = vi.hoisted(() => {
  const settingsState: {
    nostrSignerMode: "none" | "nsec" | "nip07";
    nsecSecret: string | null;
    nostrProfile: {
      pubkey: string;
      displayName: string;
      avatar: string;
      nip05: string;
      nip05verified: boolean;
      bio: string;
    } | null;
    relays: { url: string }[];
    setProfile: (profile: unknown, status: string) => void;
    setSignerMode: (mode: "none" | "nsec" | "nip07") => void;
  } = {
    nostrSignerMode: "none",
    nsecSecret: null,
    nostrProfile: null,
    relays: [{ url: "wss://relay.damus.io" }],
    setProfile: vi.fn((profile, _status) => {
      settingsState.nostrProfile = profile as typeof settingsState.nostrProfile;
    }),
    setSignerMode: vi.fn(),
  };
  const relaySettingSubscribers: Array<
    (state: typeof settingsState, previous: typeof settingsState) => void
  > = [];
  return {
    settingsState,
    ndkCtor: vi.fn(),
    privateKeySignerCtor: vi.fn(),
    nip07SignerCtor: vi.fn(),
    setPendingKormirNsecSpy: vi.fn(),
    getUser: vi.fn(),
    relayConnections: [] as string[],
    relaySettingSubscribers,
    setRelays: (relays: { url: string }[]) => {
      const previous = { ...settingsState };
      settingsState.relays = relays;
      for (const listener of relaySettingSubscribers) listener(settingsState, previous);
    },
  };
});

vi.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => mocks.settingsState,
    subscribe: vi.fn((listener) => {
      mocks.relaySettingSubscribers.push(listener);
      return () => {};
    }),
  },
}));

vi.mock("@nostr-dev-kit/ndk", () => {
  // Model the public setter boundary. Installed-dependency tests check disposal.
  class FakeNDK {
    signer: unknown = null;
    pool = { relays: new Map<string, { dispose: () => void }>() };
    subManager = { subscriptions: new Map() };
    private selected: string[] = [];
    get explicitRelayUrls() {
      return this.selected;
    }
    set explicitRelayUrls(urls: string[]) {
      this.selected = [...urls];
      for (const [url, relay] of this.pool.relays) {
        if (!urls.includes(url)) {
          relay.dispose();
          this.pool.relays.delete(url);
        }
      }
      for (const url of urls) {
        if (!this.pool.relays.has(url)) this.pool.relays.set(url, { dispose: vi.fn() });
      }
    }
    connect = vi.fn(() => {
      mocks.relayConnections.push(...this.pool.relays.keys());
      return Promise.resolve();
    });
    getUser = mocks.getUser;
    constructor(opts: { explicitRelayUrls?: string[] }) {
      mocks.ndkCtor(opts);
      this.explicitRelayUrls = opts.explicitRelayUrls ?? [];
    }
  }
  class FakeNDKPrivateKeySigner {
    constructor(nsec: string) {
      mocks.privateKeySignerCtor(nsec);
    }
    user = () =>
      Promise.resolve({ pubkey: "pk", profile: null, fetchProfile: () => Promise.resolve() });
  }
  class FakeNDKNip07Signer {
    constructor() {
      mocks.nip07SignerCtor();
    }
    user = () =>
      Promise.resolve({ pubkey: "pk", profile: null, fetchProfile: () => Promise.resolve() });
  }
  return {
    default: FakeNDK,
    NDKNip07Signer: FakeNDKNip07Signer,
    NDKPrivateKeySigner: FakeNDKPrivateKeySigner,
  };
});

vi.mock("@nostr-dev-kit/ndk-wallet", () => ({
  NDKNWCWallet: class {},
}));

vi.mock("../kormir", () => ({
  setPendingKormirNsec: mocks.setPendingKormirNsecSpy,
}));

describe("loginWithNsecOrNcryptsec shared private-key adapter", () => {
  const secret = new Uint8Array(32).fill(0x11);
  const nsec = nip19.nsecEncode(secret);
  const passphrase = "fixture-private-key-passphrase";
  const encrypted = encrypt(secret, passphrase, 4);
  let nostrModule: typeof import("../nostr");

  beforeEach(async () => {
    vi.resetModules();
    mocks.settingsState.relays = [];
    mocks.privateKeySignerCtor.mockClear();
    mocks.ndkCtor.mockClear();
    mocks.setPendingKormirNsecSpy.mockClear();
    mocks.relayConnections.length = 0;
    nostrModule = await import("../nostr");
  });

  it.each([
    ["hex", `  ${"11".repeat(32)}  `, undefined],
    ["nsec", `  ${nsec}  `, undefined],
    ["ncryptsec", encrypted, passphrase],
  ])("installs the shared canonical nsec from real %s input", async (_kind, input, password) => {
    const revision = vi.fn();
    const unsubscribe = nostrModule.subscribeToNostrSignerRevision(revision);
    const result = await nostrModule.loginWithNsecOrNcryptsec(input!, password);
    expect(result.nsec).toBe(nsec);
    expect(result.signer).toBe(nostrModule.getNdk().signer);
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledExactlyOnceWith(nsec);
    expect(mocks.setPendingKormirNsecSpy).toHaveBeenCalledExactlyOnceWith(nsec);
    expect(nostrModule.getNostrSignerRevision()).toBe(1);
    expect(revision).toHaveBeenCalledOnce();
    expect(mocks.relayConnections).toEqual([]);
    unsubscribe();
  });

  it.each([
    ["public key", nip19.npubEncode("22".repeat(32)), undefined],
    ["invalid scalar", "00".repeat(32), undefined],
    ["malformed input", "nsec1private-fixture-invalid", undefined],
    ["missing password", encrypted, undefined],
    ["wrong password", encrypted, "fixture-wrong-password"],
  ])("refuses %s before signer installation with a safe error", async (_kind, input, password) => {
    await expect(nostrModule.loginWithNsecOrNcryptsec(input!, password)).rejects.toThrow(
      "Private Nostr key is invalid or could not be decrypted.",
    );
    expect(mocks.privateKeySignerCtor).not.toHaveBeenCalled();
    expect(mocks.ndkCtor).not.toHaveBeenCalled();
    expect(mocks.setPendingKormirNsecSpy).not.toHaveBeenCalled();
    expect(nostrModule.getNostrSignerRevision()).toBe(0);
  });

  it("keeps the installed signer and Kormir binding after a refused replacement", async () => {
    const first = await nostrModule.loginWithNsecOrNcryptsec(nsec);
    const revision = vi.fn();
    const unsubscribe = nostrModule.subscribeToNostrSignerRevision(revision);
    await expect(nostrModule.loginWithNsecOrNcryptsec(encrypted, "wrong")).rejects.toThrow(
      "Private Nostr key is invalid or could not be decrypted.",
    );
    expect(nostrModule.getNdk().signer).toBe(first.signer);
    expect(nostrModule.getNostrSignerRevision()).toBe(1);
    expect(revision).not.toHaveBeenCalled();
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledExactlyOnceWith(nsec);
    expect(mocks.setPendingKormirNsecSpy).toHaveBeenCalledExactlyOnceWith(nsec);
    unsubscribe();
  });
});

describe("rehydrateNostrSigner", () => {
  let nostrModule: typeof import("../nostr");

  beforeEach(async () => {
    vi.resetModules();
    mocks.settingsState.nostrSignerMode = "none";
    mocks.settingsState.nsecSecret = null;
    mocks.settingsState.nostrProfile = null;
    vi.mocked(mocks.settingsState.setProfile).mockClear();
    vi.mocked(mocks.settingsState.setSignerMode).mockClear();
    mocks.privateKeySignerCtor.mockClear();
    mocks.nip07SignerCtor.mockClear();
    mocks.ndkCtor.mockClear();
    mocks.setPendingKormirNsecSpy.mockClear();
    nostrModule = await import("../nostr");
  });

  it('no-ops when signer mode is "none"', async () => {
    await nostrModule.rehydrateNostrSigner();
    expect(mocks.privateKeySignerCtor).not.toHaveBeenCalled();
  });

  it("no-ops when nsecSecret is null even in nsec mode", async () => {
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.settingsState.nsecSecret = null;
    await nostrModule.rehydrateNostrSigner();
    expect(mocks.privateKeySignerCtor).not.toHaveBeenCalled();
  });

  it("installs the signer when persisted nsec is present", async () => {
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.settingsState.nsecSecret = "nsec1example";
    await nostrModule.rehydrateNostrSigner();
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledTimes(1);
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledWith("nsec1example");
  });

  it("reinstalls the extension signer when persisted mode is nip07", async () => {
    mocks.settingsState.nostrSignerMode = "nip07";
    await nostrModule.rehydrateNostrSigner();
    expect(mocks.nip07SignerCtor).toHaveBeenCalledTimes(1);
    expect(mocks.settingsState.setSignerMode).not.toHaveBeenCalled();
  });

  it("is idempotent for the same nsec — second call does not reinstall", async () => {
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.settingsState.nsecSecret = "nsec1stable";
    await nostrModule.rehydrateNostrSigner();
    await nostrModule.rehydrateNostrSigner();
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledTimes(1);
  });

  it("reinstalls when the persisted nsec changes between calls", async () => {
    mocks.settingsState.nostrSignerMode = "nsec";
    mocks.settingsState.nsecSecret = "nsec1first";
    await nostrModule.rehydrateNostrSigner();
    mocks.settingsState.nsecSecret = "nsec1second";
    await nostrModule.rehydrateNostrSigner();
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledTimes(2);
    expect(mocks.privateKeySignerCtor).toHaveBeenLastCalledWith("nsec1second");
  });
});

describe("Nostr signer revision", () => {
  it("increments, notifies, and unsubscribes for both login paths", async () => {
    vi.resetModules();
    const nostrModule = await import("../nostr");
    const listener = vi.fn();
    const unsubscribe = nostrModule.subscribeToNostrSignerRevision(listener);

    await nostrModule.loginWithExtension();
    expect(nostrModule.getNostrSignerRevision()).toBe(1);
    expect(listener).toHaveBeenCalledOnce();

    await nostrModule.loginWithNsec("nsec1replacement");
    expect(nostrModule.getNostrSignerRevision()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await nostrModule.loginWithExtension();
    expect(nostrModule.getNostrSignerRevision()).toBe(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("fetchAndStoreNostrProfile", () => {
  let nostrModule: typeof import("../nostr");

  beforeEach(async () => {
    vi.resetModules();
    mocks.settingsState.relays = [{ url: "wss://relay.damus.io" }];
    mocks.settingsState.nostrProfile = null;
    mocks.ndkCtor.mockClear();
    vi.mocked(mocks.settingsState.setProfile).mockClear();
    nostrModule = await import("../nostr");
  });

  it("keeps a cached matching profile when relays return no fresh kind:0", async () => {
    const cached = {
      pubkey: "pk",
      displayName: "Cached User",
      avatar: "https://example.com/a.png",
      nip05: "",
      nip05verified: false,
      bio: "",
    };
    mocks.settingsState.nostrProfile = cached;
    (
      nostrModule.getNdk() as unknown as {
        signer: unknown;
      }
    ).signer = {
      user: () =>
        Promise.resolve({
          pubkey: "pk",
          profile: null,
          fetchProfile: () => Promise.resolve(),
        }),
    };

    await nostrModule.fetchAndStoreNostrProfile();

    expect(mocks.settingsState.setProfile).toHaveBeenLastCalledWith(cached, "found");
  });
});

describe("fetchPublicNostrProfile", () => {
  let nostrModule: typeof import("../nostr");
  const pubkey = "0123456789abcdef".repeat(4);

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mocks.getUser.mockReset();
    nostrModule = await import("../nostr");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([123, {}, [], null, undefined, true, "", "  "])(
    "uses a valid name and empty avatar for malformed public fields %j",
    async (malformed) => {
      mocks.getUser.mockReturnValue({
        fetchProfile: vi.fn().mockResolvedValue(undefined),
        profile: { displayName: malformed, name: "  Public author  ", image: malformed },
      });
      expect(await nostrModule.fetchPublicNostrProfile(pubkey)).toEqual({
        pubkey,
        displayName: "Public author",
        avatar: "",
      });
      expect(mocks.getUser).toHaveBeenCalledExactlyOnceWith({ pubkey });
    },
  );

  it.each([123, {}, [], null, undefined, true, "  "])(
    "uses the public-key fallback when both public names are malformed or empty %j",
    async (malformed) => {
      mocks.getUser.mockReturnValue({
        fetchProfile: vi.fn().mockResolvedValue(undefined),
        profile: { displayName: malformed, name: malformed },
      });
      expect(await nostrModule.fetchPublicNostrProfile(pubkey)).toEqual({
        pubkey,
        displayName: pubkey.slice(0, 8),
        avatar: "",
      });
    },
  );

  it("preserves the valid preferred name and string avatar", async () => {
    mocks.getUser.mockReturnValue({
      fetchProfile: vi.fn().mockResolvedValue(undefined),
      profile: {
        displayName: "  <Public author>  ",
        name: "Secondary name",
        image: "  https://example.com/avatar.png  ",
      },
    });
    expect(await nostrModule.fetchPublicNostrProfile(pubkey)).toEqual({
      pubkey,
      displayName: "<Public author>",
      avatar: "https://example.com/avatar.png",
    });
  });
});

describe("getNdk relay reconciliation", () => {
  let nostrModule: typeof import("../nostr");

  beforeEach(async () => {
    vi.resetModules();
    mocks.settingsState.relays = [{ url: "wss://relay.damus.io" }];
    mocks.ndkCtor.mockClear();
    mocks.relayConnections.length = 0;
    mocks.relaySettingSubscribers.length = 0;
    nostrModule = await import("../nostr");
  });

  it("connects only the custom selection without restoring defaults", async () => {
    mocks.settingsState.relays = [{ url: "wss://relay.user.example" }];
    await nostrModule.loginWithExtension();
    expect(mocks.ndkCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitRelayUrls: ["wss://relay.user.example"],
      }),
    );
    expect(mocks.relayConnections).toEqual(["wss://relay.user.example"]);
  });

  it("connects a public relay when explicitly selected", async () => {
    await nostrModule.loginWithExtension();
    expect(mocks.relayConnections).toEqual(["wss://relay.damus.io"]);
  });

  it("defaults non-production builds to the local relay", () => {
    expect(nostrModule.DEFAULT_RELAYS).toEqual(["ws://localhost:7777"]);
  });

  it("constructs NDK with relay discovery disabled", () => {
    nostrModule.getNdk();

    expect(mocks.ndkCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        enableOutboxModel: false,
        autoConnectUserRelays: false,
        outboxRelayUrls: [],
      }),
    );
  });

  it("reconciles new user relays added between calls without duplicating", () => {
    const ndk = nostrModule.getNdk();
    // User adds a new relay after first getNdk().
    mocks.settingsState.relays = [{ url: "ws://localhost:7777" }, { url: "ws://localhost:7778" }];
    nostrModule.getNdk();
    expect(ndk.explicitRelayUrls).toEqual(["ws://localhost:7777", "ws://localhost:7778"]);
    const unchanged = ndk.pool.relays.get("ws://localhost:7778");
    nostrModule.getNdk();
    expect(ndk.pool.relays.get("ws://localhost:7778")).toBe(unchanged);
  });

  it("disconnects removed relays, makes zero connections on empty, and permits public re-add", async () => {
    const ndk = nostrModule.getNdk();
    const previous = ndk.pool.relays.get("wss://relay.damus.io")!;
    mocks.setRelays([]);
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(ndk.pool.relays.size).toBe(0);
    await nostrModule.loginWithExtension();
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(ndk.pool.relays.size).toBe(0);
    expect(mocks.relayConnections).toEqual([]);
    mocks.setRelays([{ url: "wss://nos.lol" }]);
    await nostrModule.loginWithExtension();
    expect([...ndk.pool.relays.keys()]).toEqual(["wss://nos.lol"]);
    expect(mocks.relayConnections).toEqual(["wss://nos.lol"]);
  });

  it("keeps a saved explicit oracle destination independent of empty current settings", () => {
    mocks.settingsState.relays = [];
    nostrModule.createExplicitRelayNdk({
      explicitRelayUrls: ["wss://saved.oracle.example/Archive?Key=A"],
    });
    expect(mocks.ndkCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitRelayUrls: ["wss://saved.oracle.example/Archive?Key=A"],
        autoConnectUserRelays: false,
        outboxRelayUrls: [],
      }),
    );
  });
});
