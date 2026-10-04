import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  MintOperationError,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import { deriveDlcConditionId } from '@bitcaster-market/client-sdk/managedConditionInventory'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { createDurableCustodyProofMaterialRecord } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import { DurableWalletProofImportCoordinator } from '../src/durableWalletProofImportCoordinator.ts'
import { claimDaemonPosition } from '../src/nativePositionClaim.ts'
import {
  buildKeysetRedeemOperationId,
  redeemOutcomeLegWithOperation,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import { deriveDurableCustodyOperationId } from '@bitcaster-market/client-sdk/durableCustody'
import { previewDaemonPositionRemove, removeDaemonPosition } from '../src/nativePositionRemove.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { readProfile } from '../src/profile.ts'
import { openDaemonStateSqlite, type StateSqliteFaultPhase } from '../src/stateSqlite.ts'
import { readWalletBalanceFromDatabase } from '../src/walletBalance.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { dispatch } from '../src/server.ts'
import { buildDaemonAssetMonitoringHoldings } from '../src/assetMonitoring.ts'
import { subscribeToDaemonWalletHoldingsCommits } from '../src/stateSqlite.ts'
import { createDurableCustodyConformancePrepared } from '../../bitcaster-client-sdk/test/support/durableCustodyAdapterConformance.ts'
import {
  addAvailableProofs,
  emptyDaemonState,
  readState,
  writeState,
  getProofOperation,
  prepareProofOperationWithExactReservation,
  failPositionClaimRedeemFenced,
} from '../src/state.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

test('Remove keeps raw proofs, exact journals and immutable markers through retry, save and reimport', async () => {
  const fixture = await createFixture(3)
  try {
    const canonicalDatabase = await openDaemonStateSqlite(fixture.directory)
    new DurableCustodySqliteStore(canonicalDatabase).putProofCas(fixture.canonicalRow(), null)
    canonicalDatabase.close()
    const before = await readState()
    const preview = await previewDaemonPositionRemove(fixture.context)
    assert.equal(preview.targets.length, 3)
    assert.equal(JSON.stringify(preview).includes('losing-secret'), false)
    const result = await removeDaemonPosition({ ...fixture.context, preview, acknowledge: true })
    assert.equal(result.retiredProofCount, 3)
    assert.equal(result.moreProofsRemain, false)
    const after = await readState()
    assert.equal(after.wallet.proofs.length, before.wallet.proofs.length)
    assert.equal(isDeepStrictEqual(after.proofOperations, before.proofOperations), true)
    assert.equal(after.wallet.proofs.filter((proof) => proof.retirement !== undefined).length, 3)
    assert.equal(
      isDeepStrictEqual(
        after.wallet.proofs.map((proof) => proof.proof),
        before.wallet.proofs.map((proof) => proof.proof),
      ),
      true,
    )
    await writeState(after)
    assert.equal(isDeepStrictEqual(await readState(), after), true)
    await assert.rejects(writeState(before), /retired custody history/)
    const altered = structuredClone(after)
    delete altered.proofOperations[preview.targets[0]!.operationId]
    await assert.rejects(writeState(altered), /retired custody history/)
    await addAvailableProofs(fixture.context.profile.mintUrl, fixture.proofs, fixture.asset)
    assert.equal((await readState()).wallet.proofs.length, after.wallet.proofs.length)
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const balance = readWalletBalanceFromDatabase(database)
      assert.equal(balance.outcomePositions.length, 1)
      assert.equal(balance.outcomePositions[0]?.outcomeSetId, 'YES')
      const holdings = await buildDaemonAssetMonitoringHoldings(
        async (action) => action(database),
        {
          scopeId: fixture.context.fence.scopeId,
          engineBaseUrl: 'https://engine.example',
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                markets: [{ conditionId: fixture.asset.conditionId, outcomes: ['YES', 'NO'] }],
              }),
            ),
        },
      )
      assert.equal(holdings?.length, 1)
      const material = fixture.canonicalRow()
      assert.throws(
        () => new DurableCustodySqliteStore(database).putProofCas(material, null),
        /permanently retired/,
      )
      assert.throws(
        () =>
          new DurableCustodyTransactionSqlite(
            database,
            fixture.context.fence.scopeId,
            Date.now(),
          ).reserveExactInputs({
            operationId: 'not-created',
            expectedRevision: 0,
            reservationId: 'not-created',
            proofIds: [material.proofId],
          }),
        /permanently retired/,
      )
    } finally {
      database.close()
    }
    await removeDaemonPosition({ ...fixture.context, preview, acknowledge: true })
    assert.equal((await previewDaemonPositionRemove(fixture.context)).targets.length, 0)
    assert.equal(isDeepStrictEqual((await readState()).wallet.proofs, after.wallet.proofs), true)
  } finally {
    await fixture.dispose()
  }
})

