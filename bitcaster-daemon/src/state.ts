import { chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
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
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  reduceDurableTradeSession,
  validateDurableProofOperationLink,
  validateDurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import type {
  PartialLockHeldRecord,
  SwapFailure,
} from '@bitcaster-market/client-sdk/swapFailure'
import {
  ensureDaemonStateTable,
  ensureProfileDir,
  openProfileDatabase,
  profileDatabaseExists,
  profileDatabasePath,
  profileInitializationIsComplete,
  readProfile,
  tableExists,
} from './profile.ts'
import { readSecrets } from './secrets.ts'
import { validateDaemonDurableOperationBinding } from './durableTradeBinding.ts'

export interface CashuProofRecord {
  id?: string
  amount: unknown
  secret: string
  C: string
  witness?: unknown
  dleq?: unknown
  /** Retained CTF input metadata; it is part of the exact persisted request. */
  conditionId?: string
  outcomeCollection?: string
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
  ephemeralPubkey?: string
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
  /** SDK-owned durable recovery envelopes; private keys live in the same SQLite profile database. */
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
  return profileDatabasePath()
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
let stateWriteFaultHookForTest: ((stage: 'before-commit' | 'after-commit') => void) | undefined

/** Test-only fault seam for proving the SQLite transaction crash boundary. */
export function setStateWriteFaultHookForTest(
  hook: ((stage: 'before-commit' | 'after-commit') => void) | undefined,
): void {
  stateWriteFaultHookForTest = hook
}

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
  throw new Error('daemon SQLite state is not initialized; run bitcaster-daemon init')
}

/** Creates the sole fresh state row during explicit `init`; normal recovery never recreates it. */
export async function initializeState(): Promise<DaemonState> {
  return withStateUpdateLock(async () => {
    await ensureProfileDir()
    const database = openStateDatabase()
    try {
      if (process.platform !== 'win32') await chmod(statePath(), 0o600)
      const hadStateTable = stateTableExists(database)
      if (!hadStateTable && profileInitializationIsComplete(database)) {
        throw new Error('daemon SQLite state schema is missing')
      }
      ensureDaemonStateTable(database)
      const existing = readStoredStateFromDatabase(database)
      if (existing) return existing
      if (hadStateTable) {
        throw new Error('daemon SQLite state row is missing')
      }
      const fresh = emptyDaemonState()
      database.exec('BEGIN IMMEDIATE')
      try {
        writeStoredStateToDatabase(database, fresh)
        database.exec('COMMIT')
        return fresh
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // The transaction may already have completed.
        }
        throw error
      }
    } finally {
      database.close()
    }
  })
}

export async function readState(): Promise<DaemonState | null> {
  if (!(await profileDatabaseExists())) return null
  const database = openStateDatabase()
  try {
    if (!stateTableExists(database)) {
      throw new Error('daemon SQLite state schema is missing')
    }
    const state = readStoredStateFromDatabase(database)
    if (!state) throw new Error('daemon SQLite state row is missing')
    return state
  } finally {
    database.close()
  }
}

export async function writeState(state: DaemonState): Promise<void> {
  await ensureProfileDir()
  const database = openStateDatabase()
  try {
    if (process.platform !== 'win32') await chmod(statePath(), 0o600)
    // This exported helper is the explicit bootstrap/test seeding surface.
    // Runtime state transitions use updateState(), which never creates a
    // missing schema or singleton row after initialization.
    ensureDaemonStateTable(database)
    database.exec('BEGIN IMMEDIATE')
    try {
      writeStoredStateToDatabase(database, state)
      stateWriteFaultHookForTest?.('before-commit')
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The transaction may have committed before an after-commit fault.
      }
      throw error
    }
    stateWriteFaultHookForTest?.('after-commit')
  } finally {
    database.close()
  }
}

function openStateDatabase(): DatabaseSync {
  return openProfileDatabase()
}

function stateTableExists(database: DatabaseSync): boolean {
  return tableExists(database, 'daemon_state')
}

function decodeStoredState(payload: string): DaemonState {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    throw new Error('daemon SQLite state payload is corrupt')
  }
  return decodeDaemonState(parsed)
}

function readStoredStateFromDatabase(database: DatabaseSync): DaemonState | null {
  const row = database.prepare(
    'SELECT schema_version, payload FROM daemon_state WHERE singleton = 1',
  ).get() as { schema_version?: unknown; payload?: unknown } | undefined
  if (!row) return null
  if (row.schema_version !== 1 || typeof row.payload !== 'string') {
    throw new Error('daemon SQLite state row is invalid')
  }
  return decodeStoredState(row.payload)
}

/** Runs inside bootstrap's replacement transaction to protect live custody. */
export function assertStoredDaemonStateIsEmptyForIdentityReplacement(
  database: DatabaseSync,
): void {
  const state = readStoredStateFromDatabase(database)
  if (!state) throw new Error('daemon SQLite state row is missing')
  if (
    state.wallet.proofs.length !== 0 ||
    Object.keys(state.wallet.keysetCounters).length !== 0 ||
    Object.keys(state.proofOperations).length !== 0 ||
    Object.keys(state.durableTradeSessions).length !== 0 ||
    Object.keys(state.orders).length !== 0 ||
    Object.keys(state.swaps).length !== 0
  ) {
    throw new Error('daemon state is not empty; refusing to replace wallet/Nostr keys')
  }
}

