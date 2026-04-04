import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router'
import { MarketDetail } from '@/components/market-detail'
import { fetchMarketDetail, fetchOrderBook, submitOrder, toggleMarketLike } from '@/lib/markets'
import { useWalletStore } from '@/stores/wallet'
import { deriveNostrKeyPair } from '@/lib/nip17'
import type {
  MarketDetail as MarketDetailType,
  ChartTimeframe,
  ChartType,
  TradeSelection,
  TradePreview,
  TradeSide,
  OrderType,
  LimitOrderPreview,
} from '@/types/market-detail'

export function MarketDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const setupComplete = useWalletStore((s) => s.setupComplete)
  const mnemonic = useWalletStore((s) => s.mnemonic)

  // Data state
  const [market, setMarket] = useState<MarketDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // UI state
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>('7d')
  const [chartType, setChartType] = useState<ChartType>('price')
  const [tradeSelection, setTradeSelection] = useState<TradeSelection | null>(null)
  const [tradeAmount, setTradeAmount] = useState(0)
  const [tradeSide, setTradeSide] = useState<TradeSide>('buy')
  const [orderType, setOrderType] = useState<OrderType>('market')
  const [limitPrice, setLimitPrice] = useState(50)

  // Load market data
  const loadMarket = useCallback(() => {
    if (!id) return
    setLoading(true)
    setError(null)

    fetchMarketDetail(id)
      .then(async (detail) => {
        // Try to fetch order book for yesno markets
        if (detail.type === 'yesno') {
          try {
            const ob = await fetchOrderBook(`${id}-Yes`)
            detail = { ...detail, orderBook: ob }
          } catch {
            // Order book fetch is best-effort
          }
        }
        setMarket(detail)
      })
      .catch(() => {
        setError('Failed to load market. Please check that the mint is running.')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [id])

  useEffect(() => {
    loadMarket()
  }, [loadMarket])

  // Computed trade preview
  const tradePreview = useMemo<TradePreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market) return null
    if (orderType === 'limit') return null

    const feePercent = market.creator.feePercent
    const creatorFee = Math.round(tradeAmount * feePercent / 100)
    return {
      amount: tradeAmount,
      predictedOdds: 50, // Placeholder — real computation needs order book depth
      priceImpact: 0,
      potentialPayout: Math.round(tradeAmount * 100 / 50),
      creatorFee,
      platformFee: 0,
      totalCost: tradeAmount,
    }
  }, [tradeSelection, tradeAmount, market, orderType])

  // Computed limit order preview
  const limitOrderPreview = useMemo<LimitOrderPreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market) return null
    if (orderType !== 'limit') return null

    const feePercent = market.creator.feePercent
    const creatorFee = Math.round(tradeAmount * feePercent / 100)
    return {
      limitPrice,
      amount: tradeAmount,
      sharesIfFilled: limitPrice > 0 ? Math.round(tradeAmount * 10000 / limitPrice) : 0,
      creatorFee,
      platformFee: 0,
      totalCost: tradeAmount,
    }
  }, [tradeSelection, tradeAmount, market, orderType, limitPrice])

  // Handlers
  const handleTradeConfirm = useCallback(async () => {
    if (!market || !tradeSelection || !tradeAmount) return
    try {
      const outcomeName = tradeSelection.outcomeId ?? tradeSelection.side
      await submitOrder(
        `${market.id}-${outcomeName}`,
        {
          outcomeId: outcomeName,
          side: tradeSide === 'buy' ? 'Buy' : 'Sell',
          price: orderType === 'limit' ? limitPrice : 0,
          amountSats: tradeAmount,
          userId: 'anonymous',
          timeInForce: 'GTC',
        }
      )
      // Reset after successful trade
      setTradeSelection(null)
      setTradeAmount(0)
      // Reload market data
      loadMarket()
    } catch {
      // Error handling — could show a toast
    }
  }, [market, tradeSelection, tradeAmount, tradeSide, orderType, limitPrice, loadMarket])

  const handleRelatedMarketClick = useCallback((marketId: string) => {
    navigate(`/markets/${marketId}`)
  }, [navigate])

  const handleLikeToggle = useCallback(() => {
    if (!market || !mnemonic) return
    const userId = deriveNostrKeyPair(mnemonic).publicKey
    setMarket((prev) =>
      prev ? { ...prev, isLiked: !prev.isLiked, likeCount: prev.likeCount + (prev.isLiked ? -1 : 1) } : prev
    )
    toggleMarketLike(market.id, userId).then((res) => {
      setMarket((prev) => prev ? { ...prev, isLiked: res.isLiked, likeCount: res.likeCount } : prev)
    }).catch(() => {
      setMarket((prev) =>
        prev ? { ...prev, isLiked: !prev.isLiked, likeCount: prev.likeCount + (prev.isLiked ? -1 : 1) } : prev
      )
    })
  }, [market, mnemonic])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-slate-400 animate-pulse">Loading market...</div>
      </div>
    )
  }

  if (error || !market) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="text-red-400">{error ?? 'Market not found'}</div>
        <button
          onClick={loadMarket}
          className="px-4 py-2 bg-[#f7931a] text-black rounded-lg hover:bg-[#e8850f] transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <MarketDetail
      market={market}
      chartTimeframe={chartTimeframe}
      chartType={chartType}
      tradeSelection={tradeSelection}
      tradeAmount={tradeAmount}
      tradePreview={tradePreview}
      tradeSide={tradeSide}
      orderType={orderType}
      limitOrderPreview={limitOrderPreview}
      limitPrice={limitPrice}
      onTimeframeChange={setChartTimeframe}
      onChartTypeChange={setChartType}
      onTradeSelect={setTradeSelection}
      onTradeClear={() => {
        setTradeSelection(null)
        setTradeAmount(0)
      }}
      onAmountChange={setTradeAmount}
      onTradeConfirm={handleTradeConfirm}
      onTradeSideChange={setTradeSide}
      onOrderTypeChange={setOrderType}
      onLimitPriceChange={setLimitPrice}
      onRelatedMarketClick={handleRelatedMarketClick}
      onLikeToggle={handleLikeToggle}
      walletReady={setupComplete}
    />
  )
}
