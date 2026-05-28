import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  OutputData as RegularOutputData,
  Wallet as CashuWallet,
  type MintKeys,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SwapPreview,
} from '@cashu/cashu-ts'
import { amountToNumber } from './proofSelection.ts'

export interface CtfSplitRequest {
  condition_id: string
  inputs: Proof[]
  outputs: Record<string, SerializedBlindedMessage[]>
}

export interface CtfSplitResponse {
  signatures: Record<string, SerializedBlindedSignature[]>
}

export interface CtfConditionPartition {
  collateral: string
  parent_collection_id: string
  keysets: Record<string, string>
}

export interface CtfConditionInfo {
  condition_id: string
  partitions: CtfConditionPartition[]
}

export interface CtfSplitOutputData {
  blindedMessage: SerializedBlindedMessage
  blindingFactor: bigint
  secret: Uint8Array
  toProof(signature: SerializedBlindedSignature, keyset: MintKeys): Proof
}

export interface StoredOutputData {
  blindedMessage: {
    amount: number
    id: string
    B_: string
  }
  blindingFactor: string
  secret: string
}

export type CtfProofOperationKind = 'ctf-split' | 'regular-split'
export type ProofOperationState = 'prepared' | 'completed' | 'failed'

export interface CtfProofOperationRecord {
  operationId: string
  kind: CtfProofOperationKind
  state: ProofOperationState
  mintUrl: string
  inputs: Proof[]
  outputs: Record<string, StoredOutputData[]>
  metadata: Record<string, unknown>
  resultProofs?: Record<string, Proof[]>
  lastError?: string | null
  createdAt: number
  updatedAt: number
}

export interface CtfPrepareProofOperationInput {
  operationId: string
  kind: CtfProofOperationKind
  mintUrl: string
  inputs: Proof[]
  outputs: Record<string, StoredOutputData[]>
  metadata?: Record<string, unknown>
}

export interface CtfProofOperationStore {
  getProofOperation(operationId: string): Promise<CtfProofOperationRecord | null>
  prepareProofOperation(
    input: CtfPrepareProofOperationInput,
  ): Promise<CtfProofOperationRecord>
  markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<CtfProofOperationRecord>
}

export interface SplitCollateralSelection {
  inputs: Proof[]
  keep: Proof[]
  inputFeeSats: number
  grossInputSats: number
}

export interface MintSplitForSwapResult {
  resolvedLockOutcomeSetId: string
  resolvedKeepOutcomeSetId: string
  lockCollections: string[]
  keepCollections: string[]
  lockedProofs: Proof[]
  keepProofs: Proof[]
  proofsByCollection: Record<string, Proof[]>
  spentSatProofs: Proof[]
}

export interface PreflightCompleteSetSplitResult {
  resolvedLockOutcomeSetId: string
  resolvedKeepOutcomeSetId: string
  lockCollections: string[]
  keepCollections: string[]
  lockProofs: Proof[]
  keepProofs: Proof[]
  proofsByCollection: Record<string, Proof[]>
  spentSatProofs: Proof[]
}

export interface ComplementaryOutcomeLegResolution {
  resolvedLockOutcomeSetId: string
  resolvedKeepOutcomeSetId: string
  lockCollections: string[]
  keepCollections: string[]
}

export interface CtfSplitTransport {
  getKeys(keysetId: string): Promise<MintKeys>
  getRootPartitionKeysets(conditionId: string): Promise<Record<string, string>>
  postSplit(request: CtfSplitRequest): Promise<CtfSplitResponse>
}

export interface CtfSplitOptions {
  makeOutputs?: (input: {
    collection: string
    amountSats: number
    keyset: MintKeys
  }) => CtfSplitOutputData[]
  onPrepared?: (prepared: {
    inputs: Proof[]
    outputsByCollection: Record<string, CtfSplitOutputData[]>
    requestOutputs: Record<string, SerializedBlindedMessage[]>
  }) => Promise<void>
}

