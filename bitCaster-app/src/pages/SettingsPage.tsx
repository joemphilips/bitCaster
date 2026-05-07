import { useCallback, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router'
import { Settings } from '@/components/settings/Settings'
import { useWalletStore, DEFAULT_MINT_URL } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { useToastStore } from '@/stores/toast'
import { detectMintCapabilities } from '@/lib/mints'
import { userAddAndSelectMint, userAddRelay, userRemoveMint, userRemoveRelay } from '@/lib/walletOps'
import {
  loginWithExtension,
  loginWithNsecOrNcryptsec,
  fetchAndStoreNostrProfile,
} from '@/lib/nostr'
import type {
  SettingsState,
  MintConfig,
  NostrSignerMode,
  SettingsCategory,
  ThemeOption,
} from '@/types/settings'

const VALID_CATEGORIES: readonly SettingsCategory[] = ['general', 'cashu', 'nostr']

function isValidCategory(value: string | null): value is SettingsCategory {
  return value !== null && (VALID_CATEGORIES as readonly string[]).includes(value)
}

const APP_VERSION = '0.1.0'

export function SettingsPage() {
  const walletStore = useWalletStore()
  const settingsStore = useSettingsStore()
  const navigate = useNavigate()
  // Subscribe to the setter via a selector so we get the stable reference
  // zustand guarantees for actions — avoids re-running the deep-link effect
  // on every unrelated settings-store update.
  const openCategory = useSettingsStore((s) => s.openCategory)
  const [searchParams] = useSearchParams()

  // Allow other parts of the app (e.g. the market creation wizard) to
  // deep-link to a specific category via /settings?category=nostr. Use
  // `openCategory` (non-toggling) rather than `setActiveCategory`, because
  // StrictMode double-invokes effects and a toggle cancels itself.
  useEffect(() => {
    const categoryParam = searchParams.get('category')
    if (isValidCategory(categoryParam)) {
      openCategory(categoryParam)
    }
  }, [searchParams, openCategory])

  // Map wallet mints → MintConfig[]
  const mintConfigs: MintConfig[] = walletStore.mints.map((m) => {
    const info = m.info as Record<string, unknown> | undefined
    const { ctf } = detectMintCapabilities(info)
    return {
      url: m.url,
      name: info?.name as string | undefined,
      isDefault: m.url === DEFAULT_MINT_URL,
      connectionStatus:
        walletStore.mintConnectionStatuses[m.url] === 'connected'
          ? 'connected'
          : walletStore.mintConnectionStatuses[m.url] === 'failed'
            ? 'error'
            : 'disconnected',
      supportsCTF: ctf,
      addedDate: '',
    }
  })

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
      const status = await walletStore.testMintConnection(url)
      if (status === 'failed') {
        throw new Error('Failed to connect — mint is unreachable or invalid')
      }
      await userAddAndSelectMint(url)
    },
    [walletStore],
  )

  const handleMintClick = useCallback(
    (url: string) => {
      navigate(`/mint-details?mintUrl=${encodeURIComponent(url)}`)
    },
    [navigate],
  )

  const handleDisconnectNostr = useCallback(() => {
    // `setSignerMode('none')` also wipes `nsecSecret` (see settings store),
    // so no separate `setNsecSecret(null)` call is needed here.
    settingsStore.setSignerMode('none')
    settingsStore.setProfile(null, 'idle')
  }, [settingsStore])

  const handleRemoveMint = useCallback(
    (url: string) => {
      userRemoveMint(url)
    },
    [],
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
          fetchAndStoreNostrProfile()
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
    async (nsec: string, passphrase?: string): Promise<boolean> => {
      try {
        settingsStore.setSignerMode('nsec')
        const { nsec: decryptedNsec } = await loginWithNsecOrNcryptsec(nsec, passphrase)
        settingsStore.setNsecSecret(decryptedNsec)
        // Profile fetch is best-effort — don't block the success path on relay availability
        fetchAndStoreNostrProfile()
        useToastStore.getState().addToast({
          type: 'success',
          message: 'Connected with private key',
        })
        return true
      } catch (err) {
        // `setSignerMode('none')` also wipes any previously-stored nsec.
        settingsStore.setSignerMode('none')
        settingsStore.setProfile(null, 'not-found')
        const message =
          err instanceof Error && err.message.includes('passphrase')
            ? err.message
            : 'Invalid private key or connection failed'
        useToastStore.getState().addToast({
          type: 'error',
          message,
        })
        return false
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
      onThemeChange={handleThemeChange}
      onAddMint={handleAddMint}
      onRemoveMint={handleRemoveMint}
      onMintClick={handleMintClick}
      onSignerModeChange={handleSignerModeChange}
      onNsecSubmit={handleNsecSubmit}
      onDisconnectNostr={handleDisconnectNostr}
      onAddRelay={userAddRelay}
      onRemoveRelay={userRemoveRelay}
    />
  )
}
