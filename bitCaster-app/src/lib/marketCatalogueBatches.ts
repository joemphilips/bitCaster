import { marketCatalogueIdBatches } from "@bitcaster/client-sdk/marketCatalogueBatches";
import type { MarketCatalogueEntry, MarketCatalogueResponse } from "@/lib/markets";

/**
 * Read the catalogue entries of the given conditions. A failed batch is
 * skipped; the successful sibling batches are kept.
 */
export async function loadMarketCatalogue(
  conditionIds: readonly string[],
): Promise<Map<string, MarketCatalogueEntry>> {
  const catalogue = new Map<string, MarketCatalogueEntry>();
  for (const batch of marketCatalogueIdBatches(conditionIds)) {
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
