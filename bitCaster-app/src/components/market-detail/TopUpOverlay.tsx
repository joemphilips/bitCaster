import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { InvoiceDisplay } from '@/components/deposit-withdraw/InvoiceDisplay'
import {
  FEE_BUFFER_SATS,
  createMintQuote,
  mintProofs,
  waitForMintQuotePaid,
  type MintQuoteWaitResult,
} from '@/lib/cashu'
import { addProofs, type StoredProof } from '@/stores/proof-db'
import { useWalletStore } from '@/stores/wallet'
import type { MintQuoteResponse } from '@cashu/cashu-ts'
import {
  formatMarketSubunits,
  marketSubunitLabel,
  normalizeMarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'

type View = 'amount' | 'invoice'
type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'error'

function assertNeverWaitResult(r: never): never {
  throw new Error(`unhandled MintQuoteWaitResult: ${JSON.stringify(r)}`)
}

interface TopUpOverlayProps {
  /** Minimum base-asset subunits the user must top up — the trade deficit. */
  deficit: number
  baseAsset?: string | null
  minimumDescription?: string
  minimumErrorDescription?: string
  /** Called after proofs have landed in the store. */
  onSuccess: () => void
  /** User aborted the top-up. */
  onCancel: () => void
}

/**
 * Self-contained Lightning top-up flow mirroring
 * `useDepositWithdrawState.onCreateInvoice` but scoped to the trade context:
 * user picks an amount (prefilled `deficit + FEE_BUFFER_SATS`, floor `deficit`),
 * sees a bolt11, and the overlay tears itself down once proofs are stored.
 */
export function TopUpOverlay({
  deficit,
  baseAsset: baseAssetInput,
  minimumDescription,
  minimumErrorDescription,
  onSuccess,
  onCancel,
}: TopUpOverlayProps) {
  const { t } = useTranslation()
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const subunitLabel = marketSubunitLabel(baseAsset)
  const bufferSubunits = baseAsset === 'sat' ? FEE_BUFFER_SATS : 1
  const prefill = Math.max(deficit + bufferSubunits, 1)

  const [view, setView] = useState<View>('amount')
  const [amount, setAmount] = useState(prefill)
  const [bolt11, setBolt11] = useState('')
  const [expiresAtSec, setExpiresAtSec] = useState<number | undefined>()
  const [status, setStatus] = useState<InvoiceStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const unsubRef = useRef<(() => void) | null>(null)
  // The active mint quote for this overlay-open. Persisted across re-renders
  // (and StrictMode dev re-effects) so a re-render does NOT create a second
  // quote against the mint — that's what produced the LNBits "Invoice already
  // paid or pending" snackbar in P8.
  const activeQuoteRef = useRef<MintQuoteResponse | null>(null)
  // Synchronous guard against double-submits — React's `loading` state is set
  // one render later, so a rapid second click would otherwise start a second
  // quote and leak the first's polling subscription.
  const inflightRef = useRef(false)
  // Signals both cleanup and late-arriving async callbacks to bail out. Flips
  // to true when the component unmounts.
  const cancelledRef = useRef(false)
  // onSuccess is invoked from an async callback whose closure would otherwise
  // capture a stale function; route through a ref so callers don't have to
  // worry about memoisation.
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess

  useEffect(() => {
    // StrictMode in dev runs this effect mount → cleanup → mount on the same
    // fiber (refs survive), so the cleanup below would otherwise leave
    // cancelledRef stuck at `true` and make every async callback in
    // `startInvoice` think the component unmounted — producing the
    // subscribe/immediate-unsubscribe you'd see on the mint WS.
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      unsubRef.current?.()
      unsubRef.current = null
    }
  }, [])

  const handlePaidQuote = useCallback(async (quote: MintQuoteResponse, requested: number) => {
    try {
      const proofs = await mintProofs(requested, quote, activeMintUrl, baseAsset)
      const stored: StoredProof[] = proofs.map((p) => ({
        ...p,
        mintUrl: activeMintUrl,
        baseAsset,
      }))
      await addProofs(stored)
      if (cancelledRef.current) return
      setStatus('paid')
      // Small delay so the user sees "Payment received!" before the overlay vanishes.
      setTimeout(() => { if (!cancelledRef.current) onSuccessRef.current() }, 800)
    } catch (e) {
      if (!cancelledRef.current) {
        setStatus('error')
        setError((e as Error).message)
      }
    }
  }, [activeMintUrl, baseAsset])

  const handleWaitResult = useCallback((result: MintQuoteWaitResult, quote: MintQuoteResponse, requested: number) => {
    if (cancelledRef.current) return
    switch (result.status) {
      case 'PAID':
        handlePaidQuote(quote, requested)
        return
      case 'EXPIRED':
        setStatus('expired')
        setError('The Lightning invoice expired before payment arrived.')
        return
      case 'ERROR':
        setStatus('error')
        setError(result.error.message)
        return
      default:
        return assertNeverWaitResult(result)
    }
  }, [handlePaidQuote])

  const startInvoice = useCallback(async () => {
    if (inflightRef.current) return
    if (amount < deficit) {
      setError(
        minimumErrorDescription ??
          `Amount must be at least ${formatMarketSubunits(deficit, baseAsset)} to cover this trade.`,
      )
      return
    }
    const requested = amount
    inflightRef.current = true
    setError(null)
    setStatus('pending')
    setLoading(true)
    try {
      await useWalletStore.getState().ensureImplicitWallet()
      // Re-mount idempotency: reuse a quote already issued during this open.
      // Otherwise StrictMode (or a parent re-render) would issue a second quote
      // against the same mint state — LNBits then returns "Invoice already paid
      // or pending" verbatim, which the user sees as the P8 snackbar.
      const quote = activeQuoteRef.current ?? await createMintQuote(requested, activeMintUrl, baseAsset)
      activeQuoteRef.current = quote
      setBolt11(quote.request)
      setExpiresAtSec(quote.expiry ?? undefined)
      setView('invoice')

      const unsub = await waitForMintQuotePaid(
        quote,
        (r) => handleWaitResult(r, quote, requested),
        { onTransientError: (e) => { if (!cancelledRef.current) setError(e.message) } },
        activeMintUrl,
        baseAsset,
      )
      if (cancelledRef.current) unsub()
      else unsubRef.current = unsub
    } catch (e) {
      if (!cancelledRef.current) {
        setStatus('error')
        setError((e as Error).message)
      }
      inflightRef.current = false
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [activeMintUrl, amount, baseAsset, deficit, handleWaitResult, minimumErrorDescription])

  const regenerateInvoice = useCallback(() => {
    // Tear down the prior wait and clear the cached quote so the next
    // startInvoice() requests a fresh one.
    unsubRef.current?.()
    unsubRef.current = null
    activeQuoteRef.current = null
    inflightRef.current = false
    setError(null)
    setStatus('pending')
    setView('amount')
  }, [])

  if (view === 'invoice') {
    return (
      <InvoiceDisplay
        bolt11={bolt11}
        amountSats={amount}
        amountLabel={formatMarketSubunits(amount, baseAsset)}
        status={status}
        expiresAtSec={expiresAtSec}
        errorMessage={error}
        onClose={onCancel}
        onRegenerate={regenerateInvoice}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />

      <div className="relative bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-w-sm w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {t('topUp.title')}
          </h2>
          <button
            data-testid="top-up-close"
            onClick={onCancel}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          {minimumDescription ??
            t('topUp.minimumDesc', {
              sats: formatMarketSubunits(deficit, baseAsset),
            })}
        </p>

        <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">
          {baseAsset === 'sat' ? t('topUp.amountSats') : `${t('topUp.amount')} (${subunitLabel})`}
        </label>
        <input
          data-testid="top-up-amount-input"
          type="number"
          min={deficit}
          value={amount}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (Number.isFinite(next)) setAmount(next)
          }}
          className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white font-mono focus:outline-none focus:ring-2 focus:ring-[#f7931a]"
        />

        {error && (
          <div className="mt-3 text-xs text-red-500 dark:text-red-400">{error}</div>
        )}

        <button
          data-testid="top-up-continue"
          onClick={startInvoice}
          disabled={loading || amount < deficit}
          className="mt-6 w-full py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold transition-colors"
        >
          {loading ? t('topUp.requesting') : t('common.continue')}
        </button>
      </div>
    </div>
  )
}
