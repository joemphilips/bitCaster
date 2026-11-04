import { Mint as CashuMint } from '@cashu/cashu-ts'
import { createSeedRecoveryScanPolicy } from '@bitcaster-market/client-sdk/seedRecoveryScanPolicy'
import {
  SEED_POSITION_PROBE_COUNTERS,
  listSeedRestoreConditionKeysets,
  probeSeedRestoreKeysets,
  readSeedRestoreCataloguePage,
  readSeedRestoreMintConditionPage,
  type SeedRestoreMarket,
  type SeedRestoreMintListing,
} from '@bitcaster-market/client-sdk/seedPositionRestore'
import {
  readRecoverySeedInput,
  runOfflineDaemonSeedRecovery,
  type OfflineDaemonSeedRecoveryInput,
  type WalletSeedRecoveryResult,
} from './emergencySeedRecovery.ts'
import { readProfile } from './profile.ts'

// `wallet recover-seed --all-conditions`: the CLI form of the seed restore
// event of ADR-039 (amendment 2026-11-04). It uses the SDK listing, filter,
// probe, and response binding of the browser. It sends no engine identity,
// Nostr key, or wallet id to the mint.

const CATALOGUE_PAGES_MAX = 400
const MINT_LISTING_PAGES_MAX = 400

/** The highest signed counter of each probed keyset, or null without a signature. */
export type AllConditionsProbeResult = Readonly<Record<string, number | null>>

export type AllConditionsConditionOutcome =
  | {
      readonly conditionId: string
      readonly recoveryId: string
      readonly status: 'recovered'
      readonly probe: AllConditionsProbeResult
      readonly result: WalletSeedRecoveryResult
    }
  | {
      readonly conditionId: string
      readonly recoveryId: string
      readonly status: 'failed'
      readonly stage: 'listing' | 'probe' | 'recovery'
      readonly error: string
      /** Kept when the probe found a signature, so the next run with this recovery id is clear. */
      readonly probe?: AllConditionsProbeResult
    }

export interface AllConditionsSeedRecoveryResult {
  readonly regular: WalletSeedRecoveryResult
  readonly catalogueSource: 'engine' | 'mint'
  readonly marketsChecked: number
  readonly foreignSkipped: number
  /** Markets with a signature in the probe window, and markets that failed. */
  readonly conditions: readonly AllConditionsConditionOutcome[]
  /** Failed markets. Run the command again with the same recovery id to retry them. */
  readonly failed: number
}

export interface AllConditionsSeedRecoveryPorts {
  readonly engineBaseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly mint?: SeedRestoreMintListing & {
    restore(payload: { outputs: unknown[] }): Promise<unknown>
  }
  readonly recover?: (input: OfflineDaemonSeedRecoveryInput) => Promise<WalletSeedRecoveryResult>
}

/** The recovery id of one condition scope. It stays stable for one base recovery id. */
export function conditionRecoveryId(recoveryId: string, conditionId: string): string {
  return `${recoveryId}.condition-${conditionId}`
}

/**
 * Recovers the regular msat keysets, then every bitCaster market of the
 * catalogue on which the seed has a signature in the probe window. A hinted
 * or known market beyond the window needs `--condition-id`. A failure of one
 * market is reported with its recovery id, and the command continues.
 */
