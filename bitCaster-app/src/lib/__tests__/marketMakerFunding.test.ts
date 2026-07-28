import { describe, expect, it } from "vitest";
import {
  BINARY_AMM_FUNDING_TIERS,
  calculateAmmFundingPreview,
  formatFundingBudget,
  fundingTierBudget,
} from "../marketMakerFunding";

describe("market-maker funding math", () => {
  it("matches the binary Standard tier closed forms", () => {
    expect(calculateAmmFundingPreview(100_000, 2)).toEqual({
      depthPerCentSats: 5_800,
      cost50To60Sats: 32_200,
    });
  });

  it("returns sat tiers in msat subunits", () => {
    const [none, minimal, standard, deep] = BINARY_AMM_FUNDING_TIERS;

    // Sat tiers are defined in sats; fundingTierBudget returns msat subunits.
    expect(fundingTierBudget(none, "sat")).toBe(0);
    expect(fundingTierBudget(minimal, "sat")).toBe(10_000_000);
    expect(fundingTierBudget(standard, "sat")).toBe(100_000_000);
    expect(fundingTierBudget(deep, "sat")).toBe(500_000_000);

    expect(formatFundingBudget(1_500_000, "sat")).toBe("1,500 sats");
  });
});

describe("contract regeneration outputs", () => {
  it("keeps both generated clients present", () => {
    const generatedFiles = import.meta.glob(
      [
        "../../generated/api.ts",
        "../../../../BitCaster.MatchingEngine.Contracts/Generated/ApiContracts.g.cs",
      ],
      { eager: true, query: "?raw", import: "default" },
    );

    expect(generatedFiles["../../generated/api.ts"]).toBeTruthy();
    expect(
      generatedFiles["../../../../BitCaster.MatchingEngine.Contracts/Generated/ApiContracts.g.cs"],
    ).toBeTruthy();
  });
});
