import { expect, it } from "vitest";
import { commentTradePresentation, exactCommentShares } from "../commentTradePresentation";
import type { Comment } from "@/types/market-detail";
const comment = (
  side: "Buy" | "Sell",
  tokenSide: "Outcome" | "Complement",
  outcomeId = "YES",
): Comment => ({
  id: "c",
  userId: "author",
  userDisplayName: "Author",
  content: "Body",
  timestamp: "2026-10-12T02:00:00Z",
  likeCount: 0,
  isLiked: false,
  trade: {
    fillId: "f",
    outcomeId: "YES",
    executedAt: "2026-10-12T01:00:00Z",
    price: 50,
    priceDenominator: 1000,
    faceAmountSubunits: 12345,
    authorTrade: { side, tokenSide, outcomeId },
  },
});
it.each(["Buy", "Sell"] as const)(
  "uses the author's %s intent and exact linked-fill shares",
  (side) => {
    expect(commentTradePresentation(comment(side, "Complement"), [], false, "en")).toEqual({
      side,
      shares: "12.345",
      outcome: "NO",
      complement: false,
      executedAt: "2026-10-12T01:00:00Z",
    });
  },
);
it("preserves categorical complements without changing the primitive chart route", () => {
  const input = comment("Sell", "Complement", "B");
  expect(commentTradePresentation(input, [{ id: "B", label: "Beta" }], true, "ja")?.outcome).toBe(
    "Beta",
  );
  expect(
    commentTradePresentation(input, [{ id: "B", label: "Beta" }], true, "ja")?.complement,
  ).toBe(true);
  expect(input.trade?.outcomeId).toBe("YES");
});
it("keeps historical unknown intent neutral", () => {
  const input = comment("Buy", "Outcome");
  input.trade!.authorTrade = null;
  expect(commentTradePresentation(input, [], false, "en")).toBeNull();
});
it("does not round large exact share quantities", () => {
  expect(exactCommentShares(Number.MAX_SAFE_INTEGER, 1000, "en")).toBe("9,007,199,254,740.991");
  expect(exactCommentShares(1, 3, "en")).toBe("1/3");
  expect(exactCommentShares(1, 0, "en")).toBeNull();
});
