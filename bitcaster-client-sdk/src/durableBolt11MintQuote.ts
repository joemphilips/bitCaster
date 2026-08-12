import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  decodeCanonicalMintOrigin,
  deriveDurableCustodyArtifactFingerprint,
} from './durableCustody.ts'
import {
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
  type DurableWalletMintOperation,
  type DurableWalletOperationAuthority,
} from './durableWalletOperation.ts'

export const DURABLE_BOLT11_MINT_QUOTE_SCHEMA_VERSION = 1 as const
const DURABLE_BOLT11_MINT_QUOTE_TEXT_BYTES_MAX = 16 * 1_024

export type DurableBolt11MintQuotePresentationState = 'visible' | 'hidden'
export type DurableBolt11MintQuoteNut04State = 'UNPAID' | 'PAID' | 'ISSUED'

/** A persistence-neutral durable record for the NUT-04 BOLT11 quote crash window. */
export interface DurableBolt11MintQuote {
  readonly schemaVersion: 1
  readonly quoteRecordId: string
  readonly mintUrl: string
  readonly unit: string
  readonly paymentMethod: 'bolt11'
  readonly requestedAmount: string
  readonly quoteId: string
  readonly invoiceRequest: string
  readonly expiryUnixSeconds: number | null
  readonly presentationState: DurableBolt11MintQuotePresentationState
  readonly observedState: DurableBolt11MintQuoteNut04State
  readonly walletMintOperationId: string
  readonly walletMintOperationAuthority: DurableWalletOperationAuthority | null
  readonly revision: number
}

export function createDurableBolt11MintQuote(input: {
  readonly mintUrl: string
  readonly unit: string
  readonly requestedAmount: string
  readonly quoteId: string
  readonly invoiceRequest: string
  readonly expiryUnixSeconds?: number | null
  readonly observedState?: DurableBolt11MintQuoteNut04State
}): DurableBolt11MintQuote {
  const identity = decodeIdentity({ ...input, paymentMethod: 'bolt11' })
  return decodeDurableBolt11MintQuote({
    schemaVersion: DURABLE_BOLT11_MINT_QUOTE_SCHEMA_VERSION,
    quoteRecordId: deriveDurableBolt11MintQuoteRecordId(identity),
    mintUrl: identity.mintUrl,
    unit: identity.unit,
    paymentMethod: identity.paymentMethod,
    requestedAmount: input.requestedAmount,
    quoteId: identity.quoteId,
    invoiceRequest: input.invoiceRequest,
    expiryUnixSeconds: input.expiryUnixSeconds ?? null,
    presentationState: 'visible',
    observedState: input.observedState === undefined ? 'UNPAID' : input.observedState,
    walletMintOperationId: deriveDurableBolt11MintQuoteWalletMintOperationId(identity),
    walletMintOperationAuthority: null,
    revision: 0,
  })
}

export function decodeDurableBolt11MintQuote(value: unknown): DurableBolt11MintQuote {
  if (!isRecord(value)) throw new Error('durable BOLT11 mint quote is invalid')
  exactKeys(value, [
    'schemaVersion',
    'quoteRecordId',
    'mintUrl',
    'unit',
    'paymentMethod',
    'requestedAmount',
    'quoteId',
    'invoiceRequest',
    'expiryUnixSeconds',
    'presentationState',
    'observedState',
    'walletMintOperationId',
    'walletMintOperationAuthority',
    'revision',
  ])
  if (value.schemaVersion !== DURABLE_BOLT11_MINT_QUOTE_SCHEMA_VERSION) {
    throw new Error('durable BOLT11 mint quote schema is unsupported')
  }
  const identity = decodeIdentity(value)
  requirePositiveDecimalAmount(value.requestedAmount)
  requireText(value.invoiceRequest, 'invoice request')
  requireExpiry(value.expiryUnixSeconds)
  requirePresentationState(value.presentationState)
  requireNut04State(value.observedState)
  requireRevision(value.revision)
  const expectedQuoteRecordId = deriveDurableBolt11MintQuoteRecordId(identity)
  if (value.quoteRecordId !== expectedQuoteRecordId) {
    throw new Error('durable BOLT11 mint quote record identity is foreign')
  }
  const expectedOperationId = deriveDurableBolt11MintQuoteWalletMintOperationId(identity)
  if (value.walletMintOperationId !== expectedOperationId) {
    throw new Error('durable BOLT11 mint quote wallet operation identity is foreign')
  }
  const walletMintOperationAuthority = decodeAuthority(value.walletMintOperationAuthority)
  return {
    schemaVersion: DURABLE_BOLT11_MINT_QUOTE_SCHEMA_VERSION,
    quoteRecordId: expectedQuoteRecordId,
    mintUrl: identity.mintUrl,
    unit: identity.unit,
    paymentMethod: identity.paymentMethod,
    requestedAmount: value.requestedAmount,
    quoteId: identity.quoteId,
    invoiceRequest: value.invoiceRequest,
    expiryUnixSeconds: value.expiryUnixSeconds,
    presentationState: value.presentationState,
    observedState: value.observedState,
    walletMintOperationId: expectedOperationId,
    walletMintOperationAuthority,
    revision: value.revision,
  }
}