for (const recovery of ['active', 'retry'] as const) {
  test(`canonical pending ${recovery} recovery dependency refuses an otherwise unchanged exact batch`, async () => {
    const fixture = await createFixture(1)
    try {
      const database = await openDaemonStateSqlite(fixture.directory)
      const row = fixture.canonicalRow()
      const store = new DurableCustodySqliteStore(database)
      store.putProofCas(row, null)
      database.close()
      const preview = await previewDaemonPositionRemove(fixture.context)
      const reopened = await openDaemonStateSqlite(fixture.directory)
      try {
        const prepared = createDurableCustodyConformancePrepared(
          {
            scopeKind: 'wallet',
            scopeId: fixture.context.fence.scopeId,
            walletId: fixture.context.fence.scopeId.slice(15),
          },
          'remove-dependent',
        )
        const record = prepared.record
        record.operation.reservation.inputs[0]!.proofId = row.proofId
        record.operation.proofStorage.lineage.predecessorProofIds = [row.proofId]
        record.operation.exactRequest.inputProofIds = [row.proofId]
        const dependentStore = new DurableCustodySqliteStore(reopened)
        reopened.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON')
        dependentStore.putOperation({ record, expectedRevision: null, createdAtMs: 2 })
        const artifacts = [
          [record.operation.exactRequest.body, prepared.artifacts.requestBody],
          [record.operation.outputPlan.exactOutput, prepared.artifacts.output],
          [
            record.operation.privateMaterial.exactPrivateMaterial,
            prepared.artifacts.privateMaterial,
          ],
        ] as const
        for (const [reference, artifact] of artifacts)
          dependentStore.putArtifact({
            scopeId: fixture.context.fence.scopeId,
            operationId: record.operation.operationId,
            expectedOperationRevision: 0,
            expectedArtifactRevision: null,
            reference,
            artifact,
            createdAtMs: 2,
          })
        if (recovery === 'retry') {
          const now = Date.now()
          new DurableCustodyTransactionSqlite(reopened, fixture.context.fence.scopeId, now, [
            record,
          ]).transitionOperation({
            operationId: record.operation.operationId,
            expectedRevision: record.revision,
            transition: {
              kind: 'schedule-retry',
              expectedRevision: record.revision,
              authorization: {
                incarnationId: fixture.context.fence.incarnationId,
                fencingEpoch: fixture.context.fence.fencingEpoch,
                observedAtMs: now,
              },
              reason: 'mint-response-unknown',
              nextAttemptAtMs: now + 1000,
            },
          })
        }
        reopened
          .prepare(
            'INSERT INTO custody_active_work (scope_id, operation_id, next_attempt_at_ms, estimated_bytes) VALUES (?, ?, 0, 1)',
          )
          .run(fixture.context.fence.scopeId, record.operation.operationId)
        reopened.exec('COMMIT')
      } finally {
        reopened.close()
      }
      await assert.rejects(
        removeDaemonPosition({ ...fixture.context, preview, acknowledge: true }),
        /dependent custody work/,
      )
      assert.equal(
        (await readState()).wallet.proofs.some((proof) => proof.retirement !== undefined),
        false,
      )
    } finally {
      await fixture.dispose()
    }
  })
}

test('monitoring commit notification failure cannot block local retirement', async () => {
  const fixture = await createFixture(1)
  let notifications = 0
  const unsubscribe = subscribeToDaemonWalletHoldingsCommits(fixture.directory, () => {
    notifications++
    throw new Error('monitoring unavailable')
  })
  try {
    const preview = await previewDaemonPositionRemove(fixture.context)
    const result = await removeDaemonPosition({ ...fixture.context, preview, acknowledge: true })
    assert.equal(result.state, 'completed')
    assert.equal(notifications, 1)
  } finally {
    unsubscribe()
    await fixture.dispose()
  }
})

test('more than 256 proofs retire through fresh bounded previews and replay never selects later proofs', async () => {
  const fixture = await createFixture(260)
  try {
    const first = await previewDaemonPositionRemove(fixture.context)
    assert.equal(first.targets.length, 256)
    assert.equal(first.moreProofsRemain, true)
    const result = await removeDaemonPosition({
      ...fixture.context,
      preview: first,
      acknowledge: true,
    })
    assert.equal(result.moreProofsRemain, true)
    await removeDaemonPosition({ ...fixture.context, preview: first, acknowledge: true })
    assert.equal(
      (await readState()).wallet.proofs.filter((proof) => proof.retirement !== undefined).length,
      256,
    )
    const next = await previewDaemonPositionRemove(fixture.context)
    assert.equal(next.targets.length, 4)
    await removeDaemonPosition({ ...fixture.context, preview: next, acknowledge: true })
    assert.equal(
      (await readState()).wallet.proofs.filter((proof) => proof.retirement !== undefined).length,
      260,
    )
  } finally {
    await fixture.dispose()
  }
})

