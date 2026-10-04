import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import type {
  MeltPreview,
  MeltQuoteResponse,
  OutputDataLike,
  Proof,
  SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import {
  applyDurableCustodyTransaction,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  type DurableCustodyMintKeysetAuthority,
  type DurableCustodyMintOperationAuthority,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import { deserializeDurableCustodyProofArtifact } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import {
  decodeDurableWalletOperation,
  hydrateDurableWalletProof,
  requireDurableWalletOperationFromCustody,
  serializeDurableWalletProof,
  toDurableCustodyProofOperationInput,
  type DurableWalletMeltOperation,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import {
  runDurableWalletMeltOperation,
  type DurableWalletMeltExecutionResult,
} from '@bitcaster-market/client-sdk/durableWalletMelt'
import {
  computeInputFeeSubunitsForProofs,
  amountToNumber,
} from '@bitcaster-market/client-sdk/proofSelection'
import {
  createCustodyProofSqliteRowFromMaterial,
  decodeCustodyProofSqliteRow,
} from './custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import {
  admitExactAvailableWalletProofsFromDatabase,
  assertExactWalletMeltReservedProofProjectionFromDatabase,
  deleteExactReservedWalletProofsFromDatabase,
  releaseExactReservedWalletProofsFromDatabase,
  reserveExactAvailableWalletProofsFromDatabase,
} from './state.ts'

const MELT_APPROVAL_KIND = 'native-wallet-melt-approval-v2'

interface NativeMeltApproval {
  readonly schemaVersion: 2
  readonly kind: typeof MELT_APPROVAL_KIND
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly method: 'bolt11'
  readonly quote: string
  readonly invoice: string
  readonly expiryUnixSeconds: number
  readonly quoteAmountMsat: number
  readonly feeReserveMsat: number
  readonly quotedSelectedInputFeeMsat: number
  readonly selectedInputFeeMsat: number
  readonly totalWalletDebitMsat: number
  readonly approvedMaxDebitMsat: number
}

export interface NativeWalletMeltApprovalContext {
  readonly invoice: string
  readonly expiryUnixSeconds: number
  readonly amountMsat: number
  readonly feeReserveMsat: number
  readonly quotedSelectedInputFeeMsat: number
}

export interface NativeWalletMeltStatusProjection {
  readonly operationId: string
  readonly walletId: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly method: 'bolt11'
  readonly quoteId: string
  readonly invoice: string
  readonly expiryUnixSeconds: number
  readonly amountMsat: number
  readonly feeReserveMsat: number
  readonly quotedSelectedInputFeeMsat: number
  readonly selectedInputFeeMsat: number
  readonly totalWalletDebitMsat: number
  readonly approvedMaxDebitMsat: number
  readonly operationState: string
  readonly resultState: string
}

export interface NativeWalletMeltWallet {
  checkMeltQuote(method: string, quote: string): Promise<MeltQuoteResponse>
  completeMelt(preview: MeltPreview<Pick<MeltQuoteResponse, 'quote'>>): Promise<{
    readonly quote: { readonly quote: string; readonly state: string }
    readonly change?: readonly Proof[]
  }>
  createMeltChangeProofs(
    outputData: OutputDataLike[],
    changeSigs: SerializedBlindedSignature[],
  ): readonly Proof[]
  getKeyset(keysetId?: string): {
    readonly id: string
    readonly unit?: string
    readonly keys: Readonly<Record<string, string>> | Readonly<Record<number, string>>
    readonly fee?: number
    readonly expiry?: number
    readonly conditional?: unknown
    verify?(): boolean
  }
}

export interface NativeWalletMeltResult extends DurableWalletMeltExecutionResult {
  readonly operationId: string
}

/** Fenced SQLite coordinator for one exact native Lightning melt. */
export class NativeWalletMeltCoordinator {
  readonly #storage
  readonly #getFence: () => CustodyScopeFence
  readonly #now: () => number

  constructor(directory: string, getFence: () => CustodyScopeFence, now: () => number = Date.now) {
    this.#storage = createDaemonStateSqliteSession(directory)
    this.#getFence = getFence
    this.#now = now
  }

  /** Bind the exact prepared SDK operation and its approved debit before reserving inputs. */
  async prepare(input: {
    readonly operation: DurableWalletMeltOperation
    readonly wallet: NativeWalletMeltWallet
    readonly approvalContext: NativeWalletMeltApprovalContext
    readonly approvedMaxDebitMsat: number
  }): Promise<{ readonly operationId: string; readonly totalWalletDebitMsat: number }> {
    const operation = requireNativeMelt(input.operation)
    requireApprovalContext(input.approvalContext)
    requireApprovedMaximum(input.approvedMaxDebitMsat)
    const existing = await this.#loadByKey(operation.operationId)
    if (existing !== null) {
      const savedOperation = operationFromRecord(existing.record, existing.exactAuthority)
      const approval = requireMeltApproval(existing.authority, savedOperation)
      if (
        !isDeepStrictEqual(operation, savedOperation) ||
        !approvalMatchesContext(approval, input.approvalContext) ||
        approval.approvedMaxDebitMsat !== input.approvedMaxDebitMsat
      ) {
        throw new Error('native wallet melt retry conflicts with saved quote or approval')
      }
      return {
        operationId: operation.operationId,
        totalWalletDebitMsat: approval.totalWalletDebitMsat,
      }
    }

    const quote = await input.wallet.checkMeltQuote(
      operation.preview.method,
      operation.preview.quote.quote,
    )
    assertExactUnpaidQuote(operation, quote, input.approvalContext)
    const custody = toDurableCustodyProofOperationInput(operation)
    const keysets = meltKeysets(custody, input.wallet)
    const approval = createMeltApproval(
      operation,
      quote,
      keysets,
      input.approvalContext,
      input.approvedMaxDebitMsat,
    )
    const authority = prepareDurableCustodyMintOperationAuthority({
      operation: custody,
      keysets,
      applicationAuthority: approval,
    })
    const scope = walletScope(this.#getFence())
    const record = createDurableCustodyProofOperation({
      scope,
      operation: custody,
      facts: authority.facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: 'POST',
        path: `/v1/melt/${operation.preview.method}`,
        idempotencyKey: operation.operationId,
        requestBody: authority.exactRequest,
        output: authority.exactOutput,
        privateMaterial: authority.exactAuthority,
      },
    })
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const current = store.getOperation(record.operation.operationId)
      if (current !== null) {
        assertDurableCustodyMintOperationAuthority(
          current,
          requiredAuthorityArtifact(current, store),
        )
        throw new Error('native wallet melt operation already exists')
      }
      assertInputDebitCoverage(operation, approval.totalWalletDebitMsat)
      const reservationId = requiredText(record.operation.reservation.reservationId)
      reserveExactAvailableWalletProofsFromDatabase(database, {
        operationId: operation.operationId,
        reservationId,
        mintUrl: operation.mintUrl,
        proofs: operation.preview.inputs.map(hydrateDurableWalletProof),
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
        nowMs: observedAtMs,
      })
      assertCanonicalSelectableInputs(database, scope, operation, reservationId)
      applyDurableCustodyTransaction(
        new DurableCustodyTransactionSqlite(database, fence.scopeId, observedAtMs),
        selection(record, owner(fence, observedAtMs), null),
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, record, {
            requestBody: authority.exactRequest,
            output: authority.exactOutput,
            privateMaterial: authority.exactAuthority,
          }),
      )
    })
    return {
      operationId: operation.operationId,
      totalWalletDebitMsat: approval.totalWalletDebitMsat,
    }
  }

  /** Execute a new operation, or recover it if a prior call reached transport. */
  async execute(input: {
    readonly operationId: string
    readonly wallet: NativeWalletMeltWallet
  }): Promise<NativeWalletMeltResult> {
    const loaded = await this.#requireOperation(input.operationId)
    if (loaded.record.operation.state === 'aborted') {
      return { operationId: input.operationId, state: 'unpaid', proofs: [] }
    }
    const mode = loaded.record.operation.state === 'dispatch-intent' ? 'execute' : 'recover'
    const result = await this.#run(mode, loaded, input.wallet)
    return { ...result, operationId: input.operationId }
  }

  /** Recover one saved operation without selecting proofs or preparing new outputs. */
  async recover(input: {
    readonly operationId: string
    readonly wallet: NativeWalletMeltWallet
  }): Promise<NativeWalletMeltResult> {
    const loaded = await this.#requireOperation(input.operationId)
    if (loaded.record.operation.state === 'aborted') {
      return { operationId: input.operationId, state: 'unpaid', proofs: [] }
    }
    const result = await this.#run('recover', loaded, input.wallet)
    return { ...result, operationId: input.operationId }
  }

  /** Read the exact saved quote and approval without exposing proof or output material. */
  async readStatus(operationId: string): Promise<NativeWalletMeltStatusProjection | null> {
    const loaded = await this.#loadByKey(operationId)
    return loaded === null ? null : statusProjection(loaded)
  }

  /** Read one generic active-work row, returning null for a valid non-melt operation. */
  async readActiveMeltStatus(
    custodyOperationId: string,
  ): Promise<NativeWalletMeltStatusProjection | null> {
    const fence = this.#getFence()
    const active = await withDurableCustodyFencedRead(
      this.#storage,
      fence,
      this.#now(),
      (database) => new DurableCustodySqliteStore(database).getOperation(custodyOperationId),
    )
    if (active === null || !active.operation.retainedOperationKey.startsWith('wallet-melt:')) {
      return null
    }
    const loaded = await this.#loadByKey(active.operation.retainedOperationKey)
    if (loaded === null) throw new Error('native wallet melt active operation is missing')
    return statusProjection(loaded)
  }

  async #run(
    mode: 'execute' | 'recover',
    loaded: LoadedMelt,
    wallet: NativeWalletMeltWallet,
  ): Promise<DurableWalletMeltExecutionResult> {
    const { operation, record, exactAuthority, exactResult } = loaded
    return runDurableWalletMeltOperation({
      mode,
      operation,
      resultState: record.operation.result.state,
      transport: {
        completeMelt: async (preview) => {
          await this.#markTransportAttempted(record.operation.operationId)
          return wallet.completeMelt(preview)
        },
        checkMeltQuote: (method, quote) => wallet.checkMeltQuote(method, quote),
        createMeltChangeProofs: (outputs, signatures) =>
          wallet.createMeltChangeProofs(outputs, signatures),
      },
      store: {
        readAppliedResult: async () => readVerifiedResult(record, exactAuthority, exactResult),
        applyStagedResult: async () => this.#applyStaged(operation.operationId),
        stageAndApplyPaidChange: async (change) => {
          const prepared = prepareDurableCustodyVerifiedMintResult({
            record,
            exactAuthority,
            result: { change },
          })
          await this.#stageResult(record, prepared)
          return this.#applyStaged(operation.operationId)
        },
        releaseUnpaidReservation: async () => this.#releaseUnpaid(record, operation),
      },
    })
  }

  async #markTransportAttempted(operationId: string): Promise<void> {
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const current = requiredRecord(store, operationId)
      if (current.operation.state === 'transport-attempted') return
      if (current.operation.state !== 'dispatch-intent') {
        throw new Error('native wallet melt is not dispatchable')
      }
      const authorization = owner(fence, observedAtMs)
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        fence.scopeId,
        observedAtMs,
        [current],
      )
      applyDurableCustodyTransaction(
        transaction,
        selection(current, authorization, current.revision),
        (selected) =>
          selected.transitionOperation({
            operationId,
            expectedRevision: current.revision,
            transition: {
              kind: 'mark-transport-attempted',
              authorization,
              expectedRevision: current.revision,
            },
          }),
      )
      transaction.rebuildActiveWorkIndex({
        scopeId: fence.scopeId,
        operationRows: [{ operationId, expectedRevision: current.revision + 1 }],
      })
    })
  }

  async #stageResult(
    record: DurableCustodyRecord,
    prepared: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>,
  ): Promise<void> {
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const current = requiredRecord(
        new DurableCustodySqliteStore(database),
        record.operation.operationId,
      )
      if (current.operation.result.state !== 'none') return
      const authorization = owner(fence, observedAtMs)
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        fence.scopeId,
        observedAtMs,
        [current],
      )
      applyDurableCustodyTransaction(
        transaction,
        selection(current, authorization, current.revision),
        (selected) =>
          stageDurableCustodyPreparedMintResult({
            transaction: selected,
            record: current,
            prepared,
            authorization,
          }),
      )
    })
  }

  async #applyStaged(operationId: string): Promise<readonly Proof[]> {
    const loaded = await this.#requireOperation(operationId)
    if (loaded.record.operation.result.state === 'applied') {
      return readVerifiedResult(loaded.record, loaded.exactAuthority, loaded.exactResult)
    }
    if (loaded.record.operation.result.state !== 'verified-staged' || loaded.exactResult === null) {
      throw new Error('native wallet melt result is not staged')
    }
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    const custodyOperationId = loaded.record.operation.operationId
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const current = requiredRecord(store, custodyOperationId)
      if (current.operation.result.state === 'applied') return
      if (current.operation.result.state !== 'verified-staged') {
        throw new Error('native wallet melt result staging changed')
      }
      const result = exactResultArtifact(current, store)
      const currentVerified = readDurableCustodyVerifiedMintResult({
        record: current,
        exactAuthority: loaded.exactAuthority,
        exactResult: result,
      })
      const successors = currentVerified.proofs.map(({ material, dleqState }) => ({
        proof: createCustodyProofSqliteRowFromMaterial({
          scopeId: current.scope.scopeId,
          normalizedMint: current.operation.custodyContext.normalizedMint,
          unit: 'msat',
          material,
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState,
          nut07State: 'UNSPENT' as const,
          selectability: 'selectable' as const,
          storageClass: current.operation.proofStorage.storageClass,
          reservationOperationId: null,
          revision: 0,
          nowMs: observedAtMs,
        }),
        expectedRevision: null,
      }))
      const authorization = owner(fence, observedAtMs)
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        fence.scopeId,
        observedAtMs,
        [current],
      )
      transaction.stageSuccessorProofCas(custodyOperationId, successors)
      applyDurableCustodyTransaction(
        transaction,
        selection(current, authorization, current.revision),
        (selected) =>
          selected.applyVerifiedResult({
            operationId: custodyOperationId,
            expectedRevision: current.revision,
            authorization,
            outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
            resultHandle: requiredText(current.operation.result.resultHandle),
            resultFingerprint: requiredText(current.operation.result.resultFingerprint),
            successorAdmission: {
              scopeId: current.scope.scopeId,
              operationId: custodyOperationId,
              admissionId: `wallet-melt:${requiredText(current.operation.result.resultFingerprint)}`,
              proofRows: successors.map(({ proof, expectedRevision }) => ({
                proofId: proof.proofId,
                expectedRevision,
                admittedRevision: proof.revision,
              })),
            },
          }),
      )
      deleteExactReservedWalletProofsFromDatabase(database, {
        reservationId: requiredText(current.operation.reservation.reservationId),
        mintUrl: current.operation.custodyContext.normalizedMint,
        proofs: loaded.operation.preview.inputs.map(hydrateDurableWalletProof),
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      })
      transaction.rebuildActiveWorkIndex({
        scopeId: current.scope.scopeId,
        operationRows: [
          { operationId: custodyOperationId, expectedRevision: current.revision + 1 },
        ],
      })
      for (const { proof } of currentVerified.proofs) {
        admitExactAvailableWalletProofsFromDatabase(database, {
          mintUrl: current.operation.custodyContext.normalizedMint,
          proofs: [proof],
          asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
          nowMs: observedAtMs,
        })
      }
    })
    const applied = await this.#requireOperation(operationId)
    return readVerifiedResult(applied.record, applied.exactAuthority, applied.exactResult)
  }

  async #releaseUnpaid(
    record: DurableCustodyRecord,
    operation: DurableWalletMeltOperation,
  ): Promise<void> {
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const current = requiredRecord(
        new DurableCustodySqliteStore(database),
        record.operation.operationId,
      )
      if (current.operation.state === 'aborted') return
      if (current.operation.state !== 'transport-attempted') {
        throw new Error('native wallet melt unpaid release lacks a payment response')
      }
      releaseExactReservedWalletProofsFromDatabase(database, {
        reservationId: requiredText(current.operation.reservation.reservationId),
        mintUrl: current.operation.custodyContext.normalizedMint,
        proofs: operation.preview.inputs.map(hydrateDurableWalletProof),
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
        nowMs: observedAtMs,
      })
      const authorization = owner(fence, observedAtMs)
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        fence.scopeId,
        observedAtMs,
        [current],
      )
      applyDurableCustodyTransaction(
        transaction,
        selection(current, authorization, current.revision),
        (selected) =>
          selected.transitionOperation({
            operationId: current.operation.operationId,
            expectedRevision: current.revision,
            transition: {
              kind: 'release-unspent-reservation',
              authorization,
              expectedRevision: current.revision,
            },
          }),
      )
      transaction.rebuildActiveWorkIndex({
        scopeId: current.scope.scopeId,
        operationRows: [
          { operationId: current.operation.operationId, expectedRevision: current.revision + 1 },
        ],
      })
    })
  }

  async #loadByKey(operationId: string): Promise<LoadedMelt | null> {
    const fence = this.#getFence()
    const custodyOperationId = custodyId(fence.scopeId, operationId)
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(custodyOperationId)
      if (record === null) return null
      const exactAuthority = requiredAuthorityArtifact(record, store)
      const authority = assertDurableCustodyMintOperationAuthority(record, exactAuthority)
      const operation = operationFromRecord(record, exactAuthority)
      requireMeltApproval(authority, operation)
      const exactResult =
        record.operation.result.exactResult === null ? null : exactResultArtifact(record, store)
      return { record, exactAuthority, exactResult, authority, operation }
    })
  }

  async #requireOperation(operationId: string): Promise<LoadedMelt> {
    const loaded = await this.#loadByKey(operationId)
    if (loaded === null) throw new Error('native wallet melt operation is missing')
    return loaded
  }
}

