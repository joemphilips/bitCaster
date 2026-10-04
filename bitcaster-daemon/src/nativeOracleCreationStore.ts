import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  assertCreatedResultMatches,
  assertMarketCreationPreparationEqual,
  normalizeMarketCreationInput,
  parseCreateMarketResponse,
  snapshotMarketCreationPreparation,
  snapshotOraclePublicationRecord,
  assertOracleExplanationText,
  readSignedOracleEvent,
  type CreateMarketResponse,
  type MarketCreationInput,
  type MarketCreationPreparation,
  type MarketCreationRecord,
  type OraclePublicationRecord,
  type VerifiedOraclePublicationEvidence,
} from '@bitcaster-market/client-sdk'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { readProfileSecretAuthority } from './profileBootstrap.ts'
import {
  protectNativeOracleSigner,
  unlockNativeOracleSigner,
  type ProtectedSecretBody,
} from './profileSecretProtection.ts'
import {
  NATIVE_ORACLE_EVENT_JSON_BYTES_MAX,
  NATIVE_ORACLE_HEX_BYTES_MAX,
  NATIVE_ORACLE_INPUT_BYTES_MAX,
  NATIVE_ORACLE_NONCE_INDEX_LIMIT,
  NATIVE_ORACLE_OUTCOME_BYTES_MAX,
} from './nativeOracleSchema.ts'
import { deriveNativeConditionRegistrationFeeTransferId } from './nativeConditionRegistrationFee.ts'

export interface NativeOracleCreationInput {
  readonly creationId: string
  readonly eventId: string
  readonly canonicalInput: string
}

export interface NativeOracleAnnouncement {
  readonly conditionId: string
  readonly announcementTlvHex: string
  readonly announcementNostrEventJson: string
}

export interface NativeOracleAttestation {
  readonly attestationHex: string
  readonly attestationNostrEventJson: string
}

export interface NativeOracleCreationRecord extends NativeOracleCreationInput {
  readonly walletScopeId: string
  readonly walletId: string
  readonly creatorPublicKeyHex: string
  readonly nonceIndex: number
  readonly createdAtMs: number
  readonly announcement: NativeOracleAnnouncement | null
  readonly chosenOutcome: string | null
  readonly explanationDraft: string | null
  readonly attestation: NativeOracleAttestation | null
  readonly marketCreation: MarketCreationRecord | null
  readonly relayPublished: boolean
  readonly engineEvidence: VerifiedOraclePublicationEvidence | null
  readonly explanationEventJson: string | null
  readonly explanationRelayPublished: boolean
}

export class NativeOracleStoreError extends Error {
  readonly reason: 'invalid-input' | 'not-found' | 'conflict' | 'nonce-exhausted' | 'invalid-state'

  constructor(reason: NativeOracleStoreError['reason']) {
    super(`native oracle store: ${reason}`)
    this.name = 'NativeOracleStoreError'
    this.reason = reason
  }
}

export class NativeOracleSignerUnavailableError extends Error {
  readonly requiredPublicKeyHex: string
  constructor(requiredPublicKeyHex: string) {
    super(`Native oracle creation requires signer ${requiredPublicKeyHex}.`)
    this.requiredPublicKeyHex = requiredPublicKeyHex
  }
}

