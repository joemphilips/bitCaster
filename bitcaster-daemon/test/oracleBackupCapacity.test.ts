import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  createNativeOracleHelperAdapter,
  resolveNativeOracleHelperPath,
} from '../src/nativeOracleHelper.ts'
import {
  encodeOracleBackup,
  encodeOraclePrivateAuthority,
  createOracleBackupEvent,
  decryptOracleBackupEvent,
  type OracleBackupRecord,
} from '../../bitcaster-client-sdk/src/oracleBackup.ts'
import { compactOraclePrivateAuthority } from '../../bitcaster-client-sdk/src/oracleBackupModel.ts'
import { inspectOracleBackupLifecycleCapacity } from '../../bitcaster-client-sdk/src/oracleBackupCapacity.ts'
import { createOracleExplanationTemplate } from '../../bitcaster-client-sdk/src/oracleResolutionExplanation.ts'
import { deriveDlcConditionId } from '../../bitcaster-client-sdk/src/managedConditionInventory.ts'
import type { OraclePublicationRecord } from '../../bitcaster-client-sdk/src/oraclePublication.ts'

const helperPath =
  process.env.BITCASTER_TEST_NATIVE_ORACLE_HELPER ?? resolveNativeOracleHelperPath()
const realCrypto = { skip: !existsSync(helperPath) }
const helper = createNativeOracleHelperAdapter({ resolveExecutable: () => helperPath })
// Public, local-only test keys. The harness never publishes or calls a mint/engine.
const oracleSecretKeyHex = '01'.repeat(32)
const nonceSeedHex = '02'.repeat(32)
const privateKey = new Uint8Array(32).fill(1)
const destinations = {
  mintUrl: 'https://mint.bitcaster.cash',
  engineUrl: 'https://api.bitcaster.market',
  relayUrls: [
    'wss://nos.lol',
    'wss://nostr.bitcoiner.social',
    'wss://relay.primal.net',
    'wss://relay.nostr.net',
    'wss://relay.damus.io',
    'wss://purplepag.es',
  ],
}
const outcomes = Array.from({ length: 8 }, (_, index) => 'A'.repeat(190) + index)

