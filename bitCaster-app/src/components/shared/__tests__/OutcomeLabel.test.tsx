import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CATEGORICAL_OUTCOME_PALETTE,
  categoricalOutcomeColors,
  nextCategoricalOutcomeColor,
  NEUTRAL_OUTCOME_COLOR,
  normalizeOutcomeColor,
  OutcomeLabel,
} from "../OutcomeLabel";

describe("OutcomeLabel", () => {
  it.each([
    ["#a1b2c3", "#A1B2C3"],
    ["#bad", NEUTRAL_OUTCOME_COLOR],
    ["rgb(0, 0, 0)", NEUTRAL_OUTCOME_COLOR],
    [undefined, NEUTRAL_OUTCOME_COLOR],
  ])("normalizes %s to a safe outcome accent", (color, expected) => {
    render(<OutcomeLabel outcome={{ label: "Alpha", color }} />);

    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByTestId("outcome-color-swatch")).toHaveStyle({
      backgroundColor: expected,
    });
    expect(normalizeOutcomeColor(color)).toBe(expected);
  });
});

describe("categorical outcome palette", () => {
  it("assigns green, red, orange, then distinct colors while preserving manual hex values", () => {
    const colors = categoricalOutcomeColors(Array.from({ length: 8 }, () => ({})));
    expect(colors).toEqual([
      "#59A14F",
      "#E15759",
      "#F28E2B",
      "#4E79A7",
      "#76B7B2",
      "#EDC948",
      "#B07AA1",
      "#FF9DA7",
    ]);
    expect(new Set(colors).size).toBe(8);
    expect(categoricalOutcomeColors([{}, { color: "#59a14f" }, { color: "#123456" }, {}])).toEqual([
      "#E15759",
      "#59a14f",
      "#123456",
      "#F28E2B",
    ]);
  });

  it("keeps a different unused Automatic choice at the full eight-outcome bound", () => {
    const colors = [...CATEGORICAL_OUTCOME_PALETTE.slice(0, 8)];
    const selected = nextCategoricalOutcomeColor(colors);
    expect(selected).toBe("#2563EB");
    expect(colors).not.toContain(selected);
    expect(nextCategoricalOutcomeColor([selected, ...colors.slice(1)])).toBe("#59A14F");
  });

  it("refuses an exhausted candidate set instead of silently duplicating a color", () => {
    expect(() => nextCategoricalOutcomeColor(CATEGORICAL_OUTCOME_PALETTE)).toThrow(
      "No unused categorical outcome color remains.",
    );
  });
});
