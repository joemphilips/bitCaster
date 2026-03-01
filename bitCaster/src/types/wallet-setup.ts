// =============================================================================
// Setup Flow Types
// =============================================================================

export type SetupChoice = 'create' | 'recover'
export type SetupStep = 1 | 2 | 3 | 4 | 5

// =============================================================================
// Mint Connection Types
// =============================================================================

export type MintConnectionTestStatus = 'idle' | 'connecting' | 'connected' | 'failed'

export interface MintConnectionTest {
  url: string
  status: MintConnectionTestStatus
  errorMessage?: string
}

// =============================================================================
// Background Data Loading Types
// =============================================================================

export type DataLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed'

export interface BackgroundDataLoad {
  mintUrl: string
  status: DataLoadStatus
  conditionsLoaded: number
  errorMessage?: string
}

// =============================================================================
// Component Props
// =============================================================================

export interface WalletSetupProps {
  /** Current step in the setup flow (1=Welcome, 2=PWA, 3=Choice, 4=Seed, 5=Mint) */
  currentStep: SetupStep

  /** Whether the Terms of Service popup is visible */
  showTerms: boolean

  /** User's choice: create new or recover existing */
  choice: SetupChoice | null

  /** Generated seed words (for create flow) */
  seedWords: string[]

  /** User-entered seed words (for recover flow) */
  inputSeedWords: string[]

  /** Whether user has confirmed saving their seed phrase */
  seedSaved: boolean

  /** Mint connection tests */
  mintConnections: MintConnectionTest[]

  /** Background data loading state */
  backgroundDataLoad?: BackgroundDataLoad

  /** Called when user clicks Next on the welcome landing */
  onWelcomeNext?: () => void

  /** Called when user clicks Terms of Service link */
  onShowTerms?: () => void

  /** Called when user closes the Terms of Service popup */
  onCloseTerms?: () => void

  /** Called when user clicks Next on the PWA confirmation step */
  onPwaNext?: () => void

  /** Called when user selects create or recover */
  onChoiceSelect?: (choice: SetupChoice) => void

  /** Called when user checks "I have saved my seed phrase" */
  onSeedSavedToggle?: (saved: boolean) => void

  /** Called when user enters a seed word in recover flow */
  onSeedWordInput?: (index: number, word: string) => void

  /** Called when user pastes a full seed phrase */
  onSeedPhrasePaste?: (phrase: string) => void

  /** Called when user clicks Recover */
  onRecover?: () => void

  /** Called when user adds a mint URL */
  onAddMint?: (url: string) => void

  /** Called when user removes a mint */
  onRemoveMint?: (url: string) => void

  /** Called when user clicks Continue (step 4 → step 5) */
  onContinue?: () => void

  /** Called when user clicks Back */
  onBack?: () => void

  /** Called when user clicks Finish Setup */
  onFinishSetup?: () => void
}
