import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { NotificationBell } from "../NotificationBell";
import { useNotificationsStore, type Notification } from "@/stores/notifications";

const COND = "b".repeat(64);
const MARKET_ID = `${COND}-Alice`;

function marketClosed(overrides: Partial<Notification> = {}): Notification {
  return {
    id: `${MARKET_ID}-market_closed`,
    kind: "market_closed",
    orderId: "",
    marketId: MARKET_ID,
    filledAmountSubunits: 0,
    remainingAmountSubunits: 0,
    unit: "sat",
    occurredAt: Date.now(),
    read: false,
    conditionId: COND,
    finalOutcome: "Alice",
    closedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  useNotificationsStore.setState({ items: [] });
});

describe("NotificationBell market_closed", () => {
  it("renders a market_closed notification when the panel opens", () => {
    useNotificationsStore.getState().add(marketClosed());

    render(<NotificationBell />);
    // Open the panel.
    fireEvent.click(screen.getByLabelText("Notifications"));

    // "Market closed: Alice" — uses the finalOutcome as the label.
    expect(screen.getByText(/Market closed:\s*Alice/i)).toBeInTheDocument();
  });

  it("navigates to the condition page when the entry is clicked", () => {
    useNotificationsStore.getState().add(marketClosed());
    let navigated: string | null = null;

    render(<NotificationBell onNavigate={(href) => (navigated = href)} />);
    fireEvent.click(screen.getByLabelText("Notifications"));
    fireEvent.click(screen.getByText(/Market closed:\s*Alice/i));

    expect(navigated).toBe(`/markets/${COND}`);
  });
});

describe("NotificationBell order failures", () => {
  it("does not describe a failed order as cancelled", () => {
    useNotificationsStore.getState().add(
      marketClosed({
        id: "order-1-failed",
        kind: "Failed",
        orderId: "order-1",
        finalOutcome: undefined,
      }),
    );

    render(<NotificationBell />);
    fireEvent.click(screen.getByLabelText("Notifications"));

    expect(screen.getByText(/Order failed on Alice/i)).toBeInTheDocument();
    expect(screen.queryByText(/Order cancelled/i)).not.toBeInTheDocument();
  });
});
