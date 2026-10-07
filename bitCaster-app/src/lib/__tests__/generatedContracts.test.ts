import { describe, expect, it } from "vitest";

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
