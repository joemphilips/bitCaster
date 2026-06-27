import { useEffect, useMemo, useState } from 'react'
import { computeSpreadMidpoint } from '@/components/market-detail/orderBookViewModel'
import { onTradeExecuted } from '@/lib/marketHub'
import type { MarketDetail, OrderBook, PriceHistory } from '@/types/market-detail'
import { normalizeMarketDivisibility } from '@bitcaster/client-sdk/marketUnits'
import { complementOutcomeSetId, parseOutcomeSetId } from '@bitcaster/client-sdk/outcomeSets'

export interface UseMarketPriceInput {
  market: MarketDetail | null | undefined
  marketId: string | null | undefined
  outcomeSetId: string | null | undefined
  orderBook?: OrderBook | null
}

export interface MarketPriceState {
  currentPrice: number
  defaultOrderPrice: number
}

export function defaultLimitPriceForDivisibility(
  divisibility?: number | null,
  baseAsset?: string | null,
): number {
  return Math.max(1, Math.floor(normalizeMarketDivisibility(divisibility, baseAsset) / 2))
}

export function clampOrderPrice(price: number, divisibility: number): number {
  if (!Number.isFinite(price)) return defaultLimitPriceForDivisibility(divisibility)
  return Math.max(1, Math.min(divisibility - 1, Math.round(price)))
}

export function useMarketPrice({
  market,
  marketId,
  outcomeSetId,
  orderBook,
}: UseMarketPriceInput): MarketPriceState {
  const divisibility = normalizeMarketDivisibility(market?.divisibility, market?.baseAsset)
  const initialPrice = useMemo(
    () => deriveInitialCurrentPrice(market, outcomeSetId, divisibility),
    [market, outcomeSetId, divisibility],
  )
  const [livePrice, setLivePrice] = useState<number | null>(null)

  useEffect(() => {
    setLivePrice(null)
  }, [market?.id, outcomeSetId])

  useEffect(() => {
    if (!marketId) return
    return onTradeExecuted(marketId, (trade) => {
      setLivePrice(clampOrderPrice(trade.executionPrice, divisibility))
    })
  }, [marketId, divisibility])

  const currentPrice = livePrice ?? initialPrice
  const defaultOrderPrice = useMemo(() => {
    const midpoint = computeSpreadMidpoint(orderBook)
    if (midpoint == null) return currentPrice
    return clampOrderPrice(midpoint, divisibility)
  }, [orderBook, currentPrice, divisibility])

  return { currentPrice, defaultOrderPrice }
}

function deriveInitialCurrentPrice(
  market: MarketDetail | null | undefined,
  outcomeSetId: string | null | undefined,
  divisibility: number,
): number {
  if (!market) return defaultLimitPriceForDivisibility(divisibility)

  if (market.type === 'twodimensional') {
    // 2D outcome-set pricing is not yet fully supported by the order ticket;
    // use a neutral midpoint rather than borrowing an unrelated primary leg.
    return defaultLimitPriceForDivisibility(divisibility, market.baseAsset)
  }

  const historyPrice = latestHistoryNumerator(market, outcomeSetId, divisibility)
  if (historyPrice != null) return historyPrice

  const initialPrice = initialProbabilityNumerator(market, outcomeSetId, divisibility)
  if (initialPrice != null) return initialPrice

  const percent = marketOddsPercent(market, outcomeSetId)
  if (percent != null && (percent > 0 || market.type === 'numeric')) {
    return clampOrderPrice((percent / 100) * divisibility, divisibility)
  }

  return defaultLimitPriceForDivisibility(divisibility, market.baseAsset)
}

function initialProbabilityNumerator(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
  divisibility: number,
): number | null {
  const percent = initialProbabilityPercent(market, outcomeSetId)
  if (percent == null) return null
  return clampOrderPrice((percent / 100) * divisibility, divisibility)
}

function initialProbabilityPercent(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): number | null {
  const probabilities = market.initialProbabilities
  if (!probabilities) return null

  if (market.type === 'yesno') {
    if (isNoOutcomeSet(outcomeSetId)) {
      return probabilityForOutcome(probabilities, 'No')
        ?? complementPercent(probabilityForOutcome(probabilities, 'Yes'))
    }

    return probabilityForOutcome(probabilities, 'Yes')
      ?? complementPercent(probabilityForOutcome(probabilities, 'No'))
  }

  if (market.type === 'categorical' && outcomeSetId) {
    const direct = probabilityForOutcome(probabilities, outcomeSetId)
      ?? probabilityForOutcome(probabilities, outcomeLabelForSet(market, outcomeSetId) ?? '')
    if (direct != null) return direct

    const members = parseOutcomeSetId(outcomeSetId)
    if (members.length > 0) {
      const total = members.reduce(
        (sum, member) => sum + (probabilityForOutcome(probabilities, member) ?? 0),
        0,
      )
      return total > 0 ? Math.max(0, Math.min(100, total)) : null
    }
  }

  return null
}

