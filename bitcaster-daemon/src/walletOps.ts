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
} from '@bitcaster-market/client-sdk/marketUnits'
import {
  addAvailableProofs,
  completeReservedSatSend,
  ensureState,
  getProofOperation,
  markProofOperationMintSubmitted,
  markProofOperationCompleted,
  prepareProofOperation,
  releaseProofReservation,
  reserveAvailableSatProofsForSend,
  updateState,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
} from './state.ts'
import type { DaemonProfile } from './profile.ts'
import type {
  WalletConsolidationProofSummary,
  WalletConsolidationResult,
} from './protocol.ts'

export interface CashuWalletLike {
  loadMint(): Promise<void>
  receive(token: string, config?: { proofsWeHave?: Proof[] }): Promise<Proof[]>
  send(amount: number, proofs: Proof[]): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareSwapToSend?(
    amount: number,
    proofs: Proof[],
    sendConfig?: unknown,
    outputConfig?: unknown,
  ): Promise<SwapPreview>
  completeSwap?(swapPreview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
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
  createCashuWallet?: (mintUrl: string, baseAsset?: string | null) => CashuWalletLike
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
  recovered: string[]
  pending: Array<{ operationId: string; error: string }>
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
  const asset = resolveReceiveAsset(metadata)
  const decoded = await decodeTokenForProfile(token, profile, asset, deps)
  const mintUrl = decoded.mint || profile.mintUrl
  if (!mintUrl) throw new Error('cashu token did not include a mint URL')
  if (mintUrl !== profile.mintUrl) {
    throw new Error('cashu token mint does not match daemon profile mint')
  }
  if (asset.kind === 'Outcome') {
    return receiveOutcomeToken(decoded.proofs as Proof[], mintUrl, asset, secrets, deps)
  }

  const wallet = createWallet(mintUrl, secrets, deps)
  await wallet.loadMint()
  const state = await ensureState()
  const proofsWeHave = state.wallet.proofs
    .filter((record) => record.mintUrl === mintUrl)
    .map((record) => record.proof as Proof)
  const received = await wallet.receive(token, { proofsWeHave })
  await addAvailableProofs(mintUrl, received, asset)
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

export async function splitAvailableSatProofsForCtfCollateral(
  amountSats: number,
  mintUrl: string,
  operationId: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
  baseAssetInput?: string | null,
): Promise<PreparedCtfCollateralResult> {
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const wallet = createWallet(mintUrl, secrets, deps, baseAsset)
  await wallet.loadMint()
  const existing = await getProofOperation(operationId)
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
      proofOperationStore: DAEMON_CTF_PROOF_OPERATION_STORE,
    })
    const exact = await validateExactCtfCollateralFromProofs(
      mintUrl,
      split.send,
      amountSats,
      deps,
    )
    return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
  }

  const available = (await ensureState()).wallet.proofs
    .filter(
      (record) =>
        record.mintUrl === mintUrl &&
        record.state === 'available' &&
        record.asset.kind === 'sats' &&
        normalizeMarketBaseAsset(record.asset.baseAsset) === baseAsset,
    )
    .map((record) => record.proof as Proof)

  try {
    const exact = await validateExactCtfCollateralFromProofs(
      mintUrl,
      available,
      amountSats,
      deps,
    )
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
  const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(
    mintUrl,
    wallet,
    deps,
  )
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
    proofOperationStore: DAEMON_CTF_PROOF_OPERATION_STORE,
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
  const inputFeeSats = computeInputFeeSatsForProofs(
    inputs,
    inputFeePpkByKeyset,
  )
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
  const feeByKeyset = new Map(
    keysetRows.map((keyset) => [keyset.id, keyset.input_fee_ppk ?? 0]),
  )
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
      keyset.active &&
      keyset.unit === collateralUnit &&
      keyset.condition_id === undefined,
  )
  if (!activeCollateral) {
    throw new Error(`mint did not return an active ${collateralUnit} collateral keyset`)
  }
  const entries: Array<[string, string]> = [[COLLATERAL_COLLECTION, activeCollateral.id]]
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
    Object.values(request.outputs).flatMap((outputs) =>
      outputs.map((output) => output.id),
    ),
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
      return normalizeProof(
        output.toProof({ ...signature, amount: message.amount }, keyset),
      )
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
      (record) =>
        record.mintUrl !== input.mintUrl || !spentSecrets.has(record.proof.secret),
    )
    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === input.mintUrl)
        .map((record) => record.proof.secret),
    )
    for (const [collection, proofs] of Object.entries(input.resultProofs)) {
      const asset: StoredProofAsset =
        collection === COLLATERAL_COLLECTION
          ? { kind: 'sats' }
          : { kind: 'Outcome', conditionId: input.conditionId, outcomeSetId: collection }
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
  let conditional: Awaited<ReturnType<typeof mint.getConditionalKeysets>>['keysets'] = []
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
  const existing = await getProofOperation(operationId)
  const wallet = createWallet(mintUrl, secrets, deps)
  await wallet.loadMint()
  if (existing) {
    const split = await resumeWalletSendOperation(wallet, existing, mintUrl, deps)
    return walletSendResult(operationId, mintUrl, amountSats, split.send)
  }

  const reservationId = `wallet-send:${operationId}`
  const selected = await reserveAvailableSatProofsForSend({
    mintUrl,
    amountSats,
    reservedBy: reservationId,
  })
  const selectedProofs = selected as Proof[]
  if (!wallet.prepareSwapToSend || !wallet.completeSwap) {
    await releaseProofReservation(reservationId)
    throw new Error('cashu wallet does not support resumable send preparation')
  }

  let preview: SwapPreview
  try {
    preview = await wallet.prepareSwapToSend(
      amountSats,
      selectedProofs,
      undefined,
      { send: { type: 'random' }, keep: { type: 'random' } },
    )
  } catch (err) {
    await releaseProofReservation(reservationId)
    throw err
  }

  await prepareProofOperation({
    operationId,
    kind: 'wallet-send',
    mintUrl,
    inputs: preview.inputs,
    outputs: {
      send: serializeOutputDataArray(preview.sendOutputs ?? []),
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: {
      amount: amountToNumber(preview.amount),
      fees: amountToNumber(preview.fees),
      keysetId: preview.keysetId,
      unselectedProofs: preview.unselectedProofs ?? [],
      reservationId,
    },
  })

  const split = await wallet.completeSwap(preview)
  await markProofOperationCompleted(operationId, {
    send: split.send,
    keep: split.keep,
  })
  await completeReservedSatSend({
    mintUrl,
    reservedBy: reservationId,
    keepProofs: split.keep,
  })
  return walletSendResult(operationId, mintUrl, amountSats, split.send)
}

export async function recoverPreparedWalletSends(
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies = {},
): Promise<WalletSendRecoveryResult> {
  const state = await ensureState()
  const recoverable = Object.values(state.proofOperations).filter(
    (entry) =>
      (entry.kind === 'wallet-send' && entry.state === 'prepared') ||
      (entry.kind === 'ctf-consolidation' &&
        (entry.state === 'prepared' ||
          (entry.state === 'completed' &&
            !isCtfConsolidationFinalized(entry, state.wallet.proofs)))),
  )
  const result: WalletSendRecoveryResult = { recovered: [], pending: [] }
  for (const entry of recoverable) {
    try {
      if (entry.kind === 'ctf-consolidation') {
        await resumeCtfConsolidationOperation(entry, deps)
      } else {
        const wallet = createWallet(entry.mintUrl, secrets, deps)
        await wallet.loadMint()
        await resumeWalletSendOperation(wallet, entry, entry.mintUrl, deps)
      }
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

async function resumeWalletSendOperation(
  wallet: CashuWalletLike,
  entry: ProofOperationRecord,
  mintUrl: string,
  deps: WalletOpsDependencies,
): Promise<{ send: Proof[]; keep: Proof[] }> {
  assertWalletSendOperation(entry, mintUrl)
  const reservationId = readStringMetadata(entry, 'reservationId')
  if (entry.state === 'completed') {
    const split = {
      send: (entry.resultProofs?.send ?? []) as Proof[],
      keep: (entry.resultProofs?.keep ?? []) as Proof[],
    }
    await completeReservedSatSend({
      mintUrl,
      reservedBy: reservationId,
      keepProofs: split.keep,
    })
    return split
  }
  if (entry.state === 'Failed') {
    throw new Error(`Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`)
  }
  if (!wallet.checkProofsStates) {
    throw new Error('cashu wallet does not support proof-state recovery checks')
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id: id ?? '', secret })),
  )
  let split: { send: Proof[]; keep: Proof[] }
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = deps.restoreOutputGroups
      ? await deps.restoreOutputGroups(entry.mintUrl, entry.outputs)
      : await restoreOutputGroups(entry.mintUrl, entry.outputs)
    split = {
      send: restored.send ?? [],
      keep: [
        ...(restored.keep ?? []),
        ...readUnselectedProofs(entry),
      ],
    }
  } else if (allStates(states, CheckStateEnum.UNSPENT)) {
    if (!wallet.completeSwap) {
      throw new Error('cashu wallet does not support prepared send completion')
    }
    const result = await wallet.completeSwap(entryToSwapPreview(entry))
    split = { send: result.send, keep: result.keep }
  } else {
    throw new Error(`Proof operation ${entry.operationId} is still pending at the mint`)
  }

  await markProofOperationCompleted(entry.operationId, split)
  await completeReservedSatSend({
    mintUrl,
    reservedBy: reservationId,
    keepProofs: split.keep,
  })
  return split
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
): CashuWalletLike {
  const unit = defaultCollateralUnit(baseAsset)
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
    return updateState((state) => {
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
    await updateState((state) => {
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
    await updateState((state) => {
      state.wallet.keysetCounters[keysetId] = next
    })
  }

  async snapshot(): Promise<Record<string, number>> {
    return { ...(await ensureState()).wallet.keysetCounters }
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

function isCtfConsolidationFinalized(
  entry: ProofOperationRecord,
  walletProofs: Array<{ mintUrl: string; proof: { secret: string } }>,
): boolean {
  const inputSecrets = new Set(entry.inputs.map((proof) => proof.secret))
  if (
    walletProofs.some(
      (record) =>
        record.mintUrl === entry.mintUrl && inputSecrets.has(record.proof.secret),
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
    Array.isArray(inputCollections) &&
    inputCollections.length === entry.inputs.length &&
    inputCollections.every((collection) => typeof collection === 'string')
  ) {
    return groupInputsByCollection(
      entry.inputs as Proof[],
      inputCollections as string[],
    )
  }

  const state = await ensureState()
  const collectionBySecret = new Map<string, string>()
  for (const record of state.wallet.proofs) {
    if (record.mintUrl !== entry.mintUrl) continue
    collectionBySecret.set(record.proof.secret, proofCollection(record.asset))
  }
  const recoveredCollections = entry.inputs.map((proof) =>
    collectionBySecret.get(proof.secret),
  )
  if (recoveredCollections.some((collection) => !collection)) {
    throw new Error(
      `Proof operation ${entry.operationId} is missing CTF consolidation input collection metadata`,
    )
  }
  return groupInputsByCollection(
    entry.inputs as Proof[],
    recoveredCollections as string[],
  )
}

function groupInputsByCollection(
  inputs: Proof[],
  collections: string[],
): Record<string, Proof[]> {
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
    throw new Error('Mint restore response had mismatched output/signature counts')
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
    throw new Error(`Proof operation ${entry.operationId} is missing numeric metadata ${key}`)
  }
  return value
}

function readStringMetadata(entry: ProofOperationRecord, key: string): string {
  const value = entry.metadata[key]
  if (typeof value !== 'string') {
    throw new Error(`Proof operation ${entry.operationId} is missing string metadata ${key}`)
  }
  return value
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
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
): Promise<WalletReceiveResult> {
  if (!proofs.length) throw new Error('cashu token did not include proofs')
  const wallet = createWallet(mintUrl, secrets, deps, asset.baseAsset)
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
  await addAvailableProofs(mintUrl, proofs, asset)
  return {
    mintUrl,
    amountSats: sumProofs(proofs),
    proofCount: proofs.length,
    asset,
  }
}

function resolveReceiveAsset(metadata: WalletReceiveMetadata): StoredProofAsset {
  const conditionId = metadata.conditionId?.trim()
  const outcomeSetId = metadata.outcomeSetId?.trim()
  const baseAsset = normalizeMarketBaseAsset(undefined)
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