export interface RegularSplitWallet {
  prepareSwapToSend?(
    amount: number,
    proofs: Proof[],
    config?: unknown,
    outputConfig?: unknown,
  ): Promise<SwapPreview>
  completeSwap?(swapPreview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
  checkProofsStates?(
    proofs: Array<Pick<Proof, 'id' | 'secret'>>,
  ): Promise<ProofState[]>
}

export interface RegularProofSplitResult {
  send: Proof[]
  keep: Proof[]
  spent: Proof[]
}

export async function splitRegularProofsWithOperation(params: {
  mintUrl: string
  operationId: string
  wallet: RegularSplitWallet
  proofs: Proof[]
  amountSats: number
  proofOperationStore: CtfProofOperationStore
}): Promise<RegularProofSplitResult> {
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error('amountSats must be a positive safe integer')
  }

  const normalizedProofs = params.proofs.map(normalizeProof)
  const existing = await params.proofOperationStore.getProofOperation(
    params.operationId,
  )
  if (existing) {
    return resumeRegularSplit(
      params.mintUrl,
      existing,
      params.wallet,
      params.proofOperationStore,
    )
  }

  if (!params.wallet.prepareSwapToSend || !params.wallet.completeSwap) {
    throw new Error('Cashu wallet adapter does not support resumable split preparation')
  }

  const preview = await params.wallet.prepareSwapToSend(
    params.amountSats,
    normalizedProofs,
    undefined,
    { send: { type: 'random' }, keep: { type: 'random' } },
  )
  await params.proofOperationStore.prepareProofOperation({
    operationId: params.operationId,
    kind: 'regular-split',
    mintUrl: params.mintUrl,
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
    },
  })

  const result = await params.wallet.completeSwap(preview)
  const completed = {
    send: result.send.map(normalizeProof),
    keep: result.keep.map(normalizeProof),
  }
  await params.proofOperationStore.markProofOperationCompleted(
    params.operationId,
    completed,
  )
  return { ...completed, spent: preview.inputs.map(normalizeProof) }
}

export async function selectCollateralForCtfSplit(
  mintUrl: string,
  availableProofs: Proof[],
  faceAmountSats: number,
): Promise<SplitCollateralSelection> {
  if (!Number.isSafeInteger(faceAmountSats) || faceAmountSats <= 0) {
    throw new Error('faceAmountSats must be a positive safe integer')
  }

  const wallet = new CashuWallet(new CashuMint(mintUrl), { unit: 'sat' })
  await wallet.loadMint()
  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error('Cashu wallet adapter does not support fee-aware proof selection')
  }

  const selected = wallet.selectProofsToSend(
    availableProofs.map(normalizeProof),
    faceAmountSats,
    true,
    true,
  )
  const selectedSend = selected.send.map(normalizeProof)
  const selectedKeep = selected.keep.map(normalizeProof)
  const inputFeeSats = amountToNumber(wallet.getFeesForProofs(selectedSend))
  const grossInputSats = selectedSend.reduce((acc, proof) => acc + amountToNumber(proof.amount), 0)
  const netInputSats = grossInputSats - inputFeeSats
  if (netInputSats !== faceAmountSats) {
    throw new Error(
      `Selected collateral nets ${netInputSats} sats after ${inputFeeSats} sats input fee, expected ${faceAmountSats}`,
    )
  }

  return {
    inputs: selectedSend,
    keep: selectedKeep,
    inputFeeSats,
    grossInputSats,
  }
}

export async function splitRootCompleteSetForSwap(
  params: {
    mintUrl: string
    conditionId: string
    collateralProofs: Proof[]
    amountSats: number
    lockOutcomeSetId: string
    keepOutcomeSetId: string
    p2pk: P2PKOptions
    operationId: string
    proofOperationStore: CtfProofOperationStore
  },
): Promise<MintSplitForSwapResult> {
  const transport = new CashuMintCtfSplitTransport(params.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
  )
  const outcomeLegs = resolveComplementaryOutcomeLegs(
    params.lockOutcomeSetId,
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
  )
  const lockCollections = new Set(outcomeLegs.lockCollections)
  const keepCollections = new Set(outcomeLegs.keepCollections)
  const normalizedCollateral = params.collateralProofs.map(normalizeProof)
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: params.mintUrl,
    operationId: params.operationId,
    transport,
    conditionId: params.conditionId,
    collateralProofs: normalizedCollateral,
    outcomeCollectionKeysets,
    amountSats: params.amountSats,
    proofOperationStore: params.proofOperationStore,
    makeOutputs: ({ collection, amountSats, keyset }) => {
      if (lockCollections.has(collection)) {
        return RegularOutputData.createP2PKData(params.p2pk, Amount.from(amountSats), keyset)
      }
      if (keepCollections.has(collection)) {
        return RegularOutputData.createRandomData(Amount.from(amountSats), keyset)
      }
      throw new Error(`CTF split has no lock/keep branch for outcome collection ${collection}`)
    },
  })

  return {
    resolvedLockOutcomeSetId: outcomeLegs.resolvedLockOutcomeSetId,
    resolvedKeepOutcomeSetId: outcomeLegs.resolvedKeepOutcomeSetId,
    lockCollections: outcomeLegs.lockCollections,
    keepCollections: outcomeLegs.keepCollections,
    lockedProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.lockCollections,
      params.operationId,
    ),
    keepProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.keepCollections,
      params.operationId,
    ),
    proofsByCollection,
    spentSatProofs: normalizedCollateral,
  }
}

