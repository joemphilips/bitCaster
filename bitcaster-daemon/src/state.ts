import { chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
  isSettlementCompleteMessage,
} from '@bitcaster-market/client-sdk/tradeFlow'
import { isSwapCipherMessageType } from '@bitcaster-market/client-sdk/tradeSession'
import {
  defaultCollateralUnit,
  isCollateralUnitOf,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
} from '@bitcaster-market/client-sdk/marketUnits'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { CtfRedeemMintSubmissionBinding } from '@bitcaster-market/client-sdk/ctfSplit'
import type {
  DurableTradeProofOperationLink,
  DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import type {
  DurableCustodyRecoveryClassification,
  DurableCustodyRecoveryDecision,
} from '@bitcaster-market/client-sdk/durableCustody'
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
  ensureProfileDir,
  openProfileDatabase,
  profileDatabaseExists,
  profileDatabasePath,
  profileInitializationIsComplete,
  readProfile,
} from './profile.ts'
import { readOrderEphemeralSecret } from './secrets.ts'
import { validateDaemonDurableOperationBinding } from './durableTradeBinding.ts'
import {
  assertDaemonStateSchema,
  daemonStateSchemaExists,
  DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX,
  deriveDaemonWalletProofId,
  deriveDaemonWalletProofIdFromProof,
  ensureDaemonStateSchema,
  FULL_DAEMON_STATE_ROW_SCOPE,
  readDaemonActiveTradeRuntimeRows,
  readDaemonActiveSwapIdsPage,
  readDaemonPendingTakerRecoveryRows,
  readDaemonStateCounts,
  readDaemonStateIsEmpty,
  readDaemonStateRows,
  readDaemonWalletBalance,
  readDaemonWalletHoldingTotals,
  readDaemonWalletProofAmountSample,
  writeDaemonStateRows,
  type DaemonIdPage,
  type DaemonIdPageInput,
  type DaemonStateCounts,
  type DaemonStateRowChanges,
  type DaemonStateRowScope,
  type DaemonWalletHoldingTotals,
  type DaemonWalletProofAmountSample,
  type DaemonWalletProofSelector,
} from './stateSqlite.ts'

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

export type ProofOperationState =
  | 'prepared'
  | 'mint-submitted'
  | 'completed'
  | 'Failed'

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
  failureCode?: number
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
  walletProofReservation?: {
    reservationId: string
    unit: CashuProofUnit
    parentOrderCollateralPinId?: string
  }
}

export interface DaemonWalletProofDelta {
  deleteProofIds: readonly string[]
  upsertProofs: readonly StoredProofRecord[]
}

export interface CompleteProofOperationWithWalletUpdateInput {
  operationId: string
  resultProofs: Record<string, CashuProofRecord[]>
  walletProofs: readonly DaemonWalletProofSelector[]
  walletDelta: (now: string) => DaemonWalletProofDelta
}

export interface DaemonProofOperationCoordinatorPort {
  prepare(input: PrepareProofOperationInput): Promise<ProofOperationRecord>
  markMintSubmitted(
    operationId: string,
    redeemBinding?: CtfRedeemMintSubmissionBinding,
  ): Promise<ProofOperationRecord>
  complete(
    operationId: string,
    resultProofs: Record<string, CashuProofRecord[]>,
  ): Promise<ProofOperationRecord>
  completeWithWalletUpdate(
    input: CompleteProofOperationWithWalletUpdateInput,
  ): Promise<ProofOperationRecord>
  assertRecoveryBound(operation: ProofOperationRecord): Promise<void>
  decideRecovery(
    operation: ProofOperationRecord,
    classification: DurableCustodyRecoveryClassification,
  ): Promise<DurableCustodyRecoveryDecision>
  listRecoverablePage(input: {
    cursor: string | null
    limit: number
  }): Promise<DaemonCanonicalRecoveryPage>
}

export interface DaemonCanonicalRecoveryWork {
  custodyOperationId: string
  retainedOperationKey: string
  binding:
    | { kind: 'wallet'; activityId: string }
    | { kind: 'trade'; tradeId: string }
}

export interface DaemonCanonicalRecoveryPage {
  work: DaemonCanonicalRecoveryWork[]
  nextCursor: string | null
}

let proofOperationCoordinator: DaemonProofOperationCoordinatorPort | undefined

function requireProofOperationCoordinator(): DaemonProofOperationCoordinatorPort {
  if (proofOperationCoordinator === undefined) {
    throw new Error('daemon proof operation coordinator is not installed')
  }
  return proofOperationCoordinator
}

export function installDaemonProofOperationCoordinator(
  coordinator: DaemonProofOperationCoordinatorPort,
): () => void {
  if (proofOperationCoordinator !== undefined) {
    throw new Error('daemon proof operation coordinator is already installed')
  }
  proofOperationCoordinator = coordinator
  return () => {
    if (proofOperationCoordinator === coordinator) {
      proofOperationCoordinator = undefined
    }
  }
}

export async function assertProofOperationCustodyBound(
  operation: ProofOperationRecord,
): Promise<void> {
  await requireProofOperationCoordinator().assertRecoveryBound(operation)
}

export async function decideProofOperationCustodyRecovery(
  operation: ProofOperationRecord,
  classification: DurableCustodyRecoveryClassification,
): Promise<DurableCustodyRecoveryDecision> {
  return requireProofOperationCoordinator().decideRecovery(
    operation,
    classification,
  )
}

export async function readCanonicalProofOperationRecoveryPage(input: {
  cursor: string | null
  limit: number
}): Promise<DaemonCanonicalRecoveryPage> {
  return requireProofOperationCoordinator().listRecoverablePage(input)
}

export interface StoredProofRecord {
  proof: CashuProofRecord
  mintUrl: string
  unit: CashuProofUnit
  state: 'available' | 'reserved' | 'locked'
  asset: StoredProofAsset
  reservedBy?: string
  createdAt: string
  updatedAt: string
}

export type StoredProofAsset =
  | { kind: 'sats'; baseAsset: string }
  | {
      kind: 'Outcome'
      conditionId: string
      outcomeSetId: string
      baseAsset: string
    }

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

/** Initializes the canonical typed state rows inside profile bootstrap's transaction. */
export function initializeDaemonStateInDatabase(
  database: DatabaseSync,
  state: DaemonState,
): void {
  ensureDaemonStateSchema(database)
  writeStoredStateToDatabase(database, state)
}

let stateUpdateQueue: Promise<unknown> = Promise.resolve()
let stateWriteFaultHookForTest:
  | ((stage: 'before-commit' | 'after-commit') => void)
  | undefined

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
  throw new Error(
    'daemon SQLite state is not initialized; run bitcaster-daemon init',
  )
}

/** Validates the durable schema and singleton without hydrating wallet history. */
export async function assertDaemonStateStorageInitialized(): Promise<void> {
  if (!(await profileDatabaseExists())) {
    throw new Error(
      'daemon SQLite state is not initialized; run bitcaster-daemon init',
    )
  }
  const database = openStateDatabase()
  try {
    if (!stateTableExists(database)) {
      throw new Error('daemon SQLite state schema is missing')
    }
    assertDaemonStateSchema(database)
    const marker = database
      .prepare(
        'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
      )
      .get() as { schema_version?: unknown } | undefined
    if (marker?.schema_version !== 1) {
      throw new Error('daemon SQLite state row is missing or unsupported')
    }
  } finally {
    database.close()
  }
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
      ensureDaemonStateSchema(database)
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
    const state = readStoredStateSnapshot(database)
    if (!state) throw new Error('daemon SQLite state row is missing')
    return state
  } finally {
    database.close()
  }
}

export async function readStateScope(
  scope: DaemonStateRowScope,
): Promise<DaemonState | null> {
  if (!(await profileDatabaseExists())) return null
  const database = openStateDatabase()
  try {
    if (!stateTableExists(database)) {
      throw new Error('daemon SQLite state schema is missing')
    }
    const state = readStoredStateSnapshot(database, scope)
    if (!state) throw new Error('daemon SQLite state row is missing')
    return state
  } finally {
    database.close()
  }
}

export async function readWalletHoldingTotals(input: {
  mintUrl: string
  conditionId: string
  baseAsset: string
}): Promise<DaemonWalletHoldingTotals> {
  if (!(await profileDatabaseExists())) {
    return { baseUnitProofs: 0, outcomeAmountsBySet: {} }
  }
  const database = openStateDatabase()
  try {
    if (!stateTableExists(database)) {
      throw new Error('daemon SQLite state schema is missing')
    }
    return readDaemonWalletHoldingTotals(database, input)
  } finally {
    database.close()
  }
}

export async function readWalletProofAmountSample(input: {
  mintUrl: string
  unit: CashuProofUnit
}): Promise<DaemonWalletProofAmountSample[]> {
  return readNormalizedStateDatabase((database) =>
    readDaemonWalletProofAmountSample(database, input),
  )
}

export async function readActiveSwapIdsPage(
  input: DaemonIdPageInput,
): Promise<DaemonIdPage> {
  return readNormalizedStateDatabase((database) =>
    readDaemonActiveSwapIdsPage(database, input),
  )
}

export async function readActiveTradeRuntimeState(): Promise<DaemonState> {
  return readNormalizedStateDatabase((database) => {
    const rows = readDaemonActiveTradeRuntimeRows(database)
    if (rows === null) throw new Error('daemon SQLite state row is missing')
    return decodeDaemonState(rows)
  })
}

export async function readPendingTakerRecoveryState(): Promise<DaemonState> {
  return readNormalizedStateDatabase((database) => {
    const rows = readDaemonPendingTakerRecoveryRows(database)
    if (rows === null) throw new Error('daemon SQLite state row is missing')
    return decodeDaemonState(rows)
  })
}

export async function readWalletBalance(): Promise<WalletBalance> {
  return readNormalizedStateDatabase(readDaemonWalletBalance)
}

export async function readDaemonStatusSnapshot(): Promise<{
  counts: DaemonStateCounts
  wallet: WalletBalance
}> {
  return readNormalizedStateDatabase((database) => {
    database.exec('BEGIN DEFERRED')
    try {
      const snapshot = {
        counts: readDaemonStateCounts(database),
        wallet: readDaemonWalletBalance(database),
      }
      database.exec('COMMIT')
      return snapshot
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The read transaction may already have ended while reporting corruption.
      }
      throw error
    }
  })
}

export async function daemonStateStorageIsEmpty(): Promise<boolean> {
  return readNormalizedStateDatabase(readDaemonStateIsEmpty)
}

async function readNormalizedStateDatabase<T>(
  read: (database: DatabaseSync) => T,
): Promise<T> {
  if (!(await profileDatabaseExists())) {
    throw new Error(
      'daemon SQLite state is not initialized; run bitcaster-daemon init',
    )
  }
  const database = openStateDatabase()
  try {
    if (!stateTableExists(database)) {
      throw new Error('daemon SQLite state schema is missing')
    }
    return read(database)
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
    ensureDaemonStateSchema(database)
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
  return daemonStateSchemaExists(database)
}

function readStoredStateFromDatabase(
  database: DatabaseSync,
  scope: DaemonStateRowScope = FULL_DAEMON_STATE_ROW_SCOPE,
): DaemonState | null {
  const rows = readDaemonStateRows(database, scope)
  return rows === null ? null : decodeDaemonState(rows)
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
    throw new Error(
      'daemon state is not empty; refusing to replace wallet/Nostr keys',
    )
  }
}

