import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  setGlobalRequestOptions,
  type MintKeys,
  type MintKeyset,
  type CounterSource,
} from "@cashu/cashu-ts";
import { useLiveQuery } from "dexie-react-hooks";
import * as bip39 from "@/lib/bip39";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { normalizeUrl } from "@/lib/url";
import { requestBrowserWalletStoragePersistence } from "@/lib/browserWalletStoragePersistence";
import { activeBrowserEncryptedWalletBackupV2RuntimeDriver } from "@/lib/encryptedWalletBackupDriver";
import i18n from "@/i18n";
import {
  BrowserEncryptedWalletBackupV2SeedHandoffRefusal,
  handoffBrowserEncryptedWalletBackupV2Seed,
} from "@/lib/browserEncryptedWalletBackupV2SeedHandoff";
import {
  activateBrowserWalletDatabase,
  db,
  getCanonicalSelectableProofs,
  isCtfProof,
} from "./proof-db";
import { createActiveBrowserWalletCounterSource } from "./browser-wallet-counter-db";
import type { MintConnectionTestStatus } from "@/types/wallet";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { readPublicMintMetadata } from "@bitcaster/client-sdk";
import {
  cashuAmountToMarketSubunits,
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import type { SecretBackupState } from "@/types/settings";
import { useToastStore } from "./toast";
import { usePendingTradesStore } from "./pendingTrades";

const BROWSER_MINT_REQUEST_TIMEOUT_MS = 60_000;
setGlobalRequestOptions({ requestTimeout: BROWSER_MINT_REQUEST_TIMEOUT_MS });

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
  walletSeedReminderAcknowledgedScopeId: string | null;
  mints: StoredMint[];
  activeMintUrl: string;
  mintConnectionStatuses: Record<string, MintConnectionTestStatus>;

  generateMnemonic: () => void;
  ensureImplicitWallet: () => Promise<void>;
  markWalletBackupConfirmed: () => void;
  acknowledgeWalletSeedReminder: () => void;
  recoverFromMnemonic: (words: string[]) => Promise<{ valid: boolean; error?: string }>;
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
  getWallet: (mintUrl: string | undefined, baseAsset: MarketBaseAsset) => Promise<CashuWallet>;
  getWalletForUnit: (mintUrl: string | undefined, unit: string) => Promise<CashuWallet>;
}

export const DEFAULT_MINT_URL = normalizeUrl(
  import.meta.env.VITE_MINT_URL ?? "http://localhost:8085",
);

let _walletCache: Map<string, CashuWallet> = new Map();

function walletCacheKey(scopeId: string, mintUrl: string, baseAsset: MarketBaseAsset): string {
  return `${scopeId}::${mintUrl}::${defaultCollateralUnit(baseAsset)}`;
}

function walletUnitCacheKey(scopeId: string, mintUrl: string, unit: string): string {
  return `${scopeId}::${mintUrl}::unit:${unit}`;
}

function getSeedBytes(mnemonic: string): Uint8Array | undefined {
  if (!mnemonic) return undefined;
  return bip39.toSeed(mnemonic.split(" "));
}

