import type { MintPreview, MintQuoteBolt11Response, Proof } from '@cashu/cashu-ts'
import {
  applyDurableCustodyTransaction,
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
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  bindDurableBolt11MintQuoteOperation,
  createDurableBolt11MintQuote,
  decodeDurableBolt11MintQuote,
  hideDurableBolt11MintQuote,
  observeDurableBolt11MintQuoteState,
  verifyDurableBolt11MintQuoteRetry,
  type DurableBolt11MintQuote,
} from '@bitcaster-market/client-sdk/durableBolt11MintQuote'
import {
  requireDurableWalletMintJournal,
  runDurableWalletMintOperation,
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
  type DurableWalletMintOperation,
  type DurableWalletOutputData,
  type DurableWalletMintOperationSnapshot,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { decodeCanonicalMintOrigin } from '@bitcaster-market/client-sdk/durableCustody'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { createCustodyProofSqliteRowFromMaterial } from './custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createDaemonStateSqliteSession, type StateSqliteFaultPhase } from './stateSqlite.ts'
import { admitExactAvailableWalletProofsFromDatabase, readExactBoundCounter } from './state.ts'
import { NativeBolt11MintQuoteSqliteStore } from './nativeBolt11MintQuoteSqlite.ts'

const QUOTE_RECOVERY_ERROR = 'native BOLT11 mint quote recovery failed'

type NativeBolt11MintQuoteCreateStage =
  | 'validate-input'
  | 'load-wallet'
  | 'create-quote'
  | 'validate-quote'
  | 'bind-quote'
  | 'prepare-output'
  | 'validate-output'
  | 'serialize-operation'
  | 'prepare-authority'
  | 'create-custody-record'
  | 'persist-quote'

export function formatNativeBolt11MintQuoteCreateDiagnostic(
  stage: NativeBolt11MintQuoteCreateStage,
  error: unknown,
): string {
  const errorClass =
    error instanceof TypeError
      ? 'TypeError'
      : error instanceof RangeError
        ? 'RangeError'
        : error instanceof Error
          ? 'Error'
          : 'NonError'
  return `native-bolt11-invoice-create-failed stage=${stage} error=${errorClass}\n`
}

function writeNativeBolt11MintQuoteCreateDiagnostic(
  stage: NativeBolt11MintQuoteCreateStage,
  error: unknown,
): void {
  try {
    process.stderr.write(formatNativeBolt11MintQuoteCreateDiagnostic(stage, error))
  } catch {
    // Diagnostics must not replace the original operation error.
  }
}

export interface NativeBolt11MintQuoteWallet {
  readonly mint: { readonly mintUrl: string }
  loadMint(): Promise<unknown>
  createMintQuoteBolt11(amountMsat: number): Promise<MintQuoteBolt11Response>
  prepareMint(
    method: 'bolt11',
    amountMsat: number,
    quote: MintQuoteBolt11Response,
    config: {
      readonly onCountersReserved: (range: NativeBolt11MintCounterRange) => void
    },
  ): Promise<MintPreview<{ quote: string; expiry?: number | null }>>
  checkMintQuote(quoteId: string): Promise<Pick<MintQuoteBolt11Response, 'quote' | 'state'>>
  completeMint(preview: MintPreview<{ quote: string; expiry?: number | null }>): Promise<Proof[]>
  getKeyset(keysetId?: string): NativeBolt11MintKeyset | undefined
}

export interface NativeBolt11MintKeyset {
  readonly id: string
  readonly unit?: string
  readonly keys: Readonly<Record<string, string>> | Readonly<Record<number, string>>
  readonly fee?: number
  readonly expiry?: number
  readonly conditional?: unknown
  verify?(): boolean
}

export interface NativeBolt11MintCounterRange {
  readonly keysetId: string
  readonly start: number
  readonly count: number
  readonly next: number
}

export interface NativeBolt11MintQuoteView {
  readonly quoteRecordId: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly paymentMethod: 'bolt11'
  readonly requestedAmount: string
  readonly quoteId: string
  readonly invoiceRequest: string
  readonly expiryUnixSeconds: number | null
  readonly presentationState: 'visible' | 'hidden'
  readonly observedState: 'UNPAID' | 'PAID' | 'ISSUED'
  readonly revision: number
}

export type NativeBolt11MintQuoteRecoveryItem =
  | {
      readonly quoteRecordId: string
      readonly outcome: 'recovered'
      readonly blocking: false
    }
  | {
      readonly quoteRecordId: string
      readonly outcome: 'unpaid'
      readonly retryPending: true
      readonly blocking: false
    }
  | {
      readonly quoteRecordId: string
      readonly outcome: 'pending'
      readonly retryPending: true
      readonly blocking: false
    }
  | {
      readonly quoteRecordId: string
      readonly outcome: 'error'
      readonly blocking: true
      readonly error: string
    }

export interface NativeBolt11MintQuoteCoordinatorOptions {
  readonly directory: string
  readonly getFence: () => CustodyScopeFence
  readonly walletFor: (mintUrl: string, unit: 'msat') => Promise<NativeBolt11MintQuoteWallet>
  readonly restoreExactOutputs: (input: {
    readonly mintUrl: string
    readonly unit: string
    readonly outputs: readonly DurableWalletOutputData[]
  }) => Promise<readonly Proof[]>
  readonly now?: () => number
  /** Transaction fault seam for deterministic interrupted-commit tests. */
  readonly injectFault?: (phase: StateSqliteFaultPhase) => void
}

interface LoadedQuote {
  readonly record: DurableCustodyRecord
  readonly quote: DurableBolt11MintQuote
  readonly operation: DurableWalletMintOperation
  readonly exactAuthority: ReturnType<typeof requiredAuthorityArtifact>
  readonly exactResult: ReturnType<typeof requiredResultArtifact> | null
}

/** Fenced adapter from durable BOLT11 quotes to existing custody and SDK mint owners. */
export class NativeBolt11MintQuoteCoordinator {
  readonly #storage
  readonly #getFence: () => CustodyScopeFence
  readonly #walletFor: NativeBolt11MintQuoteCoordinatorOptions['walletFor']
  readonly #restoreExactOutputs: NativeBolt11MintQuoteCoordinatorOptions['restoreExactOutputs']
  readonly #now: () => number
  readonly #injectFault: NativeBolt11MintQuoteCoordinatorOptions['injectFault']

  constructor(options: NativeBolt11MintQuoteCoordinatorOptions) {
    this.#storage = createDaemonStateSqliteSession(options.directory)
    this.#getFence = options.getFence
    this.#walletFor = options.walletFor
    this.#restoreExactOutputs = options.restoreExactOutputs
    this.#now = options.now ?? Date.now
    this.#injectFault = options.injectFault
  }

  /** Create and bind exact outputs before returning the invoice request. */
  async create(input: {
    readonly mintUrl: string
    readonly amountMsat: number
  }): Promise<NativeBolt11MintQuoteView> {
    let stage: NativeBolt11MintQuoteCreateStage = 'validate-input'
    try {
      requirePositiveAmount(input.amountMsat)
      const mintUrl = canonicalMintUrl(input.mintUrl)
      stage = 'load-wallet'
      const wallet = await this.#loadedWallet(mintUrl)
      stage = 'create-quote'
      const response = await wallet.createMintQuoteBolt11(input.amountMsat)
      stage = 'validate-quote'
      assertNewQuoteResponse(response, input.amountMsat)
      stage = 'bind-quote'
      const quote = createDurableBolt11MintQuote({
        mintUrl,
        unit: 'msat',
        requestedAmount: String(input.amountMsat),
        quoteId: response.quote,
        invoiceRequest: response.request,
        expiryUnixSeconds: response.expiry,
        observedState: response.state,
      })

      let reservedRange: NativeBolt11MintCounterRange | null = null
      stage = 'prepare-output'
      const preview = await wallet.prepareMint('bolt11', input.amountMsat, response, {
        onCountersReserved: (range) => {
          if (reservedRange !== null) {
            throw new Error('native BOLT11 mint counter range was reserved more than once')
          }
          reservedRange = decodeCounterRange(range)
        },
      })
      stage = 'validate-output'
      assertPreparedMintPlan(preview, quote, reservedRange)
      stage = 'serialize-operation'
      const operation = serializeDurableWalletMintOperation({
        operationId: quote.walletMintOperationId,
        mintUrl,
        unit: 'msat',
        preview,
      })
      const boundQuote = bindDurableBolt11MintQuoteOperation(quote, operation)
      const custodyOperation = toDurableCustodyProofOperationInput(operation)
      stage = 'prepare-authority'
      const authority = prepareDurableCustodyMintOperationAuthority({
        operation: custodyOperation,
        keysets: mintKeysets(custodyOperation, wallet),
      })
      const fence = this.#getFence()
      const scope = walletScope(fence)
      stage = 'create-custody-record'
      const record = createDurableCustodyProofOperation({
        scope,
        operation: custodyOperation,
        facts: authority.facts,
        inventoryAccountId: null,
        exactBoundary: {
          method: 'POST',
          path: '/v1/mint/bolt11',
          idempotencyKey: operation.operationId,
          requestBody: authority.exactRequest,
          output: authority.exactOutput,
          privateMaterial: authority.exactAuthority,
        },
      })
      const observedAtMs = this.#now()
      stage = 'persist-quote'
      await withDurableCustodyUnitOfWork(
        this.#storage,
        fence,
        observedAtMs,
        (database) => {
          assertPersistedCounterRange(database, scope.scopeId, operation, reservedRange!)
          const transaction = new DurableCustodyTransactionSqlite(
            database,
            scope.scopeId,
            observedAtMs,
          )
          applyDurableCustodyTransaction(
            transaction,
            selection(record, owner(fence, observedAtMs), null),
            (selected) =>
              bindDurableCustodyProofOperation(selected, record, {
                requestBody: authority.exactRequest,
                output: authority.exactOutput,
                privateMaterial: authority.exactAuthority,
              }),
          )
          new NativeBolt11MintQuoteSqliteStore(database).insert({
            scopeId: scope.scopeId,
            custodyOperationId: record.operation.operationId,
            quote: boundQuote,
          })
        },
        this.#transactionOptions(),
      )
      return toView(boundQuote)
    } catch (error) {
      writeNativeBolt11MintQuoteCreateDiagnostic(stage, error)
      throw error
    }
  }

  /** Read redacted quote metadata. Proofs and output authority are never returned. */
  async get(quoteRecordId: string): Promise<NativeBolt11MintQuoteView | null> {
    const loaded = await this.#loadQuote(quoteRecordId)
    return loaded === null ? null : toView(loaded.quote)
  }

  /** Hide an invoice without deleting or disabling its recovery state. */
  async hide(quoteRecordId: string): Promise<NativeBolt11MintQuoteView> {
    const loaded = await this.#loadQuote(quoteRecordId)
    if (loaded === null) throw new Error('native BOLT11 mint quote was not found')
    if (loaded.quote.presentationState === 'hidden') return toView(loaded.quote)
    const hidden = hideDurableBolt11MintQuote(loaded.quote)
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      fence,
      observedAtMs,
      (database) =>
        new NativeBolt11MintQuoteSqliteStore(database).update({
          scopeId: fence.scopeId,
          custodyOperationId: loaded.record.operation.operationId,
          expectedRevision: loaded.quote.revision,
          quote: hidden,
        }),
      this.#transactionOptions(),
    )
    return toView(hidden)
  }

  /** Process one page from the generic custody active-work index. */
  async recoverActivePage(input: { readonly cursor: string | null }): Promise<{
    readonly outcomes: readonly NativeBolt11MintQuoteRecoveryItem[]
    readonly nextCursor: string | null
    readonly hasMore: boolean
  }> {
    const fence = this.#getFence()
    const page = await withDurableCustodyFencedRead(
      this.#storage,
      fence,
      this.#now(),
      (database) => {
        const custody = new DurableCustodySqliteStore(database)
        const active = custody.listActiveWorkPage(fence.scopeId, input.cursor)
        const quotes = new NativeBolt11MintQuoteSqliteStore(
          database,
        ).getActiveByCustodyOperationIds(
          fence.scopeId,
          active.rows.map(({ operationId }) => operationId),
        )
        return { active, quotes }
      },
    )
    const outcomes: NativeBolt11MintQuoteRecoveryItem[] = []
    for (const record of page.quotes) {
      outcomes.push(await this.#recoverQuote(record.quote.quoteRecordId))
    }
    return {
      outcomes,
      nextCursor: page.active.nextCursor,
      hasMore: page.active.nextCursor !== null,
    }
  }

  async #recoverQuote(quoteRecordId: string): Promise<NativeBolt11MintQuoteRecoveryItem> {
    try {
      const loaded = await this.#loadQuote(quoteRecordId)
      if (loaded === null) throw new Error('quote missing')
      if (loaded.record.operation.result.state !== 'none') {
        const result = await this.#runMint(loaded, null)
        return result.state === 'nonterminal'
          ? pendingOutcome(quoteRecordId)
          : recoveredOutcome(quoteRecordId)
      }

      // Verify the saved SDK operation before loading mint metadata or making a mint request.
      const wallet = await this.#loadedWallet(loaded.quote.mintUrl)
      const quoteStatus = await wallet.checkMintQuote(loaded.quote.quoteId)
      assertQuoteStatus(loaded.quote, quoteStatus)
      const updated = observeDurableBolt11MintQuoteState(loaded.quote, quoteStatus.state)
      if (updated.revision !== loaded.quote.revision) {
        await this.#updateQuote(loaded, updated)
      }
      if (quoteStatus.state === 'UNPAID') return unpaidOutcome(quoteRecordId)

      const current =
        updated.revision === loaded.quote.revision ? loaded : await this.#loadQuote(quoteRecordId)
      if (current === null) throw new Error('quote missing after state update')
      const result = await this.#runMint(current, wallet)
      return result.state === 'nonterminal'
        ? pendingOutcome(quoteRecordId)
        : recoveredOutcome(quoteRecordId)
    } catch {
      return {
        quoteRecordId,
        outcome: 'error',
        blocking: true,
        error: QUOTE_RECOVERY_ERROR,
      }
    }
  }

  async #runMint(
    loaded: LoadedQuote,
    wallet: NativeBolt11MintQuoteWallet | null,
  ): Promise<{ readonly state: 'completed' | 'external-applied' | 'nonterminal' }> {
    const custodyOperationId = loaded.record.operation.operationId
    const sdkWallet = wallet ?? terminalOnlyWallet(loaded.operation.mintUrl)
    return runDurableWalletMintOperation({
      mode: 'recover',
      operationId: loaded.operation.operationId,
      wallet: sdkWallet,
      store: {
        loadOperation: () => this.#loadMintSnapshot(custodyOperationId),
        persistCompletedResult: ({ operation, result }) =>
          this.#persistCompletedResult(custodyOperationId, operation, result),
      },
      restoreExactOutputs: this.#restoreExactOutputs,
    })
  }

  async #loadMintSnapshot(
    custodyOperationId: string,
  ): Promise<DurableWalletMintOperationSnapshot | null> {
    const loaded = await this.#loadQuoteByCustodyOperationId(custodyOperationId)
    if (loaded === null) return null
    switch (loaded.record.operation.result.state) {
      case 'none':
        return { operation: loaded.operation, state: 'prepared', result: null }
      case 'verified-staged':
        await this.#applyStaged(custodyOperationId)
        return this.#loadMintSnapshot(custodyOperationId)
      case 'applied':
        return {
          operation: loaded.operation,
          state: 'completed',
          result: {
            receive: readVerifiedProofs(loaded),
          },
        }
      default:
        throw new Error('native BOLT11 mint result state is invalid')
    }
  }

  async #persistCompletedResult(
    custodyOperationId: string,
    _operation: DurableWalletMintOperation,
    result: { readonly receive: readonly Proof[] },
  ): Promise<'completed'> {
    const loaded = await this.#loadQuoteByCustodyOperationId(custodyOperationId)
    if (loaded === null) throw new Error('native BOLT11 mint operation is missing')
    if (loaded.record.operation.result.state === 'applied') return 'completed'
    if (loaded.record.operation.result.state === 'none') {
      const prepared = prepareDurableCustodyVerifiedMintResult({
        record: loaded.record,
        exactAuthority: loaded.exactAuthority,
        result: { receive: result.receive },
      })
      const fence = this.#getFence()
      const observedAtMs = this.#now()
      await withDurableCustodyUnitOfWork(
        this.#storage,
        fence,
        observedAtMs,
        (database) => {
          const store = new DurableCustodySqliteStore(database)
          const current = requiredRecord(store, custodyOperationId)
          if (current.operation.result.state !== 'none') return
          const transaction = new DurableCustodyTransactionSqlite(
            database,
            fence.scopeId,
            observedAtMs,
            [current],
          )
          applyDurableCustodyTransaction(
            transaction,
            selection(current, owner(fence, observedAtMs), current.revision),
            (selected) =>
              stageDurableCustodyPreparedMintResult({
                transaction: selected,
                record: current,
                prepared,
                authorization: owner(fence, observedAtMs),
              }),
          )
        },
        this.#transactionOptions(),
      )
    }
    await this.#applyStaged(custodyOperationId)
    return 'completed'
  }

  async #applyStaged(custodyOperationId: string): Promise<void> {
    const loaded = await this.#loadQuoteByCustodyOperationId(custodyOperationId)
    if (loaded === null) throw new Error('native BOLT11 mint operation is missing')
    if (loaded.record.operation.result.state === 'applied') return
    if (loaded.record.operation.result.state !== 'verified-staged') {
      throw new Error('native BOLT11 mint result is not staged')
    }
    const exactResult = loaded.exactResult
    if (exactResult === null) throw new Error('native BOLT11 mint result artifact is missing')
    const verified = readDurableCustodyVerifiedMintResult({
      record: loaded.record,
      exactAuthority: loaded.exactAuthority,
      exactResult,
    })
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      fence,
      observedAtMs,
      (database) => {
        const current = requiredRecord(new DurableCustodySqliteStore(database), custodyOperationId)
        if (current.operation.result.state === 'applied') return
        if (current.operation.result.state !== 'verified-staged') {
          throw new Error('native BOLT11 mint result stage changed')
        }
        const successors = verified.proofs.map(({ material, dleqState }) => ({
          proof: createCustodyProofSqliteRowFromMaterial({
            scopeId: current.scope.scopeId,
            normalizedMint: current.operation.custodyContext.normalizedMint,
            unit: mintUnitFromRecord(current),
            material,
            baseAsset: 'sat',
            conditionId: null,
            outcomeSetId: null,
            productBinding: null,
            signatureVerified: true,
            dleqState,
            nut07State: 'UNSPENT',
            selectability: 'retained',
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
          (selected) => {
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
                admissionId: `wallet-mint:${requiredText(current.operation.result.resultFingerprint)}`,
                proofRows: successors.map(({ proof, expectedRevision }) => ({
                  proofId: proof.proofId,
                  expectedRevision,
                  admittedRevision: proof.revision,
                })),
              },
            })
          },
        )
        transaction.rebuildActiveWorkIndex({
          scopeId: current.scope.scopeId,
          operationRows: [
            { operationId: custodyOperationId, expectedRevision: current.revision + 1 },
          ],
        })
        for (const { proof } of verified.proofs) {
          admitExactAvailableWalletProofsFromDatabase(database, {
            mintUrl: current.operation.custodyContext.normalizedMint,
            proofs: [proof],
            asset: { kind: 'sats', baseAsset: 'sat', unit: mintUnitFromRecord(current) },
            nowMs: observedAtMs,
          })
        }
        const quoteStore = new NativeBolt11MintQuoteSqliteStore(database)
        const quote = quoteStore.getByCustodyOperationId(fence.scopeId, custodyOperationId)
        if (quote === null) throw new Error('native BOLT11 mint quote is missing')
        quoteStore.update({
          scopeId: fence.scopeId,
          custodyOperationId,
          expectedRevision: quote.quote.revision,
          quote: observeDurableBolt11MintQuoteState(quote.quote, 'ISSUED'),
        })
      },
      this.#transactionOptions(),
    )
  }

  async #loadQuote(quoteRecordId: string): Promise<LoadedQuote | null> {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const quoteRecord = new NativeBolt11MintQuoteSqliteStore(database).get(
        fence.scopeId,
        quoteRecordId,
      )
      if (quoteRecord === null) return null
      return loadQuoteWithCustody(database, fence.scopeId, quoteRecord)
    })
  }

  async #loadQuoteByCustodyOperationId(custodyOperationId: string): Promise<LoadedQuote | null> {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const quoteRecord = new NativeBolt11MintQuoteSqliteStore(database).getByCustodyOperationId(
        fence.scopeId,
        custodyOperationId,
      )
      if (quoteRecord === null) return null
      return loadQuoteWithCustody(database, fence.scopeId, quoteRecord)
    })
  }

  async #updateQuote(loaded: LoadedQuote, quote: DurableBolt11MintQuote): Promise<void> {
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      fence,
      observedAtMs,
      (database) =>
        new NativeBolt11MintQuoteSqliteStore(database).update({
          scopeId: fence.scopeId,
          custodyOperationId: loaded.record.operation.operationId,
          expectedRevision: loaded.quote.revision,
          quote,
        }),
      this.#transactionOptions(),
    )
  }

  async #loadedWallet(mintUrl: string): Promise<NativeBolt11MintQuoteWallet> {
    const wallet = await this.#walletFor(mintUrl, 'msat')
    if (canonicalMintUrl(wallet.mint.mintUrl) !== mintUrl) {
      throw new Error('native BOLT11 mint wallet URL conflicts')
    }
    await wallet.loadMint()
    return wallet
  }

  #transactionOptions() {
    return this.#injectFault === undefined ? {} : { injectFault: this.#injectFault }
  }
}

