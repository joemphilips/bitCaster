import { v2 as nip44 } from 'nostr-tools/nip44'
import { parseOracleBackupWireJson } from './oracleBackupWireJson.ts'
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { announcementContentFromTlv } from './oracleAnnouncementEncoding.ts'
import { deriveDlcConditionId } from './managedConditionInventory.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'
import { readSignedOracleEvent } from './oracleResolutionExplanation.ts'
import {
  oraclePublicationTerminal,
  snapshotOraclePublicationRecord,
  type OraclePublicationRecord,
} from './oraclePublication.ts'
import { NIP44_V2_PAYLOAD_CHARS_MAX, NIP44_V2_PAYLOAD_CHARS_MIN } from './nip17PaymentRequest.ts'

import {
  ORACLE_BACKUP_MODEL_BYTES_MAX,
  compactOraclePrivateAuthority,
  expandOraclePrivateAuthority,
  type OraclePrivateAuthorityV2,
  type OracleBackupRecordV2,
  type OracleBackupWriteVersion,
} from './oracleBackupModel.ts'
export type {
  OraclePrivateAuthorityV2,
  OracleBackupRecordV2,
  OracleBackupWriteVersion,
} from './oracleBackupModel.ts'

export const ORACLE_BACKUP_PLAINTEXT_BYTES_MAX = 65_535
export const ORACLE_BACKUP_KIND = 30_078
export const ORACLE_BACKUP_TAG_PREFIX = 'bitcaster/oracle-backup/v1/'

/**
 * Normalized private publication-port view, not a transport DTO. Its historical
 * version-1 shape preserves consumer compatibility; use the wire codecs before
 * Rust/WASM transport. Never log it or put it in a public projection.
 */
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

/** Internal portable-record view. Wire v2 is decoded into this separately bounded model. */
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

/** Check the selected wire encoding before any irreversible creation or relay effect. */
export async function encodeOracleBackup(
  input: unknown,
  validator: OracleBackupValidator,
  options: { readonly writeVersion: OracleBackupWriteVersion } = { writeVersion: 1 },
): Promise<string> {
  try {
    assertWriteVersion(options.writeVersion)
    const maximum =
      options.writeVersion === 1 ? ORACLE_BACKUP_PLAINTEXT_BYTES_MAX : ORACLE_BACKUP_MODEL_BYTES_MAX
    const record = snapshotRecord(JSON.parse(boundedJson(input, maximum)), maximum)
    const wire =
      options.writeVersion === 1
        ? record
        : {
            ...record,
            schemaVersion: 2 as const,
            authority: compactOraclePrivateAuthority(record.authority),
          }
    const encoded = boundedJson(wire)
    const summary = await validator.validateAuthority(
      JSON.stringify(wire.authority),
      record.oraclePubkey,
    )
    validateSummary(record, summary)
    // Validate the original view too: compacting must not hide unknown keys or conflicts.
    validatePublication(record, summary.outcomes)
    return encoded
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === 'oversized') throw error
    throw new OracleBackupError('invalid-record')
  }
}

/** Decode bounded wire v1/v2 directly before deriving any redundant in-memory fields. */
export async function decodeOracleBackup(
  plaintext: string,
  validator: OracleBackupValidator,
): Promise<OracleBackupRecord> {
  try {
    if (typeof plaintext !== 'string') throw new Error()
    if (new TextEncoder().encode(plaintext).length > ORACLE_BACKUP_PLAINTEXT_BYTES_MAX)
      throw new OracleBackupError('oversized')
    const input = parseOracleBackupWireJson(plaintext)
    if (!object(input)) throw new Error()
    if (input.schemaVersion === 1) {
      const record = snapshotRecord(input)
      const summary = await validator.validateAuthority(
        JSON.stringify(record.authority),
        record.oraclePubkey,
      )
      validateSummary(record, summary)
      validatePublication(record, summary.outcomes)
      return record
    }
    const wire = snapshotCompactRecord(input)
    // The core sees the original compact authority, never an oversized reconstructed v1 DTO.
    const summary = await validator.validateAuthority(
      JSON.stringify(wire.authority),
      wire.oraclePubkey,
    )
    validateSummary(wire, summary)
    const authority = expandOraclePrivateAuthority(wire.authority, {
      conditionId: wire.conditionId,
      oracleEventId: summary.eventId,
      oraclePubkey: summary.oraclePubkey,
      outcomes: [...summary.outcomes],
      announcementEventJson: wire.authority.announcementEventJson,
    })
    const record = snapshotRecord(
      { ...wire, schemaVersion: 1, authority },
      ORACLE_BACKUP_MODEL_BYTES_MAX,
    )
    boundedJson(record, ORACLE_BACKUP_MODEL_BYTES_MAX)
    validatePublication(record, summary.outcomes)
    return record
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === 'oversized') throw error
    throw new OracleBackupError('invalid-record')
  }
}

