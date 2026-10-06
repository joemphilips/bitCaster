import { creditedProofAmountMsat, writeNativeCompletedActivity } from './nativeCompletedActivity.ts'
import { isDeepStrictEqual } from 'node:util'
import {
  CheckStateEnum,
  hashToCurve,
  Keyset,
  verifyProofsForReceive,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  assertDurableCustodyImmutableAuthorityMatches,
  applyDurableCustodyTransaction,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  applyDurableCustodyProofImport,
  bindDurableCustodyProofImport,
  DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX,
  prepareDurableCustodyProofImport,
  stageDurableCustodyProofImport,
  type DurableCustodyProofImportKeyset,
  type PreparedDurableCustodyProofImport,
} from '@bitcaster-market/client-sdk/durableCustodyProofImport'
import { serializeDurableCustodyProofArtifact } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import { canonicalizeTokenImportMintUrl } from '@bitcaster-market/client-sdk/tokenImportValidation'
import { createCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  WalletProofImportSqlite,
  encodeWalletProofImportSource,
  type WalletProofImportSource,
} from './walletProofImportSqlite.ts'
import {
  NativePaymentRequestReceiptSqlite,
  paymentRequestReceiptBinding,
  type NativePaymentRequestReceiptBinding,
} from './nativePaymentRequestReceiptSqlite.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import type { StateSqliteFaultPhase } from './stateSqlite.ts'
import {
  admitExactAvailableWalletProofsFromDatabase,
  assertAvailableWalletProofImportHasNoConflictsFromDatabase,
  type StoredProofAsset,
} from './state.ts'

type OutcomeAsset = Extract<StoredProofAsset, { kind: 'Outcome' }>
type VerifiedImportKeyset = DurableCustodyProofImportKeyset &
  Pick<DurableCustodyMintKeysetAuthority, 'inputFeePpk' | 'finalExpiry'>

/** Imports externally received CTF proofs into both wallet and custody authority. */
export class DurableWalletProofImportCoordinator {
  readonly #storage
  readonly #getFence: () => CustodyScopeFence
  readonly #now: () => number
  readonly #injectFault: ((phase: StateSqliteFaultPhase) => void) | undefined

  constructor(
    directory: string,
    getFence: () => CustodyScopeFence,
    now: () => number = Date.now,
    injectFault?: (phase: StateSqliteFaultPhase) => void,
  ) {
    this.#storage = createDaemonStateSqliteSession(directory)
    this.#getFence = getFence
    this.#now = now
    this.#injectFault = injectFault
  }