export async function splitRootCompleteSetForPreflightOrder(
  params: {
    mintUrl: string
    conditionId: string
    collateralProofs: Proof[]
    amountSats: number
    lockOutcomeSetId: string
    keepOutcomeSetId: string
    operationId: string
    proofOperationStore: CtfProofOperationStore
  },
): Promise<PreflightCompleteSetSplitResult> {
  const transport = new CashuMintCtfSplitTransport(params.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
  )
  const outcomeLegs = resolveComplementaryOutcomeLegs(
    params.lockOutcomeSetId,
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
  )
  const normalizedCollateral = params.collateralProofs.map(normalizeProof)
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: params.mintUrl,
    operationId: params.operationId,
    transport,
    conditionId: params.conditionId,
    collateralProofs: normalizedCollateral,
    outcomeCollectionKeysets,
    amountSats: params.amountSats,
    proofOperationStore: params.proofOperationStore,
    makeOutputs: ({ amountSats, keyset }) =>
      RegularOutputData.createRandomData(Amount.from(amountSats), keyset),
  })

  return {
    resolvedLockOutcomeSetId: outcomeLegs.resolvedLockOutcomeSetId,
    resolvedKeepOutcomeSetId: outcomeLegs.resolvedKeepOutcomeSetId,
    lockCollections: outcomeLegs.lockCollections,
    keepCollections: outcomeLegs.keepCollections,
    lockProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.lockCollections,
      params.operationId,
    ),
    keepProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.keepCollections,
      params.operationId,
    ),
    proofsByCollection,
    spentSatProofs: normalizedCollateral,
  }
}

export async function splitRootCompleteSet(
  transport: CtfSplitTransport,
  conditionId: string,
  inputs: Proof[],
  amountSats: number,
  options: CtfSplitOptions = {},
): Promise<Record<string, Proof[]>> {
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(conditionId)
  return splitCompleteSet(
    transport,
    conditionId,
    inputs,
    outcomeCollectionKeysets,
    amountSats,
    options,
  )
}

