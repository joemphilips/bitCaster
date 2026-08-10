import { createDurableCustodyProofOperation } from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import type {
  DurableCustodyExactArtifact,
  DurableCustodyRecord,
  DurableCustodyScope,
  DurableProofOperationFacts,
} from '@bitcaster-market/client-sdk/durableCustody'
import type { DurableCustodyProofOperationInput } from '@bitcaster-market/client-sdk/durableCustodyProofOperation'

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
