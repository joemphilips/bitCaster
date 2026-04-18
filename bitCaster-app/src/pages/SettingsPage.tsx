import { useCallback, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router'
import { Settings } from '@/components/settings/Settings'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { loginWithExtension, loginWithNsec, getNdk } from '@/lib/nostr'
import type {
  SettingsState,
  MintConfig,
  NostrProfile,
  NostrProfileFetchStatus,
  NostrSignerMode,
  SettingsCategory,
  ThemeOption,
} from '@/types/settings'

type SetProfileFn = (
  profile: NostrProfile | null,
  status: NostrProfileFetchStatus,
) => void

const VALID_CATEGORIES: readonly SettingsCategory[] = ['general', 'cashu', 'nostr']

function isValidCategory(value: string | null): value is SettingsCategory {
  return value !== null && (VALID_CATEGORIES as readonly string[]).includes(value)
}

const DEFAULT_MINT_URL = import.meta.env.VITE_MINT_URL ?? 'http://localhost:8085'
const APP_VERSION = '0.1.0'

async function fetchNostrProfile(setProfile: SetProfileFn) {
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
  const navigate = useNavigate()
  // Subscribe to the setter via a selector so we get the stable reference
  // zustand guarantees for actions — avoids re-running the deep-link effect
  // on every unrelated settings-store update.
  const setActiveCategory = useSettingsStore((s) => s.setActiveCategory)
  const [searchParams] = useSearchParams()

  // Allow other parts of the app (e.g. the market creation wizard) to
  // deep-link to a specific category via /settings?category=nostr.
  useEffect(() => {
    const categoryParam = searchParams.get('category')
    if (isValidCategory(categoryParam)) {
      setActiveCategory(categoryParam)
    }
  }, [searchParams, setActiveCategory])

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
    async (mode: NostrSignerMode): Promise<boolean> => {
      settingsStore.setSignerMode(mode)
      if (mode === 'nip07') {
        try {
          await loginWithExtension()
          await fetchNostrProfile(settingsStore.setProfile)
          return true
        } catch {
          settingsStore.setProfile(null, 'not-found')
          useToastStore.getState().addToast({
            type: 'error',
            message: 'Failed to connect with NIP-07 extension',
          })
          return false
        }
      } else if (mode === 'none') {
        settingsStore.setProfile(null, 'idle')
      }
      return true
    },
    [settingsStore],
  )

  const handleNsecSubmit = useCallback(
    async (nsec: string): Promise<boolean> => {
      try {
        settingsStore.setSignerMode('nsec')
        await loginWithNsec(nsec)
        await fetchNostrProfile(settingsStore.setProfile)
        useToastStore.getState().addToast({
          type: 'success',
          message: 'Connected with private key',
        })
        navigate(-1)
        return true
      } catch {
        settingsStore.setSignerMode('none')
        settingsStore.setProfile(null, 'not-found')
        useToastStore.getState().addToast({
          type: 'error',
          message: 'Invalid private key or connection failed',
        })
        return false
      }
    },
    [settingsStore, navigate],
  )

  return (
    <Settings
      activeCategory={settingsStore.activeCategory}
      settings={settingsState}
      seedPhrase={walletStore.mnemonic}
      onCategoryToggle={settingsStore.setActiveCategory}
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