test('byte budget shortens a batch before oversized artifacts are loaded', async () => {
  const fixture = await createFixture(180, 12_000)
  try {
    const preview = await previewDaemonPositionRemove(fixture.context)
    assert.ok(preview.targets.length > 0 && preview.targets.length < 180)
    assert.equal(preview.moreProofsRemain, true)
    await removeDaemonPosition({ ...fixture.context, preview, acknowledge: true })
    const next = await previewDaemonPositionRemove(fixture.context)
    assert.ok(next.targets.length > 0)
    assert.equal(
      next.targets.some((target) =>
        preview.targets.some((retired) => retired.proofId === target.proofId),
      ),
      false,
    )
  } finally {
    await fixture.dispose()
  }
})

for (const change of [
  'proof',
  'reservation',
  'operation',
  'canonical',
  'readiness',
  'fence',
  'fault',
] as const) {
  test(`changed ${change} refuses the complete acknowledged batch without retirement`, async () => {
    const fixture = await createFixture(2)
    try {
      const preview = await previewDaemonPositionRemove(fixture.context)
      if (change === 'readiness') fixture.context.isCustodyReady = () => false
      else if (change === 'fence')
        await claimCustodyScopeLease(fixture.directory, {
          scopeId: fixture.context.fence.scopeId,
          incarnationId: 'replacement-owner',
          observedAtMs: fixture.context.fence.leaseExpiresAtMs + 1,
        })
      else if (change !== 'fault') {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          if (change === 'proof')
            database
              .prepare('UPDATE target_wallet_proofs SET amount = amount + 1 WHERE proof_id = ?')
              .run(preview.targets[0]!.proofId)
          if (change === 'reservation')
            database
              .prepare(
                "UPDATE target_wallet_proofs SET state = 'reserved', reserved_by = 'foreign' WHERE proof_id = ?",
              )
              .run(preview.targets[0]!.proofId)
          if (change === 'operation')
            database
              .prepare(
                'UPDATE target_proof_operations SET failure_code = NULL WHERE operation_id = ?',
              )
              .run(preview.targets[0]!.operationId)
          if (change === 'canonical')
            new DurableCustodySqliteStore(database).putProofCas(fixture.canonicalRow(), null)
        } finally {
          database.close()
        }
      }
      await assert.rejects(
        removeDaemonPosition({
          ...fixture.context,
          preview,
          acknowledge: true,
          ...(change === 'fault'
            ? {
                transactionOptions: {
                  injectFault: (phase: string) => {
                    if (phase === 'before-commit') throw new Error('injected precommit failure')
                  },
                },
              }
            : {}),
        }),
      )
      assert.equal(
        (await readState()).wallet.proofs.some((proof) => proof.retirement !== undefined),
        false,
      )
    } finally {
      await fixture.dispose()
    }
  })
}

for (const state of ['text-error', 'pending', 'wrong-asset'] as const) {
  test(`Remove refuses ${state} without verified exact losing authority`, async () => {
    const fixture = await createFixture(1)
    try {
      const database = await openDaemonStateSqlite(fixture.directory)
      try {
        if (state === 'text-error')
          database
            .prepare(
              "UPDATE target_proof_operations SET failure_code = NULL, last_error = '13015 losing text only'",
            )
            .run()
        if (state === 'pending')
          database
            .prepare(
              "UPDATE target_proof_operations SET failure_code = NULL, last_error = NULL, state = 'prepared'",
            )
            .run()
      } finally {
        database.close()
      }
      if (state === 'wrong-asset') {
        const current = await readState()
        const operation = Object.values(current.proofOperations)[0]!
        operation.metadata.outcomeSetId = 'YES'
        await writeState(current)
      }
      await assert.rejects(previewDaemonPositionRemove(fixture.context))
      assert.equal(
        (await readState()).wallet.proofs.some((proof) => proof.retirement !== undefined),
        false,
      )
    } finally {
      await fixture.dispose()
    }
  })
}

