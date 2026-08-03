import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  Amount,
  MintOperationError,
  type MintKeys,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  planProofConsolidationRound,
  type ProofConsolidationRound,
} from '@bitcaster-market/client-sdk/boundedProofConsolidation'
import {
  completeExactProofConsolidationOperation,
  classifyExactProofConsolidationReplayFailure,
  prepareExactProofConsolidationOperation,
  validateExactProofConsolidationOperation,
  validateExactProofConsolidationProofs,
  type ExactProofConsolidationWallet,
} from '@bitcaster-market/client-sdk/proofConsolidationOperation'
import { classifyCtfRangeSourceRecovery } from '@bitcaster-market/client-sdk/ctfRangeSourceRecovery'
import { checkCtfRangeInputProofStates } from '@bitcaster-market/client-sdk/ctfRangeRecoveryTransport'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { DurableCustodyProofOperationInput } from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import {
  createWallet,
  createDaemonCounterSource,
  resolveCtfConsolidationInputFees,
  resolveCtfConsolidationOutputKeysets,
  resolveMintKeysByKeyset,
  restoreOutputGroups,
  serializeOutputDataArray,
  type CashuWalletLike,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'
import {
  finalizeCompletedProofReservation,
  markProofOperationCompletedFenced,
  prepareProofOperationWithExactReservation,
  readAvailableWalletProofGroupPage,
  readAvailableWalletProofPage,
  getProofOperation,
  readProofOperationsByPurposePage,
  releasePreparedProofReservationFenced,
  type AvailableWalletProofGroup,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'

export const WALLET_PROOF_CONSOLIDATION_PURPOSE = 'wallet-proof-consolidation'
export const WALLET_PROOF_CONSOLIDATION_INPUT_MAX = 64
export const WALLET_PROOF_CONSOLIDATION_ROUND_MAX = 256

const GROUP_PAGE_SIZE = 64
const SKIPPED_SAMPLE_LIMIT = 256

export interface WalletProofConsolidationRoundResult {
  readonly operationId: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly asset: StoredProofAsset
  readonly inputKeysetId: string
  readonly outputKeysetId: string
  readonly inputCount: number
  readonly outputCount: number
  readonly fee: number
}

export interface WalletProofConsolidationResult {
  readonly invocationId: string
  readonly status: 'completed' | 'partial'
  readonly rounds: readonly WalletProofConsolidationRoundResult[]
  readonly skipped: ReadonlyArray<{
    readonly mintUrl: string
    readonly unit: 'sat' | 'msat'
    readonly keysetId: string
    readonly reason:
      | 'not-needed'
      | 'not-reducible'
      | 'fee-exhausted'
      | 'inactive-conditional-keyset'
  }>
  readonly skippedGroupCount: number
  readonly skippedTruncated: boolean
  readonly pending: ReadonlyArray<{ readonly operationId: string; readonly error: string }>
  readonly failure: {
    readonly operationId: string | null
    readonly mintUrl: string
    readonly unit: 'sat' | 'msat'
    readonly keysetId: string
    readonly error: string
  } | null
}

export interface WalletProofConsolidationRecoveryResult {
  readonly recovered: string[]
  readonly pending: Array<{ readonly operationId: string; readonly error: string }>
}

export interface WalletProofConsolidationInput {
  readonly secrets: WalletOpsSecrets
  readonly mutation: () => FencedStateMutation
  readonly dependencies?: WalletOpsDependencies
}

let consolidationQueue: Promise<void> = Promise.resolve()

export function consolidateWalletProofs(
  input: WalletProofConsolidationInput,
): Promise<WalletProofConsolidationResult> {
  return serializeConsolidation(() => consolidateWalletProofsUnlocked(input))
}

async function consolidateWalletProofsUnlocked(
  input: WalletProofConsolidationInput,
): Promise<WalletProofConsolidationResult> {
  const invocationId = randomUUID()
  const recovery = await recoverWalletProofConsolidationsUnlocked(input)
  if (recovery.pending.length > 0) {
    return {
      invocationId,
      status: 'partial',
      rounds: [],
      skipped: [],
      skippedGroupCount: 0,
      skippedTruncated: false,
      pending: recovery.pending,
      failure: null,
    }
  }
  return scanWalletProofGroups(input, invocationId)
}

interface ConsolidationScan {
  readonly input: WalletProofConsolidationInput
  readonly invocationId: string
  readonly dependencies: WalletOpsDependencies
  readonly wallets: Map<string, ExactProofConsolidationWallet>
  readonly revisit: GroupQueue
  readonly rounds: WalletProofConsolidationRoundResult[]
  readonly skipped: WalletProofConsolidationResult['skipped'][number][]
  skippedGroupCount: number
  failure: WalletProofConsolidationResult['failure']
}

async function scanWalletProofGroups(
  input: WalletProofConsolidationInput,
  invocationId: string,
): Promise<WalletProofConsolidationResult> {
  const scan: ConsolidationScan = {
    input,
    invocationId,
    dependencies: input.dependencies ?? {},
    wallets: new Map(),
    revisit: new GroupQueue([]),
    rounds: [],
    skipped: [],
    skippedGroupCount: 0,
    failure: null,
  }
  await scanInitialGroups(scan)
  while (scan.revisit.length > 0 && canContinueScan(scan)) {
    await drainWalletProofGroup(scan, scan.revisit.take()!)
  }
  return scanResult(scan)
}

async function scanInitialGroups(scan: ConsolidationScan): Promise<void> {
  let after: Parameters<typeof readAvailableWalletProofGroupPage>[0]['after']
  do {
    const page = await readAvailableWalletProofGroupPage({
      limit: GROUP_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    })
    for (const group of page.groups) {
      await drainWalletProofGroup(scan, group)
      if (!canContinueScan(scan)) break
    }
    after = page.nextCursor ?? undefined
  } while (after !== undefined && canContinueScan(scan))
}

async function drainWalletProofGroup(
  scan: ConsolidationScan,
  group: AvailableWalletProofGroup,
): Promise<void> {
  while (canContinueScan(scan)) {
    const roundInput = {
      group,
      invocationId: scan.invocationId,
      roundIndex: scan.rounds.length,
      secrets: scan.input.secrets,
      mutation: scan.input.mutation,
      dependencies: scan.dependencies,
      wallets: scan.wallets,
    }
    let outcome: ConsolidateRoundOutcome
    try {
      outcome = await consolidateOneRound(roundInput)
    } catch (error) {
      const operationId = manualRoundOperationId(roundInput)
      scan.failure = {
        operationId: (await getProofOperation(operationId)) === null ? null : operationId,
        mintUrl: group.mintUrl,
        unit: group.asset.unit,
        keysetId: group.keysetId,
        error: errorMessage(error),
      }
      return
    }
    if (outcome.kind !== 'ready') {
      recordSkippedGroup(scan, group, outcome.kind)
      return
    }
    scan.rounds.push(outcome.result)
    if (groupKey(outcome.outputGroup) !== groupKey(group)) {
      scan.revisit.add(outcome.outputGroup)
    }
  }
}

function recordSkippedGroup(
  scan: ConsolidationScan,
  group: AvailableWalletProofGroup,
  reason: WalletProofConsolidationResult['skipped'][number]['reason'],
): void {
  scan.skippedGroupCount += 1
  if (scan.skipped.length >= SKIPPED_SAMPLE_LIMIT) return
  scan.skipped.push({
    mintUrl: group.mintUrl,
    unit: group.asset.unit,
    keysetId: group.keysetId,
    reason,
  })
}

function hasRoundCapacity(scan: ConsolidationScan): boolean {
  return scan.rounds.length < WALLET_PROOF_CONSOLIDATION_ROUND_MAX
}

function canContinueScan(scan: ConsolidationScan): boolean {
  return scan.failure === null && hasRoundCapacity(scan)
}

function scanResult(scan: ConsolidationScan): WalletProofConsolidationResult {
  const partial = !hasRoundCapacity(scan) || scan.failure !== null
  const pending =
    scan.failure?.operationId === null || scan.failure === null
      ? []
      : [{ operationId: scan.failure.operationId, error: scan.failure.error }]
  return {
    invocationId: scan.invocationId,
    status: partial ? 'partial' : 'completed',
    rounds: scan.rounds,
    skipped: scan.skipped,
    skippedGroupCount: scan.skippedGroupCount,
    skippedTruncated: scan.skippedGroupCount > scan.skipped.length,
    pending,
    failure: scan.failure,
  }
}

export function recoverWalletProofConsolidations(
  input: WalletProofConsolidationInput,
): Promise<WalletProofConsolidationRecoveryResult> {
  return serializeConsolidation(() => recoverWalletProofConsolidationsUnlocked(input))
}

async function recoverWalletProofConsolidationsUnlocked(
  input: WalletProofConsolidationInput,
): Promise<WalletProofConsolidationRecoveryResult> {
  const recovered = new Set<string>()
  const pending = new Map<string, string>()
  let after: Parameters<typeof readProofOperationsByPurposePage>[0]['after']
  do {
    const page = await readProofOperationsByPurposePage({
      purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
      recoverableOnly: true,
      limit: GROUP_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    })
    for (const operation of page.operations) {
      try {
        await recoverOperation(operation, input)
        recovered.add(operation.operationId)
        pending.delete(operation.operationId)
      } catch (error) {
        if (!recovered.has(operation.operationId)) {
          pending.set(operation.operationId, errorMessage(error))
        }
      }
    }
    after = page.nextCursor ?? undefined
  } while (after !== undefined)
  return {
    recovered: [...recovered],
    pending: [...pending].map(([operationId, error]) => ({ operationId, error })),
  }
}

function serializeConsolidation<T>(run: () => Promise<T>): Promise<T> {
  const result = consolidationQueue.then(run, run)
  consolidationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

interface ConsolidateRoundInput {
  readonly group: AvailableWalletProofGroup
  readonly invocationId: string
  readonly roundIndex: number
  readonly secrets: WalletOpsSecrets
  readonly mutation: () => FencedStateMutation
  readonly dependencies: WalletOpsDependencies
  readonly wallets: Map<string, ExactProofConsolidationWallet>
}

type ConsolidateRoundOutcome =
  | {
      readonly kind: 'ready'
      readonly result: WalletProofConsolidationRoundResult
      readonly outputGroup: AvailableWalletProofGroup
    }
  | {
      readonly kind:
        | 'not-needed'
        | 'not-reducible'
        | 'fee-exhausted'
        | 'inactive-conditional-keyset'
    }

interface PreparedManualRound {
  readonly wallet: ExactProofConsolidationWallet
  readonly outputKeyset: MintKeys
  readonly inputFeePpk: number
  readonly exactInputs: Proof[]
  readonly plannedRound: ProofConsolidationRound
}

async function consolidateOneRound(input: ConsolidateRoundInput): Promise<ConsolidateRoundOutcome> {
  const planned = await prepareManualRound(input)
  if ('kind' in planned) return planned
  return executeManualRound(input, planned)
}

async function prepareManualRound(
  input: ConsolidateRoundInput,
): Promise<PreparedManualRound | Exclude<ConsolidateRoundOutcome, { kind: 'ready' }>> {
  const page = await readAvailableWalletProofPage({
    mintUrl: input.group.mintUrl,
    keysetId: input.group.keysetId,
    asset: input.group.asset,
    limit: WALLET_PROOF_CONSOLIDATION_INPUT_MAX,
  })
  const proofs = page.proofs.map(({ proof }) => toProof(proof))
  if (proofs.length < 2) return { kind: 'not-needed' }
  const wallet = await walletFor(
    input.group,
    input.secrets,
    input.dependencies,
    input.mutation,
    input.wallets,
  )
  const outputKeyset = await resolveOutputKeyset(input.group, wallet, input.dependencies)
  if (input.group.asset.kind === 'Outcome' && outputKeyset.id !== input.group.keysetId) {
    return { kind: 'inactive-conditional-keyset' }
  }
  const inputFeePpk = await resolveInputFeePpk(input.group, input.dependencies)
  const planned = planProofConsolidationRound({
    inventory: amountCounts(proofs),
    inputFeePpk,
    maxInputs: WALLET_PROOF_CONSOLIDATION_INPUT_MAX,
    keysetKeys: outputKeyset.keys,
  })
  if (planned.kind !== 'ready') return planned
  return {
    wallet,
    outputKeyset,
    inputFeePpk,
    exactInputs: selectPlannedInputs(proofs, planned.round),
    plannedRound: planned.round,
  }
}

async function executeManualRound(
  input: ConsolidateRoundInput,
  prepared: PreparedManualRound,
): Promise<Extract<ConsolidateRoundOutcome, { kind: 'ready' }>> {
  const operationId = manualRoundOperationId(input)
  const exactOperation = await prepareExactProofConsolidationOperation({
    operationId,
    bindingId: input.invocationId,
    purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
    mintUrl: input.group.mintUrl,
    unit: input.group.asset.unit,
    inputKeysetId: input.group.keysetId,
    outputKeysetId: prepared.outputKeyset.id,
    outputKeyset: prepared.outputKeyset,
    inputs: prepared.exactInputs,
    conditional: input.group.asset.kind === 'Outcome',
    inputFeePpk: prepared.inputFeePpk,
    plannedRound: prepared.plannedRound,
    seed: Buffer.from(input.secrets.walletSeedHex, 'hex'),
    counterSource: createDaemonCounterSource(input.mutation),
    wallet: prepared.wallet,
  })
  const validated = validateExactProofConsolidationOperation(exactOperation, {
    purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
  })
  const reservationId = `${operationId}:reservation`
  await persistManualRound(input, exactOperation, validated.outputs, reservationId)
  const proofs = await completeExactProofConsolidationOperation(validated, prepared.wallet, {
    purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
  })
  await completeAndFinalize(operationId, reservationId, proofs, input.group.asset, input.mutation)
  return manualRoundOutcome(input.group, prepared, operationId, proofs.length)
}

function manualRoundOperationId(input: Pick<ConsolidateRoundInput, 'invocationId' | 'roundIndex'>) {
  return `${WALLET_PROOF_CONSOLIDATION_PURPOSE}:${input.invocationId}:${input.roundIndex}`
}

async function persistManualRound(
  input: ConsolidateRoundInput,
  exactOperation: DurableCustodyProofOperationInput,
  outputs: ReturnType<typeof validateExactProofConsolidationOperation>['outputs'],
  reservationId: string,
): Promise<void> {
  await prepareProofOperationWithExactReservation(
    {
      operationId: exactOperation.operationId,
      kind: consolidationKind(exactOperation.kind),
      mintUrl: input.group.mintUrl,
      inputs: [...exactOperation.inputs],
      outputs: { consolidated: serializeOutputDataArray(outputs) },
      metadata: operationMetadata(exactOperation, input.group.asset, reservationId),
      reservationId,
      asset: input.group.asset,
    },
    input.mutation(),
  )
}

function manualRoundOutcome(
  group: AvailableWalletProofGroup,
  prepared: PreparedManualRound,
  operationId: string,
  outputCount: number,
): Extract<ConsolidateRoundOutcome, { kind: 'ready' }> {
  return {
    kind: 'ready',
    result: {
      operationId,
      mintUrl: group.mintUrl,
      unit: group.asset.unit,
      asset: group.asset,
      inputKeysetId: group.keysetId,
      outputKeysetId: prepared.outputKeyset.id,
      inputCount: prepared.exactInputs.length,
      outputCount,
      fee: Number(prepared.plannedRound.fee),
    },
    outputGroup: {
      mintUrl: group.mintUrl,
      keysetId: prepared.outputKeyset.id,
      asset: group.asset,
      proofCount: outputCount,
    },
  }
}

async function resolveInputFeePpk(
  group: AvailableWalletProofGroup,
  dependencies: WalletOpsDependencies,
): Promise<number> {
  const fees = await resolveCtfConsolidationInputFees(group.mintUrl, [group.keysetId], dependencies)
  const value = fees[group.keysetId]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`mint returned an invalid input fee for keyset ${group.keysetId}`)
  }
  return value
}

async function recoverOperation(
  entry: ProofOperationRecord,
  input: WalletProofConsolidationInput,
): Promise<void> {
  const exactOperation = persistedExactOperation(entry)
  const validated = validateExactProofConsolidationOperation(exactOperation, {
    purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
  })
  assertJournalMatchesExactOperation(entry, exactOperation, validated.outputs)
  const asset = persistedAsset(entry)
  const reservationId = metadataText(entry, 'reservationId')
  if (entry.state === 'completed') {
    await finalizeCompletedProofReservation(
      { operationId: entry.operationId, reservationId, resultGroup: 'consolidated', asset },
      input.mutation(),
    )
    return
  }
  if (entry.state !== 'prepared') throw new Error('proof consolidation operation has failed')
  const outcome = await recoverPreparedProofs(entry, validated, asset, input)
  if (outcome.kind === 'released') return
  await completeAndFinalize(entry.operationId, reservationId, outcome.proofs, asset, input.mutation)
}

type PreparedProofRecovery =
  | { readonly kind: 'proofs'; readonly proofs: readonly Proof[] }
  | { readonly kind: 'released' }

type RecoveryWallet = ExactProofConsolidationWallet & {
  checkProofsStates(proofs: Array<Pick<Proof, 'id' | 'secret'>>): Promise<ProofState[]>
}

async function recoverPreparedProofs(
  entry: ProofOperationRecord,
  validated: ReturnType<typeof validateExactProofConsolidationOperation>,
  asset: StoredProofAsset,
  input: WalletProofConsolidationInput,
): Promise<PreparedProofRecovery> {
  const wallets = new Map<string, ExactProofConsolidationWallet>()
  const wallet = await walletFor(
    {
      mintUrl: entry.mintUrl,
      keysetId: metadataText(entry, 'inputKeysetId'),
      asset,
      proofCount: entry.inputs.length,
    },
    input.secrets,
    input.dependencies ?? {},
    input.mutation,
    wallets,
  )
  const stateWallet = wallet as ExactProofConsolidationWallet & {
    checkProofsStates?: (proofs: Array<Pick<Proof, 'id' | 'secret'>>) => Promise<ProofState[]>
  }
  if (!stateWallet.checkProofsStates) {
    throw new Error('cashu wallet does not support proof-state recovery checks')
  }
  const states = await checkExactInputStates(stateWallet as RecoveryWallet, entry)
  return executeRecoveryDecision(entry, validated, stateWallet as RecoveryWallet, states, input)
}

async function executeRecoveryDecision(
  entry: ProofOperationRecord,
  validated: ReturnType<typeof validateExactProofConsolidationOperation>,
  wallet: RecoveryWallet,
  states: readonly ProofState[],
  input: WalletProofConsolidationInput,
): Promise<PreparedProofRecovery> {
  const decision = classifyCtfRangeSourceRecovery({
    journalKind: 'consolidation',
    journalState: 'prepared',
    inputStates: states.map(({ state }) => state),
    now: Math.floor(input.mutation().observedAtMs / 1_000),
  })
  switch (decision.kind) {
    case 'replay-exact-persisted-operation':
      return replayExactPreparedConsolidation(entry, validated, wallet, input)
    case 'restore-exact-persisted-outputs':
      return restorePersistedConsolidation(entry, validated, input)
    case 'remain-pending':
      throw new Error(`proof consolidation remains pending at the mint (${decision.reason})`)
    case 'fail':
      throw new Error(decision.reason)
    default:
      throw new Error('proof consolidation recovery decision is invalid')
  }
}

async function replayExactPreparedConsolidation(
  entry: ProofOperationRecord,
  validated: ReturnType<typeof validateExactProofConsolidationOperation>,
  wallet: RecoveryWallet,
  input: WalletProofConsolidationInput,
): Promise<PreparedProofRecovery> {
  try {
    return {
      kind: 'proofs',
      proofs: await completeExactProofConsolidationOperation(validated, wallet, {
        purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
      }),
    }
  } catch (error) {
    if (!(error instanceof MintOperationError)) throw error
    const postRejectionStates = await checkExactInputStates(wallet, entry)
    const disposition = classifyExactProofConsolidationReplayFailure({
      definiteMintRejection: true,
      inputStates: postRejectionStates.map(({ state }) => state),
    })
    if (disposition === 'release-exact-unspent-inputs') {
      await releasePreparedProofReservationFenced(
        {
          operationId: entry.operationId,
          reservationId: metadataText(entry, 'reservationId'),
          reason: definiteMintRejectionReason(error),
        },
        input.mutation(),
      )
      return { kind: 'released' }
    }
    const postRejectionDecision = classifyCtfRangeSourceRecovery({
      journalKind: 'consolidation',
      journalState: 'prepared',
      inputStates: postRejectionStates.map(({ state }) => state),
      now: Math.floor(input.mutation().observedAtMs / 1_000),
    })
    if (postRejectionDecision.kind === 'restore-exact-persisted-outputs') {
      return restorePersistedConsolidation(entry, validated, input)
    }
    throw new Error('proof consolidation remains pending after a rejected exact replay')
  }
}

function checkExactInputStates(
  wallet: RecoveryWallet,
  entry: ProofOperationRecord,
): Promise<ProofState[]> {
  const inputs = entry.inputs.map(({ id, secret }) => ({ id: metadataProofId(id), secret }))
  return checkCtfRangeInputProofStates(
    {
      check: async ({ Ys }) => {
        if (Ys.length !== inputs.length) {
          throw new Error('proof consolidation state request was unexpectedly split')
        }
        return { states: await wallet.checkProofsStates(inputs) }
      },
    },
    inputs,
  )
}

async function restorePersistedConsolidation(
  entry: ProofOperationRecord,
  validated: ReturnType<typeof validateExactProofConsolidationOperation>,
  input: WalletProofConsolidationInput,
): Promise<PreparedProofRecovery> {
  const restored = input.dependencies?.restoreOutputGroups
    ? await input.dependencies.restoreOutputGroups(entry.mintUrl, entry.outputs)
    : await restoreOutputGroups(entry.mintUrl, entry.outputs)
  return {
    kind: 'proofs',
    proofs: validateExactProofConsolidationProofs(validated, restored.consolidated, {
      purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
    }),
  }
}

function definiteMintRejectionReason(error: MintOperationError): string {
  const code = Number.isSafeInteger(error.code) ? String(error.code) : 'unknown'
  return `wallet-proof-consolidation-mint-rejected-${code}`
}

async function completeAndFinalize(
  operationId: string,
  reservationId: string,
  proofs: readonly Proof[],
  asset: StoredProofAsset,
  mutation: () => FencedStateMutation,
): Promise<void> {
  await markProofOperationCompletedFenced(operationId, { consolidated: [...proofs] }, mutation())
  await finalizeCompletedProofReservation(
    { operationId, reservationId, resultGroup: 'consolidated', asset },
    mutation(),
  )
}

async function walletFor(
  group: AvailableWalletProofGroup,
  secrets: WalletOpsSecrets,
  dependencies: WalletOpsDependencies,
  mutation: () => FencedStateMutation,
  cache: Map<string, ExactProofConsolidationWallet>,
): Promise<ExactProofConsolidationWallet> {
  const cacheKey = `${group.mintUrl}\0${group.asset.unit}`
  const cached = cache.get(cacheKey)
  if (cached) return cached
  const wallet = createWallet(
    group.mintUrl,
    secrets,
    dependencies,
    'sat',
    group.asset.unit,
    mutation,
  )
  await wallet.loadMint()
  const exact = requireExactWallet(wallet)
  cache.set(cacheKey, exact)
  return exact
}

async function resolveOutputKeyset(
  group: AvailableWalletProofGroup,
  wallet: ExactProofConsolidationWallet,
  dependencies: WalletOpsDependencies,
): Promise<MintKeys> {
  if (group.asset.kind === 'sats') {
    const getKeyset = (wallet as ExactProofConsolidationWallet & CashuWalletLike).getKeyset
    if (!getKeyset) throw new Error('cashu wallet does not expose its active keyset')
    const active = getKeyset.call(wallet)
    return validateOutputKeyset(
      { id: active.id, unit: group.asset.unit, keys: active.keys },
      group.asset.unit,
    )
  }
  const byCollection = await resolveCtfConsolidationOutputKeysets(
    group.mintUrl,
    group.asset.conditionId,
    dependencies,
  )
  const keysetId = byCollection[group.asset.outcomeSetId]
  if (!keysetId) throw new Error('mint has no active keyset for the proof outcome collection')
  const keysets = await resolveMintKeysByKeyset(group.mintUrl, [keysetId], dependencies)
  const keyset = keysets[keysetId]
  if (!keyset) throw new Error(`mint did not return keys for output keyset ${keysetId}`)
  return validateOutputKeyset(keyset, group.asset.unit, keysetId)
}

function requireExactWallet(wallet: CashuWalletLike): ExactProofConsolidationWallet {
  if (
    !wallet.prepareSwapToSend ||
    !wallet.completeSwap ||
    !wallet.prepareConditionalSwap ||
    !wallet.completeConditionalSwap
  ) {
    throw new Error('cashu wallet does not support exact proof consolidation')
  }
  return wallet as CashuWalletLike & ExactProofConsolidationWallet
}

function amountCounts(proofs: readonly Proof[]): Array<{ amount: string; count: number }> {
  const counts = new Map<number, number>()
  for (const proof of proofs) {
    const amount = amountToNumber(proof.amount)
    counts.set(amount, (counts.get(amount) ?? 0) + 1)
  }
  return [...counts].map(([amount, count]) => ({ amount: String(amount), count }))
}

function selectPlannedInputs(proofs: readonly Proof[], round: ProofConsolidationRound): Proof[] {
  const remaining = new Map<number, number>()
  for (const amount of round.inputs) {
    const value = Number(amount)
    remaining.set(value, (remaining.get(value) ?? 0) + 1)
  }
  const selected: Proof[] = []
  for (const proof of proofs) {
    const amount = amountToNumber(proof.amount)
    const needed = remaining.get(amount) ?? 0
    if (needed === 0) continue
    selected.push(proof)
    if (needed === 1) remaining.delete(amount)
    else remaining.set(amount, needed - 1)
  }
  if (remaining.size > 0 || selected.length !== round.inputs.length) {
    throw new Error('available proof page differs from the consolidation plan')
  }
  return selected
}

function operationMetadata(
  exactOperation: DurableCustodyProofOperationInput,
  asset: StoredProofAsset,
  reservationId: string,
): Record<string, unknown> {
  return {
    purpose: WALLET_PROOF_CONSOLIDATION_PURPOSE,
    bindingId: exactOperation.metadata?.bindingId,
    reservationId,
    unit: asset.unit,
    inputKeysetId: exactOperation.metadata?.inputKeysetId,
    outputKeysetId: exactOperation.metadata?.keysetId,
    assetKind: asset.kind,
    baseAsset: asset.baseAsset,
    conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
    outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
    exactOperation: structuredClone(exactOperation),
  }
}

function persistedExactOperation(entry: ProofOperationRecord): DurableCustodyProofOperationInput {
  const value = entry.metadata.exactOperation
  if (typeof value !== 'object' || value === null) {
    throw new Error('proof consolidation exact operation is missing')
  }
  return value as DurableCustodyProofOperationInput
}

function assertJournalMatchesExactOperation(
  entry: ProofOperationRecord,
  exact: DurableCustodyProofOperationInput,
  outputs: ReturnType<typeof validateExactProofConsolidationOperation>['outputs'],
): void {
  if (
    entry.operationId !== exact.operationId ||
    entry.kind !== exact.kind ||
    entry.mintUrl !== exact.mintUrl
  ) {
    throw new Error('proof consolidation journal identity differs from its exact operation')
  }
  if (
    entry.metadata.purpose !== exact.metadata?.purpose ||
    metadataText(entry, 'bindingId') !== exact.metadata?.bindingId ||
    entry.metadata.unit !== exact.metadata?.unit ||
    metadataText(entry, 'inputKeysetId') !== exact.metadata?.inputKeysetId ||
    metadataText(entry, 'outputKeysetId') !== exact.metadata?.keysetId ||
    metadataText(entry, 'reservationId') !== `${entry.operationId}:reservation`
  ) {
    throw new Error('proof consolidation journal metadata differs from its exact operation')
  }
  if (!isDeepStrictEqual(entry.inputs, exact.inputs)) {
    throw new Error('proof consolidation journal inputs differ from its exact operation')
  }
  if (!isDeepStrictEqual(entry.outputs, { consolidated: serializeOutputDataArray(outputs) })) {
    throw new Error('proof consolidation journal outputs differ from its exact operation')
  }
}

function persistedAsset(entry: ProofOperationRecord): StoredProofAsset {
  if (
    entry.metadata.baseAsset !== 'sat' ||
    (entry.metadata.unit !== 'sat' && entry.metadata.unit !== 'msat')
  ) {
    throw new Error('proof consolidation asset is invalid')
  }
  if (entry.metadata.assetKind === 'sats') {
    if (entry.metadata.conditionId !== null || entry.metadata.outcomeSetId !== null) {
      throw new Error('proof consolidation asset is invalid')
    }
    return { kind: 'sats', baseAsset: 'sat', unit: entry.metadata.unit }
  }
  if (entry.metadata.assetKind !== 'Outcome' || entry.metadata.unit !== 'msat') {
    throw new Error('proof consolidation asset is invalid')
  }
  return {
    kind: 'Outcome',
    conditionId: metadataText(entry, 'conditionId'),
    outcomeSetId: metadataText(entry, 'outcomeSetId'),
    baseAsset: 'sat',
    unit: 'msat',
  }
}

function metadataText(entry: ProofOperationRecord, field: string): string {
  const value = entry.metadata[field]
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
    throw new Error(`proof consolidation ${field} is invalid`)
  }
  return value
}

