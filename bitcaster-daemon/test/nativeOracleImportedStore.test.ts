import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import {
  deriveDlcConditionId,
  snapshotOraclePublicationRecord,
  type OracleBackupRecord,
  type OraclePrivateAuthority,
} from '@bitcaster-market/client-sdk'
import { bootstrapFreshDaemonProfile, readProfileSecretAuthority } from '../src/profileBootstrap.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import {
  createNativeOracleCreationStore,
  nativeOraclePublicationRecord,
} from '../src/nativeOracleCreationStore.ts'
import { createNativeOracleHelperAdapter } from '../src/nativeOracleHelper.ts'
import {
  publishNativeMarketOutcome,
  retryNativeMarketPublication,
  type NativeOraclePublicationPorts,
} from '../src/nativeOraclePublicationCoordinator.ts'
import {
  prepareNativeMarketOracle,
  type NativeMarketCreationInput,
} from '../src/nativeMarketOracle.ts'

const helperPath = process.env.BITCASTER_TEST_NATIVE_ORACLE_HELPER
const helper = createNativeOracleHelperAdapter({ resolveExecutable: () => helperPath! })
const signer = '01'.repeat(32)
const owner = getPublicKey(Buffer.from(signer, 'hex'))
const destinations = {
  mintUrl: 'https://mint.example',
  engineUrl: 'https://engine.example',
  relayUrls: ['wss://relay.example'],
}
const realHelper = {
  skip:
    helperPath === undefined
      ? 'Set BITCASTER_TEST_NATIVE_ORACLE_HELPER to the explicit prebuilt native helper.'
      : false,
}
const relayOnly = { engineDelivery: 'relay-only' as const }

async function fixture(eventId: string): Promise<OracleBackupRecord> {
  const nonceSeedHex = '02'.repeat(32)
  const created = await helper.createEnum({
    oracleSecretKeyHex: signer,
    nonceSeedHex,
    reservedNonceIndex: 257,
    eventId,
    outcomes: ['Yes', 'No'],
    eventMaturityEpoch: 2_000_000_000,
    title: 'Test',
    description: 'Test event.',
  })
  const authority = JSON.parse(
    await helper.exportEnumAuthority({
      oracleSecretKeyHex: signer,
      nonceSeedHex,
      reservedNonceIndex: 257,
      announcementTlvHex: created.announcementTlvHex,
      announcementEventJson: created.announcementNostrEventJson,
      signedOutcome: null,
      attestationHex: null,
      attestationEventJson: null,
      publicationRecordJson: null,
    }),
  ) as OraclePrivateAuthority
  return {
    schemaVersion: 1,
    conditionId: deriveDlcConditionId({ eventId, outcomeCount: 2, oraclePublicKeys: [owner] }),
    oraclePubkey: owner,
    oracleEventId: eventId,
    authority,
    destinations,
  }
}

