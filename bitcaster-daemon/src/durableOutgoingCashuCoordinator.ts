import { randomUUID } from 'node:crypto'
import { getEncodedTokenV4, type Proof } from '@cashu/cashu-ts'
import {
  applyDurableCustodyTransaction,
  deriveDurableCustodyArtifactFingerprint,
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
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  admitDurableOutgoingCashuToken,
  classifyDurableOutgoingBearerProofStates,
  completeDurableOutgoingCashuReclaim,
  createDurableOutgoingCashuTransfer,
  planDurableOutgoingCashuProofStateChunks,
  planDurableOutgoingCashuRecoveryPage,
  markDurableOutgoingCashuReclaimRecipientSpent,
  prepareDurableOutgoingCashuReclaim,
  runDurableOutgoingCashuTransfer,
  scheduleDurableOutgoingCashuRecoveryRetry,
  DURABLE_OUTGOING_CASHU_PROOF_STATE_CALL_LIMIT_MAX,
  DURABLE_OUTGOING_CASHU_PROOF_STATE_PROOFS_PER_CALL_MAX,
  DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX,
  type DurableOutgoingCashuCoordinatorInput,
  type DurableOutgoingCashuTransfer,
} from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import {
  requireDurableWalletOperationFromCustody,
  hydrateDurableWalletProof,
  runDurableWalletReceiveOperation,
  serializeDurableWalletProof,
  serializeDurableWalletReceiveOperation,
  serializeDurableWalletSendOperation,
  toDurableCustodyProofOperationInput,
  type DurableWalletProof,
  type DurableWalletReceiveOperation,
  type DurableWalletSendOperation,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { createCustodyProofSqliteRowFromMaterial } from './custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import { DurableOutgoingCashuSqliteStore } from './durableOutgoingCashuSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import {
  completeDurableOutgoingWalletSendFromDatabase,
  admitExactAvailableWalletProofsFromDatabase,
  prepareProofOperationWithExactReservation,
  readExactBoundCounter,
  readAvailableWalletProofsFenced,
  type StoredOutputData,
} from './state.ts'
import type { CashuWalletLike, WalletOpsDependencies } from './walletOps.ts'

const TOKEN_BYTES_LIMIT = 61_440
const TOKEN_PROOF_LIMIT = 512
const RECOVERY_TRANSFER_PAGE_LIMIT = 8

/** Fenced SQLite coordinator for an exact durable ordinary Cashu send. */
export class DaemonDurableOutgoingCashuCoordinator {
  readonly #storage
  readonly #getFence: () => CustodyScopeFence
  readonly #deps: WalletOpsDependencies
  readonly #now: () => number

  constructor(
    directory: string,
    getFence: () => CustodyScopeFence,
    deps: WalletOpsDependencies,
    now: () => number = Date.now,
  ) {
    this.#storage = createDaemonStateSqliteSession(directory)
    this.#getFence = getFence
    this.#deps = deps
    this.#now = now
  }

  async loadTransfer(transferId: string): Promise<DurableOutgoingCashuTransfer | null> {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(
      this.#storage,
      fence,
      this.#now(),
      (database) =>
        new DurableOutgoingCashuSqliteStore(database).get(fence.scopeId, transferId)?.transfer ??
        null,
    )
  }

  async execute(input: {
    readonly transferId: string
    readonly amountSats: number
    readonly mintUrl: string
    readonly wallet: CashuWalletLike
  }): Promise<DurableOutgoingCashuTransfer> {
    const prepared = await this.#prepare(input)
    return this.#run(prepared, input.wallet, 'execute')
  }

  async recover(input: {
    readonly transfer: DurableOutgoingCashuTransfer
    readonly amountSats: number
    readonly mintUrl: string
    readonly wallet: CashuWalletLike
  }): Promise<DurableOutgoingCashuTransfer> {
    if (
      input.transfer.mintUrl !== input.mintUrl ||
      input.transfer.unit !== 'sat' ||
      input.transfer.requestedAmount !== String(input.amountSats)
    ) {
      throw new Error('durable outgoing Cashu transfer conflicts with the caller request')
    }
    return this.#run(input.transfer, input.wallet, 'recover')
  }

  /**
   * Run one bounded recovery pass. It only retries persisted operations and
   * classifies persisted bearer proofs. It never creates a token or selects inputs.
   */
  async recoverDue(input: {
    readonly walletFor: (mintUrl: string, unit: 'sat' | 'msat') => Promise<CashuWalletLike>
  }): Promise<{
    readonly recovered: string[]
    readonly pending: Array<{ transferId: string; error: string }>
    readonly hasMore: boolean
    readonly hasPending: boolean
    readonly hasBlockingPending: boolean
  }> {
    const nowMs = this.#now()
    const fence = this.#getFence()
    const page = await withDurableCustodyFencedRead(this.#storage, fence, nowMs, (database) =>
      new DurableOutgoingCashuSqliteStore(database).listDue({
        scopeId: fence.scopeId,
        mintUrl: null,
        dueBeforeMs: nowMs,
        cursor: null,
        limit: RECOVERY_TRANSFER_PAGE_LIMIT,
        maximumBytes: DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX,
      }),
    )
    const groups = planDurableOutgoingCashuRecoveryPage({
      page,
      limit: RECOVERY_TRANSFER_PAGE_LIMIT,
      maximumBytes: DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX,
    })
    const wallets = new Map<string, Promise<CashuWalletLike>>()
    const walletFor = (mintUrl: string, unit: 'sat' | 'msat') => {
      const key = `${mintUrl}\u0000${unit}`
      let wallet = wallets.get(key)
      if (wallet === undefined) {
        wallet = input.walletFor(mintUrl, unit).then(async (created) => {
          await created.loadMint()
          return created
        })
        wallets.set(key, wallet)
      }
      return wallet
    }
    const recovered: string[] = []
    const pending: Array<{ transferId: string; error: string }> = []
    const bearer: DurableOutgoingCashuTransfer[] = []
    for (const transfers of groups.values()) {
      for (const transfer of transfers) {
        try {
          if (transfer.deliveryState === 'prepared') {
            const result = await this.recover({
              transfer,
              amountSats: Number(transfer.requestedAmount),
              mintUrl: transfer.mintUrl,
              wallet: await walletFor(transfer.mintUrl, receiveUnit(transfer.unit)),
            })
            if (result.deliveryState !== 'prepared') recovered.push(transfer.transferId)
            continue
          }
          if (
            transfer.deliveryState === 'delivery-pending' ||
            transfer.deliveryState === 'bearer-partial'
          ) {
            bearer.push(transfer)
            continue
          }
          if (transfer.deliveryState === 'reclaim-prepared') {
            const result = await this.#runReclaim(
              transfer,
              await walletFor(transfer.mintUrl, receiveUnit(transfer.unit)),
            )
            if (result.deliveryState === 'reclaimed' || result.deliveryState === 'bearer-spent') {
              recovered.push(transfer.transferId)
            } else {
              await this.#scheduleRetry(result, nowMs)
              pending.push({
                transferId: transfer.transferId,
                error: 'durable outgoing Cashu reclaim remains pending at the mint',
              })
            }
          }
        } catch (error) {
          await this.#scheduleRetry(transfer, nowMs)
          pending.push({ transferId: transfer.transferId, error: errorMessage(error) })
        }
      }
    }
    const states = new Map<string, Array<{ Y: string; state: 'UNSPENT' | 'PENDING' | 'SPENT' }>>()
    const failed = new Set<string>()
    const chunks = planDurableOutgoingCashuProofStateChunks({
      transfers: bearer,
      maximumCalls: DURABLE_OUTGOING_CASHU_PROOF_STATE_CALL_LIMIT_MAX,
      maximumProofsPerCall: DURABLE_OUTGOING_CASHU_PROOF_STATE_PROOFS_PER_CALL_MAX,
    })
    for (const chunk of chunks) {
      try {
        const wallet = await walletFor(chunk.mintUrl, 'sat')
        if (!wallet.checkProofsStates)
          throw new Error('cashu wallet does not support proof-state recovery')
        const response = await wallet.checkProofsStates(
          chunk.proofs.map(({ id, secret }) => ({ id, secret })),
        )
        if (response.length !== chunk.proofs.length) {
          throw new Error('mint proof-state recovery response length is invalid')
        }
        let responseOffset = 0
        for (const association of chunk.proofAssociations) {
          const current = states.get(association.transferId) ?? []
          current.splice(
            association.proofOffset,
            association.proofCount,
            ...response
              .slice(responseOffset, responseOffset + association.proofCount)
              .map(({ Y, state }) => ({
                Y,
                state: String(state) as 'UNSPENT' | 'PENDING' | 'SPENT',
              })),
          )
          states.set(association.transferId, current)
          responseOffset += association.proofCount
        }
      } catch (error) {
        for (const transfer of chunk.transfers) failed.add(transfer.transferId)
        pending.push(
          ...chunk.transfers.map((transfer) => ({
            transferId: transfer.transferId,
            error: errorMessage(error),
          })),
        )
      }
    }
    for (const transfer of bearer) {
      if (failed.has(transfer.transferId)) {
        await this.#scheduleRetry(transfer, nowMs)
        continue
      }
      try {
        const response = states.get(transfer.transferId)
        if (response === undefined)
          throw new Error('mint proof-state recovery response is incomplete')
        const due = scheduleDurableOutgoingCashuRecoveryRetry({ transfer, nowMs }).recovery.dueAtMs
        const classified = classifyDurableOutgoingBearerProofStates({
          transfer,
          states: response,
          dueAtMs: due,
        }).transfer
        await this.#persistTransfer(classified)
        if (classified.deliveryState === 'bearer-spent') recovered.push(transfer.transferId)
      } catch (error) {
        await this.#scheduleRetry(transfer, nowMs)
        pending.push({ transferId: transfer.transferId, error: errorMessage(error) })
      }
    }
    const active = await withDurableCustodyFencedRead(
      this.#storage,
      fence,
      this.#now(),
      (database) => new DurableOutgoingCashuSqliteStore(database).activeSummary(fence.scopeId),
    )
    return {
      recovered,
      pending: [...new Map(pending.map((entry) => [entry.transferId, entry])).values()],
      hasMore: page.nextCursor !== null,
      ...active,
    }
  }

  async reclaim(input: {
    readonly transferId: string
    readonly wallet: CashuWalletLike
  }): Promise<DurableOutgoingCashuTransfer> {
    const transfer = await this.loadTransfer(input.transferId)
    if (transfer === null) throw new Error('durable outgoing Cashu transfer is missing')
    if (transfer.deliveryState === 'reclaim-prepared') {
      return this.#runReclaim(transfer, input.wallet)
    }
    if (transfer.deliveryState === 'reclaimed') {
      return transfer
    }
    if (transfer.deliveryState === 'bearer-spent') {
      return transfer
    }
    if (
      transfer.deliveryIntent.policy !== 'bearer-spend-classification' ||
      transfer.token === null ||
      (transfer.deliveryState !== 'delivery-pending' && transfer.deliveryState !== 'bearer-partial')
    ) {
      throw new Error('durable outgoing Cashu reclaim is not authorized')
    }
    if (!input.wallet.checkProofsStates || !input.wallet.prepareSwapToReceive) {
      throw new Error('cashu wallet does not support durable outgoing Cashu reclaim')
    }
    const proofStates = await input.wallet.checkProofsStates(
      transfer.token.proofs.map(({ id, secret }) => ({ id, secret })),
    )
    const classified = classifyDurableOutgoingBearerProofStates({
      transfer,
      states: proofStates.map(({ Y, state }) => ({
        Y,
        state: String(state) as 'UNSPENT' | 'PENDING' | 'SPENT',
      })),
      dueAtMs: this.#now(),
    }).transfer
    await this.#persistTransfer(classified)
    if (classified.deliveryState === 'bearer-spent') return classified
    if (
      classified.token?.unspentProofs === null ||
      classified.token === null ||
      (classified.deliveryState !== 'delivery-pending' &&
        classified.deliveryState !== 'bearer-partial')
    ) {
      throw new Error('durable outgoing Cashu reclaim is not authorized')
    }
    const token = getEncodedTokenV4({
      mint: transfer.mintUrl,
      unit: transfer.unit,
      proofs: classified.token.unspentProofs.map(hydrateDurableWalletProof),
    })
    let range: { keysetId: string; start: number; count: number } | undefined
    const preview = await input.wallet.prepareSwapToReceive(
      token,
      { onCountersReserved: (reserved) => (range = reserved) },
      { type: 'deterministic', counter: 0 },
    )
    if (range === undefined)
      throw new Error('daemon wallet reclaim did not reserve a deterministic output range')
    const reclaimId = `bearer-reclaim:${randomUUID()}`
    const operation = serializeDurableWalletReceiveOperation({
      operationId: reclaimId,
      mintUrl: transfer.mintUrl,
      unit: transfer.unit,
      preview,
      derivationRange: {
        keysetId: range.keysetId,
        counterStart: range.start,
        counterCount: range.count,
      },
    })
    const prepared = prepareDurableOutgoingCashuReclaim({
      transfer: classified,
      reclaimId,
      states: proofStates.map(({ Y, state }) => ({
        Y,
        state: String(state) as 'UNSPENT' | 'PENDING' | 'SPENT',
      })),
      dueAtMs: classified.recovery.dueAtMs,
      walletReceiveOperation: operation,
    })
    // The receive bind and the reclaim-prepared row must share one custody transaction.
    await this.#bindReclaim(classified, prepared, input.wallet)
    return this.#runReclaim(prepared, input.wallet)
  }

  async #persistTransfer(transfer: DurableOutgoingCashuTransfer): Promise<void> {
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, this.#now(), (database) => {
      const store = new DurableOutgoingCashuSqliteStore(database)
      const current = store.get(fence.scopeId, transfer.transferId)
      if (current === null) throw new Error('durable outgoing Cashu transfer is missing')
      store.put({
        scopeId: fence.scopeId,
        custodyOperationId: current.custodyOperationId,
        transfer,
        nowMs: this.#now(),
      })
    })
  }

  async #scheduleRetry(transfer: DurableOutgoingCashuTransfer, nowMs: number): Promise<void> {
    await this.#persistTransfer(scheduleDurableOutgoingCashuRecoveryRetry({ transfer, nowMs }))
  }

  async #bindReclaim(
    classified: DurableOutgoingCashuTransfer,
    prepared: DurableOutgoingCashuTransfer,
    wallet: CashuWalletLike,
  ): Promise<void> {
    if (prepared.reclaim === null)
      throw new Error('durable outgoing Cashu reclaim authority is missing')
    const custody = toDurableCustodyProofOperationInput(prepared.reclaim.walletReceiveOperation)
    const authority = prepareDurableCustodyMintOperationAuthority({
      operation: custody,
      keysets: receiveKeysets(custody, wallet),
    })
    const fence = this.#getFence()
    const nowMs = this.#now()
    const record = createDurableCustodyProofOperation({
      scope: walletScope(fence),
      operation: custody,
      facts: authority.facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: 'POST',
        path: '/v1/swap',
        idempotencyKey: prepared.reclaim.reclaimId,
        requestBody: authority.exactRequest,
        output: authority.exactOutput,
        privateMaterial: authority.exactAuthority,
      },
    })
    await withDurableCustodyUnitOfWork(this.#storage, fence, nowMs, (database) => {
      const outgoing = new DurableOutgoingCashuSqliteStore(database)
      const current = outgoing.get(fence.scopeId, classified.transferId)
      if (current === null) throw new Error('durable outgoing Cashu transfer is missing')
      assertExactTransfer(current.transfer, classified)
      const store = new DurableCustodySqliteStore(database)
      const existing = store.getOperation(record.operation.operationId)
      if (existing === null) {
        assertReclaimCounterRange(database, fence.scopeId, prepared.reclaim!.walletReceiveOperation)
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs),
          selection(record, owner(fence, nowMs), null),
          (transaction) =>
            bindDurableCustodyProofOperation(transaction, record, {
              requestBody: authority.exactRequest,
              output: authority.exactOutput,
              privateMaterial: authority.exactAuthority,
            }),
        )
      } else {
        assertDurableCustodyMintOperationAuthority(existing, authority.exactAuthority)
      }
      outgoing.put({
        scopeId: fence.scopeId,
        custodyOperationId: current.custodyOperationId,
        transfer: prepared,
        nowMs,
      })
    })
  }

  async #runReclaim(
    expected: DurableOutgoingCashuTransfer,
    wallet: CashuWalletLike,
  ): Promise<DurableOutgoingCashuTransfer> {
    if (expected.reclaim === null || !wallet.completeSwap || !wallet.checkProofsStates) {
      throw new Error('cashu wallet does not support durable outgoing Cashu reclaim recovery')
    }
    const reclaim = expected.reclaim
    const result = await runDurableWalletReceiveOperation({
      mode: 'recover',
      operationId: reclaim.walletReceiveOperation.operationId,
      wallet: {
        completeSwap: wallet.completeSwap.bind(wallet),
        checkProofsStates: wallet.checkProofsStates.bind(wallet),
      },
      store: {
        loadOperation: () => this.#loadReclaimSnapshot(expected),
        persistCompletedResult: ({ operation, result }) =>
          this.#stageReclaimResult(expected, operation, result.receive),
      },
      restoreExactOutputs: ({ mintUrl, outputs }) =>
        this.#restoreExactOutputs(mintUrl, {
          send: [],
          keep: outputs as readonly DurableOutput[],
        }).then((restored) => ({ receive: restored.keep ?? [] })),
    })
    if (result.state === 'nonterminal') return expected
    if (result.state === 'recipient-spent') return this.#markReclaimSpent(expected)
    return this.#completeReclaim(expected, result.proofs)
  }

  async #loadReclaimSnapshot(expected: DurableOutgoingCashuTransfer) {
    if (expected.reclaim === null)
      throw new Error('durable outgoing Cashu reclaim authority is missing')
    const reclaim = expected.reclaim
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const current = new DurableOutgoingCashuSqliteStore(database).get(
        fence.scopeId,
        expected.transferId,
      )
      if (current === null) return null
      if (current.transfer.reclaim === null)
        throw new Error('durable outgoing Cashu reclaim is missing')
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperationByRetainedOperationKey(
        fence.scopeId,
        current.transfer.reclaim.walletReceiveOperation.operationId,
      )
      if (record === null)
        throw new Error('durable outgoing Cashu reclaim receive operation is missing')
      const authority = exactAuthority(record, store)
      const operation = requireDurableWalletOperationFromCustody(
        assertDurableCustodyMintOperationAuthority(record, authority).operation,
      )
      if (
        operation.kind !== 'wallet-receive' ||
        operation.operationId !== reclaim.walletReceiveOperation.operationId
      ) {
        throw new Error('durable outgoing Cashu reclaim receive authority is foreign')
      }
      if (record.operation.result.state === 'none')
        return { operation, state: 'prepared' as const, result: null }
      if (
        record.operation.result.state !== 'verified-staged' &&
        record.operation.result.state !== 'applied'
      ) {
        throw new Error('durable outgoing Cashu reclaim receive result is invalid')
      }
      const result = readDurableCustodyVerifiedMintResult({
        record,
        exactAuthority: authority,
        exactResult: exactResult(record, store),
      }).proofs.map(({ proof }) => proof)
      return { operation, state: 'completed' as const, result: { receive: result } }
    })
  }

  async #stageReclaimResult(
    expected: DurableOutgoingCashuTransfer,
    operation: DurableWalletReceiveOperation,
    proofs: readonly Proof[],
  ): Promise<'completed'> {
    if (expected.reclaim === null)
      throw new Error('durable outgoing Cashu reclaim authority is missing')
    const fence = this.#getFence()
    const nowMs = this.#now()
    await withDurableCustodyUnitOfWork(this.#storage, fence, nowMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperationByRetainedOperationKey(fence.scopeId, operation.operationId)
      if (record === null)
        throw new Error('durable outgoing Cashu reclaim receive operation is missing')
      if (record.operation.result.state !== 'none') return
      const prepared = prepareDurableCustodyVerifiedMintResult({
        record,
        exactAuthority: exactAuthority(record, store),
        result: { receive: proofs },
      })
      const transaction = new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs, [
        record,
      ])
      applyDurableCustodyTransaction(
        transaction,
        selection(record, owner(fence, nowMs), record.revision),
        (selected) =>
          stageDurableCustodyPreparedMintResult({
            transaction: selected,
            record,
            prepared,
            authorization: owner(fence, nowMs),
          }),
      )
    })
    return 'completed'
  }

  async #completeReclaim(
    expected: DurableOutgoingCashuTransfer,
    successorProofs: readonly Proof[],
  ): Promise<DurableOutgoingCashuTransfer> {
    if (expected.reclaim === null)
      throw new Error('durable outgoing Cashu reclaim authority is missing')
    const fence = this.#getFence()
    const nowMs = this.#now()
    return withDurableCustodyUnitOfWork(this.#storage, fence, nowMs, (database) => {
      const outgoing = new DurableOutgoingCashuSqliteStore(database)
      const stored = outgoing.get(fence.scopeId, expected.transferId)
      if (stored === null) throw new Error('durable outgoing Cashu transfer is missing')
      if (stored.transfer.deliveryState === 'reclaimed') return stored.transfer
      assertExactTransfer(stored.transfer, expected)
      const reclaim = stored.transfer.reclaim
      if (reclaim === null) throw new Error('durable outgoing Cashu reclaim authority is missing')
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperationByRetainedOperationKey(
        fence.scopeId,
        reclaim.walletReceiveOperation.operationId,
      )
      if (record === null || record.operation.result.state !== 'verified-staged') {
        throw new Error('durable outgoing Cashu reclaim receive result is not staged')
      }
      const authority = exactAuthority(record, store)
      const verified = readDurableCustodyVerifiedMintResult({
        record,
        exactAuthority: authority,
        exactResult: exactResult(record, store),
      })
      const transaction = new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs, [
        record,
      ])
      const successors = verified.proofs.map(({ material, dleqState }) => ({
        proof: createCustodyProofSqliteRowFromMaterial({
          scopeId: fence.scopeId,
          normalizedMint: stored.transfer.mintUrl,
          unit: receiveUnit(stored.transfer.unit),
          material,
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState,
          nut07State: 'UNSPENT',
          selectability: 'retained',
          storageClass: record.operation.proofStorage.storageClass,
          reservationOperationId: null,
          revision: 0,
          nowMs,
        }),
        expectedRevision: null,
      }))
      transaction.stageSuccessorProofCas(record.operation.operationId, successors)
      const authorization = owner(fence, nowMs)
      applyDurableCustodyTransaction(
        transaction,
        selection(record, authorization, record.revision),
        (selected) => {
          selected.applyVerifiedResult({
            operationId: record.operation.operationId,
            expectedRevision: record.revision,
            authorization,
            outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: requiredText(record.operation.result.resultHandle),
            resultFingerprint: requiredText(record.operation.result.resultFingerprint),
            successorAdmission: {
              scopeId: fence.scopeId,
              operationId: record.operation.operationId,
              admissionId: `bearer-reclaim:${requiredText(record.operation.result.resultFingerprint)}`,
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
        scopeId: fence.scopeId,
        operationRows: [
          { operationId: record.operation.operationId, expectedRevision: record.revision + 1 },
        ],
      })
      for (const { proof } of verified.proofs) {
        admitExactAvailableWalletProofsFromDatabase(database, {
          mintUrl: stored.transfer.mintUrl,
          proofs: [proof],
          asset: { kind: 'sats', baseAsset: 'sat', unit: receiveUnit(stored.transfer.unit) },
          nowMs,
        })
      }
      const evidence = {
        transferId: stored.transfer.transferId,
        reclaimId: reclaim.reclaimId,
        walletReceiveOperationAuthority: reclaim.walletReceiveOperationAuthority,
        successorProofFingerprint: deriveDurableCustodyArtifactFingerprint(
          successorProofs.map(serializeDurableWalletProof),
        ),
        custodyRevisions: reclaimCustodyRevisions(
          database,
          fence.scopeId,
          stored.transfer.mintUrl,
          stored.transfer.unit,
          reclaim.proofs,
          successorProofs,
        ),
      }
      const completed = completeDurableOutgoingCashuReclaim({
        transfer: stored.transfer,
        successorProofs,
        evidence,
      })
      outgoing.put({
        scopeId: fence.scopeId,
        custodyOperationId: stored.custodyOperationId,
        transfer: completed,
        nowMs,
      })
      return completed
    })
  }

  async #markReclaimSpent(
    expected: DurableOutgoingCashuTransfer,
  ): Promise<DurableOutgoingCashuTransfer> {
    const fence = this.#getFence()
    const nowMs = this.#now()
    return withDurableCustodyUnitOfWork(this.#storage, fence, nowMs, (database) => {
      const outgoing = new DurableOutgoingCashuSqliteStore(database)
      const stored = outgoing.get(fence.scopeId, expected.transferId)
      if (stored === null) throw new Error('durable outgoing Cashu transfer is missing')
      assertExactTransfer(stored.transfer, expected)
      const reclaim = stored.transfer.reclaim
      if (reclaim === null) throw new Error('durable outgoing Cashu reclaim authority is missing')
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperationByRetainedOperationKey(
        fence.scopeId,
        reclaim.walletReceiveOperation.operationId,
      )
      if (record === null || record.operation.result.state !== 'none') {
        throw new Error('durable outgoing Cashu reclaim receive operation is invalid')
      }
      if (record.operation.state === 'dispatch-intent') {
        const authorization = owner(fence, nowMs)
        const transaction = new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs, [
          record,
        ])
        applyDurableCustodyTransaction(
          transaction,
          selection(record, authorization, record.revision),
          (selected) =>
            selected.transitionOperation({
              operationId: record.operation.operationId,
              expectedRevision: record.revision,
              transition: { kind: 'abort', authorization, expectedRevision: record.revision },
            }),
        )
        transaction.rebuildActiveWorkIndex({
          scopeId: fence.scopeId,
          operationRows: [
            { operationId: record.operation.operationId, expectedRevision: record.revision + 1 },
          ],
        })
      } else if (record.operation.state !== 'aborted') {
        throw new Error('durable outgoing Cashu reclaim receive operation is not abortable')
      }
      const spent = markDurableOutgoingCashuReclaimRecipientSpent(stored.transfer)
      outgoing.put({
        scopeId: fence.scopeId,
        custodyOperationId: stored.custodyOperationId,
        transfer: spent,
        nowMs,
      })
      return spent
    })
  }

  async #prepare(input: {
    readonly transferId: string
    readonly amountSats: number
    readonly mintUrl: string
    readonly wallet: CashuWalletLike
  }): Promise<DurableOutgoingCashuTransfer> {
    if (!input.wallet.prepareSwapToSend || !input.wallet.completeSwap) {
      throw new Error('cashu wallet does not support durable send preparation')
    }
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    const available = await readAvailableWalletProofsFenced({
      mintUrl: input.mintUrl,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
      mutation: { fence, observedAtMs },
    })
    assertV2OutgoingProofs(available.map(({ proof }) => proof))
    const preview = await input.wallet.prepareSwapToSend(
      input.amountSats,
      available.map(({ proof }) => proof as Proof),
      undefined,
      {
        send: { type: 'random' },
        keep: { type: 'random' },
      },
    )
    const operation = serializeDurableWalletSendOperation({
      operationId: input.transferId,
      mintUrl: input.mintUrl,
      unit: 'sat',
      preview,
    })
    const transfer = createDurableOutgoingCashuTransfer({
      transferId: input.transferId,
      walletScopeId: fence.scopeId,
      requestedAmount: String(input.amountSats),
      walletSendOperation: operation,
      keepProofDerivationLocators: operation.preview.keepOutputs.map(() => null),
      deliveryIntent: {
        policy: 'bearer-spend-classification',
        tokenBytesLimit: TOKEN_BYTES_LIMIT,
        tokenProofLimit: TOKEN_PROOF_LIMIT,
      },
      dueAtMs: observedAtMs,
    })
    const binding = outgoingBinding(walletScope(fence), operation, input.wallet)
    const reservationId = `wallet-send:${input.transferId}`
    await prepareProofOperationWithExactReservation(
      {
        operationId: input.transferId,
        kind: 'wallet-send',
        mintUrl: input.mintUrl,
        inputs: preview.inputs,
        outputs: {
          send: serializeOutputs(preview.sendOutputs ?? []),
          keep: serializeOutputs(preview.keepOutputs ?? []),
        },
        metadata: {
          purpose: 'durable-outgoing-cashu',
          reservationId,
          inputAsset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
          successorAssets: { keep: { kind: 'sats', baseAsset: 'sat', unit: 'sat' } },
          amount: amountToNumber(preview.amount),
          fees: amountToNumber(preview.fees),
          keysetId: preview.keysetId,
          unselectedProofs: preview.unselectedProofs ?? [],
          unit: 'sat',
        },
        reservationId,
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
      },
      { fence, observedAtMs },
      (database) => {
        const store = new DurableCustodySqliteStore(database)
        const existing = store.getOperation(binding.record.operation.operationId)
        if (existing === null) {
          applyDurableCustodyTransaction(
            new DurableCustodyTransactionSqlite(database, fence.scopeId, observedAtMs),
            selection(binding.record, owner(fence, observedAtMs), null),
            (transaction) =>
              bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
          )
        } else {
          assertDurableCustodyMintOperationAuthority(existing, binding.artifacts.privateMaterial)
        }
        new DurableOutgoingCashuSqliteStore(database).put({
          scopeId: fence.scopeId,
          custodyOperationId: binding.record.operation.operationId,
          transfer,
          nowMs: observedAtMs,
        })
      },
    )
    return transfer
  }

  async #run(
    transfer: DurableOutgoingCashuTransfer,
    wallet: CashuWalletLike,
    mode: 'execute' | 'recover',
  ): Promise<DurableOutgoingCashuTransfer> {
    if (!wallet.completeSwap || !wallet.checkProofsStates) {
      throw new Error('cashu wallet does not support durable send recovery')
    }
    const request = transferRequest(transfer)
    return runDurableOutgoingCashuTransfer({
      mode,
      transfer: request,
      wallet: {
        completeSwap: wallet.completeSwap.bind(wallet),
        checkProofsStates: wallet.checkProofsStates.bind(wallet),
      },
      restoreExactOutputs: ({ mintUrl, outputs }) => this.#restoreExactOutputs(mintUrl, outputs),
      preMint: {
        prepare: async () => transfer,
        recover: async () => this.#requireExactTransfer(transfer),
      },
      postMint: {
        persistMinted: async (minted) => this.#persistMinted(minted),
      },
      walletOperationStore: {
        loadOperation: async (operationId) => this.#loadExactOperation(transfer, operationId),
        persistCompletedResult: async () => {
          throw new Error('durable outgoing Cashu post-mint boundary was bypassed')
        },
      },
    })
  }

  async #persistMinted(input: {
    readonly transfer: DurableOutgoingCashuTransfer
    readonly keepProofs: readonly unknown[]
    readonly sendProofs: readonly unknown[]
    readonly encodedToken: string
  }): Promise<DurableOutgoingCashuTransfer> {
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    return withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const outgoing = new DurableOutgoingCashuSqliteStore(database)
      const stored = outgoing.get(fence.scopeId, input.transfer.transferId)
      if (stored === null || stored.custodyOperationId.length === 0) {
        throw new Error('durable outgoing Cashu transfer is missing')
      }
      const currentTransfer = stored.transfer
      if (currentTransfer.deliveryState === 'delivery-pending') return currentTransfer
      assertExactTransfer(currentTransfer, input.transfer)
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(stored.custodyOperationId)
      if (record === null) throw new Error('durable outgoing custody operation is missing')
      const authority = exactAuthority(record, store)
      const keepProofs = input.keepProofs as Proof[]
      const mintedKeepProofs = keepProofs.slice(
        0,
        currentTransfer.walletSendOperation.preview.keepOutputs.length,
      )
      const prepared = prepareDurableCustodyVerifiedMintResult({
        record,
        exactAuthority: authority,
        result: {
          keep: mintedKeepProofs,
          send: input.sendProofs as Proof[],
        },
      })
      const revisions = custodyRevisions(database, record, currentTransfer, prepared.proofs)
      const admitted = admitDurableOutgoingCashuToken({
        transfer: currentTransfer,
        keepProofs: input.keepProofs,
        sendProofs: input.sendProofs,
        encodedToken: input.encodedToken,
        custodyRevisions: revisions,
        dueAtMs: currentTransfer.recovery.dueAtMs,
      })
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        fence.scopeId,
        observedAtMs,
        [record],
      )
      const authorization = owner(fence, observedAtMs)
      stageDurableCustodyPreparedMintResult({ transaction, record, prepared, authorization })
      const staged = transaction.getOperation(record.operation.operationId)
      if (staged === null) throw new Error('durable outgoing custody result staging failed')
      const successors = prepared.proofs.map(({ group, material, dleqState }) => ({
        proof: createCustodyProofSqliteRowFromMaterial({
          scopeId: staged.scope.scopeId,
          normalizedMint: staged.operation.custodyContext.normalizedMint,
          unit: 'sat',
          material,
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState,
          nut07State: group === 'send' ? 'SPENT' : 'UNSPENT',
          selectability: group === 'send' ? 'spent' : 'selectable',
          storageClass: staged.operation.proofStorage.storageClass,
          reservationOperationId: null,
          revision: 0,
          nowMs: observedAtMs,
        }),
        expectedRevision: null,
      }))
      transaction.stageSuccessorProofCas(staged.operation.operationId, successors)
      transaction.applyVerifiedResult({
        operationId: staged.operation.operationId,
        expectedRevision: staged.revision,
        authorization,
        outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
        resultHandle: requiredText(staged.operation.result.resultHandle),
        resultFingerprint: requiredText(staged.operation.result.resultFingerprint),
        successorAdmission: {
          scopeId: staged.scope.scopeId,
          operationId: staged.operation.operationId,
          admissionId: `wallet-send:${requiredText(staged.operation.result.resultFingerprint)}`,
          proofRows: successors.map(({ proof, expectedRevision }) => ({
            proofId: proof.proofId,
            expectedRevision,
            admittedRevision: proof.revision,
          })),
        },
      })
      transaction.rebuildActiveWorkIndex({
        scopeId: fence.scopeId,
        operationRows: [
          {
            operationId: staged.operation.operationId,
            expectedRevision: staged.revision + 1,
          },
        ],
      })
      completeDurableOutgoingWalletSendFromDatabase(database, {
        operationId: currentTransfer.walletSendOperation.operationId,
        reservationId: `wallet-send:${currentTransfer.walletSendOperation.operationId}`,
        keepProofs: input.keepProofs as Proof[],
        sendProofs: input.sendProofs as Proof[],
        nowMs: observedAtMs,
      })
      outgoing.put({
        scopeId: fence.scopeId,
        custodyOperationId: stored.custodyOperationId,
        transfer: admitted,
        nowMs: observedAtMs,
      })
      return admitted
    })
  }

  async #requireExactTransfer(
    expected: DurableOutgoingCashuTransfer,
  ): Promise<DurableOutgoingCashuTransfer> {
    const transfer = await this.loadTransfer(expected.transferId)
    if (transfer === null) throw new Error('durable outgoing Cashu transfer is missing')
    assertExactTransfer(transfer, expected)
    return transfer
  }

  async #loadExactOperation(transfer: DurableOutgoingCashuTransfer, operationId: string) {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const outgoing = new DurableOutgoingCashuSqliteStore(database).get(
        fence.scopeId,
        transfer.transferId,
      )
      if (outgoing === null) return null
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(outgoing.custodyOperationId)
      if (record === null) return null
      const operation = requireDurableWalletOperationFromCustody(
        assertDurableCustodyMintOperationAuthority(record, exactAuthority(record, store)).operation,
      )
      if (operation.kind !== 'wallet-send' || operation.operationId !== operationId) {
        throw new Error('durable outgoing Cashu operation is foreign')
      }
      return {
        operation,
        state:
          outgoing.transfer.deliveryState === 'delivery-pending'
            ? ('completed' as const)
            : ('prepared' as const),
        result: null,
      }
    })
  }

  async #restoreExactOutputs(
    mintUrl: string,
    outputs: Readonly<Record<'send' | 'keep', readonly DurableOutput[]>>,
  ) {
    const restored = await (
      this.#deps.restoreOutputGroups ?? (await import('./walletOps.ts')).restoreOutputGroups
    )(mintUrl, {
      send: outputs.send.map(toStoredOutput),
      keep: outputs.keep.map(toStoredOutput),
    })
    return { send: restored.send ?? [], keep: restored.keep ?? [] }
  }
}

