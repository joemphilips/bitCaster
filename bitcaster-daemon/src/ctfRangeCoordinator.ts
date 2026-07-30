import {
  applyDurableCustodyTransaction,
  assertDurableCustodyArtifactMatchesReference,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
} from '@bitcaster-market/client-sdk/durableCustody'
import { bindDurableCustodyProofOperation } from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  classifyDurableCtfRangeRecovery,
  prepareDurableCtfRangeVerifiedResult,
  recoverDurableCtfRangeVerifiedResultArtifact,
  type DurableCtfRangeAllManifestRecovery,
  type DurableCtfRangeCustodyBinding,
  type DurableCtfRangeKeysetResolver,
  type DurableCtfRangeOperation,
  type DurableCtfRangeRecoveryDecision,
  type DurableCtfRangeRecoveryObservation,
  type DurableCtfRangeRecoveredResult,
  type DurableCtfRangeResultEnvelope,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  assertDurableCtfRangeExactBinding,
  assertDurableCtfRangeExactCommittedBinding,
  assertDurableCtfRangeInputsUnspent,
  createDurableCtfRangeStagedResultAuthority,
  mapDurableCtfRangeSuccessorProofs,
  matchDurableCtfRangeExactStagedResult,
  requireDurableCtfRangeStagedResultAuthority,
  type NormalizedDurableCtfRangeSuccessorProof,
} from '@bitcaster-market/client-sdk/durableCtfRangeCustody'
import {
  checkCtfRangeInputProofStates,
  type CtfRangeProofStateClient,
} from '@bitcaster-market/client-sdk/ctfRangeRecoveryTransport'
import { createCustodyProofSqliteRowFromMaterial } from './custodyProofSqliteRow.ts'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import {
  loadDaemonDurableCtfRangeAuthority,
  type DaemonDurableCtfRangeAuthority,
} from './durableCtfRangeSqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  createDaemonStateSqliteSession,
  type DaemonStateSqliteSession,
  type StateSqliteFaultPhase,
} from './stateSqlite.ts'

export interface DaemonCtfRangeMutationInput {
  readonly observedAtMs: number
  readonly injectFault?: (phase: StateSqliteFaultPhase) => void
}

export class DaemonCtfRangeCoordinator {
  readonly #fence: CustodyScopeFence
  readonly #storage: DaemonStateSqliteSession

  constructor(directory: string, fence: CustodyScopeFence) {
    this.#fence = fence
    this.#storage = createDaemonStateSqliteSession(directory)
  }

