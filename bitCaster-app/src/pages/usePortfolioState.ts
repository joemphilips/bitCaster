import { useState, useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, isCtfProof } from '@/stores/proof-db'
import { useWalletStore } from '@/stores/wallet'
import { useSettingsStore } from '@/stores/settings'
import { useActivityLogStore } from '@/stores/activity-log'
import { safeHostname } from '@/lib/url'
import type { MarketCatalogueEntry, MarketCatalogueResponse } from '@/lib/markets'
import { outcomeSetDisplayLabel } from '@/lib/outcomeSets'
import {
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
  type MarketBaseAsset,
} from '@bitcaster/client-sdk/marketUnits'
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
import { deriveWinner } from '@/lib/positionWinner'

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
    .filter((a) => a.status === 'completed' && normalizeMarketBaseAsset(a.baseAsset) === 'sat')
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
  const activePositions = positions.filter(
    (p) => p.status === 'active' && normalizeMarketBaseAsset(p.baseAsset) === 'sat',
  )
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
        baseAsset: MarketBaseAsset
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
      const baseAsset = normalizeMarketBaseAsset(proof.baseAsset)
      const key = `${conditionId}:${outcomeCollection}:${baseAsset}`
      const current = byOutcome.get(key)
      byOutcome.set(key, {
        conditionId,
        outcomeCollection,
        baseAsset,
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
      const baseAsset = normalizeMarketBaseAsset(market?.baseAsset ?? entry.baseAsset)
      const divisibility = normalizeMarketDivisibility(market?.divisibility)
      const outcomeLabel = outcomeSetDisplayLabel(
        market?.outcomes ?? [],
        entry.outcomeCollection,
      )
      const finalOutcome = market?.finalOutcome?.trim()
      const isClosed = String(market?.state ?? '').toLowerCase() === 'closed'
      // Single source-of-truth winner/value derivation (P22 Link F HIGH).
      // A keyset is a WINNING keyset iff the attested final outcome is a member
      // of that keyset's outcome-collection (the mint redeems a collection's
      // proofs iff the collection contains the attested outcome). A position is
      // a WINNER iff it holds >= 1 proof on a winning keyset — the existence
      // ("some winning leg") rule, NOT "every leg wins". An UNCLAIMED composite
      // "A|B" position (final "A") therefore correctly counts as a winner and
      // stays claimable; the old `.every` rule mis-classified it as a loser and
      // offered only the destructive Remove, destroying the winning A-leg.
      // Claimable value sums WINNING keysets only (losing-keyset proofs = 0).
      // Each position group shares one outcome-collection label by construction
      // (the group key includes it), so it is a single leg here.
      const { status: winnerStatus, claimableValue } = deriveWinner({
        isClosed,
        finalOutcome,
        legs: [
          { outcomeCollection: entry.outcomeCollection, amount: entry.amount },
        ],
      })
      const isWinner = winnerStatus === 'winner'
      const isLoser = winnerStatus === 'loser'
      // Closed but NOT YET ATTESTED (P22 Link F): win/loss undecided. The row
      // must offer NEITHER Claim NOR Remove (destroying not-yet-decided proofs
      // is permanent loss) and show an "awaiting resolution" indicator. It stays
      // visible in the Closed tab (status 'closed'), and its value is the full
      // held amount — an undecided outcome is not a loss, so it is NOT zeroed.
      const isPending = winnerStatus === 'pending'
      const status = isClosed ? 'closed' : 'active'
      const currentValueSats = isClosed
        ? isWinner || isPending
          ? claimableValue
          : 0
        : entry.amount
      return {
        id: `${entry.conditionId}-${entry.outcomeCollection}`,
        marketId: `${entry.conditionId}-${entry.outcomeCollection}`,
        marketTitle: market?.title ?? `Market ${entry.conditionId.slice(0, 8)}`,
        marketImageUrl: market?.thumbnailUrl ?? '',
        side: positionSide(entry.outcomeCollection),
        outcomeId: entry.outcomeCollection,
        outcomeLabel,
        canClaimPayout: isWinner,
        canDiscard: isLoser,
        baseAsset,
        divisibility,
        shares: entry.amount / divisibility,
        avgBuyPrice: 0,
        currentPrice: isClosed && isWinner ? divisibility : 0,
        currentValueSats,
        // Pending (undecided) shows no realised P&L; only attested winners/losers do.
        profitLossSats: isClosed && !isPending ? currentValueSats : 0,
        profitLossPercent: isClosed
          ? isWinner
            ? 100
            : isPending
              ? 0
              : -100
          : 0,
        status,
        isWinner,
        isLoser,
        isPending,
        finalOutcome: market?.finalOutcome ?? null,
        closedDate: isClosed ? (market?.closedAt ?? undefined) : undefined,
        acquiredDate: new Date(entry.firstReceivedAt).toISOString(),
        mintUrl: entry.mintUrl,
      }
    })
  }, [], [] as Position[])
  const positions: Position[] = positionsFromDb ?? []
  const fundsFromDb = useLiveQuery(async () => {
    const proofs = await db.proofs.toArray()
    const balanceByMintAndUnit: Record<string, { mintUrl: string; baseAsset: MarketBaseAsset; amount: number }> = {}
    for (const p of proofs.filter((proof) => !isCtfProof(proof))) {
      const baseAsset = normalizeMarketBaseAsset(p.baseAsset)
      const key = `${p.mintUrl}:${baseAsset}`
      const current = balanceByMintAndUnit[key]
      balanceByMintAndUnit[key] = {
        mintUrl: p.mintUrl,
        baseAsset,
        amount: (current?.amount ?? 0) + amountToNumber(p.amount),
      }
    }
    return Object.values(balanceByMintAndUnit).map(({ mintUrl, baseAsset, amount }) => {
      const mintInfo = storeMints.find((m) => m.url === mintUrl)
      const name = (mintInfo?.info as Record<string, unknown>)?.name as string | undefined
      return {
        id: `${mintUrl}:${baseAsset}`,
        unit: baseAsset === 'sat' ? 'sats' as const : baseAsset,
        amount,
        mintUrl,
        mintName: name ?? safeHostname(mintUrl),
      }
    })
  }, [storeMints], [] as (Fund & { mintName: string })[])
  const funds: Fund[] = fundsFromDb
  const fundsBalance = useMemo(
    () => fundsFromDb
      .filter((fund) => fund.unit === 'sats')
      .reduce((sum, f) => sum + f.amount, 0),
    [fundsFromDb],
  )

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
