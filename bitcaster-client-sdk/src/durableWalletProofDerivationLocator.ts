import { Amount, assertCanonicalKeysetId, deriveSecretAndBlindingFactor } from '@cashu/cashu-ts'
import * as Cashu from '@cashu/cashu-ts'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deriveDurableCtfRangeRefundOperationId } from './durableCtfRangeOperation.ts'

const LOCATOR_TEXT_BYTES_MAX = 1_024
const MAX_U64 = 18_446_744_073_709_551_615n
const NUT13_COUNTER_MAX = 2_147_483_647
const CTF_RANGE_MANIFEST_INDEX_MAX = 255
const CTF_RANGE_REFUND_COUNTER_MAX = 32_767

export type DurableWalletProofDerivationLocator =
  | {
      readonly schemaVersion: 1
      readonly kind: 'nut13'
      readonly keysetId: string
      readonly counter: number
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'ctf-range-manifest'
      readonly rangeOperationId: string
      readonly manifestIndex: number
    }
  | {
      readonly schemaVersion: 1
      readonly kind: 'ctf-range-refund'
      readonly rangeOperationId: string
      readonly authorizationId: string
      readonly refundOperationId: string
      readonly counter: number
    }

export type SerializableDurableWalletProofDerivationLocator = DurableWalletProofDerivationLocator

export function decodeDurableWalletProofDerivationLocator(
  value: unknown,
): DurableWalletProofDerivationLocator {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== 'string') {
    throw new Error('durable wallet proof derivation locator is invalid')
  }
  switch (value.kind) {
    case 'nut13':
      return decodeNut13Locator(value)
    case 'ctf-range-manifest':
      return decodeManifestLocator(value)
    case 'ctf-range-refund':
      return decodeRefundLocator(value)
    default:
      throw new Error('durable wallet proof derivation locator is invalid')
  }
}

export function serializeDurableWalletProofDerivationLocator(
  value: unknown,
): SerializableDurableWalletProofDerivationLocator {
  return decodeDurableWalletProofDerivationLocator(value)
}

/** Encode the closed locator union for a canonical CBOR proof record. */
export function encodeDurableWalletProofDerivationLocatorCbor(value: unknown): readonly unknown[] {
  const locator = decodeDurableWalletProofDerivationLocator(value)
  switch (locator.kind) {
    case 'nut13':
      return [1, 0, locator.keysetId, locator.counter]
    case 'ctf-range-manifest':
      return [1, 1, locator.rangeOperationId, locator.manifestIndex]
    case 'ctf-range-refund':
      return [
        1,
        2,
        locator.rangeOperationId,
        locator.authorizationId,
        locator.refundOperationId,
        locator.counter,
      ]
  }
}

/** Decode the only locator representation permitted inside a CBOR proof record. */
export function decodeDurableWalletProofDerivationLocatorCbor(
  value: unknown,
): DurableWalletProofDerivationLocator {
  if (!Array.isArray(value) || value[0] !== 1 || typeof value[1] !== 'number') {
    throw new Error('durable wallet proof derivation locator is invalid')
  }
  switch (value[1]) {
    case 0:
      if (value.length !== 4) break
      return decodeDurableWalletProofDerivationLocator({
        schemaVersion: 1,
        kind: 'nut13',
        keysetId: value[2],
        counter: value[3],
      })
    case 1:
      if (value.length !== 4) break
      return decodeDurableWalletProofDerivationLocator({
        schemaVersion: 1,
        kind: 'ctf-range-manifest',
        rangeOperationId: value[2],
        manifestIndex: value[3],
      })
    case 2:
      if (value.length !== 6) break
      return decodeDurableWalletProofDerivationLocator({
        schemaVersion: 1,
        kind: 'ctf-range-refund',
        rangeOperationId: value[2],
        authorizationId: value[3],
        refundOperationId: value[4],
        counter: value[5],
      })
  }
  throw new Error('durable wallet proof derivation locator is invalid')
}

export function durableWalletProofDerivationLocatorsEqual(
  left: DurableWalletProofDerivationLocator,
  right: DurableWalletProofDerivationLocator,
): boolean {
  if (left.schemaVersion !== right.schemaVersion || left.kind !== right.kind) return false
  switch (left.kind) {
    case 'nut13':
      return (
        right.kind === 'nut13' && left.keysetId === right.keysetId && left.counter === right.counter
      )
    case 'ctf-range-manifest':
      return (
        right.kind === 'ctf-range-manifest' &&
        left.rangeOperationId === right.rangeOperationId &&
        left.manifestIndex === right.manifestIndex
      )
    case 'ctf-range-refund':
      return (
        right.kind === 'ctf-range-refund' &&
        left.rangeOperationId === right.rangeOperationId &&
        left.authorizationId === right.authorizationId &&
        left.refundOperationId === right.refundOperationId &&
        left.counter === right.counter
      )
  }
}

export function deriveDurableWalletProofSecret(input: {
  readonly seed: Uint8Array
  readonly locator: unknown
  readonly proofKeysetId: string
  readonly proofAmount: string | bigint | number
}): string {
  const locator = decodeDurableWalletProofDerivationLocator(input.locator)
  const seed = requireSeed(input.seed)
  const proofKeysetId = requireCanonicalKeysetId(input.proofKeysetId, 'proof keyset id')
  const proofAmount = requireProofAmount(input.proofAmount)
  switch (locator.kind) {
    case 'nut13':
      if (locator.keysetId !== proofKeysetId) throw new Error('NUT-13 locator keyset is foreign')
      return bytesToHex(deriveSecretAndBlindingFactor(seed, proofKeysetId, locator.counter).secret)
    case 'ctf-range-manifest':
      return manifestProofSecret(seed, locator, proofKeysetId, proofAmount)
    case 'ctf-range-refund':
      return refundProofSecret(seed, locator, proofKeysetId)
  }
}

