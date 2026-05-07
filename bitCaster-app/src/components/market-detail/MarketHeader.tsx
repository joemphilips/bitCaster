import {
  Heart,
  Share2,
  Clock,
  CheckCircle2,
  Droplet,
  Users,
  Landmark,
  Copy,
} from 'lucide-react'
import { nip19 } from 'nostr-tools'
import { useTranslation } from 'react-i18next'
import type { MarketDetail } from '@/types/market-detail'
import { formatBtc } from '@/lib/format'
import { useBookmarkStore } from '@/stores/bookmarks'

interface MarketHeaderProps {
  market: MarketDetail
  onShare?: () => void
}

const HexPubkeyPattern = /^[0-9a-f]{64}$/i

function formatCreatorNpub(creatorId: string): string | null {
  const trimmed = creatorId.trim()
  if (!trimmed || trimmed === 'unknown') return null
  if (trimmed.startsWith('npub1')) return trimmed
  if (HexPubkeyPattern.test(trimmed))
    return nip19.npubEncode(trimmed.toLowerCase())
  return trimmed
}

function shortenNpub(npub: string): string {
  if (npub.length <= 18) return npub
  return `${npub.slice(0, 10)}...${npub.slice(-6)}`
}

function formatTimeRemaining(
  closingDate: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: string,
): string {
  const now = new Date()
  const close = new Date(closingDate)
  const diff = close.getTime() - now.getTime()

  // `mapConditionToMarketDetail` defaults `closingDate` to the page-load time
  // when neither mintd nor the engine catalogue surfaces a real deadline. Treat
  // any |diff| under 60s as that "unknown deadline" sentinel and hide the row,
  // rather than rendering a misleading "Closed" badge. Once `engineEntry.deadline`
  // is wired through `mergeEngineCatalogueEntry`, real deadlines fall into the
  // normal "in the past → Closed" / "in the future → countdown" branches below.
  if (Math.abs(diff) < 60_000) return ''
  if (diff < 0) return t('market.closed')

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days > 7) {
    return new Date(closingDate).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  if (days > 0) return t('market.daysHoursRemaining', { days, hours })
  if (hours > 0) return t('market.hoursRemaining', { hours })

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  return t('market.minutesRemaining', { minutes })
}