export function createNativeOracleCreationStore(
  directory: string,
  options: { passphrase?: string } = {},
) {
  const session = createDaemonStateSqliteSession(directory)
  return {
    async readWalletBinding(): Promise<{ walletScopeId: string; walletId: string }> {
      return session.read(
        (database) =>
          database
            .prepare(
              `SELECT profile.wallet_scope_id AS walletScopeId, scope.wallet_id AS walletId
         FROM daemon_profile profile JOIN custody_scopes scope ON scope.scope_id = profile.wallet_scope_id`,
            )
            .get() as { walletScopeId: string; walletId: string },
      )
    },
    async reserveCreation(
      input: NativeOracleCreationInput,
      creatorPublicKeyHex?: string,
    ): Promise<NativeOracleCreationRecord> {
      exactText(input.creationId, 128)
      exactText(input.eventId, 512)
      exactJsonObject(input.canonicalInput, NATIVE_ORACLE_INPUT_BYTES_MAX)
      return session.transaction((database) => {
        const existing = readCreation(database, input.creationId)
        if (existing !== null) {
          if (
            existing.eventId !== input.eventId ||
            existing.canonicalInput !== input.canonicalInput
          ) {
            throw new NativeOracleStoreError('conflict')
          }
          if (
            creatorPublicKeyHex !== undefined &&
            creatorPublicKeyHex !== existing.creatorPublicKeyHex
          )
            throw new NativeOracleStoreError('conflict')
          return existing
        }
        const selected = database
          .prepare('SELECT signer_enabled AS enabled, wallet_scope_id AS scope FROM daemon_profile')
          .get() as { enabled: number; scope: string }
        const secrets = readProfileSecretAuthority(
          database,
          options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
        )
        if (
          selected.enabled !== 1 ||
          (creatorPublicKeyHex !== undefined && creatorPublicKeyHex !== secrets.nostrPublicKeyHex)
        )
          throw new NativeOracleStoreError('conflict')
        const allocator = database
          .prepare(
            'SELECT next_nonce_index AS next FROM daemon_oracle_nonce_allocator WHERE singleton = 1',
          )
          .get() as { next: number } | undefined
        if (allocator === undefined) throw new NativeOracleStoreError('invalid-state')
        if (allocator.next >= NATIVE_ORACLE_NONCE_INDEX_LIMIT) {
          throw new NativeOracleStoreError('nonce-exhausted')
        }
        database
          .prepare(
            'UPDATE daemon_oracle_nonce_allocator SET next_nonce_index = next_nonce_index + 1 WHERE singleton = 1',
          )
          .run()
        const binding = {
          walletScopeId: selected.scope,
          creationId: input.creationId,
          eventId: input.eventId,
          nonceIndex: allocator.next,
          creatorPublicKeyHex: secrets.nostrPublicKeyHex,
        }
        const protectedSigner = protectNativeOracleSigner(
          secrets.nostrSecretKeyHex,
          binding,
          options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
        )
        insertCreation(database, input, allocator.next, binding, protectedSigner)
        return requireCreation(database, input.creationId)
      })
    },

    async readCreationSigner(
      creationId: string,
    ): Promise<{ publicKeyHex: string; secretKeyHex: string }> {
      exactText(creationId, 128)
      return session.read((database) => {
        const row = database
          .prepare(
            `SELECT wallet_scope_id AS walletScopeId, creator_public_key_hex AS creatorPublicKeyHex,
          event_id AS eventId, nonce_index AS nonceIndex, signer_protection AS protection,
          signer_kdf AS kdf, signer_salt AS salt, signer_iv AS iv, signer_auth_tag AS authTag,
          signer_body AS body FROM daemon_oracle_creations WHERE creation_id = ?`,
          )
          .get(creationId) as
          | (ProtectedSecretBody & {
              walletScopeId: string
              creatorPublicKeyHex: string
              eventId: string
              nonceIndex: number
            })
          | undefined
        if (row === undefined) throw new NativeOracleStoreError('not-found')
        let secretKeyHex: string
        try {
          secretKeyHex = unlockNativeOracleSigner(
            row,
            { ...row, creationId },
            options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
          )
        } catch {
          throw new NativeOracleSignerUnavailableError(row.creatorPublicKeyHex)
        }
        return {
          publicKeyHex: row.creatorPublicKeyHex,
          secretKeyHex,
        }
      })
    },

    async readCreation(creationId: string): Promise<NativeOracleCreationRecord | null> {
      exactText(creationId, 128)
      return session.read((database) => readCreation(database, creationId))
    },

    async reserveMarketCreation(input: MarketCreationPreparation): Promise<MarketCreationRecord> {
      const preparation = snapshotMarketCreationPreparation(input)
      return session.transaction((database) => {
        const record = requireCreation(database, preparation.creationId)
        assertPreparationMatchesOracle(record, preparation)
        if (record.marketCreation !== null) {
          assertMarketCreationPreparationEqual(record.marketCreation, preparation)
          return record.marketCreation
        }
        database
          .prepare(
            `UPDATE daemon_oracle_creations SET creation_metadata_json = ?, creation_mint_url = ?,
           creation_engine_base_url = ?, creation_fee_operation_ref = ?, creation_fee_amount = ?,
           creation_fee_unit = ?, creation_thumbnail_bytes = ?, creation_thumbnail_filename = ?,
           creation_thumbnail_content_type = ? WHERE creation_id = ?`,
          )
          .run(
            JSON.stringify(preparation.metadata),
            preparation.mintUrl,
            preparation.engineBaseUrl,
            preparation.registration.feeOperationRef,
            preparation.registration.feeAmount,
            preparation.registration.feeUnit,
            preparation.thumbnail?.data ?? null,
            preparation.thumbnail?.filename ?? null,
            preparation.thumbnail?.contentType ?? null,
            preparation.creationId,
          )
        return requireMarketCreation(database, preparation.creationId)
      })
    },

    async confirmMarketCreationMint(creationId: string): Promise<MarketCreationRecord> {
      return session.transaction((database) => {
        requireMarketCreation(database, creationId)
        database
          .prepare(
            'UPDATE daemon_oracle_creations SET creation_mint_confirmed = 1 WHERE creation_id = ?',
          )
          .run(creationId)
        return requireMarketCreation(database, creationId)
      })
    },

    async confirmMarketCreationEngine(
      creationId: string,
      result: CreateMarketResponse,
    ): Promise<MarketCreationRecord> {
      const confirmed = parseCreateMarketResponse(result)
      return session.transaction((database) => {
        const stored = requireMarketCreation(database, creationId)
        if (!stored.mintConfirmed) throw new NativeOracleStoreError('invalid-state')
        assertCreatedResultMatches(confirmed, stored)
        if (stored.engineResult !== null) {
          if (JSON.stringify(stored.engineResult) !== JSON.stringify(confirmed))
            throw new NativeOracleStoreError('conflict')
          return stored
        }
        database
          .prepare(
            'UPDATE daemon_oracle_creations SET creation_engine_result_json = ? WHERE creation_id = ?',
          )
          .run(JSON.stringify(confirmed), creationId)
        return requireMarketCreation(database, creationId)
      })
    },

    async readByConditionId(conditionId: string): Promise<NativeOracleCreationRecord | null> {
      exactConditionId(conditionId)
      return session.read((database) => {
        const row = database.prepare(`${SELECT_CREATION} WHERE condition_id = ?`).get(conditionId)
        return decodeRow(row)
      })
    },

    async persistAnnouncement(creationId: string, artifact: NativeOracleAnnouncement) {
      exactConditionId(artifact.conditionId)
      exactHex(artifact.announcementTlvHex)
      exactJsonObject(artifact.announcementNostrEventJson, NATIVE_ORACLE_EVENT_JSON_BYTES_MAX)
      return session.transaction((database) => {
        const existing = requireCreation(database, creationId)
        if (existing.announcement !== null) {
          const stored = existing.announcement
          if (
            stored.conditionId !== artifact.conditionId ||
            stored.announcementTlvHex !== artifact.announcementTlvHex ||
            stored.announcementNostrEventJson !== artifact.announcementNostrEventJson
          ) {
            throw new NativeOracleStoreError('conflict')
          }
          return existing
        }
        database
          .prepare(
            `UPDATE daemon_oracle_creations SET condition_id = ?, announcement_hex = ?,
           announcement_event_json = ? WHERE creation_id = ?`,
          )
          .run(
            artifact.conditionId,
            artifact.announcementTlvHex,
            artifact.announcementNostrEventJson,
            creationId,
          )
        return requireCreation(database, creationId)
      })
    },

    async chooseOutcome(conditionId: string, outcome: string, explanationDraft?: string) {
      exactConditionId(conditionId)
      exactText(outcome, NATIVE_ORACLE_OUTCOME_BYTES_MAX)
      if (explanationDraft !== undefined) assertOracleExplanationText(explanationDraft)
      return session.transaction((database) => {
        const existing = decodeRow(
          database.prepare(`${SELECT_CREATION} WHERE condition_id = ?`).get(conditionId),
        )
        if (existing === null) throw new NativeOracleStoreError('not-found')
        if (existing.chosenOutcome !== null && existing.chosenOutcome !== outcome) {
          throw new NativeOracleStoreError('conflict')
        }
        if (
          existing.chosenOutcome !== null &&
          explanationDraft !== undefined &&
          existing.explanationDraft !== explanationDraft
        )
          throw new NativeOracleStoreError('conflict')
        const originalDraft =
          existing.chosenOutcome === null ? (explanationDraft ?? null) : existing.explanationDraft
        database
          .prepare(
            'UPDATE daemon_oracle_creations SET chosen_outcome = ?, explanation_draft = ? WHERE creation_id = ?',
          )
          .run(outcome, originalDraft, existing.creationId)
        return requireCreation(database, existing.creationId)
      })
    },

    async persistPublicationProgress(
      conditionId: string,
      change:
        | { readonly kind: 'relay'; readonly eventId: string }
        | { readonly kind: 'engine'; readonly evidence: VerifiedOraclePublicationEvidence }
        | { readonly kind: 'explanation'; readonly eventJson: string }
        | { readonly kind: 'explanation-relay'; readonly eventId: string },
    ): Promise<NativeOracleCreationRecord> {
      exactConditionId(conditionId)
      return session.transaction((database) => {
        const current = decodeRow(
          database.prepare(`${SELECT_CREATION} WHERE condition_id = ?`).get(conditionId),
        )
        if (current === null) throw new NativeOracleStoreError('not-found')
        const publication = nativeOraclePublicationRecord(current)
        if (publication === null || publication.attestation === null)
          throw new NativeOracleStoreError('invalid-state')
        if (change.kind === 'relay') {
          if (JSON.parse(publication.attestation.eventJson).id !== change.eventId)
            throw new NativeOracleStoreError('conflict')
          database
            .prepare(
              'UPDATE daemon_oracle_creations SET attestation_relay_published = 1 WHERE condition_id = ?',
            )
            .run(conditionId)
        } else if (change.kind === 'engine') {
          const checked = snapshotOraclePublicationRecord({
            ...publication,
            engineEvidence: change.evidence,
          })
          const evidenceJson = JSON.stringify(checked.engineEvidence)
          if (
            publication.engineEvidence !== null &&
            JSON.stringify(publication.engineEvidence) !== evidenceJson
          )
            throw new NativeOracleStoreError('conflict')
          database
            .prepare(
              'UPDATE daemon_oracle_creations SET attestation_engine_evidence_json = ? WHERE condition_id = ?',
            )
            .run(evidenceJson, conditionId)
        } else if (change.kind === 'explanation') {
          snapshotOraclePublicationRecord({
            ...publication,
            explanationEventJson: change.eventJson,
          })
          if (
            current.explanationDraft === null ||
            readSignedOracleEvent(change.eventJson, 1111).content !== current.explanationDraft
          )
            throw new NativeOracleStoreError('conflict')
          if (
            publication.explanationEventJson !== null &&
            publication.explanationEventJson !== change.eventJson
          )
            throw new NativeOracleStoreError('conflict')
          database
            .prepare(
              'UPDATE daemon_oracle_creations SET explanation_event_json = ? WHERE condition_id = ?',
            )
            .run(change.eventJson, conditionId)
        } else if (change.kind === 'explanation-relay') {
          if (
            publication.explanationEventJson === null ||
            JSON.parse(publication.explanationEventJson).id !== change.eventId
          )
            throw new NativeOracleStoreError('conflict')
          database
            .prepare(
              'UPDATE daemon_oracle_creations SET explanation_relay_published = 1 WHERE condition_id = ?',
            )
            .run(conditionId)
        } else throw new NativeOracleStoreError('invalid-input')
        return requireCreation(database, current.creationId)
      })
    },

    async persistAttestation(
      creationId: string,
      outcome: string,
      artifact: NativeOracleAttestation,
    ) {
      exactText(outcome, NATIVE_ORACLE_OUTCOME_BYTES_MAX)
      exactHex(artifact.attestationHex)
      exactJsonObject(artifact.attestationNostrEventJson, NATIVE_ORACLE_EVENT_JSON_BYTES_MAX)
      return session.transaction((database) => {
        const existing = requireCreation(database, creationId)
        if (existing.chosenOutcome === null) throw new NativeOracleStoreError('invalid-state')
        if (existing.chosenOutcome !== outcome) throw new NativeOracleStoreError('conflict')
        if (existing.attestation !== null) {
          if (
            existing.attestation.attestationHex !== artifact.attestationHex ||
            existing.attestation.attestationNostrEventJson !== artifact.attestationNostrEventJson
          ) {
            throw new NativeOracleStoreError('conflict')
          }
          return existing
        }
        database
          .prepare(
            `UPDATE daemon_oracle_creations SET attestation_hex = ?, attestation_event_json = ?
           WHERE creation_id = ?`,
          )
          .run(artifact.attestationHex, artifact.attestationNostrEventJson, creationId)
        return requireCreation(database, creationId)
      })
    },
  }
}

