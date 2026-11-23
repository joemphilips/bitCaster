import type { Proof, MintKeys } from '@cashu/cashu-ts'
import type { DatabaseSync } from 'node:sqlite'
import {
  getActiveRegularKeyset,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import {
  deserializeOutputGroups,
  type CtfProofOperationCompletion,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  applyDurableCustodyTransaction,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  prepareDurableCustodyAuthenticatedTerminalMintRejection,
  reconcileDurableCustodyAuthenticatedTerminalMintRejection,
  readDurableCustodyVerifiedLosingMintRejection,
  type DurableCustodyMintKeysetAuthority,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { createDurableCustodyProofMaterialRecord } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import {
  serializeDurableCustodyProofInput,
  serializeDurableCustodyOutput,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import { createCustodyProofSqliteRowFromMaterial } from './custodyProofSqliteRow.ts'
import { withDurableCustodyUnitOfWork } from './durableCustodyUnitOfWork.ts'
import { profileDir } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { createSpeculativeRedeemPreparation } from './speculativeRedeemPreparation.ts'
import {
  assertPreparedProofOperationDispatchFenced,
  prepareProofOperationWithExactReservation,
  readProofOperationFenced,
  type ExactProofOperationAuthority,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'
import { createWallet, type WalletOpsDependencies, type WalletOpsSecrets } from './walletOps.ts'

/** The owner of a redeem: its fence and its wallet dependencies. */
export interface CustodyRedeemContext {
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
}

export interface CustodyRedeemMutation {
  readonly fence: CustodyScopeFence
  readonly observedAtMs: number
}

/** The exact custody authority of a redeem target. Its successor is the regular payout. */
export type CustodyRedeemAuthority = ExactProofOperationAuthority

/**
 * The parts of a custody-backed redeem that a claim and a retirement own
 * separately: the target writers, the custody lookup and the fixed text.
 */
export interface CustodyRedeemPurpose {
  /** The words that start each refusal message. */
  readonly label: string
  readonly observeStage: Parameters<NonNullable<WalletOpsDependencies['observeRedeemPrepared']>>[0]
  /** The prefix of the custody successor admission id. */
  readonly admissionPrefix: string
  readonly authority: CustodyRedeemAuthority
  /** Refuse a saved target that this purpose does not own. */
  assertTarget(operation: ProofOperationRecord): void
  /** Read the custody operation of a target in the caller's transaction. */
  readCustody(
    database: DatabaseSync,
    fence: Pick<CustodyScopeFence, 'scopeId'>,
    target: ProofOperationRecord,
  ): {
    readonly store: DurableCustodySqliteStore
    readonly record: DurableCustodyRecord
    readonly exactAuthority: DurableCustodyExactArtifact
  }
  /** Record how a new target finds its custody operation, in the binding transaction. */
  linkCustody(
    database: DatabaseSync,
    scopeId: string,
    targetOperationId: string,
    custodyOperationId: string,
  ): void
  completeTarget(
    database: DatabaseSync,
    operationId: string,
    completion: CtfProofOperationCompletion,
    nowMs: number,
  ): ProofOperationRecord
  /** Write the facts that follow a completed payout, in the completion transaction. */
  afterComplete(
    database: DatabaseSync,
    completed: {
      readonly operationId: string
      readonly regular: Proof[]
      readonly context: CustodyRedeemMutation
    },
  ): void
  failTarget(
    database: DatabaseSync,
    operationId: string,
    message: string,
    evidence: AuthenticatedCtfRedeemTerminalEvidence,
    nowMs: number,
  ): ProofOperationRecord
}

/**
 * The proof operation store of one custody-backed redeem. One fenced
 * transaction saves the target operation, reserves its exact wallet rows and
 * binds the custody operation. The completion admits the payout to custody,
 * spends the inputs and completes the target in one transaction. A losing
 * result retains the inputs in both stores.
 */
export function createCustodyRedeemOperationStore(
  input: CustodyRedeemContext,
  operationId: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  wallet: RedeemWallet,
  preparation: ReturnType<typeof createSpeculativeRedeemPreparation>,
  purpose: CustodyRedeemPurpose,
): CtfProofOperationStore {
  const authority = purpose.authority
  return {
    getProofOperation: async (id) => {
      const operation = await readProofOperationFenced(id, mutation(input))
      if (operation === null) return null
      purpose.assertTarget(operation)
      await custodyRedeemUnitOfWork(input, (database, context) => {
        const { record, store } = purpose.readCustody(database, context.fence, operation)
        if (operation.state === 'prepared') {
          new DurableCustodyTransactionSqlite(
            database,
            context.fence.scopeId,
            context.observedAtMs,
          ).reserveExactInputs({
            operationId: record.operation.operationId,
            expectedRevision: record.revision,
            reservationId: operationId,
            proofIds: record.operation.reservation.inputs.map(({ proofId }) => proofId),
          })
        } else if (operation.state === 'Failed' && operation.failureCode === 13015) {
          const reference = record.operation.terminalMintRejection?.exactRejection
          if (reference === undefined)
            throw new Error(`${purpose.label} terminal authority is absent`)
          const artifact = store.getArtifact({
            scopeId: record.scope.scopeId,
            operationId: record.operation.operationId,
            expectedOperationRevision: record.revision,
            reference,
          })
          if (artifact === null) throw new Error(`${purpose.label} terminal artifact is absent`)
          readDurableCustodyVerifiedLosingMintRejection({
            record,
            exactRejection: artifact.artifact,
            exactAuthority: purpose.readCustody(database, context.fence, operation).exactAuthority,
          })
        }
      })
      if (operation.state === 'prepared')
        await assertPreparedProofOperationDispatchFenced(id, authority, mutation(input))
      return operation as CtfProofOperationRecord
    },
    prepareProofOperation: async (operation) => {
      const keysets = await custodyRedeemKeysets(operation, asset, wallet, purpose.label)
      await input.walletDependencies?.observeRedeemPrepared?.(
        purpose.observeStage,
        structuredClone(operation),
      )
      const context = mutation(input)
      const prepared = await prepareProofOperationWithExactReservation(
        {
          ...operation,
          reservationId: operationId,
          asset,
          metadata: { ...operation.metadata, ...authority },
        },
        context,
        (database, target) => {
          const mintAuthority = prepareDurableCustodyMintOperationAuthority({
            operation: custodyRedeemMintOperation(target, asset, purpose.label),
            keysets,
          })
          const record = createDurableCustodyProofOperation({
            scope: {
              scopeKind: 'wallet',
              scopeId: context.fence.scopeId,
              walletId: context.fence.scopeId.slice('custody:wallet:'.length),
            },
            operation: mintAuthority.authority.operation,
            facts: mintAuthority.facts,
            inventoryAccountId: null,
            reservationId: operationId,
            exactBoundary: {
              method: 'POST',
              path: '/v1/redeem_outcome',
              idempotencyKey: operationId,
              requestBody: mintAuthority.exactRequest,
              output: mintAuthority.exactOutput,
              privateMaterial: mintAuthority.exactAuthority,
            },
          })
          assertCustodyRedeemPredecessors(
            new DurableCustodySqliteStore(database),
            record,
            target,
            purpose.label,
          )
          applyDurableCustodyTransaction(
            new DurableCustodyTransactionSqlite(
              database,
              context.fence.scopeId,
              context.observedAtMs,
            ),
            {
              scope: record.scope,
              owner: custodyRedeemOwner(context),
              operationRows: [
                { operationId: record.operation.operationId, expectedRevision: null },
              ],
            },
            (transaction) =>
              bindDurableCustodyProofOperation(transaction, record, {
                requestBody: mintAuthority.exactRequest,
                output: mintAuthority.exactOutput,
                privateMaterial: mintAuthority.exactAuthority,
              }),
          )
          purpose.linkCustody(
            database,
            context.fence.scopeId,
            operationId,
            record.operation.operationId,
          )
        },
        preparation.beforePrepare,
        input.walletDependencies?.injectCustodyFault,
      )
      preparation.prepared()
      await assertPreparedProofOperationDispatchFenced(operationId, authority, mutation(input))
      return prepared as CtfProofOperationRecord
    },
    markProofOperationCompleted: async (id, completion) => {
      const target = await readProofOperationFenced(id, mutation(input))
      if (target === null) throw new Error(`${purpose.label} target is absent`)
      return await custodyRedeemUnitOfWork(input, (database, context) => {
        const { record, exactAuthority } = purpose.readCustody(database, context.fence, target)
        if (record.operation.state !== 'reconciled') {
          const prepared = prepareDurableCustodyVerifiedMintResult({
            record,
            exactAuthority,
            result: { regular: completion.resultProofs.regular ?? [] },
          })
          const transaction = new DurableCustodyTransactionSqlite(
            database,
            context.fence.scopeId,
            context.observedAtMs,
            [record],
          )
          const authorization = custodyRedeemOwner(context)
          stageDurableCustodyPreparedMintResult({ transaction, record, prepared, authorization })
          const staged = transaction.getOperation(record.operation.operationId)!
          const successors = prepared.proofs.map(({ material, dleqState }) => ({
            proof: createCustodyProofSqliteRowFromMaterial({
              scopeId: record.scope.scopeId,
              normalizedMint: record.operation.custodyContext.normalizedMint,
              unit: 'msat',
              material,
              baseAsset: 'sat',
              conditionId: null,
              outcomeSetId: null,
              productBinding: null,
              signatureVerified: true,
              dleqState,
              nut07State: 'UNSPENT',
              selectability: 'selectable',
              reservationOperationId: null,
              storageClass: record.operation.proofStorage.storageClass,
              revision: 0,
              nowMs: context.observedAtMs,
            }),
            expectedRevision: null,
          }))
          transaction.stageSuccessorProofCas(staged.operation.operationId, successors)
          transaction.applyVerifiedResult({
            operationId: staged.operation.operationId,
            expectedRevision: staged.revision,
            authorization,
            outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
            resultHandle: staged.operation.result.resultHandle!,
            resultFingerprint: staged.operation.result.resultFingerprint!,
            successorAdmission: {
              scopeId: staged.scope.scopeId,
              operationId: staged.operation.operationId,
              admissionId: `${purpose.admissionPrefix}:${prepared.resultFingerprint}`,
              proofRows: successors.map(({ proof, expectedRevision }) => ({
                proofId: proof.proofId,
                expectedRevision,
                admittedRevision: proof.revision,
              })),
            },
          })
          transaction.rebuildActiveWorkIndex({
            scopeId: record.scope.scopeId,
            operationRows: [
              { operationId: record.operation.operationId, expectedRevision: staged.revision + 1 },
            ],
          })
        }
        const completed = purpose.completeTarget(
          database,
          id,
          completion,
          context.observedAtMs,
        ) as CtfProofOperationRecord
        const regular = completed.resultProofs?.regular
        if (regular === undefined)
          throw new Error(`${purpose.label} exact regular payout is missing`)
        purpose.afterComplete(database, { operationId: id, regular, context })
        return completed
      })
    },
    markProofOperationFailed: async (id, message, evidence) => {
      const target = await readProofOperationFenced(id, mutation(input))
      if (target === null) throw new Error(`${purpose.label} target is absent`)
      return await custodyRedeemUnitOfWork(input, (database, context) => {
        const { record, exactAuthority } = purpose.readCustody(database, context.fence, target)
        const prepared = prepareDurableCustodyAuthenticatedTerminalMintRejection({
          record,
          exactAuthority,
          evidence: evidence as AuthenticatedCtfRedeemTerminalEvidence,
        })
        const transaction = new DurableCustodyTransactionSqlite(
          database,
          context.fence.scopeId,
          context.observedAtMs,
          [record],
        )
        reconcileDurableCustodyAuthenticatedTerminalMintRejection({
          transaction,
          record,
          prepared,
          authorization: custodyRedeemOwner(context),
        })
        transaction.rebuildActiveWorkIndex({
          scopeId: record.scope.scopeId,
          operationRows: [
            {
              operationId: record.operation.operationId,
              expectedRevision: transaction.getOperation(record.operation.operationId)!.revision,
            },
          ],
        })
        return purpose.failTarget(
          database,
          id,
          message,
          evidence as AuthenticatedCtfRedeemTerminalEvidence,
          context.observedAtMs,
        ) as CtfProofOperationRecord
      })
    },
  }
}

export function custodyRedeemMintOperation(
  operation: Pick<
    ProofOperationRecord,
    'operationId' | 'kind' | 'mintUrl' | 'inputs' | 'outputs' | 'metadata'
  >,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  label: string,
) {
  if (operation.kind !== 'ctf-redeem') throw new Error(`${label} operation kind is foreign`)
  return {
    operationId: operation.operationId,
    kind: 'ctf-redeem' as const,
    mintUrl: operation.mintUrl,
    inputs: operation.inputs.map((proof) => ({
      ...serializeDurableCustodyProofInput(normalizeProof(proof)),
      amount: amountToNumber(proof.amount),
      conditionId: asset.conditionId,
      outcomeCollection: asset.outcomeSetId,
    })),
    outputs: Object.fromEntries(
      Object.entries(deserializeOutputGroups(operation.outputs)).map(([group, outputs]) => [
        group,
        outputs.map((output) => {
          const serialized = serializeDurableCustodyOutput(output)
          return {
            ...serialized,
            blindedMessage: {
              ...serialized.blindedMessage,
              amount: amountToNumber(output.blindedMessage.amount),
            },
          }
        }),
      ]),
    ),
    metadata: operation.metadata,
  }
}

async function custodyRedeemKeysets(
  operation: Parameters<NonNullable<CtfProofOperationStore['prepareProofOperation']>>[0],
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  wallet: RedeemWallet,
  label: string,
): Promise<DurableCustodyMintKeysetAuthority[]> {
  if (wallet.mint === undefined) throw new Error(`${label} mint keyset lookup is unavailable`)
  const regularKeyset = await getActiveRegularKeyset(wallet, 'msat')
  if (regularKeyset.id !== operation.metadata?.regularKeysetId)
    throw new Error(`${label} regular output keyset is foreign`)
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id!),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ])
  return await Promise.all(
    [...ids].map(async (id) => {
      const conditional = id === operation.metadata?.outcomeKeysetId
      const keyset = conditional
        ? (await wallet.mint!.getKeys(id)).keysets.find((candidate) => candidate.id === id)
        : regularKeyset
      if (keyset === undefined || keyset.unit !== 'msat')
        throw new Error(`${label} keyset is foreign`)
      if (
        !conditional &&
        (id !== regularKeyset.id || keyset.active === false || keyset.conditional !== undefined)
      )
        throw new Error(`${label} regular output keyset is foreign`)
      if (conditional)
        return conditionalRedeemKeysetAuthority(
          operation.mintUrl,
          asset,
          keyset,
          operation.metadata?.outcomeInputFeePpk as number,
        )
      return {
        canonicalMintUrl: operation.mintUrl,
        id,
        unit: 'msat',
        keys: keyset.keys,
        inputFeePpk: conditional
          ? (operation.metadata?.outcomeInputFeePpk as number)
          : (keyset.input_fee_ppk ?? 0),
        finalExpiry: keyset.final_expiry ?? null,
        identity: conditional
          ? {
              kind: 'conditional' as const,
              conditionId: asset.conditionId,
              outcomeCollection: asset.outcomeSetId,
              outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
                conditionId: asset.conditionId,
                outcomeCollection: asset.outcomeSetId,
              }),
            }
          : { kind: 'regular' as const },
      }
    }),
  )
}

