import { describe, expect, it } from "vitest";
import type { components } from "@/generated/api";

describe("generated contract serialization", () => {
  it("Fill type round-trips canonical settlement fields", () => {
    const fill: components["schemas"]["Fill"] = {
      id: "11111111-1111-1111-1111-111111111111",
      takerOrderId: "22222222-2222-2222-2222-222222222222",
      makerOrderId: "33333333-3333-3333-3333-333333333333",
      amountSubunits: 1000,
      executionPrice: 500,
      path: "Complementary",
      status: "Filled",
      filledAt: "2026-06-19T00:00:00Z",
      baseAsset: "usd",
      divisibility: 1000,
      quotePaymentSubunits: 500,
      outcomeFaceAmountSubunits: 1000,
      tokenSide: "Outcome",
      tradeId: "44444444-4444-4444-4444-444444444444",
      makerEphemeralPubkey: "02" + "a".repeat(64),
    };

    const roundTripped = JSON.parse(JSON.stringify(fill)) as components["schemas"]["Fill"];

    expect(roundTripped.baseAsset).toBe("usd");
    expect(roundTripped.divisibility).toBe(1000);
    expect(roundTripped.quotePaymentSubunits).toBe(500);
    expect(roundTripped.outcomeFaceAmountSubunits).toBe(1000);
    expect(roundTripped.tokenSide).toBe("Outcome");
  });
});