function loadQuoteWithCustody(
  database: Parameters<typeof readExactBoundCounter>[0],
  scopeId: string,
  quoteRecord: ReturnType<NativeBolt11MintQuoteSqliteStore['get']> & {},
): LoadedQuote {
  const custodyStore = new DurableCustodySqliteStore(database)
  const record = custodyStore.getOperation(quoteRecord.custodyOperationId)
  if (
    record === null ||
    record.scope.scopeId !== scopeId ||
    record.operation.operationId !== quoteRecord.custodyOperationId ||
    record.operation.retainedOperationKey !== quoteRecord.quote.walletMintOperationId
  ) {
    throw new Error('native BOLT11 mint custody operation binding conflicts')
  }
  const retained = custodyStore.getOperationByRetainedOperationKey(
    scopeId,
    quoteRecord.quote.walletMintOperationId,
  )
  if (retained?.operation.operationId !== record.operation.operationId) {
    throw new Error('native BOLT11 mint retained operation binding conflicts')
  }
  const exactAuthority = requiredAuthorityArtifact(record, custodyStore)
  const authority = assertDurableCustodyMintOperationAuthority(record, exactAuthority)
  const operation = requireDurableWalletMintJournal({
    operationId: record.operation.retainedOperationKey,
    kind: authority.operation.kind,
    mintUrl: record.operation.custodyContext.normalizedMint,
    unit: record.operation.custodyContext.unit,
    outputs: authority.operation.outputs,
    metadata: authority.operation.metadata ?? {},
  })
  const quote = verifyDurableBolt11MintQuoteRetry(quoteRecord.quote, operation)
  if (
    authority.operation.kind !== 'wallet-mint' ||
    authority.operation.inputs.length !== 0 ||
    operation.operationId !== quote.walletMintOperationId ||
    operation.mintUrl !== quote.mintUrl ||
    operation.unit !== quote.unit
  ) {
    throw new Error('native BOLT11 mint operation authority conflicts')
  }
  const exactResult =
    record.operation.result.exactResult === null
      ? null
      : requiredResultArtifact(record, custodyStore)
  return { record, quote, operation, exactAuthority, exactResult }
}