export function conditionalRedeemKeysetAuthority(
  mintUrl: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  keyset: MintKeys,
  inputFeePpk: number,
): DurableCustodyMintKeysetAuthority {
  return {
    canonicalMintUrl: mintUrl,
    id: keyset.id,
    unit: 'msat',
    keys: keyset.keys,
    inputFeePpk,
    finalExpiry: keyset.final_expiry ?? null,
    identity: {
      kind: 'conditional',
      conditionId: asset.conditionId,
      outcomeCollection: asset.outcomeSetId,
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
        conditionId: asset.conditionId,
        outcomeCollection: asset.outcomeSetId,
      }),
    },
  }
}

/** Each input of the redeem has its exact unspent and verified custody row. */
export function assertCustodyRedeemPredecessors(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  target: ProofOperationRecord,
  label: string,
): void {
  for (const [index, { proofId }] of record.operation.reservation.inputs.entries()) {
    const proof = target.inputs[index]!
    const expected = createDurableCustodyProofMaterialRecord({
      scopeId: record.scope.scopeId,
      normalizedMint: target.mintUrl,
      unit: 'msat',
      proof: {
        id: proof.id!,
        amount: amountToNumber(proof.amount),
        secret: proof.secret,
        C: proof.C,
        dleq: proof.dleq ?? null,
        p2pkE: proof.p2pk_e ?? null,
        witness: proof.witness ?? null,
      },
    })
    const canonical = store.getProof(record.scope.scopeId, proofId)
    if (
      canonical === null ||
      canonical.proofId !== expected.proofId ||
      canonical.proofFingerprint !== expected.proofFingerprint ||
      canonical.normalizedMint !== target.mintUrl ||
      canonical.unit !== 'msat' ||
      canonical.baseAsset !== 'sat' ||
      canonical.conditionId !== target.metadata.conditionId ||
      canonical.outcomeSetId !== target.metadata.outcomeSetId ||
      canonical.nut07State !== 'UNSPENT' ||
      !canonical.signatureVerified ||
      canonical.dleqState !== 'verified'
    )
      throw new Error(`${label} canonical predecessor is absent or foreign`)
  }
}

