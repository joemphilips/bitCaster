import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { canonicalizeTokenImportMintUrl } from './tokenImportValidation.ts'
import type { PersistedRegisteredDlcConditionAuthority } from './managedConditionInventory.ts'

const utf8 = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_ANNOUNCEMENT_BYTES = 16_384
const MAX_ORACLES = 32

export interface VerifiedCtfEnumAnnouncement {
  readonly eventId: string
  readonly orderedOutcomes: readonly string[]
  readonly oraclePublicKey: string
  readonly noncePoint: string
  readonly announcementIdentity: string
  readonly descriptorHex: string
}

export interface VerifiedCtfConditionRegistration {
  readonly normalizedMint: string
  readonly conditionId: string
  readonly canonicalParentCollectionId: null
  readonly unit: 'msat'
  readonly eventId: string
  readonly outcomes: readonly string[]
  readonly threshold: number
  readonly oracles: readonly {
    readonly oraclePublicKey: string
    readonly noncePoint: string
    readonly announcementIdentity: string
  }[]
}

/** Verify public DLC bytes. A valid signature does not establish intended registration. */
export function verifyCtfEnumAnnouncement(raw: unknown): VerifiedCtfEnumAnnouncement {
  if (
    typeof raw !== 'string' ||
    raw.length > MAX_ANNOUNCEMENT_BYTES * 2 ||
    !/^(?:[0-9a-f]{2})+$/.test(raw)
  )
    throw new Error('CTF announcement encoding is invalid')
  const bytes = hexToBytes(raw)
  const outer = new Reader(bytes)
  const body = outer.tlv(55332)
  outer.end()
  const signature = body.take(64)
  const pubkey = body.take(32)
  const eventBytes = body.remaining()
  const event = body.tlv(55330)
  body.end()
  if (event.uint(2) !== 1) throw new Error('CTF enum announcement requires one nonce')
  const nonce = event.take(32)
  // Validate curve points even though the nonce is not used by the announcement signature.
  schnorr.utils.lift_x(BigInt(`0x${bytesToHex(pubkey)}`))
  schnorr.utils.lift_x(BigInt(`0x${bytesToHex(nonce)}`))
  event.uint(4)
  const descriptor = event.tlv(55302)
  const descriptorBytes = descriptor.remaining()
  const count = descriptor.uint(2)
  if (count < 2 || count > 8) throw new Error('CTF enum outcome count is invalid')
  const outcomes = Array.from({ length: count }, () => descriptor.text(191))
  requireUniverse(outcomes)
  descriptor.end()
  const eventId = event.text(4096)
  if (!eventId) throw new Error('CTF event id is empty')
  event.end()
  if (!schnorr.verify(signature, taggedHash('DLC/oracle/announcement/v0', eventBytes), pubkey))
    throw new Error('CTF announcement signature is invalid')
  return Object.freeze({
    eventId,
    orderedOutcomes: Object.freeze(outcomes),
    oraclePublicKey: bytesToHex(pubkey),
    noncePoint: bytesToHex(nonce),
    announcementIdentity: bytesToHex(sha256(bytes)),
    descriptorHex: bytesToHex(descriptorBytes),
  })
}

/** The configured mint supplies registration policy; announcements authenticate descriptors. */
export function verifyCtfConditionRegistration(input: {
  readonly condition: unknown
  readonly mintUrl: string
  readonly conditionId: string
  readonly allowInsecureLoopbackHttp: boolean
  readonly expected?: PersistedRegisteredDlcConditionAuthority | VerifiedCtfConditionRegistration
}): VerifiedCtfConditionRegistration {
  const normalizedMint = canonicalizeTokenImportMintUrl(
    input.mintUrl,
    input.allowInsecureLoopbackHttp,
  )
  if (!/^[0-9a-f]{64}$/.test(input.conditionId)) throw new Error('CTF condition id is invalid')
  const condition = record(input.condition)
  const parent = condition.parent_collection_id
  if (
    condition.condition_id !== input.conditionId ||
    condition.collateral !== 'msat' ||
    (condition.condition_type !== undefined && condition.condition_type !== 'enum') ||
    (parent !== undefined && parent !== null && parent !== '0'.repeat(64))
  )
    throw new Error('CTF registration binding is invalid')
  if (
    !Array.isArray(condition.announcements) ||
    condition.announcements.length < 1 ||
    condition.announcements.length > MAX_ORACLES
  )
    throw new Error('CTF oracle count is invalid')
  const announcements = condition.announcements.map(verifyCtfEnumAnnouncement)
  const first = announcements[0]!
  const threshold = condition.threshold
  if (
    !Number.isSafeInteger(threshold) ||
    (threshold as number) < 1 ||
    (threshold as number) > announcements.length
  )
    throw new Error('CTF threshold is invalid')
  if (
    new Set(announcements.map((a) => a.oraclePublicKey)).size !== announcements.length ||
    announcements.some(
      (a) => a.eventId !== first.eventId || a.descriptorHex !== first.descriptorHex,
    )
  )
    throw new Error('CTF announcements disagree')
  const conditionId = bytesToHex(
    taggedHash(
      'Cashu_condition_id',
      concatBytes(
        ...announcements
          .map((a) => a.oraclePublicKey)
          .sort()
          .map(hexToBytes),
        utf8.encode(first.eventId),
        Uint8Array.of(first.orderedOutcomes.length),
      ),
    ),
  )
  if (conditionId !== input.conditionId) throw new Error('CTF announcement condition is foreign')
  const authority: VerifiedCtfConditionRegistration = Object.freeze({
    normalizedMint,
    conditionId,
    canonicalParentCollectionId: null,
    unit: 'msat',
    eventId: first.eventId,
    outcomes: first.orderedOutcomes,
    threshold: threshold as number,
    oracles: Object.freeze(
      announcements.map((a) =>
        Object.freeze({
          oraclePublicKey: a.oraclePublicKey,
          noncePoint: a.noncePoint,
          announcementIdentity: a.announcementIdentity,
        }),
      ),
    ),
  })
  if (input.expected !== undefined) assertSameRegistration(input.expected, authority)
  return authority
}

