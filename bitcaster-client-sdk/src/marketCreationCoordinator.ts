import {
  CreateMarketError,
  parseCreateMarketResponse,
  recoverCreatedMarketResponse,
  type CreateMarketResponse,
} from './marketLifecycle.ts'
import {
  prepareMarketCreationRequest,
  type PreparedMarketCreationRequest,
} from './marketCreationRequest.ts'
import {
  assertMarketCreationBinding,
  assertMarketCreationPreparationEqual,
  snapshotMarketCreationPreparation,
  type MarketCreationBinding,
  type MarketCreationPreparation,
  type MarketCreationRecord,
  type MarketCreationStore,
} from './marketCreationRecord.ts'
import { deriveDurableCustodyArtifactFingerprint } from './durableCustody.ts'
import { defaultMarketDivisibility, defaultCollateralUnit } from './marketUnits.ts'
import { readAllocationBoundedJsonResponse } from './boundedJsonResponse.ts'

export type MarketCreationFeeReadiness = 'ready' | 'pending' | 'already-spent'

export interface MarketCreationCoordinatorAdapters {
  readonly store: MarketCreationStore
  prepareFee(record: MarketCreationRecord): Promise<MarketCreationFeeReadiness>
  confirmFee(record: MarketCreationRecord): Promise<void>
  publishAnnouncement(record: MarketCreationRecord): Promise<void>
  /** NULL means confirmed absence. Unavailable or malformed lookups must throw. */
  lookupMint(record: MarketCreationRecord): Promise<unknown | null>
  registerMint(record: MarketCreationRecord): Promise<{ condition_id: string }>
  lookupEngine(record: MarketCreationRecord): Promise<unknown | null>
  createEngine(
    record: MarketCreationRecord,
    request: PreparedMarketCreationRequest,
  ): Promise<CreateMarketResponse>
}

/** Retain -> reconcile fee/mint -> confirm mint -> reconcile engine -> confirm engine. */
export async function completeDurableMarketCreation(
  adapters: MarketCreationCoordinatorAdapters,
  input: MarketCreationPreparation,
  active: MarketCreationBinding,
) {
  const preparation = snapshotMarketCreationPreparation(input)
  assertMarketCreationBinding(preparation, active)
  const request = await prepareMarketCreationRequest(
    preparation.metadata,
    preparation.thumbnail ?? undefined,
  )
  let record = await adapters.store.reserve(preparation)
  assertStoredCreation(record, preparation, active)
  if (record.engineResult !== null) return created(record, record.engineResult)
  if (!record.mintConfirmed) {
    if (!(await ensureMintRegistration(adapters, record)))
      return {
        creationId: record.creationId,
        conditionId: record.announcement.conditionId,
        status: 'payment-pending' as const,
      }
    record = await adapters.store.confirmMint(record.creationId)
    assertStoredCreation(record, preparation, active)
    if (!record.mintConfirmed) throw new Error('Mint confirmation was not stored.')
  }
  await adapters.confirmFee(record)
  const expected = expectedEngineRegistration(record)
  const observed = await adapters.lookupEngine(record)
  let result = recoverCreatedMarketResponse(observed, expected)
  if (observed !== null && result === null)
    throw new Error('Existing market does not match this creation.')
  if (result === null) result = await createOrRecoverEngine(adapters, record, request)
  const confirmed = await adapters.store.confirmEngine(record.creationId, result)
  assertStoredCreation(confirmed, preparation, active)
  if (confirmed.engineResult === null) throw new Error('Engine confirmation was not stored.')
  if (
    deriveDurableCustodyArtifactFingerprint(confirmed.engineResult) !==
    deriveDurableCustodyArtifactFingerprint(result)
  )
    throw new Error('Stored engine confirmation does not match the confirmed result.')
  return created(confirmed, confirmed.engineResult)
}

async function ensureMintRegistration(
  adapters: MarketCreationCoordinatorAdapters,
  record: MarketCreationRecord,
): Promise<boolean> {
  const observed = await adapters.lookupMint(record)
  if (observed !== null) {
    assertMintRegistrationMatches(observed, record)
    return true
  }
  switch (await adapters.prepareFee(record)) {
    case 'pending':
      return false
    case 'already-spent':
      throw new Error('Registration fee was spent. Reconcile the original mint registration.')
    case 'ready':
      break
    default:
      throw new Error('Creation fee readiness is invalid.')
  }
  await adapters.publishAnnouncement(record)
  try {
    const registered = await adapters.registerMint(record)
    if (registered.condition_id !== record.announcement.conditionId)
      throw new Error('Mint registration returned a different condition.')
  } catch (error) {
    const reconciled = await adapters.lookupMint(record)
    if (reconciled === null) throw error
    assertMintRegistrationMatches(reconciled, record)
  }
  return true
}

