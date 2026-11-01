/**
 * The engine catalogue query returns at most 50 markets in one page, and 20
 * when `page_size` is absent. A filtered query is read as one page only. A
 * batch of at most 50 condition IDs sent with `page_size` equal to the batch
 * length therefore gets every requested market in exactly one request.
 */
export const MARKET_CATALOGUE_PAGE_IDS_MAX = 50

/**
 * Split condition IDs into distinct batches that each fit in one catalogue
 * page, in first-seen order. Send each batch with `page_size` equal to its
 * length.
 */
export function marketCatalogueIdBatches(conditionIds: readonly string[]): string[][] {
  const unique = [...new Set(conditionIds)]
  const batches: string[][] = []
  for (let offset = 0; offset < unique.length; offset += MARKET_CATALOGUE_PAGE_IDS_MAX)
    batches.push(unique.slice(offset, offset + MARKET_CATALOGUE_PAGE_IDS_MAX))
  return batches
}