async function withProfile(run: (directory: string) => Promise<void>, passphrase?: string) {
  const root = await mkdtemp(join(tmpdir(), 'oracle-import-provider-'))
  const directory = join(root, 'profile')
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: destinations.engineUrl,
      mintUrl: destinations.mintUrl,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: signer,
      passphrase,
    })
    await run(directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function ports(
  directory: string,
  hooks: Partial<NativeOraclePublicationPorts> = {},
): NativeOraclePublicationPorts {
  return {
    store: createNativeOracleCreationStore(directory),
    helper,
    async readSigner() {
      return { secretKeyHex: signer, nonceSeedHex: '03'.repeat(32) }
    },
    async publishRelay(eventJson) {
      return { eventId: JSON.parse(eventJson).id }
    },
    async submitEvent() {
      throw new Error('Engine must not run in relay-only mode.')
    },
    async readResolution() {
      throw new Error('Engine must not run in relay-only mode.')
    },
    ...hooks,
  }
}

test(
  'real SQLite imported authority reloads with protected scalar and no creation or allocator authority',
  realHelper,
  async () => {
    const backup = await fixture('protected-import')
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory, { passphrase: 'test-passphrase' })
      const imported = await store.importBackup(backup, helper)
      assert.equal(imported.kind, 'imported')
      for (const privateOrCreated of ['nonceScalarHex', 'nonceIndex', 'marketCreation'])
        assert.equal(privateOrCreated in imported, false)
      const cold = createNativeOracleCreationStore(directory, { passphrase: 'test-passphrase' })
      assert.ok(
        isDeepStrictEqual(await cold.exportBackup(backup.conditionId, helper), backup),
        'Private authority changed on reload.',
      )
      assert.equal((await cold.listImported()).length, 1)
      await assert.rejects(
        createNativeOracleCreationStore(directory).importBackup(backup, helper),
        /passphrase is required/,
      )
      const stored = await createDaemonStateSqliteSession(directory).read((database) => ({
        creations: database.prepare('SELECT COUNT(*) AS count FROM daemon_oracle_creations').get()
          ?.count,
        index: database
          .prepare('SELECT next_nonce_index AS next FROM daemon_oracle_nonce_allocator')
          .get()?.next,
        protection: database
          .prepare('SELECT nonce_protection AS kind FROM daemon_oracle_imports')
          .get()?.kind,
        rawScalar: database
          .prepare('SELECT hex(nonce_body) AS body FROM daemon_oracle_imports')
          .get()?.body,
      }))
      assert.equal(stored.creations, 0)
      assert.equal(stored.index, 0)
      assert.equal(stored.protection, 'scrypt-aes-256-gcm')
      assert.ok(
        stored.rawScalar !== backup.authority.nonceScalarHex?.toUpperCase(),
        'Scalar was stored without profile protection.',
      )
      await assert.rejects(
        createNativeOracleCreationStore(directory, {
          passphrase: 'wrong',
        }).readImportedAuthorityForSigning(backup.conditionId),
        /invalid-state/,
      )
    }, 'test-passphrase')
  },
)

test(
  'real SQLite opposite-choice race preserves one choice before helper signing and after restart',
  realHelper,
  async () => {
    const backup = await fixture('choice-race')
    await withProfile(async (directory) => {
      const first = createNativeOracleCreationStore(directory)
      const second = createNativeOracleCreationStore(directory)
      await first.importBackup(backup, helper)
      const results = await Promise.allSettled([
        first.chooseAuthorityOutcome(backup.conditionId, 'Yes'),
        second.chooseAuthorityOutcome(backup.conditionId, 'No'),
      ])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
      const cold = createNativeOracleCreationStore(directory)
      const chosen = (await cold.readAuthorityByConditionId(backup.conditionId))!.chosenOutcome!
      await assert.rejects(
        cold.chooseAuthorityOutcome(backup.conditionId, chosen === 'Yes' ? 'No' : 'Yes'),
        /conflict/,
      )
      const privateChoice = await cold.readImportedAuthorityForSigning(backup.conditionId)
      assert.equal(privateChoice.signedOutcome, chosen)
      assert.equal(privateChoice.attestationHex, null)
      const published = await publishNativeMarketOutcome(
        ports(directory),
        backup.conditionId,
        chosen,
        undefined,
        relayOnly,
      )
      assert.equal(published.record.relayPublished, true)
      const verified = await helper.verifyEnum({
        eventId: backup.oracleEventId,
        oraclePublicKeyHex: owner,
        chosenOutcome: chosen,
        announcementTlvHex: backup.authority.announcementTlvHex,
        announcementNostrEventJson: backup.authority.announcementEventJson,
        attestationHex: published.record.attestation!.attestationHex,
        attestationNostrEventJson: published.record.attestation!.eventJson,
      })
      assert.equal(
        verified.noncePointHex,
        (await helper.validateAuthority(JSON.stringify(backup.authority), owner)).noncePoint,
      )
      const retry = await retryNativeMarketPublication(
        ports(directory, {
          async readSigner() {
            throw new Error('Exact retry cannot sign.')
          },
        }),
        backup.conditionId,
        relayOnly,
      )
      assert.equal(retry.record.attestation!.eventJson, published.record.attestation!.eventJson)
      await cold.importBackup(backup, helper)
      assert.equal(
        (await cold.readAuthorityByConditionId(backup.conditionId))!.chosenOutcome,
        chosen,
      )
    })
  },
)