  async importOutcomeProofs(input: {
    readonly mintUrl: string
    readonly asset: OutcomeAsset
    readonly proofs: readonly Proof[]
    readonly keysets: readonly DurableCustodyMintKeysetAuthority[]
    readonly checkProofsStates: (
      proofs: readonly Pick<Proof, 'id' | 'secret'>[],
    ) => Promise<readonly ProofState[]>
  }): Promise<void> {
    if (input.proofs.length === 0) throw new Error('cashu outcome token did not include proofs')
    if (input.mintUrl !== canonicalizeTokenImportMintUrl(input.mintUrl, true))
      throw new Error('wallet proof import mint identity is not canonical')
    if (
      input.proofs.length > DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX ||
      input.keysets.length > 256
    )
      throw new Error('wallet proof import source exceeds bounds')
    const scope = walletScope(this.#getFence())
    const source = createOutcomeImportSource(
      scope,
      input.mintUrl,
      input.asset,
      input.proofs,
      input.keysets,
    )
    const existing = await this.#read((database) =>
      new WalletProofImportSqlite(database).load(scope.scopeId, source.rootId),
    )
    if (existing !== null) {
      // A new user action must still respect an explicit removal.
      await this.#read((database) => {
        for (const proof of source.proofs) {
          if (
            database
              .prepare(
                `SELECT 1 FROM target_wallet_proofs WHERE scope_id = ? AND normalized_mint = ? AND secret = ? AND retired_at_ms IS NOT NULL`,
              )
              .get(scope.scopeId, source.mintUrl, proof.secret) !== undefined
          )
            throw new Error('cashu outcome proof conflicts with retired wallet custody')
        }
      })
      await this.#resume(existing, input.checkProofsStates, 2048)
      return
    }
    const { keysets, pages } = this.#prepare(source)
    verifyProofSignatures(source.proofs, keysets)
    await requireUnspentProofs(source.proofs, input.checkProofsStates)

    await this.#preflightLocalConflicts(scope, input.mintUrl, input.asset, source.proofs, pages)
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#getFence(),
      this.#now(),
      (database) => {
        new WalletProofImportSqlite(database).save(
          source,
          pages.map(({ prepared }) => prepared.record.operation.operationId),
        )
      },
      this.#transactionOptions(),
    )
    await this.#resume(source, input.checkProofsStates, 2048)
  }

  async receivePaymentRequest(input: {
    readonly receipt: NativePaymentRequestReceiptBinding
    readonly mintUrl: string
    readonly groups: readonly {
      readonly asset: OutcomeAsset
      readonly proofs: readonly Proof[]
      readonly keysets: readonly DurableCustodyMintKeysetAuthority[]
    }[]
    readonly checkProofsStates: (
      proofs: readonly Pick<Proof, 'id' | 'secret'>[],
    ) => Promise<readonly ProofState[]>
  }): Promise<void> {
    const scope = walletScope(this.#getFence())
    if (
      scope.scopeId !== input.receipt.scopeId ||
      input.groups.length < 1 ||
      input.groups.length > 16
    )
      throw new Error('payment request import scope or group count is invalid')
    const existing = await this.#read((database) =>
      new NativePaymentRequestReceiptSqlite(database).assertCandidate(input.receipt),
    )
    if (existing !== null) {
      await this.recoverPaymentRequest(input.receipt.requestId, input.checkProofsStates)
      return
    }
    const sources = input.groups.map((group) =>
      createOutcomeImportSource(scope, input.mintUrl, group.asset, group.proofs, group.keysets),
    )
    if (
      sources.reduce((bytes, source) => bytes + encodeWalletProofImportSource(source).length, 0) >
      16 * 1024 * 1024
    )
      throw new Error('payment request conditional source exceeds artifact bound')
    const plans = sources.map((source) => ({ source, ...this.#prepare(source) }))
    for (const { source, keysets, pages } of plans) {
      verifyProofSignatures(source.proofs, keysets)
      await requireUnspentProofs(source.proofs, input.checkProofsStates)
      await this.#preflightLocalConflicts(scope, source.mintUrl, source.asset, source.proofs, pages)
    }
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#getFence(),
      this.#now(),
      (database) => {
        const imports = new WalletProofImportSqlite(database)
        for (const { source, pages } of plans) {
          const operationIds = pages.map(({ prepared }) => prepared.record.operation.operationId)
          if (imports.load(source.scopeId, source.rootId) === null)
            imports.save(source, operationIds)
          else imports.assertPages(source, operationIds)
        }
        new NativePaymentRequestReceiptSqlite(database).bindConditional(input.receipt, sources)
      },
      this.#transactionOptions(),
    )
    for (const source of sources) await this.#resume(source, input.checkProofsStates, 2048)
  }

  async recoverPaymentRequest(
    requestId: string,
    checkProofsStates: (
      proofs: readonly Pick<Proof, 'id' | 'secret'>[],
    ) => Promise<readonly ProofState[]>,
  ): Promise<void> {
    const sources = await this.#paymentRequestSources(requestId)
    for (const source of sources)
      await this.#resume(source, checkProofsStates, Math.floor(256 / sources.length))
  }

  async paymentRequestApplied(requestId: string): Promise<boolean> {
    const sources = await this.#paymentRequestSources(requestId)
    for (const source of sources) {
      const { pages } = this.#prepare(source)
      await this.#read((database) =>
        new WalletProofImportSqlite(database).assertPages(
          source,
          pages.map(({ prepared }) => prepared.record.operation.operationId),
        ),
      )
      for (const [index, { prepared, proofs }] of pages.entries()) {
        if (!(await this.#isAppliedPage(source, prepared, index))) return false
        await this.#apply(prepared, source.mintUrl, source.asset, proofs, source.fingerprint, true)
      }
    }
    return true
  }

  #paymentRequestSources(requestId: string): Promise<readonly WalletProofImportSource[]> {
    const scopeId = this.#getFence().scopeId
    return this.#read((database) => {
      const receipts = new NativePaymentRequestReceiptSqlite(database)
      const sources = receipts.assertGroups(scopeId, requestId).map((rootId) => {
        const source = new WalletProofImportSqlite(database).load(scopeId, rootId)
        if (source === null) throw new Error('payment request import source is missing')
        return source
      })
      const request = receipts.getRequest(scopeId, requestId)
      if (request === null) throw new Error('payment request is missing')
      receipts.assertCandidate(
        paymentRequestReceiptBinding({
          scopeId,
          requestId,
          mintUrl: request.mintUrl,
          proofs: sources.flatMap((source) => [...source.proofs]),
        }),
      )
      return sources
    })
  }

  #prepare(source: WalletProofImportSource) {
    const scope = walletScope(this.#getFence())
    if (scope.scopeId !== source.scopeId) throw new Error('wallet proof import scope is foreign')
    if (source.mintUrl !== canonicalizeTokenImportMintUrl(source.mintUrl, true))
      throw new Error('wallet proof import mint identity is not canonical')
    const orderedProofs = orderUniqueProofs(source.proofs, scope.scopeId, source.mintUrl)
    const proofSetFingerprint = deriveDurableCustodyArtifactFingerprint({
      kind: 'wallet-outcome-proof-import-v1',
      scopeId: scope.scopeId,
      normalizedMint: source.mintUrl,
      asset: source.asset,
      proofs: orderedProofs.map(({ proof }) => serializeDurableCustodyProofArtifact(proof)),
    })
    if (
      source.fingerprint !== proofSetFingerprint ||
      source.rootId !== `wallet-outcome-proof-import:${proofSetFingerprint}`
    )
      throw new Error('wallet proof import source authority is inconsistent')
    const rootSourceOperationId = source.rootId
    const keysets = importKeysets(source.keysets, source.mintUrl, source.asset)
    const pageCount = Math.ceil(
      orderedProofs.length / DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    )
    const pages: Array<{
      readonly prepared: PreparedDurableCustodyProofImport
      readonly proofs: readonly Proof[]
    }> = []
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const page = orderedProofs.slice(
        pageIndex * DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
        (pageIndex + 1) * DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
      )
      const sourceOperationId = `wallet-outcome-proof-import:${deriveDurableCustodyArtifactFingerprint(
        { rootSourceOperationId, pageIndex },
      )}`
      const pageKeysetIds = new Set(page.map(({ proof }) => proof.id))
      const prepared = prepareDurableCustodyProofImport({
        scope,
        sourceOperationId,
        normalizedMint: source.mintUrl,
        unit: source.asset.unit,
        inventoryAccountId: null,
        keysets: keysets.filter((keyset) => pageKeysetIds.has(keyset.keysetId)),
        proofs: page.map(({ proof }) => proof),
        inventoryAuthorityFingerprint: proofSetFingerprint,
        batchAuthority: {
          rootSourceOperationId,
          proofSetFingerprint,
          proofCount: orderedProofs.length,
          pageCount,
          pageIndex,
        },
      })
      pages.push({ prepared, proofs: page.map(({ proof }) => proof) })
    }

    return { keysets, pages }
  }

  async #resume(
    source: WalletProofImportSource,
    checkProofsStates: Parameters<
      DurableWalletProofImportCoordinator['importOutcomeProofs']
    >[0]['checkProofsStates'],
    pageLimit = 256,
  ): Promise<boolean> {
    const { keysets, pages } = this.#prepare(source)
    await this.#read((database) =>
      new WalletProofImportSqlite(database).assertPages(
        source,
        pages.map(({ prepared }) => prepared.record.operation.operationId),
      ),
    )
    let processed = 0
    for (const [pageIndex, { prepared, proofs }] of pages.entries()) {
      const applied = await this.#isAppliedPage(source, prepared, pageIndex)
      if (!applied) {
        if (processed >= pageLimit) return false
        verifyProofSignatures(proofs, keysets)
        await requireUnspentProofs(proofs, checkProofsStates)
        await this.#preflightLocalConflicts(
          prepared.record.scope,
          source.mintUrl,
          source.asset,
          proofs,
          [{ prepared, proofs }],
        )
        await this.#bind(prepared, source.rootId, pageIndex)
        processed += 1
      }
      if (!applied) await this.#stage(prepared)
      await this.#apply(prepared, source.mintUrl, source.asset, proofs, source.fingerprint, applied)
    }
    const completedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      this.#getFence(),
      completedAtMs,
      (database) => {
        if (!new WalletProofImportSqlite(database).complete(source.scopeId, source.rootId)) return
        writeNativeCompletedActivity(database, {
          scopeId: source.scopeId,
          sourceKind: 'outcome-import',
          sourceId: source.rootId,
          type: 'deposit',
          amountMsat: creditedProofAmountMsat(source.proofs, source.asset.unit),
          completedAtMs,
          txId: source.rootId,
        })
      },
      this.#transactionOptions(),
    )
    return true
  }

  #isAppliedPage(
    source: WalletProofImportSource,
    prepared: PreparedDurableCustodyProofImport,
    pageIndex: number,
  ): Promise<boolean> {
    return this.#read((database) => {
      const operation = new DurableCustodySqliteStore(database).getOperation(
        prepared.record.operation.operationId,
      )
      const link = database
        .prepare(
          `SELECT bound_operation_id FROM wallet_proof_import_pages WHERE scope_id = ? AND root_id = ? AND page_index = ?`,
        )
        .get(source.scopeId, source.rootId, pageIndex)
      if (operation !== null) {
        if (link?.bound_operation_id !== operation.operation.operationId)
          throw new Error('wallet proof import page operation link is missing')
        assertDurableCustodyImmutableAuthorityMatches(operation, prepared.record)
      } else if (link?.bound_operation_id !== null)
        throw new Error('wallet proof import page operation is missing')
      return operation?.operation.result.state === 'applied'
    })
  }

  async recover(input: {
    readonly checkProofsStates: (
      mintUrl: string,
      asset: OutcomeAsset,
      proofs: readonly Pick<Proof, 'id' | 'secret'>[],
    ) => Promise<readonly ProofState[]>
  }) {
    const scopeId = this.#getFence().scopeId
    const roots = await this.#read((database) => {
      const cursor =
        database
          .prepare(`SELECT root_id FROM wallet_proof_import_recovery_cursors WHERE scope_id = ?`)
          .get(scopeId)?.root_id ?? ''
      const rows = database
        .prepare(
          `SELECT root_id FROM wallet_proof_import_roots WHERE scope_id = ? AND state = 'active' AND root_id > ? ORDER BY root_id LIMIT 2`,
        )
        .all(scopeId, cursor)
      return rows.length > 0
        ? rows
        : database
            .prepare(
              `SELECT root_id FROM wallet_proof_import_roots WHERE scope_id = ? AND state = 'active' ORDER BY root_id LIMIT 2`,
            )
            .all(scopeId)
    })
    const recovered: string[] = []
    const pending: Array<{ operationId: string; error: string }> = []
    let unfinished = false
    for (const row of roots.slice(0, 1)) {
      const rootId = String(row.root_id)
      try {
        const source = await this.#read((database) =>
          new WalletProofImportSqlite(database).load(scopeId, rootId),
        )
        if (source === null) throw new Error('wallet proof import source is missing')
        if (
          await this.#resume(source, (proofs) =>
            input.checkProofsStates(source.mintUrl, source.asset, proofs),
          )
        )
          recovered.push(rootId)
        else unfinished = true
      } catch {
        pending.push({
          operationId: rootId,
          error: 'conditional proof import recovery remains pending',
        })
      }
    }
    await withDurableCustodyUnitOfWork(this.#storage, this.#getFence(), this.#now(), (database) =>
      database
        .prepare(
          `INSERT INTO wallet_proof_import_recovery_cursors VALUES (?, ?) ON CONFLICT(scope_id) DO UPDATE SET root_id = excluded.root_id`,
        )
        .run(scopeId, roots.length > 1 ? roots[0]!.root_id : null),
    )
    const remaining = await this.#read((database) =>
      database
        .prepare(
          `SELECT count(*) AS count FROM wallet_proof_import_roots WHERE scope_id = ? AND state = 'active'`,
        )
        .get(scopeId),
    )
    return {
      recovered,
      recoveredCount: recovered.length,
      pending,
      pendingCount: Number(remaining?.count),
      hasMore: roots.length > 1 || unfinished,
    }
  }

  #read<T>(read: (database: import('node:sqlite').DatabaseSync) => T): Promise<T> {
    return withDurableCustodyFencedRead(this.#storage, this.#getFence(), this.#now(), read)
  }

  async #preflightLocalConflicts(
    scope: DurableCustodyScope,
    mintUrl: string,
    asset: OutcomeAsset,
    orderedProofs: readonly Proof[],
    pages: readonly {
      readonly prepared: PreparedDurableCustodyProofImport
      readonly proofs: readonly Proof[]
    }[],
  ): Promise<void> {
    const fence = this.#getFence()
    if (walletScope(fence).scopeId !== scope.scopeId) {
      throw new Error('wallet proof import scope changed before local preflight')
    }
    const observedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(this.#storage, fence, observedAtMs, (database) => {
      assertAvailableWalletProofImportHasNoConflictsFromDatabase(database, {
        mintUrl,
        proofs: orderedProofs.map(toCashuProofRecord),
        asset,
      })

      const custody = new DurableCustodySqliteStore(database)
      for (const { prepared, proofs } of pages) {
        const operation = custody.getOperation(prepared.record.operation.operationId)
        if (operation !== null) {
          try {
            assertDurableCustodyImmutableAuthorityMatches(operation, prepared.record)
          } catch {
            throw new Error('cashu outcome proof import conflicts with local custody authority')
          }
        }
        for (const proof of proofs) {
          const proofId = deriveDurableCustodyProofId({
            scopeId: scope.scopeId,
            normalizedMint: mintUrl,
            unit: asset.unit,
            keysetId: proof.id!,
            secret: proof.secret,
          })
          const existing = custody.getProof(scope.scopeId, proofId)
          if (existing === null) continue
          if (operation === null) {
            throw new Error('cashu outcome proof conflicts with local canonical custody')
          }
          const expected = importedOutcomeProofRow({
            scopeId: scope.scopeId,
            mintUrl,
            asset,
            proof,
            storageClass: prepared.record.operation.proofStorage.storageClass,
            nowMs: 0,
          })
          if (!importedProofRowsEqual(existing, expected)) {
            throw new Error('cashu outcome proof conflicts with local canonical custody')
          }
        }
      }
    })
  }

  async #bind(
    prepared: PreparedDurableCustodyProofImport,
    rootId: string,
    pageIndex: number,
  ): Promise<void> {
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      fence,
      observedAtMs,
      (database) => {
        const store = new DurableCustodySqliteStore(database)
        const current = store.getOperation(prepared.record.operation.operationId)
        const expectedRevision = current?.revision ?? null
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(database, fence.scopeId, observedAtMs),
          selection(
            prepared.record.scope,
            prepared.record.operation.operationId,
            fence,
            observedAtMs,
            expectedRevision,
          ),
          (transaction) => bindDurableCustodyProofImport({ transaction, prepared }),
        )
        new WalletProofImportSqlite(database).bindPage(
          fence.scopeId,
          rootId,
          pageIndex,
          prepared.record.operation.operationId,
        )
      },
      this.#transactionOptions(),
    )
  }

  async #stage(prepared: PreparedDurableCustodyProofImport): Promise<void> {
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      fence,
      observedAtMs,
      (database) => {
        const current = new DurableCustodySqliteStore(database).getOperation(
          prepared.record.operation.operationId,
        )
        if (current === null) throw new Error('wallet proof import custody operation is missing')
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(database, fence.scopeId, observedAtMs, [current]),
          selection(
            current.scope,
            current.operation.operationId,
            fence,
            observedAtMs,
            current.revision,
          ),
          (transaction) =>
            stageDurableCustodyProofImport({
              transaction,
              prepared,
              authorization: owner(fence, observedAtMs),
            }),
        )
      },
      this.#transactionOptions(),
    )
  }

  async #apply(
    prepared: PreparedDurableCustodyProofImport,
    mintUrl: string,
    asset: OutcomeAsset,
    proofs: readonly Proof[],
    proofSetFingerprint: string,
    appliedReplay: boolean,
  ): Promise<void> {
    const fence = this.#getFence()
    const observedAtMs = this.#now()
    const readOrWrite = appliedReplay ? withDurableCustodyFencedRead : withDurableCustodyUnitOfWork
    await readOrWrite(
      this.#storage,
      fence,
      observedAtMs,
      (database) => {
        const current = new DurableCustodySqliteStore(database).getOperation(
          prepared.record.operation.operationId,
        )
        if (current === null) throw new Error('wallet proof import custody operation is missing')
        if (appliedReplay && current.operation.result.state !== 'applied')
          throw new Error('wallet proof import applied lineage is missing')
        const transaction = new DurableCustodyTransactionSqlite(
          database,
          fence.scopeId,
          observedAtMs,
          [current],
        )
        if (
          current.operation.result.state === 'verified-staged' &&
          proofs.some((proof) => proof.dleq == null)
        ) {
          throw new Error('cashu outcome proof DLEQ material is missing after verification')
        }
        const successorRows =
          current.operation.result.state === 'verified-staged'
            ? proofs.map((proof) => ({
                proof: importedOutcomeProofRow({
                  scopeId: fence.scopeId,
                  mintUrl,
                  asset,
                  proof,
                  storageClass: current.operation.proofStorage.storageClass,
                  nowMs: observedAtMs,
                }),
                expectedRevision: null,
              }))
            : []
        if (successorRows.length > 0) {
          transaction.stageSuccessorProofCas(current.operation.operationId, successorRows)
        }
        applyDurableCustodyTransaction(
          transaction,
          selection(
            current.scope,
            current.operation.operationId,
            fence,
            observedAtMs,
            current.revision,
          ),
          (selected) => {
            applyDurableCustodyProofImport({
              transaction: selected,
              prepared,
              authorization: owner(fence, observedAtMs),
              inventoryAuthorityFingerprint: proofSetFingerprint,
              successorAdmission: {
                scopeId: fence.scopeId,
                operationId: current.operation.operationId,
                admissionId: `proof-import:${current.operation.operationId}`,
                proofRows: prepared.successorProofIds.map((proofId) => ({
                  proofId,
                  expectedRevision: null,
                  admittedRevision: 0,
                })),
              },
            })
            if (current.operation.result.state === 'verified-staged')
              admitExactAvailableWalletProofsFromDatabase(database, {
                mintUrl,
                proofs: proofs.map(toCashuProofRecord),
                asset,
                nowMs: observedAtMs,
              })
          },
        )
        if (current.operation.result.state === 'verified-staged')
          transaction.rebuildActiveWorkIndex({
            scopeId: fence.scopeId,
            operationRows: [
              {
                operationId: current.operation.operationId,
                expectedRevision: current.revision + 1,
              },
            ],
          })
      },
      this.#transactionOptions(),
    )
  }

  #transactionOptions() {
    return this.#injectFault === undefined ? {} : { injectFault: this.#injectFault }
  }
}