async function createOrRecoverEngine(
  adapters: MarketCreationCoordinatorAdapters,
  record: MarketCreationRecord,
  request: PreparedMarketCreationRequest,
) {
  try {
    const result = parseCreateMarketResponse(await adapters.createEngine(record, request))
    assertCreatedResultMatches(result, record)
    return result
  } catch (error) {
    if (!(error instanceof CreateMarketError) || !error.mayHaveCommitted) throw error
    const recovered = recoverCreatedMarketResponse(
      await adapters.lookupEngine(record),
      expectedEngineRegistration(record),
    )
    if (recovered === null) throw error
    return recovered
  }
}

export function assertCreatedResultMatches(
  result: CreateMarketResponse,
  preparation: MarketCreationPreparation,
): void {
  const expected = expectedEngineRegistration(preparation)
  if (
    recoverCreatedMarketResponse(
      {
        ...result,
        creatorPubkey: preparation.creatorId,
        outcomes: result.marketsCreated.map((id) => id.slice(result.conditionId.length + 1)),
      },
      expected,
    ) === null
  )
    throw new Error('Created market does not match this creation.')
  if (!result.marketsCreated.every((id) => id.startsWith(`${expected.conditionId}-`)))
    throw new Error('Created market does not match this creation.')
}

function expectedEngineRegistration(record: MarketCreationPreparation) {
  return {
    conditionId: record.announcement.conditionId,
    creatorPubkey: record.creatorId,
    outcomes: record.metadata.outcomes.map((outcome) => outcome.name),
    baseAsset: record.metadata.baseAsset,
    divisibility: defaultMarketDivisibility(record.metadata.baseAsset),
  }
}

function created(record: MarketCreationRecord, market: CreateMarketResponse) {
  assertCreatedResultMatches(market, record)
  return {
    creationId: record.creationId,
    conditionId: record.announcement.conditionId,
    status: 'created' as const,
    market,
  }
}

function assertStoredCreation(
  record: MarketCreationRecord,
  preparation: MarketCreationPreparation,
  active: MarketCreationBinding,
): void {
  snapshotMarketCreationPreparation(record)
  assertMarketCreationBinding(record, active)
  assertMarketCreationPreparationEqual(record, preparation)
  if (
    typeof record.mintConfirmed !== 'boolean' ||
    (!record.mintConfirmed && record.engineResult !== null)
  )
    throw new Error('Creation progress is invalid.')
}

export function assertMintRegistrationMatches(
  value: unknown,
  record: MarketCreationPreparation,
): void {
  if (value === null || typeof value !== 'object')
    throw new Error('Mint registration lookup is invalid.')
  const condition = value as {
    condition_id?: unknown
    announcements?: unknown
    collateral?: unknown
    tags?: unknown
    keysets?: unknown
  }
  if (
    condition.condition_id !== record.announcement.conditionId ||
    condition.collateral !== defaultCollateralUnit(record.metadata.baseAsset) ||
    !Array.isArray(condition.announcements) ||
    condition.announcements.length !== 1 ||
    condition.announcements[0] !== record.announcement.announcementTlvHex
  )
    throw new Error('Mint registration does not match this creation.')
  const expectedTags = [
    ['title', record.metadata.title],
    ['description', record.metadata.description],
    ...(record.metadata.categoryTags ?? []).map((tag) => ['t', tag]),
  ]
  if (
    !Array.isArray(condition.tags) ||
    !condition.tags.every(
      (tag) => Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
    )
  )
    throw new Error('Mint registration tags are invalid.')
  const sortedTags = (tags: readonly unknown[]) => tags.map((tag) => JSON.stringify(tag)).sort()
  if (
    deriveDurableCustodyArtifactFingerprint(sortedTags(condition.tags)) !==
    deriveDurableCustodyArtifactFingerprint(sortedTags(expectedTags))
  )
    throw new Error('Mint registration does not match this creation.')
  if (record.registration.outcomeCollections !== undefined) {
    if (
      condition.keysets === null ||
      typeof condition.keysets !== 'object' ||
      !record.registration.outcomeCollections.every(
        (collection) =>
          typeof (condition.keysets as Record<string, unknown>)[collection] === 'string',
      )
    )
      throw new Error('Mint registration collections are incomplete.')
  }
}

export async function readMarketCreationMintRegistration(
  mintUrl: string,
  conditionId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<unknown | null> {
  const response = await fetchImpl(
    `${mintUrl.replace(/\/+$/, '')}/v1/conditions/${encodeURIComponent(conditionId)}`,
  )
  if (!response.ok) {
    // CDK returns HTTP 400 with NUT-CTF code 13021 for confirmed absence.
    // A proxy 404 or an unavailable endpoint does not prove absence.
    const error = await readAllocationBoundedJsonResponse(response, 64 * 1024).catch(() => null)
    if (
      response.status === 400 &&
      error !== null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 13021
    )
      return null
    throw new Error('Mint registration lookup is unavailable.')
  }
  return readAllocationBoundedJsonResponse(response, 1024 * 1024)
}