export function MarketHeader({ market, onShare }: MarketHeaderProps) {
  const { t, i18n } = useTranslation()
  const isResolved = market.resolution.status === 'resolved'
  const timeRemaining = formatTimeRemaining(
    market.closingDate,
    t,
    i18n.language,
  )
  const isClosingSoon =
    !isResolved &&
    new Date(market.closingDate).getTime() - Date.now() <
      7 * 24 * 60 * 60 * 1000
  const isBookmarked = useBookmarkStore((s) => s.markets.includes(market.id))
  const toggleBookmark = useBookmarkStore((s) => s.toggle)
  const creatorNpub = formatCreatorNpub(market.creator.id)
  const creatorLabel = creatorNpub ? shortenNpub(creatorNpub) : 'Unknown'
  const mintLabel = market.mint
    ? `${market.mint.collateral.toUpperCase()} CTF${
        market.mint.keysetCount > 0
          ? ` - ${market.mint.keysetCount} keysets`
          : ''
      }`
    : 'Unknown'

  const resolvedDate = isResolved
    ? new Date(market.resolution.resolutionDate).toLocaleDateString(
        i18n.language,
        {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        },
      )
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
      <div
        className={`relative ${market.imageUrl ? 'pt-8 pb-6 px-6' : 'py-6 px-6'}`}
      >
        {/* RESOLVED Badge */}
        {isResolved && (
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t('marketStatus.resolved')}
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
        <h1
          className={`text-2xl md:text-3xl font-bold mb-4 leading-tight ${market.imageUrl ? 'text-white' : 'text-slate-900 dark:text-white'}`}
        >
          {market.title}
        </h1>

        {/* Meta Row */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          {/* Time Remaining / Resolved Date — hidden when no real deadline known */}
          {(isResolved || timeRemaining) && (
            <div
              className={`flex items-center gap-1.5 ${isResolved ? 'text-slate-400' : isClosingSoon ? 'text-amber-400' : market.imageUrl ? 'text-slate-300' : 'text-slate-600 dark:text-slate-400'}`}
            >
              {isResolved ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <Clock className="w-4 h-4" />
              )}
              <span className="text-sm font-medium">
                {isResolved
                  ? t('market.resolvedOn', { date: resolvedDate })
                  : timeRemaining}
              </span>
            </div>
          )}

          {/* Share Button */}
          <button
            onClick={onShare}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors ${market.imageUrl ? 'bg-white/10 text-slate-300 hover:bg-white/20' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
          >
            <Share2 className="w-4 h-4" />
            <span className="text-sm font-medium">{t('common.share')}</span>
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          {/* Creator Info */}
          <div
            className={`flex min-w-0 flex-1 items-center gap-3 p-3 rounded-xl ${market.imageUrl ? 'bg-white/10' : 'bg-slate-100 dark:bg-slate-800'}`}
          >
            {market.creator.avatarUrl ? (
              <img
                src={market.creator.avatarUrl}
                alt={market.creator.name}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold">
                {creatorLabel.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p
                className={`truncate text-sm font-medium ${market.imageUrl ? 'text-white' : 'text-slate-900 dark:text-white'}`}
              >
                {t('market.oracle')}
              </p>
              <p
                className={`truncate text-xs font-mono ${market.imageUrl ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}
              >
                {creatorLabel}
              </p>
            </div>
            {creatorNpub && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(creatorNpub)
                }}
                className={`shrink-0 rounded-full p-2 transition-colors ${market.imageUrl ? 'text-slate-300 hover:bg-white/15 hover:text-white' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-white'}`}
                aria-label={t('market.copyOraclePubkey')}
                title={t('market.copyOraclePubkey')}
              >
                <Copy className="w-4 h-4" />
              </button>
            )}
          </div>

          <div
            className={`flex min-w-0 flex-1 items-center gap-3 p-3 rounded-xl ${market.imageUrl ? 'bg-white/10' : 'bg-slate-100 dark:bg-slate-800'}`}
          >
            <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center text-amber-500">
              <Landmark className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p
                className={`truncate text-sm font-medium ${market.imageUrl ? 'text-white' : 'text-slate-900 dark:text-white'}`}
              >
                Mint
              </p>
              <p
                className={`truncate text-xs font-mono ${market.imageUrl ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}`}
              >
                {mintLabel}
              </p>
            </div>
          </div>
        </div>

        {/* Metrics Footer */}
        <div
          className={`flex items-center justify-between text-xs pt-4 mt-4 border-t ${market.imageUrl ? 'border-white/10 text-slate-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}
        >
          <div
            className="flex items-center gap-1 font-mono font-semibold text-amber-600 dark:text-amber-400"
            title="Volume"
          >
            {formatBtc(market.volume)}
          </div>
          <div className="flex items-center gap-1" title="Liquidity">
            <Droplet className="w-3.5 h-3.5" />
            <span className="font-mono font-medium">
              {formatBtc(market.liquidity)}
            </span>
          </div>
          <div className="flex items-center gap-1" title="Traders">
            <Users className="w-3.5 h-3.5" />
            <span className="font-mono font-medium">
              {market.traderCount.toLocaleString()}
            </span>
          </div>
          <button
            onClick={() => toggleBookmark(market.id)}
            className={`flex items-center cursor-pointer transition-colors ${isBookmarked ? 'text-rose-500' : market.imageUrl ? 'text-slate-300 hover:text-rose-500' : 'text-slate-600 dark:text-slate-400 hover:text-rose-500'}`}
            title={
              isBookmarked ? t('market.removeBookmark') : t('market.bookmark')
            }
            aria-pressed={isBookmarked}
          >
            <Heart
              className="w-3.5 h-3.5"
              fill={isBookmarked ? 'currentColor' : 'none'}
            />
          </button>
        </div>
      </div>
    </div>
  )
}
