import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { CustodyProofSqliteRow } from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'

test('explicit ordinary recovery co-commits selectable, pending, spent, cursor, and job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-'))
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(32),
      nostrSecretKeyHex: '22'.repeat(32),
      initializedAtMs: 1,
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'recovery-incarnation',
      observedAtMs: 2,
    })
    const store = new SeedRecoverySqliteStore({
      directory,
      fence,
      invocationId: 'invocation-1',
      observedAtMs: 3,
    })
    const cursor = await runExplicitEmergencySeedRecovery({
      recoveryId: 'recovery-1',
      walletScopeId: profile.walletScopeId,
      mintUrl: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-1',
      disclosureAcknowledged: true,
      authority: {
        walletScopeId: profile.walletScopeId,
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: 3,
        leaseExpiresAtMs: fence.leaseExpiresAtMs,
        effectiveClockHighWaterMarkMs: 2,
      },
      store,
      batches: [
        {
          observation: {
            expectedRevision: 0,
            startCounter: 0,
            requestedCount: 3,
            lastCounterWithSignature: 2,
          },
          proofs: [
            observed(profile.walletScopeId, 'a', 'UNSPENT', 'selectable'),
            observed(profile.walletScopeId, 'b', 'PENDING', 'retained'),
            observed(profile.walletScopeId, 'c', 'SPENT', 'spent'),
          ],
        },
      ],
    })
    assert.equal(cursor.nextCounter, 3)
    assert.equal(cursor.revision, 1)
    const database = await openDaemonStateSqlite(directory)
    try {
      assert.deepEqual(
        {
          ...(database
            .prepare(
              `SELECT imported_proofs AS importedProofs,
                 ignored_spent_proofs AS ignoredSpentProofs, revision, state
               FROM seed_recovery_jobs WHERE recovery_id = 'recovery-1'`,
            )
            .get() as Record<string, unknown>),
        },
        {
          importedProofs: 1,
          ignoredSpentProofs: 1,
          revision: 1,
          state: 'active',
        },
      )
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM custody_proofs').get() as {
            count: number
          }
        ).count,
        1,
      )
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM seed_recovery_pending_proofs').get() as {
            count: number
          }
        ).count,
        1,
      )
    } finally {
      database.close()
    }
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
      walletSeedHex: '33'.repeat(32),
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
    const walletSeedHex = '55'.repeat(32)
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

function foreignWalletScopeId(): string {
  return deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: '99'.repeat(32),
  })
}
