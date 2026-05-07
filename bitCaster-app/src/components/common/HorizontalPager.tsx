import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface HorizontalPagerProps {
  children: ReactNode
  /**
   * Tailwind classes appended to the inner scroll container.  Use this to
   * tune layout (`gap-*`, `px-*`, `py-*`, `items-*`) without re-styling
   * the outer wrapper.  The inner container is always `flex` and always
   * hides the native scrollbar.
   */
  className?: string
  /** Accessibility label for the scroll region. */
  ariaLabel?: string
  /**
   * data-testid forwarded to the scroll container, so consumers can
   * target it (`liked-markets-scroller`, `market-tag-bar`, ...).
   */
  scrollerTestId?: string
}

/**
 * Horizontally-scrollable flex container with conditional `<` / `>`
 * chevron buttons that fade in only when there is content to scroll
 * past either edge.  Used by `TagBar`, `LikedMarkets`, and the merged
 * sort/category row on `/markets`.  The native scrollbar is always
 * hidden — paging is the affordance.
 */
export function HorizontalPager({
  children,
  className = '',
  ariaLabel,
  scrollerTestId,
}: HorizontalPagerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > 2)
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 2)
  }

  useEffect(() => {
    checkScroll()
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(checkScroll)
    observer.observe(el)
    // Also re-evaluate when child nodes mutate (e.g. tag list updates),
    // since ResizeObserver only fires on box-size changes.
    const mutation = new MutationObserver(checkScroll)
    mutation.observe(el, { childList: true })
    return () => {
      observer.disconnect()
      mutation.disconnect()
    }
  }, [])

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    const amount = Math.max(200, el.clientWidth * 0.6)
    el.scrollBy({
      left: direction === 'left' ? -amount : amount,
      behavior: 'smooth',
    })
  }

  return (
    <div className="relative flex-1 min-w-0">
      {canScrollLeft && (
        <PagerButton
          side="left"
          ariaLabel="Scroll left"
          onClick={() => scroll('left')}
        />
      )}
      {canScrollRight && (
        <PagerButton
          side="right"
          ariaLabel="Scroll right"
          onClick={() => scroll('right')}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={checkScroll}
        role={ariaLabel ? 'region' : undefined}
        aria-label={ariaLabel}
        data-testid={scrollerTestId}
        className={`flex overflow-x-auto scrollbar-hide ${className}`}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {children}
      </div>
    </div>
  )
}

interface PagerButtonProps {
  side: 'left' | 'right'
  ariaLabel: string
  onClick: () => void
}

function PagerButton({ side, ariaLabel, onClick }: PagerButtonProps) {
  const positionClass = side === 'left' ? 'left-0 ml-1' : 'right-0 mr-1'
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-testid={`horizontal-pager-${side}`}
      onClick={onClick}
      className={`absolute ${positionClass} top-1/2 -translate-y-1/2 z-10 w-8 h-8 bg-white dark:bg-slate-800 shadow-lg rounded-full flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700`}
    >
      <Icon className="w-5 h-5" />
    </button>
  )
}