export async function splitCompleteSet(
  transport: CtfSplitTransport,
  conditionId: string,
  inputs: Proof[],
  outcomeCollectionKeysets: Record<string, string>,
  amountSats: number,
  options: CtfSplitOptions = {},
): Promise<Record<string, Proof[]>> {
  const normalizedInputs = inputs.map(normalizeProof)
  validateSplitInput(conditionId, normalizedInputs, outcomeCollectionKeysets, amountSats)

  const makeOutputs = options.makeOutputs ?? defaultMakeOutputs
  const keysetsById = new Map<string, MintKeys>()
  const getCachedKeys = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysetsById.get(keysetId)
    if (cached) return cached
    const keyset = await transport.getKeys(keysetId)
    keysetsById.set(keysetId, keyset)
    return keyset
  }

  await validateInputBalance(normalizedInputs, amountSats, getCachedKeys)

  const keysetsByCollection = new Map<string, MintKeys>()
  const outputsByCollection: Record<string, CtfSplitOutputData[]> = {}
  const requestOutputs: Record<string, SerializedBlindedMessage[]> = {}

  for (const [collection, keysetId] of Object.entries(outcomeCollectionKeysets)) {
    const keyset = await getCachedKeys(keysetId)
    keysetsByCollection.set(collection, keyset)
    const outputs = makeOutputs({ collection, amountSats, keyset })
    validateOutputs(collection, keysetId, amountSats, outputs)
    outputsByCollection[collection] = outputs
    requestOutputs[collection] = outputs.map((output) =>
      toWireBlindedMessage(output.blindedMessage),
    )
  }

  await options.onPrepared?.({ inputs: normalizedInputs, outputsByCollection, requestOutputs })

  const response = await transport.postSplit({
    condition_id: conditionId,
    inputs: normalizedInputs,
    outputs: requestOutputs,
  })

  const proofsByCollection: Record<string, Proof[]> = {}
  for (const [collection, outputs] of Object.entries(outputsByCollection)) {
    const signatures = response.signatures[collection]
    if (!signatures) {
      throw new Error(`Mint did not return split signatures for outcome collection ${collection}`)
    }
    if (signatures.length !== outputs.length) {
      throw new Error(
        `Mint returned ${signatures.length} signatures for outcome collection ${collection}, expected ${outputs.length}`,
      )
    }
    const keyset = keysetsByCollection.get(collection)
    if (!keyset) throw new Error(`Missing keyset for outcome collection ${collection}`)
    proofsByCollection[collection] = outputs.map((output, index) => {
      validateSignature(collection, outputs[index].blindedMessage, signatures[index])
      return normalizeProof(
        output.toProof(
          { ...signatures[index], amount: output.blindedMessage.amount },
          keyset,
        ),
      )
    })
  }

  return proofsByCollection
}

export class CashuMintCtfSplitTransport implements CtfSplitTransport {
  private readonly mint: CashuMint & {
    getCtfCondition(conditionId: string): Promise<CtfConditionInfo>
    ctfSplit(request: CtfSplitRequest): Promise<CtfSplitResponse>
  }

  constructor(mintUrl: string) {
    this.mint = new CashuMint(mintUrl) as CashuMint & {
      getCtfCondition(conditionId: string): Promise<CtfConditionInfo>
      ctfSplit(request: CtfSplitRequest): Promise<CtfSplitResponse>
    }
  }

  async getKeys(keysetId: string): Promise<MintKeys> {
    const response = await this.mint.getKeys(keysetId)
    const keyset = response.keysets.find((candidate) => candidate.id === keysetId)
    if (!keyset) {
      throw new Error(`Mint did not return keys for conditional keyset ${keysetId}`)
    }
    return keyset
  }

  async getRootPartitionKeysets(conditionId: string): Promise<Record<string, string>> {
    return selectSingleRootPartitionKeysets(
      await this.mint.getCtfCondition(conditionId),
    )
  }

  async postSplit(request: CtfSplitRequest): Promise<CtfSplitResponse> {
    return this.mint.ctfSplit(request)
  }
}

export async function splitCompleteSetWithOperation(params: {
  mintUrl: string
  operationId: string
  transport: CtfSplitTransport
  conditionId: string
  collateralProofs: Proof[]
  outcomeCollectionKeysets: Record<string, string>
  amountSats: number
  proofOperationStore: CtfProofOperationStore
  makeOutputs: (input: {
    collection: string
    amountSats: number
    keyset: MintKeys
  }) => CtfSplitOutputData[]
}): Promise<Record<string, Proof[]>> {
  const existing = await params.proofOperationStore.getProofOperation(
    params.operationId,
  )
  if (existing) {
    return resumeCtfSplit(params.mintUrl, existing, params.transport, params.proofOperationStore)
  }

  const result = await splitCompleteSet(
    params.transport,
    params.conditionId,
    params.collateralProofs,
    params.outcomeCollectionKeysets,
    params.amountSats,
    {
      makeOutputs: params.makeOutputs,
      onPrepared: async (prepared) => {
        const preparedOutputs = Object.fromEntries(
          Object.entries(prepared.outputsByCollection).map(([collection, outputs]) => [
            collection,
            serializeOutputDataArray(outputs),
          ]),
        )
        await params.proofOperationStore.prepareProofOperation({
          operationId: params.operationId,
          kind: 'ctf-split',
          mintUrl: params.mintUrl,
          inputs: prepared.inputs,
          outputs: preparedOutputs,
          metadata: {
            conditionId: params.conditionId,
            amountSats: params.amountSats,
            outcomeCollectionKeysets: params.outcomeCollectionKeysets,
          },
        })
      },
    },
  )

  await params.proofOperationStore.markProofOperationCompleted(
    params.operationId,
    result,
  )
  return result
}

