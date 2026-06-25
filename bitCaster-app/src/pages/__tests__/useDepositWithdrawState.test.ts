import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Amount } from '@cashu/cashu-ts'
import { useDepositWithdrawState } from '../useDepositWithdrawState'
import { useWalletStore } from '@/stores/wallet'
import { useActivityLogStore } from '@/stores/activity-log'

// Mock cashu.ts — we don't want real mint calls
vi.mock('@/lib/cashu', () => ({
  createMintQuote: vi.fn(),
  mintProofs: vi.fn(),
  encodeToken: vi.fn().mockReturnValue('cashuAtoken123'),
  sendProofs: vi.fn().mockResolvedValue({ keep: [], send: [{ secret: 's1', amount: 100 }] }),
  createMeltQuote: vi.fn(),
  meltProofs: vi.fn(),
  spendRegularSatsAsToken: vi.fn().mockResolvedValue('cashuAtoken123'),
  waitForMintQuotePaid: vi.fn(),
}))

vi.mock('@/lib/walletOps', () => ({
  ingressReceiveCashuToken: vi.fn().mockResolvedValue({
    added: false,
    mintUrl: 'http://localhost:8085',
    source: 'paste',
    unit: 'sat',
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
  useActivityLogStore.getState().clear()
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
    it('updates selectedMintId for a registered mint', () => {
      useWalletStore.setState({
        mints: [
          { url: 'http://localhost:8085', info: { name: 'Test Mint' } },
          { url: 'http://localhost:8086', info: { name: 'Second Mint' } },
        ],
      })
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onMintChange('http://localhost:8086'))
      expect(result.current.selectedMintId).toBe('http://localhost:8086')
    })

    it('falls back to the active mint when the selected mint is no longer registered', () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onMintChange('unknown-mint'))
      expect(result.current.selectedMintId).toBe('http://localhost:8085')
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
      expect(cashu.createMintQuote).toHaveBeenCalledWith(1000, 'http://localhost:8085', 'sat')
      expect(cashu.waitForMintQuotePaid).toHaveBeenCalledWith(
        quote,
        expect.any(Function),
        expect.any(Object),
        'http://localhost:8085',
        'sat',
      )
      expect(result.current.invoiceExpiresAtSec).toBe(quote.expiry)
    })

    it('uses the selected advertised unit for Lightning deposit quotes', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.createMintQuote).mockClear()
      vi.mocked(cashu.waitForMintQuotePaid).mockClear()
      useWalletStore.setState({
        mints: [{
          url: 'http://localhost:8085',
          info: { name: 'Test Mint' },
          keysets: [
            { id: 'sat-keyset', unit: 'sat', active: true },
            { id: 'usd-keyset', unit: 'usd', active: true },
          ] as never,
        }],
      })
      const quote = {
        quote: 'q-usd',
        request: 'lnbc10u1pjexample',
        unit: 'usd',
        amount: 100,
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 90,
      }
      vi.mocked(cashu.createMintQuote).mockResolvedValue(quote as never)
      vi.mocked(cashu.waitForMintQuotePaid).mockResolvedValue(() => {})

      const { result } = renderHook(() => useDepositWithdrawState('deposit', vi.fn()))
      act(() => result.current.onUnitChange('usd'))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('0'))
      act(() => result.current.onNumpadPress('0'))
      await act(async () => { await result.current.onCreateInvoice() })

      expect(cashu.createMintQuote).toHaveBeenCalledWith(100, 'http://localhost:8085', 'usd')
      expect(cashu.waitForMintQuotePaid).toHaveBeenCalledWith(
        quote,
        expect.any(Function),
        expect.any(Object),
        'http://localhost:8085',
        'usd',
      )
      expect(result.current.amountLabel).toBe('$1.00')
      expect(result.current.invoiceRateInfo).toEqual({
        label: '10 sat/cent',
        source: 'implied',
      })
    })

    it('stores paid sat deposits in activity-log subunits while the input label remains sats', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.createMintQuote).mockClear()
      vi.mocked(cashu.waitForMintQuotePaid).mockClear()
      vi.mocked(cashu.mintProofs).mockResolvedValueOnce([])
      const quote = {
        quote: 'q-sat',
        request: 'lnbc1000n1example',
        amount: Amount.from(10_000),
        unit: 'sat',
        state: 'UNPAID',
        expiry: Math.floor(Date.now() / 1000) + 90,
      }
      vi.mocked(cashu.createMintQuote).mockResolvedValue(quote as never)
      vi.mocked(cashu.waitForMintQuotePaid).mockResolvedValue(() => {})

      const { result } = renderHook(() => useDepositWithdrawState('deposit', vi.fn()))
      act(() => result.current.onSelectMethod('lightning'))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('0'))

      expect(result.current.amountLabel).toBe('₿10')
      await act(async () => { await result.current.onCreateInvoice() })
      const paidCallback = vi.mocked(cashu.waitForMintQuotePaid).mock.calls[0][1]
      await act(async () => { paidCallback({ status: 'PAID', quote: { ...quote, state: 'PAID' } }) })

      expect(useActivityLogStore.getState().items[0]).toEqual(expect.objectContaining({
        type: 'deposit',
        baseAsset: 'sat',
        amountSats: 10_000,
        status: 'completed',
      }))
      expect(result.current.successAmount).toBe(10_000)
    })

    it('regenerate discards the cached quote and one-click requests a fresh one', async () => {
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

      // One-click re-quote: regenerate discards the cached quote and
      // immediately requests a fresh one — no extra Create Invoice click.
      await act(async () => { result.current.onRegenerateInvoice() })
      expect(cashu.createMintQuote).toHaveBeenCalledTimes(2)
      expect(result.current.currentView).toBe('invoice-display')
    })
  })

  describe('onPaste — ecash from unknown mint', () => {
    it('routes redemption through walletOps and stores the returned proofs', async () => {
      const walletOps = await import('@/lib/walletOps')
      const proofDb = await import('@/stores/proof-db')
      vi.mocked(proofDb.addProofs).mockClear()
      vi.mocked(walletOps.ingressReceiveCashuToken).mockResolvedValueOnce({
        added: true,
        mintUrl: 'https://testnut.cashu.space',
        source: 'paste',
        unit: 'sat',
        amountSats: 50,
        proofs: [{
          secret: 's-new',
          amount: 50,
          id: 'kid-B',
          C: 'C',
          conditionId: 'condition-1',
          outcomeCollection: 'B',
          marketId: 'condition-1-B',
        } as never],
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
      expect(proofDb.addProofs).toHaveBeenCalledWith([
        expect.objectContaining({
          mintUrl: 'https://testnut.cashu.space',
          baseAsset: 'sat',
          conditionId: 'condition-1',
          outcomeCollection: 'B',
          marketId: 'condition-1-B',
        }),
      ])
    })

    it('stores a USD token under the usd asset silo and records activity as usd', async () => {
      const walletOps = await import('@/lib/walletOps')
      const proofDb = await import('@/stores/proof-db')
      vi.mocked(proofDb.addProofs).mockClear()
      vi.mocked(walletOps.ingressReceiveCashuToken).mockResolvedValueOnce({
        added: false,
        mintUrl: 'https://usd.mint',
        source: 'paste',
        unit: 'usd',
        amountSats: 23,
        proofs: [{ secret: 's-usd', amount: 23, id: 'usd-kid', C: 'C' } as never],
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue('cashuB-usd-token') },
      })

      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      await act(async () => { await result.current.onPaste() })

      // The proof must land in the usd silo, not sat
      expect(proofDb.addProofs).toHaveBeenCalledWith([
        expect.objectContaining({ baseAsset: 'usd' }),
      ])
      // Success state must reflect the token's unit
      expect(result.current.successUnit).toBe('usd')
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

  describe('sat-only withdraw paths', () => {
    it('selects sat base proofs when sending ecash', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.spendRegularSatsAsToken).mockClear()

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onNumpadPress('5'))
      act(() => result.current.onNumpadPress('0'))

      await act(async () => { await result.current.onSendEcash() })

      expect(cashu.spendRegularSatsAsToken).toHaveBeenCalledWith(
        50,
        'http://localhost:8085',
      )
    })

    it('selects sat base proofs when paying lightning', async () => {
      const proofDb = await import('@/stores/proof-db')
      const cashu = await import('@/lib/cashu')
      vi.mocked(proofDb.getBaseProofs).mockClear()
      vi.mocked(cashu.createMeltQuote).mockResolvedValueOnce({
        quote: 'q1',
        amount: 1000,
        fee_reserve: 10,
        state: 'UNPAID',
        expiry: 0,
        payment_preimage: null,
      } as never)
      vi.mocked(cashu.meltProofs).mockResolvedValueOnce({ paid: true, change: [] } as never)

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('lightning'))
      await act(async () => {
        await result.current.onLightningInputChange('lnbc100n1pexample')
      })
      await act(async () => { await result.current.onConfirmMelt() })

      expect(proofDb.getBaseProofs).toHaveBeenCalledWith(
        'http://localhost:8085',
        { baseAsset: 'sat' },
      )
      expect(cashu.meltProofs).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Array),
        'http://localhost:8085',
      )
    })
  })
})
