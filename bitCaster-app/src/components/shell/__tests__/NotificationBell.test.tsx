import { render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "../NotificationBell";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import { orderFailureNoticeKey, useOrderFailureNotices } from "@/stores/orderFailureNotices";
import { useTradeRetryRequest } from "@/stores/tradeRetryRequest";
import type { CtfRangeOrderLock } from "@/lib/ctfRangeOrderFunds";
import { formatClockTime } from "@/lib/format";
import i18n from "@/i18n";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";

// The journal read is browser storage I/O; the panel tests read a real journal.
const mocks = vi.hoisted(() => ({
  locks: {} as Record<string, CtfRangeOrderLock>,
  lockReads: [] as Array<{ scopeId: string | null; operationIds: readonly string[] }>,
}));
vi.mock("@/hooks/useCtfRangeOrderLocks", () => ({
  useCtfRangeOrderLocks: (scopeId: string | null, operationIds: readonly string[]) => {
    mocks.lockReads.push({ scopeId, operationIds });
    return mocks.locks;
  },
}));

const COND = "b".repeat(64);
const TITLE = "Will Alice win the 2026 cup?";

/** The exact shape the liked-market reconcile persisted before titles were stored. */
function persistedBareMarketClosed(): Notification {
  return {
    id: `${COND}-market_closed`,
    kind: "market_closed",
    orderId: "",
    marketId: COND,
    filledAmountSubunits: 0,
    remainingAmountSubunits: 0,
    unit: "sat",
    occurredAt: Date.now(),
    read: false,
    conditionId: COND,
    closedAt: Date.now(),
  };
}

function positionClosed(kind: "position_won" | "position_lost", outcome: string): Notification {
  return {
    id: `${COND}-${outcome}-${kind}`,
    kind,
    orderId: "",
    marketId: `${COND}-${outcome}`,
    filledAmountSubunits: 0,
    remainingAmountSubunits: 0,
    unit: "sat",
    occurredAt: Date.now(),
    read: false,
    conditionId: COND,
    marketTitle: TITLE,
  };
}

function openBell(onNavigate?: (href: string) => void) {
  render(<NotificationBell onNavigate={onNavigate} />);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("nav.notifications") }));
}