type DurableOutput = {
  readonly blindedMessage: { readonly amount: string; readonly id: string; readonly B_: string }
  readonly blindingFactor: string
  readonly secret: string
  readonly ephemeralE: string | null
}

function serializeOutputs(
  outputs: readonly {
    readonly blindedMessage: { readonly amount: unknown; readonly id: string; readonly B_: string }
    readonly blindingFactor: bigint
    readonly secret: Uint8Array
    readonly ephemeralE?: string
  }[],
): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: Buffer.from(output.secret).toString('hex'),
    ...(output.ephemeralE === undefined ? {} : { ephemeralE: output.ephemeralE }),
  }))
}

function toStoredOutput(output: DurableOutput): StoredOutputData {
  return {
    blindedMessage: {
      amount: Number(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: BigInt(output.blindingFactor).toString(16),
    secret: Buffer.from(output.secret, 'utf8').toString('hex'),
    ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
  }
}

function outgoingBinding(
  scope: DurableCustodyScope,
  operation: DurableWalletSendOperation,
  wallet: CashuWalletLike,
) {
  const custody = toDurableCustodyProofOperationInput(operation)
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation: custody,
    keysets: outgoingKeysets(custody, wallet),
  })
  return {
    record: createDurableCustodyProofOperation({
      scope,
      operation: custody,
      facts: authority.facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: 'POST',
        path: '/v1/swap',
        idempotencyKey: operation.operationId,
        requestBody: authority.exactRequest,
        output: authority.exactOutput,
        privateMaterial: authority.exactAuthority,
      },
    }),
    artifacts: {
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
  }
}

