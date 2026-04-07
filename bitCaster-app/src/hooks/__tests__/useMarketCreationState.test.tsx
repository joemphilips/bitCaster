import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { useSettingsStore } from '@/stores/settings'

const {
  mockNavigate,
  mockRegisterCondition,
  mockRegisterPartition,
  mockUploadThumbnail,
  mockRegisterLiquidity,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRegisterCondition: vi.fn(),
  mockRegisterPartition: vi.fn(),
  mockUploadThumbnail: vi.fn(),
  mockRegisterLiquidity: vi.fn(),
}))

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/lib/markets', () => ({
  registerCondition: (...args: unknown[]) => mockRegisterCondition(...args),
  registerPartition: (...args: unknown[]) => mockRegisterPartition(...args),
  uploadThumbnail: (...args: unknown[]) => mockUploadThumbnail(...args),
  registerLiquidity: (...args: unknown[]) => mockRegisterLiquidity(...args),
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
  mockUploadThumbnail.mockResolvedValue({})
  mockRegisterLiquidity.mockResolvedValue({ marketId: 'test-cond-id-Yes', reserveA: 500, reserveB: 500, impliedProbability: 50, ordersPlaced: [] })

  // Configure Nostr so oracle announcements are fetched
  useSettingsStore.setState({ nostrSignerMode: 'nip07' })
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
  it('calls registerCondition then registerPartition in order on success', async () => {
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

    await act(async () => { await result.current.onCreateMarket() })

    expect(callOrder).toEqual(['condition', 'partition'])
    expect(mockRegisterCondition).toHaveBeenCalledOnce()
    expect(mockRegisterPartition).toHaveBeenCalledWith('test-cond-id', ['Yes', 'No'])
  })

  it('stops and sets error if registerCondition fails', async () => {
    const result = await setupDraftForSubmission()
    mockRegisterCondition.mockRejectedValueOnce(new Error('Mint rejected'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe('Mint rejected')
    expect(mockRegisterPartition).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('stops and sets error if registerPartition fails', async () => {
    const result = await setupDraftForSubmission()
    mockRegisterPartition.mockRejectedValueOnce(new Error('Partition failed'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(result.current.submitError).toBe('Partition failed')
    expect(mockUploadThumbnail).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('treats thumbnail upload failure as non-fatal', async () => {
    const result = await setupDraftForSubmission()
    mockUploadThumbnail.mockRejectedValueOnce(new Error('Upload failed'))

    await act(async () => { await result.current.onCreateMarket() })

    // Liquidity should still be called and navigation should happen
    expect(mockRegisterLiquidity).toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledWith('/markets/test-cond-id')
  })

  it('treats liquidity registration failure as non-fatal', async () => {
    const result = await setupDraftForSubmission()
    mockRegisterLiquidity.mockRejectedValue(new Error('Liquidity failed'))

    await act(async () => { await result.current.onCreateMarket() })

    expect(mockNavigate).toHaveBeenCalledWith('/markets/test-cond-id')
    expect(result.current.submitError).toBeNull()
  })

  it('navigates to /markets/{condition_id} on full success', async () => {
    const result = await setupDraftForSubmission()

    await act(async () => { await result.current.onCreateMarket() })

    expect(mockNavigate).toHaveBeenCalledWith('/markets/test-cond-id')
  })
})
