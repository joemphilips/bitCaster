import type { CurrentOdds, Market, FilterState } from "@/types/market";
import type {
  MarketDetail,
  OrderBook,
  Order,
  PriceHistory,
  PricePoint,
} from "@/types/market-detail";
import type { MarketSort } from "@/hooks/useMarketSort";
import type {
  Proof,
  SerializedBlindedMessage,
  SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import type { components } from "@/generated/api";
import {
  BitcasterEngineClient,
  type SubmitOrderRequest as SdkSubmitOrderRequest,
} from "@bitcaster/client-sdk/engineClient";
import {
  marketUnitLabel,
  DEFAULT_MARKET_DIVISIBILITY,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { getNdk } from "@/lib/nostr";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { bytesToHex } from "nostr-tools/utils";
import { toWireAmountBearing } from "@bitcaster/client-sdk/ctfRegistration";

export { requiredMarketCreationOutcomeCollections } from "@bitcaster/client-sdk/ctfRegistration";

// Types from generated OpenAPI spec

export type SubmitOrderRequest = components["schemas"]["SubmitOrderRequest"];
export type SubmitOrderResponse = components["schemas"]["SubmitOrderResponse"];
export type OrderBookSnapshot = components["schemas"]["OrderBookSnapshot"];
export type LevelDto = components["schemas"]["LevelDto"];
export type Fill = components["schemas"]["Fill"];
export type CreateMarketRequest = components["schemas"]["CreateMarketRequest"];
export type CreateMarketResponse =
  components["schemas"]["CreateMarketResponse"];
export type CreatorMarketEntry = components["schemas"]["CreatorMarketEntry"];
export type CreatorMarketsResponse =
  components["schemas"]["CreatorMarketsResponse"];
export type OracleNostrEvent = components["schemas"]["OracleNostrEvent"];
export type OracleAttestationResponse =
  components["schemas"]["OracleAttestationResponse"];
export type MarketPriceHistoryResponse =
  components["schemas"]["MarketPriceHistoryResponse"];
export type MarketCommentsResponse =
  components["schemas"]["MarketCommentsResponse"];
export type NostrKind1Event = components["schemas"]["NostrKind1Event"];

// CDK mint response types

export interface AttestationState {
  status: "pending" | "attested" | "expired" | "violation";
  winning_outcome: string | null;
  attested_at: number | null;
}

export interface ConditionInfo {
  condition_id: string;
  tags?: string[][]; // NIP-88 tag array (new spec)
  description?: string; // Legacy field (pre-tags CDK)
  threshold: number;
  announcements: string[];
  keysets: Record<string, string>;
  attestation: AttestationState;
  condition_type?: string; // "enum" (default, omitted) or "numeric"
}

export function getTagValue(tags: string[][], key: string): string | undefined {
  const tag = tags.find((t) => t.length >= 2 && t[0] === key);
  return tag?.[1];
}

export function getTagValues(tags: string[][], key: string): string[] {
  const tag = tags.find((t) => t.length >= 2 && t[0] === key);
  return tag ? tag.slice(1) : [];
}

const KNOWN_TAG_KEYS = new Set(["description", "title", "n"]);

/**
 * Identify the canonical two-outcome `Yes`/`No` universe so the mappers can
 * branch on the dedicated `type: 'yesno'` shape. P19 made outcome labels
 * oracle-verbatim, so this is a deliberate label match (`yes`/`no`,
 * case-insensitive) rather than a count-only test.
 */
function isYesNoUniverse(outcomes: readonly string[]): boolean {
  return (
    outcomes.length === 2 &&
    outcomes[0]?.toLowerCase() === "yes" &&
    outcomes[1]?.toLowerCase() === "no"
  );
}

function orderAtomicOutcomes(outcomes: string[]): string[] {
  if (
    outcomes.length === 2 &&
    outcomes.some((outcome) => outcome.toLowerCase() === "yes") &&
    outcomes.some((outcome) => outcome.toLowerCase() === "no")
  ) {
    return ["Yes", "No"];
  }
  return outcomes;
}

export function extractCategoryTagIds(tags: string[][]): string[] {
  return tags
    .filter((t) => t.length >= 2 && !KNOWN_TAG_KEYS.has(t[0]))
    .map((t) => t[1]);
}

interface ConditionsResponse {
  conditions: ConditionInfo[];
}

/**
 * Fetch the full mintd condition catalogue. ADR-009 now keeps routine
 * list/detail rendering engine-first, but operation-time checks may still
 * call mintd directly before value is spent, locked, claimed, or resolved.
 */
export async function fetchConditions(): Promise<ConditionInfo[]> {
  const response = await fetch("/v1/conditions");
  if (!response.ok) {
    throw new Error(`Failed to fetch conditions: ${response.status}`);
  }
  const data: ConditionsResponse = await response.json();
  return data.conditions;
}

// =============================================================================
// Engine markets-query proxy (ADR-009)
// =============================================================================

const SORT_TO_QUERY: Record<MarketSort, "Trending" | "Popular" | "New"> = {
  trending: "Trending",
  popular: "Popular",
  new: "New",
};

export interface GetMarketsParams {
  /** Sort dimension. Defaults to engine default (`Trending`) when omitted. */
  sort?: MarketSort;
  /** Repeatable category-tag filter. OR semantics across the supplied tags. */
  tags?: string[];
  /** Bulk-fetch by conditionId (cap 100). Pagination still applies. */
  ids?: string[];
  /** State filter — defaults to `Open`. */
  state?: "Open" | "Closed" | "All";
  /** Opaque HMAC-signed cursor returned in the previous response. */
  cursor?: string;
  /** Page size (default 20, max 50). */
  pageSize?: number;
  /** Full-text market search query. */
  search?: string;
}

export interface GetMarketsResult {
  /** Page of markets ordered by the active sort dimension. */
  markets: Market[];
  /** Cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
  /** Mintd-mirror staleness timestamp (ISO-8601). */
  lastSuccessfulRefreshAt: string;
}

export type MarketCatalogueEntry =
  components["schemas"]["MarketCatalogueEntry"];
export type MarketCatalogueResponse =
  components["schemas"]["MarketCatalogueResponse"];

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function probabilityFromLastTradedPrice(
  lastTradedPrice: number | null | undefined,
  divisibility: number,
): number | null {
  if (!Number.isFinite(lastTradedPrice)) return null;
  const price = Number(lastTradedPrice);
  // The catalogue currently documents lastTradedPrice as a decimal ratio, while
  // runtime price fields use integer numerators against divisibility. Accept
  // both shapes so generated-contract clients render correctly during the
  // compatibility window.
  return clampPercent(price <= 1 ? price * 100 : (price / divisibility) * 100);
}

function resolveYesNoOdds(
  entry: MarketCatalogueEntry,
  divisibility: number,
): CurrentOdds {
  if (Number.isFinite(entry.lastTradedPrice)) {
    const yes = probabilityFromLastTradedPrice(entry.lastTradedPrice, divisibility) ?? 50;
    return { yes, no: 100 - yes };
  }

  console.warn("Falling back to 50/50 odds for catalogue market without lastTradedPrice", {
    conditionId: entry.conditionId,
  });
  return { yes: 50, no: 50 };
}

function buildMarketsQueryString(params: GetMarketsParams): string {
  const search = new URLSearchParams();
  if (params.sort) search.set("sort", SORT_TO_QUERY[params.sort]);
  if (params.state) search.set("state", params.state);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  if (params.search?.trim()) search.set("search", params.search.trim());
  for (const t of params.tags ?? []) search.append("tag", t);
  // ?ids= is comma-separated per the OpenAPI spec, not repeated.
  if (params.ids && params.ids.length > 0)
    search.set("ids", params.ids.join(","));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Convert one catalogue entry into the frontend `Market` shape used by the
 * markets-list view. The response already carries the public market data the
 * list needs; the mapper just shapes it into the existing `Market` union.
 */
export function mapCatalogueEntryToMarket(entry: MarketCatalogueEntry): Market {
  const outcomes = orderAtomicOutcomes(entry.outcomes ?? []);
  const isYesNo = isYesNoUniverse(outcomes);

  const closingDate = entry.deadline ?? entry.createdAt;
  const title = entry.title ?? "Untitled Market";
  const imageUrl = entry.thumbnailUrl ?? "";
  const baseAsset = normalizeMarketBaseAsset(entry.baseAsset);
  const divisibility = normalizeMarketDivisibility(entry.divisibility);

  const base = {
    id: entry.conditionId,
    title,
    state: normalizeEngineMarketState(entry.state) ?? "open",
    imageUrl,
    categoryTags: entry.categoryTags ?? [],
    metaTags: [],
    volume: entry.volumeLifetimeSats ?? 0,
    liquidity: entry.liquiditySats ?? 0,
    liquiditySats: entry.liquiditySats ?? 0,
    volumeLifetimeSats: entry.volumeLifetimeSats ?? 0,
    closingDate,
    createdDate: entry.createdAt,
    activeSince: entry.createdAt,
    creatorFeePercent: 0,
    baseAsset,
    divisibility,
    baseMarket: marketUnitLabel(baseAsset),
  };

  if (isYesNo) {
    return {
      ...base,
      type: "yesno",
      currentOdds: resolveYesNoOdds(entry, divisibility),
    };
  }

  const evenOutcomePercent = 100 / Math.max(outcomes.length, 1);

  return {
    ...base,
    type: "categorical",
    outcomes: outcomes.map((label) => ({
      id: label,
      label,
      odds: evenOutcomePercent,
    })),
  };
}

/**
 * Fetch a page of markets from the matching-engine catalogue API
 * (`GET /api/v1/markets/query`). The frontend trust contract (ADR-009) is:
 * routine list/detail rendering is engine-first; critical operations must
 * fail closed or perform a later mint-authority check before funds move.
 */
export async function getMarkets(
  params: GetMarketsParams = {},
): Promise<GetMarketsResult> {
  const url = `/api/v1/markets/query${buildMarketsQueryString(params)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to query markets: ${response.status}`);
  }
  const body: MarketCatalogueResponse = await response.json();
  const markets = (body.markets ?? []).map(mapCatalogueEntryToMarket);
  return {
    markets,
    nextCursor: body.nextCursor ?? null,
    lastSuccessfulRefreshAt: body.lastSuccessfulRefreshAt,
  };
}

export function filterMarkets(
  markets: Market[],
  filter: FilterState,
): Market[] {
  let result = markets;

  if (filter.searchQuery) {
    const query = filter.searchQuery.toLowerCase();
    result = result.filter((m) => m.title.toLowerCase().includes(query));
  }

  // Multi-tag OR semantics: a market matches if ANY of its meta/category
  // tags is in the selected set. Empty set means "no tag filter".
  if (filter.selectedTags.length > 0) {
    const wanted = new Set(filter.selectedTags);
    result = result.filter(
      (m) =>
        m.metaTags.some((id) => wanted.has(id)) ||
        m.categoryTags.some((id) => wanted.has(id)),
    );
  }

  if (filter.marketTypes.length > 0) {
    result = result.filter((m) => filter.marketTypes.includes(m.type));
  }

  if (filter.volumeRange.min !== undefined) {
    const min = filter.volumeRange.min;
    result = result.filter((m) => m.volume >= min);
  }

  if (filter.volumeRange.max !== undefined) {
    const max = filter.volumeRange.max;
    result = result.filter((m) => m.volume <= max);
  }

  if (filter.closingInDays !== undefined) {
    const days = filter.closingInDays;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);
    result = result.filter((m) => new Date(m.closingDate) <= cutoff);
  }

  return result;
}

