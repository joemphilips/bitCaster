import {
  Amount,
  Mint as CashuMint,
  Wallet as CashuWallet,
  MintOperationError,
  CheckStateEnum,
  OutputData,
  getDecodedToken,
  verifyProofsForReceive,
  type CounterRange,
  type CounterSource,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type ConditionalSwapPreview,
  type OperationCounters,
  type SwapPreview,
} from '@cashu/cashu-ts'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  computeGrossCtfInputAmountSubunits,
  selectCollateralForCtfSplit,
  splitRegularProofsWithOperation,
  type CtfGrossInputPlanningKeyset,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { isLoopbackHttpUrl } from '@bitcaster-market/client-sdk'
import {
  COLLATERAL_COLLECTION,
  type CtfConsolidationPlan,
  type CtfConsolidationStrategy,
} from '@bitcaster-market/client-sdk/ctfConsolidation'
import {
  amountToNumber,
  computeInputFeeSubunitsForProofs,
} from '@bitcaster-market/client-sdk/proofSelection'
import { classifyExactProofConsolidationReplayFailure } from '@bitcaster-market/client-sdk/proofConsolidationOperation'
import { classifyCtfRangeSourceRecovery } from '@bitcaster-market/client-sdk/ctfRangeSourceRecovery'
import {
  createDurableCustodyProofOperation,
  bindDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  assertDurableCustodyMintOperationAuthority,
  type DurableCustodyMintKeysetAuthority,
  type DurableCustodyMintOperationAuthority,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  applyDurableCustodyTransaction,
  deriveDurableCustodyOperationId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  serializeDurableCustodyProofInput,
  type DurableCustodyProofOperationInput,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import {
  canonicalizeTokenImportMintUrl,
  validateProductWalletTokenImport,
  type ResolveTokenImportKeysets,
  type TokenImportUnit,
} from '@bitcaster-market/client-sdk/tokenImportValidation'
import { serializeDurableWalletReceiveOperation } from '@bitcaster-market/client-sdk/durableWalletOperation'
import {
  redactedTransferMetadata,
  type DurableOutgoingCashuTransfer,
} from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import {
  deriveDurableRecipientTokenAllowance,
  type DurableRecipientDeliveryClient,
} from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  createParticipationScoreDeliveryMetadata,
  createParticipationScoreDeliverySubmission,
  participationScoreDeliveryIntent,
} from '@bitcaster-market/client-sdk/participationScoreDelivery'
import {
  addAvailableProofs,
  advanceDaemonKeysetCounter,
  ensureState,
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  readDaemonKeysetCounters,
  readAvailableWalletProofAmountSamplesForReceive,
  readDaemonStateFromDatabase,
  writeDaemonStateToDatabase,
  emptyDaemonState,
  reserveDaemonKeysetCounter,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
  completeCtfConsolidationTargetFromDatabase,
  prepareCtfConsolidationProofOperationWithExactReservation,
  releaseCtfConsolidationProofReservationFromDatabase,
} from './state.ts'
import { profileDir, type DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import { createDaemonStateSqliteSession, type StateSqliteFaultPhase } from './stateSqlite.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import {
  createCustodyProofSqliteRow,
  createCustodyProofSqliteRowFromMaterial,
} from './custodyProofSqliteRow.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import type { WalletConsolidationProofSummary, WalletConsolidationResult } from './protocol.ts'
import { createDaemonTokenImportKeysetResolver } from './tokenImportKeysetResolver.ts'
import { DaemonDurableWalletReceiveCoordinator } from './durableWalletReceiveCoordinator.ts'
import { DaemonDurableOutgoingCashuCoordinator } from './durableOutgoingCashuCoordinator.ts'

export interface CashuWalletLike {
  loadMint(): Promise<void>
  receive(token: string, config?: { proofsWeHave?: Array<Pick<Proof, 'amount'>> }): Promise<Proof[]>
  prepareSwapToReceive?(
    token: string,
    config?: {
      proofsWeHave?: Array<Pick<Proof, 'amount'>>
      onCountersReserved?: (range: OperationCounters) => void
    },
    outputConfig?: unknown,
  ): Promise<SwapPreview>
  send(amount: number, proofs: Proof[]): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareSwapToSend?(
    amount: number,
    proofs: Proof[],
    sendConfig?: unknown,
    outputConfig?: unknown,
  ): Promise<SwapPreview>
  completeSwap?(swapPreview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareConditionalSwap?(options: {
    keysetId: string
    inputs: Proof[]
    outputs: [{ label: 'consolidated'; kind: 'random'; amount: number }]
  }): Promise<ConditionalSwapPreview>
  completeConditionalSwap?(preview: ConditionalSwapPreview): Promise<Record<string, Proof[]>>
  checkProofsStates?(proofs: Array<Pick<Proof, 'id' | 'secret'>>): Promise<ProofState[]>
  selectProofsToSend?(
    proofs: Proof[],
    amountToSend: number,
    includeFees?: boolean,
    exactMatch?: boolean,
  ): { keep: Proof[]; send: Proof[] }
  getFeesForProofs?(proofs: Proof[]): unknown
  getKeyset?(keysetId?: string): {
    id: string
    keys: Record<string, string> | Record<number, string>
  }
  keysetId?: string
}

export interface WalletOpsDependencies {
  createCashuWallet?: (mintUrl: string, unit?: TokenImportUnit) => CashuWalletLike
  getCustodyFence?: () => CustodyScopeFence
  resolveTokenImportKeysets?: ResolveTokenImportKeysets
  ctfConvert?: (
    mintUrl: string,
    request: CtfConvertRequest,
    outputsByCollection: Record<string, OutputData[]>,
  ) => Promise<Record<string, Proof[]>>
  resolveInputFeePpkByKeyset?: (
    mintUrl: string,
    keysetIds: string[],
  ) => Promise<Record<string, number>>
  resolveOutputKeysetByCollection?: (
    mintUrl: string,
    conditionId: string,
  ) => Promise<Record<string, string>>
  resolveMintKeysByKeyset?: (
    mintUrl: string,
    keysetIds: string[],
  ) => Promise<Record<string, MintKeys>>
  resolveDurableCustodyKeysets?: (
    mintUrl: string,
    keysetIds: string[],
    conditionId: string,
  ) => Promise<readonly DurableCustodyMintKeysetAuthority[]>
  restoreOutputGroups?: (
    mintUrl: string,
    outputs: Record<string, StoredOutputData[]>,
  ) => Promise<Record<string, Proof[]>>
  resolveMintKeysetIds?: (mintUrl: string) => Promise<string[]>
  resolveConditionKeysetIds?: (mintUrl: string, conditionId: string) => Promise<string[]>
  injectCustodyFault?: (phase: StateSqliteFaultPhase) => void
}

export interface WalletOpsSecrets {
  walletSeedHex: string
}

export interface WalletReceiveResult {
  mintUrl: string
  amountMsat: number
  proofCount: number
  asset: StoredProofAsset
  unit: TokenImportUnit
  hasInactiveProofs: boolean
}

export interface WalletSendResult {
  operationId: string
  mintUrl: string
  amountMsat: number
  proofCount: number
  token: string
}

export interface DurableParticipationScoreDeliveryResult {
  readonly deliveryId: string
  readonly transferId: string
  readonly state: 'pending' | 'received' | 'credited'
}

export interface WalletSendRecoveryResult {
  recovered: string[]
  pending: Array<{ operationId: string; error: string }>
}

export interface DurableOutgoingCashuRecoveryResult {
  readonly recovered: string[]
  readonly pending: Array<{ operationId: string; error: string }>
  readonly hasMore: boolean
  readonly hasPending: boolean
  readonly hasBlockingPending: boolean
}

export interface DurableOutgoingCashuReclaimResult {
  readonly transferId: string
  readonly mintUrl: string
  readonly unit: string
  readonly deliveryState: string
  readonly tokenDigest: string | null
  readonly tokenLength: number | null
  readonly returnedAmount: string | null
  readonly receiveFee: string | null
}

export interface WalletReceiveRecoveryResult {
  recovered: string[]
  recoveredCount: number
  pending: Array<{ operationId: string; error: string }>
  pendingCount: number
  hasMore: boolean
}

export interface PreparedCtfCollateralResult {
  inputs: Proof[]
  spent: Proof[]
  keep: Proof[]
}

export interface CtfCollateralOperationAuthority {
  readonly proofOperationStore: CtfProofOperationStore
  readonly beforeMintMutation: () => Promise<void>
  readonly readAvailableProofs: () => Promise<Proof[]>
}

export interface ExecuteCtfConsolidationPlanInput {
  marketId: string
  conditionId: string
  type: CtfConsolidationStrategy
  mintUrl: string
  plan: CtfConsolidationPlan
  outputsByCollection: Record<string, OutputData[]>
  secrets: WalletOpsSecrets
}

const DAEMON_CTF_PROOF_OPERATION_STORE: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, completion) =>
    (await markProofOperationCompleted(operationId, completion)) as CtfProofOperationRecord,
}

export async function receiveWalletToken(
  token: string,
  profile: DaemonProfile,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  metadata: WalletReceiveMetadata = {},
): Promise<WalletReceiveResult> {
  const allowInsecureLoopbackHttp = isLoopbackHttpUrl(profile.mintUrl)
  const canonicalProfileMintUrl = canonicalizeTokenImportMintUrl(
    profile.mintUrl,
    allowInsecureLoopbackHttp,
  )
  const validated = await validateProductWalletTokenImport({
    encodedToken: token,
    allowedCanonicalMintUrls: new Set([canonicalProfileMintUrl]),
    resolveKeysets:
      deps.resolveTokenImportKeysets ??
      createDaemonTokenImportKeysetResolver({ allowInsecureLoopbackHttp }),
    allowInsecureLoopbackHttp,
    bounds: {
      maxEncodedBytes: 4 * 1_024 * 1_024,
      maxProofs: 10_000,
      maxMints: 1,
      maxKeysets: 512,
      maxResolverCandidates: 512,
    },
  })
  if (!validated.proofs.every(({ resolvedKeysetId }) => isV2KeysetId(resolvedKeysetId))) {
    throw new Error('daemon wallet receive supports only V2 keysets')
  }
  if (validated.canonicalMintUrls.length !== 1) {
    throw new Error('daemon wallet receive supports exactly one mint per token')
  }
  const validatedMintUrl = validated.canonicalMintUrls[0]
  if (validatedMintUrl !== canonicalProfileMintUrl) {
    throw new Error('cashu token mint does not match daemon profile mint')
  }
  const asset = resolveReceiveAsset(metadata, validated.unit, validated.context)
  const decoded = await decodeTokenForProfile(validated.encodedToken, profile, asset, deps)
  const mintUrl = decoded.mint || profile.mintUrl
  if (!mintUrl) throw new Error('cashu token did not include a mint URL')
  if (mintUrl !== profile.mintUrl) {
    throw new Error('cashu token mint does not match daemon profile mint')
  }
  if (asset.kind === 'Outcome') {
    return receiveOutcomeToken(
      decoded.proofs as Proof[],
      mintUrl,
      asset,
      secrets,
      deps,
      validated.hasInactiveProofs,
    )
  }

  if (!deps.getCustodyFence) {
    throw new Error('daemon wallet receive requires custody authority')
  }
  const wallet = createWallet(mintUrl, secrets, deps, 'sat', validated.unit)
  await wallet.loadMint()
  const receiveMutation = { fence: deps.getCustodyFence(), observedAtMs: Date.now() }
  const proofsWeHave = (
    await readAvailableWalletProofAmountSamplesForReceive({
      mintUrl,
      unit: validated.unit,
      mutation: receiveMutation,
    })
  ).map(({ amount }) => ({ amount: Amount.from(amount) }))
  if (!wallet.prepareSwapToReceive) {
    throw new Error('cashu wallet does not support durable receive preparation')
  }
  let reserved: OperationCounters | undefined
  const preview = await wallet.prepareSwapToReceive(
    validated.encodedToken,
    {
      proofsWeHave,
      onCountersReserved: (range) => {
        reserved = range
      },
    },
    { type: 'deterministic', counter: 0 },
  )
  if (reserved === undefined) {
    throw new Error('daemon wallet receive did not reserve a deterministic output range')
  }
  const operation = serializeDurableWalletReceiveOperation({
    operationId: `wallet-receive:${randomUUID()}`,
    mintUrl,
    unit: validated.unit,
    preview,
    derivationRange: {
      keysetId: reserved.keysetId,
      counterStart: reserved.start,
      counterCount: reserved.count,
    },
  })
  const received = await new DaemonDurableWalletReceiveCoordinator(
    profileDir(),
    deps.getCustodyFence,
    deps.restoreOutputGroups ?? restoreOutputGroups,
  ).execute({ prepared: { operation }, wallet })
  return {
    mintUrl,
    amountMsat: sumProofs([...received.proofs]),
    proofCount: received.proofs.length,
    asset,
    unit: validated.unit,
    hasInactiveProofs: validated.hasInactiveProofs,
  }
}