test('Remove dispatch needs readiness and acknowledgement, and privacy uses no engine or mint client', async () => {
  const fixture = await createFixture(1)
  try {
    const deps = {
      getCustodyFence: () => fixture.context.fence,
      isCustodyReady: () => true,
      createEngineClient: () => {
        throw new Error('monitoring/engine I/O forbidden')
      },
      createCashuWallet: () => {
        throw new Error('mint I/O forbidden')
      },
    }
    const preview = await dispatch(
      { method: 'wallet.removePreview', params: fixture.context },
      deps as never,
    )
    assert.equal(preview.ok, true)
    const refused = await dispatch(
      {
        method: 'wallet.removePosition',
        params: { preview: preview.result, acknowledge: false },
      } as never,
      deps as never,
    )
    assert.equal(refused.ok, false)
    assert.equal(
      (
        await dispatch(
          {
            method: 'wallet.removePosition',
            params: { preview: preview.result, acknowledge: true },
          } as never,
          { ...deps, isCustodyReady: () => false } as never,
        )
      ).code,
      'custody-recovery-pending',
    )
    const extra = {
      ...(preview.result as object),
      profile: { mintUrl: 'https://foreign.example' },
      fence: { scopeId: 'foreign' },
      isCustodyReady: false,
      batchDigest: '',
    }
    extra.batchDigest = createHash('sha256').update(JSON.stringify(extra)).digest('hex')
    const result = await dispatch(
      {
        method: 'wallet.removePosition',
        params: {
          preview: extra,
          acknowledge: true,
          profile: { mintUrl: 'https://foreign.example' },
          fence: { scopeId: 'foreign' },
          isCustodyReady: false,
        },
      } as never,
      deps as never,
    )
    assert.equal(result.ok, true)
  } finally {
    await fixture.dispose()
  }
})

for (const canonical of [false, true]) {
  test(`JSON transport preserves acknowledged exact Remove dispatch with canonical row ${canonical}`, async () => {
    const fixture = await createFixture(2)
    try {
      if (canonical) {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          new DurableCustodySqliteStore(database).putProofCas(fixture.canonicalRow(), null)
        } finally {
          database.close()
        }
      }
      const deps = {
        getCustodyFence: () => fixture.context.fence,
        isCustodyReady: () => true,
        createEngineClient: () => {
          throw new Error('engine transport forbidden')
        },
        createCashuWallet: () => {
          throw new Error('mint transport forbidden')
        },
      }
      const preview = await dispatch(
        {
          method: 'wallet.removePreview',
          params: {
            conditionId: fixture.asset.conditionId,
            outcomeCollection: fixture.asset.outcomeSetId,
          },
        },
        deps as never,
      )
      assert.equal(preview.ok, true, 'the exact local preview must succeed')
      const envelope = JSON.parse(JSON.stringify(preview, null, 2))
      assert.equal(
        isDeepStrictEqual(envelope.result, preview.result),
        true,
        'JSON transport must preserve the exact preview',
      )
      const command = JSON.parse(
        JSON.stringify({
          method: 'wallet.removePosition',
          params: { preview: envelope.result, acknowledge: true },
        }),
      )
      const before = await readState()
      assert.ok(before, 'the initialized fixture state must exist')
      const result = await dispatch(command, deps as never)
      assert.equal(
        result.ok,
        true,
        'the acknowledged JSON preview must retire its exact losing batch',
      )
      assert.equal((result.result as { retiredProofCount: number }).retiredProofCount, 2)
      const after = await readState()
      assert.ok(after, 'the committed fixture state must exist')
      assert.equal(after.wallet.proofs.filter((proof) => proof.retirement !== undefined).length, 2)
      assert.equal(
        isDeepStrictEqual(after.proofOperations, before.proofOperations),
        true,
        'retirement must preserve terminal operation authority',
      )
      assert.equal(
        isDeepStrictEqual(
          after.wallet.proofs.map((proof) => proof.proof),
          before.wallet.proofs.map((proof) => proof.proof),
        ),
        true,
        'retirement must preserve raw proof history',
      )
      const replay = await dispatch(JSON.parse(JSON.stringify(command)), deps as never)
      assert.equal(
        isDeepStrictEqual(replay, result),
        true,
        'the same transported preview must replay exactly',
      )
    } finally {
      await fixture.dispose()
    }
  })
}

