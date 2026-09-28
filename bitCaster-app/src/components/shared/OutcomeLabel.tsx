import type { Outcome } from "@/types/market";

export const NEUTRAL_OUTCOME_COLOR = "#808080";
const OUTCOME_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

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
