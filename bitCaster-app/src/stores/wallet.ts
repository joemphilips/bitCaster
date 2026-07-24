import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  type MintKeys,
  type MintKeyset,
  type CounterSource,
  type CounterRange,
} from "@cashu/cashu-ts";
import { useLiveQuery } from "dexie-react-hooks";
import * as bip39 from "@/lib/bip39";
import { normalizeUrl } from "@/lib/url";
import { db, getUnitProofs, isCtfProof, type StoredProof } from "./proof-db";
import type { MintConnectionTestStatus } from "@/types/wallet";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import type { SecretBackupState } from "@/types/settings";

export interface StoredMint {
  url: string;
  keys?: MintKeys;
  keysets?: MintKeyset[];
  info?: Record<string, unknown>;
}

interface WalletState {
  mnemonic: string;
  setupComplete: boolean;
  walletBackupState: SecretBackupState;
  mints: StoredMint[];
  activeMintUrl: string;
  keysetCounters: Record<string, number>;
  /**
   * Per-keyset flag indicating that the deterministic-output recovery scan
   * (`batchRestore`) has been run against the mint at least once for this
   * keyset. Without recovery, a wallet whose `keysetCounters` entry is
   * missing or stale (e.g. because the wallet existed before the
   * `ZustandCounterSource` landed in submodule commit `8711c73`, or proofs
   * were minted from a different device with the same seed) re-uses
   * deterministic blinded outputs starting at counter 0. CDK responds to
   * the duplicate with the **misleadingly-named** error
   * `"Invoice already paid or pending"` (per
   * `cdk-common/src/error.rs:1017`, `Database(Duplicate)` →
   * `ErrorCode::InvoiceAlreadyPaid`) — see
   * `docs/TODO.md` "P8 follow-up: counter recovery".
   */
  keysetCountersRecovered: Record<string, boolean>;
  mintConnectionStatuses: Record<string, MintConnectionTestStatus>;

  generateMnemonic: () => void;
  ensureImplicitWallet: () => Promise<void>;
  markWalletBackupConfirmed: () => void;
  recoverFromMnemonic: (words: string[]) => { valid: boolean; error?: string };
  testMintConnection: (url: string) => Promise<MintConnectionTestStatus>;
  /**
   * Internal walletOps primitive. Registers a mint and SETS it as active.
   * Application code must call `userAddAndSelectMint` instead.
   */
  _addMint: (url: string) => Promise<void>;
  /**
   * Internal walletOps primitive. Registers a mint WITHOUT changing
   * `activeMintUrl`. Application ingress must call `ingressRegisterMint` or
   * `ingressReceiveCashuToken` instead.
   */
  _addMintWithoutActivating: (url: string) => Promise<void>;
  _removeMint: (url: string) => void;
  _setActiveMint: (url: string) => void;
  completeSetup: () => Promise<void>;
  getWallet: (
    mintUrl?: string,
    baseAsset?: MarketBaseAsset | string | null,
  ) => Promise<CashuWallet>;
  getWalletForUnit: (mintUrl: string | undefined, unit: string) => Promise<CashuWallet>;
}

export const DEFAULT_MINT_URL = normalizeUrl(
  import.meta.env.VITE_MINT_URL ?? "http://localhost:8085",
);

let _walletCache: Map<string, CashuWallet> = new Map();

function walletCacheKey(mintUrl: string, baseAsset?: MarketBaseAsset | string | null): string {
  return `${mintUrl}::${defaultCollateralUnit(baseAsset)}`;
}

function walletUnitCacheKey(mintUrl: string, unit: string): string {
  return `${mintUrl}::unit:${unit}`;
}

function getSeedBytes(mnemonic: string): Uint8Array | undefined {
  if (!mnemonic) return undefined;
  return bip39.toSeed(mnemonic.split(" "));
}

async function createWallet(url: string, unit: string, mnemonic: string): Promise<CashuWallet> {
  const seedBytes = getSeedBytes(mnemonic);
  const mint = new CashuMint(url);
  const wallet = new CashuWallet(mint, {
    unit,
    ...(seedBytes ? { bip39seed: seedBytes, counterSource: _counterSource } : {}),
  });
  await wallet.loadMint();
  return wallet;
}

/**
 * CounterSource backed by the Zustand wallet store's keysetCounters.
 * Persists deterministic output counters to localStorage so they survive
 * page reloads and prevent "Blinded Message already signed" collisions.
 */
