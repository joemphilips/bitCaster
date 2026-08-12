import {
  applyDurableCustodyTransaction,
  assertDurableCustodyArtifactMatchesReference,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
} from '@bitcaster-market/client-sdk/durableCustody'
import { bindDurableCustodyProofOperation } from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  classifyDurableCtfRangeRecovery,
  prepareDurableCtfRangeRecoveredResult,
  prepareDurableCtfRangeVerifiedResult,
  recoverDurableCtfRangeVerifiedResultArtifact,
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
import type { Proof } from '@cashu/cashu-ts'
import {
  createCustodyProofSqliteRow,
  createCustodyProofSqliteRowFromMaterial,
} from './custodyProofSqliteRow.ts'
import { commitDaemonCtfRangeSource } from './ctfRangeSourceState.ts'
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
import {
  admitExactAvailableWalletProofsFromDatabase,
  completeCtfRangeRefundProofOperationFromDatabase,
  readDaemonProofOperationFromDatabase,
  type CashuProofRecord,
  type StoredProofAsset,
} from './state.ts'

export interface DaemonCtfRangeMutationInput {
  readonly observedAtMs: number
  readonly injectFault?: (phase: StateSqliteFaultPhase) => void
}

interface DaemonCtfRangeBindInput extends DaemonCtfRangeMutationInput {
  readonly binding: DurableCtfRangeCustodyBinding
  readonly proofStateClient: CtfRangeProofStateClient
  readonly signal?: AbortSignal
}

interface DaemonCtfRangeResidualBindInput extends DaemonCtfRangeBindInput {
  readonly spentSourceProofs: readonly Proof[]
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

  async bind(input: DaemonCtfRangeBindInput): Promise<DaemonDurableCtfRangeAuthority> {
    return this.#bind(input, false, null)
  }

  async bindPreparedSource(
    input: DaemonCtfRangeBindInput,
  ): Promise<DaemonDurableCtfRangeAuthority> {
    return this.#bind(input, true, null)
  }

  async bindResidualPreparedSource(
    input: DaemonCtfRangeResidualBindInput,
  ): Promise<DaemonDurableCtfRangeAuthority> {
    return this.#bind(input, true, input.spentSourceProofs)
  }

