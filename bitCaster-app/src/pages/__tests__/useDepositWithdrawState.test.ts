import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDepositWithdrawState } from '../useDepositWithdrawState'
import { useWalletStore } from '@/stores/wallet'

// Mock cashu.ts — we don't want real mint calls
vi.mock('@/lib/cashu', () => ({
  createMintQuote: vi.fn(),
  mintProofs: vi.fn(),
  encodeToken: vi.fn().mockReturnValue('cashuAtoken123'),
  sendProofs: vi.fn().mockResolvedValue({ keep: [], send: [{ secret: 's1', amount: 100 }] }),
  createMeltQuote: vi.fn(),
  meltProofs: vi.fn(),
  waitForMintQuotePaid: vi.fn(),
}))

vi.mock('@/lib/walletOps', () => ({
  ingressReceiveCashuToken: vi.fn().mockResolvedValue({
    added: false,
    mintUrl: 'http://localhost:8085',
    source: 'paste',
    amountSats: 0,
    proofs: [],
  }),
  userCreatePaymentRequest: vi.fn().mockReturnValue({
    encoded: 'creq1test',
    id: 'req1',
    request: {},
  }),
}))

// Mock proof-db
vi.mock('@/stores/proof-db', () => ({
  db: { proofs: { toArray: vi.fn().mockResolvedValue([]), where: vi.fn().mockReturnThis(), equals: vi.fn().mockReturnThis() } },
  getProofs: vi.fn().mockResolvedValue([{ secret: 's1', amount: 100, mintUrl: 'http://localhost:8085', id: 'id1', C: 'C1' }]),
  getBaseProofs: vi.fn().mockResolvedValue([{ secret: 's1', amount: 100, mintUrl: 'http://localhost:8085', id: 'id1', C: 'C1' }]),
  isCtfProof: vi.fn().mockReturnValue(false),
  addProofs: vi.fn().mockResolvedValue(undefined),
  removeProofs: vi.fn().mockResolvedValue(undefined),
}))

// Mock dexie-react-hooks — useLiveQuery returns balances keyed by mint URL
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: vi.fn().mockReturnValue({ 'http://localhost:8085': 5000 }),
}))

// Mock nip17 — we don't want real Nostr calls
vi.mock('@/lib/nip17', () => ({
  deriveNostrKeyPair: vi.fn().mockReturnValue({
    privateKey: new Uint8Array(32),
    privateKeyHex: '0'.repeat(64),
    publicKey: '1'.repeat(64),
  }),
  getNostrNprofile: vi.fn().mockReturnValue('nprofile1test'),
  subscribeNip17DMs: vi.fn().mockReturnValue(() => {}),
}))