for (const fault of [undefined, 'before-commit', 'after-commit'] as const) {
  test(`completed conditional import ${fault ?? 'commit'} and losing claim allow exact JSON Remove without erasing history`, async () => {
    const fixture = await createFixture(2, 0, true, fault)
    try {
      const database = await openDaemonStateSqlite(fixture.directory)
      try {
        const source = database
          .prepare(
            "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'generic-receive'",
          )
          .get()!
        const record = new DurableCustodySqliteStore(database).getOperation(
          String(source.operation_id),
        )!
        assert.equal(record.operation.state, 'reconciled')
        assert.equal(record.operation.result.state, 'applied')
        assert.equal(record.operation.reservation.inputs.length, 0)
        assert.equal(record.operation.delivery.deliveryKind, 'none')
        assert.equal(record.operation.proofStorage.lineage.successorProofIds.length, 2)
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM custody_active_work').get()!.count,
          0,
          'completed import must not retain an active recovery index',
        )
        assert.equal(
          record.operation.proofStorage.pinReasons.includes('active-reservation'),
          false,
          'completed import must release only its active reservation pin',
        )
      } finally {
        database.close()
      }
      const deps = {
        getCustodyFence: () => fixture.context.fence,
        isCustodyReady: () => true,
        createEngineClient: () => {
          throw new Error('engine transport forbidden')
        },
        createCashuWallet: () => {
          throw new Error('mint transport forbidden')
        },
      }
      const before = await readState()
      assert.ok(before)
      const preview = await dispatch(
        JSON.parse(
          JSON.stringify({
            method: 'wallet.removePreview',
            params: {
              conditionId: fixture.asset.conditionId,
              outcomeCollection: fixture.asset.outcomeSetId,
            },
          }),
        ),
        deps as never,
      )
      assert.equal(preview.ok, true, 'completed import lineage must allow a losing preview')
      assert.equal(
        (preview.result as { targets: unknown[] }).targets.length,
        2,
        'exact losing imported proofs must appear in preview',
      )
      const request = JSON.parse(
        JSON.stringify({
          method: 'wallet.removePosition',
          params: { preview: preview.result, acknowledge: true },
        }),
      )
      const removed = await dispatch(request, deps as never)
      assert.equal(removed.ok, true)
      assert.equal((removed.result as { retiredProofCount: number }).retiredProofCount, 2)
      const after = await readState()
      assert.ok(after)
      assert.equal(
        isDeepStrictEqual(after.proofOperations, before.proofOperations),
        true,
        'claim journals must remain exact',
      )
      assert.equal(
        isDeepStrictEqual(
          after.wallet.proofs.map(({ proof }) => proof),
          before.wallet.proofs.map(({ proof }) => proof),
        ),
        true,
        'raw proof bodies must remain exact',
      )
      assert.equal(
        after.wallet.proofs.filter(({ retirement }) => retirement !== undefined).length,
        2,
      )
      const reopened = await openDaemonStateSqlite(fixture.directory)
      reopened.close()
      assert.equal(
        isDeepStrictEqual(
          await dispatch(JSON.parse(JSON.stringify(request)), deps as never),
          removed,
        ),
        true,
        'reopened exact Remove must replay',
      )
      assert.equal(
        isDeepStrictEqual(await readState(), after),
        true,
        'reopen must retain retirement and history',
      )
    } finally {
      await fixture.dispose()
    }
  })
}

test('completed conditional import with a genuine pending outbox still refuses losing Remove', async () => {
  const fixture = await createFixture(1, 0, true)
  try {
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const source = database
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'generic-receive'",
        )
        .get()!
      const operation = new DurableCustodySqliteStore(database).getOperation(
        String(source.operation_id),
      )!
      const payload = {
        encoding: 'canonical-json' as const,
        artifact: { synthetic: 'delivery' },
        fingerprint: createHash('sha256')
          .update(JSON.stringify({ synthetic: 'delivery' }))
          .digest('hex'),
      }
      const now = Date.now()
      database.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON')
      new DurableCustodyTransactionSqlite(database, fixture.context.fence.scopeId, now, [
        operation,
      ]).transitionOperation({
        operationId: operation.operation.operationId,
        expectedRevision: operation.revision,
        transition: {
          kind: 'stage-outbox',
          expectedRevision: operation.revision,
          authorization: {
            incarnationId: fixture.context.fence.incarnationId,
            fencingEpoch: fixture.context.fence.fencingEpoch,
            observedAtMs: now,
          },
          deliveryId: 'remove-pending-delivery',
          expiresAtMs: null,
          exactPayload: payload,
        },
      })
      database.exec('COMMIT')
    } finally {
      database.close()
    }
    const before = await readState()
    await assert.rejects(previewDaemonPositionRemove(fixture.context), /dependent custody work/)
    assert.equal(
      isDeepStrictEqual(await readState(), before),
      true,
      'pending delivery must leave proof and claim authority exact',
    )
  } finally {
    await fixture.dispose()
  }
})