async function createWallet(url: string, unit: string, mnemonic: string): Promise<CashuWallet> {
  const seedBytes = getSeedBytes(mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  if (!seedBytes || scopeId === null) throw new Error("The wallet profile is unavailable.");
  const mint = new CashuMint(url);
  const wallet = new CashuWallet(mint, {
    unit,
    bip39seed: seedBytes,
    counterSource: createActiveBrowserWalletCounterSource(db, scopeId, { mintUrl: url, unit }),
  });
  await wallet.loadMint();
  return wallet;
}

function activateWalletProfile(mnemonic: string): void {
  setActiveBrowserWalletProfile(mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  if (scopeId !== null) activateBrowserWalletDatabase(scopeId);
}

function requestWalletStoragePersistence(mnemonic: string): void {
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  if (scopeId !== null) requestBrowserWalletStoragePersistence(scopeId);
}

class WalletReplacementRefusal extends Error {
  constructor(readonly code: "pending-orders" | "unscoped-pending-orders") {
    super(code);
    this.name = "WalletReplacementRefusal";
  }
}

const WALLET_REPLACEMENT_REFUSAL_I18N_KEYS: Record<
  WalletReplacementRefusal["code"] | BrowserEncryptedWalletBackupV2SeedHandoffRefusal["code"],
  string
> = {
  "pending-orders": "wallet.replaceBlockedPendingOrders",
  "unscoped-pending-orders": "wallet.replaceBlockedUnscopedOrders",
  "active-wallet-work": "wallet.replaceBlockedActiveWork",
  "backup-not-current": "wallet.replaceBlockedBackup",
  "browser-lock-unavailable": "wallet.replaceBlockedBrowserLock",
};

function walletReplacementErrorMessage(error: unknown): string {
  if (
    error instanceof WalletReplacementRefusal ||
    error instanceof BrowserEncryptedWalletBackupV2SeedHandoffRefusal
  ) {
    return i18n.t(WALLET_REPLACEMENT_REFUSAL_I18N_KEYS[error.code]);
  }
  return i18n.t("wallet.replaceBlockedSafetyChecks");
}

/** Create a counter source that stays bound to one active wallet profile. */
export function createBrowserWalletCounterSource(
  scopeId: string,
  mintUrl: string,
  unit: string,
): CounterSource {
  return createActiveBrowserWalletCounterSource(db, scopeId, { mintUrl, unit });
}

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
  const { info, keysets, keys } = await readPublicMintMetadata(normalized);
  const storedMint: StoredMint = {
    url: normalized,
    info: info as unknown as Record<string, unknown>,
    keysets,
    keys: keys[0],
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
      walletSeedReminderAcknowledgedScopeId: null,
      mints: [],
      activeMintUrl: DEFAULT_MINT_URL,
      mintConnectionStatuses: {},

      generateMnemonic: () => {
        const previousWallet = get();
        if (previousWallet.mnemonic) {
          throw new Error("Seed switching requires an acknowledged encrypted backup.");
        }
        const words = bip39.generate();
        const mnemonic = words.join(" ");

        try {
          set({
            mnemonic,
            walletBackupState: "needs_backup",
            walletSeedReminderAcknowledgedScopeId: null,
          });
        } catch (error) {
          // Zustand updates memory before localStorage. Restore only the seed
          // fields so a failed initial write leaves creation retryable.
          try {
            set({
              mnemonic: previousWallet.mnemonic,
              walletBackupState: previousWallet.walletBackupState,
              walletSeedReminderAcknowledgedScopeId:
                previousWallet.walletSeedReminderAcknowledgedScopeId,
            });
          } catch {
            // The rollback setter changes memory before its storage attempt.
          }
          throw error;
        }

        _walletCache = new Map();
        activateWalletProfile(mnemonic);
        requestWalletStoragePersistence(mnemonic);
      },

      ensureImplicitWallet: async () => {
        if (!get().mnemonic) {
          get().generateMnemonic();
          useToastStore.getState().addToast({
            type: "success",
            message: i18n.t("wallet.created"),
          });
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

      acknowledgeWalletSeedReminder: () => {
        const { mnemonic } = get();
        const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
        if (scopeId === null || activeBrowserWalletScopeId() !== scopeId) return;
        set({ walletSeedReminderAcknowledgedScopeId: scopeId });
      },

      recoverFromMnemonic: async (words: string[]) => {
        if (words.length !== 12) {
          return { valid: false, error: "Seed phrase must be 12 words" };
        }
        if (!bip39.validate(words)) {
          return { valid: false, error: "Invalid seed phrase" };
        }
        _walletCache = new Map();
        const mnemonic = words.join(" ");
        const currentMnemonic = get().mnemonic.trim();
        if (currentMnemonic === mnemonic) {
          set({ walletBackupState: "confirmed" });
          requestWalletStoragePersistence(mnemonic);
          return { valid: true };
        }
        if (currentMnemonic) {
          const previousWalletBackupState = get().walletBackupState;
          const previousSeedReminderAcknowledgement = get().walletSeedReminderAcknowledgedScopeId;
          const oldScopeId = browserWalletScopeIdFromMnemonic(currentMnemonic);
          if (oldScopeId === null) {
            return { valid: false, error: "The wallet profile is unavailable." };
          }
          const oldDatabase = db;
          const oldWalletId = browserWalletIdFromMnemonic(currentMnemonic);
          if (oldWalletId === null) {
            return { valid: false, error: i18n.t("wallet.replaceBlockedSafetyChecks") };
          }
          const backupDriver = activeBrowserEncryptedWalletBackupV2RuntimeDriver(oldScopeId);
          let replacementCommitted = false;
          try {
            await backupDriver?.quiesceForSeedHandoff();
            await handoffBrowserEncryptedWalletBackupV2Seed({
              database: oldDatabase,
              scopeId: oldScopeId,
              isCurrentProfile: () => activeBrowserWalletScopeId() === oldScopeId,
              assertNoPendingOrders: () => {
                const pendingTrades = usePendingTradesStore.getState();
                if (pendingTrades.hasUnscopedPending()) {
                  throw new WalletReplacementRefusal("unscoped-pending-orders");
                }
                if (pendingTrades.hasPendingForWallet(oldWalletId)) {
                  throw new WalletReplacementRefusal("pending-orders");
                }
              },
              invalidateOldProfile: () => setActiveBrowserWalletProfile(""),
              activateNewProfile: async () => {
                activateWalletProfile(mnemonic);
                set({
                  mnemonic,
                  walletBackupState: "confirmed",
                  walletSeedReminderAcknowledgedScopeId: null,
                });
              },
              restoreOldProfile: async () => {
                activateWalletProfile(currentMnemonic);
                try {
                  set({
                    mnemonic: currentMnemonic,
                    walletBackupState: previousWalletBackupState,
                    walletSeedReminderAcknowledgedScopeId: previousSeedReminderAcknowledgement,
                  });
                } catch {
                  // Zustand restores in-memory state before its synchronous storage write.
                }
              },
            });
            replacementCommitted = true;
          } catch (error) {
            return {
              valid: false,
              error: walletReplacementErrorMessage(error),
            };
          } finally {
            if (
              !replacementCommitted &&
              backupDriver !== null &&
              activeBrowserWalletScopeId() === oldScopeId &&
              activeBrowserEncryptedWalletBackupV2RuntimeDriver(oldScopeId) === backupDriver
            ) {
              backupDriver.resumeAfterSeedHandoff();
            }
          }
          requestWalletStoragePersistence(mnemonic);
          return { valid: true };
        }
        const previousSeedState = {
          mnemonic: get().mnemonic,
          walletBackupState: get().walletBackupState,
          walletSeedReminderAcknowledgedScopeId: get().walletSeedReminderAcknowledgedScopeId,
        };
        try {
          set({
            mnemonic,
            walletBackupState: "confirmed",
            walletSeedReminderAcknowledgedScopeId: null,
          });
        } catch (error) {
          try {
            set(previousSeedState);
          } catch {
            // Zustand resets memory before the synchronous rollback storage write.
          }
          throw error;
        }
        activateWalletProfile(mnemonic);
        requestWalletStoragePersistence(mnemonic);
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
        mintUrl: string | undefined,
        baseAsset: MarketBaseAsset,
      ): Promise<CashuWallet> => {
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl);
        const mnemonic = get().mnemonic;
        const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
        if (scopeId === null || activeBrowserWalletScopeId() !== scopeId) {
          throw new Error("The wallet profile is unavailable.");
        }
        const cacheKey = walletCacheKey(scopeId, url, baseAsset);
        const cached = _walletCache.get(cacheKey);
        if (cached) return cached;

        const unit = defaultCollateralUnit(baseAsset);
        const wallet = await createWallet(url, unit, mnemonic);
        _walletCache.set(cacheKey, wallet);
        return wallet;
      },

      getWalletForUnit: async (mintUrl: string | undefined, unit: string): Promise<CashuWallet> => {
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl);
        const mnemonic = get().mnemonic;
        const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
        if (scopeId === null || activeBrowserWalletScopeId() !== scopeId) {
          throw new Error("The wallet profile is unavailable.");
        }
        const cacheKey = walletUnitCacheKey(scopeId, url, unit);
        const cached = _walletCache.get(cacheKey);
        if (cached) return cached;

        const wallet = await createWallet(url, unit, mnemonic);
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
        walletSeedReminderAcknowledgedScopeId: state.walletSeedReminderAcknowledgedScopeId,
        mints: state.mints,
        activeMintUrl: state.activeMintUrl,
        // Persist connection statuses so the Settings green/grey indicator
        // doesn't reset to grey on every reload. A background refetch in
        // App.tsx will correct any stale value on the next app load.
        mintConnectionStatuses: state.mintConnectionStatuses,
      }),
      onRehydrateStorage: () => (state) => {
        activateWalletProfile(state?.mnemonic ?? "");
      },
    },
  ),
);

