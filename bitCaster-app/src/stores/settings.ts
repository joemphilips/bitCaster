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
  { url: 'wss://relay.nostr.band', connectionStatus: 'disconnected' },
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

  setActiveCategory: (category: SettingsCategory) => void
  setBaseCurrency: (currency: BaseCurrency) => void
  setLanguage: (language: LanguageCode) => void
  setTheme: (theme: ThemeOption) => void
  setSignerMode: (mode: NostrSignerMode) => void
  setProfile: (profile: NostrProfile | null, status: NostrProfileFetchStatus) => void
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
      activeCategory: 'general',
      baseCurrency: 'BTC',
      language: 'en',
      theme: 'dark',
      nostrSignerMode: 'none',
      nostrProfile: null,
      nostrProfileFetchStatus: 'idle',
      relays: DEFAULT_RELAYS,

      setActiveCategory: (category) => set({ activeCategory: category }),
      setBaseCurrency: (currency) => set({ baseCurrency: currency }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
      setSignerMode: (mode) => set({ nostrSignerMode: mode }),
      setProfile: (profile, status) => set({ nostrProfile: profile, nostrProfileFetchStatus: status }),
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
