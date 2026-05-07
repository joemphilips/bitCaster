import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router'
import { ArrowLeft, Trash2, ChevronDown, Mail, AtSign, Copy } from 'lucide-react'
import { useWalletStore } from '@/stores/wallet'
import { userRemoveMint } from '@/lib/walletOps'
import { safeHostname } from '@/lib/url'

/** Human-readable names for well-known NUTs (7+). */
const NUT_NAMES: Record<string, string> = {
  '7': 'Token state check',
  '8': 'Overpaid Lightning fees',
  '9': 'Signature restore',
  '10': 'Spending conditions',
  '11': 'Pay-to-Pubkey (P2PK)',
  '12': 'DLEQ proofs',
  '13': 'Deterministic secrets',
  '14': 'Hashed Timelock Contracts',
  '15': 'Partial multi-path payments',
  '16': 'Animated QR codes',
  '17': 'WebSocket subscriptions',
  '18': 'Payment requests',
  '19': 'Cached responses',
  '20': 'Signature on mint quote',
  '21': 'Clear authentication',
  '22': 'Blind authentication',
  '29': 'Batched minting',
  'CTF': 'Conditional Tokens',
  'CTF-split-merge': 'CTF Split/Merge',
  'CTF-numeric': 'CTF Numeric',
}

interface ContactEntry {
  method: string
  info: string
}

interface SwapMethodLike {
  method?: string
  unit?: string
}

export function MintDetailPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const mintUrl = searchParams.get('mintUrl') ?? ''
  const [nutsExpanded, setNutsExpanded] = useState(false)

  const storedMint = useWalletStore((s) => s.mints.find((m) => m.url === mintUrl))
  const mints = useWalletStore((s) => s.mints)

  const info = storedMint?.info as Record<string, unknown> | undefined
  const name = (info?.name as string) ?? safeHostname(mintUrl)
  const description = (info?.description as string) ?? ''
  const descriptionLong = (info?.description_long as string) ?? ''
  const motd = (info?.motd as string) ?? ''
  const version = (info?.version as string) ?? ''
  const nuts = info?.nuts as Record<string, unknown> | undefined
  const contact = (info?.contact ?? []) as ContactEntry[]

  // Derive supported currencies/units from NUT-4 (mint) and NUT-5 (melt) method lists.
  const methodUnits = (['4', '5'] as const).flatMap((key) => {
    const nut = nuts?.[key] as { methods?: SwapMethodLike[] } | undefined
    return nut?.methods?.map((m) => m.unit).filter((u): u is string => !!u) ?? []
  })
  const supportedUnits = Array.from(new Set(methodUnits))

  const handleRemove = () => {
    if (mints.length <= 1) return
    userRemoveMint(mintUrl)
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

  const nutKeys = nuts ? Object.keys(nuts) : []

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

        {/* Long Description */}
        {descriptionLong && (
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
            {descriptionLong}
          </p>
        )}

        {/* Mint Message (MOTD) */}
        {motd && (
          <div>
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
              Mint Message
            </h3>
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50">
              <p className="text-sm text-amber-800 dark:text-amber-300">{motd}</p>
            </div>
          </div>
        )}

        {/* Version + Currency */}
        {(version || supportedUnits.length > 0) && (
          <div className="grid grid-cols-2 gap-3">
            {version && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-700/30">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                  Version
                </div>
                <div className="text-sm font-mono text-slate-900 dark:text-white break-all">
                  {version}
                </div>
              </div>
            )}
            {supportedUnits.length > 0 && (
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-700/30">
                <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
                  Currency
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {supportedUnits.map((u) => (
                    <span
                      key={u}
                      className="px-2 py-0.5 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 text-xs font-mono text-slate-900 dark:text-white uppercase"
                    >
                      {u}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Contact Info */}
        {contact.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Contact
            </h3>
            <div className="space-y-2">
              {contact.map((c) => (
                <div
                  key={`${c.method}-${c.info}`}
                  className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 dark:bg-slate-700/30"
                >
                  <ContactIcon method={c.method} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-500 dark:text-slate-400 capitalize">
                      {c.method}
                    </div>
                    <div className="text-sm font-mono text-slate-900 dark:text-white truncate">
                      {c.info}
                    </div>
                  </div>
                  <button
                    onClick={() => navigator.clipboard.writeText(c.info)}
                    className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors"
                    title="Copy"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Supported NUTs — expandable list */}
        {nutKeys.length > 0 && (
          <div>
            <button
              onClick={() => setNutsExpanded(!nutsExpanded)}
              className="flex items-center justify-between w-full group"
            >
              <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                Supported NUTs ({nutKeys.length})
              </h3>
              <ChevronDown
                className={`w-4 h-4 text-slate-400 transition-transform ${nutsExpanded ? 'rotate-180' : ''}`}
              />
            </button>
            {nutsExpanded && (
              <div className="mt-2 space-y-1">
                {nutKeys.map((nut) => (
                  <div
                    key={nut}
                    className="flex items-baseline gap-2 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-700/30"
                  >
                    <span className="text-xs font-mono text-slate-400 dark:text-slate-500 shrink-0">
                      {nut}:
                    </span>
                    <span className="text-sm text-slate-700 dark:text-slate-300">
                      {NUT_NAMES[nut] ?? `NUT-${nut}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
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

function ContactIcon({ method }: { method: string }) {
  if (method === 'email') {
    return <Mail className="w-4 h-4 text-slate-400 shrink-0" />
  }
  return <AtSign className="w-4 h-4 text-slate-400 shrink-0" />
}
