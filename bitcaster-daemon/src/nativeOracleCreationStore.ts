import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  encodeOracleBackup,
  mergeOraclePublicationRecords,
  type OracleBackupRecord,
  type OraclePrivateAuthority,
  assertCreatedResultMatches,
  assertMarketCreationPreparationEqual,
  normalizeMarketCreationInput,
  normalizeNostrRelayUrls,
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
import type { NativeOracleHelper } from './nativeOracleHelper.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { readProfileSecretAuthority } from './profileBootstrap.ts'
import {
  protectNativeOracleSigner,
  protectNativeOracleNonce,
  unlockNativeOracleNonce,
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
  readonly backupTerminal: boolean
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

export interface NativeImportedOracleRecord {
  readonly kind: 'imported'
  readonly walletScopeId: string
  readonly eventId: string
  readonly creatorPublicKeyHex: string
  readonly announcement: NativeOracleAnnouncement
  readonly outcomes: readonly string[]
  readonly destinations: OracleBackupRecord['destinations']
  readonly nonceAvailable: boolean
  readonly chosenOutcome: string | null
  readonly explanationDraft: string | null
  readonly attestation: NativeOracleAttestation | null
  readonly relayPublished: boolean
  readonly engineEvidence: VerifiedOraclePublicationEvidence | null
  readonly explanationEventJson: string | null
  readonly explanationRelayPublished: boolean
}

export type NativeOracleAuthorityRecord =
  | (NativeOracleCreationRecord & { readonly kind: 'created' })
  | NativeImportedOracleRecord

export type NativeOraclePublicationChange =
  | { readonly kind: 'relay'; readonly eventId: string }
  | { readonly kind: 'engine'; readonly evidence: VerifiedOraclePublicationEvidence }
  | { readonly kind: 'explanation'; readonly eventJson: string }
  | { readonly kind: 'explanation-relay'; readonly eventId: string }

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
    async readAuthorityByConditionId(
      conditionId: string,
    ): Promise<NativeOracleAuthorityRecord | null> {
      exactConditionId(conditionId)
      return session.read((database) => readAuthority(database, conditionId))
    },

    async listImported(): Promise<readonly NativeImportedOracleRecord[]> {
      return session.read((database) =>
        database.prepare(`${SELECT_IMPORT} ORDER BY condition_id`).all().map(decodeImport),
      )
    },

    /** Private signing/export port. Never return this DTO through status or RPC. */
    async readImportedAuthorityForSigning(conditionId: string): Promise<OraclePrivateAuthority> {
      exactConditionId(conditionId)
      return session.read((database) =>
        privateImportedAuthority(
          database,
          conditionId,
          options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
        ),
      )
    },

    async exportImportedBackup(
      conditionId: string,
      helper: NativeOracleHelper,
    ): Promise<OracleBackupRecord> {
      exactConditionId(conditionId)
      const snapshot = await session.read((database) => {
        const row = requireImport(database, conditionId)
        const record = decodeImport(row)
        return {
          record,
          backup: importedBackup(
            record,
            privateImportedAuthority(
              database,
              conditionId,
              options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
            ),
          ),
        }
      })
      const encoded = await encodeOracleBackup(snapshot.backup, helper)
      const latest = await this.readAuthorityByConditionId(conditionId)
      if (JSON.stringify(latest) !== JSON.stringify(snapshot.record))
        throw new NativeOracleStoreError('conflict')
      return JSON.parse(encoded) as OracleBackupRecord
    },

    /** Private backup port. Created authorities keep the retained hardened index. */
    async exportBackup(
      conditionId: string,
      helper: NativeOracleHelper,
    ): Promise<OracleBackupRecord> {
      const record = await this.readAuthorityByConditionId(conditionId)
      if (record === null) throw new NativeOracleStoreError('not-found')
      if (record.kind === 'imported') return this.exportImportedBackup(conditionId, helper)
      const publication = nativeOraclePublicationRecord(record)
      let authority: OraclePrivateAuthority = {
        schemaVersion: 1,
        announcementTlvHex: record.announcement!.announcementTlvHex,
        announcementEventJson: record.announcement!.announcementNostrEventJson,
        nonceScalarHex: null,
        signedOutcome: record.chosenOutcome,
        attestationHex: record.attestation?.attestationHex ?? null,
        attestationEventJson: record.attestation?.attestationNostrEventJson ?? null,
        publicationRecordJson: publication === null ? null : JSON.stringify(publication),
      }
      if (!record.backupTerminal) {
        const signer = await this.readCreationSigner(record.creationId)
        const secrets = await session.read((database) =>
          readProfileSecretAuthority(
            database,
            options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
          ),
        )
        const { schemaVersion: _version, nonceScalarHex: _nonce, ...retained } = authority
        authority = JSON.parse(
          await helper.exportEnumAuthority({
            ...retained,
            oracleSecretKeyHex: signer.secretKeyHex,
            nonceSeedHex: secrets.nativeOracleNonceSeedHex,
            reservedNonceIndex: record.nonceIndex,
          }),
        ) as OraclePrivateAuthority
      }
      const canonical = JSON.parse(record.canonicalInput) as {
        destination: { mintUrl: string; engineBaseUrl: string; relayUrls: readonly string[] }
      }
      const backup: OracleBackupRecord = {
        schemaVersion: 1,
        conditionId,
        oraclePubkey: record.creatorPublicKeyHex,
        oracleEventId: record.eventId,
        authority: {
          ...authority,
          nonceScalarHex: record.backupTerminal ? null : authority.nonceScalarHex,
        },
        destinations: {
          mintUrl: canonical.destination.mintUrl,
          engineUrl: canonical.destination.engineBaseUrl,
          relayUrls: normalizeNostrRelayUrls(canonical.destination.relayUrls),
        },
      }
      const encoded = await encodeOracleBackup(backup, helper)
      // Do not export a stale choice or artifact while the helper was running.
      const latest = await this.readAuthorityByConditionId(conditionId)
      if (JSON.stringify(latest) !== JSON.stringify(record))
        throw new NativeOracleStoreError('conflict')
      return JSON.parse(encoded) as OracleBackupRecord
    },

    async terminalizeAuthority(conditionId: string): Promise<NativeOracleAuthorityRecord> {
      const current = await this.readAuthorityByConditionId(conditionId)
      if (current === null) throw new NativeOracleStoreError('not-found')
      if (current.kind === 'imported') return this.terminalizeImported(conditionId)
      return session.transaction((database) => {
        const record = requireCreation(database, current.creationId)
        if (record.attestation === null || !record.relayPublished)
          throw new NativeOracleStoreError('invalid-state')
        database
          .prepare('UPDATE daemon_oracle_creations SET backup_terminal=1 WHERE creation_id=?')
          .run(record.creationId)
        return { ...requireCreation(database, record.creationId), kind: 'created' }
      })
    },

    async importBackup(
      input: unknown,
      helper: NativeOracleHelper,
    ): Promise<NativeOracleAuthorityRecord> {
      await session.read(() => undefined)
      // Validate the complete portable record before opening a mutation transaction.
      const backup = JSON.parse(await encodeOracleBackup(input, helper)) as OracleBackupRecord
      const summary = await helper.validateAuthority(
        JSON.stringify(backup.authority),
        backup.oraclePubkey,
      )
      const observed = await this.readByConditionId(backup.conditionId)
      let createdScalar: string | null = null
      if (observed !== null && backup.authority.nonceScalarHex !== null) {
        const signer = await this.readCreationSigner(observed.creationId)
        const profile = await session.read((database) =>
          readProfileSecretAuthority(
            database,
            options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
          ),
        )
        const exported = JSON.parse(
          await helper.exportEnumAuthority({
            oracleSecretKeyHex: signer.secretKeyHex,
            nonceSeedHex: profile.nativeOracleNonceSeedHex,
            reservedNonceIndex: observed.nonceIndex,
            announcementTlvHex: observed.announcement!.announcementTlvHex,
            announcementEventJson: observed.announcement!.announcementNostrEventJson,
            signedOutcome: null,
            attestationHex: null,
            attestationEventJson: null,
            publicationRecordJson: null,
          }),
        ) as OraclePrivateAuthority
        createdScalar = exported.nonceScalarHex
      }
      return session.transaction((database) => {
        const created = decodeRow(
          database.prepare(`${SELECT_CREATION} WHERE condition_id = ?`).get(backup.conditionId),
        )
        if (created !== null) {
          if (observed === null || JSON.stringify(created) !== JSON.stringify(observed))
            throw new NativeOracleStoreError('conflict')
          assertCreatedBackupBinding(created, backup)
          if (created.backupTerminal && backup.authority.nonceScalarHex !== null)
            throw new NativeOracleStoreError('conflict')
          if (
            backup.authority.nonceScalarHex !== null &&
            backup.authority.nonceScalarHex !== createdScalar
          )
            throw new NativeOracleStoreError('conflict')
          const publication = mergeBackupPublication(
            nativeOraclePublicationRecord(created),
            backup,
            summary.outcomes,
          )
          if (publication !== null) writeCreatedPublication(database, created, publication)
          if (backup.authority.nonceScalarHex === null)
            database
              .prepare('UPDATE daemon_oracle_creations SET backup_terminal=1 WHERE creation_id=?')
              .run(created.creationId)
          return { ...requireCreation(database, created.creationId), kind: 'created' }
        }
        if (observed !== null) throw new NativeOracleStoreError('conflict')
        const selected = database
          .prepare(
            'SELECT wallet_scope_id AS scope, nostr_public_key_hex AS pubkey FROM daemon_profile',
          )
          .get() as { scope: string; pubkey: string }
        if (selected.pubkey !== backup.oraclePubkey) throw new NativeOracleStoreError('conflict')
        if (backup.authority.nonceScalarHex !== null) {
          // An encrypted profile must not import its scalar into a plaintext row.
          readProfileSecretAuthority(
            database,
            options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
          )
        }

        const row = database
          .prepare(`${SELECT_IMPORT} WHERE condition_id = ?`)
          .get(backup.conditionId) as ImportRow | undefined
        const incoming = backupPublication(backup, summary.outcomes)
        if (row !== undefined) {
          const current = decodeImport(row)
          assertImportedBackupBinding(current, backup, summary.outcomes)
          if (!current.nonceAvailable && backup.authority.nonceScalarHex !== null)
            throw new NativeOracleStoreError('conflict')
          const privateCurrent = privateImportedAuthority(
            database,
            backup.conditionId,
            options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
          )
          if (
            privateCurrent.nonceScalarHex !== null &&
            backup.authority.nonceScalarHex !== null &&
            privateCurrent.nonceScalarHex !== backup.authority.nonceScalarHex
          )
            throw new NativeOracleStoreError('conflict')
          const merged = mergeBackupPublication(
            nativeOraclePublicationRecord(current),
            backup,
            summary.outcomes,
          )
          writeImportedMerge(database, current, merged)
          if (backup.authority.nonceScalarHex === null)
            removeImportedNonce(database, backup.conditionId)
          return decodeImport(requireImport(database, backup.conditionId))
        }
        if (
          database
            .prepare('SELECT 1 FROM daemon_oracle_creations WHERE event_id = ?')
            .get(backup.oracleEventId) ||
          database
            .prepare('SELECT 1 FROM daemon_oracle_imports WHERE event_id = ?')
            .get(backup.oracleEventId)
        )
          throw new NativeOracleStoreError('conflict')
        const binding = {
          walletScopeId: selected.scope,
          conditionId: backup.conditionId,
          oraclePubkey: backup.oraclePubkey,
          announcementEventId: readSignedOracleEvent(backup.authority.announcementEventJson, 88).id,
        }
        const protectedNonce =
          backup.authority.nonceScalarHex === null
            ? null
            : protectNativeOracleNonce(
                backup.authority.nonceScalarHex,
                binding,
                options.passphrase ?? process.env.BITCASTER_DAEMON_PASSPHRASE,
              )
        database
          .prepare(
            `INSERT INTO daemon_oracle_imports (condition_id,event_id,wallet_scope_id,oracle_pubkey,announcement_hex,announcement_event_json,outcomes_json,destinations_json,publication_json,chosen_outcome,relay_published,explanation_relay_published,explanation_draft,nonce_protection,nonce_kdf,nonce_salt,nonce_iv,nonce_auth_tag,nonce_body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            backup.conditionId,
            backup.oracleEventId,
            selected.scope,
            backup.oraclePubkey,
            backup.authority.announcementTlvHex,
            backup.authority.announcementEventJson,
            JSON.stringify(summary.outcomes),
            JSON.stringify(backup.destinations),
            incoming === null ? null : JSON.stringify(incoming),
            incoming?.chosenOutcome ?? null,
            Number(incoming?.relayPublished ?? false),
            Number(incoming?.explanationRelayPublished ?? false),
            incoming?.explanationEventJson === null || incoming?.explanationEventJson === undefined
              ? null
              : readSignedOracleEvent(incoming.explanationEventJson, 1111).content,
            protectedNonce?.protection ?? null,
            protectedNonce?.kdf ?? null,
            protectedNonce?.salt ?? null,
            protectedNonce?.iv ?? null,
            protectedNonce?.authTag ?? null,
            protectedNonce?.body ?? null,
          )
        return decodeImport(requireImport(database, backup.conditionId))
      })
    },

    async chooseAuthorityOutcome(
      conditionId: string,
      outcome: string,
      explanationDraft?: string,
    ): Promise<NativeOracleAuthorityRecord> {
      exactConditionId(conditionId)
      exactText(outcome, NATIVE_ORACLE_OUTCOME_BYTES_MAX)
      if (explanationDraft !== undefined) assertOracleExplanationText(explanationDraft)
      const current = await this.readAuthorityByConditionId(conditionId)
      if (current === null) throw new NativeOracleStoreError('not-found')
      if (current.kind === 'created')
        return {
          ...(await this.chooseOutcome(conditionId, outcome, explanationDraft)),
          kind: 'created',
        }
      return session.transaction((database) => {
        const record = decodeImport(requireImport(database, conditionId))
        if (!record.outcomes.includes(outcome)) throw new NativeOracleStoreError('conflict')
        if (record.chosenOutcome !== null) {
          if (
            record.chosenOutcome !== outcome ||
            (explanationDraft !== undefined && record.explanationDraft !== explanationDraft)
          )
            throw new NativeOracleStoreError('conflict')
          return record
        }
        if (!record.nonceAvailable) throw new NativeOracleStoreError('invalid-state')
        const publication = nativeOraclePublicationRecord({ ...record, chosenOutcome: outcome })!
        database
          .prepare(
            'UPDATE daemon_oracle_imports SET publication_json = ?, chosen_outcome = ?, explanation_draft = ? WHERE condition_id = ?',
          )
          .run(JSON.stringify(publication), outcome, explanationDraft ?? null, conditionId)
        return decodeImport(requireImport(database, conditionId))
      })
    },

    async persistAuthorityAttestation(
      conditionId: string,
      outcome: string,
      artifact: NativeOracleAttestation,
    ): Promise<NativeOracleAuthorityRecord> {
      exactConditionId(conditionId)
      exactText(outcome, NATIVE_ORACLE_OUTCOME_BYTES_MAX)
      exactHex(artifact.attestationHex)
      exactJsonObject(artifact.attestationNostrEventJson, NATIVE_ORACLE_EVENT_JSON_BYTES_MAX)
      const current = await this.readAuthorityByConditionId(conditionId)
      if (current === null) throw new NativeOracleStoreError('not-found')
      if (current.kind === 'created')
        return {
          ...(await this.persistAttestation(current.creationId, outcome, artifact)),
          kind: 'created',
        }
      return session.transaction((database) => {
        const record = decodeImport(requireImport(database, conditionId))
        if (record.chosenOutcome === null) throw new NativeOracleStoreError('invalid-state')
        if (record.chosenOutcome !== outcome) throw new NativeOracleStoreError('conflict')
        const publication = nativeOraclePublicationRecord(record)!
        const merged = mergeOraclePublicationRecords(
          publication,
          snapshotOraclePublicationRecord({
            ...publication,
            attestation: {
              attestationHex: artifact.attestationHex,
              eventJson: artifact.attestationNostrEventJson,
            },
          }),
        )
        writeImportedPublication(database, conditionId, merged)
        return decodeImport(requireImport(database, conditionId))
      })
    },

    async persistAuthorityPublicationProgress(
      conditionId: string,
      change: NativeOraclePublicationChange,
    ): Promise<NativeOracleAuthorityRecord> {
      exactConditionId(conditionId)
      const current = await this.readAuthorityByConditionId(conditionId)
      if (current === null) throw new NativeOracleStoreError('not-found')
      if (current.kind === 'created')
        return { ...(await this.persistPublicationProgress(conditionId, change)), kind: 'created' }
      return session.transaction((database) => {
        const record = decodeImport(requireImport(database, conditionId))
        const publication = nativeOraclePublicationRecord(record)
        if (publication?.attestation == null) throw new NativeOracleStoreError('invalid-state')
        const changed = publicationProgress(publication, record.explanationDraft, change)
        writeImportedPublication(
          database,
          conditionId,
          mergeOraclePublicationRecords(publication, changed),
        )
        return decodeImport(requireImport(database, conditionId))
      })
    },

    async terminalizeImported(conditionId: string): Promise<NativeImportedOracleRecord> {
      exactConditionId(conditionId)
      return session.transaction((database) => {
        const record = decodeImport(requireImport(database, conditionId))
        if (record.attestation === null || !record.relayPublished)
          throw new NativeOracleStoreError('invalid-state')
        removeImportedNonce(database, conditionId)
        return decodeImport(requireImport(database, conditionId))
      })
    },

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
  nonce_index AS nonceIndex, canonical_input AS canonicalInput, created_at_ms AS createdAtMs, backup_terminal AS backupTerminal,
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
  backupTerminal: number
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
    backupTerminal: value.backupTerminal === 1,
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
  record: NativeOracleCreationRecord | NativeImportedOracleRecord,
): OraclePublicationRecord | null {
  if (record.announcement === null || record.chosenOutcome === null) return null
  const outcomes =
    'kind' in record && record.kind === 'imported'
      ? record.outcomes
      : normalizeMarketCreationInput(
          (
            JSON.parse((record as NativeOracleCreationRecord).canonicalInput) as {
              market: MarketCreationInput
            }
          ).market,
        ).outcomeLabels
  return snapshotOraclePublicationRecord({
    binding: {
      conditionId: record.announcement.conditionId,
      oracleEventId: record.eventId,
      oraclePubkey: record.creatorPublicKeyHex,
      outcomes,
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

const SELECT_IMPORT = `SELECT condition_id AS conditionId, event_id AS eventId,
  wallet_scope_id AS walletScopeId, oracle_pubkey AS oraclePubkey,
  announcement_hex AS announcementTlvHex, announcement_event_json AS announcementEventJson,
  outcomes_json AS outcomesJson, destinations_json AS destinationsJson,
  publication_json AS publicationJson, explanation_draft AS explanationDraft,
  nonce_protection AS protection, nonce_kdf AS kdf, nonce_salt AS salt,
  nonce_iv AS iv, nonce_auth_tag AS authTag, nonce_body AS body FROM daemon_oracle_imports`

type ImportRow = Omit<ProtectedSecretBody, 'protection' | 'body'> & {
  conditionId: string
  eventId: string
  walletScopeId: string
  oraclePubkey: string
  announcementTlvHex: string
  announcementEventJson: string
  outcomesJson: string
  destinationsJson: string
  publicationJson: string | null
  explanationDraft: string | null
  protection: ProtectedSecretBody['protection'] | null
  body: Uint8Array | null
}

function decodeImport(row: unknown): NativeImportedOracleRecord {
  const value = row as ImportRow
  const publication =
    value.publicationJson === null
      ? null
      : snapshotOraclePublicationRecord(JSON.parse(value.publicationJson))
  return {
    kind: 'imported',
    walletScopeId: value.walletScopeId,
    eventId: value.eventId,
    creatorPublicKeyHex: value.oraclePubkey,
    announcement: {
      conditionId: value.conditionId,
      announcementTlvHex: value.announcementTlvHex,
      announcementNostrEventJson: value.announcementEventJson,
    },
    outcomes: JSON.parse(value.outcomesJson),
    destinations: JSON.parse(value.destinationsJson),
    nonceAvailable: value.body !== null,
    chosenOutcome: publication?.chosenOutcome ?? null,
    explanationDraft: value.explanationDraft,
    attestation:
      publication?.attestation == null
        ? null
        : {
            attestationHex: publication.attestation.attestationHex,
            attestationNostrEventJson: publication.attestation.eventJson,
          },
    relayPublished: publication?.relayPublished ?? false,
    engineEvidence: publication?.engineEvidence ?? null,
    explanationEventJson: publication?.explanationEventJson ?? null,
    explanationRelayPublished: publication?.explanationRelayPublished ?? false,
  }
}

function requireImport(database: DatabaseSync, conditionId: string): ImportRow {
  const row = database.prepare(`${SELECT_IMPORT} WHERE condition_id = ?`).get(conditionId) as
    | ImportRow
    | undefined
  if (row === undefined) throw new NativeOracleStoreError('not-found')
  return row
}

function readAuthority(
  database: DatabaseSync,
  conditionId: string,
): NativeOracleAuthorityRecord | null {
  const created = decodeRow(
    database.prepare(`${SELECT_CREATION} WHERE condition_id = ?`).get(conditionId),
  )
  if (created !== null) return { ...created, kind: 'created' }
  const imported = database.prepare(`${SELECT_IMPORT} WHERE condition_id = ?`).get(conditionId)
  return imported === undefined ? null : decodeImport(imported)
}

function privateImportedAuthority(
  database: DatabaseSync,
  conditionId: string,
  passphrase?: string,
): OraclePrivateAuthority {
  const row = requireImport(database, conditionId)
  const record = decodeImport(row)
  let nonceScalarHex: string | null = null
  if (row.body !== null && row.protection !== null) {
    try {
      nonceScalarHex = unlockNativeOracleNonce(
        { ...row, body: row.body, protection: row.protection },
        {
          walletScopeId: row.walletScopeId,
          conditionId,
          oraclePubkey: row.oraclePubkey,
          announcementEventId: readSignedOracleEvent(row.announcementEventJson, 88).id,
        },
        passphrase,
      )
    } catch {
      throw new NativeOracleStoreError('invalid-state')
    }
  }
  const publication = nativeOraclePublicationRecord(record)
  return {
    schemaVersion: 1,
    announcementTlvHex: row.announcementTlvHex,
    announcementEventJson: row.announcementEventJson,
    nonceScalarHex,
    signedOutcome: record.chosenOutcome,
    attestationHex: record.attestation?.attestationHex ?? null,
    attestationEventJson: record.attestation?.attestationNostrEventJson ?? null,
    publicationRecordJson: publication === null ? null : JSON.stringify(publication),
  }
}

function importedBackup(
  record: NativeImportedOracleRecord,
  authority: OraclePrivateAuthority,
): OracleBackupRecord {
  return {
    schemaVersion: 1,
    conditionId: record.announcement.conditionId,
    oracleEventId: record.eventId,
    oraclePubkey: record.creatorPublicKeyHex,
    authority,
    destinations: record.destinations,
  }
}

function backupPublication(
  backup: OracleBackupRecord,
  outcomes: readonly string[],
): OraclePublicationRecord | null {
  if (backup.authority.publicationRecordJson !== null)
    return snapshotOraclePublicationRecord(JSON.parse(backup.authority.publicationRecordJson))
  if (backup.authority.signedOutcome === null) return null
  return snapshotOraclePublicationRecord({
    binding: {
      conditionId: backup.conditionId,
      oracleEventId: backup.oracleEventId,
      oraclePubkey: backup.oraclePubkey,
      outcomes,
      announcementEventJson: backup.authority.announcementEventJson,
    },
    chosenOutcome: backup.authority.signedOutcome,
    attestation:
      backup.authority.attestationHex === null
        ? null
        : {
            attestationHex: backup.authority.attestationHex,
            eventJson: backup.authority.attestationEventJson!,
          },
    relayPublished: false,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  })
}

function mergeBackupPublication(
  current: OraclePublicationRecord | null,
  backup: OracleBackupRecord,
  outcomes: readonly string[],
): OraclePublicationRecord | null {
  try {
    return mergeOraclePublicationRecords(current, backupPublication(backup, outcomes))
  } catch {
    throw new NativeOracleStoreError('conflict')
  }
}

function assertImportedBackupBinding(
  current: NativeImportedOracleRecord,
  backup: OracleBackupRecord,
  outcomes: readonly string[],
): void {
  if (
    current.creatorPublicKeyHex !== backup.oraclePubkey ||
    current.eventId !== backup.oracleEventId ||
    current.announcement.announcementTlvHex !== backup.authority.announcementTlvHex ||
    current.announcement.announcementNostrEventJson !== backup.authority.announcementEventJson ||
    JSON.stringify(current.outcomes) !== JSON.stringify(outcomes) ||
    JSON.stringify(current.destinations) !== JSON.stringify(backup.destinations)
  )
    throw new NativeOracleStoreError('conflict')
}

function assertCreatedBackupBinding(
  current: NativeOracleCreationRecord,
  backup: OracleBackupRecord,
): void {
  const canonical = JSON.parse(current.canonicalInput) as {
    destination: { mintUrl: string; engineBaseUrl: string; relayUrls: readonly string[] }
  }
  if (
    current.creatorPublicKeyHex !== backup.oraclePubkey ||
    current.eventId !== backup.oracleEventId ||
    current.announcement?.announcementTlvHex !== backup.authority.announcementTlvHex ||
    current.announcement?.announcementNostrEventJson !== backup.authority.announcementEventJson ||
    canonical.destination.mintUrl !== backup.destinations.mintUrl ||
    canonical.destination.engineBaseUrl !== backup.destinations.engineUrl ||
    JSON.stringify(normalizeNostrRelayUrls(canonical.destination.relayUrls)) !==
      JSON.stringify(backup.destinations.relayUrls)
  )
    throw new NativeOracleStoreError('conflict')
}

function writeImportedPublication(
  database: DatabaseSync,
  conditionId: string,
  publication: OraclePublicationRecord | null,
): void {
  database
    .prepare(
      'UPDATE daemon_oracle_imports SET publication_json = ?, chosen_outcome = ?, relay_published = ?, explanation_relay_published = ? WHERE condition_id = ?',
    )
    .run(
      publication === null ? null : JSON.stringify(publication),
      publication?.chosenOutcome ?? null,
      Number(publication?.relayPublished ?? false),
      Number(publication?.explanationRelayPublished ?? false),
      conditionId,
    )
}

function writeImportedMerge(
  database: DatabaseSync,
  current: NativeImportedOracleRecord,
  publication: OraclePublicationRecord | null,
): void {
  const draft =
    current.chosenOutcome === null && publication?.explanationEventJson != null
      ? readSignedOracleEvent(publication.explanationEventJson, 1111).content
      : current.explanationDraft
  if (
    publication?.explanationEventJson != null &&
    draft !== readSignedOracleEvent(publication.explanationEventJson, 1111).content
  )
    throw new NativeOracleStoreError('conflict')
  database
    .prepare(
      'UPDATE daemon_oracle_imports SET publication_json = ?, chosen_outcome = ?, relay_published = ?, explanation_relay_published = ?, explanation_draft = ? WHERE condition_id = ?',
    )
    .run(
      publication === null ? null : JSON.stringify(publication),
      publication?.chosenOutcome ?? null,
      Number(publication?.relayPublished ?? false),
      Number(publication?.explanationRelayPublished ?? false),
      draft,
      current.announcement.conditionId,
    )
}

function removeImportedNonce(database: DatabaseSync, conditionId: string): void {
  database
    .prepare(
      'UPDATE daemon_oracle_imports SET nonce_protection=NULL,nonce_kdf=NULL,nonce_salt=NULL,nonce_iv=NULL,nonce_auth_tag=NULL,nonce_body=NULL WHERE condition_id = ?',
    )
    .run(conditionId)
}

function writeCreatedPublication(
  database: DatabaseSync,
  current: NativeOracleCreationRecord,
  publication: OraclePublicationRecord,
): void {
  const draft =
    current.chosenOutcome === null && publication.explanationEventJson !== null
      ? readSignedOracleEvent(publication.explanationEventJson, 1111).content
      : current.explanationDraft
  if (
    publication.explanationEventJson !== null &&
    draft !== readSignedOracleEvent(publication.explanationEventJson, 1111).content
  )
    throw new NativeOracleStoreError('conflict')
  database
    .prepare(
      `UPDATE daemon_oracle_creations SET chosen_outcome=?,explanation_draft=?,attestation_hex=?,attestation_event_json=?,attestation_relay_published=?,attestation_engine_evidence_json=?,explanation_event_json=?,explanation_relay_published=? WHERE creation_id=?`,
    )
    .run(
      publication.chosenOutcome,
      draft,
      publication.attestation?.attestationHex ?? null,
      publication.attestation?.eventJson ?? null,
      Number(publication.relayPublished),
      publication.engineEvidence === null ? null : JSON.stringify(publication.engineEvidence),
      publication.explanationEventJson,
      Number(publication.explanationRelayPublished),
      current.creationId,
    )
}

function publicationProgress(
  publication: OraclePublicationRecord,
  draft: string | null,
  change: NativeOraclePublicationChange,
): OraclePublicationRecord {
  switch (change.kind) {
    case 'relay':
      if (readSignedOracleEvent(publication.attestation!.eventJson, 89).id !== change.eventId)
        throw new NativeOracleStoreError('conflict')
      return snapshotOraclePublicationRecord({ ...publication, relayPublished: true })
    case 'engine':
      return snapshotOraclePublicationRecord({ ...publication, engineEvidence: change.evidence })
    case 'explanation':
      if (draft === null || readSignedOracleEvent(change.eventJson, 1111).content !== draft)
        throw new NativeOracleStoreError('conflict')
      return snapshotOraclePublicationRecord({
        ...publication,
        explanationEventJson: change.eventJson,
      })
    case 'explanation-relay':
      if (
        publication.explanationEventJson === null ||
        readSignedOracleEvent(publication.explanationEventJson, 1111).id !== change.eventId
      )
        throw new NativeOracleStoreError('conflict')
      return snapshotOraclePublicationRecord({ ...publication, explanationRelayPublished: true })
  }
}
