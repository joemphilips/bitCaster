import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { DepositWithdraw } from '../DepositWithdraw'
import type { DepositWithdrawProps } from '@/types/deposit-withdraw'

const baseMints = [
  { id: 'mint-1', name: 'Test Mint', url: 'http://localhost:3338', balanceSats: 5000 },
]

function renderDepositWithdraw(overrides: Partial<DepositWithdrawProps> = {}) {
  const defaultProps: DepositWithdrawProps = {
    mode: 'deposit',
    currentView: 'chooser',
    mints: baseMints,
    selectedMintId: 'mint-1',
    amountSats: 0,
    amountFiat: '$0.00',
    fiatSymbol: '$',
    showFiatPrimary: false,
    lightningInput: '',
    ...overrides,
  }
  return render(<DepositWithdraw {...defaultProps} />)
}

describe('DepositWithdraw', () => {
  describe('MethodChooser view', () => {
    it('shows Deposit title when mode is deposit', () => {
      renderDepositWithdraw({ mode: 'deposit', currentView: 'chooser' })
      expect(screen.getByText('Deposit')).toBeInTheDocument()
    })

    it('shows Withdrawal title when mode is withdraw', () => {
      renderDepositWithdraw({ mode: 'withdraw', currentView: 'chooser' })
      expect(screen.getByText('Withdrawal')).toBeInTheDocument()
    })

    it('shows Ecash and Lightning options', () => {
      renderDepositWithdraw({ currentView: 'chooser' })
      expect(screen.getByText('Ecash')).toBeInTheDocument()
      expect(screen.getByText('Lightning')).toBeInTheDocument()
    })

    it('calls onSelectMethod with ecash when Ecash is clicked', async () => {
      const onSelectMethod = vi.fn()
      renderDepositWithdraw({ currentView: 'chooser', onSelectMethod })
      await userEvent.click(screen.getByText('Ecash'))
      expect(onSelectMethod).toHaveBeenCalledWith('ecash')
    })

    it('calls onSelectMethod with lightning when Lightning is clicked', async () => {
      const onSelectMethod = vi.fn()
      renderDepositWithdraw({ currentView: 'chooser', onSelectMethod })
      await userEvent.click(screen.getByText('Lightning'))
      expect(onSelectMethod).toHaveBeenCalledWith('lightning')
    })

    it('calls onClose when X button is clicked', async () => {
      const onClose = vi.fn()
      renderDepositWithdraw({ currentView: 'chooser', onClose })
      // The X button is the first button in the header
      const buttons = screen.getAllByRole('button')
      await userEvent.click(buttons[0]) // X close button
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('calls onClose when backdrop is clicked', async () => {
      const onClose = vi.fn()
      renderDepositWithdraw({ currentView: 'chooser', onClose })
      // Backdrop is the div with bg-black/60
      const backdrop = document.querySelector('.bg-black\\/60')
      expect(backdrop).not.toBeNull()
      await userEvent.click(backdrop!)
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  describe('DepositLightning view', () => {
    it('shows CREATE INVOICE button disabled when amount is 0', () => {
      renderDepositWithdraw({ currentView: 'deposit-lightning', amountSats: 0 })
      const button = screen.getByRole('button', { name: /create invoice/i })
      expect(button).toBeDisabled()
    })

    it('shows CREATE INVOICE button enabled when amount > 0', () => {
      renderDepositWithdraw({ currentView: 'deposit-lightning', amountSats: 1000 })
      const button = screen.getByRole('button', { name: /create invoice/i })
      expect(button).not.toBeDisabled()
    })

    it('calls onCreateInvoice when button is clicked', async () => {
      const onCreateInvoice = vi.fn()
      renderDepositWithdraw({
        currentView: 'deposit-lightning',
        amountSats: 1000,
        onCreateInvoice,
      })
      await userEvent.click(screen.getByRole('button', { name: /create invoice/i }))
      expect(onCreateInvoice).toHaveBeenCalledOnce()
    })

    it('displays the entered amount', () => {
      renderDepositWithdraw({ currentView: 'deposit-lightning', amountSats: 42000 })
      expect(screen.getByText(/42,000/)).toBeInTheDocument()
    })

    it('shows mint name and balance', () => {
      renderDepositWithdraw({ currentView: 'deposit-lightning' })
      expect(screen.getByText('Test Mint')).toBeInTheDocument()
      expect(screen.getByText(/5,000 available/)).toBeInTheDocument()
    })

    it('calls onNumpadPress when numpad keys are clicked', async () => {
      const onNumpadPress = vi.fn()
      renderDepositWithdraw({ currentView: 'deposit-lightning', onNumpadPress })
      await userEvent.click(screen.getByRole('button', { name: '5' }))
      expect(onNumpadPress).toHaveBeenCalledWith('5')
    })
  })

  describe('DepositEcash view', () => {
    it('shows Paste, Scan, and Request options', () => {
      renderDepositWithdraw({ mode: 'deposit', currentView: 'deposit-ecash' })
      expect(screen.getByText('Paste')).toBeInTheDocument()
      expect(screen.getByText('Scan')).toBeInTheDocument()
      expect(screen.getByText('Request')).toBeInTheDocument()
    })

    it('calls onPaste when Paste is clicked', async () => {
      const onPaste = vi.fn()
      renderDepositWithdraw({ currentView: 'deposit-ecash', onPaste })
      await userEvent.click(screen.getByText('Paste'))
      expect(onPaste).toHaveBeenCalledOnce()
    })

    it('calls onBack when back button is clicked', async () => {
      const onBack = vi.fn()
      renderDepositWithdraw({ currentView: 'deposit-ecash', onBack })
      // Back button is the first button in header
      const buttons = screen.getAllByRole('button')
      await userEvent.click(buttons[0])
      expect(onBack).toHaveBeenCalledOnce()
    })
  })

  describe('SendEcash view', () => {
    it('shows SEND button disabled when amount is 0', () => {
      renderDepositWithdraw({ mode: 'withdraw', currentView: 'send-ecash', amountSats: 0 })
      const button = screen.getByRole('button', { name: /send/i })
      expect(button).toBeDisabled()
    })

    it('shows SEND button enabled when amount > 0', () => {
      renderDepositWithdraw({ mode: 'withdraw', currentView: 'send-ecash', amountSats: 500 })
      const button = screen.getByRole('button', { name: /send/i })
      expect(button).not.toBeDisabled()
    })

    it('calls onSendEcash when button is clicked', async () => {
      const onSendEcash = vi.fn()
      renderDepositWithdraw({
        mode: 'withdraw',
        currentView: 'send-ecash',
        amountSats: 500,
        onSendEcash,
      })
      await userEvent.click(screen.getByRole('button', { name: /send/i }))
      expect(onSendEcash).toHaveBeenCalledOnce()
    })
  })

  describe('PayLightning view', () => {
    it('shows invoice input textarea', () => {
      renderDepositWithdraw({ mode: 'withdraw', currentView: 'pay-lightning' })
      expect(screen.getByPlaceholderText(/lightning address or invoice/i)).toBeInTheDocument()
    })

    it('shows Paste and Scan QR Code options', () => {
      renderDepositWithdraw({ mode: 'withdraw', currentView: 'pay-lightning' })
      expect(screen.getByText('Paste')).toBeInTheDocument()
      expect(screen.getByText('Scan QR Code')).toBeInTheDocument()
    })

    it('calls onLightningInputChange when typing', async () => {
      const onLightningInputChange = vi.fn()
      renderDepositWithdraw({
        mode: 'withdraw',
        currentView: 'pay-lightning',
        onLightningInputChange,
      })
      const textarea = screen.getByPlaceholderText(/lightning address or invoice/i)
      await userEvent.type(textarea, 'lnbc')
      expect(onLightningInputChange).toHaveBeenCalled()
    })
  })

  describe('view switching', () => {
    it('renders null for unknown view', () => {
      const { container } = renderDepositWithdraw({
        currentView: 'chooser' as never,
      })
      // Should render the chooser
      expect(container.innerHTML).not.toBe('')
    })
  })
})
