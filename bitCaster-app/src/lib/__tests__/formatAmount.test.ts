import { describe, expect, it } from "vitest";
import { formatAmount, groupAmountsByUnit } from "../formatAmount";

describe("formatAmount", () => {
  it("formats sat market subunits as sats", () => {
    expect(formatAmount(1_000_000, "sat")).toBe("1,000 sats");
  });
});

describe("groupAmountsByUnit", () => {
  it("groups sat totals", () => {
    const totals = groupAmountsByUnit(
      [
        { unit: "sat" as const, amount: 1000 },
        { unit: "sat" as const, amount: 500 },
      ],
      (item) => item.unit,
      (item) => item.amount,
    );
    expect(totals).toEqual([{ unit: "sat", amount: 1500 }]);
  });
});