async function resumeCtfSplit(
  mintUrl: string,
  entry: CtfProofOperationRecord,
  transport: CtfSplitTransport,
  proofOperationStore: CtfProofOperationStore,
): Promise<Record<string, Proof[]>> {
  if (entry.kind !== 'ctf-split') {
    throw new Error(`proof operation ${entry.operationId} is not a CTF split`)
  }
  if (entry.state === 'completed') {
    return structuredClone(entry.resultProofs ?? {})
  }
  if (entry.state === 'failed') {
    throw new Error(
      `proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }

  const wallet = new CashuWallet(new CashuMint(mintUrl), { unit: 'sat' })
  await wallet.loadMint()
  if (!wallet.checkProofsStates) {
    throw new Error('Cashu wallet adapter does not support proof-state recovery checks')
  }
  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  )
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(mintUrl, entry.outputs)
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      restored,
    )
    return restored
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const metadata = entry.metadata as {
      conditionId?: string
      amountSats?: number
      outcomeCollectionKeysets?: Record<string, string>
    }
    if (!metadata.conditionId || !metadata.amountSats || !metadata.outcomeCollectionKeysets) {
      throw new Error(`proof operation ${entry.operationId} is missing CTF split metadata`)
    }
    const outputDataByCollection = deserializeCtfOutputGroups(entry.outputs)
    const result = await splitCompleteSet(
      transport,
      metadata.conditionId,
      entry.inputs,
      metadata.outcomeCollectionKeysets,
      metadata.amountSats,
      {
        makeOutputs: ({ collection }) => outputDataByCollection[collection] ?? [],
      },
    )
    await proofOperationStore.markProofOperationCompleted(entry.operationId, result)
    return normalizeProofGroups(result)
  }

  throw new Error(`Proof operation ${entry.operationId} is still pending at the mint`)
}

async function resumeRegularSplit(
  mintUrl: string,
  entry: CtfProofOperationRecord,
  wallet: RegularSplitWallet,
  proofOperationStore: CtfProofOperationStore,
): Promise<RegularProofSplitResult> {
  if (entry.kind !== 'regular-split') {
    throw new Error(`proof operation ${entry.operationId} is not a regular split`)
  }
  if (entry.state === 'completed') {
    return {
      send: (entry.resultProofs?.send ?? []).map(normalizeProof),
      keep: (entry.resultProofs?.keep ?? []).map(normalizeProof),
      spent: entry.inputs.map(normalizeProof),
    }
  }
  if (entry.state === 'failed') {
    throw new Error(
      `proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }
  if (!wallet.checkProofsStates) {
    throw new Error('Cashu wallet adapter does not support proof-state recovery checks')
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  )
  let completed: { send: Proof[]; keep: Proof[] }
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(mintUrl, entry.outputs)
    completed = {
      send: (restored.send ?? []).map(normalizeProof),
      keep: [...(restored.keep ?? []), ...readUnselectedProofs(entry)].map(normalizeProof),
    }
  } else if (allStates(states, CheckStateEnum.UNSPENT)) {
    if (!wallet.completeSwap) {
      throw new Error('Cashu wallet adapter does not support prepared split completion')
    }
    const result = await wallet.completeSwap(entryToSwapPreview(entry))
    completed = {
      send: result.send.map(normalizeProof),
      keep: result.keep.map(normalizeProof),
    }
  } else {
    throw new Error(`Proof operation ${entry.operationId} is still pending at the mint`)
  }

  await proofOperationStore.markProofOperationCompleted(
    entry.operationId,
    completed,
  )
  return { ...completed, spent: entry.inputs.map(normalizeProof) }
}

