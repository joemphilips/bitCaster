import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createDurableCustodyArtifactReference,
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  applyDurableCustodyTransaction,
  type DurableCustodyExactArtifact,
} from '@bitcaster-market/client-sdk/durableCustody'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  DurableCustodySqliteStore,
  type CustodyCounterSqliteRow,
  type CustodyProofSqliteRow,
} from '../src/durableCustodySqliteStore.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import {
  acknowledgeCustodyDelivery,
  purgeCustodyOperationP09,
  putCustodyTerminalTombstone,
} from '../src/durableCustodyLifecycle.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { bindDurableCustodyProofOperation } from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  DAEMON_HISTORY_PAGE_BYTES_MAX,
  custodyHistorySerializedPageBytes,
  takeBoundedCustodyHistoryRows,
  type CustodyHistoryRow,
} from '../src/boundedHistory.ts'
import {
  assertDurableCustodyAdapterConformance,
  createDurableCustodyConformancePrepared,
  type DurableCustodyAdapterConformanceHarness,
  type DurableCustodyAdapterConformanceSnapshot,
  type DurableCustodyConformancePrepared,
} from '../../bitcaster-client-sdk/test/support/durableCustodyAdapterConformance.ts'

async function profile() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-custody-sqlite-'))
  const bootstrapped = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(32),
    nostrSecretKeyHex: '22'.repeat(32),
    initializedAtMs: 1,
  })
  return { directory, ...bootstrapped }
}

