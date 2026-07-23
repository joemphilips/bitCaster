import type { DatabaseSync } from 'node:sqlite'
import {
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import type {
  DurableCustodyExactArtifact,
  DurableCustodyRecord,
  DurableCustodyScope,
  DurableProofOperationFacts,
} from '@bitcaster-market/client-sdk/durableCustody'
import type {
  DurableCustodyProofOperationInput,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'

export interface PreparedDaemonProofOperation {
  readonly record: DurableCustodyRecord
  readonly artifacts: {
    readonly requestBody: DurableCustodyExactArtifact
    readonly output: DurableCustodyExactArtifact
    readonly privateMaterial: DurableCustodyExactArtifact
  }
}
export function prepareDaemonDurableProofOperation(input: {
  scope: DurableCustodyScope
  operation: DurableCustodyProofOperationInput
  facts: DurableProofOperationFacts
  inventoryAccountId: string | null
  exactBoundary: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    idempotencyKey: string
    requestBody: DurableCustodyExactArtifact
    output: DurableCustodyExactArtifact
    privateMaterial: DurableCustodyExactArtifact
  }
}): PreparedDaemonProofOperation {
  const record = createDurableCustodyProofOperation(input)
  return {
    record,
    artifacts: {
      requestBody: input.exactBoundary.requestBody,
      output: input.exactBoundary.output,
      privateMaterial: input.exactBoundary.privateMaterial,
    },
  }
}

export function putTargetSwapOperationLinkCas(
  database: DatabaseSync,
  input: {
    scopeId: string
    tradeId: string
    orderId: string
    operationId: string
    role: 'seller' | 'buyer'
    stage: 'lock' | 'claim' | 'refund'
    expectedRevision: number | null
  },
): void {
  if (input.expectedRevision === null) {
    const inserted = database
      .prepare(
        `INSERT INTO swap_operation_links (
           scope_id, trade_id, order_id, operation_id, role, stage, revision
         ) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(scope_id, trade_id, operation_id) DO NOTHING`,
      )
      .run(
        input.scopeId,
        input.tradeId,
        input.orderId,
        input.operationId,
        input.role,
        input.stage,
      )
    if (inserted.changes !== 1) {
      throw new Error('target swap operation link insertion CAS lost')
    }
    return
  }
  const updated = database
    .prepare(
      `UPDATE swap_operation_links SET
         order_id = ?, role = ?, stage = ?, revision = revision + 1
       WHERE scope_id = ? AND trade_id = ? AND operation_id = ?
         AND revision = ?`,
    )
    .run(
      input.orderId,
      input.role,
      input.stage,
      input.scopeId,
      input.tradeId,
      input.operationId,
      input.expectedRevision,
    )
  if (updated.changes !== 1) {
    throw new Error('target swap operation link update CAS lost')
  }
}