test(
  'real SQLite terminal import retries exact signed artifacts without signer and refuses scalar downgrade',
  realHelper,
  async () => {
    const backup = await fixture('terminal')
    let terminal!: OracleBackupRecord
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      await store.importBackup(backup, helper)
      await assert.rejects(store.terminalizeAuthority(backup.conditionId), /invalid-state/)
      await publishNativeMarketOutcome(
        ports(directory),
        backup.conditionId,
        'Yes',
        'Test explanation.',
        relayOnly,
      )
      await store.terminalizeAuthority(backup.conditionId)
      terminal = await createNativeOracleCreationStore(directory).exportBackup(
        backup.conditionId,
        helper,
      )
      assert.ok(terminal.authority.nonceScalarHex === null, 'Terminal backup retained a scalar.')
      await assert.rejects(store.importBackup(backup, helper), /conflict/)
      await assert.rejects(
        createDaemonStateSqliteSession(directory).transaction((database) =>
          database
            .prepare(
              "UPDATE daemon_oracle_imports SET nonce_protection='owner-only-plaintext',nonce_body=?",
            )
            .run(Buffer.from(backup.authority.nonceScalarHex!, 'hex')),
        ),
        /immutable/,
      )
    })
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      await store.importBackup(terminal, helper)
      const result = await retryNativeMarketPublication(
        ports(directory, {
          async readSigner() {
            throw new Error('Terminal retry cannot sign.')
          },
        }),
        backup.conditionId,
        relayOnly,
      )
      assert.equal(result.record.attestation!.eventJson, terminal.authority.attestationEventJson)
      await assert.rejects(store.importBackup(backup, helper), /conflict/)
    })
  },
)

test(
  'real helper malformed authority, wrong owner, and wrong destinations refuse without mutation',
  realHelper,
  async () => {
    const backup = await fixture('refusals')
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      for (const invalid of [
        { ...backup, authority: { ...backup.authority, nonceScalarHex: '03'.repeat(32) } },
        {
          ...backup,
          authority: {
            ...backup.authority,
            announcementTlvHex: backup.authority.announcementTlvHex + '00',
          },
        },
        { ...backup, oraclePubkey: '00'.repeat(32) },
        { ...backup, conditionId: 'ab'.repeat(32) },
        { ...backup, destinations: { ...destinations, mintUrl: 'not-a-url' } },
      ]) {
        await assert.rejects(store.importBackup(invalid, helper), (error) => {
          assert.equal((error as Error).message, 'Private oracle backup: invalid-record.')
          return true
        })
        assert.equal((await store.listImported()).length, 0)
      }
      await store.importBackup(backup, helper)
      await assert.rejects(
        store.importBackup(
          { ...backup, destinations: { ...destinations, engineUrl: 'https://other.example' } },
          helper,
        ),
        /conflict/,
      )
      await assert.rejects(
        store.reserveCreation({
          creationId: 'collision',
          eventId: backup.oracleEventId,
          canonicalInput: '{}',
        }),
        /oracle authority conflicts/,
      )
      const allocation = await createDaemonStateSqliteSession(directory).read(
        (database) =>
          database
            .prepare('SELECT next_nonce_index AS next FROM daemon_oracle_nonce_allocator')
            .get()?.next,
      )
      assert.equal(allocation, 0)
    })
  },
)