export type NativeOracleCreationStore = ReturnType<typeof createNativeOracleCreationStore>

const SELECT_CREATION = `SELECT creation_id AS creationId, event_id AS eventId,
  wallet_scope_id AS walletScopeId,
  (SELECT wallet_id FROM custody_scopes WHERE scope_id = wallet_scope_id) AS walletId,
  creator_public_key_hex AS creatorPublicKeyHex,
  nonce_index AS nonceIndex, canonical_input AS canonicalInput, created_at_ms AS createdAtMs,
  condition_id AS conditionId, announcement_hex AS announcementTlvHex,
  announcement_event_json AS announcementNostrEventJson, chosen_outcome AS chosenOutcome,
  explanation_draft AS explanationDraft,
  attestation_hex AS attestationHex, attestation_event_json AS attestationNostrEventJson
  , attestation_relay_published AS relayPublished,
  attestation_engine_evidence_json AS engineEvidenceJson, explanation_event_json AS explanationEventJson,
  explanation_relay_published AS explanationRelayPublished
  , creation_metadata_json AS creationMetadataJson, creation_mint_url AS creationMintUrl,
  creation_engine_base_url AS creationEngineBaseUrl, creation_fee_operation_ref AS creationFeeOperationRef,
  creation_fee_amount AS creationFeeAmount, creation_fee_unit AS creationFeeUnit,
  creation_thumbnail_bytes AS creationThumbnailBytes, creation_thumbnail_filename AS creationThumbnailFilename,
  creation_thumbnail_content_type AS creationThumbnailContentType,
  creation_mint_confirmed AS creationMintConfirmed, creation_engine_result_json AS creationEngineResultJson
  FROM daemon_oracle_creations`