function outgoingKeysets(
  operation: ReturnType<typeof toDurableCustodyProofOperationInput>,
  wallet: CashuWalletLike,
) {
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ])
  return [...ids].map((id) => {
    if (typeof id !== 'string' || !/^01[0-9a-f]{64}$/.test(id))
      throw new Error('durable outgoing Cashu send supports only V2 keysets')
    const keyset = wallet.getKeyset?.(id) as
      | {
          id: string
          unit?: string
          keys: Record<string, string> | Record<number, string>
          fee?: number
          expiry?: number
          conditional?: unknown
          verify?: () => boolean
        }
      | undefined
    if (
      !keyset ||
      keyset.id !== id ||
      keyset.unit !== operation.metadata?.unit ||
      keyset.verify?.() !== true ||
      keyset.conditional !== undefined
    )
      throw new Error('durable outgoing Cashu send keyset is invalid')
    const unit = keyset.unit
    if (unit === undefined) throw new Error('durable outgoing Cashu send keyset unit is missing')
    return {
      canonicalMintUrl: operation.mintUrl,
      id,
      unit,
      keys: Object.fromEntries(Object.entries(keyset.keys)),
      inputFeePpk: keyset.fee ?? 0,
      finalExpiry: keyset.expiry ?? null,
      identity: { kind: 'regular' as const },
    }
  })
}

