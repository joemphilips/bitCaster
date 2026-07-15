import {
  Amount,
  pointFromHex,
  pointFromHexG1,
  type Proof,
} from '@cashu/cashu-ts'

const SECRET_MAX_LENGTH = 16_384
const WITNESS_MAX_LENGTH = 16_384
const PREIMAGE_MAX_LENGTH = 4_096
const WITNESS_SIGNATURE_LIMIT = 64

type CashuProofCurve = 'secp256k1' | 'bls12-381'
type P2pkSigFlag = 'SIG_INPUTS' | 'SIG_ALL'
type P2pkTag = readonly string[]

const P2PK_TAG_KEYS = new Set([
  'locktime',
  'pubkeys',
  'n_sigs',
  'refund',
  'n_sigs_refund',
  'sigflag',
])

export interface StrictP2pkCondition {
  pubkeys: readonly string[]
  requiredSignatures: number
  locktime: number | null
  refundPubkeys: readonly string[]
  requiredRefundSignatures: number
  sigFlag: P2pkSigFlag
  additionalTags: readonly (readonly string[])[]
}

export interface AtomicSwapP2pkProofBinding {
  lockerPubkey: string
  counterpartyPubkey: string
  locktime: number
}

/** Decode one exact runtime Cashu bearer artifact with no client-local fields. */
export function decodeStrictCashuProofArtifact(value: unknown): Proof {
  const proof = requireRecord(value, 'Cashu proof')
  requireExactFields(
    proof,
    ['id', 'amount', 'secret', 'C'],
    ['dleq', 'p2pk_e', 'witness'],
  )
  const { id, curve } = requireKeysetId(proof.id)
  const decoded: Proof = {
    id,
    amount: requirePositiveAmount(proof.amount),
    secret: requireText(proof.secret, 'proof secret', SECRET_MAX_LENGTH),
    C: requireCurvePoint(proof.C, curve, 'proof signature'),
    ...(proof.dleq === undefined
      ? {}
      : { dleq: requireDleq(proof.dleq, curve) }),
    ...(proof.p2pk_e === undefined
      ? {}
      : {
          p2pk_e: requireCurvePoint(
            proof.p2pk_e,
            'secp256k1',
            'proof P2PK E',
          ),
        }),
    ...(proof.witness === undefined
      ? {}
      : { witness: requireWitness(proof.witness) }),
  }
  return decoded
}

/** Boolean form for persisted-record validators that must fail closed. */
export function isStrictCashuProofArtifact(value: unknown): boolean {
  try {
    decodeStrictCashuProofArtifact(value)
    return true
  } catch {
    return false
  }
}

/** Decode an exact Cashu proof whose secret is a valid NUT-11 P2PK condition. */
export function decodeStrictP2pkCashuProofArtifact(value: unknown): Proof {
  return decodeStrictP2pkProofAndCondition(value).proof
}

function decodeStrictP2pkProofAndCondition(value: unknown): {
  proof: Proof
  condition: StrictP2pkCondition
} {
  const proof = decodeStrictCashuProofArtifact(value)
  const condition = decodeStrictP2pkCondition(proof.secret)
  if (proof.witness !== undefined) requireP2pkWitness(proof.witness)
  return { proof, condition }
}

export function isStrictP2pkCashuProofArtifact(value: unknown): boolean {
  try {
    decodeStrictP2pkCashuProofArtifact(value)
    return true
  } catch {
    return false
  }
}

/** Decode exact NUT-11 P2PK spending semantics without evaluating spendability. */
export function decodeStrictP2pkCondition(secret: string): StrictP2pkCondition {
  const { body, tags } = requireP2pkSecret(secret)
  const { pubkeys, refundPubkeys } = requireP2pkPubkeys(body.data, tags)
  const locktime = optionalPositiveIntegerTag(tags, 'locktime')
  const requiredSignatures = optionalPositiveIntegerTag(tags, 'n_sigs') ?? 1
  const requiredRefundSignatures =
    optionalPositiveIntegerTag(tags, 'n_sigs_refund') ??
    (refundPubkeys.length === 0 ? 0 : 1)
  const condition = {
    pubkeys,
    requiredSignatures,
    locktime,
    refundPubkeys,
    requiredRefundSignatures,
    sigFlag: requireP2pkSigFlag(tags),
    additionalTags: tags.filter(([key]) => !P2PK_TAG_KEYS.has(key)),
  }
  requireP2pkThresholds(condition)
  return condition
}

function requireP2pkSecret(secret: string): {
  body: Record<string, unknown>
  tags: readonly P2pkTag[]
} {
  const parsed = parseJson(secret, 'proof P2PK secret')
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'P2PK') {
    throw new Error('proof P2PK secret is invalid')
  }
  const body = requireRecord(parsed[1], 'proof P2PK secret')
  requireExactFields(body, ['nonce', 'data'], ['tags'])
  requireLowerHex(body.nonce, 64, 'proof P2PK nonce')
  return { body, tags: requireP2pkTags(body.tags) }
}

