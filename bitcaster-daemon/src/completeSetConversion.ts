import {
  createSpeculativeCounterTranscript,
  type SpeculativeCounterTranscript,
} from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { profileDir } from './profile.ts'
import { isDeepStrictEqual } from 'node:util'
import { type CounterSource, type MintKeys, type Proof } from '@cashu/cashu-ts'
import {
  CashuMintCtfSplitTransport,
  resumeExactPersistedCtfSplit,
  splitCompleteSetWithOperation,
  splitRegularProofsWithOperation,
  type CtfPrepareProofOperationInput,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
  type CtfSplitTransport,
} from '@bitcaster-market/client-sdk/ctfSplit'
import type { DaemonSecrets } from './secrets.ts'
import {
  COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT,
  assertPreparedProofOperationDispatchFenced,
  completeCompleteSetCtfProofOperationFenced,
  completeRegularSplitWithCompleteSetHandoffFenced,
  prepareCompleteSetCtfProofOperationFromDatabase,
  prepareCompleteSetRegularProofOperationFromDatabase,
  readCompleteSetRecoveryRootFromDatabase,
  readDaemonProofOperationFromDatabase,
  readDaemonReservedWalletProofsFromDatabase,
  readDaemonCounterSnapshots,
  commitDaemonCounterTranscript,
  DaemonCounterSnapshotConflictError,
  assertExactProofReservationFromDatabase,
  readAvailableWalletProofsFenced,
  readProofOperationFenced,
  readRecoverableCompleteSetProofOperationPage,
  type CashuProofRecord,
  type CompleteSetHandoffAuthority,
  type RecoverableCompleteSetRecoveryRoot,
  type CompleteSetRecoveryRoot,
  type ExactProofOperationAuthority,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
} from './state.ts'
import {
  createDaemonCounterSource,
  splitAvailableMsatProofsForCtfCollateral,
  type CashuWalletLike,
  type CtfCollateralOperationAuthority,
  type WalletOpsDependencies,
} from './walletOps.ts'

const DAEMON_COMPLETE_SET_REGULAR_SPLIT_PURPOSE = 'daemon-complete-set-regular-split'
const DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE = 'daemon-complete-set-ctf-split'

type CompleteSetCtfResumeDependencies = {
  readonly proofStateChecker?: Pick<CashuWalletLike, 'checkProofsStates'>
  readonly restoreOutputGroups?: (
    mintUrl: string,
    outputs: Record<string, StoredOutputData[]>,
  ) => Promise<Record<string, Proof[]>>
}

type CompleteSetDependencies = WalletOpsDependencies & {
  readonly observeCompleteSetPrepared?: (
    stage: 'regular' | 'ctf',
    draft: Readonly<CtfPrepareProofOperationInput>,
  ) => Promise<void>
  readonly injectCompleteSetFault?: (
    stage: 'regular' | 'ctf',
    phase: 'counter-written' | 'journal-bound',
  ) => void
  readonly createCtfSplitTransport?: (mintUrl: string) => CtfSplitTransport
  readonly createCtfResumeDependencies?: (mintUrl: string) => CompleteSetCtfResumeDependencies
}

type CompleteSetSplitInput = {
  mintUrl: string
  conditionId: string
  amountMsat: number
  operationId: string
  secrets: DaemonSecrets | null
  deps: CompleteSetDependencies
  recoveryReference?: RecoverableCompleteSetRecoveryRoot
}

type CompleteSetSplitResult = {
  operationId: string
  conditionId: string
  amountMsat: number
  outcomeProofCounts: Record<string, number>
}

export function createDaemonCompleteSetOutputMode(input: {
  readonly walletSeedHex: string
  readonly deps: Pick<WalletOpsDependencies, 'getCustodyFence'>
  readonly mintUrl: string
  readonly counterSource?: CounterSource
}) {
  if (!input.deps.getCustodyFence) {
    throw new Error('complete-set conversion requires custody authority')
  }
  const getCustodyFence = input.deps.getCustodyFence
  return {
    kind: 'seed-derived' as const,
    seed: Buffer.from(input.walletSeedHex, 'hex'),
    counterSource:
      input.counterSource ??
      createDaemonCounterSource(() => ({ fence: getCustodyFence(), observedAtMs: Date.now() }), {
        normalizedMint: input.mintUrl,
        unit: 'msat',
      }),
  }
}

export async function splitWalletCompleteSet(
  input: CompleteSetSplitInput,
): Promise<CompleteSetSplitResult> {
  if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat <= 0) {
    throw new Error('amountMsat must be a positive safe integer')
  }
  if (!input.secrets) throw new Error('daemon secrets are not initialized')
  const inputWithSecrets = { ...input, secrets: input.secrets }
  const mutation = requireCompleteSetCustodyMutation(input.deps)
  const collateralAsset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
  const recoveredOperation =
    input.recoveryReference === undefined
      ? null
      : await readAndValidateRecoveryOperation(input, mutation)
  const existingCtf =
    recoveredOperation?.operationId === `${input.operationId}:ctf-split`
      ? recoveredOperation
      : await readInitialCtfOperation(input, mutation)
  if (existingCtf !== null) {
    return resumeExistingCompleteSetSplit(inputWithSecrets, mutation, collateralAsset, existingCtf)
  }
  return startCompleteSetSplit(inputWithSecrets, mutation, collateralAsset)
}

