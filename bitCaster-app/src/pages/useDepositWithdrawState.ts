import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  DepositWithdrawMode,
  DepositWithdrawView,
  MethodType,
  MintInfo,
} from '@/types/deposit-withdraw'
import type { MeltQuoteResponse } from '@cashu/cashu-ts'
import {
  PaymentRequest,
  PaymentRequestTransportType,
} from '@cashu/cashu-ts'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { useActivityLogStore } from '@/stores/activity-log'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/stores/proof-db'
import {
  createMintQuote,
  mintProofs,
  encodeToken,
  decodeToken,
  receiveToken,
  sendProofs,
  createMeltQuote,
  meltProofs,
  waitForMintQuotePaid,
} from '@/lib/cashu'
import {
  getProofs,
  addProofs,
  removeProofs,
  type StoredProof,
} from '@/stores/proof-db'
import { deriveNostrKeyPair, getNostrNprofile } from '@/lib/nip17'
import { usePaymentRequestInbox } from '@/stores/paymentRequestInbox'
import { safeHostname } from '@/lib/url'

export type ExtendedView =
  | DepositWithdrawView
  | 'invoice-display'
  | 'token-display'
  | 'melt-confirm'
  | 'scanner'
  | 'payment-request-display'
  | 'success'

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
  invoiceStatus: 'pending' | 'paid' | 'expired'
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
    for (const p of proofs) {
      map[p.mintUrl] = (map[p.mintUrl] ?? 0) + p.amount
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
  const [invoiceStatus, setInvoiceStatus] = useState<'pending' | 'paid' | 'expired'>('pending')
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

  // Track the quote for cleanup
  const mintQuoteRef = useRef<{ quote: string; request: string } | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

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
    setSelectedMintId(mintId)
  }, [])

  const onToggleCurrency = useCallback(() => {
    setShowFiatPrimary((prev) => !prev)
  }, [])

  const onCreateInvoice = useCallback(async () => {
    if (amountSats <= 0) return
    setIsLoading(true)
    setError(null)
    try {
      const quote = await createMintQuote(amountSats, selectedMintId)
      mintQuoteRef.current = quote
      setBolt11(quote.request)
      setInvoiceStatus('pending')
      setCurrentView('invoice-display')

      // Wait for payment
      const unsub = await waitForMintQuotePaid(
        quote.quote,
        async () => {
          try {
            const savedQuote = mintQuoteRef.current
            if (!savedQuote) return
            const proofs = await mintProofs(amountSats, savedQuote as Parameters<typeof mintProofs>[1], selectedMintId)
            const stored: StoredProof[] = proofs.map((p) => ({
              ...p,
              mintUrl: selectedMintId,
            }))
            await addProofs(stored)
            setInvoiceStatus('paid')
            useActivityLogStore.getState().addActivity({
              type: 'deposit',
              amountSats,
              status: 'completed',
              lightningInvoice: savedQuote.request,
            })
          } catch (e) {
            setError((e as Error).message)
          }
        },
        (e) => setError(e.message),
        selectedMintId
      )
      unsubRef.current = unsub
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [amountSats, selectedMintId])

  const onPaste = useCallback(async () => {
    setError(null)
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return

      // Detect if it's an ecash token or a lightning invoice
      if (currentView === 'deposit-ecash') {
        setIsLoading(true)
        const decoded = await decodeToken(text)
        const proofs = await receiveToken(text, decoded.mint)
        const mintUrl = decoded.mint
        const stored: StoredProof[] = proofs.map((p) => ({
          ...p,
          mintUrl,
        }))
        await addProofs(stored)
        const receivedAmount = proofs.reduce((sum, p) => sum + p.amount, 0)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          amountSats: receivedAmount,
          status: 'completed',
        })
        setIsLoading(false)
        setSuccessAmount(receivedAmount)
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
      const proofs = await getProofs(selectedMintId)
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
      useActivityLogStore.getState().addActivity({
        type: 'withdrawal',
        amountSats,
        status: 'completed',
      })
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
      const proofs = await getProofs(selectedMintId)
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
        amountSats: meltQuote.amount,
        status: 'completed',
        lightningInvoice: lightningInput,
      })
      setSuccessAmount(meltQuote.amount)
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
        const decoded = await decodeToken(trimmed)
        const proofs = await receiveToken(trimmed, decoded.mint)
        const stored: StoredProof[] = proofs.map((p) => ({
          ...p,
          mintUrl: decoded.mint,
        }))
        await addProofs(stored)
        const receivedAmount = proofs.reduce((sum, p) => sum + p.amount, 0)
        useActivityLogStore.getState().addActivity({
          type: 'deposit',
          amountSats: receivedAmount,
          status: 'completed',
        })
        setSuccessAmount(receivedAmount)
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

    const mnemonic = useWalletStore.getState().mnemonic
    if (!mnemonic) {
      setError('Wallet not set up')
      return
    }

    try {
      const keyPair = deriveNostrKeyPair(mnemonic)
      // Embed the user's configured relays in the nprofile so the payer
      // publishes to the same relay set our continuous NIP-17 listener is
      // subscribed to (matches cashu.me's seedSignerNprofile behaviour).
      const configuredRelays = useSettingsStore
        .getState()
        .relays.map((r) => r.url)
      const nprofile = getNostrNprofile(
        keyPair.publicKey,
        configuredRelays.length > 0 ? configuredRelays : undefined
      )

      const transport = [{
        type: PaymentRequestTransportType.NOSTR,
        target: nprofile,
        tags: [['n', '17']],
      }]

      // cashu-ts's PaymentRequest does NOT auto-generate an id when the
      // arg is undefined — it just leaves it as undefined. The payer then
      // has no id to echo back in the NIP-17 payload, and our inbox store
      // has nothing to key on. Mirror cashu.me's scheme (first segment of
      // a UUIDv4) so the id survives the round-trip.
      const id = crypto.randomUUID().split('-')[0]
      const pr = new PaymentRequest(
        transport,
        id,
        undefined, // no amount
        'sat',
        [selectedMintId],
        undefined, // no description
      )
      const encoded = pr.toEncodedRequest()

      setPaymentRequestEncoded(encoded)
      setPaymentRequestStatus('waiting')
      setCurrentView('payment-request-display')
      // Hand receive-detection off to the continuous listener. The
      // useEffect above flips status to 'received' when the global inbox
      // gets an entry keyed by this id.
      setPendingRequestId(id)
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