type CreationRow = NativeOracleCreationInput & {
  walletScopeId: string
  walletId: string
  creatorPublicKeyHex: string
  nonceIndex: number
  createdAtMs: number
  conditionId: string | null
  announcementTlvHex: string | null
  announcementNostrEventJson: string | null
  chosenOutcome: string | null
  explanationDraft: string | null
  attestationHex: string | null
  attestationNostrEventJson: string | null
  relayPublished: number
  engineEvidenceJson: string | null
  explanationEventJson: string | null
  explanationRelayPublished: number
  creationMetadataJson: string | null
  creationMintUrl: string | null
  creationEngineBaseUrl: string | null
  creationFeeOperationRef: string | null
  creationFeeAmount: number | null
  creationFeeUnit: 'msat' | null
  creationThumbnailBytes: Uint8Array | null
  creationThumbnailFilename: string | null
  creationThumbnailContentType: string | null
  creationMintConfirmed: number
  creationEngineResultJson: string | null
}

function decodeRow(row: unknown): NativeOracleCreationRecord | null {
  if (row === undefined) return null
  const value = row as CreationRow
  return {
    creationId: value.creationId,
    eventId: value.eventId,
    canonicalInput: value.canonicalInput,
    walletScopeId: value.walletScopeId,
    walletId: value.walletId,
    creatorPublicKeyHex: value.creatorPublicKeyHex,
    nonceIndex: value.nonceIndex,
    createdAtMs: value.createdAtMs,
    announcement:
      value.conditionId === null
        ? null
        : {
            conditionId: value.conditionId,
            announcementTlvHex: value.announcementTlvHex!,
            announcementNostrEventJson: value.announcementNostrEventJson!,
          },
    chosenOutcome: value.chosenOutcome,
    explanationDraft: value.explanationDraft,
    attestation:
      value.attestationHex === null
        ? null
        : {
            attestationHex: value.attestationHex,
            attestationNostrEventJson: value.attestationNostrEventJson!,
          },
    marketCreation: decodeMarketCreation(value),
    relayPublished: value.relayPublished === 1,
    engineEvidence: value.engineEvidenceJson === null ? null : JSON.parse(value.engineEvidenceJson),
    explanationEventJson: value.explanationEventJson,
    explanationRelayPublished: value.explanationRelayPublished === 1,
  }
}