async function startCompleteSetSplit(
  input: CompleteSetSplitInput & { secrets: DaemonSecrets },
  mutation: () => FencedStateMutation,
  collateralAsset: StoredProofAsset,
): Promise<CompleteSetSplitResult> {
  const ctfReservationId = `${input.operationId}:ctf-split:reservation`
  const collateral = await splitCompleteSetCollateral(
    input,
    mutation,
    collateralAsset,
    ctfReservationId,
  )
  const rawTransport = createCtfSplitTransport(input.deps, input.mintUrl)
  const outcomeCollectionKeysets = structuredClone(
    await rawTransport.getRootPartitionKeysets(input.conditionId),
  )
  const transport = pinPreparationKeysets(rawTransport)
  for (let attempt = 0; attempt < 3; attempt++) {
    const counters = createStageCounters(
      Object.values(outcomeCollectionKeysets),
      input.mintUrl,
      mutation,
    )
    const ctfAuthority = createFencedCompleteSetProofOperationStore({
      kind: 'ctf',
      mintUrl: input.mintUrl,
      operationId: `${input.operationId}:ctf-split`,
      reservationId: ctfReservationId,
      inputAsset: collateralAsset,
      successorAssets: outcomeSuccessorAssets(input.conditionId, outcomeCollectionKeysets),
      context: completeSetOperationContext(input),
      root: completeSetRecoveryRoot(input),
      mutation,
      atomic: { counters, deps: input.deps },
    })
    try {
      const proofsByCollection = await splitCompleteSetWithOperation({
        mintUrl: input.mintUrl,
        baseAsset: 'sat',
        operationId: `${input.operationId}:ctf-split`,
        transport,
        conditionId: input.conditionId,
        collateralProofs: collateral.inputs,
        outcomeCollectionKeysets,
        amountSubunits: input.amountMsat,
        proofOperationStore: ctfAuthority.store,
        beforeMintMutation: ctfAuthority.beforeMintMutation,
        outputMode: createDaemonCompleteSetOutputMode({
          walletSeedHex: input.secrets.walletSeedHex,
          deps: input.deps,
          mintUrl: input.mintUrl,
          counterSource: counters.source,
        }),
      })
      return completeSetResponse(input, proofsByCollection)
    } catch (error) {
      if (
        error instanceof CompleteSetSavedPreparation &&
        error.operationId === `${input.operationId}:ctf-split`
      ) {
        const saved = await ctfAuthority.store.getProofOperation(error.operationId)
        if (!saved) throw new Error('saved complete-set CTF operation disappeared')
        return resumeExistingCompleteSetSplit(
          input,
          mutation,
          collateralAsset,
          saved as ProofOperationRecord,
        )
      }
      if (
        error instanceof CompleteSetCounterRetry &&
        error.operationId === `${input.operationId}:ctf-split` &&
        attempt < 2
      )
        continue
      throw error
    }
  }
  throw new Error('complete-set CTF preparation attempts exhausted')
}

async function splitCompleteSetCollateral(
  input: CompleteSetSplitInput & { secrets: DaemonSecrets },
  mutation: () => FencedStateMutation,
  collateralAsset: StoredProofAsset,
  ctfReservationId: string,
) {
  let attached: CounterSource | undefined
  const regularCounterSource: CounterSource = {
    reserve: (id, count) => {
      if (!attached) throw new Error('regular counter transcript is not attached')
      return attached.reserve(id, count)
    },
    advanceToAtLeast: (id, next) => {
      if (!attached) throw new Error('regular counter transcript is not attached')
      return attached.advanceToAtLeast(id, next)
    },
  }
  let counters: StageCounters | undefined
  const regularAuthority = createFencedCompleteSetProofOperationStore({
    kind: 'regular-handoff',
    mintUrl: input.mintUrl,
    operationId: `${input.operationId}:regular-split`,
    reservationId: `${input.operationId}:regular-split:reservation`,
    inputAsset: collateralAsset,
    successorAssets: { send: collateralAsset, keep: collateralAsset },
    context: completeSetOperationContext(input),
    root: completeSetRecoveryRoot(input),
    ctfHandoffAuthority: { reservationId: ctfReservationId, inputAsset: collateralAsset },
    mutation,
    atomic: {
      counters: {
        source: regularCounterSource,
        transcript: () => {
          if (!counters) throw new Error('regular counter transcript is absent')
          return counters.transcript()
        },
      },
      deps: input.deps,
    },
  })
  const authority = createCompleteSetCollateralOperationAuthority(
    regularAuthority,
    collateralAsset,
    mutation,
  )
  return splitAvailableMsatProofsForCtfCollateral(
    input.amountMsat,
    input.mintUrl,
    `${input.operationId}:regular-split`,
    input.secrets,
    input.deps,
    'sat',
    {
      ...authority,
      regularCounterSource,
      prepareRegularSplit: async (selected) => {
        const keyset = selected.wallet.getKeyset?.()
        if (!keyset || keyset.unit !== 'msat')
          throw new Error('complete-set regular output keyset is invalid')
        const pinnedWallet = {
          getKeyset: (id?: string) => selected.wallet.getKeyset!(id ?? keyset.id),
          prepareSwapToSend: selected.wallet.prepareSwapToSend!.bind(selected.wallet),
          completeSwap: selected.wallet.completeSwap!.bind(selected.wallet),
          checkProofsStates: selected.wallet.checkProofsStates?.bind(selected.wallet),
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          counters = createStageCounters([keyset.id], input.mintUrl, mutation)
          attached = counters.source
          try {
            return await splitRegularProofsWithOperation({
              mintUrl: input.mintUrl,
              baseAsset: 'sat',
              operationId: `${input.operationId}:regular-split`,
              wallet: pinnedWallet,
              proofs: [...selected.proofs],
              amountSubunits: selected.amountSubunits,
              proofOperationStore: authority.proofOperationStore,
              beforeMintMutation: authority.beforeMintMutation,
              deterministicPreparation: { seed: Buffer.from(input.secrets.walletSeedHex, 'hex') },
            })
          } catch (error) {
            if (
              error instanceof CompleteSetSavedPreparation &&
              error.operationId === `${input.operationId}:regular-split`
            )
              return splitRegularProofsWithOperation({
                mintUrl: input.mintUrl,
                baseAsset: 'sat',
                operationId: error.operationId,
                wallet: pinnedWallet,
                proofs: [],
                amountSubunits: selected.amountSubunits,
                proofOperationStore: authority.proofOperationStore,
                beforeMintMutation: authority.beforeMintMutation,
              })
            if (
              error instanceof CompleteSetCounterRetry &&
              error.operationId === `${input.operationId}:regular-split` &&
              attempt < 2
            )
              continue
            throw error
          }
        }
        throw new Error('complete-set regular preparation attempts exhausted')
      },
    },
  )
}

