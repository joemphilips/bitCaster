import type { DatabaseSync } from 'node:sqlite'
import {
  decodeDurableCustodyScopeState,
  createDurableCustodyArtifactReference,
  reduceDurableCustodyState,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
  type DurableCustodyTransition,
} from '@bitcaster-market/client-sdk/durableCustody'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import type { CustodyProofSqliteRow } from './durableCustodySqliteStore.ts'

export class DurableCustodyTransactionSqlite implements DurableCustodyTransaction {
  readonly #database: DatabaseSync
  readonly #scopeId: string
  readonly #nowMs: number
  readonly #store: DurableCustodySqliteStore
  readonly #pendingOperations = new Map<
    string,
    NonNullable<ReturnType<DurableCustodySqliteStore['getOperation']>>
  >()
  readonly #stagedSuccessors = new Map<
    string,
    Array<{ proof: CustodyProofSqliteRow; expectedRevision: number | null }>
  >()

  constructor(database: DatabaseSync, scopeId: string, nowMs: number) {
    this.#database = database
    this.#scopeId = scopeId
    this.#nowMs = nowMs
    this.#store = new DurableCustodySqliteStore(database)
  }

  getScopeState(): DurableCustodyScopeState {
    const row = this.#database
      .prepare(
        `SELECT fencing_epoch AS fencingEpoch,
           owner_incarnation_id AS ownerIncarnationId,
           lease_expires_at_ms AS leaseExpiresAtMs,
           high_water_mark_ms AS highWaterMarkMs
         FROM custody_scope_state WHERE scope_id = ?`,
      )
      .get(this.#scopeId) as {
      fencingEpoch: number
      ownerIncarnationId: string | null
      leaseExpiresAtMs: number | null
      highWaterMarkMs: number
    }
    return decodeDurableCustodyScopeState({
      schemaVersion: 1,
      scope: {
        scopeKind: 'wallet',
        walletId: this.#scopeId.slice('custody:wallet:'.length),
        scopeId: this.#scopeId,
      },
      fencingEpoch: row.fencingEpoch,
      owner:
        row.ownerIncarnationId === null
          ? null
          : {
              incarnationId: row.ownerIncarnationId,
              leaseExpiresAtMs: row.leaseExpiresAtMs,
            },
      effectiveClock: { highWaterMarkMs: row.highWaterMarkMs },
    })
  }

  getOperation(operationId: string) {
    return this.#pendingOperations.get(operationId) ?? this.#store.getOperation(operationId)
  }

  putOperation(input: Parameters<DurableCustodyTransaction['putOperation']>[0]) {
    this.#store.putOperation({ ...input, createdAtMs: this.#nowMs })
    this.#pendingOperations.set(input.record.operation.operationId, structuredClone(input.record))
  }

  getArtifact(input: Parameters<DurableCustodyTransaction['getArtifact']>[0]) {
    return this.#store.getArtifact(input)
  }

  putArtifact(input: Parameters<DurableCustodyTransaction['putArtifact']>[0]) {
    this.#store.putArtifact({ ...input, createdAtMs: this.#nowMs })
  }

