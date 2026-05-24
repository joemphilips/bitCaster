import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted state lets `vi.mock` factories close over live references.
const mocks = vi.hoisted(() => {
  const settingsState: {
    nostrSignerMode: 'none' | 'nsec' | 'nip07'
    nsecSecret: string | null
    nostrProfile: { pubkey: string; displayName: string; avatar: string; nip05: string; nip05verified: boolean; bio: string } | null
    relays: { url: string }[]
    setProfile: (profile: unknown, status: string) => void
    setSignerMode: (mode: 'none' | 'nsec' | 'nip07') => void
  } = {
    nostrSignerMode: 'none',
    nsecSecret: null,
    nostrProfile: null,
    relays: [{ url: 'wss://relay.damus.io' }],
    setProfile: vi.fn((profile, _status) => {
      settingsState.nostrProfile = profile as typeof settingsState.nostrProfile
    }),
    setSignerMode: vi.fn(),
  }
  return {
    settingsState,
    privateKeySignerCtor: vi.fn(),
    nip07SignerCtor: vi.fn(),
    setPendingKormirNsecSpy: vi.fn(),
  }
})

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => mocks.settingsState,
  },
}))

vi.mock('@nostr-dev-kit/ndk', () => {
  // Minimal NDK stub — the rehydrate path touches `signer`, `pool`, and
  // `addExplicitRelay` (via getNdk). Keep it tiny.
  class FakeNDK {
    signer: unknown = null
    pool = { relays: new Map<string, unknown>() }
    addExplicitRelay = vi.fn((_url: string) => ({}))
    connect = vi.fn(() => Promise.resolve())
    constructor(_opts: unknown) {}
  }
  class FakeNDKPrivateKeySigner {
    constructor(nsec: string) {
      mocks.privateKeySignerCtor(nsec)
    }
    user = () => Promise.resolve({ pubkey: 'pk', profile: null, fetchProfile: () => Promise.resolve() })
  }
  class FakeNDKNip07Signer {
    constructor() {
      mocks.nip07SignerCtor()
    }
    user = () => Promise.resolve({ pubkey: 'pk', profile: null, fetchProfile: () => Promise.resolve() })
  }
  return {
    default: FakeNDK,
    NDKNip07Signer: FakeNDKNip07Signer,
    NDKPrivateKeySigner: FakeNDKPrivateKeySigner,
  }
})

vi.mock('@nostr-dev-kit/ndk-wallet', () => ({
  NDKNWCWallet: class {},
}))

vi.mock('../kormir', () => ({
  setPendingKormirNsec: mocks.setPendingKormirNsecSpy,
}))

describe('rehydrateNostrSigner', () => {
  let nostrModule: typeof import('../nostr')

  beforeEach(async () => {
    vi.resetModules()
    mocks.settingsState.nostrSignerMode = 'none'
    mocks.settingsState.nsecSecret = null
    mocks.settingsState.nostrProfile = null
    vi.mocked(mocks.settingsState.setProfile).mockClear()
    vi.mocked(mocks.settingsState.setSignerMode).mockClear()
    mocks.privateKeySignerCtor.mockClear()
    mocks.nip07SignerCtor.mockClear()
    mocks.setPendingKormirNsecSpy.mockClear()
    nostrModule = await import('../nostr')
  })

  it('no-ops when signer mode is "none"', async () => {
    await nostrModule.rehydrateNostrSigner()
    expect(mocks.privateKeySignerCtor).not.toHaveBeenCalled()
  })

  it('no-ops when nsecSecret is null even in nsec mode', async () => {
    mocks.settingsState.nostrSignerMode = 'nsec'
    mocks.settingsState.nsecSecret = null
    await nostrModule.rehydrateNostrSigner()
    expect(mocks.privateKeySignerCtor).not.toHaveBeenCalled()
  })

  it('installs the signer when persisted nsec is present', async () => {
    mocks.settingsState.nostrSignerMode = 'nsec'
    mocks.settingsState.nsecSecret = 'nsec1example'
    await nostrModule.rehydrateNostrSigner()
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledTimes(1)
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledWith('nsec1example')
  })

  it('reinstalls the extension signer when persisted mode is nip07', async () => {
    mocks.settingsState.nostrSignerMode = 'nip07'
    await nostrModule.rehydrateNostrSigner()
    expect(mocks.nip07SignerCtor).toHaveBeenCalledTimes(1)
    expect(mocks.settingsState.setSignerMode).not.toHaveBeenCalled()
  })

  it('is idempotent for the same nsec — second call does not reinstall', async () => {
    mocks.settingsState.nostrSignerMode = 'nsec'
    mocks.settingsState.nsecSecret = 'nsec1stable'
    await nostrModule.rehydrateNostrSigner()
    await nostrModule.rehydrateNostrSigner()
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledTimes(1)
  })

  it('reinstalls when the persisted nsec changes between calls', async () => {
    mocks.settingsState.nostrSignerMode = 'nsec'
    mocks.settingsState.nsecSecret = 'nsec1first'
    await nostrModule.rehydrateNostrSigner()
    mocks.settingsState.nsecSecret = 'nsec1second'
    await nostrModule.rehydrateNostrSigner()
    expect(mocks.privateKeySignerCtor).toHaveBeenCalledTimes(2)
    expect(mocks.privateKeySignerCtor).toHaveBeenLastCalledWith('nsec1second')
  })
})

