import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDepositWithdrawState } from '../useDepositWithdrawState'
import { useWalletStore } from '@/stores/wallet'

// Mock cashu.ts — we don't want real mint calls
vi.mock('@/lib/cashu', () => ({
  createMintQuote: vi.fn(),
  mintProofs: vi.fn(),
  encodeToken: vi.fn().mockReturnValue('cashuAtoken123'),
  decodeToken: vi.fn().mockReturnValue({ mint: 'http://localhost:3338', proofs: [] }),
  receiveToken: vi.fn().mockResolvedValue([]),
  sendProofs: vi.fn().mockResolvedValue({ keep: [], send: [{ secret: 's1', amount: 100 }] }),
  createMeltQuote: vi.fn(),
  meltProofs: vi.fn(),
  waitForMintQuotePaid: vi.fn(),
}))

// Mock proof-db
vi.mock('@/stores/proof-db', () => ({
  db: { proofs: { toArray: vi.fn().mockResolvedValue([]), where: vi.fn().mockReturnThis(), equals: vi.fn().mockReturnThis() } },
  getProofs: vi.fn().mockResolvedValue([{ secret: 's1', amount: 100, mintUrl: 'http://localhost:3338', id: 'id1', C: 'C1' }]),
  addProofs: vi.fn().mockResolvedValue(undefined),
  removeProofs: vi.fn().mockResolvedValue(undefined),
}))

// Mock dexie-react-hooks — useLiveQuery returns balances keyed by mint URL
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: vi.fn().mockReturnValue({ 'http://localhost:3338': 5000 }),
}))

beforeEach(() => {
  useWalletStore.setState({
    mnemonic: 'test words here abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    setupComplete: true,
    mints: [{ url: 'http://localhost:3338', info: { name: 'Test Mint' } }],
    activeMintUrl: 'http://localhost:3338',
    keysetCounters: {},
    mintConnectionStatuses: {},
  })
})

describe('useDepositWithdrawState', () => {
  const onDismiss = vi.fn()

  describe('initial state', () => {
    it('starts with chooser view for deposit mode', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      expect(result.current.mode).toBe('deposit')
      expect(result.current.currentView).toBe('chooser')
      expect(result.current.amountSats).toBe(0)
    })

    it('starts with chooser view for withdraw mode', () => {
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      expect(result.current.mode).toBe('withdraw')
      expect(result.current.currentView).toBe('chooser')
    })

    it('populates mints from wallet store', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      expect(result.current.mints).toHaveLength(1)
      expect(result.current.mints[0].url).toBe('http://localhost:3338')
    })
  })

  describe('onSelectMethod', () => {
    it('navigates to deposit-lightning when selecting lightning in deposit mode', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('lightning'))
      expect(result.current.currentView).toBe('deposit-lightning')
    })

    it('navigates to deposit-ecash when selecting ecash in deposit mode', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      expect(result.current.currentView).toBe('deposit-ecash')
    })

    it('navigates to send-ecash when selecting ecash in withdraw mode', () => {
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      expect(result.current.currentView).toBe('send-ecash')
    })

    it('navigates to pay-lightning when selecting lightning in withdraw mode', () => {
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('lightning'))
      expect(result.current.currentView).toBe('pay-lightning')
    })
  })

  describe('onNumpadPress', () => {
    it('builds amount from digit presses', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('0'))
      act(() => result.current.onNumpadPress('0'))
      expect(result.current.amountSats).toBe(100)
    })

    it('removes last digit on backspace', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('2'))
      act(() => result.current.onNumpadPress('3'))
      act(() => result.current.onNumpadPress('backspace'))
      expect(result.current.amountSats).toBe(12)
    })

    it('stays at 0 when backspacing from 0', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onNumpadPress('backspace'))
      expect(result.current.amountSats).toBe(0)
    })

    it('backspace on single digit returns to 0', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onNumpadPress('5'))
      act(() => result.current.onNumpadPress('backspace'))
      expect(result.current.amountSats).toBe(0)
    })

    it('prevents leading zeros', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onNumpadPress('0'))
      expect(result.current.amountSats).toBe(0)
      act(() => result.current.onNumpadPress('0'))
      expect(result.current.amountSats).toBe(0)
    })
  })

  describe('onToggleCurrency', () => {
    it('toggles showFiatPrimary', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      expect(result.current.showFiatPrimary).toBe(false)
      act(() => result.current.onToggleCurrency())
      expect(result.current.showFiatPrimary).toBe(true)
      act(() => result.current.onToggleCurrency())
      expect(result.current.showFiatPrimary).toBe(false)
    })
  })

  describe('onBack', () => {
    it('returns to chooser view', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('lightning'))
      expect(result.current.currentView).toBe('deposit-lightning')
      act(() => result.current.onBack())
      expect(result.current.currentView).toBe('chooser')
    })

    it('clears error on back', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      // Trigger scan to set an error
      act(() => result.current.onScan())
      expect(result.current.error).not.toBeNull()
      act(() => result.current.onBack())
      expect(result.current.error).toBeNull()
    })
  })

  describe('onClose', () => {
    it('calls onDismiss', () => {
      const dismiss = vi.fn()
      const { result } = renderHook(() => useDepositWithdrawState('deposit', dismiss))
      act(() => result.current.onClose())
      expect(dismiss).toHaveBeenCalledOnce()
    })
  })

  describe('deferred features', () => {
    it('onScan sets "coming soon" error', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onScan())
      expect(result.current.error).toMatch(/coming soon/i)
    })

    it('onScanQR sets "coming soon" error', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onScanQR())
      expect(result.current.error).toMatch(/coming soon/i)
    })

    it('onRequest sets "coming soon" error', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onRequest())
      expect(result.current.error).toMatch(/coming soon/i)
    })
  })

  describe('onMintChange', () => {
    it('updates selectedMintId', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onMintChange('another-mint'))
      expect(result.current.selectedMintId).toBe('another-mint')
    })
  })

  describe('onLightningInputChange', () => {
    it('updates lightningInput for non-invoice text', async () => {
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      await act(async () => {
        await result.current.onLightningInputChange('some-text')
      })
      expect(result.current.lightningInput).toBe('some-text')
    })

    it('auto-creates melt quote when bolt11 invoice is entered', async () => {
      const cashu = await import('@/lib/cashu')
      const mockQuote = { quote: 'q1', amount: 1000, fee_reserve: 10, state: 'UNPAID', expiry: 0, payment_preimage: null }
      vi.mocked(cashu.createMeltQuote).mockResolvedValueOnce(mockQuote as never)

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      // First navigate to pay-lightning view (bolt11 detection only fires from input change)
      act(() => result.current.onSelectMethod('lightning'))
      expect(result.current.currentView).toBe('pay-lightning')

      await act(async () => {
        await result.current.onLightningInputChange('lnbc100n1pexample')
      })
      expect(result.current.lightningInput).toBe('lnbc100n1pexample')
      expect(cashu.createMeltQuote).toHaveBeenCalledWith('lnbc100n1pexample', expect.any(String))
      expect(result.current.currentView).toBe('melt-confirm')
    })
  })
})
