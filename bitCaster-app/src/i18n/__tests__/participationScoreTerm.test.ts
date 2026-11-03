import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import ja from "../locales/ja.json";

type Catalogue = Record<string, unknown>;

function lookup(catalogue: Catalogue, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value !== null && typeof value === "object" ? (value as Catalogue)[part] : undefined,
      catalogue,
    );
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Catalogue).flatMap(strings);
}

const SCORE_KEYS = [
  "participationScore.name",
  "participationScore.helpLabel",
  "participationScore.help",
  "trade.scoreTopUpCancelled",
  "trade.scoreTopUpRequired",
  "trade.scoreRecoveryUnavailable",
  "insufficientBalance.scoreTitle",
  "insufficientBalance.scoreNeeds",
  "topUp.scoreMinimumError",
  "walletRecovery.errors.score-top-up-required",
  "walletRecovery.errors.score-top-up-cancelled",
  "walletRecovery.errors.settlement-capability-score-required",
];

describe("Participation Score copy", () => {
  it.each([
    ["en", en],
    ["ja", ja],
  ] as const)("%s has every Participation Score string", (_locale, catalogue) => {
    for (const key of SCORE_KEYS) {
      expect(lookup(catalogue, key), key).toEqual(expect.any(String));
    }
  });

  it("uses the agreed English explanation", () => {
    expect(lookup(en, "participationScore.help")).toBe(
      "An anti-spam fee. bitCaster charges a few sats of Score when your order uses the order book. It is not refundable.",
    );
  });

  it.each([
    ["en", en],
    ["ja", ja],
  ] as const)("%s names the term Participation Score in every Score string", (_locale, cat) => {
    expect(lookup(cat, "participationScore.name")).toBe("Participation Score");
    for (const key of SCORE_KEYS.filter((key) => key !== "participationScore.help")) {
      expect(lookup(cat, key), key).toMatch(/Participation Score/);
    }
  });

  it.each([
    ["en", en],
    ["ja", ja],
  ] as const)("%s does not use the retired Engine Score name", (_locale, catalogue) => {
    expect(strings(catalogue).filter((value) => /engine score/i.test(value))).toEqual([]);
    expect(lookup(catalogue, "trade.engineScoreFee")).toBeUndefined();
    expect(lookup(catalogue, "trade.engineScoreFeeTooltip")).toBeUndefined();
    expect(lookup(catalogue, "trade.engineScoreFeeShownAtConfirmation")).toBeUndefined();
  });
});
