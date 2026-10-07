import { render as testingRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import type { ActivityDisplayItem as ActivityItem } from "@/types/portfolio";
import {
  decodeActivityLogPayload,
  encodeActivityLogPayload,
} from "@bitcaster/client-sdk/activityLog";
import { ActivityFeed } from "../ActivityFeed";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";

const render = (ui: ReactElement) => testingRender(ui, { wrapper: MemoryRouter });

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
    "face-overflow",
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
      case "face-overflow":
        second.tradeDetails!.faceAmountSubunits = Number.MAX_SAFE_INTEGER;
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
      expect(screen.getAllByRole("link", { name: label })).toHaveLength(3);
      expect(container.querySelector("summary")?.querySelector("a")).toBeNull();
      expect(screen.queryByText(marketId)).not.toBeInTheDocument();

      rerender(<ActivityFeed activity={[trade({ marketId, marketTitle: "Named market" })]} />);
      expect(screen.getByText("Named market")).toBeInTheDocument();
    },
  );
});

describe("ActivityFeed recovered Claim credit", () => {
  it.each([
    ["en", "Claim payout recovered", "Original Claim remains failed (13015)."],
    ["ja", "請求の払戻金を復元", "元の請求は失敗のままです（13015）。"],
  ] as const)(
    "shows completed recovery and failed original Claim in %s",
    async (language, label, note) => {
      await i18n.changeLanguage(language);
      const recovered: ActivityItem = {
        id: "recovered-credit-one",
        walletId: "a".repeat(64),
        type: "payout_claimed",
        amountSubunits: 8,
        baseAsset: "sat",
        date: "2026-10-06T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
        claimRecovery: {
          kind: "retained-claim-payout",
          originalOperationId: "claim-leg-one",
          originalStatus: "Failed",
          originalFailureCode: 13015,
        },
      };
      const restored = decodeActivityLogPayload(encodeActivityLogPayload([recovered]))!;
      render(<ActivityFeed activity={restored} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(note)).toBeInTheDocument();
      expect(screen.getByText("completed")).toBeInTheDocument();
      expect(screen.getByRole("article").textContent).toContain("+");
      expect(screen.getByRole("group", { name: "0.008 sats" })).toBeInTheDocument();
    },
  );

  it("keeps normal completed Claim labeling without a recovery annotation", () => {
    const ordinary = trade({ type: "payout_claimed" });
    delete ordinary.tradeDetails;
    render(
      <ActivityFeed activity={decodeActivityLogPayload(encodeActivityLogPayload([ordinary]))!} />,
    );
    expect(screen.getByText("Payout Claimed")).toBeInTheDocument();
    expect(screen.queryByText(/Original Claim/)).not.toBeInTheDocument();
    expect(screen.queryByText("Claim payout recovered")).not.toBeInTheDocument();
  });
});

describe("historical activity presentation", () => {
  it.each([
    ["Outcome", "YES", ["YES", "NO"], "Outcome YES"],
    ["Complement", "YES", ["YES", "NO"], "Outcome NO"],
    ["Outcome", "Blue-team", ["Blue-team", "Red", "Green"], "Outcome Blue-team"],
    ["Complement", "Blue-team", ["Blue-team", "Red", "Green"], "All outcomes except Blue-team"],
  ] as const)(
    "labels %s %s from the catalogue universe",
    (tokenSide, outcomeId, outcomes, label) => {
      const item = trade({
        marketId: `${"c".repeat(64)}-Blue-team`,
        activityMarket: { title: "A long market title ".repeat(15), outcomes },
      });
      Object.assign(item.tradeDetails!, { tokenSide, outcomeId });
      render(<ActivityFeed activity={[item]} />);
      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", `/markets/${"c".repeat(64)}`);
      expect(link).toHaveAttribute("title", item.activityMarket!.title!.trim());
      expect(link).toHaveClass("truncate");
      expect(screen.getByText(`${label} · 2.5 shares`)).toBeVisible();
      expect(screen.getByTestId("activity-execution-price")).toHaveTextContent(
        "Executed price: 0.4012 sats/share",
      );
      expect(screen.getByTestId("activity-execution-price")).toHaveAttribute(
        "title",
        "Exact execution price: 1003/2500 sats/share",
      );
    },
  );

  it("shows weighted historical price outside independent market navigation", async () => {
    const first = trade({ marketId: `${"c".repeat(64)}-YES`, marketTitle: "Market title" });
    const second = trade({ id: "second", marketId: first.marketId, amountSubunits: 1250 });
    Object.assign(first.tradeDetails!, { orderId: "one" });
    Object.assign(second.tradeDetails!, {
      orderId: "one",
      fillId: "two",
      faceAmountSubunits: 3000,
    });
    const { container } = render(<ActivityFeed activity={[first, second]} />);
    const average = screen.getByTestId("activity-average-price");
    expect(average).toHaveTextContent(
      "Weighted execution price: 0.409636 sats/share (approximate)",
    );
    expect(average).toHaveAttribute("title", "Exact execution price: 2253/5500 sats/share");
    expect(container.querySelector("summary a")).toBeNull();
    await userEvent.click(screen.getByText(/2 recorded fills/));
    const children = screen.getAllByTestId("activity-execution-price");
    expect(children[0]).toHaveAttribute("title", "Exact execution price: 1003/2500 sats/share");
    expect(children[1]).toHaveAttribute("title", "Exact execution price: 5/12 sats/share");
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it.each([
    [1, 2000, "0.0005", "1/2000"],
    [1, 2000000, "<0.000001", "1/2000000"],
    [0, 2000, "0", "0/1"],
    [
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      "1",
      "9007199254740990/9007199254740991",
    ],
  ] as const)(
    "keeps %s / %s visible with an accessible exact ratio",
    (amountSubunits, faceAmountSubunits, price, ratio) => {
      const item = trade({ amountSubunits });
      item.tradeDetails!.faceAmountSubunits = faceAmountSubunits;
      render(<ActivityFeed activity={[item]} />);
      const row = screen.getByTestId("activity-execution-price");
      expect(row).toHaveTextContent(`Executed price: ${price} sats/share`);
      expect(row).toHaveAttribute("title", `Exact execution price: ${ratio} sats/share`);
      expect(within(row).getByText(`Exact execution price: ${ratio} sats/share`)).toHaveClass(
        "sr-only",
      );
      if (faceAmountSubunits === 2000000) expect(row).toHaveTextContent("below display precision");
      if (amountSubunits === Number.MAX_SAFE_INTEGER - 1)
        expect(row).toHaveTextContent("approximate");
    },
  );

  it("keeps invalid identifiers and legacy facts readable without invented links or prices", () => {
    const legacy = trade({ marketId: "../other-YES", marketTitle: "Legacy market" });
    delete legacy.tradeDetails;
    render(<ActivityFeed activity={[legacy]} />);
    expect(screen.getByText("Legacy market")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("activity-execution-price")).not.toBeInTheDocument();
  });
});
