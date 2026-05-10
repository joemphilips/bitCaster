import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let hydrationCallback: (() => void) | null = null
  const settingsState = {
    nostrSignerMode: 'none' as 'none' | 'nsec' | 'nip07',
    nsecSecret: null as string | null,
    setSignerMode: vi.fn((mode: 'none' | 'nsec' | 'nip07') => {
      settingsState.nostrSignerMode = mode
      if (mode !== 'nsec') settingsState.nsecSecret = null
    }),
    setNsecSecret: vi.fn((nsec: string | null) => {
      settingsState.nsecSecret = nsec
    }),
    setProfile: vi.fn(),
  }
  return {
    settingsState,
    persist: {
      hydrated: true,
      hasHydrated: vi.fn(() => true),
      onFinishHydration: vi.fn((cb: () => void) => {
        hydrationCallback = cb
        return vi.fn()
      }),
      triggerHydration: () => hydrationCallback?.(),
    },
    rehydrateNostrSigner: vi.fn().mockResolvedValue(undefined),
    fetchAndStoreNostrProfile: vi.fn().mockResolvedValue(undefined),
    loginWithExtension: vi.fn().mockResolvedValue({}),
    loginWithNsecOrNcryptsec: vi.fn().mockResolvedValue({ signer: {}, nsec: 'nsec1decrypted' }),
  }
})

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => mocks.settingsState,
    persist: mocks.persist,
  },
}))

vi.mock('../nostr', () => ({
  rehydrateNostrSigner: mocks.rehydrateNostrSigner,
  fetchAndStoreNostrProfile: mocks.fetchAndStoreNostrProfile,
  loginWithExtension: mocks.loginWithExtension,
  loginWithNsecOrNcryptsec: mocks.loginWithNsecOrNcryptsec,
}))

describe('identityOps', () => {
  let identityOps: typeof import('../identityOps')

  beforeEach(async () => {
    vi.resetModules()
    mocks.settingsState.nostrSignerMode = 'none'
    mocks.settingsState.nsecSecret = null
    mocks.persist.hydrated = true
    mocks.persist.hasHydrated.mockImplementation(() => mocks.persist.hydrated)
    mocks.persist.onFinishHydration.mockClear()
    mocks.rehydrateNostrSigner.mockClear()
    mocks.fetchAndStoreNostrProfile.mockClear()
    mocks.loginWithExtension.mockClear()
    mocks.loginWithNsecOrNcryptsec.mockClear()
    vi.mocked(mocks.settingsState.setSignerMode).mockClear()
    vi.mocked(mocks.settingsState.setNsecSecret).mockClear()
    vi.mocked(mocks.settingsState.setProfile).mockClear()
    identityOps = await import('../identityOps')
  })

  it('rehydrates immediately when settings persist has already hydrated', async () => {
    await identityOps.rehydratePersistedNostrIdentity()

    expect(mocks.rehydrateNostrSigner).toHaveBeenCalledOnce()
    expect(mocks.persist.onFinishHydration).not.toHaveBeenCalled()
  })

  it('waits for settings hydration before rehydrating the signer', async () => {
    mocks.persist.hydrated = false
    const promise = identityOps.rehydratePersistedNostrIdentity()

    expect(mocks.rehydrateNostrSigner).not.toHaveBeenCalled()
    expect(mocks.persist.onFinishHydration).toHaveBeenCalledOnce()

    mocks.persist.triggerHydration()
    await promise

    expect(mocks.rehydrateNostrSigner).toHaveBeenCalledOnce()
  })

  it('connects NIP-07 through one identity operation and refreshes profile best-effort', async () => {
    const result = await identityOps.userConnectNostrSignerMode('nip07')

    expect(result).toEqual({ ok: true })
    expect(mocks.settingsState.setSignerMode).toHaveBeenCalledWith('nip07')
    expect(mocks.loginWithExtension).toHaveBeenCalledOnce()
    expect(mocks.fetchAndStoreNostrProfile).toHaveBeenCalledOnce()
  })

  it('persists decrypted nsec and refreshes profile on nsec connect', async () => {
    const result = await identityOps.userConnectNsecIdentity('ncryptsec1cipher', 'pw')

    expect(result).toEqual({ ok: true })
    expect(mocks.settingsState.setSignerMode).toHaveBeenCalledWith('nsec')
    expect(mocks.loginWithNsecOrNcryptsec).toHaveBeenCalledWith('ncryptsec1cipher', 'pw')
    expect(mocks.settingsState.setNsecSecret).toHaveBeenCalledWith('nsec1decrypted')
    expect(mocks.fetchAndStoreNostrProfile).toHaveBeenCalledOnce()
  })

  it('resets signer state on invalid nsec input', async () => {
    mocks.loginWithNsecOrNcryptsec.mockRejectedValueOnce(new Error('bad key'))

    const result = await identityOps.userConnectNsecIdentity('bad')

    expect(result).toEqual({ ok: false, error: 'Invalid private key or connection failed' })
    expect(mocks.settingsState.setSignerMode).toHaveBeenLastCalledWith('none')
    expect(mocks.settingsState.setProfile).toHaveBeenCalledWith(null, 'not-found')
  })

  it('disconnects the Nostr identity without requiring Settings page store logic', () => {
    identityOps.disconnectNostrIdentity()

    expect(mocks.settingsState.setSignerMode).toHaveBeenCalledWith('none')
    expect(mocks.settingsState.setProfile).toHaveBeenCalledWith(null, 'idle')
  })
})
