import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineAmount } from "../InlineAmount";
import { MetricExplanation } from "../MetricExplanation";

function metric(onNavigate = vi.fn()) {
  return render(
    <div onClick={onNavigate}>
      <MetricExplanation label="Volume" description="Total traded volume so far">
        <span data-testid="icon" aria-hidden="true">
          ↗
        </span>
        <InlineAmount amountSubunits={100} baseAsset="sat" showTitle={false} />
      </MetricExplanation>
      <button type="button">Other control</button>
    </div>,
  );
}

describe("MetricExplanation", () => {
  it("uses one explanation over both the icon and the exact amount", async () => {
    const user = userEvent.setup();
    metric();
    const control = screen.getByRole("button", { name: /Volume.*0.1 sats/ });
    const amount = within(control).getByRole("group", { name: "0.1 sats" });

    await user.hover(screen.getByTestId("icon"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Total traded volume so far");
    await user.hover(amount);
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(control).toHaveAccessibleDescription("Total traded volume so far");
    expect(control.querySelector("[title]")).toBeNull();
    await user.unhover(control);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("supports keyboard focus and Escape", async () => {
    const user = userEvent.setup();
    metric();

    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Total traded volume so far");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("opens on tap without activating the market card and closes on blur", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    metric(onNavigate);

    await user.click(screen.getByRole("button", { name: /Volume/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Total traded volume so far");
    expect(onNavigate).not.toHaveBeenCalled();
    await user.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
