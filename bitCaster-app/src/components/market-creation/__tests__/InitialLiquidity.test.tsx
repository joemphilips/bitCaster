import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { InitialLiquidity } from '../InitialLiquidity'

describe('InitialLiquidity', () => {
  it('renders a static AMM TBD panel instead of liquidity inputs', () => {
    render(<InitialLiquidity liquiditySats={0} />)

    expect(screen.getByRole('heading', { name: 'AMM liquidity is TBD' })).toBeInTheDocument()
    expect(screen.getByText('No liquidity payment required')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skip-liquidity')).not.toBeInTheDocument()
  })

  it('lets the creator advance without entering liquidity', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()

    render(<InitialLiquidity liquiditySats={0} onNext={onNext} />)
    await user.click(screen.getByTestId('continue-without-amm'))

    expect(onNext).toHaveBeenCalledOnce()
  })
})
