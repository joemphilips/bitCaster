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
 * Three mutually-exclusive sort buttons rendered at the left of the
 * markets list page's discovery bar.  ADR-009 `?sort=` parameter; until
 * engine PR #26 lands the values are consumed by the client-side
 * `useMarketSort` hook.  Always-rendered, single-selection, default
 * `trending`.
 *
 * Layout-only: the host (`MarketDiscovery`) supplies the surrounding
 * background and divider; this component only paints the pills.
 */
export function SortBar({ active, onSortChange }: SortBarProps) {
  const { t } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={t('sort.label')}
      data-testid="market-sort-bar"
      className="flex items-center gap-2 shrink-0"
    >
      {SORT_OPTIONS.map(({ value, labelKey, Icon }) => (
        <SortPill
          key={value}
          isActive={active === value}
          value={value}
          label={t(labelKey)}
          Icon={Icon}
          onClick={() => onSortChange(value)}
        />
      ))}
    </div>
  )
}

interface SortPillProps {
  isActive: boolean
  value: MarketSort
  label: string
  Icon: typeof Flame
  onClick: () => void
}

function SortPill({ isActive, value, label, Icon, onClick }: SortPillProps) {
  return (
    <button
      role="tab"
      aria-selected={isActive}
      data-testid={`market-sort-${value}`}
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 rounded-full font-bold text-sm transition-all transform hover:scale-105 whitespace-nowrap ${
        isActive
          ? 'bg-amber-500 dark:bg-amber-400 text-white shadow-lg scale-105'
          : 'bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/40'
      }`}
    >
      <Icon className="w-4 h-4" />
      <span>{label}</span>
    </button>
  )
}
