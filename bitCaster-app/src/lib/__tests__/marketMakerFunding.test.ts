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

  it("returns sat tiers in msat subunits and USD tiers in cent subunits", () => {
    const [none, minimal, standard, deep] = BINARY_AMM_FUNDING_TIERS;

    // Sat tiers are defined in sats; fundingTierBudget returns msat subunits.
    expect(fundingTierBudget(none, "sat")).toBe(0);
    expect(fundingTierBudget(minimal, "sat")).toBe(10_000_000);
    expect(fundingTierBudget(standard, "sat")).toBe(100_000_000);
    expect(fundingTierBudget(deep, "sat")).toBe(500_000_000);

    // USD tiers are already in cent subunits.
    expect(fundingTierBudget(none, "usd")).toBe(0);
    expect(fundingTierBudget(minimal, "usd")).toBe(10_000);
    expect(fundingTierBudget(standard, "usd")).toBe(100_000);
    expect(fundingTierBudget(deep, "usd")).toBe(500_000);

    // Unknown base asset must fail fast.
    expect(() => fundingTierBudget(minimal, "jpy")).toThrow();
  });

  it("fails fast when formatting an unsupported funding base asset", () => {
    expect(() => formatFundingBudget(1_500, "jpy")).toThrow(/unsupported base asset: jpy/);
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
