import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SeedVerification } from '../SeedVerification'

const seedWords = [
  'abandon', 'ability', 'able', 'about',
  'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident',
]

describe('SeedVerification', () => {
  it('initially shows "Enter word #3"', () => {
    render(
      <SeedVerification seedWords={seedWords} onVerificationComplete={vi.fn()} />
    )
    expect(screen.getByText('Enter word #3')).toBeInTheDocument()
  })

  it('Next button disabled when input is empty', () => {
    render(
      <SeedVerification seedWords={seedWords} onVerificationComplete={vi.fn()} />
    )
    const button = screen.getByRole('button', { name: 'Next' })
    expect(button).toBeDisabled()
  })

  it('wrong word shows error and keeps button disabled', async () => {
    const user = userEvent.setup()
    render(
      <SeedVerification seedWords={seedWords} onVerificationComplete={vi.fn()} />
    )

    const input = screen.getByPlaceholderText('Word #3')
    await user.type(input, 'wrong')

    // Button should still be disabled (wrong word)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('correct word #3 → Next → advances to word #7', async () => {
    const user = userEvent.setup()
    render(
      <SeedVerification seedWords={seedWords} onVerificationComplete={vi.fn()} />
    )

    const input = screen.getByPlaceholderText('Word #3')
    await user.type(input, seedWords[2]) // 'able'

    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeEnabled()
    await user.click(nextBtn)

    expect(screen.getByText('Enter word #7')).toBeInTheDocument()
  })

  it('completes all 3 steps and calls onVerificationComplete', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(
      <SeedVerification seedWords={seedWords} onVerificationComplete={onComplete} />
    )

    // Step 1: word #3
    await user.type(screen.getByPlaceholderText('Word #3'), seedWords[2])
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // Step 2: word #7
    await user.type(screen.getByPlaceholderText('Word #7'), seedWords[6])
    await user.click(screen.getByRole('button', { name: 'Next' }))

    // Step 3: word #12 — button says "Continue"
    await user.type(screen.getByPlaceholderText('Word #12'), seedWords[11])
    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(continueBtn).toBeEnabled()
    await user.click(continueBtn)

    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('Back button on first sub-step calls onBack', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    render(
      <SeedVerification seedWords={seedWords} onVerificationComplete={vi.fn()} onBack={onBack} />
    )

    await user.click(screen.getByRole('button', { name: /back/i }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
