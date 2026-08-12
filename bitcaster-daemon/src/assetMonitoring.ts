import type { DatabaseSync } from 'node:sqlite'
import {
  buildAssetMonitoringHoldingsFromProofFacts,
  computeAssetMonitoringOutcomeUniverseDigest,
  type AssetMonitoringAssetReference,
  type AssetMonitoringProofFact,
  type AssetMonitoringReportedHolding,
  AssetMonitoringReporter,
  fetchAssetMonitoringCatalogue,
  type AssetMonitoringReporterRemote,
} from '@bitcaster-market/client-sdk'
import { decodeCanonicalMintOrigin } from '@bitcaster-market/client-sdk/durableCustody'
import { parseCashuProofUnit } from '@bitcaster-market/client-sdk/marketUnits'
import { canonicalizeOutcomeSet } from '@bitcaster-market/client-sdk/outcomeSets'
import {
  createDaemonStateSqliteSession,
  subscribeToDaemonWalletHoldingsCommits,
  type DaemonStateSqliteSession,
} from './stateSqlite.ts'

const ROOT_CONDITION_ID = '0'.repeat(64)
const CONDITION_ID = /^[0-9a-f]{64}$/

export interface DaemonAssetMonitoringOptions {
  readonly directory: string
  readonly scopeId: string
  readonly walletId: string
  readonly engineBaseUrl: string
  readonly remote: AssetMonitoringReporterRemote
  readonly fetchImpl?: typeof fetch
  readonly hasPendingSubmittedOrder?: () => Promise<boolean>
  /** Test seam. Production uses the profile-scoped SQLite session. */
  readonly storage?: DaemonStateSqliteSession
  /** Test seam. Production observes only this profile database. */
  readonly subscribeToCommits?: (callback: () => void) => () => void
}

export interface DaemonAssetMonitoring {
  start(): void
  stop(): void
}

/**
 * Reports display-only metadata after commits. It does not own, mutate, or
 * recover custody state. It reads only bounded proof metadata.
 */
