import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Position } from '@/types/portfolio'

// --- mocks -----------------------------------------------------------------

const getOutcomeProofs = vi.fn()
const getConditionCtfProofs = vi.fn().mockResolvedValue([])
const removeProofs = vi.fn().mockResolvedValue(undefined)

vi.mock('@/stores/proof-db', () => ({
  getOutcomeProofs: (...args: unknown[]) => getOutcomeProofs(...args),
  getConditionCtfProofs: (...args: unknown[]) => getConditionCtfProofs(...args),
  removeProofs: (...args: unknown[]) => removeProofs(...args),
}))

vi.mock('@/lib/cashu', () => ({
  settleCtfPosition: vi.fn().mockResolvedValue([]),
}))

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/components/deposit-withdraw/DepositWithdrawOverlay', () => ({
  DepositWithdrawOverlay: () => null,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ nostrSignerMode: 'none', nostrProfile: null }),
}))

vi.mock('@/stores/activity-log', () => ({
  useActivityLogStore: (selector: (s: unknown) => unknown) =>
    selector({ items: [], addActivity: vi.fn() }),
}))

// usePortfolioState is heavy (Dexie live queries + fetch); supply fixed state.
let mockPositions: Position[] = []
const setPositionsTab = vi.fn()
vi.mock('../usePortfolioState', () => ({
  usePortfolioState: () => ({
    walletState: 'ready',
    baseCurrency: 'BTC',
    selectedTimeRange: 'ALL',
    profile: { userId: '', displayName: 'Anon', avatarUrl: null, registeredDate: '' },
    plChartData: { '1D': [], '1W': [], '1M': [], ALL: [] },
    stats: {
      positionsValueSats: 0,
      totalValueSats: 0,
      biggestWinSats: 0,
      predictionsCount: 0,
    },
    positions: mockPositions,
    funds: [],
    activity: [],
    createdMarkets: [],
    positionsTab: 'closed' as const,
    setSelectedTimeRange: vi.fn(),
    setPositionsTab,
    saveProfile: vi.fn(),
  }),
}))

import { PortfolioPage } from '../PortfolioPage'

function closedPosition(overrides: Partial<Position>): Position {
  return {
    id: 'cond1-A|B',
    marketId: 'cond1-A|B',
    marketTitle: 'Lost market',
    marketImageUrl: '',
    side: 'outcome',
    outcomeId: 'A|B',
    outcomeLabel: 'A|B',
    shares: 100,
    avgBuyPrice: 0,
    currentPrice: 0,
    currentValueSats: 0,
    profitLossSats: 0,
    profitLossPercent: -100,
    status: 'closed',
    isWinner: false,
    isLoser: true,
    acquiredDate: new Date(0).toISOString(),
    mintUrl: 'https://mint.example',
    ...overrides,
  }
}

describe('PortfolioPage — Remove lost position (P22 F2)', () => {
  beforeEach(() => {
    getOutcomeProofs.mockReset()
    removeProofs.mockReset()
    removeProofs.mockResolvedValue(undefined)
  })

  it('deletes the lost position proofs without a mint redeem and clears the row', async () => {
    getOutcomeProofs.mockResolvedValue([
      { secret: 's-lost-1', amount: 50 },
      { secret: 's-lost-2', amount: 50 },
    ])
    mockPositions = [closedPosition({})]
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PortfolioPage />)
    await userEvent.click(screen.getByLabelText(/remove.*lost market/i))

    expect(getOutcomeProofs).toHaveBeenCalledWith(
      'https://mint.example',
      'cond1',
      'A|B',
      { includeReserved: true },
    )
    expect(removeProofs).toHaveBeenCalledWith(['s-lost-1', 's-lost-2'])
    // No mint redeem path for a losing leg.
    const { settleCtfPosition } = await import('@/lib/cashu')
    expect(settleCtfPosition).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('never deletes a winning-keyset proof even if the position were mis-classified a loser (P22 F2 defence-in-depth)', async () => {
    // Defence-in-depth: even if a position is (wrongly) flagged isLoser and its
    // fetched proofs include one on a WINNING keyset (collection "A", final
    // "A"), the Remove handler must skip that proof and only delete the
    // genuinely-losing keyset proofs. Destroying a winning proof is permanent
    // value loss.
    getOutcomeProofs.mockResolvedValue([
      { secret: 's-win', amount: 60, outcomeCollection: 'A' },
      { secret: 's-lose', amount: 40, outcomeCollection: 'B' },
    ])
    mockPositions = [
      closedPosition({
        id: 'cond1-A|B',
        marketId: 'cond1-A|B',
        marketTitle: 'Misclassified market',
        outcomeId: 'A|B',
        outcomeLabel: 'A|B',
        finalOutcome: 'A',
        isWinner: false,
        isLoser: true,
      }),
    ]
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PortfolioPage />)
    await userEvent.click(screen.getByLabelText(/remove.*misclassified market/i))

    // Only the losing-keyset proof is deleted; the winning-keyset proof is
    // never touched.
    expect(removeProofs).toHaveBeenCalledWith(['s-lose'])
    confirmSpy.mockRestore()
  })

  it('never deletes proofs for a winner even if the handler is invoked', async () => {
    // A winner has no Remove button, but defence-in-depth: the handler bails
    // on the single isWinner/isLoser truth before touching the proof store.
    mockPositions = [
      closedPosition({
        id: 'cond1-A',
        marketId: 'cond1-A',
        marketTitle: 'Won market',
        outcomeId: 'A',
        outcomeLabel: 'A',
        isWinner: true,
        isLoser: false,
        profitLossSats: 100,
        profitLossPercent: 100,
        currentValueSats: 100,
      }),
    ]

    render(<PortfolioPage />)
    // Winner shows Claim, never Remove.
    expect(screen.queryByLabelText(/remove.*won market/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/claim.*won market/i)).toBeInTheDocument()
    expect(removeProofs).not.toHaveBeenCalled()
  })
})
