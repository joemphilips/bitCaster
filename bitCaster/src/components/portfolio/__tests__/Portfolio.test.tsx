import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { Portfolio } from '../Portfolio'
import type {
  PortfolioProps,
  UserProfile,
  PLChartData,
  PortfolioStats,
  Position,
  Fund,
  ActivityItem,
  CreatedMarket,
} from '@/types/portfolio'

const mockProfile: UserProfile = {
  userId: 'usr-a1b2',
  displayName: 'SatoshiTrader',
  avatarUrl: null,
  registeredDate: '2025-08-15T09:30:00Z',
  viewCount: 1247,
}

const mockPLData: PLChartData = {
  '1D': [
    { timestamp: '2026-01-22T00:00:00Z', cumulativePL: 220000 },
    { timestamp: '2026-01-23T00:00:00Z', cumulativePL: 234580 },
  ],
  '1W': [
    { timestamp: '2026-01-16T00:00:00Z', cumulativePL: 242780 },
    { timestamp: '2026-01-22T00:00:00Z', cumulativePL: 234580 },
  ],
  '1M': [
    { timestamp: '2025-12-23T00:00:00Z', cumulativePL: 147230 },
    { timestamp: '2026-01-22T00:00:00Z', cumulativePL: 234580 },
  ],
  ALL: [
    { timestamp: '2025-08-15T00:00:00Z', cumulativePL: 0 },
    { timestamp: '2026-01-22T00:00:00Z', cumulativePL: 234580 },
  ],
}

const mockStats: PortfolioStats = {
  positionsValueSats: 445750,
  biggestWinSats: 86400,
  predictionsCount: 8,
}

const mockPositions: Position[] = [
  {
    id: 'pos-001',
    marketId: 'mkt-001',
    marketTitle: 'Will Bitcoin reach $100K?',
    marketImageUrl: '/images/markets/bitcoin-100k.jpg',
    mintUrl: 'https://mint.bitcaster.io',
    side: 'yes',
    shares: 150,
    avgBuyPrice: 620,
    currentPrice: 675,
    currentValueSats: 101250,
    profitLossSats: 8250,
    profitLossPercent: 8.87,
    status: 'active',
    acquiredDate: '2025-12-10T14:22:00Z',
  },
  {
    id: 'pos-005',
    marketId: 'mkt-resolved-001',
    marketTitle: 'Will Ethereum merge complete?',
    marketImageUrl: '/images/markets/eth-merge.jpg',
    mintUrl: 'https://mint.bitcaster.io',
    side: 'yes',
    shares: 100,
    avgBuyPrice: 450,
    currentPrice: 1000,
    currentValueSats: 100000,
    profitLossSats: 55000,
    profitLossPercent: 122.22,
    status: 'closed',
    closedDate: '2025-12-31T23:59:59Z',
    acquiredDate: '2025-09-20T10:30:00Z',
  },
  {
    id: 'pos-006',
    marketId: 'mkt-resolved-002',
    marketTitle: 'Will the Fed raise rates?',
    marketImageUrl: '/images/markets/fed-rates.jpg',
    mintUrl: 'https://mint.bitcaster.io',
    side: 'yes',
    shares: 250,
    avgBuyPrice: 380,
    currentPrice: 0,
    currentValueSats: 0,
    profitLossSats: -95000,
    profitLossPercent: -100,
    status: 'closed',
    closedDate: '2025-12-18T19:00:00Z',
    acquiredDate: '2025-11-01T13:45:00Z',
  },
]

const mockFunds: Fund[] = [
  { id: 'fund-001', unit: 'sats', amount: 125000, mintUrl: 'https://mint.bitcaster.io' },
  { id: 'fund-002', unit: 'sats', amount: 48000, mintUrl: 'https://testnut.cashu.space' },
  { id: 'fund-003', unit: 'usd', amount: 2500, mintUrl: 'https://mint.bitcaster.io' },
]

const mockActivity: ActivityItem[] = [
  {
    id: 'act-001',
    type: 'deposit',
    amountSats: 500000,
    date: '2025-08-15T09:35:00Z',
    status: 'completed',
    txId: 'a1b2c3d4e5f6789012345678901234567890abcd',
    lightningInvoice: null,
  },
  {
    id: 'act-002',
    type: 'buy',
    amountSats: 93600,
    date: '2025-09-20T10:30:00Z',
    status: 'completed',
    txId: null,
    lightningInvoice: null,
    marketId: 'mkt-resolved-001',
    marketTitle: 'Will Ethereum merge to PoS?',
    positionId: 'pos-005',
  },
]

