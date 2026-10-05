import { v2 as nip44 } from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { announcementContentFromTlv } from './oracleAnnouncementEncoding.ts'
import { deriveDlcConditionId } from './managedConditionInventory.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'
import { readSignedOracleEvent } from './oracleResolutionExplanation.ts'
import {
  snapshotOraclePublicationRecord,
  type OraclePublicationRecord,
} from './oraclePublication.ts'
import { NIP44_V2_PAYLOAD_CHARS_MAX, NIP44_V2_PAYLOAD_CHARS_MIN } from './nip17PaymentRequest.ts'

export const ORACLE_BACKUP_PLAINTEXT_BYTES_MAX = 65_535
export const ORACLE_BACKUP_KIND = 30_078
export const ORACLE_BACKUP_TAG_PREFIX = 'bitcaster/oracle-backup/v1/'

/** Private Rust/WASM boundary. Do not put this value in logs or public projections. */
export interface OraclePrivateAuthority {
  readonly schemaVersion: 1
  readonly announcementTlvHex: string
  readonly announcementEventJson: string
  readonly nonceScalarHex: string | null
  readonly signedOutcome: string | null
  readonly attestationHex: string | null
  readonly attestationEventJson: string | null
  readonly publicationRecordJson: string | null
}

export interface OracleBackupRecord {
  readonly schemaVersion: 1
  readonly conditionId: string
  readonly oraclePubkey: string
  readonly oracleEventId: string
  readonly authority: OraclePrivateAuthority
  readonly destinations: {
    readonly mintUrl: string
    readonly engineUrl: string
    readonly relayUrls: readonly string[]
  }
}

/** Use the core Rust validator. A decoder or a storage import is insufficient. */
export interface OracleEnumAuthoritySummary {
  readonly eventId: string
  readonly oraclePubkey: string
  readonly outcomes: readonly string[]
  readonly noncePoint: string
}

export interface OracleBackupValidator {
  validateAuthority(
    privateDtoJson: string,
    expectedOraclePubkey: string,
  ): Promise<OracleEnumAuthoritySummary>
}

export class OracleBackupError extends Error {
  readonly reason: 'invalid-record' | 'invalid-envelope' | 'oversized'
  constructor(reason: OracleBackupError['reason']) {
    super(`Private oracle backup: ${reason}.`)
    this.name = 'OracleBackupError'
    this.reason = reason
  }
}

/** Check the full encoding before any irreversible creation or relay effect. */
export async function encodeOracleBackup(
  input: unknown,
  validator: OracleBackupValidator,
): Promise<string> {
  try {
    const bounded = boundedJson(input)
    const record = snapshotRecord(JSON.parse(bounded))
    const summary = await validator.validateAuthority(
      JSON.stringify(record.authority),
      record.oraclePubkey,
    )
    if (
      summary.eventId !== record.oracleEventId ||
      summary.oraclePubkey !== record.oraclePubkey ||
      !hex(summary.noncePoint, 64) ||
      record.conditionId !==
        deriveDlcConditionId({
          eventId: summary.eventId,
          outcomeCount: summary.outcomes.length,
          oraclePublicKeys: [summary.oraclePubkey],
        })
    )
      throw new Error()
    validatePublication(record, summary.outcomes)
    return boundedJson(record)
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === 'oversized') throw error
    // Crypto/helper errors can contain private input. Return only a fixed diagnostic.
    throw new OracleBackupError('invalid-record')
  }
}

export async function createOracleBackupEvent(input: {
  readonly record: OracleBackupRecord
  readonly privateKey: Uint8Array
  readonly createdAt: number
  readonly validator: OracleBackupValidator
}): Promise<Event> {
  const plaintext = await encodeOracleBackup(input.record, input.validator)
  try {
    if (getPublicKey(input.privateKey) !== input.record.oraclePubkey || !timestamp(input.createdAt))
      throw new Error()
    const record = JSON.parse(plaintext) as OracleBackupRecord
    return finalizeEvent(
      {
        kind: ORACLE_BACKUP_KIND,
        created_at: input.createdAt,
        tags: backupTags(record),
        content: nip44.encrypt(
          plaintext,
          nip44.utils.getConversationKey(input.privateKey, record.oraclePubkey),
        ),
      },
      input.privateKey,
    )
  } catch {
    throw new OracleBackupError('invalid-envelope')
  }
}

