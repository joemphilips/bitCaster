import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Plus, TrendingUp, CheckCircle2, BarChart3, Coins, AlertCircle } from 'lucide-react'
import { formatBtc } from '@/lib/format'
import { useCreatorDashboardState } from '@/hooks/useCreatorDashboardState'
import { MyMarkets } from '@/components/portfolio/MyMarkets'
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
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview')
  const { stats, markets, isLoading, error, pubkey } = useCreatorDashboardState()

  const handleCreateMarket = () => navigate('/creator/new')
  const handleViewMarket = (marketId: string) => navigate(`/markets/${marketId}`)

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-3xl">
              Your Markets
            </h1>
            <p className="mt-1 text-slate-500 dark:text-slate-400">
              Create and manage your prediction markets
            </p>
          </div>

          <button
            onClick={handleCreateMarket}
            className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-blue-600 via-blue-600 to-blue-700 px-6 py-3 text-base font-bold text-white shadow-lg shadow-blue-500/30 transition-all hover:scale-[1.02] hover:shadow-xl hover:shadow-blue-500/40 active:scale-[0.98]"
          >
            <div className="absolute inset-0 -translate-x-full animate-[shimmer_3s_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <Plus className="relative h-5 w-5" />
            <span className="relative">Create Market</span>
          </button>
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
              {tab === 'overview' ? 'Overview' : 'Analytics'}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Wallet prompt — creator state lives on the client, so without a
               wallet we have nothing to scope this dashboard to. */}
            {!pubkey && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                Set up a wallet to start creating markets — your creator activity
                is scoped to your Nostr identity.
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label="Active Markets"
                value={stats.activeMarketsCount}
                subValue="Currently trading"
                icon={<TrendingUp className="h-5 w-5" />}
              />
              <StatCard
                label="Resolved"
                value={stats.resolvedMarketsCount}
                subValue="Completed markets"
                icon={<CheckCircle2 className="h-5 w-5" />}
              />
              <StatCard
                label="Total Volume"
                value={formatBtc(stats.totalVolumeSats)}
                subValue="Traded"
                icon={<BarChart3 className="h-5 w-5" />}
              />
              <StatCard
                label="Fees Earned"
                value={formatBtc(stats.totalFeesEarnedSats)}
                subValue="Coming soon"
                icon={<Coins className="h-5 w-5" />}
              />
            </div>

            {/* Error banner — markets still render from the client store, so
               this is informational only. */}
            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">Couldn't load live volume data.</p>
                  <p className="mt-0.5 text-xs opacity-80">{error}</p>
                </div>
              </div>
            )}

            {/* Market list */}
            <div>
              <h2 className="mb-4 text-lg font-bold text-slate-900 dark:text-white">
                Your Markets
              </h2>

              {markets.length === 0 ? (
                <EmptyState isLoading={isLoading} onCreate={handleCreateMarket} />
              ) : (
                <MyMarkets
                  markets={markets}
                  onViewMarket={handleViewMarket}
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
  return (
    <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white/50 p-12 text-center dark:border-slate-700 dark:bg-slate-900/50">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
        <Plus className="h-8 w-8" />
      </div>
      <h3 className="text-lg font-bold text-slate-900 dark:text-white">
        {isLoading ? 'Loading your markets…' : 'Create your first market'}
      </h3>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        Start earning fees by creating prediction markets for others to trade.
      </p>
      <button
        onClick={onCreate}
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 font-bold text-white shadow-md transition-all hover:bg-blue-700 hover:shadow-lg"
      >
        <Plus className="h-5 w-5" />
        Create Market
      </button>
    </div>
  )
}