function metadataProofId(value: string | undefined): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error('proof consolidation input keyset is invalid')
  }
  return value
}

function toProof(value: ProofOperationRecord['inputs'][number]): Proof {
  return {
    id: metadataProofId(value.id),
    amount: Amount.from(amountToNumber(value.amount)),
    secret: metadataTextValue(value.secret, 'proof secret'),
    C: metadataTextValue(value.C, 'proof signature'),
    ...(value.dleq === undefined ? {} : { dleq: structuredClone(value.dleq) as Proof['dleq'] }),
    ...(value.p2pk_e === undefined ? {} : { p2pk_e: value.p2pk_e }),
    ...(value.witness === undefined
      ? {}
      : { witness: structuredClone(value.witness) as Proof['witness'] }),
  }
}

function metadataTextValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
    throw new Error(`proof consolidation ${label} is invalid`)
  }
  return value
}

function consolidationKind(value: unknown): 'proof-consolidation' {
  if (value === 'proof-consolidation') return value
  throw new Error('proof consolidation operation kind is invalid')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateOutputKeyset(
  value: MintKeys,
  expectedUnit: 'sat' | 'msat',
  expectedId?: string,
): MintKeys {
  const entries = Object.entries(value.keys)
  if (
    value.id.length < 1 ||
    (expectedId !== undefined && value.id !== expectedId) ||
    value.unit !== expectedUnit ||
    entries.length < 1 ||
    entries.some(
      ([amount, key]) => !/^[1-9][0-9]*$/.test(amount) || typeof key !== 'string' || key.length < 1,
    )
  ) {
    throw new Error('mint output keyset is invalid')
  }
  return value
}

class GroupQueue {
  readonly #groups: AvailableWalletProofGroup[] = []
  readonly #scheduled = new Set<string>()

  constructor(groups: readonly AvailableWalletProofGroup[]) {
    for (const group of groups) this.add(group)
  }

  get length(): number {
    return this.#groups.length
  }

  add(group: AvailableWalletProofGroup): void {
    const key = groupKey(group)
    if (this.#scheduled.has(key)) return
    this.#scheduled.add(key)
    this.#groups.push(group)
  }

  take(): AvailableWalletProofGroup | undefined {
    const group = this.#groups.shift()
    if (group) this.#scheduled.delete(groupKey(group))
    return group
  }
}

function groupKey(group: AvailableWalletProofGroup): string {
  return JSON.stringify([
    group.mintUrl,
    group.asset.unit,
    group.asset.kind,
    group.asset.kind === 'Outcome' ? group.asset.conditionId : null,
    group.asset.kind === 'Outcome' ? group.asset.outcomeSetId : null,
    group.keysetId,
  ])
}
