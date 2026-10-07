import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import {
  createNativeOracleCreationStore,
  NativeOracleStoreError,
  type NativeOracleCreationInput,
} from '../src/nativeOracleCreationStore.ts'
import {
  NATIVE_ORACLE_INPUT_BYTES_MAX,
  NATIVE_ORACLE_NONCE_INDEX_LIMIT,
} from '../src/nativeOracleSchema.ts'
import {
  createDaemonStateSqliteSession,
  subscribeToDaemonWalletHoldingsCommits,
} from '../src/stateSqlite.ts'

const announcement = {
  conditionId: 'ab'.repeat(32),
  announcementTlvHex: 'aabb',
  announcementNostrEventJson: '{"kind":88}',
}
const attestation = { attestationHex: 'ccdd', attestationNostrEventJson: '{"kind":89}' }

test('creation schema rejects incomplete preparation, illegal fee facts, and premature progress', async () => {
  await withProfile(async (directory) => {
    const store = createNativeOracleCreationStore(directory)
    await store.reserveCreation(input('bounded-preparation'))
    await store.persistAnnouncement('bounded-preparation', announcement)
    const session = createDaemonStateSqliteSession(directory)
    const prepared = `creation_metadata_json = '{}', creation_mint_url = 'https://mint.example',
      creation_engine_base_url = 'https://engine.example', creation_fee_unit = 'msat'`
    for (const mutation of [
      "creation_metadata_json = '{}'",
      'creation_mint_confirmed = 1',
      "creation_engine_result_json = '{}'",
      "creation_thumbnail_bytes = x'01'",
      `${prepared}, creation_fee_amount = 0, creation_fee_operation_ref = 'operation'`,
      `${prepared}, creation_fee_amount = 7, creation_fee_operation_ref = NULL`,
      `${prepared}, creation_fee_amount = 0, creation_fee_operation_ref = NULL,
        creation_thumbnail_bytes = zeroblob(5242881), creation_thumbnail_filename = 'original.png',
        creation_thumbnail_content_type = 'image/png'`,
    ])
      await assert.rejects(
        session.transaction((database) =>
          database.exec(`UPDATE daemon_oracle_creations SET ${mutation}`),
        ),
        /CHECK constraint failed/,
      )
    const cold =
      await createNativeOracleCreationStore(directory).readCreation('bounded-preparation')
    assert.equal(cold?.marketCreation, null)
    assert.deepEqual(cold?.announcement, announcement)
  })
})

test('oracle allocation is unique across sessions and resumes the same request after restart', async () => {
  await withProfile(async (directory) => {
    const stores = [
      createNativeOracleCreationStore(directory),
      createNativeOracleCreationStore(directory),
    ]
    const records = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        stores[index % 2].reserveCreation(input(`creation-${index}`)),
      ),
    )
    assert.deepEqual(records.map((record) => record.nonceIndex).sort(), [0, 1, 2, 3, 4, 5])
    const reopened = createNativeOracleCreationStore(directory)
    assert.ok(
      isDeepStrictEqual(await reopened.reserveCreation(input('creation-0')), records[0]),
      'retry changed creation',
    )
    const shared = await Promise.all(stores.map((store) => store.reserveCreation(input('shared'))))
    assert.ok(isDeepStrictEqual(shared[0], shared[1]), 'concurrent exact retry allocated twice')
    assert.equal(shared[0].nonceIndex, 6)
    assert.equal((await reopened.reserveCreation(input('next'))).nonceIndex, 7)
    assert.equal(await reopened.readCreation('missing'), null)
  })
})

test('a conflicting creation does not consume an allocator index', async () => {
  await withProfile(async (directory) => {
    const store = createNativeOracleCreationStore(directory)
    await store.reserveCreation(input('one'))
    for (const conflicting of [
      { ...input('one'), canonicalInput: '{"title":"changed"}' },
      { ...input('one'), eventId: 'other-event' },
      { ...input('two'), eventId: input('one').eventId },
    ]) {
      await assert.rejects(store.reserveCreation(conflicting), reason('conflict'))
    }
    assert.equal((await store.reserveCreation(input('two'))).nonceIndex, 1)
  })
})

