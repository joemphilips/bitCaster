import {
  Amount,
  Mint as CashuMint,
  Wallet as CashuWallet,
  CheckStateEnum,
  OutputData,
  getDecodedToken,
  getEncodedToken,
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
  parseCashuProofUnit,
  type CashuProofUnit,
} from '@bitcaster-market/client-sdk/marketUnits'
import {
  addAvailableProofs,
  assertProofOperationCustodyBound,
  completeProofOperationWithWalletUpdate,
  decideProofOperationCustodyRecovery,
  getProofOperation,
  markProofOperationMintSubmitted,
  markProofOperationCompleted,
  prepareProofOperation,
  readCanonicalProofOperationRecoveryPage,
  readStateScope,
  readWalletProofAmountSample,
  selectAvailableSatProofsForSend,
  updateState,
  WalletProofReservationConflictError,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
} from './state.ts'
import type { DaemonProfile } from './profile.ts'
import type {
  WalletConsolidationProofSummary,
  WalletConsolidationResult,
} from './protocol.ts'
import {
  DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX,
  deriveDaemonWalletProofIdFromProof,
} from './stateSqlite.ts'

export interface CashuWalletLike {
  loadMint(): Promise<void>
  receive(
    token: string,
    config?: { proofsWeHave?: Array<{ amount: number }> },
  ): Promise<Proof[]>
  send(
    amount: number,
    proofs: Proof[],
  ): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareSwapToSend?(
    amount: number,
    proofs: Proof[],
    sendConfig?: unknown,
    outputConfig?: unknown,
  ): Promise<SwapPreview>
  completeSwap?(
    swapPreview: SwapPreview,
  ): Promise<{ keep: Proof[]; send: Proof[] }>
  checkProofsStates?(
    proofs: Array<Pick<Proof, 'id' | 'secret'>>,
  ): Promise<ProofState[]>
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
  createCashuWallet?: (
    mintUrl: string,
    baseAsset?: string | null,
  ) => CashuWalletLike
  ctfConvert?: (
    mintUrl: string,
    request: CtfConvertRequest,
    outputsByCollection: Record<string, OutputData[]>,
  ) => Promise<Record<string, Proof[]>>
  resolveInputFeePpkByKeyset?: (
    mintUrl: string,
    keysetIds: string[],
  ) => Promise<Record<string, number>>
  selectCollateralForCtfSplit?: typeof selectCollateralForCtfSplit
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
  resolveConditionKeysetIds?: (
    mintUrl: string,
    conditionId: string,
  ) => Promise<string[]>
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
}

export interface WalletSendResult {
  operationId: string
  mintUrl: string
  amountSats: number
  proofCount: number
  token: string
}

export interface WalletSendRecoveryResult {
  recoveredCount: number
  pendingCount: number
  recovered: string[]
  pending: Array<{ operationId: string; error: string }>
  summaryTruncated: boolean
}

export interface PreparedCtfCollateralResult {
  inputs: Proof[]
  spent: Proof[]
  keep: Proof[]
}

export interface ExecuteCtfConsolidationPlanInput {
  marketId: string
  conditionId: string
  type: CtfConsolidationStrategy
  mintUrl: string
  baseAsset: string
  plan: CtfConsolidationPlan
  outputsByCollection: Record<string, OutputData[]>
  secrets: WalletOpsSecrets
}

const DAEMON_CTF_PROOF_OPERATION_STORE: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationMintSubmitted: async (operationId, redeemBinding) =>
    (await markProofOperationMintSubmitted(
      operationId,
      redeemBinding,
    )) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as CtfProofOperationRecord,
}

export async function receiveWalletToken(
  token: string,
  profile: DaemonProfile,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  metadata: WalletReceiveMetadata = {},
): Promise<WalletReceiveResult> {
  const requestedAsset = resolveReceiveAsset(
    metadata,
    defaultCollateralUnit('sat'),
  )
  const decoded = await decodeTokenForProfile(
    token,
    profile,
    requestedAsset,
    deps,
  )
  const unit = parseCashuProofUnit(decoded.unit)
  if (unit === null) throw new Error('cashu token unit is missing or invalid')
  const asset = resolveReceiveAsset(metadata, unit)
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
      unit,
      secrets,
      deps,
    )
  }

  const wallet = createWallet(mintUrl, secrets, deps, asset.baseAsset, unit)
  await wallet.loadMint()
  const proofsWeHave = await readWalletProofAmountSample({ mintUrl, unit })
  const received = await wallet.receive(token, { proofsWeHave })
  await addAvailableProofs(mintUrl, received, asset, unit)
  return {
    mintUrl,
    amountSats: sumProofs(received),
    proofCount: received.length,
    asset,
  }
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
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('amountSats must be a positive integer')
  }
  if (!mintUrl) throw new Error('mint URL is required')

  return sendWalletTokenWithOperation(
    amountSats,
    mintUrl,
    operationId ?? `wallet-send-${randomUUID()}`,
    secrets,
    deps,
  )
}

