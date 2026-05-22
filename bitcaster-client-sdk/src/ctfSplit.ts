import {
  CheckStateEnum,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  type MintKeys,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SwapPreview,
} from '@cashu/cashu-ts'

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
  blindedMessage: SerializedBlindedMessage
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

export interface ComplementarySplitForSwapResult {
  resolvedLockOutcomeSetId: string
  resolvedKeepOutcomeSetId: string
  lockedProofs: Proof[]
  keepProofs: Proof[]
  spentSatProofs: Proof[]
}

export interface PreflightCompleteSetSplitResult {
  resolvedLockOutcomeSetId: string
  resolvedKeepOutcomeSetId: string
  lockProofs: Proof[]
  keepProofs: Proof[]
  proofsByCollection: Record<string, Proof[]>
  spentSatProofs: Proof[]
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
    proofs: Array<Pick<Proof, 'secret'>>,
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
    params.proofs,
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
      amount: preview.amount,
      fees: preview.fees,
      keysetId: preview.keysetId,
      unselectedProofs: preview.unselectedProofs ?? [],
    },
  })

  const result = await params.wallet.completeSwap(preview)
  const completed = { send: result.send, keep: result.keep }
  await params.proofOperationStore.markProofOperationCompleted(
    params.operationId,
    completed,
  )
  return { ...completed, spent: preview.inputs }
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
    availableProofs,
    faceAmountSats,
    true,
    true,
  )
  const inputFeeSats = wallet.getFeesForProofs(selected.send)
  const grossInputSats = selected.send.reduce((acc, proof) => acc + proof.amount, 0)
  const netInputSats = grossInputSats - inputFeeSats
  if (netInputSats !== faceAmountSats) {
    throw new Error(
      `Selected collateral nets ${netInputSats} sats after ${inputFeeSats} sats input fee, expected ${faceAmountSats}`,
    )
  }

  return {
    inputs: selected.send,
    keep: selected.keep,
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
): Promise<ComplementarySplitForSwapResult> {
  const transport = new HttpCtfSplitTransport(params.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
  )
  const resolvedLockOutcomeSetId = resolveMintOutcomeSetKey(
    params.lockOutcomeSetId,
    outcomeCollectionKeysets,
    'lock',
  )
  const resolvedKeepOutcomeSetId = resolveMintOutcomeSetKey(
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
    'keep',
  )
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: params.mintUrl,
    operationId: params.operationId,
    transport,
    conditionId: params.conditionId,
    collateralProofs: params.collateralProofs,
    outcomeCollectionKeysets,
    amountSats: params.amountSats,
    proofOperationStore: params.proofOperationStore,
    makeOutputs: ({ collection, amountSats, keyset }) =>
      collection === resolvedLockOutcomeSetId
        ? OutputData.createP2PKData(params.p2pk, amountSats, keyset)
        : OutputData.createRandomData(amountSats, keyset),
  })

  return {
    resolvedLockOutcomeSetId,
    resolvedKeepOutcomeSetId,
    lockedProofs: requireOutcomeProofs(
      proofsByCollection,
      resolvedLockOutcomeSetId,
      params.operationId,
    ),
    keepProofs: requireOutcomeProofs(
      proofsByCollection,
      resolvedKeepOutcomeSetId,
      params.operationId,
    ),
    spentSatProofs: params.collateralProofs,
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
  const transport = new HttpCtfSplitTransport(params.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
  )
  const resolvedLockOutcomeSetId = resolveMintOutcomeSetKey(
    params.lockOutcomeSetId,
    outcomeCollectionKeysets,
    'lock',
  )
  const resolvedKeepOutcomeSetId = resolveMintOutcomeSetKey(
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
    'keep',
  )
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: params.mintUrl,
    operationId: params.operationId,
    transport,
    conditionId: params.conditionId,
    collateralProofs: params.collateralProofs,
    outcomeCollectionKeysets,
    amountSats: params.amountSats,
    proofOperationStore: params.proofOperationStore,
    makeOutputs: ({ amountSats, keyset }) =>
      OutputData.createRandomData(amountSats, keyset),
  })

  return {
    resolvedLockOutcomeSetId,
    resolvedKeepOutcomeSetId,
    lockProofs: requireOutcomeProofs(
      proofsByCollection,
      resolvedLockOutcomeSetId,
      params.operationId,
    ),
    keepProofs: requireOutcomeProofs(
      proofsByCollection,
      resolvedKeepOutcomeSetId,
      params.operationId,
    ),
    proofsByCollection,
    spentSatProofs: params.collateralProofs,
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
  validateSplitInput(conditionId, inputs, outcomeCollectionKeysets, amountSats)

  const makeOutputs = options.makeOutputs ?? defaultMakeOutputs
  const keysetsById = new Map<string, MintKeys>()
  const getCachedKeys = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysetsById.get(keysetId)
    if (cached) return cached
    const keyset = await transport.getKeys(keysetId)
    keysetsById.set(keysetId, keyset)
    return keyset
  }

  await validateInputBalance(inputs, amountSats, getCachedKeys)

  const keysetsByCollection = new Map<string, MintKeys>()
  const outputsByCollection: Record<string, CtfSplitOutputData[]> = {}
  const requestOutputs: Record<string, SerializedBlindedMessage[]> = {}

  for (const [collection, keysetId] of Object.entries(outcomeCollectionKeysets)) {
    const keyset = await getCachedKeys(keysetId)
    keysetsByCollection.set(collection, keyset)
    const outputs = makeOutputs({ collection, amountSats, keyset })
    validateOutputs(collection, keysetId, amountSats, outputs)
    outputsByCollection[collection] = outputs
    requestOutputs[collection] = outputs.map((output) => output.blindedMessage)
  }

  await options.onPrepared?.({ inputs, outputsByCollection, requestOutputs })

  const response = await transport.postSplit({
    condition_id: conditionId,
    inputs,
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
      return output.toProof(signatures[index], keyset)
    })
  }

  return proofsByCollection
}