  reserveExactInputs(input: Parameters<DurableCustodyTransaction['reserveExactInputs']>[0]): void {
    const operation = this.#requiredOperation(input.operationId, input.expectedRevision)
    if (
      operation.operation.reservation.reservationId !== input.reservationId ||
      input.proofIds.length !== operation.operation.reservation.inputs.length ||
      input.proofIds.some(
        (proofId, index) => proofId !== operation.operation.reservation.inputs[index]!.proofId,
      )
    ) {
      throw new Error('custody reservation authority is foreign')
    }
    input.proofIds.forEach((proofId, position) => {
      const existing = this.#database
        .prepare(
          `SELECT operation_id AS operationId, reservation_id AS reservationId,
             input_position AS inputPosition
           FROM custody_proof_reservations
           WHERE scope_id = ? AND proof_id = ?`,
        )
        .get(this.#scopeId, proofId) as
        | { operationId: string; reservationId: string; inputPosition: number }
        | undefined
      if (existing !== undefined) {
        const proof = this.#database
          .prepare(
            `SELECT selectability, reservation_operation_id AS reservationOperationId
             FROM custody_proofs WHERE scope_id = ? AND proof_id = ?`,
          )
          .get(this.#scopeId, proofId) as
          | { selectability: string; reservationOperationId: string | null }
          | undefined
        if (
          existing.operationId !== input.operationId ||
          existing.reservationId !== input.reservationId ||
          existing.inputPosition !== position ||
          proof?.selectability !== 'locked' ||
          proof.reservationOperationId !== input.operationId
        ) {
          throw new Error('custody proof reservation replay is foreign')
        }
        return
      }
      const reserved = this.#database
        .prepare(
          `INSERT INTO custody_proof_reservations (
             scope_id, proof_id, operation_id, reservation_id, input_position
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope_id, proof_id) DO NOTHING`,
        )
        .run(this.#scopeId, proofId, input.operationId, input.reservationId, position)
      if (reserved.changes !== 1) throw new Error('custody proof reservation CAS lost')
      const locked = this.#database
        .prepare(
          `UPDATE custody_proofs SET selectability = 'locked',
             reservation_operation_id = ?, revision = revision + 1,
             updated_at_ms = ?
           WHERE scope_id = ? AND proof_id = ?
             AND selectability = 'selectable'`,
        )
        .run(input.operationId, this.#nowMs, this.#scopeId, proofId)
      if (locked.changes !== 1) throw new Error('custody proof lock CAS lost')
    })
  }

  transitionOperation(
    input: Parameters<DurableCustodyTransaction['transitionOperation']>[0],
  ): void {
    this.#applyTransition(input.operationId, input.expectedRevision, input.transition)
    if (input.transition.kind === 'stage-outbox') {
      this.#store.putArtifact({
        scopeId: this.#scopeId,
        operationId: input.operationId,
        expectedOperationRevision: input.expectedRevision + 1,
        expectedArtifactRevision: null,
        reference: createDurableCustodyArtifactReference(
          `artifact:${input.operationId}:delivery`,
          input.transition.exactPayload,
        ),
        artifact: input.transition.exactPayload,
        createdAtMs: this.#nowMs,
      })
    }
  }

  stageVerifiedResult(
    input: Parameters<DurableCustodyTransaction['stageVerifiedResult']>[0],
  ): void {
    this.#applyTransition(input.operationId, input.expectedRevision, {
      kind: 'stage-verified-result',
      authorization: input.authorization,
      expectedRevision: input.expectedRevision,
      outputPlanFingerprint: input.outputPlanFingerprint,
      resultHandle: input.resultHandle,
      resultFingerprint: input.resultFingerprint,
      exactResult: input.exactResult,
      selectedSuccessorProofIds: input.selectedSuccessorProofIds,
    })
    this.#store.putArtifact({
      scopeId: this.#scopeId,
      operationId: input.operationId,
      expectedOperationRevision: input.expectedRevision + 1,
      expectedArtifactRevision: null,
      reference: createDurableCustodyArtifactReference(
        `artifact:${input.operationId}:result`,
        input.exactResult,
      ),
      artifact: input.exactResult,
      createdAtMs: this.#nowMs,
    })
  }

  applyVerifiedResult(
    input: Parameters<DurableCustodyTransaction['applyVerifiedResult']>[0],
  ): void {
    const stagedOperation = this.#requiredOperation(input.operationId, input.expectedRevision)
    const stagedResult = stagedOperation.operation.result
    if (
      stagedResult.state !== 'verified-staged' ||
      stagedResult.outputPlanFingerprint !== input.outputPlanFingerprint ||
      stagedResult.resultHandle !== input.resultHandle ||
      stagedResult.resultFingerprint !== input.resultFingerprint ||
      stagedResult.exactResult === null
    ) {
      throw new Error('custody staged result authority is foreign')
    }
    const exactResultRow = this.#store.getArtifact({
      scopeId: this.#scopeId,
      operationId: input.operationId,
      expectedOperationRevision: input.expectedRevision,
      reference: stagedResult.exactResult,
    })
    const canonicalResultReference =
      exactResultRow === null
        ? null
        : createDurableCustodyArtifactReference(
            `artifact:${input.operationId}:result`,
            exactResultRow.artifact,
          )
    if (
      exactResultRow === null ||
      canonicalResultReference === null ||
      canonicalResultReference.artifactId !== stagedResult.exactResult.artifactId ||
      canonicalResultReference.encoding !== stagedResult.exactResult.encoding ||
      canonicalResultReference.fingerprint !== stagedResult.exactResult.fingerprint ||
      canonicalResultReference.byteLength !== stagedResult.exactResult.byteLength
    ) {
      throw new Error('custody staged result artifact authority is foreign')
    }
    const staged = this.#stagedSuccessors.get(input.operationId) ?? []
    const planned = stagedOperation.operation.proofStorage.lineage.selectedSuccessorProofIds
    if (planned === null) {
      throw new Error('custody selected successor authority is absent')
    }
    if (
      staged.length !== planned.length ||
      input.successorAdmission.proofRows.length !== planned.length ||
      staged.some(({ proof, expectedRevision }, index) => {
        const evidence = input.successorAdmission.proofRows[index]
        return (
          proof.proofId !== planned[index] ||
          evidence?.proofId !== planned[index] ||
          evidence.expectedRevision !== expectedRevision ||
          evidence.admittedRevision !== proof.revision ||
          proof.scopeId !== this.#scopeId
        )
      })
    ) {
      throw new Error('custody successor proof admission is incomplete or foreign')
    }
    this.#database.exec('SAVEPOINT custody_apply_verified_result')
    try {
      for (const { proof, expectedRevision } of staged) {
        if (expectedRevision === null) {
          this.#store.putProofCas(proof, null)
        } else {
          const existing = this.#store.getProof(this.#scopeId, proof.proofId)
          if (
            existing === null ||
            existing.revision !== expectedRevision ||
            !proofRowsEqual(existing, proof)
          ) {
            throw new Error('custody successor proof CAS is stale or foreign')
          }
        }
      }
      this.#applyTransition(
        input.operationId,
        input.expectedRevision,
        {
          kind: 'apply-verified-result',
          authorization: input.authorization,
          expectedRevision: input.expectedRevision,
          successorAdmission: input.successorAdmission,
        },
        {
          outputPlanFingerprint: input.outputPlanFingerprint,
          resultHandle: input.resultHandle,
          resultFingerprint: input.resultFingerprint,
          resultArtifactId: stagedResult.exactResult.artifactId,
        },
      )
      this.#database.exec('RELEASE SAVEPOINT custody_apply_verified_result')
      this.#stagedSuccessors.delete(input.operationId)
    } catch (error) {
      this.#database.exec('ROLLBACK TO SAVEPOINT custody_apply_verified_result')
      this.#database.exec('RELEASE SAVEPOINT custody_apply_verified_result')
      throw error
    }
  }

  stageSuccessorProofCas(
    operationId: string,
    rows: readonly {
      proof: CustodyProofSqliteRow
      expectedRevision: number | null
    }[],
  ): void {
    if (this.#stagedSuccessors.has(operationId)) {
      throw new Error('custody successor proof CAS was already staged')
    }
    this.#stagedSuccessors.set(
      operationId,
      rows.map(({ proof, expectedRevision }) => ({
        proof: structuredClone(proof),
        expectedRevision,
      })),
    )
  }

  rebuildActiveWorkIndex(
    input: Parameters<DurableCustodyTransaction['rebuildActiveWorkIndex']>[0],
  ): void {
    if (input.scopeId !== this.#scopeId) throw new Error('custody index scope is foreign')
    for (const row of input.operationRows) {
      this.#database
        .prepare(
          `DELETE FROM custody_active_work
           WHERE scope_id = ? AND operation_id = ?`,
        )
        .run(this.#scopeId, row.operationId)
      const operation = this.getOperation(row.operationId)
      if (operation === null || operation.revision !== row.expectedRevision) continue
      if (operation.operation.state === 'reconciled' || operation.operation.state === 'aborted') {
        continue
      }
      const estimatedBytes = new TextEncoder().encode(JSON.stringify(operation)).length
      this.#database
        .prepare(
          `INSERT INTO custody_active_work (
             scope_id, operation_id, next_attempt_at_ms, estimated_bytes
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          this.#scopeId,
          row.operationId,
          operation.operation.retry.nextAttemptAtMs ?? this.#nowMs,
          estimatedBytes,
        )
    }
  }

  #applyTransition(
    operationId: string,
    expectedRevision: number,
    transition: DurableCustodyTransition,
    stagedAuthority?: {
      outputPlanFingerprint: string
      resultHandle: string
      resultFingerprint: string
      resultArtifactId: string
    },
  ): void {
    const current = this.#requiredOperation(operationId, expectedRevision)
    const next = reduceDurableCustodyState(
      { scopeState: this.getScopeState(), operation: current },
      transition,
    ).operation
    const operation = next.operation
    const updated = this.#database
      .prepare(
        `UPDATE custody_operations SET revision = ?, operation_state = ?,
           result_state = ?, result_handle = ?, result_artifact_id = ?,
           result_fingerprint = ?, result_output_plan_fingerprint = ?,
           proof_storage_class = ?, successor_selection_staged = ?,
           transport_attempted = ?,
           retry_attempt = ?, retry_reason = ?, next_attempt_at_ms = ?,
           updated_at_ms = ?
         WHERE scope_id = ? AND operation_id = ? AND revision = ?
           AND (? IS NULL OR (
             result_state = 'verified-staged'
             AND result_output_plan_fingerprint = ?
             AND result_handle = ?
             AND result_fingerprint = ?
             AND result_artifact_id = ?
           ))`,
      )
      .run(
        next.revision,
        operation.state,
        operation.result.state,
        operation.result.resultHandle,
        operation.result.exactResult?.artifactId ?? null,
        operation.result.resultFingerprint,
        operation.result.outputPlanFingerprint,
        operation.proofStorage.storageClass,
        Number(operation.proofStorage.lineage.selectedSuccessorProofIds !== null),
        Number(operation.state !== 'dispatch-intent'),
        operation.retry.attempt,
        operation.retry.reason,
        operation.retry.nextAttemptAtMs,
        this.#nowMs,
        this.#scopeId,
        operationId,
        expectedRevision,
        stagedAuthority?.resultArtifactId ?? null,
        stagedAuthority?.outputPlanFingerprint ?? null,
        stagedAuthority?.resultHandle ?? null,
        stagedAuthority?.resultFingerprint ?? null,
        stagedAuthority?.resultArtifactId ?? null,
      )
    if (updated.changes !== 1) throw new Error('custody operation transition CAS lost')
    this.#replaceLifecycleRows(
      next,
      !sameNullableProofIds(
        current.operation.proofStorage.lineage.selectedSuccessorProofIds,
        next.operation.proofStorage.lineage.selectedSuccessorProofIds,
      ),
    )
    this.#pendingOperations.set(operationId, structuredClone(next))
  }

  #replaceLifecycleRows(
    record: NonNullable<ReturnType<DurableCustodySqliteStore['getOperation']>>,
    replaceSelectedSuccessors: boolean,
  ): void {
    const operationId = record.operation.operationId
    if (replaceSelectedSuccessors) {
      this.#database
        .prepare('DELETE FROM custody_selected_successors WHERE scope_id = ? AND operation_id = ?')
        .run(this.#scopeId, operationId)
      const insertSelectedSuccessor = this.#database.prepare(
        `INSERT INTO custody_selected_successors (
           scope_id, operation_id, proof_position, proof_id
         ) VALUES (?, ?, ?, ?)`,
      )
      record.operation.proofStorage.lineage.selectedSuccessorProofIds?.forEach(
        (proofId, position) => {
          insertSelectedSuccessor.run(this.#scopeId, operationId, position, proofId)
        },
      )
    }
    this.#database
      .prepare('DELETE FROM custody_proof_pins WHERE scope_id = ? AND operation_id = ?')
      .run(this.#scopeId, operationId)
    for (const pinReason of record.operation.proofStorage.pinReasons) {
      for (const proofId of record.operation.proofStorage.lineage.predecessorProofIds) {
        this.#database
          .prepare(
            `INSERT INTO custody_proof_pins (
               scope_id, proof_id, pin_reason, operation_id, created_at_ms
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(this.#scopeId, proofId, pinReason, operationId, this.#nowMs)
      }
    }
    this.#database
      .prepare(
        'DELETE FROM custody_successor_admission_proofs WHERE scope_id = ? AND operation_id = ?',
      )
      .run(this.#scopeId, operationId)
    this.#database
      .prepare('DELETE FROM custody_successor_admissions WHERE scope_id = ? AND operation_id = ?')
      .run(this.#scopeId, operationId)
    const admission = record.operation.proofStorage.lineage.successorAdmission
    if (admission !== null) {
      this.#database
        .prepare(
          `INSERT INTO custody_successor_admissions (
             scope_id, operation_id, admission_id
           ) VALUES (?, ?, ?)`,
        )
        .run(this.#scopeId, operationId, admission.admissionId)
      admission.proofRows.forEach((proof, position) => {
        this.#database
          .prepare(
            `INSERT INTO custody_successor_admission_proofs (
               scope_id, operation_id, proof_position, proof_id,
               expected_revision, admitted_revision
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.#scopeId,
            operationId,
            position,
            proof.proofId,
            proof.expectedRevision,
            proof.admittedRevision,
          )
      })
    }
    this.#database
      .prepare('DELETE FROM custody_deliveries WHERE scope_id = ? AND operation_id = ?')
      .run(this.#scopeId, operationId)
    const delivery = record.operation.delivery
    if (delivery.deliveryKind === 'outbox') {
      this.#database
        .prepare(
          `INSERT INTO custody_deliveries (
             scope_id, operation_id, delivery_id, delivery_kind, state,
             payload_artifact_id, expires_at_ms, receipt_id,
             receipt_fingerprint, acknowledged_at_ms
           ) VALUES (?, ?, ?, 'outbox', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#scopeId,
          operationId,
          delivery.deliveryId,
          delivery.state,
          delivery.exactPayload.artifactId,
          delivery.expiresAtMs,
          delivery.receipt?.receiptId ?? null,
          delivery.receipt?.payloadFingerprint ?? null,
          delivery.receipt?.acknowledgedAtMs ?? null,
        )
    }
    this.#database
      .prepare('DELETE FROM custody_operation_tombstones WHERE scope_id = ? AND operation_id = ?')
      .run(this.#scopeId, operationId)
    if (record.terminalTombstone !== null) {
      this.#database
        .prepare(
          `INSERT INTO custody_operation_tombstones (
             scope_id, operation_id, tombstone_id, terminal_authority_id,
             authenticated_terminal_status, replay_cutoff_observed
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#scopeId,
          operationId,
          record.terminalTombstone.tombstoneId,
          record.terminalTombstone.terminalAuthorityId,
          Number(record.terminalTombstone.authenticatedTerminalStatus),
          Number(record.terminalTombstone.replayCutoffObserved),
        )
    }
    for (const [kind, reference] of [['result', record.operation.result.exactResult]] as const) {
      this.#database
        .prepare(
          `DELETE FROM custody_operation_artifact_links
           WHERE scope_id = ? AND operation_id = ? AND link_kind = ?`,
        )
        .run(this.#scopeId, operationId, kind)
      if (reference !== null) {
        this.#database
          .prepare(
            `INSERT INTO custody_operation_artifact_links (
               scope_id, operation_id, link_kind, position, artifact_id
             ) VALUES (?, ?, ?, 0, ?)`,
          )
          .run(this.#scopeId, operationId, kind, reference.artifactId)
      }
    }
  }

  #requiredOperation(operationId: string, revision: number) {
    const operation = this.getOperation(operationId)
    if (operation === null || operation.revision !== revision) {
      throw new Error('custody operation revision CAS is stale')
    }
    return operation
  }
}

function proofRowsEqual(left: CustodyProofSqliteRow, right: CustodyProofSqliteRow): boolean {
  const normalize = (row: CustodyProofSqliteRow) => ({
    ...row,
    proofBody: [...row.proofBody],
  })
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function sameNullableProofIds(left: string[] | null, right: string[] | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.length === right.length &&
      left.every((proofId, index) => proofId === right[index]))
  )
}