export async function decryptOracleBackupEvent(input: {
  readonly event: unknown
  readonly privateKey: Uint8Array
  readonly validator: OracleBackupValidator
  readonly expectedAnnouncementEventId?: string
}): Promise<OracleBackupRecord> {
  try {
    const event = readOracleBackupEnvelope(input.event, getPublicKey(input.privateKey))
    if (
      input.expectedAnnouncementEventId !== undefined &&
      event.tags[0][1] !== ORACLE_BACKUP_TAG_PREFIX + input.expectedAnnouncementEventId
    )
      throw new Error()
    const plaintext = nip44.decrypt(
      event.content,
      nip44.utils.getConversationKey(input.privateKey, event.pubkey),
    )
    if (new TextEncoder().encode(plaintext).length > ORACLE_BACKUP_PLAINTEXT_BYTES_MAX)
      throw new Error()
    const encoded = await encodeOracleBackup(JSON.parse(plaintext), input.validator)
    const record = JSON.parse(encoded) as OracleBackupRecord
    if (
      record.oraclePubkey !== event.pubkey ||
      JSON.stringify(event.tags) !== JSON.stringify(backupTags(record))
    )
      throw new Error()
    return record
  } catch {
    throw new OracleBackupError('invalid-envelope')
  }
}

/** Authenticate and bound relay input before NIP-44 decoding or private parsing. */
export function readOracleBackupEnvelope(value: unknown, expectedAuthor: string): Event {
  try {
    if (
      !object(value) ||
      !keys(value, 'content,created_at,id,kind,pubkey,sig,tags') ||
      value.kind !== ORACLE_BACKUP_KIND ||
      value.pubkey !== expectedAuthor ||
      !hex(value.id, 64) ||
      !hex(value.pubkey, 64) ||
      !hex(value.sig, 128) ||
      !timestamp(value.created_at) ||
      typeof value.content !== 'string' ||
      value.content.length < NIP44_V2_PAYLOAD_CHARS_MIN ||
      value.content.length > NIP44_V2_PAYLOAD_CHARS_MAX ||
      !Array.isArray(value.tags) ||
      value.tags.length !== 2 ||
      !Array.isArray(value.tags[0]) ||
      value.tags[0].length !== 2 ||
      value.tags[0][0] !== 'd' ||
      typeof value.tags[0][1] !== 'string' ||
      !hex(value.tags[0][1].slice(ORACLE_BACKUP_TAG_PREFIX.length), 64) ||
      !value.tags[0][1].startsWith(ORACLE_BACKUP_TAG_PREFIX) ||
      !Array.isArray(value.tags[1]) ||
      value.tags[1].length !== 2 ||
      value.tags[1][0] !== 'v' ||
      value.tags[1][1] !== '1'
    )
      throw new Error()
    // Do not inherit nostr-tools' verification-cache symbol from an untrusted object.
    const event = JSON.parse(JSON.stringify(value)) as Event
    if (!verifyEvent(event)) throw new Error()
    return event
  } catch {
    throw new OracleBackupError('invalid-envelope')
  }
}

function snapshotRecord(value: unknown): OracleBackupRecord {
  if (
    !object(value) ||
    !keys(value, 'authority,conditionId,destinations,oracleEventId,oraclePubkey,schemaVersion') ||
    value.schemaVersion !== 1 ||
    !hex(value.conditionId, 64) ||
    !hex(value.oraclePubkey, 64) ||
    !text(value.oracleEventId, 512) ||
    !object(value.destinations) ||
    !keys(value.destinations, 'engineUrl,mintUrl,relayUrls')
  )
    throw new Error()
  const authority = snapshotOraclePrivateAuthority(value.authority)
  const announcement = readSignedOracleEvent(authority.announcementEventJson, 88)
  if (
    announcement.pubkey !== value.oraclePubkey ||
    announcement.content !== announcementContentFromTlv(authority.announcementTlvHex)
  )
    throw new Error()
  const destinations = value.destinations
  if (
    !httpUrl(destinations.mintUrl) ||
    !httpUrl(destinations.engineUrl) ||
    !Array.isArray(destinations.relayUrls) ||
    destinations.relayUrls.some((url) => !text(url, 2_048))
  )
    throw new Error()
  const relayUrls = normalizeNostrRelayUrls(destinations.relayUrls as string[])
  if (JSON.stringify(relayUrls) !== JSON.stringify(destinations.relayUrls)) throw new Error()
  return {
    schemaVersion: 1,
    conditionId: value.conditionId,
    oraclePubkey: value.oraclePubkey,
    oracleEventId: value.oracleEventId,
    authority,
    destinations: { mintUrl: destinations.mintUrl, engineUrl: destinations.engineUrl, relayUrls },
  }
}