async function resumeExistingCompleteSetSplit(
  input: CompleteSetSplitInput & { secrets: DaemonSecrets },
  mutation: () => FencedStateMutation,
  collateralAsset: StoredProofAsset,
  operation: ProofOperationRecord,
): Promise<CompleteSetSplitResult> {
  const existing = requireExistingCompleteSetSplit(operation, input)
  const savedConfig: FencedCompleteSetProofOperationConfig = {
    kind: 'ctf',
    mintUrl: input.mintUrl,
    operationId: existing.operationId,
    reservationId: `${input.operationId}:ctf-split:reservation`,
    inputAsset: collateralAsset,
    successorAssets: outcomeSuccessorAssets(input.conditionId, existing.outcomeCollectionKeysets),
    context: completeSetOperationContext(input),
    root: completeSetRecoveryRoot(input),
    mutation,
  }
  const coherent = await readSavedCompleteSetOperation(savedConfig)
  if (!coherent || !isDeepStrictEqual(coherent, operation))
    throw new Error('complete-set saved CTF operation changed')
  if (existing.state === 'completed') return completeSetResponse(input, existing.resultProofs ?? {})
  const transport = createCtfSplitTransport(input.deps, input.mintUrl)
  const resumeDependencies = input.deps.createCtfResumeDependencies?.(input.mintUrl)
  const ctfAuthority = createFencedCompleteSetProofOperationStore({
    kind: 'ctf',
    mintUrl: input.mintUrl,
    operationId: existing.operationId,
    reservationId: `${input.operationId}:ctf-split:reservation`,
    inputAsset: collateralAsset,
    successorAssets: outcomeSuccessorAssets(input.conditionId, existing.outcomeCollectionKeysets),
    context: completeSetOperationContext(input),
    root: completeSetRecoveryRoot(input),
    mutation,
  })
  const proofsByCollection = await resumeExactPersistedCtfSplit({
    mintUrl: input.mintUrl,
    operationId: existing.operationId,
    conditionId: input.conditionId,
    collateralProofs: existing.inputs as Proof[],
    amountSubunits: input.amountMsat,
    baseAsset: 'sat',
    transport,
    proofOperationStore: ctfAuthority.store,
    proofStateChecker: resumeDependencies?.proofStateChecker,
    restoreOutputGroups: resumeDependencies?.restoreOutputGroups,
    outputMode: createDaemonCompleteSetOutputMode({
      walletSeedHex: input.secrets.walletSeedHex,
      deps: input.deps,
      mintUrl: input.mintUrl,
    }),
    beforeMintMutation: ctfAuthority.beforeMintMutation,
  })
  return completeSetResponse(input, proofsByCollection)
}

function completeSetResponse(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountMsat'>,
  proofsByCollection: Record<string, CashuProofRecord[]>,
): CompleteSetSplitResult {
  return {
    operationId: input.operationId,
    conditionId: input.conditionId,
    amountMsat: input.amountMsat,
    outcomeProofCounts: Object.fromEntries(
      Object.entries(proofsByCollection).map(([outcome, proofs]) => [outcome, proofs.length]),
    ),
  }
}

function completeSetOperationContext(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountMsat'>,
): Record<string, string | number> {
  return {
    rootOperationId: input.operationId,
    conditionId: input.conditionId,
    amountMsat: input.amountMsat,
  }
}

function completeSetRecoveryRoot(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountMsat' | 'mintUrl'>,
): CompleteSetRecoveryRoot {
  return {
    rootOperationId: input.operationId,
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    amountMsat: input.amountMsat,
    regularOperationId: `${input.operationId}:regular-split`,
    ctfOperationId: null,
  }
}

