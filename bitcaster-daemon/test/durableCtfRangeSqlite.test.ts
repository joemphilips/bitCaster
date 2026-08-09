import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createCtfAuthorizationOutputs,
  createCtfRangeManifest,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveCtfRangeRefundKey,
  deriveKeysetId,
  createCtfSelectionBitmap,
  hashToCurve,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import {
  buildDurableCtfRangeRecoveryQuery,
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeOperation,
  createDurableCtfRangeRefundOperation,
  createDurableCtfRangeResultEnvelope,
  deriveRootCtfOutcomeCollectionId,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeAllManifestRecovery,
  type DurableCtfRangeKeysetResolver,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeOperation,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  applyDurableCustodyTransaction,
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk'
import { bindDurableCustodyProofOperation } from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { DaemonCtfRangeCoordinator } from '../src/ctfRangeCoordinator.ts'
import { loadDaemonDurableCtfRangeAuthority } from '../src/durableCtfRangeSqlite.ts'
import {
  CTF_RANGE_REFUND_PURPOSE,
  emptyDaemonState,
  prepareCtfRangeRefundProofOperationFromDatabase,
  writeDaemonStateToDatabase,
  type CashuProofRecord,
} from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { serializeOutputDataArray } from '../src/walletOps.ts'

const CONDITION_ID = 'ab'.repeat(32)
const ROOT_PARENT = '0'.repeat(64)
const OUTCOME_COLLECTION = 'YES'
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 200
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
const MINT_KEYS = { '1': MINT_PUBLIC_KEY, '2': MINT_PUBLIC_KEY, '4': MINT_PUBLIC_KEY }
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const OFFER_KEYSET_ID = deriveKeysetId(MINT_KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const RECEIVE_KEYSET_ID = deriveConditionalKeysetId({
  keys: MINT_KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})

test('range authority survives restart and injected rollback exposes no partial link', async () => {
  const fixture = await createProfile()
  try {
    const scope = walletScope(fixture.walletScopeId)
    const operation = createRangeOperation()
    const binding = await createRangeBinding(scope, operation)
    const proofIds = binding.record.operation.reservation.inputs.map(({ proofId }) => proofId)
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-authority-test',
      observedAtMs: 2,
    })

    await withDurableCustodyUnitOfWork(fixture.directory, fence, 3, (database) => {
      const store = new DurableCustodySqliteStore(database)
      proofIds.forEach((proofId, index) =>
        store.putProofCas(
          proofRow(fixture.walletScopeId, operation, operation.inputs[index]!, proofId),
          null,
        ),
      )
    })
    await assert.rejects(
      () =>
        persistRangeBinding(fixture.directory, fence, 4, binding, (phase) => {
          if (phase === 'before-commit') throw new Error('injected range authority rollback')
        }),
      /injected range authority rollback/,
    )

    await assertRolledBack(fixture.directory, fixture.walletScopeId, proofIds)
    await assert.rejects(
      () =>
        persistRangeBinding(fixture.directory, fence, 5, binding, (phase) => {
          if (phase === 'after-commit') throw new Error('injected post-commit restart')
        }),
      /injected post-commit restart/,
    )

    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const store = new DurableCustodySqliteStore(database)
      const custodyOperationId = binding.record.operation.operationId
      const restored = loadDaemonDurableCtfRangeAuthority(store, custodyOperationId)
      assert.ok(restored)
      assert.equal(
        isDeepStrictEqual(restored.operation, operation),
        true,
        'restarted range operation must equal the exact persisted authority',
      )
      assert.equal(
        isDeepStrictEqual(
          restored.record.operation.reservation.inputs,
          binding.record.operation.reservation.inputs,
        ),
        true,
        'restarted operation must retain its exact ordered proof link',
      )
      for (const proofId of proofIds) {
        assert.equal(store.getProof(fixture.walletScopeId, proofId)?.selectability, 'locked')
        assert.equal(
          store.getProof(fixture.walletScopeId, proofId)?.reservationOperationId,
          custodyOperationId,
        )
      }
      assert.equal(
        (
          database
            .prepare(
              `SELECT count(*) AS count FROM custody_proof_reservations
               WHERE scope_id = ? AND operation_id = ?`,
            )
            .get(fixture.walletScopeId, custodyOperationId) as { count: number }
        ).count,
        2,
      )
      assert.equal(
        (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
        1,
      )
      assert.equal(
        (database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'wal',
      )
      assert.equal(
        (database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
        2,
      )
      database
        .prepare(
          `UPDATE custody_proofs SET curve = 'bls12-381', dleq_state = 'not-present'
           WHERE scope_id = ? AND proof_id = ?`,
        )
        .run(fixture.walletScopeId, proofIds[0]!)
      assert.throws(() => loadDaemonDurableCtfRangeAuthority(store, custodyOperationId), /curve/)
      database
        .prepare(
          `UPDATE custody_proofs SET
             curve = 'secp256k1', dleq_state = 'verified', amount = amount + 1
           WHERE scope_id = ? AND proof_id = ?`,
        )
        .run(fixture.walletScopeId, proofIds[0]!)
      assert.throws(
        () => loadDaemonDurableCtfRangeAuthority(store, custodyOperationId),
        /proof material authority|persisted proof authority/,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('daemon range coordinator binds exactly across before/after-commit restart boundaries', async () => {
  const fixture = await createProfile()
  try {
    const operation = createRangeOperation()
    const binding = await createRangeBinding(walletScope(fixture.walletScopeId), operation)
    const custodyOperationId = binding.record.operation.operationId
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-coordinator-bind',
      observedAtMs: 2,
    })
    await seedInputProofs(fixture.directory, fence, operation, binding)
    const coordinator = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    let checkCount = 0
    const proofStateClient = {
      check: async ({ Ys }: { Ys: string[] }) => {
        checkCount += 1
        return { states: Ys.map((Y) => ({ Y, state: 'UNSPENT' as const, witness: null })) }
      },
    }

    await assert.rejects(
      () =>
        coordinator.bind({
          binding,
          proofStateClient,
          observedAtMs: 3,
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected bind rollback')
          },
        }),
      /injected bind rollback/,
    )
    assert.equal(await coordinator.load(custodyOperationId), null)

    await assert.rejects(
      () =>
        coordinator.bind({
          binding,
          proofStateClient,
          observedAtMs: 4,
          injectFault: (phase) => {
            if (phase === 'after-commit') throw new Error('injected bind lost acknowledgement')
          },
        }),
      /injected bind lost acknowledgement/,
    )
    assert.equal(checkCount, 2)

    const restarted = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    const restored = await restarted.load(custodyOperationId)
    assert.ok(restored)
    assert.equal(
      isDeepStrictEqual(restored.operation, operation),
      true,
      'restart must load the exact persisted range authority',
    )
    const beforeReplay = await readDatabaseFingerprint(fixture.directory)
    const replay = await restarted.bind({
      binding,
      proofStateClient: {
        check: async () => {
          throw new Error('NUT-07 must not run after durable admission')
        },
      },
      observedAtMs: 5,
    })
    assert.equal(replay.operation.operationId, operation.operationId)
    assert.equal(checkCount, 2)
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeReplay),
      true,
      'exact bind replay must be read-only',
    )

    const takeoverAtMs = fence.leaseExpiresAtMs
    const takeoverFence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-coordinator-bind-takeover',
      observedAtMs: takeoverAtMs,
    })
    const takeover = await new DaemonCtfRangeCoordinator(fixture.directory, takeoverFence).bind({
      binding,
      proofStateClient: {
        check: async () => {
          throw new Error('NUT-07 must not run during exact takeover replay')
        },
      },
      observedAtMs: takeoverAtMs,
    })
    assert.equal(takeover.operation.operationId, operation.operationId)
    await assert.rejects(
      () =>
        restarted.bind({
          binding,
          proofStateClient: {
            check: async () => {
              throw new Error('NUT-07 must not run for a stale exact replay')
            },
          },
          observedAtMs: takeoverAtMs + 1,
        }),
      /stale or expired authority/,
    )
    const substituted = structuredClone(binding)
    substituted.record.operation.exactRequest.idempotencyKey += '-substituted'
    await assert.rejects(
      () =>
        restarted.bind({
          binding: substituted,
          proofStateClient: {
            check: async () => {
              throw new Error('NUT-07 must not run for a stale substituted replay')
            },
          },
          observedAtMs: takeoverAtMs + 1,
        }),
      /stale or expired authority/,
    )
    assert.equal(checkCount, 2)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('daemon range coordinator atomically transfers its prepared source across restart', async () => {
  const fixture = await createProfile()
  try {
    const operation = createRangeOperation()
    const binding = await createRangeBinding(walletScope(fixture.walletScopeId), operation)
    const custodyOperationId = binding.record.operation.operationId
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-coordinator-source',
      observedAtMs: 2,
    })
    await seedPreparedRangeSource(fixture.directory, operation)
    const coordinator = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    const beforeRollback = await readDatabaseFingerprint(fixture.directory)

    await assert.rejects(
      () =>
        coordinator.bindPreparedSource({
          binding,
          proofStateClient: unspentProofStateClient(),
          observedAtMs: 3,
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected source transfer rollback')
          },
        }),
      /injected source transfer rollback/,
    )
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeRollback),
      true,
      'source rollback must preserve target inventory and custody byte-for-byte',
    )

    await assert.rejects(
      () =>
        coordinator.bindPreparedSource({
          binding,
          proofStateClient: unspentProofStateClient(),
          observedAtMs: 4,
          injectFault: (phase) => {
            if (phase === 'after-commit') throw new Error('injected source acknowledgement loss')
          },
        }),
      /injected source acknowledgement loss/,
    )
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const reserved = database
        .prepare(
          `SELECT count(*) AS count FROM target_wallet_proofs
           WHERE scope_id = ? AND reserved_by = ?`,
        )
        .get(fixture.walletScopeId, sourceReservationId(operation)) as { count: number }
      assert.equal(reserved.count, 0)
      assert.ok(
        loadDaemonDurableCtfRangeAuthority(
          new DurableCustodySqliteStore(database),
          custodyOperationId,
        ),
      )
    } finally {
      database.close()
    }

    const restarted = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    const beforeReplay = await readDatabaseFingerprint(fixture.directory)
    await restarted.bindPreparedSource({
      binding,
      proofStateClient: {
        check: async () => {
          throw new Error('NUT-07 must not run after durable source transfer')
        },
      },
      observedAtMs: 5,
    })
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeReplay),
      true,
      'source transfer replay must be read-only',
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('daemon range coordinator stages and applies the exact result across crash boundaries', async () => {
  const fixture = await createProfile()
  try {
    const operation = createRangeOperation()
    const binding = await createRangeBinding(walletScope(fixture.walletScopeId), operation)
    const custodyOperationId = binding.record.operation.operationId
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-coordinator-result',
      observedAtMs: 2,
    })
    await seedInputProofs(fixture.directory, fence, operation, binding)
    const coordinator = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    await coordinator.bind({
      binding,
      proofStateClient: unspentProofStateClient(),
      observedAtMs: 3,
    })
    const selection = createCtfSelectionBitmap(operation.manifest.entries.length, [1, 3])
    const envelope = createDurableCtfRangeResultEnvelope({
      operation,
      requestDigest: 'ef'.repeat(32),
      selection,
      signatures: signaturesFor(operation, selection),
    })
    const recovery = recoveryFor(operation, selection)
    const resolveKeyset = rangeKeysetResolver(operation)
    const beforeStageRollback = await readRangeLifecycleSnapshot(
      fixture.directory,
      fixture.walletScopeId,
      custodyOperationId,
    )

    await assert.rejects(
      () =>
        coordinator.stageVerified({
          custodyOperationId,
          operation,
          envelope,
          resolveKeyset,
          observedAtMs: 4,
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected stage rollback')
          },
        }),
      /injected stage rollback/,
    )
    assert.equal(
      isDeepStrictEqual(
        await readRangeLifecycleSnapshot(
          fixture.directory,
          fixture.walletScopeId,
          custodyOperationId,
        ),
        beforeStageRollback,
      ),
      true,
      'stage rollback must preserve the exact bounded lifecycle snapshot',
    )
    assert.equal(
      (await coordinator.load(custodyOperationId))?.record.operation.result.state,
      'none',
    )

    await assert.rejects(
      () =>
        coordinator.stageVerified({
          custodyOperationId,
          operation,
          envelope,
          resolveKeyset,
          observedAtMs: 5,
          injectFault: (phase) => {
            if (phase === 'after-commit') throw new Error('injected stage lost acknowledgement')
          },
        }),
      /injected stage lost acknowledgement/,
    )
    assert.equal(
      (await coordinator.load(custodyOperationId))?.record.operation.result.state,
      'verified-staged',
    )
    const foreignCoordinator = new DaemonCtfRangeCoordinator(fixture.directory, {
      ...fence,
      scopeId: 'custody:wallet:foreign-wallet',
    })
    await assert.rejects(
      () => foreignCoordinator.load(custodyOperationId),
      /daemon CTF range scope is foreign/,
    )
    await assert.rejects(
      () =>
        foreignCoordinator.stageVerified({
          custodyOperationId,
          operation,
          envelope,
          resolveKeyset,
          observedAtMs: 6,
        }),
      /daemon CTF range scope is foreign/,
    )
    const beforeStageReplay = await readDatabaseFingerprint(fixture.directory)
    assert.equal(
      (
        await coordinator.stageVerified({
          custodyOperationId,
          operation,
          envelope,
          resolveKeyset,
          observedAtMs: 6,
        })
      ).kind,
      'confirmed',
    )
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeStageReplay),
      true,
      'exact stage replay must be read-only',
    )
    const staleCoordinator = new DaemonCtfRangeCoordinator(fixture.directory, {
      ...fence,
      fencingEpoch: fence.fencingEpoch + 1,
    })
    await assert.rejects(
      () =>
        staleCoordinator.stageVerified({
          custodyOperationId,
          operation,
          envelope,
          resolveKeyset,
          observedAtMs: 6,
        }),
      /stale or expired authority/,
    )
    const beforeApplyRollback = await readRangeLifecycleSnapshot(
      fixture.directory,
      fixture.walletScopeId,
      custodyOperationId,
    )

    await assert.rejects(
      () =>
        coordinator.applyStaged({
          custodyOperationId,
          resolveKeyset,
          observedAtMs: 7,
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected apply rollback')
          },
        }),
      /injected apply rollback/,
    )
    assert.equal(
      isDeepStrictEqual(
        await readRangeLifecycleSnapshot(
          fixture.directory,
          fixture.walletScopeId,
          custodyOperationId,
        ),
        beforeApplyRollback,
      ),
      true,
      'apply rollback must preserve the exact bounded lifecycle snapshot',
    )
    assert.equal(
      (await coordinator.load(custodyOperationId))?.record.operation.result.state,
      'verified-staged',
    )

    await assert.rejects(
      () =>
        coordinator.applyStaged({
          custodyOperationId,
          resolveKeyset,
          observedAtMs: 8,
          injectFault: (phase) => {
            if (phase === 'after-commit') throw new Error('injected apply lost acknowledgement')
          },
        }),
      /injected apply lost acknowledgement/,
    )
    const restarted = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    const applied = await restarted.load(custodyOperationId)
    assert.equal(applied?.record.operation.result.state, 'applied')
    assert.equal(applied?.record.operation.state, 'reconciled')
    assert.equal(
      applied?.record.operation.proofStorage.lineage.successorAdmission?.proofRows.length,
      2,
    )
    const appliedDatabase = await openDaemonStateSqlite(fixture.directory)
    try {
      for (const { proofId } of binding.record.operation.reservation.inputs) {
        const predecessor = new DurableCustodySqliteStore(appliedDatabase).getProof(
          fixture.walletScopeId,
          proofId,
        )
        assert.equal(predecessor?.nut07State, 'SPENT')
        assert.equal(predecessor?.selectability, 'spent')
        assert.equal(predecessor?.reservationOperationId, null)
      }
      const successorProofIds =
        applied?.record.operation.proofStorage.lineage.successorAdmission?.proofRows.map(
          ({ proofId }) => proofId,
        ) ?? []
      assert.equal(successorProofIds.length, 2)
      for (const proofId of successorProofIds) {
        const successor = new DurableCustodySqliteStore(appliedDatabase).getProof(
          fixture.walletScopeId,
          proofId,
        )
        assert.equal(successor?.nut07State, 'UNSPENT')
        assert.equal(successor?.selectability, 'retained')
        assert.equal(successor?.reservationOperationId, null)
      }
      const walletProofs = appliedDatabase
        .prepare(
          `SELECT state, asset_kind AS assetKind, base_asset AS baseAsset, unit,
             condition_id AS conditionId, outcome_set_id AS outcomeSetId
           FROM target_wallet_proofs
           WHERE scope_id = ?
           ORDER BY asset_kind`,
        )
        .all(fixture.walletScopeId)
        .map((row) => ({ ...row }))
      assert.deepEqual(walletProofs, [
        {
          state: 'available',
          assetKind: 'outcome',
          baseAsset: 'sat',
          unit: 'msat',
          conditionId: CONDITION_ID,
          outcomeSetId: OUTCOME_COLLECTION,
        },
        {
          state: 'available',
          assetKind: 'sats',
          baseAsset: 'sat',
          unit: 'msat',
          conditionId: null,
          outcomeSetId: null,
        },
      ])
      const reservationCount = appliedDatabase
        .prepare(
          `SELECT count(*) AS count FROM custody_proof_reservations
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .get(fixture.walletScopeId, custodyOperationId) as { count: number }
      assert.equal(reservationCount.count, 0)
    } finally {
      appliedDatabase.close()
    }
    await assert.rejects(
      () =>
        staleCoordinator.applyStaged({
          custodyOperationId,
          resolveKeyset,
          observedAtMs: 9,
        }),
      /stale or expired authority/,
    )
    const successorProofId =
      applied?.record.operation.proofStorage.lineage.successorAdmission?.proofRows[0]?.proofId
    assert.ok(successorProofId)
    await assert.rejects(
      () =>
        foreignCoordinator.applyStaged({
          custodyOperationId,
          resolveKeyset,
          observedAtMs: 9,
        }),
      /daemon CTF range scope is foreign/,
    )
    await withDurableCustodyUnitOfWork(fixture.directory, fence, 9, (database) => {
      const spent = database
        .prepare(
          `UPDATE custody_proofs
           SET selectability = 'spent', nut07_state = 'SPENT',
             revision = revision + 1, updated_at_ms = ?
           WHERE scope_id = ? AND proof_id = ?`,
        )
        .run(9, fixture.walletScopeId, successorProofId)
      assert.equal(spent.changes, 1)
    })
    const beforeApplyReplay = await readDatabaseFingerprint(fixture.directory)
    const exactReplay = await restarted.applyStaged({
      custodyOperationId,
      resolveKeyset,
      observedAtMs: 10,
    })
    assert.equal(exactReplay.operation.result.state, 'applied')
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeApplyReplay),
      true,
      'exact apply replay must be read-only',
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('daemon range recovery remains bounded and stages confirmed mint recovery atomically', async () => {
  const fixture = await createProfile()
  try {
    const operation = createRangeOperation()
    const binding = await createRangeBinding(walletScope(fixture.walletScopeId), operation)
    const custodyOperationId = binding.record.operation.operationId
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-coordinator-recovery',
      observedAtMs: 2,
    })
    await seedInputProofs(fixture.directory, fence, operation, binding)
    const coordinator = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    await coordinator.bind({
      binding,
      proofStateClient: unspentProofStateClient(),
      observedAtMs: 3,
    })
    const inputStates = operation.inputs.map(({ secret }) => ({
      Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
      state: 'UNSPENT' as const,
      witness: null,
    }))
    const query = buildDurableCtfRangeRecoveryQuery(operation, null)
    const baseObservation = {
      selection: null,
      inputStates,
      queriedOutputs: query.outputs,
      restoredOutputs: [],
      signatures: [],
      queryCompleted: true,
    }

    assert.equal(
      (
        await coordinator.classifyRecovery({
          custodyOperationId,
          observation: { ...baseObservation, now: operation.expiry - 1 },
          resolveKeyset: rangeKeysetResolver(operation),
        })
      ).kind,
      'waiting',
    )
    assert.equal(
      (
        await coordinator.classifyRecovery({
          custodyOperationId,
          observation: { ...baseObservation, now: operation.expiry },
          resolveKeyset: rangeKeysetResolver(operation),
        })
      ).kind,
      'refundable',
    )
    assert.equal(
      (
        await coordinator.classifyRecovery({
          custodyOperationId,
          observation: {
            ...baseObservation,
            inputStates: inputStates.map((state, index) =>
              index === 0 ? { ...state, state: 'PENDING' as const } : state,
            ),
            now: operation.expiry,
          },
          resolveKeyset: rangeKeysetResolver(operation),
        })
      ).kind,
      'reconciling',
    )
    assert.equal(
      (
        await coordinator.classifyRecovery({
          custodyOperationId,
          observation: {
            ...baseObservation,
            inputStates: Array.from({ length: 257 }, () => inputStates[0]!),
            now: operation.expiry,
          },
          resolveKeyset: rangeKeysetResolver(operation),
        })
      ).kind,
      'reconciling',
    )
    const retained = await coordinator.load(custodyOperationId)
    assert.equal(retained?.record.operation.result.state, 'none')
    assert.equal(retained?.record.operation.reservation.inputs.length, operation.inputs.length)
    assert.ok(retained?.record.operation.privateMaterial.exactPrivateMaterial)

    const selection = createCtfSelectionBitmap(operation.manifest.entries.length, [1, 3])
    const confirmedObservation = {
      ...recoveryFor(operation, selection),
      selection: null,
      inputStates: inputStates.map((state) => ({ ...state, state: 'SPENT' as const })),
      now: operation.expiry,
    }
    await assert.rejects(
      () =>
        coordinator.stageRecovered({
          custodyOperationId,
          observation: confirmedObservation,
          resolveKeyset: rangeKeysetResolver(operation),
          observedAtMs: 4,
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected recovered stage rollback')
          },
        }),
      /injected recovered stage rollback/,
    )
    assert.equal(
      (await coordinator.load(custodyOperationId))?.record.operation.result.state,
      'none',
    )
    await assert.rejects(
      () =>
        coordinator.stageRecovered({
          custodyOperationId,
          observation: confirmedObservation,
          resolveKeyset: rangeKeysetResolver(operation),
          observedAtMs: 5,
          injectFault: (phase) => {
            if (phase === 'after-commit') {
              throw new Error('injected recovered stage acknowledgement loss')
            }
          },
        }),
      /injected recovered stage acknowledgement loss/,
    )
    const restarted = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    assert.equal(
      (await restarted.load(custodyOperationId))?.record.operation.result.state,
      'verified-staged',
    )
    const applied = await restarted.applyStaged({
      custodyOperationId,
      resolveKeyset: rangeKeysetResolver(operation),
      observedAtMs: 6,
    })
    assert.equal(applied.operation.result.state, 'applied')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('daemon range refund completion is atomic and replay-safe across commit faults', async () => {
  const fixture = await createProfile()
  try {
    const operation = createRangeOperation()
    const binding = await createRangeBinding(walletScope(fixture.walletScopeId), operation)
    const custodyOperationId = binding.record.operation.operationId
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'range-coordinator-refund',
      observedAtMs: 2,
    })
    await seedInputProofs(fixture.directory, fence, operation, binding)
    const coordinator = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    await coordinator.bind({
      binding,
      proofStateClient: unspentProofStateClient(),
      observedAtMs: 3,
    })

    const refundOperationId = 'daemon-range-refund-1'
    const refundOutputs = OutputData.createRandomData(Amount.from(3), {
      id: OFFER_KEYSET_ID,
      keys: MINT_KEYS,
    })
    const prepared = createDurableCtfRangeRefundOperation({
      operationId: refundOperationId,
      source: operation,
      refundKeysetId: OFFER_KEYSET_ID,
      resolveKeysetAsset: (id) => (id === OFFER_KEYSET_ID ? operation.offerAsset : undefined),
      outputs: refundOutputs.map(OutputData.serialize),
    })
    await withDurableCustodyUnitOfWork(fixture.directory, fence, 4, (database) => {
      prepareCtfRangeRefundProofOperationFromDatabase(
        database,
        {
          operationId: refundOperationId,
          kind: 'swap-refund',
          mintUrl: operation.mintUrl,
          inputs: prepared.request.inputs,
          outputs: { refund: serializeOutputDataArray(refundOutputs) },
          metadata: {
            ...prepared.operation.metadata,
            purpose: CTF_RANGE_REFUND_PURPOSE,
            rangeOperationId: operation.operationId,
            custodyOperationId,
            refundKeysetId: OFFER_KEYSET_ID,
          },
        },
        4,
      )
    })
    const refundProofs = refundOutputs.map(signOutput)
    const refundAsset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
    const beforeRollback = await readDatabaseFingerprint(fixture.directory)

    await assert.rejects(
      () =>
        coordinator.completeRefund({
          custodyOperationId,
          refundOperationId,
          refundProofs,
          refundAsset,
          observedAtMs: 5,
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected refund completion rollback')
          },
        }),
      /injected refund completion rollback/,
    )
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeRollback),
      true,
      'refund rollback must preserve the exact source, journal, and wallet inventory',
    )

    await assert.rejects(
      () =>
        coordinator.completeRefund({
          custodyOperationId,
          refundOperationId,
          refundProofs,
          refundAsset,
          observedAtMs: 6,
          injectFault: (phase) => {
            if (phase === 'after-commit') {
              throw new Error('injected refund completion acknowledgement loss')
            }
          },
        }),
      /injected refund completion acknowledgement loss/,
    )
    const restarted = new DaemonCtfRangeCoordinator(fixture.directory, fence)
    const committed = await restarted.load(custodyOperationId)
    assert.equal(committed?.record.operation.state, 'aborted')
    assert.equal(committed?.record.operation.result.state, 'none')
    const committedDatabase = await openDaemonStateSqlite(fixture.directory)
    try {
      const refundJournal = committedDatabase
        .prepare(
          `SELECT state FROM target_proof_operations
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .get(fixture.walletScopeId, refundOperationId) as { state: string }
      assert.equal(refundJournal.state, 'completed')
      const walletRefunds = committedDatabase
        .prepare(
          `SELECT count(*) AS count FROM target_wallet_proofs
           WHERE scope_id = ? AND state = 'available'
             AND asset_kind = 'sats' AND unit = 'msat'`,
        )
        .get(fixture.walletScopeId) as { count: number }
      assert.equal(walletRefunds.count, refundProofs.length)
      const activeWork = committedDatabase
        .prepare(
          `SELECT count(*) AS count FROM custody_active_work
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .get(fixture.walletScopeId, custodyOperationId) as { count: number }
      assert.equal(activeWork.count, 0)
      for (const { proofId } of binding.record.operation.reservation.inputs) {
        const source = new DurableCustodySqliteStore(committedDatabase).getProof(
          fixture.walletScopeId,
          proofId,
        )
        assert.equal(source?.nut07State, 'SPENT')
        assert.equal(source?.selectability, 'spent')
        assert.equal(source?.reservationOperationId, null)
      }
    } finally {
      committedDatabase.close()
    }

    const beforeReplay = await readDatabaseFingerprint(fixture.directory)
    await restarted.completeRefund({
      custodyOperationId,
      refundOperationId,
      refundProofs,
      refundAsset,
      observedAtMs: 7,
    })
    assert.equal(
      isDeepStrictEqual(await readDatabaseFingerprint(fixture.directory), beforeReplay),
      true,
      'exact refund completion replay must be read-only',
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function createProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-range-sqlite-'))
  const bootstrapped = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
    initializedAtMs: 1,
  })
  return { directory, ...bootstrapped }
}

function walletScope(scopeId: string): DurableCustodyScope {
  return {
    scopeKind: 'wallet',
    walletId: scopeId.slice('custody:wallet:'.length),
    scopeId,
  }
}

function createRangeOperation(): DurableCtfRangeOperation {
  const seed = new Uint8Array(64).fill(7)
  const operationId = 'daemon-range-operation-1'
  const manifest = createCtfRangeManifest({
    seed,
    operationId,
    receiveKeyset: { id: RECEIVE_KEYSET_ID, active: true, keys: MINT_KEYS },
    offerKeyset: { id: OFFER_KEYSET_ID, active: true, keys: MINT_KEYS },
    maxReceive: '3',
    maxChange: '3',
    maxEntries: 4,
  })
  const refundKey = deriveCtfRangeRefundKey(seed, operationId)
  const inputs = createCtfAuthorizationOutputs({
    seed,
    operationId,
    offerKeysetId: OFFER_KEYSET_ID,
    amounts: ['2', '2'],
    commitment: manifest.commitment,
    expiry: 100,
    expiryContext: expiryContext(),
    refund: refundKey.publicKey,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    poolPolicy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
  }).map(signOutput)
  return createDurableCtfRangeOperation({
    operationId,
    sourceOperationId: 'daemon-range-prepare-1',
    authorizationId: 'daemon-range-authorization-1',
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: CONDITION_ID,
    parentCollectionId: ROOT_PARENT,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    offerKeysetId: OFFER_KEYSET_ID,
    receiveKeysetId: RECEIVE_KEYSET_ID,
    keysetLookup: keysetLookup(),
    expiryObservation: expiryObservation(),
    allowInsecureLoopbackHttp: false,
    expiry: 100,
    policy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
    refundKey,
    inputFeePpkByKeyset: { [OFFER_KEYSET_ID]: INPUT_FEE_PPK },
    inputs,
    manifest,
  })
}

function expiryContext() {
  return {
    now: 10,
    maxExpirySeconds: 100,
    condition: { condition_id: CONDITION_ID, keysets: { YES: RECEIVE_KEYSET_ID } },
    conditionalKeysets: [
      { id: RECEIVE_KEYSET_ID, condition_id: CONDITION_ID, final_expiry: FINAL_EXPIRY },
    ],
  }
}

function expiryObservation() {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh' as const,
    observedAt: 10,
    maxExpirySeconds: 100,
    conditionKeysetIds: [RECEIVE_KEYSET_ID],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        registeredAt: 10,
        keys: MINT_KEYS,
      },
    ],
  }
}

function keysetLookup() {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh' as const,
    regularKeysets: [
      {
        keysetId: OFFER_KEYSET_ID,
        unit: 'msat',
        active: true,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET_ID,
        unit: 'msat',
        active: true,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
  }
}

function signOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: {
        e: Buffer.from(dleq.e).toString('hex'),
        s: Buffer.from(dleq.s).toString('hex'),
      },
    },
    { id: output.blindedMessage.id, keys: MINT_KEYS },
  )
}

function mintKeysets(operation: DurableCtfRangeOperation) {
  return new Map<string, DurableCtfRangeMintKeyset>(
    [operation.keysetAuthority.offer, operation.keysetAuthority.receive].map((authority) => [
      authority.keysetId,
      {
        canonicalMintUrl: operation.mintUrl,
        id: authority.keysetId,
        unit: authority.unit,
        keys: MINT_KEYS,
        inputFeePpk: authority.inputFeePpk,
        finalExpiry: authority.finalExpiry,
      },
    ]),
  )
}

async function createRangeBinding(scope: DurableCustodyScope, operation: DurableCtfRangeOperation) {
  const keysets = mintKeysets(operation)
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: toDurableCtfRangeProofOperationInput(operation),
    resolveMintKeys: async () =>
      new Map(
        [...keysets].map(([id, keyset]) => [
          id,
          {
            id,
            unit: keyset.unit,
            keys: keyset.keys,
            final_expiry: keyset.finalExpiry ?? undefined,
          },
        ]),
      ),
    requireDleq: true,
  })
  return createDurableCtfRangeCustodyBinding({
    scope,
    operation,
    facts,
    mintKeysets: keysets,
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  })
}

function proofRow(
  scopeId: string,
  operation: DurableCtfRangeOperation,
  proof: DurableCtfRangeOperation['inputs'][number],
  proofId: string,
) {
  const row = createCustodyProofSqliteRow({
    scopeId,
    normalizedMint: operation.mintUrl,
    unit: operation.unit,
    proof,
    baseAsset: 'sat',
    conditionId: null,
    outcomeSetId: null,
    productBinding: null,
    signatureVerified: true,
    dleqState: proof.dleq === null ? 'not-present' : 'verified',
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    nowMs: 3,
  })
  assert.equal(row.proofId, proofId)
  return row
}

async function persistRangeBinding(
  directory: string,
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  observedAtMs: number,
  binding: Awaited<ReturnType<typeof createRangeBinding>>,
  injectFault?: (phase: 'transaction-opened' | 'before-commit' | 'after-commit') => void,
): Promise<void> {
  await withDurableCustodyUnitOfWork(
    directory,
    fence,
    observedAtMs,
    (database) => {
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        binding.record.scope.scopeId,
        observedAtMs,
      )
      applyDurableCustodyTransaction(
        transaction,
        {
          scope: binding.record.scope,
          owner: {
            incarnationId: fence.incarnationId,
            fencingEpoch: fence.fencingEpoch,
            observedAtMs,
          },
          operationRows: [
            { operationId: binding.record.operation.operationId, expectedRevision: null },
          ],
        },
        (selected) => bindDurableCustodyProofOperation(selected, binding.record, binding.artifacts),
      )
    },
    { injectFault },
  )
}

async function assertRolledBack(
  directory: string,
  scopeId: string,
  proofIds: readonly string[],
): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    for (const table of [
      'custody_operations',
      'custody_artifacts',
      'custody_operation_inputs',
      'custody_proof_reservations',
      'custody_active_work',
    ]) {
      const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number
      }
      assert.equal(row.count, 0, `${table} must not expose rolled-back range authority`)
    }
    const store = new DurableCustodySqliteStore(database)
    for (const proofId of proofIds) {
      const proof = store.getProof(scopeId, proofId)
      assert.equal(proof?.selectability, 'selectable')
      assert.equal(proof?.reservationOperationId, null)
    }
  } finally {
    database.close()
  }
}

async function seedInputProofs(
  directory: string,
  fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  operation: DurableCtfRangeOperation,
  binding: Awaited<ReturnType<typeof createRangeBinding>>,
): Promise<void> {
  await withDurableCustodyUnitOfWork(directory, fence, 2, (database) => {
    const store = new DurableCustodySqliteStore(database)
    binding.record.operation.reservation.inputs.forEach(({ proofId }, index) => {
      store.putProofCas(proofRow(fence.scopeId, operation, operation.inputs[index]!, proofId), null)
    })
  })
}

async function seedPreparedRangeSource(
  directory: string,
  operation: DurableCtfRangeOperation,
): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    const state = emptyDaemonState()
    const reservationId = sourceReservationId(operation)
    const proofs = operation.inputs.map(toCashuProofRecord)
    const now = new Date(2).toISOString()
    state.wallet.proofs = proofs.map((proof) => ({
      proof,
      mintUrl: operation.mintUrl,
      state: 'reserved',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      reservedBy: reservationId,
      createdAt: now,
      updatedAt: now,
    }))
    state.proofOperations[operation.sourceOperationId] = {
      operationId: operation.sourceOperationId,
      kind: 'wallet-send',
      state: 'completed',
      mintUrl: operation.mintUrl,
      inputs: proofs,
      outputs: {},
      metadata: {
        purpose: 'ctf-range-authorization-source',
        rangeOperationId: operation.operationId,
        reservationId,
        unit: operation.unit,
      },
      resultProofs: { authorization: proofs, keep: [] },
      lastError: null,
      createdAt: 2,
      updatedAt: 2,
    }
    writeDaemonStateToDatabase(database, state)
  } finally {
    database.close()
  }
}

function sourceReservationId(operation: DurableCtfRangeOperation): string {
  return `range-source:${operation.operationId}`
}

function toCashuProofRecord(proof: DurableCtfRangeOperation['inputs'][number]): CashuProofRecord {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null ? {} : { witness: structuredClone(proof.witness) }),
  }
}

function unspentProofStateClient() {
  return {
    check: async ({ Ys }: { Ys: string[] }) => ({
      states: Ys.map((Y) => ({ Y, state: 'UNSPENT' as const, witness: null })),
    }),
  }
}

function signaturesFor(operation: DurableCtfRangeOperation, selection: string) {
  const bitmap = Buffer.from(selection, 'hex')
  return operation.manifest.entries
    .filter((_, index) => (bitmap[index >> 3]! & (1 << (index & 7))) !== 0)
    .map(({ outputData }) => {
      const output = OutputData.deserialize(outputData)
      const signature = createBlindSignature(
        pointFromHex(output.blindedMessage.B_),
        MINT_PRIVATE_KEY,
        output.blindedMessage.id,
      )
      const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
      return {
        id: signature.id,
        amount: output.blindedMessage.amount,
        C_: signature.C_.toHex(true),
        dleq: {
          e: Buffer.from(dleq.e).toString('hex'),
          s: Buffer.from(dleq.s).toString('hex'),
        },
      }
    })
}

function recoveryFor(
  operation: DurableCtfRangeOperation,
  selection: string,
): DurableCtfRangeAllManifestRecovery {
  return {
    queriedOutputs: buildDurableCtfRangeRecoveryQuery(operation, null).outputs,
    restoredOutputs: buildDurableCtfRangeRecoveryQuery(operation, selection).outputs,
    signatures: signaturesFor(operation, selection),
    queryCompleted: true,
  }
}

function rangeKeysetResolver(operation: DurableCtfRangeOperation): DurableCtfRangeKeysetResolver {
  const keysets = new Set([
    operation.keysetAuthority.offer.keysetId,
    operation.keysetAuthority.receive.keysetId,
  ])
  return (mintUrl, keysetId) =>
    mintUrl === operation.mintUrl && keysets.has(keysetId)
      ? { id: keysetId, keys: MINT_KEYS }
      : undefined
}

async function readRangeLifecycleSnapshot(directory: string, scopeId: string, operationId: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    const operation = database
      .prepare(
        `SELECT revision, operation_state AS operationState,
           result_state AS resultState, result_handle AS resultHandle,
           result_artifact_id AS resultArtifactId,
           result_fingerprint AS resultFingerprint,
           successor_selection_staged AS successorSelectionStaged,
           updated_at_ms AS updatedAtMs
         FROM custody_operations
         WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(scopeId, operationId)
    const artifacts = database
      .prepare(
        `SELECT artifact_id AS artifactId, artifact_kind AS artifactKind,
           encoding, fingerprint, revision, private_material AS privateMaterial
         FROM custody_artifacts
         WHERE scope_id = ?
         ORDER BY artifact_id`,
      )
      .all(scopeId)
    const artifactLinks = database
      .prepare(
        `SELECT link_kind AS linkKind, position, artifact_id AS artifactId
         FROM custody_operation_artifact_links
         WHERE scope_id = ? AND operation_id = ?
         ORDER BY link_kind, position`,
      )
      .all(scopeId, operationId)
    const proofs = database
      .prepare(
        `SELECT proof_id AS proofId, revision, selectability,
           nut07_state AS nut07State,
           reservation_operation_id AS reservationOperationId,
           proof_fingerprint AS proofFingerprint,
           normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
           amount, condition_id AS conditionId, outcome_set_id AS outcomeSetId
         FROM custody_proofs
         WHERE scope_id = ?
         ORDER BY proof_id`,
      )
      .all(scopeId)
    const walletProofs = database
      .prepare(
        `SELECT proof_id AS proofId, state, reserved_by AS reservedBy,
           normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
           amount, asset_kind AS assetKind, condition_id AS conditionId,
           outcome_set_id AS outcomeSetId
         FROM target_wallet_proofs
         WHERE scope_id = ?
         ORDER BY proof_id`,
      )
      .all(scopeId)
    const lineage = database
      .prepare(
        `SELECT lineage_kind AS lineageKind, lineage_position AS lineagePosition,
           proof_id AS proofId
         FROM custody_proof_lineage
         WHERE scope_id = ? AND operation_id = ?
         ORDER BY lineage_kind, lineage_position`,
      )
      .all(scopeId, operationId)
    const selectedSuccessors = database
      .prepare(
        `SELECT proof_position AS proofPosition, proof_id AS proofId
         FROM custody_selected_successors
         WHERE scope_id = ? AND operation_id = ?
         ORDER BY proof_position`,
      )
      .all(scopeId, operationId)
    const successorAdmissions = database
      .prepare(
        `SELECT admission_id AS admissionId
         FROM custody_successor_admissions
         WHERE scope_id = ? AND operation_id = ?`,
      )
      .all(scopeId, operationId)
    const admittedProofs = database
      .prepare(
        `SELECT proof_position AS proofPosition, proof_id AS proofId,
           expected_revision AS expectedRevision, admitted_revision AS admittedRevision
         FROM custody_successor_admission_proofs
         WHERE scope_id = ? AND operation_id = ?
         ORDER BY proof_position`,
      )
      .all(scopeId, operationId)
    const reservations = database
      .prepare(
        `SELECT proof_id AS proofId, reservation_id AS reservationId,
           input_position AS inputPosition
         FROM custody_proof_reservations
         WHERE scope_id = ? AND operation_id = ?
         ORDER BY input_position`,
      )
      .all(scopeId, operationId)
    return {
      operation,
      artifacts,
      artifactLinks,
      proofs,
      walletProofs,
      lineage,
      selectedSuccessors,
      successorAdmissions,
      admittedProofs,
      reservations,
    }
  } finally {
    database.close()
  }
}

async function readDatabaseFingerprint(directory: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as { name: string }[]
    return tables.map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    }))
  } finally {
    database.close()
  }
}
