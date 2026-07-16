import { isDeepStrictEqual } from 'node:util'
import type { CtfRedeemMintSubmissionBinding } from '@bitcaster-market/client-sdk/ctfSplit'
import {
  decideDurableCustodyRecovery,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
  durableCustodySemanticPolicy,
  type DurableCustodyBinding,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyRecoveryClassification,
  type DurableCustodyRecoveryDecision,
  type DurableCustodyRecoveryInput,
  type DurableCustodyStore,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofOperationFingerprints,
  deriveDurableCustodyProofResultFingerprint,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  reduceDurableTradeSession,
  validateDurableProofOperationLink,
  validateDurableTradeSession,
  type DurableTradeProofOperationLink,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { validateDaemonDurableOperationBinding } from './durableTradeBinding.ts'
import type { DaemonDurableCustodyLease } from './durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from './durableCustodySqliteStore.ts'
import {
  DaemonCustodyUnitOfWork,
  type DaemonCustodyStateEffects,
  type DaemonCustodyUnitOfWorkTransaction,
} from './durableCustodyUnitOfWork.ts'
import {
  daemonCustodySemanticKind,
  resolveDaemonProofOperationFacts,
  type DaemonMintKeyResolver,
} from './durableProofOperationFacts.ts'
import {
  assertCompatibleProofOperation,
  assertValidCompletedProofOperationResult,
  getProofOperation,
  normalizeCashuProofRecord,
  normalizeProofRecordGroups,
  walletProofSelectorsForPrepare,
  walletProofSelectorsForRecoveryAbort,
  type CashuProofRecord,
  type CompleteProofOperationWithWalletUpdateInput,
  type DaemonCanonicalRecoveryPage,
  type DaemonProofOperationCoordinatorPort,
  type DaemonProofOperationSafeAbortEvidence,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
} from './state.ts'
import type { DaemonStateRowScope } from './stateSqlite.ts'
import {
  assertOrderCollateralPinOwnsProofs,
  bindOrderCollateralOperationInDatabase,
  releaseOrderCollateralOperationAllocationInDatabase,
} from './durableOrderCollateralSqlite.ts'
import {
  requireDaemonWalletSendDeliveryPreparation,
} from './durableWalletSendPreparation.ts'

interface DaemonCustodyAuthority {
  readonly scope: DaemonDurableCustodyLease['scope']
  assertActive(): void
  authorization(): ReturnType<DaemonDurableCustodyLease['authorization']>
}

interface DaemonProofOperationCoordinatorOptions {
  authority: DaemonCustodyAuthority
  unitOfWork?: DaemonCustodyUnitOfWork
  recoveryStore?: DurableCustodyStore
  resolveMintKeys?: DaemonMintKeyResolver
}

type CustodyTransaction = DaemonCustodyUnitOfWorkTransaction['custody']

export class DaemonProofOperationCoordinator
  implements DaemonProofOperationCoordinatorPort {
  private readonly authority: DaemonCustodyAuthority
  private readonly unitOfWork: DaemonCustodyUnitOfWork
  private readonly recoveryStore: DurableCustodyStore
  private readonly resolveMintKeys: DaemonMintKeyResolver | undefined

  constructor(options: DaemonProofOperationCoordinatorOptions) {
    this.authority = options.authority
    this.unitOfWork = options.unitOfWork ?? new DaemonCustodyUnitOfWork()
    this.recoveryStore = options.recoveryStore ?? new SqliteDurableCustodyStore()
    this.resolveMintKeys = options.resolveMintKeys
  }

  async listRecoverablePage(input: {
    cursor: string | null
    limit: number
  }): Promise<DaemonCanonicalRecoveryPage> {
    this.authority.assertActive()
    const page = await this.recoveryStore.listRecoverablePage({
      scope: this.authority.scope,
      cursor: input.cursor,
      limit: input.limit,
    })
    return {
      work: page.records.map((record) => ({
        custodyOperationId: record.operation.operationId,
        retainedOperationKey: record.operation.retainedOperationKey,
        binding: record.operation.binding.kind === 'wallet'
          ? {
              kind: 'wallet' as const,
              activityId: record.operation.binding.activityId,
            }
          : {
              kind: 'trade' as const,
              tradeId: record.operation.binding.tradeId,
            },
      })),
      nextCursor: page.nextCursor,
    }
  }

  async prepare(
    input: PrepareProofOperationInput,
  ): Promise<ProofOperationRecord> {
    this.authority.assertActive()
    const facts = await resolveDaemonProofOperationFacts(
      input,
      this.resolveMintKeys,
    )
    const custodyRecord = createDurableCustodyProofOperation({
      scope: this.authority.scope,
      operation: input,
      facts,
      inventoryAccountId: null,
      reservationId: input.walletProofReservation?.reservationId,
      parentReservationId:
        input.walletProofReservation?.parentOrderCollateralPinId,
      walletSendDeliveryPreparation:
        requireDaemonWalletSendDeliveryPreparation(input),
    })
    return this.unitOfWork.transact(
      this.transactionInput(
        stateScopeFor(input),
        custodyRecord.operation.operationId,
      ),
      (transaction) => prepareInTransaction({
        transaction,
        input,
        custodyRecord,
      }),
    )
  }

  async markMintSubmitted(
    operationId: string,
    redeemBinding?: CtfRedeemMintSubmissionBinding,
  ): Promise<ProofOperationRecord> {
    this.authority.assertActive()
    const context = await existingOperationContext(
      this.authority.scope.scopeId,
      operationId,
    )
    return this.unitOfWork.transact(
      this.transactionInput(context.stateScope, context.custodyOperationId),
      ({ custody, state, now }) => {
        const existing = requireStateOperation(state, operationId)
        const custodyId = custodyOperationId(this.authority.scope.scopeId, existing)
        const canonical = requireCustodyOperation(custody, custodyId)
        if (existing.state === 'mint-submitted') {
          assertCustodyState(canonical, 'transport-attempted')
          return existing
        }
        if (existing.state === 'completed' || existing.state === 'Failed') {
          throw new Error('cannot submit a terminal proof operation')
        }
        custody.transitionOperation({
          operationId: custodyId,
          transition: { kind: 'transport-attempted' },
        })
        custody.rebuildActiveWorkIndex()
        const updated = submittedStateRecord(
          state,
          existing,
          now,
          redeemBinding,
        )
        state.putProofOperation(updated)
        return updated
      },
    )
  }

  async complete(
    operationId: string,
    resultProofs: Record<string, CashuProofRecord[]>,
  ): Promise<ProofOperationRecord> {
    return this.completeOperation({ operationId, resultProofs })
  }

  async completeWithWalletUpdate(
    input: CompleteProofOperationWithWalletUpdateInput,
  ): Promise<ProofOperationRecord> {
    return this.completeOperation(input)
  }

  async assertRecoveryBound(operation: ProofOperationRecord): Promise<void> {
    this.authority.assertActive()
    const context = await existingOperationContext(
      this.authority.scope.scopeId,
      operation.operationId,
    )
    await this.unitOfWork.transact(
      this.transactionInput(context.stateScope, context.custodyOperationId),
      ({ custody, state }) => {
        const current = requireStateOperation(state, operation.operationId)
        if (!isDeepStrictEqual(current, operation)) {
          throw new Error('proof operation changed before custody validation')
        }
        const custodyId = custodyOperationId(
          this.authority.scope.scopeId,
          current,
        )
        assertRecoveryAuthority(
          requireCustodyOperation(custody, custodyId),
          current,
        )
      },
    )
  }

  async decideRecovery(
    operation: ProofOperationRecord,
    classification: DurableCustodyRecoveryClassification,
    exactRequestDisposition: DurableCustodyRecoveryInput['exactRequestDisposition'] =
      'unknown',
  ): Promise<DurableCustodyRecoveryDecision> {
    this.authority.assertActive()
    const context = await existingOperationContext(
      this.authority.scope.scopeId,
      operation.operationId,
    )
    const owner = this.authority.authorization()
    return this.unitOfWork.transact(
      {
        scope: this.authority.scope,
        owner,
        operationIds: [context.custodyOperationId],
        stateScope: context.stateScope,
      },
      ({ custody, state }) => {
        const current = requireStateOperation(state, operation.operationId)
        if (!isDeepStrictEqual(current, operation)) {
          throw new Error('proof operation changed before recovery decision')
        }
        const canonical = requireCustodyOperation(
          custody,
          custodyOperationId(this.authority.scope.scopeId, current),
        )
        assertRecoveryAuthority(canonical, current)
        return decideDurableCustodyRecovery(
          canonical,
          custody.getScopeState(),
          {
            ...owner,
            classification,
            exactRequestDisposition,
            scopeId: canonical.scope.scopeId,
            operationId: canonical.operation.operationId,
            requestFingerprint: canonical.operation.exactRequest.requestFingerprint,
            outputPlanFingerprint: canonical.operation.outputPlan.outputPlanFingerprint,
          },
        )
      },
    )
  }

  async abortRecovery(
    operation: ProofOperationRecord,
    evidence: DaemonProofOperationSafeAbortEvidence,
  ): Promise<ProofOperationRecord> {
    this.authority.assertActive()
    if (operation.durableTradeRecovery !== undefined) {
      throw new Error('trade proof operation abort requires its state machine')
    }
    const walletProofs = walletProofSelectorsForRecoveryAbort(operation)
    const context = await existingOperationContext(
      this.authority.scope.scopeId,
      operation.operationId,
      walletProofs,
    )
    const owner = this.authority.authorization()
    return this.unitOfWork.transact(
      {
        scope: this.authority.scope,
        owner,
        operationIds: [context.custodyOperationId],
        stateScope: context.stateScope,
      },
      ({ database, custody, state, now }) => abortRecoveryInTransaction({
        database,
        custody,
        state,
        now,
        owner,
        evidence,
        operation,
        custodyOperationId: context.custodyOperationId,
      }),
    )
  }

  private async completeOperation(input: {
    operationId: string
    resultProofs: Record<string, CashuProofRecord[]>
    walletProofs?: CompleteProofOperationWithWalletUpdateInput['walletProofs']
    walletDelta?: CompleteProofOperationWithWalletUpdateInput['walletDelta']
  }): Promise<ProofOperationRecord> {
    this.authority.assertActive()
    const resultProofs = normalizeProofRecordGroups(input.resultProofs)
    const context = await existingOperationContext(
      this.authority.scope.scopeId,
      input.operationId,
      input.walletProofs,
    )
    return this.unitOfWork.transact(
      this.transactionInput(context.stateScope, context.custodyOperationId),
      ({ custody, state, now }) => completeInTransaction({
        custody,
        state,
        now,
        input,
        resultProofs,
        scopeId: this.authority.scope.scopeId,
      }),
    )
  }

  private transactionInput(
    stateScope: DaemonStateRowScope,
    custodyOperationId: string,
  ) {
    return {
      scope: this.authority.scope,
      owner: this.authority.authorization(),
      operationIds: [custodyOperationId],
      stateScope,
    }
  }
}

function prepareInTransaction(input: {
  transaction: DaemonCustodyUnitOfWorkTransaction
  input: PrepareProofOperationInput
  custodyRecord: DurableCustodyRecord
}): ProofOperationRecord {
  const { database, custody, state, now } = input.transaction
  const parentPinId = input.input.walletProofReservation
    ?.parentOrderCollateralPinId
  const parentProofIds = input.custodyRecord.operation.reservation.inputs.map(
    ({ proofId }) => proofId,
  )
  const existing = state.getProofOperation(input.input.operationId)
  if (existing !== null) {
    assertStatePrepareMatches(existing, input.input)
    bindDurableCustodyProofOperation(custody, input.custodyRecord)
    if (existing.state === 'completed' || existing.state === 'Failed') {
      return existing
    }
    assertParentOrderCollateral(
      database,
      input.custodyRecord.scope.scopeId,
      parentPinId,
      parentProofIds,
    )
    state.reserveWalletProofs(input.input, now)
    bindParentOrderCollateral(database, input.custodyRecord)
    return existing
  }
  assertParentOrderCollateral(
    database,
    input.custodyRecord.scope.scopeId,
    parentPinId,
    parentProofIds,
  )
  state.reserveWalletProofs(input.input, now)
  bindDurableCustodyProofOperation(custody, input.custodyRecord)
  bindParentOrderCollateral(database, input.custodyRecord)
  const prepared = createPreparedStateRecord(input.input, Date.parse(now))
  state.putProofOperation(prepared)
  prepareTradeSession(state, prepared)
  return prepared
}

function abortRecoveryInTransaction(input: {
  database: DaemonCustodyUnitOfWorkTransaction['database']
  custody: CustodyTransaction
  state: DaemonCustodyStateEffects
  now: string
  owner: DurableCustodyOwnerAuthorization
  evidence: DaemonProofOperationSafeAbortEvidence
  operation: ProofOperationRecord
  custodyOperationId: string
}): ProofOperationRecord {
  const current = requireStateOperation(
    input.state,
    input.operation.operationId,
  )
  assertStatePrepareMatches(current, input.operation)
  const canonical = requireCustodyOperation(
    input.custody,
    input.custodyOperationId,
  )
  if (current.state === 'Failed') {
    assertRecoveryAuthority(canonical, current, 'aborted')
    return current
  }
  if (current.state !== 'prepared') {
    throw new Error('custody recovery abort requires a prepared operation')
  }
  assertRecoveryAuthority(canonical, current)
  const evidence = requireSafeAbortEvidence(input, canonical)
  const parentReservationId = releaseParentOrderCollateralAllocation(
    input.database,
    canonical,
  )
  transitionCustodyToAborted(input, evidence, parentReservationId, current)
  return persistAbortedState(input.state, current, input.now)
}

function requireSafeAbortEvidence(
  input: Pick<
    Parameters<typeof abortRecoveryInTransaction>[0],
    'custody' | 'owner' | 'evidence'
  >,
  canonical: DurableCustodyRecord,
): {
  classification: 'all-inputs-unspent'
  exactRequestDisposition: 'deterministically-rejected'
} {
  const decision = decideDurableCustodyRecovery(
    canonical,
    input.custody.getScopeState(),
    {
      ...input.owner,
      ...input.evidence,
      scopeId: canonical.scope.scopeId,
      operationId: canonical.operation.operationId,
      requestFingerprint: canonical.operation.exactRequest.requestFingerprint,
      outputPlanFingerprint: canonical.operation.outputPlan.outputPlanFingerprint,
    },
  )
  if (decision.kind !== 'abort-no-transport'
    || input.evidence.classification !== 'all-inputs-unspent'
    || input.evidence.exactRequestDisposition !== 'deterministically-rejected') {
    throw new Error('custody recovery abort evidence is insufficient')
  }
  return {
    classification: input.evidence.classification,
    exactRequestDisposition: input.evidence.exactRequestDisposition,
  }
}

function releaseParentOrderCollateralAllocation(
  database: DaemonCustodyUnitOfWorkTransaction['database'],
  canonical: DurableCustodyRecord,
): string | null {
  const parentReservationId = canonical.operation.reservation.parentReservationId
  if (parentReservationId !== null) {
    releaseOrderCollateralOperationAllocationInDatabase(database, {
      scopeId: canonical.scope.scopeId,
      pinId: parentReservationId,
      operationId: canonical.operation.operationId,
      proofIds: canonical.operation.reservation.inputs.map(({ proofId }) => proofId),
    })
  }
  return parentReservationId
}

function transitionCustodyToAborted(
  input: Pick<
    Parameters<typeof abortRecoveryInTransaction>[0],
    'custody' | 'now'
  > & { custodyOperationId: string; state: DaemonCustodyStateEffects },
  evidence: ReturnType<typeof requireSafeAbortEvidence>,
  parentReservationId: string | null,
  current: ProofOperationRecord,
): void {
  input.custody.transitionOperation({
    operationId: input.custodyOperationId,
    transition: {
      kind: 'abort-no-transport',
      classification: evidence.classification,
      exactRequestDisposition: evidence.exactRequestDisposition,
    },
  })
  input.custody.rebuildActiveWorkIndex()
  input.state.releaseWalletProofsForRecoveryAbort(
    current,
    input.now,
    parentReservationId,
  )
}

function persistAbortedState(
  state: DaemonCustodyStateEffects,
  current: ProofOperationRecord,
  now: string,
): ProofOperationRecord {
  const aborted = {
    ...current,
    state: 'Failed' as const,
    lastError: 'custody operation safely aborted before transport',
    updatedAt: Date.parse(now),
  }
  state.putProofOperation(aborted)
  return aborted
}

function bindParentOrderCollateral(
  database: DaemonCustodyUnitOfWorkTransaction['database'],
  record: DurableCustodyRecord,
): void {
  const pinId = record.operation.reservation.parentReservationId
  if (pinId === null) return
  bindOrderCollateralOperationInDatabase(database, {
    scopeId: record.scope.scopeId,
    pinId,
    operationId: record.operation.operationId,
    proofIds: record.operation.reservation.inputs.map(({ proofId }) => proofId),
  })
}

function assertParentOrderCollateral(
  database: DaemonCustodyUnitOfWorkTransaction['database'],
  scopeId: string,
  pinId: string | undefined,
  proofIds: readonly string[],
): void {
  if (pinId === undefined) return
  assertOrderCollateralPinOwnsProofs(database, scopeId, pinId, proofIds)
}

function createPreparedStateRecord(
  input: PrepareProofOperationInput,
  now: number,
): ProofOperationRecord {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid commit time')
  return {
    operationId: input.operationId,
    durableTradeRecovery: structuredClone(input.durableTradeRecovery),
    kind: input.kind,
    state: 'prepared',
    mintUrl: input.mintUrl,
    inputs: input.inputs.map(normalizeCashuProofRecord),
    outputs: structuredClone(input.outputs),
    metadata: structuredClone(input.metadata ?? {}),
    resultProofs: undefined,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

function assertStatePrepareMatches(
  existing: ProofOperationRecord,
  input: PrepareProofOperationInput,
): void {
  assertCompatibleProofOperation(existing, input)
  const expected = createPreparedStateRecord(input, existing.createdAt)
  const exact = (record: ProofOperationRecord) => ({
    operationId: record.operationId,
    durableTradeRecovery: operationLinkIdentity(record.durableTradeRecovery),
    kind: record.kind,
    mintUrl: record.mintUrl,
    inputs: record.inputs,
    outputs: record.outputs,
    metadata: record.metadata,
  })
  if (!isDeepStrictEqual(exact(existing), exact(expected))) {
    throw new Error('existing proof operation has foreign exact artifacts')
  }
}

function operationLinkIdentity(link?: DurableTradeProofOperationLink) {
  if (link === undefined) return undefined
  const { state: _, ...identity } = link
  return identity
}

function prepareTradeSession(
  state: DaemonCustodyStateEffects,
  operation: ProofOperationRecord,
): void {
  const link = operation.durableTradeRecovery
  if (link === undefined) return
  const session = state.getTradeSession(link.tradeId)
  if (session === null) throw new Error('proof operation has no durable trade session')
  const bindingError = validateDaemonDurableOperationBinding({
    session,
    record: operation,
    operation: link,
    allowUnlinkedSessionOperation: true,
  })
  if (bindingError !== null || link.state !== 'prepared') {
    throw new Error(`proof operation has an invalid trade binding: ${bindingError ?? 'state'}`)
  }
  const withExpected = addExpectedOperation(session, link, operation.operationId)
  state.putTradeSession(reduceDurableTradeSession(withExpected, {
    kind: 'proof-operation-prepared',
    operation: link,
  }))
}

function addExpectedOperation(
  session: DurableTradeSession,
  link: DurableTradeProofOperationLink,
  operationKey: string,
): DurableTradeSession {
  const expected = session.expectedProofOperations ?? []
  if (expected.some((item) => item.operationId === link.operationId)) return session
  return {
    ...session,
    expectedProofOperations: [...expected, {
      operationId: link.operationId,
      operationKey: link.operationKey ?? operationKey,
      stage: link.stage,
      ...(link.kind === undefined ? {} : { kind: link.kind }),
    }],
  }
}

function submittedStateRecord(
  state: DaemonCustodyStateEffects,
  existing: ProofOperationRecord,
  now: string,
  redeemBinding?: CtfRedeemMintSubmissionBinding,
): ProofOperationRecord {
  const durableTradeRecovery = advanceTradeSession(
    state,
    existing.durableTradeRecovery,
    'mint-submitted',
  )
  return {
    ...existing,
    state: 'mint-submitted',
    durableTradeRecovery,
    metadata: redeemBinding === undefined ? existing.metadata : {
      ...existing.metadata,
      redeemMintSubmissionVersion: redeemBinding.schemaVersion,
      redeemMintSubmissionRequestDigest: redeemBinding.requestDigest,
    },
    lastError: null,
    updatedAt: Date.parse(now),
  }
}

function completeInTransaction(input: {
  custody: CustodyTransaction
  state: DaemonCustodyStateEffects
  now: string
  input: {
    operationId: string
    walletDelta?: CompleteProofOperationWithWalletUpdateInput['walletDelta']
  }
  resultProofs: Record<string, CashuProofRecord[]>
  scopeId: string
}): ProofOperationRecord {
  const existing = requireStateOperation(input.state, input.input.operationId)
  const custodyId = custodyOperationId(input.scopeId, existing)
  const canonical = requireCustodyOperation(input.custody, custodyId)
  if (existing.state === 'completed') {
    if (!isDeepStrictEqual(existing.resultProofs, input.resultProofs)) {
      throw new Error('completed proof operation has a different result')
    }
    assertCustodyState(canonical, 'reconciled')
    return existing
  }
  assertValidCompletedProofOperationResult(existing, input.resultProofs)
  commitCustodyResult(input.custody, canonical, input.resultProofs)
  const durableTradeRecovery = advanceTradeSession(
    input.state,
    existing.durableTradeRecovery,
    'reconciled',
  )
  if (input.input.walletDelta !== undefined) {
    input.state.applyWalletProofDelta(input.input.walletDelta(input.now))
  }
  const completed = {
    ...existing,
    state: 'completed' as const,
    durableTradeRecovery,
    resultProofs: input.resultProofs,
    lastError: null,
    updatedAt: Date.parse(input.now),
  }
  input.state.putProofOperation(completed)
  return completed
}

function commitCustodyResult(
  custody: CustodyTransaction,
  record: DurableCustodyRecord,
  resultProofs: Record<string, CashuProofRecord[]>,
): void {
  const resultFingerprint = deriveDurableCustodyProofResultFingerprint(resultProofs)
  const resultHandle = `result:${resultFingerprint}`
  const input = {
    operationId: record.operation.operationId,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    resultHandle,
    resultFingerprint,
  }
  custody.stageVerifiedResult(input)
  custody.applyVerifiedResult(input)
  custody.rebuildActiveWorkIndex()
}

function advanceTradeSession(
  state: DaemonCustodyStateEffects,
  link: DurableTradeProofOperationLink | undefined,
  transition: 'mint-submitted' | 'reconciled',
): DurableTradeProofOperationLink | undefined {
  if (link === undefined) return undefined
  const session = state.getTradeSession(link.tradeId)
  if (session === null) throw new Error('durable proof operation has no session')
  validateSessionAndLink(session, link)
  const next = reduceDurableTradeSession(session, transition === 'mint-submitted'
    ? { kind: 'mint-submitted', operationId: link.operationId }
    : { kind: 'proof-operation-reconciled', operationId: link.operationId })
  const nextLink = next.proofOperations.find(
    (candidate) => candidate.operationId === link.operationId,
  )
  if (nextLink === undefined || nextLink.state !== transition) {
    throw new Error('durable proof operation did not advance with its session')
  }
  state.putTradeSession(next)
  return nextLink
}

function validateSessionAndLink(
  session: DurableTradeSession,
  link: DurableTradeProofOperationLink,
): void {
  const sessionError = validateDurableTradeSession(session)
  const linkError = validateDurableProofOperationLink(link)
  if (sessionError !== null || linkError !== null) {
    throw new Error(`invalid durable trade state: ${sessionError ?? linkError}`)
  }
  const stored = session.proofOperations.find(
    (candidate) => candidate.operationId === link.operationId,
  )
  if (stored === undefined || !isDeepStrictEqual(stored, link)) {
    throw new Error('durable proof operation is not bound to its session')
  }
}

function custodyOperationId(
  scopeId: string,
  operation: ProofOperationRecord,
): string {
  const semanticKind = daemonCustodySemanticKind(operation.kind)
  const stage = durableCustodySemanticPolicy(semanticKind).stage
  const binding = operation.durableTradeRecovery
    ? {
        kind: 'trade' as const,
        tradeId: operation.durableTradeRecovery.tradeId,
        role: operation.durableTradeRecovery.role,
        stage: stage as Extract<DurableCustodyBinding, { kind: 'trade' }>['stage'],
      }
    : {
        kind: 'wallet' as const,
        activityId: operation.operationId,
        stage: stage as Extract<DurableCustodyBinding, { kind: 'wallet' }>['stage'],
      }
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: operation.operationId,
    binding,
  })
}

function stateScopeFor(input: PrepareProofOperationInput): DaemonStateRowScope {
  const walletProofs = walletProofSelectorsForPrepare(input)
  return {
    proofOperationIds: [input.operationId],
    ...(input.durableTradeRecovery === undefined
      ? {}
      : { tradeIds: [input.durableTradeRecovery.tradeId] }),
    ...(walletProofs === undefined ? {} : { walletProofs }),
  }
}

async function existingOperationContext(
  custodyScopeId: string,
  operationId: string,
  walletProofs?: CompleteProofOperationWithWalletUpdateInput['walletProofs'],
): Promise<{
  custodyOperationId: string
  stateScope: DaemonStateRowScope
}> {
  const operation = await getProofOperation(operationId)
  if (operation === null) throw new Error('missing proof operation')
  const tradeId = operation.durableTradeRecovery?.tradeId
  return {
    custodyOperationId: custodyOperationId(custodyScopeId, operation),
    stateScope: {
      proofOperationIds: [operationId],
      ...(tradeId === undefined ? {} : { tradeIds: [tradeId] }),
      ...(walletProofs === undefined ? {} : { walletProofs }),
    },
  }
}

function requireStateOperation(
  state: DaemonCustodyStateEffects,
  operationId: string,
): ProofOperationRecord {
  const operation = state.getProofOperation(operationId)
  if (operation === null) throw new Error('missing proof operation')
  return operation
}

function requireCustodyOperation(
  custody: CustodyTransaction,
  operationId: string,
): DurableCustodyRecord {
  const operation = custody.getOperation(operationId)
  if (operation === null) throw new Error('missing canonical custody operation')
  return operation
}

function assertCustodyState(
  record: DurableCustodyRecord,
  expected: DurableCustodyRecord['operation']['state'],
): void {
  if (record.operation.state !== expected) {
    throw new Error('canonical custody and daemon operation state diverged')
  }
}

function assertRecoveryAuthority(
  canonical: DurableCustodyRecord,
  operation: ProofOperationRecord,
  failedCanonicalState?: Extract<
    DurableCustodyRecord['operation']['state'],
    'aborted'
  >,
): void {
  const unit = operation.metadata.unit
  if (typeof unit !== 'string' || unit.length === 0) {
    throw new Error('proof operation recovery unit is invalid')
  }
  const { requestFingerprint, outputPlanFingerprint } =
    deriveDurableCustodyProofOperationFingerprints(operation)
  const proofIds = operation.inputs.map((proof) => {
    if (!proof.id) throw new Error('proof operation input keyset is missing')
    return deriveDurableCustodyProofId({
      normalizedMint: operation.mintUrl,
      unit,
      keysetId: proof.id,
      secret: proof.secret,
    })
  })
  const expected = {
    retainedOperationKey: operation.operationId,
    semanticKind: daemonCustodySemanticKind(operation.kind),
    state: operation.state === 'Failed'
      ? requireFailedCanonicalState(failedCanonicalState)
      : custodyStateFor(operation.state),
    normalizedMint: operation.mintUrl,
    unit,
    requestFingerprint,
    outputPlanFingerprint,
    proofIds,
    resultFingerprint: operation.state === 'completed'
      ? deriveDurableCustodyProofResultFingerprint(
        requireCompletedResultProofs(operation),
      )
      : null,
  }
  const actual = {
    retainedOperationKey: canonical.operation.retainedOperationKey,
    semanticKind: canonical.operation.semanticKind,
    state: canonical.operation.state,
    normalizedMint: canonical.operation.custodyContext.normalizedMint,
    unit: canonical.operation.custodyContext.unit,
    requestFingerprint: canonical.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: canonical.operation.outputPlan.outputPlanFingerprint,
    proofIds: canonical.operation.exactRequest.inputProofIds,
    resultFingerprint: canonical.operation.result.resultFingerprint,
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('proof operation is foreign to canonical custody authority')
  }
}

function requireFailedCanonicalState(
  state: 'aborted' | undefined,
): 'aborted' {
  if (state !== 'aborted') {
    throw new Error('failed proof operation canonical state is ambiguous')
  }
  return state
}

function requireCompletedResultProofs(
  operation: ProofOperationRecord,
): Record<string, CashuProofRecord[]> {
  if (operation.state !== 'completed' || operation.resultProofs === undefined) {
    throw new Error('completed proof operation result is missing')
  }
  return operation.resultProofs
}

function custodyStateFor(
  state: ProofOperationRecord['state'],
): DurableCustodyRecord['operation']['state'] {
  switch (state) {
    case 'prepared':
      return 'dispatch-intent'
    case 'mint-submitted':
      return 'transport-attempted'
    case 'completed':
      return 'reconciled'
    case 'Failed':
      throw new Error('failed proof operation has no canonical recovery state')
  }
}
