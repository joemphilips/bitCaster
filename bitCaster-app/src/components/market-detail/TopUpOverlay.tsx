import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { InvoiceDisplay } from '@/components/deposit-withdraw/InvoiceDisplay'
import {
  FEE_BUFFER_SATS,
  createMintQuote,
  decodeToken,
  getWalletForUnit,
  mintProofs,
  waitForMintQuotePaid,
  type MintQuoteWaitResult,
} from '@/lib/cashu'
import { addProofs, type StoredProof } from '@/stores/proof-db'
import { useWalletStore } from '@/stores/wallet'
import type { MintQuoteResponse, OutputType } from '@cashu/cashu-ts'
import {
  formatAmount,
  defaultCollateralUnit,
  marketUnitLabel,
  normalizeMarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'
import {
  validateTopUpEcashToken,
  type TopUpPasteValidationError,
} from './topUpPasteValidation'

type View = 'amount' | 'invoice'
type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'error'
type TopUpMethod = 'lightning' | 'ecash'

function displayInputAmount(amountSubunits: number, baseAsset: string): number {
  if (baseAsset === 'usd') return amountSubunits / 100
  if (baseAsset === 'sat') return amountSubunits / 1000
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function displayInputStep(baseAsset: string): number {
  if (baseAsset === 'usd') return 0.01
  if (baseAsset === 'sat') return 1
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function inputAmountToSubunits(displayAmount: number, baseAsset: string): number {
  if (!Number.isFinite(displayAmount)) return 0
  if (baseAsset === 'usd') return Math.round(displayAmount * 100)
  if (baseAsset === 'sat') return Math.round(displayAmount * 1000)
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function feeBufferSubunits(baseAsset: string): number {
  if (baseAsset === 'usd') return 0
  if (baseAsset === 'sat') return FEE_BUFFER_SATS * 1000
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function topUpRequestAmount(amountSubunits: number, baseAsset: string): number {
  if (baseAsset === 'usd') return amountSubunits
  if (baseAsset === 'sat') return Math.ceil(amountSubunits / 1000)
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function topUpAmountLabel(baseAsset: string, unitLabel: string, t: (key: string) => string): string {
  if (baseAsset === 'usd') return `${t('topUp.amount')} (${unitLabel})`
  if (baseAsset === 'sat') return t('topUp.amountSats')
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function assertNeverWaitResult(r: never): never {
  throw new Error(`unhandled MintQuoteWaitResult: ${JSON.stringify(r)}`)
}

function topUpPasteValidationErrorMessage(
  error: TopUpPasteValidationError,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  switch (error.code) {
    case 'too_large':
      return t('topUp.ecash.errorTooLarge', error.values)
    case 'decode_failed':
      return t('topUp.ecash.errorDecode')
    case 'mint_mismatch':
      return t('topUp.ecash.errorMintMismatch', error.values)
    case 'unit_mismatch':
      return t('topUp.ecash.errorUnitMismatch', error.values)
    case 'amount_too_low':
      return t('topUp.ecash.errorAmountTooLow', error.values)
    default:
      return assertNeverTopUpPasteError(error.code)
  }
}

function assertNeverTopUpPasteError(code: never): never {
  throw new Error(`unhandled top-up paste validation error: ${code}`)
}

interface TopUpOverlayProps {
  /** Minimum base-asset subunits the user must top up — the trade deficit. */
  deficit: number
  /** Full registration fee for market-creation top-ups. Omit for trade top-ups. */
  feeSubunits?: number
  /** Current user balance for market-creation top-ups. Omit for trade top-ups. */
  balanceSubunits?: number
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
 * user picks an amount (prefilled with the deficit plus `FEE_BUFFER_SATS`, floor `deficit`),
 * sees a bolt11, and the overlay tears itself down once proofs are stored.
 */
export function TopUpOverlay({
  deficit,
  feeSubunits,
  balanceSubunits,
  baseAsset: baseAssetInput,
  minimumDescription,
  minimumErrorDescription,
  onSuccess,
  onCancel,
}: TopUpOverlayProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)
  const walletBackupState = useWalletStore((s) => s.walletBackupState)
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const unitLabel = marketUnitLabel(baseAsset)
  const bufferSubunits = feeBufferSubunits(baseAsset)
  const prefill = Math.max(deficit + bufferSubunits, 1)
  const displayMin = displayInputAmount(deficit, baseAsset)
  const inputStep = displayInputStep(baseAsset)
  const showFeeSummary = feeSubunits !== undefined && balanceSubunits !== undefined

  const [view, setView] = useState<View>('amount')
  const [method, setMethod] = useState<TopUpMethod>('lightning')
  const [amount, setAmount] = useState(prefill)
  const [ecashToken, setEcashToken] = useState('')
  const [bolt11, setBolt11] = useState('')
  const [expiresAtSec, setExpiresAtSec] = useState<number | undefined>()
  const [status, setStatus] = useState<InvoiceStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [backupWarningDismissed, setBackupWarningDismissed] = useState(false)
  const showBackupWarning = walletBackupState === 'needs_backup' && !backupWarningDismissed

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
        unit: defaultCollateralUnit(baseAsset),
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
          `Amount must be at least ${formatAmount(deficit, baseAsset)} to cover this trade.`,
      )
      return
    }
    const requested = topUpRequestAmount(amount, baseAsset)
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

  const submitEcashToken = useCallback(async () => {
    if (inflightRef.current) return
    const trimmed = ecashToken.trim()
    if (!trimmed) {
      setError(t('topUp.ecash.errorRequired'))
      return
    }
    inflightRef.current = true
    setLoading(true)
    setError(null)
    try {
      await useWalletStore.getState().ensureImplicitWallet()
      const validation = await validateTopUpEcashToken(trimmed, {
        activeMintUrl,
        baseAsset,
        deficit,
        decodeToken,
      })
      if (!validation.ok) {
        setError(topUpPasteValidationErrorMessage(validation, t))
        return
      }

      const wallet = await getWalletForUnit(activeMintUrl, validation.unit)
      const receiveOutput: OutputType = { type: 'random' }
      const proofs = await wallet.receive(trimmed, undefined, receiveOutput)
      const stored: StoredProof[] = proofs.map((p) => ({
        ...p,
        mintUrl: validation.mintUrl,
        baseAsset: validation.baseAsset,
        unit: validation.unit,
      }))
      await addProofs(stored)
      if (!cancelledRef.current) onSuccessRef.current()
    } catch (e) {
      if (!cancelledRef.current) setError((e as Error).message)
    } finally {
      inflightRef.current = false
      if (!cancelledRef.current) setLoading(false)
    }
  }, [activeMintUrl, baseAsset, deficit, ecashToken, t])

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
        amountLabel={formatAmount(amount, baseAsset)}
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

        {showBackupWarning && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">{t('backupSecrets.depositWarning')}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => navigate('/settings?category=cashu')}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
              >
                {t('backupSecrets.backupNow')}
              </button>
              <button
                type="button"
                onClick={() => setBackupWarningDismissed(true)}
                className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/70"
              >
                {t('backupSecrets.later')}
              </button>
            </div>
          </div>
        )}

        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          {minimumDescription ??
            t('topUp.minimumDesc', {
              sats: formatAmount(deficit, baseAsset),
            })}
        </p>

        {showFeeSummary && (
          <dl className="mb-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">{t('topUp.registrationFee')}</dt>
              <dd className="font-mono font-semibold text-slate-900 dark:text-white">
                {formatAmount(feeSubunits, baseAsset)}
              </dd>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">{t('topUp.yourBalance')}</dt>
              <dd className="font-mono text-slate-700 dark:text-slate-200">
                {formatAmount(balanceSubunits, baseAsset)}
              </dd>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-700 pt-2">
              <dt className="font-medium text-slate-700 dark:text-slate-200">{t('topUp.topUpNeeded')}</dt>
              <dd className="font-mono font-semibold text-[#f7931a]">
                {formatAmount(deficit, baseAsset)}
              </dd>
            </div>
          </dl>
        )}

        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-900">
          <button
            type="button"
            data-testid="top-up-method-lightning"
            onClick={() => { setMethod('lightning'); setError(null) }}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${method === 'lightning' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
          >
            {t('topUp.methodLightning')}
          </button>
          <button
            type="button"
            data-testid="top-up-method-ecash"
            onClick={() => { setMethod('ecash'); setError(null) }}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${method === 'ecash' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
          >
            {t('topUp.methodEcash')}
          </button>
        </div>

        {method === 'lightning' ? (
          <>
            <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">
              {topUpAmountLabel(baseAsset, unitLabel, t)}
            </label>
            <input
              data-testid="top-up-amount-input"
              type="number"
              min={displayMin}
              step={inputStep}
              value={displayInputAmount(amount, baseAsset)}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (Number.isFinite(next)) setAmount(inputAmountToSubunits(next, baseAsset))
              }}
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white font-mono focus:outline-none focus:ring-2 focus:ring-[#f7931a]"
            />
          </>
        ) : (
          <>
            <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1" htmlFor="top-up-ecash-input">
              {t('topUp.ecash.label')}
            </label>
            <textarea
              id="top-up-ecash-input"
              data-testid="top-up-ecash-input"
              value={ecashToken}
              onChange={(e) => setEcashToken(e.target.value)}
              placeholder={t('topUp.ecash.placeholder')}
              rows={5}
              className="w-full resize-y bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[#f7931a]"
            />
          </>
        )}

        {error && (
          <div className="mt-3 text-xs text-red-500 dark:text-red-400">{error}</div>
        )}

        {method === 'lightning' ? (
          <button
            data-testid="top-up-continue"
            onClick={startInvoice}
            disabled={loading || amount < deficit}
            className="mt-6 w-full py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold transition-colors"
          >
            {loading ? t('topUp.requesting') : t('common.continue')}
          </button>
        ) : (
          <button
            data-testid="top-up-ecash-submit"
            onClick={submitEcashToken}
            disabled={loading || ecashToken.trim().length === 0}
            className="mt-6 w-full py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold transition-colors"
          >
            {loading ? t('topUp.ecash.adding') : t('topUp.ecash.addFunds')}
          </button>
        )}
      </div>
    </div>
  )
}
