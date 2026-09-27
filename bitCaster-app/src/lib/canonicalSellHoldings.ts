import { getCanonicalCtfProofPage, type BitcasterDB, db } from "@/stores/proof-db";
import type { SellHoldingsState } from "@/types/market-detail";

const LOADING_SELL_HOLDINGS: SellHoldingsState = { status: "loading" };
const UNAVAILABLE_SELL_HOLDINGS: SellHoldingsState = { status: "unavailable" };

export interface CanonicalSellHoldingsIdentity {
  readonly routeId: string;
  readonly conditionId: string;
  readonly scopeId: string;
  readonly mintUrl: string;
}

export interface CanonicalSellHoldingsResult {
  readonly identityKey: string;
  readonly status: "ready";
  readonly byOutcomeSetId: ReadonlyMap<
    string,
    { readonly selectableSubunits: number; readonly reservedSubunits: number }
  >;
}

export function canonicalSellHoldingsIdentityKey(identity: CanonicalSellHoldingsIdentity): string {
  return JSON.stringify([
    identity.routeId,
    identity.conditionId,
    identity.scopeId,
    identity.mintUrl,
  ]);
}

export function sellHoldingsForCurrentIdentity(
  result:
    | CanonicalSellHoldingsResult
    | { readonly identityKey: string; readonly status: "unavailable" }
    | null
    | undefined,
  currentIdentityKey: string | null,
): SellHoldingsState {
  if (currentIdentityKey === null || result?.identityKey !== currentIdentityKey) {
    return LOADING_SELL_HOLDINGS;
  }
  if (result.status === "unavailable") return UNAVAILABLE_SELL_HOLDINGS;
  return { status: "ready", byOutcomeSetId: result.byOutcomeSetId };
}

export async function readCanonicalMarketSellHoldings(
  identity: CanonicalSellHoldingsIdentity,
  database: BitcasterDB = db,
): Promise<CanonicalSellHoldingsResult> {
  const identityKey = canonicalSellHoldingsIdentityKey(identity);
  const totals = new Map<string, { selectableSubunits: number; reservedSubunits: number }>();

  for (const selectability of ["selectable", "locked"] as const) {
    let afterProofId: string | null = null;
    do {
      const page = await getCanonicalCtfProofPage(
        identity.mintUrl,
        {
          scopeId: identity.scopeId,
          conditionId: identity.conditionId,
          selectability,
          afterProofId,
        },
        database,
      );
      for (const proof of page.proofs) {
        if (proof.outcomeCollection === null) {
          throw new Error("canonical conditional holding has no outcome collection");
        }
        const current = totals.get(proof.outcomeCollection) ?? {
          selectableSubunits: 0,
          reservedSubunits: 0,
        };
        const field = selectability === "selectable" ? "selectableSubunits" : "reservedSubunits";
        const next = current[field] + proof.amount;
        if (!Number.isSafeInteger(next)) throw new Error("canonical holding total is out of range");
        totals.set(proof.outcomeCollection, { ...current, [field]: next });
      }
      afterProofId = page.nextProofId;
    } while (afterProofId !== null);
  }

  return { identityKey, status: "ready", byOutcomeSetId: totals };
}