/** Project the existing durable row into the shared publication port. */
export function nativeOraclePublicationRecord(
  record: NativeOracleCreationRecord,
): OraclePublicationRecord | null {
  if (record.announcement === null || record.chosenOutcome === null) return null
  const canonical = JSON.parse(record.canonicalInput) as { market: MarketCreationInput }
  return snapshotOraclePublicationRecord({
    binding: {
      conditionId: record.announcement.conditionId,
      oracleEventId: record.eventId,
      oraclePubkey: record.creatorPublicKeyHex,
      outcomes: normalizeMarketCreationInput(canonical.market).outcomeLabels,
      announcementEventJson: record.announcement.announcementNostrEventJson,
    },
    chosenOutcome: record.chosenOutcome,
    attestation:
      record.attestation === null
        ? null
        : {
            attestationHex: record.attestation.attestationHex,
            eventJson: record.attestation.attestationNostrEventJson,
          },
    relayPublished: record.relayPublished,
    engineEvidence: record.engineEvidence,
    explanationEventJson: record.explanationEventJson,
    explanationRelayPublished: record.explanationRelayPublished,
  })
}

function decodeMarketCreation(value: CreationRow): MarketCreationRecord | null {
  if (value.creationMetadataJson === null) return null
  const canonical = JSON.parse(value.canonicalInput)
  const preparation = snapshotMarketCreationPreparation({
    creationId: value.creationId,
    eventId: value.eventId,
    creatorId: value.creatorPublicKeyHex,
    walletId: value.walletId,
    walletScopeId: value.walletScopeId,
    mintUrl: value.creationMintUrl!,
    engineBaseUrl: value.creationEngineBaseUrl!,
    relayUrls: canonical.destination.relayUrls,
    metadata: JSON.parse(value.creationMetadataJson),
    announcement: {
      conditionId: value.conditionId!,
      announcementTlvHex: value.announcementTlvHex!,
      announcementNostrEventJson: value.announcementNostrEventJson!,
    },
    registration: {
      feeOperationRef: value.creationFeeOperationRef,
      feeAmount: value.creationFeeAmount!,
      feeUnit: value.creationFeeUnit!,
      ...(canonical.registration.outcomeCollections === undefined
        ? {}
        : {
            outcomeCollections: canonical.registration.outcomeCollections,
          }),
    },
    thumbnail:
      value.creationThumbnailBytes === null
        ? null
        : {
            data: value.creationThumbnailBytes,
            filename: value.creationThumbnailFilename!,
            contentType: value.creationThumbnailContentType!,
          },
  })
  const engineResult =
    value.creationEngineResultJson === null
      ? null
      : parseCreateMarketResponse(JSON.parse(value.creationEngineResultJson))
  if (engineResult !== null) assertCreatedResultMatches(engineResult, preparation)
  return { ...preparation, mintConfirmed: value.creationMintConfirmed === 1, engineResult }
}

