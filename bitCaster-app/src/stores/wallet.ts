import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Mint as CashuMint, Wallet as CashuWallet, type MintKeys, type MintKeyset, type CounterSource, type CounterRange } from '@cashu/cashu-ts'
import { useLiveQuery } from 'dexie-react-hooks'
import * as bip39 from '@/lib/bip39'
import { normalizeUrl } from '@/lib/url'
import { db, getProofs, type StoredProof } from './proof-db'
import type { MintConnectionTestStatus } from '@/types/wallet-setup'

export interface StoredMint {
  url: string
  keys?: MintKeys
  keysets?: MintKeyset[]
  info?: Record<string, unknown>
}

interface WalletState {
  mnemonic: string
  setupComplete: boolean
  mints: StoredMint[]
  activeMintUrl: string
  keysetCounters: Record<string, number>
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
  keysetCountersRecovered: Record<string, boolean>
  mintConnectionStatuses: Record<string, MintConnectionTestStatus>

  generateMnemonic: () => void
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
  _addMintWithoutActivating: (url: string) => Promise<void>
  _removeMint: (url: string) => void
  _setActiveMint: (url: string) => void
  completeSetup: () => Promise<void>
  getWallet: (mintUrl?: string) => Promise<CashuWallet>
}

export const DEFAULT_MINT_URL = normalizeUrl(import.meta.env.VITE_MINT_URL ?? 'http://localhost:8085')

let _walletCache: Map<string, CashuWallet> = new Map()

function getSeedBytes(mnemonic: string): Uint8Array | undefined {
  if (!mnemonic) return undefined
  return bip39.toSeed(mnemonic.split(' '))
}

/**
 * CounterSource backed by the Zustand wallet store's keysetCounters.
 * Persists deterministic output counters to localStorage so they survive
 * page reloads and prevent "Blinded Message already signed" collisions.
 */
class ZustandCounterSource implements CounterSource {
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    if (n === 0) {
      const current = useWalletStore.getState().keysetCounters[keysetId] ?? 0
      return { start: current, count: 0 }
    }
    let start = 0
    useWalletStore.setState((s) => {
      start = s.keysetCounters[keysetId] ?? 0
      return { keysetCounters: { ...s.keysetCounters, [keysetId]: start + n } }
    })
    return { start, count: n }
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    useWalletStore.setState((s) => {
      const current = s.keysetCounters[keysetId] ?? 0
      if (minNext <= current) return s
      return { keysetCounters: { ...s.keysetCounters, [keysetId]: minNext } }
    })
  }

  async setNext(keysetId: string, next: number): Promise<void> {
    useWalletStore.setState((s) => {
      if ((s.keysetCounters[keysetId] ?? 0) === next) return s
      return { keysetCounters: { ...s.keysetCounters, [keysetId]: next } }
    })
  }

  async snapshot(): Promise<Record<string, number>> {
    return { ...useWalletStore.getState().keysetCounters }
  }
}

const _counterSource = new ZustandCounterSource()

/**
 * Shared body of `_addMint` and `_addMintWithoutActivating`. The `activate`
 * flag is the only behavioural difference and exists explicitly so untrusted-
 * input ingress (paste/scan/NIP-17) can register a mint without retargeting
 * the user's `activeMintUrl` (P8 security review Finding 3).
 */
