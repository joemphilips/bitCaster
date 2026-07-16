import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  type MintKeys,
  type MintKeyset,
  type RequestOptions,
} from '@cashu/cashu-ts'
import { useLiveQuery } from 'dexie-react-hooks'
import * as bip39 from '@/lib/bip39'
import { normalizeUrl } from '@/lib/url'
import {
  configureGuiWalletIdProvider,
  getProofs,
  getUnitProofs,
  isCtfProof,
  type StoredProof,
} from './proof-db'
import type { MintConnectionTestStatus } from '@/types/wallet'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'
import { deriveDurableCustodyWalletId } from '@bitcaster/client-sdk/durableCustody'
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  type MarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'
import type { SecretBackupState } from '@/types/settings'
import { DexieCounterSource } from './gui-counter-source'

export interface StoredMint {
  url: string
  keys?: MintKeys
  keysets?: MintKeyset[]
  info?: Record<string, unknown>
}

type WalletTransportBounds = Pick<
  RequestOptions,
  'requestTimeout' | 'responseBodyBytesLimit' | 'signal'
>

interface WalletForUnitOptions extends WalletTransportBounds {
  enableCtf?: boolean
  expectedWalletId?: string
}

interface WalletState {
  mnemonic: string
  setupComplete: boolean
  walletBackupState: SecretBackupState
  mints: StoredMint[]
  activeMintUrl: string
  mintConnectionStatuses: Record<string, MintConnectionTestStatus>

  generateMnemonic: () => void
  ensureImplicitWallet: () => Promise<void>
  markWalletBackupConfirmed: () => void
  recoverFromMnemonic: (words: string[]) => { valid: boolean; error?: string }
  testMintConnection: (url: string) => Promise<MintConnectionTestStatus>
  /**
   * Internal walletOps primitive. Registers a mint and SETS it as active.
   * Application code must call `userAddAndSelectMint` instead.
   */
  _addMint: (url: string) => Promise<void>
  /**
   * Internal walletOps primitive. Registers a mint WITHOUT changing
   * `activeMintUrl`. Application ingress must call `ingressRegisterMint` or
   * `ingressReceiveCashuToken` instead.
   */
  _addMintWithoutActivating: (
    url: string,
    options?: { expectedWalletId?: string },
  ) => Promise<void>
  _removeMint: (url: string) => void
  _setActiveMint: (url: string) => void
  completeSetup: () => Promise<void>
  getWallet: (
    mintUrl?: string,
    baseAsset?: MarketBaseAsset | string | null,
    options?: { expectedWalletId?: string },
  ) => Promise<CashuWallet>
  getWalletForUnit: (
    mintUrl: string | undefined,
    unit: string,
    options?: WalletForUnitOptions,
  ) => Promise<CashuWallet>
}

export const DEFAULT_MINT_URL = normalizeUrl(
  import.meta.env.VITE_MINT_URL ?? 'http://localhost:8085',
)

let _walletCache: Map<string, CashuWallet> = new Map()

function walletCacheKey(
  walletId: string,
  mintUrl: string,
  baseAsset?: MarketBaseAsset | string | null,
): string {
  return `${walletId}::${mintUrl}::${defaultCollateralUnit(baseAsset)}`
}

function walletUnitCacheKey(
  walletId: string,
  mintUrl: string,
  unit: string,
  enableCtf = false,
): string {
  return `${walletId}::${mintUrl}::unit:${unit}::ctf:${enableCtf}`
}

function getSeedBytes(mnemonic: string): Uint8Array | undefined {
  if (!mnemonic) return undefined
  return bip39.toSeed(mnemonic.split(' '))
}

async function createWallet(
  url: string,
  unit: string,
  seedBytes: Uint8Array | undefined,
  walletId: string,
  enableCtf = false,
  requestOptions?: WalletTransportBounds,
): Promise<CashuWallet> {
  const mint = new CashuMint(url)
  const wallet = new CashuWallet(mint, {
    unit,
    ...(enableCtf ? { enableCtf: true } : {}),
    ...(seedBytes
      ? {
          bip39seed: seedBytes,
          counterSource: new DexieCounterSource(walletId),
        }
      : {}),
  })
  await wallet.loadMint(undefined, requestOptions)
  return wallet
}

interface CapturedWalletIdentity {
  seedBytes: Uint8Array | undefined
  walletId: string
}

