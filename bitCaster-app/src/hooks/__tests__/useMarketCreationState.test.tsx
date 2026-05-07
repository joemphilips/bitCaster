import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { useSettingsStore } from '@/stores/settings'
import { useMarketDraftStore, defaultDraft } from '@/stores/marketDraft'

const {
  mockNavigate,
  mockRegisterCondition,
  mockRegisterPartition,
  mockCreateMarket,
  mockCreateEnumAnnouncement,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRegisterCondition: vi.fn(),
  mockRegisterPartition: vi.fn(),
  mockCreateMarket: vi.fn(),
  mockCreateEnumAnnouncement: vi.fn(),
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/markets', () => ({
  registerCondition: (...args: unknown[]) => mockRegisterCondition(...args),
  registerPartition: (...args: unknown[]) => mockRegisterPartition(...args),
  createMarket: (...args: unknown[]) => mockCreateMarket(...args),
  MintError: class MintError extends Error {
    constructor(public readonly code: number, public readonly detail: string) {
      super(detail)
      this.name = 'MintError'
    }
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

// Stub the wallet store — the real module transitively imports `@cashu/cashu-ts`
// which fails to load cleanly under Vitest's ESM resolver, and this test does
// not exercise the wallet at all.
vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => ({ mnemonic: null }),
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
  mockRegisterCondition.mockResolvedValue({ condition_id: 'test-cond-id' })
  mockRegisterPartition.mockResolvedValue({ keysets: { Yes: 'ks1', No: 'ks2' } })
  mockCreateMarket.mockResolvedValue({ conditionId: 'test-cond-id', marketsCreated: ['test-cond-id-Yes', 'test-cond-id-No'], thumbnailUrl: null })
  mockCreateEnumAnnouncement.mockResolvedValue('announcement-hex')

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
  it('calls registerCondition, registerPartition, then createMarket in order', async () => {
    const result = await setupDraftForSubmission()
    const callOrder: string[] = []
    mockRegisterCondition.mockImplementation(async () => {
      callOrder.push('condition')
      return { condition_id: 'test-cond-id' }
    })
    mockRegisterPartition.mockImplementation(async () => {
      callOrder.push('partition')
      return { keysets: { Yes: 'ks1', No: 'ks2' } }
    })
    mockCreateMarket.mockImplementation(async () => {
      callOrder.push('createMarket')
      return { conditionId: 'test-cond-id', marketsCreated: [], thumbnailUrl: null }
    })

    await act(async () => { await result.current.onCreateMarket() })

    expect(callOrder).toEqual(['condition', 'partition', 'createMarket'])
    expect(mockRegisterCondition).toHaveBeenCalledOnce()
    expect(mockRegisterPartition).toHaveBeenCalledWith('test-cond-id', ['Yes', 'No'])
    expect(mockCreateMarket).toHaveBeenCalledOnce()
  })

  it('stops and sets error if registerCondition fails', async () => {
    const result = await setupDraftForSubmission()
    mockRegisterCondition.mockRejectedValueOnce(new Error('Mint rejected'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe('Mint rejected')
    expect(mockRegisterPartition).not.toHaveBeenCalled()
    expect(mockCreateMarket).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('stops and sets error if registerPartition fails', async () => {
    const result = await setupDraftForSubmission()
    mockRegisterPartition.mockRejectedValueOnce(new Error('Partition failed'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe('Partition failed')
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
    )
    const entry = useCreatorMarketsStore.getState().markets[0]
    expect(entry.oracle?.type).toBe('self')
    expect(entry.oracle?.eventId).toMatch(/^will_btc_hit_150k_[0-9a-f]{12}$/)
    expect(entry.oracle?.outcomes).toEqual(['Yes', 'No'])
  })
})
