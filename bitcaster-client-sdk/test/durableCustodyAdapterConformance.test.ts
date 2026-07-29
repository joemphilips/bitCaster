import test from 'node:test'
import { bindDurableCustodyProofOperation } from '../src/durableCustodyProofOperationRecord.ts'
import {
  deriveDurableCustodyScopeId,
  type DurableCustodyScope,
  type DurableCustodyScopeState,
} from '../src/durableCustody.ts'
import {
  assertDurableCustodyAdapterConformance,
  createDurableCustodyConformancePrepared,
  type DurableCustodyAdapterConformanceHarness,
  type DurableCustodyAdapterConformanceSnapshot,
  type DurableCustodyConformancePrepared,
} from './support/durableCustodyAdapterConformance.ts'
import { FaultInjectingDurableCustodyAdapter } from './support/faultInjectingDurableCustodyAdapter.ts'

test('in-memory custody adapter satisfies the shared conformance contract', async () => {
  await assertDurableCustodyAdapterConformance((suffix) => MemoryHarness.create(suffix))
})

class MemoryHarness implements DurableCustodyAdapterConformanceHarness {
  readonly successorProofIds: readonly string[]
  readonly #prepared: DurableCustodyConformancePrepared
  readonly #adapter: FaultInjectingDurableCustodyAdapter

  private constructor(
    prepared: DurableCustodyConformancePrepared,
    adapter: FaultInjectingDurableCustodyAdapter,
  ) {
    this.#prepared = prepared
    this.#adapter = adapter
    this.successorProofIds = prepared.successorProofIds
  }

  static create(suffix: string): MemoryHarness {
    const scope = walletScope(suffix)
    const prepared = createDurableCustodyConformancePrepared(scope, suffix)
    return new MemoryHarness(prepared, new FaultInjectingDurableCustodyAdapter(scopeState(scope)))
  }

  bind(injectFault = false): void {
    this.#adapter.run(
      (transaction) =>
        bindDurableCustodyProofOperation(
          transaction,
          this.#prepared.record,
          this.#prepared.artifacts,
        ),
      injectFault ? 'rebuild-index' : undefined,
    )
  }

  stageSelection(selectedProofIds: readonly string[], injectFault = false): void {
    const record = this.#requiredRecord()
    this.#adapter.run(
      (transaction) =>
        transaction.stageVerifiedResult({
          operationId: record.operation.operationId,
          expectedRevision: record.revision,
          authorization: owner(record.scope, 20),
          outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
          resultHandle: `conformance-result:${this.#prepared.result.fingerprint}`,
          resultFingerprint: this.#prepared.result.fingerprint,
          exactResult: this.#prepared.result,
          selectedSuccessorProofIds: [...selectedProofIds],
        }),
      injectFault ? 'stage-result' : undefined,
    )
  }

  applySelection(selectedProofIds: readonly string[], injectFault = false): void {
    const record = this.#requiredRecord()
    this.#adapter.run(
      (transaction) =>
        transaction.applyVerifiedResult({
          operationId: record.operation.operationId,
          expectedRevision: record.revision,
          authorization: owner(record.scope, 21),
          outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
          resultHandle: record.operation.result.resultHandle!,
          resultFingerprint: record.operation.result.resultFingerprint!,
          successorAdmission: {
            scopeId: record.scope.scopeId,
            operationId: record.operation.operationId,
            admissionId: `conformance-admission:${record.operation.operationId}`,
            proofRows: selectedProofIds.map((proofId) => ({
              proofId,
              expectedRevision: null,
              admittedRevision: 0,
            })),
          },
        }),
      injectFault ? 'apply-result' : undefined,
    )
  }

  reopen(): MemoryHarness {
    return new MemoryHarness(this.#prepared, this.#adapter.reopen())
  }

  snapshot(): DurableCustodyAdapterConformanceSnapshot {
    const record = this.#adapter.readOperation()
    return {
      operationState: record?.operation.state ?? null,
      resultState: record?.operation.result.state ?? null,
      selectedSuccessorProofIds:
        record?.operation.proofStorage.lineage.selectedSuccessorProofIds ?? null,
      artifactCount: this.#adapter.readArtifacts().length,
      admittedSuccessorProofIds: this.#adapter.readAdmittedProofIds(),
    }
  }

  dispose(): void {}

  #requiredRecord() {
    const record = this.#adapter.readOperation()
    if (record === null) throw new Error('conformance operation is absent')
    return record
  }
}

function walletScope(suffix: string): DurableCustodyScope {
  const input = {
    scopeKind: 'wallet' as const,
    walletId: `${'a'.repeat(63)}${suffix === 'empty' ? 'b' : 'c'}`,
  }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function scopeState(scope: DurableCustodyScope): DurableCustodyScopeState {
  return {
    schemaVersion: 1,
    scope,
    fencingEpoch: 1,
    owner: { incarnationId: `incarnation-${scope.scopeId}`, leaseExpiresAtMs: 1_000 },
    effectiveClock: { highWaterMarkMs: 10 },
  }
}

function owner(scope: DurableCustodyScope, observedAtMs: number) {
  return {
    incarnationId: `incarnation-${scope.scopeId}`,
    fencingEpoch: 1,
    observedAtMs,
  }
}