interface LoadedMelt {
  readonly record: DurableCustodyRecord
  readonly exactAuthority: DurableCustodyExactArtifact
  readonly exactResult: DurableCustodyExactArtifact | null
  readonly authority: DurableCustodyMintOperationAuthority
  readonly operation: DurableWalletMeltOperation
}

function statusProjection(loaded: LoadedMelt): NativeWalletMeltStatusProjection {
  if (loaded.record.scope.scopeKind !== 'wallet') {
    throw new Error('native wallet melt status scope is foreign')
  }
  const approval = requireMeltApproval(loaded.authority, loaded.operation)
  return {
    operationId: loaded.operation.operationId,
    walletId: loaded.record.scope.walletId,
    mintUrl: loaded.operation.mintUrl,
    unit: 'msat',
    method: 'bolt11',
    quoteId: approval.quote,
    invoice: approval.invoice,
    expiryUnixSeconds: approval.expiryUnixSeconds,
    amountMsat: approval.quoteAmountMsat,
    feeReserveMsat: approval.feeReserveMsat,
    quotedSelectedInputFeeMsat: approval.quotedSelectedInputFeeMsat,
    selectedInputFeeMsat: approval.selectedInputFeeMsat,
    totalWalletDebitMsat: approval.totalWalletDebitMsat,
    approvedMaxDebitMsat: approval.approvedMaxDebitMsat,
    operationState: loaded.record.operation.state,
    resultState: loaded.record.operation.result.state,
  }
}

