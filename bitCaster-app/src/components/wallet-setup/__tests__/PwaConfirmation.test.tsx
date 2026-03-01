import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PwaConfirmation } from '../PwaConfirmation'

describe('PwaConfirmation', () => {
  it('"Next" button disabled when isPwa is false', () => {
    render(<PwaConfirmation isPwa={false} />)
    const nextBtn = screen.getByRole('button', { name: /next/i })
    expect(nextBtn).toBeDisabled()
  })

  it('"Next" button enabled when isPwa is true', () => {
    render(<PwaConfirmation isPwa={true} />)
    const nextBtn = screen.getByRole('button', { name: /next/i })
    expect(nextBtn).toBeEnabled()
  })

  it('shows install instructions when not PWA', () => {
    render(<PwaConfirmation isPwa={false} />)
    expect(screen.getByText(/install as app to continue/i)).toBeInTheDocument()
  })

  it('calls onPwaNext when button clicked in PWA mode', async () => {
    const onPwaNext = vi.fn()
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<PwaConfirmation isPwa={true} onPwaNext={onPwaNext} />)
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(onPwaNext).toHaveBeenCalledOnce()
  })
})
