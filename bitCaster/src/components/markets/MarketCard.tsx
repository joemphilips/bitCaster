import React, { useState, useRef, useEffect } from 'react'
import { Users, Droplet, ChevronUp, ChevronDown, Heart, ChevronRight } from 'lucide-react'
import { formatBtc } from '@/lib/format'
import type {
  Market,
  YesNoMarket,
  CategoricalMarket,
  TwoDimensionalMarket,
  Outcome,
} from '@/types/market'

interface SecondaryMarketInfo {
  id: string
  title: string
}

interface MarketCardProps {
  market: Market
  secondaryMarketInfos?: SecondaryMarketInfo[]
  onViewMarket?: (marketId: string) => void
  onViewSecondaryMarket?: (baseMarketId: string, secondaryMarketId: string) => void
  onLike?: (marketId: string) => void
}

function CategoricalOutcomes({
  outcomes,
  onYesClick,
  onNoClick,
}: {
  outcomes: Outcome[]
  onYesClick: (outcomeId: string, label: string) => void
  onNoClick: (outcomeId: string, label: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      setCanScrollUp(scrollTop > 2)
      setCanScrollDown(scrollTop < scrollHeight - clientHeight - 2)
    }
  }

  useEffect(() => {
    checkScroll()
    const resizeObserver = new ResizeObserver(checkScroll)
    if (scrollRef.current) {
      resizeObserver.observe(scrollRef.current)
    }
    return () => resizeObserver.disconnect()
  }, [outcomes])

  const scroll = (direction: 'up' | 'down', e: React.MouseEvent) => {
    e.stopPropagation()
    if (scrollRef.current) {
      const scrollAmount = 100
      scrollRef.current.scrollBy({
        top: direction === 'up' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      })
    }
  }

  return (
    <div className="relative group/outcomes flex-1 flex flex-col min-h-0">
      {canScrollUp && (
        <button
          onClick={(e) => scroll('up', e)}
          className="absolute left-1/2 -translate-x-1/2 -top-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/outcomes:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className="flex flex-col gap-2 overflow-y-auto flex-1 scrollbar-hide -mx-1 px-1 py-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {outcomes.map((outcome) => (
          <div
            key={outcome.id}
            className="flex-shrink-0 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2.5 border border-slate-200 dark:border-slate-700"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-slate-600 dark:text-slate-400 truncate">
                {outcome.label}
              </div>
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100 ml-2">
                {outcome.odds.toFixed(1)}%
              </div>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onYesClick(outcome.id, outcome.label)
                }}
                className="flex-1 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 rounded text-emerald-600 dark:text-emerald-400 font-bold text-xs transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                Yes
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onNoClick(outcome.id, outcome.label)
                }}
                className="flex-1 py-1.5 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 rounded text-rose-600 dark:text-rose-400 font-bold text-xs transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                No
              </button>
            </div>
          </div>
        ))}
      </div>

      {canScrollDown && (
        <button
          onClick={(e) => scroll('down', e)}
          className="absolute left-1/2 -translate-x-1/2 -bottom-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/outcomes:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

function TwoDimensionalYesNoGrid({
  market,
  onCellClick,
}: {
  market: TwoDimensionalMarket
  onCellClick: (baseOutcome: 'yes' | 'no', secondaryOutcome: 'yes' | 'no') => void
}) {
  if (!market.compositeOdds) return null

  const cells = [
    { base: 'yes' as const, secondary: 'yes' as const, label: 'Yes/Yes', odds: market.compositeOdds.yesYes },
    { base: 'yes' as const, secondary: 'no' as const, label: 'Yes/No', odds: market.compositeOdds.yesNo },
    { base: 'no' as const, secondary: 'yes' as const, label: 'No/Yes', odds: market.compositeOdds.noYes },
    { base: 'no' as const, secondary: 'no' as const, label: 'No/No', odds: market.compositeOdds.noNo },
  ]

  const [hoveredCell, setHoveredCell] = useState<string | null>(null)

  const getCellStyle = (base: 'yes' | 'no', secondary: 'yes' | 'no', isHovered: boolean) => {
    const intensity = isHovered ? 0.35 : 0.2

    if (base === 'yes' && secondary === 'yes') {
      return {
        className: 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40',
        style: {},
      }
    }
    if (base === 'no' && secondary === 'no') {
      return {
        className: 'bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/40',
        style: {},
      }
    }
    if (base === 'yes' && secondary === 'no') {
      return {
        className: 'border-slate-300 dark:border-slate-600',
        style: {
          background: `linear-gradient(135deg, rgba(16, 185, 129, ${intensity}) 50%, rgba(244, 63, 94, ${intensity}) 50%)`,
        },
      }
    }
    if (base === 'no' && secondary === 'yes') {
      return {
        className: 'border-slate-300 dark:border-slate-600',
        style: {
          background: `linear-gradient(135deg, rgba(244, 63, 94, ${intensity}) 50%, rgba(16, 185, 129, ${intensity}) 50%)`,
        },
      }
    }
    return { className: '', style: {} }
  }

  return (
    <div className="flex-1 flex flex-col">
      <div className="grid grid-cols-2 gap-1.5 flex-1">
        {cells.map((cell) => {
          const isHovered = hoveredCell === cell.label
          const cellStyle = getCellStyle(cell.base, cell.secondary, isHovered)

          return (
            <button
              key={cell.label}
              onClick={(e) => {
                e.stopPropagation()
                onCellClick(cell.base, cell.secondary)
              }}
              onMouseEnter={() => setHoveredCell(cell.label)}
              onMouseLeave={() => setHoveredCell(null)}
              className={`flex flex-col items-center justify-center p-2 rounded-lg border transition-all hover:scale-[1.02] active:scale-[0.98] ${cellStyle.className}`}
              style={cellStyle.style}
            >
              <span className="text-[10px] font-medium text-slate-600 dark:text-slate-400">
                {cell.label}
              </span>
              <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {cell.odds.toFixed(1)}%
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TwoDimensionalCategoricalGrid({
  market,
  onCellClick,
}: {
  market: TwoDimensionalMarket
  onCellClick: (baseOutcomeId: string, baseOutcomeLabel: string, secondaryOutcome: 'yes' | 'no') => void
}) {
  if (!market.categoricalCompositeOdds || !market.baseOutcomes) return null

  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
      setCanScrollUp(scrollTop > 2)
      setCanScrollDown(scrollTop < scrollHeight - clientHeight - 2)
    }
  }

  useEffect(() => {
    checkScroll()
    const resizeObserver = new ResizeObserver(checkScroll)
    if (scrollRef.current) {
      resizeObserver.observe(scrollRef.current)
    }
    return () => resizeObserver.disconnect()
  }, [market.baseOutcomes])

  const scroll = (direction: 'up' | 'down', e: React.MouseEvent) => {
    e.stopPropagation()
    if (scrollRef.current) {
      const scrollAmount = 60
      scrollRef.current.scrollBy({
        top: direction === 'up' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      })
    }
  }

  return (
    <div className="relative group/outcomes flex-1 flex flex-col min-h-0">
      {canScrollUp && (
        <button
          onClick={(e) => scroll('up', e)}
          className="absolute left-1/2 -translate-x-1/2 -top-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/outcomes:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className="flex flex-col gap-1 overflow-y-auto flex-1 scrollbar-hide -mx-1 px-1 py-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {market.baseOutcomes.map((outcome) => {
          const odds = market.categoricalCompositeOdds?.[outcome.id]
          if (!odds) return null

          return (
            <div
              key={outcome.id}
              className="flex-shrink-0 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 border border-slate-200 dark:border-slate-700"
            >
              <div className="flex items-center gap-2">
                <div className="text-[10px] font-medium text-slate-600 dark:text-slate-400 truncate flex-1 min-w-0">
                  {outcome.label}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCellClick(outcome.id, outcome.label, 'yes')
                  }}
                  className="px-2 py-1 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 rounded text-emerald-600 dark:text-emerald-400 font-bold text-[10px] transition-all"
                >
                  Y {odds.yes.toFixed(1)}%
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCellClick(outcome.id, outcome.label, 'no')
                  }}
                  className="px-2 py-1 bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 rounded text-rose-600 dark:text-rose-400 font-bold text-[10px] transition-all"
                >
                  N {odds.no.toFixed(1)}%
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {canScrollDown && (
        <button
          onClick={(e) => scroll('down', e)}
          className="absolute left-1/2 -translate-x-1/2 -bottom-2 z-10 w-7 h-7 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 opacity-0 group-hover/outcomes:opacity-100 transition-opacity border border-slate-200 dark:border-slate-700"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

function SecondaryMarketsExpander({
  secondaryMarketInfos,
  isExpanded,
  onToggle,
  onViewSecondary,
}: {
  secondaryMarketInfos: SecondaryMarketInfo[]
  isExpanded: boolean
  onToggle: (e: React.MouseEvent) => void
  onViewSecondary: (secondaryId: string, e: React.MouseEvent) => void
}) {
  if (!secondaryMarketInfos || secondaryMarketInfos.length === 0) return null

  return (
    <div className="mt-1">
      <button
        onClick={onToggle}
        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
      >
        <span>and...</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-1 animate-in fade-in-0 slide-in-from-top-2 duration-200">
          {secondaryMarketInfos.map((info) => (
            <button
              key={info.id}
              onClick={(e) => onViewSecondary(info.id, e)}
              className="w-full text-left px-3 py-2 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-lg border border-blue-200 dark:border-blue-800 transition-colors group/item"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-700 dark:text-slate-300 line-clamp-1 flex-1">
                  {info.title}
                </span>
                <ChevronRight className="w-3 h-3 text-blue-500 opacity-0 group-hover/item:opacity-100 transition-opacity flex-shrink-0" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function MarketCard({
  market,
  secondaryMarketInfos,
  onViewMarket,
  onViewSecondaryMarket,
  onLike,
}: MarketCardProps) {
  const [isSecondaryExpanded, setIsSecondaryExpanded] = useState(false)

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    if ((e.target as HTMLElement).closest('input')) return
    onViewMarket?.(market.id)
  }

  const handleBuyClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onViewMarket?.(market.id)
  }

  const handleToggleSecondary = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsSecondaryExpanded(!isSecondaryExpanded)
  }

  const handleViewSecondary = (secondaryId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onViewSecondaryMarket?.(market.id, secondaryId)
  }

  const handleLike = (e: React.MouseEvent) => {
    e.stopPropagation()
    onLike?.(market.id)
  }

  const renderNormalView = () => {
    if (market.type === 'yesno') {
      const yesNoMarket = market as YesNoMarket
      return (
        <div className="flex-1 flex flex-col justify-end">
          <div className="flex items-center justify-center gap-2 py-2 flex-1">
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Chance</span>
            <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {yesNoMarket.currentOdds.yes.toFixed(1)}%
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 flex-shrink-0">
            <button
              onClick={handleBuyClick}
              className="py-2.5 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-600 text-white rounded-lg font-semibold text-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-md"
            >
              Buy YES
            </button>
            <button
              onClick={handleBuyClick}
              className="py-2.5 bg-rose-600 hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600 text-white rounded-lg font-semibold text-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-md"
            >
              Buy NO
            </button>
          </div>
        </div>
      )
    } else if (market.type === 'categorical') {
      const categoricalMarket = market as CategoricalMarket
      return (
        <CategoricalOutcomes
          outcomes={categoricalMarket.outcomes}
          onYesClick={() => onViewMarket?.(market.id)}
          onNoClick={() => onViewMarket?.(market.id)}
        />
      )
    } else if (market.type === 'twodimensional') {
      const twoDMarket = market as TwoDimensionalMarket

      if (twoDMarket.baseMarketType === 'yesno' && twoDMarket.secondaryType === 'yesno') {
        return (
          <TwoDimensionalYesNoGrid
            market={twoDMarket}
            onCellClick={() => onViewMarket?.(market.id)}
          />
        )
      }

      if (twoDMarket.baseMarketType === 'categorical' && twoDMarket.secondaryType === 'yesno') {
        return (
          <TwoDimensionalCategoricalGrid
            market={twoDMarket}
            onCellClick={() => onViewMarket?.(market.id)}
          />
        )
      }

      return (
        <div className="flex-1 flex flex-col justify-center">
          <div className="bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30 rounded-lg p-4 border border-purple-200 dark:border-purple-800 text-center">
            <div className="text-xs text-slate-600 dark:text-slate-400 mb-2">
              Complex 2D Market
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onViewMarket?.(market.id)
              }}
              className="w-full py-2.5 bg-purple-600 hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600 text-white rounded-lg font-semibold text-sm transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-md"
            >
              View & Trade
            </button>
          </div>
        </div>
      )
    }
  }

  const secondaryCount = secondaryMarketInfos?.length || 0
  const expandedHeight = isSecondaryExpanded ? 280 + (secondaryCount * 44) : 280

  const is2DMarket = market.type === 'twodimensional'
  const twoDMarket = is2DMarket ? (market as TwoDimensionalMarket) : null

  return (
    <div
      onClick={handleCardClick}
      style={{ height: `${expandedHeight}px` }}
      className="group relative bg-white dark:bg-slate-900 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 transition-all duration-300 flex flex-col shadow-md hover:shadow-xl hover:scale-[1.01] cursor-pointer"
    >
      <div className="flex items-start gap-3 p-4 pb-2 flex-shrink-0">
        <div className="relative w-12 h-12 flex-shrink-0 rounded-lg overflow-hidden bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-800 dark:to-slate-700">
          <div
            className="absolute inset-0 bg-cover bg-center transition-transform duration-700 group-hover:scale-110"
            style={{ backgroundImage: `url(${market.imageUrl})` }}
          />
        </div>
        <div className="flex-1 min-w-0">
          {twoDMarket ? (
            <>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 line-clamp-1">
                {twoDMarket.baseMarketTitle}
              </h3>
              <div className="text-[10px] text-blue-600 dark:text-blue-400 font-medium mt-0.5">
                and...
              </div>
              <h4 className="text-xs font-medium text-slate-700 dark:text-slate-300 line-clamp-1 mt-0.5">
                {twoDMarket.secondaryQuestion}
              </h4>
            </>
          ) : (
            <>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 line-clamp-2">
                {market.title}
              </h3>
              {secondaryMarketInfos && secondaryMarketInfos.length > 0 && (
                <SecondaryMarketsExpander
                  secondaryMarketInfos={secondaryMarketInfos}
                  isExpanded={isSecondaryExpanded}
                  onToggle={handleToggleSecondary}
                  onViewSecondary={handleViewSecondary}
                />
              )}
            </>
          )}
        </div>
      </div>

      <div className="px-4 pb-4 flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex flex-col justify-between mt-3 min-h-0">
          {renderNormalView()}
        </div>

        <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 pt-2 mt-auto border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-1 font-mono font-semibold text-amber-600 dark:text-amber-400" title="Volume">
            {formatBtc(market.volume)}
          </div>
          <div className="flex items-center gap-1" title="Liquidity">
            <Droplet className="w-3.5 h-3.5" />
            <span className="font-mono font-medium">{formatBtc(market.liquidity)}</span>
          </div>
          <div className="flex items-center gap-1" title="Traders">
            <Users className="w-3.5 h-3.5" />
            <span className="font-mono font-medium">{market.traderCount.toLocaleString()}</span>
          </div>
          <button
            onClick={handleLike}
            className={`flex items-center gap-1 cursor-pointer transition-colors ${
              market.isLiked
                ? 'text-rose-500'
                : 'hover:text-rose-500'
            }`}
            title="Like"
          >
            <Heart className="w-3.5 h-3.5" fill={market.isLiked ? 'currentColor' : 'none'} />
            <span className="font-mono font-medium">{market.likeCount}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