function requireNativeMelt(value: DurableWalletMeltOperation): DurableWalletMeltOperation {
  const operation = decodeDurableWalletOperation(value)
  if (
    operation.kind !== 'wallet-melt' ||
    operation.unit !== 'msat' ||
    operation.preview.method !== 'bolt11' ||
    operation.preview.requestOptions.preferAsync ||
    Object.keys(operation.preview.requestOptions.extraPayload).length !== 0
  ) {
    throw new Error('native wallet melt operation is outside the supported contract')
  }
  return operation
}

function assertExactUnpaidQuote(
  operation: DurableWalletMeltOperation,
  quote: MeltQuoteResponse,
  approvalContext: NativeWalletMeltApprovalContext,
): void {
  if (
    quote.quote !== operation.preview.quote.quote ||
    quote.unit !== 'msat' ||
    amountToNumber(quote.amount) !== amountToNumber(operation.preview.quote.amount) ||
    amountToNumber(quote.amount) <= 0 ||
    quote.state !== 'UNPAID' ||
    quote.request !== approvalContext.invoice ||
    quote.expiry !== approvalContext.expiryUnixSeconds ||
    amountToNumber(quote.amount) !== approvalContext.amountMsat ||
    amountToNumber(quote.fee_reserve) !== approvalContext.feeReserveMsat
  ) {
    throw new Error('native wallet melt quote authority is foreign or not unpaid')
  }
  requireMsatAmount(quote.fee_reserve, 'melt fee reserve')
}

