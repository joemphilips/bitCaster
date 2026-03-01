import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  DepositWithdrawMode,
  DepositWithdrawView,
  MethodType,
  MintInfo,
} from '@/types/deposit-withdraw'
import type { MeltQuoteResponse } from '@cashu/cashu-ts'
import { useWalletStore } from '@/stores/wallet'
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

export type ExtendedView =
  | DepositWithdrawView
  | 'invoice-display'
  | 'token-display'
  | 'melt-confirm'

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
    name: (m.info as Record<string, unknown>)?.name as string ?? new URL(m.url).hostname,
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

  // Track the quote for cleanup
  const mintQuoteRef = useRef<{ quote: string; request: string } | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  // Cleanup WebSocket/polling on unmount
  useEffect(() => {
    return () => {
      unsubRef.current?.()
    }
  }, [])

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
        const decoded = decodeToken(text)
        const proofs = await receiveToken(text, decoded.mint)
        const mintUrl = decoded.mint
        const stored: StoredProof[] = proofs.map((p) => ({
          ...p,
          mintUrl,
        }))
        await addProofs(stored)
        setIsLoading(false)
        onDismiss()
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
  }, [currentView, selectedMintId, onDismiss])

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

      onDismiss()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setMeltIsPaying(false)
    }
  }, [meltQuote, selectedMintId, onDismiss])

  const onScan = useCallback(() => {
    // Camera scanning deferred for now
    setError('Camera scanning coming soon')
  }, [])

  const onRequest = useCallback(() => {
    // Request flow deferred for now
    setError('Request coming soon')
  }, [])

  const onScanQR = useCallback(() => {
    // Camera scanning deferred for now
    setError('Camera scanning coming soon')
  }, [])

  const onBack = useCallback(() => {
    setCurrentView('chooser')
    setError(null)
  }, [])

  const onClose = useCallback(() => {
    unsubRef.current?.()
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
    onSelectMethod,
    onNumpadPress,
    onMintChange,
    onToggleCurrency,
    onCreateInvoice,
    onSendEcash,
    onPaste,
    onScan,
    onRequest,
    onScanQR,
    onLightningInputChange,
    onConfirmMelt,
    onBack,
    onClose,
  }
}
