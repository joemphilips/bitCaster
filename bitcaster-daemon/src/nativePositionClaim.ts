import { createSpeculativeRedeemPreparation } from './speculativeRedeemPreparation.ts'
import { creditedProofAmountMsat, writeNativeCompletedActivity } from './nativeCompletedActivity.ts'
import type { Proof } from '@cashu/cashu-ts'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  buildKeysetRedeemOperationId,
  canonicalProofOperationMintIdentity,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import { deriveDurableCustodyOperationId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  readDurableCustodyAuthenticatedTerminalMintRejection,
  type DurableCustodyMintKeysetAuthority,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  assertCustodyRedeemPredecessors,
  conditionalRedeemKeysetAuthority,
  createCustodyRedeemOperationStore,
  fencedRedeemWallet,
  mutation,
  readCustodyRedeemOperation,
  type CustodyRedeemPurpose,
} from './custodyRedeemOperation.ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { WalletClaimPositionParams, WalletClaimPositionResult } from './protocol.ts'
import {
  POSITION_CLAIM_PURPOSE,
  completePositionClaimRedeemFromDatabase,
  failPositionClaimRedeemFromDatabase,
  readPositionClaimProofPageFenced,
  readProofOperationsByPurposePage,
  type ProofOperationRecord,
  type StoredProofAsset,
  type StoredProofRecord,
} from './state.ts'
import {
  restoreOutputGroups,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'
import type { StartupRecoveryResult } from './startupRecovery.ts'
import {
  summarizeConditionOracleEvidence,
  requireVerifiedConditionOracleEvidence,
  UNVERIFIED_CONDITION_OUTCOME_WARNING,
  type ConditionOracleEvidenceSummary,
  type ConditionOracleResolutionContext,
} from '@bitcaster-market/client-sdk/conditionOracleEvidence'
import {
  readDaemonPositionClaimResult,
  type DaemonConditionResolution,
} from './nativeConditionResolution.ts'

interface ClaimContext {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly fence: CustodyScopeFence
  readonly walletDependencies?: WalletOpsDependencies
}

export async function claimDaemonPosition(
  input: ClaimContext &
    WalletClaimPositionParams & {
      /** The mint record, then the oracle relays. The engine is not read. */
      readonly resolution: DaemonConditionResolution
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
  let authority: Awaited<ReturnType<typeof readDaemonPositionClaimResult>> | undefined
  while (true) {
    const records = await readPositionClaimProofPageFenced({
      mintUrl: input.profile.mintUrl,
      asset,
      mutation: mutation(input),
    })
    if (records.length === 0) return result
    // Read before the first new operation. A result that the mint cannot redeem refuses the claim.
    authority ??= await readDaemonPositionClaimResult({ ...input, ...position })
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
        outcome: authority.resolvedOutcome,
        oracleWitness:
          authority.evidence.status === 'verified' ? authority.evidence.canonicalOracleWitness : '',
        ...(authority.evidence.status === 'verified'
          ? { oracleResolutionContext: authority.evidence.context }
          : {}),
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
  const preparation = createSpeculativeRedeemPreparation({
    operationId: operation.operationId,
    mintUrl: operation.mintUrl,
    seed: Buffer.from(input.secrets.walletSeedHex, 'hex'),
    fence: input.fence,
    wallet: fencedRedeemWallet(
      input,
      operation.mintUrl,
      operation.operationId,
      claimAuthority(operation.operationId, asset),
    ),
  })
  const wallet = preparation.wallet
  const store = createCustodyRedeemOperationStore(
    input,
    operation.operationId,
    asset,
    wallet,
    preparation,
    positionClaimPurpose(operation.operationId, asset),
  )
  await store.getProofOperation(operation.operationId)
  try {
    const resolution = operation.metadata.oracleResolutionContext as
      | ConditionOracleResolutionContext
      | undefined
    const oracleInputKeysets =
      resolution === undefined
        ? undefined
        : ((operation.metadata.oracleInputKeysets as
            | readonly DurableCustodyMintKeysetAuthority[]
            | undefined) ?? [
            await readNativePositionClaimInputKeyset(
              input.profile.mintUrl,
              asset,
              operation.metadata.outcomeKeysetId as string,
              wallet,
            ),
          ])
    const result = await preparation.run({
      mintUrl: operation.mintUrl,
      operationId: operation.operationId,
      wallet,
      proofOperationStore: store,
      conditionId: position.conditionId,
      outcomeSetId: position.outcomeCollection,
      outcomeKeysetId: operation.metadata.outcomeKeysetId as string,
      outcome: operation.metadata.outcome as string,
      oracleWitness: operation.metadata.oracleWitness as string,
      oracleResolutionContext: resolution,
      oracleInputKeysets,
      unit: 'msat',
      proofs: operation.inputs.map(normalizeProof),
      restoreOutputGroups: input.walletDependencies?.restoreOutputGroups ?? restoreOutputGroups,
    })
    return {
      operationId: operation.operationId,
      keysetId: operation.metadata.outcomeKeysetId as string,
      state: result.refused ? 'pending' : result.losing ? 'losing' : 'completed',
      oracleEvidence: operationOracleEvidence(operation),
      payoutAmountSubunits: result.proofs.reduce(
        (sum, proof) => sum + amountToNumber(proof.amount),
        0,
      ),
    }
  } catch (error) {
    const persisted = await store.getProofOperation(operation.operationId)
    if (
      persisted === null ||
      (persisted.state !== 'prepared' &&
        !(persisted.state === 'Failed' && persisted.failureCode === 13015))
    )
      throw error
    return {
      operationId: operation.operationId,
      keysetId: operation.metadata.outcomeKeysetId as string,
      state: 'pending',
      oracleEvidence: operationOracleEvidence(operation),
      payoutAmountSubunits: 0,
    }
  }
}

function operationOracleEvidence(
  operation: Pick<ProofOperationRecord, 'mintUrl' | 'metadata'>,
): ConditionOracleEvidenceSummary {
  try {
    const verified = requireVerifiedConditionOracleEvidence(
      operation.metadata.oracleResolutionContext as ConditionOracleResolutionContext,
    )
    if (
      verified.context.registered.normalizedMint !== operation.mintUrl ||
      verified.context.registered.conditionId !== operation.metadata.conditionId ||
      verified.context.registered.unit !== 'msat'
    )
      throw new Error('claim evidence is foreign')
    return summarizeConditionOracleEvidence(verified)
  } catch {
    return {
      status: 'unverified',
      reason: 'missing',
      warning: UNVERIFIED_CONDITION_OUTCOME_WARNING,
    }
  }
}

export async function readNativePositionClaimInputKeyset(
  mintUrl: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
  id: string,
  wallet: RedeemWallet,
): Promise<DurableCustodyMintKeysetAuthority> {
  const keyset = (await wallet.mint?.getKeys(id))?.keysets.find((candidate) => candidate.id === id)
  if (
    keyset === undefined ||
    keyset.unit !== 'msat' ||
    !Number.isSafeInteger(keyset.input_fee_ppk) ||
    keyset.input_fee_ppk! < 0
  )
    throw new Error('position claim conditional keyset is foreign')
  return conditionalRedeemKeysetAuthority(mintUrl, asset, keyset, keyset.input_fee_ppk!)
}

/** A claim finds its custody operation through its link row. */
function positionClaimPurpose(
  operationId: string,
  asset: Extract<StoredProofAsset, { kind: 'Outcome' }>,
): CustodyRedeemPurpose {
  return {
    label: 'position claim',
    observeStage: 'claim',
    admissionPrefix: 'position-claim',
    authority: claimAuthority(operationId, asset),
    assertTarget: (operation) => {
      if (operation.kind !== 'ctf-redeem' || operation.metadata.purpose !== POSITION_CLAIM_PURPOSE)
        throw new Error('position claim operation is foreign')
    },
    readCustody: readNativePositionClaimCustody,
    linkCustody: (database, scopeId, targetOperationId, custodyOperationId) => {
      database
        .prepare(
          `INSERT INTO custody_position_claim_links (scope_id, target_operation_id, custody_operation_id)
             VALUES (?, ?, ?)`,
        )
        .run(scopeId, targetOperationId, custodyOperationId)
    },
    completeTarget: completePositionClaimRedeemFromDatabase,
    afterComplete: (database, { operationId: id, regular, context }) => {
      writeNativeCompletedActivity(database, {
        scopeId: context.fence.scopeId,
        sourceKind: 'position-claim',
        sourceId: id,
        type: 'payout_claimed',
        amountMsat: creditedProofAmountMsat(regular, 'msat'),
        completedAtMs: context.observedAtMs,
        txId: id,
      })
    },
    failTarget: failPositionClaimRedeemFromDatabase,
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

export function readNativePositionClaimCustody(
  database: DatabaseSync,
  fence: Pick<CustodyScopeFence, 'scopeId'>,
  target: ProofOperationRecord,
) {
  if (target.metadata.purpose !== POSITION_CLAIM_PURPOSE)
    throw new Error('position claim custody mapping is absent or foreign')
  const link = database
    .prepare(
      'SELECT custody_operation_id AS operationId FROM custody_position_claim_links WHERE scope_id = ? AND target_operation_id = ?',
    )
    .get(fence.scopeId, target.operationId) as { operationId: string } | undefined
  return readCustodyRedeemOperation(database, {
    scopeId: fence.scopeId,
    custodyOperationId: link?.operationId ?? null,
    target,
    asset: positionAsset(
      canonicalPosition({
        conditionId: target.metadata.conditionId as string,
        outcomeCollection: target.metadata.outcomeSetId as string,
      }),
    ),
    label: 'position claim',
  })
}

/** Valid only within the caller's current synchronous database snapshot/transaction. */
export function readRetainedPositionClaimHistory(
  database: DatabaseSync,
  scopeId: string,
  target: ProofOperationRecord,
) {
  if (target.kind !== 'ctf-redeem' || target.state !== 'Failed' || target.failureCode !== 13015)
    throw new Error('retained Claim history binding is invalid')
  const { store, record, exactAuthority } = readNativePositionClaimCustody(
    database,
    { scopeId },
    target,
  )
  if (record.operation.state !== 'aborted') throw new Error('retained Claim is not aborted')
  const reference = record.operation.terminalMintRejection?.exactRejection
  if (reference === undefined) throw new Error('retained Claim rejection is absent')
  const rejection = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (rejection === null) throw new Error('retained Claim rejection artifact is absent')
  readDurableCustodyAuthenticatedTerminalMintRejection({
    record,
    exactRejection: rejection.artifact,
  })
  assertCustodyRedeemPredecessors(store, record, target, 'position claim')
  return { store, record, exactAuthority, target, scopeId }
}

export function assertRetainedPositionClaimProof(
  history: ReturnType<typeof readRetainedPositionClaimHistory>,
  proof: StoredProofRecord,
): void {
  const { target, store, record, scopeId } = history
  if (
    target.kind !== 'ctf-redeem' ||
    target.state !== 'Failed' ||
    target.failureCode !== 13015 ||
    proof.state !== 'locked' ||
    proof.reservedBy !== target.operationId ||
    proof.mintUrl !== target.mintUrl ||
    proof.retirement !== undefined ||
    proof.asset.kind !== 'Outcome' ||
    proof.asset.unit !== 'msat' ||
    proof.asset.conditionId !== target.metadata.conditionId ||
    proof.asset.outcomeSetId !== target.metadata.outcomeSetId
  )
    throw new Error('retained Claim history binding is invalid')
  const index = target.inputs.findIndex((input) => isDeepStrictEqual(input, proof.proof))
  const input = record.operation.reservation.inputs[index]
  if (input === undefined || store.getProof(scopeId, input.proofId)?.selectability !== 'retained')
    throw new Error('retained Claim predecessor is absent or foreign')
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
