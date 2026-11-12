import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import {
  createOracleBackupEvent,
  decryptOracleBackupEvent,
  encodeOracleBackup,
  decodeOracleBackup,
  encodeOraclePrivateAuthority,
  readOracleBackupEnvelope,
  ORACLE_BACKUP_TAG_PREFIX,
  OracleBackupError,
  type OracleBackupRecord,
  type OracleBackupValidator,
} from '../src/oracleBackup.ts'
import { announcementContentFromTlv } from '../src/oracleAnnouncementEncoding.ts'
import { deriveDlcConditionId } from '../src/managedConditionInventory.ts'
import { oracleTestKey, otherOracleTestKey } from './fixtures/oraclePublication.ts'

// Public announcement from the native/WASM fixture. Rust owns its inner cryptographic validation.
const tlv =
  'fdd824b127bb6f385afbef8d72af2a01ec50392df5d018ecb97244b3c04bb238fe3e050844767221012e8fe49eab82ebb3548d3ab6ed791a5cf044e09e508cb08fe749414f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8224d00011d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b477359400fdd80609000203594553024e4f1962726f777365722d6f7261636c652d72656772657373696f6e'

function fixture() {
  const oraclePubkey = getPublicKey(oracleTestKey)
  const oracleEventId = 'browser-oracle-regression'
  const announcement = finalizeEvent(
    { kind: 88, created_at: 1_800_000_000, tags: [], content: announcementContentFromTlv(tlv)! },
    oracleTestKey,
  )
  const record: OracleBackupRecord = {
    schemaVersion: 1,
    oraclePubkey,
    oracleEventId,
    conditionId: deriveDlcConditionId({
      eventId: oracleEventId,
      outcomeCount: 2,
      oraclePublicKeys: [oraclePubkey],
    }),
    authority: {
      schemaVersion: 1,
      announcementTlvHex: tlv,
      announcementEventJson: JSON.stringify(announcement),
      nonceScalarHex: '01'.repeat(32),
      signedOutcome: null,
      attestationHex: null,
      attestationEventJson: null,
      publicationRecordJson: null,
    },
    destinations: {
      mintUrl: 'https://mint.example',
      engineUrl: 'https://engine.example',
      relayUrls: ['wss://relay.example'],
    },
  }
  let validations = 0
  const validator: OracleBackupValidator = {
    async validateAuthority() {
      validations++
      return {
        eventId: oracleEventId,
        oraclePubkey,
        outcomes: ['YES', 'NO'],
        noncePoint: '1d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b4',
      }
    },
  }
  return { record, validator, announcement, validations: () => validations }
}

function assertSafeError(error: unknown, reason: OracleBackupError['reason']) {
  assert.equal(error instanceof OracleBackupError, true, 'Expected a bounded backup error.')
  assert.equal((error as OracleBackupError).reason, reason)
  assert.equal((error as Error).message, `Private oracle backup: ${reason}.`)
  return true
}

test('private backup uses signed self-encryption and restores exact portable authority', async () => {
  const f = fixture()
  const event = await createOracleBackupEvent({
    record: f.record,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_001,
    validator: f.validator,
  })
  assert.equal(event.kind, 30078)
  assert.equal(event.tags[0][1], ORACLE_BACKUP_TAG_PREFIX + f.announcement.id)
  assert.equal(event.content.includes(f.record.authority.nonceScalarHex!), false)
  const restored = await decryptOracleBackupEvent({
    event,
    privateKey: oracleTestKey,
    validator: f.validator,
    expectedAnnouncementEventId: f.announcement.id,
  })
  assert.equal(isDeepStrictEqual(restored, f.record), true, 'Exact private record changed.')
  assert.equal(f.validations(), 2)
})

test('wrong owner, plaintext, bad ciphertext and foreign record identity refuse before restore', async () => {
  const f = fixture()
  const valid = await createOracleBackupEvent({
    record: f.record,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_001,
    validator: f.validator,
  })
  const cases = [
    { event: valid, privateKey: otherOracleTestKey },
    {
      event: finalizeEvent({ ...valid, content: JSON.stringify(f.record) }, oracleTestKey),
      privateKey: oracleTestKey,
    },
    {
      event: finalizeEvent({ ...valid, content: 'A'.repeat(132) }, oracleTestKey),
      privateKey: oracleTestKey,
    },
    {
      event: finalizeEvent(
        {
          ...valid,
          tags: [
            ['d', ORACLE_BACKUP_TAG_PREFIX + '00'.repeat(32)],
            ['v', '1'],
          ],
        },
        oracleTestKey,
      ),
      privateKey: oracleTestKey,
    },
  ]
  for (const input of cases)
    await assert.rejects(decryptOracleBackupEvent({ ...input, validator: f.validator }), (error) =>
      assertSafeError(error, 'invalid-envelope'),
    )
  await assert.rejects(
    decryptOracleBackupEvent({
      event: valid,
      privateKey: oracleTestKey,
      validator: f.validator,
      expectedAnnouncementEventId: '00'.repeat(32),
    }),
    (error) => assertSafeError(error, 'invalid-envelope'),
  )
})

