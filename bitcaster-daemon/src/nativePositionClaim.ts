import type { Proof } from '@cashu/cashu-ts'
import type { DatabaseSync } from 'node:sqlite'
import {
  buildKeysetRedeemOperationId,
  canonicalProofOperationMintIdentity,
  getActiveRegularKeyset,
  redeemOutcomeLegWithOperation,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import {
  deserializeOutputGroups,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  applyDurableCustodyTransaction,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyRecord,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  prepareDurableCustodyAuthenticatedTerminalMintRejection,
  reconcileDurableCustodyAuthenticatedTerminalMintRejection,
  readDurableCustodyAuthenticatedTerminalMintRejection,
  type DurableCustodyMintKeysetAuthority,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { createDurableCustodyProofMaterialRecord } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import {
  serializeDurableCustodyProofInput,
  serializeDurableCustodyOutput,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import { createCustodyProofSqliteRowFromMaterial } from './custodyProofSqliteRow.ts'
import { withDurableCustodyUnitOfWork } from './durableCustodyUnitOfWork.ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { profileDir, type DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { WalletClaimPositionParams, WalletClaimPositionResult } from './protocol.ts'
import {
  verifyDaemonConditionAttestation,
  type ManagedConditionRetirementEngine,
} from './managedConditionRetirement.ts'
import {
  POSITION_CLAIM_PURPOSE,
  assertPreparedProofOperationDispatchFenced,
  completePositionClaimRedeemFromDatabase,
  failPositionClaimRedeemFromDatabase,
  prepareProofOperationWithExactReservation,
  readProofOperationFenced,
  readPositionClaimProofPageFenced,
  readProofOperationsByPurposePage,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'
import {
  createWallet,
  restoreOutputGroups,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'
import type { StartupRecoveryResult } from './startupRecovery.ts'

interface ClaimContext {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
}

export async function claimDaemonPosition(
  input: ClaimContext &
    WalletClaimPositionParams & {
      readonly engine: ManagedConditionRetirementEngine
    },
): Promise<WalletClaimPositionResult> {
  const position = canonicalPosition(input)
  const result: WalletClaimPositionResult = { ...position, legs: [] }
  for await (const operation of preparedClaims()) {
    if (matchesPosition(operation, input.profile.mintUrl, position)) {
      result.legs.push(await executeLeg(input, operation))
    }
  }
  if (result.legs.some((leg) => leg.state === 'pending')) return result
  const asset = positionAsset(position)
  let authority: ReturnType<typeof verifyDaemonConditionAttestation> | undefined
  while (true) {
    const records = await readPositionClaimProofPageFenced({
      mintUrl: input.profile.mintUrl,
      asset,
      mutation: mutation(input),
    })
    if (records.length === 0) return result
    if (authority === undefined) {
      const response = await input.engine.getConditionAttestation(position.conditionId)
      if (response === null) throw new Error('condition resolution attestation is not available')
      authority = verifyDaemonConditionAttestation(
        input.fence,
        input.profile,
        position.conditionId,
        response,
      )
    }
    const proofs = records.map(({ proof }) => normalizeProof(proof))
    const retainedOperationKey = buildKeysetRedeemOperationId({
      mintUrl: input.profile.mintUrl,
      unit: 'msat',
      conditionId: position.conditionId,
      keysetId: proofs[0]!.id,
      proofs,
    })
    const operationId = deriveDurableCustodyOperationId(input.fence.scopeId, {
      retainedOperationKey,
      binding: { kind: 'wallet', activityId: retainedOperationKey, stage: 'ctf-redeem' },
    })
    const leg = await executeLeg(input, {
      operationId,
      mintUrl: input.profile.mintUrl,
      inputs: proofs,
      metadata: {
        ...position,
        outcomeSetId: position.outcomeCollection,
        outcomeKeysetId: proofs[0]!.id,
        outcome: authority.resolution.resolvedOutcome,
        oracleWitness: authority.oracleWitness,
      },
    })
    result.legs.push(leg)
    if (leg.state === 'pending') return result
  }
}

export async function recoverDaemonPositionClaims(
  input: ClaimContext,
): Promise<StartupRecoveryResult> {
  const recovered: string[] = []
  const pending: Array<{ operationId: string; error: string }> = []
  let recoveredCount = 0
  for await (const operation of preparedClaims()) {
    try {
      if (operation.mintUrl !== canonicalProofOperationMintIdentity(input.profile.mintUrl)) {
        throw new Error('claim mint is foreign')
      }
      const leg = await executeLeg(input, operation)
      if (leg.state === 'pending') {
        if (pending.length < 100)
          pending.push({
            operationId: leg.operationId,
            error: 'position claim recovery is pending',
          })
      } else {
        recoveredCount += 1
        if (recovered.length < 100) recovered.push(leg.operationId)
      }
    } catch {
      if (pending.length < 100)
        pending.push({
          operationId: operation.operationId,
          error: 'position claim recovery is pending',
        })
    }
  }
  return { recovered, recoveredCount, pending }
}

async function* preparedClaims(): AsyncGenerator<ProofOperationRecord> {
  let after: Parameters<typeof readProofOperationsByPurposePage>[0]['after']
  while (true) {
    const page = await readProofOperationsByPurposePage({
      purpose: POSITION_CLAIM_PURPOSE,
      limit: 64,
      recoverableOnly: true,
      ...(after === undefined ? {} : { after }),
    })
    for (const operation of page.operations) yield operation
    if (page.nextCursor === null) return
    after = page.nextCursor
  }
}

async function executeLeg(
  input: ClaimContext,
  operation: Pick<ProofOperationRecord, 'operationId' | 'mintUrl' | 'metadata' | 'inputs'>,
): Promise<WalletClaimPositionResult['legs'][number]> {
  const position = canonicalPosition({
    conditionId: operation.metadata.conditionId as string,
    outcomeCollection: operation.metadata.outcomeSetId as string,
  })
  const asset = positionAsset(position)
  const wallet = fencedClaimWallet(input, operation.mintUrl, operation.operationId, asset)
  const store = claimOperationStore(input, operation.operationId, asset, wallet)
  try {
    const result = await redeemOutcomeLegWithOperation({
      mintUrl: operation.mintUrl,
      operationId: operation.operationId,
      wallet,
      proofOperationStore: store,
      conditionId: position.conditionId,
      outcomeSetId: position.outcomeCollection,
      outcomeKeysetId: operation.metadata.outcomeKeysetId as string,
      outcome: operation.metadata.outcome as string,
      oracleWitness: operation.metadata.oracleWitness as string,
      unit: 'msat',
      proofs: operation.inputs.map(normalizeProof),
      restoreOutputGroups: input.walletDependencies?.restoreOutputGroups ?? restoreOutputGroups,
    })
    return {
      operationId: operation.operationId,
      keysetId: operation.metadata.outcomeKeysetId as string,
      state: result.losing ? 'losing' : 'completed',
      payoutAmountSubunits: result.proofs.reduce(
        (sum, proof) => sum + amountToNumber(proof.amount),
        0,
      ),
    }
  } catch (error) {
    const persisted = await readProofOperationFenced(operation.operationId, mutation(input))
    if (persisted === null || persisted.state !== 'prepared') throw error
    return {
      operationId: operation.operationId,
      keysetId: operation.metadata.outcomeKeysetId as string,
      state: 'pending',
      payoutAmountSubunits: 0,
    }
  }
}

function claimOperationStore(
  input: ClaimContext,
  operationId: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  wallet: RedeemWallet,
): CtfProofOperationStore {
  const authority = claimAuthority(operationId, asset)
  return {
    getProofOperation: async (id) => {
      const operation = await readProofOperationFenced(id, mutation(input))
      if (operation === null) return null
      if (operation.kind !== 'ctf-redeem' || operation.metadata.purpose !== POSITION_CLAIM_PURPOSE)
        throw new Error('position claim operation is foreign')
      await claimUnitOfWork(input, (database, context) => {
        const { record, store } = readClaimCustody(database, context.fence, operation)
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
            throw new Error('position claim terminal authority is absent')
          const artifact = store.getArtifact({
            scopeId: record.scope.scopeId,
            operationId: record.operation.operationId,
            expectedOperationRevision: record.revision,
            reference,
          })
          if (artifact === null) throw new Error('position claim terminal artifact is absent')
          readDurableCustodyAuthenticatedTerminalMintRejection({
            record,
            exactRejection: artifact.artifact,
          })
        }
      })
      if (operation.state === 'prepared')
        await assertPreparedProofOperationDispatchFenced(id, authority, mutation(input))
      return operation as CtfProofOperationRecord
    },
    prepareProofOperation: async (operation) => {
      const keysets = await claimKeysets(operation, asset, wallet)
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
            operation: claimMintOperation(target, asset),
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
          assertClaimPredecessors(new DurableCustodySqliteStore(database), record, target)
          applyDurableCustodyTransaction(
            new DurableCustodyTransactionSqlite(
              database,
              context.fence.scopeId,
              context.observedAtMs,
            ),
            {
              scope: record.scope,
              owner: claimOwner(context),
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
          database
            .prepare(
              `INSERT INTO custody_position_claim_links (scope_id, target_operation_id, custody_operation_id)
             VALUES (?, ?, ?)`,
            )
            .run(context.fence.scopeId, operationId, record.operation.operationId)
        },
        undefined,
        input.walletDependencies?.injectCustodyFault,
      )
      await assertPreparedProofOperationDispatchFenced(operationId, authority, mutation(input))
      return prepared as CtfProofOperationRecord
    },
    markProofOperationCompleted: async (id, completion) => {
      const target = await readProofOperationFenced(id, mutation(input))
      if (target === null) throw new Error('position claim target is absent')
      return await claimUnitOfWork(input, (database, context) => {
        const { record, exactAuthority } = readClaimCustody(database, context.fence, target)
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
          const authorization = claimOwner(context)
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
              admissionId: `position-claim:${prepared.resultFingerprint}`,
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
        return completePositionClaimRedeemFromDatabase(
          database,
          id,
          completion,
          context.observedAtMs,
        ) as CtfProofOperationRecord
      })
    },
    markProofOperationFailed: async (id, message, evidence) => {
      const target = await readProofOperationFenced(id, mutation(input))
      if (target === null) throw new Error('position claim target is absent')
      return await claimUnitOfWork(input, (database, context) => {
        const { record, exactAuthority } = readClaimCustody(database, context.fence, target)
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
          authorization: claimOwner(context),
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
        return failPositionClaimRedeemFromDatabase(
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

function claimMintOperation(
  operation: Pick<
    ProofOperationRecord,
    'operationId' | 'kind' | 'mintUrl' | 'inputs' | 'outputs' | 'metadata'
  >,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
) {
  if (operation.kind !== 'ctf-redeem') throw new Error('position claim operation kind is foreign')
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

async function claimKeysets(
  operation: Parameters<NonNullable<CtfProofOperationStore['prepareProofOperation']>>[0],
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  wallet: RedeemWallet,
): Promise<DurableCustodyMintKeysetAuthority[]> {
  if (wallet.mint === undefined) throw new Error('position claim mint keyset lookup is unavailable')
  const regularKeyset = await getActiveRegularKeyset(wallet, 'msat')
  if (regularKeyset.id !== operation.metadata?.regularKeysetId)
    throw new Error('position claim regular output keyset is foreign')
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
        throw new Error('position claim keyset is foreign')
      if (
        !conditional &&
        (id !== regularKeyset.id || keyset.active === false || keyset.conditional !== undefined)
      )
        throw new Error('position claim regular output keyset is foreign')
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

function readClaimCustody(
  database: DatabaseSync,
  fence: CustodyScopeFence,
  target: ProofOperationRecord,
) {
  const link = database
    .prepare(
      'SELECT custody_operation_id AS operationId FROM custody_position_claim_links WHERE scope_id = ? AND target_operation_id = ?',
    )
    .get(fence.scopeId, target.operationId) as { operationId: string } | undefined
  const store = new DurableCustodySqliteStore(database)
  const record = link === undefined ? null : store.getOperation(link.operationId)
  if (
    record === null ||
    record.scope.scopeId !== fence.scopeId ||
    record.operation.retainedOperationKey !== target.operationId ||
    record.operation.semanticKind !== 'ctf-redeem' ||
    target.metadata.purpose !== POSITION_CLAIM_PURPOSE ||
    record.operation.reservation.reservationId !== target.operationId
  )
    throw new Error('position claim custody mapping is absent or foreign')
  const row = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (row === null) throw new Error('position claim private authority is absent')
  const authority = assertDurableCustodyMintOperationAuthority(record, row.artifact)
  const expected = claimMintOperation(
    target,
    positionAsset(
      canonicalPosition({
        conditionId: target.metadata.conditionId as string,
        outcomeCollection: target.metadata.outcomeSetId as string,
      }),
    ),
  )
  if (
    deriveDurableCustodyArtifactFingerprint(expected) !==
      deriveDurableCustodyArtifactFingerprint(authority.operation) ||
    (target.state === 'completed' && record.operation.state !== 'reconciled') ||
    (target.state === 'prepared' &&
      record.operation.state !== 'dispatch-intent' &&
      record.operation.state !== 'transport-attempted') ||
    (target.failureCode === 13015 && record.operation.terminalMintRejection === null)
  )
    throw new Error('position claim canonical authority differs from target')
  if (target.state === 'prepared') assertClaimPredecessors(store, record, target)
  return { store, record, exactAuthority: row.artifact }
}

function assertClaimPredecessors(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  target: ProofOperationRecord,
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
      throw new Error('position claim canonical predecessor is absent or foreign')
  }
}

function claimOwner(context: ReturnType<typeof mutation>) {
  return {
    incarnationId: context.fence.incarnationId,
    fencingEpoch: context.fence.fencingEpoch,
    observedAtMs: context.observedAtMs,
  }
}

function claimUnitOfWork<T>(
  input: ClaimContext,
  action: (database: DatabaseSync, context: ReturnType<typeof mutation>) => T,
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

function fencedClaimWallet(
  input: ClaimContext,
  mintUrl: string,
  operationId: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
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
      await assertPreparedProofOperationDispatchFenced(
        operationId,
        claimAuthority(operationId, asset),
        mutation(input),
      )
      return wallet.redeemOutcomeProofs(request)
    },
  }
}

function claimAuthority(
  operationId: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
) {
  return {
    purpose: POSITION_CLAIM_PURPOSE,
    reservationId: operationId,
    inputAsset: asset,
    successorAssets: {
      regular: { kind: 'sats' as const, baseAsset: 'sat' as const, unit: 'msat' as const },
    },
  }
}

function mutation(input: ClaimContext) {
  return {
    fence: input.walletDependencies?.getCustodyFence?.() ?? input.fence,
    observedAtMs: Date.now(),
  }
}

function matchesPosition(
  operation: ProofOperationRecord,
  mintUrl: string,
  position: WalletClaimPositionParams,
): boolean {
  return (
    operation.kind === 'ctf-redeem' &&
    operation.mintUrl === canonicalProofOperationMintIdentity(mintUrl) &&
    operation.metadata.conditionId === position.conditionId &&
    operation.metadata.outcomeSetId === position.outcomeCollection
  )
}

function positionAsset(
  position: WalletClaimPositionParams,
): Extract<StoredProofAsset, { kind: 'Outcome' }> {
  return {
    kind: 'Outcome',
    conditionId: position.conditionId,
    outcomeSetId: position.outcomeCollection,
    baseAsset: 'sat',
    unit: 'msat',
  }
}

function canonicalPosition(input: WalletClaimPositionParams): WalletClaimPositionParams {
  if (typeof input.conditionId !== 'string' || !/^[0-9a-f]{64}$/i.test(input.conditionId))
    throw new Error('condition id is invalid')
  if (
    typeof input.outcomeCollection !== 'string' ||
    input.outcomeCollection.length < 1 ||
    input.outcomeCollection.length > 16384 ||
    input.outcomeCollection
      .split('|')
      .some((outcome) => outcome.length === 0 || outcome.trim() !== outcome) ||
    new Set(input.outcomeCollection.split('|')).size !== input.outcomeCollection.split('|').length
  )
    throw new Error('outcome collection is invalid')
  return {
    conditionId: input.conditionId.toLowerCase(),
    outcomeCollection: input.outcomeCollection,
  }
}

function normalizeProof(proof: ProofOperationRecord['inputs'][number]): Proof {
  return { ...proof, amount: amountToNumber(proof.amount) as never } as Proof
}
