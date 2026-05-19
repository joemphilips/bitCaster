import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import userEvent from '@testing-library/user-event'
import { DepositStep } from '../DepositStep'

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
  it('renders a static AMM TBD panel and the new market id', () => {
    renderStep()

    expect(screen.getByRole('heading', { name: 'AMM liquidity is TBD' })).toBeInTheDocument()
    expect(screen.getByText('No liquidity payment required')).toBeInTheDocument()
    expect(screen.getByTestId('condition-id')).toHaveTextContent('cond-test-abc123')
    expect(screen.queryByRole('heading', { name: 'Lightning Invoice' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('tab-ln')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tab-ecash')).not.toBeInTheDocument()
  })

  it('continues to the market without collecting a liquidity payment', async () => {
    const user = userEvent.setup()
    renderStep()

    await user.click(screen.getByTestId('continue-to-market'))

    await waitFor(() => {
      expect(screen.getByTestId('market-detail-page')).toBeInTheDocument()
    })
  })
})
