import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { createBrowserWalletCounterSource, useWalletStore } from "../wallet";
import * as bip39 from "@/lib/bip39";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { activateBrowserWalletDatabase, db } from "../proof-db";

const cashuMocks = vi.hoisted(() => ({
  loadMint: vi.fn().mockResolvedValue(undefined),
  walletConstructor: vi.fn(),
}));

const persistenceMocks = vi.hoisted(() => ({ request: vi.fn() }));
const seedHandoffMocks = vi.hoisted(() => ({ handoff: vi.fn() }));

vi.mock("@/lib/browserWalletStoragePersistence", () => ({
  requestBrowserWalletStoragePersistence: persistenceMocks.request,
}));

vi.mock("@/lib/browserEncryptedWalletBackupV2SeedHandoff", () => ({
  handoffBrowserEncryptedWalletBackupV2Seed: seedHandoffMocks.handoff,
}));

vi.mock("@cashu/cashu-ts", () => {
  class MockMint {
    constructor(public readonly url: string) {}

    async getInfo() {
      return {
        name: "test mint",
        pubkey: "abc",
        version: "test",
        nuts: {
          4: { methods: [] },
          5: { methods: [] },
        },
      };
    }

    async getKeySets() {
      return { keysets: [] };
    }

    async getKeys() {
      return { keysets: [{ id: KEYSET_ID, unit: "sat", keys: {} }] };
    }
  }

  const MockWallet = vi.fn(function MockWallet(
    this: unknown,
    mint: MockMint,
    options?: { unit?: string },
  ) {
    const wallet = { mint, options, loadMint: cashuMocks.loadMint };
    cashuMocks.walletConstructor(mint, options, wallet);
    return wallet;
  });

  return { Mint: MockMint, Wallet: MockWallet, setGlobalRequestOptions: vi.fn() };
});

const initialAddMint = useWalletStore.getState()._addMint;
const initialAddMintWithoutActivating = useWalletStore.getState()._addMintWithoutActivating;
const KEYSET_ID = `01${"11".repeat(32)}`;

// Reset store state before each test
beforeEach(() => {
  vi.clearAllMocks();
  seedHandoffMocks.handoff.mockResolvedValue(undefined);
  useWalletStore.setState({
    mnemonic: "",
    setupComplete: false,
    walletBackupState: "none",
    mints: [],
    activeMintUrl: "http://localhost:8085",
    mintConnectionStatuses: {},
    _addMint: initialAddMint,
    _addMintWithoutActivating: initialAddMintWithoutActivating,
  });
});

