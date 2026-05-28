import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  DepositWithdrawMode,
  DepositWithdrawView,
  MethodType,
  MintInfo,
} from '@/types/deposit-withdraw'
import type { MeltQuoteResponse, MintQuoteResponse } from '@cashu/cashu-ts'
import { useWalletStore } from '@/stores/wallet'
import { useActivityLogStore } from '@/stores/activity-log'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/stores/proof-db'
import {
  createMintQuote,
  mintProofs,
  encodeToken,
  sendProofs,
  createMeltQuote,
  meltProofs,
  waitForMintQuotePaid,
  type MintQuoteWaitResult,
} from '@/lib/cashu'
import {
  ingressReceiveCashuToken,
  userCreatePaymentRequest,
  type IngressReceiveCashuTokenResult,
} from '@/lib/walletOps'
import { useToastStore } from '@/stores/toast'
import {
  getBaseProofs,
  addProofs,
  removeProofs,
  isCtfProof,
  type StoredProof,
} from '@/stores/proof-db'
import { usePaymentRequestInbox } from '@/stores/paymentRequestInbox'
import { safeHostname } from '@/lib/url'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'

export type ExtendedView =
  | DepositWithdrawView
  | 'invoice-display'
  | 'token-display'
  | 'melt-confirm'
  | 'scanner'
  | 'payment-request-display'
  | 'success'

export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'error'

function assertNeverWaitResult(r: never): never {
  throw new Error(`unhandled MintQuoteWaitResult: ${JSON.stringify(r)}`)
}

export interface DepositWithdrawState {
  mode: DepositWithdrawMode
  currentView: ExtendedView
  mints: MintInfo[]
  selectedMintId: string
  amountSats: number
  amountFiat: string
  fiatSymbol: string
  showFiatPrimary: boolean
  lightningInput: string
  isLoading: boolean
  error: string | null

  // Result state
  bolt11: string | null
  invoiceStatus: InvoiceStatus
  /** Bolt11 expiry as unix-seconds. Drives the live countdown in the UI. */
  invoiceExpiresAtSec: number | undefined
  ecashToken: string | null
  meltQuote: MeltQuoteResponse | null
  meltIsPaying: boolean

  // Payment request state
  paymentRequestEncoded: string | null
  paymentRequestStatus: 'waiting' | 'received'

  // Success state
  successAmount: number

  // Handlers
  onSelectMethod: (method: MethodType) => void
  onNumpadPress: (key: string) => void
  onMintChange: (mintId: string) => void
  onToggleCurrency: () => void
  onCreateInvoice: () => void
  /** Discard the active mint quote and return to the amount entry view so the
   *  user can request a fresh invoice after expiry / failure. */
  onRegenerateInvoice: () => void
  onSendEcash: () => void
  onPaste: () => void
  onScan: () => void
  onRequest: () => void
  onScanQR: () => void
  onScanResult: (data: string) => void
  onLightningInputChange: (value: string) => void
  onConfirmMelt: () => void
  onBack: () => void
  onClose: () => void
}

/**
 * Surface a toast when ingress had to register an unknown mint before redeeming.
 * The actual wallet mutation lives in walletOps so untrusted input cannot call
 * the user-facing add-and-activate mint path by accident.
 */
function toastNewMintIfAdded(result: IngressReceiveCashuTokenResult): void {
  if (!result.added) return
  useToastStore.getState().addToast({
    message: `Added new mint: ${safeHostname(result.mintUrl)}`,
    type: 'info',
  })
}

