import { X, Copy, Check, Loader2, RotateCcw } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { useInvoiceCountdown, formatRemaining } from '@/lib/invoiceCountdown'

interface InvoiceDisplayProps {
  bolt11: string
  amountSats: number
  status: 'pending' | 'paid' | 'expired' | 'error'
  /** Bolt11 expiry (unix seconds). Drives the live "expires in Xm Ys" line. */
  expiresAtSec?: number
  /** Last poll/mint error to surface under the status pill. */
  errorMessage?: string | null
  onClose?: () => void
  /** Shown as a "Try again" button when status is 'expired' or 'error'. */
  onRegenerate?: () => void
  onPaid?: () => void
}

export function InvoiceDisplay({
  bolt11,
  amountSats,
  status,
  expiresAtSec,
  errorMessage,
  onClose,
  onRegenerate,
}: InvoiceDisplayProps) {
  const [copied, setCopied] = useState(false)
  const remainingMs = useInvoiceCountdown(expiresAtSec)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(bolt11)
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
        <h2 className="text-lg font-semibold text-white">Lightning Invoice</h2>
        <div className="w-8" />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full px-5">
        {/* Status */}
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            {status === 'pending' && (
              <>
                <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
                <span className="text-sm text-amber-400">
                  {expiresAtSec
                    ? `Awaiting payment (expires in ${formatRemaining(remainingMs)})`
                    : 'Waiting for payment...'}
                </span>
              </>
            )}
            {status === 'paid' && (
              <>
                <Check className="w-5 h-5 text-green-400" />
                <span className="text-sm text-green-400">Payment received!</span>
              </>
            )}
            {status === 'expired' && (
              <span className="text-sm text-red-400">Invoice expired — try again</span>
            )}
            {status === 'error' && (
              <span className="text-sm text-red-400">Payment failed</span>
            )}
          </div>
          {errorMessage && (status === 'expired' || status === 'error') && (
            <span className="text-xs text-red-300/80 max-w-xs text-center break-words">
              {errorMessage}
            </span>
          )}
          {(status === 'expired' || status === 'error') && onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#f7931a] hover:bg-[#e8850f] text-white text-xs font-semibold transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Try again
            </button>
          )}
        </div>

        {/* QR Code */}
        <div className="bg-white p-4 rounded-2xl">
          <QRCodeSVG
            value={bolt11.toUpperCase()}
            size={256}
            level="M"
          />
        </div>

        {/* Amount */}
        <div className="mt-6 text-2xl font-bold text-white font-mono">
          ₿{amountSats.toLocaleString()}
        </div>

        {/* Invoice text + copy */}
        <div className="mt-4 w-full">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 flex items-center gap-2">
            <span className="flex-1 text-xs text-slate-400 font-mono truncate">
              {bolt11}
            </span>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
