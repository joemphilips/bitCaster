import { describe, expect, it } from "vitest";
import { SETTLEMENT_KINDS, validateTradeCreatedProtocol } from "@bitcaster/client-sdk/tradeSession";

describe("shared trade-session protocol validation", () => {
  it("accepts direct swaps with valid locktime ordering", () => {
    expect(
      validateTradeCreatedProtocol({
        sellerLocktime: 120,
        buyerLocktime: 60,
        settlementKind: SETTLEMENT_KINDS.directSwap,
      }),
    ).toBeNull();
  });

  it("rejects unsupported settlement kinds fail-closed", () => {
    expect(
      validateTradeCreatedProtocol({
        sellerLocktime: 120,
        buyerLocktime: 60,
        settlementKind: "SellSellMerge",
      }),
    ).toContain("unsupported settlement kind");
  });

  it("requires mint split settlement metadata", () => {
    expect(
      validateTradeCreatedProtocol({
        sellerLocktime: 120,
        buyerLocktime: 60,
        settlementKind: SETTLEMENT_KINDS.mint,
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 100,
      }),
    ).toContain("positive quote payment");
  });
});
