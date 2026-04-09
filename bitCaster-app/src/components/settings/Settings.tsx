import { useState } from 'react'
import type {
  SettingsProps,
  SettingsCategory,
  BaseCurrency,
  ThemeOption,
  LanguageCode,
  MintConfig,
  NostrSignerMode,
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
} from 'lucide-react'

// ─── Segmented Control ──────────────────────────────────────────────────────

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
  category: SettingsCategory
  activeCategory: SettingsCategory
  onToggle?: (cat: SettingsCategory) => void
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
  onBaseCurrencyChange,
  onLanguageChange,
  onThemeChange,
  onAddMint,
  onRemoveMint,
  onViewSeedPhrase,
  onSignerModeChange,
  onNsecSubmit,
  onAddRelay,
  onRemoveRelay,
}: SettingsProps) {
  const { general, cashu, nostr } = settings

  // Local state for UI interactions
  const [showAddMint, setShowAddMint] = useState(false)
  const [newMintUrl, setNewMintUrl] = useState('')
  const [showSeedConfirm, setShowSeedConfirm] = useState(false)
  const [showSeedPhrase, setShowSeedPhrase] = useState(false)
  const [copied, setCopied] = useState(false)
  const [nsecValue, setNsecValue] = useState('')
  const [showNsec, setShowNsec] = useState(false)
  const [showAddRelay, setShowAddRelay] = useState(false)
  const [newRelayUrl, setNewRelayUrl] = useState('')

  const displaySeedPhrase = seedPhrase ?? ''

  const handleAddMint = () => {
    if (newMintUrl.trim()) {
      onAddMint?.(newMintUrl.trim())
      setNewMintUrl('')
      setShowAddMint(false)
    }
  }

  const handleCopySeed = () => {
    navigator.clipboard.writeText(displaySeedPhrase)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleNsecSubmit = () => {
    if (nsecValue.trim()) {
      onNsecSubmit?.(nsecValue.trim())
      setNsecValue('')
    }
  }

  const handleAddRelay = () => {
    if (newRelayUrl.trim()) {
      onAddRelay?.(newRelayUrl.trim())
      setNewRelayUrl('')
      setShowAddRelay(false)
    }
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
        {/* Base Currency */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Base Currency
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
            Choose how amounts are displayed throughout the app.
          </p>
          <SegmentedControl<BaseCurrency>
            options={[
              { label: 'BTC', value: 'BTC' },
              { label: 'USD', value: 'USD' },
              { label: 'JPY', value: 'JPY' },
            ]}
            value={general.baseCurrency}
            onChange={onBaseCurrencyChange}
          />
        </div>

        {/* Language */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Language
          </h3>
          <SegmentedControl<LanguageCode>
            options={[
              { label: 'English', value: 'en' },
              { label: 'Japanese', value: 'ja' },
            ]}
            value={general.language}
            onChange={onLanguageChange}
          />
        </div>

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
              { label: 'Documentation', href: 'https://github.com/joemphilips/bitCaster/wiki' },
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
                className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700"
              >
                <StatusDot status={mint.connectionStatus} />
                <span className="font-mono text-sm text-slate-700 dark:text-slate-300 truncate flex-1">
                  {mint.url}
                </span>
                {mint.isDefault && (
                  <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 text-xs font-semibold">
                    Default
                  </span>
                )}
                {!mint.isDefault && (
                  <button
                    onClick={() => onRemoveMint?.(mint.url)}
                    className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    title="Remove mint"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {showAddMint ? (
            <div className="mt-3 flex gap-2">
              <input
                type="url"
                value={newMintUrl}
                onChange={(e) => setNewMintUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddMint()}
                placeholder="https://mint.example.com"
                className="flex-1 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 text-sm font-mono text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <button
                onClick={handleAddMint}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
              >
                Add
              </button>
              <button
                onClick={() => { setShowAddMint(false); setNewMintUrl('') }}
                className="px-3 py-2 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddMint(true)}
              className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Mint
            </button>
          )}
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
        {/* Signer Mode */}
        <div>
          <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
            Signer Mode
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
            Choose how to authenticate with Nostr.
          </p>
          <SegmentedControl<NostrSignerMode>
            options={[
              { label: 'None', value: 'none' },
              { label: 'NIP-07 Extension', value: 'nip07' },
              { label: 'Private Key', value: 'nsec' },
            ]}
            value={nostr.signerMode}
            onChange={onSignerModeChange}
          />
        </div>

        {/* nsec Input (only when mode is nsec) */}
        {nostr.signerMode === 'nsec' && (
          <div>
            <h3 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
              Private Key (nsec)
            </h3>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showNsec ? 'text' : 'password'}
                  value={nsecValue}
                  onChange={(e) => setNsecValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleNsecSubmit()}
                  placeholder="nsec1..."
                  className="w-full px-3 py-2 pr-10 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 text-sm font-mono text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => setShowNsec(!showNsec)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  {showNsec ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <button
                onClick={handleNsecSubmit}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
              >
                Connect
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
            {nostr.profileFetchStatus === 'fetching' && (
              <div className="flex items-center gap-2 p-4 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700">
                <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                <span className="text-sm text-slate-500 dark:text-slate-400">Fetching profile...</span>
              </div>
            )}
            {nostr.profileFetchStatus === 'not-found' && (
              <div className="flex items-center gap-2 p-4 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-100 dark:border-slate-700">
                <UserCircle className="w-5 h-5 text-slate-400" />
                <span className="text-sm text-slate-500 dark:text-slate-400">Profile not found on connected relays</span>
              </div>
            )}
            {nostr.profileFetchStatus === 'found' && nostr.profile && (
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
            <div className="mt-3 flex gap-2">
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
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
              >
                Add
              </button>
              <button
                onClick={() => { setShowAddRelay(false); setNewRelayUrl('') }}
                className="px-3 py-2 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 text-sm transition-colors"
              >
                Cancel
              </button>
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
