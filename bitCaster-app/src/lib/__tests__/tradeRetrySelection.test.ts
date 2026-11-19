import { describe, expect, it } from "vitest";
import { tradeSelectionForRetry } from "../tradeRetrySelection";

const yesNo = {
  id: "condition-yn",
  type: "yesno" as const,
  baseAsset: "sat" as const,
  divisibility: 1_000,
  outcomes: [
    { id: "Yes", label: "Yes" },
    { id: "No", label: "No" },
  ],
};

const categorical = {
  id: "condition-cat",
  type: "categorical" as const,
  baseAsset: "sat" as const,
  divisibility: 1_000,
  outcomes: [
    { id: "alpha-id", label: "Alpha" },
    { id: "beta-id", label: "Beta" },
    { id: "gamma-id", label: "Gamma" },
  ],
};

describe("trade selection of a retried order", () => {
  it.each([
    ["Outcome", { side: "yes" }],
    ["Complement", { side: "no" }],
  ] as const)("selects the %s token of a yes/no market", (tokenSide, selection) => {
    expect(tradeSelectionForRetry(yesNo, { orderRouteId: "condition-yn-Yes", tokenSide })).toEqual(
      selection,
    );
  });

  it.each([
    ["Outcome", { side: "yes", outcomeId: "beta-id" }],
    ["Complement", { side: "no", outcomeId: "beta-id" }],
  ] as const)("selects the %s token of one categorical outcome", (tokenSide, selection) => {
    expect(
      tradeSelectionForRetry(categorical, { orderRouteId: "condition-cat-Beta", tokenSide }),
    ).toEqual(selection);
  });

  it.each(["condition-other-Beta", "condition-cat-Delta"])(
    "selects nothing for the route %s that this market does not have",
    (orderRouteId) => {
      expect(
        tradeSelectionForRetry(categorical, { orderRouteId, tokenSide: "Outcome" }),
      ).toBeNull();
    },
  );
});
