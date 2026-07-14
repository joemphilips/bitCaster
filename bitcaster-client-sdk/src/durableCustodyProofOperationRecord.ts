import {
  createDurableCustodyDispatchIntent,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyTransaction,
  type DurableProofOperationFacts,
} from './durableCustody.ts'
import {
  durableCustodyProofOperationSemanticKind,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import type { DurableTradeProofOperationLink } from './durableTradeRecovery.ts'
import { amountToNumber } from './proofSelection.ts'

export interface CreateDurableCustodyProofOperationInput {
  scope: DurableCustodyScope
  operation: DurableCustodyProofOperationInput
  facts: DurableProofOperationFacts
  inventoryAccountId: string | null
  reservationId?: string
}

/** Builds one exact canonical custody intent from a persisted Cashu operation. */
export function createDurableCustodyProofOperation(
  input: CreateDurableCustodyProofOperationInput,
): DurableCustodyRecord {
  const semanticKind = durableCustodyProofOperationSemanticKind(
    input.operation.kind,
  )
  const { requestFingerprint, outputPlanFingerprint } =
    deriveDurableCustodyProofOperationFingerprints(input.operation)
  const inputProofs = exactInputProofs(input.operation, input.facts)
  const handle = (kind: string, fingerprint: string) => `${kind}:${fingerprint}`
  return createDurableCustodyDispatchIntent({
    scope: input.scope,
    retainedOperationKey: input.operation.operationId,
    semanticKind,
    facts: input.facts,
    normalizedMint: input.operation.mintUrl,
    inventoryAccountId: input.inventoryAccountId,
    reservation: {
      reservationId:
        input.reservationId ?? handle('reservation', requestFingerprint),
      inputs: inputProofs,
    },
    exactRequest: {
      requestId: handle('request', requestFingerprint),
      requestFingerprint,
      payloadHandle: handle('request-payload', requestFingerprint),
      inputProofIds: inputProofs.map(({ proofId }) => proofId),
      outputPlanFingerprint,
    },
    outputPlan: {
      outputPlanId: handle('output-plan', outputPlanFingerprint),
      outputPlanFingerprint,
      outputMaterialHandle: handle('output-material', outputPlanFingerprint),
    },
    privateMaterial: {
      materialHandle: handle('private-material', requestFingerprint),
      useId: handle('private-use', requestFingerprint),
      publicFingerprint: requestFingerprint,
    },
  })
}

/** Re-derives the exact immutable request identities used during recovery. */
export function deriveDurableCustodyProofOperationFingerprints(
  operation: DurableCustodyProofOperationInput,
): { requestFingerprint: string; outputPlanFingerprint: string } {
  const artifact = exactRequestArtifact(operation)
  return {
    requestFingerprint: deriveDurableCustodyArtifactFingerprint(artifact),
    outputPlanFingerprint: deriveDurableCustodyArtifactFingerprint(
      artifact.outputs,
    ),
  }
}

/** Idempotently binds an exact operation, relation, and global proof ownership. */
export function bindDurableCustodyProofOperation(
  transaction: DurableCustodyTransaction,
  expected: DurableCustodyRecord,
): void {
  const operationId = expected.operation.operationId
  const existing = transaction.getOperation(operationId)
  if (existing === null) transaction.putOperation(expected)
  else assertSameCustodyAuthority(existing, expected)
  if (expected.operation.binding.kind === 'trade') {
    transaction.putSessionLink(operationId, expected.operation.binding)
  }
  transaction.reserveExactInputs({
    operationId,
    reservationId: expected.operation.reservation.reservationId,
    proofIds: expected.operation.reservation.inputs.map(({ proofId }) => proofId),
  })
  transaction.rebuildActiveWorkIndex()
}

function exactRequestArtifact(operation: DurableCustodyProofOperationInput) {
  return {
    kind: operation.kind,
    mintUrl: operation.mintUrl,
    inputs: operation.inputs.map(canonicalProofArtifact),
    outputs: Object.fromEntries(
      Object.entries(operation.outputs).map(([label, outputs]) => [
        label,
        outputs.map(canonicalOutputArtifact),
      ]),
    ),
    metadata: structuredClone(operation.metadata ?? {}),
    durableTradeRecovery:
      operation.durableTradeRecovery === undefined
        ? null
        : operationLinkIdentity(operation.durableTradeRecovery),
  }
}

function canonicalProofArtifact(
  proof: DurableCustodyProofOperationInput['inputs'][number],
) {
  if (!proof.id || !proof.secret || !proof.C) {
    throw new Error('custody input proof is incomplete')
  }
  return omitUndefined({
    id: proof.id,
    amount: amountToNumber(proof.amount),
    secret: proof.secret,
    C: proof.C,
    dleq: structuredClone(proof.dleq),
    p2pk_e: proof.p2pk_e,
    witness: structuredClone(proof.witness),
    conditionId: proof.conditionId,
    outcomeCollection: proof.outcomeCollection,
  })
}

function canonicalOutputArtifact(
  output: DurableCustodyProofOperationInput['outputs'][string][number],
) {
  return {
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor,
    secret: output.secret,
  }
}

function exactInputProofs(
  operation: DurableCustodyProofOperationInput,
  facts: DurableProofOperationFacts,
) {
  const curveByKeyset = new Map(
    facts.verification.inputKeysets.map((keyset) => [
      keyset.keysetId,
      keyset.curve,
    ]),
  )
  return operation.inputs.map((proof) => {
    if (!proof.id) throw new Error('custody input proof has no keyset id')
    const curve = curveByKeyset.get(proof.id)
    if (curve === undefined) {
      throw new Error('custody input keyset is unverified')
    }
    return {
      proofId: deriveDurableCustodyProofId({
        normalizedMint: operation.mintUrl,
        unit: facts.unit,
        keysetId: proof.id,
        secret: proof.secret,
      }),
      keysetId: proof.id,
      curve,
    }
  })
}

function operationLinkIdentity(link: DurableTradeProofOperationLink) {
  const { state: _, ...identity } = link
  return identity
}

function assertSameCustodyAuthority(
  existing: DurableCustodyRecord,
  expected: DurableCustodyRecord,
): void {
  const existingFingerprint = deriveDurableCustodyArtifactFingerprint(
    immutableCustodyAuthority(existing),
  )
  const expectedFingerprint = deriveDurableCustodyArtifactFingerprint(
    immutableCustodyAuthority(expected),
  )
  if (existingFingerprint !== expectedFingerprint) {
    throw new Error('existing custody operation has foreign immutable authority')
  }
}

function immutableCustodyAuthority(record: DurableCustodyRecord) {
  const operation = record.operation
  return {
    scope: record.scope,
    retainedOperationKey: operation.retainedOperationKey,
    binding: operation.binding,
    semanticKind: operation.semanticKind,
    terminalReplayEvidenceRequired: operation.terminalReplayEvidenceRequired,
    custodyContext: operation.custodyContext,
    reservation: operation.reservation,
    exactRequest: operation.exactRequest,
    outputPlan: operation.outputPlan,
    privateMaterial: operation.privateMaterial,
    verification: operation.verification,
    horizon: operation.horizon,
  }
}

function omitUndefined<T extends Record<string, unknown>>(
  value: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  )
}