/** Recover bounded active ordinary receives without creating a new output plan. */
export async function recoverDurableWalletReceives(
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
): Promise<WalletReceiveRecoveryResult> {
  if (!deps.getCustodyFence)
    return { recovered: [], recoveredCount: 0, pending: [], pendingCount: 0, hasMore: false }
  return new DaemonDurableWalletReceiveCoordinator(
    profileDir(),
    deps.getCustodyFence,
    deps.restoreOutputGroups ?? restoreOutputGroups,
  ).recover({
    walletFor: async (mintUrl, unit) => createWallet(mintUrl, secrets, deps, 'sat', unit),
  })
}

async function decodeTokenForProfile(
  token: string,
  profile: DaemonProfile,
  asset: StoredProofAsset,
  deps: WalletOpsDependencies,
): Promise<ReturnType<typeof getDecodedToken>> {
  try {
    return getDecodedToken(token, [])
  } catch (err) {
    if (!/short keyset ID/i.test(errorMessage(err))) throw err
    const keysetIds = await getDecodeKeysetIds(profile.mintUrl, asset, deps)
    return getDecodedToken(token, keysetIds)
  }
}

export interface WalletReceiveMetadata {
  conditionId?: string
  outcomeSetId?: string
}

export async function sendWalletToken(
  amountMsat: number,
  profile: DaemonProfile,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  mintUrl = profile.mintUrl,
  operationId?: string,
): Promise<WalletSendResult> {
  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('amountMsat must be a positive safe integer')
  }
  if (!mintUrl) throw new Error('mint URL is required')
  if (!deps.getCustodyFence) throw new Error('daemon wallet send requires custody authority')

  const transferId = operationId ?? `wallet-send-${randomUUID()}`
  const coordinator = new DaemonDurableOutgoingCashuCoordinator(
    profileDir(),
    deps.getCustodyFence,
    deps,
  )
  const existing = await coordinator.loadTransfer(transferId)
  if (existing !== null && existing.unit !== 'msat') {
    throw new Error('durable outgoing Cashu transfers require msat')
  }
  const wallet = createWallet(mintUrl, secrets, deps, 'sat', 'msat')
  await wallet.loadMint()
  const transfer =
    existing === null
      ? await coordinator.execute({ transferId, amountMsat, mintUrl, wallet })
      : await coordinator.recover({ transfer: existing, amountMsat, mintUrl, wallet })
  if (transfer.token === null) throw new Error('durable outgoing Cashu token admission is absent')
  return {
    operationId: transfer.walletSendOperation.operationId,
    mintUrl: transfer.mintUrl,
    amountMsat,
    proofCount: transfer.token.proofs.length,
    token: transfer.token.encodedToken,
  }
}

/** Create and reconcile one exact Score delivery without returning its bearer token. */
export async function deliverParticipationScoreCashu(input: {
  readonly deliveryId: string
  readonly accountSubject: string
  readonly amountMsat: number
  readonly purchasedTotalEpoch: number
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly client: DurableRecipientDeliveryClient
  readonly deps?: WalletOpsDependencies
}): Promise<DurableParticipationScoreDeliveryResult> {
  if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat <= 0) {
    throw new Error('Participation Score amount must be a positive safe integer')
  }
  const deps = input.deps ?? {}
  if (!deps.getCustodyFence)
    throw new Error('Participation Score delivery requires custody authority')
  if (!Number.isSafeInteger(input.purchasedTotalEpoch) || input.purchasedTotalEpoch < 0) {
    throw new Error('Participation Score purchase epoch is invalid')
  }
  const coordinator = new DaemonDurableOutgoingCashuCoordinator(
    profileDir(),
    deps.getCustodyFence,
    deps,
  )
  const pointer = await coordinator.preflightParticipationScoreDelivery({
    transferId: input.deliveryId,
    amountMsat: input.amountMsat,
    purchasedTotal: input.purchasedTotalEpoch,
    accountSubject: input.accountSubject,
    mintUrl: input.profile.mintUrl,
  })
  const requestedAmount = String(pointer.amountMsat)
  const initialMetadata = createParticipationScoreDeliveryMetadata({
    deliveryId: pointer.transferId,
    accountSubject: input.accountSubject,
    mintUrl: input.profile.mintUrl,
    requestedAmount,
  })
  const existing = await coordinator.loadTransfer(pointer.transferId)
  const metadata =
    existing === null
      ? initialMetadata
      : createParticipationScoreDeliveryMetadata({
          deliveryId: existing.transferId,
          accountSubject: input.accountSubject,
          mintUrl: existing.mintUrl,
          requestedAmount: existing.requestedAmount,
        })
  const intent = participationScoreDeliveryIntent({
    accountSubject: metadata.accountSubject,
    productBindingSha256: metadata.productBindingSha256,
    tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
  })
  const transfer =
    existing === null
      ? await executeScoreTransfer()
      : existing.deliveryState === 'recipient-acknowledged'
        ? existing
        : existing.deliveryState === 'delivery-pending' && existing.token !== null
          ? existing
          : await recoverScoreTransfer(existing)
  if (transfer.deliveryState === 'recipient-acknowledged') {
    return {
      deliveryId: metadata.deliveryId,
      transferId: transfer.transferId,
      state: 'credited',
    }
  }
  if (transfer.token === null) throw new Error('Participation Score token admission is absent')
  const status = await coordinator.reconcileRecipientDelivery({
    transfer,
    submission: createParticipationScoreDeliverySubmission({
      metadata,
      token: transfer.token.encodedToken,
    }),
    client: input.client,
    acknowledge: (candidate) => candidate.state === 'credited',
  })
  return {
    deliveryId: metadata.deliveryId,
    transferId: status.transfer.transferId,
    state:
      status.transfer.deliveryState === 'recipient-acknowledged'
        ? 'credited'
        : (status.status?.state ?? 'pending'),
  }

  async function executeScoreTransfer() {
    const wallet = createWallet(metadata.mintUrl, input.secrets, deps, 'sat', 'msat')
    await wallet.loadMint()
    return coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: Number(metadata.requestedAmount),
      mintUrl: metadata.mintUrl,
      wallet,
      deliveryIntent: intent,
    })
  }

  async function recoverScoreTransfer(existingTransfer: DurableOutgoingCashuTransfer) {
    const wallet = createWallet(metadata.mintUrl, input.secrets, deps, 'sat', 'msat')
    await wallet.loadMint()
    return coordinator.recover({
      transfer: existingTransfer,
      amountMsat: Number(metadata.requestedAmount),
      mintUrl: metadata.mintUrl,
      wallet,
      deliveryIntent: intent,
    })
  }
}

/** Recover one bounded page of due outgoing Cashu transfers without exposing tokens. */
export async function recoverDurableOutgoingCashuTransfers(
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  recipientDelivery?: {
    readonly client: DurableRecipientDeliveryClient
    readonly accountSubject: string
  },
): Promise<DurableOutgoingCashuRecoveryResult> {
  if (!deps.getCustodyFence) {
    return {
      recovered: [],
      pending: [],
      hasMore: false,
      hasPending: false,
      hasBlockingPending: false,
    }
  }
  const result = await new DaemonDurableOutgoingCashuCoordinator(
    profileDir(),
    deps.getCustodyFence,
    deps,
  ).recoverDue({
    walletFor: async (mintUrl, unit) => {
      if (unit !== 'msat') throw new Error('durable outgoing Cashu transfers require msat')
      return createWallet(mintUrl, secrets, deps, 'sat', 'msat')
    },
    ...(recipientDelivery === undefined
      ? {}
      : {
          recipientClient: recipientDelivery.client,
          recipientSubmission: (transfer: DurableOutgoingCashuTransfer) => {
            if (transfer.token === null)
              throw new Error('Participation Score token admission is absent')
            return createParticipationScoreDeliverySubmission({
              metadata: createParticipationScoreDeliveryMetadata({
                deliveryId: transfer.transferId,
                accountSubject: recipientDelivery.accountSubject,
                mintUrl: transfer.mintUrl,
                requestedAmount: transfer.requestedAmount,
              }),
              token: transfer.token.encodedToken,
            })
          },
          acknowledgeRecipientStatus: (status) => status.state === 'credited',
        }),
  })
  return {
    recovered: result.recovered,
    pending: result.pending.map(({ transferId, error }) => ({ operationId: transferId, error })),
    hasMore: result.hasMore,
    hasPending: result.hasPending,
    hasBlockingPending: result.hasBlockingPending,
  }
}

/** Reclaim one exact persisted bearer transfer after a fresh complete classification. */
export async function reclaimDurableOutgoingCashuTransfer(
  transferId: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
): Promise<DurableOutgoingCashuReclaimResult> {
  if (!deps.getCustodyFence)
    throw new Error('durable outgoing Cashu reclaim requires custody authority')
  const coordinator = new DaemonDurableOutgoingCashuCoordinator(
    profileDir(),
    deps.getCustodyFence,
    deps,
  )
  const transfer = await coordinator.loadTransfer(transferId)
  if (transfer === null) throw new Error('durable outgoing Cashu transfer is missing')
  if (transfer.unit !== 'msat') {
    throw new Error('durable outgoing Cashu transfers require msat')
  }
  const wallet = createWallet(transfer.mintUrl, secrets, deps, 'sat', 'msat')
  await wallet.loadMint()
  return redactedTransferMetadata(await coordinator.reclaim({ transferId, wallet }))
}