function createMeltApproval(
  operation: DurableWalletMeltOperation,
  quote: MeltQuoteResponse,
  keysets: readonly DurableCustodyMintKeysetAuthority[],
  approvalContext: NativeWalletMeltApprovalContext,
  approvedMaxDebitMsat: number,
): NativeMeltApproval {
  const fees = Object.fromEntries(keysets.map(({ id, inputFeePpk }) => [id, inputFeePpk]))
  const selectedInputFeeMsat = computeInputFeeSubunitsForProofs(operation.preview.inputs, fees)
  const quoteAmountMsat = amountToNumber(quote.amount)
  const feeReserveMsat = amountToNumber(quote.fee_reserve)
  const totalWalletDebitMsat = checkedAdd(
    checkedAdd(quoteAmountMsat, feeReserveMsat),
    selectedInputFeeMsat,
  )
  if (totalWalletDebitMsat > approvedMaxDebitMsat) {
    throw new Error('native wallet melt exceeds the approved maximum debit')
  }
  assertInputDebitCoverage(operation, totalWalletDebitMsat)
  return {
    schemaVersion: 2,
    kind: MELT_APPROVAL_KIND,
    mintUrl: operation.mintUrl,
    unit: 'msat',
    method: 'bolt11',
    quote: quote.quote,
    invoice: approvalContext.invoice,
    expiryUnixSeconds: approvalContext.expiryUnixSeconds,
    quoteAmountMsat,
    feeReserveMsat,
    quotedSelectedInputFeeMsat: approvalContext.quotedSelectedInputFeeMsat,
    selectedInputFeeMsat,
    totalWalletDebitMsat,
    approvedMaxDebitMsat,
  }
}

