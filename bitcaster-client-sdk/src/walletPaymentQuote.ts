/** Exact wire view used to approve one wallet BOLT11 payment. */
export interface WalletPaymentQuote {
  readonly operationId: string
  readonly walletId: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly method: 'bolt11'
  readonly invoice: string
  readonly quoteId: string
  readonly amountMsat: number
  readonly feeReserveMsat: number
  readonly selectedInputFeeMsat: number
  readonly totalWalletDebitMsat: number
  readonly expiryUnixSeconds: number
  readonly state: 'UNPAID'
}

const WALLET_PAYMENT_QUOTE_KEYS = [
  'operationId',
  'walletId',
  'mintUrl',
  'unit',
  'method',
  'invoice',
  'quoteId',
  'amountMsat',
  'feeReserveMsat',
  'selectedInputFeeMsat',
  'totalWalletDebitMsat',
  'expiryUnixSeconds',
  'state',
].sort()

/** Validate the exact quote envelope before a CLI or RPC boundary trusts its fee cap. */
export function isWalletPaymentQuote(value: unknown): value is WalletPaymentQuote {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (
    keys.length !== WALLET_PAYMENT_QUOTE_KEYS.length ||
    keys.some((key, index) => key !== WALLET_PAYMENT_QUOTE_KEYS[index]) ||
    !isWalletPaymentOperationId(value.operationId) ||
    typeof value.walletId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.walletId) ||
    typeof value.mintUrl !== 'string' ||
    value.mintUrl.length === 0 ||
    value.mintUrl.length > 2_048 ||
    value.unit !== 'msat' ||
    value.method !== 'bolt11' ||
    typeof value.invoice !== 'string' ||
    value.invoice.length === 0 ||
    value.invoice.length > 10_000 ||
    value.invoice.trim() !== value.invoice ||
    typeof value.quoteId !== 'string' ||
    value.quoteId.length === 0 ||
    value.quoteId.length > 2_048 ||
    !isPositiveSafeInteger(value.amountMsat) ||
    !isNonNegativeSafeInteger(value.feeReserveMsat) ||
    !isNonNegativeSafeInteger(value.selectedInputFeeMsat) ||
    !isPositiveSafeInteger(value.totalWalletDebitMsat) ||
    !isPositiveSafeInteger(value.expiryUnixSeconds) ||
    value.state !== 'UNPAID'
  ) {
    return false
  }

  const total = value.amountMsat + value.feeReserveMsat + value.selectedInputFeeMsat
  return Number.isSafeInteger(total) && total === value.totalWalletDebitMsat
}

export function isWalletPaymentOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^wallet-melt:[0-9a-f]{64}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