export function deriveDurableBolt11MintQuoteRecordId(input: {
  readonly mintUrl: string
  readonly unit: string
  readonly paymentMethod: 'bolt11'
  readonly quoteId: string
}): string {
  return deriveIdentity('bitcaster/durable-bolt11-mint-quote/v1\0', decodeIdentity(input))
}

export function deriveDurableBolt11MintQuoteWalletMintOperationId(input: {
  readonly mintUrl: string
  readonly unit: string
  readonly paymentMethod: 'bolt11'
  readonly quoteId: string
}): string {
  return deriveIdentity(
    'bitcaster/durable-bolt11-mint-quote-wallet-mint-operation/v1\0',
    decodeIdentity(input),
  )
}

export function hideDurableBolt11MintQuote(input: DurableBolt11MintQuote): DurableBolt11MintQuote {
  const quote = decodeDurableBolt11MintQuote(input)
  if (quote.presentationState === 'hidden') return quote
  return { ...quote, presentationState: 'hidden', revision: quote.revision + 1 }
}

export function observeDurableBolt11MintQuoteState(
  input: DurableBolt11MintQuote,
  observedState: DurableBolt11MintQuoteNut04State,
): DurableBolt11MintQuote {
  const quote = decodeDurableBolt11MintQuote(input)
  requireNut04State(observedState)
  const previousRank = nut04StateRank(quote.observedState)
  const nextRank = nut04StateRank(observedState)
  if (nextRank < previousRank) {
    throw new Error('durable BOLT11 mint quote observed state regresses')
  }
  if (nextRank === previousRank) return quote
  return { ...quote, observedState, revision: quote.revision + 1 }
}

/** Bind the exact existing wallet mint authority once. */
export function bindDurableBolt11MintQuoteOperation(
  input: DurableBolt11MintQuote,
  operation: DurableWalletMintOperation,
): DurableBolt11MintQuote {
  const quote = decodeDurableBolt11MintQuote(input)
  const authority = requireExactWalletMintOperation(quote, operation)
  if (quote.walletMintOperationAuthority === null) {
    return { ...quote, walletMintOperationAuthority: authority, revision: quote.revision + 1 }
  }
  if (!sameAuthority(quote.walletMintOperationAuthority, authority)) {
    throw new Error('durable BOLT11 mint quote wallet operation authority conflicts')
  }
  return quote
}

/** Verify that a retry uses the operation and output authority bound by the quote. */
export function verifyDurableBolt11MintQuoteRetry(
  input: DurableBolt11MintQuote,
  operation: DurableWalletMintOperation,
): DurableBolt11MintQuote {
  const quote = decodeDurableBolt11MintQuote(input)
  const authority = requireExactWalletMintOperation(quote, operation)
  if (quote.walletMintOperationAuthority === null) {
    throw new Error('durable BOLT11 mint quote wallet operation authority is not bound')
  }
  if (!sameAuthority(quote.walletMintOperationAuthority, authority)) {
    throw new Error('durable BOLT11 mint quote retry authority conflicts')
  }
  return quote
}

