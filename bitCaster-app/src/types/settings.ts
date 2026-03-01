// =============================================================================
// Settings Category
// =============================================================================

export type SettingsCategory = 'general' | 'cashu' | 'nostr' | 'oracle'

// =============================================================================
// General Settings Types
// =============================================================================

export type BaseCurrency = 'BTC' | 'USD' | 'JPY'
export type ThemeOption = 'light' | 'dark' | 'system'
export type LanguageCode = 'en' | 'ja'

export interface GeneralSettings {
  baseCurrency: BaseCurrency
  language: LanguageCode
  theme: ThemeOption
  appVersion: string
}

// =============================================================================
// Cashu Settings Types
// =============================================================================

export type MintConnectionStatus = 'connected' | 'disconnected' | 'error'

export interface MintConfig {
  url: string
  isDefault: boolean
  connectionStatus: MintConnectionStatus
  addedDate: string
}

export interface CashuSettings {
  mints: MintConfig[]
}

// =============================================================================
// Nostr Settings Types
// =============================================================================

export type NostrSignerMode = 'none' | 'nip07' | 'nsec'
export type NostrProfileFetchStatus = 'idle' | 'fetching' | 'found' | 'not-found'
export type RelayConnectionStatus = 'connected' | 'disconnected'

export interface NostrProfile {
  pubkey: string
  displayName: string
  avatar: string
  nip05: string
  nip05verified: boolean
  bio: string
}

export interface RelayConfig {
  url: string
  connectionStatus: RelayConnectionStatus
}

export interface NostrSettings {
  signerMode: NostrSignerMode
  profile: NostrProfile | null
  profileFetchStatus: NostrProfileFetchStatus
  relays: RelayConfig[]
}

// =============================================================================
// Oracle Settings Types
// =============================================================================

export interface OracleSettings {
  comingSoon: true
}

// =============================================================================
// Combined Settings State
// =============================================================================

export interface SettingsState {
  general: GeneralSettings
  cashu: CashuSettings
  nostr: NostrSettings
  oracle: OracleSettings
}

// =============================================================================
// Component Props
// =============================================================================

export interface SettingsProps {
  /** Which category group is currently expanded */
  activeCategory: SettingsCategory

  /** All settings state */
  settings: SettingsState

  /** Called when user toggles a category group */
  onCategoryToggle?: (category: SettingsCategory) => void

  // General callbacks
  onBaseCurrencyChange?: (currency: BaseCurrency) => void
  onLanguageChange?: (language: LanguageCode) => void
  onThemeChange?: (theme: ThemeOption) => void

  // Cashu callbacks
  onAddMint?: (url: string) => void
  onRemoveMint?: (url: string) => void
  onViewSeedPhrase?: () => void

  // Nostr callbacks
  onSignerModeChange?: (mode: NostrSignerMode) => void
  onNsecSubmit?: (nsec: string) => void
  onAddRelay?: (url: string) => void
  onRemoveRelay?: (url: string) => void
}
