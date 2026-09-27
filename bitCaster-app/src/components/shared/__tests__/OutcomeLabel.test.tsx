import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NEUTRAL_OUTCOME_COLOR, normalizeOutcomeColor, OutcomeLabel } from "../OutcomeLabel";

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
