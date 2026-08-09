/**
 * Strict wire codecs for the display-only asset-monitoring API.
 *
 * A 2 MiB response cap covers 200 assets, their bounded recovery hints, and
 * 300 history points. It remains bounded well below the generic 16 MiB reader
 * limit.
 */
export const ASSET_MONITORING_RESPONSE_BYTES_MAX = 2 * 1024 * 1024
export const ASSET_MONITORING_ERROR_RESPONSE_BYTES_MAX = 64 * 1024
export const ASSET_MONITORING_ASSETS_MAX = 200
export const ASSET_MONITORING_HISTORY_POINTS_MAX = 300
export const ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX = 16
export const ASSET_MONITORING_RECOVERY_COUNTERS_MAX = 4096

export type AssetMonitoringUnit = 'sat' | 'msat'
export type AssetMonitoringTimeframe = '1D' | '1W' | '1M' | 'ALL'
export type AssetMonitoringValuationStatus = 'valued' | 'unvalued'

export interface AssetMonitoringCollateralAssetReference {
  canonicalMintUrl: string
  kind: 'collateral'
  cashuUnit: AssetMonitoringUnit
  displayBaseAsset: AssetMonitoringUnit
}

export interface AssetMonitoringConditionalAssetReference {
  canonicalMintUrl: string
  kind: 'conditional'
  cashuUnit: AssetMonitoringUnit
  displayBaseAsset: AssetMonitoringUnit
  conditionId: string
  parentConditionId: string
  outcomeUniverseDigest: string
  internalOutcomeSetId: string
}

export type AssetMonitoringAssetReference =
  | AssetMonitoringCollateralAssetReference
  | AssetMonitoringConditionalAssetReference

export interface AssetMonitoringRecoveryCounterInterval {
  start: number
  count: number
}

export interface AssetMonitoringRecoveryHint {
  keysetIds: string[]
  counterIntervals: AssetMonitoringRecoveryCounterInterval[]
}

export interface AssetMonitoringReportedHolding {
  asset: AssetMonitoringAssetReference
  availableSubunits: number
  pendingOutgoingSubunits: number
  recoveryHint?: AssetMonitoringRecoveryHint | null
}

export interface AssetMonitoringReportRequest {
  walletId: string
  reportId: string
  startsNewInterval: boolean
  holdings: AssetMonitoringReportedHolding[]
}

export interface AssetMonitoringAssetResponse {
  asset: AssetMonitoringAssetReference
  availableSubunits: number
  pendingOutgoingSubunits: number
  availableValueMsat?: number | null
  pendingOutgoingValueMsat?: number | null
  estimatedValueMsat?: number | null
  valuationStatus: AssetMonitoringValuationStatus
  recoveryHint: AssetMonitoringRecoveryHint | null
}

export interface AssetMonitoringSummaryResponse {
  collateralUnit: 'msat'
  availableValueMsat: number | null
  pendingOutgoingValueMsat: number | null
  estimatedTotalValueMsat: number | null
  unvaluedAssetCount: number
  unvaluedAvailableSubunits: number | null
  unvaluedPendingOutgoingSubunits: number | null
  asOf?: string | null
  intervalRevision?: number | null
  coverageBoundary?: string | null
  valuationRevision: string
  stale: boolean
  incomplete: boolean
  building: boolean
}

export interface AssetMonitoringAssetsResponse {
  assets: AssetMonitoringAssetResponse[]
  nextCursor?: string | null
  asOf?: string | null
  intervalRevision?: number | null
  coverageBoundary?: string | null
  valuationRevision: string
  stale: boolean
  incomplete: boolean
  building: boolean
}

export interface AssetMonitoringHistoryPointResponse {
  asOf: string
  estimatedTotalValueMsat: number | null
}

export interface AssetMonitoringHistoryResponse {
  timeframe: AssetMonitoringTimeframe
  points: AssetMonitoringHistoryPointResponse[]
  asOf?: string | null
  intervalRevision?: number | null
  coverageBoundary?: string | null
  valuationRevision: string
  stale: boolean
  incomplete: boolean
  building: boolean
}

