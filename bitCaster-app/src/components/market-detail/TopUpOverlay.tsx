import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { InvoiceDisplay } from '@/components/deposit-withdraw/InvoiceDisplay'
import {
  FEE_BUFFER_SATS,
  createMintQuote,
  mintProofs,
  waitForMintQuotePaid,
} from '@/lib/cashu'
import { addProofs, type StoredProof } from '@/stores/proof-db'
import { useWalletStore } from '@/stores/wallet'

type View = 'amount' | 'invoice'

interface TopUpOverlayProps {
  /** Minimum sats the user must top up — the trade deficit. */
  deficit: number
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
export function TopUpOverlay({ deficit, onSuccess, onCancel }: TopUpOverlayProps) {
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)
  const prefill = Math.max(deficit + FEE_BUFFER_SATS, 1)

  const [view, setView] = useState<View>('amount')
  const [amount, setAmount] = useState(prefill)
  const [bolt11, setBolt11] = useState('')
  const [status, setStatus] = useState<'pending' | 'paid' | 'expired'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const unsubRef = useRef<(() => void) | null>(null)
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

  const startInvoice = useCallback(async () => {
    if (inflightRef.current) return
    if (amount < deficit) {
      setError(`Amount must be at least ${deficit} sats to cover this trade.`)
      return
    }
    // Snapshot the amount so the async paid-callback below doesn't read a
    // later edit — once we've requested an invoice for N sats, we mint N.
    const requested = amount
    inflightRef.current = true
    setError(null)
    setLoading(true)
    try {
      const quote = await createMintQuote(requested, activeMintUrl)
      setBolt11(quote.request)
      setStatus('pending')
      setView('invoice')

      const unsub = await waitForMintQuotePaid(
        quote.quote,
        async () => {
          if (cancelledRef.current) return
          try {
            const proofs = await mintProofs(requested, quote, activeMintUrl)
            const stored: StoredProof[] = proofs.map((p) => ({
              ...p,
              mintUrl: activeMintUrl,
            }))
            await addProofs(stored)
            if (cancelledRef.current) return
            setStatus('paid')
            // Small delay so the user sees the "Payment received!" state before
            // the overlay vanishes.
            setTimeout(() => {
              if (!cancelledRef.current) onSuccessRef.current()
            }, 800)
          } catch (e) {
            if (!cancelledRef.current) setError((e as Error).message)
          }
        },
        (e) => {
          if (!cancelledRef.current) setError(e.message)
        },
        activeMintUrl,
      )
      // If the component unmounted while awaits were in flight, the cleanup
      // effect already ran with a null unsubRef; tear this one down directly.
      if (cancelledRef.current) {
        unsub()
      } else {
        unsubRef.current = unsub
      }
    } catch (e) {
      if (!cancelledRef.current) setError((e as Error).message)
      inflightRef.current = false
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [activeMintUrl, amount, deficit])

  if (view === 'invoice') {
    return (
      <InvoiceDisplay
        bolt11={bolt11}
        amountSats={amount}
        status={status}
        onClose={onCancel}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />

      <div className="relative bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-w-sm w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            Top Up Wallet
          </h2>
          <button
            onClick={onCancel}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Minimum{' '}
          <span className="font-mono text-slate-700 dark:text-slate-200">
            {deficit.toLocaleString()} sats
          </span>{' '}
          to cover the trade. We've prefilled a small buffer for fees — you can
          raise it but not lower it.
        </p>

        <label className="block text-xs text-slate-400 dark:text-slate-500 mb-1">
          Amount (sats)
        </label>
        <input
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
          onClick={startInvoice}
          disabled={loading || amount < deficit}
          className="mt-6 w-full py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-semibold transition-colors"
        >
          {loading ? 'Requesting invoice…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
