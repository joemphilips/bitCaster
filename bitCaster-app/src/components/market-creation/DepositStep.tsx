import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AlertTriangle, Check, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LocalWalletPayButton } from '@/components/shared/LocalWalletPayButton'
import { resolveCreatorPubkey } from '@/lib/identityOps'
import {
  BINARY_AMM_FUNDING_TIERS,
  formatFundingBudget,
  fundingTierBudget,
  type AmmFundingTierId,
} from '@/lib/marketMakerFunding'
import { getDepositStatus, requestEcashDeposit, type DepositState } from '@/lib/markets'
import { useSettingsStore } from '@/stores/settings'
import type { MarketBaseAsset } from '@/types/market-creation'
import { estimateDepthPreview } from '@bitcaster/client-sdk/lmsrDomain'
import { defaultCollateralUnit, normalizeMarketDivisibility } from '@bitcaster/client-sdk/marketUnits'

function isFundingDepositComplete(state: DepositState | null | undefined): boolean {
  if (state == null) return false
  switch (state) {
    case 'requested':
    case 'failed':
      return false
    case 'paid':
    case 'credited':
      return true
    default:
      return assertNeverDepositState(state)
  }
}

function isFundingDepositPending(state: DepositState | null | undefined): boolean {
  return state === 'requested'
}

function assertNeverDepositState(state: never): never {
  throw new Error(`Unhandled deposit state: ${String(state)}`)
}