export function useDepositWithdrawState(
  mode: DepositWithdrawMode,
  onDismiss: () => void
): DepositWithdrawState {
  const storeMints = useWalletStore((s) => s.mints)
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)

  // Reactive balances for all mints via a single live query
  const mintUrls = storeMints.map((m) => m.url)
  const balancesByMint = useLiveQuery(async () => {
    const proofs = await db.proofs.toArray()
    const map: Record<string, number> = {}
    for (const p of proofs.filter((proof) => !isCtfProof(proof))) {
      map[p.mintUrl] = (map[p.mintUrl] ?? 0) + amountToNumber(p.amount)
    }
    return map
  }, [mintUrls.join(',')], {} as Record<string, number>)

  // Build MintInfo[] from store mints with live balances
  const mintsWithBalance: MintInfo[] = storeMints.map((m) => ({
    id: m.url,
    name: (m.info as Record<string, unknown>)?.name as string ?? safeHostname(m.url),
    url: m.url,
    balanceSats: balancesByMint[m.url] ?? 0,
  }))

  const [currentView, setCurrentView] = useState<ExtendedView>('chooser')
  const [selectedMintId, setSelectedMintId] = useState(activeMintUrl)
  const [amountString, setAmountString] = useState('')
  const [showFiatPrimary, setShowFiatPrimary] = useState(false)
  const [lightningInput, setLightningInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Result state
  const [bolt11, setBolt11] = useState<string | null>(null)
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceStatus>('pending')
  const [invoiceExpiresAtSec, setInvoiceExpiresAtSec] = useState<number | undefined>()
  const [ecashToken, setEcashToken] = useState<string | null>(null)
  const [meltQuote, setMeltQuote] = useState<MeltQuoteResponse | null>(null)
  const [meltIsPaying, setMeltIsPaying] = useState(false)

  // Payment request state
  const [paymentRequestEncoded, setPaymentRequestEncoded] = useState<string | null>(null)
  const [paymentRequestStatus, setPaymentRequestStatus] = useState<'waiting' | 'received'>('waiting')

  // Success state
  const [successAmount, setSuccessAmount] = useState(0)

  // Track which view opened the scanner so we can process results correctly
  const scanReturnViewRef = useRef<ExtendedView>('deposit-ecash')

  // The full active quote (request, quote-id, expiry). Persisted across renders
  // so that re-clicking "Continue" — or a parent re-render in dev StrictMode —
  // does NOT issue a second mint quote against the same mint state, which is
  // what produces the LNBits "Invoice already paid or pending" passthrough.
  const mintQuoteRef = useRef<MintQuoteResponse | null>(null)
  // Synchronous double-click guard. `setIsLoading(true)` is one render late;
  // a rapid second click would otherwise create a second quote & leak the
  // first's polling subscription.
  const inflightRef = useRef(false)
  const unsubRef = useRef<(() => void) | null>(null)
  const userSelectedMintRef = useRef(false)

  // PaymentRequest id of the request currently displayed in the
  // "Waiting for payment…" view. A non-null value subscribes us to the
  // global inbox store so we react the moment a matching DM is redeemed —
  // even if the DM arrives before this hook mounted.
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null)
  const inboxEntry = usePaymentRequestInbox((s) =>
    pendingRequestId ? s.entries[pendingRequestId] : undefined
  )

  // Cleanup WebSocket/polling on unmount. The NIP-17 listener is
  // global (see App.tsx::startNip17Listener) so we do NOT stop it here.
  useEffect(() => {
    return () => {
      unsubRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (!activeMintUrl) return
    setSelectedMintId((current) => {
      if (!userSelectedMintRef.current) {
        return activeMintUrl
      }
      if (!current || !storeMints.some((mint) => mint.url === current)) {
        userSelectedMintRef.current = false
        return activeMintUrl
      }
      return current
    })
  }, [activeMintUrl, storeMints])

  // React to the global inbox flipping our pending request to "received".
  useEffect(() => {
    if (!pendingRequestId || !inboxEntry) return
    setPaymentRequestStatus('received')
    setSuccessAmount(inboxEntry.amountSats)
    const handle = setTimeout(() => {
      usePaymentRequestInbox.getState().clear(pendingRequestId)
      setPendingRequestId(null)
      onDismiss()
    }, 2000)
    return () => clearTimeout(handle)
  }, [pendingRequestId, inboxEntry, onDismiss])

  const amountSats = parseInt(amountString || '0', 10)

  const onSelectMethod = useCallback(
    (method: MethodType) => {
      if (mode === 'deposit') {
        setCurrentView(method === 'ecash' ? 'deposit-ecash' : 'deposit-lightning')
      } else {
        setCurrentView(method === 'ecash' ? 'send-ecash' : 'pay-lightning')
      }
    },
    [mode]
  )

  const onNumpadPress = useCallback((key: string) => {
    setAmountString((prev) => {
      if (key === 'backspace') {
        return prev.length <= 1 ? '' : prev.slice(0, -1)
      }
      // Prevent leading zeros
      if (prev === '' && key === '0') return ''
      return prev + key
    })
  }, [])

  const onMintChange = useCallback((mintId: string) => {
    userSelectedMintRef.current = true
    setSelectedMintId(mintId)
  }, [])

  const onToggleCurrency = useCallback(() => {
    setShowFiatPrimary((prev) => !prev)
  }, [])

  const handlePaidInvoice = useCallback(
    async (quote: MintQuoteResponse, mintUrl: string, requested: number) => {
      try {
        const proofs = await mintProofs(requested, quote, mintUrl)
        const stored: StoredProof[] = proofs.map((p) => ({ ...p, mintUrl }))
        await addProofs(stored)
        setInvoiceStatus('paid')
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          amountSats: requested,
          status: 'completed',
          lightningInvoice: quote.request,
        })
        setSuccessAmount(requested)
        setCurrentView('success')
      } catch (e) {
        setInvoiceStatus('error')
        setError((e as Error).message)
      }
    },
    []
  )

  const handleInvoiceWaitResult = useCallback(
    (r: MintQuoteWaitResult, quote: MintQuoteResponse, mintUrl: string, requested: number) => {
      switch (r.status) {
        case 'PAID':
          handlePaidInvoice(quote, mintUrl, requested)
          return
        case 'EXPIRED':
          setInvoiceStatus('expired')
          setError('The Lightning invoice expired before payment arrived.')
          return
        case 'ERROR':
          setInvoiceStatus('error')
          setError(r.error.message)
          return
        default:
          return assertNeverWaitResult(r)
      }
    },
    [handlePaidInvoice]
  )

  const onCreateInvoice = useCallback(async () => {
    if (amountSats <= 0) return
    if (inflightRef.current) return
    inflightRef.current = true
    setIsLoading(true)
    setError(null)
    setInvoiceStatus('pending')
    const requested = amountSats
    const mintUrl = selectedMintId
    try {
      await useWalletStore.getState().ensureImplicitWallet()
      // Re-mount idempotency: reuse the active quote if one exists, otherwise
      // request a fresh one. Prevents the duplicate-quote LNBits snackbar.
      const quote = mintQuoteRef.current ?? await createMintQuote(requested, mintUrl)
      mintQuoteRef.current = quote
      setBolt11(quote.request)
      setInvoiceExpiresAtSec(quote.expiry ?? undefined)
      setCurrentView('invoice-display')

      const unsub = await waitForMintQuotePaid(
        quote,
        (r) => handleInvoiceWaitResult(r, quote, mintUrl, requested),
        { onTransientError: (e) => setError(e.message) },
        mintUrl,
      )
      unsubRef.current = unsub
    } catch (e) {
      setInvoiceStatus('error')
      setError((e as Error).message)
      inflightRef.current = false
    } finally {
      setIsLoading(false)
    }
  }, [amountSats, selectedMintId, handleInvoiceWaitResult])

  const onRegenerateInvoice = useCallback(() => {
    unsubRef.current?.()
    unsubRef.current = null
    mintQuoteRef.current = null
    inflightRef.current = false
    setBolt11(null)
    setInvoiceExpiresAtSec(undefined)
    setInvoiceStatus('pending')
    setError(null)
    setCurrentView('deposit-lightning')
  }, [])

  const onPaste = useCallback(async () => {
    setError(null)
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return

      // Detect if it's an ecash token or a lightning invoice
      if (currentView === 'deposit-ecash') {
        setIsLoading(true)
        const received = await ingressReceiveCashuToken(text, 'paste')
        toastNewMintIfAdded(received)
        const stored: StoredProof[] = received.proofs.map((p) => ({
          ...p,
          mintUrl: received.mintUrl,
        }))
        await addProofs(stored)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          amountSats: received.amountSats,
          status: 'completed',
        })
        setIsLoading(false)
        setSuccessAmount(received.amountSats)
        setCurrentView('success')
      } else if (currentView === 'pay-lightning') {
        setLightningInput(text)
        // Auto-create melt quote if it looks like a bolt11 invoice
        if (text.toLowerCase().startsWith('lnbc') || text.toLowerCase().startsWith('lntb')) {
          setIsLoading(true)
          const quote = await createMeltQuote(text, selectedMintId)
          setMeltQuote(quote)
          setCurrentView('melt-confirm')
          setIsLoading(false)
        }
      }
    } catch (e) {
      setError((e as Error).message)
      setIsLoading(false)
    }
  }, [currentView, selectedMintId])

  const onSendEcash = useCallback(async () => {
    if (amountSats <= 0) return
    setIsLoading(true)
    setError(null)
    try {
      const proofs = await getBaseProofs(selectedMintId)
      const { keep, send } = await sendProofs(amountSats, proofs, selectedMintId)

      // Remove original proofs, add back the kept ones
      await removeProofs(proofs.map((p) => p.secret))
      const keptStored: StoredProof[] = keep.map((p) => ({
        ...p,
        mintUrl: selectedMintId,
      }))
      await addProofs(keptStored)

      const token = encodeToken(send, selectedMintId)
      setEcashToken(token)
      setCurrentView('token-display')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [amountSats, selectedMintId])

  const onLightningInputChange = useCallback(async (value: string) => {
    setLightningInput(value)
    // Auto-create melt quote when a bolt11 invoice is detected
    const trimmed = value.trim().toLowerCase()
    if (trimmed.startsWith('lnbc') || trimmed.startsWith('lntb')) {
      setIsLoading(true)
      setError(null)
      try {
        const quote = await createMeltQuote(value.trim(), selectedMintId)
        setMeltQuote(quote)
        setCurrentView('melt-confirm')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setIsLoading(false)
      }
    }
  }, [selectedMintId])

  const onConfirmMelt = useCallback(async () => {
    if (!meltQuote) return
    setMeltIsPaying(true)
    setError(null)
    try {
      const proofs = await getBaseProofs(selectedMintId)
      const { paid, change } = await meltProofs(meltQuote, proofs, selectedMintId)

      if (!paid) {
        setError('Payment failed')
        return
      }

      // Remove spent proofs, add change
      await removeProofs(proofs.map((p) => p.secret))
      if (change.length > 0) {
        const changeStored: StoredProof[] = change.map((p) => ({
          ...p,
          mintUrl: selectedMintId,
        }))
        await addProofs(changeStored)
      }

      useActivityLogStore.getState().addActivity({
        type: 'withdrawal',
        amountSats: amountToNumber(meltQuote.amount),
        status: 'completed',
        lightningInvoice: lightningInput,
      })
      setSuccessAmount(amountToNumber(meltQuote.amount))
      setCurrentView('success')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setMeltIsPaying(false)
    }
  }, [meltQuote, selectedMintId])

  const onScan = useCallback(() => {
    scanReturnViewRef.current = currentView
    setCurrentView('scanner')
  }, [currentView])

  const onScanResult = useCallback(async (data: string) => {
    setError(null)
    const trimmed = data.trim()

    // Detect cashu token
    if (trimmed.toLowerCase().startsWith('cashu')) {
      setIsLoading(true)
      try {
        const received = await ingressReceiveCashuToken(trimmed, 'scan')
        toastNewMintIfAdded(received)
        const stored: StoredProof[] = received.proofs.map((p) => ({
          ...p,
          mintUrl: received.mintUrl,
        }))
        await addProofs(stored)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          amountSats: received.amountSats,
          status: 'completed',
        })
        setSuccessAmount(received.amountSats)
        setCurrentView('success')
      } catch (e) {
        setError((e as Error).message)
        setCurrentView(scanReturnViewRef.current)
      } finally {
        setIsLoading(false)
      }
      return
    }

    // Detect bolt11 invoice
    if (trimmed.toLowerCase().startsWith('lnbc') || trimmed.toLowerCase().startsWith('lntb')) {
      setIsLoading(true)
      try {
        const quote = await createMeltQuote(trimmed, selectedMintId)
        setMeltQuote(quote)
        setLightningInput(trimmed)
        setCurrentView('melt-confirm')
      } catch (e) {
        setError((e as Error).message)
        setCurrentView(scanReturnViewRef.current)
      } finally {
        setIsLoading(false)
      }
      return
    }

    // Detect payment request
    if (trimmed.toLowerCase().startsWith('creq')) {
      // TODO: handle paying a scanned payment request
      setError('Paying payment requests from scan is not yet supported')
      setCurrentView(scanReturnViewRef.current)
      return
    }

    // Unknown format
    setError('Unrecognized QR code format')
    setCurrentView(scanReturnViewRef.current)
  }, [selectedMintId])

  const onRequest = useCallback(async () => {
    setError(null)

    try {
      const paymentRequest = userCreatePaymentRequest(selectedMintId)

      setPaymentRequestEncoded(paymentRequest.encoded)
      setPaymentRequestStatus('waiting')
      setCurrentView('payment-request-display')
      // Hand receive-detection off to the continuous listener. The
      // useEffect above flips status to 'received' when the global inbox
      // gets an entry keyed by this id.
      setPendingRequestId(paymentRequest.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [selectedMintId])

  const onBack = useCallback(() => {
    if (currentView === 'scanner') {
      setCurrentView(scanReturnViewRef.current)
    } else if (currentView === 'payment-request-display') {
      setPendingRequestId(null)
      setCurrentView('deposit-ecash')
    } else {
      setCurrentView('chooser')
    }
    setError(null)
  }, [currentView])

  const onClose = useCallback(() => {
    unsubRef.current?.()
    setPendingRequestId(null)
    onDismiss()
  }, [onDismiss])

  return {
    mode,
    currentView,
    mints: mintsWithBalance,
    selectedMintId,
    amountSats,
    amountFiat: '$0.00', // Fiat conversion not yet implemented
    fiatSymbol: '$',
    showFiatPrimary,
    lightningInput,
    isLoading,
    error,
    bolt11,
    invoiceStatus,
    invoiceExpiresAtSec,
    ecashToken,
    meltQuote,
    meltIsPaying,
    paymentRequestEncoded,
    paymentRequestStatus,
    successAmount,
    onSelectMethod,
    onNumpadPress,
    onMintChange,
    onToggleCurrency,
    onCreateInvoice,
    onRegenerateInvoice,
    onSendEcash,
    onPaste,
    onScan,
    onRequest,
    onScanQR: onScan,
    onScanResult,
    onLightningInputChange,
    onConfirmMelt,
    onBack,
    onClose,
  }
}
