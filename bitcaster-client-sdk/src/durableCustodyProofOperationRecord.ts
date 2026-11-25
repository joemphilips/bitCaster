// Canonical generic proof-operation record re-authored from 7e1385c.
import {
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  assertDurableCustodyImmutableAuthorityMatches,
  createDurableCustodyDispatchIntent,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  encodeBoundedDurableArtifact,
  isDurableCustodyProofReservationActive,
  type DurableCustodyRecord,
  type DurableCustodyExactArtifact,
  type DurableCustodyScope,
  type DurableCustodyTransaction,
  type DurableProofOperationFacts,
} from './durableCustody.ts'
import {
  decodeDurableCustodyProofOperationInput,
  durableCustodyProofOperationSemanticKind,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { requireDurableWalletProofTransition } from './durableWalletProofTransition.ts'
import { amountToNumber } from './proofSelection.ts'
import { LATER_RECORD_TEXT_BYTES, WalletOperationTooLargeError } from './walletOperationSize.ts'

export function createDurableCustodyProofOperation(input: {
  scope: DurableCustodyScope
  operation: DurableCustodyProofOperationInput
  facts: DurableProofOperationFacts
  inventoryAccountId: string | null
  reservationId?: string
  parentReservationId?: string
  exactBoundary: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    idempotencyKey: string
    requestBody: DurableCustodyExactArtifact
    output: DurableCustodyExactArtifact
    privateMaterial: DurableCustodyExactArtifact
  }
}): DurableCustodyRecord {
  const operation = decodeDurableCustodyProofOperationInput(input.operation)
  if (operation.metadata?.unit !== input.facts.unit || operation.mintUrl.length === 0) {
    throw new Error('custody proof operation unit is invalid')
  }
  const fingerprints = {
    requestFingerprint: input.exactBoundary.requestBody.fingerprint,
    outputPlanFingerprint: input.exactBoundary.output.fingerprint,
  }
  const inputSource =
    operation.kind === 'wallet-receive'
      ? requireDurableWalletProofTransition(
          operation.metadata ?? {},
          Object.keys(operation.outputs),
        ).inputSource
      : 'wallet'
  const inputProofs = (inputSource === 'external' ? [] : operation.inputs).map((proof) => {
    if (!proof.id) throw new Error('custody input proof has no keyset id')
    const keyset = input.facts.verification.inputKeysets.find(
      (candidate) => candidate.keysetId === proof.id,
    )
    if (!keyset) throw new Error('custody input keyset is unverified')
    return {
      proofId: deriveDurableCustodyProofId({
        scopeId: input.scope.scopeId,
        normalizedMint: operation.mintUrl,
        unit: input.facts.unit,
        keysetId: proof.id,
        secret: proof.secret,
      }),
      keysetId: proof.id,
      curve: keyset.curve,
    }
  })
  const handle = (kind: string, fingerprint: string) => `${kind}:${fingerprint}`
  const successorProofIds = Object.values(operation.outputs).flatMap((outputs) =>
    outputs.map((output) =>
      deriveDurableCustodyProofId({
        scopeId: input.scope.scopeId,
        normalizedMint: operation.mintUrl,
        unit: input.facts.unit,
        keysetId: output.blindedMessage.id,
        secret: output.secret,
      }),
    ),
  )
  return createDurableCustodyDispatchIntent({
    scope: input.scope,
    retainedOperationKey: operation.operationId,
    semanticKind: durableCustodyProofOperationSemanticKind(operation.kind),
    facts: input.facts,
    normalizedMint: operation.mintUrl,
    inventoryAccountId: input.inventoryAccountId,
    reservation: {
      reservationId: input.reservationId ?? handle('reservation', fingerprints.requestFingerprint),
      parentReservationId: input.parentReservationId ?? null,
      inputs: inputProofs,
    },
    proofLineage: {
      predecessorProofIds: inputProofs.map(({ proofId }) => proofId),
      successorProofIds,
      successorAdmissionMode:
        operation.kind === 'ctf-range-authorization' || operation.kind === 'wallet-melt'
          ? 'subset'
          : 'exact',
    },
    exactRequest: {
      requestId: handle('request', fingerprints.requestFingerprint),
      requestFingerprint: fingerprints.requestFingerprint,
      payloadHandle: handle('request-payload', fingerprints.requestFingerprint),
      inputProofIds: inputProofs.map(({ proofId }) => proofId),
      outputPlanFingerprint: fingerprints.outputPlanFingerprint,
      method: input.exactBoundary.method,
      path: input.exactBoundary.path,
      idempotencyKey: input.exactBoundary.idempotencyKey,
      body: input.exactBoundary.requestBody,
    },
    outputPlan: {
      outputPlanId: handle('output-plan', fingerprints.outputPlanFingerprint),
      outputPlanFingerprint: fingerprints.outputPlanFingerprint,
      outputMaterialHandle: handle('output-material', fingerprints.outputPlanFingerprint),
      exactOutput: input.exactBoundary.output,
    },
    privateMaterial: {
      materialHandle: handle('private-material', fingerprints.requestFingerprint),
      useId: handle('private-use', fingerprints.requestFingerprint),
      publicFingerprint: input.exactBoundary.privateMaterial.fingerprint,
      exactPrivateMaterial: input.exactBoundary.privateMaterial,
    },
  })
}