export function encodeMintOutcomeCollection(
  universe: readonly string[],
  members: readonly string[],
): string {
  requireUniverse(universe)
  const selected = new Set(members)
  if (
    !members.length ||
    selected.size !== members.length ||
    members.length >= universe.length ||
    members.some((member) => !universe.includes(member))
  )
    throw new Error('CTF collection members are invalid')
  return universe.filter((member) => selected.has(member)).join('|')
}

export function decodeMintOutcomeCollection(
  universe: readonly string[],
  wire: string,
): readonly string[] {
  const members = wire.split('|')
  if (encodeMintOutcomeCollection(universe, members) !== wire)
    throw new Error('CTF collection wire order is invalid')
  return members
}

function assertSameRegistration(
  expected: PersistedRegisteredDlcConditionAuthority | VerifiedCtfConditionRegistration,
  actual: VerifiedCtfConditionRegistration,
): void {
  const oracleIds = (value: typeof expected) =>
    value.oracles
      .map((o) => `${o.oraclePublicKey}:${o.noncePoint}:${o.announcementIdentity}`)
      .sort()
  if (
    expected.normalizedMint !== actual.normalizedMint ||
    expected.conditionId !== actual.conditionId ||
    expected.canonicalParentCollectionId !== actual.canonicalParentCollectionId ||
    expected.unit !== actual.unit ||
    expected.eventId !== actual.eventId ||
    expected.threshold !== actual.threshold ||
    JSON.stringify(expected.outcomes) !== JSON.stringify(actual.outcomes) ||
    JSON.stringify(oracleIds(expected)) !== JSON.stringify(oracleIds(actual))
  )
    throw new Error('CTF registration changed from intended authority')
}

function requireUniverse(universe: readonly string[]): void {
  if (
    universe.length < 2 ||
    universe.length > 8 ||
    new Set(universe).size !== universe.length ||
    universe.some((value) => !/^[A-Za-z0-9]{1,191}$/.test(value))
  )
    throw new Error('CTF product outcome universe is invalid')
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('CTF registration is invalid')
  return value as Record<string, unknown>
}
function taggedHash(tag: string, payload: Uint8Array): Uint8Array {
  const hash = sha256(utf8.encode(tag))
  return sha256(concatBytes(hash, hash, payload))
}
class Reader {
  private offset = 0
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }
  take(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.bytes.length - this.offset)
      throw new Error('CTF announcement is truncated')
    const result = this.bytes.slice(this.offset, this.offset + count)
    this.offset += count
    return result
  }
  uint(count: number): number {
    let value = 0
    for (const byte of this.take(count)) value = value * 256 + byte
    if (!Number.isSafeInteger(value)) throw new Error('CTF integer is oversized')
    return value
  }
  bigSize(): number {
    const tag = this.uint(1)
    if (tag < 253) return tag
    const value = this.uint(tag === 253 ? 2 : tag === 254 ? 4 : 8)
    if (value < (tag === 253 ? 253 : tag === 254 ? 65536 : 4294967296))
      throw new Error('CTF BigSize is not canonical')
    return value
  }
  tlv(type: number): Reader {
    if (this.bigSize() !== type) throw new Error('CTF TLV type is invalid')
    return new Reader(this.take(this.bigSize()))
  }
  text(limit: number): string {
    const length = this.bigSize()
    if (length > limit) throw new Error('CTF text is oversized')
    return decoder.decode(this.take(length))
  }
  remaining(): Uint8Array {
    return this.bytes.slice(this.offset)
  }
  end(): void {
    if (this.offset !== this.bytes.length) throw new Error('CTF TLV has trailing bytes')
  }
}