export async function splitAvailableMsatProofsForCtfCollateral(
  amountMsat: number,
  mintUrl: string,
  operationId: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  baseAssetInput?: string | null,
  operationAuthority?: CtfCollateralOperationAuthority,
): Promise<PreparedCtfCollateralResult> {
  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('amountMsat must be a positive safe integer')
  }
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const proofOperationStore =
    operationAuthority?.proofOperationStore ?? DAEMON_CTF_PROOF_OPERATION_STORE
  const existing = await proofOperationStore.getProofOperation(operationId)
  const wallet = createWallet(mintUrl, secrets, deps, baseAsset)
  if (existing) {
    if (existing.state !== 'completed') await wallet.loadMint()
    const split = await splitRegularProofsWithOperation({
      mintUrl,
      baseAsset,
      operationId,
      wallet,
      proofs: [],
      amountSubunits: requirePersistedCtfCollateralAmount(existing),
      proofOperationStore,
      beforeMintMutation: operationAuthority?.beforeMintMutation,
    })
    const exact = await validateExactCtfCollateralFromProofs(mintUrl, split.send, amountMsat, deps)
    return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
  }
  await wallet.loadMint()

  const available = await readAvailableCollateralProofs(mintUrl, baseAsset, operationAuthority)

  try {
    const exact = await validateExactCtfCollateralFromProofs(mintUrl, available, amountMsat, deps)
    return { inputs: exact.inputs, spent: [], keep: [] }
  } catch {
    // Fall through to wallet-backed selection, then to a regular split if needed.
  }

  try {
    const exact = await selectCollateralForCtfSplit(mintUrl, available, amountMsat, baseAsset)
    return { inputs: exact.inputs, spent: [], keep: [] }
  } catch {
    // Fall through to a regular split that creates a gross CTF input.
  }

  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error('cashu wallet does not support fee-aware proof selection')
  }
  const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(mintUrl, wallet, deps)
  const grossCtfInputSubunits = computeGrossCtfInputAmountSubunits({
    faceAmountSubunits: amountMsat,
    keyset: grossPlanningKeyset,
  })
  const selected = wallet.selectProofsToSend(available, grossCtfInputSubunits, true, false)
  if (selected.send.length === 0) {
    throw new Error(`insufficient available msat in mint ${mintUrl}`)
  }
  const split = await splitRegularProofsWithOperation({
    mintUrl,
    baseAsset,
    operationId,
    wallet,
    proofs: selected.send,
    amountSubunits: grossCtfInputSubunits,
    proofOperationStore,
    beforeMintMutation: operationAuthority?.beforeMintMutation,
  })
  const exact = await validateExactCtfCollateralFromProofs(mintUrl, split.send, amountMsat, deps)
  return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
}

function requirePersistedCtfCollateralAmount(operation: CtfProofOperationRecord): number {
  const amount = operation.metadata.amount
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('persisted CTF collateral operation amount is invalid')
  }
  return amount
}

async function readAvailableCollateralProofs(
  mintUrl: string,
  baseAsset: 'sat',
  operationAuthority: CtfCollateralOperationAuthority | undefined,
): Promise<Proof[]> {
  if (operationAuthority) return operationAuthority.readAvailableProofs()
  return (await ensureState()).wallet.proofs
    .filter(
      (record) =>
        record.mintUrl === mintUrl &&
        record.state === 'available' &&
        record.asset.kind === 'sats' &&
        normalizeMarketBaseAsset(record.asset.baseAsset) === baseAsset &&
        record.asset.unit === 'msat',
    )
    .map((record) => record.proof as Proof)
}

async function resolveGrossCtfInputPlanningKeyset(
  mintUrl: string,
  wallet: CashuWalletLike,
  deps: WalletOpsDependencies,
): Promise<CtfGrossInputPlanningKeyset> {
  const keysetId = wallet.keysetId ?? wallet.getKeyset?.()?.id
  if (!keysetId) {
    throw new Error('cashu wallet did not expose an active keyset id')
  }
  const keysets = await resolveMintKeysByKeyset(mintUrl, [keysetId], deps)
  const keyset = keysets[keysetId]
  if (!keyset) {
    throw new Error(`mint did not return keys for keyset ${keysetId}`)
  }
  return {
    id: keyset.id,
    keys: keyset.keys,
    input_fee_ppk: keyset.input_fee_ppk ?? 0,
  }
}

async function validateExactCtfCollateralFromProofs(
  mintUrl: string,
  proofs: Proof[],
  faceAmountSubunits: number,
  deps: WalletOpsDependencies,
): Promise<{
  inputs: Proof[]
  keep: Proof[]
  inputFeeSubunits: number
  grossInputSubunits: number
}> {
  const inputs = proofs.map(normalizeProof)
  const inputFeePpkByKeyset = await resolveCtfConsolidationInputFees(
    mintUrl,
    inputs.map((proof) => proof.id),
    deps,
  )
  const inputFeeSubunits = computeInputFeeSubunitsForProofs(inputs, inputFeePpkByKeyset)
  const grossInputSubunits = inputs.reduce((acc, proof) => acc + amountToNumber(proof.amount), 0)
  const netInputSubunits = grossInputSubunits - inputFeeSubunits
  if (netInputSubunits !== faceAmountSubunits) {
    throw new Error(
      `CTF split inputs net ${netInputSubunits} msat after ${inputFeeSubunits} msat input fee, expected ${faceAmountSubunits}`,
    )
  }
  return { inputs, keep: [], inputFeeSubunits, grossInputSubunits }
}

type CtfCustodyBinding = {
  readonly record: DurableCustodyRecord
  readonly authority: DurableCustodyMintOperationAuthority
  readonly inputs: readonly Proof[]
  readonly artifacts: {
    readonly requestBody: DurableCustodyExactArtifact
    readonly output: DurableCustodyExactArtifact
    readonly privateMaterial: DurableCustodyExactArtifact
  }
  readonly inputAssets: readonly StoredProofAsset[]
  readonly successorAssets: Readonly<Record<string, StoredProofAsset>>
}

async function createCtfCustodyBinding(
  input: ExecuteCtfConsolidationPlanInput,
  deps: WalletOpsDependencies,
  fence: CustodyScopeFence,
  operationId: string,
): Promise<CtfCustodyBinding> {
  const inputEntries = Object.entries(input.plan.request.inputs)
  const inputAssets = inputEntries.flatMap(([collection, proofs]) =>
    proofs.map(() => consolidatedAsset(input.conditionId, collection)),
  )
  const successorAssets = Object.fromEntries(
    Object.keys(input.outputsByCollection).map((collection) => [
      collection,
      consolidatedAsset(input.conditionId, collection),
    ]),
  )
  const operationInputs = inputEntries.flatMap(([collection, proofs]) =>
    proofs.map((proof) => ({
      ...serializeDurableCustodyProofInput(proof),
      ...(collection === COLLATERAL_COLLECTION
        ? {}
        : { conditionId: input.conditionId, outcomeCollection: collection }),
    })),
  )
  const operationOutputs = Object.fromEntries(
    Object.entries(input.outputsByCollection).map(([collection, outputs]) => [
      collection,
      outputs.map((output) => serializeDurableCustodyOutput(output)),
    ]),
  )
  const operation: DurableCustodyProofOperationInput = {
    operationId,
    kind: 'ctf-consolidation',
    mintUrl: input.mintUrl,
    inputs: operationInputs,
    outputs: operationOutputs,
    metadata: {
      unit: 'msat',
      conditionId: input.conditionId,
      marketId: input.marketId,
      type: input.type,
      parentCollectionId: input.plan.request.parent_collection_id ?? null,
    },
  }
  const requestBody = {
    condition_id: input.conditionId,
    inputs: Object.fromEntries(
      inputEntries.map(([collection, proofs]) => [
        collection,
        proofs.map((proof) => serializeDurableCustodyProofInput(proof)),
      ]),
    ),
    outputs: Object.fromEntries(
      Object.entries(input.outputsByCollection).map(([collection, outputs]) => [
        collection,
        outputs.map((output) => ({
          amount: amountToNumber(output.blindedMessage.amount),
          id: output.blindedMessage.id,
          B_: output.blindedMessage.B_,
        })),
      ]),
    ),
  }
  const keysetIds = [
    ...new Set([
      ...operation.inputs.map((proof) => proof.id).filter((id): id is string => id !== undefined),
      ...Object.values(operation.outputs).flatMap((outputs) =>
        outputs.map((output) => output.blindedMessage.id),
      ),
    ]),
  ]
  const keysets = await resolveDurableCustodyKeysetAuthorities(
    input.mintUrl,
    keysetIds,
    input.conditionId,
    deps,
    inputEntries,
    Object.keys(input.outputsByCollection),
  )
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation,
    keysets,
    exactTransportRequest: prepareCanonicalArtifact(requestBody),
  })
  const reservationId = `ctf-consolidation:${operationId}`
  const record = createDurableCustodyProofOperation({
    scope: walletScope(fence),
    operation,
    facts: authority.facts,
    inventoryAccountId: null,
    reservationId,
    exactBoundary: {
      method: 'POST',
      path: '/v1/ctf/convert',
      idempotencyKey: operationId,
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
  })
  return {
    record,
    authority: authority.authority,
    inputs: flattenProofGroups(input.plan.request.inputs),
    artifacts: {
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
    inputAssets,
    successorAssets,
  }
}

async function resolveDurableCustodyKeysetAuthorities(
  mintUrl: string,
  keysetIds: readonly string[],
  conditionId: string,
  deps: WalletOpsDependencies,
  inputEntries: readonly (readonly [string, Proof[]])[],
  outputCollections: readonly string[],
): Promise<readonly DurableCustodyMintKeysetAuthority[]> {
  if (deps.resolveDurableCustodyKeysets) {
    const resolved = await deps.resolveDurableCustodyKeysets(mintUrl, [...keysetIds], conditionId)
    if (
      resolved.length !== keysetIds.length ||
      new Set(resolved.map((keyset) => keyset.id)).size !== keysetIds.length
    ) {
      throw new Error('mint custody keyset authority is incomplete')
    }
    return resolved
  }
  const mintKeys = await resolveMintKeysByKeyset(mintUrl, [...keysetIds], deps)
  const metadata = await listMintAndConditionalKeysets(mintUrl)
  const collectionByKeyset = new Map<string, string>()
  inputEntries.forEach(([collection, proofs]) =>
    proofs.forEach((proof) => {
      if (proof.id !== undefined && collection !== COLLATERAL_COLLECTION) {
        collectionByKeyset.set(proof.id, collection)
      }
    }),
  )
  outputCollections.forEach((collection) => {
    const ids = [...metadata]
      .filter(
        (row) =>
          row.condition_id === conditionId &&
          (row.outcome_collection === collection || row.outcome_collection_id === collection),
      )
      .map((row) => row.id)
    if (ids.length === 1) collectionByKeyset.set(ids[0]!, collection)
  })
  return keysetIds.map((id) => {
    const keyset = mintKeys[id]
    if (keyset === undefined) throw new Error(`mint did not return keys for keyset ${id}`)
    const row = metadata.find((candidate) => candidate.id === id)
    const collection = collectionByKeyset.get(id)
    if (row?.condition_id === conditionId && collection !== undefined) {
      const outcomeCollectionId = row.outcome_collection_id
      if (!row.outcome_collection || !outcomeCollectionId) {
        throw new Error('mint conditional keyset metadata is incomplete')
      }
      return {
        canonicalMintUrl: mintUrl,
        id,
        unit: keyset.unit,
        keys: Object.fromEntries(Object.entries(keyset.keys)),
        inputFeePpk: keyset.input_fee_ppk ?? 0,
        finalExpiry: keyset.final_expiry ?? null,
        identity: {
          kind: 'conditional' as const,
          conditionId,
          outcomeCollection: row.outcome_collection,
          outcomeCollectionId,
        },
      }
    }
    return {
      canonicalMintUrl: mintUrl,
      id,
      unit: keyset.unit,
      keys: Object.fromEntries(Object.entries(keyset.keys)),
      inputFeePpk: keyset.input_fee_ppk ?? 0,
      finalExpiry: keyset.final_expiry ?? null,
      identity: { kind: 'regular' as const },
    }
  })
}

function prepareCanonicalArtifact(value: unknown): DurableCustodyExactArtifact {
  return prepareDurableCustodyExactArtifact(value)
}

function walletScope(fence: CustodyScopeFence): DurableCustodyScope {
  if (!fence.scopeId.startsWith('custody:wallet:')) {
    throw new Error('CTF consolidation custody scope is foreign')
  }
  return {
    scopeKind: 'wallet',
    scopeId: fence.scopeId,
    walletId: fence.scopeId.slice('custody:wallet:'.length),
  }
}

function custodyOwner(
  fence: CustodyScopeFence,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return {
    incarnationId: fence.incarnationId,
    fencingEpoch: fence.fencingEpoch,
    observedAtMs,
  }
}

function custodySelection(
  record: DurableCustodyRecord,
  owner: DurableCustodyOwnerAuthorization,
  expectedRevision: number | null,
) {
  return {
    scope: record.scope,
    owner,
    operationRows: [{ operationId: record.operation.operationId, expectedRevision }],
  }
}

function assertCtfCanonicalInputMaterials(
  custody: DurableCustodySqliteStore,
  binding: CtfCustodyBinding,
  inputs: readonly Proof[],
  inputAssets: readonly StoredProofAsset[],
  scopeId: string,
  nowMs: number,
  allowedReservationOperationId: string | null = null,
): void {
  if (inputs.length !== inputAssets.length) {
    throw new Error('CTF consolidation canonical input authority is incomplete')
  }
  inputs.forEach((proof, index) => {
    const asset = inputAssets[index]!
    const expected = createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: binding.record.operation.custodyContext.normalizedMint,
      unit: 'msat',
      proof: {
        id: proof.id,
        amount: proof.amount,
        secret: proof.secret,
        C: proof.C,
        dleq: proof.dleq ?? null,
        p2pkE: proof.p2pk_e ?? null,
        witness: proof.witness ?? null,
      },
      baseAsset: 'sat',
      conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
      outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
      productBinding: null,
      signatureVerified: true,
      dleqState: proof.dleq === undefined ? 'not-present' : 'verified',
      nut07State: 'UNSPENT',
      selectability: 'retained',
      storageClass: 'terminal-replay-retained',
      reservationOperationId: null,
      revision: 0,
      nowMs,
    })
    const actual = custody.getProof(scopeId, expected.proofId)
    if (
      actual === null ||
      actual.proofId !== expected.proofId ||
      actual.normalizedMint !== expected.normalizedMint ||
      actual.unit !== expected.unit ||
      actual.keysetId !== expected.keysetId ||
      actual.amount !== expected.amount ||
      actual.baseAsset !== expected.baseAsset ||
      actual.conditionId !== expected.conditionId ||
      actual.outcomeSetId !== expected.outcomeSetId ||
      actual.productBinding !== expected.productBinding ||
      actual.proofFingerprint !== expected.proofFingerprint ||
      actual.curve !== expected.curve ||
      actual.signatureVerified !== expected.signatureVerified ||
      actual.dleqState !== expected.dleqState ||
      !Buffer.from(actual.proofBody).equals(Buffer.from(expected.proofBody))
    ) {
      throw new Error('CTF consolidation canonical input material differs from custody')
    }
    if (
      actual.nut07State !== 'UNSPENT' ||
      (actual.selectability !== 'retained' &&
        actual.selectability !== 'selectable' &&
        !(
          actual.selectability === 'locked' &&
          actual.reservationOperationId === allowedReservationOperationId
        )) ||
      (actual.reservationOperationId !== null &&
        actual.reservationOperationId !== allowedReservationOperationId)
    ) {
      throw new Error('CTF consolidation canonical input is not spendable')
    }
  })
}

