import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { useSettingsStore } from '@/stores/settings'
import { useMarketDraftStore, defaultDraft } from '@/stores/marketDraft'

const {
  mockNavigate,
  mockRegisterConditionWithFee,
  mockGetAvailableRegularBalanceSats,
  mockCreateMarket,
  mockCreateEnumAnnouncement,
  mockWalletState,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRegisterConditionWithFee: vi.fn(),
  mockGetAvailableRegularBalanceSats: vi.fn(),
  mockCreateMarket: vi.fn(),
  mockCreateEnumAnnouncement: vi.fn(),
  mockWalletState: {
    activeMintUrl: 'https://mint.example.test',
    mints: [
      {
        url: 'https://mint.example.test',
        info: {
          nuts: {
            CTF: {
              default_keyset_creation: 'one-vs-rest',
              registration_fee_base: 0,
              registration_fee_per_keyset: 0,
            },
          },
        },
      },
    ],
  },
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/markets', () => ({
  createMarket: (...args: unknown[]) => mockCreateMarket(...args),
  requiredMarketCreationOutcomeCollections: (outcomes: readonly string[]) => outcomes,
  MintError: class MintError extends Error {
    constructor(public readonly code: number, public readonly detail: string) {
      super(detail)
      this.name = 'MintError'
    }
  },
}))

vi.mock('@/lib/marketRegistrationFee', () => ({
  MAX_CONDITION_REGISTRATION_FEE_SATS: 1000,
  getAvailableRegularBalanceSats: (...args: unknown[]) =>
    mockGetAvailableRegularBalanceSats(...args),
  registerConditionWithFee: (...args: unknown[]) =>
    mockRegisterConditionWithFee(...args),
  registrationFeeForPolicy: (
    outcomes: readonly string[],
    settings: {
      defaultKeysetCreation: 'none' | 'one-vs-rest' | 'all'
      registrationFeeBase: number
      registrationFeePerKeyset: number
    },
  ) => {
    const numKeysets =
      settings.defaultKeysetCreation === 'all'
        ? Math.max(0, 2 ** outcomes.length - 2)
        : new Set(outcomes.map((outcome) => outcome.trim()).filter(Boolean)).size
    return settings.registrationFeeBase + settings.registrationFeePerKeyset * numKeysets
  },
}))

vi.mock('@/lib/oracle', () => ({
  fetchOracleAnnouncements: vi.fn().mockResolvedValue([{
    id: 'ann-hex-123',
    eventId: 'evt-1',
    oraclePubkey: 'pubkey-1',
    description: 'Test announcement',
    resolutionDate: new Date(Date.now() + 86400000).toISOString(),
    outcomes: ['Yes', 'No'],
  }]),
}))

vi.mock('@/lib/kormir', () => ({
  createEnumAnnouncement: (...args: unknown[]) => mockCreateEnumAnnouncement(...args),
}))

vi.mock('@/lib/walletOps', () => ({
  refreshMintInfoWithoutActivating: vi.fn().mockResolvedValue(undefined),
}))

// Stub the wallet store — the real module transitively imports `@cashu/cashu-ts`
// which fails to load cleanly under Vitest's ESM resolver, and this test does
// not exercise the wallet at all.
vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => mockWalletState,
  },
}))

// Pull the creator-markets store into the test so the post-success
// "0% fee" assertion can read the persisted entry. Mocked separately from
// the store under test so the assertion sees real reads/writes.
import { useCreatorMarketsStore } from '@/stores/creatorMarkets'

// Stub nip17 so the test does not pull in nostr-tools at module load time.
// The real derivation is covered in `bitCaster-app/src/lib/__tests__`.
vi.mock('@/lib/nip17', () => ({
  deriveNostrKeyPair: () => ({
    privateKeyHex: '00'.repeat(32),
    publicKey: '11'.repeat(32),
  }),
}))

// Stub env var before importing the hook (module-level const reads it at import time)
vi.stubEnv('VITE_ORACLE_PUBKEY', 'fake-oracle-pubkey')

// Must import after mocks and env stub
const { useMarketCreationState } = await import('../useMarketCreationState')

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRegisterConditionWithFee.mockResolvedValue({ condition_id: 'test-cond-id', keysets: { Yes: 'ks1', No: 'ks2' } })
  mockGetAvailableRegularBalanceSats.mockResolvedValue(1000)
  mockCreateMarket.mockResolvedValue({ conditionId: 'test-cond-id', marketsCreated: ['test-cond-id-Yes', 'test-cond-id-No'], thumbnailUrl: null })
  mockCreateEnumAnnouncement.mockResolvedValue('announcement-hex')
  mockWalletState.activeMintUrl = 'https://mint.example.test'
  mockWalletState.mints = [
    {
      url: 'https://mint.example.test',
      info: {
        nuts: {
          CTF: {
            default_keyset_creation: 'one-vs-rest',
            registration_fee_base: 0,
            registration_fee_per_keyset: 0,
          },
        },
      },
    },
  ]

  // Configure Nostr so oracle announcements are fetched
  useSettingsStore.setState({ nostrSignerMode: 'nip07' })
  // Reset the persisted wizard draft so each test starts from a clean
  // "no work in progress" state.
  useMarketDraftStore.setState({ draft: defaultDraft(), hasSavedDraft: false })
})