test('untrusted verification cache cannot authenticate a mutated outer event', async () => {
  const f = fixture()
  const event = await createOracleBackupEvent({
    record: f.record,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_001,
    validator: f.validator,
  })
  event.content = 'A'.repeat(132)
  assert.throws(
    () => readOracleBackupEnvelope(event, f.record.oraclePubkey),
    (error) => assertSafeError(error, 'invalid-envelope'),
  )
})

test('version, extra tags, ciphertext bounds and extra private fields are rejected', async () => {
  const f = fixture()
  const valid = await createOracleBackupEvent({
    record: f.record,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_001,
    validator: f.validator,
  })
  for (const change of [
    {
      tags: [
        ['d', valid.tags[0][1]],
        ['v', '02'],
      ],
    },
    { tags: [...valid.tags, ['extra', 'tag']] },
    { content: 'A'.repeat(87_473) },
  ])
    assert.throws(
      () =>
        readOracleBackupEnvelope(
          finalizeEvent({ ...valid, ...change }, oracleTestKey),
          f.record.oraclePubkey,
        ),
      (error) => assertSafeError(error, 'invalid-envelope'),
    )
  await assert.rejects(
    encodeOracleBackup({ ...f.record, nsec: 'forbidden' }, f.validator),
    (error) => assertSafeError(error, 'invalid-record'),
  )
  await assert.rejects(
    encodeOracleBackup(
      { ...f.record, authority: { ...f.record.authority, nonceIndex: 7 } },
      f.validator,
    ),
    (error) => assertSafeError(error, 'invalid-record'),
  )
})

test('malformed or trailing announcement bytes and foreign condition binding refuse', async () => {
  const f = fixture()
  for (const record of [
    { ...f.record, conditionId: '00'.repeat(32) },
    { ...f.record, authority: { ...f.record.authority, announcementTlvHex: tlv + '00' } },
    { ...f.record, authority: { ...f.record.authority, announcementTlvHex: 'fdd82401ff' } },
  ])
    await assert.rejects(encodeOracleBackup(record, f.validator), (error) =>
      assertSafeError(error, 'invalid-record'),
    )
})

test('core crypto refusal does not expose the scalar or helper diagnostic', async () => {
  const f = fixture()
  f.validator.validateAuthority = async () => {
    throw new Error(f.record.authority.nonceScalarHex!)
  }
  await assert.rejects(encodeOracleBackup(f.record, f.validator), (error) =>
    assertSafeError(error, 'invalid-record'),
  )
  const encrypted = nip44.encrypt(
    JSON.stringify(f.record),
    nip44.utils.getConversationKey(oracleTestKey, f.record.oraclePubkey),
  )
  const event = finalizeEvent(
    {
      kind: 30078,
      created_at: 1_800_000_001,
      tags: [
        ['d', ORACLE_BACKUP_TAG_PREFIX + f.announcement.id],
        ['v', '1'],
      ],
      content: encrypted,
    },
    oracleTestKey,
  )
  await assert.rejects(
    decryptOracleBackupEvent({ event, privateKey: oracleTestKey, validator: f.validator }),
    (error) => assertSafeError(error, 'invalid-envelope'),
  )
})

test('full UTF-8 encoding is bounded before the validator or signer runs', async () => {
  const f = fixture()
  const oversized = {
    ...f.record,
    authority: { ...f.record.authority, publicationRecordJson: '界'.repeat(22_000) },
  }
  await assert.rejects(encodeOracleBackup(oversized, f.validator), (error) =>
    assertSafeError(error, 'oversized'),
  )
  assert.equal(f.validations(), 0)
})

test('an explicit empty relay configuration stays empty in a portable record', async () => {
  const f = fixture()
  const encoded = await encodeOracleBackup(
    { ...f.record, destinations: { ...f.record.destinations, relayUrls: [] } },
    f.validator,
  )
  assert.equal(JSON.parse(encoded).destinations.relayUrls.length, 0)
})

