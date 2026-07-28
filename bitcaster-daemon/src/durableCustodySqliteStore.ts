import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  assertDurableCustodyArtifactMatchesReference,
  decodeDurableCustodyRecord,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  encodeBoundedDurableArtifact,
  type DurableCustodyArtifactReference,
  type DurableCustodyArtifactRow,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from '@bitcaster-market/client-sdk/durableCustody'

export const CUSTODY_ACTIVE_PAGE_LIMIT = 256
export const CUSTODY_ACTIVE_PAGE_BYTES_MAX = 4 * 1_024 * 1_024

export interface CustodyProofSqliteRow {
  readonly proofId: string
  readonly scopeId: string
  readonly normalizedMint: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly amount: number
  readonly baseAsset: 'sat'
  readonly conditionId: string | null
  readonly outcomeSetId: string | null
  readonly productBinding: string | null
  readonly proofBody: Uint8Array
  readonly proofFingerprint: string
  readonly curve: 'secp256k1' | 'bls12-381'
  readonly signatureVerified: boolean
  readonly dleqState: 'not-present' | 'verified'
  readonly nut07State: 'UNSPENT' | 'PENDING' | 'SPENT'
  readonly selectability: 'selectable' | 'locked' | 'spent' | 'retained'
  readonly storageClass: 'pinned-operation-bound-deterministic' | 'terminal-replay-retained'
  readonly reservationOperationId: string | null
  readonly revision: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CustodyCounterSqliteRow {
  readonly scopeId: string
  readonly normalizedMint: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly nextCounter: number
  readonly revision: number
  readonly updatedAtMs: number
}

export interface CustodyActiveWorkRow {
  readonly scopeId: string
  readonly operationId: string
  readonly nextAttemptAtMs: number
  readonly estimatedBytes: number
}

export interface CustodyActiveWorkPage {
  readonly rows: readonly CustodyActiveWorkRow[]
  readonly nextCursor: string | null
  readonly estimatedBytes: number
}

export class DurableCustodySqliteStore {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  putOperation(input: {
    record: DurableCustodyRecord
    expectedRevision: number | null
    createdAtMs: number
  }): void {
    const record = decodeDurableCustodyRecord(input.record)
    if (input.expectedRevision !== null || record.revision !== 0) {
      throw new Error('custody operation put is not an exact insertion')
    }
    const operation = record.operation
    const inserted = this.#database
      .prepare(
        `INSERT INTO custody_operations (
          operation_id, scope_id, schema_version, revision,
          retained_operation_key, semantic_kind, operation_state,
          activity_id, wallet_stage, normalized_mint, unit,
          inventory_account_id, reservation_id, parent_reservation_id,
          input_count, request_id, payload_handle, request_method,
          request_path, idempotency_key, request_fingerprint,
          request_artifact_id, output_plan_fingerprint, output_plan_id,
          output_material_handle, output_artifact_id,
          private_material_handle, private_use_id, private_public_fingerprint,
          private_artifact_id, result_state, result_handle,
          result_artifact_id, result_fingerprint,
          result_output_plan_fingerprint, proof_storage_class,
          verification_output_plan_fingerprint, verification_has_outputs,
          transport_attempted, retry_attempt, retry_reason, next_attempt_at_ms,
          not_before_ms, not_after_ms, safety_margin_ms, keyset_expiry_ms,
          terminal_replay_evidence_required, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
        ) ON CONFLICT(operation_id) DO NOTHING`,
      )
      .run(
        operation.operationId,
        record.scope.scopeId,
        operation.retainedOperationKey,
        operation.semanticKind,
        operation.state,
        operation.binding.activityId,
        operation.binding.stage,
        operation.custodyContext.normalizedMint,
        operation.custodyContext.unit,
        operation.custodyContext.inventoryAccountId,
        operation.reservation.reservationId,
        operation.reservation.parentReservationId,
        operation.reservation.inputs.length,
        operation.exactRequest.requestId,
        operation.exactRequest.payloadHandle,
        operation.exactRequest.method,
        operation.exactRequest.path,
        operation.exactRequest.idempotencyKey,
        operation.exactRequest.requestFingerprint,
        operation.exactRequest.body.artifactId,
        operation.outputPlan.outputPlanFingerprint,
        operation.outputPlan.outputPlanId,
        operation.outputPlan.outputMaterialHandle,
        operation.outputPlan.exactOutput.artifactId,
        operation.privateMaterial.materialHandle,
        operation.privateMaterial.useId,
        operation.privateMaterial.publicFingerprint,
        operation.privateMaterial.exactPrivateMaterial.artifactId,
        operation.result.state,
        operation.result.resultHandle,
        operation.result.exactResult?.artifactId ?? null,
        operation.result.resultFingerprint,
        operation.result.outputPlanFingerprint,
        operation.proofStorage.storageClass,
        operation.verification.outputPlanFingerprint,
        Number(operation.verification.hasOutputs),
        Number(operation.state !== 'dispatch-intent'),
        operation.retry.attempt,
        operation.retry.reason,
        operation.retry.nextAttemptAtMs,
        operation.horizon.notBeforeMs,
        operation.horizon.notAfterMs,
        operation.horizon.safetyMarginMs,
        operation.horizon.keysetExpiryMs,
        Number(operation.terminalReplayEvidenceRequired),
        input.createdAtMs,
        input.createdAtMs,
      )
    if (inserted.changes !== 1) {
      throw new Error('custody operation insertion CAS lost')
    }
    operation.reservation.inputs.forEach((proof, position) => {
      this.#database
        .prepare(
          `INSERT INTO custody_operation_inputs (
             scope_id, operation_id, input_position, proof_id, keyset_id, curve
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.scope.scopeId,
          operation.operationId,
          position,
          proof.proofId,
          proof.keysetId,
          proof.curve,
        )
    })
    for (const [kind, ids] of [
      ['predecessor', operation.proofStorage.lineage.predecessorProofIds],
      ['successor', operation.proofStorage.lineage.successorProofIds],
    ] as const) {
      ids.forEach((proofId, position) => {
        this.#database
          .prepare(
            `INSERT INTO custody_proof_lineage (
               scope_id, operation_id, lineage_kind, lineage_position, proof_id
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(record.scope.scopeId, operation.operationId, kind, position, proofId)
      })
    }
    for (const pinReason of operation.proofStorage.pinReasons) {
      for (const proofId of operation.proofStorage.lineage.predecessorProofIds) {
        this.#database
          .prepare(
            `INSERT INTO custody_proof_pins (
               scope_id, proof_id, pin_reason, operation_id, created_at_ms
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(record.scope.scopeId, proofId, pinReason, operation.operationId, input.createdAtMs)
      }
    }
    operation.verification.keysetBindings.forEach((binding, position) => {
      this.#database
        .prepare(
          `INSERT INTO custody_verification_bindings (
             scope_id, operation_id, keyset_id, curve, keyset_fingerprint,
             require_dleq, binding_position
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.scope.scopeId,
          operation.operationId,
          binding.keysetId,
          binding.curve,
          binding.keysetFingerprint,
          Number(binding.requireDleq),
          position,
        )
    })
    for (const [kind, uses] of [
      ['input', operation.verification.inputKeysets],
      ['output', operation.verification.outputKeysets],
    ] as const) {
      uses.forEach((use, position) => {
        this.#database
          .prepare(
            `INSERT INTO custody_verification_keyset_uses (
               scope_id, operation_id, use_kind, use_position, keyset_id, curve
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(record.scope.scopeId, operation.operationId, kind, position, use.keysetId, use.curve)
      })
    }
    for (const [kind, reference] of [
      ['request', operation.exactRequest.body],
      ['output', operation.outputPlan.exactOutput],
      ['private', operation.privateMaterial.exactPrivateMaterial],
    ] as const) {
      this.#database
        .prepare(
          `INSERT INTO custody_operation_artifact_links (
             scope_id, operation_id, link_kind, position, artifact_id
           ) VALUES (?, ?, ?, 0, ?)`,
        )
        .run(record.scope.scopeId, operation.operationId, kind, reference.artifactId)
    }
  }

  getOperation(operationId: string): DurableCustodyRecord | null {
    const row = this.#database
      .prepare(
        `SELECT *,
           scope_id AS scopeId, operation_id AS operationId,
           retained_operation_key AS retainedOperationKey,
           semantic_kind AS semanticKind, operation_state AS operationState,
           activity_id AS activityId, wallet_stage AS walletStage,
           normalized_mint AS normalizedMint,
           inventory_account_id AS inventoryAccountId,
           reservation_id AS reservationId,
           parent_reservation_id AS parentReservationId,
           request_id AS requestId, payload_handle AS payloadHandle,
           request_method AS requestMethod, request_path AS requestPath,
           idempotency_key AS idempotencyKey,
           request_fingerprint AS requestFingerprint,
           request_artifact_id AS requestArtifactId,
           output_plan_fingerprint AS outputPlanFingerprint,
           output_plan_id AS outputPlanId,
           output_material_handle AS outputMaterialHandle,
           output_artifact_id AS outputArtifactId,
           private_material_handle AS privateMaterialHandle,
           private_use_id AS privateUseId,
           private_public_fingerprint AS privatePublicFingerprint,
           private_artifact_id AS privateArtifactId,
           result_state AS resultState, result_handle AS resultHandle,
           result_artifact_id AS resultArtifactId,
           result_fingerprint AS resultFingerprint,
           result_output_plan_fingerprint AS resultOutputPlanFingerprint,
           proof_storage_class AS proofStorageClass,
           verification_output_plan_fingerprint AS verificationOutputPlanFingerprint,
           verification_has_outputs AS verificationHasOutputs,
           retry_attempt AS retryAttempt, retry_reason AS retryReason,
           next_attempt_at_ms AS nextAttemptAtMs,
           not_before_ms AS notBeforeMs, not_after_ms AS notAfterMs,
           safety_margin_ms AS safetyMarginMs,
           keyset_expiry_ms AS keysetExpiryMs,
           terminal_replay_evidence_required AS terminalReplayEvidenceRequired
         FROM custody_operations WHERE operation_id = ?`,
      )
      .get(operationId) as OperationSqlRow | undefined
    if (row === undefined) return null
    const inputs = this.#database
      .prepare(
        `SELECT proof_id AS proofId, keyset_id AS keysetId, curve
         FROM custody_operation_inputs
         WHERE scope_id = ? AND operation_id = ?
         ORDER BY input_position`,
      )
      .all(row.scopeId, operationId) as unknown as Array<{
      proofId: string
      keysetId: string
      curve: 'secp256k1' | 'bls12-381'
    }>
    const lineage = (kind: 'predecessor' | 'successor') =>
      (
        this.#database
          .prepare(
            `SELECT proof_id AS proofId FROM custody_proof_lineage
             WHERE scope_id = ? AND operation_id = ? AND lineage_kind = ?
             ORDER BY lineage_position`,
          )
          .all(row.scopeId, operationId, kind) as unknown as Array<{
          proofId: string
        }>
      ).map(({ proofId }) => proofId)
    const bindings = this.#database
      .prepare(
        `SELECT keyset_id AS keysetId, curve,
           keyset_fingerprint AS keysetFingerprint,
           require_dleq AS requireDleq
         FROM custody_verification_bindings
         WHERE scope_id = ? AND operation_id = ? ORDER BY binding_position`,
      )
      .all(row.scopeId, operationId) as unknown as Array<{
      keysetId: string
      curve: 'secp256k1' | 'bls12-381'
      keysetFingerprint: string
      requireDleq: number
    }>
    const keysetUses = (kind: 'input' | 'output') =>
      this.#database
        .prepare(
          `SELECT keyset_id AS keysetId, curve
           FROM custody_verification_keyset_uses
           WHERE scope_id = ? AND operation_id = ? AND use_kind = ?
           ORDER BY use_position`,
        )
        .all(row.scopeId, operationId, kind) as unknown as Array<{
        keysetId: string
        curve: 'secp256k1' | 'bls12-381'
      }>
    const admissionHeader = this.#database
      .prepare(
        `SELECT admission_id AS admissionId
         FROM custody_successor_admissions
         WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(row.scopeId, operationId) as { admissionId: string } | undefined
    const admission =
      admissionHeader === undefined
        ? null
        : {
            scopeId: row.scopeId,
            operationId,
            admissionId: admissionHeader.admissionId,
            proofRows: this.#database
              .prepare(
                `SELECT proof_id AS proofId,
                   expected_revision AS expectedRevision,
                   admitted_revision AS admittedRevision
                 FROM custody_successor_admission_proofs
                 WHERE scope_id = ? AND operation_id = ?
                 ORDER BY proof_position`,
              )
              .all(row.scopeId, operationId) as unknown as Array<{
              proofId: string
              expectedRevision: number | null
              admittedRevision: number
            }>,
          }
    const deliveryRow = this.#database
      .prepare(
        `SELECT delivery_id AS deliveryId, state,
           payload_artifact_id AS payloadArtifactId,
           expires_at_ms AS expiresAtMs, receipt_id AS receiptId,
           receipt_fingerprint AS receiptFingerprint,
           acknowledged_at_ms AS acknowledgedAtMs
         FROM custody_deliveries WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(row.scopeId, operationId) as DeliverySqlRow | undefined
    const tombstone = this.#database
      .prepare(
        `SELECT tombstone_id AS tombstoneId,
           terminal_authority_id AS terminalAuthorityId,
           authenticated_terminal_status AS authenticatedTerminalStatus,
           replay_cutoff_observed AS replayCutoffObserved
         FROM custody_operation_tombstones
         WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(row.scopeId, operationId) as
      | {
          tombstoneId: string
          terminalAuthorityId: string
          authenticatedTerminalStatus: number
          replayCutoffObserved: number
        }
      | undefined
    const record: DurableCustodyRecord = {
      schemaVersion: 1,
      revision: row.revision,
      scope: {
        scopeKind: 'wallet',
        walletId: row.scopeId.slice('custody:wallet:'.length),
        scopeId: row.scopeId,
      },
      operation: {
        operationId,
        retainedOperationKey: row.retainedOperationKey,
        binding: {
          kind: 'wallet',
          activityId: row.activityId,
          stage: row.walletStage,
        },
        semanticKind: row.semanticKind,
        state: row.operationState,
        terminalReplayEvidenceRequired: Boolean(row.terminalReplayEvidenceRequired),
        custodyContext: {
          normalizedMint: row.normalizedMint,
          unit: row.unit,
          inventoryAccountId: row.inventoryAccountId,
        },
        reservation: {
          reservationId: row.reservationId,
          parentReservationId: row.parentReservationId,
          inputs,
        },
        exactRequest: {
          requestId: row.requestId,
          requestFingerprint: row.requestFingerprint,
          payloadHandle: row.payloadHandle,
          inputProofIds: inputs.map(({ proofId }) => proofId),
          outputPlanFingerprint: row.outputPlanFingerprint,
          method: row.requestMethod,
          path: row.requestPath,
          idempotencyKey: row.idempotencyKey,
          body: this.#artifactReference(row.scopeId, row.requestArtifactId),
        },
        outputPlan: {
          outputPlanId: row.outputPlanId,
          outputPlanFingerprint: row.outputPlanFingerprint,
          outputMaterialHandle: row.outputMaterialHandle,
          exactOutput: this.#artifactReference(row.scopeId, row.outputArtifactId),
        },
        privateMaterial: {
          materialHandle: row.privateMaterialHandle,
          useId: row.privateUseId,
          publicFingerprint: row.privatePublicFingerprint,
          exactPrivateMaterial: this.#artifactReference(row.scopeId, row.privateArtifactId),
        },
        result: {
          state: row.resultState,
          resultHandle: row.resultHandle,
          resultFingerprint: row.resultFingerprint,
          outputPlanFingerprint: row.resultOutputPlanFingerprint,
          exactResult:
            row.resultArtifactId === null
              ? null
              : this.#artifactReference(row.scopeId, row.resultArtifactId),
        },
        proofStorage: {
          storageClass: row.proofStorageClass,
          pinReasons: this.#pinReasons(row.scopeId, operationId),
          lineage: {
            scopeId: row.scopeId,
            operationId,
            predecessorProofIds: lineage('predecessor'),
            successorProofIds: lineage('successor'),
            successorAdmission: admission,
          },
        },
        delivery:
          deliveryRow === undefined
            ? {
                deliveryKind: 'none',
                deliveryId: null,
                exactPayload: null,
                expiresAtMs: null,
                state: 'none',
                receipt: null,
              }
            : {
                deliveryKind: 'outbox',
                deliveryId: deliveryRow.deliveryId,
                exactPayload: this.#artifactReference(row.scopeId, deliveryRow.payloadArtifactId),
                expiresAtMs: deliveryRow.expiresAtMs,
                state: deliveryRow.state,
                receipt:
                  deliveryRow.receiptId === null
                    ? null
                    : {
                        receiptId: deliveryRow.receiptId,
                        payloadFingerprint: deliveryRow.receiptFingerprint!,
                        acknowledgedAtMs: deliveryRow.acknowledgedAtMs!,
                      },
              },
        verification: {
          outputPlanFingerprint: row.verificationOutputPlanFingerprint,
          hasOutputs: Boolean(row.verificationHasOutputs),
          keysetBindings: bindings.map((binding) => ({
            ...binding,
            requireDleq: Boolean(binding.requireDleq),
          })),
          inputKeysets: keysetUses('input'),
          outputKeysets: keysetUses('output'),
        },
        retry: {
          attempt: row.retryAttempt,
          nextAttemptAtMs: row.nextAttemptAtMs,
          reason: row.retryReason,
        },
        horizon: {
          notBeforeMs: row.notBeforeMs,
          notAfterMs: row.notAfterMs,
          safetyMarginMs: row.safetyMarginMs,
          keysetExpiryMs: row.keysetExpiryMs,
        },
      },
      terminalTombstone:
        tombstone === undefined
          ? null
          : {
              tombstoneId: tombstone.tombstoneId,
              terminalAuthorityId: tombstone.terminalAuthorityId,
              authenticatedTerminalStatus: Boolean(tombstone.authenticatedTerminalStatus),
              replayCutoffObserved: Boolean(tombstone.replayCutoffObserved),
            },
    }
    return decodeDurableCustodyRecord(record)
  }

  getArtifact(input: {
    scopeId: string
    operationId: string
    expectedOperationRevision: number
    reference: DurableCustodyArtifactReference
  }): DurableCustodyArtifactRow | null {
    this.#assertOperationRevision(input.scopeId, input.operationId, input.expectedOperationRevision)
    const row = this.#database
      .prepare(
        `SELECT encoding, body, fingerprint, revision
         FROM custody_artifacts WHERE scope_id = ? AND artifact_id = ?`,
      )
      .get(input.scopeId, input.reference.artifactId) as
      | {
          encoding: string
          body: Uint8Array
          fingerprint: string
          revision: number
        }
      | undefined
    if (row === undefined) return null
    if (
      row.encoding !== input.reference.encoding ||
      row.fingerprint !== input.reference.fingerprint ||
      row.body.byteLength !== input.reference.byteLength ||
      row.revision !== 0
    ) {
      throw new Error('custody artifact row reference is foreign')
    }
    const artifact: DurableCustodyExactArtifact = {
      encoding: 'canonical-json',
      artifact: JSON.parse(new TextDecoder().decode(row.body)) as unknown,
      fingerprint: row.fingerprint,
    }
    assertDurableCustodyArtifactMatchesReference(input.reference, artifact)
    return { reference: { ...input.reference }, artifact, revision: 0 }
  }

  putArtifact(input: {
    scopeId: string
    operationId: string
    expectedOperationRevision: number
    expectedArtifactRevision: number | null
    reference: DurableCustodyArtifactReference
    artifact: DurableCustodyExactArtifact
    createdAtMs: number
  }): void {
    assertDurableCustodyArtifactMatchesReference(input.reference, input.artifact)
    const existing = this.getArtifact(input)
    if (existing !== null) {
      if (
        input.expectedArtifactRevision !== 0 ||
        !artifactsEqual(existing.artifact, input.artifact)
      ) {
        throw new Error('custody artifact is immutable or its CAS is stale')
      }
      return
    }
    if (input.expectedArtifactRevision !== null) {
      throw new Error('custody artifact CAS is stale')
    }
    const body = encodeBoundedDurableArtifact(
      input.artifact.artifact,
      DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
    )
    const result = this.#database
      .prepare(
        `INSERT INTO custody_artifacts (
           artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
           revision, private_material, created_at_ms
         ) VALUES (?, ?, ?, 'canonical-json', ?, ?, 0, ?, ?)
         ON CONFLICT(artifact_id) DO NOTHING`,
      )
      .run(
        input.reference.artifactId,
        input.scopeId,
        artifactKind(input.reference.artifactId),
        body,
        input.reference.fingerprint,
        input.reference.artifactId.endsWith(':private') ? 1 : 0,
        input.createdAtMs,
      )
    if (result.changes !== 1) {
      throw new Error('custody artifact CAS lost')
    }
  }

  putProofCas(row: CustodyProofSqliteRow, expectedRevision: number | null): void {
    assertProofRow(row)
    if (expectedRevision === null) {
      if (row.revision !== 0) throw new Error('new custody proof revision is invalid')
      const inserted = this.#database
        .prepare(
          `INSERT INTO custody_proofs (
             proof_id, scope_id, normalized_mint, unit, keyset_id, amount,
             base_asset, condition_id, outcome_set_id, product_binding,
             proof_body, proof_fingerprint, curve, signature_verified,
             dleq_state, nut07_state, selectability, storage_class,
             reservation_operation_id, revision, created_at_ms, updated_at_ms
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           ) ON CONFLICT(proof_id) DO NOTHING`,
        )
        .run(...proofSqlValues(row))
      if (inserted.changes !== 1) throw new Error('custody proof insertion CAS lost')
      return
    }
    if (row.revision !== expectedRevision + 1) {
      throw new Error('custody proof revision did not advance exactly')
    }
    const updated = this.#database
      .prepare(
        `UPDATE custody_proofs SET
           normalized_mint = ?, unit = ?, keyset_id = ?, amount = ?,
           base_asset = ?, condition_id = ?, outcome_set_id = ?,
           product_binding = ?, proof_body = ?, proof_fingerprint = ?,
           curve = ?, signature_verified = ?, dleq_state = ?, nut07_state = ?,
           selectability = ?, storage_class = ?, reservation_operation_id = ?,
           revision = ?, updated_at_ms = ?
         WHERE scope_id = ? AND proof_id = ? AND revision = ?`,
      )
      .run(
        row.normalizedMint,
        row.unit,
        row.keysetId,
        row.amount,
        row.baseAsset,
        row.conditionId,
        row.outcomeSetId,
        row.productBinding,
        row.proofBody,
        row.proofFingerprint,
        row.curve,
        Number(row.signatureVerified),
        row.dleqState,
        row.nut07State,
        row.selectability,
        row.storageClass,
        row.reservationOperationId,
        row.revision,
        row.updatedAtMs,
        row.scopeId,
        row.proofId,
        expectedRevision,
      )
    if (updated.changes !== 1) throw new Error('custody proof update CAS lost')
  }

  getProof(scopeId: string, proofId: string): CustodyProofSqliteRow | null {
    const row = this.#database
      .prepare(
        `SELECT proof_id AS proofId, scope_id AS scopeId,
           normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
           amount, base_asset AS baseAsset, condition_id AS conditionId,
           outcome_set_id AS outcomeSetId, product_binding AS productBinding,
           proof_body AS proofBody, proof_fingerprint AS proofFingerprint,
           curve, signature_verified AS signatureVerified,
           dleq_state AS dleqState, nut07_state AS nut07State, selectability,
           storage_class AS storageClass,
           reservation_operation_id AS reservationOperationId,
           revision, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
         FROM custody_proofs WHERE scope_id = ? AND proof_id = ?`,
      )
      .get(scopeId, proofId) as
      | (Omit<CustodyProofSqliteRow, 'signatureVerified'> & {
          signatureVerified: number
        })
      | undefined
    return row === undefined ? null : { ...row, signatureVerified: Boolean(row.signatureVerified) }
  }

  putCounterCas(row: CustodyCounterSqliteRow, expectedRevision: number | null): void {
    assertCounterRow(row)
    if (expectedRevision === null) {
      if (row.revision !== 0) {
        throw new Error('new custody counter revision is invalid')
      }
      const inserted = this.#database
        .prepare(
          `INSERT INTO custody_keyset_counters (
             scope_id, normalized_mint, unit, keyset_id,
             next_counter, revision, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_id, normalized_mint, unit, keyset_id) DO NOTHING`,
        )
        .run(
          row.scopeId,
          row.normalizedMint,
          row.unit,
          row.keysetId,
          row.nextCounter,
          row.revision,
          row.updatedAtMs,
        )
      if (inserted.changes !== 1) throw new Error('custody counter insertion CAS lost')
      return
    }
    if (row.revision !== expectedRevision + 1) {
      throw new Error('custody counter revision did not advance exactly')
    }
    const updated = this.#database
      .prepare(
        `UPDATE custody_keyset_counters
         SET next_counter = ?, revision = ?, updated_at_ms = ?
         WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
           AND keyset_id = ? AND revision = ?`,
      )
      .run(
        row.nextCounter,
        row.revision,
        row.updatedAtMs,
        row.scopeId,
        row.normalizedMint,
        row.unit,
        row.keysetId,
        expectedRevision,
      )
    if (updated.changes !== 1) throw new Error('custody counter update CAS lost')
  }

  listActiveWorkPage(scopeId: string, cursor: string | null = null): CustodyActiveWorkPage {
    const [cursorTime, cursorId] = decodeActiveCursor(cursor)
    const rows = this.#database
      .prepare(
        `SELECT scope_id AS scopeId, operation_id AS operationId,
           next_attempt_at_ms AS nextAttemptAtMs,
           estimated_bytes AS estimatedBytes
         FROM custody_active_work
         WHERE scope_id = ?
           AND (? IS NULL OR next_attempt_at_ms > ?
             OR (next_attempt_at_ms = ? AND operation_id > ?))
         ORDER BY next_attempt_at_ms, operation_id
         LIMIT ?`,
      )
      .all(
        scopeId,
        cursorTime,
        cursorTime,
        cursorTime,
        cursorId,
        CUSTODY_ACTIVE_PAGE_LIMIT + 1,
      ) as unknown as CustodyActiveWorkRow[]
    const selected: CustodyActiveWorkRow[] = []
    let estimatedBytes = 0
    for (const row of rows) {
      if (
        selected.length === CUSTODY_ACTIVE_PAGE_LIMIT ||
        estimatedBytes + row.estimatedBytes > CUSTODY_ACTIVE_PAGE_BYTES_MAX
      ) {
        break
      }
      selected.push(row)
      estimatedBytes += row.estimatedBytes
    }
    const hasMore = selected.length < rows.length
    const last = selected.at(-1)
    return {
      rows: selected,
      estimatedBytes,
      nextCursor:
        hasMore && last !== undefined
          ? `${last.nextAttemptAtMs}:${encodeURIComponent(last.operationId)}`
          : null,
    }
  }

  #artifactReference(scopeId: string, artifactId: string): DurableCustodyArtifactReference {
    const row = this.#database
      .prepare(
        `SELECT encoding, fingerprint, length(body) AS byteLength
         FROM custody_artifacts WHERE scope_id = ? AND artifact_id = ?`,
      )
      .get(scopeId, artifactId) as
      | { encoding: string; fingerprint: string; byteLength: number }
      | undefined
    if (row === undefined || row.encoding !== 'canonical-json') {
      throw new Error('custody operation artifact reference is missing')
    }
    return {
      artifactId,
      encoding: 'canonical-json',
      fingerprint: row.fingerprint,
      byteLength: row.byteLength,
    }
  }

  #pinReasons(
    scopeId: string,
    operationId: string,
  ): DurableCustodyRecord['operation']['proofStorage']['pinReasons'] {
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT pin_reason AS pinReason FROM custody_proof_pins
         WHERE scope_id = ? AND operation_id = ? ORDER BY pin_reason`,
      )
      .all(scopeId, operationId) as unknown as Array<{
      pinReason: DurableCustodyRecord['operation']['proofStorage']['pinReasons'][number]
    }>
    return rows.map(({ pinReason }) => pinReason)
  }

  #assertOperationRevision(scopeId: string, operationId: string, expectedRevision: number): void {
    const row = this.#database
      .prepare(
        `SELECT revision FROM custody_operations
         WHERE scope_id = ? AND operation_id = ?`,
      )
      .get(scopeId, operationId) as { revision: number } | undefined
    if (row?.revision !== expectedRevision) {
      throw new Error('custody operation revision CAS is stale')
    }
  }
}

interface OperationSqlRow {
  scopeId: string
  operationId: string
  revision: number
  retainedOperationKey: string
  semanticKind: DurableCustodyRecord['operation']['semanticKind']
  operationState: DurableCustodyRecord['operation']['state']
  activityId: string
  walletStage: DurableCustodyRecord['operation']['binding']['stage']
  normalizedMint: string
  unit: string
  inventoryAccountId: string | null
  reservationId: string
  parentReservationId: string | null
  requestId: string
  payloadHandle: string
  requestMethod: string
  requestPath: string
  idempotencyKey: string
  requestFingerprint: string
  requestArtifactId: string
  outputPlanFingerprint: string
  outputPlanId: string
  outputMaterialHandle: string
  outputArtifactId: string
  privateMaterialHandle: string
  privateUseId: string
  privatePublicFingerprint: string
  privateArtifactId: string
  resultState: DurableCustodyRecord['operation']['result']['state']
  resultHandle: string | null
  resultArtifactId: string | null
  resultFingerprint: string | null
  resultOutputPlanFingerprint: string | null
  proofStorageClass: DurableCustodyRecord['operation']['proofStorage']['storageClass']
  verificationOutputPlanFingerprint: string
  verificationHasOutputs: number
  retryAttempt: number
  retryReason: DurableCustodyRecord['operation']['retry']['reason']
  nextAttemptAtMs: number | null
  notBeforeMs: number | null
  notAfterMs: number | null
  safetyMarginMs: number
  keysetExpiryMs: number | null
  terminalReplayEvidenceRequired: number
}

interface DeliverySqlRow {
  deliveryId: string
  payloadArtifactId: string
  expiresAtMs: number | null
  state: 'pending' | 'acknowledged' | 'expired'
  receiptId: string | null
  receiptFingerprint: string | null
  acknowledgedAtMs: number | null
}

function artifactKind(artifactId: string): string {
  if (artifactId.endsWith(':request')) return 'exact-request'
  if (artifactId.endsWith(':output')) return 'output-plan'
  if (artifactId.endsWith(':private')) return 'private-material'
  if (artifactId.endsWith(':result')) return 'exact-result'
  if (artifactId.endsWith(':delivery')) return 'delivery-payload'
  throw new Error('custody artifact identifier is unsupported by target v1')
}

function artifactsEqual(
  left: DurableCustodyExactArtifact,
  right: DurableCustodyExactArtifact,
): boolean {
  return (
    left.encoding === right.encoding &&
    left.fingerprint === right.fingerprint &&
    new TextDecoder().decode(
      encodeBoundedDurableArtifact(left.artifact, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX),
    ) ===
      new TextDecoder().decode(
        encodeBoundedDurableArtifact(right.artifact, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX),
      )
  )
}

function assertProofRow(row: CustodyProofSqliteRow): void {
  if (
    !Number.isSafeInteger(row.amount) ||
    row.amount <= 0 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    row.proofBody.byteLength === 0 ||
    row.proofBody.byteLength > 64 * 1_024
  ) {
    throw new Error('custody proof row is invalid')
  }
}

function assertCounterRow(row: CustodyCounterSqliteRow): void {
  if (
    !Number.isSafeInteger(row.nextCounter) ||
    row.nextCounter < 0 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    throw new Error('custody counter row is invalid')
  }
}

function proofSqlValues(row: CustodyProofSqliteRow): SQLInputValue[] {
  return [
    row.proofId,
    row.scopeId,
    row.normalizedMint,
    row.unit,
    row.keysetId,
    row.amount,
    row.baseAsset,
    row.conditionId,
    row.outcomeSetId,
    row.productBinding,
    row.proofBody,
    row.proofFingerprint,
    row.curve,
    Number(row.signatureVerified),
    row.dleqState,
    row.nut07State,
    row.selectability,
    row.storageClass,
    row.reservationOperationId,
    row.revision,
    row.createdAtMs,
    row.updatedAtMs,
  ]
}

function decodeActiveCursor(cursor: string | null): [number | null, string] {
  if (cursor === null) return [null, '']
  const separator = cursor.indexOf(':')
  const time = Number(cursor.slice(0, separator))
  const operationId = decodeURIComponent(cursor.slice(separator + 1))
  if (separator <= 0 || !Number.isSafeInteger(time) || time < 0 || operationId.length === 0) {
    throw new Error('custody active work cursor is invalid')
  }
  return [time, operationId]
}