function fundingUnitForBaseAsset(baseAsset: MarketBaseAsset): 'sat' | 'usd' {
  if (baseAsset === 'usd') return 'usd'
  if (baseAsset === 'sat') return 'sat'
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function customBudgetInputToSubunits(customBudgetInput: number, baseAsset: MarketBaseAsset): number {
  if (baseAsset === 'usd') return Math.round(customBudgetInput * 100)
  if (baseAsset === 'sat') return Math.max(0, Math.floor(customBudgetInput * 1000))
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function customBudgetInputStep(baseAsset: MarketBaseAsset): string {
  if (baseAsset === 'usd') return '0.01'
  if (baseAsset === 'sat') return '1'
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

function customBudgetInputMode(baseAsset: MarketBaseAsset): 'decimal' | 'numeric' {
  if (baseAsset === 'usd') return 'decimal'
  if (baseAsset === 'sat') return 'numeric'
  throw new Error(`unsupported base asset: ${baseAsset}`)
}

interface DepositStepProps {
  /** The just-created market's condition id, returned by `createMarket`. */
  conditionId: string
  /** Kept for wizard prop compatibility with older call sites. */
  defaultAmountSats: number
  /** Outcome count controls the categorical AMM funding scale. */
  outcomeCount?: number
  /** Market collateral unit. Legacy `*Sats` fields below are base subunits. */
  baseAsset?: MarketBaseAsset
}

export function DepositStep({ conditionId, outcomeCount = 2, baseAsset = 'sat' }: DepositStepProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [selectedTier, setSelectedTier] = useState<AmmFundingTierId>('standard')
  const [customBudgetInput, setCustomBudgetInput] = useState(0)
  const [stage, setStage] = useState<'created' | 'funding'>('created')
  const [depositState, setDepositState] = useState<DepositState | null>(null)
  const [activeDepositId, setActiveDepositId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fundingUnit = fundingUnitForBaseAsset(baseAsset)
  const cashuUnit = defaultCollateralUnit(baseAsset)
  const divisibility = normalizeMarketDivisibility(undefined, baseAsset)
  const customBudgetSubunits = customBudgetInputToSubunits(customBudgetInput, baseAsset)

  useEffect(() => {
    const timer = window.setTimeout(() => setStage('funding'), 5_000)
    return () => window.clearTimeout(timer)
  }, [])

  const tiers = useMemo(
    () =>
      BINARY_AMM_FUNDING_TIERS.map((tier) => ({
        ...tier,
        budgetSats: fundingTierBudget(tier, baseAsset),
      })),
    [baseAsset],
  )
  const selectedTierBudget =
    tiers.find((tier) => tier.id === selectedTier)?.budgetSats ?? customBudgetSubunits
  const budgetSats = selectedTier === 'custom' ? customBudgetSubunits : selectedTierBudget
  const customBudgetPreview = formatFundingBudget(customBudgetSubunits, fundingUnit)
  const showWarning = selectedTier === 'minimal'
  const depthPreview = selectedTier === 'none'
    ? null
    : estimateDepthPreview({ budgetSubunits: budgetSats, outcomeCount })

  const continueToMarket = useCallback(() => {
    navigate(`/markets/${conditionId}`)
  }, [conditionId, navigate])

  useEffect(() => {
    if (!isFundingDepositComplete(depositState)) return undefined
    const timer = window.setTimeout(continueToMarket, 5_000)
    return () => window.clearTimeout(timer)
  }, [continueToMarket, depositState])

  useEffect(() => {
    if (!activeDepositId || !isFundingDepositPending(depositState)) return undefined
    let cancelled = false
    let timer: number | undefined
    const schedulePoll = () => {
      timer = window.setTimeout(poll, 2_000)
    }
    const poll = async () => {
      try {
        const status = await getDepositStatus(conditionId, activeDepositId)
        if (cancelled) return
        if (status == null) {
          schedulePoll()
          return
        }
        setDepositState(status.state)
        if (isFundingDepositPending(status.state)) {
          schedulePoll()
        } else {
          setActiveDepositId(null)
        }
      } catch {
        if (!cancelled) {
          setError(t('marketCreation.statusPollError'))
          schedulePoll()
        }
      }
    }
    schedulePoll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeDepositId, conditionId, depositState, t])

  const onSubmitLocalWalletToken = useCallback(async (token: string) => {
    if (budgetSats < 1) return { accepted: false } as const
    setError(null)
    setDepositState(null)
    setActiveDepositId(null)
    try {
      const settings = useSettingsStore.getState()
      const creatorPubkey = resolveCreatorPubkey({
        nostrSignerMode: settings.nostrSignerMode,
        nsecSecret: settings.nsecSecret,
        nostrProfilePubkey: settings.nostrProfile?.pubkey,
      })
      const result = await requestEcashDeposit(conditionId, budgetSats, token, {
        creatorPubkey,
        fundAmm: true,
        unit: cashuUnit,
        divisibility,
      })
      setDepositState(result.state)
      if (isFundingDepositPending(result.state)) {
        setActiveDepositId(result.depositId)
      }
      return result.state === 'failed' ? { accepted: false } as const : { accepted: true } as const
    } catch (err) {
      setError(err instanceof Error ? err.message : t('marketCreation.ecashSubmitError'))
      throw err
    }
  }, [budgetSats, cashuUnit, conditionId, divisibility, t])

  if (stage === 'created') {
    return (
      <div className="w-full max-w-xl">
        <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300">
          <Check className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
          {t('marketCreation.marketCreatedTitle')}
        </h2>
        <p className="text-sm text-slate-400 mb-6">
          {t('marketCreation.marketCreatedAttractTraders')}
        </p>
        <button
          type="button"
          onClick={() => setStage('funding')}
          className="rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >
          {t('marketCreation.attractTraders')}
        </button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-2xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t('marketCreation.ammFundingTitle')}
      </h2>
      <p className="text-sm text-slate-400 mb-5">
        {t('marketCreation.ammFundingSubtitle')}
      </p>

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
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
              {formatFundingBudget(tier.budgetSats, fundingUnit, { wholeUsd: true })}
            </span>
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
          step={customBudgetInputStep(baseAsset)}
          inputMode={customBudgetInputMode(baseAsset)}
          aria-describedby="amm-funding-custom-preview"
          value={customBudgetInput}
          onChange={(event) => {
            setSelectedTier('custom')
            setCustomBudgetInput(Math.max(0, Number(event.target.value) || 0))
          }}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-400"
        />
        <span id="amm-funding-custom-preview" className="mt-2 block text-xs text-slate-400">
          {t('marketCreation.ammFundingCustomPreview', {
            amount: customBudgetPreview,
          })}
        </span>
      </label>

      {showWarning && (
        <div className="mb-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
          <span className="font-semibold">{t('marketCreation.ammFundingWarningBadge')}</span>
          <span className="ml-2">{t('marketCreation.ammFundingMinimalWarning')}</span>
        </div>
      )}

      {depthPreview && (
        <div className="mb-4 rounded-lg border border-blue-400/30 bg-blue-400/10 p-3 text-sm text-blue-100">
          <p>
            {t('marketCreation.ammFundingDepthPreview', {
              levels: depthPreview.levelsPerSide,
              shares: depthPreview.sharesPerLevel.toLocaleString(),
            })}
          </p>
          <p className="mt-1 text-xs text-blue-100/80">
            {t('marketCreation.ammFundingDepthPreviewDisclaimer')}
          </p>
        </div>
      )}

      <div className="mb-4 flex gap-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" strokeWidth={1.75} />
        <p>{t('marketCreation.ammFundingDisclosure')}</p>
      </div>

      {depositState && (
        depositState === 'failed' ? (
          <div className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
            <p className="font-semibold">{t('marketCreation.depositFailed')}</p>
            <p className="mt-1">{t('marketCreation.depositFailedHint')}</p>
          </div>
        ) : (
          <p className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
            {isFundingDepositComplete(depositState)
              ? t('marketCreation.statusPaymentReceived')
              : t('marketCreation.statusAwaitingPayment')}
          </p>
        )
      )}

      {selectedTier === 'none' ? (
        <button
          data-testid="confirm-amm-funding"
          type="button"
          onClick={continueToMarket}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {t('marketCreation.continueToMarket')}
        </button>
      ) : (
        <LocalWalletPayButton
          testId="confirm-amm-funding"
          amountSubunits={budgetSats}
          baseAsset={baseAsset}
          unit={cashuUnit}
          reservationPurpose="market-funding"
          pending={isFundingDepositPending(depositState)}
          failed={depositState === 'failed'}
          disabled={budgetSats < 1 || isFundingDepositComplete(depositState)}
          onTokenPayment={onSubmitLocalWalletToken}
        />
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
          {error}
        </p>
      )}
    </div>
  )
}