function requireMarketCreation(database: DatabaseSync, creationId: string): MarketCreationRecord {
  const record = requireCreation(database, creationId)
  if (record.marketCreation === null) throw new NativeOracleStoreError('invalid-state')
  return record.marketCreation
}

function assertPreparationMatchesOracle(
  record: NativeOracleCreationRecord,
  preparation: MarketCreationPreparation,
): void {
  if (record.announcement === null) throw new NativeOracleStoreError('invalid-state')
  const canonical = JSON.parse(record.canonicalInput) as {
    market: MarketCreationInput
    destination: {
      engineBaseUrl: string
      mintUrl: string
      relayUrls: string[]
      thumbnailSha256?: string
      thumbnailFilename?: string
      thumbnailContentType?: string
    }
    registration: { requiredFeeMsat: number; outcomeCollections?: readonly string[] }
  }
  const market = normalizeMarketCreationInput(canonical.market)
  const thumbnail = preparation.thumbnail
  const thumbnailHash =
    thumbnail === null ? undefined : createHash('sha256').update(thumbnail.data).digest('hex')
  if (
    thumbnailHash !== canonical.destination.thumbnailSha256 ||
    thumbnail?.filename !== canonical.destination.thumbnailFilename ||
    thumbnail?.contentType !==
      (canonical.destination.thumbnailSha256 === undefined
        ? undefined
        : (canonical.destination.thumbnailContentType ?? 'application/octet-stream'))
  )
    throw new NativeOracleStoreError('conflict')
  assertMarketCreationPreparationEqual(preparation, {
    ...preparation,
    creatorId: record.creatorPublicKeyHex,
    walletScopeId: record.walletScopeId,
    walletId: record.walletId,
    eventId: record.eventId,
    mintUrl: canonical.destination.mintUrl,
    engineBaseUrl: canonical.destination.engineBaseUrl,
    relayUrls: canonical.destination.relayUrls,
    announcement: record.announcement,
    metadata: { ...market.metadata, oracleAnnouncementHex: record.announcement.announcementTlvHex },
    registration: {
      feeOperationRef:
        canonical.registration.requiredFeeMsat === 0
          ? null
          : deriveNativeConditionRegistrationFeeTransferId(record.creationId),
      feeAmount: canonical.registration.requiredFeeMsat,
      feeUnit: 'msat',
      ...(canonical.registration.outcomeCollections === undefined
        ? {}
        : {
            outcomeCollections: canonical.registration.outcomeCollections,
          }),
    },
  })
}

