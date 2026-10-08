import type { components } from './generated/api.ts'

type History = components['schemas']['MarketPriceHistoryResponse']

export interface MarketPriceHistoryValidationContext {
  conditionId: string
  timeframe: History['timeframe']
  minimumEventOrder?: string
  /** A previously accepted server evaluation time for this market and range. */
  minimumAsOf?: string
  outcomeIds?: readonly string[]
  divisibility?: number
}

const windowMilliseconds: Record<History['timeframe'], number | null> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  all: null,
}

function invalid(field: string): never {
  throw new Error(`Invalid market price history: ${field}`)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as Record<string, unknown>
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function timestamp(value: unknown, field: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    invalid(field)
  const time = Date.parse(value)
  if (!Number.isFinite(time)) invalid(field)
  return time
}

/**
 * Validate a complete confirmed-fill snapshot. Omitted outcomes and empty ranges
 * are valid. The server enforces minimumEventOrder; clients cannot order tokens.
 * Callers must also discard responses from obsolete requests or market contexts.
 */
export function decodeMarketPriceHistoryResponse(
  value: unknown,
  context: MarketPriceHistoryValidationContext,
): History {
  const body = record(value, 'response')
  if (body.conditionId !== context.conditionId) invalid('conditionId')
  if (body.timeframe !== context.timeframe || !Object.hasOwn(windowMilliseconds, context.timeframe))
    invalid('timeframe')
  if (body.snapshotEventOrder !== null && !nonempty(body.snapshotEventOrder))
    invalid('snapshotEventOrder')
  if (context.minimumEventOrder !== undefined && body.snapshotEventOrder === null)
    invalid('snapshotEventOrder')
  const asOf = timestamp(body.asOf, 'asOf')
  if (context.minimumAsOf !== undefined && asOf < timestamp(context.minimumAsOf, 'minimumAsOf'))
    invalid('stale asOf')
  if (
    context.divisibility !== undefined &&
    (!Number.isSafeInteger(context.divisibility) || context.divisibility <= 1)
  )
    invalid('divisibility')
  if (!Array.isArray(body.outcomes)) invalid('outcomes')
  const seen = new Set<string>()
  const duration = windowMilliseconds[context.timeframe]
  for (const candidate of body.outcomes) {
    const outcome = record(candidate, 'outcome')
    if (!nonempty(outcome.outcomeId) || seen.has(outcome.outcomeId)) invalid('outcomeId')
    if (context.outcomeIds !== undefined && !context.outcomeIds.includes(outcome.outcomeId))
      invalid('outcomeId')
    seen.add(outcome.outcomeId)
    if (!Array.isArray(outcome.data)) invalid('data')
    for (const candidatePoint of outcome.data) {
      const point = record(candidatePoint, 'point')
      if (point.source !== 'fill') invalid('source')
      if (!nonempty(point.eventOrder) || body.snapshotEventOrder === null) invalid('eventOrder')
      const time = timestamp(point.timestamp, 'timestamp')
      if (duration !== null && time < asOf - duration) invalid('point outside timeframe')
      // The server can wait for catch-up after it captures asOf. A newly confirmed
      // fill can therefore have a timestamp after asOf.
      if (
        typeof point.price !== 'number' ||
        !Number.isSafeInteger(point.price) ||
        point.price < 1 ||
        (context.divisibility !== undefined && point.price >= context.divisibility)
      )
        invalid('price')
      if (
        typeof point.volumeSubunits !== 'number' ||
        !Number.isSafeInteger(point.volumeSubunits) ||
        point.volumeSubunits < 0
      )
        invalid('volumeSubunits')
    }
  }
  return body as unknown as History
}