function requireP2pkPubkeys(
  primary: unknown,
  tags: readonly P2pkTag[],
): { pubkeys: string[]; refundPubkeys: string[] } {
  const primaryPubkey = requireP2pkPubkey(primary, 'proof P2PK pubkey')
  const pubkeys = requireUniqueP2pkPubkeys(
    [primaryPubkey, ...tagValues(tags, 'pubkeys')],
    'proof P2PK pubkeys',
  )
  const refundPubkeys = requireUniqueP2pkPubkeys(
    tagValues(tags, 'refund'),
    'proof P2PK refund pubkeys',
  )
  if (pubkeys.length + refundPubkeys.length > 10) {
    throw new Error('proof P2PK has too many pubkeys')
  }
  return { pubkeys, refundPubkeys }
}

function requireP2pkSigFlag(tags: readonly P2pkTag[]): P2pkSigFlag {
  const sigFlag = optionalScalarTag(tags, 'sigflag') ?? 'SIG_INPUTS'
  if (sigFlag !== 'SIG_INPUTS' && sigFlag !== 'SIG_ALL') {
    throw new Error('proof P2PK sigflag is invalid')
  }
  return sigFlag
}

/** Fail-closed check for the exact 2-of-2 proof shape emitted by atomic-swap locking. */
export function isStrictAtomicSwapP2pkProofArtifact(
  value: unknown,
  binding: AtomicSwapP2pkProofBinding,
): boolean {
  try {
    const rawProof = requireRecord(value, 'Cashu proof')
    const { condition } = decodeStrictP2pkProofAndCondition(value)
    const expectedPubkeys = requireUniqueP2pkPubkeys(
      [binding.lockerPubkey, binding.counterpartyPubkey],
      'atomic swap pubkeys',
    )
    const expectedLocktime = requirePositiveSafeInteger(
      binding.locktime,
      'atomic swap locktime',
    )
    return (
      rawProof.witness === undefined &&
      rawProof.p2pk_e === undefined &&
      sameStrings(condition.pubkeys, expectedPubkeys) &&
      condition.requiredSignatures === 2 &&
      condition.locktime === expectedLocktime &&
      sameStrings(condition.refundPubkeys, [expectedPubkeys[0]]) &&
      condition.requiredRefundSignatures === 1 &&
      condition.sigFlag === 'SIG_INPUTS' &&
      condition.additionalTags.length === 0
    )
  } catch {
    return false
  }
}

function requireP2pkTags(value: unknown): readonly P2pkTag[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('proof P2PK tags are invalid')
  const tags = value.map((value) => requireP2pkTag(value))
  const seenKnown = new Set<string>()
  for (const [key] of tags) {
    if (P2PK_TAG_KEYS.has(key) && seenKnown.has(key)) {
      throw new Error(`proof P2PK ${key} tag is duplicated`)
    }
    if (P2PK_TAG_KEYS.has(key)) seenKnown.add(key)
  }
  return tags
}

function requireP2pkTag(value: unknown): P2pkTag {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== 'string' || part.length === 0)
  ) {
    throw new Error('proof P2PK tag is invalid')
  }
  return value
}

function tagValues(tags: readonly P2pkTag[], key: string): string[] {
  const tag = tags.find(([candidate]) => candidate === key)
  if (tag === undefined) return []
  if (tag.length < 2) throw new Error(`proof P2PK ${key} tag is invalid`)
  return tag.slice(1)
}

function optionalScalarTag(
  tags: readonly P2pkTag[],
  key: string,
): string | null {
  const tag = tags.find(([candidate]) => candidate === key)
  if (tag === undefined) return null
  if (tag.length !== 2) throw new Error(`proof P2PK ${key} tag is invalid`)
  return tag[1]
}

function optionalPositiveIntegerTag(
  tags: readonly P2pkTag[],
  key: string,
): number | null {
  const value = optionalScalarTag(tags, key)
  if (value === null) return null
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`proof P2PK ${key} tag is invalid`)
  }
  return requirePositiveSafeInteger(Number(value), `proof P2PK ${key}`)
}

function requireUniqueP2pkPubkeys(
  values: readonly unknown[],
  label: string,
): string[] {
  const pubkeys = values.map((value) => requireP2pkPubkey(value, label))
  const xOnly = pubkeys.map((pubkey) => pubkey.slice(-64))
  if (new Set(xOnly).size !== xOnly.length) {
    throw new Error(`${label} contain duplicates`)
  }
  return pubkeys
}