function requireMeltApproval(
  authority: DurableCustodyMintOperationAuthority,
  operation: DurableWalletMeltOperation,
): NativeMeltApproval {
  const value = authority.applicationAuthority
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('native wallet melt approval authority is missing')
  }
  const approval = value as Partial<NativeMeltApproval>
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'mintUrl',
    'unit',
    'method',
    'quote',
    'invoice',
    'expiryUnixSeconds',
    'quoteAmountMsat',
    'feeReserveMsat',
    'quotedSelectedInputFeeMsat',
    'selectedInputFeeMsat',
    'totalWalletDebitMsat',
    'approvedMaxDebitMsat',
  ]
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error('native wallet melt approval authority has unexpected fields')
  }
  const keys = authority.keysets
  const fees = Object.fromEntries(keys.map(({ id, inputFeePpk }) => [id, inputFeePpk]))
  const selectedInputFeeMsat = computeInputFeeSubunitsForProofs(operation.preview.inputs, fees)
  const quoteAmountMsat = amountToNumber(operation.preview.quote.amount)
  if (
    approval.schemaVersion !== 2 ||
    approval.kind !== MELT_APPROVAL_KIND ||
    approval.mintUrl !== operation.mintUrl ||
    approval.unit !== 'msat' ||
    approval.method !== operation.preview.method ||
    approval.quote !== operation.preview.quote.quote ||
    typeof approval.invoice !== 'string' ||
    approval.invoice.length === 0 ||
    !Number.isSafeInteger(approval.expiryUnixSeconds) ||
    (approval.expiryUnixSeconds as number) <= 0 ||
    approval.quoteAmountMsat !== quoteAmountMsat ||
    !Number.isSafeInteger(approval.quoteAmountMsat) ||
    (approval.quoteAmountMsat as number) <= 0 ||
    !Number.isSafeInteger(approval.feeReserveMsat) ||
    (approval.feeReserveMsat as number) < 0 ||
    !Number.isSafeInteger(approval.quotedSelectedInputFeeMsat) ||
    (approval.quotedSelectedInputFeeMsat as number) < 0 ||
    approval.selectedInputFeeMsat !== selectedInputFeeMsat ||
    approval.totalWalletDebitMsat !==
      checkedAdd(
        checkedAdd(quoteAmountMsat, approval.feeReserveMsat as number),
        selectedInputFeeMsat,
      )
  ) {
    throw new Error('native wallet melt approval authority is malformed or foreign')
  }
  requireApprovedMaximum(approval.approvedMaxDebitMsat)
  if ((approval.totalWalletDebitMsat as number) > (approval.approvedMaxDebitMsat as number)) {
    throw new Error('native wallet melt approval authority exceeds its maximum')
  }
  assertInputDebitCoverage(operation, approval.totalWalletDebitMsat as number)
  return approval as NativeMeltApproval
}