function importedOutcomeProofRow(input: {
  readonly scopeId: string
  readonly mintUrl: string
  readonly asset: OutcomeAsset
  readonly proof: Proof
  readonly storageClass: CustodyProofSqliteRow['storageClass']
  readonly nowMs: number
}) {
  return createCustodyProofSqliteRow({
    scopeId: input.scopeId,
    normalizedMint: input.mintUrl,
    unit: input.asset.unit,
    proof: {
      ...input.proof,
      dleq: input.proof.dleq ?? null,
      witness: input.proof.witness ?? null,
      p2pkE: input.proof.p2pk_e ?? null,
    },
    baseAsset: input.asset.baseAsset,
    conditionId: input.asset.conditionId,
    outcomeSetId: input.asset.outcomeSetId,
    productBinding: null,
    signatureVerified: true,
    dleqState: 'verified',
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: input.storageClass,
    reservationOperationId: null,
    revision: 0,
    nowMs: input.nowMs,
  })
}

function importedProofRowsEqual(
  left: ReturnType<typeof createCustodyProofSqliteRow>,
  right: ReturnType<typeof createCustodyProofSqliteRow>,
): boolean {
  const authority = (row: ReturnType<typeof createCustodyProofSqliteRow>) => ({
    proofId: row.proofId,
    scopeId: row.scopeId,
    normalizedMint: row.normalizedMint,
    unit: row.unit,
    keysetId: row.keysetId,
    amount: row.amount,
    baseAsset: row.baseAsset,
    conditionId: row.conditionId,
    outcomeSetId: row.outcomeSetId,
    productBinding: row.productBinding,
    proofBody: Buffer.from(row.proofBody).toString('hex'),
    proofFingerprint: row.proofFingerprint,
    curve: row.curve,
    signatureVerified: row.signatureVerified,
    dleqState: row.dleqState,
    nut07State: row.nut07State,
    selectability: row.selectability,
    storageClass: row.storageClass,
    reservationOperationId: row.reservationOperationId,
    revision: row.revision,
  })
  return isDeepStrictEqual(authority(left), authority(right))
}