function requireExistingCompleteSetSplit(
  operation: ProofOperationRecord,
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountMsat'>,
): {
  operationId: string
  state: ProofOperationRecord['state']
  inputs: CashuProofRecord[]
  outcomeCollectionKeysets: Record<string, string>
  resultProofs?: Record<string, CashuProofRecord[]>
} {
  const metadata = operation.metadata
  if (
    operation.kind !== 'ctf-split' ||
    operation.operationId !== `${input.operationId}:ctf-split` ||
    operation.mintUrl !== input.mintUrl ||
    metadata.purpose !== DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE ||
    metadata.rootOperationId !== input.operationId ||
    metadata.conditionId !== input.conditionId ||
    metadata.amountMsat !== input.amountMsat ||
    metadata.amountSubunits !== input.amountMsat ||
    metadata.reservationId !== `${input.operationId}:ctf-split:reservation` ||
    !isCollateralMsatAsset(metadata.inputAsset) ||
    !isStringRecord(metadata.outcomeCollectionKeysets) ||
    !hasExactCompleteSetSuccessorAuthority(
      metadata.successorAssets,
      input.conditionId,
      true,
      metadata.outcomeCollectionKeysets,
    )
  ) {
    throw new Error('complete-set CTF recovery operation is incompatible')
  }
  return {
    operationId: operation.operationId,
    state: operation.state,
    inputs: operation.inputs,
    outcomeCollectionKeysets: metadata.outcomeCollectionKeysets,
    resultProofs: operation.resultProofs,
  }
}

async function readAndValidateRecoveryOperation(
  input: CompleteSetSplitInput,
  mutation: () => FencedStateMutation,
): Promise<ProofOperationRecord> {
  const reference = input.recoveryReference!
  const operation = await readProofOperationFenced(reference.operationId, mutation())
  if (operation === null) throw new Error('complete-set recovery operation is absent')
  assertExactCompleteSetRecoveryAuthority(input, reference, operation)
  return operation
}

function assertExactCompleteSetRecoveryAuthority(
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountMsat'>,
  reference: RecoverableCompleteSetRecoveryRoot,
  operation: ProofOperationRecord,
): void {
  const isCtf = reference.rootState === 'ctf-prepared'
  if (
    !recoveryReferenceMatchesInput(input, reference, isCtf) ||
    !recoveryOperationMatchesReference(input, reference, operation, isCtf)
  ) {
    throw new Error('complete-set recovery operation is incompatible')
  }
}

function recoveryReferenceMatchesInput(
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountMsat'>,
  reference: RecoverableCompleteSetRecoveryRoot,
  isCtf: boolean,
): boolean {
  const root = reference.root
  const expectedOperationId = `${input.operationId}:${isCtf ? 'ctf' : 'regular'}-split`
  const expectedPurpose = isCtf
    ? DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE
    : DAEMON_COMPLETE_SET_REGULAR_SPLIT_PURPOSE
  const expectedState = isCtf
    ? 'prepared'
    : reference.rootState === 'ctf-handoff'
      ? 'completed'
      : 'prepared'
  return !(
    root.rootOperationId !== input.operationId ||
    root.mintUrl !== input.mintUrl ||
    root.conditionId !== input.conditionId ||
    root.amountMsat !== input.amountMsat ||
    (isCtf
      ? root.ctfOperationId !== expectedOperationId
      : root.regularOperationId !== expectedOperationId) ||
    reference.operationId !== expectedOperationId ||
    reference.operationKind !== (isCtf ? 'ctf-split' : 'regular-split') ||
    reference.operationPurpose !== expectedPurpose ||
    reference.operationState !== expectedState ||
    reference.reservationId !== `${expectedOperationId}:reservation` ||
    reference.mintUrl !== input.mintUrl
  )
}

function recoveryOperationMatchesReference(
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountMsat'>,
  reference: RecoverableCompleteSetRecoveryRoot,
  operation: ProofOperationRecord,
  isCtf: boolean,
): boolean {
  const expectedOperationId = `${input.operationId}:${isCtf ? 'ctf' : 'regular'}-split`
  const expectedPurpose = isCtf
    ? DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE
    : DAEMON_COMPLETE_SET_REGULAR_SPLIT_PURPOSE
  const metadata = operation.metadata
  return !(
    operation.operationId !== expectedOperationId ||
    operation.kind !== reference.operationKind ||
    operation.state !== reference.operationState ||
    operation.mintUrl !== input.mintUrl ||
    metadata.purpose !== expectedPurpose ||
    metadata.rootOperationId !== input.operationId ||
    metadata.conditionId !== input.conditionId ||
    metadata.amountMsat !== input.amountMsat ||
    (isCtf && metadata.amountSubunits !== input.amountMsat) ||
    metadata.reservationId !== reference.reservationId ||
    !isCollateralMsatAsset(metadata.inputAsset) ||
    !hasExactCompleteSetSuccessorAuthority(
      metadata.successorAssets,
      input.conditionId,
      isCtf,
      isCtf ? metadata.outcomeCollectionKeysets : undefined,
    )
  )
}

function isCollateralMsatAsset(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as StoredProofAsset).kind === 'sats' &&
    (value as StoredProofAsset).baseAsset === 'sat' &&
    (value as StoredProofAsset).unit === 'msat'
  )
}