export interface SplitAvailableCtfCollateralInput {
  amountSats: number
  mintUrl: string
  operationId: string
  secrets: WalletOpsSecrets
  deps?: WalletOpsDependencies
  baseAsset?: string | null
  proofOperationStore?: CtfProofOperationStore
  beforeCollateralUse?: (proofs: readonly Proof[]) => Promise<void>
  candidateProofs?: readonly Proof[]
}

export async function splitAvailableSatProofsForCtfCollateral(
  input: SplitAvailableCtfCollateralInput,
): Promise<PreparedCtfCollateralResult> {
  const {
    amountSats,
    mintUrl,
    operationId,
    secrets,
    beforeCollateralUse,
    candidateProofs,
  } = input
  const deps = input.deps ?? {}
  const baseAssetInput = input.baseAsset
  const proofOperationStore =
    input.proofOperationStore ?? DAEMON_CTF_PROOF_OPERATION_STORE
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const unit = defaultCollateralUnit(baseAsset)
  const wallet = createWallet(mintUrl, secrets, deps, baseAsset)
  await wallet.loadMint()
  const existing = await proofOperationStore.getProofOperation(operationId)
  if (existing) {
    const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(
      mintUrl,
      wallet,
      deps,
    )
    const grossCtfInputSats = computeGrossCtfInputAmountSats({
      faceAmountSats: amountSats,
      keyset: grossPlanningKeyset,
    })
    const split = await splitRegularProofsWithOperation({
      mintUrl,
      baseAsset,
      operationId,
      wallet,
      proofs: [],
      amountSats: grossCtfInputSats,
      proofOperationStore,
    })
    const exact = await validateExactCtfCollateralFromProofs(
      mintUrl,
      split.send,
      amountSats,
      deps,
    )
    return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
  }

  const availableRows =
    (
      await readStateScope({
        walletProofs: [
          {
            mintUrl,
            unit,
            state: 'available',
            assetKind: 'sats',
            baseAsset,
            candidateLimit: true,
          },
        ],
      })
    )?.wallet.proofs ?? []
  if (candidateProofs
    && candidateProofs.length > DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX) {
    throw new Error('candidate proof selection exceeds the durable input limit')
  }
  const available = candidateProofs
    ? candidateProofs.map((proof) => normalizeProof(proof))
    : availableRows
        .slice(0, DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX)
        .map((record) => record.proof as Proof)

  let directCollateral: Awaited<
    ReturnType<typeof validateExactCtfCollateralFromProofs>
  > | null = null
  try {
    directCollateral = await validateExactCtfCollateralFromProofs(
      mintUrl,
      available,
      amountSats,
      deps,
    )
  } catch {
    // Fall through to wallet-backed selection, then to a regular split if needed.
  }
  if (directCollateral !== null) {
    await beforeCollateralUse?.(directCollateral.inputs)
    return { inputs: directCollateral.inputs, spent: [], keep: [] }
  }

  let selectedCollateral: Awaited<
    ReturnType<typeof selectCollateralForCtfSplit>
  > | null = null
  try {
    const selectCollateral =
      deps.selectCollateralForCtfSplit ?? selectCollateralForCtfSplit
    selectedCollateral = await selectCollateral(
      mintUrl,
      available,
      amountSats,
      baseAsset,
    )
  } catch {
    // Fall through to a regular split that creates a gross CTF input.
  }
  if (selectedCollateral !== null) {
    await beforeCollateralUse?.(selectedCollateral.inputs)
    return { inputs: selectedCollateral.inputs, spent: [], keep: [] }
  }

  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error('cashu wallet does not support fee-aware proof selection')
  }
  const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(
    mintUrl,
    wallet,
    deps,
  )
  const grossCtfInputSats = computeGrossCtfInputAmountSats({
    faceAmountSats: amountSats,
    keyset: grossPlanningKeyset,
  })
  const selected = wallet.selectProofsToSend(
    available,
    grossCtfInputSats,
    true,
    false,
  )
  if (selected.send.length === 0) {
    if (availableRows.length > DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX) {
      throw new Error(
        `available proof selection exceeds the durable input limit of ${DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX}`,
      )
    }
    throw new Error(`insufficient available sats in mint ${mintUrl}`)
  }
  await beforeCollateralUse?.(selected.send)
  const split = await splitRegularProofsWithOperation({
    mintUrl,
    baseAsset,
    operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    proofOperationStore,
  })
  const exact = await validateExactCtfCollateralFromProofs(
    mintUrl,
    split.send,
    amountSats,
    deps,
  )
  return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
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
  const grossInputSats = inputs.reduce(
    (acc, proof) => acc + amountToNumber(proof.amount),
    0,
  )
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

  const operationId = ctfConsolidationOperationId(
    input.conditionId,
    input.type,
    selectedInputs,
  )
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
      inputCollections: Object.entries(input.plan.request.inputs).flatMap(
        ([collection, proofs]) => proofs.map(() => collection),
      ),
      feeSats: input.plan.feeSats,
      collateralOutputSats: input.plan.collateralOutputSats,
      baseAsset: input.baseAsset,
      unit: defaultCollateralUnit(input.baseAsset),
    },
  })
  await markProofOperationMintSubmitted(operationId)

  const resultProofs = deps.ctfConvert
    ? await deps.ctfConvert(
        input.mintUrl,
        input.plan.request,
        input.outputsByCollection,
      )
    : await executeMintCtfConvert(
        input.mintUrl,
        input.plan.request,
        input.outputsByCollection,
      )

  await completeCtfConsolidationOperation({
    operationId,
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    baseAsset: input.baseAsset,
    unit: defaultCollateralUnit(input.baseAsset),
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
  const feeByKeyset = new Map(
    keysetRows.map((keyset) => [keyset.id, keyset.input_fee_ppk ?? 0]),
  )
  return Object.fromEntries(
    unique.map((keysetId) => {
      if (!feeByKeyset.has(keysetId)) {
        throw new Error(
          `mint did not return input_fee_ppk for keyset ${keysetId}`,
        )
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
      keyset.active &&
      keyset.unit === collateralUnit &&
      keyset.condition_id === undefined,
  )
  if (!activeCollateral) {
    throw new Error(
      `mint did not return an active ${collateralUnit} collateral keyset`,
    )
  }
  const entries: Array<[string, string]> = [
    [COLLATERAL_COLLECTION, activeCollateral.id],
  ]
  for (const keyset of keysets) {
    if (!keyset.active || keyset.condition_id !== conditionId) continue
    for (const collection of [
      keyset.outcome_collection,
      keyset.outcome_collection_id,
    ]) {
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
    const keyset = response.keysets.find(
      (candidate) => candidate.id === keysetId,
    )
    if (!keyset)
      throw new Error(`mint did not return keys for keyset ${keysetId}`)
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
    Object.values(request.outputs).flatMap((outputs) =>
      outputs.map((output) => output.id),
    ),
  )
  const result: Record<string, Proof[]> = {}
  for (const [collection, outputs] of Object.entries(outputsByCollection)) {
    const signatures = response.signatures[collection]
    if (!signatures) {
      throw new Error(
        `mint did not return CTF convert signatures for ${collection}`,
      )
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
        throw new Error(
          `mint returned CTF convert signature for unexpected keyset ${signature.id}`,
        )
      }
      if (amountToNumber(signature.amount) !== amountToNumber(message.amount)) {
        throw new Error(
          'mint returned CTF convert signature with unexpected amount',
        )
      }
      const keyset = keysets[message.id]
      if (!keyset) throw new Error(`missing mint keys for keyset ${message.id}`)
      return normalizeProof(
        output.toProof({ ...signature, amount: message.amount }, keyset),
      )
    })
  }
  return result
}

async function completeCtfConsolidationOperation(input: {
  operationId: string
  mintUrl: string
  conditionId: string
  baseAsset: string
  unit: CashuProofUnit
  inputsByCollection: Record<string, Proof[]>
  resultProofs: Record<string, Proof[]>
}): Promise<void> {
  const inputProofs = flattenProofGroups(input.inputsByCollection)
  const resultProofs = flattenProofGroups(input.resultProofs)
  const inputProofIds = inputProofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof),
  )
  await completeProofOperationWithWalletUpdate({
    operationId: input.operationId,
    resultProofs: input.resultProofs,
    walletProofs: [
      {
        proofIds: [
          ...new Set(
            [...inputProofs, ...resultProofs].map((proof) =>
              deriveDaemonWalletProofIdFromProof(
                input.mintUrl,
                input.unit,
                proof,
              ),
            ),
          ),
        ],
      },
    ],
    walletDelta: (now) => ({
      deleteProofIds: inputProofIds,
      upsertProofs: Object.entries(input.resultProofs).flatMap(
        ([collection, proofs]) => {
          const asset: StoredProofAsset =
            collection === COLLATERAL_COLLECTION
              ? { kind: 'sats', baseAsset: input.baseAsset }
              : {
                  kind: 'Outcome',
                  conditionId: input.conditionId,
                  outcomeSetId: collection,
                  baseAsset: input.baseAsset,
                }
          return proofs.map((proof) => ({
            proof: normalizeProof(proof),
            mintUrl: input.mintUrl,
            unit: input.unit,
            state: 'available' as const,
            asset,
            createdAt: now,
            updatedAt: now,
          }))
        },
      ),
    }),
  })
}

function summarizeProofGroups(
  groups: Record<string, Proof[]>,
): WalletConsolidationProofSummary[] {
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
  let conditional: Awaited<
    ReturnType<typeof mint.getConditionalKeysets>
  >['keysets'] = []
  try {
    conditional = (await mint.getConditionalKeysets({ active: true })).keysets
  } catch {
    conditional = []
  }
  return [...regular, ...conditional]
}

async function sendWalletTokenWithOperation(
  amountSats: number,
  mintUrl: string,
  operationId: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
): Promise<WalletSendResult> {
  const baseAsset = normalizeMarketBaseAsset(undefined)
  const unit = defaultCollateralUnit(baseAsset)
  const existing = await getProofOperation(operationId)
  const wallet = createWallet(mintUrl, secrets, deps, baseAsset, unit)
  await wallet.loadMint()
  if (existing) {
    const split = await resumeWalletSendOperation(
      wallet,
      existing,
      mintUrl,
      deps,
    )
    return walletSendResult(operationId, mintUrl, amountSats, split.send)
  }
  const prepareSwapToSend = wallet.prepareSwapToSend?.bind(wallet)
  const completeSwap = wallet.completeSwap?.bind(wallet)
  if (!prepareSwapToSend || !completeSwap) {
    throw new Error('cashu wallet does not support resumable send preparation')
  }
  const preview = await prepareWalletSendOperation({
    amountSats,
    mintUrl,
    operationId,
    baseAsset,
    unit,
    prepareSwapToSend,
  })
  await markProofOperationMintSubmitted(operationId)

  const split = await completeSwap(preview)
  await completeWalletSendOperation({
    operationId,
    mintUrl,
    baseAsset,
    unit,
    inputs: preview.inputs,
    send: split.send,
    keep: split.keep,
  })
  return walletSendResult(operationId, mintUrl, amountSats, split.send)
}

const WALLET_SEND_RESERVATION_ATTEMPTS_MAX = 4

async function prepareWalletSendOperation(input: {
  amountSats: number
  mintUrl: string
  operationId: string
  baseAsset: string
  unit: CashuProofUnit
  prepareSwapToSend: NonNullable<
    ReturnType<typeof createWallet>['prepareSwapToSend']
  >
}): Promise<SwapPreview> {
  const reservationId = `wallet-send:${input.operationId}`
  for (let attempt = 0; attempt < WALLET_SEND_RESERVATION_ATTEMPTS_MAX; attempt += 1) {
    const selected = await selectAvailableSatProofsForSend(input)
    const preview = await input.prepareSwapToSend(
      input.amountSats,
      selected as Proof[],
      undefined,
      { send: { type: 'random' }, keep: { type: 'random' } },
    )
    try {
      await prepareProofOperation({
        operationId: input.operationId,
        kind: 'wallet-send',
        mintUrl: input.mintUrl,
        inputs: preview.inputs,
        outputs: walletSendOutputPlan(preview),
        metadata: walletSendMetadata(preview, reservationId, input),
        walletProofReservation: { reservationId, unit: input.unit },
      })
      return preview
    } catch (error) {
      if (!(error instanceof WalletProofReservationConflictError)) throw error
    }
  }
  throw new WalletProofReservationConflictError()
}

function walletSendOutputPlan(preview: SwapPreview) {
  return {
    send: serializeOutputDataArray(preview.sendOutputs ?? []),
    keep: serializeOutputDataArray(preview.keepOutputs ?? []),
  }
}

function walletSendMetadata(
  preview: SwapPreview,
  reservationId: string,
  input: { baseAsset: string; unit: CashuProofUnit },
) {
  return {
    amount: amountToNumber(preview.amount),
    fees: amountToNumber(preview.fees),
    keysetId: preview.keysetId,
    unselectedProofs: preview.unselectedProofs ?? [],
    reservationId,
    baseAsset: input.baseAsset,
    unit: input.unit,
  }
}

export async function recoverPreparedWalletSends(
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
): Promise<WalletSendRecoveryResult> {
  const result: WalletSendRecoveryResult = {
    recoveredCount: 0,
    pendingCount: 0,
    recovered: [],
    pending: [],
    summaryTruncated: false,
  }
  let cursor: string | null = null
  do {
    const page = await readCanonicalProofOperationRecoveryPage({
      cursor,
      limit: 64,
    })
    for (const work of page.work) {
      if (work.binding.kind !== 'wallet') continue
      const operationId = work.retainedOperationKey
      try {
      const entry = await getProofOperation(operationId)
      if (entry === null) {
        throw new Error('canonical wallet work has no exact daemon operation')
      }
      if (entry.state !== 'prepared' && entry.state !== 'mint-submitted') {
        throw new Error(
          'canonical wallet work has a terminal daemon projection',
        )
      }
      if (work.binding.activityId !== entry.operationId) {
        throw new Error('canonical wallet work has a foreign activity binding')
      }
      await assertProofOperationCustodyBound(entry)
      if (entry.kind === 'ctf-consolidation') {
        await resumeCtfConsolidationOperation(entry, deps)
        } else if (entry.kind === 'wallet-send') {
        const baseAsset = readStringMetadata(entry, 'baseAsset')
        const unit = requireProofUnitMetadata(entry)
        const wallet = createWallet(
          entry.mintUrl,
          secrets,
          deps,
          baseAsset,
          unit,
        )
        await wallet.loadMint()
        await resumeWalletSendOperation(wallet, entry, entry.mintUrl, deps)
        } else {
          throw new Error(
            `Unsupported recoverable wallet operation ${entry.kind}`,
          )
      }
      result.recoveredCount += 1
      if (result.recovered.length < WALLET_RECOVERY_SUMMARY_LIMIT_MAX) {
        result.recovered.push(entry.operationId)
      }
    } catch (err) {
      result.pendingCount += 1
      if (result.pending.length < WALLET_RECOVERY_SUMMARY_LIMIT_MAX) {
        result.pending.push({
          operationId,
          error: errorMessage(err).slice(0, WALLET_RECOVERY_ERROR_LENGTH_MAX),
        })
      }
    }
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  result.summaryTruncated = result.recoveredCount > result.recovered.length
    || result.pendingCount > result.pending.length
  return result
}

const WALLET_RECOVERY_SUMMARY_LIMIT_MAX = 64
const WALLET_RECOVERY_ERROR_LENGTH_MAX = 512

async function resumeCtfConsolidationOperation(
  entry: ProofOperationRecord,
  deps: WalletOpsDependencies,
): Promise<Record<string, Proof[]>> {
  assertCtfConsolidationOperation(entry)
  const conditionId = readStringMetadata(entry, 'conditionId')
  const baseAsset = readStringMetadata(entry, 'baseAsset')
  const unit = requireProofUnitMetadata(entry)
  if (entry.state === 'completed') {
    return normalizeProofGroups(entry.resultProofs!)
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

  if (entry.state === 'prepared') {
    await markProofOperationMintSubmitted(entry.operationId)
  }

  const resultProofs = deps.ctfConvert
    ? await deps.ctfConvert(entry.mintUrl, request, outputsByCollection)
    : await executeMintCtfConvert(entry.mintUrl, request, outputsByCollection)

  await completeCtfConsolidationOperation({
    operationId: entry.operationId,
    mintUrl: entry.mintUrl,
    conditionId,
    baseAsset,
    unit,
    inputsByCollection,
    resultProofs,
  })
  return resultProofs
}

async function resumeWalletSendOperation(
  wallet: CashuWalletLike,
  entry: ProofOperationRecord,
  mintUrl: string,
  deps: WalletOpsDependencies,
): Promise<{ send: Proof[]; keep: Proof[] }> {
  assertWalletSendOperation(entry, mintUrl)
  const baseAsset = readStringMetadata(entry, 'baseAsset')
  const unit = requireProofUnitMetadata(entry)
  if (entry.state === 'completed') {
    return {
      send: entry.resultProofs!.send as Proof[],
      keep: entry.resultProofs!.keep as Proof[],
    }
  }
  if (entry.state === 'Failed') {
    throw new Error(
      `Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }
  if (!wallet.checkProofsStates) {
    throw new Error('cashu wallet does not support proof-state recovery checks')
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id: id ?? '', secret })),
  )
  const classification = classifyWalletRecovery(states)
  const split = await executeWalletCustodyRecovery(
    wallet,
    entry,
    classification,
    deps,
  )

  await completeWalletSendOperation({
    operationId: entry.operationId,
    mintUrl,
    baseAsset,
    unit,
    inputs: entry.inputs as Proof[],
    send: split.send,
    keep: split.keep,
  })
  return split
}

function classifyWalletRecovery(
  states: ProofState[],
): 'all-inputs-unspent' | 'spent-restorable' | 'pending-or-mixed' {
  if (allStates(states, CheckStateEnum.SPENT)) return 'spent-restorable'
  if (allStates(states, CheckStateEnum.UNSPENT)) return 'all-inputs-unspent'
  return 'pending-or-mixed'
}

async function executeWalletCustodyRecovery(
  wallet: CashuWalletLike,
  entry: ProofOperationRecord,
  classification: ReturnType<typeof classifyWalletRecovery>,
  deps: WalletOpsDependencies,
): Promise<{ send: Proof[]; keep: Proof[] }> {
  const decision = await decideProofOperationCustodyRecovery(
    entry,
    classification,
  )
  switch (decision.kind) {
    case 'reissue-exact-operation': {
      if (classification !== 'all-inputs-unspent') {
        throw new Error('wallet reissue decision contradicts mint state')
      }
      if (entry.state === 'prepared') {
        await markProofOperationMintSubmitted(entry.operationId)
      }
      if (!wallet.completeSwap) {
        throw new Error('cashu wallet does not support prepared send completion')
      }
      const result = await wallet.completeSwap(entryToSwapPreview(entry))
      return { send: result.send, keep: result.keep }
    }
    case 'reconcile-exact-operation': {
      if (classification !== 'spent-restorable') {
        throw new Error('wallet reconciliation decision contradicts mint state')
      }
      const restored = deps.restoreOutputGroups
        ? await deps.restoreOutputGroups(entry.mintUrl, entry.outputs)
        : await restoreOutputGroups(entry.mintUrl, entry.outputs)
      return {
        send: restored.send ?? [],
        keep: [...(restored.keep ?? []), ...readUnselectedProofs(entry)],
      }
    }
    case 'retry-later':
      throw new Error(
        `Proof operation ${entry.operationId} is still pending at the mint`,
      )
    case 'abort-no-transport':
      throw new Error('wallet custody operation cannot abort during recovery')
    case 'fail-closed':
      throw new Error(
        `wallet custody recovery failed closed: ${decision.reason}`,
      )
  }
}

async function completeWalletSendOperation(input: {
  operationId: string
  mintUrl: string
  baseAsset: string
  unit: CashuProofUnit
  inputs: Proof[]
  send: Proof[]
  keep: Proof[]
}): Promise<void> {
  const changedProofIds = [...input.inputs, ...input.keep].map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof),
  )
  await completeProofOperationWithWalletUpdate({
    operationId: input.operationId,
    resultProofs: { send: input.send, keep: input.keep },
    walletProofs: [{ proofIds: [...new Set(changedProofIds)] }],
    walletDelta: (now) => ({
      deleteProofIds: input.inputs.map((proof) =>
        deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof),
      ),
      upsertProofs: input.keep.map((proof) => ({
          proof: normalizeProof(proof),
          mintUrl: input.mintUrl,
          unit: input.unit,
          state: 'available',
          asset: { kind: 'sats', baseAsset: input.baseAsset },
          createdAt: now,
          updatedAt: now,
      })),
    }),
  })
}

function walletSendResult(
  operationId: string,
  mintUrl: string,
  amountSats: number,
  sendProofs: Proof[],
  baseAsset?: string | null,
): WalletSendResult {
  const unit = defaultCollateralUnit(baseAsset)
  return {
    operationId,
    mintUrl,
    amountSats,
    proofCount: sendProofs.length,
    token: getEncodedToken({ mint: mintUrl, unit, proofs: sendProofs }),
  }
}

function createWallet(
  mintUrl: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
  baseAsset?: string | null,
  unitInput?: CashuProofUnit,
): CashuWalletLike {
  const unit = unitInput ?? defaultCollateralUnit(baseAsset)
  if (deps.createCashuWallet) return deps.createCashuWallet(mintUrl, unit)
  return new CashuWallet(new CashuMint(mintUrl), {
    unit,
    bip39seed: Buffer.from(secrets.walletSeedHex, 'hex'),
    counterSource: new DaemonCounterSource(),
  }) as CashuWalletLike
}

class DaemonCounterSource implements CounterSource {
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid counter reservation size: ${n}`)
    }
    return updateState({ keysetCounterKeys: [keysetId] }, (state) => {
      const start = state.wallet.keysetCounters[keysetId] ?? 0
      if (n > 0) {
        state.wallet.keysetCounters[keysetId] = start + n
      }
      return { start, count: n }
    })
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    if (!Number.isInteger(minNext) || minNext < 0) {
      throw new Error(`invalid counter advance target: ${minNext}`)
    }
    await updateState({ keysetCounterKeys: [keysetId] }, (state) => {
      const current = state.wallet.keysetCounters[keysetId] ?? 0
      if (minNext > current) {
        state.wallet.keysetCounters[keysetId] = minNext
      }
    })
  }

  async setNext(keysetId: string, next: number): Promise<void> {
    if (!Number.isInteger(next) || next < 0) {
      throw new Error(`invalid counter value: ${next}`)
    }
    await updateState({ keysetCounterKeys: [keysetId] }, (state) => {
      state.wallet.keysetCounters[keysetId] = next
    })
  }

  async snapshot(): Promise<Record<string, number>> {
    return {
      ...(await readStateScope({ keysetCounterKeys: 'all' }))?.wallet
        .keysetCounters,
    }
  }
}

function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)
}

function assertWalletSendOperation(
  entry: ProofOperationRecord,
  mintUrl: string,
): void {
  if (entry.kind !== 'wallet-send' || entry.mintUrl !== mintUrl) {
    throw new Error(
      `Proof operation ${entry.operationId} does not match this wallet send`,
    )
  }
}

function assertCtfConsolidationOperation(entry: ProofOperationRecord): void {
  if (entry.kind !== 'ctf-consolidation') {
    throw new Error(
      `Proof operation ${entry.operationId} does not match CTF consolidation`,
    )
  }
}

function ctfConsolidationOperationId(
  conditionId: string,
  type: CtfConsolidationStrategy,
  inputs: Proof[],
): string {
  const inputProofIds = inputs
    .map((proof) => `${proof.id ?? ''}:${proof.C}`)
    .sort()
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
    !Array.isArray(inputCollections) ||
    inputCollections.length !== entry.inputs.length ||
    inputCollections.some(
      (collection) => typeof collection !== 'string' || collection.length === 0,
  )
  ) {
    throw new Error(
      `Proof operation ${entry.operationId} is missing CTF consolidation input collection metadata`,
    )
  }
  return groupInputsByCollection(
    entry.inputs as Proof[],
    inputCollections as string[],
  )
}

