import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationBell } from "../NotificationBell";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import i18n from "@/i18n";

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
    fireEvent.click(screen.getByText(`Order failed on “${TITLE}”`));

    expect(screen.queryByText(/Order cancelled/i)).not.toBeInTheDocument();
    expect(navigated).toBe(`/markets/${COND}`);
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
    useNotificationsStore.getState().add(orderNotice("cancelled", 0, 1_000));

    openBell();

    expect(
      screen.getByText(`注文がマッチしました: 「${TITLE}」で 1,000 枚 予約済み`),
    ).toBeInTheDocument();
    expect(screen.getByText(`「${TITLE}」の注文がキャンセルされました`)).toBeInTheDocument();
  });
});
