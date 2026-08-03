import { type Proof } from '@cashu/cashu-ts'
import {
  CashuMintCtfSplitTransport,
  resumeExactPersistedCtfSplit,
  splitCompleteSetWithOperation,
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
  prepareCompleteSetCtfProofOperationFenced,
  prepareCompleteSetRegularProofOperationFenced,
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
  splitAvailableSatProofsForCtfCollateral,
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
  readonly createCtfSplitTransport?: (mintUrl: string) => CtfSplitTransport
  readonly createCtfResumeDependencies?: (mintUrl: string) => CompleteSetCtfResumeDependencies
}

type CompleteSetSplitInput = {
  mintUrl: string
  conditionId: string
  amountSats: number
  operationId: string
  secrets: DaemonSecrets | null
  deps: CompleteSetDependencies
  recoveryReference?: RecoverableCompleteSetRecoveryRoot
}

type CompleteSetSplitResult = {
  operationId: string
  conditionId: string
  amountSats: number
  outcomeProofCounts: Record<string, number>
}

export function createDaemonCompleteSetOutputMode(
  walletSeedHex: string,
  deps: Pick<WalletOpsDependencies, 'getCustodyFence'>,
) {
  if (!deps.getCustodyFence) {
    throw new Error('complete-set conversion requires custody authority')
  }
  const getCustodyFence = deps.getCustodyFence
  return {
    kind: 'seed-derived' as const,
    seed: Buffer.from(walletSeedHex, 'hex'),
    counterSource: createDaemonCounterSource(() => ({
      fence: getCustodyFence(),
      observedAtMs: Date.now(),
    })),
  }
}

export async function splitWalletCompleteSet(
  input: CompleteSetSplitInput,
): Promise<CompleteSetSplitResult> {
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
      : await readProofOperationFenced(`${input.operationId}:ctf-split`, mutation())
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
  const transport = createCtfSplitTransport(input.deps, input.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(input.conditionId)
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
  })
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: input.mintUrl,
    baseAsset: 'sat',
    operationId: `${input.operationId}:ctf-split`,
    transport,
    conditionId: input.conditionId,
    collateralProofs: collateral.inputs,
    outcomeCollectionKeysets,
    amountSubunits: input.amountSats,
    proofOperationStore: ctfAuthority.store,
    beforeMintMutation: ctfAuthority.beforeMintMutation,
    outputMode: createDaemonCompleteSetOutputMode(input.secrets.walletSeedHex, input.deps),
  })
  return completeSetResponse(input, proofsByCollection)
}

async function splitCompleteSetCollateral(
  input: CompleteSetSplitInput & { secrets: DaemonSecrets },
  mutation: () => FencedStateMutation,
  collateralAsset: StoredProofAsset,
  ctfReservationId: string,
) {
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
  })
  return splitAvailableSatProofsForCtfCollateral(
    input.amountSats,
    input.mintUrl,
    `${input.operationId}:regular-split`,
    input.secrets,
    input.deps,
    'sat',
    createCompleteSetCollateralOperationAuthority(regularAuthority, collateralAsset, mutation),
  )
}

async function resumeExistingCompleteSetSplit(
  input: CompleteSetSplitInput & { secrets: DaemonSecrets },
  mutation: () => FencedStateMutation,
  collateralAsset: StoredProofAsset,
  operation: ProofOperationRecord,
): Promise<CompleteSetSplitResult> {
  const existing = requireExistingCompleteSetSplit(operation, input)
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
    amountSubunits: input.amountSats,
    baseAsset: 'sat',
    transport,
    proofOperationStore: ctfAuthority.store,
    proofStateChecker: resumeDependencies?.proofStateChecker,
    restoreOutputGroups: resumeDependencies?.restoreOutputGroups,
    outputMode: createDaemonCompleteSetOutputMode(input.secrets.walletSeedHex, input.deps),
    beforeMintMutation: ctfAuthority.beforeMintMutation,
  })
  return completeSetResponse(input, proofsByCollection)
}

function completeSetResponse(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountSats'>,
  proofsByCollection: Record<string, CashuProofRecord[]>,
): CompleteSetSplitResult {
  return {
    operationId: input.operationId,
    conditionId: input.conditionId,
    amountSats: input.amountSats,
    outcomeProofCounts: Object.fromEntries(
      Object.entries(proofsByCollection).map(([outcome, proofs]) => [outcome, proofs.length]),
    ),
  }
}

function completeSetOperationContext(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountSats'>,
): Record<string, string | number> {
  return {
    rootOperationId: input.operationId,
    conditionId: input.conditionId,
    amountSats: input.amountSats,
  }
}

function completeSetRecoveryRoot(
  input: Pick<CompleteSetSplitInput, 'operationId' | 'conditionId' | 'amountSats' | 'mintUrl'>,
): CompleteSetRecoveryRoot {
  return {
    rootOperationId: input.operationId,
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    amountSats: input.amountSats,
    regularOperationId: `${input.operationId}:regular-split`,
    ctfOperationId: null,
  }
}

function requireExistingCompleteSetSplit(
  operation: ProofOperationRecord,
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountSats'>,
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
    metadata.amountSats !== input.amountSats ||
    metadata.amountSubunits !== input.amountSats ||
    metadata.reservationId !== `${input.operationId}:ctf-split:reservation` ||
    !isSatsAsset(metadata.inputAsset) ||
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
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountSats'>,
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
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountSats'>,
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
    root.amountSats !== input.amountSats ||
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
  input: Pick<CompleteSetSplitInput, 'mintUrl' | 'operationId' | 'conditionId' | 'amountSats'>,
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
    metadata.amountSats !== input.amountSats ||
    (isCtf && metadata.amountSubunits !== input.amountSats) ||
    metadata.reservationId !== reference.reservationId ||
    !isSatsAsset(metadata.inputAsset) ||
    !hasExactCompleteSetSuccessorAuthority(
      metadata.successorAssets,
      input.conditionId,
      isCtf,
      isCtf ? metadata.outcomeCollectionKeysets : undefined,
    )
  )
}

function isSatsAsset(value: unknown): boolean {
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
        ([group, asset]) => (group === 'send' || group === 'keep') && isSatsAsset(asset),
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
        amountSats: root.amountSats,
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

type FencedCompleteSetProofOperationConfig =
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
        return asCtfProofOperation(await readProofOperationFenced(operationId, input.mutation()))
      },
      prepareProofOperation: async (operation) =>
        prepareCompleteSetProofOperation(operation, input),
      markProofOperationCompleted: async (operationId, completion) =>
        completeCompleteSetProofOperation(operationId, completion, authority, input),
    },
    beforeMintMutation: () =>
      assertPreparedProofOperationDispatchFenced(
        input.operationId,
        authority,
        input.mutation(),
      ).then(() => undefined),
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
  const prepared =
    input.kind === 'regular-handoff'
      ? await prepareCompleteSetRegularProofOperationFenced(exactInput, input.mutation())
      : await prepareCompleteSetCtfProofOperationFenced(exactInput, input.mutation())
  return requireCtfProofOperation(prepared)
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
