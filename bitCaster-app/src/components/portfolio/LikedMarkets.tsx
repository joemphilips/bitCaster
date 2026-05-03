import { useTranslation } from 'react-i18next'
import { Heart } from 'lucide-react'
import { useLikedMarkets } from '@/hooks/useLikedMarkets'
import type { Market } from '@/types/market'

interface LikedMarketsProps {
  onViewMarket?: (marketId: string) => void
}

/**
 * Horizontal scrollable list of the user's bookmarked / "liked" markets.
 * Mounted on the portfolio page below the funds tabs (P5.1).
 *
 * The "liked" label intentionally maps to the existing bookmark store,
 * because that's what the heart-shaped Bookmark icon on each market card
 * already toggles — there is no separate kind-7 reaction store. Future
 * separation, if requested, can split the two without changing this UI.
 */
export function LikedMarkets({ onViewMarket }: LikedMarketsProps) {
  const { t } = useTranslation()
  const { markets, loading, error } = useLikedMarkets()

  return (
    <section
      aria-labelledby="liked-markets-heading"
      data-testid="liked-markets"
      className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5"
    >
      <div className="flex items-center gap-2 mb-3">
        <Heart className="w-4 h-4 text-rose-500" />
        <h3
          id="liked-markets-heading"
          className="text-sm font-semibold text-slate-900 dark:text-white"
        >
          {t('portfolio.likedMarkets')}
        </h3>
      </div>

      {loading ? (
        <p className="py-6 text-sm text-slate-400 dark:text-slate-500">
          {t('common.loading')}
        </p>
      ) : error ? (
        <p
          className="py-6 text-sm text-red-500 dark:text-red-400"
          data-testid="liked-markets-error"
        >
          {error}
        </p>
      ) : markets.length === 0 ? (
        <p
          className="py-6 text-sm text-slate-400 dark:text-slate-500"
          data-testid="liked-markets-empty"
        >
          {t('portfolio.likedMarketsEmpty')}
        </p>
      ) : (
        <div
          className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x"
          role="list"
          data-testid="liked-markets-scroller"
        >
          {markets.map((m) => (
            <LikedMarketCard
              key={m.id}
              market={m}
              onClick={() => onViewMarket?.(m.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function LikedMarketCard({ market, onClick }: { market: Market; onClick: () => void }) {
  return (
    <button
      role="listitem"
      onClick={onClick}
      data-testid={`liked-market-card-${market.id}`}
      className="snap-start shrink-0 w-56 text-left rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-700/30 hover:bg-slate-100 dark:hover:bg-slate-700/60 transition-colors overflow-hidden"
    >
      <div className="aspect-video bg-slate-200 dark:bg-slate-700 flex items-center justify-center overflow-hidden">
        {market.imageUrl ? (
          <img
            src={market.imageUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="text-2xl text-slate-400 dark:text-slate-500">&#8383;</span>
        )}
      </div>
      <div className="p-3 space-y-1">
        <p className="text-sm font-medium text-slate-900 dark:text-white line-clamp-2">
          {market.title}
        </p>
        {market.type === 'yesno' && (
          <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
            {market.currentOdds.yes}% / {market.currentOdds.no}%
          </p>
        )}
      </div>
    </button>
  )
}