  async #bind(
    input: DaemonCtfRangeBindInput,
    commitPreparedSource: boolean,
    spentSourceProofs: readonly Proof[] | null,
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
        if (commitPreparedSource) {
          const source = commitDaemonCtfRangeSource(database, operation, input.observedAtMs)
          if (spentSourceProofs !== null) {
            spendResidualSourceProofs(
              store,
              input.binding.record,
              operation,
              spentSourceProofs,
              input.observedAtMs,
            )
          }
          admitPreparedSourceProofs(
            store,
            input.binding.record,
            operation,
            source.authorization,
            input.observedAtMs,
          )
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
      readonly resolveKeyset: DurableCtfRangeKeysetResolver
    },
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    const prepared = prepareDurableCtfRangeVerifiedResult({
      record: loaded.record,
      operation: input.operation,
      envelope: input.envelope,
      resolveKeyset: input.resolveKeyset,
    })
    return this.#stagePrepared(loaded, prepared, input)
  }

  async stageRecovered(
    input: DaemonCtfRangeMutationInput & {
      readonly custodyOperationId: string
      readonly observation: DurableCtfRangeRecoveryObservation
      readonly resolveKeyset: DurableCtfRangeKeysetResolver
    },
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    const prepared = prepareDurableCtfRangeRecoveredResult({
      record: loaded.record,
      operation: loaded.operation,
      observation: input.observation,
      resolveKeyset: input.resolveKeyset,
    })
    return this.#stagePrepared(loaded, prepared, input)
  }

  async #stagePrepared(
    loaded: DaemonDurableCtfRangeAuthority,
    prepared: ReturnType<
      typeof prepareDurableCtfRangeVerifiedResult | typeof prepareDurableCtfRangeRecoveredResult
    >,
    mutation: DaemonCtfRangeMutationInput,
  ): Promise<DurableCtfRangeRecoveryDecision> {
    if (prepared.kind === 'reconciling') return prepared
    const custodyOperationId = loaded.record.operation.operationId
    if (loaded.record.operation.result.state !== 'none') {
      await this.#assertFencedExactStagedResult(loaded.record, prepared, mutation.observedAtMs)
      return { kind: 'confirmed', result: prepared.result }
    }
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      mutation.observedAtMs,
      (database) => {
        const store = new DurableCustodySqliteStore(database)
        const current = requireOperation(store, custodyOperationId)
        if (current.operation.result.state !== 'none') {
          assertExactStagedRecord(store, current, prepared)
          return
        }
        const authorization = this.#authorization(mutation.observedAtMs)
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(
            database,
            this.#fence.scopeId,
            mutation.observedAtMs,
            [current],
          ),
          selection(current, authorization, current.revision),
          (transaction) =>
            transaction.stageVerifiedResult({
              operationId: custodyOperationId,
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
      faultOptions(mutation.injectFault),
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
        admitSpendableSuccessors(database, successors, input.observedAtMs)
      },
      faultOptions(input.injectFault),
    )
    return (await this.#requireLoaded(input.custodyOperationId)).record
  }

  async readAppliedResult(input: {
    readonly custodyOperationId: string
    readonly resolveKeyset: DurableCtfRangeKeysetResolver
  }): Promise<DurableCtfRangeRecoveredResult> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    if (loaded.record.operation.result.state !== 'applied') {
      throw new Error('daemon CTF range result has not been applied')
    }
    return this.#recoverStagedResult(loaded, input.resolveKeyset)
  }

  async completeRefund(
    input: DaemonCtfRangeMutationInput & {
      readonly custodyOperationId: string
      readonly refundOperationId: string
      readonly refundProofs: readonly CashuProofRecord[]
      readonly refundAsset: StoredProofAsset
    },
  ): Promise<void> {
    const loaded = await this.#requireLoaded(input.custodyOperationId)
    if (loaded.record.operation.state === 'aborted') {
      await this.#assertFencedExactRefundCompletion(input)
      return
    }
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#fence,
      input.observedAtMs,
      (database) => {
        completeCtfRangeRefundProofOperationFromDatabase(
          database,
          input.refundOperationId,
          input.refundProofs,
          input.observedAtMs,
        )
        const store = new DurableCustodySqliteStore(database)
        const current = requireOperation(store, input.custodyOperationId)
        if (current.operation.result.state !== 'none') {
          throw new Error('daemon CTF range refund conflicts with a settlement result')
        }
        if (current.operation.state === 'dispatch-intent') {
          const authorization = this.#authorization(input.observedAtMs)
          const transaction = new DurableCustodyTransactionSqlite(
            database,
            this.#fence.scopeId,
            input.observedAtMs,
            [current],
          )
          applyDurableCustodyTransaction(
            transaction,
            selection(current, authorization, current.revision),
            (selected) => {
              selected.transitionOperation({
                operationId: input.custodyOperationId,
                expectedRevision: current.revision,
                transition: {
                  kind: 'abort',
                  authorization,
                  expectedRevision: current.revision,
                },
              })
            },
          )
          transaction.rebuildActiveWorkIndex({
            scopeId: current.scope.scopeId,
            operationRows: [
              {
                operationId: input.custodyOperationId,
                expectedRevision: current.revision + 1,
              },
            ],
          })
          retireRefundedRangeInputs(database, current, input.observedAtMs)
        } else if (current.operation.state !== 'aborted') {
          throw new Error('daemon CTF range refund source lifecycle is invalid')
        } else {
          assertRefundedRangeInputs(database, current)
        }
        admitExactAvailableWalletProofsFromDatabase(database, {
          mintUrl: current.operation.custodyContext.normalizedMint,
          proofs: input.refundProofs,
          asset: input.refundAsset,
          nowMs: input.observedAtMs,
        })
      },
      faultOptions(input.injectFault),
    )
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

  async #assertFencedExactRefundCompletion(
    input: DaemonCtfRangeMutationInput & {
      readonly custodyOperationId: string
      readonly refundOperationId: string
      readonly refundProofs: readonly CashuProofRecord[]
    },
  ): Promise<void> {
    await withDurableCustodyFencedRead(
      this.#storage,
      this.#fence,
      input.observedAtMs,
      (database) => {
        const current = requireOperation(
          new DurableCustodySqliteStore(database),
          input.custodyOperationId,
        )
        if (current.operation.state !== 'aborted' || current.operation.result.state !== 'none') {
          throw new Error('daemon CTF range exact refund authority is not committed')
        }
        const refund = readDaemonProofOperationFromDatabase(database, input.refundOperationId)
        if (refund?.state !== 'completed') {
          throw new Error('daemon CTF range exact refund journal is not committed')
        }
        completeCtfRangeRefundProofOperationFromDatabase(
          database,
          input.refundOperationId,
          input.refundProofs,
          input.observedAtMs,
        )
        assertRefundedRangeInputs(database, current)
      },
    )
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
): PreparedSuccessorProof[] {
  if (record.scope.scopeKind !== 'wallet') {
    throw new Error('daemon CTF range successor scope is foreign')
  }
  return mapDurableCtfRangeSuccessorProofs({ record, operation, result }, (authority) => ({
    proof: successorProofRow(record, authority, nowMs),
    expectedRevision: null,
    walletProof: successorWalletProof(authority),
    walletAsset: successorWalletAsset(authority),
  }))
}