function orderUniqueProofs(
  proofs: readonly Proof[],
  scopeId: string,
  mintUrl: string,
): Array<{ readonly proof: Proof; readonly proofId: string }> {
  const ordered = proofs
    .map((proof) => {
      if (typeof proof.id !== 'string' || proof.id.length === 0) {
        throw new Error('cashu outcome proof keyset id is invalid')
      }
      return {
        proof,
        proofId: deriveDurableCustodyProofId({
          scopeId,
          normalizedMint: mintUrl,
          unit: 'msat',
          keysetId: proof.id,
          secret: proof.secret,
        }),
      }
    })
    .sort((left, right) => left.proofId.localeCompare(right.proofId))
  if (new Set(ordered.map(({ proofId }) => proofId)).size !== ordered.length) {
    throw new Error('cashu outcome token contains duplicate proofs')
  }
  return ordered
}

function createOutcomeImportSource(
  scope: DurableCustodyScope,
  mintUrl: string,
  asset: OutcomeAsset,
  proofs: readonly Proof[],
  keysets: readonly DurableCustodyMintKeysetAuthority[],
): WalletProofImportSource {
  if (
    proofs.length < 1 ||
    proofs.length > DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX ||
    keysets.length < 1 ||
    keysets.length > 256
  )
    throw new Error('wallet proof import source exceeds bounds')
  const ordered = orderUniqueProofs(proofs, scope.scopeId, mintUrl).map(({ proof }) => proof)
  const fingerprint = deriveDurableCustodyArtifactFingerprint({
    kind: 'wallet-outcome-proof-import-v1',
    scopeId: scope.scopeId,
    normalizedMint: mintUrl,
    asset,
    proofs: ordered.map(serializeDurableCustodyProofArtifact),
  })
  return {
    rootId: `wallet-outcome-proof-import:${fingerprint}`,
    scopeId: scope.scopeId,
    mintUrl,
    asset,
    proofs: ordered,
    keysets,
    fingerprint,
  }
}

