import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  checkMintPaymentAmount,
  classifyMintAmountRefusal,
  mintPaymentMaximumMsat,
  type MintPaymentAmountRejection,
  type MintPaymentDirection,
  type MintPaymentLimits,
} from "@bitcaster/client-sdk/mintPaymentLimits";
import type { CashuProofUnit } from "@bitcaster/client-sdk/marketUnits";
import {
  forgetBrowserMintPaymentLimits,
  readBrowserMintPaymentLimits,
} from "@/lib/mintPaymentLimits";
import { normalizeUrl } from "@/lib/url";
import { assertNever } from "@/lib/enumDiscipline";

export interface MintPaymentAmountLimitInput {
  /** The selected mint. Null reads no limits, for a flow that does not use this direction. */
  readonly mintUrl: string | null;
  readonly direction: MintPaymentDirection;
  readonly unit: CashuProofUnit;
  /** The msat amount in the field. Null or zero shows no error. */
  readonly amountMsat: number | null;
}

export interface MintPaymentAmountLimit {
  /** Translated error for an amount that the mint does not accept, or null. */
  readonly error: string | null;
  /** The largest msat amount for one payment, when the mint limits are known. */
  readonly maxMsat: number | null;
  /** True when the known limits refuse this amount. Unknown limits refuse nothing. */
  readonly rejects: (amountMsat: number) => boolean;
  /** Record a mint refusal (NUT error 11006) for this amount and read the limits again. */
  readonly recordMintRefusal: (amountMsat: number) => void;
}

interface KeyedLimits {
  readonly key: string;
  readonly limits: MintPaymentLimits | null;
}

interface KeyedRefusal {
  readonly key: string;
  readonly amountMsat: number;
}

/**
 * Read the selected mint's limits for one payment direction and check the
 * entered amount. Limits that load, fail, or belong to another mint do not
 * block: the mint enforces its limits.
 */
export function useMintPaymentAmountLimit({
  mintUrl,
  direction,
  unit,
  amountMsat,
}: MintPaymentAmountLimitInput): MintPaymentAmountLimit {
  const { t } = useTranslation();
  const normalizedMintUrl = mintUrl === null ? null : normalizeUrl(mintUrl);
  const key = `${direction}|${unit}|${normalizedMintUrl ?? ""}`;
  const [loaded, setLoaded] = useState<KeyedLimits | null>(null);
  const [refusal, setRefusal] = useState<KeyedRefusal | null>(null);
  const [readRevision, setReadRevision] = useState(0);

  useEffect(() => {
    if (normalizedMintUrl === null) return undefined;
    let current = true;
    void readBrowserMintPaymentLimits(normalizedMintUrl, {
      direction,
      method: "bolt11",
      unit,
    }).then((limits) => {
      if (current) setLoaded({ key, limits });
    });
    return () => {
      current = false;
    };
  }, [direction, key, normalizedMintUrl, readRevision, unit]);

  // A response for another mint, direction, or unit is stale.
  const limits = loaded?.key === key ? loaded.limits : null;
  const rejectionFor = useCallback(
    (amount: number | null): MintPaymentAmountRejection | null => {
      if (amount === null || !Number.isSafeInteger(amount) || amount <= 0) return null;
      if (refusal?.key === key && refusal.amountMsat === amount) {
        return classifyMintAmountRefusal(limits, amount);
      }
      if (limits === null) return null;
      const check = checkMintPaymentAmount(limits, amount);
      return check.kind === "within-limits" ? null : check;
    },
    [key, limits, refusal],
  );

  const recordMintRefusal = useCallback(
    (amount: number) => {
      if (normalizedMintUrl === null) return;
      setRefusal({ key, amountMsat: amount });
      forgetBrowserMintPaymentLimits(normalizedMintUrl);
      setReadRevision((revision) => revision + 1);
    },
    [key, normalizedMintUrl],
  );

  const rejects = useCallback((amount: number) => rejectionFor(amount) !== null, [rejectionFor]);
  const rejection = rejectionFor(amountMsat);
  return {
    error: rejection === null ? null : mintPaymentRejectionMessage(direction, rejection, t),
    maxMsat: limits === null ? null : mintPaymentMaximumMsat(limits),
    rejects,
    recordMintRefusal,
  };
}

function mintPaymentRejectionMessage(
  direction: MintPaymentDirection,
  rejection: MintPaymentAmountRejection,
  t: TFunction,
): string {
  const prefix = `mintLimits.${direction}`;
  switch (rejection.kind) {
    case "above-maximum":
      return rejection.minSat === null
        ? t(`${prefix}.maximumInParts`, { max: formatSats(rejection.maxSat) })
        : t(`${prefix}.rangeInParts`, {
            min: formatSats(rejection.minSat),
            max: formatSats(rejection.maxSat),
          });
    case "below-minimum":
      return rejection.maxSat === null
        ? t(`${prefix}.minimum`, { min: formatSats(rejection.minSat) })
        : t(`${prefix}.range`, {
            min: formatSats(rejection.minSat),
            max: formatSats(rejection.maxSat),
          });
    case "not-accepted":
      return t(`${prefix}.notAccepted`);
    case "refused":
      return t(`${prefix}.refused`);
    default:
      return assertNever(rejection);
  }
}

function formatSats(amount: number): string {
  return amount.toLocaleString("en-US");
}