function groupInputsByCollection(
  inputs: Proof[],
  collections: string[],
): Record<string, Proof[]> {
  const grouped: Record<string, Proof[]> = {}
  inputs.forEach((proof, index) => {
    const collection = collections[index]
    grouped[collection] = [
      ...(grouped[collection] ?? []),
      normalizeProof(proof),
    ]
  })
  return grouped
}

function normalizeProofGroups(
  groups: NonNullable<ProofOperationRecord['resultProofs']>,
): Record<string, Proof[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([collection, proofs]) => [
      collection,
      proofs.map((proof) => normalizeProof(proof as Proof)),
    ]),
  )
}

function serializeOutputDataArray(
  outputs: Array<
    Pick<OutputDataLike, 'blindedMessage' | 'blindingFactor' | 'secret'>
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
  }))
}

function deserializeOutputGroups(
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
          ),
      ),
    ]),
  )
}

async function restoreOutputGroups(
  mintUrl: string,
  outputs: Record<string, StoredOutputData[]>,
): Promise<Record<string, Proof[]>> {
  const mint = new CashuMint(mintUrl)
  const rows = Object.entries(deserializeOutputGroups(outputs)).flatMap(
    ([group, groupOutputs]) =>
      groupOutputs.map((output, index) => ({ group, index, output })),
  )
  if (rows.length === 0) return {}

  const response = await mint.restore({
    outputs: rows.map((row) => row.output.blindedMessage),
  })
  if (response.signatures.length !== response.outputs.length) {
    throw new Error(
      'Mint restore response had mismatched output/signature counts',
    )
  }
  const signaturesByOutput = new Map<string, SerializedBlindedSignature>()
  response.outputs.forEach((output, index) => {
    signaturesByOutput.set(
      blindedMessageKey(output),
      response.signatures[index],
    )
  })

  const keysets = new Map<string, MintKeys>()
  const getKeyset = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysets.get(keysetId)
    if (cached) return cached
    const keysetResponse = await mint.getKeys(keysetId)
    const keyset = keysetResponse.keysets.find(
      (candidate) => candidate.id === keysetId,
    )
    if (!keyset) {
      throw new Error(`Mint did not return keys for keyset ${keysetId}`)
    }
    keysets.set(keysetId, keyset)
    return keyset
  }

  const restored: Record<string, Proof[]> = {}
  for (const row of rows) {
    const signature = signaturesByOutput.get(
      blindedMessageKey(row.output.blindedMessage),
    )
    if (!signature) {
      throw new Error(
        `Mint restore did not return signature for output ${row.group}[${row.index}]`,
      )
    }
    const keyset = await getKeyset(row.output.blindedMessage.id)
    const proof = row.output.toProof(signature, keyset)
    restored[row.group] = [...(restored[row.group] ?? []), proof]
  }
  return restored
}

