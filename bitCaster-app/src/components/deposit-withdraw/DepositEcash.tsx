import { ChevronLeft, Maximize2, Clipboard, ScanLine, FileText } from 'lucide-react'

interface DepositEcashProps {
  onPaste?: () => void
  onScan?: () => void
  onRequest?: () => void
  onBack?: () => void
  onToggleFullscreen?: () => void
}

export function DepositEcash({
  onPaste,
  onScan,
  onRequest,
  onBack,
  onToggleFullscreen,
}: DepositEcashProps) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end md:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Sheet */}
      <div className="relative w-full md:max-w-md bg-slate-800 rounded-t-2xl md:rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4">
          <button
            onClick={() => onBack?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 className="text-lg font-semibold text-white">Deposit Ecash</h2>
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
            onClick={() => onPaste?.()}
            className="w-full flex items-center gap-4 p-4 bg-slate-700/60 hover:bg-slate-700 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center group-hover:bg-slate-500 transition-colors">
              <Clipboard className="w-5 h-5 text-slate-300" />
            </div>
            <span className="text-base font-medium text-white">Paste</span>
          </button>

          <button
            onClick={() => onScan?.()}
            className="w-full flex items-center gap-4 p-4 bg-slate-700/60 hover:bg-slate-700 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center group-hover:bg-slate-500 transition-colors">
              <ScanLine className="w-5 h-5 text-slate-300" />
            </div>
            <span className="text-base font-medium text-white">Scan</span>
          </button>

          <button
            onClick={() => onRequest?.()}
            className="w-full flex items-center gap-4 p-4 bg-slate-700/60 hover:bg-slate-700 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center group-hover:bg-slate-500 transition-colors">
              <FileText className="w-5 h-5 text-slate-300" />
            </div>
            <span className="text-base font-medium text-white">Request</span>
          </button>
        </div>
      </div>
    </div>
  )
}