/**
 * Refuse a new operation whose record cannot also hold its result. Call this before the first
 * effect. After the mint spends the inputs, the result must fit, or no recovery can complete it.
 */
export function assertDurableCustodyRecordCanHoldResult(record: DurableCustodyRecord): void {
  const bytes = encodeBoundedDurableArtifact(
    recordWithLargestResult(record),
    DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  ).byteLength
  if (bytes + LATER_RECORD_TEXT_BYTES > DURABLE_CUSTODY_RECORD_BYTES_MAX)
    throw new WalletOperationTooLargeError()
}

/** The record after the mint answer, with every planned output admitted. */
function recordWithLargestResult(record: DurableCustodyRecord): DurableCustodyRecord {
  const { operation } = record
  const { lineage } = operation.proofStorage
  const fingerprint = operation.outputPlan.outputPlanFingerprint
  return {
    ...record,
    revision: Number.MAX_SAFE_INTEGER,
    operation: {
      ...operation,
      state: 'transport-attempted',
      result: {
        state: 'verified-staged',
        resultHandle: `mint-result:${fingerprint}`,
        resultFingerprint: fingerprint,
        outputPlanFingerprint: fingerprint,
        exactResult: {
          ...operation.privateMaterial.exactPrivateMaterial,
          byteLength: DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
        },
      },
      proofStorage: {
        ...operation.proofStorage,
        pinReasons: [
          'active-reservation',
          'pending-outbox',
          'active-retry-cursor',
          'replay-tombstone',
        ],
        lineage: {
          ...lineage,
          selectedSuccessorProofIds: [...lineage.successorProofIds],
          successorAdmission: {
            scopeId: lineage.scopeId,
            operationId: lineage.operationId,
            admissionId: fingerprint,
            proofRows: lineage.successorProofIds.map((proofId) => ({
              proofId,
              expectedRevision: null,
              admittedRevision: 0,
            })),
          },
        },
      },
      retry: {
        attempt: Number.MAX_SAFE_INTEGER,
        nextAttemptAtMs: Number.MAX_SAFE_INTEGER,
        reason: 'mint-response-unknown',
      },
    },
  }
}

export function deriveDurableCustodyProofOperationFingerprints(
  input: DurableCustodyProofOperationInput,
): { requestFingerprint: string; outputPlanFingerprint: string } {
  const operation = decodeDurableCustodyProofOperationInput(input)
  const artifact = exactRequestArtifact(operation)
  return {
    requestFingerprint: deriveDurableCustodyArtifactFingerprint(artifact),
    outputPlanFingerprint: deriveDurableCustodyArtifactFingerprint(artifact.outputs),
  }
}