test(
  'real helper and SQLite retained-index export above 255 merges created collision without invented creation facts',
  realHelper,
  async () => {
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      const session = createDaemonStateSqliteSession(directory)
      await session.transaction((database) =>
        database.prepare('UPDATE daemon_oracle_nonce_allocator SET next_nonce_index=300').run(),
      )
      const input: NativeMarketCreationInput = {
        creationId: 'created',
        eventId: 'created-event',
        market: {
          title: 'Test',
          description: 'Test event.',
          outcomeType: 'yesno',
          outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
          maturityEpoch: 2_000_000_000,
          categoryTags: [],
          baseAsset: 'sat',
        },
        registration: { requiredFeeMsat: 0 },
        destination: {
          engineBaseUrl: destinations.engineUrl,
          mintUrl: destinations.mintUrl,
          relayUrls: destinations.relayUrls,
        },
      }
      const profile = await session.read((database) => readProfileSecretAuthority(database))
      const created = await prepareNativeMarketOracle(
        {
          store,
          helper,
          oracleSecretKeyHex: signer,
          nonceSeedHex: profile.nativeOracleNonceSeedHex,
        },
        input,
      )
      const conditionId = created.record.announcement!.conditionId
      const backup = await store.exportBackup(conditionId, helper)
      assert.equal(created.record.nonceIndex, 300)
      assert.ok(backup.authority.nonceScalarHex !== null)
      assert.equal((await store.importBackup(backup, helper)).kind, 'created')
      assert.equal((await store.listImported()).length, 0)
      assert.equal((await store.readCreation('created'))!.nonceIndex, 300)
      assert.equal(
        (
          await session.read((database) =>
            database
              .prepare('SELECT next_nonce_index AS next FROM daemon_oracle_nonce_allocator')
              .get(),
          )
        )?.next,
        301,
      )
      await publishNativeMarketOutcome(
        ports(directory, {
          async readSigner() {
            return { secretKeyHex: signer, nonceSeedHex: profile.nativeOracleNonceSeedHex }
          },
        }),
        conditionId,
        'Yes',
        undefined,
        relayOnly,
      )
      await store.terminalizeAuthority(conditionId)
      assert.ok(
        (await store.exportBackup(conditionId, helper)).authority.nonceScalarHex === null,
        'Terminal backup retained a scalar.',
      )
      await assert.rejects(store.importBackup(backup, helper), /conflict/)
      assert.equal((await store.readCreationSigner('created')).publicKeyHex, owner)
    })
  },
)

test(
  'SQLite imported signed choice merges progress monotonically and rejects exact-envelope conflict',
  realHelper,
  async () => {
    const backup = await fixture('artifact-merge')
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      await store.importBackup(backup, helper)
      await store.chooseAuthorityOutcome(backup.conditionId, 'Yes')
      const signature = await helper.signExplicitEnum({
        oracleSecretKeyHex: signer,
        privateDtoJson: JSON.stringify(
          await store.readImportedAuthorityForSigning(backup.conditionId),
        ),
        chosenOutcome: 'Yes',
      })
      await store.persistAuthorityAttestation(backup.conditionId, 'Yes', signature)
      const saved = await createNativeOracleCreationStore(directory).readAuthorityByConditionId(
        backup.conditionId,
      )
      const publication = nativeOraclePublicationRecord(saved!)!
      assert.equal(publication.attestation!.eventJson, signature.attestationNostrEventJson)
      const incoming = snapshotOraclePublicationRecord({ ...publication, relayPublished: true })
      const advanced: OracleBackupRecord = {
        ...backup,
        authority: {
          ...backup.authority,
          signedOutcome: 'Yes',
          attestationHex: signature.attestationHex,
          attestationEventJson: signature.attestationNostrEventJson,
          publicationRecordJson: JSON.stringify(incoming),
        },
      }
      await store.importBackup(advanced, helper)
      await store.importBackup(
        {
          ...advanced,
          authority: { ...advanced.authority, publicationRecordJson: JSON.stringify(publication) },
        },
        helper,
      )
      const cold = await createNativeOracleCreationStore(directory).readAuthorityByConditionId(
        backup.conditionId,
      )
      assert.equal(cold?.relayPublished, true)
      assert.equal(
        cold?.attestation?.attestationNostrEventJson,
        signature.attestationNostrEventJson,
      )
      await assert.rejects(
        store.persistAuthorityAttestation(backup.conditionId, 'No', signature),
        /conflict/,
      )
    })
  },
)

