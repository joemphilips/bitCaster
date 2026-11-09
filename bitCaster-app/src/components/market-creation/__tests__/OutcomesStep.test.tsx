import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { OutcomesStep } from "../OutcomesStep";
import type { WizardOutcome } from "@/types/market-creation";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";

function makeOutcomes(count: number): WizardOutcome[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `o${i}`,
    label: `Outcome${i}`,
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
    const outcomes = makeOutcomes(2);
    // Each delete button names its outcome.
    await user.click(screen.getByRole("button", { name: `Remove ${outcomes[1].label}` }));
    expect(onRemoveOutcome).toHaveBeenCalledExactlyOnceWith(outcomes[1].id);
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

describe("OutcomesStep outcome colors", () => {
  it("shows visible distinct palette defaults without gray placeholders", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={makeOutcomes(8)} />);
    const colors = makeOutcomes(8).map(
      (outcome) => (screen.getByLabelText(`Color for ${outcome.label}`) as HTMLInputElement).value,
    );
    expect(colors).toEqual([
      "#59a14f",
      "#e15759",
      "#f28e2b",
      "#4e79a7",
      "#76b7b2",
      "#edc948",
      "#b07aa1",
      "#ff9da7",
    ]);
    expect(new Set(colors).size).toBe(8);
    expect(colors).not.toContain("#808080");
  });

  it("supports explicit colors and requests another Automatic choice for each outcome", async () => {
    const user = userEvent.setup();
    const onOutcomeColorChange = vi.fn();
    const outcomes = makeOutcomes(2).map((outcome, index) =>
      index === 0 ? { ...outcome, color: "#123456" } : outcome,
    );
    render(
      <OutcomesStep
        outcomeType="categorical"
        outcomes={outcomes}
        onOutcomeColorChange={onOutcomeColorChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Color for Outcome1"), {
      target: { value: "#A1B2C3" },
    });
    expect(onOutcomeColorChange).toHaveBeenCalledWith("o1", "#a1b2c3");

    await user.click(screen.getByRole("button", { name: "Use automatic color for Outcome0" }));
    expect(onOutcomeColorChange).toHaveBeenLastCalledWith("o0", null);
    expect(
      screen.getByRole("button", { name: "Use automatic color for Outcome0" }),
    ).not.toHaveAttribute("aria-pressed");
    expect(screen.getAllByRole("button", { name: /Use automatic color for Outcome/ })).toHaveLength(
      2,
    );
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

describe("OutcomesStep outcome label rule", () => {
  const outcomes = (...labels: string[]): WizardOutcome[] =>
    labels.map((label, i) => ({ id: `o${i}`, label, description: "" }));

  it.each([
    ["en", "Next", "Use 1 to 191 ASCII letters or digits, with no spaces or symbols."],
    ["ja", "次へ", "半角英数字で1〜191文字にしてください。スペースや記号は使えません。"],
  ] as const)(
    "explains the unchanged 191-character ASCII boundary in %s",
    (language, next, error) => {
      const instance = i18n.cloneInstance({ lng: language });
      const step = (label: string) => (
        <I18nextProvider i18n={instance}>
          <OutcomesStep outcomeType="categorical" outcomes={outcomes(label, "Other")} />
        </I18nextProvider>
      );
      const view = render(step("A".repeat(191)));
      expect(screen.getByRole("button", { name: next })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      view.rerender(step("A".repeat(192)));
      expect(screen.getAllByRole("textbox")[0]).toHaveValue("A".repeat(192));
      expect(screen.getByRole("alert")).toHaveTextContent(error);
      expect(screen.getByRole("button", { name: next })).toBeDisabled();
      for (const label of ["東京", "Ａ", "é"]) {
        view.rerender(step(label));
        expect(screen.getAllByRole("textbox")[0]).toHaveValue(label);
        expect(screen.getByRole("alert")).toHaveTextContent(error);
        expect(screen.getByRole("button", { name: next })).toBeDisabled();
      }
    },
  );

  it.each([
    ["a case variant", ["Red", "red"], "Another outcome already has this name."],
    ["a padded copy", ["Red", " Red "], "Another outcome already has this name."],
    [
      "a space inside",
      ["New York", "Paris"],
      "Use 1 to 191 ASCII letters or digits, with no spaces or symbols.",
    ],
    [
      "the set separator",
      ["Red|Blue", "Green"],
      "Use 1 to 191 ASCII letters or digits, with no spaces or symbols.",
    ],
  ])("shows the error at the field and keeps Next disabled for %s", (_case, labels, message) => {
    render(<OutcomesStep outcomeType="categorical" outcomes={outcomes(...labels)} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("keeps a new blank field quiet but does not proceed", () => {
    render(<OutcomesStep outcomeType="categorical" outcomes={outcomes("Red", "")} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("clears the error after the user edits the duplicate", () => {
    const { rerender } = render(
      <OutcomesStep outcomeType="categorical" outcomes={outcomes("Red", "RED")} />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(<OutcomesStep outcomeType="categorical" outcomes={outcomes("Red", "Blue")} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();
  });
});