function probabilityForOutcome(
  probabilities: Record<string, number>,
  outcome: string,
): number | null {
  const direct = probabilities[outcome]
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, Number(direct)))
  const caseInsensitive = Object.entries(probabilities).find(
    ([key]) => key.toLowerCase() === outcome.toLowerCase(),
  )?.[1]
  return Number.isFinite(caseInsensitive) ? Math.max(0, Math.min(100, Number(caseInsensitive))) : null
}

function complementPercent(percent: number | null): number | null {
  return percent == null ? null : 100 - percent
}

function latestHistoryNumerator(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
  divisibility: number,
): number | null {
  const percent = latestHistoryPercent(market, outcomeSetId)
  if (percent == null) return null
  return clampOrderPrice((percent / 100) * divisibility, divisibility)
}

function latestHistoryPercent(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): number | null {
  const history = historyForOutcome(market, outcomeSetId)
  const latest = latestHistoryPointPercent(history)
  if (latest != null) return latest

  if (market.type === 'yesno' && isNoOutcomeSet(outcomeSetId)) {
    const yes = latestHistoryPointPercent(market.priceHistory)
    return yes == null ? null : 100 - yes
  }

  if (market.type === 'categorical' && outcomeSetId) {
    const complementPercent = complementHistoryPercent(market, outcomeSetId)
    if (complementPercent != null) return complementPercent
  }

  return null
}

function latestHistoryPointPercent(history: PriceHistory | null | undefined): number | null {
  const latest = history?.data.at(-1)?.price
  if (typeof latest !== 'number' || !Number.isFinite(latest)) return null
  return Math.max(0, Math.min(100, latest))
}

function historyForOutcome(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): PriceHistory | null {
  if (market.type === 'yesno' && isNoOutcomeSet(outcomeSetId)) {
    return null
  }

  if (market.type === 'categorical' && outcomeSetId) {
    return (
      market.outcomePriceHistories[outcomeSetId] ??
      market.outcomePriceHistories[outcomeLabelForSet(market, outcomeSetId) ?? ''] ??
      null
    )
  }
  return market.priceHistory
}

function complementHistoryPercent(
  market: Extract<MarketDetail, { type: 'categorical' }>,
  outcomeSetId: string,
): number | null {
  const universe = market.outcomes.map((outcome) => outcome.label)
  if (universe.length < 2) return null
  const members = parseOutcomeSetId(outcomeSetId)
  if (members.length !== universe.length - 1) return null
  const missing = complementOutcomeSetId(universe, outcomeSetId)
  if (!missing) return null
  const primary = latestHistoryPointPercent(
    market.outcomePriceHistories[missing] ??
      market.outcomePriceHistories[outcomeLabelForSet(market, missing) ?? ''] ??
      (missing === universe[0] ? market.priceHistory : null),
  )
  return primary == null ? null : 100 - primary
}

function outcomeLabelForSet(
  market: Extract<MarketDetail, { type: 'categorical' }>,
  outcomeSetId: string,
): string | null {
  const members = parseOutcomeSetId(outcomeSetId)
  if (members.length !== 1) return null
  return (
    market.outcomes.find(
      (candidate) => candidate.id === members[0] || candidate.label === members[0],
    )?.label ?? null
  )
}

function marketOddsPercent(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): number | null {
  if (market.type === 'yesno') {
    if (isNoOutcomeSet(outcomeSetId)) {
      return market.currentOdds.no
    }
    return market.currentOdds.yes
  }

  if (market.type === 'categorical' && outcomeSetId) {
    const directOutcome = market.outcomes.find(
      (candidate) => candidate.id === outcomeSetId || candidate.label === outcomeSetId,
    )
    if (typeof directOutcome?.odds === 'number') return directOutcome.odds

    const members = parseOutcomeSetId(outcomeSetId)
    if (members.length > 0) {
      const total = members.reduce((sum, member) => {
        const outcome = market.outcomes.find(
          (candidate) => candidate.id === member || candidate.label === member,
        )
        return sum + (typeof outcome?.odds === 'number' ? outcome.odds : 0)
      }, 0)
      return total > 0 ? Math.max(0, Math.min(100, total)) : null
    }

    return null
  }

  if (market.type === 'numeric') {
    return typeof market.currentPrice === 'number' ? market.currentPrice : null
  }

  return null
}

function isNoOutcomeSet(outcomeSetId: string | null | undefined): boolean {
  return typeof outcomeSetId === 'string' && outcomeSetId.trim().toLowerCase() === 'no'
}