class ZustandCounterSource implements CounterSource {
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    if (n === 0) {
      const current = useWalletStore.getState().keysetCounters[keysetId] ?? 0;
      return { start: current, count: 0 };
    }
    let start = 0;
    useWalletStore.setState((s) => {
      start = s.keysetCounters[keysetId] ?? 0;
      return { keysetCounters: { ...s.keysetCounters, [keysetId]: start + n } };
    });
    return { start, count: n };
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    useWalletStore.setState((s) => {
      const current = s.keysetCounters[keysetId] ?? 0;
      if (minNext <= current) return s;
      return { keysetCounters: { ...s.keysetCounters, [keysetId]: minNext } };
    });
  }

  async setNext(keysetId: string, next: number): Promise<void> {
    useWalletStore.setState((s) => {
      if ((s.keysetCounters[keysetId] ?? 0) === next) return s;
      return { keysetCounters: { ...s.keysetCounters, [keysetId]: next } };
    });
  }

  async snapshot(): Promise<Record<string, number>> {
    return { ...useWalletStore.getState().keysetCounters };
  }
}

const _counterSource = new ZustandCounterSource();

/**
 * Shared body of `_addMint` and `_addMintWithoutActivating`. The `activate`
 * flag is the only behavioural difference and exists explicitly so untrusted-
 * input ingress (paste/scan/NIP-17) can register a mint without retargeting
 * the user's `activeMintUrl` (P8 security review Finding 3).
 */
async function addOrUpdateMint(
  url: string,
  set: (update: (s: WalletState) => Partial<WalletState> | WalletState) => void,
  activate: boolean,
): Promise<void> {
  const normalized = normalizeUrl(url);
  const mint = new CashuMint(normalized);
  const [info, { keysets }, keys] = await Promise.all([
    mint.getInfo(),
    mint.getKeySets(),
    mint.getKeys(),
  ]);
  const storedMint: StoredMint = {
    url: normalized,
    info: info as unknown as Record<string, unknown>,
    keysets,
    keys: keys.keysets[0],
  };
  set((s) => {
    const exists = s.mints.some((m) => m.url === normalized);
    return {
      mints: exists
        ? s.mints.map((m) => (m.url === normalized ? storedMint : m))
        : [...s.mints, storedMint],
      activeMintUrl: activate ? normalized : s.activeMintUrl,
      mintConnectionStatuses: {
        ...s.mintConnectionStatuses,
        [normalized]: "connected",
      },
    };
  });
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      mnemonic: "",
      setupComplete: false,
      walletBackupState: "none",
      mints: [],
      activeMintUrl: DEFAULT_MINT_URL,
      keysetCounters: {},
      keysetCountersRecovered: {},
      mintConnectionStatuses: {},

      generateMnemonic: () => {
        const words = bip39.generate();
        _walletCache = new Map();
        // Clear deterministic counter state — the new seed has its own
        // counter space; reusing the previous wallet's counters or
        // recovered-flags would either skip required recovery for the new
        // seed or apply a stale counter to the wrong keyset (P8 codex
        // adversarial review #6).
        set({
          mnemonic: words.join(" "),
          walletBackupState: "needs_backup",
          keysetCounters: {},
          keysetCountersRecovered: {},
        });
      },

      ensureImplicitWallet: async () => {
        if (!get().mnemonic) {
          get().generateMnemonic();
        } else if (get().walletBackupState === "none") {
          set({ walletBackupState: "needs_backup" });
        }

        const { mints } = get();
        if (!mints.some((m) => m.url === DEFAULT_MINT_URL)) {
          try {
            if (mints.length === 0) {
              await get()._addMint(DEFAULT_MINT_URL);
            } else {
              await get()._addMintWithoutActivating(DEFAULT_MINT_URL);
            }
          } catch {
            /* retry on next app load */
          }
        }
        set({ setupComplete: true });
      },

      markWalletBackupConfirmed: () => set({ walletBackupState: "confirmed" }),

      recoverFromMnemonic: (words: string[]) => {
        if (words.length !== 12) {
          return { valid: false, error: "Seed phrase must be 12 words" };
        }
        if (!bip39.validate(words)) {
          return { valid: false, error: "Invalid seed phrase" };
        }
        _walletCache = new Map();
        // See generateMnemonic — clear counter state on seed change so the
        // recovered-flag idempotency doesn't suppress a needed scan for the
        // new seed.
        set({
          mnemonic: words.join(" "),
          walletBackupState: "confirmed",
          keysetCounters: {},
          keysetCountersRecovered: {},
        });
        return { valid: true };
      },

      testMintConnection: async (url: string): Promise<MintConnectionTestStatus> => {
        const normalized = normalizeUrl(url);
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: "failed" },
          }));
          return "failed";
        }
        set((s) => ({
          mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: "connecting" },
        }));
        try {
          const res = await fetch(`${normalized}/v1/info`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: "connected" },
          }));
          return "connected";
        } catch {
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: "failed" },
          }));
          return "failed";
        }
      },

      _addMint: async (url: string) => {
        await addOrUpdateMint(url, set, /* activate */ true);
      },

      _addMintWithoutActivating: async (url: string) => {
        await addOrUpdateMint(url, set, /* activate */ false);
      },

      _setActiveMint: (url: string) => {
        const normalized = normalizeUrl(url);
        set((s) => (s.mints.some((m) => m.url === normalized) ? { activeMintUrl: normalized } : s));
      },

      _removeMint: (url: string) => {
        const { mints } = get();
        if (mints.length <= 1) return;
        set((s) => ({
          mints: s.mints.filter((m) => m.url !== url),
          activeMintUrl:
            s.activeMintUrl === url ? s.mints.find((m) => m.url !== url)!.url : s.activeMintUrl,
        }));
      },

      completeSetup: async () => {
        // Ensure the default mint is added with full info (keysets, NUTs, etc.)
        // so features like CTF badge detection work on the Settings page.
        const { mints } = get();
        if (!mints.some((m) => m.url === DEFAULT_MINT_URL)) {
          try {
            if (mints.length === 0) {
              await get()._addMint(DEFAULT_MINT_URL);
            } else {
              await get()._addMintWithoutActivating(DEFAULT_MINT_URL);
            }
          } catch {
            /* retry on next app load */
          }
        }
        set({ setupComplete: true, walletBackupState: "confirmed" });
      },

      getWallet: async (
        mintUrl?: string,
        baseAsset?: MarketBaseAsset | string | null,
      ): Promise<CashuWallet> => {
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl);
        const cacheKey = walletCacheKey(url, baseAsset);
        const cached = _walletCache.get(cacheKey);
        if (cached) return cached;

        const unit = defaultCollateralUnit(baseAsset);
        const wallet = await createWallet(url, unit, get().mnemonic);
        _walletCache.set(cacheKey, wallet);
        return wallet;
      },

      getWalletForUnit: async (mintUrl: string | undefined, unit: string): Promise<CashuWallet> => {
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl);
        const cacheKey = walletUnitCacheKey(url, unit);
        const cached = _walletCache.get(cacheKey);
        if (cached) return cached;

        const wallet = await createWallet(url, unit, get().mnemonic);
        _walletCache.set(cacheKey, wallet);
        return wallet;
      },
    }),
    {
      name: "bitcaster-wallet",
      partialize: (state) => ({
        mnemonic: state.mnemonic,
        setupComplete: state.setupComplete,
        walletBackupState: state.walletBackupState,
        mints: state.mints,
        activeMintUrl: state.activeMintUrl,
        keysetCounters: state.keysetCounters,
        keysetCountersRecovered: state.keysetCountersRecovered,
        // Persist connection statuses so the Settings green/grey indicator
        // doesn't reset to grey on every reload. A background refetch in
        // App.tsx will correct any stale value on the next app load.
        mintConnectionStatuses: state.mintConnectionStatuses,
      }),
    },
  ),
);

