import {
  reduceDurableCustodyState,
  type DurableCustodyArtifactRow,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
} from '../../src/durableCustody.ts'

interface AdapterSnapshot {
  scopeState: DurableCustodyScopeState
  operation: DurableCustodyRecord | null
  artifacts: Map<string, DurableCustodyArtifactRow>
  reservations: string[]
  admittedProofIds: string[]
}

export class FaultInjectingDurableCustodyAdapter {
  private snapshot: AdapterSnapshot

  constructor(scopeState: DurableCustodyScopeState, snapshot?: AdapterSnapshot) {
    this.snapshot = snapshot
      ? structuredClone(snapshot)
      : {
          scopeState: structuredClone(scopeState),
          operation: null,
          artifacts: new Map(),
          reservations: [],
          admittedProofIds: [],
        }
  }

  run<T>(apply: (transaction: DurableCustodyTransaction) => T, failAfter?: string): T {
    const draft = structuredClone(this.snapshot)
    const transaction = createTransaction(draft, failAfter)
    const result = apply(transaction)
    this.snapshot = draft
    return result
  }

  reopen(): FaultInjectingDurableCustodyAdapter {
    return new FaultInjectingDurableCustodyAdapter(this.snapshot.scopeState, this.snapshot)
  }

  readOperation(): DurableCustodyRecord | null {
    return structuredClone(this.snapshot.operation)
  }

  readArtifacts(): DurableCustodyArtifactRow[] {
    return [...this.snapshot.artifacts.values()].map((row) => structuredClone(row))
  }

  readAdmittedProofIds(): string[] {
    return [...this.snapshot.admittedProofIds]
  }
}

function createTransaction(
  draft: AdapterSnapshot,
  failAfter: string | undefined,
): DurableCustodyTransaction {
  const trip = (point: string) => {
    if (failAfter === point) throw new Error(`injected fault after ${point}`)
  }
  return {
    getScopeState: () => structuredClone(draft.scopeState),
    getOperation: () => structuredClone(draft.operation),
    putOperation: ({ record }) => {
      draft.operation = structuredClone(record)
      trip('put-operation')
    },
    getArtifact: ({ reference }) =>
      structuredClone(draft.artifacts.get(reference.artifactId) ?? null),
    putArtifact: ({ reference, artifact, expectedArtifactRevision }) => {
      draft.artifacts.set(reference.artifactId, {
        reference: structuredClone(reference),
        artifact: structuredClone(artifact),
        revision: expectedArtifactRevision === null ? 0 : expectedArtifactRevision + 1,
      })
      trip('put-artifact')
    },
    reserveExactInputs: ({ proofIds }) => {
      draft.reservations = [...proofIds]
      trip('reserve-inputs')
    },
    transitionOperation: ({ transition }) => {
      applyTransition(draft, transition)
      trip('transition-operation')
    },
    stageVerifiedResult: (input) => {
      applyTransition(draft, {
        kind: 'stage-verified-result',
        authorization: input.authorization,
        expectedRevision: input.expectedRevision,
        resultHandle: input.resultHandle,
        resultFingerprint: input.resultFingerprint,
        outputPlanFingerprint: input.outputPlanFingerprint,
        exactResult: input.exactResult,
        selectedSuccessorProofIds: input.selectedSuccessorProofIds,
      })
      const reference = draft.operation!.operation.result.exactResult!
      draft.artifacts.set(reference.artifactId, {
        reference,
        artifact: structuredClone(input.exactResult),
        revision: 0,
      })
      trip('stage-result')
    },
    applyVerifiedResult: (input) => {
      applyTransition(draft, {
        kind: 'apply-verified-result',
        authorization: input.authorization,
        expectedRevision: input.expectedRevision,
        successorAdmission: input.successorAdmission,
      })
      draft.admittedProofIds = input.successorAdmission.proofRows.map(({ proofId }) => proofId)
      trip('apply-result')
    },
    reconcileAuthenticatedTerminalMintRejection: (input) => {
      applyTransition(draft, {
        kind: 'reconcile-authenticated-terminal-mint-rejection',
        authorization: input.authorization,
        expectedRevision: input.expectedRevision,
        rejectionHandle: input.rejectionHandle,
        rejectionFingerprint: input.rejectionFingerprint,
        exactRejection: input.exactRejection,
        code: input.code,
        predecessorDisposition: input.predecessorDisposition,
      })
      const reference = draft.operation!.operation.terminalMintRejection!.exactRejection
      draft.artifacts.set(reference.artifactId, {
        reference,
        artifact: structuredClone(input.exactRejection),
        revision: 0,
      })
      trip('reconcile-terminal-mint-rejection')
    },
    rebuildActiveWorkIndex: () => trip('rebuild-index'),
  }
}

function applyTransition(
  draft: AdapterSnapshot,
  transition: Parameters<typeof reduceDurableCustodyState>[1],
): void {
  if (draft.operation === null) throw new Error('operation is absent')
  const next = reduceDurableCustodyState(
    { scopeState: draft.scopeState, operation: draft.operation },
    transition,
  )
  draft.scopeState = next.scopeState
  draft.operation = next.operation
}
