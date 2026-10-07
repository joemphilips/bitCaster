import {
  prepareDurableCustodyExactArtifact,
  deriveDurableCustodyScopeId,
  readPreparedDurableCustodyArtifactBytes,
} from '@bitcaster-market/client-sdk/durableCustody'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, mock } from 'node:test'
import { readActivityRows, readActivityForWallet } from './nativeActivityTestHelpers.ts'
import { SeedRecoverySqliteStore } from '../src/seedRecoverySqlite.ts'
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
import { claimDaemonPosition, readNativePositionClaimCustody } from '../src/nativePositionClaim.ts'
import {
  recoverAllDaemonWalletFromSeed,
  type AllKeysetSeedRecoveryTransport,
} from '../src/emergencySeedRecovery.ts'
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
import { addAvailableProofs, emptyDaemonState, readState, writeState } from '../src/state.ts'

test('Remove keeps raw proofs, exact journals and immutable markers through retry, save and reimport', async () => {
  const fixture = await createFixture(3)
  try {
    const canonicalDatabase = await openDaemonStateSqlite(fixture.directory)
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
    assert.ok(first.targets.length > 0 && first.targets.length < 260)
    const result = await removeDaemonPosition({
      ...fixture.context,
      preview: first,
      acknowledge: true,
    })
    assert.equal(result.moreProofsRemain, true)
    await removeDaemonPosition({ ...fixture.context, preview: first, acknowledge: true })
    assert.equal(
      (await readState()).wallet.proofs.filter((proof) => proof.retirement !== undefined).length,
      first.targets.length,
    )
    while (true) {
      const next = await previewDaemonPositionRemove(fixture.context)
      if (next.targets.length === 0) break
      assert.equal(
        next.targets.some((target) => first.targets.some((old) => old.proofId === target.proofId)),
        false,
      )
      await removeDaemonPosition({ ...fixture.context, preview: next, acknowledge: true })
    }
    assert.equal(
      (await readState()).wallet.proofs.filter((proof) => proof.retirement !== undefined).length,
      260,
    )
  } finally {
    await fixture.dispose()
  }
})