function readCreation(database: DatabaseSync, creationId: string) {
  return decodeRow(database.prepare(`${SELECT_CREATION} WHERE creation_id = ?`).get(creationId))
}

function requireCreation(database: DatabaseSync, creationId: string) {
  exactText(creationId, 128)
  const record = readCreation(database, creationId)
  if (record === null) throw new NativeOracleStoreError('not-found')
  return record
}

function insertCreation(
  database: DatabaseSync,
  input: NativeOracleCreationInput,
  index: number,
  binding: { walletScopeId: string; creatorPublicKeyHex: string },
  signer: ProtectedSecretBody,
) {
  if (
    database.prepare('SELECT 1 FROM daemon_oracle_creations WHERE event_id = ?').get(input.eventId)
  ) {
    throw new NativeOracleStoreError('conflict')
  }
  database
    .prepare(
      `INSERT INTO daemon_oracle_creations (creation_id, event_id, nonce_index, canonical_input, created_at_ms,
      wallet_scope_id,creator_public_key_hex,signer_protection,signer_kdf,signer_salt,signer_iv,signer_auth_tag,signer_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.creationId,
      input.eventId,
      index,
      input.canonicalInput,
      Date.now(),
      binding.walletScopeId,
      binding.creatorPublicKeyHex,
      signer.protection,
      signer.kdf,
      signer.salt,
      signer.iv,
      signer.authTag,
      signer.body,
    )
}

function exactText(value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > maximum ||
    value.includes('\0')
  ) {
    throw new NativeOracleStoreError('invalid-input')
  }
}

function exactConditionId(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new NativeOracleStoreError('invalid-input')
}

function exactHex(value: string): void {
  exactText(value, NATIVE_ORACLE_HEX_BYTES_MAX)
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new NativeOracleStoreError('invalid-input')
}

function exactJsonObject(value: string, maximum: number): void {
  exactText(value, maximum)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new NativeOracleStoreError('invalid-input')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeOracleStoreError('invalid-input')
  }
}
