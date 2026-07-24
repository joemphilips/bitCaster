import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DateTimePicker } from "../DateTimePicker";

// Freeze "now" so calendar rendering and disabled-date logic are deterministic.
// Use April 15, 2026 (Wednesday) 10:00 local time.
const FROZEN_NOW = new Date(2026, 3, 15, 10, 0, 0);

describe("DateTimePicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders placeholder when value is empty", () => {
    render(
      <DateTimePicker
        value=""
        onChange={() => {}}
        placeholder="Select date & time"
        aria-label="End Time"
      />,
    );
    const trigger = screen.getByRole("button", { name: "End Time" });
    expect(trigger).toHaveTextContent("Select date & time");
  });

  it("renders year of the value when populated", () => {
    render(<DateTimePicker value="2026-12-31T23:45" onChange={() => {}} aria-label="End Time" />);
    const trigger = screen.getByRole("button", { name: "End Time" });
    expect(trigger.textContent ?? "").toMatch(/2026/);
  });

  it("does not render the popover initially", () => {
    render(<DateTimePicker value="" onChange={() => {}} aria-label="End Time" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the popover when the trigger is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    render(<DateTimePicker value="" onChange={() => {}} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes the popover when Escape is pressed", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    render(<DateTimePicker value="" onChange={() => {}} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the popover when Cancel is clicked without firing onChange", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    const onChange = vi.fn();
    render(<DateTimePicker value="" onChange={onChange} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables Apply when no date has been selected", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    render(<DateTimePicker value="" onChange={() => {}} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("disables days before min (defaults to start of today)", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    render(<DateTimePicker value="" onChange={() => {}} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    // April 10, 2026 is before the frozen "now" of April 15 — should be disabled.
    const day10 = screen.getByRole("button", { name: /april 10(?:th)?,? 2026/i });
    expect(day10).toBeDisabled();
  });

  it("applies the selected date and default time via onChange", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    const onChange = vi.fn();
    render(<DateTimePicker value="" onChange={onChange} aria-label="End Time" />);

    await user.click(screen.getByRole("button", { name: "End Time" }));
    // April 20, 2026 is in the future relative to the frozen "now".
    const day20 = screen.getByRole("button", { name: /april 20(?:th)?,? 2026/i });
    await user.click(day20);

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-04-20T12:00");
  });

  it("applies the selected date and a changed time via onChange", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    const onChange = vi.fn();
    render(<DateTimePicker value="" onChange={onChange} aria-label="End Time" />);

    await user.click(screen.getByRole("button", { name: "End Time" }));
    const day22 = screen.getByRole("button", { name: /april 22(?:nd)?,? 2026/i });
    await user.click(day22);

    // Directly set the time input — userEvent.type is unreliable on type=time in jsdom.
    const timeInput = screen.getByLabelText("Time") as HTMLInputElement;
    fireEvent.change(timeInput, { target: { value: "15:30" } });

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith("2026-04-22T15:30");
  });

  it("pre-fills the time input from an existing value", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    render(<DateTimePicker value="2026-04-20T23:45" onChange={() => {}} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    const timeInput = screen.getByLabelText("Time") as HTMLInputElement;
    expect(timeInput.value).toBe("23:45");
  });

  it("respects an explicit min prop that sits in the future", async () => {
    const user = userEvent.setup({ advanceTimers: (d) => vi.advanceTimersByTime(d) });
    const min = new Date(2026, 3, 25, 0, 0, 0);
    render(<DateTimePicker value="" onChange={() => {}} min={min} aria-label="End Time" />);
    await user.click(screen.getByRole("button", { name: "End Time" }));
    // April 20 < April 25: should now be disabled.
    const day20 = screen.getByRole("button", { name: /april 20(?:th)?,? 2026/i });
    expect(day20).toBeDisabled();
  });
});
