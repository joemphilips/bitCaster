import type { Outcome } from "@/types/market";

export const NEUTRAL_OUTCOME_COLOR = "#808080";
const OUTCOME_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export const CATEGORICAL_OUTCOME_PALETTE = [
  "#59A14F",
  "#E15759",
  "#F28E2B",
  "#4E79A7",
  "#76B7B2",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#2563EB", // Reusing eight defaults would repeat or duplicate a color in a full draft.
] as const;

export function nextCategoricalOutcomeColor(colors: readonly (string | undefined)[]): string {
  const used = new Set(
    colors
      .filter((color) => color && OUTCOME_COLOR_PATTERN.test(color))
      .map((color) => color!.toUpperCase()),
  );
  const color = CATEGORICAL_OUTCOME_PALETTE.find((candidate) => !used.has(candidate));
  if (!color) throw new Error("No unused categorical outcome color remains.");
  return color;
}

export function categoricalOutcomeColors(outcomes: readonly { color?: string }[]): string[] {
  const used = outcomes.map((outcome) => outcome.color);
  return outcomes.map((outcome) => {
    if (outcome.color && OUTCOME_COLOR_PATTERN.test(outcome.color)) return outcome.color;
    const color = nextCategoricalOutcomeColor(used);
    used.push(color);
    return color;
  });
}

export function normalizeOutcomeColor(color: string | undefined): string {
  return color && OUTCOME_COLOR_PATTERN.test(color) ? color.toUpperCase() : NEUTRAL_OUTCOME_COLOR;
}

interface OutcomeLabelProps {
  outcome: Pick<Outcome, "label" | "color">;
  className?: string;
  labelClassName?: string;
  swatchClassName?: string;
}

export function OutcomeLabel({
  outcome,
  className = "",
  labelClassName = "",
  swatchClassName = "h-2 w-2",
}: OutcomeLabelProps) {
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-2 ${className}`}
      data-outcome-label={outcome.label}
    >
      <span
        aria-hidden="true"
        data-testid="outcome-color-swatch"
        className={`shrink-0 rounded-full ${swatchClassName}`}
        style={{ backgroundColor: normalizeOutcomeColor(outcome.color) }}
      />
      {outcome.label && <span className={labelClassName}>{outcome.label}</span>}
    </span>
  );
}
