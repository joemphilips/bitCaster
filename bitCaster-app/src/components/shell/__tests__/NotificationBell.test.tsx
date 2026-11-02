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
      ...persistedBareMarketClosed(),
      id: "order-1-failed",
      kind: "Failed",
      orderId: "order-1",
      marketId: `${COND}-Alice`,
    });
    let navigated: string | null = null;

    openBell((href) => (navigated = href));
    fireEvent.click(screen.getByText(/Order failed on Alice/i));

    expect(screen.queryByText(/Order cancelled/i)).not.toBeInTheDocument();
    expect(navigated).toBe(`/markets/${COND}`);
  });
});
