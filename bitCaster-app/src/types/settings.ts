// =============================================================================
// Settings Category
// =============================================================================

export type SettingsCategory = 'general' | 'cashu' | 'nostr' | null

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
  name?: string
  iconUrl?: string
  isDefault: boolean
  connectionStatus: MintConnectionStatus
  supportsCTF: boolean
  addedDate: string
}

export interface CashuSettings {
  mints: MintConfig[]
}

// =============================================================================
// Nostr Settings Types
// =============================================================================

export type NostrSignerMode = 'none' | 'nip07' | 'nsec'
export type NostrSignerSource = 'none' | 'implicit-generated' | 'user-nsec' | 'nip07'
export type SecretBackupState = 'none' | 'needs_backup' | 'confirmed'
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
  signerSource: NostrSignerSource
  signerBackupState: SecretBackupState
  canRevealGeneratedNsec: boolean
  profile: NostrProfile | null
  profileFetchStatus: NostrProfileFetchStatus
  relays: RelayConfig[]
}

// =============================================================================
// Combined Settings State
// =============================================================================

export interface SettingsState {
  general: GeneralSettings
  cashu: CashuSettings
  nostr: NostrSettings
}

// =============================================================================
// Component Props
// =============================================================================

export interface SettingsProps {
  /** Which category group is currently expanded */
  activeCategory: SettingsCategory

  /** All settings state */
  settings: SettingsState

  /** Wallet seed phrase (mnemonic) to display in the seed backup section */
  seedPhrase?: string

  walletBackupState?: SecretBackupState
  generatedNsecSecret?: string | null

  /** Called when user toggles a category group */
  onCategoryToggle?: (category: SettingsCategory) => void

  // General callbacks
  onThemeChange?: (theme: ThemeOption) => void

  // Cashu callbacks
  onAddMint?: (url: string) => Promise<void>
  onRemoveMint?: (url: string) => void
  onViewSeedPhrase?: () => void
  onMintClick?: (url: string) => void

  // Nostr callbacks
  onSignerModeChange?: (mode: NostrSignerMode) => Promise<boolean>
  onNsecSubmit?: (nsec: string, passphrase?: string) => Promise<boolean>
  onRevealGeneratedNsec?: () => void
  onConfirmSignerBackup?: () => void
  onConfirmWalletBackup?: () => void
  onDisconnectNostr?: () => void
  onRetryNostrProfile?: () => Promise<void>
  onAddRelay?: (url: string) => void
  onRemoveRelay?: (url: string) => void
}
