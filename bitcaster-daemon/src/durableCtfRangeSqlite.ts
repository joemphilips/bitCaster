import {
  assertDurableCtfRangeCustodyAuthority,
  decodeDurableCtfRangeOperation,
  type DurableCtfRangeOperation,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  canonicalDurableCustodyKeysetIdentity,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  type DurableCustodyRecord,
} from '@bitcaster-market/client-sdk/durableCustody'
import { decodeCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'

export interface DaemonDurableCtfRangeAuthority {
  readonly record: DurableCustodyRecord
  readonly operation: DurableCtfRangeOperation
}

export function loadDaemonDurableCtfRangeAuthority(
  store: DurableCustodySqliteStore,
  custodyOperationId: string,
): DaemonDurableCtfRangeAuthority | null {
  const record = store.getOperation(custodyOperationId)
  if (record === null) return null
  assertRangeRecordIdentity(record, custodyOperationId)
  const privateMaterial = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: custodyOperationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (privateMaterial === null) {
    throw new Error('durable CTF range private authority is missing')
  }
  const operation = assertDurableCtfRangeCustodyAuthority(
    record,
    decodeDurableCtfRangeOperation(privateMaterial.artifact.artifact),
  )
  assertPersistedProofRows(store, record, operation)
  return { record, operation }
}

function assertRangeRecordIdentity(record: DurableCustodyRecord, custodyOperationId: string): void {
  if (record.operation.operationId !== custodyOperationId) {
    throw new Error('durable CTF range record authority is foreign')
  }
}

function assertPersistedProofRows(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
): void {
  const links = record.operation.reservation.inputs
  operation.inputs.forEach((proof, position) => {
    const link = links[position]!
    const row = store.getProof(record.scope.scopeId, link.proofId)
    const decoded = row === null ? null : decodeCustodyProofSqliteRow(row)
    const proofId = deriveDurableCustodyProofId({
      scopeId: record.scope.scopeId,
      normalizedMint: operation.mintUrl,
      unit: operation.unit,
      keysetId: proof.id,
      secret: proof.secret,
    })
    if (
      row === null ||
      row.proofId !== proofId ||
      row.normalizedMint !== operation.mintUrl ||
      row.unit !== operation.unit ||
      canonicalDurableCustodyKeysetIdentity(row.keysetId) !==
        canonicalDurableCustodyKeysetIdentity(proof.id) ||
      row.amount !== Number(proof.amount) ||
      row.curve !== link.curve ||
      row.signatureVerified !== true ||
      (row.curve === 'secp256k1'
        ? row.dleqState !== 'verified'
        : row.dleqState !== 'not-present') ||
      row.selectability !== 'locked' ||
      row.reservationOperationId !== record.operation.operationId ||
      decoded === null ||
      !sameProofMaterial(decoded.proof, proof)
    ) {
      throw new Error('durable CTF range persisted proof authority is foreign')
    }
  })
}

function sameProofMaterial(
  persisted: ReturnType<typeof decodeCustodyProofSqliteRow>['proof'],
  operation: DurableCtfRangeOperation['inputs'][number],
): boolean {
  return (
    persisted.secret === operation.secret &&
    persisted.C === operation.C &&
    deriveDurableCustodyArtifactFingerprint({
      dleq: persisted.dleq,
      p2pkE: persisted.p2pkE,
      witness: persisted.witness,
    }) ===
      deriveDurableCustodyArtifactFingerprint({
        dleq: operation.dleq,
        p2pkE: operation.p2pkE,
        witness: operation.witness,
      })
  )
}
