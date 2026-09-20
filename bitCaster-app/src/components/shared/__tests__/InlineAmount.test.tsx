import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InlineAmount } from "../InlineAmount";

describe("InlineAmount", () => {
  it.each([
    [0, "0 sats"],
    [1, "0.001 sats"],
    [100, "0.1 sats"],
    [999, "0.999 sats"],
    [1_000, "1 sats"],
    [1_001, "1.001 sats"],
  ])("preserves the exact SDK amount for %s msat", (amountSubunits, expected) => {
    render(<InlineAmount amountSubunits={amountSubunits} baseAsset="sat" />);

    expect(screen.getByRole("group", { name: expected })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: expected })).toHaveTextContent(expected);
  });

  it("handles a large safe amount without changing the SDK text", () => {
    render(<InlineAmount amountSubunits={Number.MAX_SAFE_INTEGER} baseAsset="sat" />);

    expect(screen.getByRole("group", { name: "9,007,199,254,740.991 sats" })).toBeInTheDocument();
  });

  it("keeps locale grouping and decimal text in the accessible name", () => {
    render(<InlineAmount amountSubunits={1_001_000} baseAsset="sat" />);

    const amount = screen.getByRole("group", { name: "1,001 sats" });
    expect(amount).toHaveAttribute("title", "1,001 sats");
    expect(amount).toHaveTextContent("1,001 sats");
  });

  it("renders one unit label and smaller fractional digits", () => {
    render(<InlineAmount amountSubunits={1_001} baseAsset="sat" />);

    const amount = screen.getByRole("group", { name: "1.001 sats" });
    expect(amount.textContent).toBe("1.001 sats");
    expect(amount.querySelectorAll(".text-\\[0\\.75em\\]")).toHaveLength(1);
    expect(amount.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  });
});
