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
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SwapPreview,
} from '@cashu/cashu-ts'
import { randomUUID } from 'node:crypto'
import {
  selectCollateralForCtfSplit,
  splitRegularProofsWithOperation,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  addAvailableProofs,
  completeReservedSatSend,
  ensureState,
  getProofOperation,
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
}

export interface WalletOpsDependencies {
  createCashuWallet?: (mintUrl: string) => CashuWalletLike
  restoreOutputGroups?: (
    mintUrl: string,
    outputs: Record<string, StoredOutputData[]>,
  ) => Promise<Record<string, Proof[]>>
  resolveMintKeysetIds?: (mintUrl: string) => Promise<string[]>
  resolveConditionKeysetIds?: (
    mintUrl: string,
    conditionId: string,
  ) => Promise<string[]>
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

const DAEMON_CTF_PROOF_OPERATION_STORE: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
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
  if (asset.kind === 'outcome') {
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
): Promise<PreparedCtfCollateralResult> {
  const wallet = createWallet(mintUrl, secrets, deps)
  await wallet.loadMint()
  const existing = await getProofOperation(operationId)
  if (existing) {
    const split = await splitRegularProofsWithOperation({
      mintUrl,
      operationId,
      wallet,
      proofs: [],
      amountSats,
      proofOperationStore: DAEMON_CTF_PROOF_OPERATION_STORE,
    })
    const exact = await selectCollateralForCtfSplit(mintUrl, split.send, amountSats)
    return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
  }

  const available = (await ensureState()).wallet.proofs
    .filter(
      (record) =>
        record.mintUrl === mintUrl &&
        record.state === 'available' &&
        record.asset.kind === 'sats',
    )
    .map((record) => record.proof as Proof)

  try {
    const exact = await selectCollateralForCtfSplit(mintUrl, available, amountSats)
    return { inputs: exact.inputs, spent: [], keep: [] }
  } catch {
    // Fall through to a regular split that creates a gross CTF input.
  }

  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error('cashu wallet does not support fee-aware proof selection')
  }
  const selected = wallet.selectProofsToSend(available, amountSats, true, false)
  if (selected.send.length === 0) {
    throw new Error(`insufficient available sats in mint ${mintUrl}`)
  }
  const grossCtfInputSats = amountSats + amountToNumber(wallet.getFeesForProofs([selected.send[0]]))
  const split = await splitRegularProofsWithOperation({
    mintUrl,
    operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    proofOperationStore: DAEMON_CTF_PROOF_OPERATION_STORE,
  })
  const exact = await selectCollateralForCtfSplit(mintUrl, split.send, amountSats)
  return { inputs: exact.inputs, spent: split.spent, keep: split.keep }
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
  const prepared = Object.values(state.proofOperations).filter(
    (entry) => entry.kind === 'wallet-send' && entry.state === 'prepared',
  )
  const result: WalletSendRecoveryResult = { recovered: [], pending: [] }
  for (const entry of prepared) {
    try {
      const wallet = createWallet(entry.mintUrl, secrets, deps)
      await wallet.loadMint()
      await resumeWalletSendOperation(wallet, entry, entry.mintUrl, deps)
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
  if (entry.state === 'failed') {
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
): WalletSendResult {
  return {
    operationId,
    mintUrl,
    amountSats,
    proofCount: sendProofs.length,
    token: getEncodedToken({ mint: mintUrl, unit: 'sat', proofs: sendProofs }),
  }
}

function createWallet(
  mintUrl: string,
  secrets: WalletOpsSecrets,
  deps: WalletOpsDependencies,
): CashuWalletLike {
  if (deps.createCashuWallet) return deps.createCashuWallet(mintUrl)
  return new CashuWallet(new CashuMint(mintUrl), {
    unit: 'sat',
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
  const wallet = createWallet(mintUrl, secrets, deps)
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
  if (!conditionId && !outcomeSetId) return { kind: 'sats' }
  if (!conditionId || !outcomeSetId) {
    throw new Error('conditionId and outcomeSetId must be supplied together')
  }
  return { kind: 'outcome', conditionId, outcomeSetId }
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
    condition?: { partitions?: Array<{ keysets?: Record<string, string> }> }
    partitions?: Array<{ keysets?: Record<string, string> }>
  }
  const partitions = body.condition?.partitions ?? body.partitions ?? []
  const keysets = partitions.flatMap((partition) =>
    Object.values(partition.keysets ?? {}),
  )
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
