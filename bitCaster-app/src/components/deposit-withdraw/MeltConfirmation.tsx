import { X, Zap, Loader2 } from 'lucide-react'

interface MeltConfirmationProps {
  amountSats: number
  feeSats: number
  invoice: string
  isPaying: boolean
  onConfirm?: () => void
  onClose?: () => void
}

export function MeltConfirmation({
  amountSats,
  feeSats,
  invoice,
  isPaying,
  onConfirm,
  onClose,
}: MeltConfirmationProps) {
  const total = amountSats + feeSats

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={() => onClose?.()}
          disabled={isPaying}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors disabled:opacity-40"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Confirm Payment</h2>
        <div className="p-1.5 text-slate-400">
          <Zap className="w-5 h-5" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full px-5">
        {/* Invoice preview */}
        <div className="mt-4 bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 font-mono truncate">
            {invoice}
          </div>
        </div>

        {/* Amount breakdown */}
        <div className="mt-8 space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-sm text-slate-400">Invoice amount</span>
            <span className="text-sm font-mono text-white">₿{amountSats.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-slate-400">Network fee (estimate)</span>
            <span className="text-sm font-mono text-white">₿{feeSats.toLocaleString()}</span>
          </div>
          <div className="border-t border-slate-700 pt-4 flex justify-between items-center">
            <span className="text-base font-semibold text-white">Total</span>
            <span className="text-base font-bold font-mono text-white">₿{total.toLocaleString()}</span>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Action button */}
        <div className="py-6">
          <button
            onClick={() => onConfirm?.()}
            disabled={isPaying}
            className="w-full py-4 rounded-xl text-base font-bold uppercase tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-slate-200 text-slate-900 hover:bg-white active:bg-slate-300 disabled:hover:bg-slate-200 flex items-center justify-center gap-2"
          >
            {isPaying ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Paying...
              </>
            ) : (
              'Pay'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