beforeEach(() => {
  useWalletStore.setState({
    mnemonic: 'test words here abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    setupComplete: true,
    mints: [{ url: 'http://localhost:8085', info: { name: 'Test Mint' } }],
    activeMintUrl: 'http://localhost:8085',
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
      expect(result.current.mints[0].url).toBe('http://localhost:8085')
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

    it('returns from scanner to the previous view', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      expect(result.current.currentView).toBe('deposit-ecash')
      act(() => result.current.onScan())
      expect(result.current.currentView).toBe('scanner')
      act(() => result.current.onBack())
      expect(result.current.currentView).toBe('deposit-ecash')
    })

    it('returns from payment request to deposit-ecash', async () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      await act(async () => { await result.current.onRequest() })
      expect(result.current.currentView).toBe('payment-request-display')
      act(() => result.current.onBack())
      expect(result.current.currentView).toBe('deposit-ecash')
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

  describe('scan feature', () => {
    it('onScan navigates to scanner view', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onScan())
      expect(result.current.currentView).toBe('scanner')
    })

    it('onScanQR navigates to scanner view', () => {
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('lightning'))
      act(() => result.current.onScanQR())
      expect(result.current.currentView).toBe('scanner')
    })

    it('onScanResult with unknown data sets error', async () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onScan())
      await act(async () => { await result.current.onScanResult('random-text') })
      expect(result.current.error).toMatch(/unrecognized/i)
    })
  })

  describe('request feature', () => {
    it('onRequest creates payment request and shows display', async () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      await act(async () => { await result.current.onRequest() })
      expect(result.current.currentView).toBe('payment-request-display')
      expect(result.current.paymentRequestEncoded).toBeTruthy()
      expect(result.current.paymentRequestStatus).toBe('waiting')
    })
  })

  describe('onMintChange', () => {
    it('updates selectedMintId', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onMintChange('another-mint'))
      expect(result.current.selectedMintId).toBe('another-mint')
    })
  })

  describe('onCreateInvoice — re-mount idempotency', () => {
    // Regression for the P8 "Invoice already paid or pending" snackbar:
    // calling onCreateInvoice twice within a single open MUST reuse the cached
    // mint quote and only call the mint's createMintQuote once. A double-fire
    // is the signature of the bug — duplicate quotes against the same mint
    // state make LNBits return the literal "Invoice already paid or pending".
    it('issues exactly one mint quote across rapid double-fires', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.createMintQuote).mockClear()
      vi.mocked(cashu.waitForMintQuotePaid).mockClear()
      const quote = {
        quote: 'q1',
        request: 'lnbc1...',
        amount: 1000,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }
      vi.mocked(cashu.createMintQuote).mockResolvedValue(quote as never)
      vi.mocked(cashu.waitForMintQuotePaid).mockResolvedValue(() => {})

      const { result } = renderHook(() => useDepositWithdrawState('deposit', vi.fn()))
      act(() => result.current.onSelectMethod('lightning'))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('0'))
      act(() => result.current.onNumpadPress('0'))
      act(() => result.current.onNumpadPress('0'))

      // Fire twice as quickly as a user could double-click.
      await act(async () => {
        result.current.onCreateInvoice()
        result.current.onCreateInvoice()
      })

      expect(cashu.createMintQuote).toHaveBeenCalledTimes(1)
      expect(result.current.invoiceExpiresAtSec).toBe(quote.expiry)
    })

    it('regenerate clears the cached quote so the next create issues a fresh one', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.createMintQuote).mockClear()
      vi.mocked(cashu.waitForMintQuotePaid).mockClear()
      const quote = {
        quote: 'q1',
        request: 'lnbc1...',
        amount: 1000,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }
      vi.mocked(cashu.createMintQuote).mockResolvedValue(quote as never)
      vi.mocked(cashu.waitForMintQuotePaid).mockResolvedValue(() => {})

      const { result } = renderHook(() => useDepositWithdrawState('deposit', vi.fn()))
      act(() => result.current.onSelectMethod('lightning'))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('0'))
      act(() => result.current.onNumpadPress('0'))
      act(() => result.current.onNumpadPress('0'))

      await act(async () => { await result.current.onCreateInvoice() })
      expect(cashu.createMintQuote).toHaveBeenCalledTimes(1)

      act(() => result.current.onRegenerateInvoice())
      // currentView is back at the lightning entry; quote ref cleared.
      await act(async () => { await result.current.onCreateInvoice() })
      expect(cashu.createMintQuote).toHaveBeenCalledTimes(2)
    })
  })

  describe('onPaste — ecash from unknown mint', () => {
    it('routes redemption through walletOps and stores the returned proofs', async () => {
      const walletOps = await import('@/lib/walletOps')
      vi.mocked(walletOps.ingressReceiveCashuToken).mockResolvedValueOnce({
        added: true,
        mintUrl: 'https://testnut.cashu.space',
        source: 'paste',
        amountSats: 50,
        proofs: [{ secret: 's-new', amount: 50, id: 'kid', C: 'C' } as never],
      })
      // navigator.clipboard isn't in jsdom by default — install a stub.
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue('cashuB-token-from-unknown-mint') },
      })

      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      expect(result.current.currentView).toBe('deposit-ecash')

      await act(async () => { await result.current.onPaste() })

      expect(walletOps.ingressReceiveCashuToken).toHaveBeenCalledWith(
        'cashuB-token-from-unknown-mint',
        'paste'
      )
      expect(result.current.currentView).toBe('success')
      expect(result.current.successAmount).toBe(50)
      expect(result.current.error).toBeNull()
    })

    it('surfaces walletOps receive errors to the red banner without swallowing', async () => {
      const walletOps = await import('@/lib/walletOps')
      vi.mocked(walletOps.ingressReceiveCashuToken).mockRejectedValueOnce(
        new Error('Token already spent')
      )
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue('cashuB-spent') },
      })

      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      await act(async () => { await result.current.onPaste() })

      expect(result.current.error).toBe('Token already spent')
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