function mintKeysets(
  operation: ReturnType<typeof toDurableCustodyProofOperationInput>,
  wallet: NativeBolt11MintQuoteWallet,
) {
  const ids = new Set(
    Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  )
  if (ids.size !== 1) throw new Error('native BOLT11 mint output keyset is invalid')
  return [...ids].map((id) => {
    if (!isV2KeysetId(id)) throw new Error('native BOLT11 mint supports only V2 keysets')
    const keyset = wallet.getKeyset(id)
    if (
      !keyset ||
      keyset.id !== id ||
      keyset.unit !== 'msat' ||
      keyset.verify?.() !== true ||
      keyset.conditional !== undefined
    ) {
      throw new Error('native BOLT11 mint keyset is invalid')
    }
    return {
      canonicalMintUrl: operation.mintUrl,
      id,
      unit: 'msat',
      keys: Object.fromEntries(Object.entries(keyset.keys)),
      inputFeePpk: keyset.fee ?? 0,
      finalExpiry: keyset.expiry ?? null,
      identity: { kind: 'regular' as const },
    }
  })
}

function assertPersistedCounterRange(
  database: Parameters<typeof readExactBoundCounter>[0],
  scopeId: string,
  operation: DurableWalletMintOperation,
  range: NativeBolt11MintCounterRange | null,
): void {
  if (range === null) throw new Error('native BOLT11 mint counter range is missing')
  const next = readExactBoundCounter(database, scopeId, range.keysetId, {
    normalizedMint: operation.mintUrl,
    unit: 'msat',
  })
  if (next < range.next) throw new Error('native BOLT11 mint counter authority is incomplete')
}

