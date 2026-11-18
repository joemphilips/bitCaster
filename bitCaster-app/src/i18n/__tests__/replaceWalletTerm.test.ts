import { describe, expect, it } from "vitest";
import ja from "../locales/ja.json";

describe("Replace Wallet copy", () => {
  // One action has one verb. The Japanese copy of the wallet replacement
  // uses 切り替える, so the user sees the same action in each text.
  it("uses one Japanese verb for the wallet replacement", () => {
    const replaceTexts = Object.entries(ja.wallet)
      .filter(([key]) => key.startsWith("replace"))
      .map(([, value]) => value)
      .filter((value): value is string => typeof value === "string");

    expect(replaceTexts.length).toBeGreaterThan(0);
    expect(replaceTexts.filter((text) => text.includes("入れ替え"))).toEqual([]);
    expect(ja.wallet.replaceWalletWarning).toContain("切り替える");
  });
});
