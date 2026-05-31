import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Plus, TrendingUp, CheckCircle2, BarChart3, Coins, AlertCircle } from 'lucide-react'
import { formatBtc } from '@/lib/format'
import { buildOracleAttestationEvent } from '@/lib/oracleAttestation'
import { signEnumAttestation } from '@/lib/kormir'
import { submitOracleAttestation } from '@/lib/markets'
import { useCreatorDashboardState } from '@/hooks/useCreatorDashboardState'
import { MyMarkets } from '@/components/portfolio/MyMarkets'
import { PrimaryGradientButton } from '@/components/shared/PrimaryGradientButton'
import { useCreatorMarketsStore } from '@/stores/creatorMarkets'
import { useSettingsStore } from '@/stores/settings'
import { AnalyticsComingSoon } from './AnalyticsComingSoon'

type ActiveTab = 'overview' | 'analytics'

interface StatCardProps {
  label: string
  value: string | number
  subValue: string
  icon: React.ReactNode
}

function StatCard({ label, value, subValue, icon }: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <span className="text-slate-400 dark:text-slate-500">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">
        {value}
      </div>
      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{subValue}</div>
    </div>
  )
}

/**
 * Creator Dashboard at `/creator`.
 *
 * Three sections:
 *  - Overview — stats grid + list of markets the user has created (reuses the
 *    portfolio `MyMarkets` / `CreatedMarketRow` components so the look-and-
 *    feel is consistent with the bottom-of-portfolio section).
 *  - Analytics — placeholder until we have a real volume chart.
 *  - "Create Market" button — routes to the existing wizard at `/creator/new`.
 */