beforeEach(async () => {
  useNotificationsStore.setState({ items: [] });
  useOrderFailureNotices.setState({ notices: {} });
  useTradeRetryRequest.setState({ request: null });
  mocks.locks = {};
  mocks.lockReads = [];
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("NotificationBell market_closed", () => {
  it("shows the market title and opens the market page", () => {
    useNotificationsStore.getState().add({ ...persistedBareMarketClosed(), marketTitle: TITLE });
    let navigated: string | null = null;

    openBell((href) => (navigated = href));
    fireEvent.click(screen.getByText(`Market closed: ${TITLE}`));

    expect(navigated).toBe(`/markets/${COND}`);
  });

  it("opens an old bare-ID entry on the market page without showing the raw ID", () => {
    useNotificationsStore.getState().add(persistedBareMarketClosed());
    let navigated: string | null = null;

    openBell((href) => (navigated = href));

    expect(screen.queryByText(new RegExp(COND))).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("A market you follow has closed"));
    expect(navigated).toBe(`/markets/${COND}`);
  });
});

describe("NotificationBell held position results", () => {
  it("opens the won position in the closed Portfolio tab", () => {
    useNotificationsStore.getState().add(positionClosed("position_won", "Alice"));
    let navigated: string | null = null;

    openBell((href) => (navigated = href));
    fireEvent.click(screen.getByText(`You won your bet on “${TITLE}”. Please cash it.`));

    expect(navigated).toBe(`/portfolio?tab=closed&position=${encodeURIComponent(`${COND}-Alice`)}`);
  });

  it("opens the lost position in the closed Portfolio tab", () => {
    useNotificationsStore.getState().add(positionClosed("position_lost", "Bob|Carol"));
    let navigated: string | null = null;

    openBell((href) => (navigated = href));
    fireEvent.click(screen.getByText(`You lost your bet on “${TITLE}” 😢`));

    expect(navigated).toBe(
      `/portfolio?tab=closed&position=${encodeURIComponent(`${COND}-Bob|Carol`)}`,
    );
  });

  it("shows the Japanese result text", async () => {
    await i18n.changeLanguage("ja");
    useNotificationsStore.getState().add(positionClosed("position_won", "Alice"));
    useNotificationsStore.getState().add(positionClosed("position_lost", "Bob"));

    openBell();

    expect(
      screen.getByText(`「${TITLE}」の予想が当たりました！換金してください。`),
    ).toBeInTheDocument();
    expect(screen.getByText(`「${TITLE}」の予想は外れました 😢`)).toBeInTheDocument();
  });
});

describe("NotificationBell result icons", () => {
  it("marks a lost position with its own icon, not the market-closed flag", () => {
    useNotificationsStore.getState().add({ ...persistedBareMarketClosed(), marketTitle: TITLE });
    useNotificationsStore.getState().add(positionClosed("position_lost", "Bob"));
    openBell();

    const icon = (text: string) =>
      screen.getByText(text).closest("button")!.querySelector("svg")!.getAttribute("class");
    const closed = icon(`Market closed: ${TITLE}`);
    const lost = icon(`You lost your bet on “${TITLE}” 😢`);
    expect(closed).toMatch(/lucide-flag/);
    expect(lost).not.toMatch(/lucide-flag/);
    expect(lost).not.toMatch(/text-amber-500/);
  });
});

describe("NotificationBell language", () => {
  it("names the panel controls and the entry age in Japanese", async () => {
    await i18n.changeLanguage("ja");
    useNotificationsStore.getState().add(positionClosed("position_won", "Alice"));
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole("button", { name: "通知" }));

    expect(screen.getByText("たった今")).toBeInTheDocument();
    expect(screen.queryByText("Just now")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通知を閉じる" }));
    expect(screen.queryByText("たった今")).not.toBeInTheDocument();
  });
});

describe("NotificationBell order failures", () => {
  it("does not describe a failed order as cancelled", () => {
    useNotificationsStore.getState().add({
      ...orderNotice("Failed", 0, 1_000),
      id: "order-1-failed",
    });
    let navigated: string | null = null;

    openBell((href) => (navigated = href));
    fireEvent.click(screen.getByText(`Trade failed on “${TITLE}”`));

    expect(screen.queryByText(/Order cancelled|Order failed/i)).not.toBeInTheDocument();
    expect(navigated).toBe(`/markets/${COND}`);
  });

  // The reason and the funds sentence of the notice are separate lines.
  it.each([
    [
      "en",
      "OwnOutputReused",
      "pending",
      [en.settlementProgress.OwnOutputReused, en.settlementProgress.fundsPending],
    ],
    [
      "ja",
      "GroupOutputReused",
      "refunded",
      [ja.settlementProgress.GroupOutputReused, ja.settlementProgress.fundsReturned],
    ],
  ] as const)(
    "shows the recorded failure reason in the %s Failed notification, also after dismissal (%s, funds %s)",
    async (language, reason, funds, lines) => {
      await i18n.changeLanguage(language);
      useNotificationsStore.getState().add(orderNotice("Matched", 1_000, 0));
      useNotificationsStore
        .getState()
        .add({ ...orderNotice("Failed", 0, 1_000), id: "order-1-failed" });
      useOrderFailureNotices.getState().record({
        scopeId: "scope-1",
        operationId: "operation-1",
        orderId: "order-1",
        marketId: `${COND}-Yes`,
        marketTitle: null,
        reason,
      });
      if (funds !== "pending")
        useOrderFailureNotices
          .getState()
          .settleFunds({ [orderFailureNoticeKey("scope-1", "operation-1")]: funds });
      useOrderFailureNotices.getState().dismiss("scope-1", "operation-1");

      openBell();

      const entries = screen.getAllByRole("listitem");
      expect(entries).toHaveLength(2);
      const failed = entries.find((entry) => entry.textContent?.includes(lines[0]));
      expect(failed).toBeDefined();
      // Only the Failed entry of the order carries the reason.
      for (const line of lines) {
        expect(within(failed!).getByText(line)).toBeVisible();
        expect(screen.getAllByText(line)).toHaveLength(1);
      }
    },
  );

  it("shows no reason line and no funds claim for a failure with no reason and no refund", () => {
    useNotificationsStore
      .getState()
      .add({ ...orderNotice("Failed", 0, 1_000), id: "order-1-failed" });
    useOrderFailureNotices.getState().record({
      scopeId: "scope-1",
      operationId: "operation-1",
      orderId: "order-1",
      marketId: `${COND}-Yes`,
      marketTitle: null,
      reason: "Unspecified",
    });
    useOrderFailureNotices
      .getState()
      .settleFunds({ [orderFailureNoticeKey("scope-1", "operation-1")]: "ended" });

    openBell();

    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent(`Trade failed on “${TITLE}”`);
    expect(entry).not.toHaveTextContent(/Your funds|were returned/);
  });

  describe("an engine-cancelled FOK", () => {
    const unlockAtMs = Date.UTC(2026, 10, 19, 5, 5);
    const retry = {
      conditionId: COND,
      orderRouteId: `${COND}-Yes`,
      tokenSide: "Complement" as const,
      side: "Buy" as const,
      amountSubunits: 2_000,
    };
    const lock: CtfRangeOrderLock = {
      side: "Buy",
      lockedSubunits: 1_025,
      divisibility: 1_000,
      unlockAtMs,
      retry,
    };
    const lockedSats = en.settlementProgress.fundsLockedSats
      .replace("{{amount}}", "1.025 sats")
      .replace("{{time}}", formatClockTime(unlockAtMs, Date.now(), "en"));
    const retryName = en.settlementProgress.retryTrade.replace("{{market}}", TITLE);

    beforeEach(() => {
      useNotificationsStore
        .getState()
        .add({ ...orderNotice("cancelled", 0, 2_000), id: "order-1-cancelled" });
      useOrderFailureNotices.getState().record({
        scopeId: "scope-1",
        operationId: "operation-1",
        orderId: "order-1",
        marketId: `${COND}-Yes`,
        marketTitle: null,
        reason: "FokCancelled",
      });
      mocks.locks = { "operation-1": lock };
    });

    it("shows the reason, the locked sats and their lock end, and Retry", () => {
      openBell();

      const entry = screen.getByRole("listitem");
      expect(entry).toHaveTextContent(`Trade failed on “${TITLE}”`);
      expect(within(entry).getByText(en.settlementProgress.FokCancelled)).toBeVisible();
      expect(within(entry).getByText(lockedSats)).toBeVisible();
      expect(within(entry).getByRole("button", { name: retryName })).toBeVisible();
    });

    it("opens the market page first, then asks it for the same order", () => {
      let navigated: string | null = null;
      openBell((href) => (navigated = href));

      fireEvent.click(screen.getByRole("button", { name: retryName }));

      expect(navigated).toBe(`/markets/${COND}`);
      expect(useTradeRetryRequest.getState().request).toEqual(retry);
      // The panel closes, so the market page shows the prefilled trade form.
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    });

    it.each(["evicted_capacity", "rejected_capacity"] as const)(
      "shows the locked funds and Retry on the %s entry, as the panel does",
      (kind) => {
        useNotificationsStore.setState({ items: [] });
        useNotificationsStore
          .getState()
          .add({ ...orderNotice(kind, 0, 2_000), id: `order-1-${kind}` });
        useOrderFailureNotices.setState({ notices: {} });
        useOrderFailureNotices.getState().record({
          scopeId: "scope-1",
          operationId: "operation-1",
          orderId: "order-1",
          marketId: `${COND}-Yes`,
          marketTitle: null,
          reason: "Unspecified",
        });

        openBell();

        const entry = screen.getByRole("listitem");
        expect(within(entry).getByText(lockedSats)).toBeVisible();
        expect(within(entry).getByRole("button", { name: retryName })).toBeVisible();
      },
    );

    // A retry from a wallet that another browser uses can repeat the penalty.
    it("offers no Retry when this wallet was used in two places", () => {
      useOrderFailureNotices.setState({ notices: {} });
      useOrderFailureNotices.getState().record({
        scopeId: "scope-1",
        operationId: "operation-1",
        orderId: "order-1",
        marketId: `${COND}-Yes`,
        marketTitle: null,
        reason: "OwnOutputReused",
      });

      openBell();

      const entry = screen.getByRole("listitem");
      expect(within(entry).getByText(en.settlementProgress.OwnOutputReused)).toBeVisible();
      expect(within(entry).getByText(lockedSats)).toBeVisible();
      expect(within(entry).queryByRole("button", { name: retryName })).toBeNull();
    });

    it("shows that the funds were returned and no Retry after the refund", () => {
      useOrderFailureNotices
        .getState()
        .settleFunds({ [orderFailureNoticeKey("scope-1", "operation-1")]: "refunded" });

      openBell();

      const entry = screen.getByRole("listitem");
      expect(within(entry).getByText(en.settlementProgress.fundsReturned)).toBeVisible();
      expect(within(entry).queryByRole("button", { name: retryName })).toBeNull();
    });
  });

  it("shows no failure reason for an order whose settlement completed after all", () => {
    useNotificationsStore
      .getState()
      .add({ ...orderNotice("Failed", 0, 1_000), id: "order-1-failed" });
    useOrderFailureNotices.getState().record({
      scopeId: "scope-1",
      operationId: "operation-1",
      orderId: "order-1",
      marketId: `${COND}-Yes`,
      marketTitle: null,
      reason: "OwnOutputReused",
    });
    useOrderFailureNotices
      .getState()
      .settleFunds({ [orderFailureNoticeKey("scope-1", "operation-1")]: "settled" });

    openBell();

    expect(screen.getByRole("listitem")).not.toHaveTextContent(
      en.settlementProgress.OwnOutputReused,
    );
  });

  it("shows a Failed notification without a recorded reason as before", () => {
    useNotificationsStore
      .getState()
      .add({ ...orderNotice("Failed", 0, 1_000), id: "order-1-failed" });

    openBell();

    const entry = screen.getByRole("listitem");
    expect(entry).toHaveTextContent(`Trade failed on “${TITLE}”`);
    expect(entry).not.toHaveTextContent(en.settlementProgress.OwnOutputReused);
    expect(entry).not.toHaveTextContent(en.settlementProgress.GroupOutputReused);
    expect(within(entry).queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});

/** An order entry as the order builders store it: share face subunits and D = 1,000. */
function orderNotice(
  kind: Notification["kind"],
  filledAmountSubunits: number,
  remainingAmountSubunits: number,
): Notification {
  return {
    id: `order-1-${kind}-${remainingAmountSubunits}`,
    kind,
    orderId: "order-1",
    // A No order on a Yes/No market uses the Yes route with the complement token.
    marketId: `${COND}-Yes`,
    filledAmountSubunits,
    remainingAmountSubunits,
    unit: "sat",
    divisibility: 1_000,
    marketTitle: TITLE,
    occurredAt: Date.now(),
    read: false,
  };
}

describe("NotificationBell order notices", () => {
  it("counts shares, not sats, and names the market", () => {
    useNotificationsStore.getState().add(orderNotice("accepted", 0, 1_000_000));
    useNotificationsStore.getState().add(orderNotice("Matched", 1_000_000, 0));
    useNotificationsStore.getState().add(orderNotice("partially_filled", 400_000, 600_000));
    useNotificationsStore.getState().add(orderNotice("Filled", 1_000, 0));

    openBell();

    expect(screen.getByText(`Order accepted on “${TITLE}”`)).toBeInTheDocument();
    expect(
      screen.getByText(`Order matched: 1,000 shares reserved on “${TITLE}”`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Partial fill: 400 shares filled on “${TITLE}”, 600 shares remaining`),
    ).toBeInTheDocument();
    expect(screen.getByText(`Order filled: 1 share on “${TITLE}”`)).toBeInTheDocument();
    expect(screen.queryByText(/sats|on Yes/)).not.toBeInTheDocument();
  });

  it("shows the Japanese order text with the market title and share count", async () => {
    await i18n.changeLanguage("ja");
    useNotificationsStore.getState().add(orderNotice("Matched", 1_000_000, 0));
    useNotificationsStore.getState().add(orderNotice("partially_filled", 400_000, 600_000));
    useNotificationsStore.getState().add(orderNotice("cancelled", 0, 1_000));

    openBell();

    expect(
      screen.getByText(`注文がマッチしました: 「${TITLE}」で 1,000 枚を予約済み`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`一部約定: 「${TITLE}」で 400 枚が約定、残り 600 枚`),
    ).toBeInTheDocument();
    expect(screen.getByText(`「${TITLE}」の取引が失敗しました`)).toBeInTheDocument();
  });

  // ADR-049: entries persisted before release 4 have no title and no denominator.
  it.each([
    ["en", "Order filled: 250 shares on “Yes”"],
    ["ja", "注文が約定しました: 「Yes」で 250 枚"],
  ])("reads an order entry stored before titles were kept in %s", async (language, text) => {
    await i18n.changeLanguage(language);
    useNotificationsStore.getState().add({
      id: "o-filled",
      kind: "Filled",
      orderId: "o",
      marketId: `${COND}-Yes`,
      filledAmountSubunits: 250_000,
      remainingAmountSubunits: 0,
      unit: "sat",
      occurredAt: Date.now(),
      read: false,
    });

    openBell();

    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
