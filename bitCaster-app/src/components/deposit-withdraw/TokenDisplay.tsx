import { X, Copy, Check } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'

interface TokenDisplayProps {
  token: string
  amountSats: number
  onClose?: () => void
}

export function TokenDisplay({
  token,
  amountSats,
  onClose,
}: TokenDisplayProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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
        <div className="w-8" />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full px-5">
        {/* QR Code */}
        <div className="bg-white p-4 rounded-2xl">
          <QRCodeSVG
            value={token}
            size={256}
            level="L"
          />
        </div>

        {/* Amount */}
        <div className="mt-6 text-2xl font-bold text-white font-mono">
          ₿{amountSats.toLocaleString()}
        </div>

        {/* Token text + copy */}
        <div className="mt-4 w-full">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 flex items-center gap-2">
            <span className="flex-1 text-xs text-slate-400 font-mono truncate">
              {token}
            </span>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Instruction */}
        <p className="mt-4 text-sm text-slate-400 text-center">
          Share this token with the recipient. They can redeem it in any Cashu wallet.
        </p>
      </div>
    </div>
  )
}