const mockCreatedMarkets: CreatedMarket[] = [
  {
    id: 'mkt-user-001',
    title: 'Will Lightning reach 100K channels?',
    imageUrl: '/images/markets/lightning-channels.jpg',
    status: 'active',
    createdDate: '2025-11-20T14:00:00Z',
    volume: 456200,
    creatorFeesEarned: 9124,
    creatorFeePercent: 2.0,
  },
  {
    id: 'mkt-user-003',
    title: 'Will Nostr reach 10M users?',
    imageUrl: '/images/markets/nostr-users.jpg',
    status: 'resolved',
    createdDate: '2025-06-10T08:30:00Z',
    resolvedDate: '2025-12-31T23:59:59Z',
    volume: 892100,
    creatorFeesEarned: 17842,
    creatorFeePercent: 2.0,
  },
]

function renderPortfolio(overrides: Partial<PortfolioProps> = {}) {
  const defaultProps: PortfolioProps = {
    walletState: 'ready',
    baseCurrency: 'BTC',
    selectedTimeRange: 'ALL',
    profile: mockProfile,
    plChartData: mockPLData,
    stats: mockStats,
    positions: mockPositions,
    funds: mockFunds,
    activity: mockActivity,
    createdMarkets: mockCreatedMarkets,
    positionsTab: 'active',
    ...overrides,
  }
  return render(<Portfolio {...defaultProps} />)
}