function custodyRevisions(
  database: Parameters<typeof withDurableCustodyUnitOfWork>[3] extends (
    database: infer T,
  ) => unknown
    ? T
    : never,
  record: DurableCustodyRecord,
  transfer: DurableOutgoingCashuTransfer,
  proofs: readonly {
    readonly proof: { readonly id: string; readonly secret: string; readonly C: string }
  }[],
) {
  const read = database.prepare(
    'SELECT revision FROM custody_proofs WHERE scope_id = ? AND proof_id = ?',
  )
  const inputs = transfer.walletSendOperation.preview.inputs.map((proof) => {
    const proofId = deriveDurableCustodyProofId({
      scopeId: record.scope.scopeId,
      normalizedMint: transfer.mintUrl,
      unit: transfer.unit,
      keysetId: proof.id,
      secret: proof.secret,
    })
    const row = read.get(record.scope.scopeId, proofId) as { revision: number } | undefined
    if (row === undefined) throw new Error('durable outgoing custody predecessor is missing')
    return {
      proofIdentity: deriveDurableCustodyArtifactFingerprint({
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      }),
      revision: row.revision + 1,
    }
  })
  const unselected = transfer.walletSendOperation.preview.unselectedProofs.map((proof) => {
    const proofId = deriveDurableCustodyProofId({
      scopeId: record.scope.scopeId,
      normalizedMint: transfer.mintUrl,
      unit: transfer.unit,
      keysetId: proof.id,
      secret: proof.secret,
    })
    const row = read.get(record.scope.scopeId, proofId) as { revision: number } | undefined
    if (row === undefined) throw new Error('durable outgoing custody passthrough proof is missing')
    return {
      proofIdentity: deriveDurableCustodyArtifactFingerprint({
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      }),
      revision: row.revision,
    }
  })
  return [
    ...inputs,
    ...unselected,
    ...proofs.map(({ proof }) => ({
      proofIdentity: deriveDurableCustodyArtifactFingerprint({
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      }),
      revision: 0,
    })),
  ]
}