function requireApprovalContext(value: NativeWalletMeltApprovalContext): void {
  if (
    typeof value.invoice !== 'string' ||
    value.invoice.length === 0 ||
    value.invoice.length > 10_000 ||
    !Number.isSafeInteger(value.expiryUnixSeconds) ||
    value.expiryUnixSeconds <= 0 ||
    !Number.isSafeInteger(value.amountMsat) ||
    value.amountMsat <= 0 ||
    !Number.isSafeInteger(value.feeReserveMsat) ||
    value.feeReserveMsat < 0 ||
    !Number.isSafeInteger(value.quotedSelectedInputFeeMsat) ||
    value.quotedSelectedInputFeeMsat < 0
  ) {
    throw new Error('native wallet melt approval quote context is invalid')
  }
}

function approvalMatchesContext(
  approval: NativeMeltApproval,
  context: NativeWalletMeltApprovalContext,
): boolean {
  return (
    approval.invoice === context.invoice &&
    approval.expiryUnixSeconds === context.expiryUnixSeconds &&
    approval.quoteAmountMsat === context.amountMsat &&
    approval.feeReserveMsat === context.feeReserveMsat &&
    approval.quotedSelectedInputFeeMsat === context.quotedSelectedInputFeeMsat
  )
}

function assertInputDebitCoverage(operation: DurableWalletMeltOperation, debit: number): void {
  const inputTotal = operation.preview.inputs.reduce(
    (sum, proof) => checkedAdd(sum, amountToNumber(proof.amount)),
    0,
  )
  if (inputTotal < debit) throw new Error('native wallet melt inputs do not cover approved debit')
}

