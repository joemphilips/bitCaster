import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n'
import { DepositStep } from '../DepositStep'

const DISCLOSURE =
  'This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.'

function renderStep(
  props?: Partial<{ conditionId: string; defaultAmountSats: number; outcomeCount: number }>,
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
  })

  it('keeps skip funding as the first-class path to the market', async () => {
    const user = userEvent.setup()
    renderStep()

    expect(screen.getByRole('heading', { name: 'Fund the market maker' })).toBeInTheDocument()
    expect(screen.getByTestId('condition-id')).toHaveTextContent('cond-test-abc123')

    await user.click(screen.getByRole('button', { name: 'Skip funding (no bot liquidity)' }))

    await waitFor(() => {
      expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    })
  })

  it('shows the binding disclosure before the confirm button', () => {
    renderStep()

    const disclosure = screen.getByText(DISCLOSURE)
    const confirm = screen.getByTestId('confirm-amm-funding')

    expect(disclosure).toBeInTheDocument()
    expect(
      disclosure.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows the thin-liquidity warning for custom budgets below 10,000 sats', async () => {
    const user = userEvent.setup()
    renderStep()

    await user.clear(screen.getByRole('spinbutton'))
    await user.type(screen.getByRole('spinbutton'), '9999')

    expect(screen.getByText('Very thin liquidity')).toBeInTheDocument()
  })
})