for (const [name, title, description, eventId] of [
  ['current ASCII', 'a'.repeat(100), 'a'.repeat(1024), 'a'.repeat(64)],
  ['current quotes', '"'.repeat(100), '"'.repeat(1024), 'a'.repeat(64)],
  ['future Japanese', '界'.repeat(200), '界'.repeat(2000), 'a'.repeat(64)],
  ['future emoji', '😀'.repeat(200), '😀'.repeat(2000), 'a'.repeat(253)],
  ['future controls', '\u0001'.repeat(200), '\u0001'.repeat(2000), 'a'.repeat(512)],
  ['future combining', 'e\u0301'.repeat(100), 'e\u0301'.repeat(1000), '\u0001'.repeat(512)],
]) {
  test(`real oracle lifecycle capacity bounds ${name}`, realCrypto, async () => {
    const creation = await helper.createEnum({
      oracleSecretKeyHex,
      nonceSeedHex,
      reservedNonceIndex: 0,
      eventId,
      outcomes,
      eventMaturityEpoch: 1_800_000_000,
      title,
      description,
    })
    const signed = await helper.signEnum({
      oracleSecretKeyHex,
      nonceSeedHex,
      reservedNonceIndex: 0,
      eventId,
      chosenOutcome: outcomes[0],
      announcementTlvHex: creation.announcementTlvHex,
      announcementNostrEventJson: creation.announcementNostrEventJson,
    })
    const authority = JSON.parse(
      await helper.exportEnumAuthority({
        oracleSecretKeyHex,
        nonceSeedHex,
        reservedNonceIndex: 0,
        announcementTlvHex: creation.announcementTlvHex,
        announcementEventJson: creation.announcementNostrEventJson,
        signedOutcome: null,
        attestationHex: null,
        attestationEventJson: null,
        publicationRecordJson: null,
      }),
    )
    const oraclePubkey = creation.oraclePublicKeyHex
    const conditionId = deriveDlcConditionId({
      eventId,
      outcomeCount: outcomes.length,
      oraclePublicKeys: [oraclePubkey],
    })
    const explanationEventJson = JSON.stringify(
      finalizeEvent(
        createOracleExplanationTemplate(
          {
            oraclePubkey,
            announcementEventJson: creation.announcementNostrEventJson,
            attestationEventJson: signed.attestationNostrEventJson,
          },
          '\u0000'.repeat(4096),
          1_800_000_001,
        ),
        privateKey,
      ),
    )
    const choice: OraclePublicationRecord = {
      binding: {
        conditionId,
        oracleEventId: eventId,
        oraclePubkey,
        outcomes,
        announcementEventJson: creation.announcementNostrEventJson,
      },
      chosenOutcome: outcomes[0],
      attestation: null,
      relayPublished: false,
      engineEvidence: null,
      explanationEventJson: null,
      explanationRelayPublished: false,
    }
    const attested = {
      ...choice,
      attestation: {
        attestationHex: signed.attestationHex,
        eventJson: signed.attestationNostrEventJson,
      },
    }
    const explained = { ...attested, explanationEventJson }
    const evidenced = {
      ...explained,
      engineEvidence: {
        conditionId,
        oracleEventId: eventId,
        oraclePubkey,
        outcome: outcomes[0],
        announcementEventId: creation.announcementNostrEventId,
        attestationEventId: signed.attestationNostrEventId,
      },
    }
    const states = [
      null,
      choice,
      attested,
      explained,
      { ...explained, relayPublished: true },
      evidenced,
      { ...evidenced, relayPublished: true, explanationRelayPublished: true },
    ]
    for (const writeVersion of [1, 2] as const) {
      const capacity = inspectOracleBackupLifecycleCapacity({
        title,
        description,
        outcomes,
        eventId,
        destinations,
        writeVersion,
      })
      for (const [index, publication] of states.entries()) {
        const record: OracleBackupRecord = {
          schemaVersion: 1,
          conditionId,
          oraclePubkey,
          oracleEventId: eventId,
          destinations,
          authority: {
            ...authority,
            signedOutcome: publication?.chosenOutcome ?? null,
            attestationHex: publication?.attestation?.attestationHex ?? null,
            attestationEventJson: publication?.attestation?.eventJson ?? null,
            publicationRecordJson: publication === null ? null : JSON.stringify(publication),
            nonceScalarHex: index === states.length - 1 ? null : authority.nonceScalarHex,
          },
        }
        const wire =
          writeVersion === 1
            ? record
            : {
                ...record,
                schemaVersion: 2,
                authority: compactOraclePrivateAuthority(record.authority),
              }
        const actualBytes = new TextEncoder().encode(JSON.stringify(wire)).length
        assert.ok(
          actualBytes <= capacity.requiredPlaintextBytes,
          `${name} v${writeVersion} state ${index}: ${actualBytes} exceeds ${capacity.requiredPlaintextBytes}`,
        )
        if (actualBytes > 65_535) {
          assert.equal(capacity.fits, false)
          await assert.rejects(encodeOracleBackup(record, helper, { writeVersion }), /oversized/)
          continue
        }
        const encoded = await encodeOracleBackup(record, helper, { writeVersion })
        assert.equal(new TextEncoder().encode(encoded).length, actualBytes)
        const event = await createOracleBackupEvent({
          record,
          validator: helper,
          privateKey,
          createdAt: 1_800_000_002,
          writeVersion,
        })
        assert.ok(event.content.length <= capacity.requiredEncryptedPayloadChars)
        const restored = await decryptOracleBackupEvent({ event, validator: helper, privateKey })
        assert.equal(
          restored.authority.announcementEventJson,
          record.authority.announcementEventJson,
        )
        assert.equal(restored.authority.attestationEventJson, record.authority.attestationEventJson)
        assert.equal(restored.authority.nonceScalarHex, record.authority.nonceScalarHex)
        assert.deepEqual(
          JSON.parse(restored.authority.publicationRecordJson ?? 'null'),
          publication,
        )
        if (name === 'future controls' && writeVersion === 2 && index === states.length - 2) {
          assert.ok(new TextEncoder().encode(JSON.stringify(restored)).length > 65_535)
          const exportedPrivateWire = await helper.exportEnumAuthority({
            oracleSecretKeyHex,
            nonceSeedHex,
            reservedNonceIndex: 0,
            authorityVersion: 2,
            announcementTlvHex: restored.authority.announcementTlvHex,
            announcementEventJson: restored.authority.announcementEventJson,
            signedOutcome: restored.authority.signedOutcome,
            attestationHex: restored.authority.attestationHex,
            attestationEventJson: restored.authority.attestationEventJson,
            publicationRecordJson: restored.authority.publicationRecordJson,
          })
          assert.equal(JSON.parse(exportedPrivateWire).schemaVersion, 2)

          const root = await mkdtemp(join(tmpdir(), 'oracle-compact-restore-'))
          const directory = join(root, 'profile')
          try {
            await bootstrapFreshDaemonProfile({
              directory,
              engineBaseUrl: destinations.engineUrl,
              mintUrl: destinations.mintUrl,
              walletSeedHex: '11'.repeat(64),
              nostrSecretKeyHex: oracleSecretKeyHex,
            })
            const store = createNativeOracleCreationStore(directory)
            await store.importBackupEnvelope(event, destinations.relayUrls[0], helper)
            const reopened = createNativeOracleCreationStore(directory)
            const exported = await reopened.exportImportedBackup(conditionId, helper)
            assert.deepEqual(exported, restored)
            const retained = await reopened.readImportedAuthorityForSigning(conditionId)
            const privateDtoJson = await encodeOraclePrivateAuthority(
              retained,
              oraclePubkey,
              helper,
              { writeVersion: 2 },
            )
            const retry = await helper.signExplicitEnum({
              oracleSecretKeyHex,
              privateDtoJson,
              chosenOutcome: outcomes[0],
            })
            assert.equal(retry.attestationHex, signed.attestationHex)
            assert.equal(retry.attestationNostrEventJson, signed.attestationNostrEventJson)
            await assert.rejects(
              helper.signExplicitEnum({
                oracleSecretKeyHex,
                privateDtoJson,
                chosenOutcome: outcomes[1],
              }),
            )
          } finally {
            await rm(root, { recursive: true, force: true })
          }
        }
      }
    }
  })
}

test(
  'frozen v1 golden records validate through the real core in both wire versions',
  realCrypto,
  async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL('../../bitcaster-client-sdk/test/fixtures/oracle-backup-v1.json', import.meta.url),
        'utf8',
      ),
    ) as { records: Record<string, OracleBackupRecord> }
    for (const record of Object.values(golden.records)) {
      for (const writeVersion of [1, 2] as const) {
        await encodeOracleBackup(record, helper, { writeVersion })
      }
    }
  },
)
