import { describe, expect, it } from "vitest";
import type { components, paths } from "@/generated/api";

type LegacyEphemeralPubkeyPath = "/api/v1/trades/{tradeId}/ephemeral-pubkey";
type HasLegacyEphemeralPubkeyPath = LegacyEphemeralPubkeyPath extends keyof paths ? true : false;

const hasLegacyEphemeralPubkeyPath: HasLegacyEphemeralPubkeyPath = false;

describe("generated contract serialization", () => {
  it("omits the removed ephemeral pubkey endpoint", () => {
    expect(hasLegacyEphemeralPubkeyPath).toBe(false);
  });

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
      baseAsset: "sat",
      divisibility: 1_000,
      quotePaymentSubunits: 500,
      outcomeFaceAmountSubunits: 1000,
      tokenSide: "Outcome",
      settlementGroup: {
        groupId: "55555555-5555-5555-5555-555555555555",
        status: "Confirmed",
        revision: 1,
        coalescingDeadline: "2026-06-19T00:00:00Z",
        frozenAt: "2026-06-19T00:00:00Z",
      },
    };

    const roundTripped = JSON.parse(JSON.stringify(fill)) as components["schemas"]["Fill"];

    expect(roundTripped.baseAsset).toBe("sat");
    expect(roundTripped.divisibility).toBe(1_000);
    expect(roundTripped.quotePaymentSubunits).toBe(500);
    expect(roundTripped.outcomeFaceAmountSubunits).toBe(1000);
    expect(roundTripped.tokenSide).toBe("Outcome");
    expect(roundTripped).not.toHaveProperty("tradeId");
    expect(roundTripped).not.toHaveProperty("makerEphemeralPubkey");
  });
});
