import { isMintOperationError } from '@cashu/cashu-ts'
import type { CashuProofUnit } from './marketUnits.ts'

/**
 * A deposit mints ecash for a payment (NUT-04). A withdrawal melts ecash to
 * pay (NUT-05). Each direction has its own mint settings.
 */
export type MintPaymentDirection = 'deposit' | 'withdrawal'
export type MintPaymentMethod = 'bolt11'

export interface MintPaymentSelection {
  readonly direction: MintPaymentDirection
  readonly method: MintPaymentMethod
  readonly unit: CashuProofUnit
}

/**
 * Limits for one payment, in whole sats. A null bound means that the mint
 * advertises no bound, so the client sets none.
 */
export type MintPaymentLimits =
  | { readonly state: 'enabled'; readonly minSat: number | null; readonly maxSat: number | null }
  | { readonly state: 'disabled' }
  | { readonly state: 'unsupported' }

export type MintPaymentAmountCheck =
  | { readonly kind: 'within-limits' }
  | { readonly kind: 'below-minimum'; readonly minSat: number; readonly maxSat: number | null }
  | { readonly kind: 'above-maximum'; readonly minSat: number | null; readonly maxSat: number }
  | { readonly kind: 'not-accepted' }

/** Why one amount cannot be requested. `refused` is a mint refusal that the limits do not explain. */
export type MintPaymentAmountRejection =
  | Exclude<MintPaymentAmountCheck, { readonly kind: 'within-limits' }>
  | { readonly kind: 'refused' }

/** NUT error code "Amount outside of limit range" for NUT-04 and NUT-05 quote requests. */
export const MINT_AMOUNT_OUTSIDE_LIMIT_ERROR_CODE = 11006

const MSAT_PER_SAT = 1_000n
const MAX_SAFE_MSAT = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Read the limits for one payment method and unit from a NUT-06 mint info
 * response. Throws when the settings are malformed; a caller then sets no
 * client bound and lets the mint enforce its limits.
 */
export function parseMintPaymentLimits(
  info: unknown,
  selection: MintPaymentSelection,
): MintPaymentLimits {
  const label = sectionLabel(selection.direction)
  const nuts = requireRecord(requireRecord(info, 'mint info').nuts, 'mint info nuts')
  const section = requireRecord(nuts[label], `mint info nuts.${label}`)
  if (typeof section.disabled !== 'boolean') {
    throw new Error(`mint info nuts.${label}.disabled is not a boolean`)
  }
  if (section.disabled) return { state: 'disabled' }
  if (!Array.isArray(section.methods)) {
    throw new Error(`mint info nuts.${label}.methods is not an array`)
  }
  const settings = section.methods.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.method === selection.method && entry.unit === selection.unit,
  )
  if (settings.length === 0) return { state: 'unsupported' }
  if (settings.length > 1) {
    throw new Error(`mint info nuts.${label} repeats ${selection.method} ${selection.unit}`)
  }
  const setting = settings[0]!
  const minimum = parseLimit(setting.min_amount, `nuts.${label} min_amount`)
  const maximum = parseLimit(setting.max_amount, `nuts.${label} max_amount`)
  const minSat = minimum === null ? null : minimumSats(minimum, selection.unit)
  const maxSat = maximum === null ? null : maximumSats(maximum, selection.unit)
  if (minSat !== null && maxSat !== null && minSat > maxSat) {
    throw new Error(`mint info nuts.${label} limits contain no whole-sat amount`)
  }
  return { state: 'enabled', minSat: minSat === 0 ? null : minSat, maxSat }
}

/** Check one positive msat amount against the limits. */
export function checkMintPaymentAmount(
  limits: MintPaymentLimits,
  amountMsat: number,
): MintPaymentAmountCheck {
  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('mint payment amount must be a positive safe msat integer')
  }
  switch (limits.state) {
    case 'disabled':
    case 'unsupported':
      return { kind: 'not-accepted' }
    case 'enabled': {
      const amount = BigInt(amountMsat)
      const { minSat, maxSat } = limits
      if (minSat !== null && amount < BigInt(minSat) * MSAT_PER_SAT) {
        return { kind: 'below-minimum', minSat, maxSat }
      }
      if (maxSat !== null && amount > BigInt(maxSat) * MSAT_PER_SAT) {
        return { kind: 'above-maximum', minSat, maxSat }
      }
      return { kind: 'within-limits' }
    }
    default:
      return assertNever(limits)
  }
}

/** The largest msat amount for one payment, or null when the mint sets no maximum. */
export function mintPaymentMaximumMsat(limits: MintPaymentLimits): number | null {
  switch (limits.state) {
    case 'disabled':
    case 'unsupported':
      return null
    case 'enabled':
      return limits.maxSat === null ? null : limits.maxSat * 1_000
    default:
      return assertNever(limits)
  }
}

/** True when a mint refused a quote request because its amount is outside the limits. */
export function isMintAmountOutsideLimitError(error: unknown): boolean {
  return isMintOperationError(error) && error.code === MINT_AMOUNT_OUTSIDE_LIMIT_ERROR_CODE
}

/**
 * Explain a mint refusal with limits read after the refusal. When the limits
 * or the amount are unknown, or the limits allow the amount, the refusal
 * stays unexplained.
 */
