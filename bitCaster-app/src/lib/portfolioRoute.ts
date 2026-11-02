/**
 * Portfolio deep links. A position is identified by its public market ID,
 * `{conditionId}-{outcomeCollection}`, which the Portfolio row also carries.
 */

export type PortfolioPositionsTab = "active" | "closed";

export interface PortfolioPositionsRequest {
  tab: PortfolioPositionsTab | null;
  positionMarketId: string | null;
}

export function portfolioClosedPositionHref(positionMarketId: string): string {
  return `/portfolio?tab=closed&position=${encodeURIComponent(positionMarketId)}`;
}

/** Read the Portfolio query. An unknown tab value selects nothing. */
export function readPortfolioPositionsRequest(search: URLSearchParams): PortfolioPositionsRequest {
  const tab = search.get("tab");
  const position = search.get("position");
  return {
    tab: tab === "active" || tab === "closed" ? tab : null,
    positionMarketId: position === null || position.length === 0 ? null : position,
  };
}

/** A DOM ID has no whitespace. The encoded market ID keeps it unique and valid. */
export function portfolioPositionAnchorId(positionMarketId: string): string {
  return `position-${encodeURIComponent(positionMarketId)}`;
}
