// =============================================================================
// Deposit / Withdraw Types
// =============================================================================

export type DepositWithdrawMode = 'deposit' | 'withdraw'

export type MethodType = 'ecash' | 'lightning'

/**
 * Current view within the deposit/withdraw flow.
 * - 'chooser'           — bottom sheet with Ecash / Lightning options
 * - 'deposit-ecash'     — Deposit Ecash actions (Paste, Scan, Request)
 * - 'deposit-lightning'  — Deposit Lightning amount entry + CREATE INVOICE
 * - 'send-ecash'        — Send Ecash amount entry + SEND
 * - 'pay-lightning'     — Pay Lightning invoice/address entry
 */
export type DepositWithdrawView =
  | 'chooser'
  | 'deposit-ecash'
  | 'deposit-lightning'
  | 'send-ecash'
  | 'pay-lightning'

// =============================================================================
// Mint Types
// =============================================================================

export interface MintInfo {
  id: string
  name: string
  url: string
  balanceSats: number
}

// =============================================================================
// Component Props
// =============================================================================

export interface DepositWithdrawProps {
  /** Whether this was opened from Deposit or Withdraw button */
  mode: DepositWithdrawMode

  /** Current view in the flow */
  currentView: DepositWithdrawView

  /** Available mints to select from */
  mints: MintInfo[]

  /** Currently selected mint ID */
  selectedMintId: string

  /** Current amount entered (in sats) */
  amountSats: number

  /** Fiat equivalent of the entered amount */
  amountFiat: string

  /** Fiat currency symbol (e.g., "$", "\u00a5") */
  fiatSymbol: string

  /** Whether to show fiat or sats as the primary display */
  showFiatPrimary: boolean

  /** Lightning address or invoice text entered by user */
  lightningInput: string

  /** Called when user selects a method (ecash or lightning) from the chooser */
  onSelectMethod?: (method: MethodType) => void

  /** Called when user taps a numpad key */
  onNumpadPress?: (key: string) => void

  /** Called when user changes the selected mint */
  onMintChange?: (mintId: string) => void

  /** Called when user toggles between fiat and sats display */
  onToggleCurrency?: () => void

  /** Called when user taps "CREATE INVOICE" (deposit lightning) */
  onCreateInvoice?: () => void

  /** Called when user taps "SEND" (send ecash) */
  onSendEcash?: () => void

  /** Called when user taps "Paste" (deposit ecash or pay lightning) */
  onPaste?: () => void

  /** Called when user taps "Scan" (deposit ecash) */
  onScan?: () => void

  /** Called when user taps "Request" (deposit ecash) */
  onRequest?: () => void

  /** Called when user taps "Scan QR Code" (pay lightning) */
  onScanQR?: () => void

  /** Called when lightning input text changes */
  onLightningInputChange?: (value: string) => void

  /** Called when user navigates back within the flow */
  onBack?: () => void

  /** Called when user closes the entire modal */
  onClose?: () => void

  /** Called when user taps fullscreen toggle */
  onToggleFullscreen?: () => void
}
