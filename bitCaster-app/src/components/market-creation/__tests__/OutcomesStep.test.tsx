import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { OutcomesStep } from "../OutcomesStep";
import type { WizardOutcome } from "@/types/market-creation";

function makeOutcomes(probs: number[]): WizardOutcome[] {
  return probs.map((p, i) => ({
    id: `o${i}`,
    label: `Outcome ${i}`,
    description: "",
    probability: p,
  }));
}

// ── Auto-normalize: add-outcome rebalances ──────────────────────────────────

describe("OutcomesStep auto-normalize — add/remove", () => {
  it("shows the Add Outcome button for categorical markets", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes([50, 50])} />);
    expect(screen.getByRole("button", { name: /add outcome/i })).toBeInTheDocument();
  });

  it("calls onAddOutcome when Add Outcome is clicked", async () => {
    const user = userEvent.setup();
    const onAddOutcome = vi.fn();
    render(
      <OutcomesStep
        outcomeType="categorical"
        outcomes={makeOutcomes([50, 50])}
        onAddOutcome={onAddOutcome}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add outcome/i }));
    expect(onAddOutcome).toHaveBeenCalledOnce();
  });

  it("disables Add Outcome when at maximum outcomes", () => {
    // MAX_MARKET_OUTCOMES = 8
    const outcomes = makeOutcomes([13, 13, 12, 12, 12, 12, 13, 13]);
    render(<OutcomesStep outcomeType="categorical" outcomes={outcomes} />);
    expect(screen.getByRole("button", { name: /add outcome/i })).toBeDisabled();
  });

  it("calls onRemoveOutcome when the trash button is clicked", async () => {
    const user = userEvent.setup();
    const onRemoveOutcome = vi.fn();
    render(
      <OutcomesStep
        outcomeType="categorical"
        outcomes={makeOutcomes([60, 40])}
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
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes([50, 50])} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/divisibility/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/price moves/i)).not.toBeInTheDocument();
  });
});

// ── Auto-normalize: probability edit ───────────────────────────────────────

describe("OutcomesStep auto-normalize — probability edit", () => {
  it("calls onOutcomeProbabilityChange when a probability input changes", async () => {
    const user = userEvent.setup();
    const onOutcomeProbabilityChange = vi.fn();
    render(
      <OutcomesStep
        outcomeType="categorical"
        outcomes={makeOutcomes([50, 50])}
        onOutcomeProbabilityChange={onOutcomeProbabilityChange}
      />,
    );
    const inputs = screen.getAllByRole("spinbutton");
    // Find the first probability spinbutton
    await user.clear(inputs[0]);
    await user.type(inputs[0], "70");
    expect(onOutcomeProbabilityChange).toHaveBeenCalled();
  });

  it('does not render a "Normalize to 100%" button (auto-normalize replaces it)', () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes([30, 70])} />);
    expect(screen.queryByRole("button", { name: /normalize/i })).not.toBeInTheDocument();
  });

  it('does not render a "Normalize to 100%" button in yes/no mode either', () => {
    const outcomes: WizardOutcome[] = [
      { id: "yes", label: "Yes", description: "", probability: 50 },
      { id: "no", label: "No", description: "", probability: 50 },
    ];
    render(<OutcomesStep outcomeType="yesno" outcomes={outcomes} />);
    expect(screen.queryByRole("button", { name: /normalize/i })).not.toBeInTheDocument();
  });

  it("disables Next when categorical probabilities do not sum to 100", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes([70, 50])} />);

    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });
});