export function useBalance(
  mintUrl?: string,
  options: { baseAsset?: MarketBaseAsset | string | null } = {},
): number {
  const normalized = mintUrl ? normalizeUrl(mintUrl) : undefined;
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  const balance = useLiveQuery(
    async () => {
      const proofs = normalized
        ? await db.proofs.where("mintUrl").equals(normalized).toArray()
        : await db.proofs.toArray();
      return proofs
        .filter((p) => !isCtfProof(p) && normalizeMarketBaseAsset(p.baseAsset) === baseAsset)
        .reduce((sum, p) => sum + amountToNumber(p.amount), 0);
    },
    [normalized, baseAsset],
    0,
  );
  return balance ?? 0;
}

export async function getBalance(
  mintUrl?: string,
  options: { baseAsset?: MarketBaseAsset | string | null } = {},
): Promise<number> {
  const proofs = await getUnitProofs(mintUrl, { unit: defaultCollateralUnit(options.baseAsset) });
  return proofs.reduce((sum: number, p: StoredProof) => sum + amountToNumber(p.amount), 0);
}

/**
 * Per-input mint fee (`input_fee_ppk`, parts-per-thousand) advertised by the
 * keysets the wallet already holds for `mintUrl`. The mint applies the same
 * `input_fee_ppk` to its primitive and conditional (CTF) keysets, so the
 * already-cached primitive keysets are a faithful proxy and no extra mint
 * round-trip is needed. Returns the max ppk across the mint's keysets, or `0`
 * when the mint advertises no fee (the first-release default).
 *
 * Read-only proxy for a *display* fee estimate — never a settlement
 * authority. With `input_fee_ppk === 0` (current bitCaster mint config) the
 * derived mint fee is `0 sats` and the trade panel shows a static label.
 */
export function useActiveMintInputFeePpk(mintUrl?: string): number {
  const normalized = mintUrl ? normalizeUrl(mintUrl) : undefined;
  return useWalletStore((s) => {
    const mint = s.mints.find((m) => (normalized ? m.url === normalized : true));
    return (mint?.keysets ?? []).reduce((max, ks) => Math.max(max, ks.input_fee_ppk ?? 0), 0);
  });
}