function entryToSwapPreview(entry: ProofOperationRecord): SwapPreview {
  return {
    amount: Amount.from(readNumberMetadata(entry, 'amount')),
    fees: Amount.from(readNumberMetadata(entry, 'fees')),
    keysetId: readStringMetadata(entry, 'keysetId'),
    inputs: entry.inputs as Proof[],
    sendOutputs:
      deserializeOutputGroups({ send: entry.outputs.send ?? [] }).send ?? [],
    keepOutputs:
      deserializeOutputGroups({ keep: entry.outputs.keep ?? [] }).keep ?? [],
    unselectedProofs: readUnselectedProofs(entry),
  }
}

function readUnselectedProofs(entry: ProofOperationRecord): Proof[] {
  const value = entry.metadata.unselectedProofs
  return Array.isArray(value) ? (structuredClone(value) as Proof[]) : []
}

function readNumberMetadata(entry: ProofOperationRecord, key: string): number {
  const value = entry.metadata[key]
  if (typeof value !== 'number') {
    throw new Error(
      `Proof operation ${entry.operationId} is missing numeric metadata ${key}`,
    )
  }
  return value
}

function readStringMetadata(entry: ProofOperationRecord, key: string): string {
  const value = entry.metadata[key]
  if (typeof value !== 'string') {
    throw new Error(
      `Proof operation ${entry.operationId} is missing string metadata ${key}`,
    )
  }
  return value
}

