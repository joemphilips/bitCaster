import type { SerializedBlindedMessage } from '@cashu/cashu-ts'
import { readAllocationBoundedJsonResponse } from './boundedJsonResponse.ts'
import {
  bindExactSeedRecoveryResponse,
  planExactSeedRecoveryBatch,
  validateConditionalKeysetSeedRecoveryAuthority,
  validateConditionalKeysetSeedRecoveryDescriptor,
  type ConditionalKeysetSeedRecoveryAuthority,
  type ConditionalKeysetSeedRecoveryDescriptor,
  type ExactSeedRecoveryCandidate,
} from './conditionalKeysetSeedRecovery.ts'
import { classifyCashuMintFailure } from './mintRefusal.ts'
import type { RecoveryIndexEntry, RecoveryIndexKeysetAuthority } from './recoveryIndexDocument.ts'

// The mint reads of a seed restore. They send no engine identity, Nostr key,
// or wallet id to the mint.
//
// - The GUI restore (ADR-039, amendment 2026-11-09) scans the listed, the
//   regular and the hinted keysets with the recovery index planner and scan
//   (`recoveryIndexRestore`). It uses this module only to list the keysets of
//   a hinted condition and to resolve the mint authority of each target. It
//   never reads the market catalogue or the whole mint listing.
// - The CLI `wallet recover-seed --all-conditions` (ADR-033, amendment
//   2026-11-09) is the only broad recovery. It reads the catalogue, or the
//   strict mint listing, and probes the first counters of each market.
// - The browser keyset re-sync (ADR-033) probes the counters above a local
//   cursor after evidence of another client.

/** Counters that the CLI broad recovery probes at the start of each keyset. */
export const SEED_POSITION_PROBE_COUNTERS = 128
/** Counters probed above the local cursor of a keyset that this client uses. */
export const SEED_POSITION_RESYNC_COUNTERS = 100
/** Below the cdk-mintd default `max_outputs` of 1000. */
export const SEED_POSITION_RESTORE_REQUEST_OUTPUTS_MAX = 1000
export const SEED_POSITION_CATALOGUE_PAGE_SIZE = 50
export const SEED_POSITION_MARKET_OUTCOMES_MIN = 2
/** Equal to the engine market creation limit and the mint configuration. */
export const SEED_POSITION_MARKET_OUTCOMES_MAX = 8
const CATALOGUE_RESPONSE_BYTES_MAX = 2 * 1024 * 1024
const LISTING_PAGE_SIZE = 100
/** One-vs-rest gives 2n keysets for n outcomes. Two pages leave room for a keyset rotation. */
const CONDITION_LISTING_PAGES_MAX = 2
const DERIVATION_CHUNK = 64
const CANONICAL_CONDITION_ID = /^[0-9a-f]{64}$/

export interface SeedRestoreMarket {
  readonly conditionId: string
  readonly outcomes: readonly string[]
}

export interface SeedRestoreCataloguePage {
  readonly markets: readonly SeedRestoreMarket[]
  /** Entries that are not bitCaster markets. They are skipped. */
  readonly foreign: number
  readonly nextCursor: string | null
}

export interface SeedRestoreConditionPage {
  readonly conditionIds: readonly string[]
  readonly foreign: number
  readonly nextCursor: string | null
}

export interface SeedRestoreKeysetListing {
  readonly keysets: readonly ConditionalKeysetSeedRecoveryDescriptor[]
  /** Descriptors that fail the bitCaster filter. They are skipped. */
  readonly foreign: number
}

export interface SeedRestoreMintListing {
  getConditionalKeysets(query: {
    condition_id?: string
    limit: number
    cursor?: string
  }): Promise<unknown>
}

export interface SeedRestoreProbeTarget {
  readonly keysetId: string
  readonly start: number
  readonly count: number
}

