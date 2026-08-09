import { readAllocationBoundedJsonResponse } from './boundedJsonResponse.ts'
import { EngineClientError } from './engineClient.ts'
import {
  canonicalizeAssetMonitoringHoldings,
  computeAssetMonitoringOutcomeUniverseDigest,
  type AssetMonitoringReportedHolding,
  type AssetMonitoringReportRequest,
} from './assetMonitoring.ts'

export const ASSET_MONITORING_CONDITIONS_MAX = 200
export const ASSET_MONITORING_CATALOGUE_PAGE_IDS_MAX = 50
export const ASSET_MONITORING_CATALOGUE_RESPONSE_BYTES_MAX = 512 * 1024
export const ASSET_MONITORING_REPORT_RETRY_DELAY_MS = 1_000
export const ASSET_MONITORING_REPORT_RETRY_DELAY_MAX_MS = 30_000
const CANONICAL_CONDITION_ID = /^[0-9a-f]{64}$/

export interface AssetMonitoringCatalogueEntry {
  readonly conditionId: string
  readonly outcomes: readonly string[]
}

export interface AssetMonitoringCatalogueReaderOptions {
  /** An absolute engine base URL. Exactly one URL source is required. */
  readonly engineBaseUrl?: string
  /** An absolute query endpoint, without request-specific query parameters. */
  readonly endpoint?: string
  readonly fetchImpl: typeof fetch
}

export interface AssetMonitoringReporterRemote {
  submitAssetMonitoringReport(request: AssetMonitoringReportRequest): Promise<void>
}

export interface AssetMonitoringReporterInput {
  readonly walletId: string
  readonly buildHoldings: () => Promise<readonly AssetMonitoringReportedHolding[] | null>
  readonly remote: AssetMonitoringReporterRemote
  readonly hasPendingSubmittedOrder: () => Promise<boolean>
  readonly isCurrent: () => boolean
  readonly createReportId?: () => string
  /** Overrides retry timing for a host that needs a shorter bounded delay. */
  readonly retryDelayMs?: (failureCount: number) => number
}

/** Reads only the selected condition metadata through bounded requests. */
export async function fetchAssetMonitoringCatalogue(
  conditionIds: readonly string[],
  options: AssetMonitoringCatalogueReaderOptions,
): Promise<AssetMonitoringCatalogueEntry[]> {
  const endpoint = catalogueEndpoint(options)
  const unique = uniqueConditionIds(conditionIds)
  if (unique.length > ASSET_MONITORING_CONDITIONS_MAX) {
    throw new Error('asset-monitoring condition catalogue is too large')
  }
  if (unique.length === 0) return []
  const pages = await Promise.all(
    chunks(unique, ASSET_MONITORING_CATALOGUE_PAGE_IDS_MAX).map((ids) =>
      fetchCataloguePage(endpoint, ids, options.fetchImpl),
    ),
  )
  return pages.flat()
}

/** Serializes fail-open reports for one captured wallet profile. */
export class AssetMonitoringReporter {
  readonly #input: AssetMonitoringReporterInput
  readonly #createReportId: () => string
  #requestedRevision = 0
  #queued = false
  #running = false
  #stopped = false
  #failureCount = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #lastAcceptedSnapshot: string | undefined

  constructor(input: AssetMonitoringReporterInput) {
    this.#input = input
    this.#createReportId = input.createReportId ?? (() => crypto.randomUUID())
  }