function assertPreparedMintPlan(
  preview: MintPreview<{ quote: string; expiry?: number | null }>,
  quote: DurableBolt11MintQuote,
  range: NativeBolt11MintCounterRange | null,
): void {
  if (
    range === null ||
    range.count <= 0 ||
    range.keysetId !== preview.keysetId ||
    range.count !== preview.outputData.length ||
    preview.payload.quote !== quote.quoteId ||
    preview.payload.outputs.length !== preview.outputData.length ||
    preview.outputData.length === 0
  ) {
    throw new Error('native BOLT11 mint output plan is invalid')
  }
  for (const [index, output] of preview.outputData.entries()) {
    const blinded = preview.payload.outputs[index]
    if (
      output.blindedMessage.id !== range.keysetId ||
      blinded === undefined ||
      blinded.id !== output.blindedMessage.id ||
      amountToNumber(blinded.amount) !== amountToNumber(output.blindedMessage.amount) ||
      blinded.B_ !== output.blindedMessage.B_
    ) {
      throw new Error('native BOLT11 mint output plan conflicts with its counter range')
    }
  }
  if (range.next !== range.start + range.count) {
    throw new Error('native BOLT11 mint counter range is invalid')
  }
}

function assertNewQuoteResponse(response: MintQuoteBolt11Response, amountMsat: number): void {
  if (
    response.unit !== 'msat' ||
    response.state !== 'UNPAID' ||
    amountToNumber(response.amount) !== amountMsat ||
    typeof response.quote !== 'string' ||
    typeof response.request !== 'string'
  ) {
    throw new Error('native BOLT11 mint quote response is invalid')
  }
}

