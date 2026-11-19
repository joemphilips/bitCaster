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

/**
 * The reason lines that the failure panel and the bell show for a final order
 * failure. A failure with no known cause has no reason line.
 */
const REASON_KEYS = [
  "settlementProgress.OwnOutputReused",
  "settlementProgress.GroupOutputReused",
  "settlementProgress.FokCancelled",
];

/** The funds lines of a pending refund that name the locked amount. */
const LOCKED_FUNDS_KEYS = [
  "settlementProgress.fundsLockedSats",
  "settlementProgress.fundsLockedShares_other",
];

/** Order-failure alerts and labels that used protocol jargon before. */
const REWORDED_ORDER_FAILURE_KEYS = [
  ...REASON_KEYS,
  ...LOCKED_FUNDS_KEYS,
  "settlementProgress.orderOnMarket",
  "settlementProgress.endedWithoutTrade",
  "settlementProgress.fundsPending",
  "settlementProgress.fundsReturned",
  "settlementProgress.dismissFailure",
  "settlementProgress.retryTrade",
  "participationScore.kinds.reused-output-penalty",
  "walletRecovery.errors.order-attempt-ended",
  "walletRecovery.errors.settlement-capability-conflict",
  "walletRecovery.errors.order-capability-not-current",
];

/**
 * Status texts that the generic failure reason replaced, and the generic
 * reason, which repeated the heading.
 */
const REPLACED_STATUS_KEYS = [
  "settlementProgress.failed",
  "settlementProgress.orderRequestRejected",
  "settlementProgress.submissionRejected",
  "settlementProgress.DefinitivelyRejected",
  "settlementProgress.Refundable",
  "settlementProgress.ExpiredBeforeSubmission",
  "settlementProgress.RejectedBeforeSubmission",
];

describe("final order failure copy", () => {
  it("uses the approved plain English reasons, heading and Score label", () => {
    // Each reason starts with its cause.
    expect(en.settlementProgress.OwnOutputReused).toBe(
      "This wallet was used in another browser or device at the same time, so nothing was traded. A Participation Score penalty was charged.",
    );
    expect(en.settlementProgress.GroupOutputReused).toBe(
      "Another order in the same settlement failed, so nothing was traded. No penalty was charged.",
    );
    // The engine cancels a FOK only when it cannot fill within the consented total.
    expect(en.settlementProgress.FokCancelled).toBe(
      "The price or the available shares changed after your preview, so nothing was traded.",
    );
    expect(lookup(en, "settlementProgress.endedWithoutTrade")).toBe(
      "This order ended without a trade.",
    );
    // The fee clause is part of the funds sentence (ADR-040, section 7).
    expect(lookup(en, "settlementProgress.fundsLockedSats")).toBe(
      "{{amount}} are locked until {{time}}. Then they return to this wallet, less preparation and refund fees.",
    );
    expect(lookup(en, "settlementProgress.fundsLockedShares_one")).toBe(
      "{{amount}} is locked until {{time}}. Then it returns to this wallet, less preparation and refund fees.",
    );
    expect(lookup(en, "settlementProgress.fundsLockedShares_other")).toBe(
      "{{amount}} are locked until {{time}}. Then they return to this wallet, less preparation and refund fees.",
    );
    // Without the journal facts, the funds sentence names no amount or time.
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

  it("uses one English term for a trade that failed", () => {
    expect(JSON.stringify(en)).not.toMatch(
      /did not go through|was not completed|Order failed|Order cancelled/i,
    );
    expect(en.walletRecovery.orderFailure).toBe("Trade failed");
    expect(en.notification.failed).toBe("Trade failed on “{{market}}”");
    expect(en.notification.cancelled).toBe("Trade failed on “{{market}}”");
    expect(en.trade.fokCancelled).toBe(`Trade failed. ${en.settlementProgress.FokCancelled}`);
    expect(en.trade.tradeFailed).toBe("Trade failed.");
  });

  it("uses one Japanese term for a trade that failed", () => {
    expect(JSON.stringify(ja)).not.toMatch(
      /注文は完了しませんでした|注文が失敗しました|注文がキャンセルされました/,
    );
    for (const key of ["walletRecovery.orderFailure", "settlementProgress.failedTitle"]) {
      expect(lookup(ja, key), key).toBe("取引が失敗しました");
    }
    expect(ja.notification.failed).toBe("「{{market}}」の取引が失敗しました");
    expect(ja.notification.cancelled).toBe("「{{market}}」の取引が失敗しました");
    expect(ja.trade.tradeFailed).toBe("取引が失敗しました。");
    expect(ja.trade.fokCancelled).toBe(`取引が失敗しました。${ja.settlementProgress.FokCancelled}`);
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
      expect(lookup(ja, key), key).toContain("取引は行われませんでした");
    }
    // The fee terms of the existing fee notice.
    for (const key of [
      "settlementProgress.fundsPending",
      "settlementProgress.fundsReturned",
      ...LOCKED_FUNDS_KEYS,
    ]) {
      expect(lookup(ja, key), key).toContain("準備手数料と返金手数料");
      expect(lookup(ja, key), key).toContain("このウォレットに戻");
    }
    expect(lookup(ja, "settlementProgress.fundsPending")).toContain("注文の有効期限が切れた後");
    for (const key of LOCKED_FUNDS_KEYS) {
      expect(lookup(ja, key), key).toContain("{{amount}}");
      expect(lookup(ja, key), key).toContain("{{time}}まで");
    }
    expect(ja.settlementProgress.retryTrade).toContain("{{market}}");
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
