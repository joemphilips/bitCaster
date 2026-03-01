import type { Fund } from '@/types/portfolio'
import { FundRow } from './FundRow'

interface FundsListProps {
  funds: Fund[]
  onViewFund?: (fundId: string) => void
}

export function FundsList({ funds, onViewFund }: FundsListProps) {
  if (funds.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        No funds
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {funds.map((fund) => (
        <FundRow key={fund.id} fund={fund} onView={onViewFund} />
      ))}
    </div>
  )
}