/** Returns a bitCaster market, or null for an entry that is not one. */
export function seedRestoreMarketFromCatalogueEntry(value: unknown): SeedRestoreMarket | null {
  if (!isRecord(value)) return null
  const conditionId = value.conditionId
  const outcomes = value.outcomes
  if (typeof conditionId !== 'string' || !CANONICAL_CONDITION_ID.test(conditionId)) return null
  if (!Array.isArray(outcomes) || !validOutcomeUniverse(outcomes)) return null
  return Object.freeze({ conditionId, outcomes: Object.freeze([...(outcomes as string[])]) })
}

/** Reads one page of every market in the public catalogue, in every state. CLI only. */
export async function readSeedRestoreCataloguePage(input: {
  readonly engineBaseUrl: string
  readonly fetchImpl: typeof fetch
  readonly cursor: string | null
  readonly signal?: AbortSignal
}): Promise<SeedRestoreCataloguePage> {
  const url = new URL('/api/v1/markets/query', input.engineBaseUrl)
  url.searchParams.set('state', 'All')
  url.searchParams.set('sort', 'New')
  url.searchParams.set('page_size', String(SEED_POSITION_CATALOGUE_PAGE_SIZE))
  if (input.cursor !== null) url.searchParams.set('cursor', requireCursor(input.cursor))
  const response = await input.fetchImpl(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!response.ok) throw new Error(`market catalogue read failed with HTTP ${response.status}`)
  const body = await readAllocationBoundedJsonResponse(response, CATALOGUE_RESPONSE_BYTES_MAX)
  if (!isRecord(body) || !Array.isArray(body.markets)) {
    throw new Error('market catalogue response is invalid')
  }
  if (body.markets.length > SEED_POSITION_CATALOGUE_PAGE_SIZE) {
    throw new Error('market catalogue page exceeds its bound')
  }
  const markets: SeedRestoreMarket[] = []
  const seen = new Set<string>()
  let foreign = 0
  for (const entry of body.markets) {
    const market = seedRestoreMarketFromCatalogueEntry(entry)
    if (market === null || seen.has(market.conditionId)) {
      foreign += 1
      continue
    }
    seen.add(market.conditionId)
    markets.push(market)
  }
  return { markets, foreign, nextCursor: optionalCursor(body.nextCursor) }
}

/**
 * Reads one page of the unfiltered mint listing and returns its condition ids.
 * CLI only: use it when the catalogue is not available. Each condition then needs
 * `listSeedRestoreConditionKeysets` with no outcome list.
 */
export async function readSeedRestoreMintConditionPage(input: {
  readonly mint: SeedRestoreMintListing
  readonly cursor: string | null
}): Promise<SeedRestoreConditionPage> {
  const page = requireListingPage(
    await input.mint.getConditionalKeysets({
      limit: LISTING_PAGE_SIZE,
      ...(input.cursor === null ? {} : { cursor: requireCursor(input.cursor) }),
    }),
  )
  const conditionIds: string[] = []
  const seen = new Set<string>()
  let foreign = 0
  for (const value of page.keysets) {
    const descriptor = filterDescriptor(value)
    if (descriptor === null) {
      foreign += 1
      continue
    }
    if (!seen.has(descriptor.conditionId)) {
      seen.add(descriptor.conditionId)
      conditionIds.push(descriptor.conditionId)
    }
  }
  return { conditionIds, foreign, nextCursor: page.nextCursor }
}

/**
 * Lists the keysets of one condition with the mint condition filter and keeps
 * only bitCaster keysets. With a catalogue outcome list, each outcome
 * collection must be a strict subset of it. Without one, the keysets must form
 * the one-vs-rest set of 2 to 8 outcomes. A foreign descriptor is skipped and
 * counted. It does not stop the listing.
 */