function decodeNut13Locator(value: Record<string, unknown>): DurableWalletProofDerivationLocator {
  exactKeys(value, ['schemaVersion', 'kind', 'keysetId', 'counter'])
  return Object.freeze({
    schemaVersion: 1,
    kind: 'nut13' as const,
    keysetId: requireCanonicalKeysetId(value.keysetId, 'NUT-13 keyset id'),
    counter: requireNut13Counter(value.counter),
  })
}

function decodeManifestLocator(
  value: Record<string, unknown>,
): DurableWalletProofDerivationLocator {
  exactKeys(value, ['schemaVersion', 'kind', 'rangeOperationId', 'manifestIndex'])
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ctf-range-manifest' as const,
    rangeOperationId: requireBoundedText(value.rangeOperationId, 'range operation id'),
    manifestIndex: requireManifestIndex(value.manifestIndex),
  })
}

function decodeRefundLocator(value: Record<string, unknown>): DurableWalletProofDerivationLocator {
  exactKeys(value, [
    'schemaVersion',
    'kind',
    'rangeOperationId',
    'authorizationId',
    'refundOperationId',
    'counter',
  ])
  const rangeOperationId = requireBoundedText(value.rangeOperationId, 'range operation id')
  const refundOperationId = requireBoundedText(value.refundOperationId, 'refund operation id')
  if (refundOperationId !== deriveDurableCtfRangeRefundOperationId(rangeOperationId)) {
    throw new Error('CTF range refund operation identity is foreign')
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ctf-range-refund' as const,
    rangeOperationId,
    authorizationId: requireBoundedText(value.authorizationId, 'authorization id'),
    refundOperationId,
    counter: requireRefundCounter(value.counter),
  })
}

function manifestProofSecret(
  seed: Uint8Array,
  locator: Extract<DurableWalletProofDerivationLocator, { kind: 'ctf-range-manifest' }>,
  proofKeysetId: string,
  proofAmount: Amount,
): string {
  const derive = (
    Cashu as unknown as {
      deriveCtfRangeManifestOutputData(value: {
        seed: Uint8Array
        rangeOperationId: string
        manifestIndex: number
        amount: Amount
        keysetId: string
      }): { secret: Uint8Array }
    }
  ).deriveCtfRangeManifestOutputData
  if (typeof derive !== 'function') throw new Error('CTF range manifest derivation is unavailable')
  const output = derive({
    seed,
    rangeOperationId: locator.rangeOperationId,
    manifestIndex: locator.manifestIndex,
    amount: proofAmount,
    keysetId: proofKeysetId,
  })
  const secret = new TextDecoder().decode(output.secret)
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('CTF range manifest proof secret is invalid')
  return secret
}

function refundProofSecret(
  seed: Uint8Array,
  locator: Extract<DurableWalletProofDerivationLocator, { kind: 'ctf-range-refund' }>,
  proofKeysetId: string,
): string {
  if (seed.byteLength < 32 || seed.byteLength > 64) {
    throw new Error('CTF range refund seed is invalid')
  }
  const identity = new TextEncoder().encode(
    canonicalJson({
      schemaVersion: 1,
      rangeOperationId: locator.rangeOperationId,
      authorizationId: locator.authorizationId,
      refundOperationId: locator.refundOperationId,
      refundKeysetId: proofKeysetId,
    }),
  )
  const domain = new TextEncoder().encode('bitcaster/ctf-range-refund-output/v1\0')
  const outputSeed = hmac(sha256, seed, concatenateBytes(domain, identity))
  return bytesToHex(
    deriveSecretAndBlindingFactor(outputSeed, proofKeysetId, locator.counter).secret,
  )
}

function requireSeed(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error('wallet seed is invalid')
  }
  return value
}

function requireCanonicalKeysetId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`)
  try {
    return assertCanonicalKeysetId(value, field)
  } catch {
    throw new Error(`${field} is invalid`)
  }
}

function requireProofAmount(value: unknown): Amount {
  try {
    const amount = Amount.from(value as string | bigint | number)
    if (amount.toBigInt() < 1n || amount.toBigInt() > MAX_U64) throw new Error()
    return amount
  } catch {
    throw new Error('proof amount is invalid')
  }
}

function requireNut13Counter(value: unknown): number {
  return requireBoundedCounter(value, NUT13_COUNTER_MAX, 'NUT-13 counter')
}

function requireManifestIndex(value: unknown): number {
  return requireBoundedCounter(value, CTF_RANGE_MANIFEST_INDEX_MAX, 'range manifest index')
}

function requireRefundCounter(value: unknown): number {
  return requireBoundedCounter(value, CTF_RANGE_REFUND_COUNTER_MAX, 'CTF range refund counter')
}

function requireBoundedCounter(value: unknown, maximum: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${field} is invalid`)
  }
  return value
}

function requireBoundedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is invalid`)
  if (new TextEncoder().encode(value).byteLength > LOCATOR_TEXT_BYTES_MAX) {
    throw new Error(`${field} exceeds its byte limit`)
  }
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys)
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error('durable wallet proof derivation locator contains foreign or missing fields')
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function concatenateBytes(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