export interface AssetMonitoringPortfolioResponse {
  summary: AssetMonitoringSummaryResponse
  assets: AssetMonitoringAssetsResponse
  history: AssetMonitoringHistoryResponse
}

export interface AssetMonitoringAssetsQuery {
  walletId: string
  pageSize?: number
  cursor?: string
}

export interface AssetMonitoringHistoryQuery {
  walletId: string
  timeframe?: AssetMonitoringTimeframe
}

export interface AssetMonitoringPortfolioQuery {
  walletId: string
  timeframe?: AssetMonitoringTimeframe
  pageSize?: number
}

export function decodeAssetMonitoringReportRequest(value: unknown): AssetMonitoringReportRequest {
  const request = exactRecord(value, ['walletId', 'reportId', 'startsNewInterval', 'holdings'])
  requireWalletId(request.walletId)
  requireUuid(request.reportId, 'asset-monitoring report id')
  requireBoolean(request.startsNewInterval, 'asset-monitoring report interval flag')
  const holdings = boundedArray(
    request.holdings,
    ASSET_MONITORING_ASSETS_MAX,
    'asset-monitoring report holdings',
  ).map(decodeAssetMonitoringReportedHolding)
  return {
    walletId: request.walletId,
    reportId: request.reportId,
    startsNewInterval: request.startsNewInterval,
    holdings: canonicalizeHoldings(holdings),
  }
}

export function canonicalizeAssetMonitoringReportRequest(
  request: AssetMonitoringReportRequest,
): AssetMonitoringReportRequest {
  return decodeAssetMonitoringReportRequest(request)
}

export function decodeAssetMonitoringSummaryResponse(
  value: unknown,
): AssetMonitoringSummaryResponse {
  const response = exactRecord(
    value,
    [
      'collateralUnit',
      'availableValueMsat',
      'pendingOutgoingValueMsat',
      'estimatedTotalValueMsat',
      'unvaluedAssetCount',
      'unvaluedAvailableSubunits',
      'unvaluedPendingOutgoingSubunits',
      'valuationRevision',
      'stale',
      'incomplete',
      'building',
    ],
    ['asOf', 'intervalRevision', 'coverageBoundary'],
  )
  if (response.collateralUnit !== 'msat')
    throw new Error('asset-monitoring collateral unit is invalid')
  const nullableValues = decodeNullableAmounts(response, [
    'availableValueMsat',
    'pendingOutgoingValueMsat',
    'estimatedTotalValueMsat',
    'unvaluedAvailableSubunits',
    'unvaluedPendingOutgoingSubunits',
  ])
  requireNonnegativeSafeInteger(
    response.unvaluedAssetCount,
    'asset-monitoring unvalued asset count',
  )
  return {
    collateralUnit: 'msat',
    availableValueMsat: nullableValues.availableValueMsat.value,
    pendingOutgoingValueMsat: nullableValues.pendingOutgoingValueMsat.value,
    estimatedTotalValueMsat: nullableValues.estimatedTotalValueMsat.value,
    unvaluedAssetCount: response.unvaluedAssetCount,
    unvaluedAvailableSubunits: nullableValues.unvaluedAvailableSubunits.value,
    unvaluedPendingOutgoingSubunits: nullableValues.unvaluedPendingOutgoingSubunits.value,
    ...decodeMonitoringMetadata(response),
  }
}

export function decodeAssetMonitoringAssetsResponse(value: unknown): AssetMonitoringAssetsResponse {
  const response = exactRecord(
    value,
    ['assets', 'valuationRevision', 'stale', 'incomplete', 'building'],
    ['nextCursor', 'asOf', 'intervalRevision', 'coverageBoundary'],
  )
  const metadata = decodeMonitoringMetadata(response)
  const nextCursor = optionalNullableText(response, 'nextCursor', 4096)
  return {
    assets: boundedArray(
      response.assets,
      ASSET_MONITORING_ASSETS_MAX,
      'asset-monitoring assets',
    ).map(decodeAssetMonitoringAssetResponse),
    ...(nextCursor.present ? { nextCursor: nextCursor.value } : {}),
    ...metadata,
  }
}