function importKeysets(
  authorities: readonly DurableCustodyMintKeysetAuthority[],
  mintUrl: string,
  asset: OutcomeAsset,
): VerifiedImportKeyset[] {
  const keysets = authorities.map((keyset) => {
    const mintKeyset = {
      id: keyset.id,
      unit: keyset.unit,
      keys: { ...keyset.keys },
      input_fee_ppk: keyset.inputFeePpk,
      ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
    }
    if (
      keyset.canonicalMintUrl !== mintUrl ||
      keyset.unit !== asset.unit ||
      keyset.identity.kind !== 'conditional' ||
      keyset.identity.conditionId !== asset.conditionId ||
      keyset.identity.outcomeCollection !== asset.outcomeSetId
    ) {
      throw new Error('cashu outcome proof keyset is foreign to the requested asset')
    }
    if (
      !Keyset.verifyConditionalKeysetId(mintKeyset, {
        conditionId: keyset.identity.conditionId,
        outcomeCollection: keyset.identity.outcomeCollection,
        outcomeCollectionId: keyset.identity.outcomeCollectionId,
      })
    ) {
      throw new Error('cashu outcome proof keyset identity is inconsistent')
    }
    return {
      keysetId: keyset.id,
      unit: keyset.unit,
      curve: 'secp256k1' as const,
      publicKeys: keyset.keys,
      keysetExpiryMs: keyset.finalExpiry,
      requireDleq: true,
      inputFeePpk: keyset.inputFeePpk,
      finalExpiry: keyset.finalExpiry,
    }
  })
  if (new Set(keysets.map((keyset) => keyset.keysetId)).size !== keysets.length) {
    throw new Error('cashu outcome proof keyset authority is duplicated')
  }
  return keysets
}