interface PreparedSuccessorProof {
  readonly proof: CustodyProofSqliteRow
  readonly expectedRevision: null
  readonly walletProof: CashuProofRecord
  readonly walletAsset: StoredProofAsset
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
    selectability: 'retained',
    storageClass: record.operation.proofStorage.storageClass,
    reservationOperationId: null,
    revision: 0,
    nowMs,
  })
}

function successorWalletProof(
  authority: NormalizedDurableCtfRangeSuccessorProof,
): CashuProofRecord {
  return {
    id: authority.proof.id,
    amount: authority.material.amount,
    secret: authority.proof.secret,
    C: authority.proof.C,
    ...(authority.proof.dleq === null ? {} : { dleq: authority.proof.dleq }),
    ...(authority.proof.p2pkE === null ? {} : { p2pk_e: authority.proof.p2pkE }),
    ...(authority.proof.witness === null ? {} : { witness: authority.proof.witness }),
  }
}

function successorWalletAsset(
  authority: NormalizedDurableCtfRangeSuccessorProof,
): StoredProofAsset {
  const { conditionId, outcomeSetId } = authority.classification
  if (conditionId === null && outcomeSetId === null) {
    return { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
  }
  if (conditionId !== null && outcomeSetId !== null) {
    return {
      kind: 'Outcome',
      conditionId,
      outcomeSetId,
      baseAsset: 'sat',
      unit: 'msat',
    }
  }
  throw new Error('daemon CTF range successor asset classification is incomplete')
}

function admitSpendableSuccessors(
  database: Parameters<typeof admitExactAvailableWalletProofsFromDatabase>[0],
  successors: readonly PreparedSuccessorProof[],
  nowMs: number,
): void {
  for (const successor of successors) {
    admitExactAvailableWalletProofsFromDatabase(database, {
      mintUrl: successor.proof.normalizedMint,
      proofs: [successor.walletProof],
      asset: successor.walletAsset,
      nowMs,
    })
  }
}

function admitPreparedSourceProofs(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  proofs: readonly Proof[],
  nowMs: number,
): void {
  if (
    proofs.length !== record.operation.reservation.inputs.length ||
    proofs.length !== operation.inputs.length
  ) {
    throw new Error('daemon CTF range source proof count is foreign')
  }
  proofs.forEach((proof, position) => {
    const row = sourceProofRow(record, operation, proof, nowMs)
    if (row.proofId !== record.operation.reservation.inputs[position]!.proofId) {
      throw new Error('daemon CTF range source proof identity is foreign')
    }
    store.putProofCas(row, null)
  })
}

function spendResidualSourceProofs(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  proofs: readonly Proof[],
  nowMs: number,
): void {
  for (const proof of proofs) {
    const expected = sourceProofRow(record, operation, proof, nowMs)
    const existing = store.getProof(record.scope.scopeId, expected.proofId)
    if (existing === null) {
      throw new Error('daemon residual source proof is absent from custody')
    }
    assertSameSourceProof(existing, expected)
    if (
      existing.selectability !== 'retained' ||
      existing.nut07State !== 'UNSPENT' ||
      existing.reservationOperationId !== null
    ) {
      throw new Error('daemon residual source proof is not spendable')
    }
    store.putProofCas(
      {
        ...existing,
        nut07State: 'SPENT',
        selectability: 'spent',
        revision: existing.revision + 1,
        updatedAtMs: Math.max(existing.createdAtMs, nowMs),
      },
      existing.revision,
    )
  }
}

function sourceProofRow(
  record: DurableCustodyRecord,
  operation: DurableCtfRangeOperation,
  proof: Proof,
  nowMs: number,
): CustodyProofSqliteRow {
  return createCustodyProofSqliteRow({
    scopeId: record.scope.scopeId,
    normalizedMint: operation.mintUrl,
    unit: operation.unit,
    proof: {
      id: proof.id,
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
      dleq: proof.dleq ?? null,
      p2pkE: proof.p2pk_e ?? null,
      witness: proof.witness ?? null,
    },
    baseAsset: 'sat',
    ...offerAssetClassification(operation),
    productBinding: null,
    signatureVerified: true,
    dleqState: proof.dleq === undefined ? 'not-present' : 'verified',
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: record.operation.proofStorage.storageClass,
    reservationOperationId: null,
    revision: 0,
    nowMs,
  })
}

function assertSameSourceProof(
  actual: CustodyProofSqliteRow,
  expected: CustodyProofSqliteRow,
): void {
  if (
    actual.proofId !== expected.proofId ||
    actual.proofFingerprint !== expected.proofFingerprint ||
    actual.normalizedMint !== expected.normalizedMint ||
    actual.unit !== expected.unit ||
    actual.keysetId !== expected.keysetId ||
    actual.amount !== expected.amount ||
    actual.baseAsset !== expected.baseAsset ||
    actual.conditionId !== expected.conditionId ||
    actual.outcomeSetId !== expected.outcomeSetId ||
    actual.signatureVerified !== expected.signatureVerified ||
    actual.dleqState !== expected.dleqState ||
    actual.storageClass !== expected.storageClass
  ) {
    throw new Error('daemon residual source proof differs from custody authority')
  }
}

function retireRefundedRangeInputs(
  database: Parameters<typeof completeCtfRangeRefundProofOperationFromDatabase>[0],
  record: DurableCustodyRecord,
  nowMs: number,
): void {
  const retire = database.prepare(
    `UPDATE custody_proofs
     SET nut07_state = 'SPENT', selectability = 'spent',
       reservation_operation_id = NULL, revision = revision + 1,
       updated_at_ms = MAX(created_at_ms, ?)
     WHERE scope_id = ? AND proof_id = ?
       AND nut07_state = 'UNSPENT' AND selectability = 'locked'
       AND reservation_operation_id = ?`,
  )
  for (const { proofId } of record.operation.reservation.inputs) {
    const updated = retire.run(nowMs, record.scope.scopeId, proofId, record.operation.operationId)
    if (updated.changes !== 1) {
      throw new Error('daemon CTF range refund predecessor CAS lost')
    }
  }
  const released = database
    .prepare(
      `DELETE FROM custody_proof_reservations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .run(record.scope.scopeId, record.operation.operationId)
  if (released.changes !== record.operation.reservation.inputs.length) {
    throw new Error('daemon CTF range refund reservation release is incomplete')
  }
}

function assertRefundedRangeInputs(
  database: Parameters<typeof completeCtfRangeRefundProofOperationFromDatabase>[0],
  record: DurableCustodyRecord,
): void {
  const read = database.prepare(
    `SELECT nut07_state AS nut07State, selectability,
       reservation_operation_id AS reservationOperationId
     FROM custody_proofs
     WHERE scope_id = ? AND proof_id = ?`,
  )
  for (const { proofId } of record.operation.reservation.inputs) {
    const proof = read.get(record.scope.scopeId, proofId) as
      | {
          nut07State: string
          selectability: string
          reservationOperationId: string | null
        }
      | undefined
    if (
      proof?.nut07State !== 'SPENT' ||
      proof.selectability !== 'spent' ||
      proof.reservationOperationId !== null
    ) {
      throw new Error('daemon CTF range refund predecessor authority is incomplete')
    }
  }
}

function offerAssetClassification(operation: DurableCtfRangeOperation): {
  readonly conditionId: string | null
  readonly outcomeSetId: string | null
} {
  return operation.offerAsset.kind === 'regular'
    ? { conditionId: null, outcomeSetId: null }
    : {
        conditionId: operation.offerAsset.conditionId,
        outcomeSetId: operation.offerAsset.outcomeCollection,
      }
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
