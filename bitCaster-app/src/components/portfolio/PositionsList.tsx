import type { Position } from '@/types/portfolio'
import { PositionRow } from './PositionRow'

interface PositionsListProps {
  positions: Position[]
  positionsTab: 'active' | 'closed'
  onPositionsTabChange?: (tab: 'active' | 'closed') => void
  onSellPosition?: (positionId: string) => void
  onClaimPayout?: (positionId: string) => void
  onViewPosition?: (positionId: string) => void
}

export function PositionsList({
  positions,
  positionsTab,
  onPositionsTabChange,
  onSellPosition,
  onClaimPayout,
  onViewPosition,
}: PositionsListProps) {
  const filtered = positions.filter((p) => p.status === positionsTab)

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-3" role="tablist">
        {(['active', 'closed'] as const).map((tab) => {
          const count = positions.filter((p) => p.status === tab).length
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={positionsTab === tab}
              onClick={() => onPositionsTabChange?.(tab)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                positionsTab === tab
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)} ({count})
            </button>
          )
        })}
      </div>

      {/* Position List */}
      {filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
          No {positionsTab} positions
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((position) => (
            <PositionRow
              key={position.id}
              position={position}
              onSell={onSellPosition}
              onClaim={onClaimPayout}
              onView={onViewPosition}
            />
          ))}
        </div>
      )}
    </div>
  )
}
