import {
  decodeDurableCustodyScopeInput,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from './durableCustody.ts'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import {
  decodeCtfRangeOrderRequest,
  decodeCtfRangeOrderPreparationFromRecord,
  decodePersistedCtfRangeOrderPreparation,
  decodePersistedCtfRangeOrderPreparationV2,
  planPersistedCtfRangeOrderAuthorization,
  type CtfRangeOrderRequest,
  type PersistedCtfRangeOrderPreparation,
  type PersistedCtfRangeOrderPreparationV2,
} from './ctfRangeOrderProtocol.ts'
import {
  decodeCtfRangeOrderPreparationIdentity,
  CTF_RANGE_ORDER_FEE_CONSENT_BYTES_MAX,
  decodeCtfRangeOrderPreparationArtifact,
  encodeCtfRangeOrderPreparationArtifact,
  decodeCtfRangeOrderFeeConsentArtifact,
  encodeCtfRangeOrderFeeConsentArtifact,
} from './ctfRangeOrderJournal.ts'
import {
  prepareCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorizationFromCounters,
  type CtfRangeOrderPreparation,
} from './ctfRangeOrderPreparation.ts'
import {
  assertCanonicalNut02V2KeysetId,
  isDurableSeedDerivedCounter,
} from './durableSeedDerivedPolicy.ts'

export interface CtfRangePreparationIntent {
  readonly version: 1
  readonly scopeId: string
  readonly request: CtfRangeOrderRequest
  /** Canonical fee-consent artifact bytes, encoded as lowercase hex. */
  readonly feeConsentHex: string | null
  readonly consolidateProofs: boolean
}

export interface CounterCtfRangePreparation extends Omit<
  PersistedCtfRangeOrderPreparationV2,
  'version'
> {
  readonly version: 3
  readonly preparationIntent: CtfRangePreparationIntent
  readonly preparationIntentDigest: string
  readonly offerCounterStart: number
  readonly offerCounterCount: number
  readonly receiveCounterStart: number
  readonly receiveCounterCount: number
}

const EXTRA_FIELDS = [
  'preparationIntent',
  'preparationIntentDigest',
  'offerCounterStart',
  'offerCounterCount',
  'receiveCounterStart',
  'receiveCounterCount',
] as const
const INTENT_FIELDS = ['version', 'scopeId', 'request', 'feeConsentHex', 'consolidateProofs']

/** Retains caller intent separately from the later exact mint request body. */
export function createCtfRangePreparationIntent(input: {
  scopeId: string
  request: CtfRangeOrderRequest
  feeConsentBytes: Uint8Array | null
  consolidateProofs: boolean
}): { intent: CtfRangePreparationIntent; digest: string } {
  if (
    input.feeConsentBytes !== null &&
    (!(input.feeConsentBytes instanceof Uint8Array) ||
      input.feeConsentBytes.length > CTF_RANGE_ORDER_FEE_CONSENT_BYTES_MAX)
  )
    fail()
  return decodeIntent({
    version: 1,
    scopeId: input.scopeId,
    request: input.request,
    feeConsentHex: input.feeConsentBytes === null ? null : bytesToHex(input.feeConsentBytes),
    consolidateProofs: input.consolidateProofs,
  })
}

function decodeIntent(value: unknown): { intent: CtfRangePreparationIntent; digest: string } {
  const candidate = record(value)
  if (
    Object.keys(candidate).sort().join() !== [...INTENT_FIELDS].sort().join() ||
    candidate.version !== 1 ||
    typeof candidate.scopeId !== 'string' ||
    candidate.scopeId.length < 1 ||
    candidate.scopeId.length > 1024 ||
    typeof candidate.consolidateProofs !== 'boolean'
  )
    fail()
  if (decodeDurableCustodyScopeInput(candidate.scopeId).scopeKind !== 'wallet') fail()
  const fee = candidate.feeConsentHex
  if (fee !== null) {
    if (
      typeof fee !== 'string' ||
      fee.length < 2 ||
      fee.length > 2 * CTF_RANGE_ORDER_FEE_CONSENT_BYTES_MAX ||
      !/^(?:[0-9a-f]{2})+$/.test(fee)
    )
      fail()
    const decoded = decodeCtfRangeOrderFeeConsentArtifact(hexToBytes(fee))
    if (bytesToHex(encodeCtfRangeOrderFeeConsentArtifact(decoded)) !== fee) fail()
  }
  const intent: CtfRangePreparationIntent = {
    version: 1,
    scopeId: candidate.scopeId,
    request: decodeCtfRangeOrderRequest(candidate.request),
    feeConsentHex: fee,
    consolidateProofs: candidate.consolidateProofs,
  }
  return { intent, digest: bytesToHex(sha256(encodeCtfRangeOrderPreparationArtifact(intent))) }
}

export function deriveCounterCtfRangeIdentity(
  seed: Uint8Array,
  offerKeysetId: string,
  offerStart: number,
): { operationId: string; authorizationId: string } {
  if (
    !(seed instanceof Uint8Array) ||
    (seed.length !== 32 && seed.length !== 64) ||
    !isDurableSeedDerivedCounter(offerStart)
  )
    fail()
  assertCanonicalNut02V2KeysetId(offerKeysetId)
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(offerStart), false)
  const digest = hmac(
    sha256,
    seed,
    concatBytes(
      new TextEncoder().encode('bitcaster/ctf-range-identity/v1\0'),
      hexToBytes(offerKeysetId),
      counter,
    ),
  )
  return { operationId: uuid(digest.slice(0, 16)), authorizationId: uuid(digest.slice(16)) }
}

function uuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 15) | 128
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Counts only. This function does not reserve or derive outputs. */
export function planCounterCtfRangePreparation(preparation: PersistedCtfRangeOrderPreparation): {
  offerCount: number
  receiveCount: number
  changeCount: number
} {
  const plan = planPersistedCtfRangeOrderAuthorization(
    decodePersistedCtfRangeOrderPreparation(preparation),
  )
  const receiveCount = BigInt(plan.manifest.maxReceive).toString(2).length
  const changeCount = BigInt(plan.manifest.maxChange).toString(2).length
  return {
    offerCount: 2 * plan.authorizationAmounts.length + changeCount,
    receiveCount,
    changeCount,
  }
}

/** The caller must atomically retain this receipt with both reserved ranges. */
export function createCounterCtfRangePreparation(input: {
  preparation: PersistedCtfRangeOrderPreparationV2
  intent: CtfRangePreparationIntent
  seed: Uint8Array
  offerCounterStart: number
  receiveCounterStart: number
}): CounterCtfRangePreparation {
  const base = decodePersistedCtfRangeOrderPreparationV2(input.preparation)
  const { intent, digest } = decodeIntent(input.intent)
  requireSeedScope(input.seed, intent.scopeId)
  const counts = planCounterCtfRangePreparation(base)
  requireRange(input.offerCounterStart, counts.offerCount)
  requireRange(input.receiveCounterStart, counts.receiveCount)
  const identity = deriveCounterCtfRangeIdentity(
    input.seed,
    base.offerKeyset.id,
    input.offerCounterStart,
  )
  const receipt = decodeCounterCtfRangePreparation({
    ...base,
    ...identity,
    sourceOperationId: `${identity.operationId}:source`,
    version: 3,
    preparationIntent: intent,
    preparationIntentDigest: digest,
    offerCounterStart: input.offerCounterStart,
    offerCounterCount: counts.offerCount,
    receiveCounterStart: input.receiveCounterStart,
    receiveCounterCount: counts.receiveCount,
  })
  // Refuse an unusable receipt before the caller commits its counter ranges.
  reconstructCtfRangePreparation(receipt, input.seed)
  return receipt
}

/** Structural validation does not claim to verify seed-derived IDs. Reconstruction does. */
export function decodeCounterCtfRangePreparation(value: unknown): CounterCtfRangePreparation {
  const input = record(value)
  if (input.version !== 3) fail()
  const baseInput: Record<string, unknown> = { ...input, version: 2 }
  for (const field of EXTRA_FIELDS) delete baseInput[field]
  const base = decodePersistedCtfRangeOrderPreparationV2(baseInput)
  const { intent, digest } = decodeIntent(input.preparationIntent)
  if (
    input.preparationIntentDigest !== digest ||
    bytesToHex(encodeCtfRangeOrderPreparationArtifact(intent.request)) !==
      bytesToHex(encodeCtfRangeOrderPreparationArtifact(base.request))
  )
    fail()
  const counts = planCounterCtfRangePreparation(base)
  if (
    input.offerCounterCount !== counts.offerCount ||
    input.receiveCounterCount !== counts.receiveCount ||
    base.sourceOperationId !== `${base.operationId}:source`
  )
    fail()
  requireRange(input.offerCounterStart, counts.offerCount)
  requireRange(input.receiveCounterStart, counts.receiveCount)
  return {
    ...base,
    version: 3,
    preparationIntent: intent,
    preparationIntentDigest: digest,
    offerCounterStart: input.offerCounterStart,
    offerCounterCount: counts.offerCount,
    receiveCounterStart: input.receiveCounterStart,
    receiveCounterCount: counts.receiveCount,
  }
}

export function encodeCounterCtfRangePreparation(value: CounterCtfRangePreparation): Uint8Array {
  return encodeCtfRangeOrderPreparationArtifact(decodeCounterCtfRangePreparation(value))
}

export function decodeCounterCtfRangePreparationBytes(
  bytes: Uint8Array,
): CounterCtfRangePreparation {
  return decodeCounterCtfRangePreparation(decodeCtfRangeOrderPreparationArtifact(bytes))
}