/** Validate an internal publication-port model without imposing the historical v1 wire budget. */
export async function validateOracleBackupModel(
  input: unknown,
  validator: OracleBackupValidator,
): Promise<OracleBackupRecord> {
  try {
    const record = snapshotRecord(
      JSON.parse(boundedJson(input, ORACLE_BACKUP_MODEL_BYTES_MAX)),
      ORACLE_BACKUP_MODEL_BYTES_MAX,
    )
    await encodeOracleBackup(record, validator, { writeVersion: 2 })
    return record
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === 'oversized') throw error
    throw new OracleBackupError('invalid-record')
  }
}

/** Decode a bounded private-core wire DTO before deriving a publication port view. */
export async function decodeOraclePrivateAuthority(
  privateDtoJson: string,
  expectedOraclePubkey: string,
  validator: OracleBackupValidator,
): Promise<OraclePrivateAuthority> {
  try {
    if (
      typeof privateDtoJson !== 'string' ||
      new TextEncoder().encode(privateDtoJson).length > ORACLE_BACKUP_PLAINTEXT_BYTES_MAX
    )
      throw new OracleBackupError('oversized')
    const input = parseOracleBackupWireJson(privateDtoJson)
    const wire =
      object(input) && input.schemaVersion === 1
        ? snapshotAuthority(input, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX)
        : snapshotCompactAuthority(input)
    const summary = await validator.validateAuthority(privateDtoJson, expectedOraclePubkey)
    if (summary.oraclePubkey !== expectedOraclePubkey || !hex(summary.noncePoint, 64))
      throw new Error()
    const conditionId = deriveDlcConditionId({
      eventId: summary.eventId,
      outcomeCount: summary.outcomes.length,
      oraclePublicKeys: [summary.oraclePubkey],
    })
    const authority =
      wire.schemaVersion === 1
        ? wire
        : expandOraclePrivateAuthority(wire, {
            conditionId,
            oraclePubkey: summary.oraclePubkey,
            oracleEventId: summary.eventId,
            outcomes: [...summary.outcomes],
            announcementEventJson: wire.announcementEventJson,
          })
    const announcement = readSignedOracleEvent(authority.announcementEventJson, 88)
    if (
      announcement.pubkey !== expectedOraclePubkey ||
      announcement.content !== announcementContentFromTlv(authority.announcementTlvHex)
    )
      throw new Error()
    boundedJson(authority, ORACLE_BACKUP_MODEL_BYTES_MAX)
    validatePublication(
      {
        conditionId,
        oraclePubkey: expectedOraclePubkey,
        oracleEventId: summary.eventId,
        authority,
      },
      summary.outcomes,
    )
    return authority
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === 'oversized') throw error
    throw new OracleBackupError('invalid-record')
  }
}