  async load(custodyOperationId: string): Promise<DaemonDurableCtfRangeAuthority | null> {
    return this.#storage.read((database) => {
      const loaded = loadDaemonDurableCtfRangeAuthority(
        new DurableCustodySqliteStore(database),
        custodyOperationId,
      )
      if (loaded !== null) this.#assertScope(loaded.record)
      return loaded
    })
  }

  async bind(
    input: DaemonCtfRangeMutationInput & {
      readonly binding: DurableCtfRangeCustodyBinding
      readonly proofStateClient: CtfRangeProofStateClient
      readonly signal?: AbortSignal
    },
  ): Promise<DaemonDurableCtfRangeAuthority> {
    const custodyOperationId = input.binding.record.operation.operationId
    this.#assertScope(input.binding.record)
    const existing = await this.load(custodyOperationId)
    if (existing !== null) {
      await this.#validateFencedExactBinding(input.binding, input.observedAtMs)
      return this.#requireLoaded(custodyOperationId)
    }
    const operation = assertDurableCtfRangeExactBinding(input.binding)
    const states = await checkCtfRangeInputProofStates(
      input.proofStateClient,
      operation.inputs,
      input.signal,
    )
    assertDurableCtfRangeInputsUnspent(states)
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      input.observedAtMs,
      (database) => {
        const store = new DurableCustodySqliteStore(database)
        const current = store.getOperation(custodyOperationId)
        if (current !== null) {
          assertDurableCtfRangeExactCommittedBinding(current, input.binding.record, operation)
          return
        }
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(database, this.#fence.scopeId, input.observedAtMs),
          selection(input.binding.record, this.#authorization(input.observedAtMs), null),
          (transaction) =>
            bindDurableCustodyProofOperation(
              transaction,
              input.binding.record,
              input.binding.artifacts,
            ),
        )
      },
      faultOptions(input.injectFault),
    )
    return this.#requireLoaded(custodyOperationId)
  }

  async stageVerified(
    input: DaemonCtfRangeMutationInput & {
      readonly custodyOperationId: string
      readonly operation: DurableCtfRangeOperation
      readonly envelope: DurableCtfRangeResultEnvelope
      readonly allManifestRecovery: DurableCtfRangeAllManifestRecovery
      readonly resolveKeyset: DurableCtfRangeKeysetResolver
    },
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    const prepared = prepareDurableCtfRangeVerifiedResult({
      record: loaded.record,
      operation: input.operation,
      envelope: input.envelope,
      allManifestRecovery: input.allManifestRecovery,
      resolveKeyset: input.resolveKeyset,
    })
    if (prepared.kind === 'reconciling') return prepared
    if (loaded.record.operation.result.state !== 'none') {
      await this.#assertFencedExactStagedResult(loaded.record, prepared, input.observedAtMs)
      return { kind: 'confirmed', result: prepared.result }
    }
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      input.observedAtMs,
      (database) => {
        const store = new DurableCustodySqliteStore(database)
        const current = requireOperation(store, input.custodyOperationId)
        if (current.operation.result.state !== 'none') {
          assertExactStagedRecord(store, current, prepared)
          return
        }
        const authorization = this.#authorization(input.observedAtMs)
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(database, this.#fence.scopeId, input.observedAtMs, [
            current,
          ]),
          selection(current, authorization, current.revision),
          (transaction) =>
            transaction.stageVerifiedResult({
              operationId: input.custodyOperationId,
              expectedRevision: current.revision,
              authorization,
              outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
              resultHandle: prepared.resultHandle,
              resultFingerprint: prepared.resultFingerprint,
              exactResult: prepared.exactResult,
              selectedSuccessorProofIds: prepared.selectedSuccessorProofIds,
            }),
        )
      },
      faultOptions(input.injectFault),
    )
    return { kind: 'confirmed', result: prepared.result }
  }

  async applyStaged(
    input: DaemonCtfRangeMutationInput & {
      readonly custodyOperationId: string
      readonly resolveKeyset: DurableCtfRangeKeysetResolver
    },
  ): Promise<DurableCustodyRecord> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    if (loaded.record.operation.result.state === 'none') {
      throw new Error('daemon CTF range result has not been staged')
    }
    if (loaded.record.operation.result.state === 'applied') {
      return this.#requireFencedExactApplied(loaded.record, input.observedAtMs)
    }
    const result = await this.#recoverStagedResult(loaded, input.resolveKeyset)
    const successors = prepareSuccessorProofRows(
      loaded.record,
      loaded.operation,
      result,
      input.observedAtMs,
    )
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      input.observedAtMs,
      (database) => {
        const store = new DurableCustodySqliteStore(database)
        const current = requireOperation(store, input.custodyOperationId)
        if (current.operation.result.state === 'applied') return
        const exactStaged = matchDurableCtfRangeExactStagedResult(
          current,
          requireDurableCtfRangeStagedResultAuthority(loaded.record),
        )
        if (exactStaged === null) {
          throw new Error('daemon CTF range staged apply authority is absent')
        }
        const authorization = this.#authorization(input.observedAtMs)
        const transaction = new DurableCustodyTransactionSqlite(
          database,
          this.#fence.scopeId,
          input.observedAtMs,
          [current],
        )
        transaction.stageSuccessorProofCas(input.custodyOperationId, successors)
        applyDurableCustodyTransaction(
          transaction,
          selection(current, authorization, current.revision),
          (selected) =>
            selected.applyVerifiedResult({
              operationId: input.custodyOperationId,
              expectedRevision: current.revision,
              authorization,
              outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
              resultHandle: requireResultText(current.operation.result.resultHandle),
              resultFingerprint: requireResultText(current.operation.result.resultFingerprint),
              successorAdmission: {
                scopeId: current.scope.scopeId,
                operationId: input.custodyOperationId,
                admissionId: `ctf-range-admission:${requireResultText(
                  current.operation.result.resultFingerprint,
                )}`,
                proofRows: successors.map(({ proof, expectedRevision }) => ({
                  proofId: proof.proofId,
                  expectedRevision,
                  admittedRevision: proof.revision,
                })),
              },
            }),
        )
      },
      faultOptions(input.injectFault),
    )
    return (await this.#requireLoaded(input.custodyOperationId)).record
  }

  async classifyRecovery(input: {
    readonly custodyOperationId: string
    readonly observation: DurableCtfRangeRecoveryObservation
    readonly resolveKeyset: DurableCtfRangeKeysetResolver
  }): Promise<DurableCtfRangeRecoveryDecision> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    return classifyDurableCtfRangeRecovery({
      operation: loaded.operation,
      record: loaded.record,
      observation: input.observation,
      resolveKeyset: input.resolveKeyset,
    })
  }

  async #recoverStagedResult(
    loaded: DaemonDurableCtfRangeAuthority,
    resolveKeyset: DurableCtfRangeKeysetResolver,
  ): Promise<DurableCtfRangeRecoveredResult> {
    const reference = loaded.record.operation.result.exactResult
    if (reference === null) throw new Error('daemon CTF range result artifact is absent')
    return this.#storage.read((database) => {
      const row = new DurableCustodySqliteStore(database).getArtifact({
        scopeId: loaded.record.scope.scopeId,
        operationId: loaded.record.operation.operationId,
        expectedOperationRevision: loaded.record.revision,
        reference,
      })
      if (row === null) throw new Error('daemon CTF range result artifact is absent')
      return recoverDurableCtfRangeVerifiedResultArtifact({
        record: loaded.record,
        operation: loaded.operation,
        exactResult: row.artifact,
        resolveKeyset,
      })
    })
  }

  async #assertFencedExactStagedResult(
    record: DurableCustodyRecord,
    prepared: Extract<
      ReturnType<typeof prepareDurableCtfRangeVerifiedResult>,
      { kind: 'confirmed' }
    >,
    observedAtMs: number,
  ): Promise<void> {
    await withDurableCustodyFencedRead(this.#storage, this.#fence, observedAtMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const current = requireOperation(store, record.operation.operationId)
      assertExactStagedRecord(store, current, prepared)
    })
  }

  async #requireFencedExactApplied(
    expected: DurableCustodyRecord,
    observedAtMs: number,
  ): Promise<DurableCustodyRecord> {
    await withDurableCustodyFencedRead(this.#storage, this.#fence, observedAtMs, (database) => {
      const current = requireOperation(
        new DurableCustodySqliteStore(database),
        expected.operation.operationId,
      )
      if (current.operation.result.state !== 'applied') {
        throw new Error('daemon CTF range exact apply authority is not committed')
      }
      matchDurableCtfRangeExactStagedResult(
        current,
        requireDurableCtfRangeStagedResultAuthority(expected),
      )
    })
    return (await this.#requireLoaded(expected.operation.operationId)).record
  }

  async #validateFencedExactBinding(
    binding: DurableCtfRangeCustodyBinding,
    observedAtMs: number,
  ): Promise<void> {
    await withDurableCustodyFencedRead(this.#storage, this.#fence, observedAtMs, (database) => {
      const operation = assertDurableCtfRangeExactBinding(binding)
      const current = requireOperation(
        new DurableCustodySqliteStore(database),
        binding.record.operation.operationId,
      )
      assertDurableCtfRangeExactCommittedBinding(current, binding.record, operation)
    })
  }

  async #requireLoaded(custodyOperationId: string): Promise<DaemonDurableCtfRangeAuthority> {
    const loaded = await this.load(custodyOperationId)
    if (loaded === null) throw new Error('daemon CTF range operation is absent')
    return loaded
  }

  #authorization(observedAtMs: number): DurableCustodyOwnerAuthorization {
    return {
      incarnationId: this.#fence.incarnationId,
      fencingEpoch: this.#fence.fencingEpoch,
      observedAtMs,
    }
  }

  #assertScope(record: DurableCustodyRecord): void {
    if (record.scope.scopeId !== this.#fence.scopeId || record.scope.scopeKind !== 'wallet') {
      throw new Error('daemon CTF range scope is foreign')
    }
  }
}

