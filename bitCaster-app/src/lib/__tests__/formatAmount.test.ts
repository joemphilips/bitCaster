import { describe, expect, it } from "vitest";
import { formatAmount, groupAmountsByUnit } from "../formatAmount";

describe("formatAmount", () => {
  it("formats sat market subunits as sats", () => {
    expect(formatAmount(1_000_000, "sat")).toBe("1,000 sats");
  });

  it("formats USD cents as dollars", () => {
    expect(formatAmount(23, "usd")).toBe("$0.23");
    expect(formatAmount(-123, "usd")).toBe("-$1.23");
  });
});

describe("groupAmountsByUnit", () => {
  it("keeps sat and USD totals separate", () => {
    const totals = groupAmountsByUnit(
      [
        { unit: "sat", amount: 1000 },
        { unit: "usd", amount: 23 },
        { unit: "sat", amount: 500 },
      ],
      (item) => item.unit,
      (item) => item.amount,
    );
    expect(totals).toEqual([
      { unit: "sat", amount: 1500 },
      { unit: "usd", amount: 23 },
    ]);
  });
});