async function createFixture(
  count: number,
  extraBytes = 0,
  imported = false,
  importFault?: StateSqliteFaultPhase,
) {
  const directory = await mkdtemp(join(tmpdir(), 'native-remove-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = '11'.repeat(64)
  const bootstrap = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: seed,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: bootstrap.walletScopeId,
    incarnationId: 'position-remove-fixture-owner',
    observedAtMs: Date.now(),
  })
  const privateKey = Uint8Array.from([...new Uint8Array(31), 1])
  const publicKey = bytesToHex(schnorr.getPublicKey(privateKey))
  const tag = sha256(utf8ToBytes('DLC/oracle/attestation/v0'))
  const signature = bytesToHex(
    schnorr.sign(sha256(concatBytes(tag, tag, utf8ToBytes('YES'))), privateKey, new Uint8Array(32)),
  )
  const conditionId = deriveDlcConditionId({
    eventId: 'remove-fixture',
    outcomeCount: 2,
    oraclePublicKeys: [publicKey],
  })
  const key = bytesToHex(secp256k1.getPublicKey(privateKey, true))
  const keys = Object.fromEntries(Array.from({ length: 13 }, (_, power) => [2 ** power, key]))
  const regularId = deriveKeysetId(keys, { unit: 'msat', versionByte: 1, input_fee_ppk: 0 })
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId,
    outcomeCollection: 'NO',
  })
  const id = imported
    ? deriveConditionalKeysetId({ keys, unit: 'msat', conditionId, outcomeCollectionId })
    : canonicalTestKeysetId('remove-conditional')
  const conditionalIds =
    extraBytes === 0
      ? [id]
      : Array.from({ length: count }, (_, index) =>
          canonicalTestKeysetId(`remove-large-proof-${index}`),
        )
  const keyset = (keysetId: string) => ({
    id: keysetId,
    unit: 'msat',
    active: true,
    input_fee_ppk: 0,
    keys,
  })
  const asset = {
    kind: 'Outcome' as const,
    conditionId,
    outcomeSetId: 'NO',
    baseAsset: 'sat' as const,
    unit: 'msat' as const,
  }
  const proofs = Array.from({ length: count }, (_, index) => {
    const secret = `losing-secret-${index}`
    if (imported) {
      const output = OutputData.createSingleData(8, id, secret, BigInt(index + 1))
      const signature = createBlindSignature(pointFromHex(output.blindedMessage.B_), privateKey, id)
      const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey)
      const proof = output.toProof(
        {
          id,
          amount: output.blindedMessage.amount,
          C_: signature.C_.toHex(true),
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        },
        { id, keys },
      )
      return { ...proof, amount: 8 }
    }
    return {
      id: conditionalIds[extraBytes === 0 ? 0 : index]!,
      secret,
      amount: 8,
      C: hashToCurve(utf8ToBytes(secret)).toHex(true),
      ...(extraBytes === 0 ? {} : { witness: 'x'.repeat(extraBytes) }),
    }
  })
  if (imported) {
    await writeState(emptyDaemonState())
    let commits = 0
    const importInput = {
      mintUrl: 'https://mint.example',
      asset,
      proofs: proofs as unknown as Proof[],
      keysets: [
        {
          canonicalMintUrl: 'https://mint.example',
          id,
          unit: 'msat' as const,
          keys,
          inputFeePpk: 0,
          finalExpiry: null,
          identity: {
            kind: 'conditional' as const,
            conditionId,
            outcomeCollection: 'NO',
            outcomeCollectionId,
          },
        },
      ],
      checkProofsStates: async (items: readonly Pick<Proof, 'id' | 'secret'>[]) =>
        items.map(({ secret }) => ({
          Y: hashToCurve(utf8ToBytes(secret)).toHex(true),
          state: CheckStateEnum.UNSPENT,
          witness: null,
        })),
    }
    const importAttempt = new DurableWalletProofImportCoordinator(
      directory,
      () => fence,
      Date.now,
      importFault === undefined
        ? undefined
        : (phase) => {
            if (phase === importFault && ++commits === 4)
              throw new Error('injected import apply boundary')
          },
    )
    if (importFault === undefined) await importAttempt.importOutcomeProofs(importInput)
    else {
      await assert.rejects(
        importAttempt.importOutcomeProofs(importInput),
        /injected import apply boundary/,
      )
      const reopened = await openDaemonStateSqlite(directory)
      try {
        const source = reopened
          .prepare(
            "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'generic-receive'",
          )
          .get()!
        const record = new DurableCustodySqliteStore(reopened).getOperation(
          String(source.operation_id),
        )!
        const committed = importFault === 'after-commit'
        assert.equal(record.operation.result.state, committed ? 'applied' : 'verified-staged')
        assert.deepEqual(
          record.operation.proofStorage.pinReasons,
          committed ? [] : ['active-reservation'],
        )
        assert.equal(
          reopened.prepare('SELECT count(*) AS count FROM custody_active_work').get()!.count,
          committed ? 0 : 1,
        )
        assert.equal(
          reopened.prepare('SELECT count(*) AS count FROM custody_proofs').get()!.count,
          committed ? count : 0,
        )
        assert.equal(
          reopened.prepare('SELECT count(*) AS count FROM target_wallet_proofs').get()!.count,
          committed ? count : 0,
        )
      } finally {
        reopened.close()
      }
      await new DurableWalletProofImportCoordinator(directory, () => fence).importOutcomeProofs(
        importInput,
      )
    }
    const sourceDatabase = await openDaemonStateSqlite(directory)
    const authorityBefore = sourceDatabase.prepare('SELECT * FROM custody_operations').all()
    const proofsBefore = sourceDatabase.prepare('SELECT * FROM custody_proofs').all()
    const artifactsBefore = sourceDatabase.prepare('SELECT * FROM custody_artifacts').all()
    sourceDatabase.close()
    await new DurableWalletProofImportCoordinator(directory, () => fence).importOutcomeProofs({
      ...importInput,
      checkProofsStates: async () => {
        throw new Error('completed import replay mint I/O forbidden')
      },
    })
    const replayDatabase = await openDaemonStateSqlite(directory)
    try {
      assert.equal(
        isDeepStrictEqual(
          replayDatabase.prepare('SELECT * FROM custody_operations').all(),
          authorityBefore,
        ),
        true,
        'completed replay must preserve operation revision and pins',
      )
      assert.equal(
        isDeepStrictEqual(
          replayDatabase.prepare('SELECT * FROM custody_proofs').all(),
          proofsBefore,
        ),
        true,
        'completed replay must preserve canonical proof rows',
      )
      assert.equal(
        isDeepStrictEqual(
          replayDatabase.prepare('SELECT * FROM custody_artifacts').all(),
          artifactsBefore,
        ),
        true,
        'completed replay must preserve exact artifacts',
      )
    } finally {
      replayDatabase.close()
    }
  } else await addAvailableProofs('https://mint.example', proofs, asset)
  await addAvailableProofs(
    'https://mint.example',
    [
      {
        ...proofs[0]!,
        secret: 'sibling-secret',
        C: hashToCurve(utf8ToBytes('sibling-secret')).toHex(true),
      },
    ],
    { ...asset, outcomeSetId: 'YES' },
  )
  if (imported)
    assert.equal(
      (await readState())!.wallet.proofs.filter(
        ({ asset: held }) => held.kind === 'Outcome' && held.outcomeSetId === 'NO',
      ).length,
      count,
      'conditional import must remain native before claim',
    )
  const profile = (await readProfile())!
  const claimInput = {
    profile,
    fence,
    conditionId,
    outcomeCollection: 'NO',
    secrets: { walletSeedHex: seed },
    walletDependencies: {
      createCashuWallet: () =>
        ({
          loadMint: async () => {},
          mint: {
            getKeySets: async () => ({
              keysets: [keyset(regularId), ...conditionalIds.map(keyset)],
            }),
            getKeys: async (requested = regularId) => ({ keysets: [keyset(requested)] }),
          },
          redeemOutcomeProofs: async () => {
            throw new MintOperationError(13015, 'verified losing outcome')
          },
          checkProofsStates: async (inputs: Proof[]) =>
            inputs.map((proof) => ({
              Y: hashToCurve(utf8ToBytes(proof.secret)).toHex(true),
              state: 'UNSPENT',
              witness: null,
            })),
        }) as never,
    },
    engine: {
      getConditionAttestation: async () => ({
        conditionId,
        attestedOutcome: 'YES',
        oracleWitness: {
          oracle_sigs: [{ oracle_pubkey: publicKey, oracle_sig: signature, outcome: 'YES' }],
        },
        registeredAuthority: {
          eventId: 'remove-fixture',
          outcomes: ['YES', 'NO'],
          threshold: 1,
          oracles: [
            {
              oraclePublicKey: publicKey,
              noncePoint: signature.slice(0, 64),
              announcementIdentity: '44'.repeat(32),
            },
          ],
        },
      }),
    },
  }
  // Artificial target-only rows exercise Remove guards, not native Claim admission.
  // The imported cases below use the complete production Claim boundary.
  const claim = imported
    ? await claimDaemonPosition(claimInput)
    : await seedLosingRemoveGuardAuthority(claimInput, proofs as unknown as Proof[])
  if (imported) {
    assert.equal(claim.legs.length, 1, 'real losing claim must select the imported keyset')
    assert.equal(
      claim.legs[0]!.state,
      'losing',
      'exact mint rejection must retain the losing input',
    )
    assert.equal(
      (await readState())!.wallet.proofs.filter(
        ({ asset: held }) => held.kind === 'Outcome' && held.outcomeSetId === 'NO',
      ).length,
      count,
      'losing claim must retain the imported native rows',
    )
  }
  return {
    directory,
    proofs,
    asset,
    context: { profile, fence, conditionId, outcomeCollection: 'NO', isCustodyReady: () => true },
    canonicalRow: () => {
      const material = createDurableCustodyProofMaterialRecord({
        scopeId: fence.scopeId,
        normalizedMint: profile.mintUrl,
        unit: 'msat',
        proof: { ...proofs[0]!, dleq: null, p2pkE: null, witness: null },
      })
      return {
        scopeId: fence.scopeId,
        proofId: material.proofId,
        normalizedMint: profile.mintUrl,
        unit: 'msat' as const,
        keysetId: id,
        amount: 8,
        baseAsset: 'sat' as const,
        conditionId,
        outcomeSetId: 'NO',
        productBinding: null,
        proofBody: material.proofBody,
        proofFingerprint: material.proofFingerprint,
        curve: 'secp256k1' as const,
        signatureVerified: true,
        dleqState: 'not-present' as const,
        nut07State: 'UNSPENT' as const,
        selectability: 'selectable' as const,
        storageClass: 'terminal-replay-retained' as const,
        reservationOperationId: null,
        revision: 0,
        createdAtMs: 1,
        updatedAtMs: 1,
      }
    },
    dispose: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function seedLosingRemoveGuardAuthority(
  input: Parameters<typeof claimDaemonPosition>[0],
  proofs: Proof[],
) {
  const wallet = input.walletDependencies!.createCashuWallet!(
    input.profile.mintUrl,
    'msat',
  ) as unknown as RedeemWallet
  const response = await input.engine.getConditionAttestation(input.conditionId)
  assert.notEqual(response, null)
  const legs: Awaited<ReturnType<typeof claimDaemonPosition>>['legs'] = []
  for (const keysetId of new Set(proofs.map(({ id }) => id))) {
    const selected = proofs.filter(({ id }) => id === keysetId)
    for (let offset = 0; offset < selected.length; offset += 64) {
      const inputs = selected.slice(offset, offset + 64)
      const retainedOperationKey = buildKeysetRedeemOperationId({
        mintUrl: input.profile.mintUrl,
        unit: 'msat',
        conditionId: input.conditionId,
        keysetId,
        proofs: inputs,
      })
      const operationId = deriveDurableCustodyOperationId(input.fence.scopeId, {
        retainedOperationKey,
        binding: { kind: 'wallet', activityId: retainedOperationKey, stage: 'ctf-redeem' },
      })
      const asset = {
        kind: 'Outcome' as const,
        conditionId: input.conditionId,
        outcomeSetId: input.outcomeCollection,
        baseAsset: 'sat' as const,
        unit: 'msat' as const,
      }
      const mutation = { fence: input.fence, observedAtMs: Date.now() }
      await redeemOutcomeLegWithOperation({
        mintUrl: input.profile.mintUrl,
        operationId,
        wallet,
        conditionId: input.conditionId,
        outcomeSetId: input.outcomeCollection,
        outcomeKeysetId: keysetId,
        outcome: 'YES',
        unit: 'msat',
        proofs: inputs,
        oracleWitness: JSON.stringify(response!.oracleWitness),
        proofOperationStore: {
          getProofOperation: async (id) => (await getProofOperation(id)) as never,
          prepareProofOperation: async (operation) =>
            (await prepareProofOperationWithExactReservation(
              {
                ...operation,
                reservationId: operationId,
                asset,
                metadata: {
                  ...operation.metadata,
                  purpose: 'position-claim',
                  reservationId: operationId,
                  inputAsset: asset,
                  successorAssets: { regular: { kind: 'sats', baseAsset: 'sat', unit: 'msat' } },
                },
              },
              mutation,
            )) as never,
          markProofOperationCompleted: async () => {
            throw new Error('Remove guard fixture must not credit a payout')
          },
          markProofOperationFailed: async (id, message, evidence) =>
            (await failPositionClaimRedeemFenced(id, message, evidence!, mutation)) as never,
        },
      })
      legs.push({ operationId, keysetId, state: 'losing', payoutAmountSubunits: 0 })
    }
  }
  return { conditionId: input.conditionId, outcomeCollection: input.outcomeCollection, legs }
}