export async function listSeedRestoreConditionKeysets(input: {
  readonly conditionId: string
  readonly outcomes: readonly string[] | null
  readonly mint: SeedRestoreMintListing
}): Promise<SeedRestoreKeysetListing> {
  if (!CANONICAL_CONDITION_ID.test(input.conditionId)) {
    throw new Error('seed restore condition id is invalid')
  }
  if (input.outcomes !== null && !validOutcomeUniverse(input.outcomes)) {
    throw new Error('seed restore outcome list is invalid')
  }
  const kept: ConditionalKeysetSeedRecoveryDescriptor[] = []
  const ids = new Set<string>()
  let foreign = 0
  let cursor: string | null = null
  const cursors = new Set<string>()
  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex === CONDITION_LISTING_PAGES_MAX) {
      throw new Error('seed restore condition listing exceeds its bound')
    }
    const page = requireListingPage(
      await input.mint.getConditionalKeysets({
        condition_id: input.conditionId,
        limit: LISTING_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      }),
    )
    for (const value of page.keysets) {
      const descriptor = filterDescriptor(value)
      if (
        descriptor === null ||
        descriptor.conditionId !== input.conditionId ||
        ids.has(descriptor.id) ||
        (input.outcomes !== null && !strictSubset(descriptor.outcomeCollection, input.outcomes))
      ) {
        foreign += 1
        continue
      }
      ids.add(descriptor.id)
      kept.push(descriptor)
    }
    if (page.nextCursor === null) break
    if (cursors.has(page.nextCursor)) throw new Error('seed restore listing cursor repeats')
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  if (input.outcomes === null && !oneVsRestShape(kept)) {
    return { keysets: [], foreign: foreign + kept.length }
  }
  return { keysets: kept, foreign }
}

/**
 * Probes counter windows with NUT-09 and returns the highest signed counter for
 * each keyset (null when no counter in its window has a signature). It derives
 * outputs in small chunks and calls `yieldControl` between them, so a browser
 * main thread stays responsive. A probe hit authorizes only a full scan; that
 * scan verifies the signatures before any admission.
 */
export async function probeSeedRestoreKeysets(input: {
  readonly seed: Uint8Array
  readonly targets: readonly SeedRestoreProbeTarget[]
  readonly restore: (outputs: SerializedBlindedMessage[]) => Promise<unknown>
  readonly maxOutputsPerRequest?: number
  readonly yieldControl?: () => Promise<void>
}): Promise<ReadonlyMap<string, number | null>> {
  const maxOutputs = input.maxOutputsPerRequest ?? SEED_POSITION_RESTORE_REQUEST_OUTPUTS_MAX
  if (!Number.isSafeInteger(maxOutputs) || maxOutputs < 1 || maxOutputs > 8192) {
    throw new Error('seed restore request bound is invalid')
  }
  const highest = new Map<string, number | null>()
  for (const target of input.targets) {
    if (highest.has(target.keysetId)) throw new Error('seed restore probe repeats a keyset')
    highest.set(target.keysetId, null)
  }
  const send = async (candidates: readonly ExactSeedRecoveryCandidate[]) => {
    const binding = bindExactSeedRecoveryResponse({
      candidates,
      response: await input.restore(candidates.map(({ blindedOutput }) => ({ ...blindedOutput }))),
    })
    for (const { candidate } of binding.matches) {
      const current = highest.get(candidate.keysetId) ?? null
      if (current === null || candidate.counter > current) {
        highest.set(candidate.keysetId, candidate.counter)
      }
    }
  }
  let pending: ExactSeedRecoveryCandidate[] = []
  for (const target of input.targets) {
    for (let offset = 0; offset < target.count; offset += DERIVATION_CHUNK) {
      pending.push(
        ...planExactSeedRecoveryBatch({
          seed: input.seed,
          keysetId: target.keysetId,
          startCounter: target.start + offset,
          count: Math.min(DERIVATION_CHUNK, target.count - offset),
        }),
      )
      await input.yieldControl?.()
      while (pending.length >= maxOutputs) {
        await send(pending.slice(0, maxOutputs))
        pending = pending.slice(maxOutputs)
      }
    }
  }
  if (pending.length > 0) await send(pending)
  return highest
}

/** The mint reads that resolve the authority of one GUI restore target. */
export interface SeedRestoreKeysetMint extends SeedRestoreMintListing {
  getKeys(keysetId: string): Promise<unknown>
}

