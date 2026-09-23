import {
  formatMarketSubunits,
  marketSubunitLabel,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";

interface InlineAmountProps {
  amountSubunits: number;
  baseAsset: MarketBaseAsset;
  className?: string;
}

interface FormattedAmountParts {
  integer: string;
  fraction: string;
  unit: string;
}

/**
 * Split the SDK's complete locale-aware amount for visual emphasis only.
 * Keep this style markup in the frontend because the SDK has no JSX role.
 * The SDK string remains the accessible name and the unit is rendered once.
 */
function splitFormattedAmount(
  formattedAmount: string,
  baseAsset: MarketBaseAsset,
): FormattedAmountParts {
  const unitSuffix = ` ${marketSubunitLabel(baseAsset)}`;
  if (!formattedAmount.endsWith(unitSuffix)) {
    return { integer: formattedAmount, fraction: "", unit: "" };
  }

  const numericAmount = formattedAmount.slice(0, -unitSuffix.length);
  const decimalSeparator =
    Intl.NumberFormat()
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const decimalIndex = numericAmount.lastIndexOf(decimalSeparator);
  if (decimalIndex < 0) {
    return { integer: numericAmount, fraction: "", unit: unitSuffix };
  }

  return {
    integer: numericAmount.slice(0, decimalIndex),
    fraction: numericAmount.slice(decimalIndex),
    unit: unitSuffix,
  };
}

/** Render one compact sats amount without reimplementing SDK conversion. */
export function InlineAmount({ amountSubunits, baseAsset, className }: InlineAmountProps) {
  const formattedAmount = formatMarketSubunits(amountSubunits, baseAsset);
  const parts = splitFormattedAmount(formattedAmount, baseAsset);

  return (
    <span className={className} role="group" aria-label={formattedAmount} title={formattedAmount}>
      <span aria-hidden="true">
        {parts.integer}
        {parts.fraction && <span className="text-[0.75em] align-baseline">{parts.fraction}</span>}
        {parts.unit}
      </span>
    </span>
  );
}
