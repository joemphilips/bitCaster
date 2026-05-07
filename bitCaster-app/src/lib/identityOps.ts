import { useSettingsStore } from '@/stores/settings'
import type { NostrSignerMode } from '@/types/settings'
import {
  fetchAndStoreNostrProfile,
  loginWithExtension,
  loginWithNsecOrNcryptsec,
  rehydrateNostrSigner,
} from '@/lib/nostr'

export interface IdentityActionResult {
  ok: boolean
  error?: string
}

let rehydratePromise: Promise<void> | null = null

function waitForSettingsHydration(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe()
      resolve()
    })
  })
}

export function rehydratePersistedNostrIdentity(): Promise<void> {
  rehydratePromise ??= waitForSettingsHydration().then(() => rehydrateNostrSigner())
  return rehydratePromise
}

export function disconnectNostrIdentity(): void {
  const settings = useSettingsStore.getState()
  settings.setSignerMode('none')
  settings.setProfile(null, 'idle')
}

export async function refreshNostrProfile(): Promise<void> {
  await fetchAndStoreNostrProfile()
}

export async function userConnectNostrSignerMode(
  mode: NostrSignerMode,
): Promise<IdentityActionResult> {
  const settings = useSettingsStore.getState()
  settings.setSignerMode(mode)
  if (mode === 'nip07') {
    try {
      await loginWithExtension()
      refreshNostrProfile().catch(() => {})
      return { ok: true }
    } catch {
      settings.setProfile(null, 'not-found')
      return { ok: false, error: 'Failed to connect with NIP-07 extension' }
    }
  }
  if (mode === 'none') {
    settings.setProfile(null, 'idle')
  }
  return { ok: true }
}

export async function userConnectNsecIdentity(
  nsec: string,
  passphrase?: string,
): Promise<IdentityActionResult> {
  const settings = useSettingsStore.getState()
  try {
    settings.setSignerMode('nsec')
    const { nsec: decryptedNsec } = await loginWithNsecOrNcryptsec(nsec, passphrase)
    settings.setNsecSecret(decryptedNsec)
    refreshNostrProfile().catch(() => {})
    return { ok: true }
  } catch (err) {
    settings.setSignerMode('none')
    settings.setProfile(null, 'not-found')
    const error =
      err instanceof Error && err.message.includes('passphrase')
        ? err.message
        : 'Invalid private key or connection failed'
    return { ok: false, error }
  }
}