/** Check the DTO shape only. Require core cryptographic validation before use. */
export function snapshotOraclePrivateAuthority(value: unknown): OraclePrivateAuthority {
  boundedJson(value)
  if (
    !object(value) ||
    !keys(
      value,
      'announcementEventJson,announcementTlvHex,attestationEventJson,attestationHex,nonceScalarHex,publicationRecordJson,schemaVersion,signedOutcome',
    ) ||
    value.schemaVersion !== 1 ||
    !text(value.announcementEventJson, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX) ||
    !text(value.announcementTlvHex, 48 * 1_024) ||
    (value.nonceScalarHex !== null && !hex(value.nonceScalarHex, 64)) ||
    (value.signedOutcome !== null && !text(value.signedOutcome, 191)) ||
    (value.attestationHex !== null && !text(value.attestationHex, 48 * 1_024)) ||
    (value.attestationEventJson !== null &&
      !text(value.attestationEventJson, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX)) ||
    (value.publicationRecordJson !== null &&
      !text(value.publicationRecordJson, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX))
  )
    throw new Error()
  return structuredClone(value) as unknown as OraclePrivateAuthority
}

function validatePublication(record: OracleBackupRecord, outcomes: readonly string[]): void {
  const authority = record.authority
  if (authority.signedOutcome !== null && !outcomes.includes(authority.signedOutcome))
    throw new Error()
  if (authority.publicationRecordJson === null) {
    if (authority.nonceScalarHex === null) throw new Error()
    return
  }
  const input = JSON.parse(authority.publicationRecordJson)
  if (
    !object(input) ||
    !keys(
      input,
      'attestation,binding,chosenOutcome,engineEvidence,explanationEventJson,explanationRelayPublished,relayPublished',
    ) ||
    !object(input.binding) ||
    !keys(input.binding, 'announcementEventJson,conditionId,oracleEventId,oraclePubkey,outcomes') ||
    (input.attestation !== null &&
      (!object(input.attestation) || !keys(input.attestation, 'attestationHex,eventJson'))) ||
    (input.engineEvidence !== null &&
      (!object(input.engineEvidence) ||
        !keys(
          input.engineEvidence,
          'announcementEventId,attestationEventId,conditionId,oracleEventId,oraclePubkey,outcome',
        )))
  )
    throw new Error()
  const publication: OraclePublicationRecord = snapshotOraclePublicationRecord(
    input as unknown as OraclePublicationRecord,
  )
  if (
    publication.binding.conditionId !== record.conditionId ||
    publication.binding.oracleEventId !== record.oracleEventId ||
    publication.binding.oraclePubkey !== record.oraclePubkey ||
    publication.binding.announcementEventJson !== authority.announcementEventJson ||
    JSON.stringify(publication.binding.outcomes) !== JSON.stringify(outcomes) ||
    publication.chosenOutcome !== authority.signedOutcome ||
    (publication.attestation?.attestationHex ?? null) !== authority.attestationHex ||
    (publication.attestation?.eventJson ?? null) !== authority.attestationEventJson ||
    (authority.nonceScalarHex === null &&
      (publication.attestation === null || !publication.relayPublished))
  )
    throw new Error()
}

function backupTags(record: OracleBackupRecord): string[][] {
  return [
    [
      'd',
      ORACLE_BACKUP_TAG_PREFIX +
        readSignedOracleEvent(record.authority.announcementEventJson, 88).id,
    ],
    ['v', '1'],
  ]
}

function boundedJson(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new Error()
  if (new TextEncoder().encode(encoded).length > ORACLE_BACKUP_PLAINTEXT_BYTES_MAX)
    throw new OracleBackupError('oversized')
  return encoded
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected
}
function hex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    new TextEncoder().encode(value).length <= max
  )
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function httpUrl(value: unknown): value is string {
  if (!text(value, 2_048)) return false
  const url = new URL(value)
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password &&
    !url.hash
  )
}
