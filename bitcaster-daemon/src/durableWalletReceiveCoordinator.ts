import type { Proof } from '@cashu/cashu-ts'
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
  requireDurableWalletOperationFromCustody,
  runDurableWalletReceiveOperation,
  toDurableCustodyProofOperationInput,
  type DurableWalletReceiveOperation,
  type DurableWalletReceiveOperationSnapshot,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { createCustodyProofSqliteRowFromMaterial } from './custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { admitExactAvailableWalletProofsFromDatabase, readExactBoundCounter } from './state.ts'
import type { CashuWalletLike } from './walletOps.ts'

export interface PreparedDaemonWalletReceive {
  readonly operation: DurableWalletReceiveOperation
}

export interface DaemonWalletReceiveResult {
  readonly proofs: readonly Proof[]
  readonly operationId: string
}

/** Fenced SQLite coordinator for the SDK's ordinary-wallet receive state machine. */
export class DaemonDurableWalletReceiveCoordinator {
  readonly #storage
  readonly #getFence: () => CustodyScopeFence
  readonly #now: () => number
  readonly #restoreExactOutputs: (
    mintUrl: string,
    outputs: Record<string, StoredReceiveOutput[]>,
  ) => Promise<Record<string, Proof[]>>

  constructor(
    directory: string,
    getFence: () => CustodyScopeFence,
    restoreExactOutputs: (
      mintUrl: string,
      outputs: Record<string, StoredReceiveOutput[]>,
    ) => Promise<Record<string, Proof[]>>,
    now: () => number = Date.now,
  ) {
    this.#storage = createDaemonStateSqliteSession(directory)
    this.#getFence = getFence
    this.#restoreExactOutputs = restoreExactOutputs
    this.#now = now
  }

  async execute(input: {
    readonly prepared: PreparedDaemonWalletReceive
    readonly wallet: CashuWalletLike
  }): Promise<DaemonWalletReceiveResult> {
    const custodyOperationId = await this.#bind(input.prepared.operation, input.wallet)
    const result = await this.#run(
      'execute',
      input.prepared.operation.operationId,
      custodyOperationId,
      input.wallet,
    )
    if (result.state === 'nonterminal')
      throw new Error('daemon wallet receive did not reach a terminal state')
    return { proofs: result.proofs, operationId: input.prepared.operation.operationId }
  }

  async recover(input: {
    readonly walletFor: (mintUrl: string, unit: 'sat' | 'msat') => Promise<CashuWalletLike>
  }): Promise<{
    recovered: string[]
    recoveredCount: number
    pending: Array<{ operationId: string; error: string }>
    pendingCount: number
    hasMore: boolean
  }> {
    const recovered: string[] = []
    const pending: Array<{ operationId: string; error: string }> = []
    let recoveredCount = 0
    const page = await this.#activePage()
    const wallets = new Map<string, Promise<CashuWalletLike>>()
    for (const row of page.rows) {
      try {
        const loaded = await this.#loadRecord(row.operationId)
        if (loaded === null || !isReceiveRecord(loaded.record)) continue
        const operation = this.#operationFromRecord(loaded.record, loaded.exactAuthority)
        const unit = receiveUnit(operation)
        const walletKey = `${operation.mintUrl}\u0000${unit}`
        let wallet = wallets.get(walletKey)
        if (wallet === undefined) {
          wallet = input.walletFor(operation.mintUrl, unit).then(async (created) => {
            await created.loadMint()
            return created
          })
          wallets.set(walletKey, wallet)
        }
        const result = await this.#run(
          'recover',
          operation.operationId,
          row.operationId,
          await wallet,
        )
        if (result.state === 'nonterminal') {
          pending.push({
            operationId: operation.operationId,
            error: 'mint proof state remains pending',
          })
        } else {
          recoveredCount += 1
          recovered.push(operation.operationId)
        }
      } catch (error) {
        pending.push({ operationId: row.operationId, error: errorMessage(error) })
      }
    }
    await this.#advanceRecoveryCursor(page.nextCursor)
    const pendingCount = await this.#activeReceiveCount()
    return {
      recovered,
      recoveredCount,
      pending,
      pendingCount,
      hasMore: page.nextCursor !== null,
    }
  }

  async #bind(operation: DurableWalletReceiveOperation, wallet: CashuWalletLike): Promise<string> {
    const custody = toDurableCustodyProofOperationInput(operation)
    const authority = prepareDurableCustodyMintOperationAuthority({
      operation: custody,
      keysets: receiveKeysets(custody, wallet),
    })
    const scope = walletScope(this.#getFence())
    const record = createDurableCustodyProofOperation({
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
    })
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const existing = store.getOperation(record.operation.operationId)
      if (existing !== null) {
        assertDurableCustodyMintOperationAuthority(existing, authority.exactAuthority)
        return
      }
      assertPersistedCounterRange(database, fence.scopeId, operation)
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
    return record.operation.operationId
  }

  async #run(
    mode: 'execute' | 'recover',
    operationId: string,
    custodyOperationId: string,
    wallet: CashuWalletLike,
  ) {
    if (!wallet.completeSwap || !wallet.checkProofsStates) {
      throw new Error('cashu wallet does not support durable receive recovery')
    }
    return runDurableWalletReceiveOperation({
      mode,
      operationId,
      wallet: {
        completeSwap: wallet.completeSwap.bind(wallet),
        checkProofsStates: wallet.checkProofsStates.bind(wallet),
      },
      store: {
        loadOperation: () => this.#loadSnapshot(custodyOperationId),
        persistCompletedResult: ({ operation, result }) =>
          this.#persistResult(custodyOperationId, operation, result),
      },
      restoreExactOutputs: async ({ mintUrl, outputs }) => {
        const restore = await this.#restoreExactOutputs(mintUrl, {
          receive: outputs.map(toLegacyStoredOutput),
        })
        return { receive: restore.receive ?? [] }
      },
    })
  }

  async #loadSnapshot(
    custodyOperationId: string,
  ): Promise<DurableWalletReceiveOperationSnapshot | null> {
    const loaded = await this.#loadRecord(custodyOperationId)
    if (loaded === null) return null
    const operation = this.#operationFromRecord(loaded.record, loaded.exactAuthority)
    switch (loaded.record.operation.result.state) {
      case 'none':
        return { operation, state: 'prepared' as const, result: null }
      case 'verified-staged':
        await this.#applyStaged(custodyOperationId)
        return this.#loadSnapshot(custodyOperationId)
      case 'applied':
        return {
          operation,
          state: 'completed' as const,
          result: {
            receive: this.#verifiedProofs(loaded.record, loaded.exactAuthority, loaded.exactResult),
          },
        }
      default:
        throw new Error('daemon wallet receive result state is invalid')
    }
  }

  async #persistResult(
    custodyOperationId: string,
    _operation: DurableWalletReceiveOperation,
    result: { readonly receive: readonly Proof[] },
  ): Promise<'completed'> {
    const loaded = await this.#loadRecord(custodyOperationId)
    if (loaded === null) throw new Error('daemon wallet receive operation is missing')
    const prepared = prepareDurableCustodyVerifiedMintResult({
      record: loaded.record,
      exactAuthority: loaded.exactAuthority,
      result,
    })
    if (loaded.record.operation.result.state === 'none') {
      const observedAtMs = this.#now()
      const fence = this.#getFence()
      await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
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
      })
    }
    await this.#applyStaged(custodyOperationId)
    return 'completed'
  }

  async #applyStaged(custodyOperationId: string): Promise<void> {
    const loaded = await this.#loadRecord(custodyOperationId)
    if (loaded === null) throw new Error('daemon wallet receive operation is missing')
    if (loaded.record.operation.result.state === 'applied') return
    if (loaded.record.operation.result.state !== 'verified-staged') {
      throw new Error('daemon wallet receive result is not staged')
    }
    const verified = readDurableCustodyVerifiedMintResult({
      record: loaded.record,
      exactAuthority: loaded.exactAuthority,
      exactResult: requiredLoadedResult(loaded),
    })
    const observedAtMs = this.#now()
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const current = requiredRecord(store, custodyOperationId)
      if (current.operation.result.state === 'applied') return
      const successors = verified.proofs.map(({ material, dleqState }) => ({
        proof: createCustodyProofSqliteRowFromMaterial({
          scopeId: current.scope.scopeId,
          normalizedMint: current.operation.custodyContext.normalizedMint,
          unit: receiveUnitFromRecord(current),
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
              admissionId: `wallet-receive:${requiredText(current.operation.result.resultFingerprint)}`,
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
          asset: { kind: 'sats', baseAsset: 'sat', unit: receiveUnitFromRecord(current) },
          nowMs: observedAtMs,
        })
      }
    })
  }

  async #loadRecord(custodyOperationId: string) {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(custodyOperationId)
      if (record === null) return null
      const exactAuthority = requiredAuthorityArtifact(record, store)
      const exactResult =
        record.operation.result.exactResult === null ? null : requiredResultArtifact(record, store)
      return { record, exactAuthority, exactResult }
    })
  }

  async #activePage() {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) => {
      const store = new DurableCustodySqliteStore(database)
      const cursor = store.getWalletReceiveRecoveryCursor(fence.scopeId)
      const page = store.listWalletReceiveActiveWorkPage(fence.scopeId, cursor)
      if (page.rows.length !== 0 || cursor === null) return page
      return store.listWalletReceiveActiveWorkPage(fence.scopeId)
    })
  }

  async #advanceRecoveryCursor(cursor: string | null): Promise<void> {
    const fence = this.#getFence()
    await withDurableCustodyUnitOfWork(this.#storage, fence, this.#now(), (database) => {
      new DurableCustodySqliteStore(database).setWalletReceiveRecoveryCursor(fence.scopeId, cursor)
    })
  }

  async #activeReceiveCount(): Promise<number> {
    const fence = this.#getFence()
    return withDurableCustodyFencedRead(this.#storage, fence, this.#now(), (database) =>
      new DurableCustodySqliteStore(database).countWalletReceiveActiveWork(fence.scopeId),
    )
  }

  #operationFromRecord(
    record: DurableCustodyRecord,
    exactAuthority: ReturnType<typeof requiredAuthorityArtifact>,
  ): DurableWalletReceiveOperation {
    const authority = assertDurableCustodyMintOperationAuthority(record, exactAuthority)
    const operation = requireDurableWalletOperationFromCustody(authority.operation)
    if (
      !isReceiveRecord(record) ||
      operation.operationId !== record.operation.retainedOperationKey ||
      operation.mintUrl !== record.operation.custodyContext.normalizedMint
    ) {
      throw new Error('daemon wallet receive authority is foreign')
    }
    if (operation.kind !== 'wallet-receive')
      throw new Error('daemon wallet receive kind is foreign')
    return operation
  }

  #verifiedProofs(
    record: DurableCustodyRecord,
    exactAuthority: ReturnType<typeof requiredAuthorityArtifact>,
    exactResult: ReturnType<typeof requiredResultArtifact> | null,
  ): Proof[] {
    return readDurableCustodyVerifiedMintResult({
      record,
      exactAuthority,
      exactResult:
        exactResult ??
        (() => {
          throw new Error('daemon wallet receive result artifact is missing')
        })(),
    }).proofs.map(({ proof }) => proof)
  }
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
    if (!isV2KeysetId(id)) throw new Error('daemon wallet receive supports only V2 keysets')
    const keyset = wallet.getKeyset?.(id) as unknown as {
      id: string
      unit?: string
      keys: Record<string, string> | Record<number, string>
      fee?: number
      expiry?: number
      conditional?: unknown
      verify?: () => boolean
    }
    if (
      !keyset ||
      keyset.id !== id ||
      keyset.unit !== operation.metadata?.unit ||
      keyset.verify?.() !== true ||
      keyset.conditional !== undefined
    ) {
      throw new Error('daemon wallet receive keyset is invalid')
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

function assertPersistedCounterRange(
  database: Parameters<typeof readExactBoundCounter>[0],
  scopeId: string,
  operation: DurableWalletReceiveOperation,
): void {
  const range = operation.derivationRange
  if (range === null) throw new Error('daemon wallet receive derivation range is missing')
  const next = readExactBoundCounter(database, scopeId, range.keysetId, {
    normalizedMint: operation.mintUrl,
    unit: receiveUnit(operation),
  })
  if (next < range.counterStart + range.counterCount)
    throw new Error('daemon wallet receive counter authority is incomplete')
}

function walletScope(fence: CustodyScopeFence): DurableCustodyScope {
  if (!fence.scopeId.startsWith('custody:wallet:'))
    throw new Error('daemon wallet receive scope is foreign')
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

function requiredAuthorityArtifact(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (row === null) throw new Error('daemon wallet receive private authority is missing')
  return row.artifact
}

function requiredResultArtifact(record: DurableCustodyRecord, store: DurableCustodySqliteStore) {
  const reference = record.operation.result.exactResult
  if (reference === null) throw new Error('daemon wallet receive result authority is missing')
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (row === null) throw new Error('daemon wallet receive result artifact is missing')
  return row.artifact
}

function requiredLoadedResult(input: {
  readonly exactResult: ReturnType<typeof requiredResultArtifact> | null
}): ReturnType<typeof requiredResultArtifact> {
  if (input.exactResult === null)
    throw new Error('daemon wallet receive result artifact is missing')
  return input.exactResult
}

function requiredRecord(
  store: DurableCustodySqliteStore,
  operationId: string,
): DurableCustodyRecord {
  const record = store.getOperation(operationId)
  if (record === null) throw new Error('daemon wallet receive operation is missing')
  return record
}

function receiveUnit(operation: DurableWalletReceiveOperation): 'sat' | 'msat' {
  if (operation.unit !== 'sat' && operation.unit !== 'msat')
    throw new Error('daemon wallet receive unit is invalid')
  return operation.unit
}

function receiveUnitFromRecord(record: DurableCustodyRecord): 'sat' | 'msat' {
  if (
    record.operation.custodyContext.unit !== 'sat' &&
    record.operation.custodyContext.unit !== 'msat'
  )
    throw new Error('daemon wallet receive unit is invalid')
  return record.operation.custodyContext.unit
}

function isReceiveRecord(record: DurableCustodyRecord): boolean {
  return (
    record.operation.semanticKind === 'generic-receive' &&
    record.operation.retainedOperationKey.startsWith('wallet-receive:')
  )
}

interface StoredReceiveOutput {
  blindedMessage: { amount: number; id: string; B_: string }
  blindingFactor: string
  secret: string
  ephemeralE?: string
}

function toLegacyStoredOutput(
  output: DurableWalletReceiveOperation['preview']['keepOutputs'][number],
): StoredReceiveOutput {
  return {
    blindedMessage: {
      ...output.blindedMessage,
      amount: amountToNumber(output.blindedMessage.amount),
    },
    blindingFactor: BigInt(output.blindingFactor).toString(16),
    secret: Buffer.from(output.secret, 'utf8').toString('hex'),
    ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
  }
}

function isV2KeysetId(id: unknown): id is string {
  return typeof id === 'string' && /^01[0-9a-f]{64}$/.test(id)
}

function requiredText(value: string | null): string {
  if (value === null || value.length === 0)
    throw new Error('daemon wallet receive result authority is incomplete')
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
