import { Flame, Star, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MarketSort } from '@/hooks/useMarketSort'

interface SortBarProps {
  active: MarketSort
  onSortChange: (next: MarketSort) => void
}

interface SortOption {
  value: MarketSort
  labelKey: string
  Icon: typeof Flame
}

const SORT_OPTIONS: ReadonlyArray<SortOption> = [
  { value: 'trending', labelKey: 'sort.trending', Icon: Flame },
  { value: 'popular', labelKey: 'sort.popular', Icon: Star },
  { value: 'new', labelKey: 'sort.new', Icon: Sparkles },
]

/**
 * Three mutually-exclusive sort buttons rendered above the tag chips on
 * the markets list page. The buttons drive ADR-009's `?sort=` parameter
 * — until engine PR #26 lands the values are consumed by the client-side
 * `useMarketSort` hook (lifetime volume for popular/trending, createdAt
 * desc for new). Always-rendered, single-selection, default `trending`.
 */
export function SortBar({ active, onSortChange }: SortBarProps) {
  const { t } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={t('sort.label')}
      data-testid="market-sort-bar"
      className="flex items-center gap-2 px-4 sm:px-6 lg:px-8 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
    >
      {SORT_OPTIONS.map(({ value, labelKey, Icon }) => {
        const isActive = active === value
        return (
          <button
            key={value}
            role="tab"
            aria-selected={isActive}
            data-testid={`market-sort-${value}`}
            onClick={() => onSortChange(value)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full font-bold text-sm transition-all transform hover:scale-105 whitespace-nowrap ${
              isActive
                ? 'bg-amber-500 dark:bg-amber-400 text-white shadow-lg scale-105'
                : 'bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/40'
            }`}
          >
            <Icon className="w-4 h-4" />
            <span>{t(labelKey)}</span>
          </button>
        )
      })}
    </div>
  )
}
