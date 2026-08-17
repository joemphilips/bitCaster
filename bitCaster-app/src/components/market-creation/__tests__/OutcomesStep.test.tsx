import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { OutcomesStep } from "../OutcomesStep";
import type { WizardOutcome } from "@/types/market-creation";

function makeOutcomes(count: number): WizardOutcome[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `o${i}`,
    label: `Outcome ${i}`,
    description: "",
  }));
}

// ── Auto-normalize: add-outcome rebalances ──────────────────────────────────

describe("OutcomesStep auto-normalize — add/remove", () => {
  it("shows the Add Outcome button for categorical markets", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes(2)} />);
    expect(screen.getByRole("button", { name: /add outcome/i })).toBeInTheDocument();
  });

  it("calls onAddOutcome when Add Outcome is clicked", async () => {
    const user = userEvent.setup();
    const onAddOutcome = vi.fn();
    render(
      <OutcomesStep
        outcomeType="categorical"
        outcomes={makeOutcomes(2)}
        onAddOutcome={onAddOutcome}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add outcome/i }));
    expect(onAddOutcome).toHaveBeenCalledOnce();
  });

  it("disables Add Outcome when at maximum outcomes", () => {
    // MAX_MARKET_OUTCOMES = 8
    const outcomes = makeOutcomes(8);
    render(<OutcomesStep outcomeType="categorical" outcomes={outcomes} />);
    expect(screen.getByRole("button", { name: /add outcome/i })).toBeDisabled();
  });

  it("calls onRemoveOutcome when the trash button is clicked", async () => {
    const user = userEvent.setup();
    const onRemoveOutcome = vi.fn();
    render(
      <OutcomesStep
        outcomeType="categorical"
        outcomes={makeOutcomes(2)}
        onRemoveOutcome={onRemoveOutcome}
      />,
    );
    // Each outcome row has a trash button; click the first one
    const trashButtons = screen.getAllByRole("button", { name: "" });
    // The trash buttons have no accessible name — find by aria or order
    await user.click(trashButtons[trashButtons.length - 1]);
    expect(onRemoveOutcome).toHaveBeenCalledOnce();
  });
});

// ── Market unit controls ────────────────────────────────────────────────────

describe("OutcomesStep market unit controls", () => {
  it("does not render a divisibility selector or denominator guidance", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes(2)} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/divisibility/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/price moves/i)).not.toBeInTheDocument();
  });
});

describe("OutcomesStep creator pricing removal", () => {
  it("does not render creator probability inputs or summaries", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes(2)} />);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
    expect(screen.queryByText(/probability/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
  });
});