export async function runOfflineDaemonSeedRecoveryAllConditions(
  input: OfflineDaemonSeedRecoveryInput,
  ports: AllConditionsSeedRecoveryPorts = {},
): Promise<AllConditionsSeedRecoveryResult> {
  const recover = ports.recover ?? runOfflineDaemonSeedRecovery
  const gapLimit = input.scanPolicy?.gapLimit
  const regular = await recover({
    ...input,
    scanPolicy: createSeedRecoveryScanPolicy(gapLimit === undefined ? {} : { gapLimit }),
  })
  const engineBaseUrl = ports.engineBaseUrl ?? (await readProfile())?.engineBaseUrl
  if (engineBaseUrl === undefined) throw new Error('daemon profile is not initialized')
  const mint = ports.mint ?? new CashuMint(input.mintUrl)
  const { markets, source, foreign } = await listMarkets({
    engineBaseUrl,
    fetchImpl: ports.fetchImpl ?? fetch,
    mint,
  })
  const seed = Uint8Array.from(Buffer.from(await readRecoverySeedInput(input), 'hex'))
  const touched: { conditionId: string; probe: AllConditionsProbeResult }[] = []
  const conditions: AllConditionsConditionOutcome[] = []
  let foreignSkipped = foreign
  try {
    for (const market of markets) {
      const recoveryId = conditionRecoveryId(input.recoveryId, market.conditionId)
      let listing: Awaited<ReturnType<typeof listSeedRestoreConditionKeysets>>
      try {
        listing = await listSeedRestoreConditionKeysets({
          conditionId: market.conditionId,
          outcomes: market.outcomes,
          mint,
        })
      } catch (error) {
        conditions.push(failedCondition(market.conditionId, recoveryId, 'listing', error))
        continue
      }
      foreignSkipped += listing.foreign
      if (listing.keysets.length === 0) continue
      let highest: ReadonlyMap<string, number | null>
      try {
        highest = await probeSeedRestoreKeysets({
          seed,
          targets: listing.keysets.map(({ id }) => ({
            keysetId: id,
            start: 0,
            count: SEED_POSITION_PROBE_COUNTERS,
          })),
          restore: (outputs) => mint.restore({ outputs }),
        })
      } catch (error) {
        conditions.push(failedCondition(market.conditionId, recoveryId, 'probe', error))
        continue
      }
      if ([...highest.values()].some((counter) => counter !== null)) {
        touched.push({ conditionId: market.conditionId, probe: Object.fromEntries(highest) })
      }
    }
  } finally {
    seed.fill(0)
  }
  for (const { conditionId, probe } of touched) {
    const recoveryId = conditionRecoveryId(input.recoveryId, conditionId)
    try {
      const result = await recover({
        ...input,
        recoveryId,
        scanPolicy: createSeedRecoveryScanPolicy({
          conditionId,
          ...(gapLimit === undefined ? {} : { gapLimit }),
        }),
      })
      conditions.push({ conditionId, recoveryId, status: 'recovered', probe, result })
    } catch (error) {
      conditions.push({ ...failedCondition(conditionId, recoveryId, 'recovery', error), probe })
    }
  }
  const order = new Map(markets.map(({ conditionId }, index) => [conditionId, index]))
  conditions.sort((left, right) => order.get(left.conditionId)! - order.get(right.conditionId)!)
  return {
    regular,
    catalogueSource: source,
    marketsChecked: markets.length,
    foreignSkipped,
    conditions,
    failed: conditions.filter(({ status }) => status === 'failed').length,
  }
}

const ERROR_TEXT_MAX = 200

function failedCondition(
  conditionId: string,
  recoveryId: string,
  stage: 'listing' | 'probe' | 'recovery',
  error: unknown,
): Extract<AllConditionsConditionOutcome, { status: 'failed' }> {
  const message = error instanceof Error ? error.message : String(error)
  return {
    conditionId,
    recoveryId,
    status: 'failed',
    stage,
    error: message.slice(0, ERROR_TEXT_MAX),
  }
}

async function listMarkets(input: {
  readonly engineBaseUrl: string
  readonly fetchImpl: typeof fetch
  readonly mint: SeedRestoreMintListing
}): Promise<{
  markets: readonly { conditionId: string; outcomes: readonly string[] | null }[]
  source: 'engine' | 'mint'
  foreign: number
}> {
  const markets: SeedRestoreMarket[] = []
  let foreign = 0
  let cursor: string | null = null
  for (let page = 0; page < CATALOGUE_PAGES_MAX; page += 1) {
    let result: Awaited<ReturnType<typeof readSeedRestoreCataloguePage>>
    try {
      result = await readSeedRestoreCataloguePage({
        engineBaseUrl: input.engineBaseUrl,
        fetchImpl: input.fetchImpl,
        cursor,
      })
    } catch (error) {
      // Use the strict mint listing only when no catalogue page was read.
      if (page === 0) return listMintConditions(input.mint)
      throw error
    }
    markets.push(...result.markets)
    foreign += result.foreign
    if (result.nextCursor === null) return { markets: unique(markets), source: 'engine', foreign }
    cursor = result.nextCursor
  }
  throw new Error('market catalogue exceeds its page bound')
}

async function listMintConditions(mint: SeedRestoreMintListing) {
  const conditionIds: string[] = []
  let foreign = 0
  let cursor: string | null = null
  for (let page = 0; page < MINT_LISTING_PAGES_MAX; page += 1) {
    const result = await readSeedRestoreMintConditionPage({ mint, cursor })
    conditionIds.push(...result.conditionIds)
    foreign += result.foreign
    if (result.nextCursor === null) {
      return {
        markets: [...new Set(conditionIds)].map((conditionId) => ({ conditionId, outcomes: null })),
        source: 'mint' as const,
        foreign,
      }
    }
    cursor = result.nextCursor
  }
  throw new Error('mint conditional keyset listing exceeds its page bound')
}

function unique(markets: readonly SeedRestoreMarket[]): SeedRestoreMarket[] {
  const seen = new Set<string>()
  return markets.filter(({ conditionId }) => !seen.has(conditionId) && seen.add(conditionId))
}

/** The follow-up command after `daemon init` with an imported seed. It names no secret. */
export function importedSeedRestoreHint(mintUrl: string): string {
  return [
    'The imported seed can already hold funds and market positions at the mint.',
    'Restore them with:',
    `  bitcaster-cli wallet recover-seed --wallet-seed-hex-file <path> --recovery-id restore-1 --mint ${mintUrl} --all-conditions --acknowledge-seed-disclosure`,
    '',
  ].join('\n')
}