function requireApprovedMaximum(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('native wallet melt requires a positive approved maximum debit')
  }
}

function requireMsatAmount(value: unknown, label: string): number {
  const amount = amountToNumber(value as Parameters<typeof amountToNumber>[0])
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new Error(`native wallet ${label} is invalid`)
  return amount
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || left < 0 || right < 0) {
    throw new Error('native wallet melt debit exceeds the safe integer range')
  }
  return sum
}

function meltKeysets(
  operation: ReturnType<typeof toDurableCustodyProofOperationInput>,
  wallet: NativeWalletMeltWallet,
): DurableCustodyMintKeysetAuthority[] {
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ])
  return [...ids].map((id) => {
    const keyset = wallet.getKeyset(id)
    if (
      !keyset ||
      keyset.id !== id ||
      keyset.unit !== 'msat' ||
      keyset.conditional !== undefined ||
      keyset.verify?.() !== true ||
      !Number.isSafeInteger(keyset.fee) ||
      keyset.fee! < 0
    ) {
      throw new Error('native wallet melt keyset authority is invalid')
    }
    return {
      canonicalMintUrl: operation.mintUrl,
      id,
      unit: 'msat',
      keys: Object.fromEntries(Object.entries(keyset.keys)),
      inputFeePpk: keyset.fee!,
      finalExpiry: keyset.expiry ?? null,
      identity: { kind: 'regular' as const },
    }
  })
}