function writeStoredStateToDatabase(database: DatabaseSync, state: DaemonState): void {
  const payload = encodeDaemonStateForStorage(state)
  database.prepare(
    `INSERT INTO daemon_state (singleton, schema_version, payload)
     VALUES (1, 1, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       schema_version = excluded.schema_version,
       payload = excluded.payload`,
  ).run(payload)
}

/** Returns a validated state payload for the atomic profile bootstrap transaction. */
export function encodeDaemonStateForStorage(state: DaemonState): string {
  return JSON.stringify(decodeDaemonState(toJsonSafe(state)))
}

export async function updateState<T>(
  update: (state: DaemonState, now: string) => T,
): Promise<T> {
  return withStateUpdateLock(async () => {
    await ensureProfileDir()
    const database = openStateDatabase()
    try {
      if (process.platform !== 'win32') await chmod(statePath(), 0o600)
      database.exec('BEGIN IMMEDIATE')
      try {
        const state = readStoredStateFromDatabase(database)
        if (!state) throw new Error('daemon SQLite state row is missing')
        const result = update(state, new Date().toISOString())
        writeStoredStateToDatabase(database, state)
        stateWriteFaultHookForTest?.('before-commit')
        database.exec('COMMIT')
        stateWriteFaultHookForTest?.('after-commit')
        return result
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // The transaction may have committed before an after-commit fault.
        }
        throw error
      }
    } finally {
      database.close()
    }
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
  return updateState((state) => {
    const existing = state.proofOperations[input.operationId]
    if (existing) {
      assertCompatibleProofOperation(existing, input)
      return existing
    }
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
      if (!session) {
        throw new Error(`Proof operation ${input.operationId} has no durable trade session`)
      }
      const bindingError = validateDaemonDurableOperationBinding({
        session,
        record,
        operation: link,
        allowUnlinkedSessionOperation: true,
      })
      if (bindingError || link.state !== 'prepared') {
        throw new Error(`Proof operation ${input.operationId} has an invalid durable trade binding: ${bindingError ?? 'state'}`)
      }
      const expected = session.expectedProofOperations ?? []
      if (!expected.some((item) => item.operationId === link.operationId)) {
        expected.push({
          operationId: link.operationId,
          operationKey: link.operationKey ?? input.operationId,
          stage: link.stage,
          ...(link.kind === undefined ? {} : { kind: link.kind }),
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
    const durableTradeRecovery = existing.durableTradeRecovery
      ? advanceDurableProofOperationWithSession(
        state,
        existing.durableTradeRecovery,
        'reconciled',
      )
      : undefined
    const updated: ProofOperationRecord = {
      ...existing,
      state: 'completed',
      durableTradeRecovery,
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
    const durableTradeRecovery = existing.durableTradeRecovery
      ? advanceDurableProofOperationWithSession(
        state,
        existing.durableTradeRecovery,
        'mint-submitted',
      )
      : undefined
    const updated: ProofOperationRecord = {
      ...existing,
      state: 'mint-submitted',
      durableTradeRecovery,
      lastError: null,
      updatedAt: Date.now(),
    }
    state.proofOperations[operationId] = updated
    return updated
  })
}

/**
 * A durable swap session and its proof ledger live in the same daemon state
 * file. Keep their state projections in one write so a crash cannot leave a
 * completed mint operation paired with an older SDK recovery session.
 */
function advanceDurableProofOperationWithSession(
  state: DaemonState,
  link: DurableTradeProofOperationLink,
  transition: 'mint-submitted' | 'reconciled',
): DurableTradeProofOperationLink {
  const session = state.durableTradeSessions[link.tradeId]
  if (!session) {
    throw new Error(`durable proof operation ${link.operationId} has no session`)
  }
  const sessionError = validateDurableTradeSession(session)
  const linkError = validateDurableProofOperationLink(link)
  if (sessionError || linkError) {
    throw new Error(`invalid durable trade state: ${sessionError ?? linkError}`)
  }
  const sessionLink = session.proofOperations.find(
    (candidate) => candidate.operationId === link.operationId,
  )
  if (!sessionLink || !sameDurableTradeOperationIdentity(sessionLink, link)) {
    throw new Error(`durable proof operation ${link.operationId} is not bound to its session`)
  }

  switch (transition) {
    case 'mint-submitted':
      if (sessionLink.state === 'mint-submitted' && link.state === 'mint-submitted') {
        return sessionLink
      }
      if (sessionLink.state !== 'prepared' ||
        (link.state !== 'prepared' && link.state !== 'mint-submitted')) {
        throw new Error(`durable proof operation ${link.operationId} cannot advance to mint-submitted`)
      }
      break
    case 'reconciled':
      if (sessionLink.state === 'reconciled' && link.state === 'reconciled') {
        return sessionLink
      }
      if ((sessionLink.state !== 'prepared' && sessionLink.state !== 'mint-submitted') ||
        sessionLink.state !== link.state) {
        throw new Error(`durable proof operation ${link.operationId} cannot advance to reconciled`)
      }
      break
  }

  const nextSession = reduceDurableTradeSession(
    session,
    transition === 'mint-submitted'
      ? { kind: 'mint-submitted', operationId: link.operationId }
      : { kind: 'proof-operation-reconciled', operationId: link.operationId },
  )
  const nextLink = nextSession.proofOperations.find(
    (candidate) => candidate.operationId === link.operationId,
  )
  if (!nextLink || nextLink.state !== transition ||
    !sameDurableTradeOperationIdentity(nextLink, link)) {
    throw new Error(`durable proof operation ${link.operationId} did not advance with its session`)
  }
  state.durableTradeSessions[link.tradeId] = nextSession
  return nextLink
}

function sameDurableTradeOperationIdentity(
  left: DurableTradeProofOperationLink,
  right: DurableTradeProofOperationLink,
): boolean {
  return left.operationId === right.operationId &&
    left.operationKey === right.operationKey &&
    left.tradeId === right.tradeId &&
    left.role === right.role &&
    left.stage === right.stage &&
    left.kind === right.kind
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
          schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
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
  if (!session) {
    throw new Error('Cannot journal protected swap ciphertext without a durable trade session')
  }
  const sessionError = validateDurableTradeSession(session)
  if (sessionError) {
    throw new Error(`Cannot journal protected swap ciphertext: ${sessionError}`)
  }
  // settlement-complete carries no private cipher and is not part of the
  // SDK outbox. It still passed the session validity check above, so a send
  // can never bypass a missing or corrupt recovery authority.
  if (!isSwapCipherMessageType(messageType)) return
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

/**
 * The deployed schema starts fresh. Never normalize, omit, or default a row
 * while reading it: changing a persisted custody record is recovery work, not
 * deserialization. A malformed existing row must stop the daemon before it can
 * select, lock, mint, or send with a replacement proof set.
 */
function decodeDaemonState(value: unknown): DaemonState {
  const root = requireStateRecord(value, 'state payload')
  requireStateFields(root, [
    'version', 'wallet', 'proofOperations', 'durableTradeSessions', 'orders', 'swaps',
  ])
  if (root.version !== 1) throw new Error('daemon SQLite state schema is unsupported')

  const wallet = requireStateRecord(root.wallet, 'state wallet')
  requireStateFields(wallet, ['proofs', 'keysetCounters'])
  if (!Array.isArray(wallet.proofs)) throw new Error('daemon SQLite wallet proofs are invalid')
  const proofOperations = decodeStoredProofOperations(root.proofOperations)
  const durableTradeSessions = decodeDurableTradeSessions(root.durableTradeSessions)

  for (const operation of Object.values(proofOperations)) {
    if (!operation.durableTradeRecovery) continue
    const session = durableTradeSessions[operation.durableTradeRecovery.tradeId]
    if (!session) throw new Error('daemon durable proof operation session is missing')
    const bindingError = validateDaemonDurableOperationBinding({
      session,
      record: operation,
      operation: operation.durableTradeRecovery,
    })
    if (bindingError) throw new Error(`daemon durable proof operation is invalid: ${bindingError}`)
  }

  return {
    version: 1,
    wallet: {
      proofs: wallet.proofs.map((proof) => decodeStoredProofRecord(proof)),
      keysetCounters: decodeCounterMap(wallet.keysetCounters),
    },
    proofOperations,
    durableTradeSessions,
    orders: decodeLocalOrders(root.orders),
    swaps: decodeLocalSwaps(root.swaps),
  }
}

function decodeStoredProofRecord(value: unknown): StoredProofRecord {
  const record = requireStateRecord(value, 'stored proof')
  requireStateFields(record, [
    'proof', 'mintUrl', 'state', 'asset', 'reservedBy', 'createdAt', 'updatedAt',
  ], ['reservedBy'])
  const state = record.state
  if (state !== 'available' && state !== 'reserved' && state !== 'locked') {
    throw new Error('stored proof state is invalid')
  }
  const reservedBy = optionalNonEmptyString(record.reservedBy, 'stored proof reservation')
  return {
    proof: decodeCashuProofRecord(record.proof, 'stored proof'),
    mintUrl: requireNonEmptyString(record.mintUrl, 'stored proof mint'),
    state,
    asset: decodeStoredProofAsset(record.asset),
    ...(reservedBy ? { reservedBy } : {}),
    createdAt: requireNonEmptyString(record.createdAt, 'stored proof created time'),
    updatedAt: requireNonEmptyString(record.updatedAt, 'stored proof updated time'),
  }
}

function decodeStoredProofAsset(value: unknown): StoredProofAsset {
  const asset = requireStateRecord(value, 'stored proof asset')
  if (asset.kind === 'sats') {
    requireStateFields(asset, ['kind', 'baseAsset'], ['baseAsset'])
    return {
      kind: 'sats',
      ...(asset.baseAsset === undefined || asset.baseAsset === null
        ? {}
        : { baseAsset: requireNonEmptyString(asset.baseAsset, 'stored proof base asset') }),
    }
  }
  if (asset.kind === 'Outcome') {
    requireStateFields(asset, ['kind', 'conditionId', 'outcomeSetId', 'baseAsset'], ['baseAsset'])
    return {
      kind: 'Outcome',
      conditionId: requireNonEmptyString(asset.conditionId, 'stored proof condition'),
      outcomeSetId: requireNonEmptyString(asset.outcomeSetId, 'stored proof outcome set'),
      ...(asset.baseAsset === undefined || asset.baseAsset === null
        ? {}
        : { baseAsset: requireNonEmptyString(asset.baseAsset, 'stored proof base asset') }),
    }
  }
  throw new Error('stored proof asset is invalid')
}

function decodeCashuProofRecord(value: unknown, name: string): CashuProofRecord {
  const proof = requireStateRecord(value, name)
  requireStateFields(proof, [
    'id', 'amount', 'secret', 'C', 'witness', 'dleq', 'conditionId', 'outcomeCollection',
  ], [
    'id', 'witness', 'dleq', 'conditionId', 'outcomeCollection',
  ])
  if (typeof proof.amount !== 'number' || !Number.isSafeInteger(proof.amount) || proof.amount < 0) {
    throw new Error(`${name} amount is invalid`)
  }
  return {
    ...(proof.id === undefined ? {} : { id: requireNonEmptyString(proof.id, `${name} keyset`) }),
    amount: proof.amount,
    secret: requireNonEmptyString(proof.secret, `${name} secret`),
    C: requireNonEmptyString(proof.C, `${name} signature`),
    ...(proof.witness === undefined ? {} : { witness: structuredClone(proof.witness) }),
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.conditionId === undefined
      ? {}
      : { conditionId: requireNonEmptyString(proof.conditionId, `${name} condition`) }),
    ...(proof.outcomeCollection === undefined
      ? {}
      : { outcomeCollection: requireNonEmptyString(proof.outcomeCollection, `${name} outcome collection`) }),
  }
}

function decodeCounterMap(value: unknown): Record<string, number> {
  const counters = requireStateRecord(value, 'keyset counters')
  const decoded: Array<[string, number]> = []
  for (const [key, counter] of Object.entries(counters)) {
    if (key.length === 0 || typeof counter !== 'number'
      || !Number.isSafeInteger(counter) || counter < 0) {
      throw new Error('keyset counter is invalid')
    }
    decoded.push([key, counter])
  }
  return Object.fromEntries(decoded)
}

function decodeStoredProofOperations(value: unknown): Record<string, ProofOperationRecord> {
  const operations = requireStateRecord(value, 'proof operations')
  return Object.fromEntries(Object.entries(operations).map(([operationId, raw]) => [
    operationId,
    decodeStoredProofOperation(operationId, raw),
  ]))
}

function decodeStoredProofOperation(
  operationId: string,
  value: unknown,
): ProofOperationRecord {
  const operation = requireStateRecord(value, 'proof operation')
  requireStateFields(operation, [
    'operationId', 'durableTradeRecovery', 'kind', 'state', 'mintUrl', 'inputs', 'outputs',
    'metadata', 'resultProofs', 'lastError', 'createdAt', 'updatedAt',
  ], ['durableTradeRecovery', 'resultProofs', 'lastError'])
  if (operation.operationId !== operationId || operationId.length === 0) {
    throw new Error('proof operation identity is invalid')
  }
  if (!isProofOperationKind(operation.kind) || !isProofOperationState(operation.state)) {
    throw new Error('proof operation lifecycle is invalid')
  }
  if (!Array.isArray(operation.inputs)) throw new Error('proof operation inputs are invalid')
  const outputs = decodeStoredOutputGroups(operation.outputs)
  const resultProofs = operation.resultProofs === undefined
    ? undefined
    : decodeProofRecordGroups(operation.resultProofs)
  const durableTradeRecovery = operation.durableTradeRecovery === undefined
    ? undefined
    : decodeDurableProofOperationLink(operation.durableTradeRecovery)
  return {
    operationId,
    ...(durableTradeRecovery ? { durableTradeRecovery } : {}),
    kind: operation.kind,
    state: operation.state,
    mintUrl: requireNonEmptyString(operation.mintUrl, 'proof operation mint'),
    inputs: operation.inputs.map((proof) => decodeCashuProofRecord(proof, 'proof operation input')),
    outputs,
    metadata: requireStateRecord(operation.metadata, 'proof operation metadata'),
    ...(resultProofs ? { resultProofs } : {}),
    lastError: operation.lastError === undefined || operation.lastError === null
      ? null
      : requireNonEmptyString(operation.lastError, 'proof operation error'),
    createdAt: requireTimestamp(operation.createdAt, 'proof operation creation time'),
    updatedAt: requireTimestamp(operation.updatedAt, 'proof operation update time'),
  }
}

function decodeDurableProofOperationLink(value: unknown): DurableTradeProofOperationLink {
  const operation = value as DurableTradeProofOperationLink
  const error = validateDurableProofOperationLink(operation)
  if (error) throw new Error(`durable proof operation link is invalid: ${error}`)
  return structuredClone(operation)
}

function decodeStoredOutputGroups(value: unknown): Record<string, StoredOutputData[]> {
  const groups = requireStateRecord(value, 'proof operation outputs')
  return Object.fromEntries(Object.entries(groups).map(([label, outputs]) => {
    if (label.length === 0 || !Array.isArray(outputs)) throw new Error('proof operation outputs are invalid')
    return [label, outputs.map((output) => decodeStoredOutputData(output))]
  }))
}

function decodeStoredOutputData(value: unknown): StoredOutputData {
  const output = requireStateRecord(value, 'stored output data')
  requireStateFields(output, ['blindedMessage', 'blindingFactor', 'secret'])
  const blindedMessage = requireStateRecord(output.blindedMessage, 'stored blinded message')
  requireStateFields(blindedMessage, ['amount', 'id', 'B_'])
  if (typeof blindedMessage.amount !== 'number'
    || !Number.isSafeInteger(blindedMessage.amount)
    || blindedMessage.amount < 0) {
    throw new Error('stored blinded message amount is invalid')
  }
  return {
    blindedMessage: {
      amount: blindedMessage.amount,
      id: requireNonEmptyString(blindedMessage.id, 'stored blinded message keyset'),
      B_: requireNonEmptyString(blindedMessage.B_, 'stored blinded message point'),
    },
    blindingFactor: requireNonEmptyString(output.blindingFactor, 'stored output blinding factor'),
    secret: requireNonEmptyString(output.secret, 'stored output secret'),
  }
}

function decodeProofRecordGroups(value: unknown): Record<string, CashuProofRecord[]> {
  const groups = requireStateRecord(value, 'proof operation result proofs')
  return Object.fromEntries(Object.entries(groups).map(([label, proofs]) => {
    if (label.length === 0 || !Array.isArray(proofs)) throw new Error('proof operation result proofs are invalid')
    return [label, proofs.map((proof) => decodeCashuProofRecord(proof, 'proof operation result proof'))]
  }))
}

function decodeDurableTradeSessions(value: unknown): Record<string, DurableTradeSession> {
  const sessions = requireStateRecord(value, 'durable trade sessions')
  return Object.fromEntries(Object.entries(sessions).map(([tradeId, raw]) => {
    const session = raw as DurableTradeSession
    const error = validateDurableTradeSession(session)
    if (error || session.tradeId !== tradeId || tradeId.length === 0) {
      throw new Error(`durable trade session is invalid: ${error ?? 'session identity is invalid'}`)
    }
    return [tradeId, structuredClone(session)]
  }))
}

function decodeLocalOrders(value: unknown): Record<string, LocalOrderRecord> {
  const orders = requireStateRecord(value, 'local orders')
  return Object.fromEntries(Object.entries(orders).map(([orderId, raw]) => {
    const order = requireStateRecord(raw, 'local order')
    requireStateFields(order, [
      'orderId', 'marketId', 'tokenSide', 'side', 'priceSubunits', 'amountSubunits',
      'timeInForce', 'recoveryAttempt', 'status', 'ephemeralPubkey', 'clientOrderId',
      'preflightSplit', 'baseAsset', 'divisibility', 'tradeIds', 'engineStatus',
      'createdAt', 'updatedAt',
    ], [
      'tokenSide', 'side', 'priceSubunits', 'amountSubunits', 'timeInForce', 'recoveryAttempt',
      'ephemeralPubkey', 'clientOrderId', 'preflightSplit', 'baseAsset', 'divisibility',
      'engineStatus',
    ])
    if (order.orderId !== orderId || orderId.length === 0) throw new Error('local order is invalid')
    const tradeIds = decodeStringArray(order.tradeIds, 'local order trades')
    if (new Set(tradeIds).size !== tradeIds.length) throw new Error('local order trades are invalid')
    return [orderId, {
      orderId,
      marketId: requireNonEmptyString(order.marketId, 'local order market'),
      ...(order.tokenSide === undefined ? {} : { tokenSide: decodeTokenSide(order.tokenSide) }),
      ...(order.side === undefined ? {} : { side: decodeOrderSide(order.side) }),
      ...(order.priceSubunits === undefined ? {} : { priceSubunits: requireTimestamp(order.priceSubunits, 'local order price') }),
      ...(order.amountSubunits === undefined ? {} : { amountSubunits: requireTimestamp(order.amountSubunits, 'local order amount') }),
      ...(order.timeInForce === undefined ? {} : { timeInForce: decodeTimeInForce(order.timeInForce) }),
      ...(order.recoveryAttempt === undefined ? {} : { recoveryAttempt: requireTimestamp(order.recoveryAttempt, 'local order recovery attempt') }),
      status: requireNonEmptyString(order.status, 'local order status'),
      ...(order.ephemeralPubkey === undefined ? {} : { ephemeralPubkey: requireNonEmptyString(order.ephemeralPubkey, 'local order ephemeral key') }),
      ...(order.clientOrderId === undefined ? {} : { clientOrderId: requireNonEmptyString(order.clientOrderId, 'local order client id') }),
      ...(order.preflightSplit === undefined ? {} : { preflightSplit: decodePreflightSplit(order.preflightSplit) }),
      ...(order.baseAsset === undefined || order.baseAsset === null
        ? {}
        : { baseAsset: requireNonEmptyString(order.baseAsset, 'local order base asset') }),
      ...(order.divisibility === undefined ? {} : { divisibility: requirePositiveInteger(order.divisibility, 'local order divisibility') }),
      tradeIds,
      ...(order.engineStatus === undefined ? {} : { engineStatus: structuredClone(order.engineStatus) }),
      createdAt: requireNonEmptyString(order.createdAt, 'local order creation time'),
      updatedAt: requireNonEmptyString(order.updatedAt, 'local order update time'),
    } satisfies LocalOrderRecord] as const
  }))
}

function decodeLocalSwaps(value: unknown): Record<string, LocalSwapRecord> {
  const swaps = requireStateRecord(value, 'local swaps')
  return Object.fromEntries(Object.entries(swaps).map(([tradeId, raw]) => {
    const swap = requireStateRecord(raw, 'local swap')
    requireStateFields(swap, [
      'tradeId', 'marketId', 'orderId', 'role', 'counterpartyPubkey', 'sellerLocktime', 'buyerLocktime',
      'fillAmountSats', 'fillAmountSubunits', 'outcomeFaceAmountSats', 'outcomeFaceAmountSubunits',
      'quotePaymentSats', 'baseAsset', 'divisibility', 'quotePaymentSubunits', 'settlementKind',
      'sellerKeepOutcomeSetId', 'sellerLockOutcomeSetId', 'isTaker', 'messages',
      'sellerAdaptorSecretHex', 'sellerAdaptorPointHex', 'buyerPreSigsHex', 'buyerLockedProofs',
      'sellerPreSigsHex', 'engineState', 'failureReason', 'takerRecovery', 'step', 'error', 'failure',
      'createdAt', 'updatedAt',
    ], [
      'marketId', 'orderId', 'role', 'counterpartyPubkey', 'sellerLocktime', 'buyerLocktime',
      'fillAmountSats', 'fillAmountSubunits', 'outcomeFaceAmountSats', 'outcomeFaceAmountSubunits',
      'quotePaymentSats', 'baseAsset', 'divisibility', 'quotePaymentSubunits', 'settlementKind',
      'sellerKeepOutcomeSetId', 'sellerLockOutcomeSetId', 'isTaker', 'sellerAdaptorSecretHex',
      'sellerAdaptorPointHex', 'buyerPreSigsHex', 'buyerLockedProofs', 'sellerPreSigsHex',
      'engineState', 'failureReason', 'takerRecovery', 'error', 'failure',
    ])
    if (swap.tradeId !== tradeId || tradeId.length === 0) throw new Error('local swap is invalid')
    return [tradeId, {
      tradeId,
      ...(swap.marketId === undefined ? {} : { marketId: requireNonEmptyString(swap.marketId, 'local swap market') }),
      ...(swap.orderId === undefined ? {} : { orderId: requireNonEmptyString(swap.orderId, 'local swap order') }),
      ...(swap.role === undefined ? {} : { role: decodeSwapRole(swap.role) }),
      ...(swap.counterpartyPubkey === undefined ? {} : { counterpartyPubkey: requireHex(swap.counterpartyPubkey, 'local swap counterparty key') }),
      ...decodeOptionalSwapIntegers(swap),
      ...(swap.baseAsset === undefined || swap.baseAsset === null
        ? {}
        : { baseAsset: requireNonEmptyString(swap.baseAsset, 'local swap base asset') }),
      ...(swap.settlementKind === undefined || swap.settlementKind === null
        ? {}
        : { settlementKind: decodeSettlementKind(swap.settlementKind) }),
      ...(swap.sellerKeepOutcomeSetId === undefined || swap.sellerKeepOutcomeSetId === null
        ? {}
        : { sellerKeepOutcomeSetId: requireNonEmptyString(swap.sellerKeepOutcomeSetId, 'local swap keep outcome') }),
      ...(swap.sellerLockOutcomeSetId === undefined || swap.sellerLockOutcomeSetId === null
        ? {}
        : { sellerLockOutcomeSetId: requireNonEmptyString(swap.sellerLockOutcomeSetId, 'local swap lock outcome') }),
      ...(swap.isTaker === undefined ? {} : { isTaker: requireBoolean(swap.isTaker, 'local swap taker flag') }),
      messages: decodeSwapMessages(swap.messages),
      ...(swap.sellerAdaptorSecretHex === undefined ? {} : { sellerAdaptorSecretHex: requireHex(swap.sellerAdaptorSecretHex, 'local swap adaptor secret') }),
      ...(swap.sellerAdaptorPointHex === undefined ? {} : { sellerAdaptorPointHex: requireHex(swap.sellerAdaptorPointHex, 'local swap adaptor point') }),
      ...(swap.buyerPreSigsHex === undefined ? {} : { buyerPreSigsHex: decodeHexArray(swap.buyerPreSigsHex, 'local swap buyer pre-signatures') }),
      ...(swap.buyerLockedProofs === undefined ? {} : { buyerLockedProofs: decodeCashuProofArray(swap.buyerLockedProofs, 'local swap buyer locked proofs') }),
      ...(swap.sellerPreSigsHex === undefined ? {} : { sellerPreSigsHex: decodeHexArray(swap.sellerPreSigsHex, 'local swap seller pre-signatures') }),
      ...(swap.engineState === undefined ? {} : { engineState: requireNonEmptyString(swap.engineState, 'local swap engine state') }),
      ...(swap.failureReason === undefined ? {} : { failureReason: requireNonEmptyString(swap.failureReason, 'local swap failure reason') }),
      ...(swap.takerRecovery === undefined ? {} : { takerRecovery: decodeTakerRecovery(swap.takerRecovery) }),
      step: decodeSwapStep(swap.step),
      ...(swap.error === undefined ? {} : { error: requireNonEmptyString(swap.error, 'local swap error') }),
      ...(swap.failure === undefined ? {} : { failure: decodeSwapFailure(swap.failure) }),
      createdAt: requireNonEmptyString(swap.createdAt, 'local swap creation time'),
      updatedAt: requireNonEmptyString(swap.updatedAt, 'local swap update time'),
    } satisfies LocalSwapRecord] as const
  }))
}

function requireStateRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value
}

function requireStateFields(
  record: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) throw new Error(`unknown daemon SQLite state field '${key}'`)
  }
  for (const key of expected) {
    if (!optional.includes(key) && !(key in record)) {
      throw new Error(`missing daemon SQLite state field '${key}'`)
    }
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is invalid`)
  return value
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireNonEmptyString(value, name)
}

function requireTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function isValidSwapStep(value: unknown): value is LocalSwapRecord['step'] {
  return value === 'awaiting-trade-created' || value === 'opened' || value === 'seller-opened'
    || value === 'buyer-responded' || value === 'settling' || value === 'awaiting-confirmation'
    || value === 'confirmed' || value === 'refunded' || value === 'Failed'
}

function decodeTokenSide(value: unknown): NonNullable<LocalOrderRecord['tokenSide']> {
  if (value === 'Outcome' || value === 'Complement') return value
  throw new Error('local order token side is invalid')
}

function decodeOrderSide(value: unknown): NonNullable<LocalOrderRecord['side']> {
  if (value === 'Buy' || value === 'Sell') return value
  throw new Error('local order side is invalid')
}

function decodeTimeInForce(value: unknown): NonNullable<LocalOrderRecord['timeInForce']> {
  if (value === 'FAK' || value === 'FOK' || value === 'GTC') return value
  throw new Error('local order time in force is invalid')
}

function decodePreflightSplit(value: unknown): LocalOrderPreflightSplit {
  const split = requireStateRecord(value, 'local order preflight split')
  requireStateFields(split, [
    'reservationId', 'conditionId', 'keepOutcomeSetId', 'lockOutcomeSetId', 'amountSats',
  ])
  return {
    reservationId: requireNonEmptyString(split.reservationId, 'local order preflight reservation'),
    conditionId: requireNonEmptyString(split.conditionId, 'local order preflight condition'),
    keepOutcomeSetId: requireNonEmptyString(split.keepOutcomeSetId, 'local order preflight keep outcome'),
    lockOutcomeSetId: requireNonEmptyString(split.lockOutcomeSetId, 'local order preflight lock outcome'),
    amountSats: requirePositiveInteger(split.amountSats, 'local order preflight amount'),
  }
}

function decodeSwapRole(value: unknown): NonNullable<LocalSwapRecord['role']> {
  if (value === 'seller' || value === 'buyer') return value
  throw new Error('local swap role is invalid')
}

function decodeSettlementKind(value: unknown): string {
  if (value === 'Mint' || value === 'DirectSwap') return value
  throw new Error('local swap settlement kind is invalid')
}

function decodeSwapStep(value: unknown): LocalSwapRecord['step'] {
  if (!isValidSwapStep(value)) throw new Error('local swap step is invalid')
  return value
}

function decodeOptionalSwapIntegers(swap: Record<string, unknown>): Partial<LocalSwapRecord> {
  const names = [
    'sellerLocktime', 'buyerLocktime', 'fillAmountSats', 'fillAmountSubunits',
    'outcomeFaceAmountSats', 'outcomeFaceAmountSubunits', 'quotePaymentSats',
    'divisibility', 'quotePaymentSubunits',
  ] as const
  const decoded: Partial<LocalSwapRecord> = {}
  for (const name of names) {
    if (swap[name] !== undefined) {
      ;(decoded as Record<string, number>)[name] = name === 'divisibility'
        ? requirePositiveInteger(swap[name], `local swap ${name}`)
        : requireTimestamp(swap[name], `local swap ${name}`)
    }
  }
  return decoded
}

function decodeSwapMessages(value: unknown): LocalSwapRecord['messages'] {
  const messages = requireStateRecord(value, 'local swap messages')
  requireStateFields(messages, ['adaptorPoint', 'lockedProofsSeller', 'lockedProofsBuyer'], [
    'adaptorPoint', 'lockedProofsSeller', 'lockedProofsBuyer',
  ])
  return {
    ...(messages.adaptorPoint === undefined ? {} : { adaptorPoint: requireNonEmptyString(messages.adaptorPoint, 'local swap adaptor cipher') }),
    ...(messages.lockedProofsSeller === undefined ? {} : { lockedProofsSeller: requireNonEmptyString(messages.lockedProofsSeller, 'local swap seller cipher') }),
    ...(messages.lockedProofsBuyer === undefined ? {} : { lockedProofsBuyer: requireNonEmptyString(messages.lockedProofsBuyer, 'local swap buyer cipher') }),
  }
}

function decodeHexArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value.map((entry) => requireNonEmptyString(entry, name))
}

function decodeCashuProofArray(value: unknown, name: string): CashuProofRecord[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value.map((proof) => decodeCashuProofRecord(proof, name))
}

function decodeTakerRecovery(value: unknown): NonNullable<LocalSwapRecord['takerRecovery']> {
  const recovery = requireStateRecord(value, 'local swap taker recovery')
  requireStateFields(recovery, ['clientOrderId', 'status', 'replacementOrderId'], ['replacementOrderId'])
  if (recovery.status !== 'pending' && recovery.status !== 'submitted') {
    throw new Error('local swap taker recovery is invalid')
  }
  return {
    clientOrderId: requireNonEmptyString(recovery.clientOrderId, 'local swap replacement client id'),
    status: recovery.status,
    ...(recovery.replacementOrderId === undefined
      ? {}
      : { replacementOrderId: requireNonEmptyString(recovery.replacementOrderId, 'local swap replacement order id') }),
  }
}

function decodeSwapFailure(value: unknown): SwapFailure | PartialLockHeldRecord {
  const failure = requireStateRecord(value, 'local swap failure')
  const common = ['kind', 'refundLocktime', 'affectedKeysets', 'detail']
  if (failure.kind === 'PartialLockHeld') {
    requireStateFields(failure, [
      ...common, 'tradeId', 'orderId', 'mintUrl', 'outcomeByKeyset', 'lockedProofs', 'createdAt',
    ], ['tradeId', 'orderId', 'mintUrl', 'outcomeByKeyset', 'lockedProofs', 'createdAt'])
    const base: PartialLockHeldRecord = {
      kind: 'PartialLockHeld',
      tradeId: failure.tradeId === undefined || failure.tradeId === ''
        ? ''
        : requireNonEmptyString(failure.tradeId, 'local partial lock trade id'),
      refundLocktime: requireTimestamp(failure.refundLocktime, 'local partial lock refund time'),
      affectedKeysets: decodeStringArray(failure.affectedKeysets, 'local partial lock keysets'),
      detail: requireNonEmptyString(failure.detail, 'local partial lock detail'),
      outcomeByKeyset: failure.outcomeByKeyset === undefined
        ? {}
        : decodeOutcomeByKeyset(failure.outcomeByKeyset),
      lockedProofs: failure.lockedProofs === undefined
        ? []
        : decodeCashuProofArray(failure.lockedProofs, 'local partial lock proofs'),
      ...(failure.orderId === undefined ? {} : { orderId: requireNonEmptyString(failure.orderId, 'local partial lock order id') }),
      ...(failure.mintUrl === undefined ? {} : { mintUrl: requireNonEmptyString(failure.mintUrl, 'local partial lock mint') }),
      ...(failure.createdAt === undefined ? {} : { createdAt: requireTimestamp(failure.createdAt, 'local partial lock creation time') }),
    }
    return base
  }
  if (failure.kind !== 'InsufficientInventory' && failure.kind !== 'MintError' && failure.kind !== 'EngineRejected') {
    throw new Error('local swap failure is invalid')
  }
  requireStateFields(failure, common, ['refundLocktime', 'affectedKeysets'])
  return {
    kind: failure.kind,
    detail: requireNonEmptyString(failure.detail, 'local swap failure detail'),
    ...(failure.refundLocktime === undefined ? {} : { refundLocktime: requireTimestamp(failure.refundLocktime, 'local swap refund time') }),
    ...(failure.affectedKeysets === undefined ? {} : { affectedKeysets: decodeStringArray(failure.affectedKeysets, 'local swap failure keysets') }),
  }
}

function decodeOutcomeByKeyset(value: unknown): PartialLockHeldRecord['outcomeByKeyset'] {
  const mappings = requireStateRecord(value, 'local partial lock keyset outcomes')
  return Object.fromEntries(Object.entries(mappings).map(([keysetId, raw]) => {
    const metadata = requireStateRecord(raw, 'local partial lock outcome metadata')
    requireStateFields(metadata, ['conditionId', 'outcomeCollection', 'marketId'])
    return [
      requireNonEmptyString(keysetId, 'local partial lock keyset'),
      {
        conditionId: requireNonEmptyString(metadata.conditionId, 'local partial lock condition'),
        outcomeCollection: requireNonEmptyString(metadata.outcomeCollection, 'local partial lock outcome'),
        marketId: requireNonEmptyString(metadata.marketId, 'local partial lock market'),
      },
    ]
  }))
}

function decodeStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value.map((entry) => requireNonEmptyString(entry, name))
}

function requirePositiveInteger(value: unknown, name: string): number {
  const integer = requireTimestamp(value, name)
  if (integer === 0) throw new Error(`${name} is invalid`)
  return integer
}

function requireHex(value: unknown, name: string): string {
  const text = requireNonEmptyString(value, name).toLowerCase()
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2 !== 0) throw new Error(`${name} is invalid`)
  return text
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