async function readCtfConsolidationInputStates(
  mintUrl: string,
  secrets: WalletOpsSecrets,
  inputs: readonly Proof[],
  deps: WalletOpsDependencies,
): Promise<readonly ProofState[]> {
  const wallet = createWallet(mintUrl, secrets, deps, 'sat', 'msat')
  if (!wallet.checkProofsStates) {
    throw new Error('cashu wallet does not support CTF consolidation proof-state checks')
  }
  const states = await wallet.checkProofsStates(
    inputs.map((proof) => ({ id: proof.id, secret: proof.secret })),
  )
  if (states.length !== inputs.length) {
    throw new Error('CTF consolidation proof-state response is incomplete')
  }
  return states
}

async function releaseCtfConsolidationReservations(
  operationId: string,
  binding: CtfCustodyBinding,
  fence: CustodyScopeFence,
  reason: string,
): Promise<void> {
  const observedAtMs = Date.now()
  await withDurableCustodyUnitOfWork(profileDir(), fence, observedAtMs, (database) => {
    const custody = new DurableCustodySqliteStore(database)
    const canonical = custody.getOperation(binding.record.operation.operationId)
    if (canonical === null) throw new Error('CTF consolidation custody operation is missing')
    releaseCtfConsolidationProofReservationFromDatabase(database, {
      operationId,
      reservationId: `ctf-consolidation:${operationId}`,
      inputAssets: binding.inputAssets,
      reason,
      observedAtMs,
    })
    const authorization = custodyOwner(fence, observedAtMs)
    const transaction = new DurableCustodyTransactionSqlite(database, fence.scopeId, observedAtMs, [
      canonical,
    ])
    applyDurableCustodyTransaction(
      transaction,
      custodySelection(canonical, authorization, canonical.revision),
      (selected) =>
        selected.transitionOperation({
          operationId: binding.record.operation.operationId,
          expectedRevision: canonical.revision,
          transition: {
            kind: 'release-unspent-reservation',
            expectedRevision: canonical.revision,
            authorization,
          },
        }),
    )
  })
}

export async function executeCtfConsolidationPlan(
  input: ExecuteCtfConsolidationPlanInput,
  deps: WalletOpsDependencies = {},
): Promise<WalletConsolidationResult> {
  const selectedInputs = flattenProofGroups(input.plan.request.inputs)
  if (selectedInputs.length === 0) {
    throw new Error('CTF consolidation plan did not include input proofs')
  }

  const operationId = ctfConsolidationOperationId(input.conditionId, input.type, selectedInputs)
  const fence = deps.getCustodyFence?.()
  if (fence === undefined) {
    throw new Error('wallet CTF consolidation requires custody authority')
  }
  const binding = await createCtfCustodyBinding(input, deps, fence, operationId)
  await prepareCtfConsolidationProofOperationWithExactReservation(
    {
      operationId,
      kind: 'ctf-consolidation',
      mintUrl: input.mintUrl,
      inputs: selectedInputs,
      outputs: Object.fromEntries(
        Object.entries(input.outputsByCollection).map(([collection, outputs]) => [
          collection,
          serializeOutputDataArray(outputs),
        ]),
      ),
      metadata: {
        marketId: input.marketId,
        conditionId: input.conditionId,
        type: input.type,
        parentCollectionId: input.plan.request.parent_collection_id ?? null,
        inputCollections: Object.entries(input.plan.request.inputs).flatMap(
          ([collection, proofs]) => proofs.map(() => collection),
        ),
        feeSubunits: input.plan.feeSubunits,
        collateralOutputSubunits: input.plan.collateralOutputSubunits,
        reservationId: `ctf-consolidation:${operationId}`,
        inputAssets: binding.inputAssets,
        successorAssets: binding.successorAssets,
      },
      reservationId: `ctf-consolidation:${operationId}`,
      inputAssets: binding.inputAssets,
    },
    { fence, observedAtMs: Date.now() },
    (database) => {
      const observedAtMs = Date.now()
      const custody = new DurableCustodySqliteStore(database)
      const existing = custody.getOperation(binding.record.operation.operationId)
      assertCtfCanonicalInputMaterials(
        custody,
        binding,
        selectedInputs,
        binding.inputAssets,
        fence.scopeId,
        observedAtMs,
        existing === null ? null : binding.record.operation.operationId,
      )
      if (existing === null) {
        applyDurableCustodyTransaction(
          new DurableCustodyTransactionSqlite(database, fence.scopeId, observedAtMs),
          custodySelection(binding.record, custodyOwner(fence, observedAtMs), null),
          (transaction) =>
            bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
        )
      } else {
        assertDurableCustodyMintOperationAuthority(existing, binding.artifacts.privateMaterial)
      }
    },
    deps.injectCustodyFault,
  )

  let resultProofs: Record<string, Proof[]>
  try {
    resultProofs = deps.ctfConvert
      ? await deps.ctfConvert(input.mintUrl, input.plan.request, input.outputsByCollection)
      : await executeMintCtfConvert(input.mintUrl, input.plan.request, input.outputsByCollection)
  } catch (error) {
    if (error instanceof MintOperationError) {
      let inputStates: readonly ProofState[] | null = null
      try {
        inputStates = await readCtfConsolidationInputStates(
          input.mintUrl,
          input.secrets,
          selectedInputs,
          deps,
        )
      } catch {
        inputStates = null
      }
      const disposition =
        inputStates === null
          ? 'remain-pending'
          : classifyExactProofConsolidationReplayFailure({
              definiteMintRejection: true,
              inputStates: inputStates.map(({ state }) => state),
            })
      if (disposition === 'release-exact-unspent-inputs') {
        const reason = 'CTF consolidation mint rejected before mutation'
        await releaseCtfConsolidationReservations(operationId, binding, fence, reason)
        throw new Error('CTF consolidation mint rejected before mutation')
      }
    }
    throw new Error(
      error instanceof MintOperationError
        ? 'CTF consolidation mint rejection remains held for exact recovery'
        : 'CTF consolidation mint result is uncertain',
    )
  }

  await finalizeCtfConsolidationResult(
    {
      operationId,
      custodyOperationId: binding.record.operation.operationId,
      mintUrl: input.mintUrl,
      conditionId: input.conditionId,
      inputsByCollection: input.plan.request.inputs,
      inputAssets: binding.inputAssets,
      resultProofs,
      outputsByCollection: input.outputsByCollection,
      successorAssets: binding.successorAssets,
      keysets: binding.authority.keysets,
    },
    deps,
  )

  return {
    marketId: input.marketId,
    conditionId: input.conditionId,
    type: input.type,
    status: 'consolidated',
    convertFeeMsat: input.plan.feeSubunits,
    collateralReturnedMsat: input.plan.collateralOutputSubunits,
    spentInputs: summarizeProofGroups(input.plan.request.inputs),
    outputs: summarizeProofGroups(resultProofs),
  }
}