test('terminal authority requires a durable signed publication with a relay copy or engine evidence', async () => {
  const f = fixture()
  await assert.rejects(
    encodeOracleBackup(
      { ...f.record, authority: { ...f.record.authority, nonceScalarHex: null } },
      f.validator,
    ),
    (error) => assertSafeError(error, 'invalid-record'),
  )
})

test('terminal backup keeps exact retry artifacts and rejects inconsistent publication metadata', async () => {
  const f = fixture()
  const attestation = finalizeEvent(
    { kind: 89, created_at: 1_800_000_001, tags: [['e', f.announcement.id]], content: 'qrs=' },
    oracleTestKey,
  )
  const publication = {
    binding: {
      conditionId: f.record.conditionId,
      oracleEventId: f.record.oracleEventId,
      oraclePubkey: f.record.oraclePubkey,
      outcomes: ['YES', 'NO'],
      announcementEventJson: f.record.authority.announcementEventJson,
    },
    chosenOutcome: 'YES',
    attestation: { attestationHex: 'aabb', eventJson: JSON.stringify(attestation) },
    relayPublished: true,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  const authority = {
    ...f.record.authority,
    nonceScalarHex: null,
    signedOutcome: 'YES',
    attestationHex: 'aabb',
    attestationEventJson: publication.attestation.eventJson,
    publicationRecordJson: JSON.stringify(publication),
  }
  const record = { ...f.record, authority }
  const event = await createOracleBackupEvent({
    record,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_002,
    validator: f.validator,
  })
  const restored = await decryptOracleBackupEvent({
    event,
    privateKey: oracleTestKey,
    validator: f.validator,
  })
  assert.equal(restored.authority.nonceScalarHex, null)
  assert.equal(
    restored.authority.attestationEventJson === authority.attestationEventJson,
    true,
    'Exact event changed.',
  )
  for (const change of [
    { relayPublished: false },
    { chosenOutcome: 'NO' },
    { binding: { ...publication.binding, outcomes: ['NO', 'YES'] } },
    { attestation: null },
  ]) {
    const bad = {
      ...record,
      authority: {
        ...authority,
        publicationRecordJson: JSON.stringify({ ...publication, ...change }),
      },
    }
    await assert.rejects(encodeOracleBackup(bad, f.validator), (error) =>
      assertSafeError(error, 'invalid-record'),
    )
  }
})

test('terminal backup accepts verified engine evidence without a relay copy', async () => {
  const f = fixture()
  const attestation = finalizeEvent(
    { kind: 89, created_at: 1_800_000_001, tags: [['e', f.announcement.id]], content: 'qrs=' },
    oracleTestKey,
  )
  const publication = {
    binding: {
      conditionId: f.record.conditionId,
      oracleEventId: f.record.oracleEventId,
      oraclePubkey: f.record.oraclePubkey,
      outcomes: ['YES', 'NO'],
      announcementEventJson: f.record.authority.announcementEventJson,
    },
    chosenOutcome: 'YES',
    attestation: { attestationHex: 'aabb', eventJson: JSON.stringify(attestation) },
    relayPublished: false,
    engineEvidence: {
      conditionId: f.record.conditionId,
      oracleEventId: f.record.oracleEventId,
      oraclePubkey: f.record.oraclePubkey,
      outcome: 'YES',
      announcementEventId: f.announcement.id,
      attestationEventId: attestation.id,
    },
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  const record = {
    ...f.record,
    authority: {
      ...f.record.authority,
      nonceScalarHex: null,
      signedOutcome: 'YES',
      attestationHex: 'aabb',
      attestationEventJson: publication.attestation.eventJson,
      publicationRecordJson: JSON.stringify(publication),
    },
  }
  const event = await createOracleBackupEvent({
    record,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_002,
    validator: f.validator,
  })
  const restored = await decryptOracleBackupEvent({
    event,
    privateKey: oracleTestKey,
    validator: f.validator,
  })
  assert.equal(restored.authority.nonceScalarHex, null)
  assert.equal(restored.authority.publicationRecordJson, record.authority.publicationRecordJson)
  const unconfirmed = {
    ...record,
    authority: {
      ...record.authority,
      publicationRecordJson: JSON.stringify({ ...publication, engineEvidence: null }),
    },
  }
  await assert.rejects(encodeOracleBackup(unconfirmed, f.validator), (error) =>
    assertSafeError(error, 'invalid-record'),
  )
})

function resolvedFixture(large = false) {
  const f = fixture()
  const announcement = finalizeEvent(
    {
      kind: 88,
      created_at: 1_800_000_000,
      tags: large ? Array.from({ length: 8 }, () => ['x', '"'.repeat(1_024)]) : [],
      content: announcementContentFromTlv(tlv)!,
    },
    oracleTestKey,
  )
  const announcementEventJson = JSON.stringify(announcement)
  const attestation = finalizeEvent(
    {
      kind: 89,
      created_at: 1_800_000_001,
      tags: [['e', announcement.id]],
      content: 'qrs=',
    },
    oracleTestKey,
  )
  const attestationEventJson = JSON.stringify(attestation)
  const publication = {
    binding: {
      conditionId: f.record.conditionId,
      oracleEventId: f.record.oracleEventId,
      oraclePubkey: f.record.oraclePubkey,
      outcomes: ['YES', 'NO'],
      announcementEventJson,
    },
    chosenOutcome: 'YES',
    attestation: { attestationHex: 'aabb', eventJson: attestationEventJson },
    relayPublished: true,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }
  return {
    ...f,
    announcement,
    record: {
      ...f.record,
      authority: {
        ...f.record.authority,
        announcementEventJson,
        nonceScalarHex: null,
        signedOutcome: 'YES',
        attestationHex: 'aabb',
        attestationEventJson,
        publicationRecordJson: JSON.stringify(publication),
      },
    },
  }
}

test('v2 compact wire preserves exact signed artifacts and v1 remains the default writer', async () => {
  const f = resolvedFixture()
  const defaultWire = JSON.parse(await encodeOracleBackup(f.record, f.validator))
  assert.equal(defaultWire.schemaVersion, 1)
  assert.equal(
    defaultWire.authority.publicationRecordJson,
    f.record.authority.publicationRecordJson,
  )
  const encoded = await encodeOracleBackup(f.record, f.validator, { writeVersion: 2 })
  const wire = JSON.parse(encoded)
  assert.equal(wire.schemaVersion, 2)
  assert.equal(wire.authority.schemaVersion, 2)
  assert.equal('publicationRecordJson' in wire.authority, false)
  assert.equal('binding' in wire.authority.publication, false)
  assert.equal('attestation' in wire.authority.publication, false)
  assert.equal(wire.authority.announcementEventJson, f.record.authority.announcementEventJson)
  assert.equal(wire.authority.attestationEventJson, f.record.authority.attestationEventJson)
  assert.deepEqual(await decodeOracleBackup(encoded, f.validator), f.record)
  const event = await createOracleBackupEvent({
    record: f.record,
    validator: f.validator,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_003,
    writeVersion: 2,
  })
  assert.deepEqual(event.tags, [
    ['d', ORACLE_BACKUP_TAG_PREFIX + f.announcement.id],
    ['v', '2'],
  ])
  assert.deepEqual(
    await decryptOracleBackupEvent({ event, privateKey: oracleTestKey, validator: f.validator }),
    f.record,
  )
})

test('compact decoding sends original v2 authority to crypto before bounded model expansion', async () => {
  const f = resolvedFixture(true)
  assert.ok(new TextEncoder().encode(JSON.stringify(f.record)).length > 65_535)
  await assert.rejects(encodeOracleBackup(f.record, f.validator), (error) =>
    assertSafeError(error, 'oversized'),
  )
  const encoded = await encodeOracleBackup(f.record, f.validator, { writeVersion: 2 })
  assert.ok(new TextEncoder().encode(encoded).length <= 65_535)
  const validator = {
    async validateAuthority(value: string) {
      assert.equal(JSON.parse(value).schemaVersion, 2)
      assert.equal('publicationRecordJson' in JSON.parse(value), false)
      assert.ok(new TextEncoder().encode(value).length <= 65_535)
      return f.validator.validateAuthority(value, f.record.oraclePubkey)
    },
  }
  const restored = await decodeOracleBackup(encoded, validator)
  assert.deepEqual(restored, f.record)
  const privateWire = await encodeOraclePrivateAuthority(
    restored.authority,
    restored.oraclePubkey,
    validator,
    { writeVersion: 2 },
  )
  assert.equal(JSON.parse(privateWire).schemaVersion, 2)
})

test('v2 wire rejects unknown/missing fields, version mismatches and inconsistent progress', async () => {
  const f = resolvedFixture()
  const wire = JSON.parse(await encodeOracleBackup(f.record, f.validator, { writeVersion: 2 }))
  const variants = [
    { ...wire, schemaVersion: 3 },
    { ...wire, schemaVersion: 1 },
    { ...wire, unexpected: true },
    { ...wire, authority: { ...wire.authority, schemaVersion: 1 } },
    { ...wire, authority: { ...wire.authority, publicationRecordJson: null } },
    { ...wire, authority: { ...wire.authority, signedOutcome: 'FOREIGN' } },
    { ...wire, authority: { ...wire.authority, attestationEventJson: null } },
    {
      ...wire,
      authority: {
        ...wire.authority,
        publication: { ...wire.authority.publication, relayPublished: false },
      },
    },
    {
      ...wire,
      authority: {
        ...wire.authority,
        publication: { ...wire.authority.publication, explanationRelayPublished: true },
      },
    },
    {
      ...wire,
      authority: {
        ...wire.authority,
        publication: { ...wire.authority.publication, unexpected: true },
      },
    },
  ]
  const missing = structuredClone(wire)
  delete missing.authority.publication.engineEvidence
  variants.push(missing)
  for (const invalid of variants)
    await assert.rejects(decodeOracleBackup(JSON.stringify(invalid), f.validator), (error) =>
      assertSafeError(error, 'invalid-record'),
    )
})

test('authenticated future envelopes remain visible but unsupported and mismatched bodies never decode', async () => {
  const f = fixture()
  const event = await createOracleBackupEvent({
    record: f.record,
    validator: f.validator,
    privateKey: oracleTestKey,
    createdAt: 1_800_000_001,
  })
  for (const version of ['2', '3']) {
    const changed = finalizeEvent(
      { ...event, tags: [event.tags[0], ['v', version]] },
      oracleTestKey,
    )
    assert.equal(readOracleBackupEnvelope(changed, f.record.oraclePubkey).id, changed.id)
    await assert.rejects(
      decryptOracleBackupEvent({
        event: changed,
        privateKey: oracleTestKey,
        validator: f.validator,
      }),
      (error) => assertSafeError(error, 'invalid-envelope'),
    )
  }
})

test('real deployed-format golden artifacts survive v1 read, compact write and encrypted reload', async () => {
  const golden = JSON.parse(
    readFileSync(new URL('./fixtures/oracle-backup-v1.json', import.meta.url), 'utf8'),
  ) as {
    syntheticOnly: boolean
    testPrivateKeyHex: string
    records: Record<string, OracleBackupRecord>
  }
  assert.equal(golden.syntheticOnly, true)
  const privateKey = Uint8Array.from(Buffer.from(golden.testPrivateKeyHex, 'hex'))
  for (const record of Object.values(golden.records)) {
    // The daemon harness validates these same frozen artifacts through the real Rust core.
    const validator: OracleBackupValidator = {
      async validateAuthority() {
        return {
          eventId: record.oracleEventId,
          oraclePubkey: record.oraclePubkey,
          outcomes: ['Yes', 'No'],
          noncePoint: getPublicKey(
            Uint8Array.from(Buffer.from(golden.records.unsigned.authority.nonceScalarHex!, 'hex')),
          ),
        }
      },
    }
    const decoded = await decodeOracleBackup(JSON.stringify(record), validator)
    assert.deepEqual(decoded, record)
    const compact = await createOracleBackupEvent({
      record: decoded,
      privateKey,
      createdAt: 1_800_000_001,
      validator,
      writeVersion: 2,
    })
    const reloaded = await decryptOracleBackupEvent({ event: compact, privateKey, validator })
    assert.equal(reloaded.authority.announcementEventJson, record.authority.announcementEventJson)
    assert.equal(reloaded.authority.attestationEventJson, record.authority.attestationEventJson)
    assert.deepEqual(
      JSON.parse(reloaded.authority.publicationRecordJson ?? 'null'),
      JSON.parse(record.authority.publicationRecordJson ?? 'null'),
    )
    assert.equal(reloaded.authority.nonceScalarHex, record.authority.nonceScalarHex)
  }
})

test('compact wire rejects duplicate object keys before Rust DTO normalization', async () => {
  const f = resolvedFixture()
  const wire = await encodeOracleBackup(f.record, f.validator, { writeVersion: 2 })
  for (const duplicate of [
    wire.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
    wire.replace(
      '"authority":{"schemaVersion":2',
      '"authority":{"schemaVersion":2,"schemaVersion":2',
    ),
    wire.replace('"relayPublished":true', '"relayPublished":true,"relayPublished":true'),
    wire.replace('"relayPublished":true', '"relayPublished":true,"relayPublished":false'),
    wire.replace('"engineUrl":', '"engineUrl":"https://other.example","engineUrl":'),
  ]) {
    await assert.rejects(decodeOracleBackup(duplicate, f.validator), (error) =>
      assertSafeError(error, 'invalid-record'),
    )
  }
})