function captureWalletIdentity(
  mnemonic: string,
  expectedWalletId?: string,
): CapturedWalletIdentity {
  const seedBytes = getSeedBytes(mnemonic)
  const walletId = seedBytes
    ? deriveDurableCustodyWalletId(seedBytes)
    : 'anonymous'
  if (expectedWalletId !== undefined && expectedWalletId !== walletId) {
    throw new Error('Active wallet seed does not match the held wallet lock')
  }
  return { seedBytes, walletId }
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
  get: () => WalletState,
  activate: boolean,
  expectedWalletId?: string,
): Promise<void> {
  if (expectedWalletId !== undefined) {
    captureWalletIdentity(get().mnemonic, expectedWalletId)
  }
  const normalized = normalizeUrl(url)
  const mint = new CashuMint(normalized)
  const [info, { keysets }, keys] = await Promise.all([
    mint.getInfo(),
    mint.getKeySets(),
    mint.getKeys(),
  ])
  const storedMint: StoredMint = {
    url: normalized,
    info: info as unknown as Record<string, unknown>,
    keysets,
    keys: keys.keysets[0],
  }
  set((s) => {
    if (expectedWalletId !== undefined) {
      captureWalletIdentity(s.mnemonic, expectedWalletId)
    }
    const exists = s.mints.some((m) => m.url === normalized)
    return {
      mints: exists
        ? s.mints.map((m) => (m.url === normalized ? storedMint : m))
        : [...s.mints, storedMint],
      activeMintUrl: activate ? normalized : s.activeMintUrl,
      mintConnectionStatuses: {
        ...s.mintConnectionStatuses,
        [normalized]: 'connected',
      },
    }
  })
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      mnemonic: '',
      setupComplete: false,
      walletBackupState: 'none',
      mints: [],
      activeMintUrl: DEFAULT_MINT_URL,
      mintConnectionStatuses: {},

      generateMnemonic: () => {
        const words = bip39.generate()
        _walletCache = new Map()
        set({
          mnemonic: words.join(' '),
          walletBackupState: 'needs_backup',
        })
      },

      ensureImplicitWallet: async () => {
        if (!get().mnemonic) {
          get().generateMnemonic()
        } else if (get().walletBackupState === 'none') {
          set({ walletBackupState: 'needs_backup' })
        }

        const { mints } = get()
        if (!mints.some((m) => m.url === DEFAULT_MINT_URL)) {
          try {
            if (mints.length === 0) {
              await get()._addMint(DEFAULT_MINT_URL)
            } else {
              await get()._addMintWithoutActivating(DEFAULT_MINT_URL)
            }
          } catch {
            /* retry on next app load */
          }
        }
        set({ setupComplete: true })
      },

      markWalletBackupConfirmed: () => set({ walletBackupState: 'confirmed' }),

      recoverFromMnemonic: (words: string[]) => {
        if (words.length !== 12) {
          return { valid: false, error: 'Seed phrase must be 12 words' }
        }
        if (!bip39.validate(words)) {
          return { valid: false, error: 'Invalid seed phrase' }
        }
        _walletCache = new Map()
        set({
          mnemonic: words.join(' '),
          walletBackupState: 'confirmed',
        })
        return { valid: true }
      },

      testMintConnection: async (
        url: string,
      ): Promise<MintConnectionTestStatus> => {
        const normalized = normalizeUrl(url)
        if (
          !normalized.startsWith('http://') &&
          !normalized.startsWith('https://')
        ) {
          set((s) => ({
            mintConnectionStatuses: {
              ...s.mintConnectionStatuses,
              [normalized]: 'failed',
            },
          }))
          return 'failed'
        }
        set((s) => ({
          mintConnectionStatuses: {
            ...s.mintConnectionStatuses,
            [normalized]: 'connecting',
          },
        }))
        try {
          const res = await fetch(`${normalized}/v1/info`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          set((s) => ({
            mintConnectionStatuses: {
              ...s.mintConnectionStatuses,
              [normalized]: 'connected',
            },
          }))
          return 'connected'
        } catch {
          set((s) => ({
            mintConnectionStatuses: {
              ...s.mintConnectionStatuses,
              [normalized]: 'failed',
            },
          }))
          return 'failed'
        }
      },

      _addMint: async (url: string) => {
        await addOrUpdateMint(url, set, get, /* activate */ true)
      },

      _addMintWithoutActivating: async (
        url: string,
        options?: { expectedWalletId?: string },
      ) => {
        await addOrUpdateMint(
          url,
          set,
          get,
          /* activate */ false,
          options?.expectedWalletId,
        )
      },

      _setActiveMint: (url: string) => {
        const normalized = normalizeUrl(url)
        set((s) =>
          s.mints.some((m) => m.url === normalized)
            ? { activeMintUrl: normalized }
            : s,
        )
      },

      _removeMint: (url: string) => {
        const { mints } = get()
        if (mints.length <= 1) return
        set((s) => ({
          mints: s.mints.filter((m) => m.url !== url),
          activeMintUrl:
            s.activeMintUrl === url
              ? s.mints.find((m) => m.url !== url)!.url
              : s.activeMintUrl,
        }))
      },

      completeSetup: async () => {
        // Ensure the default mint is added with full info (keysets, NUTs, etc.)
        // so features like CTF badge detection work on the Settings page.
        const { mints } = get()
        if (!mints.some((m) => m.url === DEFAULT_MINT_URL)) {
          try {
            if (mints.length === 0) {
              await get()._addMint(DEFAULT_MINT_URL)
            } else {
              await get()._addMintWithoutActivating(DEFAULT_MINT_URL)
            }
          } catch {
            /* retry on next app load */
          }
        }
        set({ setupComplete: true, walletBackupState: 'confirmed' })
      },

      getWallet: async (
        mintUrl?: string,
        baseAsset?: MarketBaseAsset | string | null,
        options?: { expectedWalletId?: string },
      ): Promise<CashuWallet> => {
        const identity = captureWalletIdentity(
          get().mnemonic,
          options?.expectedWalletId,
        )
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl)
        const cacheKey = walletCacheKey(identity.walletId, url, baseAsset)
        const cached = _walletCache.get(cacheKey)
        if (cached) return cached

        const unit = defaultCollateralUnit(baseAsset)
        const wallet = await createWallet(
          url,
          unit,
          identity.seedBytes,
          identity.walletId,
        )
        _walletCache.set(cacheKey, wallet)
        return wallet
      },

      getWalletForUnit: async (
        mintUrl: string | undefined,
        unit: string,
        options?: WalletForUnitOptions,
      ): Promise<CashuWallet> => {
        const identity = captureWalletIdentity(
          get().mnemonic,
          options?.expectedWalletId,
        )
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl)
        const enableCtf = options?.enableCtf === true
        const cacheKey = walletUnitCacheKey(
          identity.walletId,
          url,
          unit,
          enableCtf,
        )
        const cached = _walletCache.get(cacheKey)
        if (cached) return cached

        const wallet = await createWallet(
          url,
          unit,
          identity.seedBytes,
          identity.walletId,
          enableCtf,
          options,
        )
        _walletCache.set(cacheKey, wallet)
        return wallet
      },
    }),
    {
      name: 'bitcaster-wallet',
      partialize: (state) => ({
        mnemonic: state.mnemonic,
        setupComplete: state.setupComplete,
        walletBackupState: state.walletBackupState,
        mints: state.mints,
        activeMintUrl: state.activeMintUrl,
        // Persist connection statuses so the Settings green/grey indicator
        // doesn't reset to grey on every reload. A background refetch in
        // App.tsx will correct any stale value on the next app load.
        mintConnectionStatuses: state.mintConnectionStatuses,
      }),
    },
  ),
)