export function classifyMintAmountRefusal(
  limits: MintPaymentLimits | null,
  amountMsat: number | null,
): MintPaymentAmountRejection {
  if (limits === null || amountMsat === null) return { kind: 'refused' }
  const check = checkMintPaymentAmount(limits, amountMsat)
  return check.kind === 'within-limits' ? { kind: 'refused' } : check
}

/** English text for CLI and daemon output. The GUI uses its own translated copy. */
export function describeMintPaymentAmountRejection(
  direction: MintPaymentDirection,
  rejection: MintPaymentAmountRejection,
): string {
  const words = directionWords(direction)
  switch (rejection.kind) {
    case 'above-maximum':
      return rejection.minSat === null
        ? `This mint accepts up to ${sats(rejection.maxSat)} sats for each ${words.noun}. ${words.inParts}`
        : `This mint accepts ${sats(rejection.minSat)} to ${sats(rejection.maxSat)} sats for each ${words.noun}. ${words.inParts}`
    case 'below-minimum':
      return rejection.maxSat === null
        ? `This mint accepts at least ${sats(rejection.minSat)} sats for each ${words.noun}.`
        : `This mint accepts ${sats(rejection.minSat)} to ${sats(rejection.maxSat)} sats for each ${words.noun}.`
    case 'not-accepted':
      return `This mint does not accept Lightning ${words.noun}s.`
    case 'refused':
      return `This mint does not accept this ${words.noun} amount.`
    default:
      return assertNever(rejection)
  }
}

const MAX_BOLT11_AMOUNT_DIGITS = 20
const BOLT11_MSAT_PER_UNIT: Readonly<Record<'m' | 'u' | 'n', bigint>> = {
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
}
const BOLT11_MSAT_PER_BTC = 100_000_000_000n

/**
 * Read the msat amount from the human-readable part of a BOLT11 invoice.
 * Returns null for an amountless invoice. The checksum and signature are not
 * verified: the mint validates the invoice when it quotes the payment.
 */
export function bolt11InvoiceAmountMsat(invoice: string): number | null {
  const text = invoice.toLowerCase()
  // The bech32 data alphabet excludes '1', so the last '1' separates the HRP.
  const separator = text.lastIndexOf('1')
  if (!text.startsWith('ln') || separator < 3 || separator === text.length - 1) {
    throw new Error('Invalid BOLT11 invoice')
  }
  const match = /^ln[a-z]+?(\d*)([munp]?)$/.exec(text.slice(0, separator))
  if (match === null) throw new Error('Invalid BOLT11 invoice')
  const digits = match[1]!
  const multiplier = match[2]!
  if (digits === '') return null
  // BOLT11 forbids leading zeros, which also excludes a zero amount.
  if (digits.startsWith('0') || digits.length > MAX_BOLT11_AMOUNT_DIGITS) {
    throw new Error('Invalid BOLT11 amount')
  }
  const units = BigInt(digits)
  let amountMsat: bigint
  switch (multiplier) {
    case '':
      amountMsat = units * BOLT11_MSAT_PER_BTC
      break
    case 'p':
      // One pico-bitcoin is 0.1 msat, so BOLT11 requires a multiple of 10.
      if (units % 10n !== 0n) throw new Error('Invalid BOLT11 amount')
      amountMsat = units / 10n
      break
    case 'm':
    case 'u':
    case 'n':
      amountMsat = units * BOLT11_MSAT_PER_UNIT[multiplier]
      break
    default:
      throw new Error('Invalid BOLT11 amount')
  }
  if (amountMsat > MAX_SAFE_MSAT) throw new Error('Invalid BOLT11 amount')
  return Number(amountMsat)
}

function sectionLabel(direction: MintPaymentDirection): '4' | '5' {
  switch (direction) {
    case 'deposit':
      return '4'
    case 'withdrawal':
      return '5'
    default:
      return assertNever(direction)
  }
}

function directionWords(direction: MintPaymentDirection): {
  readonly noun: string
  readonly inParts: string
} {
  switch (direction) {
    case 'deposit':
      return { noun: 'deposit', inParts: 'Deposit in parts.' }
    case 'withdrawal':
      return { noun: 'withdrawal', inParts: 'Withdraw in parts.' }
    default:
      return assertNever(direction)
  }
}

function minimumSats(amount: bigint, unit: CashuProofUnit): number {
  switch (unit) {
    case 'sat':
      return Number(amount)
    case 'msat':
      return Number((amount + MSAT_PER_SAT - 1n) / MSAT_PER_SAT)
    default:
      return assertNever(unit)
  }
}

function maximumSats(amount: bigint, unit: CashuProofUnit): number {
  switch (unit) {
    case 'sat':
      return Number(amount)
    case 'msat':
      return Number(amount / MSAT_PER_SAT)
    default:
      return assertNever(unit)
  }
}

/** NUT-04 and NUT-05 limits are `<int|null>`; an absent limit is no limit. */
function parseLimit(value: unknown, label: string): bigint | null {
  if (value === undefined || value === null) return null
  const amount =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : null
  // A sat limit is checked in msat, so keep the converted bound safe as well.
  if (amount === null || amount < 0n || amount * MSAT_PER_SAT > MAX_SAFE_MSAT) {
    throw new Error(`mint info ${label} is not a supported non-negative integer`)
  }
  return amount
}

function sats(amount: number): string {
  return amount.toLocaleString('en-US')
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNever(value: never): never {
  throw new Error(`unsupported mint payment value: ${String(value)}`)
}
