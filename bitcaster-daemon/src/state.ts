import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Proof } from '@cashu/cashu-ts'
import {
  completedProofAuthorityDigest,
  type CtfProofOperationCompletion,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
  isSettlementCompleteMessage,
} from '@bitcaster-market/client-sdk/tradeFlow'
import {
  cashuAmountToMarketSubunits,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from '@bitcaster-market/client-sdk/marketUnits'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { PartialLockHeldRecord, SwapFailure } from '@bitcaster-market/client-sdk/swapFailure'
import { profileDatabasePath, profileDir } from './profile.ts'
import { readSecrets } from './secrets.ts'
import { openDaemonStateSqlite, withDaemonStateSqliteTransaction } from './stateSqlite.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

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

export type ProofOperationState = 'prepared' | 'completed' | 'Failed'

export interface ProofOperationRecord {
  operationId: string
  kind: ProofOperationKind
  state: ProofOperationState
  mintUrl: string
  inputs: CashuProofRecord[]
  outputs: Record<string, StoredOutputData[]>
  metadata: Record<string, unknown>
  resultProofs?: Record<string, CashuProofRecord[]>
  resultProofsDigest?: string
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
  | { kind: 'sats'; baseAsset: 'sat'; unit: 'sat' | 'msat' }
  | {
      kind: 'Outcome'
      conditionId: string
      outcomeSetId: string
      baseAsset: 'sat'
      unit: 'msat'
    }

export interface LocalOrderRecord {
  orderId: string
  marketId: string
  tokenSide?: 'Outcome' | 'Complement'
  side?: 'Buy' | 'Sell'
  priceSubunits?: number
  amountSubunits?: number
  status: string
  ephemeralPubkey?: string
  clientOrderId?: string
  preflightSplit?: LocalOrderPreflightSplit
  baseAsset: 'sat'
  divisibility: number
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
  amountSubunits: number
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
  baseAsset: 'sat'
  divisibility: number
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
  baseAsset: 'sat'
  collateralUnit: 'msat'
  divisibility: number
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
  return profileDatabasePath()
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
    await withDaemonStateSqliteTransaction(profileDir(), (database) => {
      writeStateToDatabase(database, fresh)
    })
    return fresh
  })
}

export async function readState(): Promise<DaemonState | null> {
  return withProfileStorageAccess(async () => {
    const database = await openDaemonStateSqlite(profileDir())
    try {
      return readStateFromDatabase(database)
    } finally {
      database.close()
    }
  })
}

export async function writeState(state: DaemonState): Promise<void> {
  await withStateUpdateLock(async () => {
    await withDaemonStateSqliteTransaction(profileDir(), (database) => {
      writeStateToDatabase(database, normalizeState(state))
    })
  })
}

export async function updateState<T>(update: (state: DaemonState, now: string) => T): Promise<T> {
  return withStateUpdateLock(async () => {
    return withDaemonStateSqliteTransaction(profileDir(), (database) => {
      const state = readStateFromDatabase(database) ?? emptyDaemonState()
      const result = update(state, new Date().toISOString())
      writeStateToDatabase(database, normalizeState(state))
      return result
    })
  })
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
          normalizeProofAssetBaseAsset(record.asset) === 'sat' &&
          normalizeProofAssetUnit(record.asset) === 'sat',
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
      (record) => record.mintUrl !== input.mintUrl || record.reservedBy !== input.reservedBy,
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
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
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

export async function getProofOperation(operationId: string): Promise<ProofOperationRecord | null> {
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
      resultProofsDigest: undefined,
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
  completion: Record<string, CashuProofRecord[]> | CtfProofOperationCompletion,
): Promise<ProofOperationRecord> {
  return updateState((state) => {
    const existing = state.proofOperations[operationId]
    if (!existing) {
      throw new Error(`Missing proof operation ${operationId}`)
    }
    const ctfCompletion = isCtfProofOperationCompletion(completion)
    if (isSdkCtfProofOperationKind(existing.kind) && !ctfCompletion) {
      throw new Error(`Proof operation ${operationId} requires an SDK completion`)
    }
    if (ctfCompletion && completion.kind !== existing.kind) {
      throw new Error(
        `Proof operation ${operationId} kind ${existing.kind} does not match completion ${completion.kind}`,
      )
    }
    const resultProofs = ctfCompletion ? completion.resultProofs : completion
    const updated: ProofOperationRecord = {
      ...existing,
      state: 'completed',
      resultProofs: normalizeProofRecordGroups(resultProofs),
      resultProofsDigest:
        ctfCompletion && 'resultProofsDigest' in completion
          ? completion.resultProofsDigest
          : undefined,
      lastError: null,
      updatedAt: Date.now(),
    }
    state.proofOperations[operationId] = updated
    return updated
  })
}

function isCtfProofOperationCompletion(
  value: Record<string, CashuProofRecord[]> | CtfProofOperationCompletion,
): value is CtfProofOperationCompletion {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'resultProofs' in value
  )
}

function isSdkCtfProofOperationKind(kind: ProofOperationKind): boolean {
  return (
    kind === 'ctf-split' ||
    kind === 'ctf-merge' ||
    kind === 'ctf-redeem' ||
    kind === 'regular-split'
  )
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

    const amount =
      cashuAmountToMarketSubunits(
        amountToNumber(proof.proof.amount),
        normalizeProofAssetUnit(proof.asset),
      ) / 1_000
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

  const mintRows = [...byMint.values()].sort((a, b) => a.mintUrl.localeCompare(b.mintUrl))
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
  baseAsset?: 'sat',
  divisibility?: number,
): Promise<LocalOrderRecord> {
  return upsertOrderFromEngine(
    marketId,
    orderId,
    engineStatus,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    baseAsset,
    divisibility,
  )
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
  baseAsset?: 'sat',
  divisibility?: number,
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
    baseAsset,
    divisibility,
  )
}

function summarizeProofOperation(operation: ProofOperationRecord): ProofOperationSummary {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    state: operation.state,
    mintUrl: operation.mintUrl,
    inputAmountSats: operation.inputs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0),
    inputCount: operation.inputs.length,
    outputCounts: countRecordArrays(operation.outputs),
    resultProofCounts: countRecordArrays(operation.resultProofs ?? {}),
    lastError: operation.lastError,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  }
}