type ConfirmedPreparation = Extract<
  ReturnType<typeof prepareDurableCtfRangeVerifiedResult>,
  { kind: 'confirmed' }
>

function assertExactStagedRecord(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  prepared: ConfirmedPreparation,
): void {
  const authority = createDurableCtfRangeStagedResultAuthority({
    record,
    exactResult: prepared.exactResult,
    resultHandle: prepared.resultHandle,
    resultFingerprint: prepared.resultFingerprint,
    selectedSuccessorProofIds: prepared.selectedSuccessorProofIds,
  })
  const resultReference = matchDurableCtfRangeExactStagedResult(record, authority)
  if (resultReference === null) throw new Error('daemon CTF range result has not been staged')
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: resultReference,
  })
  if (row === null) throw new Error('daemon CTF range result artifact is absent')
  assertDurableCustodyArtifactMatchesReference(resultReference, prepared.exactResult)
  assertDurableCustodyArtifactMatchesReference(resultReference, row.artifact)
}

function prepareSuccessorProofRows(
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  result: DurableCtfRangeRecoveredResult,
  nowMs: number,
): Array<{ proof: CustodyProofSqliteRow; expectedRevision: null }> {
  if (record.scope.scopeKind !== 'wallet') {
    throw new Error('daemon CTF range successor scope is foreign')
  }
  return mapDurableCtfRangeSuccessorProofs({ record, operation, result }, (authority) => ({
    proof: successorProofRow(record, authority, nowMs),
    expectedRevision: null,
  }))
}