async function restoreOutputGroups(
  mintUrl: string,
  outputs: Record<string, StoredOutputData[]>,
): Promise<Record<string, Proof[]>> {
  const mint = new CashuMint(mintUrl)
  const rows = Object.entries(deserializeCtfOutputGroups(outputs)).flatMap(
    ([group, groupOutputs]) =>
      groupOutputs.map((output, index) => ({ group, index, output })),
  )
  if (rows.length === 0) return {}

  const response = await mint.restore({
    outputs: rows.map((row) => toWireBlindedMessage(row.output.blindedMessage)),
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
    if (!keyset) throw new Error(`Mint did not return keys for keyset ${keysetId}`)
    keysets.set(keysetId, keyset)
    return keyset
  }

  const restored: Record<string, Proof[]> = {}
  for (const row of rows) {
    const signature = signaturesByOutput.get(
      blindedMessageKey(row.output.blindedMessage),
    )
    if (!signature) {
      throw new Error(`Mint restore did not return signature for output ${row.group}[${row.index}]`)
    }
    const keyset = await getKeyset(row.output.blindedMessage.id)
    const proof = normalizeProof(
      row.output.toProof(
        { ...signature, amount: row.output.blindedMessage.amount },
        keyset,
      ),
    )
    restored[row.group] = [...(restored[row.group] ?? []), proof]
  }
  return normalizeProofGroups(restored)
}

export function resolveMintOutcomeSetKey(
  engineOutcomeSetId: string,
  outcomeCollectionKeysets: Record<string, string>,
  branch: 'lock' | 'keep',
): string {
  const engineSet = parseOutcomeSetToComparableSet(engineOutcomeSetId)
  const matches = Object.keys(outcomeCollectionKeysets).filter((mintKey) =>
    outcomeSetsEqual(engineSet, parseOutcomeSetToComparableSet(mintKey)),
  )
  if (matches.length !== 1) {
    throw new Error(
      `CTF split ${branch} outcome ${engineOutcomeSetId} matched ${matches.length} mint keyset-map keys; expected exactly one`,
    )
  }
  return matches[0]
}

export function resolveComplementaryOutcomeLegs(
  lockOutcomeSetId: string,
  keepOutcomeSetId: string,
  outcomeCollectionKeysets: Record<string, string>,
): ComplementaryOutcomeLegResolution {
  const rootCollections = Object.keys(outcomeCollectionKeysets)
  const primitiveCollections = new Map<string, string>()
  for (const collection of rootCollections) {
    const parts = parseOutcomeSetId(collection)
    if (parts.length !== 1) {
      throw new Error(
        `CTF split root outcome collection ${collection} is not primitive`,
      )
    }
    const comparable = comparableOutcome(parts[0])
    if (primitiveCollections.has(comparable)) {
      throw new Error(
        `CTF split root outcome collection ${collection} duplicates primitive outcome ${parts[0]}`,
      )
    }
    primitiveCollections.set(comparable, collection)
  }

  const lockSet = parseOutcomeSetToComparableSet(lockOutcomeSetId)
  const keepSet = parseOutcomeSetToComparableSet(keepOutcomeSetId)
  const lockCollections = resolvePrimitiveOutcomeCollections(
    lockOutcomeSetId,
    lockSet,
    primitiveCollections,
    'lock',
  )
  const keepCollections = resolvePrimitiveOutcomeCollections(
    keepOutcomeSetId,
    keepSet,
    primitiveCollections,
    'keep',
  )

  const seen = new Set<string>()
  for (const collection of lockCollections) seen.add(collection)
  for (const collection of keepCollections) {
    if (seen.has(collection)) {
      throw new Error(
        `CTF split lock and keep outcomes overlap on primitive collection ${collection}`,
      )
    }
    seen.add(collection)
  }
  if (seen.size !== rootCollections.length) {
    const missing = rootCollections.filter((collection) => !seen.has(collection))
    throw new Error(
      `CTF split lock and keep outcomes are not a complete partition; missing ${missing.join('|')}`,
    )
  }

  return {
    resolvedLockOutcomeSetId: canonicalizeOutcomeSetCollections(lockCollections),
    resolvedKeepOutcomeSetId: canonicalizeOutcomeSetCollections(keepCollections),
    lockCollections,
    keepCollections,
  }
}

export function requireOutcomeProofs(
  proofsByCollection: Record<string, Proof[]>,
  outcomeSetId: string,
  operationId: string,
): Proof[] {
  const proofs = proofsByCollection[outcomeSetId]
  if (!proofs || proofs.length === 0) {
    throw new Error(
      `CTF split ${operationId} did not return proofs for outcome ${outcomeSetId}`,
    )
  }
  return proofs
}

export function requireOutcomeProofsForCollections(
  proofsByCollection: Record<string, Proof[]>,
  collections: string[],
  operationId: string,
): Proof[] {
  return collections.flatMap((collection) =>
    requireOutcomeProofs(proofsByCollection, collection, operationId),
  )
}

function selectSingleRootPartitionKeysets(condition: CtfConditionInfo): Record<string, string> {
  const rootPartitions = condition.partitions.filter(
    (partition) =>
      partition.collateral === 'sat' &&
      partition.parent_collection_id === ZERO_COLLECTION_ID &&
      Object.keys(partition.keysets).length >= 2,
  )
  if (rootPartitions.length !== 1) {
    throw new Error(
      `Expected exactly one root sat CTF partition for condition ${condition.condition_id}, found ${rootPartitions.length}`,
    )
  }
  return rootPartitions[0].keysets
}

function validateSplitInput(
  conditionId: string,
  inputs: Proof[],
  outcomeCollectionKeysets: Record<string, string>,
  amountSats: number,
): void {
  if (!/^[0-9a-fA-F]{64}$/.test(conditionId)) {
    throw new Error('conditionId must be a 64-character hex string for CTF split')
  }
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error('amountSats must be a positive safe integer')
  }
  if (inputs.length === 0) throw new Error('CTF split requires collateral proofs')
  const collections = Object.keys(outcomeCollectionKeysets)
  if (collections.length < 2) {
    throw new Error('CTF split requires at least two outcome collection keysets')
  }
  for (const collection of collections) {
    if (!collection) throw new Error('CTF split outcome collection key cannot be empty')
    if (!outcomeCollectionKeysets[collection]) {
      throw new Error(`CTF split keyset id is missing for outcome collection ${collection}`)
    }
  }
}