function assertQuoteStatus(
  quote: DurableBolt11MintQuote,
  response: Pick<MintQuoteBolt11Response, 'quote' | 'state'>,
): asserts response is Pick<MintQuoteBolt11Response, 'quote' | 'state'> & {
  state: DurableBolt11MintQuote['observedState']
} {
  if (
    response.quote !== quote.quoteId ||
    (response.state !== 'UNPAID' && response.state !== 'PAID' && response.state !== 'ISSUED')
  ) {
    throw new Error('native BOLT11 mint quote status is foreign')
  }
}

function readVerifiedProofs(loaded: LoadedQuote): Proof[] {
  if (loaded.exactResult === null) {
    throw new Error('native BOLT11 mint result artifact is missing')
  }
  return readDurableCustodyVerifiedMintResult({
    record: loaded.record,
    exactAuthority: loaded.exactAuthority,
    exactResult: loaded.exactResult,
  }).proofs.map(({ proof }) => proof)
}

function requiredAuthorityArtifact(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (row === null) throw new Error('native BOLT11 mint private authority is missing')
  return row.artifact
}

function requiredResultArtifact(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const reference = record.operation.result.exactResult
  if (reference === null) throw new Error('native BOLT11 mint result authority is missing')
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (row === null) throw new Error('native BOLT11 mint result artifact is missing')
  return row.artifact
}