function hasExactCompleteSetSuccessorAuthority(
  value: unknown,
  conditionId: string,
  isCtf: boolean,
  outcomeCollectionKeysets: unknown,
): boolean {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  if (!isCtf) {
    return (
      entries.length === 2 &&
      entries.every(
        ([group, asset]) => (group === 'send' || group === 'keep') && isCollateralMsatAsset(asset),
      )
    )
  }
  return (
    isStringRecord(outcomeCollectionKeysets) &&
    entries.length > 0 &&
    entries.length === Object.keys(outcomeCollectionKeysets).length &&
    entries.every(
      ([outcomeSetId, asset]) =>
        Object.hasOwn(outcomeCollectionKeysets, outcomeSetId) &&
        typeof asset === 'object' &&
        asset !== null &&
        (asset as StoredProofAsset).kind === 'Outcome' &&
        (asset as Extract<StoredProofAsset, { kind: 'Outcome' }>).conditionId === conditionId &&
        (asset as Extract<StoredProofAsset, { kind: 'Outcome' }>).outcomeSetId === outcomeSetId &&
        (asset as StoredProofAsset).baseAsset === 'sat' &&
        (asset as StoredProofAsset).unit === 'msat',
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, entry]) => key.length > 0 && typeof entry === 'string' && entry.length > 0,
    )
  )
}

export async function recoverCompleteSetSplits(input: {
  readonly secrets: DaemonSecrets
  readonly deps: CompleteSetDependencies
}): Promise<{
  recovered: string[]
  recoveredCount: number
  pending: Array<{ operationId: string; error: string }>
}> {
  if (!input.deps.getCustodyFence) return { recovered: [], recoveredCount: 0, pending: [] }
  return recoverCompleteSetRecoveryPages({
    readPage: () =>
      readRecoverableCompleteSetProofOperationPage({
        regularPurpose: DAEMON_COMPLETE_SET_REGULAR_SPLIT_PURPOSE,
        ctfPurpose: DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE,
        limit: COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT,
      }),
    recoverRoot: async (recoveryReference) => {
      const root = recoveryReference.root
      await splitWalletCompleteSet({
        mintUrl: root.mintUrl,
        conditionId: root.conditionId,
        amountMsat: root.amountMsat,
        operationId: root.rootOperationId,
        secrets: input.secrets,
        deps: input.deps,
        recoveryReference,
      })
    },
  })
}

export async function recoverCompleteSetRecoveryPages<
  RecoveryReference extends { readonly root: Pick<CompleteSetRecoveryRoot, 'rootOperationId'> },
>(input: {
  readonly readPage: () => Promise<{
    readonly roots: readonly RecoveryReference[]
    readonly hasMore: boolean
  }>
  readonly recoverRoot: (recoveryReference: RecoveryReference) => Promise<void>
}): Promise<{
  recovered: string[]
  recoveredCount: number
  pending: Array<{ operationId: string; error: string }>
}> {
  const recovered: string[] = []
  const pending: Array<{ operationId: string; error: string }> = []
  let recoveredCount = 0
  for (;;) {
    const page = await input.readPage()
    for (const recoveryReference of page.roots) {
      try {
        await input.recoverRoot(recoveryReference)
        recoveredCount += 1
        if (recovered.length < COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT) {
          recovered.push(recoveryReference.root.rootOperationId)
        }
      } catch (error) {
        pending.push({
          operationId: recoveryReference.root.rootOperationId,
          error: errorMessage(error),
        })
        return { recovered, recoveredCount, pending }
      }
    }
    if (!page.hasMore) return { recovered, recoveredCount, pending }
  }
}

