import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { deriveDurableCustodyScopeId } from '@bitcaster-market/client-sdk/durableCustody'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  recoverDaemonWalletFromSeed,
  runExplicitEmergencySeedRecovery,
} from '../src/emergencySeedRecovery.ts'
import {
  SeedRecoverySqliteStore,
  type SeedRecoveryObservedProof,
} from '../src/seedRecoverySqlite.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { reserveDaemonKeysetCounter } from '../src/state.ts'

test('explicit ordinary recovery co-commits selectable, pending, spent, cursor, and job', async () => {
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
          },
          proofs: [
            observed(fixture.profile.walletScopeId, 'a', 'UNSPENT', 'selectable'),
            observed(fixture.profile.walletScopeId, 'b', 'PENDING', 'retained'),
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
      assert.equal(readRowCount(database, 'seed_recovery_pending_proofs'), 1)
    })
    await withDaemonHome(directory, async () => {
      assert.deepEqual(
        await reserveDaemonKeysetCounter('keyset-1', 1, {
          fence: fixture.fence,
          observedAtMs: 4,
        }),
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
      new DurableCustodySqliteStore(database).putProofCas(duplicate.proof, null)
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
      /pending proof is selectable/,
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

test('typed recovery runner performs one bounded mint scan and fenced commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-runner-'))
  try {
    const walletSeedHex = '55'.repeat(64)
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex,
      nostrSecretKeyHex: '66'.repeat(32),
      initializedAtMs: 1,
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'recovery-runner-incarnation',
      observedAtMs: 2,
    })
    let restores = 0
    const result = await recoverDaemonWalletFromSeed(
      {
        recoveryId: 'recovery-runner',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        keysetId: 'keyset-1',
        walletSeedHex,
        disclosureAcknowledged: true,
      },
      {
        directory,
        getFence: () => fence,
        nowMs: () => 3,
        invocationId: () => 'invocation-runner',
        createWallet: () => ({
          async loadMint() {},
          keyChain: { getKeysets: () => [{ id: 'keyset-1' }] },
          getKeyset() {
            return { id: 'keyset-1', unit: 'sat', keys: {} }
          },
          async restore(start, count) {
            restores += 1
            assert.equal(start, 0)
            assert.equal(count, 300)
            return { proofs: [] }
          },
          async checkProofsStates() {
            throw new Error('empty recovery batch must not call NUT-07')
          },
        }),
      },
    )
    assert.deepEqual(result, {
      recoveryId: 'recovery-runner',
      state: 'completed',
      nextCounter: 300,
      batchesProcessed: 1,
    })
    assert.equal(restores, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

type RecoveryFixture = {
  readonly directory: string
  readonly profile: Awaited<ReturnType<typeof bootstrapFreshDaemonProfile>>
  readonly fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>
  readonly store: SeedRecoverySqliteStore
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

function readRowCount(
  database: DatabaseSync,
  table:
    | 'custody_proofs'
    | 'seed_recovery_jobs'
    | 'seed_recovery_pending_proofs'
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
        id: 'keyset-1',
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

async function withDaemonHome(directory: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
  }
}

function foreignWalletScopeId(): string {
  return deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: '99'.repeat(32),
  })
}
