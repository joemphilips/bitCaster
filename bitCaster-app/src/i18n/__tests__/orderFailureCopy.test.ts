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

/** The texts that the failure panel and the bell show for a final order failure. */
const REASON_KEYS = [
  "settlementProgress.OwnOutputReused",
  "settlementProgress.GroupOutputReused",
  "settlementProgress.failed",
];

/** Order-failure alerts and labels that used protocol jargon before. */
const REWORDED_ORDER_FAILURE_KEYS = [
  ...REASON_KEYS,
  "settlementProgress.orderOnMarket",
  "settlementProgress.endedWithoutTrade",
  "settlementProgress.fundsPending",
  "settlementProgress.fundsReturned",
  "settlementProgress.dismissFailure",
  "participationScore.kinds.reused-output-penalty",
  "walletRecovery.errors.order-attempt-ended",
  "walletRecovery.errors.settlement-capability-conflict",
  "walletRecovery.errors.order-capability-not-current",
];

/** Status texts that the generic failure reason replaces. */
const REPLACED_STATUS_KEYS = [
  "settlementProgress.orderRequestRejected",
  "settlementProgress.submissionRejected",
  "settlementProgress.DefinitivelyRejected",
  "settlementProgress.Refundable",
  "settlementProgress.ExpiredBeforeSubmission",
  "settlementProgress.RejectedBeforeSubmission",
];

describe("final order failure copy", () => {
  it("uses the approved plain English reasons, heading and Score label", () => {
    expect(en.settlementProgress.OwnOutputReused).toBe(
      "This order was not completed because this wallet was used in another browser or device at the same time. A Participation Score penalty was charged.",
    );
    expect(en.settlementProgress.GroupOutputReused).toBe(
      "This order was not completed because another order in the same settlement failed. No penalty was charged.",
    );
    expect(lookup(en, "settlementProgress.failed")).toBe("This order was not completed.");
    expect(lookup(en, "settlementProgress.endedWithoutTrade")).toBe(
      "This order ended without a trade.",
    );
    // The fee clause is part of the funds sentence (ADR-040, section 7).
    expect(lookup(en, "settlementProgress.fundsPending")).toBe(
      "Your funds, less preparation and refund fees, return to this wallet after the order expires.",
    );
    expect(lookup(en, "settlementProgress.fundsReturned")).toBe(
      "Your funds, less preparation and refund fees, were returned to this wallet.",
    );
    expect(en.settlementProgress.failedTitle).toBe("Trade failed");
    expect(en.participationScore.kinds["reused-output-penalty"]).toBe(
      "Penalty: wallet used in two places",
    );
  });

  it.each([
    ["en", en, /output|authori[sz]ation|operation/i],
    ["ja", ja, /出力|認可|承認|操作/],
  ] as const)("%s order-failure texts use no protocol jargon", (_locale, catalogue, jargon) => {
    for (const key of REWORDED_ORDER_FAILURE_KEYS) {
      expect(lookup(catalogue, key), key).toEqual(expect.any(String));
      expect(lookup(catalogue, key), key).not.toMatch(jargon);
    }
  });

  // Consolidation rounds commit before the mint refuses the source
  // preparation, so a consolidation fee can already be paid on this path.
  it.each([
    ["en", en, "less any consolidation fee"],
    ["ja", ja, "統合手数料"],
  ] as const)(
    "%s names the paid consolidation fee when the reserved funds are released",
    (_locale, catalogue, fee) => {
      expect(catalogue.walletRecovery.fundsReleased).toContain(fee);
    },
  );

  it("uses one English term for an order that was not completed", () => {
    expect(JSON.stringify(en)).not.toMatch(/did not go through/i);
    expect(en.walletRecovery.orderFailure).toBe("Order was not completed");
  });

  it.each([
    ["en", en],
    ["ja", ja],
  ] as const)("%s has no status text that the generic reason replaced", (_locale, catalogue) => {
    for (const key of REPLACED_STATUS_KEYS) expect(lookup(catalogue, key), key).toBeUndefined();
  });

  it("uses the existing Japanese terms", () => {
    expect(ja.settlementProgress.OwnOutputReused).toContain("Participation Score");
    expect(ja.settlementProgress.GroupOutputReused).not.toContain("Participation Score");
    for (const key of REASON_KEYS) {
      expect(lookup(ja, key), key).toContain("この注文は完了しませんでした");
    }
    // The fee terms of the existing fee notice.
    for (const key of ["settlementProgress.fundsPending", "settlementProgress.fundsReturned"]) {
      expect(lookup(ja, key), key).toContain("準備手数料と返金手数料");
      expect(lookup(ja, key), key).toContain("このウォレットに戻");
    }
    expect(lookup(ja, "settlementProgress.fundsPending")).toContain("注文の有効期限が切れた後");
    expect(lookup(ja, "settlementProgress.orderOnMarket")).toContain("{{market}}");
    expect(ja.settlementProgress.failedTitle).toMatch(/取引/);
    expect(ja.settlementProgress.dismissFailure).toMatch(/閉じる$/);
    expect(ja.settlementProgress.dismissFailure).toContain("{{market}}");
  });

  it.each([
    ["en", en, "A. B."],
    ["ja", ja, "A。B。"],
  ] as const)(
    "%s joins a reason and its funds sentence as one paragraph",
    (_locale, catalogue, joined) => {
      const template = lookup(catalogue, "settlementProgress.withFunds") as string;
      const [reason, funds] = _locale === "en" ? ["A.", "B."] : ["A。", "B。"];
      expect(template.replace("{{reason}}", reason).replace("{{funds}}", funds)).toBe(joined);
    },
  );
});