function createCtfSplitTransport(
  deps: CompleteSetDependencies,
  mintUrl: string,
): CtfSplitTransport {
  return deps.createCtfSplitTransport?.(mintUrl) ?? new CashuMintCtfSplitTransport(mintUrl)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireCompleteSetCustodyMutation(
  deps: Pick<WalletOpsDependencies, 'getCustodyFence'>,
): () => FencedStateMutation {
  if (!deps.getCustodyFence) {
    throw new Error('complete-set conversion requires custody authority')
  }
  return () => ({ fence: deps.getCustodyFence!(), observedAtMs: Date.now() })
}

function createCompleteSetCollateralOperationAuthority(
  authority: FencedCompleteSetProofOperationStore,
  asset: StoredProofAsset,
  mutation: () => FencedStateMutation,
): CtfCollateralOperationAuthority {
  return {
    proofOperationStore: authority.store,
    beforeMintMutation: authority.beforeMintMutation,
    readAvailableProofs: async () =>
      (
        await readAvailableWalletProofsFenced({
          mintUrl: authority.mintUrl,
          asset,
          mutation: mutation(),
        })
      ).map((record) => record.proof as Proof),
  }
}

interface FencedCompleteSetProofOperationStore {
  readonly mintUrl: string
  readonly authority: ExactProofOperationAuthority
  readonly store: CtfProofOperationStore
  readonly beforeMintMutation: () => Promise<void>
}

type FencedCompleteSetProofOperationConfig = {
  readonly atomic?: { readonly counters: StageCounters; readonly deps: CompleteSetDependencies }
} & (
  | {
      readonly kind: 'regular-handoff'
      readonly mintUrl: string
      readonly operationId: string
      readonly reservationId: string
      readonly inputAsset: StoredProofAsset
      readonly successorAssets: Readonly<Record<string, StoredProofAsset>>
      readonly context: Readonly<Record<string, unknown>>
      readonly root: CompleteSetRecoveryRoot
      readonly ctfHandoffAuthority: CompleteSetHandoffAuthority
      readonly mutation: () => FencedStateMutation
    }
  | {
      readonly kind: 'ctf'
      readonly mintUrl: string
      readonly operationId: string
      readonly reservationId: string
      readonly inputAsset: StoredProofAsset
      readonly successorAssets: Readonly<Record<string, StoredProofAsset>>
      readonly context: Readonly<Record<string, unknown>>
      readonly root: CompleteSetRecoveryRoot
      readonly mutation: () => FencedStateMutation
    }
)

function createFencedCompleteSetProofOperationStore(
  input: FencedCompleteSetProofOperationConfig,
): FencedCompleteSetProofOperationStore {
  const authority = createCompleteSetOperationAuthority(input)
  return {
    mintUrl: input.mintUrl,
    authority,
    store: {
      getProofOperation: async (operationId) => {
        assertCompleteSetOperationId(operationId, input.operationId)
        return asCtfProofOperation(await readSavedCompleteSetOperation(input))
      },
      prepareProofOperation: async (operation) =>
        prepareCompleteSetProofOperation(operation, input),
      markProofOperationCompleted: async (operationId, completion) =>
        completeCompleteSetProofOperation(operationId, completion, authority, input),
    },
    beforeMintMutation: async () => {
      const saved = await readSavedCompleteSetOperation(input)
      if (!saved || saved.state !== 'prepared')
        throw new Error('complete-set prepared operation is absent')
      await assertPreparedProofOperationDispatchFenced(
        input.operationId,
        authority,
        input.mutation(),
      )
    },
  }
}

function createCompleteSetOperationAuthority(
  input: FencedCompleteSetProofOperationConfig,
): ExactProofOperationAuthority {
  return {
    purpose:
      input.kind === 'regular-handoff'
        ? DAEMON_COMPLETE_SET_REGULAR_SPLIT_PURPOSE
        : DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE,
    reservationId: input.reservationId,
    inputAsset: input.inputAsset,
    successorAssets: input.successorAssets,
  }
}

async function completeCompleteSetProofOperation(
  operationId: string,
  completion: Parameters<CtfProofOperationStore['markProofOperationCompleted']>[1],
  authority: ExactProofOperationAuthority,
  input: FencedCompleteSetProofOperationConfig,
): Promise<CtfProofOperationRecord> {
  assertCompleteSetOperationId(operationId, input.operationId)
  const mutation = input.mutation()
  if (input.kind === 'regular-handoff') {
    return requireCtfProofOperation(
      await completeRegularSplitWithCompleteSetHandoffFenced(
        {
          operationId,
          completion,
          regularAuthority: authority,
          ctfAuthority: input.ctfHandoffAuthority,
          root: input.root,
        },
        mutation,
      ),
    )
  }
  return requireCtfProofOperation(
    await completeCompleteSetCtfProofOperationFenced(
      { operationId, completion, authority, root: input.root },
      mutation,
    ),
  )
}

function assertCompleteSetOperationId(operationId: string, expectedOperationId: string): void {
  if (operationId !== expectedOperationId) {
    throw new Error('complete-set proof operation id is incompatible')
  }
}

async function prepareCompleteSetProofOperation(
  operation: CtfPrepareProofOperationInput,
  input: FencedCompleteSetProofOperationConfig,
): Promise<CtfProofOperationRecord> {
  assertCompleteSetOperationId(operation.operationId, input.operationId)
  const exactInput = {
    ...operation,
    metadata: {
      ...operation.metadata,
      purpose:
        input.kind === 'regular-handoff'
          ? DAEMON_COMPLETE_SET_REGULAR_SPLIT_PURPOSE
          : DAEMON_COMPLETE_SET_CTF_SPLIT_PURPOSE,
      reservationId: input.reservationId,
      inputAsset: input.inputAsset,
      successorAssets: input.successorAssets,
      ...input.context,
    },
    reservationId: input.reservationId,
    asset: input.inputAsset,
    root: input.root,
  }
  if (!input.atomic) throw new Error('fresh complete-set preparation requires atomic counters')
  await input.atomic.deps.observeCompleteSetPrepared?.(
    input.kind === 'ctf' ? 'ctf' : 'regular',
    structuredClone(operation),
  )
  const mutation = input.mutation()
  try {
    const prepared = await withDurableCustodyUnitOfWork(
      createDaemonStateSqliteSession(profileDir()),
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const saved = readDaemonProofOperationFromDatabase(database, input.operationId)
        if (saved) {
          validateSavedCompleteSetOperation(database, saved, input)
          throw new CompleteSetSavedPreparation(input.operationId)
        }
        commitDaemonCounterTranscript(
          database,
          mutation.fence.scopeId,
          { normalizedMint: input.mintUrl, unit: 'msat' },
          input.atomic!.counters.transcript(),
          mutation.observedAtMs,
        )
        input.atomic!.deps.injectCompleteSetFault?.(
          input.kind === 'ctf' ? 'ctf' : 'regular',
          'counter-written',
        )
        const prepared =
          input.kind === 'regular-handoff'
            ? prepareCompleteSetRegularProofOperationFromDatabase(
                database,
                exactInput,
                mutation.observedAtMs,
              )
            : prepareCompleteSetCtfProofOperationFromDatabase(
                database,
                exactInput,
                mutation.observedAtMs,
              )
        input.atomic!.deps.injectCompleteSetFault?.(
          input.kind === 'ctf' ? 'ctf' : 'regular',
          'journal-bound',
        )
        return prepared
      },
      { injectFault: input.atomic.deps.injectCustodyFault },
    )
    return requireCtfProofOperation(prepared)
  } catch (error) {
    const saved = await readSavedCompleteSetOperation(input)
    if (saved) throw new CompleteSetSavedPreparation(input.operationId)
    if (error instanceof DaemonCounterSnapshotConflictError)
      throw new CompleteSetCounterRetry(input.operationId)
    throw error
  }
}

