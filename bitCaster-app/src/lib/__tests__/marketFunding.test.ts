import { describe, expect, it } from "vitest";
import { mergeMarketFundingObservation, type MarketFundingObservation } from "../marketFunding";

describe("mergeMarketFundingObservation", () => {
  const current: MarketFundingObservation = {
    ammBotBudgetSubunits: 10_000,
    fundingRevision: "0002",
  };

  it.each([
    ["older revision", { ammBotBudgetSubunits: 20_000, fundingRevision: "0001" }],
    ["unversioned REST snapshot", { ammBotBudgetSubunits: 0, fundingRevision: null }],
    [
      "conflicting total for the same revision",
      { ammBotBudgetSubunits: 12_000, fundingRevision: "0002" },
    ],
  ] as const)("keeps the current observation when incoming data is %s", (_name, incoming) => {
    expect(mergeMarketFundingObservation(current, incoming)).toEqual(current);
  });

  it("accepts a newer total and revision as one observation", () => {
    expect(
      mergeMarketFundingObservation(current, {
        ammBotBudgetSubunits: 30_000,
        fundingRevision: "0003",
      }),
    ).toEqual({ ammBotBudgetSubunits: 30_000, fundingRevision: "0003" });
  });

  it("accepts a versioned observation before the first live revision", () => {
    expect(
      mergeMarketFundingObservation(
        { ammBotBudgetSubunits: 0, fundingRevision: null },
        { ammBotBudgetSubunits: 5_000, fundingRevision: "0001" },
      ),
    ).toEqual({ ammBotBudgetSubunits: 5_000, fundingRevision: "0001" });
  });

  it("allows a fresh unversioned baseline to replace a local placeholder", () => {
    expect(
      mergeMarketFundingObservation(
        { ammBotBudgetSubunits: 0 },
        { ammBotBudgetSubunits: 1_000, fundingRevision: null },
      ),
    ).toEqual({ ammBotBudgetSubunits: 1_000, fundingRevision: null });
  });

  it("does not leak stale unrelated model fields when it rejects a null revision", () => {
    const currentWithStaleTitle = {
      ...current,
      title: "stale title",
    };

    expect(
      mergeMarketFundingObservation(currentWithStaleTitle, {
        ammBotBudgetSubunits: 0,
        fundingRevision: null,
      }),
    ).toEqual(current);
  });

  it("does not leak event fields when accepting a newer observation", () => {
    const event = {
      conditionId: "condition",
      ammBotBudgetSubunits: 30_000,
      fundingRevision: "0003",
    };

    expect(mergeMarketFundingObservation(current, event)).toEqual({
      ammBotBudgetSubunits: 30_000,
      fundingRevision: "0003",
    });
  });
});