function reclaimCustodyRevisions(
  database: Parameters<typeof withDurableCustodyUnitOfWork>[3] extends (
    database: infer T,
  ) => unknown
    ? T
    : never,
  scopeId: string,
  mintUrl: string,
  unit: string,
  inputs: readonly DurableWalletProof[],
  successors: readonly Proof[],
) {
  const read = database.prepare(
    'SELECT revision FROM custody_proofs WHERE scope_id = ? AND proof_id = ?',
  )
  return [
    ...inputs.map((proof) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId,
        normalizedMint: mintUrl,
        unit,
        keysetId: proof.id,
        secret: proof.secret,
      })
      const row = read.get(scopeId, proofId) as { revision: number } | undefined
      if (row === undefined) throw new Error('durable outgoing reclaim predecessor is missing')
      return {
        proofIdentity: deriveDurableCustodyArtifactFingerprint({
          id: proof.id,
          secret: proof.secret,
          C: proof.C,
        }),
        revision: row.revision,
      }
    }),
    ...successors.map((proof) => ({
      proofIdentity: deriveDurableCustodyArtifactFingerprint({
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      }),
      revision: 0,
    })),
  ]
}

function receiveKeysets(
  operation: ReturnType<typeof toDurableCustodyProofOperationInput>,
  wallet: CashuWalletLike,
) {
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ])
  return [...ids].map((id) => {
    if (typeof id !== 'string' || !/^01[0-9a-f]{64}$/.test(id)) {
      throw new Error('daemon wallet reclaim supports only V2 keysets')
    }
    const keyset = wallet.getKeyset?.(id) as
      | {
          id: string
          unit?: string
          keys: Record<string, string> | Record<number, string>
          fee?: number
          expiry?: number
          conditional?: unknown
          verify?: () => boolean
        }
      | undefined
    if (
      !keyset ||
      keyset.id !== id ||
      keyset.unit !== operation.metadata?.unit ||
      keyset.verify?.() !== true ||
      keyset.conditional !== undefined
    ) {
      throw new Error('daemon wallet reclaim keyset is invalid')
    }
    return {
      canonicalMintUrl: operation.mintUrl,
      id,
      unit: keyset.unit!,
      keys: Object.fromEntries(Object.entries(keyset.keys)),
      inputFeePpk: keyset.fee ?? 0,
      finalExpiry: keyset.expiry ?? null,
      identity: { kind: 'regular' as const },
    }
  })
}