function requireProofUnitMetadata(
  entry: ProofOperationRecord,
): CashuProofUnit {
  const unit = parseCashuProofUnit(readStringMetadata(entry, 'unit'))
  if (unit === null) {
    throw new Error(`Proof operation ${entry.operationId} has invalid unit metadata`)
  }
  return unit
}

function allStates(states: ProofState[], expected: string): boolean {
  return states.length > 0 && states.every((state) => state.state === expected)
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
  unit: CashuProofUnit,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
): Promise<WalletReceiveResult> {
  if (!proofs.length) throw new Error('cashu token did not include proofs')
  const wallet = createWallet(mintUrl, secrets, deps, asset.baseAsset, unit)
  await wallet.loadMint()
  if (!wallet.checkProofsStates) {
    throw new Error('cashu wallet does not support proof-state checks')
  }
  const proofStates = await wallet.checkProofsStates(
    proofs.map((proof) => ({ id: proof.id, secret: proof.secret })),
  )
  const firstBlocked = proofStates.find(
    (state) => state.state !== CheckStateEnum.UNSPENT,
  )
  if (firstBlocked) {
    throw new Error(
      `cashu outcome proof is not spendable: ${firstBlocked.state}`,
    )
  }
  await addAvailableProofs(mintUrl, proofs, asset, unit)
  return {
    mintUrl,
    amountSats: sumProofs(proofs),
    proofCount: proofs.length,
    asset,
  }
}