/** Serialize a normalized authority for a version-aware core import/validation port. */
export async function encodeOraclePrivateAuthority(
  input: unknown,
  expectedOraclePubkey: string,
  validator: OracleBackupValidator,
  options: { readonly writeVersion: OracleBackupWriteVersion } = { writeVersion: 1 },
): Promise<string> {
  try {
    assertWriteVersion(options.writeVersion)
    const maximum =
      options.writeVersion === 1 ? ORACLE_BACKUP_PLAINTEXT_BYTES_MAX : ORACLE_BACKUP_MODEL_BYTES_MAX
    const authority = snapshotAuthority(input, maximum)
    const wire = options.writeVersion === 1 ? authority : compactOraclePrivateAuthority(authority)
    const encoded = boundedJson(wire)
    const summary = await validator.validateAuthority(encoded, expectedOraclePubkey)
    if (summary.oraclePubkey !== expectedOraclePubkey || !hex(summary.noncePoint, 64))
      throw new Error()
    const conditionId = deriveDlcConditionId({
      eventId: summary.eventId,
      outcomeCount: summary.outcomes.length,
      oraclePublicKeys: [summary.oraclePubkey],
    })
    validatePublication(
      {
        conditionId,
        oraclePubkey: expectedOraclePubkey,
        oracleEventId: summary.eventId,
        authority,
      },
      summary.outcomes,
    )
    return encoded
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === 'oversized') throw error
    throw new OracleBackupError('invalid-record')
  }
}

function validateSummary(
  record: Pick<OracleBackupRecord, 'oracleEventId' | 'oraclePubkey' | 'conditionId'>,
  summary: OracleEnumAuthoritySummary,
): void {
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
}

function assertWriteVersion(version: OracleBackupWriteVersion): void {
  if (version !== 1 && version !== 2) throw new Error()
}

