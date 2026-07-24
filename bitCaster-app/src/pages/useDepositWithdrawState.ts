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
  createMeltQuote,
  meltProofs,
  spendRegularSatsAsToken,
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
  getUnitProofs,
  addProofs,
  removeProofs,
  isCtfProof,
  type StoredProof,
} from '@/stores/proof-db'
import { usePaymentRequestInbox } from '@/stores/paymentRequestInbox'
import { safeHostname } from '@/lib/url'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'
import {
  collateralScaleForUnit,
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
  type MarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'
import { diagnoseProofStates } from '@/lib/proofDiagnostics'
import { formatAmount } from '@/lib/formatAmount'
import { formatBtc } from '@/lib/format'
import { getMintQuoteRateInfo, type MintQuoteRateInfo } from '@/lib/mintQuoteRate'

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

function depositInputAmountToActivitySubunits(
  amount: number,
  baseAsset: MarketBaseAsset,
): number {
  const unit = defaultCollateralUnit(baseAsset)
  const amountSubunits = amount * collateralScaleForUnit(unit)
  if (!Number.isSafeInteger(amountSubunits)) {
    throw new Error(`Amount exceeds safe integer range for ${unit}: ${amount}`)
  }
  return amountSubunits
}

export interface DepositWithdrawState {
  mode: DepositWithdrawMode
  currentView: ExtendedView
  mints: MintInfo[]
  selectedMintId: string
  amountSats: number
  amountLabel: string
  selectedUnit: MarketBaseAsset
  unitOptions: MarketBaseAsset[]
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
  invoiceRateInfo: MintQuoteRateInfo | null
  ecashToken: string | null
  meltQuote: MeltQuoteResponse | null
  meltIsPaying: boolean

  // Payment request state
  paymentRequestEncoded: string | null
  paymentRequestStatus: 'waiting' | 'received'

  // Success state
  successAmount: number
  /** Unit of `successAmount` — NOT necessarily `selectedUnit`: ecash receive,
   *  melt, and payment-request flows are sat-denominated regardless of the
   *  deposit unit selector. */
  successUnit: MarketBaseAsset

  // Handlers
  onSelectMethod: (method: MethodType) => void
  onNumpadPress: (key: string) => void
  onMintChange: (mintId: string) => void
  onToggleCurrency: () => void
  onUnitChange: (unit: MarketBaseAsset) => void
  onCreateInvoice: () => void
  /** Discard the active mint quote and immediately request a fresh one for the
   *  same amount/mint/unit (one-click re-quote after expiry / failure). */
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
    const map: Record<string, Partial<Record<MarketBaseAsset, number>>> = {}
    for (const p of proofs.filter((proof) => !isCtfProof(proof))) {
      const baseAsset = normalizeMarketBaseAsset(p.baseAsset)
      const mintBalances = map[p.mintUrl] ?? {}
      mintBalances[baseAsset] = (mintBalances[baseAsset] ?? 0) + amountToNumber(p.amount)
      map[p.mintUrl] = mintBalances
    }
    return map
  }, [mintUrls.join(',')], {} as Record<string, Partial<Record<MarketBaseAsset, number>>>)

  const unitsForMint = useCallback((mintUrl: string): MarketBaseAsset[] => {
    const mint = storeMints.find((m) => m.url === mintUrl)
    const units = new Set<MarketBaseAsset>()
    for (const keyset of mint?.keysets ?? []) {
      if (keyset.active === false) continue
      units.add(normalizeMarketBaseAsset(keyset.unit))
    }
    return units.size > 0 ? Array.from(units) : ['sat']
  }, [storeMints])

  // Build MintInfo[] from store mints with live balances
  const mintsWithBalance: MintInfo[] = storeMints.map((m) => ({
    id: m.url,
    name: (m.info as Record<string, unknown>)?.name as string ?? safeHostname(m.url),
    url: m.url,
    balanceSats: balancesByMint[m.url]?.sat ?? 0,
    balancesByUnit: balancesByMint[m.url] ?? {},
    units: unitsForMint(m.url),
  }))

  const [currentView, setCurrentView] = useState<ExtendedView>('chooser')
  const [selectedMintId, setSelectedMintId] = useState(activeMintUrl)
  const [selectedUnit, setSelectedUnit] = useState<MarketBaseAsset>('sat')
  const [amountString, setAmountString] = useState('')
  const [showFiatPrimary, setShowFiatPrimary] = useState(false)
  const [lightningInput, setLightningInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Result state
  const [bolt11, setBolt11] = useState<string | null>(null)
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceStatus>('pending')
  const [invoiceExpiresAtSec, setInvoiceExpiresAtSec] = useState<number | undefined>()
  const [invoiceRateInfo, setInvoiceRateInfo] = useState<MintQuoteRateInfo | null>(null)
  const [ecashToken, setEcashToken] = useState<string | null>(null)
  const [meltQuote, setMeltQuote] = useState<MeltQuoteResponse | null>(null)
  const [meltIsPaying, setMeltIsPaying] = useState(false)

  // Payment request state
  const [paymentRequestEncoded, setPaymentRequestEncoded] = useState<string | null>(null)
  const [paymentRequestStatus, setPaymentRequestStatus] = useState<'waiting' | 'received'>('waiting')

  // Success state
  const [successAmount, setSuccessAmount] = useState(0)
  const [successUnit, setSuccessUnit] = useState<MarketBaseAsset>('sat')

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
    const userChoseMint = userSelectedMintRef.current
    const selectedMintStillExists =
      !!selectedMintId && storeMints.some((mint) => mint.url === selectedMintId)
    if (!userChoseMint || !selectedMintStillExists) {
      userSelectedMintRef.current = false
      if (selectedMintId !== activeMintUrl) {
        setSelectedMintId(activeMintUrl)
      }
    }
  }, [activeMintUrl, selectedMintId, storeMints])

  useEffect(() => {
    const units = unitsForMint(selectedMintId)
    if (!units.includes(selectedUnit)) {
      setSelectedUnit(units[0] ?? 'sat')
    }
  }, [selectedMintId, selectedUnit, unitsForMint])

  // React to the global inbox flipping our pending request to "received".
  useEffect(() => {
    if (!pendingRequestId || !inboxEntry) return
    setPaymentRequestStatus('received')
    setSuccessAmount(inboxEntry.amountSubunits)
    setSuccessUnit(inboxEntry.baseAsset)
    const handle = setTimeout(() => {
      usePaymentRequestInbox.getState().clear(pendingRequestId)
      setPendingRequestId(null)
      onDismiss()
    }, 2000)
    return () => clearTimeout(handle)
  }, [pendingRequestId, inboxEntry, onDismiss])

  const amountSats = parseInt(amountString || '0', 10)
  const amountLabel = selectedUnit === 'sat' ? formatBtc(amountSats) : formatAmount(amountSats, selectedUnit)
  const unitOptions = unitsForMint(selectedMintId)

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
    setSelectedUnit(unitsForMint(mintId)[0] ?? 'sat')
  }, [unitsForMint])

  const onUnitChange = useCallback((unit: MarketBaseAsset) => {
    setSelectedUnit(normalizeMarketBaseAsset(unit))
    mintQuoteRef.current = null
    unsubRef.current?.()
    unsubRef.current = null
    inflightRef.current = false
    setBolt11(null)
    setInvoiceExpiresAtSec(undefined)
    setInvoiceRateInfo(null)
    setInvoiceStatus('pending')
    setError(null)
  }, [])

  const onToggleCurrency = useCallback(() => {
    setShowFiatPrimary((prev) => !prev)
  }, [])

  const handlePaidInvoice = useCallback(
    async (
      quote: MintQuoteResponse,
      mintUrl: string,
      requested: number,
      baseAsset: MarketBaseAsset,
    ) => {
      try {
        const proofs = await mintProofs(requested, quote, mintUrl, baseAsset)
        await diagnoseProofStates({
          label: 'top-up:minted-proofs',
          mintUrl,
          proofs,
          extra: { requested, baseAsset },
        })
        const stored: StoredProof[] = proofs.map((p) => ({
          ...p,
          mintUrl,
          baseAsset,
          unit: defaultCollateralUnit(baseAsset),
        }))
        await addProofs(stored)
        setInvoiceStatus('paid')
        const requestedSubunits = depositInputAmountToActivitySubunits(requested, baseAsset)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          baseAsset,
          amountSats: requestedSubunits,
          status: 'completed',
          lightningInvoice: quote.request,
        })
        setSuccessAmount(requestedSubunits)
        setSuccessUnit(baseAsset)
        setCurrentView('success')
      } catch (e) {
        setInvoiceStatus('error')
        setError((e as Error).message)
      }
    },
    []
  )

  const handleInvoiceWaitResult = useCallback(
    (
      r: MintQuoteWaitResult,
      quote: MintQuoteResponse,
      mintUrl: string,
      requested: number,
      baseAsset: MarketBaseAsset,
    ) => {
      switch (r.status) {
        case 'PAID':
          handlePaidInvoice(quote, mintUrl, requested, baseAsset)
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
    const baseAsset = selectedUnit
    try {
      await useWalletStore.getState().ensureImplicitWallet()
      // Re-mount idempotency: reuse the active quote if one exists, otherwise
      // request a fresh one. Prevents the duplicate-quote LNBits snackbar.
      const quote = mintQuoteRef.current ?? await createMintQuote(requested, mintUrl, baseAsset)
      mintQuoteRef.current = quote
      setBolt11(quote.request)
      setInvoiceExpiresAtSec(quote.expiry ?? undefined)
      setInvoiceRateInfo(baseAsset === 'usd' ? getMintQuoteRateInfo(quote, requested) : null)
      setCurrentView('invoice-display')

      const unsub = await waitForMintQuotePaid(
        quote,
        (r) => handleInvoiceWaitResult(r, quote, mintUrl, requested, baseAsset),
        { onTransientError: (e) => setError(e.message) },
        mintUrl,
        baseAsset,
      )
      unsubRef.current = unsub
    } catch (e) {
      setInvoiceStatus('error')
      setError((e as Error).message)
      inflightRef.current = false
    } finally {
      setIsLoading(false)
    }
  }, [amountSats, selectedMintId, selectedUnit, handleInvoiceWaitResult])

  const onRegenerateInvoice = useCallback(() => {
    unsubRef.current?.()
    unsubRef.current = null
    mintQuoteRef.current = null
    inflightRef.current = false
    setBolt11(null)
    setInvoiceExpiresAtSec(undefined)
    setInvoiceRateInfo(null)
    setInvoiceStatus('pending')
    setError(null)
    // One-click re-quote: the amount and mint are unchanged, so request a
    // fresh quote immediately instead of bouncing through the entry view.
    // Matters most for short-lived USD quotes (~90s) where the rate moved.
    void onCreateInvoice()
  }, [onCreateInvoice])

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
        const receivedUnit = requireCashuProofUnit(received.unit)
        const receivedBaseAsset = normalizeMarketBaseAsset(receivedUnit)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          baseAsset: receivedBaseAsset,
          amountSats: received.amountSubunits,
          status: 'completed',
        })
        setIsLoading(false)
        setSuccessAmount(received.amountSubunits)
        setSuccessUnit(receivedBaseAsset)
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
      const token = await spendRegularSatsAsToken(amountSats, selectedMintId)
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
      const proofs = await getUnitProofs(selectedMintId, { unit: 'sat' })
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
          baseAsset: 'sat',
          unit: 'sat',
        }))
        await addProofs(changeStored)
      }

      useActivityLogStore.getState().addActivity({
        type: 'withdrawal',
        baseAsset: 'sat',
        amountSats: amountToNumber(meltQuote.amount),
        status: 'completed',
        lightningInvoice: lightningInput,
      })
      setSuccessAmount(amountToNumber(meltQuote.amount))
      setSuccessUnit('sat')
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
        const receivedUnit = requireCashuProofUnit(received.unit)
        const receivedBaseAsset = normalizeMarketBaseAsset(receivedUnit)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          baseAsset: receivedBaseAsset,
          amountSats: received.amountSubunits,
          status: 'completed',
        })
        setSuccessAmount(received.amountSubunits)
        setSuccessUnit(receivedBaseAsset)
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
    amountLabel,
    selectedUnit,
    unitOptions,
    amountFiat: '$0.00', // Fiat conversion not yet implemented
    fiatSymbol: '$',
    showFiatPrimary,
    lightningInput,
    isLoading,
    error,
    bolt11,
    invoiceStatus,
    invoiceExpiresAtSec,
    invoiceRateInfo,
    ecashToken,
    meltQuote,
    meltIsPaying,
    paymentRequestEncoded,
    paymentRequestStatus,
    successAmount,
    successUnit,
    onSelectMethod,
    onNumpadPress,
    onMintChange,
    onUnitChange,
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

function requireCashuProofUnit(value: string | null | undefined): CashuProofUnit {
  const unit = parseCashuProofUnit(value)
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${value ?? ''}'`)
  return unit
}