function verifyProofSignatures(
  proofs: readonly Proof[],
  keysets: readonly VerifiedImportKeyset[],
): void {
  const byId = new Map(keysets.map((keyset) => [keyset.keysetId, keyset]))
  try {
    verifyProofsForReceive(
      [...proofs],
      (keysetId) => {
        const keyset = byId.get(keysetId)
        if (keyset === undefined) throw new Error('proof keyset is missing')
        return {
          id: keyset.keysetId,
          unit: keyset.unit,
          keys: keyset.publicKeys,
          input_fee_ppk: keyset.inputFeePpk,
          ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
        }
      },
      { requireDleq: true },
    )
  } catch (error) {
    throw new Error('cashu outcome proof cryptographic verification failed', { cause: error })
  }
}

async function requireUnspentProofs(
  proofs: readonly Proof[],
  checkProofsStates: (
    proofs: readonly Pick<Proof, 'id' | 'secret'>[],
  ) => Promise<readonly ProofState[]>,
): Promise<void> {
  const states = await checkProofsStates(proofs)
  if (states.length !== proofs.length) {
    throw new Error('cashu outcome proof state response count is invalid')
  }
  const expected = new Set(
    proofs.map((proof) => hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true)),
  )
  for (const state of states) {
    if (!expected.delete(state.Y)) throw new Error('cashu outcome proof state response is foreign')
    if (state.state !== CheckStateEnum.UNSPENT) {
      throw new Error(`cashu outcome proof is not spendable: ${state.state}`)
    }
  }
  if (expected.size !== 0) throw new Error('cashu outcome proof state response is incomplete')
}

function toCashuProofRecord(proof: Proof) {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    ...(proof.witness === undefined ? {} : { witness: proof.witness }),
    ...(proof.dleq === undefined ? {} : { dleq: proof.dleq }),
    ...(proof.p2pk_e === undefined ? {} : { p2pk_e: proof.p2pk_e }),
  }
}

function walletScope(fence: CustodyScopeFence): DurableCustodyScope {
  if (!fence.scopeId.startsWith('custody:wallet:')) {
    throw new Error('wallet proof import scope is foreign')
  }
  return {
    scopeKind: 'wallet',
    scopeId: fence.scopeId,
    walletId: fence.scopeId.slice('custody:wallet:'.length),
  }
}

function selection(
  scope: DurableCustodyScope,
  operationId: string,
  fence: CustodyScopeFence,
  observedAtMs: number,
  expectedRevision: number | null,
) {
  return {
    scope,
    owner: owner(fence, observedAtMs),
    operationRows: [{ operationId, expectedRevision }],
  }
}

function owner(fence: CustodyScopeFence, observedAtMs: number): DurableCustodyOwnerAuthorization {
  return { incarnationId: fence.incarnationId, fencingEpoch: fence.fencingEpoch, observedAtMs }
}
