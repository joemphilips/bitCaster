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
  prepareDurableCustodyProofImport,
  stageDurableCustodyProofImport,
  type DurableCustodyProofImportKeyset,
  type PreparedDurableCustodyProofImport,
} from '@bitcaster-market/client-sdk/durableCustodyProofImport'
import { serializeDurableCustodyProofArtifact } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import { createCustodyProofSqliteRow } from './custodyProofSqliteRow.ts'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import { withDurableCustodyUnitOfWork } from './durableCustodyUnitOfWork.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
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
    const scope = walletScope(this.#getFence())
    const orderedProofs = orderUniqueProofs(input.proofs, scope.scopeId, input.mintUrl)
    const proofSetFingerprint = deriveDurableCustodyArtifactFingerprint({
      kind: 'wallet-outcome-proof-import-v1',
      scopeId: scope.scopeId,
      normalizedMint: input.mintUrl,
      asset: input.asset,
      proofs: orderedProofs.map(({ proof }) => serializeDurableCustodyProofArtifact(proof)),
    })
    const rootSourceOperationId = `wallet-outcome-proof-import:${proofSetFingerprint}`
    const keysets = importKeysets(input.keysets, input.mintUrl, input.asset)
    verifyProofSignatures(
      orderedProofs.map(({ proof }) => proof),
      keysets,
    )
    await requireUnspentProofs(
      orderedProofs.map(({ proof }) => proof),
      input.checkProofsStates,
    )

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
        normalizedMint: input.mintUrl,
        unit: input.asset.unit,
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

    await this.#preflightLocalConflicts(scope, input.mintUrl, input.asset, orderedProofs, pages)

    for (const { prepared, proofs } of pages) {
      await this.#bind(prepared)
      await this.#stage(prepared)
      await this.#apply(prepared, input.mintUrl, input.asset, proofs, proofSetFingerprint)
    }
  }

  async #preflightLocalConflicts(
    scope: DurableCustodyScope,
    mintUrl: string,
    asset: OutcomeAsset,
    orderedProofs: readonly { readonly proof: Proof; readonly proofId: string }[],
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
        proofs: orderedProofs.map(({ proof }) => toCashuProofRecord(proof)),
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

  async #bind(prepared: PreparedDurableCustodyProofImport): Promise<void> {
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
  ): Promise<void> {
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
            admitExactAvailableWalletProofsFromDatabase(database, {
              mintUrl,
              proofs: proofs.map(toCashuProofRecord),
              asset,
              nowMs: observedAtMs,
            })
          },
        )
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
