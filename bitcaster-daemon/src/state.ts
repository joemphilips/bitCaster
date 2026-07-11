import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
  isSettlementCompleteMessage,
} from '@bitcaster-market/client-sdk/tradeFlow'
import { isSwapCipherMessageType } from '@bitcaster-market/client-sdk/tradeSession'
import {
  normalizeMarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type {
  DurableTradeProofOperationLink,
  DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import type {
  PartialLockHeldRecord,
  SwapFailure,
} from '@bitcaster-market/client-sdk/swapFailure'
import { ensureProfileDir, profileDir, readProfile } from './profile.ts'
import { readSecrets } from './secrets.ts'

export interface CashuProofRecord {
  id?: string
  amount: unknown
  secret: string
  C: string
  witness?: unknown
  dleq?: unknown
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

export type ProofOperationKind =
  | 'swap-lock'
  | 'swap-claim'
  | 'conditional-keyset-swap'
  | 'ctf-split'
  | 'ctf-merge'
  | 'ctf-consolidation'
  | 'ctf-redeem'
  | 'regular-split'
  | 'wallet-send'
  | 'proof-split'
  | 'swap-refund'

export type ProofOperationState = 'prepared' | 'mint-submitted' | 'completed' | 'Failed'

export interface ProofOperationRecord {
  operationId: string
  durableTradeRecovery?: DurableTradeProofOperationLink
  kind: ProofOperationKind
  state: ProofOperationState
  mintUrl: string
  inputs: CashuProofRecord[]
  outputs: Record<string, StoredOutputData[]>
  metadata: Record<string, unknown>
  resultProofs?: Record<string, CashuProofRecord[]>
  lastError?: string | null
  createdAt: number
  updatedAt: number
}

export interface ProofOperationSummary {
  operationId: string
  kind: ProofOperationKind
  state: ProofOperationState
  mintUrl: string
  inputAmountSats: number
  inputCount: number
  outputCounts: Record<string, number>
  resultProofCounts: Record<string, number>
  lastError?: string | null
  createdAt: number
  updatedAt: number
}

export interface ListProofOperationsParams {
  kind?: string
  state?: string
}

export interface PrepareProofOperationInput {
  operationId: string
  durableTradeRecovery?: DurableTradeProofOperationLink
  kind: ProofOperationKind
  mintUrl: string
  inputs: CashuProofRecord[]
  outputs: Record<string, StoredOutputData[]>
  metadata?: Record<string, unknown>
}

export interface StoredProofRecord {
  proof: CashuProofRecord
  mintUrl: string
  state: 'available' | 'reserved' | 'locked'
  asset: StoredProofAsset
  reservedBy?: string
  createdAt: string
  updatedAt: string
}

export type StoredProofAsset =
  | { kind: 'sats'; baseAsset?: string | null }
  | { kind: 'Outcome'; conditionId: string; outcomeSetId: string; baseAsset?: string | null }

export interface LocalOrderRecord {
  orderId: string
  marketId: string
  tokenSide?: 'Outcome' | 'Complement'
  side?: 'Buy' | 'Sell'
  priceSubunits?: number
  amountSubunits?: number
  timeInForce?: 'FAK' | 'FOK' | 'GTC'
  /** Number of maker-collateral replacement attempts that produced this order. */
  recoveryAttempt?: number
  status: string
  clientOrderId?: string
  preflightSplit?: LocalOrderPreflightSplit
  baseAsset?: string | null
  divisibility?: number
  tradeIds: string[]
  engineStatus?: unknown
  createdAt: string
  updatedAt: string
}

export interface LocalOrderPreflightSplit {
  reservationId: string
  conditionId: string
  keepOutcomeSetId: string
  lockOutcomeSetId: string
  amountSats: number
}

export interface ListLocalOrdersParams {
  marketId?: string
  status?: string
}

export interface ListLocalSwapsParams {
  marketId?: string
  orderId?: string
  step?: string
}

export interface LocalSwapRecord {
  tradeId: string
  marketId?: string
  orderId?: string
  role?: 'seller' | 'buyer'
  counterpartyPubkey?: string
  sellerLocktime?: number
  buyerLocktime?: number
  fillAmountSats?: number
  fillAmountSubunits?: number
  outcomeFaceAmountSats?: number
  outcomeFaceAmountSubunits?: number
  quotePaymentSats?: number
  baseAsset?: string | null
  divisibility?: number
  quotePaymentSubunits?: number
  settlementKind?: string | null
  sellerKeepOutcomeSetId?: string | null
  sellerLockOutcomeSetId?: string | null
  /** True when this local order was the fill's incoming taker order. */
  isTaker?: boolean
  messages: {
    adaptorPoint?: string
    lockedProofsSeller?: string
    lockedProofsBuyer?: string
  }
  sellerAdaptorSecretHex?: string
  sellerAdaptorPointHex?: string
  buyerPreSigsHex?: string[]
  buyerLockedProofs?: CashuProofRecord[]
  sellerPreSigsHex?: string[]
  engineState?: string
  /** Allowlisted terminal reason from TradeHub, never arbitrary server text. */
  failureReason?: string
  /** Durable idempotency record for a maker-caused taker replacement order. */
  takerRecovery?: {
    clientOrderId: string
    status: 'pending' | 'submitted'
    replacementOrderId?: string
  }
  step:
    | 'awaiting-trade-created'
    | 'opened'
    | 'seller-opened'
    | 'buyer-responded'
    | 'settling'
    | 'awaiting-confirmation'
    | 'confirmed'
      | 'refunded'
      | 'Failed'
  error?: string
  failure?: SwapFailure | PartialLockHeldRecord
  createdAt: string
  updatedAt: string
}

export interface DaemonTradeCreatedPayload {
  tradeId: string
  sellerPubkey: string
  buyerPubkey: string
  sellerLocktime: string
  buyerLocktime: string
  marketId: string
  fillAmountSats?: number
  fillAmountSubunits?: number
  outcomeFaceAmountSats?: number
  outcomeFaceAmountSubunits?: number
  quotePaymentSats?: number
  baseAsset?: string | null
  divisibility?: number
  quotePaymentSubunits?: number
  settlementKind?: string | null
  sellerKeepOutcomeSetId?: string | null
  sellerLockOutcomeSetId?: string | null
}

export interface DaemonState {
  version: 1
  wallet: {
    proofs: StoredProofRecord[]
    keysetCounters: Record<string, number>
  }
  proofOperations: Record<string, ProofOperationRecord>
  /** SDK-owned durable recovery envelopes. Private key material remains in daemon-secrets.json. */
  durableTradeSessions: Record<string, DurableTradeSession>
  orders: Record<string, LocalOrderRecord>
  swaps: Record<string, LocalSwapRecord>
}

export interface WalletBalance {
  totalAvailableSats: number
  totalReservedSats: number
  totalLockedSats: number
  byMint: Array<{
    mintUrl: string
    availableSats: number
    reservedSats: number
    lockedSats: number
  }>
  outcomePositions: Array<{
    mintUrl: string
    conditionId: string
    outcomeSetId: string
    availableSats: number
    reservedSats: number
    lockedSats: number
  }>
}

export function statePath(): string {
  return join(profileDir(), 'daemon-state.json')
}

export function emptyDaemonState(): DaemonState {
  return {
    version: 1,
    wallet: { proofs: [], keysetCounters: {} },
    proofOperations: {},
    durableTradeSessions: {},
    orders: {},
    swaps: {},
  }
}

let stateUpdateQueue: Promise<unknown> = Promise.resolve()
let stateWriteSequence = 0

async function withStateUpdateLock<T>(run: () => Promise<T>): Promise<T> {
  const next = stateUpdateQueue.then(run, run)
  stateUpdateQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export async function ensureState(): Promise<DaemonState> {
  const state = await readState()
  if (state) return state
  return withStateUpdateLock(async () => {
    const latest = await readState()
    if (latest) return latest
    const fresh = emptyDaemonState()
    await writeState(fresh)
    return fresh
  })
}

export async function readState(): Promise<DaemonState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as unknown
    return normalizeState(parsed)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function writeState(state: DaemonState): Promise<void> {
  const dir = await ensureProfileDir()
  const target = statePath()
  stateWriteSequence += 1
  const tmp = join(
    dir,
    `.daemon-state.${process.pid}.${Date.now()}.${stateWriteSequence}.tmp`,
  )
  await writeFile(tmp, `${JSON.stringify(toJsonSafe(state), null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, target)
}

export async function updateState<T>(
  update: (state: DaemonState, now: string) => T,
): Promise<T> {
  return withStateUpdateLock(async () => {
    const state = (await readState()) ?? emptyDaemonState()
    const result = update(state, new Date().toISOString())
    await writeState(state)
    return result
  })
}

export async function addAvailableSatProofs(
  mintUrl: string,
  proofs: CashuProofRecord[],
): Promise<StoredProofRecord[]> {
  return addAvailableProofs(mintUrl, proofs, { kind: 'sats' })
}

export async function addAvailableProofs(
  mintUrl: string,
  proofs: CashuProofRecord[],
  asset: StoredProofAsset,
): Promise<StoredProofRecord[]> {
  return updateState((state, now) => {
    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === mintUrl)
        .map((record) => record.proof.secret),
    )
    const inserted: StoredProofRecord[] = []
    for (const proof of proofs) {
      if (existingSecrets.has(proof.secret)) continue
      existingSecrets.add(proof.secret)
      const record: StoredProofRecord = {
        proof: normalizeCashuProofRecord(proof),
        mintUrl,
        state: 'available',
        asset: normalizeProofAsset(asset),
        createdAt: now,
        updatedAt: now,
      }
      state.wallet.proofs.push(record)
      inserted.push(record)
    }
    return inserted
  })
}

export async function replaceSentSatProofs(input: {
  mintUrl: string
  spentSecrets: string[]
  keepProofs: CashuProofRecord[]
}): Promise<StoredProofRecord[]> {
  return updateState((state, now) => {
    const spent = new Set(input.spentSecrets)
    const before = state.wallet.proofs.length
    state.wallet.proofs = state.wallet.proofs.filter(
      (record) => record.mintUrl !== input.mintUrl || !spent.has(record.proof.secret),
    )
    if (state.wallet.proofs.length === before) {
      throw new Error('send operation did not consume any stored proofs')
    }

    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === input.mintUrl)
        .map((record) => record.proof.secret),
    )
    const inserted: StoredProofRecord[] = []
    for (const proof of input.keepProofs) {
      if (existingSecrets.has(proof.secret)) continue
      existingSecrets.add(proof.secret)
      const record: StoredProofRecord = {
        proof: normalizeCashuProofRecord(proof),
        mintUrl: input.mintUrl,
        state: 'available',
        asset: { kind: 'sats' },
        createdAt: now,
        updatedAt: now,
      }
      state.wallet.proofs.push(record)
      inserted.push(record)
    }
    return inserted
  })
}

export async function reserveAvailableSatProofsForSend(input: {
  mintUrl: string
  amountSats: number
  reservedBy: string
}): Promise<CashuProofRecord[]> {
  return updateState((state, now) => {
    const selected: StoredProofRecord[] = []
    let total = 0
    const candidates = state.wallet.proofs
      .filter(
        (record) =>
          record.mintUrl === input.mintUrl &&
          record.state === 'available' &&
          record.asset.kind === 'sats' &&
          normalizeProofAssetBaseAsset(record.asset) === 'sat',
      )
      .sort((a, b) => amountToNumber(b.proof.amount) - amountToNumber(a.proof.amount))

    for (const record of candidates) {
      selected.push(record)
      total += amountToNumber(record.proof.amount)
      if (total >= input.amountSats) break
    }
    if (total < input.amountSats) {
      throw new Error(`insufficient available sats in mint ${input.mintUrl}`)
    }

    for (const record of selected) {
      record.state = 'reserved'
      record.reservedBy = input.reservedBy
      record.updatedAt = now
    }
    return selected.map((record) => structuredClone(record.proof))
  })
}

export async function completeReservedSatSend(input: {
  mintUrl: string
  reservedBy: string
  keepProofs: CashuProofRecord[]
}): Promise<StoredProofRecord[]> {
  return updateState((state, now) => {
    state.wallet.proofs = state.wallet.proofs.filter(
      (record) =>
        record.mintUrl !== input.mintUrl ||
        record.reservedBy !== input.reservedBy,
    )

    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === input.mintUrl)
        .map((record) => record.proof.secret),
    )
    const inserted: StoredProofRecord[] = []
    for (const proof of input.keepProofs) {
      if (existingSecrets.has(proof.secret)) continue
      existingSecrets.add(proof.secret)
      const record: StoredProofRecord = {
        proof: normalizeCashuProofRecord(proof),
        mintUrl: input.mintUrl,
        state: 'available',
        asset: { kind: 'sats' },
        createdAt: now,
        updatedAt: now,
      }
      state.wallet.proofs.push(record)
      inserted.push(record)
    }
    return inserted
  })
}

export async function releaseProofReservation(reservedBy: string): Promise<void> {
  await updateState((state, now) => {
    for (const record of state.wallet.proofs) {
      if (record.reservedBy !== reservedBy || record.state !== 'reserved') {
        continue
      }
      record.state = 'available'
      delete record.reservedBy
      record.updatedAt = now
    }
  })
}

export async function getProofOperation(
  operationId: string,
): Promise<ProofOperationRecord | null> {
  return (await readState())?.proofOperations[operationId] ?? null
}

export async function prepareProofOperation(
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(input.operationId)
  if (existing) {
    assertCompatibleProofOperation(existing, input)
    return existing
  }

  return updateState((state) => {
    const now = Date.now()
    const record: ProofOperationRecord = {
      operationId: input.operationId,
      durableTradeRecovery: input.durableTradeRecovery,
      kind: input.kind,
      state: 'prepared',
      mintUrl: input.mintUrl,
      inputs: input.inputs.map(normalizeCashuProofRecord),
      outputs: structuredClone(input.outputs),
      metadata: structuredClone(input.metadata ?? {}),
      resultProofs: undefined,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    state.proofOperations[input.operationId] = record
    if (record.durableTradeRecovery) {
      const link = record.durableTradeRecovery
      const session = state.durableTradeSessions[link.tradeId]
      // Legacy pre-migration records may have a link without a promoted session.
      // The SDK will fail those orphaned records closed during recovery.
      if (!session) return record
      if (session.role !== link.role || link.state !== 'prepared') {
        throw new Error(`Proof operation ${input.operationId} has an invalid durable trade binding`)
      }
      const expected = session.expectedProofOperations ?? []
      if (!expected.some((item) => item.operationId === link.operationId)) {
        expected.push({
          operationId: link.operationId,
          operationKey: link.operationKey ?? input.operationId,
          stage: link.stage,
        })
      }
      if (!session.proofOperations.some((item) => item.operationId === link.operationId)) {
        session.proofOperations.push(link)
      }
      session.expectedProofOperations = expected
      session.stage = 'proof-reserved'
      session.revision += 1
    }
    return record
  })
}

export async function markProofOperationCompleted(
  operationId: string,
  resultProofs: Record<string, CashuProofRecord[]>,
): Promise<ProofOperationRecord> {
  return updateState((state) => {
    const existing = state.proofOperations[operationId]
    if (!existing) {
      throw new Error(`Missing proof operation ${operationId}`)
    }
    const updated: ProofOperationRecord = {
      ...existing,
      state: 'completed',
      durableTradeRecovery: existing.durableTradeRecovery
        ? { ...existing.durableTradeRecovery, state: 'reconciled' }
        : undefined,
      resultProofs: normalizeProofRecordGroups(resultProofs),
      lastError: null,
      updatedAt: Date.now(),
    }
    state.proofOperations[operationId] = updated
    return updated
  })
}

/** Persists the recovery boundary immediately before a Cashu mint request. */
export async function markProofOperationMintSubmitted(
  operationId: string,
): Promise<ProofOperationRecord> {
  return updateState((state) => {
    const existing = state.proofOperations[operationId]
    if (!existing) {
      throw new Error(`Missing proof operation ${operationId}`)
    }
    if (existing.state === 'completed' || existing.state === 'Failed') {
      throw new Error(`Cannot submit terminal proof operation ${operationId}`)
    }
    const updated: ProofOperationRecord = {
      ...existing,
      state: 'mint-submitted',
      durableTradeRecovery: existing.durableTradeRecovery
        ? { ...existing.durableTradeRecovery, state: 'mint-submitted' }
        : undefined,
      lastError: null,
      updatedAt: Date.now(),
    }
    state.proofOperations[operationId] = updated
    return updated
  })
}

export function summarizeWalletBalance(state: DaemonState): WalletBalance {
  const byMint = new Map<
    string,
    { mintUrl: string; availableSats: number; reservedSats: number; lockedSats: number }
  >()
  const outcomes = new Map<
    string,
    {
      mintUrl: string
      conditionId: string
      outcomeSetId: string
      availableSats: number
      reservedSats: number
      lockedSats: number
    }
  >()

  for (const proof of state.wallet.proofs) {
    if (normalizeProofAssetBaseAsset(proof.asset) !== 'sat') continue

    const amount = amountToNumber(proof.proof.amount)
    const mint = getOrCreate(byMint, proof.mintUrl, () => ({
      mintUrl: proof.mintUrl,
      availableSats: 0,
      reservedSats: 0,
      lockedSats: 0,
    }))
    addAmount(mint, proof.state, amount)

    if (proof.asset.kind === 'Outcome') {
      const key = `${proof.mintUrl}\n${proof.asset.conditionId}\n${proof.asset.outcomeSetId}`
      const outcome = getOrCreate(outcomes, key, () => ({
        mintUrl: proof.mintUrl,
        conditionId: proof.asset.kind === 'Outcome' ? proof.asset.conditionId : '',
        outcomeSetId: proof.asset.kind === 'Outcome' ? proof.asset.outcomeSetId : '',
        availableSats: 0,
        reservedSats: 0,
        lockedSats: 0,
      }))
      addAmount(outcome, proof.state, amount)
    }
  }

  const mintRows = [...byMint.values()].sort((a, b) =>
    a.mintUrl.localeCompare(b.mintUrl),
  )
  return {
    totalAvailableSats: mintRows.reduce((sum, row) => sum + row.availableSats, 0),
    totalReservedSats: mintRows.reduce((sum, row) => sum + row.reservedSats, 0),
    totalLockedSats: mintRows.reduce((sum, row) => sum + row.lockedSats, 0),
    byMint: mintRows,
    outcomePositions: [...outcomes.values()].sort(
      (a, b) =>
        a.mintUrl.localeCompare(b.mintUrl) ||
        a.conditionId.localeCompare(b.conditionId) ||
        a.outcomeSetId.localeCompare(b.outcomeSetId),
    ),
  }
}

export async function recordOrderStatus(
  marketId: string,
  orderId: string,
  engineStatus: unknown,
): Promise<LocalOrderRecord> {
  return upsertOrderFromEngine(marketId, orderId, engineStatus)
}

export async function listLocalOrders(
  params: ListLocalOrdersParams = {},
): Promise<LocalOrderRecord[]> {
  const state = await readState()
  if (!state) return []
  return Object.values(state.orders)
    .filter((order) => !params.marketId || order.marketId === params.marketId)
    .filter((order) => !params.status || order.status === params.status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listLocalSwaps(
  params: ListLocalSwapsParams = {},
): Promise<LocalSwapRecord[]> {
  const state = await readState()
  if (!state) return []
  return Object.values(state.swaps)
    .filter((swap) => !params.marketId || swap.marketId === params.marketId)
    .filter((swap) => !params.orderId || swap.orderId === params.orderId)
    .filter((swap) => !params.step || swap.step === params.step)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listProofOperations(
  params: ListProofOperationsParams = {},
): Promise<ProofOperationSummary[]> {
  const state = await readState()
  if (!state) return []
  return Object.values(state.proofOperations)
    .filter((operation) => !params.kind || operation.kind === params.kind)
    .filter((operation) => !params.state || operation.state === params.state)
    .map(summarizeProofOperation)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function recordSubmittedOrder(
  marketId: string,
  clientOrderId: string,
  engineResponse: unknown,
  preflightSplit?: LocalOrderPreflightSplit | null,
  tokenSide?: 'Outcome' | 'Complement',
  side?: 'Buy' | 'Sell',
  priceSubunits?: number,
  amountSubunits?: number,
  timeInForce?: 'FAK' | 'FOK' | 'GTC',
  recoveryAttempt?: number,
): Promise<LocalOrderRecord> {
  const orderId = readStringProperty(engineResponse, 'orderId')
  if (!orderId) {
    throw new Error('engine submit response did not include orderId')
  }
  return upsertOrderFromEngine(
    marketId,
    orderId,
    engineResponse,
    clientOrderId,
    preflightSplit,
    tokenSide,
    side,
    priceSubunits,
    amountSubunits,
    timeInForce,
    recoveryAttempt,
  )
}

function summarizeProofOperation(
  operation: ProofOperationRecord,
): ProofOperationSummary {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    state: operation.state,
    mintUrl: operation.mintUrl,
    inputAmountSats: operation.inputs.reduce(
      (sum, proof) => sum + amountToNumber(proof.amount),
      0,
    ),
    inputCount: operation.inputs.length,
    outputCounts: countRecordArrays(operation.outputs),
    resultProofCounts: countRecordArrays(operation.resultProofs ?? {}),
    lastError: operation.lastError,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  }
}

function countRecordArrays<T>(record: Record<string, T[]>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).map(([key, values]) => [key, values.length]),
  )
}

function upsertOrderFromEngine(
  marketId: string,
  orderId: string,
  engineStatus: unknown,
  clientOrderId?: string,
  preflightSplit?: LocalOrderPreflightSplit | null,
  tokenSide?: 'Outcome' | 'Complement',
  side?: 'Buy' | 'Sell',
  priceSubunits?: number,
  amountSubunits?: number,
  timeInForce?: 'FAK' | 'FOK' | 'GTC',
  recoveryAttempt?: number,
): Promise<LocalOrderRecord> {
  return updateState((state, now) => {
    const existing = state.orders[orderId]
    const status = readStringProperty(engineStatus, 'status') ?? existing?.status ?? 'unknown'
    const baseAsset =
      readStringProperty(engineStatus, 'baseAsset') ?? existing?.baseAsset ?? null
    const divisibility =
      readNumberProperty(engineStatus, 'divisibility') ?? existing?.divisibility
    const tradeIds = [
      ...new Set([
        ...(existing?.tradeIds ?? []),
        ...extractTradeIds(engineStatus),
      ]),
    ]
    const nextTokenSide = tokenSide ?? existing?.tokenSide
    const nextSide = side ?? existing?.side
    const nextPriceSubunits = priceSubunits ?? existing?.priceSubunits
    const nextAmountSubunits = amountSubunits ?? existing?.amountSubunits
    const nextTimeInForce = timeInForce ?? existing?.timeInForce
    const nextRecoveryAttempt = recoveryAttempt ?? existing?.recoveryAttempt
    const takerByTradeId = extractTakerParticipation(engineStatus, orderId)
    const record: LocalOrderRecord = {
      orderId,
      marketId,
      ...(nextTokenSide ? { tokenSide: nextTokenSide } : {}),
      ...(nextSide ? { side: nextSide } : {}),
      ...(nextPriceSubunits != null ? { priceSubunits: nextPriceSubunits } : {}),
      ...(nextAmountSubunits != null ? { amountSubunits: nextAmountSubunits } : {}),
      ...(nextTimeInForce ? { timeInForce: nextTimeInForce } : {}),
      ...(nextRecoveryAttempt != null ? { recoveryAttempt: nextRecoveryAttempt } : {}),
      status,
      ...((clientOrderId ?? existing?.clientOrderId)
        ? { clientOrderId: clientOrderId ?? existing?.clientOrderId }
        : {}),
      ...(baseAsset ? { baseAsset } : {}),
      ...(divisibility ? { divisibility } : {}),
      ...(preflightSplit === null
        ? {}
        : preflightSplit || existing?.preflightSplit
          ? { preflightSplit: preflightSplit ?? existing?.preflightSplit }
          : {}),
      tradeIds,
      engineStatus,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    state.orders[orderId] = record
    for (const tradeId of tradeIds) {
      const swap = state.swaps[tradeId]
      state.swaps[tradeId] = {
        tradeId,
        marketId,
        orderId,
        role: swap?.role,
        counterpartyPubkey: swap?.counterpartyPubkey,
        sellerLocktime: swap?.sellerLocktime,
        buyerLocktime: swap?.buyerLocktime,
        fillAmountSats: swap?.fillAmountSats,
        fillAmountSubunits: swap?.fillAmountSubunits,
        outcomeFaceAmountSats: swap?.outcomeFaceAmountSats,
        outcomeFaceAmountSubunits: swap?.outcomeFaceAmountSubunits,
        quotePaymentSats: swap?.quotePaymentSats,
        baseAsset: swap?.baseAsset,
        divisibility: swap?.divisibility,
        quotePaymentSubunits: swap?.quotePaymentSubunits,
        settlementKind: swap?.settlementKind,
        sellerKeepOutcomeSetId: swap?.sellerKeepOutcomeSetId,
        sellerLockOutcomeSetId: swap?.sellerLockOutcomeSetId,
        isTaker: takerByTradeId.get(tradeId) ?? swap?.isTaker,
        messages: swap?.messages ?? {},
        sellerAdaptorSecretHex: swap?.sellerAdaptorSecretHex,
        sellerAdaptorPointHex: swap?.sellerAdaptorPointHex,
        buyerPreSigsHex: swap?.buyerPreSigsHex,
        buyerLockedProofs: swap?.buyerLockedProofs,
        sellerPreSigsHex: swap?.sellerPreSigsHex,
        engineState: swap?.engineState,
        failureReason: swap?.failureReason,
        takerRecovery: swap?.takerRecovery,
        step: swap?.step ?? 'awaiting-trade-created',
        error: swap?.error,
        createdAt: swap?.createdAt ?? now,
        updatedAt: now,
      }
    }
    return record
  })
}

export async function recordTradeCreated(
  payload: DaemonTradeCreatedPayload,
): Promise<LocalSwapRecord | null> {
  const secrets = await readSecrets()
  const profile = await readProfile()
  const ownEphemeralPubkey = secrets?.orderEphemeralKeys[payload.tradeId]?.publicKeyHex
  return updateState((state, now) => {
    const match = findOrderForTradeCreated(state, payload, ownEphemeralPubkey)
    if (!match) return null

    const existing = state.swaps[payload.tradeId]
    const order = state.orders[match.orderId]
    const legacyOrderAmountScale =
      order?.divisibility == null && typeof payload.divisibility === 'number'
        ? payload.divisibility / 100
        : 1
    const expectedDivisibility =
      order?.divisibility ?? payload.divisibility ?? (order?.amountSubunits != null ? 100 : undefined)
    const legacyOutcomeAmountScale =
      payload.outcomeFaceAmountSubunits == null &&
      payload.outcomeFaceAmountSats != null &&
      typeof expectedDivisibility === 'number'
        ? expectedDivisibility / 100
        : 1
    if (order && !order.tradeIds.includes(payload.tradeId)) {
      order.tradeIds = [...order.tradeIds, payload.tradeId]
      order.updatedAt = now
    }
    const decision = decideTradeCreated({
      ownEphemeralPubkey: match.ownEphemeralPubkey,
      sellerPubkey: payload.sellerPubkey,
      buyerPubkey: payload.buyerPubkey,
      sellerLocktime: payload.sellerLocktime,
      buyerLocktime: payload.buyerLocktime,
      settlementKind: payload.settlementKind,
      sellerKeepOutcomeSetId: payload.sellerKeepOutcomeSetId,
      sellerLockOutcomeSetId: payload.sellerLockOutcomeSetId,
      baseAsset: payload.baseAsset ?? order?.baseAsset ?? null,
      divisibility: payload.divisibility ?? expectedDivisibility,
      expectedBaseAsset: order?.baseAsset,
      expectedDivisibility,
      expectedOrder:
        order?.side && order.priceSubunits != null && order.amountSubunits != null
          ? {
              side: order.side,
              tokenSide: order.tokenSide,
              priceSubunits: order.priceSubunits,
              amountSubunits: order.amountSubunits * legacyOrderAmountScale,
            }
          : null,
      requireExpectedOrder: true,
      outcomeFaceAmountSubunits:
        payload.outcomeFaceAmountSubunits ?? payload.outcomeFaceAmountSats,
      quotePaymentSubunits: payload.quotePaymentSubunits ?? payload.quotePaymentSats,
    })
    const protocolError = decision.accepted ? null : decision.error
    const accepted = decision.accepted

    const record: LocalSwapRecord = {
      tradeId: payload.tradeId,
      marketId: match.marketId,
      orderId: match.orderId,
      role: decision.role ?? existing?.role,
      counterpartyPubkey: decision.counterpartyPubkey ?? existing?.counterpartyPubkey,
      sellerLocktime: decision.sellerLocktime,
      buyerLocktime: decision.buyerLocktime,
      fillAmountSats: payload.fillAmountSats ?? existing?.fillAmountSats,
      fillAmountSubunits:
        payload.fillAmountSubunits ?? payload.fillAmountSats ?? existing?.fillAmountSubunits,
      outcomeFaceAmountSats:
        payload.outcomeFaceAmountSats ?? existing?.outcomeFaceAmountSats,
      outcomeFaceAmountSubunits:
        payload.outcomeFaceAmountSubunits ??
        (payload.outcomeFaceAmountSats != null
          ? payload.outcomeFaceAmountSats * legacyOutcomeAmountScale
          : existing?.outcomeFaceAmountSubunits),
      quotePaymentSats: payload.quotePaymentSats ?? existing?.quotePaymentSats,
      baseAsset: payload.baseAsset ?? order?.baseAsset ?? existing?.baseAsset ?? null,
      divisibility: expectedDivisibility ?? existing?.divisibility,
      quotePaymentSubunits:
        payload.quotePaymentSubunits ?? payload.quotePaymentSats ?? existing?.quotePaymentSubunits,
      settlementKind: payload.settlementKind ?? existing?.settlementKind ?? null,
      sellerKeepOutcomeSetId:
        payload.sellerKeepOutcomeSetId ?? existing?.sellerKeepOutcomeSetId ?? null,
      sellerLockOutcomeSetId:
        payload.sellerLockOutcomeSetId ?? existing?.sellerLockOutcomeSetId ?? null,
      isTaker: existing?.isTaker,
      messages: existing?.messages ?? {},
      sellerAdaptorSecretHex: existing?.sellerAdaptorSecretHex,
      sellerAdaptorPointHex: existing?.sellerAdaptorPointHex,
      buyerPreSigsHex: existing?.buyerPreSigsHex,
      buyerLockedProofs: existing?.buyerLockedProofs,
      sellerPreSigsHex: existing?.sellerPreSigsHex,
      engineState: existing?.engineState,
      failureReason: existing?.failureReason,
      takerRecovery: existing?.takerRecovery,
      step: accepted ? promoteTradeCreatedStep(existing?.step) : 'Failed',
      error: protocolError ?? existing?.error,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    state.swaps[payload.tradeId] = record
    if (accepted && decision.role && decision.counterpartyPubkey && profile) {
      const key = secrets?.orderEphemeralKeys[payload.tradeId] ??
        (record.orderId ? secrets?.orderEphemeralKeys[record.orderId] : undefined)
      if (key && key.publicKeyHex === match.ownEphemeralPubkey) {
        const prior = state.durableTradeSessions[payload.tradeId]
        state.durableTradeSessions[payload.tradeId] = prior ?? {
          schemaVersion: 1,
          revision: 0,
          tradeId: payload.tradeId,
          role: decision.role,
          localProtocolPubkey: key.publicKeyHex,
          counterpartyProtocolPubkey: decision.counterpartyPubkey,
          mintUrl: profile.mintUrl,
          sellerLocktimeSecs: Math.floor(new Date(payload.sellerLocktime).getTime() / 1000),
          buyerLocktimeSecs: Math.floor(new Date(payload.buyerLocktime).getTime() / 1000),
          ephemeralKeyHandle: {
            keyId: payload.tradeId,
            tradeId: payload.tradeId,
            role: decision.role,
            localProtocolPubkey: key.publicKeyHex,
            counterpartyProtocolPubkey: decision.counterpartyPubkey,
            mintUrl: profile.mintUrl,
            sellerLocktimeSecs: Math.floor(new Date(payload.sellerLocktime).getTime() / 1000),
            buyerLocktimeSecs: Math.floor(new Date(payload.buyerLocktime).getTime() / 1000),
          },
          stage: 'intent',
          expectedProofOperations: [],
          proofOperations: [],
          receivedCiphers: {},
          outboundCiphers: {},
        }
      }
    }
    return record
  })
}

function promoteTradeCreatedStep(
  existingStep: LocalSwapRecord['step'] | undefined,
): LocalSwapRecord['step'] {
  return existingStep === undefined || existingStep === 'awaiting-trade-created'
    ? 'opened'
    : existingStep
}

export async function recordSwapMessage(
  tradeId: string,
  messageType: string,
  ciphertext: string,
): Promise<LocalSwapRecord | null> {
  return updateState((state, now) => {
    if (isSettlementCompleteMessage(messageType)) {
      return state.swaps[tradeId] ?? null
    }
    const existing = state.swaps[tradeId]
    if (!existing) return null
    const decision = decideSwapMessage({
      role: existing.role,
      messages: existing.messages,
      messageType,
      ciphertext,
    })
    if (!decision.messageKey) {
      return existing
    }
    const next = {
      ...existing,
      messages: decision.messages,
      updatedAt: now,
    }
    state.swaps[tradeId] = next
    journalDurableCipher(state.durableTradeSessions[tradeId], 'receivedCiphers', messageType, ciphertext)
    return next
  })
}

/** Journals the exact outbound ciphertext before transport delivery is attempted. */
export async function journalOutboundSwapCipher(
  tradeId: string,
  messageType: string,
  ciphertext: string,
): Promise<void> {
  await updateState((state) => {
    journalDurableCipher(state.durableTradeSessions[tradeId], 'outboundCiphers', messageType, ciphertext)
  })
}

function journalDurableCipher(
  session: DurableTradeSession | undefined,
  journal: 'receivedCiphers' | 'outboundCiphers',
  messageType: string,
  ciphertext: string,
): void {
  if (!session || !isSwapCipherMessageType(messageType)) return
  const sha256 = createHash('sha256').update(ciphertext).digest('hex')
  const existing = session[journal][messageType]
  if (existing && (existing.ciphertext !== ciphertext || existing.sha256 !== sha256)) {
    throw new Error(`Durable trade ${session.tradeId} has conflicting ${journal} ${messageType} ciphertext`)
  }
  if (!existing) {
    session[journal][messageType] = { ciphertext, sha256 }
    session.revision += 1
  }
}

export async function recordTradeStateChanged(
  tradeId: string,
  engineState: string,
  failureReason?: string,
): Promise<LocalSwapRecord | null> {
  return updateState((state, now) => {
    const existing = state.swaps[tradeId]
    if (!existing) return null
    const next: LocalSwapRecord = {
      ...existing,
      engineState,
      ...(failureReason !== undefined ? { failureReason } : {}),
      step: mapEngineStateToStep(engineState, existing.step),
      updatedAt: now,
    }
    state.swaps[tradeId] = next
    return next
  })
}

function normalizeState(value: unknown): DaemonState {
  if (!isRecord(value) || value.version !== 1) return emptyDaemonState()
  return {
    version: 1,
    wallet: isRecord(value.wallet) && Array.isArray(value.wallet.proofs)
      ? {
          proofs: (value.wallet.proofs as StoredProofRecord[]).map((record) => ({
            ...record,
            proof: normalizeCashuProofRecord(record.proof),
            asset: normalizeProofAsset(record.asset),
          })),
          keysetCounters: isRecord(value.wallet.keysetCounters)
            ? normalizeCounterMap(value.wallet.keysetCounters)
            : {},
        }
      : { proofs: [], keysetCounters: {} },
    proofOperations: isRecord(value.proofOperations)
      ? normalizeProofOperations(value.proofOperations)
      : {},
    durableTradeSessions: isRecord(value.durableTradeSessions)
      ? value.durableTradeSessions as Record<string, DurableTradeSession>
      : {},
    orders: isRecord(value.orders)
      ? normalizeOrders(value.orders)
      : {},
    swaps: isRecord(value.swaps)
      ? normalizeSwaps(value.swaps)
      : {},
  }
}

function normalizeProofAsset(asset: StoredProofAsset | undefined): StoredProofAsset {
  if (isOutcomeProofAsset(asset)) {
    return {
      kind: 'Outcome',
      conditionId: asset.conditionId,
      outcomeSetId: asset.outcomeSetId,
      baseAsset: normalizeProofAssetBaseAsset(asset),
    }
  }

  return {
    kind: 'sats',
    baseAsset: normalizeProofAssetBaseAsset(asset),
  }
}

function isOutcomeProofAsset(
  asset: StoredProofAsset | undefined,
): asset is Extract<StoredProofAsset, { kind: 'Outcome' }> {
  return asset?.kind === 'Outcome' || (asset as { kind?: unknown } | undefined)?.kind === 'outcome'
}

function normalizeProofAssetBaseAsset(asset: StoredProofAsset | undefined): string {
  return normalizeMarketBaseAsset(asset?.baseAsset)
}

function normalizeCounterMap(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' &&
        Number.isInteger(entry[1]) &&
        entry[1] >= 0,
    ),
  )
}

function normalizeProofOperations(
  value: Record<string, unknown>,
): Record<string, ProofOperationRecord> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([operationId, raw]) => normalizeProofOperation(operationId, raw))
      .filter((entry): entry is [string, ProofOperationRecord] => entry !== null),
  )
}

function normalizeProofOperation(
  operationId: string,
  raw: unknown,
): [string, ProofOperationRecord] | null {
  if (!isRecord(raw)) return null
  const kind = raw.kind
  const state = normalizeProofOperationState(raw.state)
  const mintUrl = raw.mintUrl
  if (
    !isProofOperationKind(kind) ||
    !isProofOperationState(state) ||
    typeof mintUrl !== 'string'
  ) {
    return null
  }
  return [
    operationId,
    {
      operationId:
        typeof raw.operationId === 'string' ? raw.operationId : operationId,
      durableTradeRecovery: isRecord(raw.durableTradeRecovery)
        ? raw.durableTradeRecovery as unknown as DurableTradeProofOperationLink
        : undefined,
      kind,
      state,
      mintUrl,
      inputs: Array.isArray(raw.inputs)
        ? (raw.inputs as CashuProofRecord[]).map(normalizeCashuProofRecord)
        : [],
      outputs: isRecord(raw.outputs)
        ? (raw.outputs as Record<string, StoredOutputData[]>)
        : {},
      metadata: isRecord(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : {},
      resultProofs: isRecord(raw.resultProofs)
        ? normalizeProofRecordGroups(raw.resultProofs as Record<string, CashuProofRecord[]>)
        : undefined,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    },
  ]
}

function assertCompatibleProofOperation(
  existing: ProofOperationRecord,
  input: PrepareProofOperationInput,
): void {
  if (
    existing.kind !== input.kind ||
    existing.mintUrl !== input.mintUrl ||
    JSON.stringify(existing.inputs) !== JSON.stringify(input.inputs)
  ) {
    throw new Error(
      `Proof operation ${input.operationId} does not match this swap step`,
    )
  }
}

function normalizeSwaps(value: Record<string, unknown>): Record<string, LocalSwapRecord> {
  return Object.fromEntries(
    Object.entries(value).map(([tradeId, raw]) => {
      const swap = raw as Partial<LocalSwapRecord>
      return [
        tradeId,
        {
          ...swap,
          tradeId: swap.tradeId ?? tradeId,
          messages: swap.messages ?? {},
          step: normalizeSwapStep(swap.step),
          createdAt: swap.createdAt ?? new Date(0).toISOString(),
          updatedAt: swap.updatedAt ?? new Date(0).toISOString(),
        } as LocalSwapRecord,
      ]
    }),
  )
}

function normalizeOrders(value: Record<string, unknown>): Record<string, LocalOrderRecord> {
  return Object.fromEntries(
    Object.entries(value).map(([orderId, raw]) => {
      const order = raw as Partial<LocalOrderRecord>
      return [
        orderId,
        {
          ...order,
          orderId: order.orderId ?? orderId,
          ...(normalizeTokenSide(order.tokenSide)
            ? { tokenSide: normalizeTokenSide(order.tokenSide) }
            : {}),
          ...(normalizeOrderSide(order.side)
            ? { side: normalizeOrderSide(order.side) }
            : {}),
          status: normalizeOrderStatus(order.status),
          tradeIds: order.tradeIds ?? [],
          createdAt: order.createdAt ?? new Date(0).toISOString(),
          updatedAt: order.updatedAt ?? new Date(0).toISOString(),
        } as LocalOrderRecord,
      ]
    }),
  )
}

function normalizeTokenSide(value: unknown): LocalOrderRecord['tokenSide'] {
  if (value === 'Outcome' || value === 'outcome') return 'Outcome'
  if (value === 'Complement' || value === 'complement') return 'Complement'
  return undefined
}

function normalizeOrderSide(value: unknown): LocalOrderRecord['side'] {
  if (value === 'Buy' || value === 'buy') return 'Buy'
  if (value === 'Sell' || value === 'sell') return 'Sell'
  return undefined
}

function normalizeOrderStatus(value: unknown): string {
  if (value === 'filled') return 'Filled'
  if (value === 'failed') return 'Failed'
  return typeof value === 'string' ? value : 'unknown'
}

function normalizeSwapStep(value: unknown): LocalSwapRecord['step'] {
  if (value === 'failed') return 'Failed'
  if (
    value === 'awaiting-trade-created' ||
    value === 'opened' ||
    value === 'seller-opened' ||
    value === 'buyer-responded' ||
    value === 'settling' ||
    value === 'awaiting-confirmation' ||
    value === 'confirmed' ||
    value === 'refunded' ||
    value === 'Failed'
  ) {
    return value
  }
  return 'awaiting-trade-created'
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key)
  if (existing) return existing
  const fresh = create()
  map.set(key, fresh)
  return fresh
}

function normalizeProofRecordGroups(
  groups: Record<string, CashuProofRecord[]>,
): Record<string, CashuProofRecord[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, proofs]) => [
      label,
      proofs.map(normalizeCashuProofRecord),
    ]),
  )
}

function normalizeCashuProofRecord(proof: CashuProofRecord): CashuProofRecord {
  return {
    ...structuredClone(proof),
    amount: amountToNumber(proof.amount),
  }
}

function addAmount(
  target: { availableSats: number; reservedSats: number; lockedSats: number },
  state: StoredProofRecord['state'],
  amount: number,
): void {
  if (state === 'available') target.availableSats += amount
  else if (state === 'reserved') target.reservedSats += amount
  else target.lockedSats += amount
}

function extractTradeIds(value: unknown): string[] {
  if (!isRecord(value)) return []
  const fillTradeIds = Array.isArray(value.fills)
    ? value.fills.map((fill) => (isRecord(fill) ? fill.tradeId : undefined))
    : []
  const pendingTradeIds = Array.isArray(value.pendingPubkeySubmissions)
    ? value.pendingPubkeySubmissions.map((submission) =>
        isRecord(submission) ? submission.tradeId : undefined)
    : []
  const topLevelTradeId = typeof value.tradeId === 'string' && value.tradeId ? [value.tradeId] : []
  return [...fillTradeIds, ...pendingTradeIds, ...topLevelTradeId]
    .filter((tradeId): tradeId is string => typeof tradeId === 'string' && tradeId.length > 0)
}

function extractTakerParticipation(
  value: unknown,
  orderId: string,
): Map<string, boolean> {
  if (!isRecord(value) || !Array.isArray(value.fills)) return new Map()
  const participation = new Map<string, boolean>()
  for (const fill of value.fills) {
    if (!isRecord(fill)) continue
    const tradeId = typeof fill.tradeId === 'string' ? fill.tradeId : undefined
    const takerOrderId =
      typeof fill.takerOrderId === 'string' ? fill.takerOrderId : undefined
    if (tradeId && takerOrderId) {
      participation.set(tradeId, takerOrderId === orderId)
    }
  }
  return participation
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null
  const field = value[key]
  return typeof field === 'string' ? field : null
}

function readNumberProperty(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProofOperationKind(value: unknown): value is ProofOperationKind {
  return (
    value === 'swap-lock' ||
    value === 'swap-claim' ||
    value === 'conditional-keyset-swap' ||
    value === 'ctf-split' ||
    value === 'ctf-merge' ||
    value === 'ctf-consolidation' ||
    value === 'ctf-redeem' ||
    value === 'regular-split' ||
    value === 'wallet-send' ||
    value === 'proof-split' ||
    value === 'swap-refund'
  )
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (
    value &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof value.toNumber === 'function'
  ) {
    return value.toNumber()
  }
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, toJsonSafe(nested)]),
  )
}

function isProofOperationState(value: unknown): value is ProofOperationState {
  return value === 'prepared' || value === 'mint-submitted' || value === 'completed' || value === 'Failed'
}

function normalizeProofOperationState(value: unknown): unknown {
  return value === 'failed' ? 'Failed' : value
}

function findOrderForTradeCreated(
  state: DaemonState,
  payload: DaemonTradeCreatedPayload,
  ownEphemeralPubkey: string | undefined,
): { orderId: string; marketId: string; ownEphemeralPubkey: string } | null {
  for (const order of Object.values(state.orders)) {
    const orderEphemeralPubkey = readStringProperty(order, 'ephemeralPubkey')
    const matchedEphemeralPubkey = ownEphemeralPubkey ?? orderEphemeralPubkey ?? undefined
    if (
      matchedEphemeralPubkey &&
      order.tradeIds.includes(payload.tradeId)
    ) {
      return {
        orderId: order.orderId,
        marketId: order.marketId,
        ownEphemeralPubkey: matchedEphemeralPubkey,
      }
    }
    if (
      orderEphemeralPubkey &&
      isOrderEphemeralForTrade(orderEphemeralPubkey, payload) &&
      orderMarketMatchesTradeCreated(order, payload)
    ) {
      return {
        orderId: order.orderId,
        marketId: order.marketId,
        ownEphemeralPubkey: orderEphemeralPubkey,
      }
    }
  }
  return null
}

function isOrderEphemeralForTrade(
  orderEphemeralPubkey: string,
  payload: DaemonTradeCreatedPayload,
): boolean {
  return orderEphemeralPubkey === payload.sellerPubkey || orderEphemeralPubkey === payload.buyerPubkey
}

function orderMarketMatchesTradeCreated(
  order: LocalOrderRecord,
  payload: DaemonTradeCreatedPayload,
): boolean {
  if (payload.settlementKind !== 'Mint') {
    return order.marketId === payload.marketId
  }
  const role = orderRoleForTradeCreated(order, payload)
  if (!role) return false
  const conditionId = payload.marketId.split('-', 1)[0]
  const sellerKeepMarketId = payload.sellerKeepOutcomeSetId
    ? `${conditionId}-${payload.sellerKeepOutcomeSetId}`
    : null
  const sellerLockMarketId = payload.sellerLockOutcomeSetId
    ? `${conditionId}-${payload.sellerLockOutcomeSetId}`
    : payload.marketId
  if (role === 'seller') return order.marketId === sellerKeepMarketId
  if (order.tokenSide === 'Complement') return order.marketId === sellerKeepMarketId
  return order.marketId === sellerLockMarketId
}

function orderRoleForTradeCreated(
  order: LocalOrderRecord,
  payload: DaemonTradeCreatedPayload,
): 'seller' | 'buyer' | null {
  const orderEphemeralPubkey = readStringProperty(order, 'ephemeralPubkey')
  if (orderEphemeralPubkey === payload.sellerPubkey) return 'seller'
  if (orderEphemeralPubkey === payload.buyerPubkey) return 'buyer'
  return null
}

function mapEngineStateToStep(
  engineState: string,
  current: LocalSwapRecord['step'],
): LocalSwapRecord['step'] {
  switch (decideTradeStateChanged(engineState)) {
    case 'settlement-claim':
      return 'settling'
    case 'finish-confirmed':
      return 'confirmed'
    case 'finish-refunded':
      return 'refunded'
    case 'finish-failed':
      return 'Failed'
    default:
      return current
  }
}
