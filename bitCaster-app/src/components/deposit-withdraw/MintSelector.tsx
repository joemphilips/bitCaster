import { useState } from 'react'
import { ChevronDown, Check, X } from 'lucide-react'
import type { MintInfo } from '@/types/deposit-withdraw'
import { AddMintForm } from '@/components/shared/AddMintForm'
import { normalizeUrl } from '@/lib/url'
import { userAddAndSelectMint } from '@/lib/walletOps'
import { formatAmount } from '@/lib/formatAmount'
import type { MarketBaseAsset } from '@bitcaster/client-sdk/marketUnits'

interface MintSelectorProps {
  mints: MintInfo[]
  selectedMintId: string
  selectedUnit?: MarketBaseAsset
  onMintChange?: (mintId: string) => void
}

export function MintSelector({
  mints,
  selectedMintId,
  selectedUnit = 'sat',
  onMintChange,
}: MintSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const selected = mints.find((m) => m.id === selectedMintId) ?? mints[0]
  if (!selected) return null
  // Falling back to `balanceSats` is only correct for the sat unit — a mint
  // with no balance entry for a fiat unit holds 0 of it, not its sat balance.
  const balanceFor = (mint: MintInfo): number =>
    mint.balancesByUnit?.[selectedUnit] ?? (selectedUnit === 'sat' ? mint.balanceSats : 0)

  /**
   * Add-mint completion (P5.2). The shared form invokes the wallet-store
   * action; on success the new mint URL becomes activeMintUrl and we
   * mirror that into the local widget selection so the just-added mint
   * is the one being deposited into. The bottom sheet stays open so the
   * user sees the new row land in the list.
   */
  const handleAddMint = async (rawUrl: string) => {
    await userAddAndSelectMint(rawUrl)
    onMintChange?.(normalizeUrl(rawUrl))
  }

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(true)}
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
            {formatAmount(balanceFor(selected), selectedUnit)} available
          </div>
        </div>

        {/* Chevron */}
        <ChevronDown className="w-5 h-5 text-slate-400" />
      </button>

      {/* Bottom sheet modal */}
      {isOpen && (
        <div className="fixed inset-0 z-[80] flex flex-col justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          />

          {/* Sheet */}
          <div className="relative bg-slate-900 border-t border-slate-700 rounded-t-2xl max-h-[60vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <h3 className="text-base font-semibold text-white">Select Mint</h3>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Mint list */}
            <div className="overflow-y-auto px-3 py-2">
              {mints.map((mint) => (
                <button
                  key={mint.id}
                  onClick={() => {
                    onMintChange?.(mint.id)
                    setIsOpen(false)
                  }}
                  className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-800 transition-colors"
                >
                  {/* Mint icon */}
                  <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-bold text-slate-900">
                      {mint.name.slice(0, 2).toUpperCase()}
                    </span>
                  </div>

                  {/* Mint info */}
                  <div className="flex-1 text-left">
                    <div className="text-sm font-semibold text-white">{mint.name}</div>
                    <div className="text-xs text-slate-400 font-mono">
                      {formatAmount(balanceFor(mint), selectedUnit)} available
                    </div>
                  </div>

                  {/* Selected indicator */}
                  {mint.id === selectedMintId && (
                    <Check className="w-5 h-5 text-green-400" />
                  )}
                </button>
              ))}

              {/* Add Mint trigger — same shared form as /settings (T5.2.c). */}
              <div className="px-1 py-3">
                <AddMintForm
                  onAddMint={handleAddMint}
                  triggerLabel="Add Mint"
                  variant="sheet"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