function exactRequestArtifact(operation: DurableCustodyProofOperationInput) {
  return {
    kind: operation.kind,
    mintUrl: operation.mintUrl,
    inputs: operation.inputs.map(canonicalProof),
    outputs: Object.fromEntries(
      Object.entries(operation.outputs).map(([label, outputs]) => [
        label,
        outputs.map(canonicalOutput),
      ]),
    ),
    metadata: structuredClone(operation.metadata ?? {}),
  }
}

export function deriveDurableCustodyProofResultFingerprint(
  groups: Readonly<Record<string, readonly DurableCustodyProofOperationInput['inputs'][number][]>>,
): string {
  return deriveDurableCustodyArtifactFingerprint(
    Object.fromEntries(
      Object.entries(groups).map(([label, proofs]) => [label, proofs.map(canonicalProof)]),
    ),
  )
}

/** Bind a new operation before its first effect. A record without room for its result is refused. */
export function bindNewDurableCustodyProofOperation(
  transaction: DurableCustodyTransaction,
  expected: DurableCustodyRecord,
  artifacts: Parameters<typeof bindDurableCustodyProofOperation>[2],
): void {
  if (transaction.getOperation(expected.operation.operationId) === null)
    assertDurableCustodyRecordCanHoldResult(expected)
  bindDurableCustodyProofOperation(transaction, expected, artifacts)
}

/**
 * Bind an operation that follows an effect, or an operation without a mint request. After an effect
 * a refusal would block the result of that effect.
 */
export function bindDurableCustodyProofOperation(
  transaction: DurableCustodyTransaction,
  expected: DurableCustodyRecord,
  artifacts: {
    requestBody: DurableCustodyExactArtifact
    output: DurableCustodyExactArtifact
    privateMaterial: DurableCustodyExactArtifact
  },
): void {
  const operationId = expected.operation.operationId
  const existing = transaction.getOperation(operationId)
  if (existing === null) {
    transaction.putOperation({ record: expected, expectedRevision: null })
  } else {
    assertDurableCustodyImmutableAuthorityMatches(existing, expected)
  }
  const revision = (existing ?? expected).revision
  for (const [reference, artifact] of [
    [expected.operation.exactRequest.body, artifacts.requestBody],
    [expected.operation.outputPlan.exactOutput, artifacts.output],
    [expected.operation.privateMaterial.exactPrivateMaterial, artifacts.privateMaterial],
  ] as const) {
    const artifactLookup = {
      scopeId: expected.scope.scopeId,
      operationId,
      expectedOperationRevision: revision,
      reference,
    }
    const artifactInput = {
      ...artifactLookup,
      artifact,
    }
    const existingArtifact = transaction.getArtifact(artifactLookup)
    transaction.putArtifact({
      ...artifactInput,
      expectedArtifactRevision: existingArtifact?.revision ?? null,
    })
  }
  if (isDurableCustodyProofReservationActive(existing ?? expected)) {
    transaction.reserveExactInputs({
      operationId,
      expectedRevision: revision,
      reservationId: expected.operation.reservation.reservationId,
      proofIds: expected.operation.reservation.inputs.map(({ proofId }) => proofId),
    })
  }
  transaction.rebuildActiveWorkIndex({
    scopeId: expected.scope.scopeId,
    operationRows: [
      {
        operationId,
        expectedRevision: revision,
      },
    ],
  })
}

function canonicalProof(
  proof: DurableCustodyProofOperationInput['inputs'][number],
): Record<string, unknown> {
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

function canonicalOutput(
  output: DurableCustodyProofOperationInput['outputs'][string][number],
): Record<string, unknown> {
  return omitUndefined({
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor,
    secret: output.secret,
    ephemeralE: output.ephemeralE,
  })
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