test('byte budget shortens a batch before oversized artifacts are loaded', async () => {
  const fixture = await createFixture(70, 12_000)
  try {
    const preview = await previewDaemonPositionRemove(fixture.context)
    assert.ok(preview.targets.length > 0 && preview.targets.length < 70)
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
            database
              .prepare('UPDATE custody_proofs SET revision = revision + 1 WHERE proof_id = ?')
              .run(fixture.canonicalRow().proofId)
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
        const operation = Object.values(current.proofOperations).find(
          ({ metadata }) => metadata.purpose === 'position-claim',
        )!
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

for (const pretty of [false, true]) {
  test(`JSON transport preserves acknowledged exact Remove dispatch with ${pretty ? 'formatted' : 'compact'} JSON`, async () => {
    const fixture = await createFixture(2)
    try {
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
      const envelope = JSON.parse(JSON.stringify(preview, null, pretty ? 2 : undefined))
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
  imported = true,
  importFault?: StateSqliteFaultPhase,
  initialMintResolution = false,
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
  const id = deriveConditionalKeysetId({ keys, unit: 'msat', conditionId, outcomeCollectionId })
  const conditionalIds = [id]
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
      return {
        ...proof,
        amount: 8,
        ...(extraBytes === 0 ? {} : { witness: 'x'.repeat(extraBytes) }),
      }
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
    if (importFault === undefined) {
      for (let offset = 0; offset < proofs.length; offset += 64)
        await importAttempt.importOutcomeProofs({
          ...importInput,
          proofs: proofs.slice(offset, offset + 64) as unknown as Proof[],
        })
    } else {
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
    for (let offset = 0; offset < proofs.length; offset += 64)
      await new DurableWalletProofImportCoordinator(directory, () => fence).importOutcomeProofs({
        ...importInput,
        proofs: proofs.slice(offset, offset + 64) as unknown as Proof[],
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
            getCtfCondition: async () => ({
              condition_id: conditionId,
              threshold: 1,
              collateral: 'msat',
              announcements: ['01'],
              attestation: initialMintResolution
                ? { status: 'pending' }
                : {
                    status: 'attested',
                    winning_outcome: 'YES',
                    oracle_sigs: [
                      { oracle_pubkey: publicKey, oracle_sig: signature, outcome: 'YES' },
                    ],
                  },
            }),
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
              announcementIdentity: createHash('sha256')
                .update(Buffer.from([1]))
                .digest('hex'),
            },
          ],
        },
      }),
    },
  }
  const claim = await claimDaemonPosition(claimInput)
  if (imported) {
    assert.ok(
      claim.legs.length >= Math.ceil(count / 64),
      'real losing claim must select bounded imported pages',
    )
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
  const canonicalDatabase = await openDaemonStateSqlite(directory)
  const canonicalProof = new DurableCustodySqliteStore(canonicalDatabase).getProof(
    fence.scopeId,
    createDurableCustodyProofMaterialRecord({
      scopeId: fence.scopeId,
      normalizedMint: profile.mintUrl,
      unit: 'msat',
      proof: {
        ...proofs[0]!,
        dleq: proofs[0]!.dleq ?? null,
        p2pkE: null,
        witness: proofs[0]!.witness ?? null,
      },
    }).proofId,
  )!
  canonicalDatabase.close()
  return {
    directory,
    proofs,
    asset,
    context: { profile, fence, conditionId, outcomeCollection: 'NO', isCustodyReady: () => true },
    canonicalRow: () => canonicalProof,
    dispose: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('native Claim verifies engine evidence before the mint records its first resolution', async () => {
  const fixture = await createFixture(1, 0, true, undefined, true)
  try {
    const state = (await readState())!
    const claim = Object.values(state.proofOperations).find(({ kind }) => kind === 'ctf-redeem')!
    assert.equal(claim.failureCode, 13015)
    assert.ok(claim.metadata.oracleResolutionContext)
    await assert.doesNotReject(previewDaemonPositionRemove(fixture.context))
  } finally {
    await fixture.dispose()
  }
})

test('retained Claim recovery refuses a profile containing a foreign scope', async () => {
  const fixture = await createFixture(1)
  try {
    const walletId = 'ab'.repeat(32)
    const scopeId = deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId })
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      database
        .prepare('INSERT INTO custody_scopes VALUES (?, ?, ?, ?, ?)')
        .run(scopeId, 'wallet', walletId, 'cd'.repeat(32), Date.now())
      database.prepare('INSERT INTO custody_scope_state VALUES (?, 0, NULL, NULL, 0)').run(scopeId)
    } finally {
      database.close()
    }
    const store = new SeedRecoverySqliteStore({
      directory: fixture.directory,
      fence: fixture.context.fence,
      invocationId: 'foreign-scope-refusal',
      observedAtMs: Date.now(),
    })
    await assert.rejects(
      store.readRetainedClaimPage('https://mint.example'),
      /daemon profile SQLite schema does not match/,
    )
  } finally {
    await fixture.dispose()
  }
})

test('retained Claim SQLite cursor pages exact sorted records and filters mint', async () => {
  const fixture = await createFixture(1025)
  try {
    const store = new SeedRecoverySqliteStore({
      directory: fixture.directory,
      fence: fixture.context.fence,
      invocationId: 'retained-cursor-test',
      observedAtMs: Date.now(),
    })
    const expected = Object.values((await readState())!.proofOperations)
      .filter(
        ({ kind, state, failureCode }) =>
          kind === 'ctf-redeem' && state === 'Failed' && failureCode === 13015,
      )
      .map(({ operationId }) => operationId)
      .sort()
    assert.equal(expected.length, 17)
    const first = await store.readRetainedClaimPage('https://mint.example')
    assert.equal(first.length, 16)
    const second = await store.readRetainedClaimPage(
      'https://mint.example',
      first.at(-1)!.target.operationId,
    )
    assert.equal(second.length, 1)
    assert.deepEqual(
      [...first, ...second].map(({ target }) => target.operationId),
      expected,
    )
    assert.deepEqual(
      await store.readRetainedClaimPage('https://mint.example', second[0]!.target.operationId),
      [],
    )
    assert.deepEqual(await store.readRetainedClaimPage('https://another-mint.example'), [])
  } finally {
    await fixture.dispose()
  }
})

test('historical canonical code-only terminal remains retained after reopen and cannot authorize Remove', async () => {
  const fixture = await createFixture(3)
  try {
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const terminal = database.prepare('SELECT * FROM custody_terminal_mint_rejections').get()!
      const row = database
        .prepare('SELECT body FROM custody_artifacts WHERE artifact_id = ?')
        .get(terminal.rejection_artifact_id)!
      const { losingAuthority: removed, ...history } = JSON.parse(
        Buffer.from(row.body as Uint8Array).toString(),
      )
      const exact = prepareDurableCustodyExactArtifact(history)
      database
        .prepare('UPDATE custody_artifacts SET body = ?, fingerprint = ? WHERE artifact_id = ?')
        .run(
          readPreparedDurableCustodyArtifactBytes(exact),
          exact.fingerprint,
          terminal.rejection_artifact_id,
        )
      // Reconstruct a pre-D4 row in this disposable fixture. Restore the schema guard before reads.
      const immutable = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'custody_terminal_mint_rejections_no_update'",
        )
        .get()!
      database.exec('DROP TRIGGER custody_terminal_mint_rejections_no_update')
      try {
        database
          .prepare(
            'UPDATE custody_terminal_mint_rejections SET rejection_fingerprint = ? WHERE operation_id = ?',
          )
          .run(exact.fingerprint, terminal.operation_id)
      } finally {
        database.exec(String(immutable.sql))
      }
    } finally {
      database.close()
    }
    const original = (await readState())!
    await assert.rejects(
      previewDaemonPositionRemove(fixture.context),
      /no verified losing authority/,
    )
    const reopened = await openDaemonStateSqlite(fixture.directory)
    reopened.close()
    await assert.rejects(
      previewDaemonPositionRemove(fixture.context),
      /no verified losing authority/,
    )
    assert.equal(isDeepStrictEqual(await readState(), original), true)
    const check = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        check
          .prepare('SELECT selectability FROM custody_proofs WHERE condition_id = ?')
          .get(fixture.asset.conditionId)!.selectability,
        'retained',
      )
      assert.equal(
        check
          .prepare(
            "SELECT operation_state FROM custody_operations WHERE semantic_kind = 'ctf-redeem'",
          )
          .get()!.operation_state,
        'aborted',
      )
    } finally {
      check.close()
    }
    await recoverHistoricalClaimPayout(fixture, original)
  } finally {
    await fixture.dispose()
  }
})

