import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router'
import { MarketDetail } from '@/components/market-detail'
import { InsufficientBalanceModal } from '@/components/shared/InsufficientBalanceModal'
import { TopUpOverlay } from '@/components/market-detail/TopUpOverlay'
import { fetchMarketDetail, fetchOrderBook, submitOrder } from '@/lib/markets'
import { generateEphemeralKeyPair } from '@/lib/ephemeral-key'
import { getBalance, useWalletStore } from '@/stores/wallet'
import { usePendingTradesStore } from '@/stores/pendingTrades'
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

type TopUpStage = 'closed' | 'modal' | 'overlay'

export function MarketDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const setupComplete = useWalletStore((s) => s.setupComplete)
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl)
  const addPendingTrade = usePendingTradesStore((s) => s.add)

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

  // Top-up flow state — surfaced only when the user tries to confirm a trade
  // they can't afford. `balanceAtCheck` is the snapshot taken when the gate
  // tripped, so the modal / overlay keep showing the user's real deficit even
  // if the wallet balance changes live while they decide.
  const [topUpStage, setTopUpStage] = useState<TopUpStage>('closed')
  const [balanceAtCheck, setBalanceAtCheck] = useState(0)

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

  // Submit the order. Assumes wallet is set up and balance has been checked —
  // callers that can't promise that must route through `handleTradeConfirm`.
  const placeOrder = useCallback(async () => {
    if (!market || !tradeSelection || !tradeAmount) return
    const outcomeName = tradeSelection.outcomeId ?? tradeSelection.side
    const marketId = `${market.id}-${outcomeName}`
    const ephemeral = generateEphemeralKeyPair()
    try {
      const response = await submitOrder(marketId, {
        outcomeId: outcomeName,
        side: tradeSide === 'buy' ? 'Buy' : 'Sell',
        price: orderType === 'limit' ? limitPrice : 0,
        amountSats: tradeAmount,
        timeInForce: 'GTC',
        ephemeralPubkey: ephemeral.pubkey,
      })
      // Only persist the privkey once the engine has accepted the order.
      // Otherwise we accumulate orphaned keys on every failed submission.
      addPendingTrade({
        orderId: response.orderId,
        marketId,
        ephemeralPubkey: ephemeral.pubkey,
        ephemeralPrivkey: ephemeral.privkey,
        submittedAt: Date.now(),
      })
      setTradeSelection(null)
      setTradeAmount(0)
      loadMarket()
    } catch {
      // Error handling — could show a toast. PR1 deliberately keeps this silent
      // so we don't ship half a notification system.
    }
  }, [
    market,
    tradeSelection,
    tradeAmount,
    tradeSide,
    orderType,
    limitPrice,
    loadMarket,
    addPendingTrade,
  ])

  // Gate the order submission on sufficient balance. Reads the balance at
  // click-time (not via `useBalance`) so we don't race a stale live-query
  // subscription after a top-up.
  const handleTradeConfirm = useCallback(async () => {
    if (!market || !tradeSelection || !tradeAmount) return
    const requiredSats = tradeAmount // totalCost for FAK today; PR2+ refines
    const current = await getBalance(activeMintUrl)
    if (current < requiredSats) {
      setBalanceAtCheck(current)
      setTopUpStage('modal')
      return
    }
    await placeOrder()
  }, [market, tradeSelection, tradeAmount, activeMintUrl, placeOrder])

  // After a successful top-up, close the overlay and place the order.
  // TopUpOverlay only invokes onSuccess once proofs have been written to the
  // store, so the balance is guaranteed to cover `tradeAmount` by the time we
  // get here — no re-read needed.
  const handleTopUpSuccess = useCallback(async () => {
    setTopUpStage('closed')
    await placeOrder()
  }, [placeOrder])

  const handleRelatedMarketClick = useCallback((marketId: string) => {
    navigate(`/markets/${marketId}`)
  }, [navigate])

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
    <>
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
        walletReady={setupComplete}
      />
      {topUpStage === 'modal' && (
        <InsufficientBalanceModal
          balance={balanceAtCheck}
          required={tradeAmount}
          onCancel={() => setTopUpStage('closed')}
          onTopUp={() => setTopUpStage('overlay')}
        />
      )}
      {topUpStage === 'overlay' && (
        <TopUpOverlay
          deficit={Math.max(tradeAmount - balanceAtCheck, 0)}
          onSuccess={handleTopUpSuccess}
          onCancel={() => setTopUpStage('closed')}
        />
      )}
    </>
  )
}
