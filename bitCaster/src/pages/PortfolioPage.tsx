import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { Portfolio } from '@/components/portfolio'
import { usePortfolioState } from './usePortfolioState'
import type { PLTimeSelector } from '@/types/portfolio'

export function PortfolioPage() {
  const navigate = useNavigate()
  const state = usePortfolioState()

  const handleGetStarted = useCallback(() => {
    navigate('/setup')
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
    navigate('/deposit')
  }, [navigate])

  const handleWithdraw = useCallback(() => {
    navigate('/withdraw')
  }, [navigate])

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

  return (
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
    />
  )
}