function successorProofRow(
  record: DurableCustodyRecord,
  authority: NormalizedDurableCtfRangeSuccessorProof,
  nowMs: number,
): CustodyProofSqliteRow {
  return createCustodyProofSqliteRowFromMaterial({
    scopeId: record.scope.scopeId,
    normalizedMint: record.operation.custodyContext.normalizedMint,
    unit: 'msat',
    material: authority.material,
    baseAsset: 'sat',
    ...authority.classification,
    productBinding: null,
    signatureVerified: true,
    dleqState: authority.dleqState,
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: record.operation.proofStorage.storageClass,
    reservationOperationId: null,
    revision: 0,
    nowMs,
  })
}

function selection(
  record: DurableCustodyRecord,
  owner: DurableCustodyOwnerAuthorization,
  expectedRevision: number | null,
) {
  return {
    scope: record.scope,
    owner,
    operationRows: [{ operationId: record.operation.operationId, expectedRevision }],
  }
}

function requireOperation(
  store: DurableCustodySqliteStore,
  operationId: string,
): DurableCustodyRecord {
  const record = store.getOperation(operationId)
  if (record === null) throw new Error('daemon CTF range operation is absent')
  return record
}

function requireResultText(value: string | null): string {
  if (value === null || value.length === 0) throw new Error('daemon CTF range result is incomplete')
  return value
}

function faultOptions(injectFault: ((phase: StateSqliteFaultPhase) => void) | undefined) {
  return injectFault === undefined ? {} : { injectFault }
}