function countRecordArrays<T>(record: Record<string, T[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([key, values]) => [key, values.length]))
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
  suppliedBaseAsset?: 'sat',
  suppliedDivisibility?: number,
): Promise<LocalOrderRecord> {
  return updateState((state, now) => {
    const existing = state.orders[orderId]
    const status = readStringProperty(engineStatus, 'status') ?? existing?.status ?? 'unknown'
    const engineBaseAsset = readStringProperty(engineStatus, 'baseAsset')
    const baseAsset =
      suppliedBaseAsset ??
      (engineBaseAsset === undefined
        ? existing?.baseAsset
        : normalizeMarketBaseAsset(engineBaseAsset))
    if (baseAsset === undefined) {
      throw new Error('engine order status did not include required baseAsset')
    }
    const engineDivisibility = readNumberProperty(engineStatus, 'divisibility')
    const divisibility =
      suppliedDivisibility ??
      (engineDivisibility === undefined
        ? existing?.divisibility
        : normalizeMarketDivisibility(engineDivisibility, baseAsset))
    if (divisibility === undefined) {
      throw new Error('engine order status did not include required divisibility')
    }
    const tradeIds = [...new Set([...(existing?.tradeIds ?? []), ...extractTradeIds(engineStatus)])]
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
      ...((clientOrderId ?? existing?.clientOrderId)
        ? { clientOrderId: clientOrderId ?? existing?.clientOrderId }
        : {}),
      baseAsset,
      divisibility,
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
        baseAsset: swap?.baseAsset ?? baseAsset,
        divisibility: swap?.divisibility ?? divisibility,
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
  const canonicalPayload: DaemonTradeCreatedPayload = {
    ...payload,
    baseAsset: normalizeMarketBaseAsset(payload.baseAsset),
    divisibility: normalizeMarketDivisibility(payload.divisibility, 'sat'),
  }
  const secrets = await readSecrets()
  const tradeKey = secrets?.orderEphemeralKeys[canonicalPayload.tradeId]
  const ownEphemeralPubkey = tradeKey?.publicKeyHex
  return updateState((state, now) => {
    const payload = canonicalPayload
    const match = findOrderForTradeCreated(state, payload, ownEphemeralPubkey)
    if (!match) return null
    const key = tradeKey ?? secrets?.orderEphemeralKeys[match.orderId]
    if (
      key !== undefined &&
      (key.orderId !== match.orderId ||
        key.marketId !== match.marketId ||
        (key.tradeId !== undefined && key.tradeId !== payload.tradeId) ||
        key.publicKeyHex !== match.ownEphemeralPubkey)
    ) {
      throw new Error(`TradeCreated ${payload.tradeId} protocol key binding is invalid`)
    }

    const existing = state.swaps[payload.tradeId]
    const order = state.orders[match.orderId]
    const expectedDivisibility = order?.divisibility ?? payload.divisibility
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
      baseAsset: payload.baseAsset,
      divisibility: payload.divisibility,
      expectedBaseAsset: order?.baseAsset,
      expectedDivisibility,
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
      fillAmountSubunits: payload.fillAmountSubunits ?? existing?.fillAmountSubunits,
      outcomeFaceAmountSats: payload.outcomeFaceAmountSats ?? existing?.outcomeFaceAmountSats,
      outcomeFaceAmountSubunits:
        payload.outcomeFaceAmountSubunits ?? existing?.outcomeFaceAmountSubunits,
      quotePaymentSats: payload.quotePaymentSats ?? existing?.quotePaymentSats,
      baseAsset: payload.baseAsset,
      divisibility: payload.divisibility,
      quotePaymentSubunits: payload.quotePaymentSubunits ?? existing?.quotePaymentSubunits,
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
      step: accepted ? promoteTradeCreatedStep(existing?.step) : 'Failed',
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

function readStateFromDatabase(database: DatabaseSync): DaemonState | null {
  const scopeId = readScopeId(database)
  const metadata = database
    .prepare('SELECT schema_version FROM target_state_metadata WHERE scope_id = ?')
    .get(scopeId)
  if (metadata === undefined) return null

  const state = emptyDaemonState()
  for (const raw of database
    .prepare('SELECT * FROM target_wallet_proofs WHERE scope_id = ? ORDER BY proof_id')
    .all(scopeId) as Array<Record<string, unknown>>) {
    const proof = decodeArtifact(raw.proof_body, 'wallet proof') as CashuProofRecord
    const asset: StoredProofAsset =
      raw.asset_kind === 'outcome'
        ? {
            kind: 'Outcome',
            conditionId: requireText(raw.condition_id, 'proof condition'),
            outcomeSetId: requireText(raw.outcome_set_id, 'proof outcome set'),
            baseAsset: requireSatBaseAsset(raw.base_asset, 'proof base asset'),
            unit: requireMsatUnit(raw.unit, 'outcome proof unit'),
          }
        : {
            kind: 'sats',
            baseAsset: requireSatBaseAsset(raw.base_asset, 'proof base asset'),
            unit: requireCashuUnit(raw.unit, 'proof unit'),
          }
    state.wallet.proofs.push({
      proof: normalizeCashuProofRecord(proof),
      mintUrl: requireText(raw.normalized_mint, 'proof mint'),
      state: requireProofState(raw.state),
      asset,
      ...(raw.reserved_by === null
        ? {}
        : { reservedBy: requireText(raw.reserved_by, 'proof reservation') }),
      createdAt: timestampToIso(raw.created_at_ms, 'proof created time'),
      updatedAt: timestampToIso(raw.updated_at_ms, 'proof updated time'),
    })
  }
  for (const raw of database
    .prepare('SELECT keyset_id, next_counter FROM target_keyset_counters WHERE scope_id = ?')
    .all(scopeId) as Array<Record<string, unknown>>) {
    state.wallet.keysetCounters[requireText(raw.keyset_id, 'counter keyset')] = requireInteger(
      raw.next_counter,
      'counter value',
    )
  }
  for (const raw of database
    .prepare('SELECT * FROM target_proof_operations WHERE scope_id = ?')
    .all(scopeId) as Array<Record<string, unknown>>) {
    const operationId = requireText(raw.operation_id, 'operation id')
    const request = decodeArtifactById(database, scopeId, raw.request_artifact_id)
    const outputs = decodeArtifactById(database, scopeId, raw.output_artifact_id)
    const requestRecord = requireRecord(request, 'operation request')
    const operation: ProofOperationRecord = {
      operationId,
      kind: requireProofOperationKind(raw.kind),
      state: requireProofOperationState(raw.state),
      mintUrl: requireText(raw.normalized_mint, 'operation mint'),
      inputs: requireArray(requestRecord.inputs, 'operation inputs').map((proof) =>
        normalizeCashuProofRecord(proof as CashuProofRecord),
      ),
      outputs: requireRecord(outputs, 'operation outputs') as Record<string, StoredOutputData[]>,
      metadata: requireRecord(requestRecord.metadata, 'operation metadata'),
      lastError: raw.last_error === null ? null : requireText(raw.last_error, 'operation error'),
      createdAt: requireInteger(raw.created_at_ms, 'operation created time'),
      updatedAt: requireInteger(raw.updated_at_ms, 'operation updated time'),
    }
    if (raw.result_artifact_id !== null) {
      operation.resultProofs = normalizeProofRecordGroups(
        requireRecord(
          decodeArtifactById(database, scopeId, raw.result_artifact_id),
          'operation result',
        ) as Record<string, CashuProofRecord[]>,
      )
      if (operation.kind === 'ctf-split' || operation.kind === 'ctf-merge') {
        const storedDigest = requireText(
          raw.result_proofs_digest,
          'operation result authority digest',
        )
        const computedDigest = completedProofAuthorityDigest(
          operation.resultProofs as Record<string, Proof[]>,
        )
        if (storedDigest !== computedDigest) {
          throw new Error('operation result authority digest does not match result proofs')
        }
        operation.resultProofsDigest = storedDigest
      } else if (raw.result_proofs_digest !== null) {
        throw new Error('non-CTF operation has an unexpected result authority digest')
      }
    }
    state.proofOperations[operationId] = operation
  }
  for (const raw of database
    .prepare('SELECT * FROM daemon_orders WHERE scope_id = ?')
    .all(scopeId) as Array<Record<string, unknown>>) {
    const orderId = requireText(raw.order_id, 'order id')
    const tradeIds = (
      database
        .prepare(
          `SELECT trade_id FROM daemon_order_trades
         WHERE scope_id = ? AND order_id = ? ORDER BY position`,
        )
        .all(scopeId, orderId) as Array<Record<string, unknown>>
    ).map((row) => requireText(row.trade_id, 'order trade id'))
    const preflight =
      raw.preflight_reservation_id === null
        ? undefined
        : {
            reservationId: requireText(raw.preflight_reservation_id, 'preflight reservation'),
            conditionId: requireText(raw.preflight_condition_id, 'preflight condition'),
            keepOutcomeSetId: requireText(raw.preflight_keep_outcome_set_id, 'preflight keep set'),
            lockOutcomeSetId: requireText(raw.preflight_lock_outcome_set_id, 'preflight lock set'),
            amountSubunits: requireInteger(
              raw.preflight_amount_subunits,
              'preflight amountSubunits',
            ),
          }
    state.orders[orderId] = {
      orderId,
      marketId: requireText(raw.market_id, 'order market'),
      ...(raw.token_side === null ? {} : { tokenSide: requireTokenSide(raw.token_side) }),
      ...(raw.side === null ? {} : { side: requireOrderSide(raw.side) }),
      ...(raw.price_subunits === null
        ? {}
        : { priceSubunits: requireInteger(raw.price_subunits, 'order price') }),
      ...(raw.amount_subunits === null
        ? {}
        : { amountSubunits: requireInteger(raw.amount_subunits, 'order amount') }),
      status: requireText(raw.status, 'order status'),
      ...(raw.ephemeral_pubkey === null
        ? {}
        : { ephemeralPubkey: requireText(raw.ephemeral_pubkey, 'order ephemeral pubkey') }),
      ...(raw.client_order_id === null
        ? {}
        : { clientOrderId: requireText(raw.client_order_id, 'client order id') }),
      ...(preflight === undefined ? {} : { preflightSplit: preflight }),
      baseAsset: requireSatBaseAsset(raw.base_asset, 'order base asset'),
      divisibility: normalizeMarketDivisibility(
        requireInteger(raw.divisibility, 'order divisibility'),
        'sat',
      ),
      tradeIds,
      ...(raw.engine_status_present === 1
        ? { engineStatus: decodeArtifact(raw.engine_status_body, 'engine status') }
        : {}),
      createdAt: timestampToIso(raw.created_at_ms, 'order created time'),
      updatedAt: timestampToIso(raw.updated_at_ms, 'order updated time'),
    }
  }
  for (const raw of database
    .prepare('SELECT * FROM daemon_swaps WHERE scope_id = ?')
    .all(scopeId) as Array<Record<string, unknown>>) {
    const tradeId = requireText(raw.trade_id, 'swap trade id')
    state.swaps[tradeId] = decodeSwap(database, scopeId, raw)
  }
  return state
}

function writeStateToDatabase(database: DatabaseSync, state: DaemonState): void {
  const scopeId = readScopeId(database)
  const priorTargetArtifactIds = collectTargetArtifactIds(database, scopeId)
  database.prepare('DELETE FROM target_proof_operations WHERE scope_id = ?').run(scopeId)
  database.prepare('DELETE FROM target_wallet_proofs WHERE scope_id = ?').run(scopeId)
  database.prepare('DELETE FROM target_keyset_counters WHERE scope_id = ?').run(scopeId)
  database
    .prepare(
      `INSERT INTO target_state_metadata (scope_id, schema_version) VALUES (?, 1)
       ON CONFLICT(scope_id) DO NOTHING`,
    )
    .run(scopeId)

  for (const proof of state.wallet.proofs) insertWalletProof(database, scopeId, proof)
  const now = Date.now()
  for (const [keysetId, nextCounter] of Object.entries(state.wallet.keysetCounters)) {
    database
      .prepare(
        `INSERT INTO target_keyset_counters (
           scope_id, keyset_id, next_counter, updated_at_ms
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(scopeId, keysetId, nextCounter, now)
  }
  for (const operation of Object.values(state.proofOperations)) {
    insertProofOperation(database, scopeId, operation)
  }
  for (const order of Object.values(state.orders)) {
    database
      .prepare('DELETE FROM daemon_order_trades WHERE scope_id = ? AND order_id = ?')
      .run(scopeId, order.orderId)
    insertOrder(database, scopeId, order)
  }
  for (const swap of Object.values(state.swaps)) insertSwap(database, scopeId, swap)
  deleteUnreferencedMissingSwaps(database, scopeId, new Set(Object.keys(state.swaps)))
  deleteUnreferencedMissingOrders(database, scopeId, new Set(Object.keys(state.orders)))
  deleteGloballyUnreferencedArtifacts(database, scopeId, priorTargetArtifactIds)
}

function insertWalletProof(
  database: DatabaseSync,
  scopeId: string,
  record: StoredProofRecord,
): void {
  const proof = normalizeCashuProofRecord(record.proof)
  const body = encodeArtifact(proof)
  const proofId = createHash('sha256')
    .update(scopeId)
    .update('\0')
    .update(record.mintUrl)
    .update('\0')
    .update(proof.secret)
    .digest('hex')
  const asset = normalizeProofAsset(record.asset)
  const timestamps = monotonicTimestamps(
    isoToTimestamp(record.createdAt, 'proof created time'),
    isoToTimestamp(record.updatedAt, 'proof updated time'),
  )
  database
    .prepare(
      `INSERT INTO target_wallet_proofs (
         proof_id, scope_id, normalized_mint, unit, keyset_id, amount, secret,
         signature, proof_body, state, reserved_by, asset_kind, condition_id,
         outcome_set_id, base_asset, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      proofId,
      scopeId,
      record.mintUrl,
      asset.unit,
      requireProofKeysetId(proof.id),
      amountToNumber(proof.amount),
      proof.secret,
      proof.C,
      body,
      record.state,
      record.reservedBy ?? null,
      asset.kind === 'Outcome' ? 'outcome' : asset.kind,
      asset.kind === 'Outcome' ? asset.conditionId : null,
      asset.kind === 'Outcome' ? asset.outcomeSetId : null,
      normalizeProofAssetBaseAsset(asset),
      timestamps.createdAt,
      timestamps.updatedAt,
    )
}

function insertProofOperation(
  database: DatabaseSync,
  scopeId: string,
  operation: ProofOperationRecord,
): void {
  const requestId = putArtifact(database, scopeId, 'exact-request', {
    inputs: operation.inputs.map(normalizeCashuProofRecord),
    metadata: operation.metadata,
  })
  const outputId = putArtifact(database, scopeId, 'output-plan', operation.outputs)
  const resultId =
    operation.resultProofs === undefined
      ? null
      : putArtifact(database, scopeId, 'exact-result', operation.resultProofs)
  const resultProofsDigest = persistedResultProofsDigest(operation)
  const inputAmount = operation.inputs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)
  const timestamps = monotonicTimestamps(operation.createdAt, operation.updatedAt)
  database
    .prepare(
      `INSERT INTO target_proof_operations (
         operation_id, scope_id, kind, state, normalized_mint,
         request_artifact_id, output_artifact_id, result_artifact_id, result_proofs_digest,
         input_count, input_amount, last_error, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      operation.operationId,
      scopeId,
      operation.kind,
      operation.state === 'Failed' ? 'failed' : operation.state,
      operation.mintUrl,
      requestId,
      outputId,
      resultId,
      resultProofsDigest,
      operation.inputs.length,
      inputAmount,
      operation.lastError ?? null,
      timestamps.createdAt,
      timestamps.updatedAt,
    )
}

function persistedResultProofsDigest(operation: ProofOperationRecord): string | null {
  const isCompletedCtf =
    (operation.kind === 'ctf-split' || operation.kind === 'ctf-merge') &&
    operation.state === 'completed'
  if (!isCompletedCtf) {
    if (operation.resultProofsDigest !== undefined) {
      throw new Error('non-completed CTF operation has an unexpected result authority digest')
    }
    return null
  }
  if (operation.resultProofs === undefined) {
    throw new Error('completed CTF operation is missing result proofs')
  }
  const computed = completedProofAuthorityDigest(operation.resultProofs as Record<string, Proof[]>)
  if (operation.resultProofsDigest !== computed) {
    throw new Error(
      `completed CTF operation result authority digest does not match result proofs (${operation.resultProofsDigest ?? 'missing'} != ${computed})`,
    )
  }
  return computed
}

function insertOrder(database: DatabaseSync, scopeId: string, order: LocalOrderRecord): void {
  const preflight = order.preflightSplit
  const hasEngineStatus = Object.hasOwn(order, 'engineStatus') && order.engineStatus !== undefined
  const timestamps = monotonicTimestamps(
    isoToTimestamp(order.createdAt, 'order created time'),
    isoToTimestamp(order.updatedAt, 'order updated time'),
  )
  database
    .prepare(
      `INSERT INTO daemon_orders (
         order_id, scope_id, market_id, token_side, side, price_subunits,
         amount_subunits, status, revision, ephemeral_pubkey, client_order_id,
         preflight_reservation_id, preflight_condition_id,
         preflight_keep_outcome_set_id, preflight_lock_outcome_set_id,
         preflight_amount_subunits, base_asset, divisibility,
         engine_status_present, engine_status_body, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         market_id = excluded.market_id,
         token_side = excluded.token_side,
         side = excluded.side,
         price_subunits = excluded.price_subunits,
         amount_subunits = excluded.amount_subunits,
         status = excluded.status,
         revision = daemon_orders.revision + 1,
         ephemeral_pubkey = excluded.ephemeral_pubkey,
         client_order_id = excluded.client_order_id,
         preflight_reservation_id = excluded.preflight_reservation_id,
         preflight_condition_id = excluded.preflight_condition_id,
         preflight_keep_outcome_set_id = excluded.preflight_keep_outcome_set_id,
         preflight_lock_outcome_set_id = excluded.preflight_lock_outcome_set_id,
         preflight_amount_subunits = excluded.preflight_amount_subunits,
         base_asset = excluded.base_asset,
         divisibility = excluded.divisibility,
         engine_status_present = excluded.engine_status_present,
         engine_status_body = excluded.engine_status_body,
         updated_at_ms = MAX(excluded.updated_at_ms, daemon_orders.created_at_ms)
       WHERE daemon_orders.scope_id = excluded.scope_id`,
    )
    .run(
      order.orderId,
      scopeId,
      order.marketId,
      order.tokenSide ?? null,
      order.side ?? null,
      order.priceSubunits ?? null,
      order.amountSubunits ?? null,
      order.status,
      order.ephemeralPubkey ?? null,
      order.clientOrderId ?? null,
      preflight?.reservationId ?? null,
      preflight?.conditionId ?? null,
      preflight?.keepOutcomeSetId ?? null,
      preflight?.lockOutcomeSetId ?? null,
      preflight?.amountSubunits ?? null,
      order.baseAsset ?? null,
      order.divisibility ?? null,
      hasEngineStatus ? 1 : 0,
      hasEngineStatus ? encodeArtifact(order.engineStatus) : null,
      timestamps.createdAt,
      timestamps.updatedAt,
    )
  order.tradeIds.forEach((tradeId, position) => {
    database
      .prepare(
        `INSERT INTO daemon_order_trades (
           scope_id, order_id, position, trade_id
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(scopeId, order.orderId, position, tradeId)
  })
}

function insertSwap(database: DatabaseSync, scopeId: string, swap: LocalSwapRecord): void {
  const artifacts = {
    adaptor: putOptionalArtifact(database, scopeId, 'relay-ciphertext', swap.messages.adaptorPoint),
    sellerCipher: putOptionalArtifact(
      database,
      scopeId,
      'relay-ciphertext',
      swap.messages.lockedProofsSeller,
    ),
    buyerCipher: putOptionalArtifact(
      database,
      scopeId,
      'relay-ciphertext',
      swap.messages.lockedProofsBuyer,
    ),
    buyerProofs: putOptionalArtifact(database, scopeId, 'locked-proofs', swap.buyerLockedProofs),
    adaptorSecret: putOptionalArtifact(
      database,
      scopeId,
      'adaptor-secret',
      swap.sellerAdaptorSecretHex,
    ),
    adaptorPoint: putOptionalArtifact(
      database,
      scopeId,
      'adaptor-point',
      swap.sellerAdaptorPointHex,
    ),
    buyerPreSigs: putOptionalArtifact(
      database,
      scopeId,
      'buyer-pre-signatures',
      swap.buyerPreSigsHex,
    ),
    sellerPreSigs: putOptionalArtifact(
      database,
      scopeId,
      'seller-pre-signatures',
      swap.sellerPreSigsHex,
    ),
    failure: putOptionalArtifact(database, scopeId, 'failure', swap.failure),
  }
  const timestamps = monotonicTimestamps(
    isoToTimestamp(swap.createdAt, 'swap created time'),
    isoToTimestamp(swap.updatedAt, 'swap updated time'),
  )
  database
    .prepare(
      `INSERT INTO daemon_swaps (
         trade_id, scope_id, order_id, market_id, role, counterparty_pubkey,
         seller_locktime, buyer_locktime, fill_amount_sats, fill_amount_subunits,
         outcome_face_amount_sats, outcome_face_amount_subunits,
         quote_payment_sats, quote_payment_subunits, base_asset, divisibility,
         settlement_kind, seller_keep_outcome_set_id, seller_lock_outcome_set_id,
         step, revision, engine_state, adaptor_point_cipher_artifact_id,
         locked_seller_cipher_artifact_id, locked_buyer_cipher_artifact_id,
         buyer_locked_proofs_artifact_id, seller_adaptor_secret_artifact_id,
         seller_adaptor_point_artifact_id, buyer_pre_sigs_artifact_id,
         seller_pre_sigs_artifact_id, failure_artifact_id, error,
         created_at_ms, updated_at_ms
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT(trade_id) DO UPDATE SET
         order_id = excluded.order_id,
         market_id = excluded.market_id,
         role = excluded.role,
         counterparty_pubkey = excluded.counterparty_pubkey,
         seller_locktime = excluded.seller_locktime,
         buyer_locktime = excluded.buyer_locktime,
         fill_amount_sats = excluded.fill_amount_sats,
         fill_amount_subunits = excluded.fill_amount_subunits,
         outcome_face_amount_sats = excluded.outcome_face_amount_sats,
         outcome_face_amount_subunits = excluded.outcome_face_amount_subunits,
         quote_payment_sats = excluded.quote_payment_sats,
         quote_payment_subunits = excluded.quote_payment_subunits,
         base_asset = excluded.base_asset,
         divisibility = excluded.divisibility,
         settlement_kind = excluded.settlement_kind,
         seller_keep_outcome_set_id = excluded.seller_keep_outcome_set_id,
         seller_lock_outcome_set_id = excluded.seller_lock_outcome_set_id,
         step = excluded.step,
         revision = daemon_swaps.revision + 1,
         engine_state = excluded.engine_state,
         adaptor_point_cipher_artifact_id = excluded.adaptor_point_cipher_artifact_id,
         locked_seller_cipher_artifact_id = excluded.locked_seller_cipher_artifact_id,
         locked_buyer_cipher_artifact_id = excluded.locked_buyer_cipher_artifact_id,
         buyer_locked_proofs_artifact_id = excluded.buyer_locked_proofs_artifact_id,
         seller_adaptor_secret_artifact_id = excluded.seller_adaptor_secret_artifact_id,
         seller_adaptor_point_artifact_id = excluded.seller_adaptor_point_artifact_id,
         buyer_pre_sigs_artifact_id = excluded.buyer_pre_sigs_artifact_id,
         seller_pre_sigs_artifact_id = excluded.seller_pre_sigs_artifact_id,
         failure_artifact_id = excluded.failure_artifact_id,
         error = excluded.error,
         updated_at_ms = MAX(excluded.updated_at_ms, daemon_swaps.created_at_ms)
       WHERE daemon_swaps.scope_id = excluded.scope_id`,
    )
    .run(
      swap.tradeId,
      scopeId,
      swap.orderId ?? null,
      swap.marketId ?? null,
      swap.role ?? null,
      swap.counterpartyPubkey ?? null,
      swap.sellerLocktime ?? null,
      swap.buyerLocktime ?? null,
      swap.fillAmountSats ?? null,
      swap.fillAmountSubunits ?? null,
      swap.outcomeFaceAmountSats ?? null,
      swap.outcomeFaceAmountSubunits ?? null,
      swap.quotePaymentSats ?? null,
      swap.quotePaymentSubunits ?? null,
      swap.baseAsset ?? null,
      swap.divisibility ?? null,
      swap.settlementKind ?? null,
      swap.sellerKeepOutcomeSetId ?? null,
      swap.sellerLockOutcomeSetId ?? null,
      swap.step === 'Failed' ? 'failed' : swap.step,
      swap.engineState ?? null,
      artifacts.adaptor,
      artifacts.sellerCipher,
      artifacts.buyerCipher,
      artifacts.buyerProofs,
      artifacts.adaptorSecret,
      artifacts.adaptorPoint,
      artifacts.buyerPreSigs,
      artifacts.sellerPreSigs,
      artifacts.failure,
      swap.error ?? null,
      timestamps.createdAt,
      timestamps.updatedAt,
    )
}

function decodeSwap(
  database: DatabaseSync,
  scopeId: string,
  raw: Record<string, unknown>,
): LocalSwapRecord {
  const optionalArtifact = (column: string): unknown | undefined =>
    raw[column] === null ? undefined : decodeArtifactById(database, scopeId, raw[column])
  return {
    tradeId: requireText(raw.trade_id, 'swap trade id'),
    ...(raw.market_id === null ? {} : { marketId: requireText(raw.market_id, 'swap market') }),
    ...(raw.order_id === null ? {} : { orderId: requireText(raw.order_id, 'swap order') }),
    ...(raw.role === null ? {} : { role: requireSwapRole(raw.role) }),
    ...(raw.counterparty_pubkey === null
      ? {}
      : { counterpartyPubkey: requireText(raw.counterparty_pubkey, 'swap counterparty') }),
    ...(raw.seller_locktime === null
      ? {}
      : { sellerLocktime: requireInteger(raw.seller_locktime, 'seller locktime') }),
    ...(raw.buyer_locktime === null
      ? {}
      : { buyerLocktime: requireInteger(raw.buyer_locktime, 'buyer locktime') }),
    ...(raw.fill_amount_sats === null
      ? {}
      : { fillAmountSats: requireInteger(raw.fill_amount_sats, 'fill sats') }),
    ...(raw.fill_amount_subunits === null
      ? {}
      : { fillAmountSubunits: requireInteger(raw.fill_amount_subunits, 'fill subunits') }),
    ...(raw.outcome_face_amount_sats === null
      ? {}
      : { outcomeFaceAmountSats: requireInteger(raw.outcome_face_amount_sats, 'outcome sats') }),
    ...(raw.outcome_face_amount_subunits === null
      ? {}
      : {
          outcomeFaceAmountSubunits: requireInteger(
            raw.outcome_face_amount_subunits,
            'outcome subunits',
          ),
        }),
    ...(raw.quote_payment_sats === null
      ? {}
      : { quotePaymentSats: requireInteger(raw.quote_payment_sats, 'quote sats') }),
    ...(raw.quote_payment_subunits === null
      ? {}
      : { quotePaymentSubunits: requireInteger(raw.quote_payment_subunits, 'quote subunits') }),
    baseAsset: requireSatBaseAsset(raw.base_asset, 'swap base asset'),
    divisibility: normalizeMarketDivisibility(
      requireInteger(raw.divisibility, 'swap divisibility'),
      'sat',
    ),
    ...(raw.settlement_kind === null
      ? {}
      : { settlementKind: requireText(raw.settlement_kind, 'settlement kind') }),
    ...(raw.seller_keep_outcome_set_id === null
      ? {}
      : { sellerKeepOutcomeSetId: requireText(raw.seller_keep_outcome_set_id, 'seller keep set') }),
    ...(raw.seller_lock_outcome_set_id === null
      ? {}
      : { sellerLockOutcomeSetId: requireText(raw.seller_lock_outcome_set_id, 'seller lock set') }),
    messages: {
      ...(raw.adaptor_point_cipher_artifact_id === null
        ? {}
        : { adaptorPoint: String(optionalArtifact('adaptor_point_cipher_artifact_id')) }),
      ...(raw.locked_seller_cipher_artifact_id === null
        ? {}
        : { lockedProofsSeller: String(optionalArtifact('locked_seller_cipher_artifact_id')) }),
      ...(raw.locked_buyer_cipher_artifact_id === null
        ? {}
        : { lockedProofsBuyer: String(optionalArtifact('locked_buyer_cipher_artifact_id')) }),
    },
    ...(raw.seller_adaptor_secret_artifact_id === null
      ? {}
      : { sellerAdaptorSecretHex: String(optionalArtifact('seller_adaptor_secret_artifact_id')) }),
    ...(raw.seller_adaptor_point_artifact_id === null
      ? {}
      : { sellerAdaptorPointHex: String(optionalArtifact('seller_adaptor_point_artifact_id')) }),
    ...(raw.buyer_pre_sigs_artifact_id === null
      ? {}
      : { buyerPreSigsHex: optionalArtifact('buyer_pre_sigs_artifact_id') as string[] }),
    ...(raw.buyer_locked_proofs_artifact_id === null
      ? {}
      : {
          buyerLockedProofs: (
            optionalArtifact('buyer_locked_proofs_artifact_id') as CashuProofRecord[]
          ).map(normalizeCashuProofRecord),
        }),
    ...(raw.seller_pre_sigs_artifact_id === null
      ? {}
      : { sellerPreSigsHex: optionalArtifact('seller_pre_sigs_artifact_id') as string[] }),
    ...(raw.engine_state === null
      ? {}
      : { engineState: requireText(raw.engine_state, 'engine state') }),
    step: requireSwapStep(raw.step),
    ...(raw.error === null ? {} : { error: requireText(raw.error, 'swap error') }),
    ...(raw.failure_artifact_id === null
      ? {}
      : {
          failure: optionalArtifact('failure_artifact_id') as SwapFailure | PartialLockHeldRecord,
        }),
    createdAt: timestampToIso(raw.created_at_ms, 'swap created time'),
    updatedAt: timestampToIso(raw.updated_at_ms, 'swap updated time'),
  }
}

function readScopeId(database: DatabaseSync): string {
  const row = database
    .prepare('SELECT wallet_scope_id AS scopeId FROM daemon_profile WHERE singleton = 1')
    .get() as { scopeId?: unknown } | undefined
  return requireText(row?.scopeId, 'daemon wallet scope')
}

function putOptionalArtifact(
  database: DatabaseSync,
  scopeId: string,
  kind:
    | 'relay-ciphertext'
    | 'locked-proofs'
    | 'adaptor-secret'
    | 'adaptor-point'
    | 'buyer-pre-signatures'
    | 'seller-pre-signatures'
    | 'failure',
  value: unknown,
): string | null {
  return value === undefined ? null : putArtifact(database, scopeId, kind, value)
}

function putArtifact(
  database: DatabaseSync,
  scopeId: string,
  kind:
    | 'exact-request'
    | 'output-plan'
    | 'exact-result'
    | 'relay-ciphertext'
    | 'locked-proofs'
    | 'adaptor-secret'
    | 'adaptor-point'
    | 'buyer-pre-signatures'
    | 'seller-pre-signatures'
    | 'failure',
  value: unknown,
): string {
  const isText =
    typeof value === 'string' &&
    (kind === 'relay-ciphertext' || kind === 'adaptor-secret' || kind === 'adaptor-point')
  const body = isText ? Buffer.from(value, 'utf8') : encodeArtifact(value)
  const fingerprint = createHash('sha256').update(body).digest('hex')
  const artifactId = createHash('sha256')
    .update(scopeId)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(body)
    .digest('hex')
  database
    .prepare(
      `INSERT INTO custody_artifacts (
         artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
         revision, private_material, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(artifact_id) DO NOTHING`,
    )
    .run(
      artifactId,
      scopeId,
      kind,
      isText ? 'utf8' : 'canonical-json',
      body,
      fingerprint,
      kind === 'relay-ciphertext' ||
        kind === 'locked-proofs' ||
        kind === 'adaptor-secret' ||
        kind === 'buyer-pre-signatures' ||
        kind === 'seller-pre-signatures'
        ? 1
        : 0,
      Date.now(),
    )
  return artifactId
}

function decodeArtifactById(database: DatabaseSync, scopeId: string, artifactId: unknown): unknown {
  const id = requireText(artifactId, 'artifact id')
  const row = database
    .prepare(
      `SELECT encoding, body FROM custody_artifacts
       WHERE scope_id = ? AND artifact_id = ?`,
    )
    .get(scopeId, id) as { encoding?: unknown; body?: unknown } | undefined
  if (row === undefined) throw new Error('target state artifact is missing')
  if (row.encoding === 'utf8')
    return Buffer.from(requireBytes(row.body, 'artifact body')).toString('utf8')
  if (row.encoding !== 'canonical-json')
    throw new Error('target state artifact encoding is invalid')
  return decodeArtifact(row.body, 'target state artifact')
}

function deleteUnreferencedMissingSwaps(
  database: DatabaseSync,
  scopeId: string,
  retainedTradeIds: ReadonlySet<string>,
): void {
  const rows = database
    .prepare('SELECT trade_id FROM daemon_swaps WHERE scope_id = ?')
    .all(scopeId) as Array<Record<string, unknown>>
  for (const row of rows) {
    const tradeId = requireText(row.trade_id, 'swap trade id')
    if (retainedTradeIds.has(tradeId)) continue
    database
      .prepare(
        `DELETE FROM daemon_swaps
         WHERE scope_id = ? AND trade_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM swap_operation_links
             WHERE scope_id = ? AND trade_id = ?
           )`,
      )
      .run(scopeId, tradeId, scopeId, tradeId)
  }
}

function collectTargetArtifactIds(database: DatabaseSync, scopeId: string): Set<string> {
  const artifactIds = new Set<string>()
  const operationRows = database
    .prepare(
      `SELECT request_artifact_id, output_artifact_id, result_artifact_id
       FROM target_proof_operations WHERE scope_id = ?`,
    )
    .all(scopeId) as Array<Record<string, unknown>>
  const swapRows = database
    .prepare(
      `SELECT adaptor_point_cipher_artifact_id, locked_seller_cipher_artifact_id,
        locked_buyer_cipher_artifact_id, buyer_locked_proofs_artifact_id,
        seller_adaptor_secret_artifact_id, seller_adaptor_point_artifact_id,
        buyer_pre_sigs_artifact_id, seller_pre_sigs_artifact_id,
        failure_artifact_id
       FROM daemon_swaps WHERE scope_id = ?`,
    )
    .all(scopeId) as Array<Record<string, unknown>>
  for (const row of [...operationRows, ...swapRows]) {
    for (const value of Object.values(row)) {
      if (typeof value === 'string') artifactIds.add(value)
    }
  }
  return artifactIds
}

function deleteGloballyUnreferencedArtifacts(
  database: DatabaseSync,
  scopeId: string,
  candidates: ReadonlySet<string>,
): void {
  const statement = database.prepare(
    `DELETE FROM custody_artifacts
     WHERE scope_id = ? AND artifact_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM target_proof_operations
         WHERE scope_id = ? AND (
           request_artifact_id = ? OR output_artifact_id = ? OR result_artifact_id = ?
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM custody_operations
         WHERE scope_id = ? AND (
           request_artifact_id = ? OR output_artifact_id = ?
           OR private_artifact_id = ? OR result_artifact_id = ?
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM custody_operation_artifact_links
         WHERE scope_id = ? AND artifact_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM custody_deliveries
         WHERE scope_id = ? AND payload_artifact_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM daemon_swaps
         WHERE scope_id = ? AND (
           adaptor_point_cipher_artifact_id = ?
           OR locked_seller_cipher_artifact_id = ?
           OR locked_buyer_cipher_artifact_id = ?
           OR buyer_locked_proofs_artifact_id = ?
           OR seller_adaptor_secret_artifact_id = ?
           OR seller_adaptor_point_artifact_id = ?
           OR buyer_pre_sigs_artifact_id = ?
           OR seller_pre_sigs_artifact_id = ?
           OR failure_artifact_id = ?
         )
       )`,
  )
  for (const artifactId of candidates) {
    statement.run(
      scopeId,
      artifactId,
      scopeId,
      artifactId,
      artifactId,
      artifactId,
      scopeId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
      scopeId,
      artifactId,
      scopeId,
      artifactId,
      scopeId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
      artifactId,
    )
  }
}

function deleteUnreferencedMissingOrders(
  database: DatabaseSync,
  scopeId: string,
  retainedOrderIds: ReadonlySet<string>,
): void {
  const rows = database
    .prepare('SELECT order_id FROM daemon_orders WHERE scope_id = ?')
    .all(scopeId) as Array<Record<string, unknown>>
  for (const row of rows) {
    const orderId = requireText(row.order_id, 'order id')
    if (retainedOrderIds.has(orderId)) continue
    database
      .prepare('DELETE FROM daemon_order_trades WHERE scope_id = ? AND order_id = ?')
      .run(scopeId, orderId)
    database
      .prepare(
        `DELETE FROM daemon_orders
         WHERE scope_id = ? AND order_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM order_collateral_pins
             WHERE scope_id = ? AND order_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM daemon_swaps
             WHERE scope_id = ? AND order_id = ?
           )`,
      )
      .run(scopeId, orderId, scopeId, orderId, scopeId, orderId)
  }
}

function normalizeState(value: unknown): DaemonState {
  if (!isRecord(value) || value.version !== 1) return emptyDaemonState()
  return {
    version: 1,
    wallet:
      isRecord(value.wallet) && Array.isArray(value.wallet.proofs)
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
    orders: isRecord(value.orders) ? normalizeOrders(value.orders) : {},
    swaps: isRecord(value.swaps) ? normalizeSwaps(value.swaps) : {},
  }
}

function normalizeProofAsset(asset: StoredProofAsset | undefined): StoredProofAsset {
  if (isOutcomeProofAsset(asset)) {
    return {
      kind: 'Outcome',
      conditionId: asset.conditionId,
      outcomeSetId: asset.outcomeSetId,
      baseAsset: normalizeProofAssetBaseAsset(asset),
      unit: 'msat',
    }
  }

  return {
    kind: 'sats',
    baseAsset: normalizeProofAssetBaseAsset(asset),
    unit: normalizeProofAssetUnit(asset),
  }
}

function isOutcomeProofAsset(
  asset: StoredProofAsset | undefined,
): asset is Extract<StoredProofAsset, { kind: 'Outcome' }> {
  return asset?.kind === 'Outcome' || (asset as { kind?: unknown } | undefined)?.kind === 'outcome'
}

function normalizeProofAssetBaseAsset(asset: StoredProofAsset | undefined): 'sat' {
  return normalizeMarketBaseAsset(asset?.baseAsset)
}

function normalizeProofAssetUnit(asset: StoredProofAsset | undefined): 'sat' | 'msat' {
  if (asset?.unit === 'sat' || asset?.unit === 'msat') return asset.unit
  throw new Error('proof asset unit must be exactly sat or msat')
}

function normalizeCounterMap(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0,
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
  if (!isProofOperationKind(kind) || !isProofOperationState(state) || typeof mintUrl !== 'string') {
    return null
  }
  return [
    operationId,
    {
      operationId: typeof raw.operationId === 'string' ? raw.operationId : operationId,
      kind,
      state,
      mintUrl,
      inputs: Array.isArray(raw.inputs)
        ? (raw.inputs as CashuProofRecord[]).map(normalizeCashuProofRecord)
        : [],
      outputs: isRecord(raw.outputs) ? (raw.outputs as Record<string, StoredOutputData[]>) : {},
      metadata: isRecord(raw.metadata) ? (raw.metadata as Record<string, unknown>) : {},
      resultProofs: isRecord(raw.resultProofs)
        ? normalizeProofRecordGroups(raw.resultProofs as Record<string, CashuProofRecord[]>)
        : undefined,
      resultProofsDigest: normalizeOptionalSha256(raw.resultProofsDigest),
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    },
  ]
}

function normalizeOptionalSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('proof operation result authority digest must be canonical SHA-256 hex')
  }
  return value
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
    throw new Error(`Proof operation ${input.operationId} does not match this swap step`)
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
          ...(normalizeOrderSide(order.side) ? { side: normalizeOrderSide(order.side) } : {}),
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
    Object.entries(groups).map(([label, proofs]) => [label, proofs.map(normalizeCashuProofRecord)]),
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
        isRecord(submission) ? submission.tradeId : undefined,
      )
    : []
  const topLevelTradeId = typeof value.tradeId === 'string' && value.tradeId ? [value.tradeId] : []
  return [...fillTradeIds, ...pendingTradeIds, ...topLevelTradeId].filter(
    (tradeId): tradeId is string => typeof tradeId === 'string' && tradeId.length > 0,
  )
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
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toJsonSafe(nested)]))
}

function isProofOperationState(value: unknown): value is ProofOperationState {
  return value === 'prepared' || value === 'completed' || value === 'Failed'
}

function normalizeProofOperationState(value: unknown): unknown {
  return value === 'failed' ? 'Failed' : value
}

function requireProofOperationState(value: unknown): ProofOperationState {
  const normalized = normalizeProofOperationState(value)
  if (!isProofOperationState(normalized)) {
    throw new Error('proof operation state is invalid')
  }
  return normalized
}

function requireProofOperationKind(value: unknown): ProofOperationKind {
  if (!isProofOperationKind(value)) throw new Error('proof operation kind is invalid')
  return value
}

function requireProofState(value: unknown): StoredProofRecord['state'] {
  if (value === 'available' || value === 'reserved' || value === 'locked') return value
  throw new Error('wallet proof state is invalid')
}

function requireTokenSide(value: unknown): NonNullable<LocalOrderRecord['tokenSide']> {
  if (value === 'Outcome' || value === 'Complement') return value
  throw new Error('order token side is invalid')
}

function requireOrderSide(value: unknown): NonNullable<LocalOrderRecord['side']> {
  if (value === 'Buy' || value === 'Sell') return value
  throw new Error('order side is invalid')
}

function requireSwapRole(value: unknown): NonNullable<LocalSwapRecord['role']> {
  if (value === 'seller' || value === 'buyer') return value
  throw new Error('swap role is invalid')
}

function requireSwapStep(value: unknown): LocalSwapRecord['step'] {
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
  )
    return value
  throw new Error('swap step is invalid')
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireSatBaseAsset(value: unknown, label: string): 'sat' {
  if (value !== 'sat') throw new Error(`${label} must be exactly sat`)
  return value
}

function requireCashuUnit(value: unknown, label: string): 'sat' | 'msat' {
  if (value !== 'sat' && value !== 'msat') {
    throw new Error(`${label} must be exactly sat or msat`)
  }
  return value
}

function requireProofKeysetId(value: unknown): string {
  return requireText(value, 'proof keyset id')
}

function requireMsatUnit(value: unknown, label: string): 'msat' {
  if (value !== 'msat') throw new Error(`${label} must be exactly msat`)
  return value
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`)
  return value
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value
}

function requireBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is invalid`)
  return value
}

