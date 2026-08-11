import {
  Amount,
  Mint as CashuMint,
  Wallet as CashuWallet,
  CheckStateEnum,
  OutputData,
  getDecodedToken,
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
import {
  computeGrossCtfInputAmountSats,
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
  computeInputFeeSatsForProofs,
} from '@bitcaster-market/client-sdk/proofSelection'
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
import { redactedTransferMetadata } from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import {
  addAvailableProofs,
  advanceDaemonKeysetCounter,
  ensureState,
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  readDaemonKeysetCounters,
  readAvailableWalletProofAmountSamplesForReceive,
  reserveDaemonKeysetCounter,
  updateState,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
} from './state.ts'
import { profileDir, type DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
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
  restoreOutputGroups?: (
    mintUrl: string,
    outputs: Record<string, StoredOutputData[]>,
  ) => Promise<Record<string, Proof[]>>
  resolveMintKeysetIds?: (mintUrl: string) => Promise<string[]>
  resolveConditionKeysetIds?: (mintUrl: string, conditionId: string) => Promise<string[]>
  resolveRootPreflightOutputAmountSats?: (params: {
    mintUrl: string
    baseAsset?: string | null
    conditionId: string
    amountSats: number
    lockOutcomeSetId: string
    keepOutcomeSetId: string
  }) => Promise<number>
  resolveRootDirectLockOutputAmountSats?: (params: {
    mintUrl: string
    baseAsset?: string | null
    conditionId: string
    amountSats: number
    lockOutcomeSetId: string
    keepOutcomeSetId: string
  }) => Promise<number>
}

export interface WalletOpsSecrets {
  walletSeedHex: string
}

export interface WalletReceiveResult {
  mintUrl: string
  amountSats: number
  proofCount: number
  asset: StoredProofAsset
  unit: TokenImportUnit
  hasInactiveProofs: boolean
}

export interface WalletSendResult {
  operationId: string
  mintUrl: string
  amountSats: number
  proofCount: number
  token: string
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
    amountSats: sumProofs([...received.proofs]),
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
  amountSats: number,
  profile: DaemonProfile,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  mintUrl = profile.mintUrl,
  operationId?: string,
): Promise<WalletSendResult> {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error('amountSats must be a positive safe integer')
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
  const wallet = createWallet(mintUrl, secrets, deps, 'sat', 'sat')
  await wallet.loadMint()
  const transfer =
    existing === null
      ? await coordinator.execute({ transferId, amountSats, mintUrl, wallet })
      : await coordinator.recover({ transfer: existing, amountSats, mintUrl, wallet })
  if (transfer.token === null) throw new Error('durable outgoing Cashu token admission is absent')
  return {
    operationId: transfer.walletSendOperation.operationId,
    mintUrl: transfer.mintUrl,
    amountSats,
    proofCount: transfer.token.proofs.length,
    token: transfer.token.encodedToken,
  }
}

/** Recover one bounded page of due outgoing bearer transfers without token delivery. */
export async function recoverDurableOutgoingCashuTransfers(
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
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
    walletFor: async (mintUrl, unit) => createWallet(mintUrl, secrets, deps, 'sat', unit),
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
  const wallet = createWallet(
    transfer.mintUrl,
    secrets,
    deps,
    'sat',
    transfer.unit as TokenImportUnit,
  )
  await wallet.loadMint()
  return redactedTransferMetadata(await coordinator.reclaim({ transferId, wallet }))
}

export async function splitAvailableSatProofsForCtfCollateral(
  amountSats: number,
  mintUrl: string,
  operationId: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  baseAssetInput?: string | null,
  operationAuthority?: CtfCollateralOperationAuthority,
): Promise<PreparedCtfCollateralResult> {
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
      amountSats: requirePersistedCtfCollateralAmount(existing),
      proofOperationStore,
      beforeMintMutation: operationAuthority?.beforeMintMutation,
    })
    const exact = await validateExactCtfCollateralFromProofs(mintUrl, split.send, amountSats, deps)
    return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
  }
  await wallet.loadMint()

  const available = await readAvailableCollateralProofs(mintUrl, baseAsset, operationAuthority)

  try {
    const exact = await validateExactCtfCollateralFromProofs(mintUrl, available, amountSats, deps)
    return { inputs: exact.inputs, spent: [], keep: [] }
  } catch {
    // Fall through to wallet-backed selection, then to a regular split if needed.
  }

  try {
    const exact = await selectCollateralForCtfSplit(mintUrl, available, amountSats, baseAsset)
    return { inputs: exact.inputs, spent: [], keep: [] }
  } catch {
    // Fall through to a regular split that creates a gross CTF input.
  }

  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error('cashu wallet does not support fee-aware proof selection')
  }
  const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(mintUrl, wallet, deps)
  const grossCtfInputSats = computeGrossCtfInputAmountSats({
    faceAmountSats: amountSats,
    keyset: grossPlanningKeyset,
  })
  const selected = wallet.selectProofsToSend(available, grossCtfInputSats, true, false)
  if (selected.send.length === 0) {
    throw new Error(`insufficient available sats in mint ${mintUrl}`)
  }
  const split = await splitRegularProofsWithOperation({
    mintUrl,
    baseAsset,
    operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    proofOperationStore,
    beforeMintMutation: operationAuthority?.beforeMintMutation,
  })
  const exact = await validateExactCtfCollateralFromProofs(mintUrl, split.send, amountSats, deps)
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
  faceAmountSats: number,
  deps: WalletOpsDependencies,
): Promise<{
  inputs: Proof[]
  keep: Proof[]
  inputFeeSats: number
  grossInputSats: number
}> {
  const inputs = proofs.map(normalizeProof)
  const inputFeePpkByKeyset = await resolveCtfConsolidationInputFees(
    mintUrl,
    inputs.map((proof) => proof.id),
    deps,
  )
  const inputFeeSats = computeInputFeeSatsForProofs(inputs, inputFeePpkByKeyset)
  const grossInputSats = inputs.reduce((acc, proof) => acc + amountToNumber(proof.amount), 0)
  const netInputSats = grossInputSats - inputFeeSats
  if (netInputSats !== faceAmountSats) {
    throw new Error(
      `CTF split inputs net ${netInputSats} sats after ${inputFeeSats} sats input fee, expected ${faceAmountSats}`,
    )
  }
  return { inputs, keep: [], inputFeeSats, grossInputSats }
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
  await prepareProofOperation({
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
      inputCollections: Object.entries(input.plan.request.inputs).flatMap(([collection, proofs]) =>
        proofs.map(() => collection),
      ),
      feeSats: input.plan.feeSats,
      collateralOutputSats: input.plan.collateralOutputSats,
    },
  })

  const resultProofs = deps.ctfConvert
    ? await deps.ctfConvert(input.mintUrl, input.plan.request, input.outputsByCollection)
    : await executeMintCtfConvert(input.mintUrl, input.plan.request, input.outputsByCollection)

  await markProofOperationCompleted(operationId, resultProofs)
  await replaceConsolidatedProofs({
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    inputsByCollection: input.plan.request.inputs,
    resultProofs,
  })

  return {
    marketId: input.marketId,
    conditionId: input.conditionId,
    type: input.type,
    status: 'consolidated',
    convertFeeSats: input.plan.feeSats,
    collateralReturnedSats: input.plan.collateralOutputSats,
    spentInputs: summarizeProofGroups(input.plan.request.inputs),
    outputs: summarizeProofGroups(resultProofs),
  }
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

