import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import userEvent from '@testing-library/user-event'
import { DepositStep } from '../DepositStep'

const {
  mockCreateMeltQuote,
  mockMeltProofs,
  mockGetBaseProofs,
  mockRemoveProofs,
  mockAddProofs,
} = vi.hoisted(() => ({
  mockCreateMeltQuote: vi.fn(),
  mockMeltProofs: vi.fn(),
  mockGetBaseProofs: vi.fn(),
  mockRemoveProofs: vi.fn(),
  mockAddProofs: vi.fn(),
}))

// The deposit step depends on the API client. Mock the surface.
vi.mock('@/lib/markets', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/markets')>()
  return {
    ...mod,
    requestLnInvoiceDeposit: vi.fn(),
    requestEcashDeposit: vi.fn(),
    getDepositStatus: vi.fn(),
  }
})

vi.mock('@/lib/cashu', () => ({
  createMeltQuote: (...args: unknown[]) => mockCreateMeltQuote(...args),
  meltProofs: (...args: unknown[]) => mockMeltProofs(...args),
}))

vi.mock('@/stores/proof-db', () => ({
  getBaseProofs: (...args: unknown[]) => mockGetBaseProofs(...args),
  removeProofs: (...args: unknown[]) => mockRemoveProofs(...args),
  addProofs: (...args: unknown[]) => mockAddProofs(...args),
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: (selector: (s: { activeMintUrl: string }) => unknown) =>
    selector({ activeMintUrl: 'http://mint.test' }),
}))

import {
  requestLnInvoiceDeposit,
  requestEcashDeposit,
  getDepositStatus,
} from '@/lib/markets'

function renderStep(props?: Partial<{ conditionId: string; defaultAmountSats: number }>) {
  const conditionId = props?.conditionId ?? 'cond-test-abc123'
  const defaultAmountSats = props?.defaultAmountSats ?? 1000
  return render(
    <MemoryRouter initialEntries={['/creator/new']}>
      <Routes>
        <Route
          path="/creator/new"
          element={<DepositStep conditionId={conditionId} defaultAmountSats={defaultAmountSats} />}
        />
        <Route
          path="/markets/:id"
          element={<div data-testid="market-detail-page">market-detail</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('DepositStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMeltQuote.mockResolvedValue({
      quote: 'melt-q',
      amount: 1000,
      fee_reserve: 0,
      state: 'UNPAID',
      expiry: 0,
      payment_preimage: null,
    })
    mockGetBaseProofs.mockResolvedValue([])
    mockMeltProofs.mockResolvedValue({ paid: true, change: [] })
    mockRemoveProofs.mockResolvedValue(undefined)
    mockAddProofs.mockResolvedValue(undefined)
  })

  it('renders the new market id and the two payment-method tabs', () => {
    renderStep()
    expect(screen.getByTestId('condition-id')).toHaveTextContent('cond-test-abc123')
    expect(screen.getByTestId('tab-ln')).toBeInTheDocument()
    expect(screen.getByTestId('tab-ecash')).toBeInTheDocument()
  })

  it('Lightning flow: requests invoice, displays bolt11, polls to Credited, navigates on continue', async () => {
    vi.mocked(requestLnInvoiceDeposit).mockResolvedValueOnce({
      depositId: 'd-1',
      bolt11: 'lnbcrt1000n1pq...',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    // Keep the invoice visible for the first assertion, then advance to
    // Credited on the next poll so the test is still fast.
    vi.mocked(getDepositStatus).mockResolvedValueOnce({
      depositId: 'd-1',
      conditionId: 'cond-test-abc123',
      state: 'Requested',
      method: 'LightningInvoice',
      amountSats: 1000,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).mockResolvedValue({
      depositId: 'd-1',
      conditionId: 'cond-test-abc123',
      state: 'Credited',
      method: 'LightningInvoice',
      amountSats: 1000,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const user = userEvent.setup()
    renderStep()

    await user.click(screen.getByTestId('request-ln-invoice'))

    // Bolt11 bearer string is shown by the same full-screen invoice UI used
    // for wallet deposits/top-ups.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Lightning Invoice' })).toBeInTheDocument()
      expect(screen.getByText('lnbcrt1000n1pq...')).toBeInTheDocument()
    })

    // Polling resolves Credited; the green panel + Continue button appear.
    await waitFor(
      () => {
        expect(screen.getByTestId('deposit-credited')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )
    expect(screen.getByTestId('continue-to-market')).toBeInTheDocument()

    // Continue navigates to the market detail route.
    await user.click(screen.getByTestId('continue-to-market'))
    await waitFor(() => {
      expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    })
  })

  it('Ecash flow: requires a token before submitting', async () => {
    const user = userEvent.setup()
    renderStep()

    await user.click(screen.getByTestId('tab-ecash'))
    const submit = screen.getByTestId('submit-ecash')
    expect(submit).toBeDisabled()

    await user.type(screen.getByTestId('ecash-token-input'), 'cashuB...')
    expect(submit).toBeEnabled()
  })

  it('Ecash flow: posts proofs, advances to credited via polling', async () => {
    vi.mocked(requestEcashDeposit).mockResolvedValueOnce({
      depositId: 'd-2',
      state: 'Paid',
    })
    vi.mocked(getDepositStatus).mockResolvedValue({
      depositId: 'd-2',
      conditionId: 'cond-test-abc123',
      state: 'Credited',
      method: 'Ecash',
      amountSats: 1000,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const user = userEvent.setup()
    renderStep()

    await user.click(screen.getByTestId('tab-ecash'))
    await user.type(screen.getByTestId('ecash-token-input'), 'cashuB-fake-token-blob')
    await user.click(screen.getByTestId('submit-ecash'))

    await waitFor(
      () => {
        expect(screen.getByTestId('deposit-credited')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )
  })

  it('surfaces request errors without crashing', async () => {
    vi.mocked(requestLnInvoiceDeposit).mockRejectedValueOnce(new Error('engine 502'))

    const user = userEvent.setup()
    renderStep()

    await user.click(screen.getByTestId('request-ln-invoice'))

    await waitFor(() => {
      expect(screen.getByText(/engine 502/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('heading', { name: 'Lightning Invoice' })).not.toBeInTheDocument()
  })

  it('prevents amount < 1', () => {
    renderStep({ defaultAmountSats: 0 })
    expect(screen.getByTestId('request-ln-invoice')).toBeDisabled()
  })

  it('lets creators skip optional liquidity provisioning', async () => {
    const user = userEvent.setup()
    renderStep()

    await user.click(screen.getByTestId('skip-liquidity'))

    await waitFor(() => {
      expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    })
  })
})
