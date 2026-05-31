import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  SettingsCategory,
  BaseCurrency,
  LanguageCode,
  ThemeOption,
  NostrSignerMode,
  NostrSignerSource,
  SecretBackupState,
  NostrProfile,
  NostrProfileFetchStatus,
  RelayConfig,
} from '@/types/settings'
import { defaultRelayConfigs } from '@/lib/relayDefaults'

const DEFAULT_RELAYS: RelayConfig[] = defaultRelayConfigs()

interface SettingsStoreState {
  activeCategory: SettingsCategory
  baseCurrency: BaseCurrency
  language: LanguageCode
  theme: ThemeOption
  nostrSignerMode: NostrSignerMode
  signerSource: NostrSignerSource
  signerBackupState: SecretBackupState
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

  /**
   * Opt-in for client-side Web Notifications when a bookmarked ("liked")
   * market closes (P22 Link G). Purely local — there is no server-stored push
   * subscription (that would leak the private bookmark set and require the
   * engine to hold authoritative per-user state — P08). When enabled, the app
   * fires an in-browser `Notification` on a detected open→closed transition.
   */
  likedMarketCloseNotifications: boolean

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
  setSignerSource: (source: NostrSignerSource) => void
  setSignerBackupState: (state: SecretBackupState) => void
  setProfile: (profile: NostrProfile | null, status: NostrProfileFetchStatus) => void
  setNsecSecret: (nsec: string | null) => void
  setLikedMarketCloseNotifications: (enabled: boolean) => void
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
      signerSource: 'none',
      signerBackupState: 'none',
      nostrProfile: null,
      nostrProfileFetchStatus: 'idle',
      relays: DEFAULT_RELAYS,
      nsecSecret: null,
      likedMarketCloseNotifications: false,

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
          signerSource:
            mode === 'none'
              ? 'none'
              : mode === 'nip07'
                ? 'nip07'
                : s.signerSource === 'implicit-generated'
                  ? 'implicit-generated'
                  : 'user-nsec',
          signerBackupState:
            mode === 'none'
              ? 'none'
              : mode === 'nip07'
                ? 'confirmed'
                : s.signerSource === 'implicit-generated'
                  ? s.signerBackupState
                  : 'confirmed',
          // Any mode other than 'nsec' must not carry a stray secret in
          // localStorage — switching to NIP-07 or disconnecting should wipe it.
          nsecSecret: mode === 'nsec' ? s.nsecSecret : null,
        })),
      setSignerSource: (source) => set({ signerSource: source }),
      setSignerBackupState: (state) => set({ signerBackupState: state }),
      setProfile: (profile, status) => set({ nostrProfile: profile, nostrProfileFetchStatus: status }),
      setNsecSecret: (nsec) => set({ nsecSecret: nsec }),
      setLikedMarketCloseNotifications: (enabled) =>
        set({ likedMarketCloseNotifications: enabled }),
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
        signerSource: state.signerSource,
        signerBackupState: state.signerBackupState,
        relays: state.relays,
        nostrProfile: state.nostrProfile,
        nostrProfileFetchStatus: state.nostrProfileFetchStatus,
        // Persist the decrypted nsec so the NDK signer can be rehydrated on
        // reload. Same localStorage surface as the BIP-39 mnemonic.
        nsecSecret: state.nsecSecret,
        likedMarketCloseNotifications: state.likedMarketCloseNotifications,
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