function asCtfProofOperation(
  operation: Awaited<ReturnType<typeof readProofOperationFenced>>,
): CtfProofOperationRecord | null {
  return operation as CtfProofOperationRecord | null
}

function requireCtfProofOperation(
  operation: ProofOperationRecord | CtfProofOperationRecord | null,
): CtfProofOperationRecord {
  if (operation === null) throw new Error('complete-set proof operation is missing')
  if (
    operation.kind !== 'ctf-split' &&
    operation.kind !== 'ctf-merge' &&
    operation.kind !== 'ctf-redeem' &&
    operation.kind !== 'regular-split'
  ) {
    throw new Error('complete-set proof operation kind is incompatible')
  }
  return operation as CtfProofOperationRecord
}

function outcomeSuccessorAssets(
  conditionId: string,
  keysets: Readonly<Record<string, string>>,
): Record<string, StoredProofAsset> {
  return Object.fromEntries(
    Object.keys(keysets).map((outcomeSetId) => [
      outcomeSetId,
      { kind: 'Outcome', conditionId, outcomeSetId, baseAsset: 'sat', unit: 'msat' },
    ]),
  )
}

class CompleteSetSavedPreparation extends Error {
  readonly operationId: string
  constructor(operationId: string) {
    super('complete-set saved preparation must be recovered')
    this.operationId = operationId
  }
}
class CompleteSetCounterRetry extends Error {
  readonly operationId: string
  constructor(operationId: string) {
    super('complete-set counter snapshot changed')
    this.operationId = operationId
  }
}
interface StageCounters {
  readonly source: CounterSource
  readonly transcript: () => SpeculativeCounterTranscript
}
function createStageCounters(
  keysetIds: readonly string[],
  mintUrl: string,
  mutation: () => FencedStateMutation,
): StageCounters {
  // The SDK has validated and bounded all groups before its first allocation.
  if (
    keysetIds.length < 1 ||
    keysetIds.length > 256 ||
    keysetIds.some((id) => !/^01[0-9a-f]{64}$/.test(id))
  )
    throw new Error('complete-set counter keysets are invalid')
  const ids = [...new Set(keysetIds)].sort()
  let ready: SpeculativeCounterTranscript | undefined
  let pending: Promise<SpeculativeCounterTranscript> | undefined
  const load = () =>
    (pending ??= readDaemonCounterSnapshots({
      storage: createDaemonStateSqliteSession(profileDir()),
      mutation: mutation(),
      keysetIds: ids,
      binding: { normalizedMint: mintUrl, unit: 'msat' },
    }).then((snapshots) => (ready = createSpeculativeCounterTranscript(snapshots))))
  return {
    source: {
      reserve: async (id, count) => (await load()).counterSource.reserve(id, count),
      advanceToAtLeast: async (id, next) => (await load()).counterSource.advanceToAtLeast(id, next),
    },
    transcript: () => {
      if (!ready) throw new Error('complete-set output counter transcript is missing')
      return ready
    },
  }
}
function pinPreparationKeysets(transport: CtfSplitTransport): CtfSplitTransport {
  const keys = new Map<string, Promise<MintKeys>>()
  return {
    getKeys: (id) => {
      let found = keys.get(id)
      if (!found) {
        found = transport.getKeys(id).then((value) => structuredClone(value))
        keys.set(id, found)
      }
      return found
    },
    getRootPartitionKeysets: (...args) => transport.getRootPartitionKeysets(...args),
    getConditionalKeysets: transport.getConditionalKeysets?.bind(transport),
    postSplit: transport.postSplit.bind(transport),
    postConvert: transport.postConvert?.bind(transport),
  }
}
async function readSavedCompleteSetOperation(
  input: FencedCompleteSetProofOperationConfig,
): Promise<ProofOperationRecord | null> {
  const mutation = input.mutation()
  return withDurableCustodyFencedRead(
    createDaemonStateSqliteSession(profileDir()),
    mutation.fence,
    mutation.observedAtMs,
    (database) => {
      const operation = readDaemonProofOperationFromDatabase(database, input.operationId)
      if (operation) validateSavedCompleteSetOperation(database, operation, input)
      else validateAbsentCompleteSetStage(database, input)

      return operation
    },
    { snapshot: true },
  )
}
function validateCompleteSetRootBinding(
  root: NonNullable<ReturnType<typeof readCompleteSetRecoveryRootFromDatabase>>,
  input: Pick<FencedCompleteSetProofOperationConfig, 'mintUrl' | 'root'>,
): void {
  if (
    root.rootOperationId !== input.root.rootOperationId ||
    root.mintUrl !== input.mintUrl ||
    root.conditionId !== input.root.conditionId ||
    root.amountMsat !== input.root.amountMsat ||
    (root.regularOperationId !== null &&
      root.regularOperationId !== input.root.regularOperationId) ||
    (root.ctfOperationId !== null &&
      root.ctfOperationId !== `${input.root.rootOperationId}:ctf-split`)
  )
    throw new Error('complete-set recovery root binding conflicts')
}
function validateSavedCompleteSetOperation(
  database: import('node:sqlite').DatabaseSync,
  operation: ProofOperationRecord,
  input: FencedCompleteSetProofOperationConfig,
): void {
  const authority = createCompleteSetOperationAuthority(input)
  if (
    operation.operationId !== input.operationId ||
    operation.mintUrl !== input.mintUrl ||
    operation.kind !== (input.kind === 'ctf' ? 'ctf-split' : 'regular-split') ||
    operation.metadata.purpose !== authority.purpose ||
    operation.metadata.reservationId !== input.reservationId ||
    !isDeepStrictEqual(operation.metadata.inputAsset, input.inputAsset) ||
    !isDeepStrictEqual(operation.metadata.successorAssets, input.successorAssets) ||
    Object.entries(input.context).some(
      ([key, value]) => !isDeepStrictEqual(operation.metadata[key], value),
    )
  )
    throw new Error('complete-set saved stage authority conflicts')
  const root = readCompleteSetRecoveryRootFromDatabase(database, input.root.rootOperationId)
  if (root) validateCompleteSetRootBinding(root, input)
  if (operation.state === 'prepared') {
    if (
      !root ||
      (input.kind === 'ctf'
        ? root.state !== 'ctf-prepared' || root.ctfOperationId !== input.operationId
        : root.state !== 'regular-prepared' || root.regularOperationId !== input.operationId)
    )
      throw new Error('complete-set prepared root authority conflicts')
    assertExactProofReservationFromDatabase(database, {
      operationId: operation.operationId,
      kind: operation.kind,
      mintUrl: operation.mintUrl,
      inputs: operation.inputs,
      outputs: operation.outputs,
      metadata: operation.metadata,
      reservationId: input.reservationId,
      asset: input.inputAsset,
    })
  } else if (operation.state === 'completed') {
    if (input.kind === 'ctf') {
      if (root !== null) throw new Error('complete-set completed CTF root was not finalized')
    } else if (!root) {
      const ctf = readDaemonProofOperationFromDatabase(
        database,
        `${input.root.rootOperationId}:ctf-split`,
      )
      if (
        !ctf ||
        requireExistingCompleteSetSplit(ctf, {
          operationId: input.root.rootOperationId,
          mintUrl: input.mintUrl,
          conditionId: input.root.conditionId,
          amountMsat: input.root.amountMsat,
        }).state !== 'completed'
      )
        throw new Error('complete-set completed handoff authority is absent')
    } else if (root.state !== 'ctf-handoff' && root.state !== 'ctf-prepared')
      throw new Error('complete-set completed regular root conflicts')
  } else throw new Error('complete-set saved operation has failed')
}

