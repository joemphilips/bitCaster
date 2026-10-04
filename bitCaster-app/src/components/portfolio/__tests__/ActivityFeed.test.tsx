import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("groups two recorded fills of one submitted order without hiding fill details", () => {
    const first = trade();
    const second = trade({ id: "second" });
    Object.assign(first.tradeDetails!, { orderId: "order-one" });
    Object.assign(second.tradeDetails!, { orderId: "order-one", fillId: "second" });
    const { container } = render(<ActivityFeed activity={[first, second]} />);
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(screen.getByText(/2 recorded fills/)).toBeInTheDocument();
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByText("Trade value before fees")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "2.006 sats" })).toBeInTheDocument();
  });

  it.each([
    "order",
    "wallet",
    "unknown",
    "pending",
    "failed",
    "market",
    "side",
    "token",
    "outcome",
    "divisibility",
    "overflow",
    "duplicate",
  ])("keeps %s membership or conflicting metadata separate", (difference) => {
    const first = trade();
    const second = trade({ id: "second" });
    Object.assign(first.tradeDetails!, { orderId: "one" });
    Object.assign(second.tradeDetails!, { orderId: "one", fillId: "second" });
    switch (difference) {
      case "order":
        second.tradeDetails!.orderId = "two";
        break;
      case "wallet":
        second.walletId = "b".repeat(64);
        break;
      case "unknown":
        delete second.tradeDetails!.orderId;
        break;
      case "pending":
        second.status = "pending";
        break;
      case "failed":
        second.status = "Failed";
        second.failureReason = "Fill failed";
        break;
      case "market":
        second.marketId = "other-YES";
        break;
      case "side":
        second.type = "Sell";
        break;
      case "token":
        second.tradeDetails!.tokenSide = "Outcome";
        break;
      case "outcome":
        second.tradeDetails!.outcomeId = "NO";
        break;
      case "divisibility":
        second.tradeDetails!.divisibility = 1_000_000;
        break;
      case "overflow":
        second.amountSubunits = Number.MAX_SAFE_INTEGER;
        break;
      case "duplicate":
        second.tradeDetails!.fillId = first.tradeDetails!.fillId;
        break;
    }
    const { container } = render(<ActivityFeed activity={[first, second]} />);
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    if (difference === "failed") expect(screen.getByText("Fill failed")).toBeInTheDocument();
  });

  it.each([
    ["en", "2 recorded fills", "Trade value before fees", "Complement of YES · 2.5 shares"],
    ["ja", "記録された約定 2 件", "手数料適用前の取引額", "YES の補完トークン · 2.5 口"],
  ] as const)("expands exact fill records in %s", async (language, header, qualifier, shares) => {
    await i18n.changeLanguage(language);
    const first = trade();
    const second = trade({ id: "second", amountSubunits: 1_250 });
    Object.assign(first.tradeDetails!, { orderId: "one" });
    Object.assign(second.tradeDetails!, { orderId: "one", fillId: "second" });
    const { container } = render(<ActivityFeed activity={[first, second]} />);
    const group = container.querySelector("details")!;
    expect(group.open).toBe(false);
    await userEvent.click(screen.getByText(new RegExp(header)));
    expect(group.open).toBe(true);
    const records = screen.getAllByRole("article");
    for (const [index, amount] of ["1.003 sats", "1.25 sats"].entries()) {
      expect(within(records[index]).getByText(shares)).toBeVisible();
      expect(within(records[index]).getByRole("group", { name: amount })).toBeVisible();
      expect(within(records[index]).getByText(qualifier)).toBeVisible();
      expect(records[index].textContent).toContain("-");
      expect(records[index]).not.toHaveAttribute("tabindex");
    }
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText(new RegExp(header)));
    expect(group.open).toBe(false);
  });

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
      expect(screen.getByRole("article").textContent).toContain(sign);
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

  it.each([
    ["en", "Market aaaaaaaaaaaa"],
    ["ja", "市場 aaaaaaaaaaaa"],
  ] as const)(
    "shows a short market reference in %s when the title is absent",
    async (language, label) => {
      await i18n.changeLanguage(language);
      const marketId = `${"a".repeat(64)}-YES`;
      const single = trade({ marketId });
      const groupedFirst = trade({ id: "group-first", marketId });
      const groupedSecond = trade({ id: "group-second", marketId });
      Object.assign(groupedFirst.tradeDetails!, { orderId: "grouped-order" });
      Object.assign(groupedSecond.tradeDetails!, {
        orderId: "grouped-order",
        fillId: "group-second",
      });

      const { container, rerender } = render(<ActivityFeed activity={[single]} />);
      expect(screen.getByText(label)).toHaveAttribute("title", marketId);
      expect(screen.queryByText(marketId)).not.toBeInTheDocument();

      rerender(<ActivityFeed activity={[groupedFirst, groupedSecond]} />);
      expect(container.querySelector("summary")?.textContent).toContain(label);
      expect(screen.queryByText(marketId)).not.toBeInTheDocument();

      rerender(<ActivityFeed activity={[trade({ marketId, marketTitle: "Named market" })]} />);
      expect(screen.getByText("Named market")).toBeInTheDocument();
    },
  );
});