test('the final hardened index is usable once and an exact retry survives exhaustion', async () => {
  await withProfile(async (directory) => {
    const session = createDaemonStateSqliteSession(directory)
    await session.transaction((database) =>
      database
        .prepare('UPDATE daemon_oracle_nonce_allocator SET next_nonce_index = ?')
        .run(NATIVE_ORACLE_NONCE_INDEX_LIMIT - 1),
    )
    const store = createNativeOracleCreationStore(directory)
    const last = await store.reserveCreation(input('last'))
    assert.equal(last.nonceIndex, NATIVE_ORACLE_NONCE_INDEX_LIMIT - 1)
    await assert.rejects(store.reserveCreation(input('overflow')), reason('nonce-exhausted'))
    assert.ok(
      isDeepStrictEqual(await store.reserveCreation(input('last')), last),
      'exhaustion broke exact retry',
    )
  })
})

test('oracle artifacts and the first chosen outcome survive restart without changing custody state', async () => {
  await withProfile(async (directory) => {
    let notifications = 0
    const unsubscribe = subscribeToDaemonWalletHoldingsCommits(directory, () => {
      notifications += 1
    })
    try {
      const store = createNativeOracleCreationStore(directory)
      await store.reserveCreation(input('one'))
      await assert.rejects(
        store.persistAttestation('one', 'YES', attestation),
        reason('invalid-state'),
      )
      await store.persistAnnouncement('one', announcement)
      const chosen = await store.chooseOutcome(announcement.conditionId, 'YES')
      assert.equal(chosen.chosenOutcome, 'YES')
      assert.equal(chosen.attestation, null)
      const reopened = createNativeOracleCreationStore(directory)
      await assert.rejects(
        reopened.chooseOutcome(announcement.conditionId, 'NO'),
        reason('conflict'),
      )
      await assert.rejects(
        reopened.persistAttestation('one', 'NO', attestation),
        reason('conflict'),
      )
      const completed = await reopened.persistAttestation('one', 'YES', attestation)
      assert.ok(
        isDeepStrictEqual(completed.announcement, announcement),
        'announcement bytes changed',
      )
      assert.ok(isDeepStrictEqual(completed.attestation, attestation), 'attestation bytes changed')
      assert.ok(
        isDeepStrictEqual(await reopened.persistAnnouncement('one', announcement), completed),
        'announcement retry changed record',
      )
      assert.ok(
        isDeepStrictEqual(await reopened.persistAttestation('one', 'YES', attestation), completed),
        'attestation retry changed record',
      )
      assert.ok(
        isDeepStrictEqual(await reopened.readByConditionId(announcement.conditionId), completed),
        'condition lookup changed record',
      )
      assert.equal(notifications, 0)
      const session = createDaemonStateSqliteSession(directory)
      const epoch = await session.read((database) =>
        database.prepare('SELECT fencing_epoch AS epoch FROM custody_scope_state').get(),
      )
      assert.equal(epoch?.epoch, 0)
    } finally {
      unsubscribe()
    }
  })
})

test('different artifact bytes cannot replace a persisted announcement or attestation', async () => {
  await withProfile(async (directory) => {
    const store = createNativeOracleCreationStore(directory)
    await store.reserveCreation(input('one'))
    await store.persistAnnouncement('one', announcement)
    for (const changed of [
      { ...announcement, conditionId: 'cd'.repeat(32) },
      { ...announcement, announcementTlvHex: 'ffff' },
      { ...announcement, announcementNostrEventJson: '{"kind":88,"created_at":2}' },
    ])
      await assert.rejects(store.persistAnnouncement('one', changed), reason('conflict'))
    await store.chooseOutcome(announcement.conditionId, 'YES')
    await store.persistAttestation('one', 'YES', attestation)
    for (const changed of [
      { ...attestation, attestationHex: 'ffff' },
      { ...attestation, attestationNostrEventJson: '{"kind":89,"created_at":2}' },
    ])
      await assert.rejects(store.persistAttestation('one', 'YES', changed), reason('conflict'))
  })
})