function custodyRedeemOwner(context: CustodyRedeemMutation) {
  return {
    incarnationId: context.fence.incarnationId,
    fencingEpoch: context.fence.fencingEpoch,
    observedAtMs: context.observedAtMs,
  }
}

function custodyRedeemUnitOfWork<T>(
  input: CustodyRedeemContext,
  action: (database: DatabaseSync, context: CustodyRedeemMutation) => T,
): Promise<T> {
  const context = mutation(input)
  return withDurableCustodyUnitOfWork(
    profileDir(),
    context.fence,
    context.observedAtMs,
    (database) => action(database, context),
    input.walletDependencies?.injectCustodyFault === undefined
      ? {}
      : { injectFault: input.walletDependencies.injectCustodyFault },
  )
}

/** A redeem wallet that checks the prepared dispatch authority before each mint request. */
export function fencedRedeemWallet(
  input: CustodyRedeemContext & { readonly secrets: WalletOpsSecrets },
  mintUrl: string,
  operationId: string,
  authority: CustodyRedeemAuthority,
): RedeemWallet {
  const wallet = createWallet(
    mintUrl,
    input.secrets,
    input.walletDependencies ?? {},
    'sat',
    'msat',
  ) as unknown as RedeemWallet
  return {
    mint: wallet.mint,
    loadMint: () => wallet.loadMint(),
    checkProofsStates:
      wallet.checkProofsStates === undefined
        ? undefined
        : (proofs) => wallet.checkProofsStates!(proofs),
    redeemOutcomeProofs: async (request) => {
      await assertPreparedProofOperationDispatchFenced(operationId, authority, mutation(input))
      return wallet.redeemOutcomeProofs(request)
    },
  }
}

/** The current custody fence of the owner, read again for each transaction. */
export function mutation(input: CustodyRedeemContext): CustodyRedeemMutation {
  return {
    fence: input.walletDependencies?.getCustodyFence?.() ?? input.fence,
    observedAtMs: Date.now(),
  }
}

function normalizeProof(proof: ProofOperationRecord['inputs'][number]): Proof {
  return { ...proof, amount: amountToNumber(proof.amount) as never } as Proof
}