export async function getWalletForMnemonicUnit(
  mintUrl: string,
  unit: string,
  mnemonic: string,
): Promise<CashuWallet> {
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  if (scopeId === null || activeBrowserWalletScopeId() !== scopeId) {
    throw new Error("The wallet profile changed during funded work.");
  }
  const url = normalizeUrl(mintUrl);
  const cacheKey = walletUnitCacheKey(scopeId, url, unit);
  const cached = _walletCache.get(cacheKey);
  if (cached) return cached;
  const wallet = await createWallet(url, unit, mnemonic);
  if (activeBrowserWalletScopeId() !== scopeId) {
    throw new Error("The wallet profile changed during funded work.");
  }
  _walletCache.set(cacheKey, wallet);
  return wallet;
}

export function useBalance(
  mintUrl: string | undefined,
  options: { readonly baseAsset: MarketBaseAsset | string },
): number {
  const normalized = mintUrl ? normalizeUrl(mintUrl) : undefined;
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const balance = useLiveQuery(
    async () => {
      const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
      if (scopeId === null) return 0;
      const proofs = await getCanonicalSelectableProofs(scopeId);
      if (proofs === null) throw new Error("Canonical wallet custody is unavailable");
      return proofs
        .filter(
          (p) =>
            (!normalized || p.mintUrl === normalized) &&
            !isCtfProof(p) &&
            normalizeMarketBaseAsset(p.baseAsset) === baseAsset,
        )
        .reduce((sum, p) => {
          const unit = parseCashuProofUnit(p.unit);
          return unit ? sum + cashuAmountToMarketSubunits(amountToNumber(p.amount), unit) : sum;
        }, 0);
    },
    [normalized, baseAsset, mnemonic],
    0,
  );
  return balance ?? 0;
}

export async function getBalance(
  mintUrl?: string,
  options: { baseAsset?: MarketBaseAsset | string | null } = {},
): Promise<number> {
  return getExactUnitBalance(mintUrl, defaultCollateralUnit(options.baseAsset));
}

/** Read the spendable balance for one exact Cashu unit. */
export async function getExactUnitBalance(
  mintUrl: string | undefined,
  unit: string,
): Promise<number> {
  const scopeId = activeBrowserWalletScopeId();
  if (scopeId === null) throw new Error("The wallet profile is unavailable");
  const proofs = await getCanonicalSelectableProofs(scopeId);
  if (proofs === null) throw new Error("Canonical wallet custody is unavailable");
  const normalizedMint = mintUrl ? normalizeUrl(mintUrl) : undefined;
  const exactUnit = parseCashuProofUnit(unit);
  if (!exactUnit) throw new Error(`Unsupported Cashu proof unit '${unit}'`);
  return proofs
    .filter(
      (proof) =>
        (!normalizedMint || proof.mintUrl === normalizedMint) &&
        !isCtfProof(proof) &&
        proof.unit === exactUnit,
    )
    .reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
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