export class HttpCtfSplitTransport implements CtfSplitTransport {
  private readonly mint: CashuMint
  private readonly mintUrl: string

  constructor(mintUrl: string) {
    this.mintUrl = mintUrl
    this.mint = new CashuMint(mintUrl)
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
    if (!/^[0-9a-fA-F]{64}$/.test(conditionId)) {
      throw new Error('conditionId must be a 64-character hex string for CTF condition lookup')
    }
    const normalizedConditionId = conditionId.toLowerCase()
    const response = await fetch(joinUrl(this.mintUrl, `/v1/conditions/${normalizedConditionId}`), {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`CTF condition lookup failed with HTTP ${response.status}: ${body}`)
    }
    const body = (await response.json()) as CtfConditionInfo | { condition?: CtfConditionInfo }
    const condition = normalizeConditionResponse(body)
    if (!condition || condition.condition_id.toLowerCase() !== normalizedConditionId) {
      throw new Error(`Mint did not return condition ${normalizedConditionId}`)
    }
    return selectSingleRootPartitionKeysets(condition)
  }

  async postSplit(request: CtfSplitRequest): Promise<CtfSplitResponse> {
    const response = await fetch(joinUrl(this.mintUrl, '/v1/ctf/split'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`CTF split failed with HTTP ${response.status}: ${body}`)
    }
    return (await response.json()) as CtfSplitResponse
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
    entry.inputs.map(({ secret }) => ({ secret })),
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
    const outputDataByCollection = deserializeOutputGroups(entry.outputs)
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
    return result
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
      send: structuredClone(entry.resultProofs?.send ?? []),
      keep: structuredClone(entry.resultProofs?.keep ?? []),
      spent: structuredClone(entry.inputs),
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
    entry.inputs.map(({ secret }) => ({ secret })),
  )
  let completed: { send: Proof[]; keep: Proof[] }
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(mintUrl, entry.outputs)
    completed = {
      send: restored.send ?? [],
      keep: [...(restored.keep ?? []), ...readUnselectedProofs(entry)],
    }
  } else if (allStates(states, CheckStateEnum.UNSPENT)) {
    if (!wallet.completeSwap) {
      throw new Error('Cashu wallet adapter does not support prepared split completion')
    }
    const result = await wallet.completeSwap(entryToSwapPreview(entry))
    completed = { send: result.send, keep: result.keep }
  } else {
    throw new Error(`Proof operation ${entry.operationId} is still pending at the mint`)
  }

  await proofOperationStore.markProofOperationCompleted(
    entry.operationId,
    completed,
  )
  return { ...completed, spent: structuredClone(entry.inputs) }
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
    const proof = row.output.toProof(signature, keyset)
    restored[row.group] = [...(restored[row.group] ?? []), proof]
  }
  return restored
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

function normalizeConditionResponse(
  body: CtfConditionInfo | { condition?: CtfConditionInfo },
): CtfConditionInfo | undefined {
  if ('condition' in body) return body.condition
  return body as CtfConditionInfo
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
  const inputAmountSats = inputs.reduce((acc, proof) => acc + proof.amount, 0)
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
  const total = outputs.reduce((acc, output) => acc + output.blindedMessage.amount, 0)
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
  if (signature.amount !== output.amount) {
    throw new Error(
      `CTF split signature for outcome collection ${collection} amount ${signature.amount}, expected ${output.amount}`,
    )
  }
}

function serializeOutputDataArray(outputs: CtfSplitOutputData[]): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: Number(output.blindedMessage.amount),
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
            output.blindedMessage,
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
    amount,
    fees,
    keysetId,
    inputs: structuredClone(entry.inputs),
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
    ? structuredClone(metadata.unselectedProofs as Proof[])
    : []
}

function defaultMakeOutputs(input: {
  amountSats: number
  keyset: MintKeys
}): CtfSplitOutputData[] {
  return OutputData.createRandomData(input.amountSats, input.keyset)
}

function parseOutcomeSetToComparableSet(outcomeSetId: string): Set<string> {
  const elements = parseOutcomeSetId(outcomeSetId)
  if (elements.length === 0) {
    throw new Error('CTF split outcome-set id cannot be empty')
  }
  return new Set(elements)
}

function parseOutcomeSetId(outcomeSetId: string): string[] {
  return outcomeSetId
    .split('|')
    .map((outcome) => outcome.trim())
    .filter(Boolean)
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

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
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