function requiredRecord(
  store: DurableCustodySqliteStore,
  operationId: string,
): DurableCustodyRecord {
  const record = store.getOperation(operationId)
  if (record === null) throw new Error('native BOLT11 mint operation is missing')
  return record
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

function walletScope(fence: CustodyScopeFence): DurableCustodyScope {
  if (!fence.scopeId.startsWith('custody:wallet:')) {
    throw new Error('native BOLT11 mint custody scope is foreign')
  }
  return {
    scopeKind: 'wallet',
    scopeId: fence.scopeId,
    walletId: fence.scopeId.slice('custody:wallet:'.length),
  }
}

function owner(fence: CustodyScopeFence, observedAtMs: number): DurableCustodyOwnerAuthorization {
  return {
    incarnationId: fence.incarnationId,
    fencingEpoch: fence.fencingEpoch,
    observedAtMs,
  }
}

function mintUnitFromRecord(record: DurableCustodyRecord): 'msat' {
  if (record.operation.custodyContext.unit !== 'msat') {
    throw new Error('native BOLT11 mint custody unit is invalid')
  }
  return 'msat'
}

function decodeCounterRange(value: NativeBolt11MintCounterRange): NativeBolt11MintCounterRange {
  if (
    typeof value.keysetId !== 'string' ||
    !Number.isSafeInteger(value.start) ||
    value.start < 0 ||
    !Number.isSafeInteger(value.count) ||
    value.count <= 0 ||
    !Number.isSafeInteger(value.next) ||
    value.next !== value.start + value.count
  ) {
    throw new Error('native BOLT11 mint counter range is invalid')
  }
  return { ...value }
}

function terminalOnlyWallet(mintUrl: string): NativeBolt11MintQuoteWallet {
  const unexpected = async (): Promise<never> => {
    throw new Error('terminal mint operation attempted mint I/O')
  }
  return {
    mint: { mintUrl },
    loadMint: unexpected,
    createMintQuoteBolt11: unexpected,
    prepareMint: unexpected,
    checkMintQuote: unexpected,
    completeMint: unexpected,
    getKeyset: () => undefined,
  }
}

function toView(quote: DurableBolt11MintQuote): NativeBolt11MintQuoteView {
  const decoded = decodeDurableBolt11MintQuote(quote)
  return {
    quoteRecordId: decoded.quoteRecordId,
    mintUrl: decoded.mintUrl,
    unit: 'msat',
    paymentMethod: 'bolt11',
    requestedAmount: decoded.requestedAmount,
    quoteId: decoded.quoteId,
    invoiceRequest: decoded.invoiceRequest,
    expiryUnixSeconds: decoded.expiryUnixSeconds,
    presentationState: decoded.presentationState,
    observedState: decoded.observedState,
    revision: decoded.revision,
  }
}

function canonicalMintUrl(value: string): string {
  try {
    return decodeCanonicalMintOrigin(value)
  } catch {
    throw new Error('native BOLT11 mint URL is invalid')
  }
}

function requirePositiveAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('native BOLT11 mint amount must be a positive integer msat value')
  }
}

function isV2KeysetId(value: unknown): value is string {
  return typeof value === 'string' && /^01[0-9a-f]{64}$/.test(value)
}

function unpaidOutcome(quoteRecordId: string): NativeBolt11MintQuoteRecoveryItem {
  return { quoteRecordId, outcome: 'unpaid', retryPending: true, blocking: false }
}

function pendingOutcome(quoteRecordId: string): NativeBolt11MintQuoteRecoveryItem {
  return { quoteRecordId, outcome: 'pending', retryPending: true, blocking: false }
}

function recoveredOutcome(quoteRecordId: string): NativeBolt11MintQuoteRecoveryItem {
  return { quoteRecordId, outcome: 'recovered', blocking: false }
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('native BOLT11 mint result authority is invalid')
  }
  return value
}