function encodeArtifact(value: unknown): Uint8Array {
  const encoded = JSON.stringify(toJsonSafe(value))
  if (encoded === undefined) throw new Error('target state artifact is not JSON encodable')
  return Buffer.from(encoded, 'utf8')
}

function decodeArtifact(value: unknown, label: string): unknown {
  const bytes = requireBytes(value, label)
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch {
    throw new Error(`${label} is invalid`)
  }
}

function isoToTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`${label} is invalid`)
  }
  return timestamp
}

function monotonicTimestamps(
  createdAt: number,
  updatedAt: number,
): { createdAt: number; updatedAt: number } {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('created timestamp is invalid')
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('updated timestamp is invalid')
  }
  return {
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
  }
}

function timestampToIso(value: unknown, label: string): string {
  return new Date(requireInteger(value, label)).toISOString()
}

function findOrderForTradeCreated(
  state: DaemonState,
  payload: DaemonTradeCreatedPayload,
  ownEphemeralPubkey: string | undefined,
): { orderId: string; marketId: string; ownEphemeralPubkey: string } | null {
  const exactMatches: Array<{
    orderId: string
    marketId: string
    ownEphemeralPubkey: string
  }> = []
  const fallbackMatches: Array<{
    orderId: string
    marketId: string
    ownEphemeralPubkey: string
  }> = []
  let exactOrderCount = 0
  for (const order of Object.values(state.orders)) {
    const matchedEphemeralPubkey = ownEphemeralPubkey ?? order.ephemeralPubkey
    if (order.tradeIds.includes(payload.tradeId)) {
      exactOrderCount += 1
      if (!matchedEphemeralPubkey) continue
      if (
        !isOrderEphemeralForTrade(matchedEphemeralPubkey, payload) ||
        !orderMarketMatchesTradeCreated(order, payload, matchedEphemeralPubkey)
      ) {
        throw new Error(
          `TradeCreated ${payload.tradeId} exact local order has an invalid market path`,
        )
      }
      exactMatches.push({
        orderId: order.orderId,
        marketId: order.marketId,
        ownEphemeralPubkey: matchedEphemeralPubkey,
      })
      continue
    }
    if (
      order.ephemeralPubkey &&
      isOrderEphemeralForTrade(order.ephemeralPubkey, payload) &&
      orderMarketMatchesTradeCreated(order, payload, order.ephemeralPubkey)
    ) {
      fallbackMatches.push({
        orderId: order.orderId,
        marketId: order.marketId,
        ownEphemeralPubkey: order.ephemeralPubkey,
      })
    }
  }
  if (exactOrderCount > 1) {
    throw new Error(`TradeCreated ${payload.tradeId} matches multiple exact local orders`)
  }
  if (exactOrderCount === 1 && exactMatches.length === 0) {
    throw new Error(`TradeCreated ${payload.tradeId} exact local order has no protocol key`)
  }
  if (exactMatches.length === 1) return exactMatches[0]
  if (fallbackMatches.length > 1) {
    throw new Error(`TradeCreated ${payload.tradeId} has ambiguous local order fallback`)
  }
  return fallbackMatches[0] ?? null
}

