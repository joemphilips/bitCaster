import { useCallback } from 'react'
import { Settings } from '@/components/settings/Settings'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { loginWithExtension, loginWithNsec, getNdk } from '@/lib/nostr'
import type {
  SettingsState,
  MintConfig,
  NostrSignerMode,
  ThemeOption,
} from '@/types/settings'

const DEFAULT_MINT_URL = import.meta.env.VITE_MINT_URL ?? 'http://localhost:8085'
const APP_VERSION = '0.1.0'

async function fetchNostrProfile(
  setProfile: typeof useSettingsStore.getState extends () => infer S
    ? S extends { setProfile: infer F } ? F : never
    : never,
) {
  setProfile(null, 'fetching')
  try {
    const ndk = getNdk()
    const signer = ndk.signer
    if (!signer) {
      setProfile(null, 'not-found')
      return
    }
    const user = await signer.user()
    await user.fetchProfile()
    const profile = user.profile
    if (profile) {
      setProfile(
        {
          pubkey: user.pubkey,
          displayName: profile.displayName ?? profile.name ?? user.pubkey.slice(0, 8),
          avatar: profile.image ?? '',
          nip05: profile.nip05 ?? '',
          nip05verified: !!profile.nip05,
          bio: profile.bio ?? profile.about ?? '',
        },
        'found',
      )
    } else {
      setProfile(null, 'not-found')
    }
  } catch {
    setProfile(null, 'not-found')
  }
}

export function SettingsPage() {
  const walletStore = useWalletStore()
  const settingsStore = useSettingsStore()

  // Map wallet mints → MintConfig[]
  const mintConfigs: MintConfig[] = walletStore.mints.map((m) => ({
    url: m.url,
    isDefault: m.url === DEFAULT_MINT_URL,
    connectionStatus:
      walletStore.mintConnectionStatuses[m.url] === 'connected'
        ? 'connected'
        : walletStore.mintConnectionStatuses[m.url] === 'failed'
          ? 'error'
          : 'disconnected',
    addedDate: '',
  }))

  const settingsState: SettingsState = {
    general: {
      baseCurrency: settingsStore.baseCurrency,
      language: settingsStore.language,
      theme: settingsStore.theme,
      appVersion: APP_VERSION,
    },
    cashu: {
      mints: mintConfigs,
    },
    nostr: {
      signerMode: settingsStore.nostrSignerMode,
      profile: settingsStore.nostrProfile,
      profileFetchStatus: settingsStore.nostrProfileFetchStatus,
      relays: settingsStore.relays,
    },
    oracle: {
      comingSoon: true,
    },
  }

  const handleAddMint = useCallback(
    async (url: string) => {
      await walletStore.testMintConnection(url)
      await walletStore.addMint(url)
    },
    [walletStore],
  )

  const handleRemoveMint = useCallback(
    (url: string) => {
      walletStore.removeMint(url)
    },
    [walletStore],
  )

  const handleThemeChange = useCallback(
    (theme: ThemeOption) => {
      settingsStore.setTheme(theme)
    },
    [settingsStore],
  )

  const handleSignerModeChange = useCallback(
    async (mode: NostrSignerMode) => {
      settingsStore.setSignerMode(mode)
      if (mode === 'nip07') {
        try {
          await loginWithExtension()
          await fetchNostrProfile(settingsStore.setProfile)
        } catch {
          settingsStore.setProfile(null, 'not-found')
        }
      } else if (mode === 'none') {
        settingsStore.setProfile(null, 'idle')
      }
    },
    [settingsStore],
  )

  const handleNsecSubmit = useCallback(
    async (nsec: string) => {
      try {
        await loginWithNsec(nsec)
        await fetchNostrProfile(settingsStore.setProfile)
      } catch {
        settingsStore.setProfile(null, 'not-found')
      }
    },
    [settingsStore],
  )

  return (
    <Settings
      activeCategory={settingsStore.activeCategory}
      settings={settingsState}
      seedPhrase={walletStore.mnemonic}
      onCategoryToggle={settingsStore.setActiveCategory}
      onBaseCurrencyChange={settingsStore.setBaseCurrency}
      onLanguageChange={settingsStore.setLanguage}
      onThemeChange={handleThemeChange}
      onAddMint={handleAddMint}
      onRemoveMint={handleRemoveMint}
      onSignerModeChange={handleSignerModeChange}
      onNsecSubmit={handleNsecSubmit}
      onAddRelay={settingsStore.addRelay}
      onRemoveRelay={settingsStore.removeRelay}
    />
  )
}