describe('fetchAndStoreNostrProfile', () => {
  let nostrModule: typeof import('../nostr')

  beforeEach(async () => {
    vi.resetModules()
    mocks.settingsState.relays = [{ url: 'wss://relay.damus.io' }]
    mocks.settingsState.nostrProfile = null
    vi.mocked(mocks.settingsState.setProfile).mockClear()
    nostrModule = await import('../nostr')
  })

  it('keeps a cached matching profile when relays return no fresh kind:0', async () => {
    const cached = {
      pubkey: 'pk',
      displayName: 'Cached User',
      avatar: 'https://example.com/a.png',
      nip05: '',
      nip05verified: false,
      bio: '',
    }
    mocks.settingsState.nostrProfile = cached
    ;(nostrModule.getNdk() as unknown as {
      signer: unknown
    }).signer = {
      user: () => Promise.resolve({
        pubkey: 'pk',
        profile: null,
        fetchProfile: () => Promise.resolve(),
      }),
    }

    await nostrModule.fetchAndStoreNostrProfile()

    expect(mocks.settingsState.setProfile).toHaveBeenLastCalledWith(cached, 'found')
  })
})

describe('getNdk relay reconciliation', () => {
  let nostrModule: typeof import('../nostr')

  beforeEach(async () => {
    vi.resetModules()
    mocks.settingsState.relays = [{ url: 'wss://relay.damus.io' }]
    nostrModule = await import('../nostr')
  })

  it('merges user-configured relays with DEFAULT_RELAYS on first construction', () => {
    mocks.settingsState.relays = [
      { url: 'wss://relay.damus.io' }, // dedup vs DEFAULT_RELAYS
      { url: 'wss://relay.user.example' }, // unique to the user
    ]
    const ndk = nostrModule.getNdk() as unknown as {
      addExplicitRelay: (url: string) => unknown
      pool: { relays: Map<string, unknown> }
    }
    // First call seeds the pool via the constructor; addExplicitRelay
    // shouldn't fire for the seeded URLs.
    expect(ndk.addExplicitRelay).not.toHaveBeenCalled()
  })

  it('keeps search-only relays out of production defaults', () => {
    expect(nostrModule.DEFAULT_RELAYS).not.toContain('wss://relay.nostr.band')
  })

  it('reconciles new user relays added between calls without duplicating', () => {
    const ndk = nostrModule.getNdk() as unknown as {
      addExplicitRelay: ReturnType<typeof vi.fn>
      pool: { relays: Map<string, unknown> }
    }
    // Simulate the FakeNDK pool being seeded on construction.
    for (const url of nostrModule.DEFAULT_RELAYS) ndk.pool.relays.set(url, {})
    ndk.pool.relays.set('wss://relay.damus.io', {})
    // User adds a new relay after first getNdk().
    mocks.settingsState.relays = [
      { url: 'wss://relay.damus.io' },
      { url: 'wss://relay.newly-added.example' },
    ]
    nostrModule.getNdk()
    expect(ndk.addExplicitRelay).toHaveBeenCalledWith(
      'wss://relay.newly-added.example',
      undefined,
      true,
    )
    // Calling again with no further changes must NOT walk the pool again.
    ndk.pool.relays.set('wss://relay.newly-added.example', {})
    ndk.addExplicitRelay.mockClear()
    nostrModule.getNdk()
    expect(ndk.addExplicitRelay).not.toHaveBeenCalled()
  })
})