export type SeedRestoreKeysetResolution =
  | {
      readonly status: 'resolved'
      readonly keyset: RecoveryIndexKeysetAuthority
      /** The authority of a conditional keyset, with its outcome collection. Null for a regular keyset. */
      readonly conditional: ConditionalKeysetSeedRecoveryAuthority | null
    }
  /** The mint names no matching keyset. The entry stays in the index. */
  | { readonly status: 'unverifiable' }

const UNVERIFIABLE: SeedRestoreKeysetResolution = Object.freeze({ status: 'unverifiable' })
/** The NUT error code of a keyset that the mint does not know. */
const MINT_UNKNOWN_KEYSET_REFUSAL_CODE = 12001

/**
 * Finds the mint authority of one target of the GUI restore (ADR-039,
 * "Restore order"). A regular keyset takes the keys of the mint. A
 * conditional keyset also needs its outcome collection: the index holds only
 * its id, and only the listing of its condition names the collection. The
 * recovery index scan then checks that the keys derive the keyset id of the
 * entry. A failed mint request rejects, so the caller keeps the target.
 */
export async function resolveSeedRestoreKeyset(input: {
  readonly entry: RecoveryIndexEntry
  readonly mint: SeedRestoreKeysetMint
  /** The bitCaster keysets of one condition, for example a cached `listSeedRestoreConditionKeysets`. */
  readonly conditionKeysets: (conditionId: string) => Promise<SeedRestoreKeysetListing>
}): Promise<SeedRestoreKeysetResolution> {
  const { entry } = input
  let response: unknown
  try {
    response = await input.mint.getKeys(entry.keysetId)
  } catch (error) {
    const failure = classifyCashuMintFailure(error)
    if (failure.kind === 'refusal' && failure.code === MINT_UNKNOWN_KEYSET_REFUSAL_CODE) {
      return UNVERIFIABLE
    }
    throw error
  }
  const keys = mintKeysetKeys(response, entry.keysetId)
  if (keys === null || keys.unit !== 'msat') return UNVERIFIABLE
  switch (entry.kind) {
    case 'regular':
      return Object.freeze({ status: 'resolved', keyset: keys, conditional: null })
    case 'conditional': {
      const listing = await input.conditionKeysets(entry.conditionId)
      const descriptor = listing.keysets.find(
        ({ id, outcomeCollectionId }) =>
          id === entry.keysetId && outcomeCollectionId === entry.outcomeCollectionId,
      )
      if (descriptor === undefined) return UNVERIFIABLE
      let conditional: ConditionalKeysetSeedRecoveryAuthority
      try {
        conditional = validateConditionalKeysetSeedRecoveryAuthority({
          id: descriptor.id,
          unit: descriptor.unit,
          active: descriptor.active,
          input_fee_ppk: descriptor.inputFeePpk,
          ...(descriptor.finalExpiry === null ? {} : { final_expiry: descriptor.finalExpiry }),
          condition_id: descriptor.conditionId,
          outcome_collection: descriptor.outcomeCollection,
          outcome_collection_id: descriptor.outcomeCollectionId,
          registered_at: descriptor.registeredAt,
          keys: { ...keys.keys },
        })
      } catch {
        return UNVERIFIABLE
      }
      return Object.freeze({
        status: 'resolved',
        keyset: Object.freeze({
          id: conditional.id,
          unit: conditional.unit,
          keys: conditional.keys,
          inputFeePpk: conditional.inputFeePpk,
          finalExpiry: conditional.finalExpiry,
        }),
        conditional,
      })
    }
    default:
      return assertNever(entry)
  }
}

/** The restore entries of the keysets of one hinted condition at one mint. */
export function seedRestoreHintEntries(
  mintUrl: string,
  listing: SeedRestoreKeysetListing,
): readonly RecoveryIndexEntry[] {
  return Object.freeze(
    listing.keysets.map((descriptor) =>
      Object.freeze({
        kind: 'conditional' as const,
        mintUrl,
        keysetId: descriptor.id,
        conditionId: descriptor.conditionId,
        outcomeCollectionId: descriptor.outcomeCollectionId,
      }),
    ),
  )
}