async function addOrUpdateMint(
  url: string,
  set: (
    update: (s: WalletState) => Partial<WalletState> | WalletState
  ) => void,
  activate: boolean
): Promise<void> {
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
      mints: [],
      activeMintUrl: DEFAULT_MINT_URL,
      keysetCounters: {},
      keysetCountersRecovered: {},
      mintConnectionStatuses: {},

      generateMnemonic: () => {
        const words = bip39.generate()
        _walletCache = new Map()
        // Clear deterministic counter state — the new seed has its own
        // counter space; reusing the previous wallet's counters or
        // recovered-flags would either skip required recovery for the new
        // seed or apply a stale counter to the wrong keyset (P8 codex
        // adversarial review #6).
        set({
          mnemonic: words.join(' '),
          keysetCounters: {},
          keysetCountersRecovered: {},
        })
      },

      recoverFromMnemonic: (words: string[]) => {
        if (words.length !== 12) {
          return { valid: false, error: 'Seed phrase must be 12 words' }
        }
        if (!bip39.validate(words)) {
          return { valid: false, error: 'Invalid seed phrase' }
        }
        _walletCache = new Map()
        // See generateMnemonic — clear counter state on seed change so the
        // recovered-flag idempotency doesn't suppress a needed scan for the
        // new seed.
        set({
          mnemonic: words.join(' '),
          keysetCounters: {},
          keysetCountersRecovered: {},
        })
        return { valid: true }
      },

      testMintConnection: async (url: string): Promise<MintConnectionTestStatus> => {
        const normalized = normalizeUrl(url)
        if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: 'failed' },
          }))
          return 'failed'
        }
        set((s) => ({
          mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: 'connecting' },
        }))
        try {
          const res = await fetch(`${normalized}/v1/info`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: 'connected' },
          }))
          return 'connected'
        } catch {
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [normalized]: 'failed' },
          }))
          return 'failed'
        }
      },

      _addMint: async (url: string) => {
        await addOrUpdateMint(url, set, /* activate */ true)
      },

      _addMintWithoutActivating: async (url: string) => {
        await addOrUpdateMint(url, set, /* activate */ false)
      },

      _setActiveMint: (url: string) => {
        const normalized = normalizeUrl(url)
        set((s) =>
          s.mints.some((m) => m.url === normalized)
            ? { activeMintUrl: normalized }
            : s
        )
      },

      _removeMint: (url: string) => {
        const { mints } = get()
        if (mints.length <= 1) return
        set((s) => ({
          mints: s.mints.filter((m) => m.url !== url),
          activeMintUrl: s.activeMintUrl === url ? s.mints.find((m) => m.url !== url)!.url : s.activeMintUrl,
        }))
      },

      completeSetup: async () => {
        // Ensure the default mint is added with full info (keysets, NUTs, etc.)
        // so features like CTF badge detection work on the Settings page.
        const { mints } = get()
        if (!mints.some((m) => m.url === DEFAULT_MINT_URL)) {
          try { await get()._addMint(DEFAULT_MINT_URL) } catch { /* retry on next app load */ }
        }
        set({ setupComplete: true })
      },

      getWallet: async (mintUrl?: string): Promise<CashuWallet> => {
        const url = normalizeUrl(mintUrl ?? get().activeMintUrl)
        const cached = _walletCache.get(url)
        if (cached) return cached

        const seedBytes = getSeedBytes(get().mnemonic)
        const mint = new CashuMint(url)
        const wallet = new CashuWallet(mint, {
          unit: 'sat',
          ...(seedBytes ? { bip39seed: seedBytes, counterSource: _counterSource } : {}),
        })
        await wallet.loadMint()
        _walletCache.set(url, wallet)
        return wallet
      },
    }),
    {
      name: 'bitcaster-wallet',
      partialize: (state) => ({
        mnemonic: state.mnemonic,
        setupComplete: state.setupComplete,
        mints: state.mints,
        activeMintUrl: state.activeMintUrl,
        keysetCounters: state.keysetCounters,
        keysetCountersRecovered: state.keysetCountersRecovered,
        // Persist connection statuses so the Settings green/grey indicator
        // doesn't reset to grey on every reload. A background refetch in
        // App.tsx will correct any stale value on the next app load.
        mintConnectionStatuses: state.mintConnectionStatuses,
      }),
    }
  )
)

export function useBalance(mintUrl?: string): number {
  const normalized = mintUrl ? normalizeUrl(mintUrl) : undefined
  const balance = useLiveQuery(async () => {
    const proofs = normalized
      ? await db.proofs.where('mintUrl').equals(normalized).toArray()
      : await db.proofs.toArray()
    return proofs.reduce((sum, p) => sum + p.amount, 0)
  }, [normalized], 0)
  return balance ?? 0
}

export async function getBalance(mintUrl?: string): Promise<number> {
  const proofs = await getProofs(mintUrl)
  return proofs.reduce((sum: number, p: StoredProof) => sum + p.amount, 0)
}