// =============================================================================
// Market Detail Data Fetching
// =============================================================================

function mapCatalogueEntryToMarketDetail(entry: MarketCatalogueEntry): MarketDetail {
  const outcomes = orderAtomicOutcomes(entry.outcomes ?? []);
  const mappedOutcomes = outcomes.map((label) => ({
    id: label,
    label,
    odds: 100 / Math.max(outcomes.length, 1),
  }));
  const now = new Date().toISOString();
  const createdAt = entry.createdAt ?? now;
  const title = entry.title?.trim() || "Untitled Market";
  const description = entry.description?.trim();
  const creatorPubkey = entry.creatorPubkey?.trim();
  const normalisedState = normalizeEngineMarketState(entry.state);
  const finalOutcome = entry.finalOutcome?.trim() || undefined;
  const resolutionDate = entry.closedAt ?? entry.deadline ?? createdAt;
  const isYesNo = isYesNoUniverse(outcomes);
  const baseAsset = normalizeMarketBaseAsset(entry.baseAsset);
  const divisibility = normalizeMarketDivisibility(entry.divisibility);

  const base = {
    id: entry.conditionId,
    title,
    state: normalisedState ?? undefined,
    imageUrl: entry.thumbnailUrl ?? undefined,
    categoryTags: (entry.categoryTags ?? []).map((id) => ({
      id,
      label: id,
      marketCount: 0,
    })),
    volume: entry.volumeLifetimeSats ?? 0,
    liquidity: entry.liquiditySats ?? 0,
    liquiditySats: entry.liquiditySats ?? 0,
    volumeLifetimeSats: entry.volumeLifetimeSats ?? 0,
    closingDate: entry.deadline ?? null,
    createdDate: createdAt,
    activeSince: createdAt,
    baseAsset,
    divisibility,
    baseUnit: marketUnitLabel(baseAsset),
    mint: {
      collateral: baseAsset,
      keysetCount: 0,
    },
    creator: creatorPubkey
      ? {
          id: creatorPubkey,
          name: `${creatorPubkey.slice(0, 8)}...${creatorPubkey.slice(-4)}`,
          totalMarketsCreated: 0,
          feePercent: 0,
        }
      : {
          id: "unknown",
          name: "Unknown",
          totalMarketsCreated: 0,
          feePercent: 0,
        },
    outcomes: mappedOutcomes,
    resolution: {
      criteria: description || title,
      source: "oracle" as const,
      resolutionDate,
      status: finalOutcome ? ("resolved" as const) : ("open" as const),
      finalOutcome,
    },
    priceHistory: { data: [], timeframe: "7d" as const },
    orderBook: { bids: [], asks: [], spread: 0 },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
  };

  if (isYesNo) {
    return {
      ...base,
      type: "yesno",
      currentOdds: { yes: 50, no: 50 },
    };
  }

  return {
    ...base,
    type: "categorical",
    outcomePriceHistories: {},
    outcomeOrderBooks: {},
  };
}