async function replaceConsolidatedProofs(input: {
  mintUrl: string
  conditionId: string
  inputsByCollection: Record<string, Proof[]>
  resultProofs: Record<string, Proof[]>
}): Promise<void> {
  const spentSecrets = new Set(
    flattenProofGroups(input.inputsByCollection).map((proof) => proof.secret),
  )
  await updateState((state, now) => {
    state.wallet.proofs = state.wallet.proofs.filter(
      (record) => record.mintUrl !== input.mintUrl || !spentSecrets.has(record.proof.secret),
    )
    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === input.mintUrl)
        .map((record) => record.proof.secret),
    )
    for (const [collection, proofs] of Object.entries(input.resultProofs)) {
      const asset: StoredProofAsset =
        collection === COLLATERAL_COLLECTION
          ? { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
          : {
              kind: 'Outcome',
              conditionId: input.conditionId,
              outcomeSetId: collection,
              baseAsset: 'sat',
              unit: 'msat',
            }
      for (const proof of proofs) {
        if (existingSecrets.has(proof.secret)) continue
        existingSecrets.add(proof.secret)
        state.wallet.proofs.push({
          proof: normalizeProof(proof),
          mintUrl: input.mintUrl,
          state: 'available',
          asset,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  })
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
  _secrets: WalletOpsSecrets,
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
      await resumeCtfConsolidationOperation(entry, deps)
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

async function resumeCtfConsolidationOperation(
  entry: ProofOperationRecord,
  deps: WalletOpsDependencies,
): Promise<Record<string, Proof[]>> {
  assertCtfConsolidationOperation(entry)
  const conditionId = readStringMetadata(entry, 'conditionId')
  if (entry.state === 'completed') {
    const resultProofs = normalizeProofGroups(entry.resultProofs ?? {})
    await replaceConsolidatedProofs({
      mintUrl: entry.mintUrl,
      conditionId,
      inputsByCollection: { [COLLATERAL_COLLECTION]: entry.inputs as Proof[] },
      resultProofs,
    })
    return resultProofs
  }
  if (entry.state === 'Failed') {
    throw new Error(
      `Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }

  const inputsByCollection = await ctfConsolidationInputGroups(entry)
  const outputsByCollection = deserializeOutputGroups(entry.outputs)
  const request: CtfConvertRequest = {
    condition_id: conditionId,
    inputs: inputsByCollection,
    outputs: Object.fromEntries(
      Object.entries(entry.outputs).map(([collection, outputs]) => [
        collection,
        outputs.map((output) => ({
          ...output.blindedMessage,
          amount: Amount.from(output.blindedMessage.amount),
        })),
      ]),
    ),
  }

  const resultProofs = deps.ctfConvert
    ? await deps.ctfConvert(entry.mintUrl, request, outputsByCollection)
    : await executeMintCtfConvert(entry.mintUrl, request, outputsByCollection)

  await markProofOperationCompleted(entry.operationId, resultProofs)
  await replaceConsolidatedProofs({
    mintUrl: entry.mintUrl,
    conditionId,
    inputsByCollection,
    resultProofs,
  })
  return resultProofs
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

async function ctfConsolidationInputGroups(
  entry: ProofOperationRecord,
): Promise<Record<string, Proof[]>> {
  const inputCollections = entry.metadata.inputCollections
  if (
    Array.isArray(inputCollections) &&
    inputCollections.length === entry.inputs.length &&
    inputCollections.every((collection) => typeof collection === 'string')
  ) {
    return groupInputsByCollection(entry.inputs as Proof[], inputCollections as string[])
  }

  const state = await ensureState()
  const collectionBySecret = new Map<string, string>()
  for (const record of state.wallet.proofs) {
    if (record.mintUrl !== entry.mintUrl) continue
    collectionBySecret.set(record.proof.secret, proofCollection(record.asset))
  }
  const recoveredCollections = entry.inputs.map((proof) => collectionBySecret.get(proof.secret))
  if (recoveredCollections.some((collection) => !collection)) {
    throw new Error(
      `Proof operation ${entry.operationId} is missing CTF consolidation input collection metadata`,
    )
  }
  return groupInputsByCollection(entry.inputs as Proof[], recoveredCollections as string[])
}

function groupInputsByCollection(inputs: Proof[], collections: string[]): Record<string, Proof[]> {
  const grouped: Record<string, Proof[]> = {}
  inputs.forEach((proof, index) => {
    const collection = collections[index]
    grouped[collection] = [...(grouped[collection] ?? []), normalizeProof(proof)]
  })
  return grouped
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

function proofCollection(asset: StoredProofAsset): string {
  return asset.kind === 'sats' ? COLLATERAL_COLLECTION : asset.outcomeSetId
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
    amountSats: sumProofs(proofs),
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
  if (context !== 'ctf-position-msat' || unit !== 'msat') {
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