test(
  'real SQLite same-choice signed-envelope race retains only the winning exact envelope',
  realHelper,
  async () => {
    const backup = await fixture('envelope-race')
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      await store.importBackup(backup, helper)
      await store.chooseAuthorityOutcome(backup.conditionId, 'Yes')
      const signed = await helper.signExplicitEnum({
        oracleSecretKeyHex: signer,
        privateDtoJson: JSON.stringify(
          await store.readImportedAuthorityForSigning(backup.conditionId),
        ),
        chosenOutcome: 'Yes',
      })
      const original = JSON.parse(signed.attestationNostrEventJson)
      const alternateJson = JSON.stringify(
        finalizeEvent(
          { ...original, created_at: original.created_at + 1 },
          Buffer.from(signer, 'hex'),
        ),
      )
      await helper.verifyEnum({
        eventId: backup.oracleEventId,
        oraclePublicKeyHex: owner,
        chosenOutcome: 'Yes',
        announcementTlvHex: backup.authority.announcementTlvHex,
        announcementNostrEventJson: backup.authority.announcementEventJson,
        attestationHex: signed.attestationHex,
        attestationNostrEventJson: alternateJson,
      })
      const stores = [
        createNativeOracleCreationStore(directory),
        createNativeOracleCreationStore(directory),
      ]
      const results = await Promise.allSettled([
        stores[0].persistAuthorityAttestation(backup.conditionId, 'Yes', signed),
        stores[1].persistAuthorityAttestation(backup.conditionId, 'Yes', {
          attestationHex: signed.attestationHex,
          attestationNostrEventJson: alternateJson,
        }),
      ])
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
      const cold = createNativeOracleCreationStore(directory)
      const retained = (await cold.readAuthorityByConditionId(backup.conditionId))!.attestation!
        .attestationNostrEventJson
      assert.ok(retained === signed.attestationNostrEventJson || retained === alternateJson)
      let delivered = ''
      await retryNativeMarketPublication(
        ports(directory, {
          async readSigner() {
            throw new Error('Saved envelope cannot sign again.')
          },
          async publishRelay(eventJson) {
            delivered = eventJson
            return { eventId: JSON.parse(eventJson).id }
          },
        }),
        backup.conditionId,
        relayOnly,
      )
      assert.equal(delivered, retained)
      assert.equal(
        (await cold.readAuthorityByConditionId(backup.conditionId))!.attestation!
          .attestationNostrEventJson,
        retained,
      )
    })
  },
)

