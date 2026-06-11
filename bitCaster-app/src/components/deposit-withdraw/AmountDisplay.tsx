import { ArrowUpDown } from 'lucide-react'

interface AmountDisplayProps {
  amountSats: number
  amountLabel?: string
  amountFiat: string
  fiatSymbol: string
  showFiatPrimary: boolean
  /** Hide the fiat-equivalent toggle line — e.g. when the entered amount is
   *  already fiat-denominated (USD/JPY deposit units). Defaults to true. */
  showFiatToggle?: boolean
  onToggleCurrency?: () => void
}

export function AmountDisplay({
  amountSats,
  amountLabel,
  amountFiat,
  fiatSymbol,
  showFiatPrimary,
  showFiatToggle = true,
  onToggleCurrency,
}: AmountDisplayProps) {
  const satsText = amountLabel ?? `₿${amountSats.toLocaleString()}`
  const fiatText = `${fiatSymbol}${amountFiat}`

  const primary = showFiatToggle && showFiatPrimary ? fiatText : satsText
  const secondary = showFiatPrimary ? satsText : fiatText

  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="text-5xl sm:text-6xl font-bold text-white font-mono tracking-tight">
        {primary}
      </div>
      {showFiatToggle && (
        <button
          onClick={() => onToggleCurrency?.()}
          className="mt-2 flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-300 transition-colors"
        >
          <span>{secondary}</span>
          <ArrowUpDown className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
