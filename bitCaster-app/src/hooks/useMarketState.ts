import type { MarketDetail, ResolutionStatus } from '@/types/market-detail'

/**
 * Per ADR-010 the matching engine has a single closed-market discriminator:
 * `MarketState ∈ { Open, Closed }`. Until the market-query proxy (engine
 * PR #26 / ADR-009) lands and the engine surfaces `state` directly on the
 * REST market record, the frontend derives the same view from mintd's
 * attestation status — the same data path that already drives the
 * "resolved" affordances on the market-detail page.
 *
 * The mapping mirrors the engine's two close sources:
 *
 *   - oracle resolution attestation         → mintd `'attested'`     → Closed
 *   - oracle deadline passed without resolve → mintd `'expired'`      → Closed
 *   - oracle reported a CET-violation        → mintd `'violation'`    → Closed
 *   - oracle still has not declared anything → mintd `'pending'`      → Open
 *
 * `mapConditionToMarketDetail` collapses `attested|expired|violation` into
 * `resolution.status === 'resolved'`, so callers that already hold a
 * `MarketDetail` can drop in the hook below without touching their data
 * fetching path.
 *
 * Once engine PR #26 ships, this hook should switch over to the engine's
 * authoritative `state` field and treat the mintd attestation as a
 * fallback / staleness signal.
 */
export type DerivedMarketState = 'Open' | 'Closed'

const CLOSED_RESOLUTION_STATUSES: ReadonlySet<ResolutionStatus> = new Set([
  'resolved',
  'pending_resolution',
  'disputed',
])

export function useMarketState(market: Pick<MarketDetail, 'resolution'> | null | undefined): DerivedMarketState {
  if (!market) return 'Open'
  return CLOSED_RESOLUTION_STATUSES.has(market.resolution.status) ? 'Closed' : 'Open'
}
