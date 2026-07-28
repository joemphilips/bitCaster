import { describe, expect, it } from "vitest";
import type { Market } from "@/types/market";
import { reconcileLikedMarketCloses } from "../likedMarketClose";

function market(id: string, state: Market["state"]): Market {
  // Minimal shape sufficient for the reconcile — only `id` and `state` are read.
  return {
    id,
    title: id,
    state,
    type: "yesno",
    currentOdds: { yes: 50, no: 50 },
    imageUrl: "",
    categoryTags: [],
    metaTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: "",
    createdDate: "",
    activeSince: "",
    creatorFeePercent: 0,
    baseMarket: "sats",
    baseAsset: "sat",
    divisibility: 10_000,
  };
}

const COND = "a".repeat(64);
// useLikedMarkets maps `market.id = entry.conditionId` (the bare conditionId,
// no `-{outcome}` suffix), so the reconcile sees the conditionId as the id.
const MARKET_ID = COND;

describe("reconcileLikedMarketCloses", () => {
  it("emits a market_closed notification on an open -> closed transition", () => {
    const { notifications, nextStates } = reconcileLikedMarketCloses(
      [market(MARKET_ID, "closed")],
      { [MARKET_ID]: "open" },
      1_700_000_000_000,
    );

    expect(notifications).toHaveLength(1);
    const n = notifications[0];
    expect(n.kind).toBe("market_closed");
    expect(n.id).toBe(`${MARKET_ID}-market_closed`);
    expect(n.marketId).toBe(MARKET_ID);
    expect(n.conditionId).toBe(COND);
    // finalOutcome is the oracle-attested winning outcome — not encoded in the
    // marketId/conditionId — so the reconcile leaves it unset (the user sees it
    // on the market/portfolio surface when they open the notification).
    expect(n.finalOutcome).toBeUndefined();
    expect(n.closedAt).toBe(1_700_000_000_000);
    expect(nextStates[MARKET_ID]).toBe("closed");
  });

  it("does not notify when a market is first seen already closed (no prior open record)", () => {
    const { notifications, nextStates } = reconcileLikedMarketCloses(
      [market(MARKET_ID, "closed")],
      {},
    );
    expect(notifications).toHaveLength(0);
    // But we still record it so a later open->closed elsewhere is consistent.
    expect(nextStates[MARKET_ID]).toBe("closed");
  });

  it("does not notify when the market stays open", () => {
    const { notifications } = reconcileLikedMarketCloses([market(MARKET_ID, "open")], {
      [MARKET_ID]: "open",
    });
    expect(notifications).toHaveLength(0);
  });

  it("does not re-notify when an already-closed market stays closed", () => {
    const { notifications } = reconcileLikedMarketCloses([market(MARKET_ID, "closed")], {
      [MARKET_ID]: "closed",
    });
    expect(notifications).toHaveLength(0);
  });
});
