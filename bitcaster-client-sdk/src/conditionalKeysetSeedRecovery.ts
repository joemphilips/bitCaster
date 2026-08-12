import {
  Amount,
  OutputData,
  deriveConditionalKeysetId,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { deriveRootCtfOutcomeCollectionId } from './durableCtfRangeOperation.ts'

export const CONDITIONAL_KEYSET_DISCOVERY_PREFIX_COUNTERS = 300 as const
export const CONDITIONAL_KEYSET_DISCOVERY_KEYSET_LIMIT = 1_024 as const
export const CONDITIONAL_KEYSET_DISCOVERY_OUTPUT_LIMIT = 4_096 as const
export const EXACT_SEED_RECOVERY_BATCH_LIMIT = 300 as const

export interface ExactSeedRecoveryCandidate {
  readonly keysetId: string
  readonly counter: number
  readonly blindedOutput: SerializedBlindedMessage
  readonly outputData: OutputData
}

export interface ExactSeedRecoveryMatch<T extends ExactSeedRecoveryCandidate> {
  readonly candidate: T
  readonly output: SerializedBlindedMessage
  readonly signature: SerializedBlindedSignature
}

export interface ExactSeedRecoveryResponseBinding<T extends ExactSeedRecoveryCandidate> {
  readonly matches: readonly ExactSeedRecoveryMatch<T>[]
  readonly lastCounterWithSignature: number | null
}

export interface ConditionalKeysetSeedRecoveryDescriptor {
  readonly id: string
  readonly unit: string
  readonly active: boolean
  readonly inputFeePpk: number
  readonly finalExpiry: number | null
  readonly conditionId: string
  readonly outcomeCollection: string
  readonly outcomeCollectionId: string
  readonly registeredAt: number
}

export interface ConditionalKeysetSeedRecoveryAuthority extends ConditionalKeysetSeedRecoveryDescriptor {
  readonly keys: Readonly<Record<string, string>>
}

export interface ConditionalKeysetSeedRecoveryCursor {
  readonly nextKeysetIndex: number
  readonly nextCounter: number
}

export interface ConditionalKeysetSeedRecoveryCandidate extends ExactSeedRecoveryCandidate {
  readonly asset: Omit<ConditionalKeysetSeedRecoveryDescriptor, 'id'> & {
    readonly kind: 'conditional'
  }
}

export interface ConditionalKeysetSeedRecoveryPage {
  readonly candidates: readonly ConditionalKeysetSeedRecoveryCandidate[]
  readonly nextCursor: ConditionalKeysetSeedRecoveryCursor | null
}

export interface ConditionalKeysetSeedRecoveryMatch {
  readonly candidate: ConditionalKeysetSeedRecoveryCandidate
  readonly output: SerializedBlindedMessage
  readonly signature: SerializedBlindedSignature
}

/** Plan one exact deterministic NUT-09 batch for a selected V2 keyset. */
export function planExactSeedRecoveryBatch(input: {
  readonly seed: Uint8Array
  readonly keysetId: string
  readonly startCounter: number
  readonly count: number
}): readonly ExactSeedRecoveryCandidate[] {
  const seed = requireSeed(input.seed)
  const keysetId = requireV2KeysetId(input.keysetId)
  const startCounter = requireBoundedInteger(
    input.startCounter,
    0,
    Number.MAX_SAFE_INTEGER,
    'seed recovery start counter',
  )
  const count = requireBoundedInteger(
    input.count,
    1,
    EXACT_SEED_RECOVERY_BATCH_LIMIT,
    'seed recovery batch count',
  )
  if (startCounter > Number.MAX_SAFE_INTEGER - count) {
    throw new Error('seed recovery counter range is invalid')
  }
  return Object.freeze(
    Array.from({ length: count }, (_, offset) =>
      createExactCandidate(seed, keysetId, startCounter + offset),
    ),
  )
}

/** Bind a raw NUT-09 subset to exact deterministic candidates. */
export function bindExactSeedRecoveryResponse<T extends ExactSeedRecoveryCandidate>(input: {
  readonly candidates: readonly T[]
  readonly response: unknown
}): ExactSeedRecoveryResponseBinding<T> {
  const candidates = indexCandidates(input.candidates)
  const response = decodeRestoreResponse(input.response, candidates.size)
  const seen = new Set<string>()
  const matches = response.outputs.map((output, index) => {
    const candidate = candidates.get(output.B_)
    const signature = response.signatures[index]!
    if (candidate === undefined) throw new Error('seed recovery NUT-09 output is foreign')
    if (seen.has(output.B_)) throw new Error('seed recovery NUT-09 output is duplicated')
    seen.add(output.B_)
    if (!matchesCandidate(candidate, output, signature)) {
      throw new Error('seed recovery NUT-09 signature does not match its output')
    }
    return { candidate, output, signature }
  })
  return {
    matches,
    lastCounterWithSignature:
      matches.length === 0 ? null : Math.max(...matches.map(({ candidate }) => candidate.counter)),
  }
}

export interface ConditionalKeysetSeedRecoveryResponseBinding {
  readonly matches: readonly ConditionalKeysetSeedRecoveryMatch[]
  readonly discoveredKeysetIds: ReadonlySet<string>
}

/** Validate advertised keyset metadata before discovery output planning. */
export function validateConditionalKeysetSeedRecoveryDescriptor(
  value: unknown,
): ConditionalKeysetSeedRecoveryDescriptor {
  const record = exactRecord(value, 'conditional keyset discovery descriptor')
  exactKeys(
    record,
    [
      'id',
      'unit',
      'active',
      'condition_id',
      'outcome_collection',
      'outcome_collection_id',
      'registered_at',
    ],
    ['input_fee_ppk', 'final_expiry'],
    'conditional keyset discovery descriptor',
  )
  const descriptor = decodeDescriptor(record)
  assertDescriptorIdentity(descriptor)
  return Object.freeze(descriptor)
}

/** Validate fetched denomination keys before selected-keyset recovery. */
export function validateConditionalKeysetSeedRecoveryAuthority(
  value: unknown,
): ConditionalKeysetSeedRecoveryAuthority {
  const record = exactRecord(value, 'conditional keyset recovery authority')
  exactKeys(
    record,
    [
      'id',
      'unit',
      'active',
      'condition_id',
      'outcome_collection',
      'outcome_collection_id',
      'registered_at',
      'keys',
    ],
    ['input_fee_ppk', 'final_expiry'],
    'conditional keyset recovery authority',
  )
  const authority = Object.freeze({
    ...decodeDescriptor(record),
    keys: decodeDenominationKeys(record.keys),
  })
  assertAuthorityIdentity(authority)
  return authority
}

/** Plan one bounded NUT-13 prefix page from validated discovery descriptors. */
export function planConditionalKeysetSeedRecoveryPage(input: {
  readonly seed: Uint8Array
  readonly keysets: readonly ConditionalKeysetSeedRecoveryDescriptor[]
  readonly maxOutputs: number
  readonly cursor?: ConditionalKeysetSeedRecoveryCursor | null
}): ConditionalKeysetSeedRecoveryPage {
  const seed = requireSeed(input.seed)
  const keysets = orderKeysets(input.keysets)
  const cursor = validateCursor(input.cursor, keysets.length)
  const maxOutputs = requireBoundedInteger(
    input.maxOutputs,
    1,
    CONDITIONAL_KEYSET_DISCOVERY_OUTPUT_LIMIT,
    'conditional keyset discovery maximum outputs',
  )
  return createPage(seed, keysets, cursor, maxOutputs)
}

/** Bind a raw NUT-09 subset to exact planned blinded-output candidates. */
export function bindConditionalKeysetSeedRecoveryResponse(input: {
  readonly candidates: readonly ConditionalKeysetSeedRecoveryCandidate[]
  readonly response: unknown
}): ConditionalKeysetSeedRecoveryResponseBinding {
  const { matches } = bindExactSeedRecoveryResponse(input)
  return {
    matches,
    discoveredKeysetIds: new Set(matches.map(({ candidate }) => candidate.keysetId)),
  }
}

function createExactCandidate(
  seed: Uint8Array,
  keysetId: string,
  counter: number,
): ExactSeedRecoveryCandidate {
  try {
    const outputData = OutputData.createSingleDeterministicData(0, seed, counter, keysetId)
    return Object.freeze({
      keysetId,
      counter,
      blindedOutput: Object.freeze({ ...outputData.blindedMessage }),
      outputData,
    })
  } catch {
    throw new Error('seed recovery output derivation failed')
  }
}

function decodeDescriptor(value: Record<string, unknown>): ConditionalKeysetSeedRecoveryDescriptor {
  const registeredAt = requireBoundedInteger(
    value.registered_at,
    0,
    Number.MAX_SAFE_INTEGER,
    'conditional keyset registration',
  )
  const finalExpiry = optionalPositiveInteger(value.final_expiry, 'conditional keyset final expiry')
  if (finalExpiry !== null && finalExpiry <= registeredAt)
    throw new Error('conditional keyset expiry precedes registration')
  if (value.active !== true && value.active !== false)
    throw new Error('conditional keyset active is invalid')
  return {
    id: requireV2KeysetId(value.id),
    unit: requireText(value.unit, 'conditional keyset unit', 64),
    active: value.active,
    inputFeePpk:
      value.input_fee_ppk == null
        ? 0
        : requireBoundedInteger(
            value.input_fee_ppk,
            0,
            Number.MAX_SAFE_INTEGER,
            'conditional keyset input fee',
          ),
    finalExpiry,
    conditionId: requireHash(value.condition_id, 'conditional keyset condition id'),
    outcomeCollection: requireCleanProductOutcomeCollection(value.outcome_collection),
    outcomeCollectionId: requireHash(
      value.outcome_collection_id,
      'conditional keyset outcome collection id',
    ),
    registeredAt,
  }
}

function assertAuthorityIdentity(authority: ConditionalKeysetSeedRecoveryAuthority): void {
  assertDescriptorIdentity(authority)
  const id = deriveConditionalKeysetId({
    keys: authority.keys,
    unit: authority.unit,
    ...(authority.inputFeePpk === 0 ? {} : { input_fee_ppk: authority.inputFeePpk }),
    ...(authority.finalExpiry === null ? {} : { final_expiry: authority.finalExpiry }),
    conditionId: authority.conditionId,
    outcomeCollectionId: authority.outcomeCollectionId,
  })
  if (id !== authority.id) throw new Error('conditional keyset identity is inconsistent')
}

function assertDescriptorIdentity(descriptor: ConditionalKeysetSeedRecoveryDescriptor): void {
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: descriptor.conditionId,
    outcomeCollection: descriptor.outcomeCollection,
  })
  if (outcomeCollectionId !== descriptor.outcomeCollectionId)
    throw new Error('conditional keyset outcome collection is inconsistent')
}

