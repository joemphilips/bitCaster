import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { deriveDurableCustodyScopeId } from '@bitcaster-market/client-sdk/durableCustody'
import { createEmergencySeedRecoveryCoCommit } from '@bitcaster-market/client-sdk/emergencySeedRecovery'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease, renewCustodyScopeLease } from '../src/profileFencing.ts'
import {
  recoverDaemonWalletFromSeed,
  runExplicitEmergencySeedRecovery,
  type ExplicitSeedRecoveryBatch,
} from '../src/emergencySeedRecovery.ts'
import {
  SeedRecoverySqliteStore,
  type SeedRecoveryJobFinalization,
  type SeedRecoveryObservedProof,
} from '../src/seedRecoverySqlite.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { RECOVERY_COUNTER_BINDING, withDaemonHome } from './seedRecoveryTestSupport.ts'
import {
  advanceDaemonKeysetCounter,
  readAvailableWalletProofsFenced,
  reserveDaemonKeysetCounter,
} from '../src/state.ts'

test('explicit ordinary recovery co-commits selectable and spent proofs with cursor and job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      incarnationId: 'recovery-incarnation',
      invocationId: 'invocation-1',
    })
    const cursor = await runRecovery(fixture, {
      recoveryId: 'recovery-1',
      disclosureAcknowledged: true,
      batches: [
        {
          observation: {
            expectedRevision: 0,
            startCounter: 0,
            requestedCount: 3,
            lastCounterWithSignature: 2,
            scanThroughCounter: 3,
          },
          proofs: [
            observed(fixture.profile.walletScopeId, 'a', 'UNSPENT', 'selectable'),
            observed(fixture.profile.walletScopeId, 'c', 'SPENT', 'spent'),
          ],
        },
      ],
    })
    assert.equal(cursor.nextCounter, 3)
    assert.equal(cursor.revision, 1)
    await withRecoveryDatabase(directory, async (database) => {
      assert.deepEqual(readRecoveryJob(database, 'recovery-1'), {
        importedProofs: 1,
        ignoredSpentProofs: 1,
        revision: 1,
        state: 'active',
      })
      assert.equal(readRowCount(database, 'custody_proofs'), 1)
      assert.equal(readRowCount(database, 'target_wallet_proofs'), 1)
    })
    await withDaemonHome(directory, async () => {
      const available = await readAvailableWalletProofsFenced({
        mintUrl: 'https://mint.example',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
        mutation: { fence: fixture.fence, observedAtMs: 4 },
      })
      assert.deepEqual(
        available.map(({ proof }) => proof.secret),
        ['secret-a'],
      )
      assert.deepEqual(
        await reserveDaemonKeysetCounter(
          'keyset-1',
          1,
          {
            fence: fixture.fence,
            observedAtMs: 4,
          },
          RECOVERY_COUNTER_BINDING,
        ),
        { start: 3, count: 1 },
      )
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery commit rolls its counter back with a failed proof insert', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-counter-atomic-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '77'.repeat(64),
      nostrSecretKeyHex: '88'.repeat(32),
      incarnationId: 'recovery-counter-atomic',
      invocationId: 'recovery-counter-atomic',
    })
    const duplicate = observed(fixture.profile.walletScopeId, 'duplicate', 'UNSPENT', 'selectable')
    await withRecoveryDatabase(directory, async (database) => {
      new DurableCustodySqliteStore(database).putProofCas(
        { ...duplicate.proof, productBinding: 'foreign-binding' },
        null,
      )
    })
    await assert.rejects(() =>
      runRecovery(fixture, {
        recoveryId: 'recovery-counter-atomic',
        disclosureAcknowledged: true,
        batches: [{ observation: oneProofObservation(), proofs: [duplicate] }],
      }),
    )
    await withRecoveryDatabase(directory, async (database) => {
      assert.equal(readRowCount(database, 'seed_recovery_jobs'), 0)
      assert.equal(readRowCount(database, 'custody_proofs'), 1)
      assert.equal(readRowCount(database, 'target_keyset_counters'), 0)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery continues beyond four pages across explicit invocations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-continuation-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '12'.repeat(64),
      nostrSecretKeyHex: '23'.repeat(32),
      incarnationId: 'recovery-continuation',
      invocationId: 'recovery-continuation-1',
    })
    const first = await runRecovery(fixture, {
      recoveryId: 'recovery-continuation',
      disclosureAcknowledged: true,
      batches: [0, 1, 2, 3].map((index) => signedBatch(index)),
    })
    assert.equal(first.nextCounter, 1_200)

    const second = await runExplicitEmergencySeedRecovery({
      recoveryId: 'recovery-continuation',
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-1',
      disclosureAcknowledged: true,
      authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
      store: new SeedRecoverySqliteStore({
        directory,
        fence: fixture.fence,
        invocationId: 'recovery-continuation-2',
        observedAtMs: 3,
      }),
      batches: [signedBatch(4)],
    })
    assert.equal(second.nextCounter, 1_500)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery rejects a resumed job with a changed mint or unit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-binding-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '13'.repeat(64),
      nostrSecretKeyHex: '24'.repeat(32),
      incarnationId: 'recovery-binding',
      invocationId: 'recovery-binding',
    })
    await runRecovery(fixture, {
      recoveryId: 'recovery-binding',
      disclosureAcknowledged: true,
      batches: [signedBatch(0)],
    })
    await assert.rejects(
      runRecoveryWithContext(fixture, 'recovery-binding', 'https://other.example', 'sat'),
      /binding/,
    )
    await assert.rejects(
      runRecoveryWithContext(fixture, 'recovery-binding', 'https://mint.example', 'msat'),
      /binding/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('one recovery job isolates two keyset cursors and aggregates both batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-multikeyset-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '16'.repeat(64),
      nostrSecretKeyHex: '27'.repeat(32),
      incarnationId: 'recovery-multikeyset',
      invocationId: 'recovery-multikeyset',
    })
    await runRecovery(fixture, {
      recoveryId: 'recovery-multikeyset',
      disclosureAcknowledged: true,
      batches: [
        {
          observation: oneProofObservation(),
          proofs: [observed(fixture.profile.walletScopeId, 'one', 'UNSPENT', 'selectable')],
        },
      ],
    })
    const second = await runExplicitEmergencySeedRecovery({
      recoveryId: 'recovery-multikeyset',
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-2',
      disclosureAcknowledged: true,
      authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
      store: fixture.store,
      batches: [
        {
          observation: oneProofObservation(),
          proofs: [
            observed(fixture.profile.walletScopeId, 'two', 'UNSPENT', 'selectable', 'keyset-2'),
          ],
        },
      ],
    })
    assert.deepEqual(
      { nextCounter: second.nextCounter, revision: second.revision },
      { nextCounter: 1, revision: 1 },
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.deepEqual(readRecoveryJob(database, 'recovery-multikeyset'), {
        importedProofs: 2,
        ignoredSpentProofs: 0,
        revision: 2,
        state: 'active',
      })
      const cursors = database
        .prepare(
          `SELECT keyset_id AS keysetId, next_counter AS nextCounter, revision
           FROM seed_recovery_keysets WHERE recovery_id = ? ORDER BY keyset_id`,
        )
        .all('recovery-multikeyset')
      assert.deepEqual(
        cursors.map((cursor) => ({ ...cursor })),
        [
          { keysetId: 'keyset-1', nextCounter: 1, revision: 1 },
          { keysetId: 'keyset-2', nextCounter: 1, revision: 1 },
        ],
      )
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('completed children remain extensible until the orchestrator finalizes discovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-discovery-finalize-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '1a'.repeat(64),
      nostrSecretKeyHex: '2b'.repeat(32),
      incarnationId: 'recovery-discovery-finalize',
      invocationId: 'recovery-discovery-finalize',
    })
    const binding = {
      recoveryId: 'recovery-discovery-finalize',
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat' as const,
    }
    await runRecovery(fixture, {
      recoveryId: binding.recoveryId,
      disclosureAcknowledged: true,
      batches: [emptyBatch(0)],
    })
    const secondStart = await fixture.store.readRecoveryStart({
      ...binding,
      keysetId: 'keyset-2',
    })
    assert.equal(secondStart.cursor.state, 'active')
    await runExplicitEmergencySeedRecovery({
      ...binding,
      keysetId: 'keyset-2',
      disclosureAcknowledged: true,
      authority: recoveryAuthority(binding.walletScopeId, fixture.fence),
      store: fixture.store,
      batches: [emptyBatch(0)],
    })
    await fixture.store.finalizeRecoveryJob(finalization(binding, fixture.fence, true))
    await withRecoveryDatabase(directory, (database) => {
      assert.deepEqual(readRecoveryJob(database, binding.recoveryId), {
        importedProofs: 0,
        ignoredSpentProofs: 0,
        revision: 3,
        state: 'completed',
      })
      assert.equal(readRowCount(database, 'seed_recovery_keysets'), 2)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery child access rejects foreign bindings and completed job acquisition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-child-binding-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '17'.repeat(64),
      nostrSecretKeyHex: '28'.repeat(32),
      incarnationId: 'recovery-child-binding',
      invocationId: 'recovery-child-binding',
    })
    const input = {
      recoveryId: 'recovery-child-binding',
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat' as const,
      keysetId: 'keyset-1',
    }
    await fixture.store.readRecoveryStart(input)
    await assert.rejects(
      () => fixture.store.readRecoveryStart({ ...input, walletScopeId: foreignWalletScopeId() }),
      /foreign/,
    )
    await runRecovery(fixture, {
      recoveryId: input.recoveryId,
      disclosureAcknowledged: true,
      batches: [emptyBatch(0)],
    })
    await fixture.store.finalizeRecoveryJob(finalization(input, fixture.fence, true))
    const completed = await fixture.store.readRecoveryStart(input)
    assert.equal(completed.cursor.state, 'completed')
    await assert.rejects(
      () => fixture.store.readRecoveryStart({ ...input, keysetId: 'keyset-2' }),
      /cannot acquire/,
    )
    await assert.rejects(
      () => fixture.store.readRecoveryStart({ ...input, mintUrl: 'https://other.example' }),
      /binding/,
    )
    await assert.rejects(
      () => fixture.store.readRecoveryStart({ ...input, unit: 'msat' }),
      /binding/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('fenced finalization requires completed children and explicit empty discovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-finalization-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '18'.repeat(64),
      nostrSecretKeyHex: '29'.repeat(32),
      incarnationId: 'recovery-finalization',
      invocationId: 'recovery-finalization',
    })
    const binding = {
      recoveryId: 'recovery-finalization',
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat' as const,
    }
    await runRecovery(fixture, {
      recoveryId: binding.recoveryId,
      disclosureAcknowledged: true,
      batches: [signedBatch(0)],
    })
    await assert.rejects(
      () => fixture.store.finalizeRecoveryJob(finalization(binding, fixture.fence, true)),
      /active keysets/,
    )
    await runRecovery(fixture, {
      recoveryId: binding.recoveryId,
      disclosureAcknowledged: true,
      batches: [emptyBatch(1)],
    })
    await assert.rejects(
      () =>
        fixture.store.finalizeRecoveryJob({
          ...finalization(binding, fixture.fence, true),
          discoveryCompleted: false,
        } as unknown as SeedRecoveryJobFinalization),
      /finalization input is invalid/,
    )
    await fixture.store.finalizeRecoveryJob(finalization(binding, fixture.fence, true))
    await fixture.store.finalizeRecoveryJob(finalization(binding, fixture.fence, true))
    await assert.rejects(
      () =>
        fixture.store.finalizeRecoveryJob({
          ...finalization(binding, fixture.fence, true),
          authority: {
            ...recoveryAuthority(binding.walletScopeId, fixture.fence),
            incarnationId: 'foreign-finalizer',
          },
        }),
      /authority is foreign/,
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.deepEqual(readRecoveryJob(database, binding.recoveryId), {
        importedProofs: 0,
        ignoredSpentProofs: 0,
        revision: 3,
        state: 'completed',
      })
    })
    const empty = { ...binding, recoveryId: 'recovery-empty' }
    await assert.rejects(
      () =>
        fixture.store.finalizeRecoveryJob({
          ...finalization(empty, fixture.fence, true),
          discoveryCompleted: false,
        } as unknown as SeedRecoveryJobFinalization),
      /finalization input is invalid/,
    )
    const emptyStore = new SeedRecoverySqliteStore({
      directory,
      fence: fixture.fence,
      invocationId: 'recovery-empty',
      observedAtMs: 3,
    })
    await emptyStore.finalizeRecoveryJob(finalization(empty, fixture.fence, true))
    await assert.rejects(
      () =>
        emptyStore.finalizeRecoveryJob(
          finalization({ ...empty, mintUrl: 'https://other.example' }, fixture.fence, true),
        ),
      /binding/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery schema rejects an orphan child keyset while foreign keys are enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-schema-fk-'))
  try {
    await createRecoveryFixture({
      directory,
      walletSeedHex: '19'.repeat(64),
      nostrSecretKeyHex: '2a'.repeat(32),
      incarnationId: 'recovery-schema-fk',
      invocationId: 'recovery-schema-fk',
    })
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(
        (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
        1,
      )
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO seed_recovery_keysets (
                 recovery_id, keyset_id, next_counter,
                 trailing_empty_counters, revision, state
               ) VALUES ('orphan', 'keyset-1', 0, 0, 0, 'active')`,
            )
            .run(),
        /FOREIGN KEY constraint failed/,
      )
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('direct recovery rejects a nonselectable proof without advancing cursor or counter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-pending-reject-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '14'.repeat(64),
      nostrSecretKeyHex: '25'.repeat(32),
      incarnationId: 'recovery-pending-reject',
      invocationId: 'recovery-pending-reject',
    })
    await assert.rejects(
      () =>
        runRecovery(fixture, {
          recoveryId: 'recovery-pending-reject',
          disclosureAcknowledged: true,
          batches: [
            {
              observation: oneProofObservation(),
              proofs: [observed(fixture.profile.walletScopeId, 'pending', 'PENDING', 'retained')],
            },
          ],
        }),
      /nonselectable/,
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(readRowCount(database, 'seed_recovery_jobs'), 0)
      assert.equal(readRowCount(database, 'seed_recovery_keysets'), 0)
      assert.equal(readRowCount(database, 'target_keyset_counters'), 0)
      assert.equal(readRowCount(database, 'custody_proofs'), 0)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('direct staged recovery rejects a target reservation added after its initial read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-target-reservation-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '15'.repeat(64),
      nostrSecretKeyHex: '26'.repeat(32),
      incarnationId: 'recovery-target-reservation',
      invocationId: 'recovery-target-reservation',
    })
    const recoveryId = 'recovery-target-reservation'
    const start = await fixture.store.readRecoveryStart({
      recoveryId,
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-1',
    })
    const recovered = observed(fixture.profile.walletScopeId, 'post-read', 'UNSPENT', 'selectable')
    fixture.store.stageBatch(recoveryId, 'keyset-1', [recovered])
    await withRecoveryDatabase(directory, (database) =>
      insertTargetWalletReservation(database, fixture.profile.walletScopeId),
    )
    await assert.rejects(
      () =>
        fixture.store.commitRecoveryBatch(
          createEmergencySeedRecoveryCoCommit({
            cursor: start.cursor,
            observation: oneProofObservation(),
            recoveredProofIds: [recovered.proof.proofId],
            recoveryJobId: recoveryId,
            authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
          }),
        ),
      /target-wallet-proof-reserved/,
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(readRowCount(database, 'seed_recovery_jobs'), 0)
      assert.equal(readRowCount(database, 'seed_recovery_keysets'), 0)
      assert.equal(readRowCount(database, 'target_keyset_counters'), 0)
      assert.equal(readRowCount(database, 'custody_proofs'), 0)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing recovery cursor restarts at zero and re-admits an identical proof idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-missing-cursor-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '34'.repeat(64),
      nostrSecretKeyHex: '45'.repeat(32),
      incarnationId: 'recovery-missing-cursor',
      invocationId: 'recovery-missing-cursor-1',
    })
    const batch = {
      observation: oneProofObservation(),
      proofs: [observed(fixture.profile.walletScopeId, 'same', 'UNSPENT', 'selectable')],
    }
    await runRecovery(fixture, {
      recoveryId: 'recovery-missing-cursor',
      disclosureAcknowledged: true,
      batches: [batch],
    })
    await deleteRecoveryCursor(directory, 'recovery-missing-cursor')
    const replay = await replayRecoveryFromZero(fixture, 'recovery-missing-cursor', batch)
    assert.equal(replay.nextCounter, 1)
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(readRowCount(database, 'custody_proofs'), 1)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery replay preserves stronger proof state and rejects a foreign binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-proof-preservation-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '78'.repeat(64),
      nostrSecretKeyHex: '89'.repeat(32),
      incarnationId: 'recovery-proof-preservation',
      invocationId: 'recovery-proof-preservation',
    })
    const strongerCases = [
      { label: 'pending', nut07State: 'PENDING', selectability: 'locked', reservation: null },
      { label: 'retained', nut07State: 'UNSPENT', selectability: 'retained', reservation: null },
      { label: 'spent', nut07State: 'SPENT', selectability: 'spent', reservation: null },
      {
        label: 'terminal',
        nut07State: 'SPENT',
        selectability: 'spent',
        reservation: null,
        storageClass: 'terminal-replay-retained' as const,
      },
      {
        label: 'owner-scoped',
        nut07State: 'UNSPENT',
        selectability: 'locked',
        reservation: 'owner-1',
      },
    ] as const
    for (const stronger of strongerCases) {
      const recovered = observed(
        fixture.profile.walletScopeId,
        stronger.label,
        'UNSPENT',
        'selectable',
      )
      await withRecoveryDatabase(directory, (database) => {
        const store = new DurableCustodySqliteStore(database)
        store.putProofCas(recovered.proof, null)
        store.putProofCas(
          {
            ...recovered.proof,
            nut07State: stronger.nut07State,
            selectability: stronger.selectability,
            reservationOperationId: stronger.reservation,
            storageClass: stronger.storageClass ?? recovered.proof.storageClass,
            revision: 1,
            updatedAtMs: 4,
          },
          0,
        )
      })
      await runExplicitEmergencySeedRecovery({
        recoveryId: `recovery-proof-${stronger.label}`,
        walletScopeId: fixture.profile.walletScopeId,
        mintUrl: 'https://mint.example',
        unit: 'sat',
        keysetId: 'keyset-1',
        disclosureAcknowledged: true,
        authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
        store: new SeedRecoverySqliteStore({
          directory: fixture.directory,
          fence: fixture.fence,
          invocationId: `recovery-proof-${stronger.label}`,
          observedAtMs: 3,
        }),
        batches: [{ observation: oneProofObservation(), proofs: [recovered] }],
      })
      await withRecoveryDatabase(directory, (database) => {
        const row = new DurableCustodySqliteStore(database).getProof(
          fixture.profile.walletScopeId,
          recovered.proof.proofId,
        )
        assert.equal(row?.nut07State, stronger.nut07State)
        assert.equal(row?.selectability, stronger.selectability)
        assert.equal(row?.reservationOperationId, stronger.reservation)
        assert.equal(row?.storageClass, stronger.storageClass ?? recovered.proof.storageClass)
        assert.equal(
          database
            .prepare('SELECT 1 FROM target_wallet_proofs WHERE scope_id = ? AND secret = ?')
            .get(fixture.profile.walletScopeId, `secret-${stronger.label}`),
          undefined,
        )
      })
    }

    const foreign = observed(fixture.profile.walletScopeId, 'foreign', 'UNSPENT', 'selectable')
    await withRecoveryDatabase(directory, (database) => {
      new DurableCustodySqliteStore(database).putProofCas(
        { ...foreign.proof, productBinding: 'foreign-binding' },
        null,
      )
    })
    await assert.rejects(
      () =>
        runRecovery(fixture, {
          recoveryId: 'recovery-proof-foreign',
          disclosureAcknowledged: true,
          batches: [{ observation: oneProofObservation(), proofs: [foreign] }],
        }),
      /mismatch/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery failures before and after commit preserve atomic recovery semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-commit-fault-'))
  try {
    const fixture = await createRecoveryFixture({
      directory,
      walletSeedHex: '9a'.repeat(64),
      nostrSecretKeyHex: 'ab'.repeat(32),
      incarnationId: 'recovery-commit-fault',
      invocationId: 'recovery-commit-fault',
    })
    const batch = {
      observation: oneProofObservation(),
      proofs: [observed(fixture.profile.walletScopeId, 'fault', 'UNSPENT', 'selectable')],
    }
    const beforeCommit = new SeedRecoverySqliteStore({
      directory,
      fence: fixture.fence,
      invocationId: 'recovery-before-commit',
      observedAtMs: 3,
      injectFault: (phase) => {
        if (phase === 'before-commit') throw new Error('injected failure before commit')
      },
    })
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          recoveryId: 'recovery-before-commit',
          walletScopeId: fixture.profile.walletScopeId,
          mintUrl: 'https://mint.example',
          unit: 'sat',
          keysetId: 'keyset-1',
          disclosureAcknowledged: true,
          authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
          store: beforeCommit,
          batches: [batch],
        }),
      /before commit/,
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(readRowCount(database, 'custody_proofs'), 0)
      assert.equal(readRowCount(database, 'target_keyset_counters'), 0)
      assert.equal(readRowCount(database, 'seed_recovery_jobs'), 0)
    })

    const afterCommit = new SeedRecoverySqliteStore({
      directory,
      fence: fixture.fence,
      invocationId: 'recovery-after-commit',
      observedAtMs: 3,
      injectFault: (phase) => {
        if (phase === 'after-commit') throw new Error('injected failure after commit')
      },
    })
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          recoveryId: 'recovery-after-commit',
          walletScopeId: fixture.profile.walletScopeId,
          mintUrl: 'https://mint.example',
          unit: 'sat',
          keysetId: 'keyset-1',
          disclosureAcknowledged: true,
          authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
          store: afterCommit,
          batches: [batch],
        }),
      /after commit/,
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(readRowCount(database, 'custody_proofs'), 1)
      assert.equal(readRowCount(database, 'target_keyset_counters'), 1)
      assert.equal(readRowCount(database, 'seed_recovery_jobs'), 1)
    })
    const failedUpdate = new SeedRecoverySqliteStore({
      directory,
      fence: fixture.fence,
      invocationId: 'recovery-failed-update',
      observedAtMs: 3,
      injectFault: (phase) => {
        if (phase === 'before-commit') throw new Error('injected update failure')
      },
    })
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          recoveryId: 'recovery-after-commit',
          walletScopeId: fixture.profile.walletScopeId,
          mintUrl: 'https://mint.example',
          unit: 'sat',
          keysetId: 'keyset-1',
          disclosureAcknowledged: true,
          authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
          store: failedUpdate,
          batches: [
            {
              observation: {
                expectedRevision: 1,
                startCounter: 1,
                requestedCount: 1,
                lastCounterWithSignature: 1,
                scanThroughCounter: 2,
              },
              proofs: [
                observed(fixture.profile.walletScopeId, 'failed-update', 'UNSPENT', 'selectable'),
              ],
            },
          ],
        }),
      /update failure/,
    )
    await withRecoveryDatabase(directory, (database) => {
      assert.deepEqual(readRecoveryJob(database, 'recovery-after-commit'), {
        importedProofs: 1,
        ignoredSpentProofs: 0,
        revision: 1,
        state: 'active',
      })
      const cursor = database
        .prepare(
          `SELECT next_counter AS nextCounter, revision
           FROM seed_recovery_keysets WHERE recovery_id = ? AND keyset_id = ?`,
        )
        .get('recovery-after-commit', 'keyset-1') as { nextCounter: number; revision: number }
      assert.equal(cursor.nextCounter, 1)
      assert.equal(cursor.revision, 1)
      assert.equal(readRowCount(database, 'custody_proofs'), 1)
      const counter = database
        .prepare(
          `SELECT next_counter AS nextCounter FROM target_keyset_counters
           WHERE scope_id = ? AND keyset_id = ?`,
        )
        .get(fixture.profile.walletScopeId, 'keyset-1') as { nextCounter: number }
      assert.equal(counter.nextCounter, 1)
    })
    await runExplicitEmergencySeedRecovery({
      recoveryId: 'recovery-after-commit',
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-1',
      disclosureAcknowledged: true,
      authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
      store: new SeedRecoverySqliteStore({
        directory,
        fence: fixture.fence,
        invocationId: 'recovery-after-commit-replay',
        observedAtMs: 3,
      }),
      batches: [
        {
          observation: {
            expectedRevision: 1,
            startCounter: 1,
            requestedCount: 1,
            lastCounterWithSignature: null,
            scanThroughCounter: 2,
          },
          proofs: [],
        },
      ],
    })
    await withRecoveryDatabase(directory, (database) => {
      assert.equal(readRowCount(database, 'custody_proofs'), 1)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery requires acknowledgement, rejects unknown state, and caps four batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-refusal-'))
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '33'.repeat(64),
      nostrSecretKeyHex: '44'.repeat(32),
      initializedAtMs: 1,
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'recovery-refusal',
      observedAtMs: 2,
    })
    const store = new SeedRecoverySqliteStore({
      directory,
      fence,
      invocationId: 'invocation-refusal',
      observedAtMs: 3,
    })
    const common = {
      recoveryId: 'recovery-refusal',
      walletScopeId: profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat' as const,
      keysetId: 'keyset-1',
      authority: {
        walletScopeId: profile.walletScopeId,
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: 3,
        leaseExpiresAtMs: fence.leaseExpiresAtMs,
        effectiveClockHighWaterMarkMs: 2,
      },
      store,
    }
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          ...common,
          disclosureAcknowledged: false,
          batches: [emptyBatch(0)],
        }),
      /acknowledgement/,
    )
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          ...common,
          disclosureAcknowledged: true,
          batches: Array.from({ length: 5 }, (_, index) => emptyBatch(index)),
        }),
      /one and four/,
    )
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          ...common,
          disclosureAcknowledged: true,
          batches: [
            {
              ...emptyBatch(0),
              proofs: [observed(profile.walletScopeId, 'd', 'UNKNOWN', 'retained')],
            },
          ],
        }),
      /unknown/,
    )
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          ...common,
          recoveryId: 'recovery-foreign',
          disclosureAcknowledged: true,
          store: new SeedRecoverySqliteStore({
            directory,
            fence,
            invocationId: 'invocation-foreign',
            observedAtMs: 3,
          }),
          batches: [
            {
              observation: oneProofObservation(),
              proofs: [observed(foreignWalletScopeId(), 'e', 'UNSPENT', 'selectable')],
            },
          ],
        }),
      /foreign/,
    )
    await assert.rejects(
      () =>
        runExplicitEmergencySeedRecovery({
          ...common,
          recoveryId: 'recovery-selectable-pending',
          disclosureAcknowledged: true,
          store: new SeedRecoverySqliteStore({
            directory,
            fence,
            invocationId: 'invocation-selectable-pending',
            observedAtMs: 3,
          }),
          batches: [
            {
              observation: oneProofObservation(),
              proofs: [observed(profile.walletScopeId, 'f', 'PENDING', 'selectable')],
            },
          ],
        }),
      /nonselectable/,
    )
    const database = await openDaemonStateSqlite(directory)
    try {
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM seed_recovery_jobs').get() as {
            count: number
          }
        ).count,
        0,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovery accepts lease renewal but rejects an owner takeover during mint I/O', async () => {
  await assertRecoveryFenceChange('renewal', async (directory, fence) =>
    renewCustodyScopeLease(directory, fence, 20_000),
  )
  await assert.rejects(
    () =>
      assertRecoveryFenceChange('takeover', (directory, fence) =>
        claimCustodyScopeLease(directory, {
          scopeId: fence.scopeId,
          incarnationId: 'recovery-takeover-owner',
          observedAtMs: fence.leaseExpiresAtMs,
        }),
      ),
    /changed|foreign|stale/,
  )
})

type RecoveryFixture = {
  readonly directory: string
  readonly profile: Awaited<ReturnType<typeof bootstrapFreshDaemonProfile>>
  readonly fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>
  readonly store: SeedRecoverySqliteStore
}

async function deleteRecoveryCursor(directory: string, recoveryId: string): Promise<void> {
  await withRecoveryDatabase(directory, (database) => {
    database.exec('PRAGMA foreign_keys = OFF')
    database
      .prepare('DELETE FROM seed_recovery_keysets WHERE recovery_id = ? AND keyset_id = ?')
      .run(recoveryId, 'keyset-1')
    database.exec('PRAGMA foreign_keys = ON')
  })
}

function replayRecoveryFromZero(
  fixture: RecoveryFixture,
  recoveryId: string,
  batch: ExplicitSeedRecoveryBatch,
) {
  return runExplicitEmergencySeedRecovery({
    recoveryId,
    walletScopeId: fixture.profile.walletScopeId,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-1',
    disclosureAcknowledged: true,
    authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
    store: new SeedRecoverySqliteStore({
      directory: fixture.directory,
      fence: fixture.fence,
      invocationId: `${recoveryId}-replay`,
      observedAtMs: 3,
    }),
    batches: [batch],
  })
}

type RecoveryFixtureInput = {
  readonly directory: string
  readonly walletSeedHex: string
  readonly nostrSecretKeyHex: string
  readonly incarnationId: string
  readonly invocationId: string
}

type RecoveryRequest = Parameters<typeof runExplicitEmergencySeedRecovery>[0]

async function createRecoveryFixture(input: RecoveryFixtureInput): Promise<RecoveryFixture> {
  const profile = await bootstrapFreshDaemonProfile({
    directory: input.directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: input.walletSeedHex,
    nostrSecretKeyHex: input.nostrSecretKeyHex,
    initializedAtMs: 1,
  })
  const fence = await claimCustodyScopeLease(input.directory, {
    scopeId: profile.walletScopeId,
    incarnationId: input.incarnationId,
    observedAtMs: 2,
  })
  return {
    directory: input.directory,
    profile,
    fence,
    store: new SeedRecoverySqliteStore({
      directory: input.directory,
      fence,
      invocationId: input.invocationId,
      observedAtMs: 3,
    }),
  }
}

function runRecovery(
  fixture: RecoveryFixture,
  input: Omit<
    RecoveryRequest,
    'walletScopeId' | 'mintUrl' | 'unit' | 'keysetId' | 'authority' | 'store'
  >,
): Promise<Awaited<ReturnType<typeof runExplicitEmergencySeedRecovery>>> {
  return runExplicitEmergencySeedRecovery({
    ...input,
    walletScopeId: fixture.profile.walletScopeId,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-1',
    authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
    store: fixture.store,
  })
}

function runRecoveryWithContext(
  fixture: RecoveryFixture,
  recoveryId: string,
  mintUrl: string,
  unit: 'sat' | 'msat',
  keysetId = 'keyset-1',
) {
  return () =>
    runExplicitEmergencySeedRecovery({
      recoveryId,
      walletScopeId: fixture.profile.walletScopeId,
      mintUrl,
      unit,
      keysetId,
      disclosureAcknowledged: true,
      authority: recoveryAuthority(fixture.profile.walletScopeId, fixture.fence),
      store: new SeedRecoverySqliteStore({
        directory: fixture.directory,
        fence: fixture.fence,
        invocationId: `recovery-context-${mintUrl}-${unit}`,
        observedAtMs: 3,
      }),
      batches: [emptyBatch(0)],
    })
}

async function assertRecoveryFenceChange(
  label: string,
  change: (
    directory: string,
    fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  ) => Promise<Awaited<ReturnType<typeof claimCustodyScopeLease>>>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `bitcaster-recovery-${label}-`))
  try {
    const walletSeedHex = 'cd'.repeat(64)
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex,
      nostrSecretKeyHex: 'ef'.repeat(32),
      initializedAtMs: 1,
    })
    let fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: `recovery-${label}`,
      observedAtMs: 2,
    })
    await recoverDaemonWalletFromSeed(
      {
        recoveryId: `recovery-${label}`,
        mintUrl: 'https://mint.example',
        unit: 'sat',
        keysetId: 'keyset-1',
        walletSeedHex,
        disclosureAcknowledged: true,
      },
      recoveryDependencies(
        directory,
        () => fence,
        async () => {
          fence = await change(directory, fence)
        },
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function recoveryDependencies(
  directory: string,
  getFence: () => Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  onRestore: () => Promise<void>,
) {
  return {
    directory,
    getFence,
    nowMs: () => 3,
    invocationId: () => 'recovery-fence-change',
    createWallet: () => ({
      async loadMint() {},
      keyChain: { getKeysets: () => [{ id: 'keyset-1' }] },
      getKeyset: () => ({ id: 'keyset-1', unit: 'sat', keys: {} }),
      async restore() {
        await onRestore()
        return { proofs: [] }
      },
      async checkProofsStates() {
        throw new Error('empty recovery batch must not call NUT-07')
      },
    }),
  }
}

async function withRecoveryDatabase(
  directory: string,
  run: (database: DatabaseSync) => void | Promise<void>,
): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    await run(database)
  } finally {
    database.close()
  }
}

function readRecoveryJob(database: DatabaseSync, recoveryId: string): Record<string, unknown> {
  return {
    ...(database
      .prepare(
        `SELECT imported_proofs AS importedProofs,
           ignored_spent_proofs AS ignoredSpentProofs, revision, state
         FROM seed_recovery_jobs WHERE recovery_id = ?`,
      )
      .get(recoveryId) as Record<string, unknown>),
  }
}

function insertTargetWalletReservation(database: DatabaseSync, scopeId: string): void {
  database
    .prepare(
      `INSERT INTO target_wallet_proofs (
         proof_id, scope_id, normalized_mint, unit, keyset_id, amount, secret,
         signature, proof_body, state, reserved_by, asset_kind, condition_id,
         outcome_set_id, base_asset, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 'https://mint.example', 'sat', 'keyset-1', 1,
         'target-reservation-secret', 'signature', X'7b7d', 'reserved',
         'reservation-1', 'sats', NULL, NULL, 'sat', 0, 0)`,
    )
    .run('f'.repeat(64), scopeId)
}

function readRowCount(
  database: DatabaseSync,
  table:
    | 'custody_proofs'
    | 'target_wallet_proofs'
    | 'seed_recovery_jobs'
    | 'seed_recovery_keysets'
    | 'target_keyset_counters',
): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count
}

function observed(
  scopeId: string,
  id: string,
  mintState: unknown,
  selectability: CustodyProofSqliteRow['selectability'],
  keysetId = 'keyset-1',
): SeedRecoveryObservedProof {
  const nut07State =
    mintState === 'UNSPENT' ? 'UNSPENT' : mintState === 'SPENT' ? 'SPENT' : 'PENDING'
  return {
    proofY: `proof-y-${id}`,
    mintState,
    proof: createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: 'https://mint.example',
      unit: 'sat',
      proof: {
        id: keysetId,
        amount: '1',
        secret: `secret-${id}`,
        C: `signature-${id}`,
        dleq: null,
        p2pkE: null,
        witness: null,
      },
      baseAsset: 'sat',
      conditionId: null,
      outcomeSetId: null,
      productBinding: null,
      signatureVerified: mintState === 'UNSPENT',
      dleqState: 'not-present',
      nut07State,
      selectability,
      storageClass: 'pinned-operation-bound-deterministic',
      reservationOperationId: null,
      revision: 0,
      nowMs: 3,
    }),
  }
}

function emptyBatch(index: number) {
  return {
    observation: {
      expectedRevision: index,
      startCounter: index * 300,
      requestedCount: 300,
      lastCounterWithSignature: null,
      scanThroughCounter: (index + 1) * 300,
    },
    proofs: [],
  }
}

function signedBatch(index: number) {
  return {
    observation: {
      expectedRevision: index,
      startCounter: index * 300,
      requestedCount: 300,
      lastCounterWithSignature: index * 300 + 299,
      scanThroughCounter: (index + 1) * 300,
    },
    proofs: [],
  }
}

function oneProofObservation() {
  return {
    expectedRevision: 0,
    startCounter: 0,
    requestedCount: 1,
    lastCounterWithSignature: 0,
    scanThroughCounter: 1,
  }
}

function recoveryAuthority(
  walletScopeId: string,
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
) {
  return {
    walletScopeId,
    incarnationId: fence.incarnationId,
    fencingEpoch: fence.fencingEpoch,
    observedAtMs: 3,
    leaseExpiresAtMs: fence.leaseExpiresAtMs,
    effectiveClockHighWaterMarkMs: 2,
  }
}

function finalization(
  binding: {
    readonly recoveryId: string
    readonly walletScopeId: string
    readonly mintUrl: string
    readonly unit: 'sat' | 'msat'
  },
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  discoveryCompleted: true,
) {
  return {
    recoveryId: binding.recoveryId,
    walletScopeId: binding.walletScopeId,
    mintUrl: binding.mintUrl,
    unit: binding.unit,
    disclosureAcknowledged: true as const,
    discoveryCompleted,
    authority: recoveryAuthority(binding.walletScopeId, fence),
  }
}

function foreignWalletScopeId(): string {
  return deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: '99'.repeat(32),
  })
}
