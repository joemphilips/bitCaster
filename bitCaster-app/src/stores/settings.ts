import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  SettingsCategory,
  BaseCurrency,
  LanguageCode,
  ThemeOption,
  NostrSignerMode,
  NostrProfile,
  NostrProfileFetchStatus,
  RelayConfig,
} from '@/types/settings'

const DEFAULT_RELAYS: RelayConfig[] = [
  { url: 'wss://relay.damus.io', connectionStatus: 'disconnected' },
  { url: 'wss://nos.lol', connectionStatus: 'disconnected' },
  { url: 'wss://relay.primal.net', connectionStatus: 'disconnected' },
  { url: 'wss://nostr.bitcoiner.social', connectionStatus: 'disconnected' },
]

interface SettingsStoreState {
  activeCategory: SettingsCategory
  baseCurrency: BaseCurrency
  language: LanguageCode
  theme: ThemeOption
  nostrSignerMode: NostrSignerMode
  nostrProfile: NostrProfile | null
  nostrProfileFetchStatus: NostrProfileFetchStatus
  relays: RelayConfig[]
  /**
   * The user's Nostr private key, stored as bech32 `nsec1...` (or raw hex).
   * Persisted to localStorage alongside the BIP-39 mnemonic — same threat
   * model (origin-scoped, XSS-exposed). Needed so the NDK signer can be
   * re-installed on page reload without prompting the user every time.
   * `null` when the user has not configured nsec login.
   */
  nsecSecret: string | null

  setActiveCategory: (category: SettingsCategory) => void
  /**
   * Deep-link setter — always opens the given category (no toggle).
   * `setActiveCategory` is wired to the tab UI and toggles the category
   * closed when clicked while already open, which fights StrictMode's
   * double-invoked `useEffect` when we deep-link to `?category=nostr`.
   */
  openCategory: (category: SettingsCategory) => void
  setBaseCurrency: (currency: BaseCurrency) => void
  setLanguage: (language: LanguageCode) => void
  setTheme: (theme: ThemeOption) => void
  setSignerMode: (mode: NostrSignerMode) => void
  setProfile: (profile: NostrProfile | null, status: NostrProfileFetchStatus) => void
  setNsecSecret: (nsec: string | null) => void
  addRelay: (url: string) => void
  removeRelay: (url: string) => void
}

/** Apply theme class to `<html>` element. */
export function applyTheme(theme: ThemeOption) {
  const html = document.documentElement
  if (theme === 'dark') {
    html.classList.add('dark')
  } else if (theme === 'light') {
    html.classList.remove('dark')
  } else {
    // system
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    if (prefersDark) {
      html.classList.add('dark')
    } else {
      html.classList.remove('dark')
    }
  }
}

export const useSettingsStore = create<SettingsStoreState>()(
  persist(
    (set) => ({
      activeCategory: 'general' as SettingsCategory,
      baseCurrency: 'BTC',
      language: 'en',
      theme: 'dark',
      nostrSignerMode: 'none',
      nostrProfile: null,
      nostrProfileFetchStatus: 'idle',
      relays: DEFAULT_RELAYS,
      nsecSecret: null,

      setActiveCategory: (category) => set((s) => ({
        activeCategory: s.activeCategory === category ? null : category,
      })),
      openCategory: (category) => set({ activeCategory: category }),
      setBaseCurrency: (currency) => set({ baseCurrency: currency }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
      setSignerMode: (mode) =>
        set((s) => ({
          nostrSignerMode: mode,
          // Any mode other than 'nsec' must not carry a stray secret in
          // localStorage — switching to NIP-07 or disconnecting should wipe it.
          nsecSecret: mode === 'nsec' ? s.nsecSecret : null,
        })),
      setProfile: (profile, status) => set({ nostrProfile: profile, nostrProfileFetchStatus: status }),
      setNsecSecret: (nsec) => set({ nsecSecret: nsec }),
      addRelay: (url) =>
        set((s) => {
          if (s.relays.some((r) => r.url === url)) return s
          return { relays: [...s.relays, { url, connectionStatus: 'disconnected' as const }] }
        }),
      removeRelay: (url) =>
        set((s) => ({ relays: s.relays.filter((r) => r.url !== url) })),
    }),
    {
      name: 'bitcaster-settings',
      partialize: (state) => ({
        baseCurrency: state.baseCurrency,
        language: state.language,
        theme: state.theme,
        nostrSignerMode: state.nostrSignerMode,
        relays: state.relays,
        nostrProfile: state.nostrProfile,
        nostrProfileFetchStatus: state.nostrProfileFetchStatus,
        // Persist the decrypted nsec so the NDK signer can be rehydrated on
        // reload. Same localStorage surface as the BIP-39 mnemonic.
        nsecSecret: state.nsecSecret,
      }),
      onRehydrateStorage: () => {
        return (state: SettingsStoreState | undefined) => {
          if (state) {
            applyTheme(state.theme)
          }
        }
      },
    }
  )
)
