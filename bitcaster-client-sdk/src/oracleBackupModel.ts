import type { OracleBackupRecord, OraclePrivateAuthority } from './oracleBackup.ts'
import type {
  OraclePublicationRecord,
  VerifiedOraclePublicationEvidence,
} from './oraclePublication.ts'

/** Wire versions are an application release decision, never a user preference. */
export type OracleBackupWriteVersion = 1 | 2

/**
 * A bounded in-memory view may repeat signed strings to serve existing publication ports.
 * It is not a wire format. Expansion adds announcement/attestation copies with at most
 * twice their compact-wire escaping cost, and derived binding fields bounded by the
 * original wire. Four times the wire budget covers this redundant view; Rust uses the
 * same resource bound. The independently checked wire budget remains 65,535 bytes.
 */
export const ORACLE_BACKUP_MODEL_BYTES_MAX = 4 * 65_535

export interface OracleCompactPublication {
  readonly relayPublished: boolean
  readonly engineEvidence: VerifiedOraclePublicationEvidence | null
  readonly explanationEventJson: string | null
  readonly explanationRelayPublished: boolean
}

export interface OraclePrivateAuthorityV2 {
  readonly schemaVersion: 2
  readonly announcementTlvHex: string
  readonly announcementEventJson: string
  readonly nonceScalarHex: string | null
  readonly signedOutcome: string | null
  readonly attestationHex: string | null
  readonly attestationEventJson: string | null
  readonly publication: OracleCompactPublication | null
}

export interface OracleBackupRecordV2 {
  readonly schemaVersion: 2
  readonly conditionId: string
  readonly oraclePubkey: string
  readonly oracleEventId: string
  readonly authority: OraclePrivateAuthorityV2
  readonly destinations: OracleBackupRecord['destinations']
}

/** Call only after validating the normalized publication's full binding and exact artifacts. */
export function compactOraclePrivateAuthority(
  authority: OraclePrivateAuthority,
): OraclePrivateAuthorityV2 {
  const publication =
    authority.publicationRecordJson === null
      ? null
      : (JSON.parse(authority.publicationRecordJson) as OraclePublicationRecord)
  return {
    schemaVersion: 2,
    announcementTlvHex: authority.announcementTlvHex,
    announcementEventJson: authority.announcementEventJson,
    nonceScalarHex: authority.nonceScalarHex,
    signedOutcome: authority.signedOutcome,
    attestationHex: authority.attestationHex,
    attestationEventJson: authority.attestationEventJson,
    publication:
      publication === null
        ? null
        : {
            relayPublished: publication.relayPublished,
            engineEvidence: structuredClone(publication.engineEvidence),
            explanationEventJson: publication.explanationEventJson,
            explanationRelayPublished: publication.explanationRelayPublished,
          },
  }
}

/** Expand a cryptographically validated compact authority into a publication port view. */
export function expandOraclePrivateAuthority(
  authority: OraclePrivateAuthorityV2,
  binding: OraclePublicationRecord['binding'],
): OraclePrivateAuthority {
  const publication =
    authority.publication === null
      ? null
      : {
          binding,
          chosenOutcome: authority.signedOutcome,
          attestation:
            authority.attestationHex === null && authority.attestationEventJson === null
              ? null
              : {
                  attestationHex: authority.attestationHex,
                  eventJson: authority.attestationEventJson,
                },
          ...authority.publication,
        }
  return {
    schemaVersion: 1,
    announcementTlvHex: authority.announcementTlvHex,
    announcementEventJson: authority.announcementEventJson,
    nonceScalarHex: authority.nonceScalarHex,
    signedOutcome: authority.signedOutcome,
    attestationHex: authority.attestationHex,
    attestationEventJson: authority.attestationEventJson,
    publicationRecordJson: publication === null ? null : JSON.stringify(publication),
  }
}
