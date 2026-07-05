import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n'
import { DepositStep } from '../DepositStep'

const requestEcashDeposit = vi.fn()
const getDepositStatus = vi.fn()

vi.mock('@/lib/markets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/markets')>()),
  requestEcashDeposit: (...args: unknown[]) => requestEcashDeposit(...args),
  getDepositStatus: (...args: unknown[]) => getDepositStatus(...args),
}))

const DISCLOSURE =
  'This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.'

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
    requestEcashDeposit.mockReset()
    getDepositStatus.mockReset()
    requestEcashDeposit.mockResolvedValue({
      depositId: 'deposit-1',
      state: 'paid',
    })
    getDepositStatus.mockResolvedValue({
      depositId: 'deposit-1',
      state: 'paid',
      method: 'ecash',
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
    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBusdtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        1_500,
        'cashuBusdtoken',
        expect.objectContaining({ fundAmm: true, unit: 'usd', divisibility: 1_000 }),
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

  it('submits AMM funding with a pasted ecash token', async () => {
    const user = userEvent.setup()
    renderStep()

    await openFunding(user)
    expect(screen.queryByTestId('request-ln-invoice')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000_000,
        'cashuBtoken',
        expect.objectContaining({ fundAmm: true, unit: 'msat', divisibility: 10_000 }),
      )
    })
    expect(await screen.findByText('Payment received — crediting your market…')).toBeInTheDocument()
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

    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000_000,
        'cashuBtoken',
        expect.objectContaining({ fundAmm: true, unit: 'msat', divisibility: 10_000 }),
      )
    })
  })

  it('fails fast for unsupported AMM funding base assets', () => {
    expect(() => renderStep({ baseAsset: 'jpy' })).toThrow(/unsupported base asset: jpy/)
  })

  it('auto-navigates five seconds after ecash funding is accepted', async () => {
    const user = userEvent.setup()
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    renderStep()

    await openFunding(user)
    timeoutSpy.mockClear()
    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))
    expect(await screen.findByText('Payment received — crediting your market…')).toBeInTheDocument()

    expect(screen.queryByTestId('market-detail-page')).not.toBeInTheDocument()
    const navigationCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000)
    expect(navigationCall).toBeDefined()
    act(() => {
      ;(navigationCall?.[0] as () => void)()
    })
    expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    timeoutSpy.mockRestore()
  })

  it('polls requested ecash deposits until they are credited before navigating', async () => {
    const user = userEvent.setup()
    const timeoutSpy = vi.spyOn(window, 'setTimeout')
    requestEcashDeposit.mockResolvedValueOnce({
      depositId: 'deposit-requested',
      state: 'requested',
    })
    getDepositStatus.mockResolvedValueOnce({
      depositId: 'deposit-requested',
      state: 'requested',
      method: 'ecash',
    })
    getDepositStatus.mockResolvedValueOnce({
      depositId: 'deposit-requested',
      state: 'credited',
      method: 'ecash',
    })
    renderStep()

    await openFunding(user)
    timeoutSpy.mockClear()
    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    expect(await screen.findByText('Awaiting payment…')).toBeInTheDocument()
    const pollingCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 2_000)
    expect(pollingCall).toBeDefined()

    await act(async () => {
      ;(pollingCall?.[0] as () => void)()
    })

    await waitFor(() => {
      expect(getDepositStatus).toHaveBeenCalledWith('cond-test-abc123', 'deposit-requested')
    })
    expect(screen.getByText('Awaiting payment…')).toBeInTheDocument()
    const secondPollingCall = timeoutSpy.mock.calls.filter(([, delay]) => delay === 2_000)[1]
    expect(secondPollingCall).toBeDefined()

    await act(async () => {
      ;(secondPollingCall?.[0] as () => void)()
    })

    await waitFor(() => {
      expect(getDepositStatus).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText('Payment received — crediting your market…')).toBeInTheDocument()
    expect(screen.queryByTestId('market-detail-page')).not.toBeInTheDocument()
    const navigationCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000)
    expect(navigationCall).toBeDefined()
    act(() => {
      ;(navigationCall?.[0] as () => void)()
    })
    expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    timeoutSpy.mockRestore()
  })

  it('renders failed ecash deposit state with an error and retry action', async () => {
    const user = userEvent.setup()
    requestEcashDeposit.mockResolvedValueOnce({
      depositId: 'deposit-failed',
      state: 'failed',
    })
    renderStep()

    await openFunding(user)
    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    expect(await screen.findByText('Deposit failed')).toBeInTheDocument()
    expect(screen.getByText('Proof verification or crediting failed. Check the token and retry.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry ecash deposit' })).toBeEnabled()
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

    await user.type(screen.getByTestId('amm-funding-ecash-token'), 'cashuBusdtoken')
    await user.click(screen.getByTestId('confirm-amm-funding'))

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        'cond-test-abc123',
        100_000,
        'cashuBusdtoken',
        expect.objectContaining({ fundAmm: true, unit: 'usd', divisibility: 1_000 }),
      )
    })
  })
})
