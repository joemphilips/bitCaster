import { useState, useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/stores/proof-db'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { useActivityLogStore } from '@/stores/activity-log'
import { safeHostname } from '@/lib/url'
import type {
  WalletState,
  BaseCurrency,
  PLTimeSelector,
  PLChartData,
  PLChartDataPoint,
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

const TIME_RANGE_MS: Record<PLTimeSelector, number> = {
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
  '1M': 30 * 24 * 60 * 60 * 1000,
  ALL: Infinity,
}

/** Build P/L chart data from activity history. */
function buildPLChartData(items: ActivityItem[]): PLChartData {
  // Sort oldest-first
  const sorted = [...items]
    .filter((a) => a.status === 'completed')
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  if (sorted.length === 0) {
    return { '1D': [], '1W': [], '1M': [], ALL: [] }
  }

  // Build cumulative balance points
  const points: PLChartDataPoint[] = []
  let cumulative = 0
  for (const item of sorted) {
    const delta =
      item.type === 'deposit' || item.type === 'payout_claimed' || item.type === 'creator_fee_claimed'
        ? item.amountSats
        : -item.amountSats
    cumulative += delta
    points.push({ timestamp: item.date, cumulativePL: cumulative })
  }

  const now = Date.now()
  const result: PLChartData = { '1D': [], '1W': [], '1M': [], ALL: points }
  for (const range of ['1D', '1W', '1M'] as const) {
    const cutoff = now - TIME_RANGE_MS[range]
    result[range] = points.filter((p) => new Date(p.timestamp).getTime() >= cutoff)
  }
  return result
}

const DEFAULT_PROFILE: UserProfile = {
  userId: '',
  displayName: 'Anon',
  avatarUrl: null,
  registeredDate: new Date().toISOString(),
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

function computeStats(positions: Position[], fundsBalance: number): PortfolioStats {
  const activePositions = positions.filter((p) => p.status === 'active')
  const positionsValueSats = activePositions.reduce((sum, p) => sum + p.currentValueSats, 0)
  const biggestWinSats = positions.reduce(
    (max, p) => Math.max(max, p.profitLossSats),
    0
  )
  return {
    positionsValueSats,
    totalValueSats: positionsValueSats + fundsBalance,
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
  const [localProfile, setLocalProfile] = useState<UserProfile>(loadProfile)
  const [positionsTab, setPositionsTab] = useState<'active' | 'closed'>('active')

  // Merge nostr profile into local profile when available
  const nostrProfile = useSettingsStore((s) => s.nostrProfile)
  const profile: UserProfile = useMemo(() => {
    if (!nostrProfile) return localProfile
    return {
      ...localProfile,
      displayName: nostrProfile.displayName || localProfile.displayName,
      avatarUrl: nostrProfile.avatar || localProfile.avatarUrl,
    }
  }, [localProfile, nostrProfile])

  const [positions] = useState<Position[]>([])
  const activity = useActivityLogStore((s) => s.items)
  const [createdMarkets] = useState<CreatedMarket[]>([])
  const plChartData = useMemo(() => buildPLChartData(activity), [activity])

  // Funds: aggregate proof balances by mint from IndexedDB
  const storeMints = useWalletStore((s) => s.mints)
  const fundsFromDb = useLiveQuery(async () => {
    const proofs = await db.proofs.toArray()
    const balanceByMint: Record<string, number> = {}
    for (const p of proofs) {
      balanceByMint[p.mintUrl] = (balanceByMint[p.mintUrl] ?? 0) + p.amount
    }
    return Object.entries(balanceByMint).map(([mintUrl, amount]) => {
      const mintInfo = storeMints.find((m) => m.url === mintUrl)
      const name = (mintInfo?.info as Record<string, unknown>)?.name as string | undefined
      return {
        id: mintUrl,
        unit: 'sats' as const,
        amount,
        mintUrl,
        mintName: name ?? safeHostname(mintUrl),
      }
    })
  }, [storeMints], [] as (Fund & { mintName: string })[])
  const funds: Fund[] = fundsFromDb
  const fundsBalance = useMemo(() => fundsFromDb.reduce((sum, f) => sum + f.amount, 0), [fundsFromDb])

  const stats = useMemo(() => computeStats(positions, fundsBalance), [positions, fundsBalance])

  const saveProfile = useCallback((updated: UserProfile) => {
    setLocalProfile(updated)
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
