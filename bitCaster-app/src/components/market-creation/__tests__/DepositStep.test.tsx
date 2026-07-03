import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

async function flushAsyncEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function depositStatus(
  state: 'requested' | 'paid' | 'credited' | 'failed',
  options: { expiresAt?: string } = {},
) {
  return {
    depositId: 'deposit-1',
    conditionId: 'cond-test-abc123',
    state,
    method: 'lightningInvoice',
    amountSats: 100_000,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    failureReason: null,
  }
}

function renderStep(
  props?: Partial<{
    conditionId: string
    defaultAmountSats: number
    outcomeCount: number
    baseAsset: 'sat' | 'usd' | 'jpy'
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
    getDepositStatus.mockResolvedValue(depositStatus('requested'))
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('shows the thin-depth warning only for minimal funding', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('amm-funding-tier-minimal'))
    expect(screen.getByText('Minimal funding produces thin 1-share levels.')).toBeInTheDocument()

    await user.clear(screen.getByRole('spinbutton'))
    await user.type(screen.getByRole('spinbutton'), '9999')
    expect(screen.queryByText('Minimal funding produces thin 1-share levels.')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('amm-funding-tier-none'))
    expect(screen.queryByText('Minimal funding produces thin 1-share levels.')).not.toBeInTheDocument()
  })

  it('previews USD custom funding as entered dollars', async () => {
    const user = userEvent.setup()
    renderStep({ baseAsset: 'usd' })

    await openFunding(user)
    await user.clear(screen.getByRole('spinbutton'))
    await user.type(screen.getByRole('spinbutton'), '15')

    expect(screen.getByText('Funding amount: $15.00')).toBeInTheDocument()
  })

  it('converts USD custom funding dollars to cent subunits at the request boundary', async () => {
    const user = userEvent.setup()
    renderStep({ baseAsset: 'usd' })

    await openFunding(user)
    await user.clear(screen.getByRole('spinbutton'))
    await user.type(screen.getByRole('spinbutton'), '15')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestLnInvoiceDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        1_500,
        expect.objectContaining({ fundAmm: true }),
      )
    })
  })

  it('renders USD funding tiers in dollars instead of cent subunits', async () => {
    const user = userEvent.setup()
    renderStep({ baseAsset: 'usd', outcomeCount: 4 })

    await openFunding(user)

    expect(screen.getByTestId('amm-funding-tier-minimal')).toHaveTextContent('$100')
    expect(screen.getByTestId('amm-funding-tier-standard')).toHaveTextContent('$1,000')
    expect(screen.getByTestId('amm-funding-tier-deep')).toHaveTextContent('$5,000')
    expect(screen.queryByText('1500')).not.toBeInTheDocument()
    expect(screen.queryByText('15000')).not.toBeInTheDocument()
  })

  it('requests AMM funding and shows the shared invoice display', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestLnInvoiceDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000_000,
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

  it('renders SAT funding tiers as hardcoded round whole-sat amounts', async () => {
    const user = userEvent.setup()
    renderStep({ baseAsset: 'sat', outcomeCount: 4 })

    await openFunding(user)

    expect(screen.getByTestId('amm-funding-tier-minimal')).toHaveTextContent('10,000 sats')
    expect(screen.getByTestId('amm-funding-tier-standard')).toHaveTextContent('100,000 sats')
    expect(screen.getByTestId('amm-funding-tier-deep')).toHaveTextContent('500,000 sats')
    expect(screen.getByText(/At this budget, the bot posts ~/)).toBeInTheDocument()
    expect(screen.getByText('Depth before mint fees — actual quoted depth may be lower.')).toBeInTheDocument()

    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestLnInvoiceDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000_000,
        expect.objectContaining({ fundAmm: true }),
      )
    })
  })

  it('fails fast for unsupported AMM funding base assets', () => {
    expect(() => renderStep({ baseAsset: 'jpy' })).toThrow(/unsupported base asset: jpy/)
  })

  it('marks the funding invoice paid once the Lightning payment is confirmed', async () => {
    const user = userEvent.setup()
    getDepositStatus.mockResolvedValue(depositStatus('paid'))
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))

    expect(await screen.findByText('Payment received!')).toBeInTheDocument()
  })

  it('keeps polling until a requested invoice is paid', async () => {
    vi.useFakeTimers()
    getDepositStatus
      .mockResolvedValueOnce(depositStatus('requested'))
      .mockResolvedValueOnce(depositStatus('paid'))
    renderStep()

    fireEvent.click(screen.getByRole('button', { name: 'Attract Traders' }))
    fireEvent.click(screen.getByTestId('confirm-amm-funding'))
    await flushAsyncEffects()

    expect(getDepositStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Payment received!')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    await flushAsyncEffects()

    expect(screen.getByText('Payment received!')).toBeInTheDocument()
    expect(getDepositStatus).toHaveBeenCalledTimes(2)
  })

  it('still marks credited deposits as paid when polling observes the terminal state first', async () => {
    const user = userEvent.setup()
    getDepositStatus.mockResolvedValue(depositStatus('credited'))
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))

    expect(await screen.findByText('Payment received!')).toBeInTheDocument()
  })

  it('auto-navigates five seconds after Lightning payment is confirmed', async () => {
    const user = userEvent.setup()
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    getDepositStatus.mockResolvedValue(depositStatus('paid'))
    renderStep()

    await openFunding(user)
    timeoutSpy.mockClear()
    await user.click(screen.getByTestId('confirm-amm-funding'))
    expect(await screen.findByText('Payment received!')).toBeInTheDocument()

    expect(screen.queryByTestId('market-detail-page')).not.toBeInTheDocument()
    const navigationCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000)
    expect(navigationCall).toBeDefined()
    act(() => {
      ;(navigationCall?.[0] as () => void)()
    })
    expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    timeoutSpy.mockRestore()
  })

  it('auto-navigates when polling observes credited before paid', async () => {
    const user = userEvent.setup()
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    getDepositStatus.mockResolvedValue(depositStatus('credited'))
    renderStep()

    await openFunding(user)
    timeoutSpy.mockClear()
    await user.click(screen.getByTestId('confirm-amm-funding'))
    expect(await screen.findByText('Payment received!')).toBeInTheDocument()

    const navigationCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000)
    expect(navigationCall).toBeDefined()
    act(() => {
      ;(navigationCall?.[0] as () => void)()
    })
    expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    timeoutSpy.mockRestore()
  })

  it('does not expire an invoice after payment is already confirmed', async () => {
    const user = userEvent.setup()
    requestLnInvoiceDeposit.mockResolvedValueOnce({
      depositId: 'deposit-1',
      bolt11: 'lnbc10u1pjexampleinvoice',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    getDepositStatus.mockResolvedValue(
      depositStatus('paid', { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    )
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))

    expect(await screen.findByText('Payment received!')).toBeInTheDocument()
    expect(screen.queryByText('Invoice expired')).not.toBeInTheDocument()
  })

  it('lets the creator request a fresh funding invoice after expiry', async () => {
    const user = userEvent.setup()
    requestLnInvoiceDeposit
      .mockResolvedValueOnce({
        depositId: 'deposit-expired',
        bolt11: 'lnbc10u1pjexpired',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      })
      .mockResolvedValueOnce({
        depositId: 'deposit-fresh',
        bolt11: 'lnbc10u1pjfresh',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    renderStep()

    await openFunding(user)
    await user.click(screen.getByTestId('confirm-amm-funding'))
    expect(await screen.findByText('Invoice expired')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Re-quote' }))

    await waitFor(() => {
      expect(requestLnInvoiceDeposit).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText('lnbc10u1pjfresh')).toBeInTheDocument()
  })

  it('renders USD funding tiers as hardcoded round whole-dollar amounts and requests base subunits', async () => {
    const user = userEvent.setup()
    renderStep({ baseAsset: 'usd', outcomeCount: 4 })

    await openFunding(user)
    expect(screen.getByTestId('amm-funding-tier-minimal')).toHaveTextContent('$100')
    expect(screen.getByTestId('amm-funding-tier-standard')).toHaveTextContent('$1,000')
    expect(screen.getByTestId('amm-funding-tier-deep')).toHaveTextContent('$5,000')
    expect(screen.queryByText('$15.00')).not.toBeInTheDocument()
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
