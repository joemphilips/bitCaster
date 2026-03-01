import { X, Lock, Bitcoin } from 'lucide-react'
import type { MintInfo } from '@/types/deposit-withdraw'
import { MintSelector } from './MintSelector'
import { AmountDisplay } from './AmountDisplay'
import { Numpad } from './Numpad'

interface SendEcashProps {
  mints: MintInfo[]
  selectedMintId: string
  amountSats: number
  amountFiat: string
  fiatSymbol: string
  showFiatPrimary: boolean
  onMintChange?: (mintId: string) => void
  onNumpadPress?: (key: string) => void
  onToggleCurrency?: () => void
  onSendEcash?: () => void
  onClose?: () => void
}

export function SendEcash({
  mints,
  selectedMintId,
  amountSats,
  amountFiat,
  fiatSymbol,
  showFiatPrimary,
  onMintChange,
  onNumpadPress,
  onToggleCurrency,
  onSendEcash,
  onClose,
}: SendEcashProps) {
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
        <h2 className="text-lg font-semibold text-white">Send Ecash</h2>
        <div className="flex items-center gap-1 text-slate-400">
          <Lock className="w-4 h-4" />
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

        {/* Amount */}
        <div className="flex-1 flex items-center justify-center">
          <AmountDisplay
            amountSats={amountSats}
            amountFiat={amountFiat}
            fiatSymbol={fiatSymbol}
            showFiatPrimary={showFiatPrimary}
            onToggleCurrency={onToggleCurrency}
          />
        </div>

        {/* Numpad */}
        <Numpad onPress={onNumpadPress} />

        {/* Action button */}
        <div className="px-5 py-6">
          <button
            onClick={() => onSendEcash?.()}
            disabled={amountSats === 0}
            className="w-full py-4 rounded-xl text-base font-bold uppercase tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-slate-200 text-slate-900 hover:bg-white active:bg-slate-300 disabled:hover:bg-slate-200"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