function resolveReceiveAsset(
  metadata: WalletReceiveMetadata,
  unit: CashuProofUnit,
): StoredProofAsset {
  const conditionId = metadata.conditionId?.trim()
  const outcomeSetId = metadata.outcomeSetId?.trim()
  const baseAsset = normalizeMarketBaseAsset(unit)
  if (!conditionId && !outcomeSetId) return { kind: 'sats', baseAsset }
  if (!conditionId || !outcomeSetId) {
    throw new Error('conditionId and outcomeSetId must be supplied together')
  }
  return { kind: 'Outcome', conditionId, outcomeSetId, baseAsset }
}

async function getConditionKeysetIds(
  mintUrl: string,
  conditionId: string,
  deps: WalletOpsDependencies,
): Promise<string[]> {
  if (deps.resolveConditionKeysetIds) {
    return deps.resolveConditionKeysetIds(mintUrl, conditionId)
  }
  const response = await fetch(
    `${mintUrl.replace(/\/+$/, '')}/v1/conditions/${conditionId}`,
  )
  if (!response.ok) {
    throw new Error(
      `condition keyset lookup failed with HTTP ${response.status}`,
    )
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
  return [
    ...regular,
    ...(await getConditionKeysetIds(mintUrl, asset.conditionId, deps)),
  ]
}

async function getMintKeysetIds(
  mintUrl: string,
  deps: WalletOpsDependencies,
): Promise<string[]> {
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