async function validateInputBalance(
  inputs: Proof[],
  amountSats: number,
  getKeys: (keysetId: string) => Promise<MintKeys>,
): Promise<void> {
  let feePpk = 0
  for (const proof of inputs) {
    const keyset = await getKeys(proof.id)
    feePpk += keyset.input_fee_ppk ?? 0
  }

  const inputFeeSats = Math.ceil(feePpk / 1_000)
  const inputAmountSats = inputs.reduce((acc, proof) => acc + amountToNumber(proof.amount), 0)
  const netInputSats = inputAmountSats - inputFeeSats

  if (netInputSats !== amountSats) {
    throw new Error(
      `CTF split inputs net ${netInputSats} sats after ${inputFeeSats} sats input fee, expected ${amountSats}`,
    )
  }
}

function validateOutputs(
  collection: string,
  keysetId: string,
  amountSats: number,
  outputs: CtfSplitOutputData[],
): void {
  if (outputs.length === 0) {
    throw new Error(`No blinded outputs generated for outcome collection ${collection}`)
  }
  const total = outputs.reduce(
    (acc, output) => acc + amountToNumber(output.blindedMessage.amount),
    0,
  )
  if (total !== amountSats) {
    throw new Error(
      `CTF split outputs for outcome collection ${collection} total ${total}, expected ${amountSats}`,
    )
  }
  const mismatched = outputs.find((output) => output.blindedMessage.id !== keysetId)
  if (mismatched) {
    throw new Error(
      `CTF split output for outcome collection ${collection} used keyset ${mismatched.blindedMessage.id}, expected ${keysetId}`,
    )
  }
}

function validateSignature(
  collection: string,
  output: SerializedBlindedMessage,
  signature: SerializedBlindedSignature,
): void {
  if (signature.id !== output.id) {
    throw new Error(
      `CTF split signature for outcome collection ${collection} used keyset ${signature.id}, expected ${output.id}`,
    )
  }
  if (amountToNumber(signature.amount) !== amountToNumber(output.amount)) {
    throw new Error(
      `CTF split signature for outcome collection ${collection} amount ${signature.amount}, expected ${output.amount}`,
    )
  }
}