/**
 * Resolve the engine catalogue entry for a single `conditionId`. Used by the
 * detail page to read engine-authoritative fields (`outcomes`, `state`,
 * `thumbnailUrl`, `volumeLifetimeSats`, `liquiditySats`).
 * Creator-defined outcome order comes from engine registration metadata, not
 * mintd's one-vs-rest keysets.
 * Returns `null` when the engine has no record of the market or the request
 * fails.
 *
 * Single-shot: no retry delay. Callers that need retry-on-not-found (e.g.
 * newly registered markets that haven't been indexed yet) must implement the
 * retry loop in their own post-paint enrichment path so the blocking first
 * render is never delayed.
 */
async function fetchEngineCatalogueEntry(
  conditionId: string,
): Promise<MarketCatalogueEntry | null> {
  try {
    const url = `/api/v1/markets/query?ids=${encodeURIComponent(conditionId)}&state=All`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body: MarketCatalogueResponse = await response.json();
    return body.markets.find((m) => m.conditionId === conditionId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalise the engine `state` field at the boundary. Per the OpenAPI spec
 * (and `bitcaster-coding-guideline` Rule 1) the engine MUST emit `"open"` /
 * `"closed"` (camelCase). Both the InMemoryMatchingEngine and (as of this
 * writing) the production engine ship with NSwag-generated DTOs whose
 * property-level `[JsonConverter(typeof(JsonStringEnumConverter<T>))]`
 * attribute overrides the global naming policy and emits the bare enum
 * NAME — i.e. `"Open"` / `"Closed"` (PascalCase). Until the producer is
 * fixed upstream (track via the engine repo's TODO), normalise once here so
 * the detail page's exhaustive switch over `'open' | 'closed'` does not
 * fall through to `assertNever` on every load.
 *
 * This is the SOLE place this normalisation lives — Rule 2 forbids paving
 * over the case mismatch at every call site.
 */
function normalizeEngineMarketState(
  raw: unknown,
): MarketCatalogueEntry["state"] | null {
  if (raw == null) return null;
  const s = String(raw).toLowerCase().trim();
  if (s === "open" || s === "closed") return s;
  return null;
}

/**
 * Fetch the minimal engine entry for first-paint. Makes exactly one backend
 * request so the route shell renders immediately without any retry delay.
 *
 * Newly registered markets that have not yet been indexed by the engine will
 * cause this to throw "Market not found". The page's post-paint
 * `needsEngineDetailRefresh` polling loop (activated whenever `closingDate` or
 * `state` is missing) handles the catch-up without blocking initial render.
 */
export async function fetchMarketDetail(
  conditionId: string,
): Promise<MarketDetail> {
  // First render is engine-first and intentionally narrow: the route shell
  // should not wait on mintd, comments, or price history. Public market
  // outcome order is creator metadata recorded by the engine; mintd keysets
  // are one-vs-rest implementation details and are not an ordered display
  // contract. No retry loop here — one request, no delay.
  const engineEntry = await fetchEngineCatalogueEntry(conditionId);
  if (!engineEntry) {
    throw new Error(`Market not found: ${conditionId}`);
  }
  if (!engineEntry.outcomes || engineEntry.outcomes.length === 0) {
    throw new Error(`Market ${conditionId} is missing outcome metadata`);
  }
  return mapCatalogueEntryToMarketDetail(engineEntry);
}

export async function fetchMarketPriceHistory(
  conditionId: string,
  timeframe: PriceHistory["timeframe"] = "7d",
): Promise<MarketPriceHistoryResponse> {
  const params = new URLSearchParams({ timeframe });
  const response = await fetch(
    `/api/v1/markets/${encodeURIComponent(conditionId)}/price-history?${params}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch price history: ${response.status}`);
  }
  return (await response.json()) as MarketPriceHistoryResponse;
}

export async function fetchMarketComments(
  conditionId: string,
): Promise<MarketCommentsResponse> {
  const response = await fetch(
    `/api/v1/markets/${encodeURIComponent(conditionId)}/comments`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch comments: ${response.status}`);
  }
  return (await response.json()) as MarketCommentsResponse;
}

export function applyMarketComments(
  market: MarketDetail,
  response: MarketCommentsResponse,
): MarketDetail {
  return {
    ...market,
    comments: response.comments.map((comment) => ({
      id: comment.commentId,
      userId: `comment:${comment.commentId}`,
      userDisplayName: "Verified trader",
      userAvatarUrl: undefined,
      content: comment.content,
      timestamp: comment.createdAt,
      likeCount: 0,
      isLiked: false,
    })),
  };
}

const MAX_PRICE_HISTORY_POINTS_PER_OUTCOME = 1000;

// Width of each timeframe window in milliseconds. The chart X-axis scale is
// derived from the visible point span, so trimming the series to the active
// window keeps the date ticks proportional to the selected timeframe instead
// of always spanning the full retained history. `all` keeps the newest capped
// retained points so live tabs cannot grow without bound.
const TIMEFRAME_WINDOW_MS: Record<PriceHistory["timeframe"], number | null> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/**
 * Trim a price series to the active timeframe window. Anchored on the newest
 * sample (not wall-clock now) so a series whose latest point is older than the
 * window still renders. One pre-window point is retained so the step line has a
 * defined starting value at the left edge of the window.
 */
export function windowPriceHistory(history: PriceHistory): PriceHistory {
  const windowMs = TIMEFRAME_WINDOW_MS[history.timeframe];
  if (history.data.length === 0) return history;
  const byTimestamp = new Map<string, PricePoint>();
  for (const point of history.data) byTimestamp.set(point.timestamp, point);
  const sorted = [...byTimestamp.values()].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  if (windowMs === null) {
    return {
      ...history,
      data: sorted.slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME),
    };
  }
  const newest = new Date(sorted[sorted.length - 1].timestamp).getTime();
  const cutoff = newest - windowMs;
  const firstInWindow = sorted.findIndex(
    (p) => new Date(p.timestamp).getTime() >= cutoff,
  );
  if (firstInWindow <= 0) {
    return {
      ...history,
      data: sorted.slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME),
    };
  }
  // Keep one point before the cutoff so the line has a left-edge value.
  return {
    ...history,
    data: sorted
      .slice(firstInWindow - 1)
      .slice(-MAX_PRICE_HISTORY_POINTS_PER_OUTCOME),
  };
}

export function priceNumeratorToPercent(price: number, divisibility: number): number {
  if (!Number.isFinite(price)) return 0;
  const normalizedDivisibility = normalizeMarketDivisibility(divisibility);
  return Math.max(0, Math.min(100, (price / normalizedDivisibility) * 100));
}

function normalizePricePoint(
  point: MarketPriceHistoryResponse["outcomes"][number]["data"][number],
  divisibility: number,
) {
  return {
    timestamp: point.timestamp,
    price: priceNumeratorToPercent(point.price, divisibility),
    volume: point.volumeSubunits ?? point.volumeSats,
    source: point.source,
  };
}

export function appendLivePricePoint(
  history: PriceHistory,
  point: { timestamp: string; price: number; volume?: number },
): PriceHistory {
  const byTimestamp = new Map(history.data.map((p) => [p.timestamp, p]));
  byTimestamp.set(point.timestamp, point);
  return windowPriceHistory({
    ...history,
    data: [...byTimestamp.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
  });
}

export function applyMarketPriceHistory(
  market: MarketDetail,
  response: MarketPriceHistoryResponse,
): MarketDetail {
  const byOutcomeLabel = new Map(
    (market.outcomes ?? []).map(
      (outcome) => [outcome.label, outcome.id] as const,
    ),
  );
  const toPriceHistory = (
    data: MarketPriceHistoryResponse["outcomes"][number]["data"],
  ): PriceHistory =>
    windowPriceHistory({
      timeframe: response.timeframe as PriceHistory["timeframe"],
      data: data.map((point) => normalizePricePoint(point, market.divisibility ?? DEFAULT_MARKET_DIVISIBILITY)),
    });
  const histories = Object.fromEntries(
    response.outcomes.map((outcome) => {
      const outcomeId =
        byOutcomeLabel.get(outcome.outcomeId) ?? outcome.outcomeId;
      return [outcomeId, toPriceHistory(outcome.data)] as const;
    }),
  );
  const primary =
    market.type === "yesno"
      ? (histories[
          byOutcomeLabel.get("YES") ?? byOutcomeLabel.get("Yes") ?? "outcome-0"
        ] ?? histories[Object.keys(histories)[0]])
      : histories[Object.keys(histories)[0]];

  if (market.type === "categorical") {
    return {
      ...market,
      priceHistory: primary ?? market.priceHistory,
      outcomePriceHistories: histories,
    };
  }

  return {
    ...market,
    priceHistory: primary ?? market.priceHistory,
  };
}

export function mapSnapshotToOrderBook(snapshot: OrderBookSnapshot): OrderBook {
  let cumulativeBid = 0;
  const bids: Order[] = snapshot.bids.map((level) => {
    cumulativeBid += level.amount;
    return { price: level.price, amount: level.amount, total: cumulativeBid };
  });

  let cumulativeAsk = 0;
  const asks: Order[] = snapshot.asks.map((level) => {
    cumulativeAsk += level.amount;
    return { price: level.price, amount: level.amount, total: cumulativeAsk };
  });

  return {
    bids,
    asks,
    spread: snapshot.spread ?? 0,
    depthLimit: snapshot.depthLimit ?? undefined,
  };
}

export async function fetchOrderBook(marketId: string): Promise<OrderBook> {
  const snapshot = await new BitcasterEngineClient({
    baseUrl: window.location.origin,
  }).getOrderBook(marketId);
  return mapSnapshotToOrderBook(snapshot as OrderBookSnapshot);
}

export async function submitOrder(
  marketId: string,
  params: SubmitOrderRequest,
): Promise<SubmitOrderResponse> {
  return (await createAuthenticatedBrowserEngineClient().submitOrder(
    marketId,
    params as SdkSubmitOrderRequest,
  )) as SubmitOrderResponse;
}

export async function signTradeComment(
  conditionId: string,
  content: string,
): Promise<NostrKind1Event> {
  const ndk = getNdk();
  if (!ndk.signer)
    throw new Error("No Nostr signer configured — connect in Settings first");
  const event = new NDKEvent(ndk);
  event.kind = 1;
  event.created_at = Math.floor(Date.now() / 1000);
  event.content = content;
  event.tags = [
    [
      "r",
      `${window.location.origin}/markets/${encodeURIComponent(conditionId)}`,
    ],
  ];
  await event.sign();
  const raw = event.rawEvent();
  return {
    id: raw.id ?? "",
    pubkey: raw.pubkey ?? "",
    createdAt: raw.created_at ?? event.created_at,
    kind: 1,
    tags: raw.tags ?? event.tags,
    content: raw.content ?? content,
    sig: raw.sig ?? "",
  };
}

export function createAuthenticatedBrowserEngineClient(): BitcasterEngineClient {
  return new BitcasterEngineClient({
    baseUrl: window.location.origin,
    authorization: async ({ url, method, bodyText }) => {
      const payloadHash = bodyText
        ? await sha256Hex(new TextEncoder().encode(bodyText))
        : undefined;
      return generateNip98Header(url, method, payloadHash);
    },
  });
}

// =============================================================================
// Market Creation API
// =============================================================================

export class MintError extends Error {
  constructor(
    public readonly code: number,
    public readonly detail: string,
  ) {
    super(`[Mint] ${detail}`);
    this.name = "MintError";
  }
}

/** Parse a non-OK mint response into a MintError with the CDK error code. */
async function parseMintError(
  response: Response,
  fallbackPrefix: string,
): Promise<MintError> {
  let code = 0;
  let detail = `${fallbackPrefix}: ${response.status}`;
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      code = typeof body.code === "number" ? body.code : 0;
      detail = body.detail ?? body.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* empty */
  }
  return new MintError(code, detail);
}

export async function registerCondition(params: {
  tags: string[][];
  announcementHex: string;
  collateral?: string;
  outcomeCollections?: readonly string[];
  fee?: readonly Proof[];
  outputs?: readonly SerializedBlindedMessage[];
}): Promise<{
  condition_id: string;
  keysets: Record<string, string>;
  change?: SerializedBlindedSignature[];
}> {
  const response = await fetch("/v1/conditions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tags: params.tags,
      announcements: [params.announcementHex],
      ...(params.collateral ? { collateral: params.collateral } : {}),
      ...(params.outcomeCollections
        ? { outcome_collections: params.outcomeCollections }
        : {}),
      ...(params.fee ? { fee: params.fee.map(toWireAmountBearing) } : {}),
      ...(params.outputs ? { outputs: params.outputs.map(toWireAmountBearing) } : {}),
    }),
  });
  if (!response.ok) {
    throw await parseMintError(response, "Failed to register condition");
  }
  return response.json();
}

/**
 * Lowercase-hex SHA-256 of a byte buffer. Used to bind NIP-98 tokens to
 * the request body (`payload` tag); the matching engine rejects body-bearing
 * REST verbs whose token's `payload` does not match the digest of the bytes
 * the server actually receives.
 */
async function sha256Hex(data: BufferSource): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

/**
 * Generate a NIP-98 Authorization header using NDK's active signer.
 * Works with both NIP-07 (browser extension) and nsec (private key) signers.
 *
 * When `payloadHash` is supplied (lowercase-hex SHA-256 of the request body),
 * a `payload` tag is added per NIP-98. The matching engine REQUIRES this for
 * `POST`/`PUT`/`PATCH` — without it, the request is rejected as a replay
 * candidate. GET / DELETE / SignalR-negotiate calls omit the parameter.
 *
 * Exported so other modules (portfolio store, MarketHub helper, etc.) can
 * reuse a single implementation instead of each growing its own NDK wiring.
 */
export async function generateNip98Header(
  url: string,
  method: string,
  payloadHash?: string,
): Promise<string> {
  const ndk = getNdk();
  if (!ndk.signer)
    throw new Error("No Nostr signer configured — connect in Settings first");
  const event = new NDKEvent(ndk);
  event.kind = 27235;
  event.created_at = Math.floor(Date.now() / 1000);
  event.content = "";
  event.tags = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (payloadHash) {
    event.tags.push(["payload", payloadHash]);
  }
  await event.sign();
  const token = btoa(JSON.stringify(event.rawEvent()));
  return `Nostr ${token}`;
}

export async function createMarket(
  conditionId: string,
  params: CreateMarketRequest,
  thumbnailFile?: File | null,
): Promise<CreateMarketResponse> {
  const formData = new FormData();
  formData.append("metadata", JSON.stringify(params));
  if (thumbnailFile) {
    formData.append("thumbnail", thumbnailFile);
  }
  const url = `${window.location.origin}/api/v1/markets/${conditionId}`;
  // Multipart bodies need pre-serialization so the NIP-98 `payload` tag binds
  // to the exact bytes (including the random multipart boundary) that fetch
  // will ship. Construct a transient Request to serialize, hash, then send
  // the same bytes with the same Content-Type so server-side SHA-256 matches.
  const serialized = new Request(url, { method: "POST", body: formData });
  const bodyBytes = await serialized.arrayBuffer();
  const contentType =
    serialized.headers.get("Content-Type") ?? "multipart/form-data";
  const payloadHash = await sha256Hex(bodyBytes);
  const authHeader = await generateNip98Header(url, "POST", payloadHash);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType, Authorization: authHeader },
    body: bodyBytes,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      const raw =
        body.detail ?? body.title ?? body.message ?? JSON.stringify(body);
      detail =
        typeof raw === "string" ? raw.slice(0, 500) : String(raw).slice(0, 500);
    } catch {
      detail = response.statusText || detail;
    }
    throw new Error(`[Matching Engine] Failed to create market: ${detail}`);
  }
  return response.json();
}

export async function submitOracleAttestation(
  conditionId: string,
  event: OracleNostrEvent,
): Promise<OracleAttestationResponse> {
  const response = await fetch(
    `/api/v1/markets/${encodeURIComponent(conditionId)}/oracle-attestation`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    },
  );
  const body = (await response
    .json()
    .catch(() => null)) as OracleAttestationResponse | null;
  if (!response.ok) {
    throw new Error(
      body?.result
        ? `Oracle attestation rejected: ${body.result}`
        : `Oracle attestation rejected: HTTP ${response.status}`,
    );
  }
  if (!body) throw new Error("Oracle attestation response was empty");
  return body;
}

export async function fetchThumbnailUrl(
  conditionId: string,
): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/${conditionId}/thumbnail`, {
      method: "HEAD",
    });
    if (response.ok) return `/api/v1/${conditionId}/thumbnail`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a market's thumbnail URL for rendering. Returns the canonical
 * matching-engine thumbnail URL when the engine reports a stored image,
 * the explicit URL the caller has already resolved, or `null` when no
 * thumbnail is available — the caller renders a placeholder asset instead
 * of letting `<div style="background-image: url()">` produce a broken
 * empty-string URL request (the P6 P4.3 regression).
 */
export function getMarketThumbnail(market: {
  id: string;
  imageUrl?: string | null;
}): string | null {
  const explicit = market.imageUrl;
  if (typeof explicit === "string" && explicit.trim().length > 0)
    return explicit;
  return null;
}

// =============================================================================
// AMM Bot Deposit API (matching engine MarketFunding aggregate)
// =============================================================================

export type RequestLnInvoiceDepositRequest =
  components["schemas"]["RequestLnInvoiceDepositRequest"];
export type RequestLnInvoiceDepositResponse =
  components["schemas"]["RequestLnInvoiceDepositResponse"];
export type RequestEcashDepositRequest =
  components["schemas"]["RequestEcashDepositRequest"];
export type RequestEcashDepositResponse =
  components["schemas"]["RequestEcashDepositResponse"];
export type ParticipationScoreResponse =
  components["schemas"]["ParticipationScoreResponse"];
export type PayParticipationScoreEcashResponse =
  components["schemas"]["PayParticipationScoreEcashResponse"];
export type GetDepositResponseDto =
  components["schemas"]["GetDepositResponseDto"];
export type DepositState = components["schemas"]["DepositState"];
export type DepositMethod = components["schemas"]["DepositMethod"];

export interface MarketFundingDepositOptions {
  creatorPubkey?: string | null;
  fundAmm?: boolean;
}

function normalizeDepositState(state: unknown): DepositState {
  switch (state) {
    case "Requested":
    case "requested":
      return "requested";
    case "Paid":
    case "paid":
      return "paid";
    case "Credited":
    case "credited":
      return "credited";
    case "Failed":
    case "failed":
      return "failed";
    default:
      throw new Error(`Unknown deposit state: ${String(state)}`);
  }
}

function normalizeDepositMethod(method: unknown): DepositMethod {
  switch (method) {
    case "LightningInvoice":
    case "lightningInvoice":
      return "lightningInvoice";
    case "Ecash":
    case "ecash":
      return "ecash";
    default:
      throw new Error(`Unknown deposit method: ${String(method)}`);
  }
}

/**
 * Request a Lightning invoice for a market's AMM bot deposit. The returned
 * `bolt11` is bearer material — it appears only in this immediate response,
 * never in the polling endpoint, so capture and display it before navigating
 * away.
 */
export async function requestLnInvoiceDeposit(
  conditionId: string,
  amountSats: number,
  options: MarketFundingDepositOptions = {},
): Promise<RequestLnInvoiceDepositResponse> {
  const url = `${window.location.origin}/api/v1/markets/${conditionId}/deposit/ln-invoice`;
  const body: RequestLnInvoiceDepositRequest = { amountSats, fundAmm: false };
  if (options.creatorPubkey) body.creatorPubkey = options.creatorPubkey;
  if (options.fundAmm !== undefined) body.fundAmm = options.fundAmm;
  const bodyText = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyText);
  const payloadHash = await sha256Hex(bodyBytes);
  const authHeader = await generateNip98Header(url, "POST", payloadHash);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: bodyText,
  });
  if (!response.ok) {
    throw new Error(
      `[Matching Engine] Failed to request LN deposit: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

/**
 * Submit ecash proofs as a market's AMM bot deposit. Phase 1 of the engine
 * records the request and defers proof verification to the wallet-service;
 * the deposit walks `Requested → Paid → Credited` as the wallet-service
 * confirms.
 */
export async function requestEcashDeposit(
  conditionId: string,
  amountSats: number,
  proofsToken: string,
  options: MarketFundingDepositOptions = {},
): Promise<RequestEcashDepositResponse> {
  const url = `${window.location.origin}/api/v1/markets/${conditionId}/deposit/ecash`;
  const body: RequestEcashDepositRequest = { amountSats, proofsToken, fundAmm: false };
  if (options.creatorPubkey) body.creatorPubkey = options.creatorPubkey;
  if (options.fundAmm !== undefined) body.fundAmm = options.fundAmm;
  const bodyText = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyText);
  const payloadHash = await sha256Hex(bodyBytes);
  const authHeader = await generateNip98Header(url, "POST", payloadHash);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: bodyText,
  });
  if (!response.ok) {
    throw new Error(
      `[Matching Engine] Failed to submit ecash deposit: ${response.status} ${await response.text()}`,
    );
  }
  const result = (await response.json()) as RequestEcashDepositResponse;
  return { ...result, state: normalizeDepositState(result.state) };
}

/**
 * Polling read of a deposit's current lifecycle state. Public — no auth.
 * Returns `null` when the engine has no record of `depositId` for this
 * `conditionId` (404). Bearer payment instruments (bolt11) and proof
 * material are deliberately excluded from this shape by the engine.
 */
export async function getDepositStatus(
  conditionId: string,
  depositId: string,
): Promise<GetDepositResponseDto | null> {
  const url = `${window.location.origin}/api/v1/markets/${conditionId}/deposit/${depositId}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to read deposit status: ${response.status}`);
  }
  const result = (await response.json()) as GetDepositResponseDto;
  return {
    ...result,
    state: normalizeDepositState(result.state),
    method: normalizeDepositMethod(result.method),
  };
}

export async function getParticipationScore(): Promise<ParticipationScoreResponse> {
  return createAuthenticatedBrowserEngineClient().getParticipationScore();
}

export async function payParticipationScoreEcash(
  amountSats: number,
  proofsToken: string,
  paymentId?: string,
): Promise<PayParticipationScoreEcashResponse> {
  return createAuthenticatedBrowserEngineClient().payParticipationScoreEcash(
    amountSats,
    proofsToken,
    paymentId,
  );
}

/**
 * Fetch the list of markets the matching engine has indexed under a given
 * creator pubkey. The engine returns volume/created-at for markets it knows
 * about; the client is responsible for merging this with its own store so
 * markets the backend hasn't indexed still show up as `0` volume.
 */
export async function fetchCreatorMarkets(
  pubkey: string,
): Promise<CreatorMarketsResponse> {
  const response = await fetch(`/api/v1/creators/${pubkey}/markets`);
  if (!response.ok) {
    throw new Error(`Failed to fetch creator markets: ${response.status}`);
  }
  return response.json();
}
