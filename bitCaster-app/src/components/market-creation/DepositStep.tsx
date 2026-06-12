import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { resolveCreatorPubkey } from '@/lib/identityOps'
import {
  BINARY_AMM_FUNDING_TIERS,
  MIN_THIN_LIQUIDITY_WARNING_SATS,
  type AmmFundingTierId,
  calculateAmmFundingPreview,
  displayedFundingBudgetSats,
} from '@/lib/marketMakerFunding'
import { requestLnInvoiceDeposit, type RequestLnInvoiceDepositResponse } from '@/lib/markets'
import { useSettingsStore } from '@/stores/settings'

interface DepositStepProps {
  /** The just-created market's condition id, returned by `createMarket`. */
  conditionId: string
  /** Kept for wizard prop compatibility with older call sites. */
  defaultAmountSats: number
  /** Outcome count controls the categorical AMM funding scale. */
  outcomeCount?: number
}

function formatSats(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString()
}

export function DepositStep({ conditionId, outcomeCount = 2 }: DepositStepProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [selectedTier, setSelectedTier] = useState<AmmFundingTierId>('standard')
  const [customBudgetSats, setCustomBudgetSats] = useState(0)
  const [invoice, setInvoice] = useState<RequestLnInvoiceDepositResponse | null>(null)
  const [isRequesting, setIsRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tiers = useMemo(
    () =>
      BINARY_AMM_FUNDING_TIERS.map((tier) => ({
        ...tier,
        budgetSats: displayedFundingBudgetSats(tier.baseBudgetSats, outcomeCount),
      })),
    [outcomeCount],
  )
  const selectedTierBudget =
    tiers.find((tier) => tier.id === selectedTier)?.budgetSats ?? customBudgetSats
  const budgetSats = selectedTier === 'custom' ? customBudgetSats : selectedTierBudget
  const preview = calculateAmmFundingPreview(budgetSats, outcomeCount)
  const showWarning =
    selectedTier === 'minimal' ||
    (selectedTier === 'custom' && budgetSats < MIN_THIN_LIQUIDITY_WARNING_SATS)

  const onSkip = () => {
    navigate(`/markets/${conditionId}`)
  }

  const onRequestInvoice = async () => {
    if (isRequesting || budgetSats < 1) return
    setIsRequesting(true)
    setError(null)
    try {
      const settings = useSettingsStore.getState()
      const creatorPubkey = resolveCreatorPubkey({
        nostrSignerMode: settings.nostrSignerMode,
        nsecSecret: settings.nsecSecret,
        nostrProfilePubkey: settings.nostrProfile?.pubkey,
      })
      const result = await requestLnInvoiceDeposit(conditionId, budgetSats, {
        creatorPubkey,
        fundAmm: true,
      })
      setInvoice(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('marketCreation.ammFundingRequestFailed'))
    } finally {
      setIsRequesting(false)
    }
  }

  return (
    <div className="w-full max-w-2xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t('marketCreation.ammFundingTitle')}
      </h2>
      <p className="text-sm text-slate-400 mb-5">
        {t('marketCreation.ammFundingSubtitle')}
      </p>

      <button
        data-testid="skip-amm-funding"
        type="button"
        onClick={onSkip}
        className="mb-5 w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-left text-sm font-semibold text-slate-100 transition-colors hover:border-slate-500 hover:bg-slate-800"
      >
        {t('marketCreation.skipAmmFunding')}
      </button>

      <div data-testid="condition-id" className="mb-5 rounded-lg border border-slate-800 bg-slate-900 p-3">
        <p className="mb-1 text-xs text-slate-500">
          {t('marketCreation.marketCreatedLabel')}
        </p>
        <p className="break-all font-mono text-xs text-slate-300">{conditionId}</p>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {tiers.map((tier) => (
          <button
            key={tier.id}
            data-testid={`amm-funding-tier-${tier.id}`}
            type="button"
            onClick={() => setSelectedTier(tier.id)}
            className={`rounded-lg border p-4 text-left transition-colors ${
              selectedTier === tier.id
                ? 'border-blue-400 bg-blue-500/10'
                : 'border-slate-800 bg-slate-900 hover:border-slate-600'
            }`}
          >
            <span className="block text-sm font-semibold text-white">
              {t(`marketCreation.ammFundingTier.${tier.id}`)}
            </span>
            <span className="mt-1 block text-lg font-bold text-slate-100">
              {formatSats(tier.budgetSats)}
            </span>
            <span className="text-xs text-slate-500">{t('marketCreation.satsSuffix')}</span>
            {tier.warning && (
              <span className="mt-3 inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-normal text-amber-200">
                <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                {t('marketCreation.ammFundingWarningBadge')}
              </span>
            )}
          </button>
        ))}
      </div>

      <label className="mb-5 block rounded-lg border border-slate-800 bg-slate-900 p-4">
        <span className="mb-2 block text-sm font-semibold text-white">
          {t('marketCreation.ammFundingTier.custom')}
        </span>
        <input
          data-testid="amm-funding-custom-budget"
          type="number"
          min={0}
          inputMode="numeric"
          value={customBudgetSats}
          onChange={(event) => {
            setSelectedTier('custom')
            setCustomBudgetSats(Math.max(0, Number(event.target.value) || 0))
          }}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
        />
      </label>

      {showWarning && (
        <div className="mb-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          <span className="font-semibold">{t('marketCreation.ammFundingWarningBadge')}</span>
          <span className="ml-2">{t('marketCreation.ammFundingThinLiquidity')}</span>
        </div>
      )}

      <div className="mb-5 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <p className="text-sm font-semibold text-white">
          {t('marketCreation.ammFundingDepthPreviewTitle')}
        </p>
        <p className="mt-2 text-sm text-slate-300">
          {t('marketCreation.ammFundingDepthPreviewMove', {
            sats: formatSats(preview.depthPerCentSats),
            cents: 1,
          })}
        </p>
        <p className="mt-1 text-sm text-slate-300">
          {t('marketCreation.ammFundingDepthPreviewCost', {
            sats: formatSats(preview.cost50To60Sats),
          })}
        </p>
      </div>

      <p
        data-testid="amm-funding-disclosure"
        className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm leading-relaxed text-red-100"
      >
        {t('marketCreation.ammFundingDisclosure')}
      </p>

      <button
        data-testid="confirm-amm-funding"
        type="button"
        onClick={onRequestInvoice}
        disabled={isRequesting || budgetSats < 1}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        {isRequesting ? (
          <span className="inline-flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('marketCreation.ammFundingRequestingInvoice')}
          </span>
        ) : (
          t('marketCreation.ammFundingConfirm')
        )}
      </button>

      {error && (
        <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
          {error}
        </p>
      )}

      {invoice && (
        <div className="mt-5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-4">
          <p className="mb-2 inline-flex items-center gap-2 text-sm font-semibold text-emerald-100">
            <Check className="h-4 w-4" strokeWidth={1.75} />
            {t('marketCreation.ammFundingInvoiceReady')}
          </p>
          <p className="break-all rounded border border-emerald-400/20 bg-slate-950 p-3 font-mono text-xs text-emerald-50">
            {invoice.bolt11}
          </p>
          <button
            type="button"
            onClick={onSkip}
            className="mt-4 w-full rounded-lg border border-emerald-300/30 px-4 py-3 text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-400/10"
          >
            {t('marketCreation.continueToMarket')}
          </button>
        </div>
      )}
    </div>
  )
}