test(
  'real SQLite terminal relay-only restore later synchronizes the exact artifact without a signer',
  realHelper,
  async () => {
    const backup = await fixture('later-engine')
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      await store.importBackup(backup, helper)
      const relay = await publishNativeMarketOutcome(
        ports(directory),
        backup.conditionId,
        'Yes',
        undefined,
        relayOnly,
      )
      const exact = relay.record.attestation!.eventJson
      assert.equal(relay.record.engineEvidence, null)
      await store.terminalizeAuthority(backup.conditionId)
      let submissions = 0
      const syncPorts = ports(directory, {
        async readSigner() {
          throw new Error('Terminal exact synchronization cannot sign.')
        },
        async publishRelay() {
          throw new Error('Confirmed relay artifact does not need another publication.')
        },
        async submitEvent(conditionId, eventJson) {
          submissions++
          assert.equal(conditionId, backup.conditionId)
          assert.equal(eventJson, exact)
        },
        async readResolution(conditionId) {
          const saved =
            (await createNativeOracleCreationStore(directory).readAuthorityByConditionId(
              conditionId,
            ))!
          const checked = await helper.verifyEnum({
            eventId: saved.eventId,
            oraclePublicKeyHex: saved.creatorPublicKeyHex,
            chosenOutcome: saved.chosenOutcome!,
            announcementTlvHex: saved.announcement!.announcementTlvHex,
            announcementNostrEventJson: saved.announcement!.announcementNostrEventJson,
            attestationHex: saved.attestation!.attestationHex,
            attestationNostrEventJson: saved.attestation!.attestationNostrEventJson,
          })
          const { created_at, ...event } = JSON.parse(saved.attestation!.attestationNostrEventJson)
          return {
            conditionId,
            attestedOutcome: saved.chosenOutcome,
            attestationEvent: { ...event, createdAt: created_at },
            registeredAuthority: {
              eventId: saved.eventId,
              outcomes: ['Yes', 'No'],
              threshold: 1,
              oracles: [
                {
                  oraclePublicKey: owner,
                  noncePoint: checked.noncePointHex,
                  announcementIdentity: createHash('sha256')
                    .update(Buffer.from(saved.announcement!.announcementTlvHex, 'hex'))
                    .digest('hex'),
                },
              ],
            },
            oracleWitness: {
              oracle_sigs: [
                {
                  oracle_pubkey: owner,
                  oracle_sig: checked.oracleSignatureHex,
                  outcome: saved.chosenOutcome,
                },
              ],
            },
          }
        },
      })
      const synced = await retryNativeMarketPublication(syncPorts, backup.conditionId)
      assert.ok(synced.record.engineEvidence)
      assert.equal(synced.record.attestation!.eventJson, exact)
      assert.equal(submissions, 1)
      const retry = await retryNativeMarketPublication(syncPorts, backup.conditionId)
      assert.ok(retry.record.engineEvidence)
      assert.equal(submissions, 1)
      const cold = await createNativeOracleCreationStore(directory).readAuthorityByConditionId(
        backup.conditionId,
      )
      assert.ok(cold?.engineEvidence)
      assert.equal(cold?.attestation?.attestationNostrEventJson, exact)
    })
  },
)

test(
  'real SQLite export refuses a stale authority snapshot after helper validation',
  realHelper,
  async () => {
    for (const kind of ['imported', 'created'] as const) {
      await withProfile(async (directory) => {
        const store = createNativeOracleCreationStore(directory)
        let conditionId: string
        if (kind === 'imported') {
          const backup = await fixture('export-race-imported')
          await store.importBackup(backup, helper)
          conditionId = backup.conditionId
        } else {
          const profile = await createDaemonStateSqliteSession(directory).read((database) =>
            readProfileSecretAuthority(database),
          )
          const created = await prepareNativeMarketOracle(
            {
              store,
              helper,
              oracleSecretKeyHex: signer,
              nonceSeedHex: profile.nativeOracleNonceSeedHex,
            },
            {
              creationId: 'export-race-created',
              eventId: 'export-race-created',
              market: {
                title: 'Test',
                description: 'Test event.',
                outcomeType: 'yesno',
                outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
                maturityEpoch: 2_000_000_000,
                categoryTags: [],
                baseAsset: 'sat',
              },
              registration: { requiredFeeMsat: 0 },
              destination: {
                engineBaseUrl: destinations.engineUrl,
                mintUrl: destinations.mintUrl,
                relayUrls: destinations.relayUrls,
              },
            },
          )
          conditionId = created.record.announcement!.conditionId
        }
        const racingHelper = {
          ...helper,
          async validateAuthority(privateDtoJson: string, expectedOraclePubkey: string) {
            const summary = await helper.validateAuthority(privateDtoJson, expectedOraclePubkey)
            await createNativeOracleCreationStore(directory).chooseAuthorityOutcome(
              conditionId,
              'Yes',
            )
            return summary
          },
        }
        await assert.rejects(store.exportBackup(conditionId, racingHelper), /conflict/)
        const cold = createNativeOracleCreationStore(directory)
        const saved = await cold.exportBackup(conditionId, helper)
        assert.equal(saved.authority.signedOutcome, 'Yes')
        assert.equal(saved.authority.attestationHex, null)
      })
    }
  },
)

