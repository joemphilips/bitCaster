import { useParams } from 'react-router'

export function MarketDetailPage() {
  const { id } = useParams()
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-100 mb-4">Market Detail</h1>
      <p className="text-slate-400">
        Detailed view for market <span className="font-mono text-slate-300">{id}</span>.
        Price charts, order book, and trading interface will appear here.
      </p>
    </div>
  )
}
