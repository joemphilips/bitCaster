import type { MarketCatalogueEntry, MarketCatalogueResponse } from "@/lib/markets";

/**
 * The engine accepts at most 100 IDs in one query but returns at most 50
 * markets in one page. A batch of 50 IDs therefore needs exactly one request.
 */
const MARKET_CATALOGUE_ID_BATCH_SIZE = 50;

/**
 * Read the catalogue entries of the given conditions. A failed batch is
 * skipped; the successful sibling batches are kept.
 */
export async function loadMarketCatalogue(
  conditionIds: readonly string[],
): Promise<Map<string, MarketCatalogueEntry>> {
  if (conditionIds.length === 0) return new Map();
  const uniqueConditionIds = [...new Set(conditionIds)];
  const catalogue = new Map<string, MarketCatalogueEntry>();
  for (
    let offset = 0;
    offset < uniqueConditionIds.length;
    offset += MARKET_CATALOGUE_ID_BATCH_SIZE
  ) {
    const batch = uniqueConditionIds.slice(offset, offset + MARKET_CATALOGUE_ID_BATCH_SIZE);
    try {
      const search = new URLSearchParams({
        ids: batch.join(","),
        state: "All",
        page_size: String(batch.length),
      });
      const response = await fetch(`/api/v1/markets/query?${search}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as MarketCatalogueResponse;
      const requestedIds = new Set(batch);
      for (const market of body.markets ?? []) {
        if (requestedIds.has(market.conditionId)) catalogue.set(market.conditionId, market);
      }
    } catch {
      // Keep successful sibling batches when one catalogue page is unavailable.
    }
  }
  return catalogue;
}
