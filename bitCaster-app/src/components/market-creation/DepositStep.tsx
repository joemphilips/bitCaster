import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { Loader2, Zap, Coins, CheckCircle2, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { InvoiceDisplay } from '@/components/deposit-withdraw/InvoiceDisplay'
import {
  requestLnInvoiceDeposit,
  requestEcashDeposit,
  getDepositStatus,
  type DepositState,
  type RequestLnInvoiceDepositResponse,
} from '@/lib/markets'

interface DepositStepProps {
  /** The just-created market's condition id, returned by `createMarket`. */
  conditionId: string
  /** Pre-set amount from the wizard's liquidity step; user can override. */
  defaultAmountSats: number
}

type Tab = 'ln' | 'ecash'

const POLL_INTERVAL_MS = 1500
/** Stop polling once a terminal state is reached. */
const TERMINAL_STATES: DepositState[] = ['Credited', 'Failed']

/**
 * Final step of the market-create wizard. After `createMarket` succeeds, the
 * wizard renders this component with the new `conditionId`. The user funds
 * the market's CPMM bot via Lightning or ecash and waits for the
 * wallet-service to credit the per-market account.
 *
 * Once the deposit reaches `Credited`, the user navigates to the market
 * detail page — that's the only path forward; the market is unfunded and
 * idle until a deposit lands.
 */
export function DepositStep({ conditionId, defaultAmountSats }: DepositStepProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('ln')
  const [amountSats, setAmountSats] = useState(defaultAmountSats)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [depositId, setDepositId] = useState<string | null>(null)
  const [bolt11, setBolt11] = useState<string | null>(null)
  const [bolt11ExpiresAt, setBolt11ExpiresAt] = useState<string | null>(null)
  const [ecashToken, setEcashToken] = useState('')
  const [state, setState] = useState<DepositState | null>(null)
  const [stateUpdatedAt, setStateUpdatedAt] = useState<string | null>(null)

  // Polling driver — kicks off when `depositId` is set, stops on terminal state.
  // The terminal check runs inside the tick (not in the effect deps) so each
  // state transition does NOT tear down + recreate the interval; the interval
  // lives until the deposit reaches Credited/Failed or the component unmounts.
  const stateRef = useRef<DepositState | null>(state)
  stateRef.current = state
  useEffect(() => {
    if (!depositId) return
    let cancelled = false
    let handle: number | null = null
    const tick = async () => {
      if (cancelled) return
      if (stateRef.current && TERMINAL_STATES.includes(stateRef.current)) {
        if (handle !== null) window.clearInterval(handle)
        return
      }
      try {
        const status = await getDepositStatus(conditionId, depositId)
        if (cancelled) return
        if (status) {
          setState(status.state)
          setStateUpdatedAt(status.updatedAt)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('marketCreation.statusPollError'))
        }
      }
    }
    void tick()
    handle = window.setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (handle !== null) window.clearInterval(handle)
    }
  }, [conditionId, depositId, t])

  const onRequestLn = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const res: RequestLnInvoiceDepositResponse = await requestLnInvoiceDeposit(conditionId, amountSats)
      setDepositId(res.depositId)
      setBolt11(res.bolt11)
      setBolt11ExpiresAt(res.expiresAt)
      setState('Requested')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('marketCreation.lnRequestError'))
    } finally {
      setSubmitting(false)
    }
  }, [conditionId, amountSats, t])

  const onSubmitEcash = useCallback(async () => {
    if (ecashToken.trim().length === 0) {
      setError(t('marketCreation.ecashRequiredError'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await requestEcashDeposit(conditionId, amountSats, ecashToken.trim())
      setDepositId(res.depositId)
      setState(res.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('marketCreation.ecashSubmitError'))
    } finally {
      setSubmitting(false)
    }
  }, [conditionId, amountSats, ecashToken, t])

  const onContinue = useCallback(() => {
    navigate(`/markets/${conditionId}`)
  }, [navigate, conditionId])

  const onRegenerateLn = useCallback(() => {
    setDepositId(null)
    setBolt11(null)
    setBolt11ExpiresAt(null)
    setState(null)
    setStateUpdatedAt(null)
    setError(null)
  }, [])

  const isTerminal = state ? TERMINAL_STATES.includes(state) : false
  const credited = state === 'Credited'
  const failed = state === 'Failed'
  const invoiceExpiresAtSec = bolt11ExpiresAt
    ? Math.floor(new Date(bolt11ExpiresAt).getTime() / 1000)
    : undefined
  const invoiceStatus =
    failed ? 'error' : state === 'Paid' || credited ? 'paid' : 'pending'

  if (bolt11 && !credited) {
    return (
      <InvoiceDisplay
        bolt11={bolt11}
        amountSats={amountSats}
        status={invoiceStatus}
        expiresAtSec={invoiceExpiresAtSec}
        errorMessage={error}
        onClose={() => setBolt11(null)}
        onRegenerate={onRegenerateLn}
      />
    )
  }

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">{t('marketCreation.depositTitle')}</h2>
      <p className="text-sm text-slate-400 mb-6">
        {t('marketCreation.depositSubtitle')}
      </p>

      <div data-testid="condition-id" className="mb-6 p-3 rounded-lg bg-slate-900 border border-slate-800">
        <p className="text-xs text-slate-500 mb-1">{t('marketCreation.marketCreatedLabel')}</p>
        <p className="text-xs font-mono text-slate-300 break-all">{conditionId}</p>
      </div>

      {!depositId && (
        <>
          <div className="flex gap-2 mb-6 border-b border-slate-800">
            <TabButton active={tab === 'ln'} onClick={() => setTab('ln')} icon={<Zap className="w-4 h-4" />} label={t('marketCreation.tabLightning')} testid="tab-ln" />
            <TabButton active={tab === 'ecash'} onClick={() => setTab('ecash')} icon={<Coins className="w-4 h-4" />} label={t('marketCreation.tabEcash')} testid="tab-ecash" />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-slate-300 mb-2">{t('marketCreation.amountSats')}</label>
            <input
              data-testid="amount-input"
              type="number"
              min={1}
              value={amountSats}
              onChange={(e) => setAmountSats(Math.max(1, Number.parseInt(e.target.value, 10) || 0))}
              className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
            />
          </div>

          {tab === 'ln' && (
            <button
              data-testid="request-ln-invoice"
              type="button"
              disabled={submitting || amountSats < 1}
              onClick={onRequestLn}
              className="w-full px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {t('marketCreation.requestLightningInvoice')}
            </button>
          )}

          {tab === 'ecash' && (
            <>
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-300 mb-2">{t('marketCreation.ecashTokenLabel')}</label>
                <textarea
                  data-testid="ecash-token-input"
                  value={ecashToken}
                  onChange={(e) => setEcashToken(e.target.value)}
                  placeholder={t('marketCreation.ecashTokenPlaceholder')}
                  rows={4}
                  className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-xs font-mono placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 resize-none"
                />
                <p className="text-xs text-slate-500 mt-1.5">
                  {t('marketCreation.ecashTokenHint')}
                </p>
              </div>
              <button
                data-testid="submit-ecash"
                type="button"
                disabled={submitting || ecashToken.trim().length === 0 || amountSats < 1}
                onClick={onSubmitEcash}
                className="w-full px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                {t('marketCreation.submitEcash')}
              </button>
            </>
          )}
        </>
      )}

      {state && !credited && !failed && (
        <div data-testid="deposit-status" className="mb-4 p-4 rounded-lg bg-slate-900 border border-slate-700 flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
          <div>
            <p className="text-sm font-medium text-white">{stateLabel(state, t)}</p>
            {stateUpdatedAt && (
              <p className="text-xs text-slate-500">{t('marketCreation.lastUpdate', { time: new Date(stateUpdatedAt).toLocaleTimeString() })}</p>
            )}
          </div>
        </div>
      )}

      {credited && (
        <div data-testid="deposit-credited" className="mb-4 p-4 rounded-lg bg-green-950/40 border border-green-800/60 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">{t('marketCreation.botFunded')}</p>
            <p className="text-xs text-slate-300">{t('marketCreation.botFundedHint')}</p>
          </div>
        </div>
      )}

      {failed && (
        <div data-testid="deposit-failed" className="mb-4 p-4 rounded-lg bg-red-950/40 border border-red-800/60 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">{t('marketCreation.depositFailed')}</p>
            <p className="text-xs text-slate-300">
              {t('marketCreation.depositFailedHint')}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-950/30 border border-red-900/50 text-xs text-red-300">
          {error}
        </div>
      )}

      {isTerminal && (
        <button
          data-testid="continue-to-market"
          type="button"
          onClick={onContinue}
          className="w-full px-4 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
        >
          {t('marketCreation.continueToMarket')}
        </button>
      )}

      {!credited && (
        <button
          data-testid="skip-liquidity"
          type="button"
          onClick={onContinue}
          className="mt-3 w-full px-4 py-3 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
        >
          {t('marketCreation.skipLiquidityProvisioning')}
        </button>
      )}
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  testid: string
}

function TabButton({ active, onClick, icon, label, testid }: TabButtonProps) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'text-white border-blue-500'
          : 'text-slate-400 border-transparent hover:text-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function stateLabel(state: DepositState, t: (key: string) => string): string {
  switch (state) {
    case 'Requested':
      return t('marketCreation.statusAwaitingPayment')
    case 'Paid':
      return t('marketCreation.statusPaymentReceived')
    case 'Credited':
      return t('marketCreation.statusFunded')
    case 'Failed':
      return t('marketCreation.statusFailed')
  }
}