export function createDaemonAssetMonitoring(
  options: DaemonAssetMonitoringOptions,
): DaemonAssetMonitoring {
  const storage = options.storage ?? createDaemonStateSqliteSession(options.directory)
  const buildHoldings = createCachedHoldingsBuilder(storage, options)
  let stopped = false
  let unsubscribe: (() => void) | undefined
  const reporter = new AssetMonitoringReporter({
    walletId: options.walletId,
    remote: options.remote,
    buildHoldings,
    hasPendingSubmittedOrder:
      options.hasPendingSubmittedOrder ??
      (() => hasPendingSubmittedOrder(storage, options.scopeId)),
    isCurrent: () => !stopped,
  })
  return {
    start: () => {
      if (stopped || unsubscribe !== undefined) return
      unsubscribe =
        options.subscribeToCommits?.(() => reporter.request()) ??
        subscribeToDaemonWalletHoldingsCommits(options.directory, () => reporter.request())
      reporter.request()
    },
    stop: () => {
      if (stopped) return
      stopped = true
      reporter.stop()
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}

function createCachedHoldingsBuilder(
  storage: DaemonStateSqliteSession,
  options: Pick<DaemonAssetMonitoringOptions, 'scopeId' | 'engineBaseUrl' | 'fetchImpl'>,
): () => Promise<readonly AssetMonitoringReportedHolding[] | null> {
  let cachedRows = ''
  let cachedHoldings: readonly AssetMonitoringReportedHolding[] | undefined
  return async () => {
    const rows = await storage.read((database) => readMonitoringRows(database, options.scopeId))
    const rowsKey = JSON.stringify(rows)
    if (cachedHoldings !== undefined && rowsKey === cachedRows) return cachedHoldings
    const holdings = buildAssetMonitoringHoldingsFromProofFacts(await factsFromRows(rows, options))
    cachedRows = rowsKey
    cachedHoldings = holdings
    return holdings
  }
}

async function hasPendingSubmittedOrder(
  storage: DaemonStateSqliteSession,
  scopeId: string,
): Promise<boolean> {
  return storage.read(
    (database) =>
      database
        .prepare(
          `SELECT 1
           FROM daemon_ctf_range_preparations
           WHERE scope_id = ? AND lifecycle_state = 'order-submitted'
           UNION ALL
           SELECT 1
           FROM daemon_orders
           WHERE scope_id = ?
             AND status NOT IN ('Filled', 'filled', 'cancelled', 'expired', 'evicted_capacity',
                                'rejected_capacity', 'Failed', 'failed')
           LIMIT 1`,
        )
        .get(scopeId, scopeId) !== undefined,
  )
}

export async function buildDaemonAssetMonitoringHoldings(
  read: <T>(action: (database: DatabaseSync) => T) => Promise<T>,
  options: Pick<DaemonAssetMonitoringOptions, 'scopeId' | 'engineBaseUrl' | 'fetchImpl'>,
): Promise<readonly AssetMonitoringReportedHolding[] | null> {
  try {
    const rows = await read((database) => readMonitoringRows(database, options.scopeId))
    const facts = await factsFromRows(rows, options)
    return buildAssetMonitoringHoldingsFromProofFacts(facts)
  } catch {
    return null
  }
}

interface MonitoringRow {
  readonly proofId: unknown
  readonly normalizedMint: unknown
  readonly unit: unknown
  readonly keysetId: unknown
  readonly amount: unknown
  readonly baseAsset: unknown
  readonly conditionId: unknown
  readonly outcomeSetId: unknown
  readonly source: unknown
  readonly state: unknown
  readonly selectability: unknown
  readonly nut07State: unknown
}

function readMonitoringRows(database: DatabaseSync, scopeId: string): MonitoringRow[] {
  // This projection deliberately selects no proof_body, secret, signature, or bearer field.
  return database
    .prepare(
      `SELECT proof_id AS proofId, normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
       amount, base_asset AS baseAsset, condition_id AS conditionId, outcome_set_id AS outcomeSetId,
       'target' AS source, state, NULL AS selectability, NULL AS nut07State
       FROM target_wallet_proofs WHERE scope_id = ?
     UNION ALL
     SELECT proof_id AS proofId, normalized_mint AS normalizedMint, unit, keyset_id AS keysetId,
       amount, base_asset AS baseAsset, condition_id AS conditionId, outcome_set_id AS outcomeSetId,
       'custody' AS source, NULL AS state, selectability, nut07_state AS nut07State
       FROM custody_proofs WHERE scope_id = ?
     ORDER BY proofId, source`,
    )
    .all(scopeId, scopeId) as unknown as MonitoringRow[]
}

async function factsFromRows(
  rows: readonly MonitoringRow[],
  options: Pick<DaemonAssetMonitoringOptions, 'engineBaseUrl' | 'fetchImpl'>,
): Promise<AssetMonitoringProofFact[]> {
  const decoded = rows.map(decodeMonitoringRow)
  const current = new Map<string, DecodedMonitoringRow>()
  for (const row of decoded) {
    if (row === null) continue
    const existing = current.get(row.proofId)
    if (existing !== undefined && !sameMetadata(existing, row)) {
      throw new Error('asset-monitoring duplicate proof metadata conflicts')
    }
    current.set(row.proofId, row)
  }
  const conditions = [
    ...new Set(
      [...current.values()].flatMap((row) => (row.conditionId === null ? [] : [row.conditionId])),
    ),
  ]
  const catalogue = await fetchAssetMonitoringCatalogue(conditions, {
    engineBaseUrl: options.engineBaseUrl,
    fetchImpl: options.fetchImpl ?? fetch,
  })
  const byCondition = new Map<string, { readonly outcomes: readonly string[] }>(
    catalogue.map((entry) => [entry.conditionId, entry]),
  )
  return [...current.values()].map((row) => ({
    proofIdentity: row.proofId,
    keysetId: row.keysetId,
    amount: row.amount,
    state: row.state,
    asset: monitoringAsset(row, byCondition),
  }))
}

interface DecodedMonitoringRow {
  readonly proofId: string
  readonly normalizedMint: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly amount: number
  readonly conditionId: string | null
  readonly outcomeSetId: string | null
  readonly state: 'available' | 'pending'
}

function decodeMonitoringRow(row: MonitoringRow): DecodedMonitoringRow | null {
  const amount = row.amount
  if (
    typeof row.proofId !== 'string' ||
    !CONDITION_ID.test(row.proofId) ||
    typeof row.keysetId !== 'string' ||
    row.keysetId.length === 0 ||
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    row.baseAsset !== 'sat'
  )
    throw new Error('asset-monitoring proof metadata is invalid')
  const unit = parseCashuProofUnit(row.unit)
  if (unit === null) throw new Error('asset-monitoring proof unit is invalid')
  const normalizedMint = decodeCanonicalMintOrigin(row.normalizedMint)
  const conditionId = row.conditionId === null ? null : requireConditionId(row.conditionId)
  const outcomeSetId = row.outcomeSetId === null ? null : requireOutcomeSet(row.outcomeSetId)
  if ((conditionId === null) !== (outcomeSetId === null))
    throw new Error('asset-monitoring conditional metadata is invalid')
  const state = monitorState(row)
  if (state === null) return null
  return {
    proofId: row.proofId,
    normalizedMint,
    unit,
    keysetId: row.keysetId,
    amount,
    conditionId,
    outcomeSetId,
    state,
  }
}

function monitorState(row: MonitoringRow): 'available' | 'pending' | null {
  if (row.source === 'target') {
    if (row.state === 'available') return 'available'
    if (row.state === 'reserved' || row.state === 'locked') return 'pending'
    throw new Error('asset-monitoring target proof state is invalid')
  }
  if (row.source !== 'custody') throw new Error('asset-monitoring proof source is invalid')
  if (
    row.selectability === 'spent' ||
    row.selectability === 'retained' ||
    row.nut07State === 'SPENT'
  )
    return null
  if (row.selectability === 'locked' || row.nut07State === 'PENDING') return 'pending'
  if (row.selectability === 'selectable' && row.nut07State === 'UNSPENT') return 'available'
  throw new Error('asset-monitoring custody proof state is invalid')
}

function monitoringAsset(
  row: DecodedMonitoringRow,
  catalogue: ReadonlyMap<string, { readonly outcomes: readonly string[] }>,
): AssetMonitoringAssetReference {
  if (row.conditionId === null || row.outcomeSetId === null)
    return {
      canonicalMintUrl: row.normalizedMint,
      kind: 'collateral',
      cashuUnit: row.unit,
      displayBaseAsset: 'sat',
    }
  const entry = catalogue.get(row.conditionId)
  if (entry === undefined || !isCanonicalSubset(row.outcomeSetId, entry.outcomes))
    throw new Error('asset-monitoring condition metadata is unavailable')
  return {
    canonicalMintUrl: row.normalizedMint,
    kind: 'conditional',
    cashuUnit: row.unit,
    displayBaseAsset: 'sat',
    conditionId: row.conditionId,
    parentConditionId: ROOT_CONDITION_ID,
    outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(entry.outcomes),
    internalOutcomeSetId: row.outcomeSetId,
  }
}

function sameMetadata(left: DecodedMonitoringRow, right: DecodedMonitoringRow): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
function requireConditionId(value: unknown): string {
  if (typeof value !== 'string' || !CONDITION_ID.test(value))
    throw new Error('asset-monitoring condition id is invalid')
  return value
}
function requireOutcomeSet(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    canonicalizeOutcomeSet(value.split('|')) !== value
  )
    throw new Error('asset-monitoring outcome set is invalid')
  return value
}
function isCanonicalSubset(value: string, universe: readonly string[]): boolean {
  const selected = value.split('|')
  return (
    selected.length > 0 &&
    selected.length < universe.length &&
    selected.every((outcome) => universe.includes(outcome))
  )
}
