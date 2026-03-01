import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { CashuMint, CashuWallet, type MintKeys, type MintKeyset } from '@cashu/cashu-ts'
import * as bip39 from '@/lib/bip39'
import { getProofs, type StoredProof } from './proof-db'
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
  mintConnectionStatuses: Record<string, MintConnectionTestStatus>

  generateMnemonic: () => void
  recoverFromMnemonic: (words: string[]) => { valid: boolean; error?: string }
  testMintConnection: (url: string) => Promise<MintConnectionTestStatus>
  addMint: (url: string) => Promise<void>
  removeMint: (url: string) => void
  completeSetup: () => void
  getWallet: (mintUrl?: string) => Promise<CashuWallet>
}

const DEFAULT_MINT_URL = import.meta.env.VITE_MINT_URL ?? 'http://localhost:3338'

let _walletCache: Map<string, CashuWallet> = new Map()

function getSeedBytes(mnemonic: string): Uint8Array | undefined {
  if (!mnemonic) return undefined
  return bip39.toSeed(mnemonic.split(' '))
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      mnemonic: '',
      setupComplete: false,
      mints: [],
      activeMintUrl: DEFAULT_MINT_URL,
      keysetCounters: {},
      mintConnectionStatuses: {},

      generateMnemonic: () => {
        const words = bip39.generate()
        _walletCache = new Map()
        set({ mnemonic: words.join(' ') })
      },

      recoverFromMnemonic: (words: string[]) => {
        if (words.length !== 12) {
          return { valid: false, error: 'Seed phrase must be 12 words' }
        }
        if (!bip39.validate(words)) {
          return { valid: false, error: 'Invalid seed phrase' }
        }
        _walletCache = new Map()
        set({ mnemonic: words.join(' ') })
        return { valid: true }
      },

      testMintConnection: async (url: string): Promise<MintConnectionTestStatus> => {
        set((s) => ({
          mintConnectionStatuses: { ...s.mintConnectionStatuses, [url]: 'connecting' },
        }))
        try {
          const res = await fetch(`${url}/v1/info`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [url]: 'connected' },
          }))
          return 'connected'
        } catch {
          set((s) => ({
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [url]: 'failed' },
          }))
          return 'failed'
        }
      },

      addMint: async (url: string) => {
        const mint = new CashuMint(url)
        const info = await mint.getInfo()
        const { keysets } = await mint.getKeySets()
        const keys = await mint.getKeys()

        const storedMint: StoredMint = {
          url,
          info: info as unknown as Record<string, unknown>,
          keysets,
          keys: keys.keysets[0],
        }

        set((s) => {
          const exists = s.mints.some((m) => m.url === url)
          return {
            mints: exists ? s.mints.map((m) => (m.url === url ? storedMint : m)) : [...s.mints, storedMint],
            activeMintUrl: url,
            mintConnectionStatuses: { ...s.mintConnectionStatuses, [url]: 'connected' },
          }
        })
      },

      removeMint: (url: string) => {
        const { mints } = get()
        if (mints.length <= 1) return
        set((s) => ({
          mints: s.mints.filter((m) => m.url !== url),
          activeMintUrl: s.activeMintUrl === url ? s.mints.find((m) => m.url !== url)!.url : s.activeMintUrl,
        }))
      },

      completeSetup: () => {
        set({ setupComplete: true })
      },

      getWallet: async (mintUrl?: string): Promise<CashuWallet> => {
        const url = mintUrl ?? get().activeMintUrl
        const cached = _walletCache.get(url)
        if (cached) return cached

        const seedBytes = getSeedBytes(get().mnemonic)
        const mint = new CashuMint(url)
        const wallet = new CashuWallet(mint, {
          unit: 'sat',
          ...(seedBytes ? { bip39seed: seedBytes } : {}),
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
      }),
    }
  )
)

export function useBalance(): number {
  // Reactive balance from proofs — placeholder for now, will be connected to Dexie liveQuery
  return 0
}

export async function getBalance(mintUrl?: string): Promise<number> {
  const proofs = await getProofs(mintUrl)
  return proofs.reduce((sum: number, p: StoredProof) => sum + p.amount, 0)
}