export function decodeAssetMonitoringHistoryResponse(
  value: unknown,
): AssetMonitoringHistoryResponse {
  const response = exactRecord(
    value,
    ['timeframe', 'points', 'valuationRevision', 'stale', 'incomplete', 'building'],
    ['asOf', 'intervalRevision', 'coverageBoundary'],
  )
  requireTimeframe(response.timeframe)
  return {
    timeframe: response.timeframe,
    points: boundedArray(
      response.points,
      ASSET_MONITORING_HISTORY_POINTS_MAX,
      'asset-monitoring history points',
    ).map(decodeAssetMonitoringHistoryPointResponse),
    ...decodeMonitoringMetadata(response),
  }
}

export function decodeAssetMonitoringPortfolioResponse(
  value: unknown,
): AssetMonitoringPortfolioResponse {
  const response = exactRecord(value, ['summary', 'assets', 'history'])
  return {
    summary: decodeAssetMonitoringSummaryResponse(response.summary),
    assets: decodeAssetMonitoringAssetsResponse(response.assets),
    history: decodeAssetMonitoringHistoryResponse(response.history),
  }
}

export function decodeAssetMonitoringAssetsQuery(value: unknown): AssetMonitoringAssetsQuery {
  const query = exactRecord(value, ['walletId'], ['pageSize', 'cursor'])
  requireWalletId(query.walletId)
  if (query.pageSize !== undefined) requirePageSize(query.pageSize)
  if (query.cursor !== undefined) requireText(query.cursor, 'asset-monitoring cursor', 1, 4096)
  return {
    walletId: query.walletId,
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  }
}

export function decodeAssetMonitoringHistoryQuery(value: unknown): AssetMonitoringHistoryQuery {
  const query = exactRecord(value, ['walletId'], ['timeframe'])
  requireWalletId(query.walletId)
  if (query.timeframe !== undefined) requireTimeframe(query.timeframe)
  return {
    walletId: query.walletId,
    ...(query.timeframe === undefined ? {} : { timeframe: query.timeframe }),
  }
}

export function decodeAssetMonitoringPortfolioQuery(value: unknown): AssetMonitoringPortfolioQuery {
  const query = exactRecord(value, ['walletId'], ['timeframe', 'pageSize'])
  requireWalletId(query.walletId)
  if (query.timeframe !== undefined) requireTimeframe(query.timeframe)
  if (query.pageSize !== undefined) requirePageSize(query.pageSize)
  return {
    walletId: query.walletId,
    ...(query.timeframe === undefined ? {} : { timeframe: query.timeframe }),
    ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
  }
}

export function decodeAssetMonitoringWalletId(value: unknown): string {
  requireWalletId(value)
  return value
}

export function decodeAssetMonitoringReportedHolding(
  value: unknown,
): AssetMonitoringReportedHolding {
  const holding = exactRecord(
    value,
    ['asset', 'availableSubunits', 'pendingOutgoingSubunits'],
    ['recoveryHint'],
  )
  requireNonnegativeSafeInteger(holding.availableSubunits, 'asset-monitoring available subunits')
  requireNonnegativeSafeInteger(
    holding.pendingOutgoingSubunits,
    'asset-monitoring pending outgoing subunits',
  )
  const recoveryHint = optionalRecoveryHint(holding, 'recoveryHint', true)
  return {
    asset: decodeAssetMonitoringAssetReference(holding.asset),
    availableSubunits: holding.availableSubunits,
    pendingOutgoingSubunits: holding.pendingOutgoingSubunits,
    ...(recoveryHint.present ? { recoveryHint: recoveryHint.value } : {}),
  }
}