function assertCanonicalSelectableInputs(
  database: DatabaseSync,
  scope: DurableCustodyScope,
  operation: DurableWalletMeltOperation,
  reservationId: string,
): void {
  assertExactWalletMeltReservedProofProjectionFromDatabase(database, {
    reservationId,
    mintUrl: operation.mintUrl,
    proofs: operation.preview.inputs.map(hydrateDurableWalletProof),
    asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
  })
  const store = new DurableCustodySqliteStore(database)
  const seen = new Set<string>()
  for (const candidate of operation.preview.inputs) {
    const proofId = deriveDurableCustodyProofId({
      scopeId: scope.scopeId,
      normalizedMint: operation.mintUrl,
      unit: 'msat',
      keysetId: candidate.id,
      secret: candidate.secret,
    })
    if (seen.has(proofId)) throw new Error('native wallet melt input proof is duplicated')
    seen.add(proofId)
    const row = store.getProof(scope.scopeId, proofId)
    if (
      row === null ||
      row.normalizedMint !== operation.mintUrl ||
      row.unit !== 'msat' ||
      row.baseAsset !== 'sat' ||
      row.conditionId !== null ||
      row.outcomeSetId !== null ||
      row.productBinding !== null ||
      row.signatureVerified !== true ||
      row.dleqState !== 'verified' ||
      row.nut07State !== 'UNSPENT' ||
      !['selectable', 'retained'].includes(row.selectability) ||
      row.reservationOperationId !== null
    ) {
      throw new Error('native wallet melt input is not canonical and selectable')
    }
    const canonical = deserializeDurableCustodyProofArtifact({
      schemaVersion: 1,
      ...decodeCustodyProofSqliteRow(row).proof,
    })
    if (!isDeepStrictEqual(candidate, serializeDurableWalletProof(canonical))) {
      throw new Error('native wallet melt input differs from canonical custody proof')
    }
  }
}

function operationFromRecord(
  record: DurableCustodyRecord,
  exactAuthority: DurableCustodyExactArtifact,
): DurableWalletMeltOperation {
  const authority = assertDurableCustodyMintOperationAuthority(record, exactAuthority)
  const input = requireDurableWalletOperationFromCustody(authority.operation)
  if (
    input.kind !== 'wallet-melt' ||
    input.operationId !== record.operation.retainedOperationKey ||
    input.mintUrl !== record.operation.custodyContext.normalizedMint ||
    input.unit !== 'msat' ||
    record.operation.semanticKind !== 'generic-send' ||
    record.operation.binding.stage !== 'send'
  ) {
    throw new Error('native wallet melt custody authority is foreign')
  }
  requireNativeMelt(input)
  return input
}

function readVerifiedResult(
  record: DurableCustodyRecord,
  exactAuthority: DurableCustodyExactArtifact,
  exactResult: DurableCustodyExactArtifact | null,
): readonly Proof[] {
  if (exactResult === null) throw new Error('native wallet melt result artifact is missing')
  return readDurableCustodyVerifiedMintResult({ record, exactAuthority, exactResult }).proofs.map(
    ({ proof }) => proof,
  )
}

function requiredAuthorityArtifact(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (row === null) throw new Error('native wallet melt authority artifact is missing')
  return row.artifact
}

function exactResultArtifact(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const reference = record.operation.result.exactResult
  if (reference === null) throw new Error('native wallet melt result authority is missing')
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (row === null) throw new Error('native wallet melt result artifact is missing')
  return row.artifact
}

function requiredRecord(
  store: DurableCustodySqliteStore,
  operationId: string,
): DurableCustodyRecord {
  const record = store.getOperation(operationId)
  if (record === null) throw new Error('native wallet melt operation is missing')
  return record
}

function custodyId(scopeId: string, operationId: string): string {
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: operationId,
    binding: { kind: 'wallet', activityId: operationId, stage: 'send' },
  })
}

function walletScope(fence: CustodyScopeFence): DurableCustodyScope {
  if (!fence.scopeId.startsWith('custody:wallet:'))
    throw new Error('native wallet melt scope is foreign')
  return {
    scopeKind: 'wallet',
    scopeId: fence.scopeId,
    walletId: fence.scopeId.slice('custody:wallet:'.length),
  }
}

function owner(fence: CustodyScopeFence, observedAtMs: number): DurableCustodyOwnerAuthorization {
  return { incarnationId: fence.incarnationId, fencingEpoch: fence.fencingEpoch, observedAtMs }
}

function selection(
  record: DurableCustodyRecord,
  authorization: DurableCustodyOwnerAuthorization,
  expectedRevision: number | null,
) {
  return {
    scope: record.scope,
    owner: authorization,
    operationRows: [{ operationId: record.operation.operationId, expectedRevision }],
  }
}

function requiredText(value: string | null): string {
  if (value === null || value.length === 0)
    throw new Error('native wallet melt result authority is incomplete')
  return value
}
