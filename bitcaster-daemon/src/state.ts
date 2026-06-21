import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
  isSettlementCompleteMessage,
} from '@bitcaster-market/client-sdk/tradeFlow'
import {
  normalizeMarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type {
  PartialLockHeldRecord,
  SwapFailure,
} from '@bitcaster-market/client-sdk/swapFailure'
import { ensureProfileDir, profileDir } from './profile.ts'

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

export type ProofOperationState = 'prepared' | 'completed' | 'failed'

export interface ProofOperationRecord {
  operationId: string
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
  | { kind: 'outcome'; conditionId: string; outcomeSetId: string; baseAsset?: string | null }

export interface LocalOrderRecord {
  orderId: string
  marketId: string
  tokenSide?: 'Outcome' | 'Complement'
  side?: 'Buy' | 'Sell'
  priceSubunits?: number
  amountSubunits?: number
  status: string
  ephemeralPubkey?: string
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
  outcomeFaceAmountSats?: number
  outcomeFaceAmountSubunits?: number
  quotePaymentSats?: number
  baseAsset?: string | null
  divisibility?: number
  quotePaymentSubunits?: number
  settlementKind?: string | null
  sellerKeepOutcomeSetId?: string | null
  sellerLockOutcomeSetId?: string | null
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
  step:
    | 'awaiting-trade-created'
    | 'opened'
    | 'seller-opened'
    | 'buyer-responded'
    | 'settling'
    | 'awaiting-confirmation'
    | 'confirmed'
      | 'refunded'
      | 'failed'
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
      resultProofs: normalizeProofRecordGroups(resultProofs),
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

    if (proof.asset.kind === 'outcome') {
      const key = `${proof.mintUrl}\n${proof.asset.conditionId}\n${proof.asset.outcomeSetId}`
      const outcome = getOrCreate(outcomes, key, () => ({
        mintUrl: proof.mintUrl,
        conditionId: proof.asset.kind === 'outcome' ? proof.asset.conditionId : '',
        outcomeSetId: proof.asset.kind === 'outcome' ? proof.asset.outcomeSetId : '',
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
  ephemeralPubkey: string,
  engineResponse: unknown,
  preflightSplit?: LocalOrderPreflightSplit | null,
  tokenSide?: 'Outcome' | 'Complement',
  side?: 'Buy' | 'Sell',
  priceSubunits?: number,
  amountSubunits?: number,
): Promise<LocalOrderRecord> {
  const orderId = readStringProperty(engineResponse, 'orderId')
  if (!orderId) {
    throw new Error('engine submit response did not include orderId')
  }
  return upsertOrderFromEngine(
    marketId,
    orderId,
    engineResponse,
    ephemeralPubkey,
    preflightSplit,
    tokenSide,
    side,
    priceSubunits,
    amountSubunits,
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
  ephemeralPubkey?: string,
  preflightSplit?: LocalOrderPreflightSplit | null,
  tokenSide?: 'Outcome' | 'Complement',
  side?: 'Buy' | 'Sell',
  priceSubunits?: number,
  amountSubunits?: number,
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
    const record: LocalOrderRecord = {
      orderId,
      marketId,
      ...(nextTokenSide ? { tokenSide: nextTokenSide } : {}),
      ...(nextSide ? { side: nextSide } : {}),
      ...(nextPriceSubunits != null ? { priceSubunits: nextPriceSubunits } : {}),
      ...(nextAmountSubunits != null ? { amountSubunits: nextAmountSubunits } : {}),
      status,
      ephemeralPubkey: ephemeralPubkey ?? existing?.ephemeralPubkey,
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
        outcomeFaceAmountSats: swap?.outcomeFaceAmountSats,
        outcomeFaceAmountSubunits: swap?.outcomeFaceAmountSubunits,
        quotePaymentSats: swap?.quotePaymentSats,
        baseAsset: swap?.baseAsset,
        divisibility: swap?.divisibility,
        quotePaymentSubunits: swap?.quotePaymentSubunits,
        settlementKind: swap?.settlementKind,
        sellerKeepOutcomeSetId: swap?.sellerKeepOutcomeSetId,
        sellerLockOutcomeSetId: swap?.sellerLockOutcomeSetId,
        messages: swap?.messages ?? {},
        sellerAdaptorSecretHex: swap?.sellerAdaptorSecretHex,
        sellerAdaptorPointHex: swap?.sellerAdaptorPointHex,
        buyerPreSigsHex: swap?.buyerPreSigsHex,
        buyerLockedProofs: swap?.buyerLockedProofs,
        sellerPreSigsHex: swap?.sellerPreSigsHex,
        engineState: swap?.engineState,
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
  return updateState((state, now) => {
    const match = findOrderForTradeCreated(state, payload)
    if (!match) return null

    const existing = state.swaps[payload.tradeId]
    const order = state.orders[match.orderId]
    if (order && !order.tradeIds.includes(payload.tradeId)) {
      order.tradeIds = [...order.tradeIds, payload.tradeId]
      order.updatedAt = now
    }
    const decision = decideTradeCreated({
      ownEphemeralPubkey: match.ephemeralPubkey,
      sellerPubkey: payload.sellerPubkey,
      buyerPubkey: payload.buyerPubkey,
      sellerLocktime: payload.sellerLocktime,
      buyerLocktime: payload.buyerLocktime,
      settlementKind: payload.settlementKind,
      sellerKeepOutcomeSetId: payload.sellerKeepOutcomeSetId,
      sellerLockOutcomeSetId: payload.sellerLockOutcomeSetId,
      baseAsset: payload.baseAsset,
      divisibility: payload.divisibility,
      expectedBaseAsset: order?.baseAsset,
      expectedDivisibility: order?.divisibility,
      expectedOrder:
        order?.side && order.priceSubunits != null && order.amountSubunits != null
          ? {
              side: order.side,
              tokenSide: order.tokenSide,
              priceSubunits: order.priceSubunits,
              amountSubunits: order.amountSubunits,
            }
          : null,
      requireExpectedOrder: true,
      outcomeFaceAmountSats: payload.outcomeFaceAmountSats,
      quotePaymentSats: payload.quotePaymentSats,
      outcomeFaceAmountSubunits: payload.outcomeFaceAmountSubunits,
      quotePaymentSubunits: payload.quotePaymentSubunits,
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
      outcomeFaceAmountSats:
        payload.outcomeFaceAmountSats ?? existing?.outcomeFaceAmountSats,
      outcomeFaceAmountSubunits:
        payload.outcomeFaceAmountSubunits ?? existing?.outcomeFaceAmountSubunits,
      quotePaymentSats: payload.quotePaymentSats ?? existing?.quotePaymentSats,
      baseAsset: payload.baseAsset ?? order?.baseAsset ?? existing?.baseAsset ?? null,
      divisibility: payload.divisibility ?? order?.divisibility ?? existing?.divisibility,
      quotePaymentSubunits:
        payload.quotePaymentSubunits ?? existing?.quotePaymentSubunits,
      settlementKind: payload.settlementKind ?? existing?.settlementKind ?? null,
      sellerKeepOutcomeSetId:
        payload.sellerKeepOutcomeSetId ?? existing?.sellerKeepOutcomeSetId ?? null,
      sellerLockOutcomeSetId:
        payload.sellerLockOutcomeSetId ?? existing?.sellerLockOutcomeSetId ?? null,
      messages: existing?.messages ?? {},
      sellerAdaptorSecretHex: existing?.sellerAdaptorSecretHex,
      sellerAdaptorPointHex: existing?.sellerAdaptorPointHex,
      buyerPreSigsHex: existing?.buyerPreSigsHex,
      buyerLockedProofs: existing?.buyerLockedProofs,
      sellerPreSigsHex: existing?.sellerPreSigsHex,
      engineState: existing?.engineState,
      step: accepted ? promoteTradeCreatedStep(existing?.step) : 'failed',
      error: protocolError ?? existing?.error,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    state.swaps[payload.tradeId] = record
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
    return next
  })
}

export async function recordTradeStateChanged(
  tradeId: string,
  engineState: string,
): Promise<LocalSwapRecord | null> {
  return updateState((state, now) => {
    const existing = state.swaps[tradeId]
    if (!existing) return null
    const next: LocalSwapRecord = {
      ...existing,
      engineState,
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
    orders: isRecord(value.orders)
      ? (value.orders as Record<string, LocalOrderRecord>)
      : {},
    swaps: isRecord(value.swaps)
      ? normalizeSwaps(value.swaps)
      : {},
  }
}

function normalizeProofAsset(asset: StoredProofAsset | undefined): StoredProofAsset {
  if (asset?.kind === 'outcome') {
    return {
      kind: 'outcome',
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
  const state = raw.state
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
          step: swap.step ?? 'awaiting-trade-created',
          createdAt: swap.createdAt ?? new Date(0).toISOString(),
          updatedAt: swap.updatedAt ?? new Date(0).toISOString(),
        } as LocalSwapRecord,
      ]
    }),
  )
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
  if (!isRecord(value) || !Array.isArray(value.fills)) return []
  return value.fills
    .map((fill) => (isRecord(fill) ? fill.tradeId : undefined))
    .filter((tradeId): tradeId is string => typeof tradeId === 'string' && tradeId.length > 0)
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
  return value === 'prepared' || value === 'completed' || value === 'failed'
}

function findOrderForTradeCreated(
  state: DaemonState,
  payload: DaemonTradeCreatedPayload,
): { orderId: string; marketId: string; ephemeralPubkey: string } | null {
  const seller = payload.sellerPubkey.toLowerCase()
  const buyer = payload.buyerPubkey.toLowerCase()
  for (const order of Object.values(state.orders)) {
    const ephemeralPubkey = order.ephemeralPubkey?.toLowerCase()
    if (!ephemeralPubkey) continue
    const role =
      ephemeralPubkey === seller
        ? 'seller'
        : ephemeralPubkey === buyer
          ? 'buyer'
          : null
    if (role && order.tradeIds.includes(payload.tradeId)) {
      return {
        orderId: order.orderId,
        marketId: order.marketId,
        ephemeralPubkey: order.ephemeralPubkey!,
      }
    }
    if (role && tradeCreatedMatchesOrderPath(order, payload, role)) {
      return {
        orderId: order.orderId,
        marketId: order.marketId,
        ephemeralPubkey: order.ephemeralPubkey!,
      }
    }
  }
  return null
}

function tradeCreatedMatchesOrderPath(
  order: LocalOrderRecord,
  payload: DaemonTradeCreatedPayload,
  role: 'seller' | 'buyer',
): boolean {
  const settlementKind = payload.settlementKind ?? 'DirectSwap'
  if (settlementKind === 'DirectSwap') {
    return order.marketId === payload.marketId
  }

  if (settlementKind !== 'Mint') {
    return true
  }

  if (!payload.sellerKeepOutcomeSetId || !payload.sellerLockOutcomeSetId) {
    return true
  }

  if (
    order.marketId === payload.marketId &&
    (role === 'buyer' || order.tokenSide === 'Complement')
  ) {
    return true
  }

  const market = parseMarketId(payload.marketId)
  if (!market) return true

  const sellerKeepMarketId = `${market.conditionId}-${payload.sellerKeepOutcomeSetId}`
  const sellerLockMarketId = `${market.conditionId}-${payload.sellerLockOutcomeSetId}`
  if (order.tokenSide === 'Complement') {
    if (role === 'buyer' && order.marketId === sellerKeepMarketId) {
      return true
    }
    if (role === 'seller' && order.marketId === sellerLockMarketId) {
      return true
    }
  }

  const expectedOutcomeSetId =
    role === 'seller'
      ? payload.sellerKeepOutcomeSetId
      : payload.sellerLockOutcomeSetId
  return order.marketId === `${market.conditionId}-${expectedOutcomeSetId}`
}

function parseMarketId(
  marketId: string,
): { conditionId: string; outcomeSetId: string } | null {
  const dash = marketId.lastIndexOf('-')
  if (dash <= 0 || dash >= marketId.length - 1) return null
  return {
    conditionId: marketId.slice(0, dash),
    outcomeSetId: marketId.slice(dash + 1),
  }
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
      return 'failed'
    default:
      return current
  }
}
