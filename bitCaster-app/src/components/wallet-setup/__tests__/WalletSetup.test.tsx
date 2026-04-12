import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WalletSetup } from '../WalletSetup'
import type { SetupStep } from '@/types/wallet-setup'

const baseProps = {
  currentStep: 1 as SetupStep,
  showTerms: false,
  choice: null,
  seedWords: [] as string[],
  inputSeedWords: Array(12).fill(''),
  seedSaved: false,
  mintConnections: [],
  isPwa: false,
  seedVerificationActive: false,
}

describe('WalletSetup close button', () => {
  it('renders close button on step 1 (Welcome)', () => {
    render(<WalletSetup {...baseProps} currentStep={1} />)
    expect(screen.getByRole('button', { name: /close wallet setup/i })).toBeInTheDocument()
  })

  it('renders close button on step 2 (PWA)', () => {
    render(<WalletSetup {...baseProps} currentStep={2} />)
    expect(screen.getByRole('button', { name: /close wallet setup/i })).toBeInTheDocument()
  })

  it('renders close button on step 3 (Choice)', () => {
    render(<WalletSetup {...baseProps} currentStep={3} />)
    expect(screen.getByRole('button', { name: /close wallet setup/i })).toBeInTheDocument()
  })

  it('renders close button on step 4 (Seed)', () => {
    render(
      <WalletSetup
        {...baseProps}
        currentStep={4}
        choice="create"
        seedWords={['abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'about']}
      />
    )
    expect(screen.getByRole('button', { name: /close wallet setup/i })).toBeInTheDocument()
  })

  it('renders close button on step 5 (Mint)', () => {
    render(<WalletSetup {...baseProps} currentStep={5} />)
    expect(screen.getByRole('button', { name: /close wallet setup/i })).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    render(<WalletSetup {...baseProps} currentStep={1} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: /close wallet setup/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