function requireExactWalletMintOperation(
  quote: DurableBolt11MintQuote,
  value: DurableWalletMintOperation,
): DurableWalletOperationAuthority {
  const operation = decodeDurableWalletOperation(value)
  if (operation.kind !== 'wallet-mint') {
    throw new Error('durable BOLT11 mint quote wallet operation is foreign')
  }
  if (operation.preview.method !== 'bolt11') {
    throw new Error('durable BOLT11 mint quote wallet operation is foreign')
  }
  if (
    operation.operationId !== quote.walletMintOperationId ||
    operation.mintUrl !== quote.mintUrl ||
    operation.unit !== quote.unit ||
    operation.preview.payload.quote !== quote.quoteId
  ) {
    throw new Error('durable BOLT11 mint quote wallet operation is foreign')
  }
  const plannedAmount = operation.preview.payload.outputs.reduce(
    (total, output) => total + BigInt(output.amount),
    0n,
  )
  if (plannedAmount !== BigInt(quote.requestedAmount)) {
    throw new Error('durable BOLT11 mint quote wallet operation amount conflicts')
  }
  return deriveDurableWalletOperationAuthority(operation)
}

function decodeIdentity(value: {
  readonly mintUrl?: unknown
  readonly unit?: unknown
  readonly paymentMethod?: unknown
  readonly quoteId?: unknown
}): { mintUrl: string; unit: string; paymentMethod: 'bolt11'; quoteId: string } {
  let mintUrl: string
  try {
    mintUrl = decodeCanonicalMintOrigin(value.mintUrl)
  } catch {
    throw new Error('durable BOLT11 mint quote mint URL is not normalized')
  }
  requireText(value.unit, 'unit')
  if (value.paymentMethod !== 'bolt11') {
    throw new Error('durable BOLT11 mint quote payment method is invalid')
  }
  requireText(value.quoteId, 'quote id')
  return { mintUrl, unit: value.unit, paymentMethod: value.paymentMethod, quoteId: value.quoteId }
}

function deriveIdentity(
  domain: string,
  identity: { mintUrl: string; unit: string; paymentMethod: 'bolt11'; quoteId: string },
): string {
  const canonicalIdentity = deriveDurableCustodyArtifactFingerprint({
    mintUrl: identity.mintUrl,
    unit: identity.unit,
    paymentMethod: identity.paymentMethod,
    quoteId: identity.quoteId,
  })
  return bytesToHex(
    sha256(
      concatenateBytes(
        new TextEncoder().encode(domain),
        new TextEncoder().encode(canonicalIdentity),
      ),
    ),
  )
}

function decodeAuthority(value: unknown): DurableWalletOperationAuthority | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('durable BOLT11 mint quote authority is invalid')
  exactKeys(value, ['requestFingerprint', 'outputPlanFingerprint'])
  requireFingerprint(value.requestFingerprint, 'authority request fingerprint')
  requireFingerprint(value.outputPlanFingerprint, 'authority output fingerprint')
  return {
    requestFingerprint: value.requestFingerprint,
    outputPlanFingerprint: value.outputPlanFingerprint,
  }
}

function requirePositiveDecimalAmount(value: unknown): asserts value is string {
  requireText(value, 'amount')
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('durable BOLT11 mint quote amount is invalid')
  }
  try {
    BigInt(value)
  } catch {
    throw new Error('durable BOLT11 mint quote amount is invalid')
  }
}

function requireExpiry(value: unknown): asserts value is number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('durable BOLT11 mint quote expiry is invalid')
  }
}

function requirePresentationState(
  value: unknown,
): asserts value is DurableBolt11MintQuotePresentationState {
  if (value !== 'visible' && value !== 'hidden') {
    throw new Error('durable BOLT11 mint quote presentation state is invalid')
  }
}

function requireNut04State(value: unknown): asserts value is DurableBolt11MintQuoteNut04State {
  if (value !== 'UNPAID' && value !== 'PAID' && value !== 'ISSUED') {
    throw new Error('durable BOLT11 mint quote observed state is invalid')
  }
}

function nut04StateRank(value: DurableBolt11MintQuoteNut04State): number {
  switch (value) {
    case 'UNPAID':
      return 0
    case 'PAID':
      return 1
    case 'ISSUED':
      return 2
  }
}

function requireRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('durable BOLT11 mint quote revision is invalid')
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > DURABLE_BOLT11_MINT_QUOTE_TEXT_BYTES_MAX
  ) {
    throw new Error(`durable BOLT11 mint quote ${label} is invalid`)
  }
}

function requireFingerprint(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`durable BOLT11 mint quote ${label} is invalid`)
  }
}

function sameAuthority(
  left: DurableWalletOperationAuthority,
  right: DurableWalletOperationAuthority,
): boolean {
  return (
    left.requestFingerprint === right.requestFingerprint &&
    left.outputPlanFingerprint === right.outputPlanFingerprint
  )
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error('durable BOLT11 mint quote contains foreign fields')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function concatenateBytes(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}
