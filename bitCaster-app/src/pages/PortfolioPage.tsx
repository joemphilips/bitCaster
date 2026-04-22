import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router'
import { Portfolio } from '@/components/portfolio'
import { DepositWithdrawOverlay } from '@/components/deposit-withdraw/DepositWithdrawOverlay'
import { usePortfolioState } from './usePortfolioState'
import { useSettingsStore } from '@/stores/settings'
import type { PLTimeSelector } from '@/types/portfolio'
import type { DepositWithdrawMode } from '@/types/deposit-withdraw'

export function PortfolioPage() {
  const navigate = useNavigate()
  const state = usePortfolioState()
  const [overlayMode, setOverlayMode] = useState<DepositWithdrawMode | null>(null)

  const handleGetStarted = useCallback(() => {
    navigate('/setup', { state: { from: '/portfolio' } })
  }, [navigate])

  const handleAvatarUpload = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file)
      state.saveProfile({ ...state.profile, avatarUrl: url })
    },
    [state]
  )

  const handleTimeRangeChange = useCallback(
    (range: PLTimeSelector) => {
      state.setSelectedTimeRange(range)
    },
    [state]
  )

  const handleDeposit = useCallback(() => {
    setOverlayMode('deposit')
  }, [])

  const handleWithdraw = useCallback(() => {
    setOverlayMode('withdraw')
  }, [])

  const handleSellPosition = useCallback(
    (positionId: string) => {
      const position = state.positions.find((p) => p.id === positionId)
      if (position) {
        navigate(`/markets/${position.marketId}`)
      }
    },
    [navigate, state.positions]
  )

  const handleViewPosition = useCallback(
    (positionId: string) => {
      const position = state.positions.find((p) => p.id === positionId)
      if (position) {
        navigate(`/markets/${position.marketId}`)
      }
    },
    [navigate, state.positions]
  )

  const handleViewMarket = useCallback(
    (marketId: string) => {
      navigate(`/markets/${marketId}`)
    },
    [navigate]
  )

  const handlePositionsTabChange = useCallback(
    (tab: 'active' | 'closed') => {
      state.setPositionsTab(tab)
    },
    [state]
  )

  const handleOpenSettings = useCallback(() => {
    navigate('/settings')
  }, [navigate])

  const handleConnectNostr = useCallback(() => {
    navigate('/settings?category=nostr')
  }, [navigate])

  // Anon state: no signer configured and no cached profile. Matches the
  // empty app-bar "Anon" + empty avatar the user sees in this state.
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode)
  const nostrProfile = useSettingsStore((s) => s.nostrProfile)
  const showConnectNostrCta = nostrSignerMode === 'none' && nostrProfile == null

  return (
    <>
      <Portfolio
        walletState={state.walletState}
        baseCurrency={state.baseCurrency}
        selectedTimeRange={state.selectedTimeRange}
        profile={state.profile}
        plChartData={state.plChartData}
        stats={state.stats}
        positions={state.positions}
        funds={state.funds}
        activity={state.activity}
        createdMarkets={state.createdMarkets}
        positionsTab={state.positionsTab}
        onGetStarted={handleGetStarted}
        onAvatarUpload={handleAvatarUpload}
        onTimeRangeChange={handleTimeRangeChange}
        onDeposit={handleDeposit}
        onWithdraw={handleWithdraw}
        onSellPosition={handleSellPosition}
        onViewPosition={handleViewPosition}
        onViewMarket={handleViewMarket}
        onPositionsTabChange={handlePositionsTabChange}
        onOpenSettings={handleOpenSettings}
        showConnectNostrCta={showConnectNostrCta}
        onConnectNostr={handleConnectNostr}
      />
      {overlayMode && (
        <DepositWithdrawOverlay
          mode={overlayMode}
          onClose={() => setOverlayMode(null)}
        />
      )}
    </>
  )
}
