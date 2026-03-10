import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PwaConfirmation } from '../PwaConfirmation'

describe('PwaConfirmation', () => {
  it('"Next" button enabled even when isPwa is false', () => {
    render(<PwaConfirmation isPwa={false} />)
    const nextBtn = screen.getByRole('button', { name: /next/i })
    expect(nextBtn).toBeEnabled()
  })

  it('"Next" button enabled when isPwa is true', () => {
    render(<PwaConfirmation isPwa={true} />)
    const nextBtn = screen.getByRole('button', { name: /next/i })
    expect(nextBtn).toBeEnabled()
  })

  it('shows PWA recommendation when not PWA', () => {
    render(<PwaConfirmation isPwa={false} />)
    expect(screen.getByText(/install bitCaster as a PWA/i)).toBeInTheDocument()
  })

  it('calls onPwaNext when button clicked', async () => {
    const onPwaNext = vi.fn()
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()

    render(<PwaConfirmation isPwa={false} onPwaNext={onPwaNext} />)
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(onPwaNext).toHaveBeenCalledOnce()
  })
})
