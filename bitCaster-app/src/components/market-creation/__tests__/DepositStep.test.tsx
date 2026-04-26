import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import userEvent from '@testing-library/user-event'
import { DepositStep } from '../DepositStep'

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
    // Polling resolves directly to Credited so the test is fast.
    vi.mocked(getDepositStatus).mockResolvedValue({
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

    // Bolt11 bearer string is shown.
    await waitFor(() => {
      expect(screen.getByTestId('bolt11-display')).toHaveTextContent('lnbcrt1000n1pq...')
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
    expect(screen.queryByTestId('bolt11-display')).not.toBeInTheDocument()
  })

  it('prevents amount < 1', () => {
    renderStep({ defaultAmountSats: 0 })
    expect(screen.getByTestId('request-ln-invoice')).toBeDisabled()
  })
})