function orderKeysets(
  value: readonly ConditionalKeysetSeedRecoveryDescriptor[],
): readonly ConditionalKeysetSeedRecoveryDescriptor[] {
  if (value.length === 0 || value.length > CONDITIONAL_KEYSET_DISCOVERY_KEYSET_LIMIT) {
    throw new Error('conditional keyset discovery keysets are invalid')
  }
  const keysets = [...value].sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(keysets.map(({ id }) => id)).size !== keysets.length) {
    throw new Error('conditional keyset discovery keysets are duplicated')
  }
  return keysets
}

function validateCursor(
  cursor: ConditionalKeysetSeedRecoveryCursor | null | undefined,
  keysetCount: number,
): ConditionalKeysetSeedRecoveryCursor {
  if (cursor === undefined || cursor === null) return { nextKeysetIndex: 0, nextCounter: 0 }
  const nextKeysetIndex = requireBoundedInteger(
    cursor.nextKeysetIndex,
    0,
    keysetCount,
    'conditional keyset cursor index',
  )
  const nextCounter = requireBoundedInteger(
    cursor.nextCounter,
    0,
    CONDITIONAL_KEYSET_DISCOVERY_PREFIX_COUNTERS - 1,
    'conditional keyset cursor counter',
  )
  if (nextKeysetIndex === keysetCount && nextCounter !== 0)
    throw new Error('conditional keyset discovery cursor is invalid')
  return { nextKeysetIndex, nextCounter }
}