export function CreatorDashboard() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview')
  const [resolvingMarketId, setResolvingMarketId] = useState<string | null>(null)
  const [resolutionError, setResolutionError] = useState<string | null>(null)
  const [resolutionSuccess, setResolutionSuccess] = useState<string | null>(null)
  const { stats, markets, isLoading, error, pubkey, refresh } = useCreatorDashboardState()
  const signerMode = useSettingsStore((s) => s.nostrSignerMode)
  const nsecSecret = useSettingsStore((s) => s.nsecSecret)
  const relays = useSettingsStore((s) => s.relays)
  const markOracleAttested = useCreatorMarketsStore((s) => s.markOracleAttested)

  const handleCreateMarket = () => navigate('/creator/new')
  const handleViewMarket = (marketId: string) => navigate(`/markets/${marketId}`)
  const handlePublishOracleAttestation = async (marketId: string, outcome: string) => {
    const market = markets.find((m) => m.id === marketId)
    if (!market?.oracle) return
    setResolutionError(null)
    setResolutionSuccess(null)
    if (!market.oracle.outcomes.includes(outcome)) {
      setResolutionError(t('creator.invalidAttestationOutcome'))
      return
    }
    if (signerMode !== 'nsec') {
      setResolutionError(t('creator.nsecRequiredToResolve'))
      return
    }
    if (!nsecSecret) {
      setResolutionError(t('creator.nsecRequiredToResolve'))
      return
    }
    const confirmed = window.confirm(
      t('creator.closeMarketConfirm', { title: market.title, outcome }),
    )
    if (!confirmed) return
    const relayUrls = relays.map((r) => r.url)
    if (relayUrls.length === 0) {
      setResolutionError(t('creator.relayRequiredToResolve'))
      return
    }
    setResolvingMarketId(marketId)
    try {
      // Sign against the announcement's COMMITTED nonce via kormir. The mint
      // enforces the DLC committed-nonce scheme at redeem; a fresh-nonce
      // signature would close the market but leave it unclaimable.
      //
      // Pass the mirrored announcement hex so a fresh browser profile (which
      // restored only the oracle nsec and lost kormir's nonce-index store) can
      // re-import the committed-nonce material before signing (P22 B1b). The
      // import is idempotent and non-destructive when the event already exists.
      const attestationHex = await signEnumAttestation(
        relayUrls,
        market.oracle.eventId,
        outcome,
        market.oracle.announcementHex,
      )
      const attestation = buildOracleAttestationEvent(nsecSecret, attestationHex)
      await submitOracleAttestation(marketId, attestation)
      markOracleAttested(marketId, {
        outcome,
        attestationHex: attestation.content,
        attestedAt: new Date().toISOString(),
      })
      setResolutionSuccess(t('creator.attestationPublished', { outcome }))
      refresh()
    } catch (err) {
      setResolutionError(
        err instanceof Error ? err.message : t('creator.attestationPublishFailed'),
      )
    } finally {
      setResolvingMarketId(null)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-3xl">
              {t('creator.title')}
            </h1>
            <p className="mt-1 text-slate-500 dark:text-slate-400">
              {t('creator.subtitle')}
            </p>
          </div>

          <PrimaryGradientButton onClick={handleCreateMarket} icon={Plus}>
            {t('creator.createMarket')}
          </PrimaryGradientButton>
        </div>

        {/* Tab navigation */}
        <div className="mb-6 flex items-center gap-1 rounded-xl bg-slate-100 p-1.5 dark:bg-slate-800">
          {(['overview', 'analytics'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all sm:flex-none ${
                activeTab === tab
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              }`}
            >
              {tab === 'overview' ? t('creator.tabOverview') : t('creator.tabAnalytics')}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Wallet prompt — creator state lives on the client, so without a
               wallet we have nothing to scope this dashboard to. */}
            {!pubkey && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {t('creator.walletPrompt')}
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label={t('creator.statActiveMarkets')}
                value={stats.activeMarketsCount}
                subValue={t('creator.statActiveMarketsSub')}
                icon={<TrendingUp className="h-5 w-5" />}
              />
              <StatCard
                label={t('creator.statResolved')}
                value={stats.resolvedMarketsCount}
                subValue={t('creator.statResolvedSub')}
                icon={<CheckCircle2 className="h-5 w-5" />}
              />
              <StatCard
                label={t('creator.statTotalVolume')}
                value={formatBtc(stats.totalVolumeSats)}
                subValue={t('creator.statTotalVolumeSub')}
                icon={<BarChart3 className="h-5 w-5" />}
              />
              <StatCard
                label={t('creator.statFeesEarned')}
                value={formatBtc(stats.totalFeesEarnedSats)}
                subValue={t('creator.statFeesEarnedSub')}
                icon={<Coins className="h-5 w-5" />}
              />
            </div>

            {/* Error banner — markets still render from the client store, so
               this is informational only. */}
            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">{t('creator.volumeErrorTitle')}</p>
                  <p className="mt-0.5 text-xs opacity-80">{error}</p>
                </div>
              </div>
            )}

            {resolutionError && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">{t('creator.attestationErrorTitle')}</p>
                  <p className="mt-0.5 text-xs opacity-80">{resolutionError}</p>
                </div>
              </div>
            )}

            {resolutionSuccess && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                {resolutionSuccess}
              </div>
            )}

            {/* Market list */}
            <div>
              {markets.length === 0 ? (
                <EmptyState isLoading={isLoading} onCreate={handleCreateMarket} />
              ) : (
                <MyMarkets
                  markets={markets}
                  onViewMarket={handleViewMarket}
                  onPublishOracleAttestation={handlePublishOracleAttestation}
                  publishingOracleAttestationMarketId={resolvingMarketId}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === 'analytics' && <AnalyticsComingSoon />}
      </div>
    </div>
  )
}

interface EmptyStateProps {
  isLoading: boolean
  onCreate: () => void
}

function EmptyState({ isLoading, onCreate }: EmptyStateProps) {
  const { t } = useTranslation()
  return (
    <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white/50 p-12 text-center dark:border-slate-700 dark:bg-slate-900/50">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
        <Plus className="h-8 w-8" />
      </div>
      <h3 className="text-lg font-bold text-slate-900 dark:text-white">
        {isLoading ? t('creator.emptyLoading') : t('creator.emptyTitle')}
      </h3>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        {t('creator.emptyDesc')}
      </p>
      <button
        onClick={onCreate}
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 font-bold text-white shadow-md transition-all hover:bg-blue-700 hover:shadow-lg"
      >
        <Plus className="h-5 w-5" />
        {t('creator.createMarket')}
      </button>
    </div>
  )
}