async function setupDraftForSubmission() {
  const { result } = renderHook(() => useMarketCreationState(), { wrapper })

  // Wait for oracle announcements to load
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

  // Select oracle announcement
  await act(async () => { result.current.onAnnouncementSelect('ann-hex-123') })

  // Navigate through steps: step 1 → 2
  await act(async () => { result.current.onNext() })
  // Step 2: select outcome type
  await act(async () => { result.current.onOutcomeTypeSelect('yesno') })
  await act(async () => { result.current.onNext() })
  // Step 3: basic info
  await act(async () => { result.current.onTitleChange('Test Market') })
  await act(async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    result.current.onClosingDateChange(future)
  })
  await act(async () => { result.current.onNext() })
  // Step 4: outcomes (default 50/50)
  await act(async () => { result.current.onNext() })
  // Step 5: liquidity
  await act(async () => { result.current.onLiquiditySatsChange(10000) })
  await act(async () => { result.current.onNext() })
  // Step 6: description
  await act(async () => { result.current.onDescriptionChange('Test description') })

  return result
}

describe('useMarketCreationState – onCreateMarket', () => {
  it('uses the mint default keyset policy when registering the condition', async () => {
    const result = await setupDraftForSubmission()
    const callOrder: string[] = []
    mockRegisterConditionWithFee.mockImplementation(async () => {
      callOrder.push('condition')
      return { condition_id: 'test-cond-id', keysets: { Yes: 'ks1', No: 'ks2' } }
    })
    mockCreateMarket.mockImplementation(async () => {
      callOrder.push('createMarket')
      return { conditionId: 'test-cond-id', marketsCreated: [], thumbnailUrl: null }
    })

    await act(async () => { await result.current.onCreateMarket() })

    expect(callOrder).toEqual(['condition', 'createMarket'])
    expect(mockRegisterConditionWithFee).toHaveBeenCalledOnce()
    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.test',
      requiredFeeSats: 0,
      request: {
        tags: [
          ['title', 'Test Market'],
          ['description', 'Test description'],
        ],
        announcementHex: 'ann-hex-123',
        collateral: 'sat',
        outcomeCollections: undefined,
      },
    })
    expect(mockCreateMarket).toHaveBeenCalledOnce()
    expect(mockCreateMarket.mock.calls[0][1]).toMatchObject({
      oracleAnnouncementHex: 'ann-hex-123',
    })
  })

  it('requests outcome collections explicitly when the mint default policy is none', async () => {
    mockWalletState.mints[0].info.nuts.CTF.default_keyset_creation = 'none'
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          collateral: 'sat',
          outcomeCollections: ['Yes', 'No'],
        }),
      }),
    )
  })

  it('omits client-defined collections when the mint default policy is all', async () => {
    mockWalletState.mints[0].info.nuts.CTF.default_keyset_creation = 'all'
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          collateral: 'sat',
          outcomeCollections: undefined,
        }),
      }),
    )
  })

  it('prompts before paying a non-zero registration fee', async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_base = 10
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_per_keyset = 2
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.registrationFeePrompt).toEqual({
      feeSats: 14,
      balanceSats: 1000,
    })
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled()
    expect(mockCreateMarket).not.toHaveBeenCalled()

    await act(async () => { await result.current.onConfirmRegistrationFee() })

    expect(mockRegisterConditionWithFee).toHaveBeenCalledWith(
      expect.objectContaining({ requiredFeeSats: 14 }),
    )
    expect(mockCreateMarket).toHaveBeenCalledOnce()
  })

  it('shows the top-up gate when the registration fee exceeds available regular balance', async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_base = 10
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_per_keyset = 2
    mockGetAvailableRegularBalanceSats.mockResolvedValueOnce(3)
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.registrationFeeTopUpStage).toBe('modal')
    expect(result.current.registrationFeeTopUp).toEqual({
      feeSats: 14,
      balanceSats: 3,
    })
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled()
  })

  it('rechecks the registration fee after top-up success', async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_base = 10
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_per_keyset = 2
    mockGetAvailableRegularBalanceSats
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1000)
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })
    await act(async () => { await result.current.onRegistrationFeeTopUpSuccess() })

    expect(result.current.registrationFeeTopUpStage).toBe('closed')
    expect(result.current.registrationFeePrompt).toEqual({
      feeSats: 14,
      balanceSats: 1000,
    })
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled()
  })

  it('blocks market creation when the registration fee exceeds the app cap', async () => {
    mockWalletState.mints[0].info.nuts.CTF.registration_fee_base = 1001
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe(
      'This mint requires a 1001 sat condition registration fee, which exceeds the 1000 sat app limit.',
    )
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled()
    expect(mockCreateMarket).not.toHaveBeenCalled()
  })

  it('blocks market creation when CTF settings are missing or invalid', async () => {
    ;(mockWalletState.mints[0].info.nuts as any).CTF = { supported: true }
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe(
      'Active mint CTF settings are missing or invalid. Refresh mint info or choose another mint.',
    )
    expect(mockRegisterConditionWithFee).not.toHaveBeenCalled()
    expect(mockCreateMarket).not.toHaveBeenCalled()
  })

  it('stops and sets error if registerCondition fails', async () => {
    const result = await setupDraftForSubmission()
    mockRegisterConditionWithFee.mockRejectedValueOnce(new Error('Mint rejected'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe('Mint rejected')
    expect(mockCreateMarket).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('stops and sets error if createMarket fails', async () => {
    const result = await setupDraftForSubmission()
    mockCreateMarket.mockRejectedValueOnce(new Error('Market creation failed'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe('Market creation failed')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('hands off to the deposit step on full success (does NOT navigate immediately)', async () => {
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(mockCreateMarket).toHaveBeenCalledOnce()
    // Post-CPMM-Phase-5: createMarket success transitions the wizard to the
    // deposit step rather than navigating to the market detail page. The
    // user funds the bot first; navigation happens from DepositStep on
    // `Credited`. The hook signals this via `createdMarketConditionId`.
    expect(result.current.createdMarketConditionId).toBe('test-cond-id')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('clears the persisted draft on success so the wizard does not resurface stale work', async () => {
    const result = await setupDraftForSubmission()
    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true)

    await act(async () => { await result.current.onCreateMarket() })

    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(false)
  })

  it('keeps the persisted draft when createMarket fails so the user can retry', async () => {
    const result = await setupDraftForSubmission()
    mockCreateMarket.mockRejectedValueOnce(new Error('Market creation failed'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(useMarketDraftStore.getState().hasSavedDraft).toBe(true)
  })

  it('stamps creatorFeePercent=0 (P7 §/creator: engine accrues no fees)', async () => {
    // Reset the creator-markets store so the assertion is not polluted by
    // entries from the other tests in this file.
    useCreatorMarketsStore.setState({ markets: [] })
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    const entry = useCreatorMarketsStore
      .getState()
      .markets.find((m) => m.conditionId === 'test-cond-id')
    expect(entry).toBeDefined()
    expect(entry!.creatorFeePercent).toBe(0)
  })

  it('records self-oracle event metadata when creating as the oracle', async () => {
    useCreatorMarketsStore.setState({ markets: [] })
    useSettingsStore.setState({
      nostrSignerMode: 'nsec',
      relays: [{ url: 'wss://relay.example.test', connectionStatus: 'connected' }],
    })
    const { result } = renderHook(() => useMarketCreationState(), { wrapper })

    await act(async () => { result.current.onOracleChoiceSelect('become-oracle') })
    await act(async () => { result.current.onNext() })
    await act(async () => { result.current.onOutcomeTypeSelect('yesno') })
    await act(async () => { result.current.onNext() })
    await act(async () => { result.current.onTitleChange('Will BTC hit $150k?') })
    await act(async () => {
      const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
      result.current.onClosingDateChange(future)
    })
    await act(async () => { result.current.onNext() })
    await act(async () => { result.current.onNext() })
    await act(async () => { result.current.onLiquiditySatsChange(10000) })
    await act(async () => { result.current.onNext() })
    await act(async () => { result.current.onDescriptionChange('Test description') })

    await act(async () => { await result.current.onCreateMarket() })

    expect(mockCreateEnumAnnouncement).toHaveBeenCalledWith(
      ['wss://relay.example.test'],
      expect.stringMatching(/^will_btc_hit_150k_[0-9a-f]{12}$/),
      ['Yes', 'No'],
      expect.any(Number),
      'Will BTC hit $150k?',
      'Test description',
    )
    const entry = useCreatorMarketsStore.getState().markets[0]
    expect(entry.oracle?.type).toBe('self')
    expect(entry.oracle?.eventId).toMatch(/^will_btc_hit_150k_[0-9a-f]{12}$/)
    expect(entry.oracle?.outcomes).toEqual(['Yes', 'No'])
  })
})