function validateAbsentCompleteSetStage(
  database: import('node:sqlite').DatabaseSync,
  input: Pick<FencedCompleteSetProofOperationConfig, 'kind' | 'mintUrl' | 'reservationId' | 'root'>,
): void {
  const root = readCompleteSetRecoveryRootFromDatabase(database, input.root.rootOperationId)
  const reserved = readDaemonReservedWalletProofsFromDatabase(
    database,
    input.mintUrl,
    input.reservationId,
  )
  if (reserved.length > 0 && !(input.kind === 'ctf' && root?.state === 'ctf-handoff'))
    throw new Error('complete-set reservation exists without its stage journal or handoff')
  if (root) {
    validateCompleteSetRootBinding(root, input)
    if (input.kind === 'regular-handoff' || root.state !== 'ctf-handoff')
      throw new Error('complete-set root exists without its stage journal')
  }
}
async function readInitialCtfOperation(
  input: CompleteSetSplitInput,
  mutation: () => FencedStateMutation,
): Promise<ProofOperationRecord | null> {
  const authority = mutation()
  return withDurableCustodyFencedRead(
    createDaemonStateSqliteSession(profileDir()),
    authority.fence,
    authority.observedAtMs,
    (database) => {
      const operation = readDaemonProofOperationFromDatabase(
        database,
        `${input.operationId}:ctf-split`,
      )
      if (!operation) {
        const root = readCompleteSetRecoveryRootFromDatabase(database, input.operationId)
        if (root?.state === 'regular-prepared') {
          if (
            readDaemonReservedWalletProofsFromDatabase(
              database,
              input.mintUrl,
              `${input.operationId}:ctf-split:reservation`,
            ).length > 0
          )
            throw new Error('complete-set CTF reservation precedes its handoff')
          const regular = readDaemonProofOperationFromDatabase(
            database,
            `${input.operationId}:regular-split`,
          )
          if (!regular) throw new Error('complete-set root exists without its regular journal')
          const asset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
          validateSavedCompleteSetOperation(database, regular, {
            kind: 'regular-handoff',
            mintUrl: input.mintUrl,
            operationId: `${input.operationId}:regular-split`,
            reservationId: `${input.operationId}:regular-split:reservation`,
            inputAsset: asset,
            successorAssets: { send: asset, keep: asset },
            context: completeSetOperationContext(input),
            root: completeSetRecoveryRoot(input),
            mutation,
            ctfHandoffAuthority: {
              reservationId: `${input.operationId}:ctf-split:reservation`,
              inputAsset: asset,
            },
          })
        } else
          validateAbsentCompleteSetStage(database, {
            kind: 'ctf',
            mintUrl: input.mintUrl,
            reservationId: `${input.operationId}:ctf-split:reservation`,
            root: completeSetRecoveryRoot(input),
          })
      }
      return operation
    },
    { snapshot: true },
  )
}