function writeStoredStateToDatabase(
  database: DatabaseSync,
  state: DaemonState,
  scope: DaemonStateRowScope = FULL_DAEMON_STATE_ROW_SCOPE,
  changes: DaemonStateRowChanges = {},
): void {
  writeDaemonStateRows(
    database,
    decodeDaemonState(toJsonSafe(state)),
    scope,
    changes,
  )
}

function readStoredStateSnapshot(
  database: DatabaseSync,
  scope: DaemonStateRowScope = FULL_DAEMON_STATE_ROW_SCOPE,
): DaemonState | null {
  database.exec('BEGIN DEFERRED')
  try {
    const state = readStoredStateFromDatabase(database, scope)
    database.exec('COMMIT')
    return state
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The read transaction may already have ended while reporting corruption.
    }
    throw error
  }
}

/** Persistence primitive used only by the daemon's combined SQLite UoW. */
export function applyDaemonStateWorkInDatabase<T>(
  database: DatabaseSync,
  scope: DaemonStateRowScope,
  update: (state: DaemonState, now: string) => T,
): T {
  const state = readStoredStateFromDatabase(database, scope)
  if (!state) throw new Error('daemon SQLite state row is missing')
  const priorWalletProofs =
    scope.walletProofs !== undefined
      ? fingerprintWalletProofs(state.wallet.proofs)
      : undefined
  const result = update(state, new Date().toISOString())
  const normalized = decodeDaemonState(toJsonSafe(state))
  const changes =
    priorWalletProofs === undefined
      ? {}
      : diffWalletProofs(priorWalletProofs, normalized.wallet.proofs)
  writeDaemonStateRows(database, normalized, scope, changes)
  return result
}