function decodeAssetMonitoringAssetResponse(value: unknown): AssetMonitoringAssetResponse {
  const response = exactRecord(
    value,
    ['asset', 'availableSubunits', 'pendingOutgoingSubunits', 'valuationStatus', 'recoveryHint'],
    ['availableValueMsat', 'pendingOutgoingValueMsat', 'estimatedValueMsat'],
  )
  requireNonnegativeSafeInteger(response.availableSubunits, 'asset-monitoring available subunits')
  requireNonnegativeSafeInteger(
    response.pendingOutgoingSubunits,
    'asset-monitoring pending outgoing subunits',
  )
  requireValuationStatus(response.valuationStatus)
  const values = decodeNullableAmounts(response, [
    'availableValueMsat',
    'pendingOutgoingValueMsat',
    'estimatedValueMsat',
  ])
  return {
    asset: decodeAssetMonitoringAssetReference(response.asset),
    availableSubunits: response.availableSubunits,
    pendingOutgoingSubunits: response.pendingOutgoingSubunits,
    ...(values.availableValueMsat.present
      ? { availableValueMsat: values.availableValueMsat.value }
      : {}),
    ...(values.pendingOutgoingValueMsat.present
      ? { pendingOutgoingValueMsat: values.pendingOutgoingValueMsat.value }
      : {}),
    ...(values.estimatedValueMsat.present
      ? { estimatedValueMsat: values.estimatedValueMsat.value }
      : {}),
    valuationStatus: response.valuationStatus,
    recoveryHint: decodeNullableRecoveryHint(response.recoveryHint),
  }
}

function decodeAssetMonitoringHistoryPointResponse(
  value: unknown,
): AssetMonitoringHistoryPointResponse {
  const point = exactRecord(value, ['asOf', 'estimatedTotalValueMsat'])
  requireIsoTime(point.asOf, 'asset-monitoring history point time')
  return {
    asOf: point.asOf,
    estimatedTotalValueMsat: decodeNullableAmount(
      point.estimatedTotalValueMsat,
      'asset-monitoring history point value',
    ),
  }
}

export function decodeAssetMonitoringAssetReference(value: unknown): AssetMonitoringAssetReference {
  const record = objectRecord(value)
  if (record.kind === 'collateral') {
    const asset = exactRecord(record, ['canonicalMintUrl', 'kind', 'cashuUnit', 'displayBaseAsset'])
    requireCanonicalMintUrl(asset.canonicalMintUrl)
    requireUnit(asset.cashuUnit)
    requireUnit(asset.displayBaseAsset)
    return {
      canonicalMintUrl: asset.canonicalMintUrl,
      kind: 'collateral',
      cashuUnit: asset.cashuUnit,
      displayBaseAsset: asset.displayBaseAsset,
    }
  }
  if (record.kind === 'conditional') {
    const asset = exactRecord(record, [
      'canonicalMintUrl',
      'kind',
      'cashuUnit',
      'displayBaseAsset',
      'conditionId',
      'parentConditionId',
      'outcomeUniverseDigest',
      'internalOutcomeSetId',
    ])
    requireCanonicalMintUrl(asset.canonicalMintUrl)
    requireUnit(asset.cashuUnit)
    requireUnit(asset.displayBaseAsset)
    requireConditionId(asset.conditionId, 'asset-monitoring condition id')
    requireConditionId(asset.parentConditionId, 'asset-monitoring parent condition id')
    requireDigest(asset.outcomeUniverseDigest, 'asset-monitoring outcome universe digest')
    requireCanonicalInternalOutcomeSetId(asset.internalOutcomeSetId)
    return {
      canonicalMintUrl: asset.canonicalMintUrl,
      kind: 'conditional',
      cashuUnit: asset.cashuUnit,
      displayBaseAsset: asset.displayBaseAsset,
      conditionId: asset.conditionId,
      parentConditionId: asset.parentConditionId,
      outcomeUniverseDigest: asset.outcomeUniverseDigest,
      internalOutcomeSetId: asset.internalOutcomeSetId,
    }
  }
  throw new Error('asset-monitoring asset kind is invalid')
}

