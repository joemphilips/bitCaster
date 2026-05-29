import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let hydrationCallback: (() => void) | null = null
  const settingsState = {
    nostrSignerMode: 'none' as 'none' | 'nsec' | 'nip07',
    signerSource: 'none' as 'none' | 'implicit-generated' | 'user-nsec' | 'nip07',
    signerBackupState: 'none' as 'none' | 'needs_backup' | 'confirmed',
    nsecSecret: null as string | null,
    setSignerMode: vi.fn((mode: 'none' | 'nsec' | 'nip07') => {
      settingsState.nostrSignerMode = mode
      if (mode !== 'nsec') settingsState.nsecSecret = null
    }),
    setSignerSource: vi.fn((source: 'none' | 'implicit-generated' | 'user-nsec' | 'nip07') => {
      settingsState.signerSource = source
    }),
    setSignerBackupState: vi.fn((state: 'none' | 'needs_backup' | 'confirmed') => {
      settingsState.signerBackupState = state
    }),
    setNsecSecret: vi.fn((nsec: string | null) => {
      settingsState.nsecSecret = nsec
    }),
    setProfile: vi.fn(),
  }
  const walletState = {
    ensureImplicitWallet: vi.fn().mockResolvedValue(undefined),
  }
  return {
    settingsState,
    walletState,
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
    loginWithNsec: vi.fn().mockResolvedValue({}),
    loginWithNsecOrNcryptsec: vi.fn().mockResolvedValue({ signer: {}, nsec: 'nsec1decrypted' }),
    generateSecretKey: vi.fn(() => new Uint8Array(32).fill(7)),
    nsecEncode: vi.fn(() => 'nsec1generated'),
  }
})

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => mocks.settingsState,
    persist: mocks.persist,
  },
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => mocks.walletState,
  },
}))

vi.mock('../nostr', () => ({
  rehydrateNostrSigner: mocks.rehydrateNostrSigner,
  fetchAndStoreNostrProfile: mocks.fetchAndStoreNostrProfile,
  loginWithExtension: mocks.loginWithExtension,
  loginWithNsec: mocks.loginWithNsec,
  loginWithNsecOrNcryptsec: mocks.loginWithNsecOrNcryptsec,
}))

vi.mock('nostr-tools', () => ({
  generateSecretKey: mocks.generateSecretKey,
  nip19: {
    nsecEncode: mocks.nsecEncode,
  },
}))

describe('identityOps', () => {
  let identityOps: typeof import('../identityOps')

  beforeEach(async () => {
    vi.resetModules()
    mocks.settingsState.nostrSignerMode = 'none'
    mocks.settingsState.signerSource = 'none'
    mocks.settingsState.signerBackupState = 'none'
    mocks.settingsState.nsecSecret = null
    mocks.persist.hydrated = true
    mocks.persist.hasHydrated.mockImplementation(() => mocks.persist.hydrated)
    mocks.persist.onFinishHydration.mockClear()
    mocks.rehydrateNostrSigner.mockClear()
    mocks.fetchAndStoreNostrProfile.mockClear()
    mocks.loginWithExtension.mockClear()
    mocks.loginWithNsec.mockClear()
    mocks.loginWithNsecOrNcryptsec.mockClear()
    mocks.walletState.ensureImplicitWallet.mockClear()
    mocks.generateSecretKey.mockClear()
    mocks.nsecEncode.mockClear()
    vi.mocked(mocks.settingsState.setSignerMode).mockClear()
    vi.mocked(mocks.settingsState.setSignerSource).mockClear()
    vi.mocked(mocks.settingsState.setSignerBackupState).mockClear()
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
    expect(mocks.settingsState.setSignerSource).toHaveBeenCalledWith('nip07')
    expect(mocks.settingsState.setSignerBackupState).toHaveBeenCalledWith('confirmed')
    expect(mocks.fetchAndStoreNostrProfile).toHaveBeenCalledOnce()
  })

  it('persists decrypted nsec and refreshes profile on nsec connect', async () => {
    const result = await identityOps.userConnectNsecIdentity('ncryptsec1cipher', 'pw')

    expect(result).toEqual({ ok: true })
    expect(mocks.settingsState.setSignerMode).toHaveBeenCalledWith('nsec')
    expect(mocks.loginWithNsecOrNcryptsec).toHaveBeenCalledWith('ncryptsec1cipher', 'pw')
    expect(mocks.settingsState.setNsecSecret).toHaveBeenCalledWith('nsec1decrypted')
    expect(mocks.settingsState.setSignerSource).toHaveBeenCalledWith('user-nsec')
    expect(mocks.settingsState.setSignerBackupState).toHaveBeenCalledWith('confirmed')
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
    expect(mocks.settingsState.setSignerSource).toHaveBeenCalledWith('none')
    expect(mocks.settingsState.setSignerBackupState).toHaveBeenCalledWith('none')
    expect(mocks.settingsState.setProfile).toHaveBeenCalledWith(null, 'idle')
  })

  it('creates an implicit wallet and generated nsec when no signer exists', async () => {
    const result = await identityOps.createImplicitWalletAndNostrIdentity()

    expect(result).toEqual({ ok: true })
    expect(mocks.walletState.ensureImplicitWallet).toHaveBeenCalledOnce()
    expect(mocks.generateSecretKey).toHaveBeenCalledOnce()
    expect(mocks.nsecEncode).toHaveBeenCalledWith(new Uint8Array(32).fill(7))
    expect(mocks.loginWithNsec).toHaveBeenCalledWith('nsec1generated')
    expect(mocks.settingsState.setSignerMode).toHaveBeenCalledWith('nsec')
    expect(mocks.settingsState.setNsecSecret).toHaveBeenCalledWith('nsec1generated')
    expect(mocks.settingsState.setSignerSource).toHaveBeenCalledWith('implicit-generated')
    expect(mocks.settingsState.setSignerBackupState).toHaveBeenCalledWith('needs_backup')
  })

  it('does not overwrite an existing NIP-07 signer during implicit wallet setup', async () => {
    mocks.settingsState.nostrSignerMode = 'nip07'
    mocks.settingsState.signerSource = 'nip07'

    const result = await identityOps.createImplicitWalletAndNostrIdentity()

    expect(result).toEqual({ ok: true })
    expect(mocks.walletState.ensureImplicitWallet).toHaveBeenCalledOnce()
    expect(mocks.generateSecretKey).not.toHaveBeenCalled()
    expect(mocks.loginWithNsec).not.toHaveBeenCalled()
    expect(mocks.settingsState.setNsecSecret).not.toHaveBeenCalled()
  })

  it('does not overwrite an existing user-provided nsec signer during implicit wallet setup', async () => {
    mocks.settingsState.nostrSignerMode = 'nsec'
    mocks.settingsState.signerSource = 'user-nsec'
    mocks.settingsState.nsecSecret = 'nsec1user'

    const result = await identityOps.createImplicitWalletAndNostrIdentity()

    expect(result).toEqual({ ok: true })
    expect(mocks.walletState.ensureImplicitWallet).toHaveBeenCalledOnce()
    expect(mocks.generateSecretKey).not.toHaveBeenCalled()
    expect(mocks.loginWithNsec).not.toHaveBeenCalled()
    expect(mocks.settingsState.nsecSecret).toBe('nsec1user')
  })
})
