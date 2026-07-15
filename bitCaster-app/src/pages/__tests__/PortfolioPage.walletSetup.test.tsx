import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ensureImplicitWallet = vi.fn()
const recoverFromMnemonic = vi.fn()
const navigate = vi.fn()
let mockWalletState: 'none' | 'ready' = 'none'
let mockWalletBackupState: 'none' | 'needs_backup' | 'confirmed' = 'none'

vi.mock('react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('@/components/deposit-withdraw/DepositWithdrawOverlay', () => ({
  DepositWithdrawOverlay: ({ mode }: { mode: string }) => <div>{mode} overlay</div>,
}))

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ nostrSignerMode: 'none', nostrProfile: null }),
}))

vi.mock('@/stores/activity-log', () => ({
  useActivityLogStore: (selector: (s: unknown) => unknown) =>
    selector({ addActivityForWallet: vi.fn() }),
}))

vi.mock('@/stores/proof-db', () => ({
  getConditionCtfProofs: vi.fn().mockResolvedValue([]),
  getOutcomeProofs: vi.fn().mockResolvedValue([]),
  removeProofs: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/cashu', () => ({
  settleCtfPosition: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => ({
      ensureImplicitWallet,
      recoverFromMnemonic,
      walletBackupState: mockWalletBackupState,
    }),
  },
}))

vi.mock('../usePortfolioState', () => ({
  usePortfolioState: () => ({
    walletState: mockWalletState,
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
    positions: [],
    funds: [],
    activity: [],
    createdMarkets: [],
    positionsTab: 'active' as const,
    setSelectedTimeRange: vi.fn(),
    setPositionsTab: vi.fn(),
    saveProfile: vi.fn(),
  }),
}))

import { PortfolioPage } from '../PortfolioPage'

describe('PortfolioPage wallet setup', () => {
  beforeEach(() => {
    mockWalletState = 'none'
    mockWalletBackupState = 'none'
    navigate.mockReset()
    ensureImplicitWallet.mockReset()
    recoverFromMnemonic.mockReset()
  })

  it('opens the wallet setup modal from the no-wallet portfolio CTA', async () => {
    render(<PortfolioPage />)

    await userEvent.click(screen.getByRole('button', { name: /get started/i }))

    expect(screen.getByRole('heading', { name: /wallet setup/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create new wallet/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /import existing wallet/i })).toBeInTheDocument()
  })

  it('creates an implicit wallet, closes the modal, and shows the empty portfolio wallet', async () => {
    ensureImplicitWallet.mockImplementation(async () => {
      mockWalletState = 'ready'
    })

    render(<PortfolioPage />)

    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    await userEvent.click(screen.getByRole('button', { name: /create new wallet/i }))

    await waitFor(() => expect(ensureImplicitWallet).toHaveBeenCalledOnce())
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /wallet setup/i })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /deposit/i })).toBeInTheDocument()
    expect(screen.getAllByText(/0 sats/i).length).toBeGreaterThan(0)
  })

  it('shows seedphrase input for importing an existing wallet', async () => {
    render(<PortfolioPage />)

    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    await userEvent.click(screen.getByRole('button', { name: /import existing wallet/i }))

    expect(screen.getByLabelText(/enter your seedphrase/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restore wallet/i })).toBeInTheDocument()
  })

  it('imports a seed phrase through recoverFromMnemonic and stays on the portfolio page', async () => {
    recoverFromMnemonic.mockImplementation(() => {
      mockWalletState = 'ready'
      return { valid: true }
    })
    const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

    render(<PortfolioPage />)

    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    await userEvent.click(screen.getByRole('button', { name: /import existing wallet/i }))
    await userEvent.type(screen.getByLabelText(/enter your seedphrase/i), words)
    await userEvent.click(screen.getByRole('button', { name: /restore wallet/i }))

    expect(recoverFromMnemonic).toHaveBeenCalledWith(words.split(' '))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /wallet setup/i })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /deposit/i })).toBeInTheDocument()
  })

  it('opens deposit for an unbacked wallet instead of blocking on backup', async () => {
    mockWalletState = 'ready'
    mockWalletBackupState = 'needs_backup'

    render(<PortfolioPage />)

    await userEvent.click(screen.getByRole('button', { name: /deposit/i }))

    expect(screen.getByText('deposit overlay')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /back up your wallet first/i })).not.toBeInTheDocument()
  })
})