describe("useWalletStore", () => {
  it("does not persist superseded deterministic counter fields", () => {
    const partialize = useWalletStore.persist.getOptions().partialize!;
    const persisted = partialize(useWalletStore.getState());

    expect(persisted).not.toHaveProperty("keysetCounters");
    expect(persisted).not.toHaveProperty("keysetCountersRecovered");
  });

  it("does not request browser persistence during Zustand hydration", () => {
    const hydrate = useWalletStore.persist.getOptions().onRehydrateStorage!(
      useWalletStore.getState(),
    );
    hydrate?.({ mnemonic: bip39.generate().join(" ") } as never, undefined);
    expect(persistenceMocks.request).not.toHaveBeenCalled();
  });

  describe("generateMnemonic", () => {
    it("produces 12 valid BIP-39 English words", () => {
      useWalletStore.getState().generateMnemonic();
      const mnemonic = useWalletStore.getState().mnemonic;
      const words = mnemonic.split(" ");
      expect(words).toHaveLength(12);
      expect(bip39.validate(words)).toBe(true);
      expect(persistenceMocks.request).toHaveBeenCalledOnce();
    });
  });

  describe("recoverFromMnemonic", () => {
    it("accepts a valid phrase", async () => {
      const words = bip39.generate();
      const result = await useWalletStore.getState().recoverFromMnemonic(words);
      expect(result.valid).toBe(true);
      expect(useWalletStore.getState().mnemonic).toBe(words.join(" "));
      expect(persistenceMocks.request).toHaveBeenCalledOnce();
    });

    it("rejects invalid phrase", async () => {
      const result = await useWalletStore
        .getState()
        .recoverFromMnemonic([
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "zoo",
          "abandon",
        ]);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects wrong word count", async () => {
      const result = await useWalletStore.getState().recoverFromMnemonic(["abandon", "abandon"]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("12 words");
    });

    it("hands off a different seed only after activating the new profile", async () => {
      const oldMnemonic = bip39.generate().join(" ");
      const newWords = bip39.generate();
      const oldScopeId = browserWalletScopeIdFromMnemonic(oldMnemonic);
      expect(oldScopeId).not.toBeNull();
      useWalletStore.setState({ mnemonic: oldMnemonic, walletBackupState: "confirmed" });
      setActiveBrowserWalletProfile(oldMnemonic);
      activateBrowserWalletDatabase(oldScopeId!);
      const oldDatabase = db;

      let mnemonicDuringActivation = "";
      let profileWasCurrentDuringHandoff = false;
      let stateDuringPersistence: { mnemonic: string; walletBackupState: string } | undefined;
      persistenceMocks.request.mockImplementationOnce(() => {
        const state = useWalletStore.getState();
        stateDuringPersistence = {
          mnemonic: state.mnemonic,
          walletBackupState: state.walletBackupState,
        };
      });
      seedHandoffMocks.handoff.mockImplementationOnce(
        async (input: {
          invalidateOldProfile: () => void;
          activateNewProfile: () => Promise<void>;
          isCurrentProfile: () => boolean;
        }) => {
          profileWasCurrentDuringHandoff = input.isCurrentProfile();
          input.invalidateOldProfile();
          mnemonicDuringActivation = useWalletStore.getState().mnemonic;
          await input.activateNewProfile();
        },
      );

      const result = await useWalletStore.getState().recoverFromMnemonic(newWords);

      expect(result).toEqual({ valid: true });
      expect(seedHandoffMocks.handoff).toHaveBeenCalledWith(
        expect.objectContaining({
          database: oldDatabase,
          scopeId: oldScopeId,
          isCurrentProfile: expect.any(Function),
        }),
      );
      expect(profileWasCurrentDuringHandoff).toBe(true);
      expect(mnemonicDuringActivation).toBe(oldMnemonic);
      expect(useWalletStore.getState().mnemonic).toBe(newWords.join(" "));
      expect(useWalletStore.getState().walletBackupState).toBe("confirmed");
      expect(activeBrowserWalletScopeId()).toBe(
        browserWalletScopeIdFromMnemonic(newWords.join(" ")),
      );
      expect(stateDuringPersistence).toEqual({
        mnemonic: newWords.join(" "),
        walletBackupState: "confirmed",
      });
      expect(persistenceMocks.request).toHaveBeenCalledOnce();
    });

    it("keeps the old Zustand mnemonic when the seed handoff rejects", async () => {
      const oldMnemonic = bip39.generate().join(" ");
      const newWords = bip39.generate();
      const oldScopeId = browserWalletScopeIdFromMnemonic(oldMnemonic);
      expect(oldScopeId).not.toBeNull();
      useWalletStore.setState({ mnemonic: oldMnemonic, walletBackupState: "confirmed" });
      setActiveBrowserWalletProfile(oldMnemonic);
      activateBrowserWalletDatabase(oldScopeId!);
      seedHandoffMocks.handoff.mockRejectedValueOnce(new Error("backup is incomplete"));

      const result = await useWalletStore.getState().recoverFromMnemonic(newWords);

      expect(result).toEqual({ valid: false, error: "backup is incomplete" });
      expect(useWalletStore.getState().mnemonic).toBe(oldMnemonic);
      expect(activeBrowserWalletScopeId()).toBe(oldScopeId);
      expect(persistenceMocks.request).not.toHaveBeenCalled();
    });

    it("reopens the current seed without handing off or changing the profile", async () => {
      const words = bip39.generate();
      const mnemonic = words.join(" ");
      useWalletStore.setState({ mnemonic });

      await expect(useWalletStore.getState().recoverFromMnemonic(words)).resolves.toEqual({
        valid: true,
      });
      expect(seedHandoffMocks.handoff).not.toHaveBeenCalled();
    });
  });

  describe("generateMnemonic", () => {
    it("activates a seed-scoped canonical database", () => {
      useWalletStore.getState().generateMnemonic();

      const state = useWalletStore.getState();
      expect(state.mnemonic.split(" ")).toHaveLength(12);
      expect(db.name).toMatch(/^bitcaster-wallet-[0-9a-f]{64}$/);
    });
  });

  describe("testMintConnection", () => {
    it("returns connected on successful fetch", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
      const status = await useWalletStore.getState().testMintConnection("http://localhost:8085");
      expect(status).toBe("connected");
      expect(useWalletStore.getState().mintConnectionStatuses["http://localhost:8085"]).toBe(
        "connected",
      );
      vi.restoreAllMocks();
    });

    it("returns failed on fetch error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
      const status = await useWalletStore.getState().testMintConnection("http://bad:1234");
      expect(status).toBe("failed");
      expect(useWalletStore.getState().mintConnectionStatuses["http://bad:1234"]).toBe("failed");
      vi.restoreAllMocks();
    });
  });

  describe("getWallet cache units", () => {
    it("blocks a profile-bound counter source before keyset recovery", async () => {
      const mnemonic = bip39.generate().join(" ");
      useWalletStore.setState({ mnemonic });
      setActiveBrowserWalletProfile(mnemonic);
      const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
      expect(scopeId).not.toBeNull();
      activateBrowserWalletDatabase(scopeId!);
      const counterSource = createBrowserWalletCounterSource(
        scopeId!,
        "http://localhost:8085",
        "sat",
      );

      await expect(counterSource.reserve(KEYSET_ID, 1)).rejects.toThrow(
        /counter recovery is incomplete/,
      );
    });

    it("does not reuse a base-asset sat msat wallet for a raw-unit sat wallet", async () => {
      useWalletStore.getState().generateMnemonic();

      const msatWallet = await useWalletStore.getState().getWallet("http://localhost:8085", "sat");
      const satWallet = await useWalletStore
        .getState()
        .getWalletForUnit("http://localhost:8085", "sat");

      expect(satWallet).not.toBe(msatWallet);
      expect(cashuMocks.walletConstructor).toHaveBeenCalledTimes(2);
      expect(cashuMocks.walletConstructor.mock.calls.map(([, options]) => options?.unit)).toEqual([
        "msat",
        "sat",
      ]);
    });

    it("rejects counter mutation through a wallet from the previous seed", async () => {
      useWalletStore.getState().generateMnemonic();
      await useWalletStore.getState().getWalletForUnit("http://localhost:8085", "msat");
      const oldCounterSource = cashuMocks.walletConstructor.mock.calls.at(-1)?.[1]
        ?.counterSource as { reserve(keysetId: string, count: number): Promise<unknown> };

      setActiveBrowserWalletProfile(bip39.generate().join(" "));

      await expect(oldCounterSource.reserve(KEYSET_ID, 1)).rejects.toThrow(
        /wallet profile changed/,
      );
    });
  });

  describe("_removeMint", () => {
    it("cannot remove the last mint", () => {
      useWalletStore.setState({
        mints: [{ url: "http://localhost:8085" }],
        activeMintUrl: "http://localhost:8085",
      });
      useWalletStore.getState()._removeMint("http://localhost:8085");
      expect(useWalletStore.getState().mints).toHaveLength(1);
    });

    it("removes a mint when there are multiple", () => {
      useWalletStore.setState({
        mints: [{ url: "http://a.com" }, { url: "http://b.com" }],
        activeMintUrl: "http://a.com",
      });
      useWalletStore.getState()._removeMint("http://b.com");
      expect(useWalletStore.getState().mints).toHaveLength(1);
      expect(useWalletStore.getState().mints[0].url).toBe("http://a.com");
    });
  });

  describe("completeSetup", () => {
    it("sets setupComplete to true", async () => {
      // Pre-populate mints so completeSetup skips the internal add-mint network call
      useWalletStore.setState({ mints: [{ url: "http://localhost:8085" }] });
      expect(useWalletStore.getState().setupComplete).toBe(false);
      await useWalletStore.getState().completeSetup();
      expect(useWalletStore.getState().setupComplete).toBe(true);
    });

    it("does not activate the default mint when setup already has a custom active mint", async () => {
      useWalletStore.setState({
        mints: [{ url: "http://localhost:5273" }],
        activeMintUrl: "http://localhost:5273",
        _addMint: vi.fn().mockResolvedValue(undefined),
        _addMintWithoutActivating: vi.fn().mockResolvedValue(undefined),
      } as Partial<ReturnType<typeof useWalletStore.getState>>);

      await useWalletStore.getState().completeSetup();

      const state = useWalletStore.getState();
      expect(state._addMint).not.toHaveBeenCalled();
      expect(state._addMintWithoutActivating).toHaveBeenCalledWith("http://localhost:8085");
      expect(state.activeMintUrl).toBe("http://localhost:5273");
    });
  });

  describe("ensureImplicitWallet", () => {
    it("creates a mnemonic, marks backup needed, and completes setup when none exists", async () => {
      useWalletStore.setState({
        _addMint: vi.fn().mockResolvedValue(undefined),
      } as Partial<ReturnType<typeof useWalletStore.getState>>);

      await useWalletStore.getState().ensureImplicitWallet();

      const state = useWalletStore.getState();
      expect(state.mnemonic.split(" ")).toHaveLength(12);
      expect(state.walletBackupState).toBe("needs_backup");
      expect(state.setupComplete).toBe(true);
      expect(state._addMint).toHaveBeenCalledWith("http://localhost:8085");
    });

    it("does not replace an existing mnemonic", async () => {
      const words = bip39.generate().join(" ");
      useWalletStore.setState({
        mnemonic: words,
        walletBackupState: "confirmed",
        mints: [{ url: "http://localhost:8085" }],
        _addMint: vi.fn().mockResolvedValue(undefined),
      } as Partial<ReturnType<typeof useWalletStore.getState>>);

      await useWalletStore.getState().ensureImplicitWallet();

      const state = useWalletStore.getState();
      expect(state.mnemonic).toBe(words);
      expect(state.walletBackupState).toBe("confirmed");
      expect(state.setupComplete).toBe(true);
      expect(state._addMint).not.toHaveBeenCalled();
    });

    it("registers the default mint without activating it when another mint is active", async () => {
      const words = bip39.generate().join(" ");
      useWalletStore.setState({
        mnemonic: words,
        walletBackupState: "confirmed",
        mints: [{ url: "http://localhost:5273" }],
        activeMintUrl: "http://localhost:5273",
        _addMint: vi.fn().mockResolvedValue(undefined),
        _addMintWithoutActivating: vi.fn().mockResolvedValue(undefined),
      } as Partial<ReturnType<typeof useWalletStore.getState>>);

      await useWalletStore.getState().ensureImplicitWallet();

      const state = useWalletStore.getState();
      expect(state._addMint).not.toHaveBeenCalled();
      expect(state._addMintWithoutActivating).toHaveBeenCalledWith("http://localhost:8085");
      expect(state.activeMintUrl).toBe("http://localhost:5273");
    });

    it("marks a pre-existing unconfirmed mnemonic as needing backup", async () => {
      const words = bip39.generate().join(" ");
      useWalletStore.setState({
        mnemonic: words,
        walletBackupState: "none",
        mints: [{ url: "http://localhost:8085" }],
      });

      await useWalletStore.getState().ensureImplicitWallet();

      expect(useWalletStore.getState().mnemonic).toBe(words);
      expect(useWalletStore.getState().walletBackupState).toBe("needs_backup");
    });

    it("marks wallet backup confirmed explicitly", () => {
      useWalletStore.setState({ walletBackupState: "needs_backup" });
      useWalletStore.getState().markWalletBackupConfirmed();
      expect(useWalletStore.getState().walletBackupState).toBe("confirmed");
    });
  });

  describe("_addMintWithoutActivating + _setActiveMint — P8 Finding 3 split", () => {
    // The activating add-mint side effect that retargets activeMintUrl is the AGENTS.md-
    // documented anti-pattern that bit P8 Issue 4. These tests pin the
    // separation: untrusted-input ingress paths use addMintWithoutActivating;
    // setActiveMint is the explicit user-consent action.
    beforeEach(() => {
      useWalletStore.setState({
        mints: [{ url: "http://staging.example" } as never],
        activeMintUrl: "http://staging.example",
      });
    });

    it("_addMintWithoutActivating registers the mint but leaves activeMintUrl untouched", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const u = String(input);
        if (u.endsWith("/v1/info")) {
          return Response.json({
            name: "test mint",
            pubkey: "abc",
            version: "test",
            nuts: {
              4: { methods: [] },
              5: { methods: [] },
            },
          });
        }
        if (u.endsWith("/v1/keysets")) return new Response('{"keysets":[]}');
        if (u.endsWith("/v1/keys"))
          return new Response('{"keysets":[{"id":"k","unit":"sat","keys":{}}]}');
        return new Response("{}");
      });

      await useWalletStore.getState()._addMintWithoutActivating("https://attacker.example");

      const state = useWalletStore.getState();
      expect(state.mints.map((m) => m.url)).toContain("https://attacker.example");
      // Critical assertion: untrusted-input registration MUST NOT change the
      // user's active mint. If this assertion ever fails, the activating add-mint anti-
      // pattern has been re-introduced — re-read bitcaster-coding-guideline
      // Rule 5 in the bitCaster submodule's SKILL.md.
      expect(state.activeMintUrl).toBe("http://staging.example");
    });

    it("_setActiveMint switches activeMintUrl only when the target is already a registered mint", () => {
      useWalletStore.setState({
        mints: [
          { url: "http://staging.example" } as never,
          { url: "https://other.example" } as never,
        ],
      });

      useWalletStore.getState()._setActiveMint("https://other.example");
      expect(useWalletStore.getState().activeMintUrl).toBe("https://other.example");

      // Switching to an unregistered mint is a no-op (no surprise activation
      // from a typo or stale URL).
      useWalletStore.getState()._setActiveMint("https://unknown.example");
      expect(useWalletStore.getState().activeMintUrl).toBe("https://other.example");
    });
  });
});