export function decodeAssetMonitoringRecoveryHint(value: unknown): AssetMonitoringRecoveryHint {
  const hint = exactRecord(value, ['keysetIds', 'counterIntervals'])
  const keysetIds = boundedArray(
    hint.keysetIds,
    ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX,
    'asset-monitoring recovery keyset ids',
  ).map((keysetId) => {
    requireKeysetId(keysetId)
    return keysetId
  })
  if (new Set(keysetIds).size !== keysetIds.length) {
    throw new Error('asset-monitoring recovery keyset ids are invalid')
  }
  const counterIntervals = boundedArray(
    hint.counterIntervals,
    ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX,
    'asset-monitoring recovery counter intervals',
  ).map(decodeAssetMonitoringRecoveryCounterInterval)
  validateRecoveryIntervals(counterIntervals)
  return { keysetIds, counterIntervals }
}

function decodeNullableRecoveryHint(value: unknown): AssetMonitoringRecoveryHint | null {
  return value === null ? null : decodeAssetMonitoringRecoveryHint(value)
}

export function decodeAssetMonitoringRecoveryCounterInterval(
  value: unknown,
): AssetMonitoringRecoveryCounterInterval {
  const interval = exactRecord(value, ['start', 'count'])
  requireNonnegativeSafeInteger(interval.start, 'asset-monitoring recovery counter start')
  requirePositiveSafeInteger(interval.count, 'asset-monitoring recovery counter count')
  if (
    interval.start > 0x7fffffff ||
    interval.count > 0x7fffffff ||
    interval.start + interval.count > 0x80000000
  ) {
    throw new Error('asset-monitoring recovery counter interval is invalid')
  }
  return { start: interval.start, count: interval.count }
}

function optionalRecoveryHint(
  record: Record<string, unknown>,
  field: string,
  canonicalize: boolean,
): { present: false } | { present: true; value: AssetMonitoringRecoveryHint | null } {
  if (!Object.hasOwn(record, field)) return { present: false }
  if (record[field] === null) return { present: true, value: null }
  const hint = decodeAssetMonitoringRecoveryHint(record[field])
  return { present: true, value: canonicalize ? canonicalizeRecoveryHint(hint) : hint }
}

function canonicalizeRecoveryHint(hint: AssetMonitoringRecoveryHint): AssetMonitoringRecoveryHint {
  const keysetIds = [...hint.keysetIds].sort(compareOrdinal)
  const intervals = [...hint.counterIntervals].sort(
    (left, right) => left.start - right.start || left.count - right.count,
  )
  const canonical: AssetMonitoringRecoveryCounterInterval[] = []
  for (const interval of intervals) {
    const previous = canonical.at(-1)
    if (previous !== undefined && previous.start + previous.count === interval.start) {
      previous.count += interval.count
    } else {
      canonical.push({ ...interval })
    }
  }
  if (canonical.length > ASSET_MONITORING_RECOVERY_HINT_ITEMS_MAX) {
    throw new Error('asset-monitoring recovery counter intervals are invalid')
  }
  return { keysetIds, counterIntervals: canonical }
}

function canonicalizeHoldings(
  holdings: AssetMonitoringReportedHolding[],
): AssetMonitoringReportedHolding[] {
  const canonical = [...holdings].sort((left, right) => compareAssets(left.asset, right.asset))
  for (let index = 1; index < canonical.length; index += 1) {
    if (compareAssets(canonical[index - 1].asset, canonical[index].asset) === 0) {
      throw new Error('asset-monitoring report asset identities are duplicated')
    }
  }
  return canonical
}