export async function updateState<T>(
  update: (state: DaemonState, now: string) => T,
): Promise<T>
export async function updateState<T>(
  scope: DaemonStateRowScope,
  update: (state: DaemonState, now: string) => T,
): Promise<T>
export async function updateState<T>(
  scopeOrUpdate: DaemonStateRowScope | ((state: DaemonState, now: string) => T),
  scopedUpdate?: (state: DaemonState, now: string) => T,
): Promise<T> {
  const scope =
    typeof scopeOrUpdate === 'function'
      ? FULL_DAEMON_STATE_ROW_SCOPE
      : scopeOrUpdate
  const update =
    typeof scopeOrUpdate === 'function' ? scopeOrUpdate : scopedUpdate
  if (!update) throw new Error('daemon state update callback is missing')
  return withStateUpdateLock(async () => {
    await ensureProfileDir()
    const database = openStateDatabase()
    try {
      if (process.platform !== 'win32') await chmod(statePath(), 0o600)
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = applyDaemonStateWorkInDatabase(database, scope, update)
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

function fingerprintWalletProofs(
  proofs: readonly StoredProofRecord[],
): Map<string, string> {
  return new Map(
    proofs.map((record) => [
      walletProofStorageKey(record),
      JSON.stringify(record),
    ]),
  )
}

function diffWalletProofs(
  prior: ReadonlyMap<string, string>,
  nextProofs: readonly StoredProofRecord[],
): DaemonStateRowChanges {
  const next = new Map(
    nextProofs.map(
      (record) => [walletProofStorageKey(record), record] as const,
    ),
  )
  const deleteIds: string[] = []
  const upserts: StoredProofRecord[] = []
  for (const [key, fingerprint] of prior) {
    const record = next.get(key)
    if (record !== undefined && JSON.stringify(record) === fingerprint) continue
    deleteIds.push(key)
  }
  for (const [key, record] of next) {
    if (prior.get(key) === JSON.stringify(record)) continue
    upserts.push(record)
  }
  return {
    walletProofDeleteIds: deleteIds,
    walletProofUpserts: upserts,
  }
}

function walletProofStorageKey(record: StoredProofRecord): string {
  return deriveDaemonWalletProofId(record)
}

export async function addAvailableSatProofs(
  mintUrl: string,
  proofs: CashuProofRecord[],
  unit: CashuProofUnit = 'sat',
): Promise<StoredProofRecord[]> {
  return addAvailableProofs(
    mintUrl,
    proofs,
    { kind: 'sats', baseAsset: normalizeMarketBaseAsset(unit) },
    unit,
  )
}

export async function addAvailableProofs(
  mintUrl: string,
  proofs: CashuProofRecord[],
  asset: StoredProofAsset,
  unitInput: string,
): Promise<StoredProofRecord[]> {
  const unit = parseCashuProofUnit(unitInput)
  if (unit === null) throw new Error('stored proof unit is invalid')
  return updateState(
    {
      walletProofs: exactWalletProofSelector(mintUrl, proofs, unit),
    },
    (state, now) => {
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
        unit,
        state: 'available',
        asset: normalizeProofAsset(asset),
        createdAt: now,
        updatedAt: now,
      }
      state.wallet.proofs.push(record)
      inserted.push(record)
    }
    return inserted
    },
    )
}

export class WalletProofReservationConflictError extends Error {
  constructor() {
    super('wallet proof reservation lost a concurrent selection race')
    this.name = 'WalletProofReservationConflictError'
  }
}

export async function selectAvailableSatProofsForSend(input: {
  mintUrl: string
  amountSats: number
  unit?: CashuProofUnit
}): Promise<CashuProofRecord[]> {
  const unit = input.unit ?? defaultCollateralUnit('sat')
  const walletProofs: DaemonWalletProofSelector[] = [{
    mintUrl: input.mintUrl,
    unit,
    state: 'available',
    assetKind: 'sats',
    baseAsset: 'sat',
    candidateLimit: true,
  }]
  const state = await readStateScope({ walletProofs })
  if (state === null) throw new Error('daemon state is not initialized')
  return selectAvailableSatProofRecords(state, { ...input, unit }).map(
    (record) => structuredClone(record.proof),
  )
}

export function walletProofSelectorsForPrepare(
  input: PrepareProofOperationInput,
): DaemonWalletProofSelector[] | undefined {
  const reservation = validatedWalletProofReservation(input)
  if (reservation === null) return undefined
  return exactWalletProofSelector(input.mintUrl, input.inputs, reservation.unit)
}

export function reserveWalletProofsForPrepareInState(
  state: DaemonState,
  input: PrepareProofOperationInput,
  now: string,
): void {
  const reservation = validatedWalletProofReservation(input)
  if (reservation === null) return
  const recordsById = new Map(state.wallet.proofs.map((record) => [
    deriveDaemonWalletProofId(record),
    record,
  ]))
  for (const proof of input.inputs) {
    const proofId = deriveDaemonWalletProofIdFromProof(
      input.mintUrl,
      reservation.unit,
      proof,
    )
    const record = recordsById.get(proofId)
    if (record === undefined) throw new WalletProofReservationConflictError()
    assertWalletProofMatchesPrepare(record, proof, input, reservation)
    if (record.state === 'reserved' && record.reservedBy === reservation.reservationId) {
      continue
    }
    const parentOwned = reservation.parentOrderCollateralPinId !== undefined
      && record.state === 'reserved'
      && record.reservedBy === reservation.parentOrderCollateralPinId
    if (record.state !== 'available' && !parentOwned) {
      throw new WalletProofReservationConflictError()
    }
    record.state = 'reserved'
    record.reservedBy = reservation.reservationId
    record.updatedAt = now
  }
}

function selectAvailableSatProofRecords(
  state: DaemonState,
  input: { mintUrl: string; amountSats: number; unit: CashuProofUnit },
): StoredProofRecord[] {
  const candidates = state.wallet.proofs.filter((record) =>
    record.mintUrl === input.mintUrl &&
    record.unit === input.unit &&
    record.state === 'available' &&
    record.asset.kind === 'sats' &&
    normalizeProofAssetBaseAsset(record.asset) === 'sat',
  ).sort((left, right) =>
    amountToNumber(right.proof.amount) - amountToNumber(left.proof.amount),
  )
  const selected: StoredProofRecord[] = []
  let total = 0
  for (const record of candidates.slice(0, DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX)) {
    selected.push(record)
    total += amountToNumber(record.proof.amount)
    if (total >= input.amountSats) return selected
  }
  if (candidates.length > DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX) {
    throw new Error('available proof selection exceeds the durable input limit')
  }
  throw new Error(`insufficient available sats in mint ${input.mintUrl}`)
}

function validatedWalletProofReservation(
  input: PrepareProofOperationInput,
): {
  reservationId: string
  unit: CashuProofUnit
  parentOrderCollateralPinId?: string
} | null {
  const reservation = input.walletProofReservation
  if (reservation === undefined) return null
  const parentOrderCollateralPinId = reservation.parentOrderCollateralPinId
  const tradeLockOperation = isTradeWalletReservationKind(input.kind)
  if (input.kind !== 'wallet-send'
    && (!tradeLockOperation
      || (input.durableTradeRecovery === undefined
        && parentOrderCollateralPinId === undefined))) {
    throw new Error('wallet proof reservation requires a durable wallet effect')
  }
  if (reservation.reservationId.length === 0) {
    throw new Error('wallet proof reservation id is invalid')
  }
  const unit = parseCashuProofUnit(reservation.unit)
  if (unit === null || input.metadata?.reservationId !== reservation.reservationId
    || input.metadata?.unit !== unit) {
    throw new Error('wallet proof reservation metadata is invalid')
  }
  if (parentOrderCollateralPinId !== undefined
    && (parentOrderCollateralPinId.length === 0
      || !tradeLockOperation)) {
    throw new Error('order collateral parent reservation is invalid')
  }
  if (input.inputs.length === 0) {
    throw new Error('wallet proof reservation inputs are empty')
  }
  return {
    reservationId: reservation.reservationId,
    unit,
    ...(parentOrderCollateralPinId === undefined
      ? {}
      : { parentOrderCollateralPinId }),
  }
}

export function isTradeWalletReservationKind(kind: ProofOperationKind): boolean {
  switch (kind) {
    case 'swap-lock':
    case 'conditional-keyset-swap':
    case 'ctf-split':
    case 'proof-split':
    case 'regular-split':
      return true
    case 'wallet-send':
    case 'swap-claim':
    case 'swap-refund':
    case 'ctf-merge':
    case 'ctf-consolidation':
    case 'ctf-redeem':
      return false
    default:
      return unreachableProofOperationKind(kind)
  }
}

function unreachableProofOperationKind(value: never): never {
  throw new Error(`unhandled proof operation kind: ${String(value)}`)
}

function assertWalletProofMatchesPrepare(
  record: StoredProofRecord,
  proof: CashuProofRecord,
  input: PrepareProofOperationInput,
  reservation: {
    unit: CashuProofUnit
    parentOrderCollateralPinId?: string
  },
): void {
  const assetMatches = reservation.parentOrderCollateralPinId !== undefined
    ? true
    : input.kind === 'wallet-send'
    ? record.asset.kind === 'sats'
      && normalizeProofAssetBaseAsset(record.asset) === 'sat'
      && proof.conditionId === undefined
      && proof.outcomeCollection === undefined
    : proofMetadataMatchesStoredAsset(record, proof)
  if (record.mintUrl !== input.mintUrl || record.unit !== reservation.unit
    || !assetMatches
    || !isDeepStrictEqual(
      normalizedProofWithoutAssetMetadata(record.proof),
      normalizedProofWithoutAssetMetadata(proof),
    )) {
    throw new Error('wallet proof reservation input is foreign')
  }
}

function proofMetadataMatchesStoredAsset(
  record: StoredProofRecord,
  proof: CashuProofRecord,
): boolean {
  if (record.asset.kind === 'sats') {
    return proof.conditionId === undefined
      && proof.outcomeCollection === undefined
  }
  return proof.conditionId === record.asset.conditionId
    && proof.outcomeCollection === record.asset.outcomeSetId
}

function normalizedProofWithoutAssetMetadata(
  proof: CashuProofRecord,
): CashuProofRecord {
  const normalized = normalizeCashuProofRecord(proof)
  delete normalized.conditionId
  delete normalized.outcomeCollection
  return normalized
}

/**
 * Completes a proof operation and applies its wallet-proof transition in the
 * same SQLite transaction. Repeating an already committed result is
 * idempotent; the wallet transition is not replayed.
 */
export async function completeProofOperationWithWalletUpdate(
  input: CompleteProofOperationWithWalletUpdateInput,
): Promise<ProofOperationRecord> {
  return requireProofOperationCoordinator().completeWithWalletUpdate(input)
}

/** Test-only state-projection fixture; production custody must use the coordinator. */
export async function completeProofOperationStateProjectionForTest(
  input: CompleteProofOperationWithWalletUpdateInput,
): Promise<ProofOperationRecord> {
  const normalizedResultProofs = normalizeProofRecordGroups(input.resultProofs)
  return updateState(
    {
      proofOperationIds: [input.operationId],
      walletProofs: input.walletProofs,
    },
    (state, now) => {
      const existing = requireProofOperation(state, input.operationId)
      if (existing.state === 'completed') {
        if (!isDeepStrictEqual(existing.resultProofs, normalizedResultProofs)) {
          throw new Error(
            `Completed proof operation ${input.operationId} has a different result`,
    )
      }
        return existing
      }
      assertValidCompletedProofOperationResult(existing, normalizedResultProofs)
      applyWalletProofDeltaInState(state, input.walletDelta(now))
      return completeProofOperationInState(
        state,
        existing,
        normalizedResultProofs,
      )
    },
  )
}

export function applyWalletProofDeltaInState(
  state: DaemonState,
  delta: DaemonWalletProofDelta,
): void {
  const deleteProofIds = new Set(delta.deleteProofIds)
  if (deleteProofIds.size !== delta.deleteProofIds.length) {
    throw new Error('wallet proof delta contains duplicate deletes')
  }
  const retained = state.wallet.proofs.filter((proof) =>
    !deleteProofIds.has(
      deriveDaemonWalletProofIdFromProof(proof.mintUrl, proof.unit, proof.proof),
    ),
  )
  const byId = new Map(retained.map((proof) => [
    deriveDaemonWalletProofIdFromProof(proof.mintUrl, proof.unit, proof.proof),
    proof,
  ]))
  for (const proof of delta.upsertProofs) {
    const proofId = deriveDaemonWalletProofIdFromProof(
      proof.mintUrl,
      proof.unit,
      proof.proof,
    )
    byId.set(proofId, structuredClone(proof))
  }
  state.wallet.proofs = [...byId.values()]
}

function exactWalletProofSelector(
  mintUrl: string,
  proofs: readonly CashuProofRecord[],
  unitInput: string | null | undefined,
): DaemonWalletProofSelector[] {
  const proofIds = proofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(mintUrl, unitInput, proof),
  )
  return proofIds.length === 0 ? [] : [{ proofIds }]
}

export async function getProofOperation(
  operationId: string,
): Promise<ProofOperationRecord | null> {
  return (
    (await readStateScope({ proofOperationIds: [operationId] }))
      ?.proofOperations[operationId] ?? null
  )
}

export interface ReconciledTradeWalletInputs {
  operationKeys: string[]
  rows: StoredProofRecord[]
}

interface ReconciledTradeLockedOutput {
  operation: ProofOperationRecord
  proof: CashuProofRecord
  unit: CashuProofUnit
}

/**
 * Loads the exact wallet inputs retained by reconciled operations for one
 * state-machine step. Missing, released, mixed, or body-mismatched authority
 * fails closed; callers may select fresh proofs only when no matching operation
 * has ever been prepared.
 */
export async function readReconciledTradeWalletInputs(
  tradeId: string,
  operationKeyPrefix: string,
): Promise<ReconciledTradeWalletInputs | null> {
  const tradeState = await readStateScope({ tradeIds: [tradeId] })
  if (tradeState === null) throw new Error('daemon state is not initialized')
  const operations = Object.values(tradeState.proofOperations)
    .filter((operation) =>
      operation.durableTradeRecovery?.tradeId === tradeId
      && (operation.operationId === operationKeyPrefix
        || operation.operationId.startsWith(`${operationKeyPrefix}/`)),
    )
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
  if (operations.length === 0) return null

  const prepared = operations.map(requireReconciledWalletOperation)
  const proofIds = prepared.flatMap(({ operation, unit }) =>
    operation.inputs.map((proof) => deriveDaemonWalletProofIdFromProof(
      operation.mintUrl,
      unit,
      proof,
    )),
  )
  if (new Set(proofIds).size !== proofIds.length) {
    throw new Error('reconciled trade operations share wallet input authority')
  }
  const walletState = await readStateScope({ walletProofs: [{ proofIds }] })
  if (walletState === null) throw new Error('daemon state is not initialized')
  const rowsById = new Map(walletState.wallet.proofs.map((row) => [
    deriveDaemonWalletProofId(row),
    row,
  ]))
  const rows = prepared.flatMap(({ operation, unit }) =>
    operation.inputs.map((proof) => {
      const proofId = deriveDaemonWalletProofIdFromProof(
        operation.mintUrl,
        unit,
        proof,
      )
      const row = rowsById.get(proofId)
      if (row === undefined
        || row.state !== 'reserved'
        || row.reservedBy !== operation.operationId) {
        throw new Error('reconciled trade wallet input authority is missing')
      }
      assertWalletProofMatchesPrepare(row, proof, operation, { unit })
      return structuredClone(row)
    }),
  )
  return {
    operationKeys: operations.map(({ operationId }) => operationId),
    rows,
  }
}

/**
 * Loads the exact locked outputs retained by reconciled swap-lock operations.
 * The wallet row lifecycle is only a checked projection: the completed daemon
 * operation and its SDK custody result fingerprint remain the authority.
 */
export async function readReconciledTradeLockedOutputs(
  tradeId: string,
  exactProofs: readonly CashuProofRecord[],
): Promise<StoredProofRecord[]> {
  const expectedByKey = indexExpectedLockedOutputs(exactProofs)
  const matchedByKey = await matchReconciledLockedOutputs(
    tradeId,
    expectedByKey,
  )
  return readExactLockedOutputRows(tradeId, exactProofs, matchedByKey)
}

async function matchReconciledLockedOutputs(
  tradeId: string,
  expectedByKey: ReadonlyMap<string, CashuProofRecord>,
): Promise<Map<string, ReconciledTradeLockedOutput>> {
  const tradeState = await readStateScope({ tradeIds: [tradeId] })
  if (tradeState === null) throw new Error('daemon state is not initialized')
  const matchedByKey = new Map<string, ReconciledTradeLockedOutput>()
  for (const operation of Object.values(tradeState.proofOperations)) {
    if (operation.kind !== 'swap-lock'
      || operation.durableTradeRecovery?.tradeId !== tradeId) {
      continue
    }
    const { unit } = requireReconciledWalletOperation(operation)
    await assertProofOperationCustodyBound(operation)
    for (const proof of operation.resultProofs?.send ?? []) {
      const normalized = normalizeCashuProofRecord(proof)
      const key = proofAuthorityKey(normalized)
      const expected = expectedByKey.get(key)
      if (expected === undefined) continue
      if (matchedByKey.has(key)) {
        throw new Error('partial lock refund has duplicate output authority')
      }
      assertExactProofBody(normalized, expected)
      matchedByKey.set(key, { operation, proof: normalized, unit })
    }
  }
  if (matchedByKey.size !== expectedByKey.size) {
    throw new Error('partial lock refund has no reconciled output authority')
  }
  return matchedByKey
}

async function readExactLockedOutputRows(
  tradeId: string,
  exactProofs: readonly CashuProofRecord[],
  matchedByKey: ReadonlyMap<string, ReconciledTradeLockedOutput>,
): Promise<StoredProofRecord[]> {
  const proofIds = [...matchedByKey.values()].map(({ operation, proof, unit }) =>
    deriveDaemonWalletProofIdFromProof(operation.mintUrl, unit, proof),
  )
  const walletState = await readStateScope({ walletProofs: [{ proofIds }] })
  if (walletState === null) throw new Error('daemon state is not initialized')
  const rowsById = new Map(walletState.wallet.proofs.map((row) => [
    deriveDaemonWalletProofId(row),
    row,
  ]))
  return exactProofs.map((proof) => {
    const canonical = matchedByKey.get(proofAuthorityKey(proof))
    if (canonical === undefined) {
      throw new Error('partial lock refund has no reconciled output authority')
    }
    const proofId = deriveDaemonWalletProofIdFromProof(
      canonical.operation.mintUrl,
      canonical.unit,
      canonical.proof,
    )
    const row = rowsById.get(proofId)
    if (row === undefined
      || row.state !== 'locked'
      || row.reservedBy !== tradeId
      || row.mintUrl !== canonical.operation.mintUrl
      || row.unit !== canonical.unit) {
      throw new Error('partial lock refund projection is not exact')
    }
    assertExactProofBody(row.proof, canonical.proof)
    return structuredClone(row)
  })
}

function indexExpectedLockedOutputs(
  exactProofs: readonly CashuProofRecord[],
): Map<string, CashuProofRecord> {
  if (exactProofs.length === 0) {
    throw new Error('partial lock refund has no reconciled output authority')
  }
  const expectedByKey = new Map<string, CashuProofRecord>()
  for (const proof of exactProofs.map(normalizeCashuProofRecord)) {
    const key = proofAuthorityKey(proof)
    if (expectedByKey.has(key)) {
      throw new Error('partial lock refund repeats a locked proof')
    }
    expectedByKey.set(key, proof)
  }
  return expectedByKey
}

function proofAuthorityKey(proof: CashuProofRecord): string {
  if (!proof.id) throw new Error('partial lock proof keyset is missing')
  return `${proof.id}\u0000${proof.secret}`
}

function assertExactProofBody(
  actual: CashuProofRecord,
  expected: CashuProofRecord,
): void {
  if (!isDeepStrictEqual(
    normalizedProofWithoutAssetMetadata(actual),
    normalizedProofWithoutAssetMetadata(expected),
  )) {
    throw new Error('partial lock refund proof body is foreign')
  }
}

function requireReconciledWalletOperation(operation: ProofOperationRecord): {
  operation: ProofOperationRecord
  unit: CashuProofUnit
} {
  const link = operation.durableTradeRecovery
  const rawUnit = operation.metadata.unit
  const unit = parseCashuProofUnit(
    typeof rawUnit === 'string' ? rawUnit : null,
  )
  if (operation.state !== 'completed'
    || link?.state !== 'reconciled'
    || operation.metadata.reservationId !== operation.operationId
    || unit === null
    || operation.inputs.length === 0) {
    throw new Error('trade wallet operation is not reconciled exact authority')
  }
  return { operation, unit }
}

export async function prepareProofOperation(
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  return requireProofOperationCoordinator().prepare(input)
}

/** Test-only state-projection fixture; production custody must use the coordinator. */
export async function prepareProofOperationStateProjectionForTest(
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  const walletProofs = walletProofSelectorsForPrepare(input)
  return updateState(
    {
      proofOperationIds: [input.operationId],
      ...(input.durableTradeRecovery === undefined
        ? {}
        : { tradeIds: [input.durableTradeRecovery.tradeId] }),
      ...(walletProofs === undefined ? {} : { walletProofs }),
    },
    (state, nowIso) => {
    const existing = state.proofOperations[input.operationId]
    if (existing) {
      assertCompatibleProofOperation(existing, input)
      if (existing.state === 'prepared' || existing.state === 'mint-submitted') {
        reserveWalletProofsForPrepareInState(state, input, nowIso)
      }
      return existing
    }
    reserveWalletProofsForPrepareInState(state, input, nowIso)
    const now = Date.parse(nowIso)
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
          throw new Error(
            `Proof operation ${input.operationId} has no durable trade session`,
          )
      }
      const bindingError = validateDaemonDurableOperationBinding({
        session,
        record,
        operation: link,
        allowUnlinkedSessionOperation: true,
      })
      if (bindingError || link.state !== 'prepared') {
          throw new Error(
            `Proof operation ${input.operationId} has an invalid durable trade binding: ${bindingError ?? 'state'}`,
          )
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
        if (
          !session.proofOperations.some(
            (item) => item.operationId === link.operationId,
          )
        ) {
        session.proofOperations.push(link)
      }
      session.expectedProofOperations = expected
      session.stage = 'proof-reserved'
      session.revision += 1
    }
    return record
    },
  )
}