/** The keys of one keyset in a NUT-01 response, or null when the mint does not name it. */
function mintKeysetKeys(value: unknown, keysetId: string): RecoveryIndexKeysetAuthority | null {
  if (!isRecord(value) || !Array.isArray(value.keysets)) {
    throw new Error('seed restore mint keys are invalid')
  }
  const keyset = value.keysets.find((candidate) => isRecord(candidate) && candidate.id === keysetId)
  if (!isRecord(keyset) || typeof keyset.unit !== 'string' || !isRecord(keyset.keys)) return null
  const keys: Record<string, string> = {}
  for (const [amount, key] of Object.entries(keyset.keys)) {
    if (typeof key !== 'string') return null
    keys[amount] = key
  }
  const fee = keyset.input_fee_ppk ?? 0
  const expiry = keyset.final_expiry ?? null
  if (
    !Number.isSafeInteger(fee) ||
    (fee as number) < 0 ||
    (expiry !== null && (!Number.isSafeInteger(expiry) || (expiry as number) <= 0))
  ) {
    return null
  }
  return Object.freeze({
    id: keysetId,
    unit: keyset.unit,
    keys: Object.freeze(keys),
    inputFeePpk: fee as number,
    finalExpiry: expiry as number | null,
  })
}

function assertNever(value: never): never {
  throw new Error(`unhandled seed restore entry: ${JSON.stringify(value)}`)
}

function filterDescriptor(value: unknown): ConditionalKeysetSeedRecoveryDescriptor | null {
  let descriptor: ConditionalKeysetSeedRecoveryDescriptor
  try {
    descriptor = validateConditionalKeysetSeedRecoveryDescriptor(value)
  } catch {
    return null
  }
  if (descriptor.unit !== 'msat') return null
  const members = descriptor.outcomeCollection.split('|')
  if (
    members.length >= SEED_POSITION_MARKET_OUTCOMES_MAX ||
    members.some((member) => !validOutcomeName(member))
  ) {
    return null
  }
  return descriptor
}

function strictSubset(collection: string, outcomes: readonly string[]): boolean {
  const members = collection.split('|')
  return members.length < outcomes.length && members.every((member) => outcomes.includes(member))
}

function oneVsRestShape(keysets: readonly ConditionalKeysetSeedRecoveryDescriptor[]): boolean {
  const singletons = keysets
    .map(({ outcomeCollection }) => outcomeCollection)
    .filter((collection) => !collection.includes('|'))
  const universe = new Set(singletons)
  if (
    universe.size < SEED_POSITION_MARKET_OUTCOMES_MIN ||
    universe.size > SEED_POSITION_MARKET_OUTCOMES_MAX
  ) {
    return false
  }
  return keysets.every(({ outcomeCollection }) => {
    const members = outcomeCollection.split('|')
    if (members.some((member) => !universe.has(member))) return false
    return members.length === 1 || members.length === universe.size - 1
  })
}

function validOutcomeUniverse(outcomes: readonly unknown[]): boolean {
  return (
    outcomes.length >= SEED_POSITION_MARKET_OUTCOMES_MIN &&
    outcomes.length <= SEED_POSITION_MARKET_OUTCOMES_MAX &&
    outcomes.every(validOutcomeName) &&
    new Set(outcomes).size === outcomes.length
  )
}

function validOutcomeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('|') &&
    new TextEncoder().encode(value).byteLength <= 256
  )
}

function requireListingPage(value: unknown): {
  keysets: readonly unknown[]
  nextCursor: string | null
} {
  if (!isRecord(value) || !Array.isArray(value.keysets)) {
    throw new Error('seed restore listing is invalid')
  }
  if (value.keysets.length > LISTING_PAGE_SIZE) {
    throw new Error('seed restore listing page exceeds its bound')
  }
  return { keysets: value.keysets, nextCursor: optionalCursor(value.next_cursor) }
}

function optionalCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return requireCursor(value)
}

function requireCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error('seed restore cursor is invalid')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