function createPage(
  seed: Uint8Array,
  keysets: readonly ConditionalKeysetSeedRecoveryDescriptor[],
  cursor: ConditionalKeysetSeedRecoveryCursor,
  maxOutputs: number,
): ConditionalKeysetSeedRecoveryPage {
  const candidates: ConditionalKeysetSeedRecoveryCandidate[] = []
  let { nextKeysetIndex: keysetIndex, nextCounter: counter } = cursor
  while (keysetIndex < keysets.length && candidates.length < maxOutputs) {
    candidates.push(createCandidate(seed, keysets[keysetIndex]!, counter))
    counter += 1
    if (counter === CONDITIONAL_KEYSET_DISCOVERY_PREFIX_COUNTERS) {
      keysetIndex += 1
      counter = 0
    }
  }
  return {
    candidates,
    nextCursor:
      keysetIndex === keysets.length
        ? null
        : { nextKeysetIndex: keysetIndex, nextCounter: counter },
  }
}

function createCandidate(
  seed: Uint8Array,
  authority: ConditionalKeysetSeedRecoveryDescriptor,
  counter: number,
): ConditionalKeysetSeedRecoveryCandidate {
  const candidate = createExactCandidate(seed, authority.id, counter)
  return Object.freeze({
    ...candidate,
    asset: Object.freeze({
      kind: 'conditional',
      unit: authority.unit,
      active: authority.active,
      inputFeePpk: authority.inputFeePpk,
      finalExpiry: authority.finalExpiry,
      conditionId: authority.conditionId,
      outcomeCollection: authority.outcomeCollection,
      outcomeCollectionId: authority.outcomeCollectionId,
      registeredAt: authority.registeredAt,
    }),
  })
}

