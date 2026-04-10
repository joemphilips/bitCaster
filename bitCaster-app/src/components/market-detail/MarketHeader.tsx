import { Bookmark, Share2, Clock, CheckCircle2, Droplet, Users } from 'lucide-react'
import type { MarketDetail } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'
import { useBookmarkStore } from '@/stores/bookmarks'

interface MarketHeaderProps {
  market: MarketDetail
  onShare?: () => void
  onCreatorClick?: (creatorId: string) => void
}

function formatTimeRemaining(closingDate: string): string {
  const now = new Date()
  const close = new Date(closingDate)
  const diff = close.getTime() - now.getTime()

  if (diff < 0) return 'Closed'

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days > 7) {
    return new Date(closingDate).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  if (days > 0) return `${days}d ${hours}h remaining`
  if (hours > 0) return `${hours}h remaining`

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  return `${minutes}m remaining`
}

export function MarketHeader({
  market,
  onShare,
  onCreatorClick,
}: MarketHeaderProps) {
  const isResolved = market.resolution.status === 'resolved'
  const timeRemaining = formatTimeRemaining(market.closingDate)
  const isClosingSoon = !isResolved && new Date(market.closingDate).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000
  const isBookmarked = useBookmarkStore((s) => s.markets.includes(market.id))
  const toggleBookmark = useBookmarkStore((s) => s.toggle)

  const resolvedDate = isResolved
    ? new Date(market.resolution.resolutionDate).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null

  return (
    <div className="relative">
      {/* Background Image with Gradient Overlay */}
      {market.imageUrl && (
        <div className="absolute inset-0 h-64 overflow-hidden rounded-t-2xl">
          <img
            src={market.imageUrl}
            alt=""
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-900/60 via-slate-900/80 to-slate-900" />
        </div>
      )}

      {/* Content */}
      <div className={`relative ${market.imageUrl ? 'pt-8 pb-6 px-6' : 'py-6 px-6'}`}>
        {/* RESOLVED Badge */}
        {isResolved && (
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Resolved
            </span>
            {market.resolution.finalOutcome && (
              <span className="text-sm font-semibold text-emerald-400">
                {market.resolution.finalOutcome}
              </span>
            )}
          </div>
        )}

        {/* Category Tags */}
        <div className="flex flex-wrap gap-2 mb-4">
          {market.categoryTags.map((tag) => (
            <span
              key={tag.id}
              className="px-3 py-1 text-xs font-medium rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30"
            >
              {tag.label}
            </span>
          ))}
        </div>

        {/* Title */}
        <h1 className={`text-2xl md:text-3xl font-bold mb-4 leading-tight ${
          market.imageUrl ? 'text-white' : 'text-slate-900 dark:text-white'
        }`}>
          {market.title}
        </h1>

        {/* Meta Row */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          {/* Time Remaining / Resolved Date */}
          <div className={`flex items-center gap-1.5 ${
            isResolved
              ? 'text-slate-400'
              : isClosingSoon ? 'text-amber-400' : market.imageUrl ? 'text-slate-300' : 'text-slate-600 dark:text-slate-400'
          }`}>
            {isResolved ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
            <span className="text-sm font-medium">
              {isResolved ? `Resolved on ${resolvedDate}` : timeRemaining}
            </span>
          </div>

          {/* Share Button */}
          <button
            onClick={onShare}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors ${
              market.imageUrl
                ? 'bg-white/10 text-slate-300 hover:bg-white/20'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            <Share2 className="w-4 h-4" />
            <span className="text-sm font-medium">Share</span>
          </button>
        </div>

        {/* Creator Info */}
        <button
          onClick={() => onCreatorClick?.(market.creator.id)}
          className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
            market.imageUrl
              ? 'bg-white/10 hover:bg-white/20'
              : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700'
          }`}
        >
          {market.creator.avatarUrl ? (
            <img
              src={market.creator.avatarUrl}
              alt={market.creator.name}
              className="w-10 h-10 rounded-full"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold">
              {market.creator.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="text-left">
            <p className={`text-sm font-medium ${market.imageUrl ? 'text-white' : 'text-slate-900 dark:text-white'}`}>
              {market.creator.name}
            </p>
            <p className={`text-xs ${market.imageUrl ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}>
              {market.creator.totalMarketsCreated} markets created
              {market.creator.reputationScore && ` • ${market.creator.reputationScore} rating`}
            </p>
          </div>
        </button>

        {/* Metrics Footer */}
        <div className={`flex items-center justify-between text-xs pt-4 mt-4 border-t ${
          market.imageUrl
            ? 'border-white/10 text-slate-300'
            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
        }`}>
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
            onClick={() => toggleBookmark(market.id)}
            className={`flex items-center cursor-pointer transition-colors ${
              isBookmarked
                ? 'text-amber-500'
                : market.imageUrl
                  ? 'text-slate-300 hover:text-amber-500'
                  : 'text-slate-600 dark:text-slate-400 hover:text-amber-500'
            }`}
            title={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
            aria-pressed={isBookmarked}
          >
            <Bookmark className="w-3.5 h-3.5" fill={isBookmarked ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
    </div>
  )
}
