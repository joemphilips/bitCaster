import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { InitialLiquidity } from '../InitialLiquidity'

describe('InitialLiquidity', () => {
  it('disables Next button when liquidity is 0', () => {
    render(<InitialLiquidity liquiditySats={0} />)
    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeDisabled()
  })

  it('enables Next button when liquidity is greater than 0', () => {
    render(<InitialLiquidity liquiditySats={1000} />)
    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeEnabled()
  })

  it('calls onLiquiditySatsChange with 1000 when 1,000 quick button is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<InitialLiquidity liquiditySats={0} onLiquiditySatsChange={onChange} />)
    await user.click(screen.getByRole('button', { name: '1,000' }))
    expect(onChange).toHaveBeenCalledWith(1000)
  })

  it('calls onLiquiditySatsChange with 5000 when 5,000 quick button is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<InitialLiquidity liquiditySats={0} onLiquiditySatsChange={onChange} />)
    await user.click(screen.getByRole('button', { name: '5,000' }))
    expect(onChange).toHaveBeenCalledWith(5000)
  })

  it('calls onLiquiditySatsChange with 10000 when 10,000 quick button is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<InitialLiquidity liquiditySats={0} onLiquiditySatsChange={onChange} />)
    await user.click(screen.getByRole('button', { name: '10,000' }))
    expect(onChange).toHaveBeenCalledWith(10000)
  })

  it('calls onLiquiditySatsChange with 50000 when 50,000 quick button is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<InitialLiquidity liquiditySats={0} onLiquiditySatsChange={onChange} />)
    await user.click(screen.getByRole('button', { name: '50,000' }))
    expect(onChange).toHaveBeenCalledWith(50000)
  })

  it('calls onNext when Next is clicked with valid liquidity', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()
    render(<InitialLiquidity liquiditySats={5000} onNext={onNext} />)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('allows the creator to skip optional liquidity at zero', async () => {
    const user = userEvent.setup()
    const onSkip = vi.fn()
    render(<InitialLiquidity liquiditySats={0} onSkip={onSkip} />)
    await user.click(screen.getByTestId('skip-liquidity'))
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('highlights the selected quick amount button', () => {
    render(<InitialLiquidity liquiditySats={5000} />)
    const btn5k = screen.getByRole('button', { name: '5,000' })
    expect(btn5k.className).toContain('bg-blue-600')
  })
})