function compareAssets(
  left: AssetMonitoringAssetReference,
  right: AssetMonitoringAssetReference,
): number {
  const leftKind = left.kind === 'collateral' ? 0 : 1
  const rightKind = right.kind === 'collateral' ? 0 : 1
  return (
    leftKind - rightKind ||
    compareOrdinal(left.canonicalMintUrl, right.canonicalMintUrl) ||
    compareUnit(left.cashuUnit, right.cashuUnit) ||
    compareUnit(left.displayBaseAsset, right.displayBaseAsset) ||
    compareOrdinal(assetConditionId(left), assetConditionId(right)) ||
    compareOrdinal(assetParentConditionId(left), assetParentConditionId(right)) ||
    compareOrdinal(assetOutcomeUniverseDigest(left), assetOutcomeUniverseDigest(right)) ||
    compareOrdinal(assetInternalOutcomeSetId(left), assetInternalOutcomeSetId(right))
  )
}

function decodeMonitoringMetadata(record: Record<string, unknown>): {
  valuationRevision: string
  stale: boolean
  incomplete: boolean
  building: boolean
  asOf?: string | null
  intervalRevision?: number | null
  coverageBoundary?: string | null
} {
  requireText(record.valuationRevision, 'asset-monitoring valuation revision', 1)
  requireBoolean(record.stale, 'asset-monitoring stale flag')
  requireBoolean(record.incomplete, 'asset-monitoring incomplete flag')
  requireBoolean(record.building, 'asset-monitoring building flag')
  const asOf = optionalNullableIsoTime(record, 'asOf')
  const intervalRevision = optionalNullablePositiveInteger(record, 'intervalRevision')
  const coverageBoundary = optionalNullableText(record, 'coverageBoundary')
  return {
    valuationRevision: record.valuationRevision,
    stale: record.stale,
    incomplete: record.incomplete,
    building: record.building,
    ...(asOf.present ? { asOf: asOf.value } : {}),
    ...(intervalRevision.present ? { intervalRevision: intervalRevision.value } : {}),
    ...(coverageBoundary.present ? { coverageBoundary: coverageBoundary.value } : {}),
  }
}

function decodeNullableAmounts(
  record: Record<string, unknown>,
  fields: readonly string[],
): Record<string, { present: boolean; value: number | null }> {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      Object.hasOwn(record, field)
        ? { present: true, value: decodeNullableAmount(record[field], `asset-monitoring ${field}`) }
        : { present: false, value: null },
    ]),
  )
}

function decodeNullableAmount(value: unknown, label: string): number | null {
  if (value === null) return null
  requireNonnegativeSafeInteger(value, label)
  return value
}

function optionalNullableText(
  record: Record<string, unknown>,
  field: string,
  maximumLength?: number,
): { present: false } | { present: true; value: string | null } {
  if (!Object.hasOwn(record, field)) return { present: false }
  if (record[field] === null) return { present: true, value: null }
  requireText(record[field], `asset-monitoring ${field}`, 0, maximumLength)
  return { present: true, value: record[field] }
}

function optionalNullableIsoTime(
  record: Record<string, unknown>,
  field: string,
): { present: false } | { present: true; value: string | null } {
  if (!Object.hasOwn(record, field)) return { present: false }
  if (record[field] === null) return { present: true, value: null }
  requireIsoTime(record[field], `asset-monitoring ${field}`)
  return { present: true, value: record[field] }
}

function optionalNullablePositiveInteger(
  record: Record<string, unknown>,
  field: string,
): { present: false } | { present: true; value: number | null } {
  if (!Object.hasOwn(record, field)) return { present: false }
  if (record[field] === null) return { present: true, value: null }
  requirePositiveSafeInteger(record[field], `asset-monitoring ${field}`)
  return { present: true, value: record[field] }
}

function validateRecoveryIntervals(
  intervals: readonly AssetMonitoringRecoveryCounterInterval[],
): void {
  let covered = 0
  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.count - right.count,
  )
  let previousEnd = -1
  for (const interval of sorted) {
    if (interval.start < previousEnd) {
      throw new Error('asset-monitoring recovery counter intervals are invalid')
    }
    covered += interval.count
    if (covered > ASSET_MONITORING_RECOVERY_COUNTERS_MAX) {
      throw new Error('asset-monitoring recovery counter intervals are invalid')
    }
    previousEnd = interval.start + interval.count
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = objectRecord(value)
  const keys = Object.keys(record)
  if (
    required.some((field) => !Object.hasOwn(record, field)) ||
    keys.some((field) => !required.includes(field) && !optional.includes(field))
  ) {
    throw new Error('asset-monitoring fields are invalid')
  }
  return record
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('asset-monitoring object is invalid')
  }
  return value as Record<string, unknown>
}

function boundedArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} are invalid`)
  return value
}

function requireWalletId(value: unknown): asserts value is string {
  requireDigest(value, 'asset-monitoring wallet id')
}

function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
}

function requireUuid(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function requireCanonicalMintUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[%?#]/.test(value)) {
    throw new Error('asset-monitoring mint URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('asset-monitoring mint URL is invalid')
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    value.endsWith('/') ||
    url.origin !== value
  ) {
    throw new Error('asset-monitoring mint URL is invalid')
  }
}

function requireUnit(value: unknown): asserts value is AssetMonitoringUnit {
  if (value !== 'sat' && value !== 'msat') throw new Error('asset-monitoring unit is invalid')
}

function requireTimeframe(value: unknown): asserts value is AssetMonitoringTimeframe {
  if (value !== '1D' && value !== '1W' && value !== '1M' && value !== 'ALL') {
    throw new Error('asset-monitoring timeframe is invalid')
  }
}

function requireValuationStatus(value: unknown): asserts value is AssetMonitoringValuationStatus {
  if (value !== 'valued' && value !== 'unvalued') {
    throw new Error('asset-monitoring valuation status is invalid')
  }
}

function requireConditionId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{1,128}$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
}

function requireCanonicalInternalOutcomeSetId(value: unknown): asserts value is string {
  requireText(value, 'asset-monitoring internal outcome set id', 1, 1024)
  const tokens = value.split('|')
  if (tokens.length < 1 || tokens.length >= 8) {
    throw new Error('asset-monitoring internal outcome set id is invalid')
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (
      token === undefined ||
      token.length > 191 ||
      !/^[A-Za-z0-9]+$/.test(token) ||
      (index > 0 && compareOrdinal(tokens[index - 1] ?? '', token) >= 0)
    ) {
      throw new Error('asset-monitoring internal outcome set id is invalid')
    }
  }
}

function requireKeysetId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(?:00[0-9a-f]{14}|0[12][0-9a-f]{64})$/.test(value)) {
    throw new Error('asset-monitoring recovery keyset id is invalid')
  }
}

function requirePageSize(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > ASSET_MONITORING_ASSETS_MAX
  ) {
    throw new Error('asset-monitoring page size is invalid')
  }
}

function requireNonnegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
}

function requirePositiveSafeInteger(value: unknown, label: string): asserts value is number {
  requireNonnegativeSafeInteger(value, label)
  if (value === 0) throw new Error(`${label} is invalid`)
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`)
}

function requireText(
  value: unknown,
  label: string,
  minimumLength = 1,
  maximumLength?: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    (maximumLength !== undefined && value.length > maximumLength)
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function requireIsoTime(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} is invalid`)
  }
}

function compareUnit(left: AssetMonitoringUnit, right: AssetMonitoringUnit): number {
  return (left === 'sat' ? 0 : 1) - (right === 'sat' ? 0 : 1)
}

function assetConditionId(asset: AssetMonitoringAssetReference): string {
  return asset.kind === 'conditional' ? asset.conditionId : ''
}

function assetParentConditionId(asset: AssetMonitoringAssetReference): string {
  return asset.kind === 'conditional' ? asset.parentConditionId : ''
}

function assetOutcomeUniverseDigest(asset: AssetMonitoringAssetReference): string {
  return asset.kind === 'conditional' ? asset.outcomeUniverseDigest : ''
}

function assetInternalOutcomeSetId(asset: AssetMonitoringAssetReference): string {
  return asset.kind === 'conditional' ? asset.internalOutcomeSetId : ''
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