configureGuiWalletIdProvider(() => {
  const seed = getSeedBytes(useWalletStore.getState().mnemonic)
  if (!seed) throw new Error('Funded browser work requires a wallet seed')
  return deriveDurableCustodyWalletId(seed)
})

export function useBalance(
  mintUrl?: string,
  options: { baseAsset?: MarketBaseAsset | string | null } = {},
): number {
  const normalized = mintUrl ? normalizeUrl(mintUrl) : undefined
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset)
  const mnemonic = useWalletStore((state) => state.mnemonic)
  const balance = useLiveQuery(
    async () => {
      if (!mnemonic) return 0
      const proofs = await getProofs(normalized)
      return proofs
        .filter(
          (p) =>
            !isCtfProof(p) &&
            normalizeMarketBaseAsset(p.baseAsset) === baseAsset,
        )
        .reduce((sum, p) => sum + amountToNumber(p.amount), 0)
    },
    [normalized, baseAsset, mnemonic],
    0,
  )
  return balance ?? 0
}

export async function getBalance(
  mintUrl?: string,
  options: { baseAsset?: MarketBaseAsset | string | null } = {},
): Promise<number> {
  const proofs = await getUnitProofs(mintUrl, {
    unit: defaultCollateralUnit(options.baseAsset),
  })
  return proofs.reduce(
    (sum: number, p: StoredProof) => sum + amountToNumber(p.amount),
    0,
  )
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
  const normalized = mintUrl ? normalizeUrl(mintUrl) : undefined
  return useWalletStore((s) => {
    const mint = s.mints.find((m) => (normalized ? m.url === normalized : true))
    return (mint?.keysets ?? []).reduce(
      (max, ks) => Math.max(max, ks.input_fee_ppk ?? 0),
      0,
    )
  })
}