function isOrderEphemeralForTrade(
  orderEphemeralPubkey: string,
  payload: DaemonTradeCreatedPayload,
): boolean {
  return (
    orderEphemeralPubkey === payload.sellerPubkey || orderEphemeralPubkey === payload.buyerPubkey
  )
}

function orderMarketMatchesTradeCreated(
  order: LocalOrderRecord,
  payload: DaemonTradeCreatedPayload,
  authoritativeEphemeralPubkey: string,
): boolean {
  if (payload.settlementKind !== 'Mint') {
    return order.marketId === payload.marketId
  }
  const role = orderRoleForTradeCreated(authoritativeEphemeralPubkey, payload)
  if (!role) return false
  const conditionId = payload.marketId.split('-', 1)[0]
  const sellerKeepMarketId = payload.sellerKeepOutcomeSetId
    ? `${conditionId}-${payload.sellerKeepOutcomeSetId}`
    : null
  const sellerLockMarketId = payload.sellerLockOutcomeSetId
    ? `${conditionId}-${payload.sellerLockOutcomeSetId}`
    : payload.marketId
  if (role === 'seller') return order.marketId === sellerKeepMarketId
  if (order.tokenSide === 'Complement') {
    return order.marketId === sellerKeepMarketId
  }
  return order.marketId === sellerLockMarketId
}

function orderRoleForTradeCreated(
  authoritativeEphemeralPubkey: string,
  payload: DaemonTradeCreatedPayload,
): 'seller' | 'buyer' | null {
  if (authoritativeEphemeralPubkey === payload.sellerPubkey) return 'seller'
  if (authoritativeEphemeralPubkey === payload.buyerPubkey) return 'buyer'
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
