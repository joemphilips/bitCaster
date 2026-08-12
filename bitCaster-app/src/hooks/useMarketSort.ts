/**
 * Sort dimensions per ADR-009 — the engine-side query proxy
 * (`GET /api/v1/markets/query?sort=...`) returns markets pre-ordered by the
 * active dimension; the frontend treats the value as opaque and forwards
 * it to the API. The previous version of this module sorted client-side as
 * a stopgap; that path is gone now that the engine endpoint is live.
 *
 *   - `trending` — total trading volume in the rolling 24h window, desc
 *   - `popular`  — total trading volume in the rolling 30d window, desc
 *   - `new`      — engine `createdAt` timestamp, desc
 */
export type MarketSort = "trending" | "popular" | "new";

export const DEFAULT_MARKET_SORT: MarketSort = "trending";