export async function markProofOperationCompleted(
  operationId: string,
  resultProofs: Record<string, CashuProofRecord[]>,
): Promise<ProofOperationRecord> {
  return requireProofOperationCoordinator().complete(operationId, resultProofs)
}

/** Test-only state-projection fixture; production custody must use the coordinator. */
export async function markProofOperationCompletedStateProjectionForTest(
  operationId: string,
  resultProofs: Record<string, CashuProofRecord[]>,
): Promise<ProofOperationRecord> {
  return updateState({ proofOperationIds: [operationId] }, (state) => {
    const existing = requireProofOperation(state, operationId)
    if (
      existing.kind === 'wallet-send' ||
      existing.kind === 'ctf-consolidation'
    ) {
      throw new Error(
        `Proof operation ${operationId} requires atomic wallet completion`,
      )
    }
    const normalizedResultProofs = normalizeProofRecordGroups(resultProofs)
    if (existing.state === 'completed') {
      if (!isDeepStrictEqual(existing.resultProofs, normalizedResultProofs)) {
        throw new Error(
          `Completed proof operation ${operationId} has a different result`,
        )
      }
      return existing
    }
    assertValidCompletedProofOperationResult(existing, normalizedResultProofs)
    return completeProofOperationInState(
      state,
      existing,
      normalizedResultProofs,
    )
  })
}

function requireProofOperation(
  state: DaemonState,
  operationId: string,
): ProofOperationRecord {
    const existing = state.proofOperations[operationId]
  if (!existing) throw new Error(`Missing proof operation ${operationId}`)
  return existing
    }

function completeProofOperationInState(
  state: DaemonState,
  existing: ProofOperationRecord,
  resultProofs: Record<string, CashuProofRecord[]>,
): ProofOperationRecord {
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
    resultProofs,
      lastError: null,
      updatedAt: Date.now(),
    }
  state.proofOperations[existing.operationId] = updated
    return updated
}

/** Persists the recovery boundary immediately before a Cashu mint request. */
export async function markProofOperationMintSubmitted(
  operationId: string,
  redeemBinding?: CtfRedeemMintSubmissionBinding,
): Promise<ProofOperationRecord> {
  return requireProofOperationCoordinator().markMintSubmitted(
    operationId,
    redeemBinding,
  )
}