function indexCandidates<T extends ExactSeedRecoveryCandidate>(
  candidates: readonly T[],
): ReadonlyMap<string, T> {
  if (candidates.length === 0 || candidates.length > CONDITIONAL_KEYSET_DISCOVERY_OUTPUT_LIMIT) {
    throw new Error('conditional keyset discovery candidates are invalid')
  }
  const indexed = new Map<string, T>()
  for (const candidate of candidates) {
    if (indexed.has(candidate.blindedOutput.B_))
      throw new Error('conditional keyset discovery candidates are duplicated')
    indexed.set(candidate.blindedOutput.B_, candidate)
  }
  return indexed
}

function decodeRestoreResponse(
  value: unknown,
  candidateCount: number,
): {
  outputs: readonly SerializedBlindedMessage[]
  signatures: readonly SerializedBlindedSignature[]
} {
  const record = exactRecord(value, 'conditional keyset NUT-09 response')
  exactKeys(record, ['outputs', 'signatures'], [], 'conditional keyset NUT-09 response')
  if (
    !Array.isArray(record.outputs) ||
    !Array.isArray(record.signatures) ||
    record.outputs.length !== record.signatures.length ||
    record.outputs.length > candidateCount
  ) {
    throw new Error('conditional keyset NUT-09 response is invalid')
  }
  return {
    outputs: record.outputs.map(decodeRestoreOutput),
    signatures: record.signatures.map(decodeRestoreSignature),
  }
}

function matchesCandidate(
  candidate: ExactSeedRecoveryCandidate,
  output: SerializedBlindedMessage,
  signature: SerializedBlindedSignature,
): boolean {
  return (
    output.id === candidate.keysetId &&
    output.B_ === candidate.blindedOutput.B_ &&
    equalAmounts(output.amount, candidate.blindedOutput.amount) &&
    signature.id === candidate.keysetId &&
    isPositiveAmount(signature.amount)
  )
}