export async function createOracleBackupEvent(input: {
  readonly record: OracleBackupRecord
  readonly privateKey: Uint8Array
  readonly createdAt: number
  readonly validator: OracleBackupValidator
  readonly writeVersion?: OracleBackupWriteVersion
}): Promise<Event> {
  const plaintext = await encodeOracleBackup(input.record, input.validator, {
    writeVersion: input.writeVersion ?? 1,
  })
  try {
    if (getPublicKey(input.privateKey) !== input.record.oraclePubkey || !timestamp(input.createdAt))
      throw new Error()
    const record = JSON.parse(plaintext) as OracleBackupRecord | OracleBackupRecordV2
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
    const wire = JSON.parse(plaintext) as OracleBackupRecord | OracleBackupRecordV2
    const record = await decodeOracleBackup(plaintext, input.validator)
    if (
      record.oraclePubkey !== event.pubkey ||
      JSON.stringify(event.tags) !== JSON.stringify(backupTags(wire))
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
      typeof value.tags[1][1] !== 'string' ||
      !/^[1-9][0-9]{0,8}$/.test(value.tags[1][1])
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

function snapshotRecord(
  value: unknown,
  maximum = ORACLE_BACKUP_PLAINTEXT_BYTES_MAX,
): OracleBackupRecord {
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
  const authority = snapshotAuthority(value.authority, maximum)
  const announcement = readSignedOracleEvent(authority.announcementEventJson, 88)
  if (
    announcement.pubkey !== value.oraclePubkey ||
    announcement.content !== announcementContentFromTlv(authority.announcementTlvHex)
  )
    throw new Error()
  const destinations = snapshotDestinations(value.destinations)
  return {
    schemaVersion: 1,
    conditionId: value.conditionId,
    oraclePubkey: value.oraclePubkey,
    oracleEventId: value.oracleEventId,
    authority,
    destinations,
  }
}

function snapshotCompactRecord(value: unknown): OracleBackupRecordV2 {
  if (
    !object(value) ||
    !keys(value, 'authority,conditionId,destinations,oracleEventId,oraclePubkey,schemaVersion') ||
    value.schemaVersion !== 2 ||
    !hex(value.conditionId, 64) ||
    !hex(value.oraclePubkey, 64) ||
    !text(value.oracleEventId, 512)
  )
    throw new Error()
  const authority = snapshotCompactAuthority(value.authority)
  const announcement = readSignedOracleEvent(authority.announcementEventJson, 88)
  if (
    announcement.pubkey !== value.oraclePubkey ||
    announcement.content !== announcementContentFromTlv(authority.announcementTlvHex)
  )
    throw new Error()
  return {
    schemaVersion: 2,
    conditionId: value.conditionId,
    oraclePubkey: value.oraclePubkey,
    oracleEventId: value.oracleEventId,
    authority,
    destinations: snapshotDestinations(value.destinations),
  }
}

function snapshotCompactAuthority(value: unknown): OraclePrivateAuthorityV2 {
  if (
    !object(value) ||
    !keys(
      value,
      'announcementEventJson,announcementTlvHex,attestationEventJson,attestationHex,nonceScalarHex,publication,schemaVersion,signedOutcome',
    ) ||
    value.schemaVersion !== 2 ||
    !validAuthorityArtifacts(value)
  )
    throw new Error()
  const publication = value.publication
  if (publication !== null) {
    if (
      !object(publication) ||
      !keys(
        publication,
        'engineEvidence,explanationEventJson,explanationRelayPublished,relayPublished',
      ) ||
      typeof publication.relayPublished !== 'boolean' ||
      typeof publication.explanationRelayPublished !== 'boolean' ||
      (publication.explanationEventJson !== null &&
        !text(publication.explanationEventJson, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX)) ||
      (publication.engineEvidence !== null &&
        (!object(publication.engineEvidence) ||
          !keys(
            publication.engineEvidence,
            'announcementEventId,attestationEventId,conditionId,oracleEventId,oraclePubkey,outcome',
          )))
    )
      throw new Error()
  }
  return structuredClone(value) as unknown as OraclePrivateAuthorityV2
}

function validAuthorityArtifacts(value: Record<string, unknown>): boolean {
  return (
    text(value.announcementEventJson, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX) &&
    text(value.announcementTlvHex, 48 * 1_024) &&
    (value.nonceScalarHex === null || hex(value.nonceScalarHex, 64)) &&
    (value.signedOutcome === null || text(value.signedOutcome, 191)) &&
    (value.attestationHex === null || text(value.attestationHex, 48 * 1_024)) &&
    (value.attestationEventJson === null ||
      text(value.attestationEventJson, ORACLE_BACKUP_PLAINTEXT_BYTES_MAX))
  )
}

function snapshotDestinations(value: unknown): OracleBackupRecord['destinations'] {
  if (
    !object(value) ||
    !keys(value, 'engineUrl,mintUrl,relayUrls') ||
    !httpUrl(value.mintUrl) ||
    !httpUrl(value.engineUrl) ||
    !Array.isArray(value.relayUrls) ||
    value.relayUrls.some((url) => !text(url, 2_048))
  )
    throw new Error()
  const relayUrls = normalizeNostrRelayUrls(value.relayUrls as string[])
  if (JSON.stringify(relayUrls) !== JSON.stringify(value.relayUrls)) throw new Error()
  return { mintUrl: value.mintUrl, engineUrl: value.engineUrl, relayUrls }
}

/** Check the internal model shape only; this never replaces bounded wire/core validation. */
export function snapshotOraclePrivateAuthority(value: unknown): OraclePrivateAuthority {
  return snapshotAuthority(value, ORACLE_BACKUP_MODEL_BYTES_MAX)
}

function snapshotAuthority(value: unknown, maximum: number): OraclePrivateAuthority {
  boundedJson(value, maximum)
  if (
    !object(value) ||
    !keys(
      value,
      'announcementEventJson,announcementTlvHex,attestationEventJson,attestationHex,nonceScalarHex,publicationRecordJson,schemaVersion,signedOutcome',
    ) ||
    value.schemaVersion !== 1 ||
    !validAuthorityArtifacts(value) ||
    (value.publicationRecordJson !== null && !text(value.publicationRecordJson, maximum))
  )
    throw new Error()
  return structuredClone(value) as unknown as OraclePrivateAuthority
}

function validatePublication(
  record: Pick<OracleBackupRecord, 'conditionId' | 'oracleEventId' | 'oraclePubkey' | 'authority'>,
  outcomes: readonly string[],
): void {
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
    (authority.nonceScalarHex === null && !oraclePublicationTerminal(publication))
  )
    throw new Error()
}

function backupTags(record: OracleBackupRecord | OracleBackupRecordV2): string[][] {
  return [
    [
      'd',
      ORACLE_BACKUP_TAG_PREFIX +
        readSignedOracleEvent(record.authority.announcementEventJson, 88).id,
    ],
    ['v', String(record.schemaVersion)],
  ]
}

function boundedJson(value: unknown, maximum = ORACLE_BACKUP_PLAINTEXT_BYTES_MAX): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new Error()
  if (new TextEncoder().encode(encoded).length > maximum) throw new OracleBackupError('oversized')
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
