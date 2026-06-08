import { useState, useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, isCtfProof } from '@/stores/proof-db'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { useActivityLogStore } from '@/stores/activity-log'
import { safeHostname } from '@/lib/url'
import type { MarketCatalogueEntry, MarketCatalogueResponse } from '@/lib/markets'
import { outcomeSetDisplayLabel } from '@/lib/outcomeSets'
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
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'

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

function parseOutcomeCollection(value: string): string[] {
  const outcomes: string[] = []
  let current = ''
  let escaped = false
  for (const ch of value) {
    if (escaped) {
      current += ch
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '|') {
      outcomes.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  outcomes.push(current)
  return outcomes.filter((outcome) => outcome.length > 0)
}

function positionSide(outcomeCollection: string): Position['side'] {
  const normalized = outcomeCollection.toUpperCase()
  if (normalized === 'YES') return 'yes'
  if (normalized === 'NO') return 'no'
  return 'outcome'
}

async function loadMarketCatalogue(
  conditionIds: string[],
): Promise<Map<string, MarketCatalogueEntry>> {
  if (conditionIds.length === 0) return new Map()
  try {
    const search = new URLSearchParams()
    search.set('ids', conditionIds.join(','))
    search.set('state', 'All')
    search.set('page_size', String(Math.min(Math.max(conditionIds.length, 1), 50)))
    const response = await fetch(`/api/v1/markets/query?${search.toString()}`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return new Map()
    const body = (await response.json()) as MarketCatalogueResponse
    return new Map((body.markets ?? []).map((market) => [market.conditionId, market]))
  } catch {
    return new Map()
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

  const activity = useActivityLogStore((s) => s.items)
  const [createdMarkets] = useState<CreatedMarket[]>([])
  const plChartData = useMemo(() => buildPLChartData(activity), [activity])

  // Positions and funds are both wallet-local. CTF proofs are market
  // positions; base proofs are spendable ecash funds.
  const storeMints = useWalletStore((s) => s.mints)
  const positionsFromDb = useLiveQuery(async () => {
    const proofs = await db.proofs.toArray()
    const byOutcome = new Map<
      string,
      {
        conditionId: string
        outcomeCollection: string
        amount: number
        mintUrl: string
        firstReceivedAt: number
      }
    >()
    for (const proof of proofs.filter(isCtfProof)) {
      const candidate = proof as typeof proof & {
        conditionId?: string
        condition_id?: string
        outcomeCollection?: string
        outcome_collection?: string
      }
      const conditionId = candidate.conditionId ?? candidate.condition_id
      const outcomeCollection =
        candidate.outcomeCollection ?? candidate.outcome_collection
      if (!conditionId || !outcomeCollection) continue
      const key = `${conditionId}:${outcomeCollection}`
      const current = byOutcome.get(key)
      byOutcome.set(key, {
        conditionId,
        outcomeCollection,
        amount: (current?.amount ?? 0) + amountToNumber(proof.amount),
        mintUrl: current?.mintUrl ?? proof.mintUrl,
        firstReceivedAt: Math.min(
          current?.firstReceivedAt ?? Number.POSITIVE_INFINITY,
          proof.receivedAt ?? Date.now(),
        ),
      })
    }
    const entries = Array.from(byOutcome.values())
    const catalogue = await loadMarketCatalogue([
      ...new Set(entries.map((entry) => entry.conditionId)),
    ])
    return entries.map((entry): Position => {
      const market = catalogue.get(entry.conditionId)
      const outcomeLabel = outcomeSetDisplayLabel(
        market?.outcomes ?? [],
        entry.outcomeCollection,
      )
      const finalOutcome = market?.finalOutcome?.trim()
      const isClosed = String(market?.state ?? '').toLowerCase() === 'closed'
      const isWinner =
        isClosed &&
        !!finalOutcome &&
        parseOutcomeCollection(entry.outcomeCollection).some(
          (held) => held.toLowerCase() === finalOutcome.toLowerCase(),
        )
      const isLoser = isClosed && !!finalOutcome && !isWinner
      const status = isClosed ? 'closed' : 'active'
      const currentValueSats = isWinner
        ? entry.amount
        : isLoser
          ? 0
          : entry.amount
      return {
        id: `${entry.conditionId}-${entry.outcomeCollection}`,
        marketId: `${entry.conditionId}-${entry.outcomeCollection}`,
        marketTitle: market?.title ?? `Market ${entry.conditionId.slice(0, 8)}`,
        marketImageUrl: market?.thumbnailUrl ?? '',
        side: positionSide(entry.outcomeCollection),
        outcomeId: entry.outcomeCollection,
        outcomeLabel,
        shares: entry.amount,
        avgBuyPrice: 0,
        currentPrice: isClosed ? (isWinner ? 100 : 0) : 0,
        currentValueSats,
        profitLossSats: isClosed ? currentValueSats : 0,
        profitLossPercent: isClosed
          ? isWinner
            ? 100
            : -100
          : 0,
        status,
        closedDate: isClosed ? (market?.closedAt ?? undefined) : undefined,
        acquiredDate: new Date(entry.firstReceivedAt).toISOString(),
        mintUrl: entry.mintUrl,
      }
    })
  }, [], [] as Position[])
  const positions: Position[] = positionsFromDb ?? []
  const fundsFromDb = useLiveQuery(async () => {
    const proofs = await db.proofs.toArray()
    const balanceByMint: Record<string, number> = {}
    for (const p of proofs.filter((proof) => !isCtfProof(proof))) {
      balanceByMint[p.mintUrl] =
        (balanceByMint[p.mintUrl] ?? 0) + amountToNumber(p.amount)
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
