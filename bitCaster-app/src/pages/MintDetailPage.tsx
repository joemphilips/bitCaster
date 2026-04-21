import { useSearchParams, useNavigate } from 'react-router'
import { ArrowLeft, Trash2, ExternalLink } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useWalletStore } from '@/stores/wallet'

export function MintDetailPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const mintUrl = searchParams.get('mintUrl') ?? ''

  const storedMint = useWalletStore((s) => s.mints.find((m) => m.url === mintUrl))
  const removeMint = useWalletStore((s) => s.removeMint)
  const mints = useWalletStore((s) => s.mints)

  const info = storedMint?.info as Record<string, unknown> | undefined
  const name = (info?.name as string) ?? (() => { try { return new URL(mintUrl).hostname } catch { return mintUrl } })()
  const description = (info?.description as string) ?? ''
  const motd = (info?.motd as string) ?? ''
  const nuts = info?.nuts as Record<string, unknown> | undefined

  const handleRemove = () => {
    if (mints.length <= 1) return
    removeMint(mintUrl)
    navigate('/settings?category=cashu')
  }

  const isSafeUrl = mintUrl.startsWith('http://') || mintUrl.startsWith('https://')

  if (!mintUrl || !isSafeUrl) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <p className="text-slate-500">No valid mint URL specified.</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
          {name}
        </h1>
      </div>

      {/* Mint Info Card */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 space-y-4">
        {/* Icon + Name */}
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center border border-slate-200 dark:border-slate-600">
            <span className="text-xl font-bold text-slate-700 dark:text-slate-200">
              {name.slice(0, 2).toUpperCase()}
            </span>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{name}</h2>
            {description && (
              <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
            )}
          </div>
        </div>

        {/* MOTD */}
        {motd && (
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50">
            <p className="text-sm text-amber-800 dark:text-amber-300">{motd}</p>
          </div>
        )}

        {/* URL */}
        <div>
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
            URL
          </h3>
          <a
            href={mintUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm font-mono text-blue-600 dark:text-blue-400 hover:underline"
          >
            {mintUrl}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {/* Supported NUTs */}
        {nuts && Object.keys(nuts).length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Supported NUTs
            </h3>
            <div className="flex flex-wrap gap-2">
              {Object.keys(nuts).map((nut) => (
                <span
                  key={nut}
                  className="px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-700 text-xs font-mono text-slate-700 dark:text-slate-300"
                >
                  NUT-{nut}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* QR Code */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 flex flex-col items-center">
        <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">
          QR Code
        </h3>
        <div className="bg-white p-3 rounded-xl">
          <QRCodeSVG value={mintUrl} size={200} level="M" />
        </div>
      </div>

      {/* Remove Button */}
      {mints.length > 1 && (
        <button
          onClick={handleRemove}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 font-medium transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          Remove Mint
        </button>
      )}
    </div>
  )
}
