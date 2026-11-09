import { v2 as nip44 } from 'nostr-tools/nip44'
import { ORACLE_BACKUP_PLAINTEXT_BYTES_MAX, type OracleBackupRecord } from './oracleBackup.ts'
import {
  compactOraclePrivateAuthority,
  type OracleBackupWriteVersion,
} from './oracleBackupModel.ts'
import { NIP44_V2_PAYLOAD_CHARS_MAX } from './nip17PaymentRequest.ts'
import { ORACLE_EXPLANATION_UTF8_BYTES_MAX } from './oracleResolutionExplanation.ts'
import { validateMarketOutcomeLabels } from './marketCreationInput.ts'

export interface OracleBackupLifecycleCapacityInput {
  readonly title: string
  readonly description: string
  readonly outcomes: readonly string[]
  readonly eventId: string
  readonly destinations: OracleBackupRecord['destinations']
  readonly writeVersion: OracleBackupWriteVersion
}

export interface OracleBackupLifecycleCapacity {
  readonly requiredPlaintextBytes: number
  readonly requiredEncryptedPayloadChars: number
  readonly plaintextBytesMax: number
  readonly encryptedPayloadCharsMax: number
  readonly fits: boolean
}

export class OracleBackupCapacityError extends Error {
  readonly reason = 'lifecycle-capacity' as const
  readonly capacity: OracleBackupLifecycleCapacity
  constructor(capacity: OracleBackupLifecycleCapacity) {
    super(
      'Market text and destination settings leave insufficient room for a recoverable oracle resolution. Shorten the text or reduce the configured relay URLs.',
    )
    this.name = 'OracleBackupCapacityError'
    this.capacity = capacity
  }
}

/**
 * Reserve the full eventual record before allocating a nonce, signing or paying.
 * This is a byte projection, never signing authority. Current single-nonce enum DLC
 * lengths follow dlc-messages oracle_msgs.rs and its BigSize/u16 serialization.
 * Real native/WASM lifecycle fixtures must guard any change to those encodings.
 *
 * Fixed-size IDs, signatures and hex/base64 payloads have fixed JSON widths. Raw
 * title/description conservatively include whitespace that announcement formatting
 * can only shorten. U+0000 consumes one explanation UTF-8 byte and the maximum six
 * JSON characters; serializing the actual nested schema accounts for every escape.
 * Full evidence/explanation plus a retained nonce dominates terminal and partial
 * states. False acknowledgments and the largest safe timestamp dominate their widths.
 */
