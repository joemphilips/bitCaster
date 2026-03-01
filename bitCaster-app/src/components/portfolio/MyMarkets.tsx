import { useState } from 'react'
import type { CreatedMarket } from '@/types/portfolio'
import { ChevronDown } from 'lucide-react'
import { CreatedMarketRow } from './CreatedMarketRow'

interface MyMarketsProps {
  markets: CreatedMarket[]
  onViewMarket?: (marketId: string) => void
  onClaimCreatorFees?: (marketId: string) => void
}

export function MyMarkets({ markets, onViewMarket, onClaimCreatorFees }: MyMarketsProps) {
  const [isOpen, setIsOpen] = useState(true)

  if (markets.length === 0) return null

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 text-left"
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          My Markets ({markets.length})
        </h3>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="px-1 pb-1">
          {markets.map((market) => (
            <CreatedMarketRow
              key={market.id}
              market={market}
              onView={onViewMarket}
              onClaimFees={onClaimCreatorFees}
            />
          ))}
        </div>
      )}
    </div>
  )
}