async function finalizeCtfConsolidationResult(
  input: {
    readonly operationId: string
    readonly custodyOperationId: string
    readonly mintUrl: string
    readonly conditionId: string
    readonly inputsByCollection: Record<string, Proof[]>
    readonly inputAssets: readonly StoredProofAsset[]
    readonly resultProofs: Record<string, Proof[]>
    readonly outputsByCollection: Record<string, OutputData[]>
    readonly successorAssets: Readonly<Record<string, StoredProofAsset>>
    readonly keysets: readonly DurableCustodyMintKeysetAuthority[]
    readonly persistedResult?: boolean
  },
  deps: WalletOpsDependencies,
): Promise<void> {
  const fence = deps.getCustodyFence?.()
  if (fence === undefined) throw new Error('wallet CTF consolidation requires custody authority')
  if (!input.persistedResult) {
    verifyConsolidatedResultProofs(input.resultProofs, input.outputsByCollection, input.keysets)
  }
  const observedAtMs = Date.now()
  await withDurableCustodyUnitOfWork(
    profileDir(),
    fence,
    observedAtMs,
    (database) => {
      const custody = new DurableCustodySqliteStore(database)
      const record = custody.getOperation(input.custodyOperationId)
      if (record === null) throw new Error('CTF consolidation custody operation is missing')
      const exactAuthority = requiredCustodyAuthorityArtifact(record, custody)
      const transaction = new DurableCustodyTransactionSqlite(
        database,
        fence.scopeId,
        observedAtMs,
        [record],
      )
      const authorization = custodyOwner(fence, observedAtMs)
      let prepared =
        record.operation.result.state === 'verified-staged'
          ? readDurableCustodyVerifiedMintResult({
              record,
              exactAuthority,
              exactResult: requiredCustodyResultArtifact(record, custody),
            })
          : prepareDurableCustodyVerifiedMintResult({
              record,
              exactAuthority,
              result: input.resultProofs,
            })
      if (
        record.operation.result.state !== 'verified-staged' &&
        record.operation.result.state !== 'applied'
      ) {
        stageDurableCustodyPreparedMintResult({
          transaction,
          record,
          prepared,
          authorization,
        })
      }
      const staged = transaction.getOperation(input.custodyOperationId)
      if (staged === null) throw new Error('CTF consolidation custody result staging failed')
      if (staged.operation.result.state === 'applied') {
        completeCtfConsolidationTargetFromDatabase(database, {
          operationId: input.operationId,
          resultProofs: normalizeProofGroups(input.resultProofs),
          inputAssets: input.inputAssets,
          successorAssets: input.successorAssets,
          nowMs: observedAtMs,
        })
        const state = readDaemonStateFromDatabase(database) ?? emptyDaemonState()
        replaceConsolidatedWalletProofs(
          state,
          {
            mintUrl: input.mintUrl,
            conditionId: input.conditionId,
            inputsByCollection: input.inputsByCollection,
            resultProofs: input.resultProofs,
            outputsByCollection: input.outputsByCollection,
          },
          observedAtMs,
        )
        writeDaemonStateToDatabase(database, state)
        return
      }
      prepared =
        staged.operation.result.state === 'verified-staged'
          ? readDurableCustodyVerifiedMintResult({
              record: staged,
              exactAuthority,
              exactResult: requiredCustodyResultArtifact(staged, custody),
            })
          : prepared
      const successors = prepared.proofs.map(({ group, material, dleqState }) => {
        const asset = input.successorAssets[group]
        if (asset === undefined) throw new Error('CTF consolidation successor asset is missing')
        return {
          proof: createCustodyProofSqliteRowFromMaterial({
            scopeId: staged.scope.scopeId,
            normalizedMint: staged.operation.custodyContext.normalizedMint,
            unit: 'msat',
            material,
            baseAsset: 'sat',
            conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
            outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
            productBinding: null,
            signatureVerified: true,
            dleqState,
            nut07State: 'UNSPENT',
            selectability: 'retained',
            storageClass: staged.operation.proofStorage.storageClass,
            reservationOperationId: null,
            revision: 0,
            nowMs: observedAtMs,
          }),
          expectedRevision: null,
        }
      })
      const current = transaction.getOperation(input.custodyOperationId)
      if (current === null) throw new Error('CTF consolidation custody operation disappeared')
      transaction.stageSuccessorProofCas(input.custodyOperationId, successors)
      transaction.applyVerifiedResult({
        operationId: input.custodyOperationId,
        expectedRevision: current.revision,
        authorization,
        outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
        resultHandle: requiredText(current.operation.result.resultHandle),
        resultFingerprint: requiredText(current.operation.result.resultFingerprint),
        successorAdmission: {
          scopeId: current.scope.scopeId,
          operationId: current.operation.operationId,
          admissionId: `ctf-consolidation:${requiredText(current.operation.result.resultFingerprint)}`,
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
          { operationId: input.custodyOperationId, expectedRevision: current.revision + 1 },
        ],
      })
      completeCtfConsolidationTargetFromDatabase(database, {
        operationId: input.operationId,
        resultProofs: normalizeProofGroups(input.resultProofs),
        inputAssets: input.inputAssets,
        successorAssets: input.successorAssets,
        nowMs: observedAtMs,
      })
      persistConsolidatedWalletProjection(database, input, observedAtMs)
    },
    deps.injectCustodyFault === undefined ? {} : { injectFault: deps.injectCustodyFault },
  )
}

function persistConsolidatedWalletProjection(
  database: Parameters<typeof readDaemonStateFromDatabase>[0],
  input: {
    readonly mintUrl: string
    readonly conditionId: string
    readonly inputsByCollection: Record<string, Proof[]>
    readonly resultProofs: Record<string, Proof[]>
    readonly outputsByCollection: Record<string, OutputData[]>
  },
  nowMs: number,
): void {
  const state = readDaemonStateFromDatabase(database) ?? emptyDaemonState()
  replaceConsolidatedWalletProofs(state, input, nowMs)
  writeDaemonStateToDatabase(database, state)
}

function requiredCustodyAuthorityArtifact(
  record: DurableCustodyRecord,
  custody: DurableCustodySqliteStore,
): DurableCustodyExactArtifact {
  const artifact = custody.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.privateMaterial.exactPrivateMaterial,
  })
  if (artifact === null) throw new Error('CTF consolidation custody authority is missing')
  return artifact.artifact
}

function requiredCustodyRequestArtifact(
  record: DurableCustodyRecord,
  custody: DurableCustodySqliteStore,
): DurableCustodyExactArtifact {
  const artifact = custody.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.exactRequest.body,
  })
  if (artifact === null) throw new Error('CTF consolidation request authority is missing')
  return artifact.artifact
}

function requiredCustodyOutputArtifact(
  record: DurableCustodyRecord,
  custody: DurableCustodySqliteStore,
): DurableCustodyExactArtifact {
  const artifact = custody.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference: record.operation.outputPlan.exactOutput,
  })
  if (artifact === null) throw new Error('CTF consolidation output authority is missing')
  return artifact.artifact
}

function requiredCustodyResultArtifact(
  record: DurableCustodyRecord,
  custody: DurableCustodySqliteStore,
): DurableCustodyExactArtifact {
  const reference = record.operation.result.exactResult
  if (reference === null) throw new Error('CTF consolidation custody result authority is missing')
  const artifact = custody.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (artifact === null) throw new Error('CTF consolidation custody result authority is missing')
  return artifact.artifact
}

export async function resolveCtfConsolidationInputFees(
  mintUrl: string,
  keysetIds: string[],
  deps: WalletOpsDependencies = {},
): Promise<Record<string, number>> {
  const unique = [...new Set(keysetIds.filter(Boolean))]
  if (deps.resolveInputFeePpkByKeyset) {
    return deps.resolveInputFeePpkByKeyset(mintUrl, unique)
  }
  const keysetRows = await listMintAndConditionalKeysets(mintUrl)
  const feeByKeyset = new Map(keysetRows.map((keyset) => [keyset.id, keyset.input_fee_ppk ?? 0]))
  return Object.fromEntries(
    unique.map((keysetId) => {
      if (!feeByKeyset.has(keysetId)) {
        throw new Error(`mint did not return input_fee_ppk for keyset ${keysetId}`)
      }
      return [keysetId, feeByKeyset.get(keysetId) ?? 0]
    }),
  )
}

export async function resolveCtfConsolidationOutputKeysets(
  mintUrl: string,
  conditionId: string,
  deps: WalletOpsDependencies = {},
): Promise<Record<string, string>> {
  if (deps.resolveOutputKeysetByCollection) {
    return deps.resolveOutputKeysetByCollection(mintUrl, conditionId)
  }
  const keysets = await listMintAndConditionalKeysets(mintUrl)
  const collateralUnit = defaultCollateralUnit(undefined)
  const activeCollateral = keysets.find(
    (keyset) =>
      keyset.active && keyset.unit === collateralUnit && keyset.condition_id === undefined,
  )
  if (!activeCollateral) {
    throw new Error(`mint did not return an active ${collateralUnit} collateral keyset`)
  }
  const entries: Array<[string, string]> = [[COLLATERAL_COLLECTION, activeCollateral.id]]
  for (const keyset of keysets) {
    if (!keyset.active || keyset.condition_id !== conditionId) continue
    for (const collection of [keyset.outcome_collection, keyset.outcome_collection_id]) {
      if (collection) entries.push([collection, keyset.id])
    }
  }
  return Object.fromEntries(entries)
}

export async function resolveMintKeysByKeyset(
  mintUrl: string,
  keysetIds: string[],
  deps: WalletOpsDependencies = {},
): Promise<Record<string, MintKeys>> {
  if (deps.resolveMintKeysByKeyset) {
    return deps.resolveMintKeysByKeyset(mintUrl, keysetIds)
  }
  const mint = new CashuMint(mintUrl)
  const result: Record<string, MintKeys> = {}
  for (const keysetId of [...new Set(keysetIds.filter(Boolean))]) {
    const response = await mint.getKeys(keysetId)
    const keyset = response.keysets.find((candidate) => candidate.id === keysetId)
    if (!keyset) throw new Error(`mint did not return keys for keyset ${keysetId}`)
    result[keysetId] = keyset
  }
  return result
}

async function executeMintCtfConvert(
  mintUrl: string,
  request: CtfConvertRequest,
  outputsByCollection: Record<string, OutputData[]>,
): Promise<Record<string, Proof[]>> {
  const mint = new CashuMint(mintUrl) as CashuMint & {
    ctfConvert(request: CtfConvertRequest): Promise<CtfConvertResponse>
  }
  const response = await mint.ctfConvert(request)
  const keysets = await resolveMintKeysByKeyset(
    mintUrl,
    Object.values(request.outputs).flatMap((outputs) => outputs.map((output) => output.id)),
  )
  const result: Record<string, Proof[]> = {}
  for (const [collection, outputs] of Object.entries(outputsByCollection)) {
    const signatures = response.signatures[collection]
    if (!signatures) {
      throw new Error(`mint did not return CTF convert signatures for ${collection}`)
    }
    if (signatures.length !== outputs.length) {
      throw new Error(
        `mint returned ${signatures.length} CTF convert signatures for ${collection}, expected ${outputs.length}`,
      )
    }
    result[collection] = outputs.map((output, index) => {
      const signature = signatures[index]
      const message = output.blindedMessage
      if (signature.id !== message.id) {
        throw new Error(`mint returned CTF convert signature for unexpected keyset ${signature.id}`)
      }
      if (amountToNumber(signature.amount) !== amountToNumber(message.amount)) {
        throw new Error('mint returned CTF convert signature with unexpected amount')
      }
      const keyset = keysets[message.id]
      if (!keyset) throw new Error(`missing mint keys for keyset ${message.id}`)
      return normalizeProof(output.toProof({ ...signature, amount: message.amount }, keyset))
    })
  }
  return result
}