/** Test-only state-projection fixture; production custody must use the coordinator. */
export async function markProofOperationMintSubmittedStateProjectionForTest(
  operationId: string,
  redeemBinding?: CtfRedeemMintSubmissionBinding,
): Promise<ProofOperationRecord> {
  return updateState({ proofOperationIds: [operationId] }, (state) => {
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
      metadata:
        redeemBinding === undefined
        ? existing.metadata
        : {
          ...existing.metadata,
          redeemMintSubmissionVersion: redeemBinding.schemaVersion,
          redeemMintSubmissionRequestDigest: redeemBinding.requestDigest,
        },
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
    throw new Error(
      `durable proof operation ${link.operationId} has no session`,
    )
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
    throw new Error(
      `durable proof operation ${link.operationId} is not bound to its session`,
    )
  }

  switch (transition) {
    case 'mint-submitted':
      if (
        sessionLink.state === 'mint-submitted' &&
        link.state === 'mint-submitted'
      ) {
        return sessionLink
      }
      if (
        sessionLink.state !== 'prepared' ||
        (link.state !== 'prepared' && link.state !== 'mint-submitted')
      ) {
        throw new Error(
          `durable proof operation ${link.operationId} cannot advance to mint-submitted`,
        )
      }
      break
    case 'reconciled':
      if (sessionLink.state === 'reconciled' && link.state === 'reconciled') {
        return sessionLink
      }
      if (
        (sessionLink.state !== 'prepared' &&
          sessionLink.state !== 'mint-submitted') ||
        sessionLink.state !== link.state
      ) {
        throw new Error(
          `durable proof operation ${link.operationId} cannot advance to reconciled`,
        )
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
  if (
    !nextLink ||
    nextLink.state !== transition ||
    !sameDurableTradeOperationIdentity(nextLink, link)
  ) {
    throw new Error(
      `durable proof operation ${link.operationId} did not advance with its session`,
    )
  }
  state.durableTradeSessions[link.tradeId] = nextSession
  return nextLink
}

function sameDurableTradeOperationIdentity(
  left: DurableTradeProofOperationLink,
  right: DurableTradeProofOperationLink,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.operationKey === right.operationKey &&
    left.tradeId === right.tradeId &&
    left.role === right.role &&
    left.stage === right.stage &&
    left.kind === right.kind
  )
}

export function summarizeWalletBalance(state: DaemonState): WalletBalance {
  const byMint = new Map<
    string,
    {
      mintUrl: string
      availableSats: number
      reservedSats: number
      lockedSats: number
    }
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
        conditionId:
          proof.asset.kind === 'Outcome' ? proof.asset.conditionId : '',
        outcomeSetId:
          proof.asset.kind === 'Outcome' ? proof.asset.outcomeSetId : '',
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
    totalAvailableSats: mintRows.reduce(
      (sum, row) => sum + row.availableSats,
      0,
    ),
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
  return upsertOrderFromEngine({ marketId, orderId, engineStatus })
}

export async function listLocalOrders(
  params: ListLocalOrdersParams = {},
): Promise<LocalOrderRecord[]> {
  const state = await readStateScope({ orderIds: 'all' })
  if (!state) return []
  return Object.values(state.orders)
    .filter((order) => !params.marketId || order.marketId === params.marketId)
    .filter((order) => !params.status || order.status === params.status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listLocalSwaps(
  params: ListLocalSwapsParams = {},
): Promise<LocalSwapRecord[]> {
  const state = await readStateScope({ swapIds: 'all' })
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
  const state = await readStateScope({ proofOperationIds: 'all' })
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
  return upsertOrderFromEngine({
    marketId,
    orderId,
    engineStatus: engineResponse,
    clientOrderId,
    preflightSplit,
    tokenSide,
    side,
    priceSubunits,
    amountSubunits,
    timeInForce,
    recoveryAttempt,
  })
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

function countRecordArrays<T>(
  record: Record<string, T[]>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).map(([key, values]) => [key, values.length]),
  )
}

export interface OrderEngineProjectionInput {
  marketId: string
  orderId: string
  engineStatus: unknown
  clientOrderId?: string
  preflightSplit?: LocalOrderPreflightSplit | null
  tokenSide?: 'Outcome' | 'Complement'
  side?: 'Buy' | 'Sell'
  priceSubunits?: number
  amountSubunits?: number
  timeInForce?: 'FAK' | 'FOK' | 'GTC'
  recoveryAttempt?: number
}

export function orderEngineProjectionScope(
  input: OrderEngineProjectionInput,
): DaemonStateRowScope {
  return {
    orderIds: [input.orderId],
    swapIds: extractTradeIds(input.engineStatus),
    swapIdsFromOrderIds: [input.orderId],
  }
}

export function applyOrderEngineProjection(
  state: DaemonState,
  now: string,
  input: OrderEngineProjectionInput,
): LocalOrderRecord {
  const existing = state.orders[input.orderId]
  const tradeIds = mergedTradeIds(existing, input.engineStatus)
  const record = buildOrderRecord(input, existing, tradeIds, now)
  const takerByTradeId = extractTakerParticipation(
    input.engineStatus,
    input.orderId,
  )
  state.orders[input.orderId] = record
  for (const tradeId of tradeIds) {
    state.swaps[tradeId] = projectOrderSwap(
      state.swaps[tradeId],
      record,
      tradeId,
      takerByTradeId.get(tradeId),
      now,
    )
  }
  return record
}

function upsertOrderFromEngine(
  input: OrderEngineProjectionInput,
): Promise<LocalOrderRecord> {
  return updateState(
    orderEngineProjectionScope(input),
    (state, now) => applyOrderEngineProjection(state, now, input),
  )
}

function mergedTradeIds(
  existing: LocalOrderRecord | undefined,
  engineStatus: unknown,
): string[] {
  return [...new Set([
    ...(existing?.tradeIds ?? []),
    ...extractTradeIds(engineStatus),
  ])]
}

function buildOrderRecord(
  input: OrderEngineProjectionInput,
  existing: LocalOrderRecord | undefined,
  tradeIds: string[],
  now: string,
): LocalOrderRecord {
  const baseAsset = readStringProperty(input.engineStatus, 'baseAsset')
    ?? existing?.baseAsset ?? null
  const divisibility = readNumberProperty(input.engineStatus, 'divisibility')
    ?? existing?.divisibility
  const preflightSplit = input.preflightSplit === null
    ? undefined
    : input.preflightSplit ?? existing?.preflightSplit
  return {
    orderId: input.orderId,
    marketId: input.marketId,
    ...optional('tokenSide', input.tokenSide ?? existing?.tokenSide),
    ...optional('side', input.side ?? existing?.side),
    ...optional('priceSubunits', input.priceSubunits ?? existing?.priceSubunits),
    ...optional('amountSubunits', input.amountSubunits ?? existing?.amountSubunits),
    ...optional('timeInForce', input.timeInForce ?? existing?.timeInForce),
    ...optional('recoveryAttempt', input.recoveryAttempt ?? existing?.recoveryAttempt),
    status: readStringProperty(input.engineStatus, 'status')
      ?? existing?.status ?? 'unknown',
    ...optional('clientOrderId', input.clientOrderId ?? existing?.clientOrderId),
    ...optional('baseAsset', baseAsset || undefined),
    ...optional('divisibility', divisibility || undefined),
    ...optional('preflightSplit', preflightSplit),
    tradeIds,
    engineStatus: input.engineStatus,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]: Value }
}

function projectOrderSwap(
  existing: LocalSwapRecord | undefined,
  order: LocalOrderRecord,
  tradeId: string,
  isTaker: boolean | undefined,
  now: string,
): LocalSwapRecord {
  return {
    ...existing,
    tradeId,
    marketId: order.marketId,
    orderId: order.orderId,
    isTaker: isTaker ?? existing?.isTaker,
    messages: existing?.messages ?? {},
    step: existing?.step ?? 'awaiting-trade-created',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export async function recordTradeCreated(
  payload: DaemonTradeCreatedPayload,
): Promise<LocalSwapRecord | null> {
  const tradeKey = await readOrderEphemeralSecret(payload.tradeId)
  const profile = await readProfile()
  const ownEphemeralPubkey = tradeKey?.publicKeyHex
  const candidates = await readStateScope({
    orderTradeIds: [payload.tradeId],
    orderEphemeralPubkeys: [payload.sellerPubkey, payload.buyerPubkey],
  })
  const candidate =
    candidates === null
      ? null
      : findOrderForTradeCreated(candidates, payload, ownEphemeralPubkey)
  if (!candidate) return null
  const keyId = tradeKey === null ? candidate.orderId : payload.tradeId
  const key = tradeKey ?? (await readOrderEphemeralSecret(candidate.orderId))
  if (
    key !== null &&
    (key.orderId !== candidate.orderId ||
      key.marketId !== candidate.marketId ||
      (key.tradeId !== undefined && key.tradeId !== payload.tradeId) ||
      key.publicKeyHex !== candidate.ownEphemeralPubkey)
  ) {
    throw new Error(
      `TradeCreated ${payload.tradeId} protocol key binding is invalid`,
    )
  }
  return updateState(
    {
      orderIds: [candidate.orderId],
      swapIds: [payload.tradeId],
      tradeIds: [payload.tradeId],
    },
    (state, now) => {
    const match = findOrderForTradeCreated(state, payload, ownEphemeralPubkey)
    if (!match) return null

    const existing = state.swaps[payload.tradeId]
    const order = state.orders[match.orderId]
    const legacyOrderAmountScale =
      order?.divisibility == null && typeof payload.divisibility === 'number'
        ? payload.divisibility / 100
        : 1
    const expectedDivisibility =
        order?.divisibility ??
        payload.divisibility ??
        (order?.amountSubunits != null ? 100 : undefined)
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
          order?.side &&
          order.priceSubunits != null &&
          order.amountSubunits != null
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
        quotePaymentSubunits:
          payload.quotePaymentSubunits ?? payload.quotePaymentSats,
    })
    const protocolError = decision.accepted ? null : decision.error
    const accepted = decision.accepted
      if (accepted && !key) {
        throw new Error(
          `TradeCreated ${payload.tradeId} protocol key is missing`,
        )
      }

    const record: LocalSwapRecord = {
      tradeId: payload.tradeId,
      marketId: match.marketId,
      orderId: match.orderId,
      role: decision.role ?? existing?.role,
        counterpartyPubkey:
          decision.counterpartyPubkey ?? existing?.counterpartyPubkey,
      sellerLocktime: decision.sellerLocktime,
      buyerLocktime: decision.buyerLocktime,
      fillAmountSats: payload.fillAmountSats ?? existing?.fillAmountSats,
      fillAmountSubunits:
          payload.fillAmountSubunits ??
          payload.fillAmountSats ??
          existing?.fillAmountSubunits,
      outcomeFaceAmountSats:
        payload.outcomeFaceAmountSats ?? existing?.outcomeFaceAmountSats,
      outcomeFaceAmountSubunits:
        payload.outcomeFaceAmountSubunits ??
        (payload.outcomeFaceAmountSats != null
          ? payload.outcomeFaceAmountSats * legacyOutcomeAmountScale
          : existing?.outcomeFaceAmountSubunits),
        quotePaymentSats:
          payload.quotePaymentSats ?? existing?.quotePaymentSats,
        baseAsset:
          payload.baseAsset ?? order?.baseAsset ?? existing?.baseAsset ?? null,
      divisibility: expectedDivisibility ?? existing?.divisibility,
      quotePaymentSubunits:
          payload.quotePaymentSubunits ??
          payload.quotePaymentSats ??
          existing?.quotePaymentSubunits,
        settlementKind:
          payload.settlementKind ?? existing?.settlementKind ?? null,
      sellerKeepOutcomeSetId:
          payload.sellerKeepOutcomeSetId ??
          existing?.sellerKeepOutcomeSetId ??
          null,
      sellerLockOutcomeSetId:
          payload.sellerLockOutcomeSetId ??
          existing?.sellerLockOutcomeSetId ??
          null,
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
        const prior = state.durableTradeSessions[payload.tradeId]
        state.durableTradeSessions[payload.tradeId] = prior ?? {
          schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
          revision: 0,
          tradeId: payload.tradeId,
          role: decision.role,
          localProtocolPubkey: key!.publicKeyHex,
          counterpartyProtocolPubkey: decision.counterpartyPubkey,
          mintUrl: profile.mintUrl,
          sellerLocktimeSecs: Math.floor(
            new Date(payload.sellerLocktime).getTime() / 1000,
          ),
          buyerLocktimeSecs: Math.floor(
            new Date(payload.buyerLocktime).getTime() / 1000,
          ),
          ephemeralKeyHandle: {
            keyId,
            tradeId: payload.tradeId,
            role: decision.role,
            localProtocolPubkey: key!.publicKeyHex,
            counterpartyProtocolPubkey: decision.counterpartyPubkey,
            mintUrl: profile.mintUrl,
            sellerLocktimeSecs: Math.floor(
              new Date(payload.sellerLocktime).getTime() / 1000,
            ),
            buyerLocktimeSecs: Math.floor(
              new Date(payload.buyerLocktime).getTime() / 1000,
            ),
          },
          stage: 'intent',
          expectedProofOperations: [],
          proofOperations: [],
          receivedCiphers: {},
          outboundCiphers: {},
        }
    }
    return record
    },
  )
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
  return updateState(
    { swapIds: [tradeId], tradeIds: [tradeId] },
    (state, now) => {
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
      journalDurableCipher(
        state.durableTradeSessions[tradeId],
        'receivedCiphers',
        messageType,
        ciphertext,
      )
    return next
    },
  )
}

/** Journals the exact outbound ciphertext before transport delivery is attempted. */
export async function journalOutboundSwapCipher(
  tradeId: string,
  messageType: string,
  ciphertext: string,
): Promise<void> {
  await updateState({ tradeIds: [tradeId] }, (state) => {
    journalDurableCipher(
      state.durableTradeSessions[tradeId],
      'outboundCiphers',
      messageType,
      ciphertext,
    )
  })
}

function journalDurableCipher(
  session: DurableTradeSession | undefined,
  journal: 'receivedCiphers' | 'outboundCiphers',
  messageType: string,
  ciphertext: string,
): void {
  if (!session) {
    throw new Error(
      'Cannot journal protected swap ciphertext without a durable trade session',
    )
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
  if (
    existing &&
    (existing.ciphertext !== ciphertext || existing.sha256 !== sha256)
  ) {
    throw new Error(
      `Durable trade ${session.tradeId} has conflicting ${journal} ${messageType} ciphertext`,
    )
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
  return updateState({ swapIds: [tradeId] }, (state, now) => {
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
    'version',
    'wallet',
    'proofOperations',
    'durableTradeSessions',
    'orders',
    'swaps',
  ])
  if (root.version !== 1)
    throw new Error('daemon SQLite state schema is unsupported')

  const wallet = requireStateRecord(root.wallet, 'state wallet')
  requireStateFields(wallet, ['proofs', 'keysetCounters'])
  if (!Array.isArray(wallet.proofs))
    throw new Error('daemon SQLite wallet proofs are invalid')
  const walletProofs = wallet.proofs.map((proof) =>
    decodeStoredProofRecord(proof),
  )
  const walletProofKeys = new Set<string>()
  for (const proof of walletProofs) {
    const key = walletProofStorageKey(proof)
    if (walletProofKeys.has(key)) {
      throw new Error('daemon SQLite wallet proof identity is duplicated')
    }
    walletProofKeys.add(key)
  }
  const proofOperations = decodeStoredProofOperations(root.proofOperations)
  const durableTradeSessions = decodeDurableTradeSessions(
    root.durableTradeSessions,
  )
  const operationsByDurableId = new Map<string, ProofOperationRecord>()

  for (const operation of Object.values(proofOperations)) {
    if (!operation.durableTradeRecovery) continue
    const session = durableTradeSessions[operation.durableTradeRecovery.tradeId]
    if (!session)
      throw new Error('daemon durable proof operation session is missing')
    const bindingError = validateDaemonDurableOperationBinding({
      session,
      record: operation,
      operation: operation.durableTradeRecovery,
    })
    if (bindingError)
      throw new Error(
        `daemon durable proof operation is invalid: ${bindingError}`,
      )
    if (operationsByDurableId.has(operation.durableTradeRecovery.operationId)) {
      throw new Error('daemon durable proof operation identity is duplicated')
    }
    operationsByDurableId.set(
      operation.durableTradeRecovery.operationId,
      operation,
    )
  }
  for (const session of Object.values(durableTradeSessions)) {
    for (const link of session.proofOperations) {
      const operation = operationsByDurableId.get(link.operationId)
      if (
        !operation ||
        operation.durableTradeRecovery?.tradeId !== session.tradeId
      ) {
        throw new Error('daemon durable session proof operation is missing')
      }
    }
  }

  return {
    version: 1,
    wallet: {
      proofs: walletProofs,
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
  requireStateFields(
    record,
    [
      'proof',
      'mintUrl',
      'unit',
      'state',
      'asset',
      'reservedBy',
      'createdAt',
      'updatedAt',
    ],
    ['reservedBy'],
  )
  const state = record.state
  if (state !== 'available' && state !== 'reserved' && state !== 'locked') {
    throw new Error('stored proof state is invalid')
  }
  const reservedBy = optionalNonEmptyString(
    record.reservedBy,
    'stored proof reservation',
  )
  const proof = decodeCashuProofRecord(record.proof, 'stored proof')
  if (proof.id === undefined) throw new Error('stored proof keyset is missing')
  if (
    (proof.conditionId === undefined) !==
    (proof.outcomeCollection === undefined)
  ) {
    throw new Error('stored proof condition metadata is incomplete')
  }
  if (
    state === 'available' ? reservedBy !== undefined : reservedBy === undefined
  ) {
    throw new Error('stored proof reservation state is invalid')
  }
  const unit = parseCashuProofUnit(
    typeof record.unit === 'string' ? record.unit : undefined,
  )
  if (unit === null) throw new Error('stored proof unit is invalid')
  const asset = decodeStoredProofAsset(record.asset)
  if (!isCollateralUnitOf(unit, asset.baseAsset)) {
    throw new Error('stored proof unit does not match its base asset')
  }
  return {
    proof,
    mintUrl: requireNonEmptyString(record.mintUrl, 'stored proof mint'),
    unit,
    state,
    asset,
    ...(reservedBy ? { reservedBy } : {}),
    createdAt: requireNonEmptyString(
      record.createdAt,
      'stored proof created time',
    ),
    updatedAt: requireNonEmptyString(
      record.updatedAt,
      'stored proof updated time',
    ),
  }
}

function decodeStoredProofAsset(value: unknown): StoredProofAsset {
  const asset = requireStateRecord(value, 'stored proof asset')
  if (asset.kind === 'sats') {
    requireStateFields(asset, ['kind', 'baseAsset'])
    return {
      kind: 'sats',
      baseAsset: requireNonEmptyString(
        asset.baseAsset,
        'stored proof base asset',
      ),
    }
  }
  if (asset.kind === 'Outcome') {
    requireStateFields(
      asset,
      ['kind', 'conditionId', 'outcomeSetId', 'baseAsset'],
    )
    return {
      kind: 'Outcome',
      conditionId: requireNonEmptyString(
        asset.conditionId,
        'stored proof condition',
      ),
      outcomeSetId: requireNonEmptyString(
        asset.outcomeSetId,
        'stored proof outcome set',
      ),
      baseAsset: requireNonEmptyString(
        asset.baseAsset,
        'stored proof base asset',
      ),
    }
  }
  throw new Error('stored proof asset is invalid')
}

function decodeCashuProofRecord(
  value: unknown,
  name: string,
): CashuProofRecord {
  const proof = requireStateRecord(value, name)
  requireStateFields(
    proof,
    [
      'id',
      'amount',
      'secret',
      'C',
      'witness',
      'dleq',
      'conditionId',
      'outcomeCollection',
    ],
    ['id', 'witness', 'dleq', 'conditionId', 'outcomeCollection'],
  )
  if (
    typeof proof.amount !== 'number' ||
    !Number.isSafeInteger(proof.amount) ||
    proof.amount < 0
  ) {
    throw new Error(`${name} amount is invalid`)
  }
  return {
    ...(proof.id === undefined
      ? {}
      : { id: requireNonEmptyString(proof.id, `${name} keyset`) }),
    amount: proof.amount,
    secret: requireNonEmptyString(proof.secret, `${name} secret`),
    C: requireNonEmptyString(proof.C, `${name} signature`),
    ...(proof.witness === undefined
      ? {}
      : { witness: structuredClone(proof.witness) }),
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.conditionId === undefined
      ? {}
      : {
          conditionId: requireNonEmptyString(
            proof.conditionId,
            `${name} condition`,
          ),
        }),
    ...(proof.outcomeCollection === undefined
      ? {}
      : {
          outcomeCollection: requireNonEmptyString(
            proof.outcomeCollection,
            `${name} outcome collection`,
          ),
        }),
  }
}

function decodeCounterMap(value: unknown): Record<string, number> {
  const counters = requireStateRecord(value, 'keyset counters')
  const decoded: Array<[string, number]> = []
  for (const [key, counter] of Object.entries(counters)) {
    if (
      key.length === 0 ||
      typeof counter !== 'number' ||
      !Number.isSafeInteger(counter) ||
      counter < 0
    ) {
      throw new Error('keyset counter is invalid')
    }
    decoded.push([key, counter])
  }
  return Object.fromEntries(decoded)
}

function decodeStoredProofOperations(
  value: unknown,
): Record<string, ProofOperationRecord> {
  const operations = requireStateRecord(value, 'proof operations')
  return Object.fromEntries(
    Object.entries(operations).map(([operationId, raw]) => [
    operationId,
    decodeStoredProofOperation(operationId, raw),
    ]),
  )
}

function decodeStoredProofOperation(
  operationId: string,
  value: unknown,
): ProofOperationRecord {
  const operation = requireStateRecord(value, 'proof operation')
  requireStateFields(
    operation,
    [
      'operationId',
      'durableTradeRecovery',
      'kind',
      'state',
      'mintUrl',
      'inputs',
      'outputs',
      'metadata',
      'resultProofs',
      'lastError',
      'failureCode',
      'createdAt',
      'updatedAt',
    ],
    ['durableTradeRecovery', 'resultProofs', 'lastError', 'failureCode'],
  )
  if (operation.operationId !== operationId || operationId.length === 0) {
    throw new Error('proof operation identity is invalid')
  }
  if (
    !isProofOperationKind(operation.kind) ||
    !isProofOperationState(operation.state)
  ) {
    throw new Error('proof operation lifecycle is invalid')
  }
  if (!Array.isArray(operation.inputs))
    throw new Error('proof operation inputs are invalid')
  const outputs = decodeStoredOutputGroups(operation.outputs)
  const resultProofs =
    operation.resultProofs === undefined
    ? undefined
    : decodeProofRecordGroups(operation.resultProofs)
  if ((operation.state === 'completed') !== (resultProofs !== undefined)) {
    throw new Error('proof operation completion result is invalid')
  }
  if (operation.failureCode !== undefined && operation.state !== 'Failed') {
    throw new Error('proof operation failure code is invalid')
  }
  const durableTradeRecovery =
    operation.durableTradeRecovery === undefined
    ? undefined
    : decodeDurableProofOperationLink(operation.durableTradeRecovery)
  const decoded: ProofOperationRecord = {
    operationId,
    ...(durableTradeRecovery ? { durableTradeRecovery } : {}),
    kind: operation.kind,
    state: operation.state,
    mintUrl: requireNonEmptyString(operation.mintUrl, 'proof operation mint'),
    inputs: operation.inputs.map((proof) =>
      decodeCashuProofRecord(proof, 'proof operation input'),
    ),
    outputs,
    metadata: requireStateRecord(
      operation.metadata,
      'proof operation metadata',
    ),
    ...(resultProofs ? { resultProofs } : {}),
    lastError:
      operation.lastError === undefined || operation.lastError === null
      ? null
      : requireNonEmptyString(operation.lastError, 'proof operation error'),
    ...(operation.failureCode === undefined
      ? {}
      : {
          failureCode: requireTimestamp(
            operation.failureCode,
            'proof operation failure code',
          ),
        }),
    createdAt: requireTimestamp(
      operation.createdAt,
      'proof operation creation time',
    ),
    updatedAt: requireTimestamp(
      operation.updatedAt,
      'proof operation update time',
    ),
  }
  if (decoded.state === 'completed') {
    assertValidCompletedProofOperationResult(
      decoded,
      decoded.resultProofs ?? {},
    )
  }
  return decoded
}

function decodeDurableProofOperationLink(
  value: unknown,
): DurableTradeProofOperationLink {
  const operation = value as DurableTradeProofOperationLink
  const error = validateDurableProofOperationLink(operation)
  if (error)
    throw new Error(`durable proof operation link is invalid: ${error}`)
  return structuredClone(operation)
}

function decodeStoredOutputGroups(
  value: unknown,
): Record<string, StoredOutputData[]> {
  const groups = requireStateRecord(value, 'proof operation outputs')
  return Object.fromEntries(
    Object.entries(groups).map(([label, outputs]) => {
      if (label.length === 0 || !Array.isArray(outputs))
        throw new Error('proof operation outputs are invalid')
    return [label, outputs.map((output) => decodeStoredOutputData(output))]
    }),
  )
}

function decodeStoredOutputData(value: unknown): StoredOutputData {
  const output = requireStateRecord(value, 'stored output data')
  requireStateFields(output, ['blindedMessage', 'blindingFactor', 'secret'])
  const blindedMessage = requireStateRecord(
    output.blindedMessage,
    'stored blinded message',
  )
  requireStateFields(blindedMessage, ['amount', 'id', 'B_'])
  if (
    typeof blindedMessage.amount !== 'number' ||
    !Number.isSafeInteger(blindedMessage.amount) ||
    blindedMessage.amount < 0
  ) {
    throw new Error('stored blinded message amount is invalid')
  }
  return {
    blindedMessage: {
      amount: blindedMessage.amount,
      id: requireNonEmptyString(
        blindedMessage.id,
        'stored blinded message keyset',
      ),
      B_: requireNonEmptyString(
        blindedMessage.B_,
        'stored blinded message point',
      ),
    },
    blindingFactor: requireNonEmptyString(
      output.blindingFactor,
      'stored output blinding factor',
    ),
    secret: requireNonEmptyString(output.secret, 'stored output secret'),
  }
}

function decodeProofRecordGroups(
  value: unknown,
): Record<string, CashuProofRecord[]> {
  const groups = requireStateRecord(value, 'proof operation result proofs')
  return Object.fromEntries(
    Object.entries(groups).map(([label, proofs]) => {
      if (label.length === 0 || !Array.isArray(proofs))
        throw new Error('proof operation result proofs are invalid')
      return [
        label,
        proofs.map((proof) =>
          decodeCashuProofRecord(proof, 'proof operation result proof'),
        ),
      ]
    }),
  )
}

function decodeDurableTradeSessions(
  value: unknown,
): Record<string, DurableTradeSession> {
  const sessions = requireStateRecord(value, 'durable trade sessions')
  return Object.fromEntries(
    Object.entries(sessions).map(([tradeId, raw]) => {
    const session = raw as DurableTradeSession
    const error = validateDurableTradeSession(session)
    if (error || session.tradeId !== tradeId || tradeId.length === 0) {
        throw new Error(
          `durable trade session is invalid: ${error ?? 'session identity is invalid'}`,
        )
    }
    return [tradeId, structuredClone(session)]
    }),
  )
}

function decodeLocalOrders(value: unknown): Record<string, LocalOrderRecord> {
  const orders = requireStateRecord(value, 'local orders')
  return Object.fromEntries(
    Object.entries(orders).map(([orderId, raw]) => {
    const order = requireStateRecord(raw, 'local order')
      requireStateFields(
        order,
        [
          'orderId',
          'marketId',
          'tokenSide',
          'side',
          'priceSubunits',
          'amountSubunits',
          'timeInForce',
          'recoveryAttempt',
          'status',
          'ephemeralPubkey',
          'clientOrderId',
          'preflightSplit',
          'baseAsset',
          'divisibility',
          'tradeIds',
      'engineStatus',
          'createdAt',
          'updatedAt',
        ],
        [
          'tokenSide',
          'side',
          'priceSubunits',
          'amountSubunits',
          'timeInForce',
          'recoveryAttempt',
          'ephemeralPubkey',
          'clientOrderId',
          'preflightSplit',
          'baseAsset',
          'divisibility',
          'engineStatus',
        ],
      )
      if (order.orderId !== orderId || orderId.length === 0)
        throw new Error('local order is invalid')
    const tradeIds = decodeStringArray(order.tradeIds, 'local order trades')
      if (new Set(tradeIds).size !== tradeIds.length)
        throw new Error('local order trades are invalid')
      return [
        orderId,
        {
      orderId,
      marketId: requireNonEmptyString(order.marketId, 'local order market'),
          ...(order.tokenSide === undefined
            ? {}
            : { tokenSide: decodeTokenSide(order.tokenSide) }),
          ...(order.side === undefined
            ? {}
            : { side: decodeOrderSide(order.side) }),
          ...(order.priceSubunits === undefined
            ? {}
            : {
                priceSubunits: requireTimestamp(
                  order.priceSubunits,
                  'local order price',
                ),
              }),
          ...(order.amountSubunits === undefined
            ? {}
            : {
                amountSubunits: requireTimestamp(
                  order.amountSubunits,
                  'local order amount',
                ),
              }),
          ...(order.timeInForce === undefined
            ? {}
            : { timeInForce: decodeTimeInForce(order.timeInForce) }),
          ...(order.recoveryAttempt === undefined
            ? {}
            : {
                recoveryAttempt: requireTimestamp(
                  order.recoveryAttempt,
                  'local order recovery attempt',
                ),
              }),
      status: requireNonEmptyString(order.status, 'local order status'),
          ...(order.ephemeralPubkey === undefined
            ? {}
            : {
                ephemeralPubkey: requireNonEmptyString(
                  order.ephemeralPubkey,
                  'local order ephemeral key',
                ),
              }),
          ...(order.clientOrderId === undefined
            ? {}
            : {
                clientOrderId: requireNonEmptyString(
                  order.clientOrderId,
                  'local order client id',
                ),
              }),
          ...(order.preflightSplit === undefined
            ? {}
            : { preflightSplit: decodePreflightSplit(order.preflightSplit) }),
      ...(order.baseAsset === undefined || order.baseAsset === null
        ? {}
            : {
                baseAsset: requireNonEmptyString(
                  order.baseAsset,
                  'local order base asset',
                ),
              }),
          ...(order.divisibility === undefined
            ? {}
            : {
                divisibility: requirePositiveInteger(
                  order.divisibility,
                  'local order divisibility',
                ),
              }),
      tradeIds,
          ...(order.engineStatus === undefined
            ? {}
            : { engineStatus: structuredClone(order.engineStatus) }),
          createdAt: requireNonEmptyString(
            order.createdAt,
            'local order creation time',
          ),
          updatedAt: requireNonEmptyString(
            order.updatedAt,
            'local order update time',
          ),
        } satisfies LocalOrderRecord,
      ] as const
    }),
  )
}

function decodeLocalSwaps(value: unknown): Record<string, LocalSwapRecord> {
  const swaps = requireStateRecord(value, 'local swaps')
  return Object.fromEntries(
    Object.entries(swaps).map(([tradeId, raw]) => {
    const swap = requireStateRecord(raw, 'local swap')
      requireStateFields(
        swap,
        [
          'tradeId',
          'marketId',
          'orderId',
          'role',
          'counterpartyPubkey',
          'sellerLocktime',
          'buyerLocktime',
          'fillAmountSats',
          'fillAmountSubunits',
          'outcomeFaceAmountSats',
          'outcomeFaceAmountSubunits',
          'quotePaymentSats',
          'baseAsset',
          'divisibility',
          'quotePaymentSubunits',
          'settlementKind',
          'sellerKeepOutcomeSetId',
          'sellerLockOutcomeSetId',
          'isTaker',
          'messages',
          'sellerAdaptorSecretHex',
          'sellerAdaptorPointHex',
          'buyerPreSigsHex',
          'buyerLockedProofs',
          'sellerPreSigsHex',
          'engineState',
          'failureReason',
          'takerRecovery',
          'step',
          'error',
          'failure',
          'createdAt',
          'updatedAt',
        ],
        [
          'marketId',
          'orderId',
          'role',
          'counterpartyPubkey',
          'sellerLocktime',
          'buyerLocktime',
          'fillAmountSats',
          'fillAmountSubunits',
          'outcomeFaceAmountSats',
          'outcomeFaceAmountSubunits',
          'quotePaymentSats',
          'baseAsset',
          'divisibility',
          'quotePaymentSubunits',
          'settlementKind',
          'sellerKeepOutcomeSetId',
          'sellerLockOutcomeSetId',
          'isTaker',
          'sellerAdaptorSecretHex',
          'sellerAdaptorPointHex',
          'buyerPreSigsHex',
          'buyerLockedProofs',
          'sellerPreSigsHex',
          'engineState',
          'failureReason',
          'takerRecovery',
          'error',
          'failure',
        ],
      )
      if (swap.tradeId !== tradeId || tradeId.length === 0)
        throw new Error('local swap is invalid')
      return [
      tradeId,
        {
          tradeId,
          ...(swap.marketId === undefined
            ? {}
            : {
                marketId: requireNonEmptyString(
                  swap.marketId,
                  'local swap market',
                ),
              }),
          ...(swap.orderId === undefined
            ? {}
            : {
                orderId: requireNonEmptyString(
                  swap.orderId,
                  'local swap order',
                ),
              }),
          ...(swap.role === undefined
            ? {}
            : { role: decodeSwapRole(swap.role) }),
          ...(swap.counterpartyPubkey === undefined
            ? {}
            : {
                counterpartyPubkey: requireHex(
                  swap.counterpartyPubkey,
                  'local swap counterparty key',
                ),
              }),
      ...decodeOptionalSwapIntegers(swap),
      ...(swap.baseAsset === undefined || swap.baseAsset === null
        ? {}
            : {
                baseAsset: requireNonEmptyString(
                  swap.baseAsset,
                  'local swap base asset',
                ),
              }),
      ...(swap.settlementKind === undefined || swap.settlementKind === null
        ? {}
        : { settlementKind: decodeSettlementKind(swap.settlementKind) }),
          ...(swap.sellerKeepOutcomeSetId === undefined ||
          swap.sellerKeepOutcomeSetId === null
            ? {}
            : {
                sellerKeepOutcomeSetId: requireNonEmptyString(
                  swap.sellerKeepOutcomeSetId,
                  'local swap keep outcome',
                ),
              }),
          ...(swap.sellerLockOutcomeSetId === undefined ||
          swap.sellerLockOutcomeSetId === null
        ? {}
            : {
                sellerLockOutcomeSetId: requireNonEmptyString(
                  swap.sellerLockOutcomeSetId,
                  'local swap lock outcome',
                ),
              }),
          ...(swap.isTaker === undefined
        ? {}
            : {
                isTaker: requireBoolean(swap.isTaker, 'local swap taker flag'),
              }),
      messages: decodeSwapMessages(swap.messages),
          ...(swap.sellerAdaptorSecretHex === undefined
            ? {}
            : {
                sellerAdaptorSecretHex: requireHex(
                  swap.sellerAdaptorSecretHex,
                  'local swap adaptor secret',
                ),
              }),
          ...(swap.sellerAdaptorPointHex === undefined
            ? {}
            : {
                sellerAdaptorPointHex: requireHex(
                  swap.sellerAdaptorPointHex,
                  'local swap adaptor point',
                ),
              }),
          ...(swap.buyerPreSigsHex === undefined
            ? {}
            : {
                buyerPreSigsHex: decodeHexArray(
                  swap.buyerPreSigsHex,
                  'local swap buyer pre-signatures',
                ),
              }),
          ...(swap.buyerLockedProofs === undefined
            ? {}
            : {
                buyerLockedProofs: decodeCashuProofArray(
                  swap.buyerLockedProofs,
                  'local swap buyer locked proofs',
                ),
              }),
          ...(swap.sellerPreSigsHex === undefined
            ? {}
            : {
                sellerPreSigsHex: decodeHexArray(
                  swap.sellerPreSigsHex,
                  'local swap seller pre-signatures',
                ),
              }),
          ...(swap.engineState === undefined
            ? {}
            : {
                engineState: requireNonEmptyString(
                  swap.engineState,
                  'local swap engine state',
                ),
              }),
          ...(swap.failureReason === undefined
            ? {}
            : {
                failureReason: requireNonEmptyString(
                  swap.failureReason,
                  'local swap failure reason',
                ),
              }),
          ...(swap.takerRecovery === undefined
            ? {}
            : { takerRecovery: decodeTakerRecovery(swap.takerRecovery) }),
      step: decodeSwapStep(swap.step),
          ...(swap.error === undefined
            ? {}
            : { error: requireNonEmptyString(swap.error, 'local swap error') }),
          ...(swap.failure === undefined
            ? {}
            : { failure: decodeSwapFailure(swap.failure) }),
          createdAt: requireNonEmptyString(
            swap.createdAt,
            'local swap creation time',
          ),
          updatedAt: requireNonEmptyString(
            swap.updatedAt,
            'local swap update time',
          ),
        } satisfies LocalSwapRecord,
      ] as const
    }),
  )
}

function requireStateRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value))
    throw new Error(`${name} is invalid`)
  return value
}

function requireStateFields(
  record: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key))
      throw new Error(`unknown daemon SQLite state field '${key}'`)
  }
  for (const key of expected) {
    if (!optional.includes(key) && !(key in record)) {
      throw new Error(`missing daemon SQLite state field '${key}'`)
    }
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} is invalid`)
  return value
}

function optionalNonEmptyString(
  value: unknown,
  name: string,
): string | undefined {
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
  return (
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
}

function decodeTokenSide(
  value: unknown,
): NonNullable<LocalOrderRecord['tokenSide']> {
  if (value === 'Outcome' || value === 'Complement') return value
  throw new Error('local order token side is invalid')
}

function decodeOrderSide(
  value: unknown,
): NonNullable<LocalOrderRecord['side']> {
  if (value === 'Buy' || value === 'Sell') return value
  throw new Error('local order side is invalid')
}

function decodeTimeInForce(
  value: unknown,
): NonNullable<LocalOrderRecord['timeInForce']> {
  if (value === 'FAK' || value === 'FOK' || value === 'GTC') return value
  throw new Error('local order time in force is invalid')
}

function decodePreflightSplit(value: unknown): LocalOrderPreflightSplit {
  const split = requireStateRecord(value, 'local order preflight split')
  requireStateFields(split, [
    'reservationId',
    'conditionId',
    'keepOutcomeSetId',
    'lockOutcomeSetId',
    'amountSats',
  ])
  return {
    reservationId: requireNonEmptyString(
      split.reservationId,
      'local order preflight reservation',
    ),
    conditionId: requireNonEmptyString(
      split.conditionId,
      'local order preflight condition',
    ),
    keepOutcomeSetId: requireNonEmptyString(
      split.keepOutcomeSetId,
      'local order preflight keep outcome',
    ),
    lockOutcomeSetId: requireNonEmptyString(
      split.lockOutcomeSetId,
      'local order preflight lock outcome',
    ),
    amountSats: requirePositiveInteger(
      split.amountSats,
      'local order preflight amount',
    ),
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

function decodeOptionalSwapIntegers(
  swap: Record<string, unknown>,
): Partial<LocalSwapRecord> {
  const names = [
    'sellerLocktime',
    'buyerLocktime',
    'fillAmountSats',
    'fillAmountSubunits',
    'outcomeFaceAmountSats',
    'outcomeFaceAmountSubunits',
    'quotePaymentSats',
    'divisibility',
    'quotePaymentSubunits',
  ] as const
  const decoded: Partial<LocalSwapRecord> = {}
  for (const name of names) {
    if (swap[name] !== undefined) {
      ;(decoded as Record<string, number>)[name] =
        name === 'divisibility'
        ? requirePositiveInteger(swap[name], `local swap ${name}`)
        : requireTimestamp(swap[name], `local swap ${name}`)
    }
  }
  return decoded
}

function decodeSwapMessages(value: unknown): LocalSwapRecord['messages'] {
  const messages = requireStateRecord(value, 'local swap messages')
  requireStateFields(
    messages,
    ['adaptorPoint', 'lockedProofsSeller', 'lockedProofsBuyer'],
    ['adaptorPoint', 'lockedProofsSeller', 'lockedProofsBuyer'],
  )
  return {
    ...(messages.adaptorPoint === undefined
      ? {}
      : {
          adaptorPoint: requireNonEmptyString(
            messages.adaptorPoint,
            'local swap adaptor cipher',
          ),
        }),
    ...(messages.lockedProofsSeller === undefined
      ? {}
      : {
          lockedProofsSeller: requireNonEmptyString(
            messages.lockedProofsSeller,
            'local swap seller cipher',
          ),
        }),
    ...(messages.lockedProofsBuyer === undefined
      ? {}
      : {
          lockedProofsBuyer: requireNonEmptyString(
            messages.lockedProofsBuyer,
            'local swap buyer cipher',
          ),
        }),
  }
}

function decodeHexArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value.map((entry) => requireNonEmptyString(entry, name))
}

function decodeCashuProofArray(
  value: unknown,
  name: string,
): CashuProofRecord[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value.map((proof) => decodeCashuProofRecord(proof, name))
}

function decodeTakerRecovery(
  value: unknown,
): NonNullable<LocalSwapRecord['takerRecovery']> {
  const recovery = requireStateRecord(value, 'local swap taker recovery')
  requireStateFields(
    recovery,
    ['clientOrderId', 'status', 'replacementOrderId'],
    ['replacementOrderId'],
  )
  if (recovery.status !== 'pending' && recovery.status !== 'submitted') {
    throw new Error('local swap taker recovery is invalid')
  }
  return {
    clientOrderId: requireNonEmptyString(
      recovery.clientOrderId,
      'local swap replacement client id',
    ),
    status: recovery.status,
    ...(recovery.replacementOrderId === undefined
      ? {}
      : {
          replacementOrderId: requireNonEmptyString(
            recovery.replacementOrderId,
            'local swap replacement order id',
          ),
        }),
  }
}

function decodeSwapFailure(
  value: unknown,
): SwapFailure | PartialLockHeldRecord {
  const failure = requireStateRecord(value, 'local swap failure')
  const common = ['kind', 'refundLocktime', 'affectedKeysets', 'detail']
  if (failure.kind === 'PartialLockHeld') {
    requireStateFields(
      failure,
      [
        ...common,
        'tradeId',
        'orderId',
        'mintUrl',
        'outcomeByKeyset',
        'lockedProofs',
        'createdAt',
      ],
      [
        'tradeId',
        'orderId',
        'mintUrl',
        'outcomeByKeyset',
        'lockedProofs',
        'createdAt',
      ],
    )
    const base: PartialLockHeldRecord = {
      kind: 'PartialLockHeld',
      tradeId:
        failure.tradeId === undefined || failure.tradeId === ''
        ? ''
          : requireNonEmptyString(
              failure.tradeId,
              'local partial lock trade id',
            ),
      refundLocktime: requireTimestamp(
        failure.refundLocktime,
        'local partial lock refund time',
      ),
      affectedKeysets: decodeStringArray(
        failure.affectedKeysets,
        'local partial lock keysets',
      ),
      detail: requireNonEmptyString(
        failure.detail,
        'local partial lock detail',
      ),
      outcomeByKeyset:
        failure.outcomeByKeyset === undefined
        ? {}
        : decodeOutcomeByKeyset(failure.outcomeByKeyset),
      lockedProofs:
        failure.lockedProofs === undefined
        ? []
          : decodeCashuProofArray(
              failure.lockedProofs,
              'local partial lock proofs',
            ),
      ...(failure.orderId === undefined
        ? {}
        : {
            orderId: requireNonEmptyString(
              failure.orderId,
              'local partial lock order id',
            ),
          }),
      ...(failure.mintUrl === undefined
        ? {}
        : {
            mintUrl: requireNonEmptyString(
              failure.mintUrl,
              'local partial lock mint',
            ),
          }),
      ...(failure.createdAt === undefined
        ? {}
        : {
            createdAt: requireTimestamp(
              failure.createdAt,
              'local partial lock creation time',
            ),
          }),
    }
    return base
  }
  if (
    failure.kind !== 'InsufficientInventory' &&
    failure.kind !== 'MintError' &&
    failure.kind !== 'EngineRejected'
  ) {
    throw new Error('local swap failure is invalid')
  }
  requireStateFields(failure, common, ['refundLocktime', 'affectedKeysets'])
  return {
    kind: failure.kind,
    detail: requireNonEmptyString(failure.detail, 'local swap failure detail'),
    ...(failure.refundLocktime === undefined
      ? {}
      : {
          refundLocktime: requireTimestamp(
            failure.refundLocktime,
            'local swap refund time',
          ),
        }),
    ...(failure.affectedKeysets === undefined
      ? {}
      : {
          affectedKeysets: decodeStringArray(
            failure.affectedKeysets,
            'local swap failure keysets',
          ),
        }),
  }
}

function decodeOutcomeByKeyset(
  value: unknown,
): PartialLockHeldRecord['outcomeByKeyset'] {
  const mappings = requireStateRecord(
    value,
    'local partial lock keyset outcomes',
  )
  return Object.fromEntries(
    Object.entries(mappings).map(([keysetId, raw]) => {
      const metadata = requireStateRecord(
        raw,
        'local partial lock outcome metadata',
      )
      requireStateFields(metadata, [
        'conditionId',
        'outcomeCollection',
        'marketId',
      ])
    return [
      requireNonEmptyString(keysetId, 'local partial lock keyset'),
      {
          conditionId: requireNonEmptyString(
            metadata.conditionId,
            'local partial lock condition',
          ),
          outcomeCollection: requireNonEmptyString(
            metadata.outcomeCollection,
            'local partial lock outcome',
          ),
          marketId: requireNonEmptyString(
            metadata.marketId,
            'local partial lock market',
          ),
      },
    ]
    }),
  )
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
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2 !== 0)
    throw new Error(`${name} is invalid`)
  return text
}

function normalizeProofAsset(
  asset: StoredProofAsset | undefined,
): StoredProofAsset {
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
  return (
    asset?.kind === 'Outcome' ||
    (asset as { kind?: unknown } | undefined)?.kind === 'outcome'
  )
}

function normalizeProofAssetBaseAsset(
  asset: StoredProofAsset | undefined,
): string {
  return normalizeMarketBaseAsset(asset?.baseAsset)
}

export function assertCompatibleProofOperation(
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

export function normalizeProofRecordGroups(
  groups: Record<string, CashuProofRecord[]>,
): Record<string, CashuProofRecord[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, proofs]) => [
      label,
      proofs.map(normalizeCashuProofRecord),
    ]),
  )
}

export function assertValidCompletedProofOperationResult(
  operation: Pick<ProofOperationRecord, 'kind' | 'outputs' | 'metadata'>,
  resultProofs: Record<string, CashuProofRecord[]>,
): void {
  const outputCounts = Object.fromEntries(
    Object.entries(operation.outputs).map(([label, outputs]) => [
      label,
      outputs.length,
    ]),
  )
  const outputLabels = Object.keys(outputCounts).sort()
  const unselectedProofCount = Array.isArray(
    operation.metadata.unselectedProofs,
  )
    ? operation.metadata.unselectedProofs.length
    : -1
  let expectedCounts: Record<string, number>
  let requiresUnselectedProofs = false
  switch (operation.kind) {
    case 'swap-lock':
    case 'proof-split':
    case 'regular-split':
    case 'wallet-send':
      requiresUnselectedProofs = true
      assertCompletedOutputLabels(outputLabels, ['keep', 'send'])
      expectedCounts = {
        send: outputCounts.send ?? 0,
        keep: (outputCounts.keep ?? 0) + unselectedProofCount,
      }
      break
    case 'swap-claim':
      assertCompletedOutputLabels(outputLabels, ['keep'])
      expectedCounts = {
        keep: outputCounts.keep ?? 0,
      }
      break
    case 'conditional-keyset-swap':
    case 'ctf-split':
    case 'ctf-consolidation':
      if (
        outputLabels.length === 0 ||
        outputLabels.some((label) => outputCounts[label] === 0)
      ) {
        throw new Error('proof operation completed result groups are invalid')
      }
      expectedCounts = outputCounts
      break
    case 'ctf-merge':
      assertCompletedOutputLabels(outputLabels, ['*'])
      expectedCounts = { regular: outputCounts['*'] ?? 0 }
      break
    case 'ctf-redeem':
      assertCompletedOutputLabels(outputLabels, ['regular'])
      expectedCounts = { regular: outputCounts.regular ?? 0 }
      break
    case 'swap-refund': {
      assertCompletedOutputLabels(outputLabels, ['refund'])
      const labels = Object.keys(resultProofs)
      if (labels.length !== 1 || labels[0] !== 'refund') {
        throw new Error('proof operation completed result groups are invalid')
      }
      if (resultProofs.refund.length === 0) {
        throw new Error('proof operation completed result counts are invalid')
      }
      if (resultProofs.refund.length !== outputCounts.refund) {
        throw new Error('proof operation completed result counts are invalid')
      }
      return
    }
    default: {
      const exhaustiveKind: never = operation.kind
      throw new Error(`Unsupported proof operation kind ${exhaustiveKind}`)
    }
  }

  const actualLabels = Object.keys(resultProofs).sort()
  const expectedLabels = Object.keys(expectedCounts).sort()
  if (!isDeepStrictEqual(actualLabels, expectedLabels)) {
    throw new Error('proof operation completed result groups are invalid')
  }
  if (
    (requiresUnselectedProofs && unselectedProofCount < 0) ||
    expectedLabels.some(
      (label) =>
        resultProofs[label].length !== expectedCounts[label] ||
        (label !== 'keep' && resultProofs[label].length === 0),
    )
  ) {
    throw new Error('proof operation completed result counts are invalid')
  }
}

function assertCompletedOutputLabels(
  actualLabels: readonly string[],
  expectedLabels: readonly string[],
): void {
  if (!isDeepStrictEqual(actualLabels, [...expectedLabels].sort())) {
    throw new Error('proof operation completed result groups are invalid')
  }
}

export function normalizeCashuProofRecord(
  proof: CashuProofRecord,
): CashuProofRecord {
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
  const topLevelTradeId =
    typeof value.tradeId === 'string' && value.tradeId ? [value.tradeId] : []
  return [...fillTradeIds, ...pendingTradeIds, ...topLevelTradeId].filter(
    (tradeId): tradeId is string =>
      typeof tradeId === 'string' && tradeId.length > 0,
  )
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
  return (
    value === 'prepared' ||
    value === 'mint-submitted' ||
    value === 'completed' ||
    value === 'Failed'
  )
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
    const orderEphemeralPubkey = readStringProperty(order, 'ephemeralPubkey')
    const matchedEphemeralPubkey =
      ownEphemeralPubkey ?? orderEphemeralPubkey ?? undefined
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
      orderEphemeralPubkey &&
      isOrderEphemeralForTrade(orderEphemeralPubkey, payload) &&
      orderMarketMatchesTradeCreated(order, payload, orderEphemeralPubkey)
    ) {
      fallbackMatches.push({
        orderId: order.orderId,
        marketId: order.marketId,
        ownEphemeralPubkey: orderEphemeralPubkey,
      })
    }
      }
  if (exactOrderCount > 1) {
    throw new Error(
      `TradeCreated ${payload.tradeId} matches multiple exact local orders`,
    )
    }
  if (exactOrderCount === 1 && exactMatches.length === 0) {
    throw new Error(
      `TradeCreated ${payload.tradeId} exact local order has no protocol key`,
    )
  }
  if (exactMatches.length === 1) return exactMatches[0]!
  if (fallbackMatches.length > 1) {
    throw new Error(
      `TradeCreated ${payload.tradeId} has ambiguous local order fallback`,
    )
  }
  return fallbackMatches[0] ?? null
}

function isOrderEphemeralForTrade(
  orderEphemeralPubkey: string,
  payload: DaemonTradeCreatedPayload,
): boolean {
  return (
    orderEphemeralPubkey === payload.sellerPubkey ||
    orderEphemeralPubkey === payload.buyerPubkey
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
  if (order.tokenSide === 'Complement')
    return order.marketId === sellerKeepMarketId
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