test('fenced custody unit of work rolls proof and counter writes back atomically', async () => {
  const fixture = await profile()
  try {
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'incarnation-0001',
      observedAtMs: 2,
    })
    const proof = proofRow(fixture.walletScopeId)
    const counter: CustodyCounterSqliteRow = {
      scopeId: fixture.walletScopeId,
      normalizedMint: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-1',
      nextCounter: 3,
      revision: 0,
      updatedAtMs: 3,
    }
    await assert.rejects(
      () =>
        withDurableCustodyUnitOfWork(
          fixture.directory,
          fence,
          3,
          (database) => {
            const store = new DurableCustodySqliteStore(database)
            store.putProofCas(proof, null)
            store.putCounterCas(counter, null)
          },
          {
            injectFault: (phase) => {
              if (phase === 'before-commit') throw new Error('injected rollback')
            },
          },
        ),
      /injected rollback/,
    )
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM custody_proofs').get() as {
            count: number
          }
        ).count,
        0,
      )
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM custody_keyset_counters').get() as {
            count: number
          }
        ).count,
        0,
      )
    } finally {
      database.close()
    }
    await withDurableCustodyUnitOfWork(fixture.directory, fence, 4, (database) => {
      const store = new DurableCustodySqliteStore(database)
      store.putProofCas({ ...proof, updatedAtMs: 4 }, null)
      store.putCounterCas({ ...counter, updatedAtMs: 4 }, null)
      assert.throws(
        () => store.putCounterCas({ ...counter, nextCounter: 4, revision: 2, updatedAtMs: 4 }, 0),
        /advance exactly/,
      )
    })
    await assert.rejects(
      () =>
        withDurableCustodyUnitOfWork(
          fixture.directory,
          { ...fence, fencingEpoch: fence.fencingEpoch + 1 },
          5,
          () => undefined,
        ),
      /stale or expired/,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('artifact adapter validates full immutable reference and operation revision', async () => {
  const fixture = await profile()
  try {
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const request = artifact({ request: 1 })
      const output = artifact({ output: 1 })
      const privateMaterial = artifact({ private: 1 })
      const operationId = 'custody-operation:test'
      const references = {
        request: createDurableCustodyArtifactReference(`artifact:${operationId}:request`, request),
        output: createDurableCustodyArtifactReference(`artifact:${operationId}:output`, output),
        private: createDurableCustodyArtifactReference(
          `artifact:${operationId}:private`,
          privateMaterial,
        ),
      }
      for (const [kind, exact] of [
        ['exact-request', request],
        ['output-plan', output],
        ['private-material', privateMaterial],
      ] as const) {
        const reference =
          kind === 'exact-request'
            ? references.request
            : kind === 'output-plan'
              ? references.output
              : references.private
        database
          .prepare(
            `INSERT INTO custody_artifacts (
               artifact_id, scope_id, artifact_kind, encoding, body,
               fingerprint, revision, private_material, created_at_ms
             ) VALUES (?, ?, ?, 'canonical-json', ?, ?, 0, ?, 2)`,
          )
          .run(
            reference.artifactId,
            fixture.walletScopeId,
            kind,
            new TextEncoder().encode(JSON.stringify(exact.artifact)),
            exact.fingerprint,
            kind === 'private-material' ? 1 : 0,
          )
      }
      insertMinimalOperation(database, {
        scopeId: fixture.walletScopeId,
        operationId,
        requestId: references.request.artifactId,
        outputId: references.output.artifactId,
        privateId: references.private.artifactId,
      })
      const store = new DurableCustodySqliteStore(database)
      const lookup = {
        scopeId: fixture.walletScopeId,
        operationId,
        expectedOperationRevision: 0,
        reference: references.request,
      }
      assert.deepEqual(store.getArtifact(lookup)?.artifact, request)
      assert.throws(
        () =>
          store.getArtifact({
            ...lookup,
            reference: { ...references.request, byteLength: 99 },
          }),
        /reference is foreign/,
      )
      assert.throws(
        () =>
          store.putArtifact({
            ...lookup,
            expectedArtifactRevision: 0,
            artifact: artifact({ replacement: true }),
            createdAtMs: 3,
          }),
        /does not match|fingerprint|immutable/,
      )
      assert.throws(
        () => store.getArtifact({ ...lookup, expectedOperationRevision: 1 }),
        /revision CAS/,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('P09 physically deletes only after receipt, tombstone, and persisted admission', async () => {
  const fixture = await profile()
  try {
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const operationId = 'custody-operation:purge'
      const successorProofId = 'd'.repeat(64)
      const refs = ['request', 'output', 'private', 'delivery', 'result'].map((suffix) => {
        const exact = artifact({ suffix })
        const reference = createDurableCustodyArtifactReference(
          `artifact:${operationId}:${suffix}`,
          exact,
        )
        database
          .prepare(
            `INSERT INTO custody_artifacts (
               artifact_id, scope_id, artifact_kind, encoding, body,
               fingerprint, revision, private_material, created_at_ms
             ) VALUES (?, ?, ?, 'canonical-json', ?, ?, 0, ?, 2)`,
          )
          .run(
            reference.artifactId,
            fixture.walletScopeId,
            suffix === 'request'
              ? 'exact-request'
              : suffix === 'output'
                ? 'output-plan'
                : suffix === 'private'
                  ? 'private-material'
                  : suffix === 'delivery'
                    ? 'delivery-payload'
                    : 'exact-result',
            new TextEncoder().encode(JSON.stringify(exact.artifact)),
            exact.fingerprint,
            suffix === 'private' ? 1 : 0,
          )
        return reference
      })
      insertMinimalOperation(database, {
        scopeId: fixture.walletScopeId,
        operationId,
        requestId: refs[0]!.artifactId,
        outputId: refs[1]!.artifactId,
        privateId: refs[2]!.artifactId,
      })
      database
        .prepare(
          `UPDATE custody_operations SET
             operation_state = 'reconciled', result_state = 'applied',
             result_handle = 'result-1', result_artifact_id = ?,
             result_fingerprint = ?, result_output_plan_fingerprint = ?,
             successor_selection_staged = 1
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(
          refs[4]!.artifactId,
          refs[4]!.fingerprint,
          '2'.repeat(64),
          fixture.walletScopeId,
          operationId,
        )
      new DurableCustodySqliteStore(database).putProofCas(
        {
          ...proofRow(fixture.walletScopeId),
          proofId: successorProofId,
        },
        null,
      )
      database
        .prepare(
          `INSERT INTO custody_proof_lineage (
             scope_id, operation_id, lineage_kind, lineage_position, proof_id
           ) VALUES (?, ?, 'successor', 0, ?)`,
        )
        .run(fixture.walletScopeId, operationId, successorProofId)
      database
        .prepare(
          `INSERT INTO custody_selected_successors (
             scope_id, operation_id, proof_position, proof_id
           ) VALUES (?, ?, 0, ?)`,
        )
        .run(fixture.walletScopeId, operationId, successorProofId)
      database
        .prepare(
          `INSERT INTO custody_deliveries (
             scope_id, operation_id, delivery_id, delivery_kind, state,
             payload_artifact_id, expires_at_ms
           ) VALUES (?, ?, 'delivery-1', 'outbox', 'pending', ?, NULL)`,
        )
        .run(fixture.walletScopeId, operationId, refs[3]!.artifactId)
      acknowledgeCustodyDelivery(database, {
        scopeId: fixture.walletScopeId,
        operationId,
        deliveryId: 'delivery-1',
        receiptId: 'receipt-1',
        receiptFingerprint: refs[3]!.fingerprint,
        acknowledgedAtMs: 3,
      })
      putCustodyTerminalTombstone(database, {
        scopeId: fixture.walletScopeId,
        operationId,
        tombstoneId: 'tombstone-1',
        terminalAuthorityId: 'authority-1',
        authenticatedTerminalStatus: true,
        replayCutoffObserved: true,
      })
      const evidence = {
        scopeId: fixture.walletScopeId,
        operationId,
        admissionId: 'admission-1',
        proofRows: [
          {
            proofId: successorProofId,
            expectedRevision: null,
            admittedRevision: 0,
          },
        ],
      }
      assert.equal(
        purgeCustodyOperationP09(database, {
          scopeId: fixture.walletScopeId,
          operationId,
          plannedSuccessorProofIds: [successorProofId],
          successorAdmission: evidence,
        }),
        'retained',
      )
      database
        .prepare(
          `INSERT INTO custody_successor_admissions (
             scope_id, operation_id, admission_id
           ) VALUES (?, ?, ?)`,
        )
        .run(fixture.walletScopeId, operationId, evidence.admissionId)
      database
        .prepare(
          `INSERT INTO custody_successor_admission_proofs (
             scope_id, operation_id, proof_position, proof_id,
             expected_revision, admitted_revision
           ) VALUES (?, ?, 0, ?, NULL, 0)`,
        )
        .run(fixture.walletScopeId, operationId, successorProofId)
      assert.equal(
        purgeCustodyOperationP09(database, {
          scopeId: fixture.walletScopeId,
          operationId,
          plannedSuccessorProofIds: [successorProofId],
          successorAdmission: evidence,
        }),
        'deleted',
      )
      assert.equal(
        database
          .prepare('SELECT 1 FROM custody_operations WHERE operation_id = ?')
          .get(operationId),
        undefined,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('active work pages enforce exact 256-record and 4 MiB boundaries', async () => {
  const fixture = await profile()
  try {
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      for (let index = 0; index < 257; index += 1) {
        const operationId = `custody-operation:page-${index}`
        const ids = seedMinimalArtifacts(database, fixture.walletScopeId, operationId)
        insertMinimalOperation(database, {
          scopeId: fixture.walletScopeId,
          operationId,
          requestId: ids.requestId,
          outputId: ids.outputId,
          privateId: ids.privateId,
        })
        if (index < 256) {
          database
            .prepare(
              `INSERT INTO custody_active_work (
                 scope_id, operation_id, next_attempt_at_ms, estimated_bytes
               ) VALUES (?, ?, ?, 1)`,
            )
            .run(fixture.walletScopeId, operationId, index)
        }
      }
      const store = new DurableCustodySqliteStore(database)
      const exactRecords = store.listActiveWorkPage(fixture.walletScopeId)
      assert.equal(exactRecords.rows.length, 256)
      assert.equal(exactRecords.nextCursor, null)
      database
        .prepare(
          `INSERT INTO custody_active_work (
             scope_id, operation_id, next_attempt_at_ms, estimated_bytes
           ) VALUES (?, ?, 256, 1)`,
        )
        .run(fixture.walletScopeId, 'custody-operation:page-256')
      const maxPlusOne = store.listActiveWorkPage(fixture.walletScopeId)
      assert.equal(maxPlusOne.rows.length, 256)
      assert.notEqual(maxPlusOne.nextCursor, null)

      database.prepare('DELETE FROM custody_active_work').run()
      database
        .prepare(
          `INSERT INTO custody_active_work (
             scope_id, operation_id, next_attempt_at_ms, estimated_bytes
           ) VALUES (?, ?, 0, ?)`,
        )
        .run(fixture.walletScopeId, 'custody-operation:page-0', 4 * 1_024 * 1_024)
      database
        .prepare(
          `INSERT INTO custody_active_work (
             scope_id, operation_id, next_attempt_at_ms, estimated_bytes
           ) VALUES (?, ?, 1, 1)`,
        )
        .run(fixture.walletScopeId, 'custody-operation:page-1')
      const exactBytes = store.listActiveWorkPage(fixture.walletScopeId)
      assert.equal(exactBytes.rows.length, 1)
      assert.equal(exactBytes.estimatedBytes, 4 * 1_024 * 1_024)
      assert.notEqual(exactBytes.nextCursor, null)
      assert.throws(
        () =>
          database
            .prepare(
              `UPDATE custody_active_work SET estimated_bytes = ?
               WHERE scope_id = ? AND operation_id = ?`,
            )
            .run(4 * 1_024 * 1_024 + 1, fixture.walletScopeId, 'custody-operation:page-0'),
        /constraint/,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('operation and artifacts round-trip exactly with deferred FK ordering', async () => {
  const fixture = await profile()
  try {
    const prepared = exactIntent(fixture.walletScopeId)
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'incarnation-roundtrip',
      observedAtMs: 2,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      store.putProofCas(
        {
          ...proofRow(fixture.walletScopeId),
          proofId: prepared.record.operation.reservation.inputs[0]!.proofId,
        },
        null,
      )
      const transaction = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 3)
      applyDurableCustodyTransaction(
        transaction,
        {
          scope: prepared.record.scope,
          owner: {
            incarnationId: fence.incarnationId,
            fencingEpoch: fence.fencingEpoch,
            observedAtMs: 3,
          },
          operationRows: [
            {
              operationId: prepared.record.operation.operationId,
              expectedRevision: null,
            },
          ],
        },
        (selected) =>
          bindDurableCustodyProofOperation(selected, prepared.record, {
            requestBody: prepared.artifacts[0][1],
            output: prepared.artifacts[1][1],
            privateMaterial: prepared.artifacts[2][1],
          }),
      )
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const transaction = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 4)
      applyDurableCustodyTransaction(
        transaction,
        {
          scope: prepared.record.scope,
          owner: {
            incarnationId: fence.incarnationId,
            fencingEpoch: fence.fencingEpoch,
            observedAtMs: 4,
          },
          operationRows: [
            {
              operationId: prepared.record.operation.operationId,
              expectedRevision: 0,
            },
          ],
        },
        (selected) =>
          bindDurableCustodyProofOperation(selected, prepared.record, {
            requestBody: prepared.artifacts[0][1],
            output: prepared.artifacts[1][1],
            privateMaterial: prepared.artifacts[2][1],
          }),
      )
      assert.throws(
        () =>
          transaction.reserveExactInputs({
            operationId: prepared.record.operation.operationId,
            expectedRevision: 0,
            reservationId: 'foreign-reservation',
            proofIds: prepared.record.operation.reservation.inputs.map(({ proofId }) => proofId),
          }),
        /foreign/,
      )
      assert.throws(
        () =>
          transaction.reserveExactInputs({
            operationId: prepared.record.operation.operationId,
            expectedRevision: 1,
            reservationId: prepared.record.operation.reservation.reservationId,
            proofIds: prepared.record.operation.reservation.inputs.map(({ proofId }) => proofId),
          }),
        /revision CAS/,
      )
    })
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.deepEqual(
        new DurableCustodySqliteStore(database).getOperation(prepared.record.operation.operationId),
        prepared.record,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('history paging uses exact multibyte UTF-8 page bytes at max and max plus one', () => {
  const prefix: CustodyHistoryRow[] = Array.from({ length: 255 }, (_, index) => ({
    operationId: `界-${index}`,
    revision: 0,
    semanticKind: 'wallet-send',
    operationState: 'dispatch-intent',
    updatedAtMs: index,
  }))
  const finalRow = {
    operationId: '',
    revision: 0,
    semanticKind: 'wallet-send',
    operationState: 'dispatch-intent',
    updatedAtMs: 256,
  }
  const emptyBytes = custodyHistorySerializedPageBytes([...prefix, finalRow], null)
  const remaining = DAEMON_HISTORY_PAGE_BYTES_MAX - emptyBytes
  assert.ok(remaining > 0)
  finalRow.operationId = '界'.repeat(Math.floor(remaining / 3))
  const padding =
    DAEMON_HISTORY_PAGE_BYTES_MAX - custodyHistorySerializedPageBytes([...prefix, finalRow], null)
  assert.ok(padding >= 0)
  finalRow.operationId += 'a'.repeat(padding)
  const exact = takeBoundedCustodyHistoryRows([...prefix, finalRow])
  assert.equal(exact.rows.length, 256)
  assert.equal(exact.serializedBytes, DAEMON_HISTORY_PAGE_BYTES_MAX)
  const maxPlusOne = takeBoundedCustodyHistoryRows([
    ...prefix,
    { ...finalRow, operationId: `${finalRow.operationId}a` },
  ])
  assert.equal(maxPlusOne.rows.length, 255)
  assert.ok(maxPlusOne.serializedBytes < DAEMON_HISTORY_PAGE_BYTES_MAX)
})

test('row-scoped active rebuild and transition preserve unrelated operation work', async () => {
  const fixture = await profile()
  try {
    const first = exactIntent(fixture.walletScopeId, 'a')
    const second = exactIntent(fixture.walletScopeId, 'b')
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'incarnation-index',
      observedAtMs: 2,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      for (const prepared of [first, second]) {
        store.putProofCas(
          {
            ...proofRow(fixture.walletScopeId),
            proofId: prepared.record.operation.reservation.inputs[0]!.proofId,
          },
          null,
        )
        const transaction = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 3)
        applyDurableCustodyTransaction(
          transaction,
          {
            scope: prepared.record.scope,
            owner: {
              incarnationId: fence.incarnationId,
              fencingEpoch: fence.fencingEpoch,
              observedAtMs: 3,
            },
            operationRows: [
              {
                operationId: prepared.record.operation.operationId,
                expectedRevision: null,
              },
            ],
          },
          (selected) =>
            bindDurableCustodyProofOperation(selected, prepared.record, {
              requestBody: prepared.artifacts[0][1],
              output: prepared.artifacts[1][1],
              privateMaterial: prepared.artifacts[2][1],
            }),
        )
      }
      const firstTransaction = new DurableCustodyTransactionSqlite(
        database,
        fixture.walletScopeId,
        4,
      )
      applyDurableCustodyTransaction(
        firstTransaction,
        {
          scope: first.record.scope,
          owner: {
            incarnationId: fence.incarnationId,
            fencingEpoch: fence.fencingEpoch,
            observedAtMs: 4,
          },
          operationRows: [
            {
              operationId: first.record.operation.operationId,
              expectedRevision: 0,
            },
          ],
        },
        (selected) =>
          selected.transitionOperation({
            operationId: first.record.operation.operationId,
            expectedRevision: 0,
            transition: {
              kind: 'mark-transport-attempted',
              authorization: {
                incarnationId: fence.incarnationId,
                fencingEpoch: fence.fencingEpoch,
                observedAtMs: 4,
              },
              expectedRevision: 0,
            },
          }),
      )
      const rebuild = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 4)
      rebuild.rebuildActiveWorkIndex({
        scopeId: fixture.walletScopeId,
        operationRows: [
          {
            operationId: first.record.operation.operationId,
            expectedRevision: 1,
          },
        ],
      })
      assert.equal(
        (
          database
            .prepare('SELECT count(*) AS count FROM custody_active_work WHERE scope_id = ?')
            .get(fixture.walletScopeId) as { count: number }
        ).count,
        2,
      )
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('verified apply requires exact same-UoW successor proof CAS and rolls failures back', async () => {
  const fixture = await profile()
  try {
    const prepared = exactIntent(fixture.walletScopeId, 'admission', 2)
    const operationId = prepared.record.operation.operationId
    const [successorId, secondSuccessorId] = prepared.record.operation.proofStorage.lineage
      .successorProofIds as [string, string]
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'incarnation-admission',
      observedAtMs: 2,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      store.putProofCas(
        {
          ...proofRow(fixture.walletScopeId),
          proofId: prepared.record.operation.reservation.inputs[0]!.proofId,
        },
        null,
      )
      const bind = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 3)
      applyDurableCustodyTransaction(
        bind,
        {
          scope: prepared.record.scope,
          owner: {
            incarnationId: fence.incarnationId,
            fencingEpoch: fence.fencingEpoch,
            observedAtMs: 3,
          },
          operationRows: [{ operationId, expectedRevision: null }],
        },
        (selected) =>
          bindDurableCustodyProofOperation(selected, prepared.record, {
            requestBody: prepared.artifacts[0][1],
            output: prepared.artifacts[1][1],
            privateMaterial: prepared.artifacts[2][1],
          }),
      )
      const authority = {
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: 4,
      }
      const transition = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 4)
      transition.transitionOperation({
        operationId,
        expectedRevision: 0,
        transition: {
          kind: 'mark-transport-attempted',
          authorization: authority,
          expectedRevision: 0,
        },
      })
      const result = artifact({ proofs: [successorId] })
      transition.stageVerifiedResult({
        operationId,
        expectedRevision: 1,
        authorization: authority,
        outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-admission',
        resultFingerprint: result.fingerprint,
        exactResult: result,
        selectedSuccessorProofIds: prepared.record.operation.proofStorage.lineage.successorProofIds,
      })
      const evidence = {
        scopeId: fixture.walletScopeId,
        operationId,
        admissionId: 'admission-exact',
        proofRows: [successorId, secondSuccessorId].map((proofId) => ({
          proofId,
          expectedRevision: null,
          admittedRevision: 0,
        })),
      }
      assert.throws(
        () =>
          new DurableCustodyTransactionSqlite(
            database,
            fixture.walletScopeId,
            5,
          ).applyVerifiedResult({
            operationId,
            expectedRevision: 2,
            authorization: { ...authority, observedAtMs: 5 },
            outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: 'result-admission',
            resultFingerprint: result.fingerprint,
            successorAdmission: evidence,
          }),
        /incomplete/,
      )
      assert.equal(store.getOperation(operationId)?.revision, 2)

      const desiredProof = {
        ...proofRow(fixture.walletScopeId),
        proofId: successorId,
        createdAtMs: 5,
        updatedAtMs: 5,
      }
      const secondDesiredProof = {
        ...desiredProof,
        proofId: secondSuccessorId,
      }
      for (const override of [
        { outputPlanFingerprint: 'e'.repeat(64) },
        { resultHandle: 'foreign-result-handle' },
        { resultFingerprint: 'd'.repeat(64) },
      ]) {
        const mismatch = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 5)
        mismatch.stageSuccessorProofCas(operationId, [
          { proof: desiredProof, expectedRevision: null },
          { proof: secondDesiredProof, expectedRevision: null },
        ])
        assert.throws(
          () =>
            mismatch.applyVerifiedResult({
              operationId,
              expectedRevision: 2,
              authorization: { ...authority, observedAtMs: 5 },
              outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
              resultHandle: 'result-admission',
              resultFingerprint: result.fingerprint,
              successorAdmission: evidence,
              ...override,
            }),
          /staged result authority/,
        )
        assert.equal(store.getOperation(operationId)?.revision, 2)
        assert.equal(store.getProof(fixture.walletScopeId, successorId), null)
        assert.equal(
          (
            database
              .prepare(
                `SELECT count(*) AS count FROM custody_successor_admissions
                 WHERE scope_id = ? AND operation_id = ?`,
              )
              .get(fixture.walletScopeId, operationId) as { count: number }
          ).count,
          0,
        )
      }
      const foreignResultArtifactId = 'artifact:custody-operation:foreign:result'
      database
        .prepare(
          `INSERT INTO custody_artifacts (
             artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
             revision, private_material, created_at_ms
           ) VALUES (?, ?, 'exact-result', 'canonical-json', ?, ?, 0, 0, 5)`,
        )
        .run(
          foreignResultArtifactId,
          fixture.walletScopeId,
          new TextEncoder().encode(JSON.stringify(result.artifact)),
          result.fingerprint,
        )
      database
        .prepare(
          `UPDATE custody_operations SET result_artifact_id = ?
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(foreignResultArtifactId, fixture.walletScopeId, operationId)
      const misbound = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 5)
      misbound.stageSuccessorProofCas(operationId, [
        { proof: desiredProof, expectedRevision: null },
        { proof: secondDesiredProof, expectedRevision: null },
      ])
      assert.throws(
        () =>
          misbound.applyVerifiedResult({
            operationId,
            expectedRevision: 2,
            authorization: { ...authority, observedAtMs: 5 },
            outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: 'result-admission',
            resultFingerprint: result.fingerprint,
            successorAdmission: evidence,
          }),
        /artifact authority/,
      )
      assert.equal(store.getProof(fixture.walletScopeId, successorId), null)
      database
        .prepare(
          `UPDATE custody_operations SET result_artifact_id = ?
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(`artifact:${operationId}:result`, fixture.walletScopeId, operationId)
      const foreign = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 5)
      foreign.stageSuccessorProofCas(operationId, [
        { proof: { ...desiredProof, proofId: 'f'.repeat(64) }, expectedRevision: null },
        { proof: secondDesiredProof, expectedRevision: null },
      ])
      assert.throws(
        () =>
          foreign.applyVerifiedResult({
            operationId,
            expectedRevision: 2,
            authorization: { ...authority, observedAtMs: 5 },
            outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: 'result-admission',
            resultFingerprint: result.fingerprint,
            successorAdmission: evidence,
          }),
        /foreign/,
      )
      assert.equal(store.getProof(fixture.walletScopeId, 'f'.repeat(64)), null)

      store.putProofCas(
        {
          ...secondDesiredProof,
          proofFingerprint: 'c'.repeat(64),
          proofBody: new TextEncoder().encode('{"foreign":true}'),
        },
        null,
      )
      const stale = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 5)
      stale.stageSuccessorProofCas(operationId, [
        { proof: desiredProof, expectedRevision: null },
        { proof: secondDesiredProof, expectedRevision: 0 },
      ])
      assert.throws(
        () =>
          stale.applyVerifiedResult({
            operationId,
            expectedRevision: 2,
            authorization: { ...authority, observedAtMs: 5 },
            outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: 'result-admission',
            resultFingerprint: result.fingerprint,
            successorAdmission: {
              ...evidence,
              proofRows: [
                {
                  proofId: successorId,
                  expectedRevision: null,
                  admittedRevision: 0,
                },
                {
                  proofId: secondSuccessorId,
                  expectedRevision: 0,
                  admittedRevision: 0,
                },
              ],
            },
          }),
        /stale or foreign/,
      )
      assert.equal(store.getOperation(operationId)?.revision, 2)
      assert.equal(store.getProof(fixture.walletScopeId, successorId), null)
      database
        .prepare('DELETE FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
        .run(fixture.walletScopeId, secondSuccessorId)

      const success = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 5)
      success.stageSuccessorProofCas(operationId, [
        { proof: desiredProof, expectedRevision: null },
        { proof: secondDesiredProof, expectedRevision: null },
      ])
      success.applyVerifiedResult({
        operationId,
        expectedRevision: 2,
        authorization: { ...authority, observedAtMs: 5 },
        outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-admission',
        resultFingerprint: result.fingerprint,
        successorAdmission: evidence,
      })
      assert.equal(store.getOperation(operationId)?.revision, 3)
      assert.equal(store.getProof(fixture.walletScopeId, successorId)?.revision, 0)
      assert.equal(store.getProof(fixture.walletScopeId, secondSuccessorId)?.revision, 0)
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('subset successor authority admits only the durably selected proof', async () => {
  const fixture = await profile()
  try {
    const prepared = exactIntent(fixture.walletScopeId, 'subset', 2)
    prepared.record.operation.proofStorage.lineage.successorAdmissionMode = 'subset'
    const operationId = prepared.record.operation.operationId
    const [selectedId, unselectedId] =
      prepared.record.operation.proofStorage.lineage.successorProofIds
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'incarnation-subset',
      observedAtMs: 2,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      store.putProofCas(
        {
          ...proofRow(fixture.walletScopeId),
          proofId: prepared.record.operation.reservation.inputs[0]!.proofId,
        },
        null,
      )
      const owner = {
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: 3,
      }
      applyDurableCustodyTransaction(
        new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 3),
        {
          scope: prepared.record.scope,
          owner,
          operationRows: [{ operationId, expectedRevision: null }],
        },
        (selected) =>
          bindDurableCustodyProofOperation(selected, prepared.record, {
            requestBody: prepared.artifacts[0][1],
            output: prepared.artifacts[1][1],
            privateMaterial: prepared.artifacts[2][1],
          }),
      )
      assert.throws(
        () =>
          database
            .prepare(
              `UPDATE custody_operations SET successor_selection_staged = 1
               WHERE scope_id = ? AND operation_id = ?`,
            )
            .run(fixture.walletScopeId, operationId),
        /constraint failed/i,
      )
      const result = artifact({ proofs: [selectedId] })
      const transaction = new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 4)
      transaction.stageVerifiedResult({
        operationId,
        expectedRevision: 0,
        authorization: { ...owner, observedAtMs: 4 },
        outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-subset',
        resultFingerprint: result.fingerprint,
        exactResult: result,
        selectedSuccessorProofIds: [selectedId!],
      })
      const selectedRowId = (
        database
          .prepare(
            `SELECT rowid AS rowId FROM custody_selected_successors
             WHERE scope_id = ? AND operation_id = ?`,
          )
          .get(fixture.walletScopeId, operationId) as { rowId: number }
      ).rowId
      const proof = { ...proofRow(fixture.walletScopeId), proofId: selectedId! }
      transaction.stageSuccessorProofCas(operationId, [{ proof, expectedRevision: null }])
      transaction.applyVerifiedResult({
        operationId,
        expectedRevision: 1,
        authorization: { ...owner, observedAtMs: 5 },
        outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-subset',
        resultFingerprint: result.fingerprint,
        successorAdmission: {
          scopeId: fixture.walletScopeId,
          operationId,
          admissionId: 'admission-subset',
          proofRows: [{ proofId: selectedId!, expectedRevision: null, admittedRevision: 0 }],
        },
      })
      const stored = store.getOperation(operationId)!
      assert.equal(stored.operation.state, 'reconciled')
      assert.deepEqual(stored.operation.proofStorage.lineage.selectedSuccessorProofIds, [
        selectedId,
      ])
      assert.equal(store.getProof(fixture.walletScopeId, selectedId!)?.revision, 0)
      assert.equal(store.getProof(fixture.walletScopeId, unselectedId!), null)
      assert.equal(
        (
          database
            .prepare(
              `SELECT rowid AS rowId FROM custody_selected_successors
               WHERE scope_id = ? AND operation_id = ?`,
            )
            .get(fixture.walletScopeId, operationId) as { rowId: number }
        ).rowId,
        selectedRowId,
      )
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('SQLite custody adapter satisfies the shared conformance contract', async () => {
  await assertDurableCustodyAdapterConformance((suffix) => SqliteConformanceHarness.create(suffix))
})

test('an empty staged successor selection survives a SQLite reopen', async () => {
  const fixture = await profile()
  try {
    const prepared = exactIntent(fixture.walletScopeId, 'empty-selection', 0)
    const operationId = prepared.record.operation.operationId
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: 'incarnation-empty-selection',
      observedAtMs: 2,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      store.putProofCas(
        {
          ...proofRow(fixture.walletScopeId),
          proofId: prepared.record.operation.reservation.inputs[0]!.proofId,
        },
        null,
      )
      const owner = {
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: 3,
      }
      applyDurableCustodyTransaction(
        new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 3),
        {
          scope: prepared.record.scope,
          owner,
          operationRows: [{ operationId, expectedRevision: null }],
        },
        (selected) =>
          bindDurableCustodyProofOperation(selected, prepared.record, {
            requestBody: prepared.artifacts[0][1],
            output: prepared.artifacts[1][1],
            privateMaterial: prepared.artifacts[2][1],
          }),
      )
      const result = artifact({ proofs: [] })
      new DurableCustodyTransactionSqlite(database, fixture.walletScopeId, 4).stageVerifiedResult({
        operationId,
        expectedRevision: 0,
        authorization: { ...owner, observedAtMs: 4 },
        outputPlanFingerprint: prepared.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: 'result-empty-selection',
        resultFingerprint: result.fingerprint,
        exactResult: result,
        selectedSuccessorProofIds: [],
      })
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const stored = new DurableCustodySqliteStore(database).getOperation(operationId)!
      assert.equal(stored.operation.result.state, 'verified-staged')
      assert.deepEqual(stored.operation.proofStorage.lineage.selectedSuccessorProofIds, [])
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

class SqliteConformanceHarness implements DurableCustodyAdapterConformanceHarness {
  readonly successorProofIds: readonly string[]
  readonly #directory: string
  readonly #scopeId: string
  readonly #prepared: DurableCustodyConformancePrepared
  readonly #fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>

  private constructor(
    directory: string,
    scopeId: string,
    prepared: DurableCustodyConformancePrepared,
    fence: Awaited<ReturnType<typeof claimCustodyScopeLease>>,
  ) {
    this.#directory = directory
    this.#scopeId = scopeId
    this.#prepared = prepared
    this.#fence = fence
    this.successorProofIds = prepared.successorProofIds
  }

  static async create(suffix: string): Promise<SqliteConformanceHarness> {
    const fixture = await profile()
    const scope = {
      scopeKind: 'wallet' as const,
      walletId: fixture.walletScopeId.slice('custody:wallet:'.length),
      scopeId: fixture.walletScopeId,
    }
    const prepared = createDurableCustodyConformancePrepared(scope, suffix)
    const fence = await claimCustodyScopeLease(fixture.directory, {
      scopeId: fixture.walletScopeId,
      incarnationId: `incarnation-conformance-${suffix}`,
      observedAtMs: 2,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      new DurableCustodySqliteStore(database).putProofCas(
        {
          ...proofRow(fixture.walletScopeId),
          proofId: prepared.predecessorProofId,
        },
        null,
      )
    })
    return new SqliteConformanceHarness(fixture.directory, fixture.walletScopeId, prepared, fence)
  }

  async bind(injectFault = false): Promise<void> {
    await withDaemonStateSqliteTransaction(this.#directory, (database) => {
      const transaction = new DurableCustodyTransactionSqlite(database, this.#scopeId, 3)
      applyDurableCustodyTransaction(
        transaction,
        {
          scope: this.#prepared.record.scope,
          owner: this.#owner(3),
          operationRows: [
            {
              operationId: this.#prepared.record.operation.operationId,
              expectedRevision: null,
            },
          ],
        },
        (selected) =>
          bindDurableCustodyProofOperation(
            selected,
            this.#prepared.record,
            this.#prepared.artifacts,
          ),
      )
      if (injectFault) throw new Error('injected bind fault')
    })
  }

  async stageSelection(selectedProofIds: readonly string[], injectFault = false): Promise<void> {
    await withDaemonStateSqliteTransaction(this.#directory, (database) => {
      const record = new DurableCustodySqliteStore(database).getOperation(
        this.#prepared.record.operation.operationId,
      )
      if (record === null) throw new Error('conformance operation is absent')
      new DurableCustodyTransactionSqlite(database, this.#scopeId, 4).stageVerifiedResult({
        operationId: record.operation.operationId,
        expectedRevision: record.revision,
        authorization: this.#owner(4),
        outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: `conformance-result:${this.#prepared.result.fingerprint}`,
        resultFingerprint: this.#prepared.result.fingerprint,
        exactResult: this.#prepared.result,
        selectedSuccessorProofIds: [...selectedProofIds],
      })
      if (injectFault) throw new Error('injected stage fault')
    })
  }

  async applySelection(selectedProofIds: readonly string[], injectFault = false): Promise<void> {
    await withDaemonStateSqliteTransaction(this.#directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(this.#prepared.record.operation.operationId)
      if (record === null) throw new Error('conformance operation is absent')
      const transaction = new DurableCustodyTransactionSqlite(database, this.#scopeId, 5)
      transaction.stageSuccessorProofCas(
        record.operation.operationId,
        selectedProofIds.map((proofId) => ({
          proof: { ...proofRow(this.#scopeId), proofId },
          expectedRevision: null,
        })),
      )
      transaction.applyVerifiedResult({
        operationId: record.operation.operationId,
        expectedRevision: record.revision,
        authorization: this.#owner(5),
        outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: record.operation.result.resultHandle!,
        resultFingerprint: record.operation.result.resultFingerprint!,
        successorAdmission: {
          scopeId: this.#scopeId,
          operationId: record.operation.operationId,
          admissionId: `conformance-admission:${record.operation.operationId}`,
          proofRows: selectedProofIds.map((proofId) => ({
            proofId,
            expectedRevision: null,
            admittedRevision: 0,
          })),
        },
      })
      if (injectFault) throw new Error('injected apply fault')
    })
  }

  reopen(): SqliteConformanceHarness {
    return new SqliteConformanceHarness(this.#directory, this.#scopeId, this.#prepared, this.#fence)
  }

  async snapshot(): Promise<DurableCustodyAdapterConformanceSnapshot> {
    const database = await openDaemonStateSqlite(this.#directory)
    try {
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(this.#prepared.record.operation.operationId)
      const artifactCount = (
        database
          .prepare('SELECT count(*) AS count FROM custody_artifacts WHERE scope_id = ?')
          .get(this.#scopeId) as { count: number }
      ).count
      return {
        operationState: record?.operation.state ?? null,
        resultState: record?.operation.result.state ?? null,
        selectedSuccessorProofIds:
          record?.operation.proofStorage.lineage.selectedSuccessorProofIds ?? null,
        artifactCount,
        admittedSuccessorProofIds: this.successorProofIds.filter(
          (proofId) => store.getProof(this.#scopeId, proofId) !== null,
        ),
      }
    } finally {
      database.close()
    }
  }

  async dispose(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true })
  }

  #owner(observedAtMs: number) {
    return {
      incarnationId: this.#fence.incarnationId,
      fencingEpoch: this.#fence.fencingEpoch,
      observedAtMs,
    }
  }
}

function artifact(value: unknown): DurableCustodyExactArtifact {
  return {
    encoding: 'canonical-json',
    artifact: value,
    fingerprint: deriveDurableCustodyArtifactFingerprint(value),
  }
}

function exactIntent(scopeId: string, suffix = '1', successorCount = 1) {
  const scope = {
    scopeKind: 'wallet' as const,
    walletId: scopeId.slice('custody:wallet:'.length),
    scopeId,
  }
  const request = artifact({ request: 1 })
  const output = artifact({ output: 1 })
  const privateMaterial = artifact({ private: 1 })
  const proofId = deriveDurableCustodyProofId({
    scopeId,
    normalizedMint: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-1',
    secret: `predecessor-secret-${suffix}`,
  })
  const successorIds = Array.from({ length: successorCount }, (_, index) =>
    deriveDurableCustodyProofId({
      scopeId,
      normalizedMint: 'https://mint.example',
      unit: 'sat',
      keysetId: 'keyset-1',
      secret: `successor-secret-${suffix}-${index}`,
    }),
  )
  const facts = createDurableProofOperationFacts({
    unit: 'sat',
    binding: {
      kind: 'wallet',
      activityId: `activity-${suffix}`,
      stage: 'send',
    },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: successorCount > 0,
    inputKeysetRequirement: 'required',
    keysets: [
      {
        keysetId: 'keyset-1',
        unit: 'sat',
        curve: 'secp256k1',
        publicKeys: { '1': `02${'11'.repeat(32)}` },
        keysetExpiryMs: null,
        requireDleq: false,
        usedByInputs: true,
        usedByOutputs: successorCount > 0,
      },
    ],
  })
  const record = createDurableCustodyDispatchIntent({
    scope,
    retainedOperationKey: `retained-${suffix}`,
    semanticKind: 'wallet-send',
    facts,
    normalizedMint: 'https://mint.example',
    inventoryAccountId: null,
    reservation: {
      reservationId: `reservation-${suffix}`,
      parentReservationId: null,
      inputs: [{ proofId, keysetId: 'keyset-1', curve: 'secp256k1' }],
    },
    proofLineage: {
      predecessorProofIds: [proofId],
      successorProofIds: successorIds,
      successorAdmissionMode: 'exact',
    },
    exactRequest: {
      requestId: `request-${suffix}`,
      requestFingerprint: request.fingerprint,
      payloadHandle: `payload-${suffix}`,
      inputProofIds: [proofId],
      outputPlanFingerprint: output.fingerprint,
      method: 'POST',
      path: '/v1/swap',
      idempotencyKey: `idempotency-${suffix}`,
      body: request,
    },
    outputPlan: {
      outputPlanId: `output-plan-${suffix}`,
      outputPlanFingerprint: output.fingerprint,
      outputMaterialHandle: `output-material-${suffix}`,
      exactOutput: output,
    },
    privateMaterial: {
      materialHandle: `private-material-${suffix}`,
      useId: `private-use-${suffix}`,
      publicFingerprint: privateMaterial.fingerprint,
      exactPrivateMaterial: privateMaterial,
    },
  })
  return {
    record,
    artifacts: [
      [record.operation.exactRequest.body, request],
      [record.operation.outputPlan.exactOutput, output],
      [record.operation.privateMaterial.exactPrivateMaterial, privateMaterial],
    ] as const,
  }
}

function proofRow(scopeId: string): CustodyProofSqliteRow {
  return {
    proofId: 'a'.repeat(64),
    scopeId,
    normalizedMint: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-1',
    amount: 1,
    baseAsset: 'sat',
    conditionId: null,
    outcomeSetId: null,
    productBinding: null,
    proofBody: new TextEncoder().encode('{"proof":1}'),
    proofFingerprint: 'b'.repeat(64),
    curve: 'secp256k1',
    signatureVerified: true,
    dleqState: 'not-present',
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    createdAtMs: 3,
    updatedAtMs: 3,
  }
}

function insertMinimalOperation(
  database: Awaited<ReturnType<typeof openDaemonStateSqlite>>,
  input: {
    scopeId: string
    operationId: string
    requestId: string
    outputId: string
    privateId: string
    hasOutputs?: boolean
  },
): void {
  database
    .prepare(
      `INSERT INTO custody_operations (
         operation_id, scope_id, schema_version, revision, retained_operation_key,
         semantic_kind, operation_state, activity_id, wallet_stage,
         normalized_mint, unit, inventory_account_id, reservation_id,
         parent_reservation_id, input_count, request_id, payload_handle,
         request_method, request_path, idempotency_key, request_fingerprint,
         request_artifact_id, output_plan_fingerprint, output_plan_id,
         output_material_handle, output_artifact_id, private_material_handle,
         private_use_id, private_public_fingerprint, private_artifact_id,
         result_state, result_handle, result_artifact_id, result_fingerprint,
         result_output_plan_fingerprint, proof_storage_class,
         successor_admission_mode, successor_selection_staged,
         verification_output_plan_fingerprint, verification_has_outputs,
         transport_attempted, retry_attempt, retry_reason, next_attempt_at_ms,
         not_before_ms, not_after_ms, safety_margin_ms, keyset_expiry_ms,
         terminal_replay_evidence_required, created_at_ms, updated_at_ms
       ) VALUES (
         ?, ?, 1, 0, 'retained-1', 'wallet-send', 'dispatch-intent',
         'activity-1', 'send', 'https://mint.example', 'sat', NULL,
         ?, NULL, 0, 'request-1', 'payload-1',
         'POST', '/v1/swap', 'idem-1',
         ?, ?, ?, 'output-plan-1', 'output-material-1', ?,
         'private-material-1', 'private-use-1', ?, ?,
         'none', NULL, NULL, NULL, NULL,
         'pinned-operation-bound-deterministic', 'exact', 0, ?, ?,
         0, 0, 'none', NULL, NULL, NULL, 0, NULL, 0, 2, 2
       )`,
    )
    .run(
      input.operationId,
      input.scopeId,
      `reservation:${input.operationId}`,
      '1'.repeat(64),
      input.requestId,
      '2'.repeat(64),
      input.outputId,
      '3'.repeat(64),
      input.privateId,
      '2'.repeat(64),
      Number(input.hasOutputs ?? true),
    )
}

function seedMinimalArtifacts(
  database: Awaited<ReturnType<typeof openDaemonStateSqlite>>,
  scopeId: string,
  operationId: string,
): { requestId: string; outputId: string; privateId: string } {
  const entries = [
    ['request', 'exact-request', 0],
    ['output', 'output-plan', 0],
    ['private', 'private-material', 1],
  ] as const
  for (const [suffix, kind, privateMaterial] of entries) {
    database
      .prepare(
        `INSERT INTO custody_artifacts (
           artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
           revision, private_material, created_at_ms
         ) VALUES (?, ?, ?, 'canonical-json', X'7b7d', ?, 0, ?, 2)`,
      )
      .run(
        `artifact:${operationId}:${suffix}`,
        scopeId,
        kind,
        suffix === 'request'
          ? '1'.repeat(64)
          : suffix === 'output'
            ? '2'.repeat(64)
            : '3'.repeat(64),
        privateMaterial,
      )
  }
  return {
    requestId: `artifact:${operationId}:request`,
    outputId: `artifact:${operationId}:output`,
    privateId: `artifact:${operationId}:private`,
  }
}