function verifyConsolidatedResultProofs(
  resultProofs: Record<string, Proof[]>,
  outputsByCollection: Record<string, OutputData[]>,
  keysetAuthorities: readonly DurableCustodyMintKeysetAuthority[],
): void {
  assertConsolidatedResultMatchesOutputPlan(resultProofs, outputsByCollection)
  const proofs = flattenProofGroups(resultProofs)
  if (proofs.length === 0) throw new Error('CTF consolidation mint returned no proofs')
  if (proofs.some((proof) => !isV2KeysetId(proof.id))) {
    throw new Error('CTF consolidation mint returned a non-V2 keyset')
  }
  const keysets = new Map(
    keysetAuthorities.map((keyset) => [
      keyset.id,
      {
        id: keyset.id,
        unit: keyset.unit,
        keys: keyset.keys,
        input_fee_ppk: keyset.inputFeePpk,
        ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
      } as MintKeys,
    ]),
  )
  verifyProofsForReceive(
    proofs,
    (keysetId) => {
      const keyset = keysets.get(keysetId)
      if (keyset === undefined) throw new Error('CTF consolidation output keyset is missing')
      return keyset
    },
    { requireDleq: true },
  )
}

function assertConsolidatedResultMatchesOutputPlan(
  resultProofs: Record<string, Proof[]>,
  outputsByCollection: Record<string, OutputData[]>,
): void {
  const resultCollections = Object.keys(resultProofs).sort()
  const outputCollections = Object.keys(outputsByCollection).sort()
  if (
    resultCollections.length !== outputCollections.length ||
    resultCollections.some((collection, index) => collection !== outputCollections[index])
  ) {
    throw new Error('CTF consolidation result groups differ from the output plan')
  }
  for (const collection of outputCollections) {
    const proofs = resultProofs[collection] ?? []
    const outputs = outputsByCollection[collection] ?? []
    if (proofs.length !== outputs.length) {
      throw new Error('CTF consolidation result count differs from the output plan')
    }
    proofs.forEach((proof, index) => {
      const output = outputs[index]!
      if (
        proof.id !== output.blindedMessage.id ||
        amountToNumber(proof.amount) !== amountToNumber(output.blindedMessage.amount) ||
        proof.secret !== new TextDecoder().decode(output.secret) ||
        (proof.p2pk_e ?? null) !== (output.ephemeralE ?? null)
      ) {
        throw new Error('CTF consolidation result proof differs from the output plan')
      }
    })
  }
}

function replaceConsolidatedWalletProofs(
  state: ReturnType<typeof emptyDaemonState>,
  input: {
    mintUrl: string
    conditionId: string
    inputsByCollection: Record<string, Proof[]>
    resultProofs: Record<string, Proof[]>
    outputsByCollection: Record<string, OutputData[]>
  },
  nowMs: number,
): void {
  const spentSecrets = new Set(
    flattenProofGroups(input.inputsByCollection).map((proof) => proof.secret),
  )
  state.wallet.proofs = state.wallet.proofs.filter(
    (record) => record.mintUrl !== input.mintUrl || !spentSecrets.has(record.proof.secret),
  )
  const existingSecrets = new Set(
    state.wallet.proofs
      .filter((record) => record.mintUrl === input.mintUrl)
      .map((record) => record.proof.secret),
  )
  for (const [collection, proofs] of Object.entries(input.resultProofs)) {
    const asset = consolidatedAsset(input.conditionId, collection)
    for (const proof of proofs) {
      if (existingSecrets.has(proof.secret)) continue
      existingSecrets.add(proof.secret)
      state.wallet.proofs.push({
        proof: normalizeProof(proof),
        mintUrl: input.mintUrl,
        state: 'available',
        asset,
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      })
    }
  }
}

function consolidatedAsset(conditionId: string, collection: string): StoredProofAsset {
  return collection === COLLATERAL_COLLECTION
    ? { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
    : {
        kind: 'Outcome',
        conditionId,
        outcomeSetId: collection,
        baseAsset: 'sat',
        unit: 'msat',
      }
}

function summarizeProofGroups(groups: Record<string, Proof[]>): WalletConsolidationProofSummary[] {
  return Object.entries(groups).flatMap(([label, proofs]) =>
    proofs.map((proof) => ({
      id: proof.id,
      amount: amountToNumber(proof.amount),
      label,
      keysetId: proof.id,
    })),
  )
}

function flattenProofGroups(groups: Record<string, Proof[]>): Proof[] {
  return Object.values(groups).flatMap((proofs) => proofs.map(normalizeProof))
}

function normalizeProof(proof: Proof): Proof {
  return { ...proof, amount: amountToNumber(proof.amount) as never }
}

async function listMintAndConditionalKeysets(mintUrl: string): Promise<
  Array<{
    id: string
    unit: string
    active?: boolean
    input_fee_ppk?: number
    condition_id?: string
    outcome_collection?: string
    outcome_collection_id?: string
  }>
> {
  const mint = new CashuMint(mintUrl) as CashuMint & {
    getConditionalKeysets(query?: { active?: boolean }): Promise<{
      keysets: Array<{
        id: string
        unit: string
        active?: boolean
        input_fee_ppk?: number
        condition_id?: string
        outcome_collection?: string
        outcome_collection_id?: string
      }>
    }>
  }
  const regular = (await mint.getKeySets()).keysets
  let conditional: Awaited<ReturnType<typeof mint.getConditionalKeysets>>['keysets'] = []
  try {
    conditional = (await mint.getConditionalKeysets({ active: true })).keysets
  } catch {
    conditional = []
  }
  return [...regular, ...conditional]
}

export async function recoverPreparedWalletSends(
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
): Promise<WalletSendRecoveryResult> {
  const state = await ensureState()
  const recoverable = Object.values(state.proofOperations).filter(
    (entry) =>
      entry.kind === 'ctf-consolidation' &&
      (entry.state === 'prepared' ||
        (entry.state === 'completed' && !isCtfConsolidationFinalized(entry, state.wallet.proofs))),
  )
  const result: WalletSendRecoveryResult = { recovered: [], pending: [] }
  for (const entry of recoverable) {
    try {
      await resumeCtfConsolidationOperation(entry, secrets, deps)
      result.recovered.push(entry.operationId)
    } catch (err) {
      result.pending.push({
        operationId: entry.operationId,
        error: errorMessage(err),
      })
    }
  }
  return result
}

async function loadPersistedCtfCustodyBinding(
  entry: ProofOperationRecord,
  deps: WalletOpsDependencies,
): Promise<CtfCustodyBinding> {
  const fence = deps.getCustodyFence?.()
  if (fence === undefined) throw new Error('wallet CTF consolidation requires custody authority')
  const custodyOperationId = deriveDurableCustodyOperationId(fence.scopeId, {
    retainedOperationKey: entry.operationId,
    binding: { kind: 'wallet', activityId: entry.operationId, stage: 'ctf-merge' },
  })
  return withDurableCustodyFencedRead(
    createDaemonStateSqliteSession(profileDir()),
    fence,
    Date.now(),
    (database) => {
      const custody = new DurableCustodySqliteStore(database)
      const record = custody.getOperation(custodyOperationId)
      if (record === null) {
        throw new Error('CTF consolidation recovery lacks canonical custody authority')
      }
      if (
        record.operation.retainedOperationKey !== entry.operationId ||
        record.operation.semanticKind !== 'ctf-merge' ||
        record.operation.custodyContext.normalizedMint !== entry.mintUrl ||
        record.operation.custodyContext.unit !== 'msat'
      ) {
        throw new Error('CTF consolidation persisted custody authority is foreign')
      }
      const exactAuthority = requiredCustodyAuthorityArtifact(record, custody)
      const authority = assertDurableCustodyMintOperationAuthority(record, exactAuthority)
      if (authority.operation.kind !== 'ctf-consolidation') {
        throw new Error('CTF consolidation persisted custody operation is foreign')
      }
      const inputs = authority.operation.inputs.map((input) => durableInputToProof(input))
      const conditionId = readStringMetadata(entry, 'conditionId')
      const inputAssets = authority.operation.inputs.map((input) =>
        consolidatedAsset(conditionId, input.outcomeCollection ?? COLLATERAL_COLLECTION),
      )
      const successorAssets = Object.fromEntries(
        Object.keys(authority.operation.outputs).map((collection) => [
          collection,
          consolidatedAsset(conditionId, collection),
        ]),
      )
      assertPersistedCtfTargetMatchesAuthority(entry, authority, inputAssets, successorAssets)
      return {
        record,
        authority,
        inputs,
        artifacts: {
          requestBody: requiredCustodyRequestArtifact(record, custody),
          output: requiredCustodyOutputArtifact(record, custody),
          privateMaterial: exactAuthority,
        },
        inputAssets,
        successorAssets,
      }
    },
  )
}

function durableInputToProof(input: DurableCustodyProofOperationInput['inputs'][number]): Proof {
  return {
    id:
      input.id ??
      (() => {
        throw new Error('CTF consolidation persisted input keyset is missing')
      })(),
    amount: Amount.from(amountToNumber(input.amount)),
    secret: input.secret,
    C: input.C,
    ...(input.dleq === undefined ? {} : { dleq: input.dleq }),
    ...(input.p2pk_e === undefined ? {} : { p2pk_e: input.p2pk_e }),
    ...(input.witness === undefined ? {} : { witness: input.witness }),
  } as Proof
}

function assertPersistedCtfTargetMatchesAuthority(
  entry: ProofOperationRecord,
  authority: DurableCustodyMintOperationAuthority,
  inputAssets: readonly StoredProofAsset[],
  successorAssets: Readonly<Record<string, StoredProofAsset>>,
): void {
  const targetOutputs = Object.fromEntries(
    Object.entries(deserializeOutputGroups(entry.outputs)).map(([collection, outputs]) => [
      collection,
      outputs.map((output) => serializeDurableCustodyOutput(output)),
    ]),
  )
  const canonicalOutputs = (
    outputs: Record<
      string,
      readonly {
        blindedMessage: { amount: unknown; id: string; B_: string }
        blindingFactor: string
        secret: string
        ephemeralE?: string
      }[]
    >,
  ) =>
    Object.fromEntries(
      Object.entries(outputs).map(([group, groupOutputs]) => [
        group,
        groupOutputs.map((output) => ({
          ...output,
          blindedMessage: {
            ...output.blindedMessage,
            amount: amountToNumber(output.blindedMessage.amount),
          },
        })),
      ]),
    )
  if (
    !isDeepStrictEqual(
      canonicalOutputs(targetOutputs),
      canonicalOutputs(authority.operation.outputs),
    )
  ) {
    throw new Error('CTF consolidation persisted output authority differs from target')
  }
  if (entry.inputs.length !== authority.operation.inputs.length) {
    throw new Error('CTF consolidation persisted input authority differs from target')
  }
  entry.inputs.forEach((proof, index) => {
    const asset = inputAssets[index]
    if (asset === undefined) throw new Error('CTF consolidation persisted input asset is missing')
    if (proof.id === undefined) {
      throw new Error('CTF consolidation persisted input keyset is missing')
    }
    const expected = {
      ...serializeDurableCustodyProofInput({
        ...proof,
        id: proof.id,
        amount: Amount.from(amountToNumber(proof.amount)),
      } as Proof),
      ...(asset.kind === 'Outcome'
        ? { conditionId: asset.conditionId, outcomeCollection: asset.outcomeSetId }
        : {}),
    }
    if (!isDeepStrictEqual(expected, authority.operation.inputs[index])) {
      throw new Error('CTF consolidation persisted input authority differs from target')
    }
  })
  if (!isDeepStrictEqual(entry.metadata.inputAssets, inputAssets)) {
    throw new Error('CTF consolidation persisted input asset authority differs from target')
  }
  if (!isDeepStrictEqual(entry.metadata.successorAssets, successorAssets)) {
    throw new Error('CTF consolidation persisted successor asset authority differs from target')
  }
}

function ctfInputGroupsFromBinding(binding: CtfCustodyBinding): Record<string, Proof[]> {
  const groups: Record<string, Proof[]> = {}
  binding.authority.operation.inputs.forEach((input, index) => {
    const collection = input.outcomeCollection ?? COLLATERAL_COLLECTION
    const proof = binding.inputs[index]
    if (proof === undefined) throw new Error('CTF consolidation persisted input is missing')
    groups[collection] = [...(groups[collection] ?? []), proof]
  })
  return groups
}

function ctfOutputGroupsFromBinding(binding: CtfCustodyBinding): Record<string, OutputData[]> {
  return Object.fromEntries(
    Object.entries(binding.authority.operation.outputs).map(([collection, outputs]) => [
      collection,
      outputs.map((output) => deserializeDurableCustodyOutput(output)),
    ]),
  )
}

async function readPersistedCtfResult(
  binding: CtfCustodyBinding,
  deps: WalletOpsDependencies,
): Promise<Record<string, Proof[]> | null> {
  const fence = deps.getCustodyFence?.()
  if (fence === undefined) throw new Error('wallet CTF consolidation requires custody authority')
  return withDurableCustodyFencedRead(
    createDaemonStateSqliteSession(profileDir()),
    fence,
    Date.now(),
    (database) => {
      const custody = new DurableCustodySqliteStore(database)
      const record = custody.getOperation(binding.record.operation.operationId)
      if (record === null) throw new Error('CTF consolidation custody operation is missing')
      if (record.operation.result.state === 'none') return null
      if (
        record.operation.result.state !== 'verified-staged' &&
        record.operation.result.state !== 'applied'
      ) {
        throw new Error('CTF consolidation persisted result authority is invalid')
      }
      const exactAuthority = requiredCustodyAuthorityArtifact(record, custody)
      const exactResult = requiredCustodyResultArtifact(record, custody)
      const prepared = readDurableCustodyVerifiedMintResult({
        record,
        exactAuthority,
        exactResult,
      })
      const result: Record<string, Proof[]> = {}
      for (const { group, proof } of prepared.proofs) {
        result[group] = [...(result[group] ?? []), proof]
      }
      return result
    },
  )
}

function requireTextMetadata(entry: ProofOperationRecord, key: string): string {
  const value = entry.metadata[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`CTF consolidation metadata ${key} is missing`)
  }
  return value
}