async function recoverHistoricalClaimPayout(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  original: NonNullable<Awaited<ReturnType<typeof readState>>>,
) {
  const claim = Object.values(original.proofOperations).find(({ kind }) => kind === 'ctf-redeem')!
  assert.equal(claim.state, 'Failed')
  const outputs = claim.outputs.regular!
  assert.deepEqual(
    outputs.map(({ blindedMessage }) => Number(blindedMessage.amount)).sort((a, b) => a - b),
    [8, 16],
  )
  const activityBefore = await readActivityRows(fixture.directory)
  const committed = new Map(
    outputs.map((output) => [output.blindedMessage.B_, output.blindedMessage]),
  )
  const privateKey = Uint8Array.from([...new Uint8Array(31), 1])
  const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
  const keys = Object.fromEntries(Array.from({ length: 13 }, (_, power) => [2 ** power, publicKey]))
  const regular = {
    id: deriveKeysetId(keys, { unit: 'msat', versionByte: 1, input_fee_ppk: 0 }),
    unit: 'msat',
    keys,
  }
  assert.ok(outputs.every(({ blindedMessage }) => blindedMessage.id === regular.id))
  let restored = 0
  let mode:
    | 'valid'
    | 'collision'
    | 'empty'
    | 'partial'
    | 'bad-dleq'
    | 'spent'
    | 'mixed'
    | 'pending'
    | 'missing-state'
    | 'duplicate-state'
    | 'foreign-state'
    | 'changed-authority'
    | 'payout-rollback'
    | 'activity-rollback'
    | 'late-active-work'
    | 'takeover' = 'valid'
  const readCounters = async () => {
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      return {
        target: database.prepare('SELECT * FROM target_keyset_counters ORDER BY keyset_id').all(),
        canonical: database
          .prepare('SELECT * FROM custody_keyset_counters ORDER BY keyset_id')
          .all(),
      }
    } finally {
      database.close()
    }
  }
  let retainedCounters: Awaited<ReturnType<typeof readCounters>> | undefined
  let counterChecks = 0
  let takeover = false
  let rollbackDatabase: Awaited<ReturnType<typeof openDaemonStateSqlite>> | undefined
  let lateWorkOperationId: string | undefined
  let authorityBefore: { artifactId: string; body: Uint8Array } | undefined
  const currentFence = () =>
    mode === 'takeover' && takeover
      ? { ...fixture.context.fence, fencingEpoch: fixture.context.fence.fencingEpoch + 1 }
      : fixture.context.fence
  const transport: AllKeysetSeedRecoveryTransport = {
    wallet: {
      loadMint: async () => {},
      keyChain: {
        getKeyset: () => regular,
        ensureKeysetKeys: async () => regular,
      },
      checkProofsStates: async (proofs) => {
        const states = proofs.map((proof) => ({
          Y: hashToCurve(utf8ToBytes(proof.secret)).toHex(true),
          state:
            mode === 'spent' || (mode === 'mixed' && Number(proof.amount) !== 8)
              ? CheckStateEnum.SPENT
              : mode === 'pending'
                ? CheckStateEnum.PENDING
                : CheckStateEnum.UNSPENT,
          witness: null,
        }))
        if (mode === 'missing-state') return states.slice(1)
        if (mode === 'duplicate-state') return states.map(() => states[0]!)
        if (mode === 'foreign-state') return states.map((state) => ({ ...state, Y: publicKey }))
        return states
      },
    },
    listRegularKeysets: async () => ({
      keysets: [{ id: regular.id, unit: 'msat', active: true, input_fee_ppk: 0 }],
    }),
    listConditionalKeysets: async () => ({ keysets: [] }),
    getConditionalKeyset: async () => {
      throw new Error('ordinary payout recovery must not fetch conditional keys')
    },
    restoreCandidates: async (candidates) => {
      const matches = candidates.flatMap((candidate) => {
        const planned = committed.get((candidate as { B_: string }).B_)
        return planned === undefined ? [] : [planned]
      })
      if (matches.length > 0) retainedCounters = await readCounters()
      else if (retainedCounters !== undefined) {
        assert.deepEqual(
          await readCounters(),
          retainedCounters,
          'retained-output recovery must not advance seed counters',
        )
        retainedCounters = undefined
        counterChecks += 1
      }
      if (mode === 'empty') matches.length = 0
      if (mode === 'partial' && matches.length > 1) matches.length = 1
      if (mode === 'takeover' && matches.length > 0) takeover = true
      if (mode === 'changed-authority' && matches.length > 0) {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          const { exactAuthority } = readNativePositionClaimCustody(
            database,
            fixture.context.fence,
            claim,
          )
          const row = database
            .prepare('SELECT artifact_id, body FROM custody_artifacts WHERE fingerprint = ?')
            .get(exactAuthority.fingerprint)!
          authorityBefore = {
            artifactId: String(row.artifact_id),
            body: Uint8Array.from(row.body as Uint8Array),
          }
          const changed = authorityBefore.body.slice()
          changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
          database
            .prepare('UPDATE custody_artifacts SET body = ? WHERE artifact_id = ?')
            .run(changed, authorityBefore.artifactId)
        } finally {
          database.close()
        }
      }
      if (mode === 'payout-rollback' && matches.length > 0) {
        const database = await openDaemonStateSqlite(fixture.directory)
        rollbackDatabase = database
        {
          database.exec(`CREATE TRIGGER test_retained_payout_rollback
            BEFORE INSERT ON custody_proofs
            WHEN NEW.condition_id IS NULL AND
              (SELECT count(*) FROM custody_proofs WHERE condition_id IS NULL) > 0
            BEGIN SELECT RAISE(ABORT, 'test retained payout second insert failure'); END`)
        }
      }
      if (mode === 'activity-rollback' && matches.length > 0) {
        rollbackDatabase = await openDaemonStateSqlite(fixture.directory)
        rollbackDatabase.exec(`CREATE TRIGGER test_retained_activity_rollback
          BEFORE INSERT ON daemon_activity_feed WHEN NEW.source_id LIKE 'retained-claim-payout:%'
          BEGIN SELECT RAISE(ABORT, 'test retained Activity insert failure'); END`)
      }
      if (mode === 'late-active-work' && matches.length > 0) {
        const database = await openDaemonStateSqlite(fixture.directory)
        try {
          lateWorkOperationId = String(
            database
              .prepare('SELECT operation_id FROM custody_operations WHERE scope_id = ? LIMIT 1')
              .get(fixture.context.fence.scopeId)!.operation_id,
          )
          database
            .prepare(
              'INSERT INTO custody_active_work (scope_id, operation_id, next_attempt_at_ms, estimated_bytes) VALUES (?, ?, 0, 1)',
            )
            .run(fixture.context.fence.scopeId, lateWorkOperationId!)
        } finally {
          database.close()
        }
      }
      matches.reverse()
      if (mode === 'valid') restored += matches.length
      return {
        outputs: matches,
        signatures: matches.map((output) => {
          const point = pointFromHex(output.B_)
          const signature = createBlindSignature(point, privateKey, regular.id)
          const dleq = createDLEQProof(point, privateKey)
          return {
            id: regular.id,
            amount: Number(output.amount),
            C_: signature.C_.toHex(true),
            dleq: {
              e: mode === 'bad-dleq' ? '01'.repeat(32) : bytesToHex(dleq.e),
              s: bytesToHex(dleq.s),
            },
          }
        }),
      }
    },
  }
  const pagingDatabase = await openDaemonStateSqlite(fixture.directory)
  const pagingAuthority = readNativePositionClaimCustody(
    pagingDatabase,
    fixture.context.fence,
    claim,
  )
  pagingDatabase.close()
  for (const total of [1023, 1024, 1025]) {
    let reads = 0
    let restoredRecords = 0
    const pageMock = mock.method(
      SeedRecoverySqliteStore.prototype,
      'readRetainedClaimPage',
      async (mintUrl: string, after = '') => {
        assert.equal(mintUrl, 'https://mint.example')
        const offset = after === '' ? 0 : Number(after.slice('paging-'.length)) + 1
        assert.equal(offset, reads * 16)
        reads += 1
        return Array.from({ length: Math.min(16, total - offset) }, (_, index) => ({
          target: { ...claim, operationId: `paging-${String(offset + index).padStart(4, '0')}` },
          record: pagingAuthority.record,
          exactAuthority: pagingAuthority.exactAuthority,
        }))
      },
    )
    try {
      const recovery = recoverAllDaemonWalletFromSeed(
        {
          recoveryId: `historical-page-bound-${total}`,
          mintUrl: 'https://mint.example',
          unit: 'msat',
          walletSeedHex: '11'.repeat(64),
          disclosureAcknowledged: true,
        },
        {
          directory: fixture.directory,
          getFence: currentFence,
          transport: {
            ...transport,
            restoreCandidates: async (candidates) => {
              if (candidates.some((candidate) => committed.has((candidate as { B_: string }).B_)))
                restoredRecords += 1
              return { outputs: [], signatures: [] }
            },
          },
        },
      )
      if (total === 1025)
        await assert.rejects(recovery, /retained payout recovery record bound exceeded/)
      else assert.equal((await recovery).state, 'completed')
      assert.equal(restoredRecords, Math.min(total, 1024))
      assert.equal(reads, total === 1023 ? 64 : 65)
      assert.deepEqual((await readState())!.wallet.proofs, original.wallet.proofs)
    } finally {
      pageMock.mock.restore()
    }
  }
  const expectedAmount = outputs.reduce(
    (sum, { blindedMessage }) => sum + Number(blindedMessage.amount),
    0,
  )
  assert.ok(expectedAmount > 0)
  assert.ok(outputs.length > 1, 'partial and reordered replies require multiple outputs')
  for (const scenario of [
    'empty',
    'partial',
    'bad-dleq',
    'spent',
    'pending',
    'missing-state',
    'duplicate-state',
    'foreign-state',
    'takeover',
    'late-active-work',
    'payout-rollback',
    'activity-rollback',
    'changed-authority',
  ] as const) {
    mode = scenario
    takeover = false
    retainedCounters = undefined
    const recovery = recoverAllDaemonWalletFromSeed(
      {
        recoveryId: `historical-${scenario}`,
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHex: '11'.repeat(64),
        disclosureAcknowledged: true,
      },
      { directory: fixture.directory, getFence: currentFence, transport },
    )
    if (scenario === 'empty' || scenario === 'spent') {
      const result = await recovery
      assert.equal(result.state, 'completed')
      assert.equal(result.retainedOutputProofsImported, 0)
    } else {
      await assert.rejects(
        recovery,
        scenario === 'changed-authority'
          ? /durable owner blocker target-wallet-proof-reserved/
          : scenario === 'activity-rollback'
            ? /test retained Activity insert failure/
            : scenario === 'payout-rollback'
              ? /test retained payout second insert failure/
              : /incomplete|DLEQ|Dleq|dleq|pending|proof state|owner or epoch changed|durable owner blocker custody-active-work/,
      )
    }
    if (scenario === 'changed-authority') {
      const database = await openDaemonStateSqlite(fixture.directory)
      try {
        database
          .prepare('UPDATE custody_artifacts SET body = ? WHERE artifact_id = ?')
          .run(authorityBefore!.body, authorityBefore!.artifactId)
      } finally {
        database.close()
      }
    }
    if (scenario === 'activity-rollback') {
      rollbackDatabase!.exec('DROP TRIGGER test_retained_activity_rollback')
      rollbackDatabase!.close()
      rollbackDatabase = undefined
    }
    if (scenario === 'payout-rollback') {
      try {
        rollbackDatabase!.exec('DROP TRIGGER test_retained_payout_rollback')
      } finally {
        rollbackDatabase!.close()
        rollbackDatabase = undefined
      }
    }
    if (scenario === 'late-active-work') {
      const database = await openDaemonStateSqlite(fixture.directory)
      try {
        assert.equal(
          database
            .prepare('SELECT count(*) AS count FROM custody_active_work WHERE scope_id = ?')
            .get(fixture.context.fence.scopeId)?.count,
          1,
        )
        database
          .prepare('DELETE FROM custody_active_work WHERE scope_id = ? AND operation_id = ?')
          .run(fixture.context.fence.scopeId, lateWorkOperationId!)
      } finally {
        database.close()
      }
    }
    assert.deepEqual(await readActivityRows(fixture.directory), activityBefore)
    const state = (await readState())!
    assert.deepEqual(state.wallet.proofs, original.wallet.proofs)
    assert.deepEqual(state.proofOperations[claim.operationId], claim)
    const reopened = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        reopened
          .prepare('SELECT count(*) AS count FROM custody_proofs WHERE condition_id IS NULL')
          .get()!.count,
        0,
      )
    } finally {
      reopened.close()
    }
  }
  mode = 'mixed'
  const mixed = await recoverAllDaemonWalletFromSeed(
    {
      recoveryId: 'historical-mixed-first',
      mintUrl: 'https://mint.example',
      unit: 'msat',
      walletSeedHex: '11'.repeat(64),
      disclosureAcknowledged: true,
    },
    { directory: fixture.directory, getFence: currentFence, transport },
  )
  assert.equal(mixed.retainedOutputProofsImported, 1)
  const firstCredit = (await readActivityRows(fixture.directory)).filter(
    ({ item }) => item.claimRecovery,
  )
  assert.equal(firstCredit.length, 1)
  assert.equal(firstCredit[0]!.item.amountSubunits, 8)
  assert.equal(firstCredit[0]!.item.status, 'completed')
  assert.deepEqual(firstCredit[0]!.item.claimRecovery, {
    kind: 'retained-claim-payout',
    originalOperationId: claim.operationId,
    originalStatus: 'Failed',
    originalFailureCode: 13015,
  })
  assert.deepEqual(
    (
      await readActivityForWallet(
        fixture.directory,
        fixture.context.fence.scopeId.slice('custody:wallet:'.length),
      )
    ).filter((item) => item.claimRecovery),
    firstCredit.map(({ item }) => item),
  )
  assert.deepEqual(await readActivityForWallet(fixture.directory, 'ff'.repeat(32)), [])
  const reopenedCredit = await openDaemonStateSqlite(fixture.directory)
  reopenedCredit.close()
  for (const retryMode of ['mixed', 'spent'] as const) {
    mode = retryMode
    const retry = await recoverAllDaemonWalletFromSeed(
      {
        recoveryId: `historical-mixed-${retryMode}`,
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHex: '11'.repeat(64),
        disclosureAcknowledged: true,
      },
      { directory: fixture.directory, getFence: currentFence, transport },
    )
    assert.equal(retry.retainedOutputProofsImported, 0)
    assert.deepEqual(
      (await readActivityRows(fixture.directory)).filter(({ item }) => item.claimRecovery),
      firstCredit,
    )
  }
  assert.equal(
    isDeepStrictEqual((await readState())!.proofOperations[claim.operationId], claim),
    true,
  )
  mode = 'valid'
  let allCredits: Awaited<ReturnType<typeof readActivityRows>> | undefined
  for (const recoveryId of ['historical-payout-first', 'historical-payout-again']) {
    const result = await recoverAllDaemonWalletFromSeed(
      {
        recoveryId,
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHex: '11'.repeat(64),
        disclosureAcknowledged: true,
      },
      { directory: fixture.directory, getFence: currentFence, transport },
    )
    assert.equal(result.state, 'completed')
    assert.equal(
      result.retainedOutputProofsImported,
      recoveryId === 'historical-payout-first' ? 1 : 0,
    )
    const credits = (await readActivityRows(fixture.directory)).filter(
      ({ item }) => item.claimRecovery,
    )
    assert.deepEqual(credits[0], firstCredit[0])
    assert.equal(credits.length, 2)
    assert.equal(credits[1]!.item.amountSubunits, 16)
    assert.notEqual(credits[0]!.item.id, credits[1]!.item.id)
    if (allCredits === undefined) allCredits = credits
    else assert.deepEqual(credits, allCredits)
    const state = (await readState())!
    assert.deepEqual(
      state.wallet.proofs.filter(({ asset }) => asset.kind === 'Outcome'),
      original.wallet.proofs.filter(({ asset }) => asset.kind === 'Outcome'),
    )
    assert.deepEqual(state.proofOperations[claim.operationId], claim)
    const payouts = state.wallet.proofs.filter(({ asset }) => asset.kind === 'sats')
    assert.equal(
      payouts.reduce((sum, { proof }) => sum + Number(proof.amount), 0),
      expectedAmount,
    )
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        database
          .prepare('SELECT selectability FROM custody_proofs WHERE condition_id = ?')
          .get(fixture.asset.conditionId)!.selectability,
        'retained',
      )
      assert.equal(
        database
          .prepare(
            "SELECT operation_state FROM custody_operations WHERE semantic_kind = 'ctf-redeem'",
          )
          .get()!.operation_state,
        'aborted',
      )
    } finally {
      database.close()
    }
  }
  mode = 'spent'
  const spentRetry = await recoverAllDaemonWalletFromSeed(
    {
      recoveryId: 'historical-all-spent-after-credit',
      mintUrl: 'https://mint.example',
      unit: 'msat',
      walletSeedHex: '11'.repeat(64),
      disclosureAcknowledged: true,
    },
    { directory: fixture.directory, getFence: currentFence, transport },
  )
  assert.equal(spentRetry.retainedOutputProofsImported, 0)
  assert.deepEqual(
    (await readActivityRows(fixture.directory)).filter(({ item }) => item.claimRecovery),
    allCredits,
  )
  mode = 'collision'
  const beforeCollision = (await readState())!
  const collisionDatabase = await openDaemonStateSqlite(fixture.directory)
  const payoutRow = collisionDatabase
    .prepare(
      'SELECT proof_id FROM custody_proofs WHERE condition_id IS NULL ORDER BY proof_id LIMIT 1',
    )
    .get()!
  collisionDatabase
    .prepare("UPDATE custody_proofs SET selectability = 'spent' WHERE proof_id = ?")
    .run(payoutRow.proof_id)
  const collisionRows = collisionDatabase
    .prepare('SELECT * FROM custody_proofs ORDER BY proof_id')
    .all()
  collisionDatabase.close()
  await assert.rejects(
    recoverAllDaemonWalletFromSeed(
      {
        recoveryId: 'historical-payout-collision',
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHex: '11'.repeat(64),
        disclosureAcknowledged: true,
      },
      { directory: fixture.directory, getFence: currentFence, transport },
    ),
    /retained payout conflicts with existing proof authority/,
  )
  const afterCollision = (await readState())!
  assert.deepEqual(afterCollision.wallet.proofs, beforeCollision.wallet.proofs)
  assert.deepEqual(afterCollision.proofOperations[claim.operationId], claim)
  const collisionReopened = await openDaemonStateSqlite(fixture.directory)
  try {
    assert.deepEqual(
      collisionReopened.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      collisionRows,
    )
  } finally {
    collisionReopened.close()
  }
  assert.deepEqual(
    (await readActivityRows(fixture.directory)).filter(({ item }) => item.claimRecovery),
    allCredits,
  )
  assert.equal(restored, outputs.length * 2)
  assert.ok(
    counterChecks >= 4,
    'empty, spent, initial payout and retry preserve counters before seed scanning',
  )
}

test('native Remove rechecks original frozen intended scope rather than mutable terminal metadata', async () => {
  const fixture = await createFixture(1)
  try {
    const state = (await readState())!
    const operation = Object.values(state.proofOperations).find(
      ({ metadata }) => metadata.purpose === 'position-claim',
    )!
    const context = operation.metadata.oracleResolutionContext as {
      registered: { scopeId: string }
    }
    context.registered.scopeId = deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: 'ff'.repeat(32),
    })
    await writeState(state)
    const reopened = await openDaemonStateSqlite(fixture.directory)
    reopened.close()
    await assert.rejects(
      previewDaemonPositionRemove(fixture.context),
      /canonical authority differs/,
    )
    assert.equal(
      (await readState())!.wallet.proofs.some(({ retirement }) => retirement !== undefined),
      false,
    )
  } finally {
    await fixture.dispose()
  }
})
