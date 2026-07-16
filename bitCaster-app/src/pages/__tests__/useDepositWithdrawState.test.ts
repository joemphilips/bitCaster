import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Amount, getEncodedTokenV4 } from '@cashu/cashu-ts'
import { createCashuNut16Encoder } from '@bitcaster/client-sdk/cashuNut16'
import { useDepositWithdrawState } from '../useDepositWithdrawState'
import { useWalletStore } from '@/stores/wallet'
import { useActivityLogStore } from '@/stores/activity-log'

const prepareGuiLightningMint = vi.fn().mockResolvedValue({
  walletId: '0'.repeat(64),
  operationId: 'wallet-mint:test',
  mintUrl: 'http://localhost:8085',
  unit: 'sat',
})
const completeGuiLightningMint = vi.fn().mockResolvedValue([])
const addProofs = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const cancellationMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  cancel: vi.fn(),
  findPendingReapproval: vi.fn(),
}))

vi.mock('@/stores/gui-ordinary-wallet-operation', () => ({
  prepareGuiLightningMint: (...args: unknown[]) => prepareGuiLightningMint(...args),
  completeGuiLightningMint: (...args: unknown[]) => completeGuiLightningMint(...args),
}))

vi.mock('@/stores/gui-bearer-spend-cancellation', () => ({
  inspectGuiBearerSpendCancellation: cancellationMocks.inspect,
  cancelGuiBearerSpend: cancellationMocks.cancel,
  findPendingGuiBearerSpendReapproval: cancellationMocks.findPendingReapproval,
}))

// Mock cashu.ts — we don't want real mint calls
vi.mock('@/lib/cashu', () => ({
  createMintQuote: vi.fn(),
  mintProofs: vi.fn(),
  encodeToken: vi.fn().mockReturnValue('cashuAtoken123'),
  createMeltQuote: vi.fn(),
  meltProofs: vi.fn(),
  spendRegularSatsAsToken: vi.fn().mockResolvedValue({
    operationId: 'wallet-send:test',
    token: 'cashuAtoken123',
  }),
  getPendingRegularSatsToken: vi.fn().mockResolvedValue(null),
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
  configureGuiWalletIdProvider: vi.fn(),
  currentGuiWalletId: vi.fn(() => '0'.repeat(64)),
  db: {
    proofs: {
      toArray: vi.fn().mockResolvedValue([]),
      where: vi.fn().mockReturnThis(),
      equals: vi.fn().mockReturnThis(),
    },
  },
  getProofs: vi.fn().mockResolvedValue([
    {
      secret: 's1',
      amount: 100,
      mintUrl: 'http://localhost:8085',
      id: 'id1',
      C: 'C1',
    },
  ]),
  getUnitProofs: vi.fn().mockResolvedValue([
    {
      secret: 's1',
      amount: 100,
      mintUrl: 'http://localhost:8085',
      id: 'id1',
      C: 'C1',
    },
  ]),
  isCtfProof: vi.fn().mockReturnValue(false),
  addProofs,
  removeProofs: vi.fn().mockResolvedValue(undefined),
}))

