import type { DatabaseSync } from 'node:sqlite'
import type { DurableCustodySuccessorAdmissionEvidence } from '@bitcaster-market/client-sdk/durableCustody'

export function acknowledgeCustodyDelivery(
  database: DatabaseSync,
  input: {
    scopeId: string
    operationId: string
    deliveryId: string
    receiptId: string
    receiptFingerprint: string
    acknowledgedAtMs: number
  },
): void {
  const updated = database
    .prepare(
      `UPDATE custody_deliveries SET
         state = 'acknowledged', receipt_id = ?, receipt_fingerprint = ?,
         acknowledged_at_ms = ?
       WHERE scope_id = ? AND operation_id = ? AND delivery_id = ?
         AND state = 'pending'`,
    )
    .run(
      input.receiptId,
      input.receiptFingerprint,
      input.acknowledgedAtMs,
      input.scopeId,
      input.operationId,
      input.deliveryId,
    )
  if (updated.changes !== 1) {
    throw new Error('custody delivery acknowledgement CAS failed')
  }
}

export function putCustodyTerminalTombstone(
  database: DatabaseSync,
  input: {
    scopeId: string
    operationId: string
    tombstoneId: string
    terminalAuthorityId: string
    authenticatedTerminalStatus: boolean
    replayCutoffObserved: boolean
  },
): void {
  const inserted = database
    .prepare(
      `INSERT INTO custody_operation_tombstones (
         scope_id, operation_id, tombstone_id, terminal_authority_id,
         authenticated_terminal_status, replay_cutoff_observed
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, operation_id) DO NOTHING`,
    )
    .run(
      input.scopeId,
      input.operationId,
      input.tombstoneId,
      input.terminalAuthorityId,
      Number(input.authenticatedTerminalStatus),
      Number(input.replayCutoffObserved),
    )
  if (inserted.changes !== 1) {
    throw new Error('custody tombstone insertion CAS failed')
  }
}

