import type { MarketCatalogueEntry, MarketCatalogueResponse } from "@/lib/markets";

/**
 * The engine accepts at most 100 IDs in one query but returns at most 50
 * markets in one page, and 20 when `page_size` is absent. A batch of 50 IDs
 * sent with `page_size` equal to the batch length therefore needs exactly one
 * request.
 */
const MARKET_CATALOGUE_ID_BATCH_SIZE = 50;

/**
 * Split condition IDs into distinct batches that each fit in one catalogue
 * page. Send each batch with `page_size` equal to its length.
 */
export function marketCatalogueIdBatches(conditionIds: readonly string[]): string[][] {
  const uniqueConditionIds = [...new Set(conditionIds)];
  const batches: string[][] = [];
  for (
    let offset = 0;
    offset < uniqueConditionIds.length;
    offset += MARKET_CATALOGUE_ID_BATCH_SIZE
  ) {
    batches.push(uniqueConditionIds.slice(offset, offset + MARKET_CATALOGUE_ID_BATCH_SIZE));
  }
  return batches;
}

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
