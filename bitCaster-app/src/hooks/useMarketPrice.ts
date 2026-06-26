import { useEffect, useMemo, useState } from 'react'
import { computeSpreadMidpoint } from '@/components/market-detail/orderBookViewModel'
import { onTradeExecuted } from '@/lib/marketHub'
import type { MarketDetail, OrderBook, PriceHistory } from '@/types/market-detail'
import { normalizeMarketDivisibility } from '@bitcaster/client-sdk/marketUnits'

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

  const historyPrice = latestHistoryNumerator(market, outcomeSetId, divisibility)
  if (historyPrice != null) return historyPrice

  const percent = marketOddsPercent(market, outcomeSetId)
  if (percent != null && percent > 0) {
    return clampOrderPrice((percent / 100) * divisibility, divisibility)
  }

  return defaultLimitPriceForDivisibility(divisibility, market.baseAsset)
}

function latestHistoryNumerator(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
  divisibility: number,
): number | null {
  const history = historyForOutcome(market, outcomeSetId)
  const latest = history?.data.at(-1)?.price
  if (typeof latest !== 'number' || !Number.isFinite(latest)) return null
  return clampOrderPrice((latest / 100) * divisibility, divisibility)
}

function historyForOutcome(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): PriceHistory | null {
  if (market.type === 'categorical' && outcomeSetId) {
    return market.outcomePriceHistories[outcomeSetId] ?? null
  }
  return market.priceHistory
}

function marketOddsPercent(
  market: MarketDetail,
  outcomeSetId: string | null | undefined,
): number | null {
  if (market.type === 'yesno') {
    if (outcomeSetId === 'No' || outcomeSetId === 'NO' || outcomeSetId === 'no') {
      return market.currentOdds.no
    }
    return market.currentOdds.yes
  }

  if (market.type === 'categorical' && outcomeSetId) {
    const outcome = market.outcomes.find(
      (candidate) => candidate.id === outcomeSetId || candidate.label === outcomeSetId,
    )
    return typeof outcome?.odds === 'number' ? outcome.odds : null
  }

  if (market.type === 'numeric') {
    return typeof market.currentPrice === 'number' ? market.currentPrice : null
  }

  return null
}