function decodeRestoreOutput(value: unknown): SerializedBlindedMessage {
  const record = exactRecord(value, 'conditional keyset NUT-09 output')
  exactKeys(record, ['amount', 'B_', 'id'], [], 'conditional keyset NUT-09 output')
  if (typeof record.id !== 'string' || typeof record.B_ !== 'string' || !isAmount(record.amount)) {
    throw new Error('conditional keyset NUT-09 output is invalid')
  }
  return record as unknown as SerializedBlindedMessage
}

function decodeRestoreSignature(value: unknown): SerializedBlindedSignature {
  const record = exactRecord(value, 'conditional keyset NUT-09 signature')
  exactKeys(record, ['id', 'amount', 'C_'], ['dleq'], 'conditional keyset NUT-09 signature')
  if (
    typeof record.id !== 'string' ||
    !/^(?:02|03)[0-9a-f]{64}$/.test(record.C_ as string) ||
    !isAmount(record.amount) ||
    (record.dleq !== undefined && !isDleq(record.dleq))
  ) {
    throw new Error('conditional keyset NUT-09 signature is invalid')
  }
  return record as unknown as SerializedBlindedSignature
}

function decodeDenominationKeys(value: unknown): Readonly<Record<string, string>> {
  const record = exactRecord(value, 'conditional keyset public keys')
  const entries = Object.entries(record)
  if (entries.length === 0 || entries.length > 64)
    throw new Error('conditional keyset public keys are invalid')
  const keys: Record<string, string> = {}
  for (const [amount, publicKey] of entries) {
    if (!/^[1-9][0-9]{0,19}$/.test(amount) || BigInt(amount) > 18_446_744_073_709_551_615n) {
      throw new Error('conditional keyset denomination is invalid')
    }
    if (typeof publicKey !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(publicKey)) {
      throw new Error('conditional keyset public key is invalid')
    }
    try {
      secp256k1.Point.fromHex(publicKey)
    } catch {
      throw new Error('conditional keyset public key is invalid')
    }
    keys[amount] = publicKey
  }
  return Object.freeze(keys)
}

function requireCleanProductOutcomeCollection(value: unknown): string {
  const collection = requireText(value, 'conditional keyset outcome collection', 1_024)
  const members = collection.split('|')
  if (
    members.length > 8 ||
    new Set(members).size !== members.length ||
    members.some(
      (member) =>
        member.length === 0 ||
        member !== member.trim() ||
        new TextEncoder().encode(member).byteLength > 256,
    )
  ) {
    throw new Error('conditional keyset outcome collection syntax is invalid')
  }
  return collection
}

function requireSeed(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 64)
    throw new Error('conditional keyset discovery seed is invalid')
  return value.slice()
}

function requireV2KeysetId(value: unknown): string {
  if (typeof value !== 'string' || !/^01[0-9a-f]{64}$/.test(value))
    throw new Error('conditional keyset id is invalid')
  return value
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new Error(`${label} is invalid`)
  return value
}

function requireText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes
  )
    throw new Error(`${label} is invalid`)
  return value
}

function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${label} is invalid`)
  return value as number
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  return value == null ? null : requireBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label)
}

function isAmount(value: unknown): boolean {
  try {
    Amount.from(value as never)
    return true
  } catch {
    return false
  }
}

function equalAmounts(left: unknown, right: unknown): boolean {
  try {
    return Amount.from(left as never).equals(Amount.from(right as never))
  } catch {
    return false
  }
}

function isPositiveAmount(amount: unknown): boolean {
  try {
    return !Amount.from(amount as never).isZero()
  } catch {
    return false
  }
}

function isDleq(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length >= 2 &&
    keys.length <= 3 &&
    keys.every((key) => key === 's' || key === 'e' || key === 'r') &&
    typeof value.s === 'string' &&
    typeof value.e === 'string' &&
    (value.r === undefined || typeof value.r === 'string')
  )
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  if (
    Object.keys(value).length < required.length ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} contains foreign or missing fields`)
  }
}