test('SQLite refuses nonce rollback, record rebinding, deletion, and partial artifacts', async () => {
  await withProfile(async (directory) => {
    const store = createNativeOracleCreationStore(directory)
    await store.reserveCreation(input('one'))
    await store.persistAnnouncement('one', announcement)
    await store.chooseOutcome(announcement.conditionId, 'YES')
    await store.persistAttestation('one', 'YES', attestation)
    await store.reserveCreation(input('two'))
    const session = createDaemonStateSqliteSession(directory)
    for (const sql of [
      'UPDATE daemon_oracle_nonce_allocator SET next_nonce_index = 0',
      'DELETE FROM daemon_oracle_nonce_allocator',
      'UPDATE daemon_oracle_creations SET nonce_index = 12',
      "UPDATE daemon_oracle_creations SET canonical_input = '{}'",
      'UPDATE daemon_oracle_creations SET condition_id = NULL',
      'UPDATE daemon_oracle_creations SET announcement_hex = NULL',
      "UPDATE daemon_oracle_creations SET chosen_outcome = 'NO'",
      'UPDATE daemon_oracle_creations SET attestation_event_json = NULL',
      'DELETE FROM daemon_oracle_creations',
      "UPDATE daemon_oracle_creations SET announcement_hex = 'aabb' WHERE creation_id = 'two'",
      "UPDATE daemon_oracle_creations SET chosen_outcome = 'YES' WHERE creation_id = 'two'",
    ])
      await assert.rejects(session.transaction((database) => database.exec(sql)))
    assert.equal((await store.readCreation('one'))?.chosenOutcome, 'YES')
  })
})

test('oracle outcome storage preserves the engine maximum label length', async () => {
  await withProfile(async (directory) => {
    const store = createNativeOracleCreationStore(directory)
    const outcome = 'A'.repeat(191)
    await store.reserveCreation({
      ...input('one'),
      canonicalInput: JSON.stringify({ outcomes: [outcome, 'No'] }),
    })
    await store.persistAnnouncement('one', announcement)
    await assert.rejects(
      store.chooseOutcome(announcement.conditionId, `${outcome}B`),
      reason('invalid-input'),
    )
    assert.equal(
      (await store.chooseOutcome(announcement.conditionId, outcome)).chosenOutcome,
      outcome,
    )
    assert.equal(
      (await store.persistAttestation('one', outcome, attestation)).chosenOutcome,
      outcome,
    )
  })
})

test('invalid or oversized creation input is refused before allocation', async () => {
  await withProfile(async (directory) => {
    const store = createNativeOracleCreationStore(directory)
    for (const invalid of [
      { ...input('one'), creationId: '' },
      { ...input('one'), eventId: 'x'.repeat(513) },
      { ...input('one'), canonicalInput: '[]' },
      { ...input('one'), canonicalInput: '{' },
      {
        ...input('one'),
        canonicalInput: JSON.stringify({ title: 'x'.repeat(NATIVE_ORACLE_INPUT_BYTES_MAX) }),
      },
    ])
      await assert.rejects(store.reserveCreation(invalid), reason('invalid-input'))
    assert.equal((await store.reserveCreation(input('one'))).nonceIndex, 0)
  })
})

function input(creationId: string): NativeOracleCreationInput {
  return { creationId, eventId: `event-${creationId}`, canonicalInput: '{"outcomes":["YES","NO"]}' }
}

function reason(expected: NativeOracleStoreError['reason']) {
  return (error: unknown) => error instanceof NativeOracleStoreError && error.reason === expected
}

async function withProfile(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-oracle-store-'))
  const directory = join(root, 'profile')
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'http://localhost:8085',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    await run(directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