export function purgeCustodyOperationP09(
  database: DatabaseSync,
  input: {
    scopeId: string
    operationId: string
    plannedSuccessorProofIds: readonly string[]
    successorAdmission: DurableCustodySuccessorAdmissionEvidence | null
  },
): 'retained' | 'deleted' {
  const terminal = database
    .prepare(
      `SELECT authenticated_terminal_status AS authenticatedTerminalStatus,
         replay_cutoff_observed AS replayCutoffObserved
       FROM custody_operation_tombstones
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(input.scopeId, input.operationId) as
    | { authenticatedTerminalStatus: number; replayCutoffObserved: number }
    | undefined
  const delivery = database
    .prepare(
      `SELECT state, receipt_id AS receiptId
       FROM custody_deliveries
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(input.scopeId, input.operationId) as
    | { state: string; receiptId: string | null }
    | undefined
  const operation = database
    .prepare(
      `SELECT operation_state AS operationState, result_state AS resultState
       FROM custody_operations WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(input.scopeId, input.operationId) as
    | { operationState: string; resultState: string }
    | undefined
  if (
    operation?.operationState !== 'reconciled' ||
    operation.resultState !== 'applied' ||
    terminal === undefined ||
    terminal.authenticatedTerminalStatus !== 1 ||
    terminal.replayCutoffObserved !== 1 ||
    delivery === undefined ||
    delivery.state !== 'acknowledged' ||
    delivery.receiptId === null ||
    !successorEvidenceMatches(
      database,
      input.scopeId,
      input.operationId,
      input.plannedSuccessorProofIds,
      input.successorAdmission,
    )
  ) {
    return 'retained'
  }
  const artifactRows = database
    .prepare(
      `SELECT artifact_id AS artifactId FROM custody_operation_artifact_links
       WHERE scope_id = ? AND operation_id = ?
       UNION
       SELECT request_artifact_id FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?
       UNION
       SELECT output_artifact_id FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?
       UNION
       SELECT private_artifact_id FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?
       UNION
       SELECT result_artifact_id FROM custody_operations
       WHERE scope_id = ? AND operation_id = ? AND result_artifact_id IS NOT NULL
       UNION
       SELECT payload_artifact_id FROM custody_deliveries
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .all(
      input.scopeId,
      input.operationId,
      input.scopeId,
      input.operationId,
      input.scopeId,
      input.operationId,
      input.scopeId,
      input.operationId,
      input.scopeId,
      input.operationId,
      input.scopeId,
      input.operationId,
    ) as unknown as Array<{ artifactId: string }>
  const dependentPin = database
    .prepare(
      `SELECT 1 FROM order_collateral_pins
       WHERE scope_id = ? AND operation_id = ? LIMIT 1`,
    )
    .get(input.scopeId, input.operationId)
  if (dependentPin !== undefined) return 'retained'
  for (const table of [
    'custody_proof_reservations',
    'custody_operation_pins',
    'custody_successor_admission_proofs',
    'custody_successor_admissions',
    'custody_selected_successors',
    'custody_proof_lineage',
    'custody_wallet_receive_active_work',
    'custody_active_work',
    'custody_deliveries',
    'custody_operation_tombstones',
    'custody_verification_keyset_uses',
    'custody_verification_bindings',
    'custody_operation_artifact_links',
    'custody_operation_inputs',
  ]) {
    database
      .prepare(`DELETE FROM ${table} WHERE scope_id = ? AND operation_id = ?`)
      .run(input.scopeId, input.operationId)
  }
  const deleted = database
    .prepare(
      `DELETE FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .run(input.scopeId, input.operationId)
  if (deleted.changes !== 1) return 'retained'
  for (const { artifactId } of artifactRows) {
    database
      .prepare(
        `DELETE FROM custody_artifacts
         WHERE scope_id = ? AND artifact_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM custody_operation_artifact_links
             WHERE scope_id = ? AND artifact_id = ?
           )`,
      )
      .run(input.scopeId, artifactId, input.scopeId, artifactId)
  }
  return 'deleted'
}

function successorEvidenceMatches(
  database: DatabaseSync,
  scopeId: string,
  operationId: string,
  plannedIds: readonly string[],
  evidence: DurableCustodySuccessorAdmissionEvidence | null,
): boolean {
  if (
    evidence === null ||
    evidence.scopeId !== scopeId ||
    evidence.operationId !== operationId ||
    evidence.proofRows.length !== plannedIds.length
  ) {
    return false
  }
  const admission = database
    .prepare(
      `SELECT admission_id AS admissionId
       FROM custody_successor_admissions
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(scopeId, operationId) as { admissionId: string } | undefined
  if (admission?.admissionId !== evidence.admissionId) return false
  return evidence.proofRows.every((admission, index) => {
    if (
      admission.proofId !== plannedIds[index] ||
      admission.admittedRevision !== (admission.expectedRevision ?? 0)
    ) {
      return false
    }
    const proof = database
      .prepare(
        `SELECT revision FROM custody_proofs
         WHERE scope_id = ? AND proof_id = ?`,
      )
      .get(scopeId, admission.proofId) as { revision: number } | undefined
    const lineage = database
      .prepare(
        `SELECT 1 FROM custody_proof_lineage
         WHERE scope_id = ? AND operation_id = ? AND proof_id = ?`,
      )
      .get(scopeId, operationId, admission.proofId)
    const persistedAdmission = database
      .prepare(
        `SELECT expected_revision AS expectedRevision,
           admitted_revision AS admittedRevision
         FROM custody_successor_admission_proofs
         WHERE scope_id = ? AND operation_id = ?
           AND proof_position = ? AND proof_id = ?`,
      )
      .get(scopeId, operationId, index, admission.proofId) as
      | { expectedRevision: number | null; admittedRevision: number }
      | undefined
    return (
      proof?.revision === admission.admittedRevision &&
      lineage !== undefined &&
      persistedAdmission?.expectedRevision === admission.expectedRevision &&
      persistedAdmission.admittedRevision === admission.admittedRevision
    )
  })
}
