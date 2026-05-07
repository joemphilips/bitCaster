import { useParams } from 'react-router'
import { UserCircle } from 'lucide-react'

export function UserPage() {
  const { pubkey = '' } = useParams()
  const shortPubkey = pubkey.length > 16
    ? `${pubkey.slice(0, 12)}...${pubkey.slice(-8)}`
    : pubkey

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center gap-4 border-b border-slate-200 dark:border-slate-800 pb-6">
          <div className="w-14 h-14 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400">
            <UserCircle className="w-8 h-8" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              User
            </h1>
            <p className="font-mono text-sm text-slate-500 dark:text-slate-400 truncate">
              {shortPubkey}
            </p>
          </div>
        </div>

        <section className="py-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Markets
          </h2>
          <div className="mt-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-6 text-sm text-slate-500 dark:text-slate-400">
            No creator markets found.
          </div>
        </section>
      </div>
    </div>
  )
}
