import { ChevronDown } from 'lucide-react'
import type { MintInfo } from '@/types/deposit-withdraw'

interface MintSelectorProps {
  mints: MintInfo[]
  selectedMintId: string
  onMintChange?: (mintId: string) => void
}

export function MintSelector({
  mints,
  selectedMintId,
  onMintChange,
}: MintSelectorProps) {
  const selected = mints.find((m) => m.id === selectedMintId) ?? mints[0]
  if (!selected) return null

  return (
    <button
      onClick={() => {
        // Cycle through mints for the demo
        const currentIndex = mints.findIndex((m) => m.id === selectedMintId)
        const nextIndex = (currentIndex + 1) % mints.length
        onMintChange?.(mints[nextIndex].id)
      }}
      className="w-full flex items-center gap-3 p-4 bg-slate-800 border border-slate-700 rounded-xl hover:border-slate-600 transition-colors"
    >
      {/* Mint icon */}
      <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center flex-shrink-0">
        <span className="text-sm font-bold text-slate-900">
          {selected.name.slice(0, 2).toUpperCase()}
        </span>
      </div>

      {/* Mint info */}
      <div className="flex-1 text-left">
        <div className="text-sm font-semibold text-white">{selected.name}</div>
        <div className="text-xs text-slate-400 font-mono">
          ₿{selected.balanceSats.toLocaleString()} available
        </div>
      </div>

      {/* Chevron */}
      <ChevronDown className="w-5 h-5 text-slate-400" />
    </button>
  )
}