function requireP2pkPubkey(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} are invalid`)
  const normalized = value.toLowerCase()
  const compressed =
    /^[0-9a-f]{64}$/.test(normalized) ? `02${normalized}` : normalized
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(compressed)) {
    throw new Error(`${label} are invalid`)
  }
  try {
    pointFromHex(compressed)
  } catch {
    throw new Error(`${label} are invalid`)
  }
  return compressed
}

function requireP2pkThresholds(condition: {
  pubkeys: readonly string[]
  refundPubkeys: readonly string[]
  requiredSignatures: number
  requiredRefundSignatures: number
  locktime: number | null
}): void {
  if (condition.requiredSignatures > condition.pubkeys.length) {
    throw new Error('proof P2PK signature threshold is invalid')
  }
  if (condition.refundPubkeys.length > 0 && condition.locktime === null) {
    throw new Error('proof P2PK refund requires a locktime')
  }
  if (
    (condition.refundPubkeys.length === 0 &&
      condition.requiredRefundSignatures !== 0) ||
    condition.requiredRefundSignatures > condition.refundPubkeys.length
  ) {
    throw new Error('proof P2PK refund threshold is invalid')
  }
}

function requireP2pkWitness(value: unknown): void {
  const parsed =
    typeof value === 'string' ? parseJson(value, 'proof witness') : value
  const witness = requireRecord(parsed, 'proof witness')
  requireWitnessRecord(witness)
  if (Object.hasOwn(witness, 'preimage')) {
    throw new Error('proof P2PK witness cannot contain a preimage')
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} is invalid`)
  }
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid`)
  }
  return value as number
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function requireKeysetId(value: unknown): {
  id: string
  curve: CashuProofCurve
} {
  if (typeof value !== 'string') throw new Error('proof keyset id is invalid')
  if (/^00[0-9a-f]{14}$/.test(value)) {
    return { id: value, curve: 'secp256k1' }
  }
  if (/^01[0-9a-f]{64}$/.test(value)) {
    return { id: value, curve: 'secp256k1' }
  }
  if (/^02[0-9a-f]{64}$/.test(value)) {
    return {
      id: value,
      curve: 'bls12-381',
    }
  }
  if (/^[0-9a-f]+$/i.test(value)) {
    throw new Error('proof keyset id is invalid')
  }
  if (isCanonicalLegacyKeysetId(value)) {
    return { id: value, curve: 'secp256k1' }
  }
  throw new Error('proof keyset id is invalid')
}

function isCanonicalLegacyKeysetId(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{12}$/.test(value)) return false
  try {
    return btoa(atob(value)) === value
  } catch {
    return false
  }
}

function requirePositiveAmount(value: unknown): Amount {
  let amount: Amount
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Amount
  ) {
    amount = Amount.from(value)
  } else {
    const record = requireRecord(value, 'proof amount')
    requireExactFields(record, ['value'])
    if (typeof record.value !== 'bigint') {
      throw new Error('proof amount is invalid')
    }
    amount = Amount.from(record.value)
  }
  if (amount.toBigInt() < 1n) {
    throw new Error('proof amount is invalid')
  }
  return amount
}

function requireCurvePoint(
  value: unknown,
  curve: CashuProofCurve,
  label: string,
): string {
  const pattern =
    curve === 'secp256k1' ? /^(?:02|03)[0-9a-f]{64}$/ : /^[0-9a-f]{96}$/
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  try {
    if (curve === 'secp256k1') pointFromHex(value)
    else pointFromHexG1(value)
  } catch {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireDleq(
  value: unknown,
  curve: CashuProofCurve,
): NonNullable<Proof['dleq']> {
  if (curve === 'bls12-381') {
    throw new Error('BLS proof DLEQ is invalid')
  }
  const dleq = requireRecord(value, 'proof DLEQ')
  requireExactFields(dleq, ['e', 's'], ['r'])
  return {
    e: requireLowerHex(dleq.e, 64, 'proof DLEQ e'),
    s: requireLowerHex(dleq.s, 64, 'proof DLEQ s'),
    ...(dleq.r === undefined
      ? {}
      : { r: requireLowerHex(dleq.r, 64, 'proof DLEQ r') }),
  }
}

function requireWitness(value: unknown): NonNullable<Proof['witness']> {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > WITNESS_MAX_LENGTH) {
      throw new Error('proof witness is invalid')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('proof witness is invalid')
    }
    requireWitnessRecord(parsed)
    return value
  }
  return requireWitnessRecord(value)
}

function requireWitnessRecord(
  value: unknown,
): Exclude<NonNullable<Proof['witness']>, string> {
  const witness = requireRecord(value, 'proof witness')
  requireExactFields(witness, [], ['preimage', 'signatures'])
  const signatures =
    witness.signatures === undefined
      ? undefined
      : requireWitnessSignatures(witness.signatures)
  if (witness.preimage === undefined) {
    return signatures === undefined ? {} : { signatures }
  }
  return {
    preimage: requireText(
      witness.preimage,
      'proof witness preimage',
      PREIMAGE_MAX_LENGTH,
    ),
    ...(signatures === undefined ? {} : { signatures }),
  }
}

function requireWitnessSignatures(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > WITNESS_SIGNATURE_LIMIT) {
    throw new Error('proof witness signatures are invalid')
  }
  return value.map((signature) =>
    requireLowerHex(signature, 128, 'proof witness signature'),
  )
}

function requireLowerHex(
  value: unknown,
  length: number,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length !== length ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    required.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error('Cashu proof has invalid fields')
  }
}
