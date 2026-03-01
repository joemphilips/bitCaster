import { X, Maximize2, Link, Zap } from 'lucide-react'
import type { DepositWithdrawMode, MethodType } from '@/types/deposit-withdraw'

interface MethodChooserProps {
  mode: DepositWithdrawMode
  onSelectMethod?: (method: MethodType) => void
  onClose?: () => void
  onToggleFullscreen?: () => void
}

export function MethodChooser({
  mode,
  onSelectMethod,
  onClose,
  onToggleFullscreen,
}: MethodChooserProps) {
  const title = mode === 'deposit' ? 'Deposit' : 'Withdrawal'

  return (
    <div className="fixed inset-0 z-[70] flex items-end md:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => onClose?.()}
      />

      {/* Sheet */}
      <div className="relative w-full md:max-w-md bg-slate-800 rounded-t-2xl md:rounded-2xl overflow-hidden animate-in slide-in-from-bottom duration-300">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4">
          <button
            onClick={() => onClose?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button
            onClick={() => onToggleFullscreen?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <Maximize2 className="w-5 h-5" />
          </button>
        </div>

        {/* Options */}
        <div className="px-5 pb-6 space-y-3">
          <button
            onClick={() => onSelectMethod?.('ecash')}
            className="w-full flex items-center gap-4 p-4 bg-slate-700/60 hover:bg-slate-700 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center group-hover:bg-slate-500 transition-colors">
              <Link className="w-5 h-5 text-slate-300" />
            </div>
            <span className="text-base font-medium text-white">Ecash</span>
          </button>

          <button
            onClick={() => onSelectMethod?.('lightning')}
            className="w-full flex items-center gap-4 p-4 bg-slate-700/60 hover:bg-slate-700 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center group-hover:bg-slate-500 transition-colors">
              <Zap className="w-5 h-5 text-slate-300" />
            </div>
            <span className="text-base font-medium text-white">Lightning</span>
          </button>
        </div>
      </div>
    </div>
  )
}