function assertReclaimCounterRange(
  database: Parameters<typeof readExactBoundCounter>[0],
  scopeId: string,
  operation: DurableWalletReceiveOperation,
): void {
  const range = operation.derivationRange
  if (range === null) throw new Error('daemon wallet reclaim derivation range is missing')
  const next = readExactBoundCounter(database, scopeId, range.keysetId, {
    normalizedMint: operation.mintUrl,
    unit: receiveUnit(operation.unit),
  })
  if (next < range.counterStart + range.counterCount) {
    throw new Error('daemon wallet reclaim counter authority is incomplete')
  }
}

function receiveUnit(unit: string): 'sat' | 'msat' {
  if (unit !== 'sat' && unit !== 'msat') throw new Error('daemon wallet reclaim unit is invalid')
  return unit
}

function exactResult(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const reference = record.operation.result.exactResult
  if (reference === null) throw new Error('durable outgoing reclaim result authority is missing')
  const result = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (result === null) throw new Error('durable outgoing reclaim result authority is missing')
  return result.artifact
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function exactAuthority(
  record: DurableCustodyRecord,
  store: DurableCustodySqliteStore,
): DurableCustodyExactArtifact {
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (row === null) throw new Error('durable outgoing custody authority is missing')
  return row.artifact
}

function walletScope(fence: CustodyScopeFence): DurableCustodyScope {
  if (!fence.scopeId.startsWith('custody:wallet:'))
    throw new Error('durable outgoing Cashu scope is foreign')
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

function transferRequest(
  transfer: DurableOutgoingCashuTransfer,
): DurableOutgoingCashuCoordinatorInput['transfer'] {
  return {
    transferId: transfer.transferId,
    walletScopeId: transfer.walletScopeId,
    mintUrl: transfer.mintUrl,
    unit: transfer.unit,
    requestedAmount: transfer.requestedAmount,
    deliveryIntent: transfer.deliveryIntent,
  }
}

function assertExactTransfer(
  actual: DurableOutgoingCashuTransfer,
  expected: DurableOutgoingCashuTransfer,
): void {
  if (
    deriveDurableCustodyArtifactFingerprint(actual) !==
    deriveDurableCustodyArtifactFingerprint(expected)
  ) {
    throw new Error('durable outgoing Cashu transfer authority conflicts')
  }
}

function requiredText(value: string | null): string {
  if (!value) throw new Error('durable outgoing custody result authority is missing')
  return value
}

function assertV2OutgoingProofs(proofs: readonly { readonly id?: string }[]): void {
  if (proofs.some(({ id }) => typeof id !== 'string' || !/^01[0-9a-f]{64}$/.test(id))) {
    throw new Error('durable outgoing Cashu send supports only V2 keysets')
  }
}