function serializeOutputDataArray(outputs: CtfSplitOutputData[]): StoredOutputData[] {
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

function toWireBlindedMessage(output: SerializedBlindedMessage): SerializedBlindedMessage {
  return {
    ...output,
    amount: amountToNumber(output.amount),
  } as unknown as SerializedBlindedMessage
}

function normalizeProof(proof: Proof): Proof {
  return {
    ...proof,
    amount: amountToNumber(proof.amount) as never,
  }
}

function normalizeProofGroups(groups: Record<string, Proof[]>): Record<string, Proof[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, proofs]) => [
      group,
      proofs.map(normalizeProof),
    ]),
  )
}

function deserializeCtfOutputGroups(
  groups: Record<string, StoredOutputData[]>,
): Record<string, CtfSplitOutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new RegularOutputData(
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

function deserializeOutputGroups(
  groups: Record<string, StoredOutputData[]>,
): Record<string, RegularOutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new RegularOutputData(
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

function entryToSwapPreview(entry: CtfProofOperationRecord): SwapPreview {
  const metadata = entry.metadata as {
    amount?: unknown
    fees?: unknown
    keysetId?: unknown
    unselectedProofs?: unknown
  }
  if (
    !Number.isSafeInteger(metadata.amount) ||
    !Number.isSafeInteger(metadata.fees) ||
    typeof metadata.keysetId !== 'string'
  ) {
    throw new Error(`proof operation ${entry.operationId} is missing regular split metadata`)
  }
  const amount = metadata.amount as number
  const fees = metadata.fees as number
  const keysetId = metadata.keysetId
  const outputs = deserializeOutputGroups(entry.outputs)
  return {
    amount: Amount.from(amount),
    fees: Amount.from(fees),
    keysetId,
    inputs: entry.inputs.map(normalizeProof),
    sendOutputs: outputs.send ?? [],
    keepOutputs: outputs.keep ?? [],
    unselectedProofs: Array.isArray(metadata.unselectedProofs)
      ? structuredClone(metadata.unselectedProofs as Proof[])
      : [],
  }
}

function readUnselectedProofs(entry: CtfProofOperationRecord): Proof[] {
  const metadata = entry.metadata as { unselectedProofs?: unknown }
  return Array.isArray(metadata.unselectedProofs)
    ? (metadata.unselectedProofs as Proof[]).map(normalizeProof)
    : []
}

function defaultMakeOutputs(input: {
  amountSats: number
  keyset: MintKeys
}): CtfSplitOutputData[] {
  return RegularOutputData.createRandomData(Amount.from(input.amountSats), input.keyset)
}

function parseOutcomeSetToComparableSet(outcomeSetId: string): Set<string> {
  const elements = parseOutcomeSetId(outcomeSetId)
  if (elements.length === 0) {
    throw new Error('CTF split outcome-set id cannot be empty')
  }
  return new Set(elements.map(comparableOutcome))
}

function parseOutcomeSetId(outcomeSetId: string): string[] {
  return outcomeSetId
    .split('|')
    .map((outcome) => outcome.trim())
    .filter(Boolean)
}

function resolvePrimitiveOutcomeCollections(
  outcomeSetId: string,
  outcomeSet: Set<string>,
  primitiveCollections: Map<string, string>,
  branch: 'lock' | 'keep',
): string[] {
  const collections: string[] = []
  for (const primitive of outcomeSet) {
    const collection = primitiveCollections.get(primitive)
    if (!collection) {
      throw new Error(
        `CTF split ${branch} outcome ${outcomeSetId} contains primitive ${primitive} with no mint root keyset`,
      )
    }
    collections.push(collection)
  }
  return collections
}

function canonicalizeOutcomeSetCollections(collections: string[]): string {
  return collections
    .flatMap(parseOutcomeSetId)
    .sort()
    .join('|')
}

function comparableOutcome(outcome: string): string {
  return outcome.trim()
}

function outcomeSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function blindedMessageKey(output: SerializedBlindedMessage): string {
  return `${output.id}:${output.B_}`
}

function allStates(states: ProofState[], expected: string): boolean {
  return states.length > 0 && states.every((state) => state.state === expected)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hex string must have an even length')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

const ZERO_COLLECTION_ID = '0'.repeat(64)