// Mock dexie-react-hooks — useLiveQuery returns balances keyed by mint URL
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: vi.fn((_query: unknown, _dependencies: unknown, defaultResult: unknown) =>
    defaultResult === null ? true : { 'http://localhost:8085': 5000 },
  ),
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
  prepareGuiLightningMint.mockClear()
  completeGuiLightningMint.mockClear()
  addProofs.mockClear()
  cancellationMocks.inspect.mockReset()
  cancellationMocks.cancel.mockReset()
  cancellationMocks.findPendingReapproval.mockReset().mockResolvedValue(null)
  useActivityLogStore.getState().clear()
  useWalletStore.setState({
    mnemonic: 'test words here abandon abandon abandon abandon abandon abandon abandon abandon abandon',
    setupComplete: true,
    mints: [{ url: 'http://localhost:8085', info: { name: 'Test Mint' } }],
    activeMintUrl: 'http://localhost:8085',
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
      await act(async () => {
        await result.current.onRequest()
      })
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
      await act(async () => {
        await result.current.onScanResult('random-text')
      })
      expect(result.current.error).toMatch(/unrecognized/i)
    })

    it('keeps scanning NUT-16 fragments and imports only the complete token', async () => {
      const walletOps = await import('@/lib/walletOps')
      const receive = vi.mocked(walletOps.ingressReceiveCashuToken)
      receive.mockClear()
      receive.mockResolvedValueOnce({
        added: false,
        mintUrl: 'https://mint.example',
        source: 'scan',
        unit: 'sat',
        amountSats: 8,
        proofs: [],
      })
      const token = getEncodedTokenV4({
        mint: 'https://mint.example',
        unit: 'sat',
        proofs: Array.from({ length: 8 }, (_, index) => ({
          id: '0011223344556677',
          amount: Amount.from(1),
          secret: index.toString(16).padStart(64, '0'),
          C: `02${(index + 1).toString(16).padStart(64, '0')}`,
        })),
      })
      const encoder = createCashuNut16Encoder(token)
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onScan())

      for (let index = 0; index < encoder.fragmentCount; index += 1) {
        let disposition: 'continue' | 'complete' | undefined
        await act(async () => {
          disposition = await result.current.onScanResult(encoder.nextPart())
        })
        expect(disposition, result.current.error ?? undefined).toBe(
          index === encoder.fragmentCount - 1 ? 'complete' : 'continue',
        )
        expect(receive).toHaveBeenCalledTimes(index === encoder.fragmentCount - 1 ? 1 : 0)
      }
      expect(receive).toHaveBeenCalledWith(token, 'scan')
      expect(result.current.currentView).toBe('success')
      expect(result.current.scanProgress).toBeNull()
    })
  })

  describe('bearer cancellation', () => {
    it('requires a disclosed preview before reclaiming the exact operation', async () => {
      const preview = {
        operationId: 'wallet-send:test',
        deliveryId: 'delivery:test',
        mintUrl: 'http://localhost:8085',
        amount: 10,
        fee: 1,
        returnedAmount: 9,
        proofCount: 1,
        partial: false,
        fingerprint: 'ab'.repeat(32),
      }
      cancellationMocks.inspect.mockResolvedValueOnce(preview)
      cancellationMocks.cancel.mockResolvedValueOnce({
        kind: 'completed',
        preview,
        returnedProofs: [],
      })
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onNumpadPress('1'))
      act(() => result.current.onNumpadPress('0'))
      await act(async () => {
        await result.current.onSendEcash()
      })

      await act(async () => {
        await result.current.onInspectEcashCancellation()
      })
      expect(cancellationMocks.inspect).toHaveBeenCalledWith('wallet-send:test')
      expect(result.current.ecashCancellationPreview).toEqual(preview)

      await act(async () => {
        await result.current.onConfirmEcashCancellation()
      })
      expect(cancellationMocks.cancel).toHaveBeenCalledWith('wallet-send:test', preview.fingerprint)
      expect(result.current.currentView).toBe('success')
      expect(result.current.successAmount).toBe(9)
      expect(result.current.ecashToken).toBeNull()
    })

    it('requires reapproval when the exact proof subset or fee changes', async () => {
      const first = {
        operationId: 'wallet-send:test',
        deliveryId: 'delivery:test',
        mintUrl: 'http://localhost:8085',
        amount: 10,
        fee: 1,
        returnedAmount: 9,
        proofCount: 1,
        partial: false,
        fingerprint: 'ab'.repeat(32),
      }
      const changed = {
        ...first,
        amount: 8,
        returnedAmount: 7,
        partial: true,
        fingerprint: 'cd'.repeat(32),
      }
      cancellationMocks.inspect.mockResolvedValueOnce(first)
      cancellationMocks.cancel.mockResolvedValueOnce({
        kind: 'changed',
        preview: changed,
      })
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onNumpadPress('1'))
      await act(async () => {
        await result.current.onSendEcash()
      })
      await act(async () => {
        await result.current.onInspectEcashCancellation()
      })
      await act(async () => {
        await result.current.onConfirmEcashCancellation()
      })

      expect(result.current.currentView).toBe('token-display')
      expect(result.current.ecashCancellationPreview).toEqual(changed)
      expect(result.current.ecashToken).toBeNull()
      expect(result.current.error).toMatch(/review the updated return amount/i)
    })

    it('hides the cached token when inspection finds a partial spend', async () => {
      cancellationMocks.inspect.mockResolvedValueOnce({
        operationId: 'wallet-send:test',
        deliveryId: 'delivery:test',
        mintUrl: 'http://localhost:8085',
        amount: 8,
        fee: 1,
        returnedAmount: 7,
        proofCount: 1,
        partial: true,
        fingerprint: 'cd'.repeat(32),
      })
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onNumpadPress('1'))
      await act(async () => result.current.onSendEcash())
      expect(result.current.ecashToken).toBe('cashuAtoken123')

      await act(async () => result.current.onInspectEcashCancellation())

      expect(result.current.ecashToken).toBeNull()
    })

    it('fails closed in memory when cancellation inspection is indeterminate', async () => {
      cancellationMocks.inspect.mockRejectedValueOnce(new Error('mint unavailable'))
      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onNumpadPress('1'))
      await act(async () => result.current.onSendEcash())

      await act(async () => result.current.onInspectEcashCancellation())

      expect(result.current.ecashToken).toBeNull()
      expect(result.current.error).toMatch(/mint unavailable/)
    })
  })

  describe('request feature', () => {
    it('onRequest creates payment request and shows display', async () => {
      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      await act(async () => {
        await result.current.onRequest()
      })
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

    it('does not expose the invoice before the exact mint plan commits', async () => {
      const cashu = await import('@/lib/cashu')
      const quote = {
        quote: 'q-before-display',
        request: 'lnbc1hidden',
        amount: 1,
        state: 'UNPAID',
      }
      vi.mocked(cashu.createMintQuote).mockResolvedValueOnce(quote as never)
      vi.mocked(cashu.waitForMintQuotePaid).mockResolvedValueOnce(() => {})
      let releasePlan!: (plan: unknown) => void
      prepareGuiLightningMint.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePlan = resolve
          }),
      )
      const { result } = renderHook(() => useDepositWithdrawState('deposit', vi.fn()))
      act(() => result.current.onSelectMethod('lightning'))
      act(() => result.current.onNumpadPress('1'))

      act(() => {
        result.current.onCreateInvoice()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(result.current.currentView).toBe('deposit-lightning')
      expect(result.current.bolt11).toBeNull()

      await act(async () => {
        releasePlan({
          walletId: '0'.repeat(64),
          operationId: 'wallet-mint:q-before-display',
          mintUrl: 'http://localhost:8085',
          unit: 'sat',
        })
        await Promise.resolve()
      })
      expect(result.current.currentView).toBe('invoice-display')
      expect(result.current.bolt11).toBe('lnbc1hidden')
    })

    it('uses the selected advertised unit for Lightning deposit quotes', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.createMintQuote).mockClear()
      vi.mocked(cashu.waitForMintQuotePaid).mockClear()
      useWalletStore.setState({
        mints: [
          {
            url: 'http://localhost:8085',
            info: { name: 'Test Mint' },
            keysets: [
              { id: 'sat-keyset', unit: 'sat', active: true },
              { id: 'usd-keyset', unit: 'usd', active: true },
            ] as never,
          },
        ],
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
      await act(async () => {
        await result.current.onCreateInvoice()
      })

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

    it('leaves paid deposit activity to the durable operation projection', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.createMintQuote).mockClear()
      vi.mocked(cashu.waitForMintQuotePaid).mockClear()
      completeGuiLightningMint.mockResolvedValueOnce([])
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
      await act(async () => {
        await result.current.onCreateInvoice()
      })
      const paidCallback = vi.mocked(cashu.waitForMintQuotePaid).mock.calls[0][1]
      await act(async () => {
        paidCallback({ status: 'PAID', quote: { ...quote, state: 'PAID' } })
      })

      expect(completeGuiLightningMint).toHaveBeenCalledOnce()
      expect(useActivityLogStore.getState().items).toEqual([])
      expect(result.current.successAmount).toBe(10_000)
      expect(addProofs).not.toHaveBeenCalled()
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

      await act(async () => {
        await result.current.onCreateInvoice()
      })
      expect(cashu.createMintQuote).toHaveBeenCalledTimes(1)

      // One-click re-quote: regenerate discards the cached quote and
      // immediately requests a fresh one — no extra Create Invoice click.
      await act(async () => {
        result.current.onRegenerateInvoice()
      })
      expect(cashu.createMintQuote).toHaveBeenCalledTimes(2)
      expect(result.current.currentView).toBe('invoice-display')
    })
  })

  describe('onPaste — ecash from unknown mint', () => {
    it('routes redemption through walletOps whose coordinator stores the proofs', async () => {
      const walletOps = await import('@/lib/walletOps')
      vi.mocked(walletOps.ingressReceiveCashuToken).mockResolvedValueOnce({
        added: true,
        mintUrl: 'https://testnut.cashu.space',
        source: 'paste',
        unit: 'sat',
        amountSats: 50,
        proofs: [
          {
            secret: 's-new',
            amount: 50,
            id: 'kid-B',
            C: 'C',
            conditionId: 'condition-1',
            outcomeCollection: 'B',
            marketId: 'condition-1-B',
          } as never,
        ],
      })
      // navigator.clipboard isn't in jsdom by default — install a stub.
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: vi.fn().mockResolvedValue('cashuB-token-from-unknown-mint'),
        },
      })

      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      expect(result.current.currentView).toBe('deposit-ecash')

      await act(async () => {
        await result.current.onPaste()
      })

      expect(walletOps.ingressReceiveCashuToken).toHaveBeenCalledWith('cashuB-token-from-unknown-mint', 'paste')
      expect(result.current.currentView).toBe('success')
      expect(result.current.successAmount).toBe(50)
      expect(result.current.error).toBeNull()
    })

    it('stores a USD token under the usd asset silo and records activity as usd', async () => {
      const walletOps = await import('@/lib/walletOps')
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
      await act(async () => {
        await result.current.onPaste()
      })

      // Success state must reflect the token's unit
      expect(result.current.successUnit).toBe('usd')
    })

    it('surfaces walletOps receive errors to the red banner without swallowing', async () => {
      const walletOps = await import('@/lib/walletOps')
      vi.mocked(walletOps.ingressReceiveCashuToken).mockRejectedValueOnce(new Error('Token already spent'))
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: vi.fn().mockResolvedValue('cashuB-spent') },
      })

      const { result } = renderHook(() => useDepositWithdrawState('deposit', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      await act(async () => {
        await result.current.onPaste()
      })

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
      const mockQuote = {
        quote: 'q1',
        amount: 1000,
        fee_reserve: 10,
        state: 'UNPAID',
        expiry: 0,
        payment_preimage: null,
      }
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
    it('restores a pending exported token without treating presentation as completion', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.getPendingRegularSatsToken).mockResolvedValueOnce({
        operationId: 'wallet-send:pending',
        amountSats: 21,
        mintUrl: 'http://localhost:8085',
        token: 'cashuApending',
      })

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      await waitFor(() => expect(result.current.currentView).toBe('token-display'))

      expect(result.current.ecashToken).toBe('cashuApending')
      expect(result.current.amountSats).toBe(21)
      expect(result.current).not.toHaveProperty('onEcashTokenSavedOrShared')
    })

    it('restores pending reclaim reapproval without redisplaying the token', async () => {
      const preview = {
        operationId: 'wallet-send:reapproval',
        deliveryId: 'delivery:reapproval',
        mintUrl: 'http://localhost:8085',
        amount: 18,
        fee: 1,
        returnedAmount: 17,
        proofCount: 2,
        partial: true,
        fingerprint: 'ef'.repeat(32),
      }
      cancellationMocks.findPendingReapproval.mockResolvedValueOnce({
        operationId: preview.operationId,
        preview,
      })

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      await waitFor(() => expect(result.current.currentView).toBe('token-display'))

      expect(result.current.ecashToken).toBeNull()
      expect(result.current.ecashCancellationPreview).toEqual(preview)
      expect(result.current.amountSats).toBe(18)
    })

    it('selects sat base proofs when sending ecash', async () => {
      const cashu = await import('@/lib/cashu')
      vi.mocked(cashu.spendRegularSatsAsToken).mockClear()

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('ecash'))
      act(() => result.current.onNumpadPress('5'))
      act(() => result.current.onNumpadPress('0'))

      await act(async () => {
        await result.current.onSendEcash()
      })

      expect(cashu.spendRegularSatsAsToken).toHaveBeenCalledWith(50, 'http://localhost:8085')
    })

    it('selects sat base proofs when paying lightning', async () => {
      const proofDb = await import('@/stores/proof-db')
      const cashu = await import('@/lib/cashu')
      vi.mocked(proofDb.getUnitProofs).mockClear()
      vi.mocked(cashu.createMeltQuote).mockResolvedValueOnce({
        quote: 'q1',
        amount: 1000,
        fee_reserve: 10,
        state: 'UNPAID',
        expiry: 0,
        payment_preimage: null,
      } as never)
      vi.mocked(cashu.meltProofs).mockResolvedValueOnce({
        paid: true,
        change: [],
      } as never)

      const { result } = renderHook(() => useDepositWithdrawState('withdraw', onDismiss))
      act(() => result.current.onSelectMethod('lightning'))
      await act(async () => {
        await result.current.onLightningInputChange('lnbc100n1pexample')
      })
      await act(async () => {
        await result.current.onConfirmMelt()
      })

      expect(proofDb.getUnitProofs).toHaveBeenCalledWith('http://localhost:8085', { unit: 'sat' })
      expect(cashu.meltProofs).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), 'http://localhost:8085')
    })
  })
})
