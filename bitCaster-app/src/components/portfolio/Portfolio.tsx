import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PortfolioProps } from '@/types/portfolio'
import { Settings, Zap } from 'lucide-react'
import { ProfileCard } from './ProfileCard'
import { PrimaryGradientButton } from '@/components/shared/PrimaryGradientButton'
import { PLChart } from './PLChart'
import { StatsRow } from './StatsRow'
import { PositionsList } from './PositionsList'
import { FundsList } from './FundsList'
import { ActivityFeed } from './ActivityFeed'
import { MyMarkets } from './MyMarkets'
import { LikedMarkets } from './LikedMarkets'

type MainTab = 'positions' | 'funds' | 'activity'

export function Portfolio(props: PortfolioProps) {
  const { t } = useTranslation()
  const [mainTab, setMainTab] = useState<MainTab>('positions')

  // No-wallet CTA state
  if (props.walletState === 'none') {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
        <div className="w-20 h-20 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-6">
          <span className="text-4xl">&#8383;</span>
        </div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          {t('portfolio.welcomeTitle')}
        </h2>
        <p className="text-slate-500 dark:text-slate-400 max-w-sm mb-6">
          {t('portfolio.welcomeDesc')}
        </p>
        <button
          onClick={() => props.onGetStarted?.()}
          className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors"
        >
          {t('wallet.getStarted')}
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header with Settings */}
      <div className="flex items-start justify-between">
        <div className="flex-1" />
        <button
          onClick={() => props.onOpenSettings?.()}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          aria-label="Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>

      {/* Profile + Chart Section */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left: Profile */}
          <div className="flex flex-col gap-3">
            <ProfileCard
              profile={props.profile}
              onAvatarUpload={props.onAvatarUpload}
            />
            {/* P5 item 4: Anon users have no identity across reloads —
                surface the Nostr connect flow here so they can find it
                without hunting through the Settings category list. */}
            {props.showConnectNostrCta && (
              <PrimaryGradientButton
                onClick={() => props.onConnectNostr?.()}
                icon={Zap}
              >
                {t('portfolio.connectNostr')}
              </PrimaryGradientButton>
            )}
          </div>

          {/* Right: P/L Chart */}
          <PLChart
            chartData={props.plChartData}
            selectedTimeRange={props.selectedTimeRange}
            totalValueSats={props.stats.totalValueSats}
            onTimeRangeChange={props.onTimeRangeChange}
          />
        </div>
      </div>

      {/* Stats Row */}
      <StatsRow stats={props.stats} />

      {/* Deposit / Withdraw Buttons */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => props.onDeposit?.()}
          className="py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-colors"
        >
          {t('common.deposit')}
        </button>
        <button
          onClick={() => props.onWithdraw?.()}
          className="py-3 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-900 dark:text-white font-semibold transition-colors border border-slate-200 dark:border-slate-600"
        >
          {t('common.withdraw')}
        </button>
      </div>

      {/* Main Tabs: Positions | Funds | Activity */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="flex border-b border-slate-200 dark:border-slate-700" role="tablist">
          {(['positions', 'funds', 'activity'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={mainTab === tab}
              onClick={() => setMainTab(tab)}
              className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
                mainTab === tab
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {t(`portfolio.${tab}`)}
              {mainTab === tab && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400" />
              )}
            </button>
          ))}
        </div>

        <div className="p-4" role="tabpanel">
          {mainTab === 'positions' && (
            <PositionsList
              positions={props.positions}
              positionsTab={props.positionsTab}
              onPositionsTabChange={props.onPositionsTabChange}
              onSellPosition={props.onSellPosition}
              onClaimPayout={props.onClaimPayout}
              onViewPosition={props.onViewPosition}
            />
          )}
          {mainTab === 'funds' && (
            <FundsList
              funds={props.funds}
              onViewFund={props.onViewFund}
            />
          )}
          {mainTab === 'activity' && (
            <ActivityFeed
              activity={props.activity}
              onViewActivity={props.onViewActivity}
            />
          )}
        </div>
      </div>

      {/* Liked / Bookmarked Markets (P5.1) */}
      <LikedMarkets onViewMarket={props.onViewMarket} />

      {/* My Markets (Collapsible) */}
      <MyMarkets
        markets={props.createdMarkets}
        onViewMarket={props.onViewMarket}
        onClaimCreatorFees={props.onClaimCreatorFees}
      />
    </div>
  )
}