async function resumeCtfConsolidationOperation(
  entry: ProofOperationRecord,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
): Promise<Record<string, Proof[]>> {
  assertCtfConsolidationOperation(entry)
  const conditionId = readStringMetadata(entry, 'conditionId')
  if (entry.state === 'Failed') {
    throw new Error(
      `Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }
  const binding = await loadPersistedCtfCustodyBinding(entry, deps)
  const inputsByCollection = ctfInputGroupsFromBinding(binding)
  const outputsByCollection = ctfOutputGroupsFromBinding(binding)
  const persistedResult = await readPersistedCtfResult(binding, deps)
  if (persistedResult !== null) {
    await finalizeCtfConsolidationResult(
      {
        operationId: entry.operationId,
        custodyOperationId: binding.record.operation.operationId,
        mintUrl: entry.mintUrl,
        conditionId,
        inputsByCollection,
        inputAssets: binding.inputAssets,
        resultProofs: persistedResult,
        outputsByCollection,
        successorAssets: binding.successorAssets,
        keysets: binding.authority.keysets,
        persistedResult: true,
      },
      deps,
    )
    return persistedResult
  }
  if (entry.state === 'completed') {
    throw new Error('CTF consolidation completed target lacks persisted canonical result')
  }
  const fence = deps.getCustodyFence?.()
  if (fence === undefined) throw new Error('wallet CTF consolidation requires custody authority')
  const preflightStates = await readCtfConsolidationInputStates(
    entry.mintUrl,
    secrets,
    binding.inputs,
    deps,
  ).catch(() => null)
  if (preflightStates !== null) {
    const decision = classifyCtfRangeSourceRecovery({
      journalKind: 'consolidation',
      journalState: 'prepared',
      inputStates: preflightStates.map(({ state }) => state),
      now: Math.floor(Date.now() / 1_000),
    })
    if (decision.kind === 'restore-exact-persisted-outputs') {
      const restored = await restorePersistedCtfOutputs(entry, deps)
      await finalizeCtfConsolidationResult(
        {
          operationId: entry.operationId,
          custodyOperationId: binding.record.operation.operationId,
          mintUrl: entry.mintUrl,
          conditionId,
          inputsByCollection,
          inputAssets: binding.inputAssets,
          resultProofs: restored,
          outputsByCollection,
          successorAssets: binding.successorAssets,
          keysets: binding.authority.keysets,
        },
        deps,
      )
      return restored
    }
    if (decision.kind === 'remain-pending') {
      throw new Error(`CTF consolidation recovery remains pending at the mint (${decision.reason})`)
    }
    if (decision.kind === 'fail') throw new Error(decision.reason)
  }
  const request: CtfConvertRequest = {
    condition_id: conditionId,
    inputs: inputsByCollection,
    outputs: Object.fromEntries(
      Object.entries(outputsByCollection).map(([collection, outputs]) => [
        collection,
        outputs.map((output) => ({
          ...output.blindedMessage,
          amount: Amount.from(output.blindedMessage.amount),
        })),
      ]),
    ),
  }
  await prepareCtfConsolidationProofOperationWithExactReservation(
    {
      operationId: entry.operationId,
      kind: 'ctf-consolidation',
      mintUrl: entry.mintUrl,
      inputs: [...binding.inputs],
      outputs: entry.outputs,
      metadata: entry.metadata,
      reservationId: requireTextMetadata(entry, 'reservationId'),
      inputAssets: binding.inputAssets,
    },
    { fence, observedAtMs: Date.now() },
    (database) => {
      const custody = new DurableCustodySqliteStore(database)
      const current = custody.getOperation(binding.record.operation.operationId)
      if (current === null) throw new Error('CTF consolidation custody operation is missing')
      assertCtfCanonicalInputMaterials(
        custody,
        binding,
        binding.inputs,
        binding.inputAssets,
        fence.scopeId,
        Date.now(),
        binding.record.operation.operationId,
      )
      assertDurableCustodyMintOperationAuthority(current, binding.artifacts.privateMaterial)
    },
    deps.injectCustodyFault,
  )
  let resultProofs: Record<string, Proof[]>
  try {
    resultProofs = deps.ctfConvert
      ? await deps.ctfConvert(entry.mintUrl, request, outputsByCollection)
      : await executeMintCtfConvert(entry.mintUrl, request, outputsByCollection)
  } catch (error) {
    if (error instanceof MintOperationError) {
      const inputStates = await readCtfConsolidationInputStates(
        entry.mintUrl,
        secrets,
        binding.inputs,
        deps,
      ).catch(() => null)
      if (inputStates !== null) {
        const postRejectionDecision = classifyCtfRangeSourceRecovery({
          journalKind: 'consolidation',
          journalState: 'prepared',
          inputStates: inputStates.map(({ state }) => state),
          now: Math.floor(Date.now() / 1_000),
        })
        if (postRejectionDecision.kind === 'restore-exact-persisted-outputs') {
          const restored = await restorePersistedCtfOutputs(entry, deps)
          await finalizeCtfConsolidationResult(
            {
              operationId: entry.operationId,
              custodyOperationId: binding.record.operation.operationId,
              mintUrl: entry.mintUrl,
              conditionId,
              inputsByCollection,
              inputAssets: binding.inputAssets,
              resultProofs: restored,
              outputsByCollection,
              successorAssets: binding.successorAssets,
              keysets: binding.authority.keysets,
            },
            deps,
          )
          return restored
        }
      }
      const disposition =
        inputStates === null
          ? 'remain-pending'
          : classifyExactProofConsolidationReplayFailure({
              definiteMintRejection: true,
              inputStates: inputStates.map(({ state }) => state),
            })
      if (disposition === 'release-exact-unspent-inputs') {
        await releaseCtfConsolidationReservations(
          entry.operationId,
          binding,
          fence,
          'CTF consolidation mint rejected before mutation',
        )
        return {}
      }
      throw new Error('CTF consolidation mint rejection remains held for exact recovery')
    }
    throw new Error('CTF consolidation mint result is uncertain')
  }
  await finalizeCtfConsolidationResult(
    {
      operationId: entry.operationId,
      custodyOperationId: binding.record.operation.operationId,
      mintUrl: entry.mintUrl,
      conditionId,
      inputsByCollection,
      inputAssets: binding.inputAssets,
      resultProofs,
      outputsByCollection,
      successorAssets: binding.successorAssets,
      keysets: binding.authority.keysets,
    },
    deps,
  )
  return resultProofs
}

async function restorePersistedCtfOutputs(
  entry: ProofOperationRecord,
  deps: WalletOpsDependencies,
): Promise<Record<string, Proof[]>> {
  const restored = deps.restoreOutputGroups
    ? await deps.restoreOutputGroups(entry.mintUrl, entry.outputs)
    : await restoreOutputGroups(entry.mintUrl, entry.outputs)
  const expectedGroups = Object.keys(entry.outputs).sort()
  const restoredGroups = Object.keys(restored).sort()
  if (
    expectedGroups.length !== restoredGroups.length ||
    expectedGroups.some((group, index) => group !== restoredGroups[index]) ||
    expectedGroups.some(
      (group) => (restored[group]?.length ?? -1) !== (entry.outputs[group]?.length ?? -2),
    )
  ) {
    throw new Error('CTF consolidation persisted output restore is incomplete')
  }
  return restored
}

export function createWallet(
  mintUrl: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
  baseAsset: 'sat',
  exactUnit?: TokenImportUnit,
  counterMutation?: () => FencedStateMutation,
): CashuWalletLike {
  const unit = exactUnit ?? defaultCollateralUnit(baseAsset)
  if (deps.createCashuWallet) return deps.createCashuWallet(mintUrl, unit)
  const mutation = counterMutation ?? mutationFromRuntimeFence(deps.getCustodyFence)
  if (!mutation) {
    throw new Error('default Cashu wallet requires a runtime custody fence provider')
  }
  return new CashuWallet(new CashuMint(mintUrl), {
    unit,
    bip39seed: Buffer.from(secrets.walletSeedHex, 'hex'),
    counterSource: createDaemonCounterSource(mutation, { normalizedMint: mintUrl, unit }),
  }) as CashuWalletLike
}

export function createDaemonCounterSource(
  mutation: () => FencedStateMutation,
  binding: { normalizedMint: string; unit: 'sat' | 'msat' },
): CounterSource {
  return new DaemonCounterSource(mutation, binding)
}

class DaemonCounterSource implements CounterSource {
  readonly #mutation: () => FencedStateMutation
  readonly #binding: { normalizedMint: string; unit: 'sat' | 'msat' }

  constructor(
    mutation: () => FencedStateMutation,
    binding: { normalizedMint: string; unit: 'sat' | 'msat' },
  ) {
    this.#mutation = mutation
    this.#binding = {
      normalizedMint: canonicalizeTokenImportMintUrl(
        binding.normalizedMint,
        isLoopbackHttpUrl(binding.normalizedMint),
      ),
      unit: binding.unit,
    }
  }

  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    return reserveDaemonKeysetCounter(keysetId, n, this.#mutation(), this.#binding)
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    await advanceDaemonKeysetCounter(keysetId, minNext, this.#mutation(), this.#binding)
  }

  async snapshot(): Promise<Record<string, number>> {
    return readDaemonKeysetCounters(this.#binding)
  }
}

function mutationFromRuntimeFence(
  getCustodyFence: (() => CustodyScopeFence) | undefined,
): (() => FencedStateMutation) | undefined {
  if (!getCustodyFence) return undefined
  return () => ({ fence: getCustodyFence(), observedAtMs: Date.now() })
}

function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)
}

function assertCtfConsolidationOperation(entry: ProofOperationRecord): void {
  if (entry.kind !== 'ctf-consolidation') {
    throw new Error(`Proof operation ${entry.operationId} does not match CTF consolidation`)
  }
}

function isCtfConsolidationFinalized(
  entry: ProofOperationRecord,
  walletProofs: Array<{ mintUrl: string; proof: { secret: string } }>,
): boolean {
  const inputSecrets = new Set(entry.inputs.map((proof) => proof.secret))
  if (
    walletProofs.some(
      (record) => record.mintUrl === entry.mintUrl && inputSecrets.has(record.proof.secret),
    )
  ) {
    return false
  }

  const resultSecrets = Object.values(entry.resultProofs ?? {})
    .flat()
    .map((proof) => proof.secret)
  return (
    resultSecrets.length > 0 &&
    resultSecrets.every((secret) =>
      walletProofs.some(
        (record) => record.mintUrl === entry.mintUrl && record.proof.secret === secret,
      ),
    )
  )
}

function ctfConsolidationOperationId(
  conditionId: string,
  type: CtfConsolidationStrategy,
  inputs: Proof[],
): string {
  const inputProofIds = inputs.map((proof) => `${proof.id ?? ''}:${proof.C}`).sort()
  const digest = createHash('sha256')
    .update(JSON.stringify({ conditionId, type, inputProofIds }), 'utf8')
    .digest('hex')
    .slice(0, 32)
  return `ctf-consolidation:${conditionId}:${type}:${digest}`
}

function normalizeProofGroups(
  groups: ProofOperationRecord['resultProofs'] | undefined,
): Record<string, Proof[]> {
  return Object.fromEntries(
    Object.entries(groups ?? {}).map(([collection, proofs]) => [
      collection,
      proofs.map((proof) => normalizeProof(proof as Proof)),
    ]),
  )
}

export function serializeOutputDataArray(
  outputs: Array<
    Pick<OutputDataLike, 'blindedMessage' | 'blindingFactor' | 'secret' | 'ephemeralE'>
  >,
): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: bytesToHex(output.secret),
    ...(output.ephemeralE === undefined ? {} : { ephemeralE: output.ephemeralE }),
  }))
}

export function deserializeOutputGroups(
  groups: Record<string, StoredOutputData[]>,
): Record<string, OutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new OutputData(
            {
              ...output.blindedMessage,
              amount: Amount.from(output.blindedMessage.amount),
            },
            BigInt(`0x${output.blindingFactor}`),
            hexToBytes(output.secret),
            output.ephemeralE,
          ),
      ),
    ]),
  )
}

export async function restoreOutputGroups(
  mintUrl: string,
  outputs: Record<string, StoredOutputData[]>,
): Promise<Record<string, Proof[]>> {
  const mint = new CashuMint(mintUrl)
  const rows = Object.entries(deserializeOutputGroups(outputs)).flatMap(([group, groupOutputs]) =>
    groupOutputs.map((output, index) => ({ group, index, output })),
  )
  if (rows.length === 0) return {}

  const response = await mint.restore({
    outputs: rows.map((row) => row.output.blindedMessage),
  })
  if (response.signatures.length !== response.outputs.length) {
    throw new Error('Mint restore response had mismatched output/signature counts')
  }
  const signaturesByOutput = new Map<string, SerializedBlindedSignature>()
  response.outputs.forEach((output, index) => {
    signaturesByOutput.set(blindedMessageKey(output), response.signatures[index])
  })

  const keysets = new Map<string, MintKeys>()
  const getKeyset = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysets.get(keysetId)
    if (cached) return cached
    const keysetResponse = await mint.getKeys(keysetId)
    const keyset = keysetResponse.keysets.find((candidate) => candidate.id === keysetId)
    if (!keyset) {
      throw new Error(`Mint did not return keys for keyset ${keysetId}`)
    }
    keysets.set(keysetId, keyset)
    return keyset
  }

  const restored: Record<string, Proof[]> = {}
  for (const row of rows) {
    const signature = signaturesByOutput.get(blindedMessageKey(row.output.blindedMessage))
    if (!signature) {
      throw new Error(`Mint restore did not return signature for output ${row.group}[${row.index}]`)
    }
    const keyset = await getKeyset(row.output.blindedMessage.id)
    const proof = row.output.toProof(signature, keyset)
    restored[row.group] = [...(restored[row.group] ?? []), proof]
  }
  return restored
}

function readStringMetadata(entry: ProofOperationRecord, key: string): string {
  const value = entry.metadata[key]
  if (typeof value !== 'string') {
    throw new Error(`Proof operation ${entry.operationId} is missing string metadata ${key}`)
  }
  return value
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function blindedMessageKey(output: SerializedBlindedMessage): string {
  return `${output.id}:${output.B_}`
}

async function receiveOutcomeToken(
  proofs: Proof[],
  mintUrl: string,
  asset: StoredProofAsset,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
  hasInactiveProofs: boolean,
): Promise<WalletReceiveResult> {
  if (!proofs.length) throw new Error('cashu token did not include proofs')
  for (const proof of proofs) {
    if (!isV2KeysetId(proof.id)) {
      throw new Error('cashu outcome receive supports only V2 keysets')
    }
  }
  const wallet = createWallet(mintUrl, secrets, deps, asset.baseAsset, asset.unit)
  await wallet.loadMint()
  if (!wallet.checkProofsStates) {
    throw new Error('cashu wallet does not support proof-state checks')
  }
  const proofStates = await wallet.checkProofsStates(
    proofs.map((proof) => ({ id: proof.id, secret: proof.secret })),
  )
  const firstBlocked = proofStates.find((state) => state.state !== CheckStateEnum.UNSPENT)
  if (firstBlocked) {
    throw new Error(`cashu outcome proof is not spendable: ${firstBlocked.state}`)
  }
  await addAvailableProofs(mintUrl, proofs, asset)
  return {
    mintUrl,
    amountMsat: sumProofs(proofs),
    proofCount: proofs.length,
    asset,
    unit: asset.unit,
    hasInactiveProofs,
  }
}

function isV2KeysetId(id: unknown): id is string {
  return typeof id === 'string' && /^01[0-9a-f]{64}$/.test(id)
}

function resolveReceiveAsset(
  metadata: WalletReceiveMetadata,
  unit: TokenImportUnit,
  context: 'ordinary-sat' | 'ctf-position-msat' | 'ctf-collateral-msat',
): StoredProofAsset {
  if (unit !== 'msat') {
    throw new Error('daemon wallet receive supports only msat tokens')
  }
  if (context === 'ordinary-sat') {
    throw new Error('daemon wallet receive supports only msat tokens')
  }
  const conditionId = requireCanonicalOptionalText(metadata.conditionId, 'conditionId')
  const outcomeSetId = requireCanonicalOptionalText(metadata.outcomeSetId, 'outcomeSetId')
  const baseAsset = normalizeMarketBaseAsset('sat')
  if (!conditionId && !outcomeSetId) {
    if (context === 'ctf-position-msat') {
      throw new Error('conditional msat proofs require conditionId and outcomeSetId')
    }
    return { kind: 'sats', baseAsset, unit }
  }
  if (!conditionId || !outcomeSetId) {
    throw new Error('conditionId and outcomeSetId must be supplied together')
  }
  if (context === 'ctf-collateral-msat') {
    throw new Error('outcome-token imports require exact conditional msat proofs')
  }
  return { kind: 'Outcome', conditionId, outcomeSetId, baseAsset, unit }
}

function requireCanonicalOptionalText(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (!value || value !== value.trim()) throw new Error(`${name} must be canonical non-empty text`)
  return value
}

async function getConditionKeysetIds(
  mintUrl: string,
  conditionId: string,
  deps: WalletOpsDependencies,
): Promise<string[]> {
  if (deps.resolveConditionKeysetIds) {
    return deps.resolveConditionKeysetIds(mintUrl, conditionId)
  }
  const response = await fetch(`${mintUrl.replace(/\/+$/, '')}/v1/conditions/${conditionId}`)
  if (!response.ok) {
    throw new Error(`condition keyset lookup failed with HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    condition?: { keysets?: Record<string, string> }
    keysets?: Record<string, string>
  }
  const keysets = Object.values(body.condition?.keysets ?? body.keysets ?? {})
  if (!keysets.length) {
    throw new Error(`condition ${conditionId} did not include CTF keysets`)
  }
  return keysets
}

async function getDecodeKeysetIds(
  mintUrl: string,
  asset: StoredProofAsset,
  deps: WalletOpsDependencies,
): Promise<string[]> {
  const regular = await getMintKeysetIds(mintUrl, deps)
  if (asset.kind === 'sats') return regular
  return [...regular, ...(await getConditionKeysetIds(mintUrl, asset.conditionId, deps))]
}

async function getMintKeysetIds(mintUrl: string, deps: WalletOpsDependencies): Promise<string[]> {
  if (deps.resolveMintKeysetIds) return deps.resolveMintKeysetIds(mintUrl)
  const response = await fetch(`${mintUrl.replace(/\/+$/, '')}/v1/keysets`)
  if (!response.ok) {
    throw new Error(`mint keyset lookup failed with HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    keysets?: Array<{ id?: string }>
  }
  const keysets = (body.keysets ?? [])
    .map((keyset) => keyset.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (!keysets.length) throw new Error('mint did not return keyset ids')
  return keysets
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function requiredText(value: string | null): string {
  if (!value) throw new Error('CTF consolidation custody result authority is missing')
  return value
}
