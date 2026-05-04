import { useState, useRef, useEffect } from 'react'
import { SlidersHorizontal, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CategoryTag } from '@/types/market'

interface TagBarProps {
  categoryTags: CategoryTag[]
  /**
   * Currently selected category tag IDs (multi-select, OR semantics). The
   * engine's `/api/v1/markets/query?tag=…` accepts repeated values; the page
   * forwards the whole set per click. P7 §`/markets`: users want to combine
   * categories rather than cycle through them one at a time.
   */
  selectedTags: string[]
  filtersVisible: boolean
  activeFilterCount: number
  onTagSelect?: (tagId: string) => void
  onClearTags?: () => void
  onToggleFilters?: () => void
}

export function TagBar({
  categoryTags,
  selectedTags,
  filtersVisible,
  activeFilterCount,
  onTagSelect,
  onClearTags,
  onToggleFilters,
}: TagBarProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkScroll = () => {
    if (scrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
      setCanScrollLeft(scrollLeft > 2)
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 2)
    }
  }

  useEffect(() => {
    checkScroll()
    const resizeObserver = new ResizeObserver(checkScroll)
    if (scrollRef.current) {
      resizeObserver.observe(scrollRef.current)
    }
    return () => resizeObserver.disconnect()
  }, [categoryTags])

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      const scrollAmount = 200
      scrollRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      })
    }
  }

  const selectedSet = new Set(selectedTags)
  const hasAnySelected = selectedSet.size > 0

  return (
    <div
      data-testid="market-tag-bar"
      className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md relative"
    >
      {/* Left scroll button */}
      {canScrollLeft && (
        <button
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700 ml-1"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}

      {/* Right scroll button */}
      {canScrollRight && (
        <button
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700 mr-1"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={checkScroll}
        className="flex items-center gap-2 px-4 sm:px-6 lg:px-8 py-3 overflow-x-auto scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {/* Category Tags */}
        {categoryTags.map((tag) => {
          const isSelected = selectedSet.has(tag.id)
          return (
            <button
              key={tag.id}
              onClick={() => onTagSelect?.(tag.id)}
              aria-pressed={isSelected}
              className={`px-4 py-2 rounded-full font-semibold text-sm transition-all transform hover:scale-105 whitespace-nowrap ${
                isSelected
                  ? 'bg-blue-600 dark:bg-blue-500 text-white shadow-lg scale-105'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
              }`}
            >
              <span>{tag.label}</span>
              <span className="ml-2 text-xs opacity-75 font-mono">{tag.marketCount}</span>
            </button>
          )
        })}

        {/* Clear-all chip — surfaces only while at least one tag is active so
            the row stays calm at rest. The mobile bottom-nav and the
            desktop header both render this row, so the affordance is
            present in both layouts (Mobile/Desktop UI Parity). */}
        {hasAnySelected && (
          <button
            onClick={onClearTags}
            data-testid="market-tag-clear"
            className="flex items-center gap-1 px-3 py-2 rounded-full font-semibold text-sm transition-colors whitespace-nowrap bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 hover:bg-rose-200 dark:hover:bg-rose-900/50"
          >
            <X className="w-3.5 h-3.5" />
            <span>{t('common.clearAll')}</span>
          </button>
        )}

        {/* Filter Toggle Button */}
        <div className="w-px bg-slate-300 dark:bg-slate-700 mx-2" />
        <button
          onClick={onToggleFilters}
          className={`relative p-2 rounded-full transition-all transform hover:scale-105 ${
            filtersVisible
              ? 'bg-blue-600 dark:bg-blue-500 text-white shadow-lg'
              : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
          }`}
          title={filtersVisible ? 'Hide filters' : 'Show filters'}
        >
          <SlidersHorizontal className="w-4 h-4" />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>
    </div>
  )
}
