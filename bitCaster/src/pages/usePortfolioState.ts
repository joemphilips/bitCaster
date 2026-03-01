import { useState, useCallback, useMemo } from 'react'
import type {
  WalletState,
  BaseCurrency,
  PLTimeSelector,
  PLChartData,
  PortfolioStats,
  UserProfile,
  Position,
  Fund,
  ActivityItem,
  CreatedMarket,
} from '@/types/portfolio'

interface PortfolioState {
  walletState: WalletState
  baseCurrency: BaseCurrency
  selectedTimeRange: PLTimeSelector
  profile: UserProfile
  plChartData: PLChartData
  stats: PortfolioStats
  positions: Position[]
  funds: Fund[]
  activity: ActivityItem[]
  createdMarkets: CreatedMarket[]
  positionsTab: 'active' | 'closed'
}

const EMPTY_PL_DATA: PLChartData = {
  '1D': [],
  '1W': [],
  '1M': [],
  ALL: [],
}

const DEFAULT_PROFILE: UserProfile = {
  userId: '',
  displayName: 'Anon',
  avatarUrl: null,
  registeredDate: new Date().toISOString(),
  viewCount: 0,
}

function detectWalletState(): WalletState {
  try {
    const stored = localStorage.getItem('bitcaster-wallet')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (parsed?.state?.setupComplete) return 'ready'
    }
  } catch {
    // ignore parse errors
  }
  return 'none'
}

function loadProfile(): UserProfile {
  try {
    const stored = localStorage.getItem('bitcaster-profile')
    if (stored) return JSON.parse(stored)
  } catch {
    // ignore
  }
  return DEFAULT_PROFILE
}

function computeStats(positions: Position[]): PortfolioStats {
  const activePositions = positions.filter((p) => p.status === 'active')
  const positionsValueSats = activePositions.reduce((sum, p) => sum + p.currentValueSats, 0)
  const biggestWinSats = positions.reduce(
    (max, p) => Math.max(max, p.profitLossSats),
    0
  )
  return {
    positionsValueSats,
    biggestWinSats,
    predictionsCount: positions.length,
  }
}

export function usePortfolioState(): PortfolioState & {
  setSelectedTimeRange: (range: PLTimeSelector) => void
  setPositionsTab: (tab: 'active' | 'closed') => void
  saveProfile: (profile: UserProfile) => void
} {
  const [walletState] = useState<WalletState>(detectWalletState)
  const [baseCurrency] = useState<BaseCurrency>('BTC')
  const [selectedTimeRange, setSelectedTimeRange] = useState<PLTimeSelector>('ALL')
  const [profile, setProfile] = useState<UserProfile>(loadProfile)
  const [positionsTab, setPositionsTab] = useState<'active' | 'closed'>('active')

  // TODO: These will be populated from wallet token scanning and local DB
  // once the wallet integration layer is built
  const [positions] = useState<Position[]>([])
  const [funds] = useState<Fund[]>([])
  const [activity] = useState<ActivityItem[]>([])
  const [createdMarkets] = useState<CreatedMarket[]>([])
  const [plChartData] = useState<PLChartData>(EMPTY_PL_DATA)

  const stats = useMemo(() => computeStats(positions), [positions])

  const saveProfile = useCallback((updated: UserProfile) => {
    setProfile(updated)
    localStorage.setItem('bitcaster-profile', JSON.stringify(updated))
  }, [])

  return {
    walletState,
    baseCurrency,
    selectedTimeRange,
    profile,
    plChartData,
    stats,
    positions,
    funds,
    activity,
    createdMarkets,
    positionsTab,
    setSelectedTimeRange,
    setPositionsTab,
    saveProfile,
  }
}
