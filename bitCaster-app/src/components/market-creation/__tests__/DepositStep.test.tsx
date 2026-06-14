import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n'
import { DepositStep } from '../DepositStep'

const requestLnInvoiceDeposit = vi.fn()
const getDepositStatus = vi.fn()

vi.mock('@/lib/markets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/markets')>()),
  requestLnInvoiceDeposit: (...args: unknown[]) => requestLnInvoiceDeposit(...args),
  getDepositStatus: (...args: unknown[]) => getDepositStatus(...args),
}))

const DISCLOSURE =
  'This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.'

function renderStep(
  props?: Partial<{
    conditionId: string
    defaultAmountSats: number
    outcomeCount: number
    baseAsset: 'sat' | 'usd'
  }>,
) {
  const conditionId = props?.conditionId ?? 'cond-test-abc123'
  const defaultAmountSats = props?.defaultAmountSats ?? 1000
  const outcomeCount = props?.outcomeCount ?? 2
  return render(
    <MemoryRouter initialEntries={['/creator/new']}>
      <Routes>
        <Route
          path="/creator/new"
          element={
            <DepositStep
              conditionId={conditionId}
              defaultAmountSats={defaultAmountSats}
              outcomeCount={outcomeCount}
              baseAsset={props?.baseAsset ?? 'sat'}
            />
          }
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
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    requestLnInvoiceDeposit.mockReset()
    requestLnInvoiceDeposit.mockResolvedValue({
      depositId: 'deposit-1',
      bolt11: 'lnbc10u1pjexampleinvoice',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    getDepositStatus.mockReset()
    getDepositStatus.mockResolvedValue({
      depositId: 'deposit-1',
      conditionId: 'cond-test-abc123',
      state: 'Requested',
      method: 'Lightning',
      amountSats: 100_000,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      failureReason: null,
    })
  })

  async function openFunding(user = userEvent.setup()) {
    await user.click(screen.getByRole('button', { name: 'Attract Traders' }))
    expect(screen.getByRole('heading', { name: 'Fund the market maker' })).toBeInTheDocument()
    return user
  }

  it('shows the created page first, then opens funding', async () => {
    const user = userEvent.setup()
    renderStep()

    expect(screen.getByRole('heading', { name: 'Market created!' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Fund the market maker' })).not.toBeInTheDocument()

    await openFunding(user)
    expect(screen.queryByTestId('condition-id')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument()
  })

  it('keeps no-liquidity as a funding tier path to the market', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('amm-funding-tier-none'))
    await user.click(screen.getByRole('button', { name: 'Continue to your market' }))

    await waitFor(() => {
      expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    })
  })

  it('shows the binding disclosure before funding confirmation', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument()
  })

  it('shows the warning only for no-liquidity funding', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('amm-funding-tier-minimal'))
    expect(screen.queryByText('Very thin liquidity')).not.toBeInTheDocument()

    await user.clear(screen.getByRole('spinbutton'))
    await user.type(screen.getByRole('spinbutton'), '9999')
    expect(screen.queryByText('Very thin liquidity')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('amm-funding-tier-none'))
    expect(screen.getByText('Very thin liquidity')).toBeInTheDocument()
  })

  it('requests AMM funding and shows the shared invoice display', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestLnInvoiceDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000,
        expect.objectContaining({ fundAmm: true }),
      )
    })
    expect(await screen.findByTestId('bolt11-display')).toHaveTextContent(
      'lnbc10u1pjexampleinvoice',
    )
    await waitFor(() => {
      expect(getDepositStatus).toHaveBeenCalledWith('cond-test-abc123', 'deposit-1')
    })
  })

  it('marks the funding invoice paid after the deposit is credited', async () => {
    const user = userEvent.setup()
    getDepositStatus.mockResolvedValue({
      depositId: 'deposit-1',
      conditionId: 'cond-test-abc123',
      state: 'Credited',
      method: 'Lightning',
      amountSats: 100_000,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      failureReason: null,
    })
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))

    expect(await screen.findByText('Payment received!')).toBeInTheDocument()
  })

  it('renders USD funding in dollars/cents and requests base subunits', async () => {
    const user = userEvent.setup()
    renderStep({ baseAsset: 'usd' })

    await openFunding(user)
    expect(screen.getByText('$1,000.00')).toBeInTheDocument()
    expect(screen.queryByText('cents')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestLnInvoiceDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000,
        expect.objectContaining({ fundAmm: true }),
      )
    })
  })
})