/** Version 2 is retained-state compatibility only; new reservations use version 3. */
export function reconstructCtfRangePreparation(
  value: unknown,
  seed: Uint8Array,
): CtfRangeOrderPreparation {
  if (record(value).version === 2)
    return prepareCtfRangeOrderAuthorization({
      ...decodePersistedCtfRangeOrderPreparation(value),
      seed,
    })
  const preparation = decodeCounterCtfRangePreparation(value)
  requireSeedScope(seed, preparation.preparationIntent.scopeId)
  const identity = deriveCounterCtfRangeIdentity(
    seed,
    preparation.offerKeyset.id,
    preparation.offerCounterStart,
  )
  if (
    identity.operationId !== preparation.operationId ||
    identity.authorizationId !== preparation.authorizationId
  )
    fail()
  const plan = planPersistedCtfRangeOrderAuthorization({ ...preparation, version: 2 })
  return prepareCtfRangeOrderAuthorizationFromCounters(
    { ...preparation, seed },
    {
      offerStart: preparation.offerCounterStart,
      receiveStart: preparation.receiveCounterStart,
      receiveCount: preparation.receiveCounterCount,
      changeCount: preparation.offerCounterCount - 2 * plan.authorizationAmounts.length,
    },
  )
}

function requireRange(start: unknown, count: number): asserts start is number {
  if (
    !isDurableSeedDerivedCounter(start) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    start > 2147483648 - count
  )
    fail()
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function fail(): never {
  throw new Error('Invalid counter CTF preparation')
}

function requireSeedScope(seed: Uint8Array, scopeId: string): void {
  if (
    deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(seed),
    }) !== scopeId
  )
    fail()
}

/** A bounded provider result. Providers retain ownership of transaction and fencing. */
export function selectCtfRangePreparationForIntent<
  T extends import('./ctfRangeOrderJournal.ts').CtfRangeOrderPreparationRecord & {
    readonly consolidateProofs: boolean
  },
>(rows: readonly T[], intentValue: CtfRangePreparationIntent): T | null {
  const wanted = decodeIntent(intentValue)
  if (rows.length > 32) throw new Error('CTF preparation history exceeds its limit')
  const matches: T[] = []
  for (const row of rows) {
    const { consolidateProofs: _policy, ...sdkRecord } = row
    const preparation = decodeCtfRangeOrderPreparationFromRecord(sdkRecord)
    if (
      row.scopeId !== wanted.intent.scopeId ||
      row.clientOrderId !== wanted.intent.request.clientOrderId ||
      typeof row.consolidateProofs !== 'boolean'
    )
      fail()
    const actual = createCtfRangePreparationIntent({
      scopeId: row.scopeId,
      request: preparation.request,
      feeConsentBytes: row.feeConsentBytes,
      consolidateProofs: row.consolidateProofs,
    })
    if (preparation.version === 3 && actual.digest !== preparation.preparationIntentDigest) fail()
    if (actual.digest === wanted.digest) matches.push(row)
  }
  if (rows.length > 1) throw new Error('CTF preparation history is ambiguous')
  if (matches.length === 1) return matches[0]!
  if (rows.length > 0) throw new Error('CTF preparation intent conflicts with its retained receipt')
  return null
}

export function assertCounterPreparationRecordBinding(
  preparation: CounterCtfRangePreparation,
  record: import('./ctfRangeOrderJournal.ts').CtfRangeOrderPreparationRecord,
): void {
  if (
    preparation.preparationIntent.scopeId !== record.scopeId ||
    preparation.preparationIntent.feeConsentHex !==
      (record.feeConsentBytes === null ? null : bytesToHex(record.feeConsentBytes))
  )
    fail()
}

/** Creates the existing journal identity; storage adds its own lifecycle and revision. */
export function counterCtfRangePreparationIdentity(
  value: CounterCtfRangePreparation,
  createdAtMs: number,
): import('./ctfRangeOrderJournal.ts').CtfRangeOrderPreparationIdentity {
  const preparation = decodeCounterCtfRangePreparation(value)
  return decodeCtfRangeOrderPreparationIdentity({
    scopeId: preparation.preparationIntent.scopeId,
    rangeOperationId: preparation.operationId,
    sourceOperationId: preparation.sourceOperationId,
    authorizationId: preparation.authorizationId,
    clientOrderId: preparation.request.clientOrderId,
    orderRouteId: preparation.request.marketId,
    normalizedMint: preparation.mintUrl,
    conditionId: preparation.conditionId,
    unit: 'msat',
    tokenSide: preparation.request.tokenSide,
    side: preparation.side,
    priceSubunits: preparation.priceNumerator,
    amountSubunits: preparation.amountSubunits,
    minimumFillAmountSubunits: preparation.request.minimumFillAmountSubunits,
    divisibility: preparation.divisibility,
    authorizationExpiresAtUnixSeconds: preparation.expiry,
    preparationBytes: encodeCounterCtfRangePreparation(preparation),
    feeConsentBytes:
      preparation.preparationIntent.feeConsentHex === null
        ? null
        : hexToBytes(preparation.preparationIntent.feeConsentHex),
    createdAtMs,
  })
}
