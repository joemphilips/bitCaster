import { PlusCircle, RefreshCw } from 'lucide-react'
import type { SetupChoice } from '@/types/wallet-setup'

interface ChoiceCardsProps {
  onChoiceSelect?: (choice: SetupChoice) => void
}

const choices = [
  {
    id: 'create' as SetupChoice,
    icon: PlusCircle,
    title: 'Create New Wallet',
    description: 'Generate a fresh wallet with a new seed phrase',
  },
  {
    id: 'recover' as SetupChoice,
    icon: RefreshCw,
    title: 'Recover Wallet',
    description: 'Restore an existing wallet from your 12-word seed phrase',
  },
]

export function ChoiceCards({ onChoiceSelect }: ChoiceCardsProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
          Set Up Your Wallet
        </h2>
        <p className="text-slate-500 dark:text-slate-400">
          Choose how you'd like to get started
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {choices.map(({ id, icon: Icon, title, description }) => (
          <button
            key={id}
            onClick={() => onChoiceSelect?.(id)}
            className="group relative p-6 rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 transition-all duration-200 text-left"
          >
            <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-4 group-hover:bg-blue-200 dark:group-hover:bg-blue-900/50 transition-colors">
              <Icon className="w-6 h-6 text-blue-600 dark:text-blue-400" strokeWidth={1.5} />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">
              {title}
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              {description}
            </p>
            <div className="absolute inset-0 rounded-2xl ring-0 group-hover:ring-2 ring-blue-500/20 dark:ring-blue-400/20 transition-all pointer-events-none" />
          </button>
        ))}
      </div>
    </div>
  )
}
