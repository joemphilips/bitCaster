import assert from 'node:assert/strict'
import {
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from '../../src/durableCustody.ts'

export interface DurableCustodyAdapterConformanceSnapshot {
  operationState: DurableCustodyRecord['operation']['state'] | null
  resultState: DurableCustodyRecord['operation']['result']['state'] | null
  selectedSuccessorProofIds: string[] | null
  artifactCount: number
  admittedSuccessorProofIds: string[]
}

export interface DurableCustodyAdapterConformanceHarness {
  readonly successorProofIds: readonly string[]
  bind(injectFault?: boolean): void | Promise<void>
  stageSelection(selectedProofIds: readonly string[], injectFault?: boolean): void | Promise<void>
  applySelection(selectedProofIds: readonly string[], injectFault?: boolean): void | Promise<void>
  reopen():
    | DurableCustodyAdapterConformanceHarness
    | Promise<DurableCustodyAdapterConformanceHarness>
  snapshot():
    | DurableCustodyAdapterConformanceSnapshot
    | Promise<DurableCustodyAdapterConformanceSnapshot>
  dispose(): void | Promise<void>
}

export interface DurableCustodyConformancePrepared {
  record: DurableCustodyRecord
  artifacts: {
    requestBody: DurableCustodyExactArtifact
    output: DurableCustodyExactArtifact
    privateMaterial: DurableCustodyExactArtifact
  }
  result: DurableCustodyExactArtifact
  predecessorProofId: string
  successorProofIds: readonly string[]
}

export async function assertDurableCustodyAdapterConformance(
  createHarness: (
    suffix: string,
  ) => DurableCustodyAdapterConformanceHarness | Promise<DurableCustodyAdapterConformanceHarness>,
): Promise<void> {
  const selectedHarness = await createHarness('selected')
  try {
    const selectedProofId = selectedHarness.successorProofIds[1]
    assert.ok(selectedProofId)
    await assert.rejects(
      async () => await selectedHarness.bind(true),
      /injected.*bind|injected.*fault/i,
    )
    assert.deepEqual(await selectedHarness.snapshot(), emptySnapshot())

    await selectedHarness.bind()
    let reopened = await selectedHarness.reopen()
    assert.deepEqual(await reopened.snapshot(), {
      operationState: 'dispatch-intent',
      resultState: 'none',
      selectedSuccessorProofIds: null,
      artifactCount: 3,
      admittedSuccessorProofIds: [],
    })

    await assert.rejects(
      async () => await reopened.stageSelection([selectedProofId], true),
      /injected.*stage|injected.*fault/i,
    )
    reopened = await reopened.reopen()
    assert.deepEqual(await reopened.snapshot(), {
      operationState: 'dispatch-intent',
      resultState: 'none',
      selectedSuccessorProofIds: null,
      artifactCount: 3,
      admittedSuccessorProofIds: [],
    })

    await reopened.stageSelection([selectedProofId])
    reopened = await reopened.reopen()
    assert.deepEqual(await reopened.snapshot(), {
      operationState: 'dispatch-intent',
      resultState: 'verified-staged',
      selectedSuccessorProofIds: [selectedProofId],
      artifactCount: 4,
      admittedSuccessorProofIds: [],
    })

    await assert.rejects(
      async () => await reopened.applySelection([selectedProofId], true),
      /injected.*apply|injected.*fault/i,
    )
    reopened = await reopened.reopen()
    assert.deepEqual(await reopened.snapshot(), {
      operationState: 'dispatch-intent',
      resultState: 'verified-staged',
      selectedSuccessorProofIds: [selectedProofId],
      artifactCount: 4,
      admittedSuccessorProofIds: [],
    })

    await reopened.applySelection([selectedProofId])
    reopened = await reopened.reopen()
    assert.deepEqual(await reopened.snapshot(), {
      operationState: 'reconciled',
      resultState: 'applied',
      selectedSuccessorProofIds: [selectedProofId],
      artifactCount: 4,
      admittedSuccessorProofIds: [selectedProofId],
    })
  } finally {
    await selectedHarness.dispose()
  }

  const emptyHarness = await createHarness('empty')
  try {
    await emptyHarness.bind()
    let reopened = await emptyHarness.reopen()
    await reopened.stageSelection([])
    reopened = await reopened.reopen()
    const staged = await reopened.snapshot()
    assert.equal(staged.resultState, 'verified-staged')
    assert.deepEqual(staged.selectedSuccessorProofIds, [])
    await reopened.applySelection([])
    reopened = await reopened.reopen()
    const applied = await reopened.snapshot()
    assert.equal(applied.operationState, 'reconciled')
    assert.equal(applied.resultState, 'applied')
    assert.deepEqual(applied.selectedSuccessorProofIds, [])
    assert.deepEqual(applied.admittedSuccessorProofIds, [])
  } finally {
    await emptyHarness.dispose()
  }
}

export function createDurableCustodyConformancePrepared(
  scope: DurableCustodyScope,
  suffix: string,
): DurableCustodyConformancePrepared {
  const exactRequest = artifact({ request: suffix })
  const successorCount = suffix === 'empty' ? 0 : 2
  const exactOutput = artifact({
    outputs: Array.from({ length: successorCount }, (_, index) => `successor-${suffix}-${index}`),
  })
  const privateMaterial = artifact({ secret: `private-${suffix}` })
  const predecessorProofId = proofId(scope, `predecessor-${suffix}`)
  const successorProofIds = Array.from({ length: successorCount }, (_, index) =>
    proofId(scope, `successor-${suffix}-${index}`),
  )
  const facts = createDurableProofOperationFacts({
    unit: 'sat',
    binding: { kind: 'wallet', activityId: `activity-${suffix}`, stage: 'send' },
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
    retainedOperationKey: `conformance-${suffix}`,
    semanticKind: 'wallet-send',
    facts,
    normalizedMint: 'https://mint.example',
    inventoryAccountId: scopeInventoryAccountId(scope),
    reservation: {
      reservationId: `reservation-${suffix}`,
      parentReservationId: null,
      inputs: [{ proofId: predecessorProofId, keysetId: 'keyset-1', curve: 'secp256k1' }],
    },
    proofLineage: {
      predecessorProofIds: [predecessorProofId],
      successorProofIds,
      successorAdmissionMode: 'subset',
    },
    exactRequest: {
      requestId: `request-${suffix}`,
      requestFingerprint: exactRequest.fingerprint,
      payloadHandle: `request-payload-${suffix}`,
      inputProofIds: [predecessorProofId],
      outputPlanFingerprint: exactOutput.fingerprint,
      method: 'POST',
      path: '/v1/conformance',
      idempotencyKey: `conformance-${suffix}`,
      body: exactRequest,
    },
    outputPlan: {
      outputPlanId: `output-plan-${suffix}`,
      outputPlanFingerprint: exactOutput.fingerprint,
      outputMaterialHandle: `output-material-${suffix}`,
      exactOutput,
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
    artifacts: {
      requestBody: exactRequest,
      output: exactOutput,
      privateMaterial,
    },
    result: artifact({ selected: suffix }),
    predecessorProofId,
    successorProofIds,
  }
}

function scopeInventoryAccountId(scope: DurableCustodyScope): string | null {
  switch (scope.scopeKind) {
    case 'market':
      return scope.inventoryAccountId
    case 'wallet':
      return null
  }
}

function emptySnapshot(): DurableCustodyAdapterConformanceSnapshot {
  return {
    operationState: null,
    resultState: null,
    selectedSuccessorProofIds: null,
    artifactCount: 0,
    admittedSuccessorProofIds: [],
  }
}

function proofId(scope: DurableCustodyScope, secret: string): string {
  return deriveDurableCustodyProofId({
    scopeId: scope.scopeId,
    normalizedMint: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-1',
    secret,
  })
}

function artifact(value: unknown): DurableCustodyExactArtifact {
  return {
    encoding: 'canonical-json',
    artifact: value,
    fingerprint: deriveDurableCustodyArtifactFingerprint(value),
  }
}
