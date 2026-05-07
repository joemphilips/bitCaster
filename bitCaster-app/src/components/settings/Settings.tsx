import { useState } from 'react'
import type {
  SettingsProps,
  SettingsCategory,
  ThemeOption,
  MintConfig,
  RelayConnectionStatus,
} from '@/types/settings'
import {
  Trash2,
  Plus,
  Eye,
  EyeOff,
  Copy,
  Check,
  Shield,
  ExternalLink,
  ChevronDown,
  Settings2,
  Landmark,
  Radio,
  Loader2,
  UserCircle,
  BadgeCheck,
  Plug,
  KeyRound,
  AlertTriangle,
} from 'lucide-react'
import { useToastStore } from '@/stores/toast'
import { isNip07Available, fetchAndStoreNostrProfile } from '@/lib/nostr'
import { getRelayUrlValidationError } from '@/lib/walletOps'
import { safeHostname } from '@/lib/url'
import { AddMintForm } from '@/components/shared/AddMintForm'

//─── Segmented Control ──────────────────────────────────────────────────────

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange?: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-700/50 p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            value === opt.value
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Status Dot ─────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: MintConfig['connectionStatus'] | RelayConnectionStatus }) {
  const colors = {
    connected: 'bg-green-500',
    disconnected: 'bg-slate-400',
    error: 'bg-red-500',
  }
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colors[status]}`}
      title={status}
    />
  )
}

// ─── Collapsible Category Card ──────────────────────────────────────────────

function CategoryCard({
  icon: Icon,
  label,
  category,
  activeCategory,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  category: Exclude<SettingsCategory, null>
  activeCategory: SettingsCategory
  onToggle?: (cat: Exclude<SettingsCategory, null>) => void
  children: React.ReactNode
}) {
  const isOpen = activeCategory === category
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <button
        onClick={() => onToggle?.(category)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
      >
        <Icon className="w-5 h-5 text-slate-500 dark:text-slate-400" />
        <span className="flex-1 text-base font-semibold text-slate-900 dark:text-white">
          {label}
        </span>
        <ChevronDown
          className={`w-5 h-5 text-slate-400 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>
      {isOpen && (
        <div className="px-5 pb-5 pt-1 border-t border-slate-100 dark:border-slate-700 space-y-6">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Main Settings Component ────────────────────────────────────────────────

export function Settings({
  activeCategory,
  settings,
  seedPhrase,
  onCategoryToggle,
  onThemeChange,
  onAddMint,
  onRemoveMint,
  onViewSeedPhrase,
  onMintClick,
  onSignerModeChange,
  onNsecSubmit,
  onDisconnectNostr,
  onAddRelay,
  onRemoveRelay,
}: SettingsProps) {
  const { general, cashu, nostr } = settings

  // Local state for UI interactions. The add-mint subform is owned by
  // AddMintForm itself so the same component can be reused from the
  // portfolio mint selector (P5.2) without duplicating spinner / error
  // state — `onAddMint` resolves only when the underlying wallet store
  // has finished mutating.
  const [showSeedConfirm, setShowSeedConfirm] = useState(false)
  const [showSeedPhrase, setShowSeedPhrase] = useState(false)
  const [copied, setCopied] = useState(false)
  const [nsecValue, setNsecValue] = useState('')
  const [showNsec, setShowNsec] = useState(false)
  const [showNsecInput, setShowNsecInput] = useState(false)
  const [ncryptsecPassphrase, setNcryptsecPassphrase] = useState('')
  const [showAddRelay, setShowAddRelay] = useState(false)
  const [newRelayUrl, setNewRelayUrl] = useState('')
  const [isConnectingNip07, setIsConnectingNip07] = useState(false)
  const [isConnectingNsec, setIsConnectingNsec] = useState(false)
  const [isRetryingProfile, setIsRetryingProfile] = useState(false)

  /**
   * Manual retry for the Nostr profile fetch. Even after the persist-
   * hydration fix in `App.tsx`, a pubkey may have no kind:0 yet on the
   * connected relays, or the relays themselves may have been added after
   * the initial rehydrate. The button gives the user an explicit way to
   * trigger another fetch without a full reload.
   */
  const handleRetryProfile = async () => {
    setIsRetryingProfile(true)
    try {
      await fetchAndStoreNostrProfile()
    } finally {
      setIsRetryingProfile(false)
    }
  }

  const displaySeedPhrase = seedPhrase ?? ''

  const handleCopySeed = () => {
    navigator.clipboard.writeText(displaySeedPhrase)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const trimmedNsec = nsecValue.trim()
  const isNcryptsec = trimmedNsec.startsWith('ncryptsec1')
  const relayError = getRelayUrlValidationError(newRelayUrl)

  const handleNsecSubmit = async () => {
    if (!trimmedNsec) return
    if (isNcryptsec && !ncryptsecPassphrase) return
    setIsConnectingNsec(true)
    try {
      const success = await onNsecSubmit?.(
        trimmedNsec,
        isNcryptsec ? ncryptsecPassphrase : undefined,
      )
      if (success) {
        setNsecValue('')
        setNcryptsecPassphrase('')
        setShowNsecInput(false)
      }
    } finally {
      setIsConnectingNsec(false)
    }
  }

  const handleNip07Connect = async () => {
    if (!isNip07Available()) {
      useToastStore.getState().addToast({
        type: 'error',
        message: 'You need to install a Nostr extension like Alby. Visit https://getalby.com',
      })
      return
    }
    setIsConnectingNip07(true)
    try {
      const success = await onSignerModeChange?.('nip07')
      if (success) {
        useToastStore.getState().addToast({
          type: 'success',
          message: 'Connected via NIP-07 extension',
        })
      }
    } finally {
      setIsConnectingNip07(false)
    }
  }

  const handleAddRelay = () => {
    const trimmed = newRelayUrl.trim()
    if (!trimmed || relayError) return
    onAddRelay?.(trimmed)
    setNewRelayUrl('')
    setShowAddRelay(false)
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
        Settings
      </h1>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* 1. General Settings                                                */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <CategoryCard
        icon={Settings2}
        label="General Settings"
        category="general"
        activeCategory={activeCategory}
        onToggle={onCategoryToggle}
      >
        {/* Theme */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Theme
          </h3>
          <SegmentedControl<ThemeOption>
            options={[
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
              { label: 'System', value: 'system' },
            ]}
            value={general.theme}
            onChange={onThemeChange}
          />
        </div>

        {/* About */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            About
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600 dark:text-slate-400">Version</span>
              <span className="text-sm font-mono text-slate-900 dark:text-white">
                {general.appVersion}
              </span>
            </div>
            <div className="border-t border-slate-100 dark:border-slate-700" />
            {[
              { label: 'Source Code', href: 'https://github.com/joemphilips/bitCaster' },
              { label: 'Documentation', href: 'https://bitcasterdoc.com' },
              { label: 'Support', href: 'https://github.com/joemphilips/bitCaster/issues' },
            ].map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between py-1 group"
              >
                <span className="text-sm text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">
                  {link.label}
                </span>
                <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-blue-500 transition-colors" />
              </a>
            ))}
          </div>
        </div>
      </CategoryCard>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* 2. Cashu Settings                                                  */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <CategoryCard
        icon={Landmark}
        label="Cashu Settings"
        category="cashu"
        activeCategory={activeCategory}
        onToggle={onCategoryToggle}
      >
        {/* Connected Mints */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            Connected Mints
          </h3>
          <div className="space-y-3">
            {cashu.mints.map((mint) => (
              <div
                key={mint.url}
                className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors"
                onClick={() => onMintClick?.(mint.url)}
              >
                <StatusDot status={mint.connectionStatus} />
                {/* Mint thumbnail or initials */}
                <div className="w-8 h-8 rounded-full bg-white dark:bg-slate-600 flex items-center justify-center flex-shrink-0 border border-slate-200 dark:border-slate-500">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                    {(mint.name ?? safeHostname(mint.url)).slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {mint.name ?? safeHostname(mint.url)}
                    </span>
                    {!mint.supportsCTF && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-600 text-slate-500 dark:text-slate-300">
                        Ecash only
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-slate-500 dark:text-slate-400 truncate">
                    {mint.url}
                  </div>
                </div>
                {mint.isDefault && (
                  <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-xs font-semibold">
                    Default
                  </span>
                )}
                {!mint.isDefault && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveMint?.(mint.url) }}
                    className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    title="Remove mint"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3">
            <AddMintForm
              onAddMint={async (url) => {
                if (!onAddMint) return
                await onAddMint(url)
              }}
              triggerLabel="Add Mint"
            />
          </div>
        </div>

        {/* Seed Backup */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Seed Backup
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
            Back up your wallet seed phrase. Anyone with this phrase can access your funds.
          </p>
          <button
            onClick={() => setShowSeedConfirm(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-900 dark:text-white text-sm font-medium transition-colors border border-slate-200 dark:border-slate-600"
          >
            <Eye className="w-4 h-4" />
            View Seed Phrase
          </button>
        </div>
      </CategoryCard>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* 3. Nostr Settings                                                  */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <CategoryCard
        icon={Radio}
        label="Nostr Settings"
        category="nostr"
        activeCategory={activeCategory}
        onToggle={onCategoryToggle}
      >
        {/* Nostr Connection — only show connect buttons if not already connected */}
        {nostr.signerMode === 'none' && (
          <div>
            <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Connect to Nostr
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
              Choose how to authenticate with Nostr.
            </p>
            <div className="space-y-3">
              <button
                onClick={handleNip07Connect}
                disabled={isConnectingNip07}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/50 text-slate-900 dark:text-white text-sm font-medium transition-colors border border-slate-200 dark:border-slate-600 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isConnectingNip07 ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plug className="w-4 h-4" />
                )}
                Connect with NIP-07 Extension
              </button>
              <button
                onClick={() => setShowNsecInput(!showNsecInput)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/50 text-slate-900 dark:text-white text-sm font-medium transition-colors border border-slate-200 dark:border-slate-600"
              >
                <KeyRound className="w-4 h-4" />
                Connect with Private Key
              </button>
            </div>
          </div>
        )}

        {/* nsec Input (when user clicks Connect with Private Key) */}
        {showNsecInput && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800 dark:text-amber-300">
                <span className="font-semibold">WARNING:</span> Pasting nsec is dangerous. This is necessary for now if you want to become an oracle. It is left for future improvement to make this not mandatory.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                Private Key (nsec or ncryptsec)
              </h3>
              <div className="relative">
                <input
                  type={showNsec ? 'text' : 'password'}
                  value={nsecValue}
                  onChange={(e) => {
                    const v = e.target.value
                    setNsecValue(v)
                    if (!v.trim().startsWith('ncryptsec1')) setNcryptsecPassphrase('')
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleNsecSubmit()}
                  placeholder="nsec1... or ncryptsec1..."
                  className="w-full px-3 py-2 pr-10 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 text-sm font-mono text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <button
                  onClick={() => setShowNsec(!showNsec)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  {showNsec ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {isNcryptsec && (
                <div className="mt-3">
                  <label className="block text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    Passphrase
                  </label>
                  <input
                    type="password"
                    value={ncryptsecPassphrase}
                    onChange={(e) => setNcryptsecPassphrase(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleNsecSubmit()}
                    placeholder="Decrypt passphrase (NIP-49)"
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
              <button
                onClick={handleNsecSubmit}
                disabled={isConnectingNsec || !trimmedNsec || (isNcryptsec && !ncryptsecPassphrase)}
                className="mt-3 w-full px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isConnectingNsec && <Loader2 className="w-4 h-4 animate-spin" />}
                {isNcryptsec ? 'Decrypt & Connect' : 'Connect'}
              </button>
            </div>
          </div>
        )}

        {/* Profile Preview */}
        {nostr.signerMode !== 'none' && (
          <div>
            <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
              Profile
            </h3>
            {nostr.profileFetchStatus === 'fetching' && !nostr.profile && (
              <div className="flex items-center gap-2 p-4 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700">
                <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                <span className="text-sm text-slate-500 dark:text-slate-400">Fetching profile...</span>
              </div>
            )}
            {nostr.profileFetchStatus === 'not-found' && (
              <div className="flex items-center justify-between gap-2 p-4 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700">
                <div className="flex items-center gap-2 min-w-0">
                  <UserCircle className="w-5 h-5 text-slate-400 shrink-0" />
                  <span className="text-sm text-slate-500 dark:text-slate-400 truncate">Profile not found on connected relays</span>
                </div>
                <button
                  onClick={handleRetryProfile}
                  disabled={isRetryingProfile}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors disabled:opacity-60 shrink-0"
                >
                  {isRetryingProfile && <Loader2 className="w-4 h-4 animate-spin" />}
                  Retry
                </button>
              </div>
            )}
            {nostr.profile && (
              <div className="flex items-start gap-4 p-4 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700">
                <img
                  src={nostr.profile.avatar}
                  alt={nostr.profile.displayName}
                  className="w-12 h-12 rounded-full bg-slate-200 dark:bg-slate-600 object-cover"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {nostr.profile.displayName}
                    </span>
                    {nostr.profileFetchStatus === 'fetching' && (
                      <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                    )}
                    {nostr.profile.nip05verified && (
                      <BadgeCheck className="w-4 h-4 text-blue-500" />
                    )}
                  </div>
                  {nostr.profile.nip05 && (
                    <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
                      {nostr.profile.nip05}
                    </p>
                  )}
                  {nostr.profile.bio && (
                    <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 line-clamp-2">
                      {nostr.profile.bio}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="mt-3 flex items-center gap-3">
              {nostr.signerMode === 'nip07' && (
                <button
                  onClick={handleNip07Connect}
                  disabled={isConnectingNip07}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors disabled:opacity-60"
                >
                  {isConnectingNip07 ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plug className="w-4 h-4" />
                  )}
                  Re-authenticate
                </button>
              )}
              <button
                onClick={() => onDisconnectNostr?.()}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 text-sm font-medium transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {/* Relay Management */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">
            Relays
          </h3>
          <div className="space-y-3">
            {nostr.relays.map((relay) => (
              <div
                key={relay.url}
                className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700"
              >
                <StatusDot status={relay.connectionStatus} />
                <span className="font-mono text-sm text-slate-700 dark:text-slate-300 truncate flex-1">
                  {relay.url}
                </span>
                <button
                  onClick={() => onRemoveRelay?.(relay.url)}
                  className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  title="Remove relay"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          {showAddRelay ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="url"
                value={newRelayUrl}
                onChange={(e) => setNewRelayUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddRelay()}
                placeholder="wss://relay.example.com"
                className="flex-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 text-sm font-mono text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <button
                onClick={handleAddRelay}
                disabled={!newRelayUrl.trim() || !!relayError}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
              >
                Add
              </button>
              <button
                onClick={() => { setShowAddRelay(false); setNewRelayUrl('') }}
                className="px-3 py-2 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 text-sm transition-colors"
              >
                Cancel
              </button>
              {relayError && (
                <div className="basis-full text-xs text-red-500 dark:text-red-400">
                  {relayError}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowAddRelay(true)}
              className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Relay
            </button>
          )}
        </div>
      </CategoryCard>

      {/* ── Seed Phrase Confirmation Modal ──────────────────────────────── */}
      {showSeedConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <Shield className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                Security Warning
              </h3>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              Your seed phrase is the master key to your wallet. Never share it
              with anyone. Make sure no one is looking at your screen before
              proceeding.
            </p>

            {!showSeedPhrase ? (
              <div className="flex gap-3">
                <button
                  onClick={() => setShowSeedConfirm(false)}
                  className="flex-1 py-2.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 text-sm font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowSeedPhrase(true)
                    onViewSeedPhrase?.()
                  }}
                  className="flex-1 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
                >
                  I Understand, Show Phrase
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 mb-4">
                  {displaySeedPhrase.split(' ').map((word, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600"
                    >
                      <span className="text-xs text-slate-400 dark:text-slate-500 w-4 text-right">
                        {i + 1}
                      </span>
                      <span className="font-mono text-sm text-slate-900 dark:text-white">
                        {word}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleCopySeed}
                    className="flex items-center justify-center gap-2 flex-1 py-2.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 text-sm font-medium transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4 text-green-500" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4" />
                        Copy to Clipboard
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setShowSeedConfirm(false)
                      setShowSeedPhrase(false)
                      setCopied(false)
                    }}
                    className="flex-1 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
