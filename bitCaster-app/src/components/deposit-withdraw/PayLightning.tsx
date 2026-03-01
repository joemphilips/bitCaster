import { X, Bitcoin, ScanLine } from 'lucide-react'
import type { MintInfo } from '@/types/deposit-withdraw'
import { MintSelector } from './MintSelector'

interface PayLightningProps {
  mints: MintInfo[]
  selectedMintId: string
  lightningInput: string
  onMintChange?: (mintId: string) => void
  onLightningInputChange?: (value: string) => void
  onPaste?: () => void
  onScanQR?: () => void
  onClose?: () => void
}

export function PayLightning({
  mints,
  selectedMintId,
  lightningInput,
  onMintChange,
  onLightningInputChange,
  onPaste,
  onScanQR,
  onClose,
}: PayLightningProps) {
  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={() => onClose?.()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Pay Lightning</h2>
        <div className="p-1.5 text-slate-400">
          <Bitcoin className="w-5 h-5" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
        {/* Mint selector */}
        <div className="px-5 pt-2">
          <MintSelector
            mints={mints}
            selectedMintId={selectedMintId}
            onMintChange={onMintChange}
          />
        </div>

        {/* Invoice input */}
        <div className="px-5 pt-8">
          <div className="relative bg-slate-800 border border-slate-700 rounded-xl p-4">
            <textarea
              value={lightningInput}
              onChange={(e) => onLightningInputChange?.(e.target.value)}
              placeholder="Lightning address or invoice"
              rows={3}
              className="w-full bg-transparent text-white placeholder-slate-500 text-sm resize-none focus:outline-none"
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={() => onPaste?.()}
                className="text-sm font-semibold text-white hover:text-slate-300 transition-colors"
              >
                Paste
              </button>
            </div>
          </div>
        </div>

        {/* Scan QR */}
        <div className="px-5 pt-4">
          <button
            onClick={() => onScanQR?.()}
            className="w-full flex items-center gap-4 p-4 bg-slate-800 border border-slate-700 hover:border-slate-600 rounded-xl transition-colors group"
          >
            <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center group-hover:bg-slate-600 transition-colors">
              <ScanLine className="w-5 h-5 text-slate-300" />
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold text-white">
                Scan QR Code
              </div>
              <div className="text-xs text-slate-400">
                Tap to scan an address
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