  request(): void {
    if (this.#stopped) return
    this.#clearRetry()
    this.#requestedRevision += 1
    this.#queued = true
    if (!this.#running) void this.#run()
  }

  stop(): void {
    this.#stopped = true
    this.#requestedRevision += 1
    this.#queued = false
    this.#clearRetry()
  }

  async #run(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      while (this.#queued && !this.#stopped) {
        this.#queued = false
        const revision = this.#requestedRevision
        let holdings: readonly AssetMonitoringReportedHolding[] | null
        try {
          holdings = await this.#input.buildHoldings()
        } catch (error) {
          if (this.#isCurrentRevision(revision) && isTransientReportError(error)) {
            this.#scheduleRetry()
          }
          continue
        }
        if (!this.#isCurrentRevision(revision)) continue
        if (holdings === null) {
          this.#scheduleRetry()
          continue
        }
        const result = await this.#submitFrozen(revision, holdings)
        if (result === 'retry') this.#scheduleRetry()
      }
    } finally {
      this.#running = false
      if (this.#queued && !this.#stopped) void this.#run()
    }
  }

  async #submitFrozen(
    revision: number,
    holdings: readonly AssetMonitoringReportedHolding[],
  ): Promise<'done' | 'retry'> {
    if (!this.#isCurrentRevision(revision)) return 'done'
    const canonicalHoldings = canonicalizeAssetMonitoringHoldings(holdings)
    const snapshot = JSON.stringify(canonicalHoldings)
    if (snapshot === this.#lastAcceptedSnapshot) return 'done'
    try {
      await this.#input.remote.submitAssetMonitoringReport(this.#request(canonicalHoldings, false))
      this.#lastAcceptedSnapshot = snapshot
      this.#failureCount = 0
      return 'done'
    } catch (error) {
      if (!(error instanceof EngineClientError) || error.status !== 409) {
        return this.#isCurrentRevision(revision) && isTransientReportError(error) ? 'retry' : 'done'
      }
    }
    if (!this.#isCurrentRevision(revision)) return 'done'
    let pendingOrder: boolean
    try {
      pendingOrder = await this.#input.hasPendingSubmittedOrder()
    } catch {
      return this.#isCurrentRevision(revision) ? 'retry' : 'done'
    }
    if (pendingOrder || !this.#isCurrentRevision(revision)) return 'done'
    try {
      await this.#input.remote.submitAssetMonitoringReport(this.#request(canonicalHoldings, true))
      this.#lastAcceptedSnapshot = snapshot
      this.#failureCount = 0
    } catch (error) {
      return this.#isCurrentRevision(revision) && isTransientReportError(error) ? 'retry' : 'done'
    }
    return 'done'
  }

  #scheduleRetry(): void {
    if (this.#stopped || !this.#input.isCurrent() || this.#retryTimer !== undefined) return
    this.#failureCount += 1
    const requested = this.#input.retryDelayMs?.(this.#failureCount)
    const delay = boundedRetryDelay(requested ?? exponentialRetryDelay(this.#failureCount))
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      this.request()
    }, delay)
  }

  #clearRetry(): void {
    if (this.#retryTimer === undefined) return
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }

  #request(
    holdings: readonly AssetMonitoringReportedHolding[],
    startsNewInterval: boolean,
  ): AssetMonitoringReportRequest {
    return {
      walletId: this.#input.walletId,
      reportId: this.#createReportId(),
      startsNewInterval,
      holdings: holdings.map((holding) => ({ ...holding })),
    }
  }

  #isCurrentRevision(revision: number): boolean {
    return !this.#stopped && this.#input.isCurrent() && revision === this.#requestedRevision
  }
}

function exponentialRetryDelay(failureCount: number): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 5)
  return ASSET_MONITORING_REPORT_RETRY_DELAY_MS * 2 ** exponent
}

function isTransientReportError(error: unknown): boolean {
  if (!(error instanceof EngineClientError)) return true
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
}

function boundedRetryDelay(value: number): number {
  if (!Number.isFinite(value)) return ASSET_MONITORING_REPORT_RETRY_DELAY_MAX_MS
  return Math.min(Math.max(Math.trunc(value), 1), ASSET_MONITORING_REPORT_RETRY_DELAY_MAX_MS)
}

function catalogueEndpoint(options: AssetMonitoringCatalogueReaderOptions): URL {
  if ((options.engineBaseUrl === undefined) === (options.endpoint === undefined)) {
    throw new Error('asset-monitoring catalogue requires exactly one endpoint source')
  }
  const value =
    options.endpoint ?? new URL('/api/v1/markets/query', requireUrl(options.engineBaseUrl!)).href
  const endpoint = requireUrl(value)
  if (endpoint.search || endpoint.hash)
    throw new Error('asset-monitoring catalogue endpoint is invalid')
  return endpoint
}

function requireUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error()
    return url
  } catch {
    throw new Error('asset-monitoring catalogue endpoint is invalid')
  }
}

async function fetchCataloguePage(
  endpoint: URL,
  ids: readonly string[],
  fetchImpl: typeof fetch,
): Promise<AssetMonitoringCatalogueEntry[]> {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({
    ids: ids.join(','),
    state: 'All',
    page_size: String(ids.length),
  }).toString()
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    throw new EngineClientError(
      response.status,
      'asset-monitoring condition catalogue is unavailable',
    )
  }
  const body = (await readAllocationBoundedJsonResponse(
    response,
    ASSET_MONITORING_CATALOGUE_RESPONSE_BYTES_MAX,
  )) as { markets?: unknown }
  if (!Array.isArray(body.markets) || body.markets.length > ids.length) {
    throw new Error('asset-monitoring condition catalogue is invalid')
  }
  const requested = new Set(ids)
  const seen = new Set<string>()
  return body.markets.map((entry) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error('asset-monitoring condition catalogue is invalid')
    const record = entry as { conditionId?: unknown; outcomes?: unknown }
    if (
      typeof record.conditionId !== 'string' ||
      !requested.has(record.conditionId) ||
      seen.has(record.conditionId) ||
      !Array.isArray(record.outcomes) ||
      !record.outcomes.every((outcome) => typeof outcome === 'string')
    ) {
      throw new Error('asset-monitoring condition catalogue is invalid')
    }
    const outcomes = record.outcomes as string[]
    computeAssetMonitoringOutcomeUniverseDigest(outcomes)
    seen.add(record.conditionId)
    return { conditionId: record.conditionId, outcomes }
  })
}

function uniqueConditionIds(conditionIds: readonly string[]): string[] {
  const unique = new Set<string>()
  for (const conditionId of conditionIds) {
    if (!CANONICAL_CONDITION_ID.test(conditionId))
      throw new Error('asset-monitoring condition catalogue has an invalid condition ID')
    unique.add(conditionId)
  }
  return [...unique]
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size))
  return result
}