for (const invalid of [
  {
    name: 'a scalar with no protection kind',
    protection: null,
    kdf: null,
    salt: null,
    iv: null,
    authTag: null,
  },
  {
    name: 'an encrypted scalar with no KDF',
    protection: 'scrypt-aes-256-gcm',
    kdf: null,
    salt: Buffer.alloc(16),
    iv: Buffer.alloc(12),
    authTag: Buffer.alloc(16),
  },
]) {
  test(`real SQLite schema refuses ${invalid.name}`, async () => {
    await withProfile(async (directory) => {
      const session = createDaemonStateSqliteSession(directory)
      const binding = await createNativeOracleCreationStore(directory).readWalletBinding()
      await assert.rejects(
        session.transaction((database) =>
          database
            .prepare(
              `
        INSERT INTO daemon_oracle_imports (condition_id,event_id,wallet_scope_id,oracle_pubkey,
          announcement_hex,announcement_event_json,outcomes_json,destinations_json,
          nonce_protection,nonce_kdf,nonce_salt,nonce_iv,nonce_auth_tag,nonce_body)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
            )
            .run(
              'ab'.repeat(32),
              'nullable-protection-test',
              binding.walletScopeId,
              owner,
              'aabb',
              '{}',
              '["Yes","No"]',
              '{}',
              invalid.protection,
              invalid.kdf,
              invalid.salt,
              invalid.iv,
              invalid.authTag,
              Buffer.alloc(32, 1),
            ),
        ),
        /CHECK constraint failed/,
      )
      const count = await session.read(
        (database) =>
          database.prepare('SELECT count(*) AS count FROM daemon_oracle_imports').get()?.count,
      )
      assert.equal(count, 0)
    })
  })
}

test(
  'real SQLite reordered signed backup preserves exact artifacts through reload, relay progress, and reimport',
  realHelper,
  async () => {
    const backup = await fixture('reordered-signed-import')
    const signed = await helper.signExplicitEnum({
      oracleSecretKeyHex: signer,
      privateDtoJson: JSON.stringify(backup.authority),
      chosenOutcome: 'Yes',
    })
    const publication = {
      explanationRelayPublished: false,
      explanationEventJson: null,
      engineEvidence: null,
      relayPublished: false,
      attestation: {
        eventJson: signed.attestationNostrEventJson,
        attestationHex: signed.attestationHex,
      },
      chosenOutcome: 'Yes',
      binding: {
        outcomes: ['Yes', 'No'],
        oraclePubkey: owner,
        oracleEventId: backup.oracleEventId,
        announcementEventJson: backup.authority.announcementEventJson,
        conditionId: backup.conditionId,
      },
    }
    const reordered: OracleBackupRecord = {
      ...backup,
      authority: {
        ...backup.authority,
        signedOutcome: 'Yes',
        attestationHex: signed.attestationHex,
        attestationEventJson: signed.attestationNostrEventJson,
        publicationRecordJson: JSON.stringify(publication),
      },
    }
    await withProfile(async (directory) => {
      const store = createNativeOracleCreationStore(directory)
      await store.importBackup(reordered, helper)
      const cold = createNativeOracleCreationStore(directory)
      const loaded = (await cold.readAuthorityByConditionId(backup.conditionId))!
      assert.equal(loaded.attestation?.attestationHex, signed.attestationHex)
      assert.equal(loaded.attestation?.attestationNostrEventJson, signed.attestationNostrEventJson)
      const confirmed = await cold.persistAuthorityPublicationProgress(backup.conditionId, {
        kind: 'relay',
        eventId: JSON.parse(signed.attestationNostrEventJson).id,
      })
      assert.equal(confirmed.relayPublished, true)
      await createNativeOracleCreationStore(directory).importBackup(reordered, helper)
      const restored = (await createNativeOracleCreationStore(directory).readAuthorityByConditionId(
        backup.conditionId,
      ))!
      assert.equal(restored.relayPublished, true)
      assert.equal(restored.attestation?.attestationHex, signed.attestationHex)
      assert.equal(
        restored.attestation?.attestationNostrEventJson,
        signed.attestationNostrEventJson,
      )
    })
  },
)