export function inspectOracleBackupLifecycleCapacity(
  input: OracleBackupLifecycleCapacityInput,
): OracleBackupLifecycleCapacity {
  assertProjectionInput(input)
  const longestOutcome = input.outcomes.reduce((longest, outcome) =>
    utf8(outcome) > utf8(longest) ? outcome : longest,
  )
  const descriptorBytes = 2 + input.outcomes.reduce((sum, value) => sum + dlcStringBytes(value), 0)
  const eventBytes = 2 + 32 + 4 + tlvBytes(descriptorBytes) + dlcStringBytes(input.eventId)
  const announcementBodyBytes = 64 + 32 + tlvBytes(eventBytes)
  const announcementBytes = tlvBytes(announcementBodyBytes)
  const attestationBytes =
    dlcStringBytes(input.eventId) + 32 + 2 + 64 + 2 + dlcStringBytes(longestOutcome)
  const id = '0'.repeat(64)
  const announcementEventJson = eventJson(88, base64Placeholder(announcementBodyBytes), [
    ['title', input.title],
    ['description', input.description],
  ])
  const attestationEventJson = eventJson(89, base64Placeholder(attestationBytes), [['e', id]])
  const explanationEventJson = eventJson(1111, '\u0000'.repeat(ORACLE_EXPLANATION_UTF8_BYTES_MAX), [
    ['E', id, '', id],
    ['K', '88'],
    ['P', id],
    ['e', id, '', id],
    ['k', '89'],
    ['p', id],
  ])
  const publication = {
    binding: {
      conditionId: id,
      oracleEventId: input.eventId,
      oraclePubkey: id,
      outcomes: [...input.outcomes],
      announcementEventJson,
    },
    chosenOutcome: longestOutcome,
    attestation: {
      attestationHex: '0'.repeat(attestationBytes * 2),
      eventJson: attestationEventJson,
    },
    relayPublished: false,
    engineEvidence: {
      conditionId: id,
      oracleEventId: input.eventId,
      oraclePubkey: id,
      outcome: longestOutcome,
      announcementEventId: id,
      attestationEventId: id,
    },
    explanationEventJson,
    explanationRelayPublished: false,
  }
  const model: OracleBackupRecord = {
    schemaVersion: 1,
    conditionId: id,
    oraclePubkey: id,
    oracleEventId: input.eventId,
    authority: {
      schemaVersion: 1,
      announcementTlvHex: '0'.repeat(announcementBytes * 2),
      announcementEventJson,
      nonceScalarHex: id,
      signedOutcome: longestOutcome,
      attestationHex: publication.attestation.attestationHex,
      attestationEventJson,
      publicationRecordJson: JSON.stringify(publication),
    },
    destinations: input.destinations,
  }
  const wire =
    input.writeVersion === 1
      ? model
      : {
          ...model,
          schemaVersion: 2,
          authority: compactOraclePrivateAuthority(model.authority),
        }
  const requiredPlaintextBytes = utf8(JSON.stringify(wire))
  // NIP-44 v2: version(1) + nonce(32) + length(2) + padded plaintext + MAC(32).
  const requiredEncryptedPayloadChars =
    4 * Math.ceil((67 + nip44.utils.calcPaddedLen(requiredPlaintextBytes)) / 3)
  return {
    requiredPlaintextBytes,
    requiredEncryptedPayloadChars,
    plaintextBytesMax: ORACLE_BACKUP_PLAINTEXT_BYTES_MAX,
    encryptedPayloadCharsMax: NIP44_V2_PAYLOAD_CHARS_MAX,
    fits:
      requiredPlaintextBytes <= ORACLE_BACKUP_PLAINTEXT_BYTES_MAX &&
      requiredEncryptedPayloadChars <= NIP44_V2_PAYLOAD_CHARS_MAX,
  }
}

export function assertOracleBackupLifecycleCapacity(
  input: OracleBackupLifecycleCapacityInput,
): OracleBackupLifecycleCapacity {
  const capacity = inspectOracleBackupLifecycleCapacity(input)
  if (!capacity.fits) throw new OracleBackupCapacityError(capacity)
  return capacity
}

function eventJson(kind: number, content: string, tags: string[][]): string {
  return JSON.stringify({
    id: '0'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: Number.MAX_SAFE_INTEGER,
    kind,
    tags,
    content,
    sig: '0'.repeat(128),
  })
}
function utf8(value: string): number {
  return new TextEncoder().encode(value).length
}
function bigSizeBytes(value: number): number {
  return value < 0xfd ? 1 : value <= 0xffff ? 3 : value <= 0xffff_ffff ? 5 : 9
}
function dlcStringBytes(value: string): number {
  const size = utf8(value)
  return bigSizeBytes(size) + size
}
function tlvBytes(body: number): number {
  return 3 + bigSizeBytes(body) + body
}
function base64Placeholder(bytes: number): string {
  return 'A'.repeat(4 * Math.ceil(bytes / 3))
}
function assertProjectionInput(input: OracleBackupLifecycleCapacityInput): void {
  const validText = (value: unknown): value is string =>
    typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value)
  if (
    (input.writeVersion !== 1 && input.writeVersion !== 2) ||
    !validText(input.eventId) ||
    utf8(input.eventId) < 1 ||
    utf8(input.eventId) > 512 ||
    !validText(input.title) ||
    !validText(input.description) ||
    utf8(input.title) > 256 * 1_024 ||
    utf8(input.description) > 256 * 1_024 ||
    !Array.isArray(input.outcomes) ||
    input.outcomes.length < 2 ||
    input.outcomes.length > 8 ||
    input.outcomes.some((value) => !validText(value) || value !== value.trim()) ||
    validateMarketOutcomeLabels(input.outcomes).length !== 0 ||
    !validText(input.destinations.mintUrl) ||
    !validText(input.destinations.engineUrl) ||
    !Array.isArray(input.destinations.relayUrls) ||
    input.destinations.relayUrls.some((url) => !validText(url)) ||
    utf8(JSON.stringify(input.destinations)) > 512 * 1_024
  ) {
    throw new Error('Oracle backup capacity input is invalid.')
  }
}