describe('Portfolio', () => {
  describe('No Wallet State', () => {
    it('shows Get Started CTA when walletState is none', () => {
      renderPortfolio({ walletState: 'none' })
      expect(screen.getByText('Welcome to bitCaster')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument()
      expect(screen.queryByText('SatoshiTrader')).not.toBeInTheDocument()
    })

    it('calls onGetStarted when CTA is clicked', async () => {
      const onGetStarted = vi.fn()
      renderPortfolio({ walletState: 'none', onGetStarted })
      await userEvent.click(screen.getByRole('button', { name: /get started/i }))
      expect(onGetStarted).toHaveBeenCalledOnce()
    })
  })

  describe('Full Dashboard', () => {
    it('renders profile card with display name', () => {
      renderPortfolio()
      expect(screen.getByText('SatoshiTrader')).toBeInTheDocument()
    })

    it('renders stats row', () => {
      renderPortfolio()
      expect(screen.getByText('Positions Value')).toBeInTheDocument()
      expect(screen.getByText('Biggest Win')).toBeInTheDocument()
      expect(screen.getByText('Predictions')).toBeInTheDocument()
    })

    it('renders deposit and withdraw buttons', () => {
      renderPortfolio()
      expect(screen.getByRole('button', { name: /deposit/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /withdraw/i })).toBeInTheDocument()
    })

    it('renders settings button', () => {
      renderPortfolio()
      expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
    })
  })

  describe('Main Tabs', () => {
    it('shows positions tab by default', () => {
      renderPortfolio()
      expect(screen.getByText('Active (1)')).toBeInTheDocument()
    })

    it('switches to funds tab', async () => {
      renderPortfolio()
      await userEvent.click(screen.getByRole('tab', { name: /funds/i }))
      expect(screen.getAllByText('Sats')).toHaveLength(2)
    })

    it('switches to activity tab', async () => {
      renderPortfolio()
      await userEvent.click(screen.getByRole('tab', { name: /activity/i }))
      // "Deposit" appears both as a button label and activity type label
      expect(screen.getAllByText('Deposit').length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Positions', () => {
    it('shows active positions by default', () => {
      renderPortfolio()
      expect(screen.getByText('Will Bitcoin reach $100K?')).toBeInTheDocument()
    })

    it('switches to closed positions tab', async () => {
      const onPositionsTabChange = vi.fn()
      renderPortfolio({ onPositionsTabChange })
      await userEvent.click(screen.getByText('Closed (2)'))
      expect(onPositionsTabChange).toHaveBeenCalledWith('closed')
    })

    it('shows Sell button on active positions', () => {
      const onSellPosition = vi.fn()
      renderPortfolio({ onSellPosition })
      expect(screen.getByLabelText(/sell.*bitcoin/i)).toBeInTheDocument()
    })

    it('calls onSellPosition when Sell is clicked', async () => {
      const onSellPosition = vi.fn()
      renderPortfolio({ onSellPosition })
      await userEvent.click(screen.getByLabelText(/sell.*bitcoin/i))
      expect(onSellPosition).toHaveBeenCalledWith('pos-001')
    })

    it('shows Claim button on winning closed positions', async () => {
      const onClaimPayout = vi.fn()
      renderPortfolio({ positionsTab: 'closed', onClaimPayout })
      // Winning closed position (pos-005, profitLossSats > 0)
      expect(screen.getByLabelText(/claim.*ethereum/i)).toBeInTheDocument()
    })

    it('does not show Claim button on losing closed positions', () => {
      const onClaimPayout = vi.fn()
      renderPortfolio({ positionsTab: 'closed', onClaimPayout })
      // Losing closed position (pos-006, profitLossSats < 0)
      expect(screen.queryByLabelText(/claim.*fed/i)).not.toBeInTheDocument()
    })

    it('shows empty state when no positions', () => {
      renderPortfolio({ positions: [] })
      expect(screen.getByText('No active positions')).toBeInTheDocument()
    })
  })

  describe('Funds Tab', () => {
    it('renders fund rows with correct info', async () => {
      renderPortfolio()
      await userEvent.click(screen.getByRole('tab', { name: /funds/i }))
      // Two mints referenced in funds
      expect(screen.getAllByText('mint.bitcaster.io')).toHaveLength(2) // sats + usd
      expect(screen.getByText('testnut.cashu.space')).toBeInTheDocument()
    })

    it('shows empty state when no funds', async () => {
      renderPortfolio({ funds: [] })
      await userEvent.click(screen.getByRole('tab', { name: /funds/i }))
      expect(screen.getByText('No funds')).toBeInTheDocument()
    })
  })

  describe('Activity Tab', () => {
    it('renders activity items', async () => {
      renderPortfolio()
      await userEvent.click(screen.getByRole('tab', { name: /activity/i }))
      // Activity type labels appear along with the Deposit button
      expect(screen.getByText('Buy')).toBeInTheDocument()
      expect(screen.getByText('Will Ethereum merge to PoS?')).toBeInTheDocument()
    })

    it('shows empty state when no activity', async () => {
      renderPortfolio({ activity: [] })
      await userEvent.click(screen.getByRole('tab', { name: /activity/i }))
      expect(screen.getByText('No activity yet')).toBeInTheDocument()
    })
  })

  describe('P/L Chart', () => {
    it('calls onTimeRangeChange when time range is clicked', async () => {
      const onTimeRangeChange = vi.fn()
      renderPortfolio({ onTimeRangeChange })
      await userEvent.click(screen.getByRole('button', { name: '1W' }))
      expect(onTimeRangeChange).toHaveBeenCalledWith('1W')
    })
  })

  describe('My Markets', () => {
    it('renders created markets section', () => {
      renderPortfolio()
      expect(screen.getByText('My Markets (2)')).toBeInTheDocument()
      expect(screen.getByText('Will Lightning reach 100K channels?')).toBeInTheDocument()
    })

    it('hides section when no created markets', () => {
      renderPortfolio({ createdMarkets: [] })
      expect(screen.queryByText(/my markets/i)).not.toBeInTheDocument()
    })

    it('collapses and expands', async () => {
      renderPortfolio()
      expect(screen.getByText('Will Lightning reach 100K channels?')).toBeInTheDocument()
      // Click the collapse button (My Markets header)
      await userEvent.click(screen.getByText('My Markets (2)'))
      expect(screen.queryByText('Will Lightning reach 100K channels?')).not.toBeInTheDocument()
      // Expand again
      await userEvent.click(screen.getByText('My Markets (2)'))
      expect(screen.getByText('Will Lightning reach 100K channels?')).toBeInTheDocument()
    })

    it('shows Claim Fees button on resolved markets with fees', () => {
      const onClaimCreatorFees = vi.fn()
      renderPortfolio({ onClaimCreatorFees })
      expect(screen.getByText('Claim Fees')).toBeInTheDocument()
    })

    it('calls onClaimCreatorFees when Claim Fees is clicked', async () => {
      const onClaimCreatorFees = vi.fn()
      renderPortfolio({ onClaimCreatorFees })
      await userEvent.click(screen.getByText('Claim Fees'))
      expect(onClaimCreatorFees).toHaveBeenCalledWith('mkt-user-003')
    })
  })

  describe('Callbacks', () => {
    it('calls onDeposit when Deposit is clicked', async () => {
      const onDeposit = vi.fn()
      renderPortfolio({ onDeposit })
      await userEvent.click(screen.getByRole('button', { name: /deposit/i }))
      expect(onDeposit).toHaveBeenCalledOnce()
    })

    it('calls onWithdraw when Withdraw is clicked', async () => {
      const onWithdraw = vi.fn()
      renderPortfolio({ onWithdraw })
      await userEvent.click(screen.getByRole('button', { name: /withdraw/i }))
      expect(onWithdraw).toHaveBeenCalledOnce()
    })

    it('calls onOpenSettings when settings icon is clicked', async () => {
      const onOpenSettings = vi.fn()
      renderPortfolio({ onOpenSettings })
      await userEvent.click(screen.getByRole('button', { name: /settings/i }))
      expect(onOpenSettings).toHaveBeenCalledOnce()
    })
  })
})
