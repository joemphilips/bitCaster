import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import type { ActivityItem } from "@/types/portfolio";
import { ActivityFeed } from "../ActivityFeed";

function trade(overrides: Partial<ActivityItem> = {}): ActivityItem {
  const fillId = "11111111-1111-4111-8111-111111111111";
  return {
    id: `trade:${"a".repeat(64)}:${fillId}`,
    walletId: "a".repeat(64),
    type: "Buy",
    amountSubunits: 1_003,
    baseAsset: "sat",
    date: "2026-09-27T12:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    marketId: "condition-YES",
    tradeDetails: {
      fillId,
      outcomeId: "YES",
      tokenSide: "Complement",
      faceAmountSubunits: 2_500,
      divisibility: 1_000,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ActivityFeed trade details", () => {
  it.each([
    {
      side: "Buy",
      activity: trade(),
      tokenAndShares: "Complement of YES · 2.5 shares",
      quote: "1.003 sats",
      sign: "-",
    },
    {
      side: "Sell",
      activity: trade({
        id: `trade:${"a".repeat(64)}:22222222-2222-4222-8222-222222222222`,
        type: "Sell",
        amountSubunits: 1_250,
        tradeDetails: {
          fillId: "22222222-2222-4222-8222-222222222222",
          outcomeId: "YES",
          tokenSide: "Outcome",
          faceAmountSubunits: 2_500_000,
          divisibility: 1_000_000,
        },
      }),
      tokenAndShares: "Outcome YES · 2.5 shares",
      quote: "1.25 sats",
      sign: "+",
    },
  ])(
    "labels the exact $side quote value before fees",
    ({ activity, tokenAndShares, quote, sign }) => {
      render(<ActivityFeed activity={[activity]} />);

      expect(screen.getByText("condition-YES")).toBeInTheDocument();
      expect(screen.getByText(tokenAndShares)).toBeInTheDocument();
      expect(screen.getByRole("group", { name: quote })).toBeInTheDocument();
      expect(screen.getByText("Trade value before fees")).toBeInTheDocument();
      expect(screen.getByRole("button").textContent).toContain(sign);
    },
  );

  it.each([
    ["en", "Trade value before fees"],
    ["ja", "手数料適用前の取引額"],
  ] as const)("localizes the quote qualifier in %s", async (language, qualifier) => {
    await i18n.changeLanguage(language);
    render(<ActivityFeed activity={[trade()]} />);

    expect(screen.getByText(qualifier)).toBeInTheDocument();
  });
});
