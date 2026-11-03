import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HelpTip, tipPosition } from "../HelpTip";
import { NativeDialog } from "../NativeDialog";

const LABEL = "About Participation Score";
const CONTENT = "An anti-spam fee.";

function renderTip() {
  return render(
    <div>
      <HelpTip label={LABEL} content={CONTENT} testId="help" />
      <button type="button">Elsewhere</button>
    </div>,
  );
}

function tooltip() {
  return screen.queryByRole("tooltip");
}

describe("HelpTip", () => {
  it("is a real button that names the term and describes it while closed", () => {
    renderTip();

    const button = screen.getByRole("button", { name: LABEL });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAccessibleDescription(CONTENT);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(tooltip()).toBeNull();
  });

  it("gives the button a 44 px touch target", () => {
    renderTip();

    expect(screen.getByRole("button", { name: LABEL })).toHaveClass("h-11", "w-11");
  });

  it("opens on mouse hover and closes when the pointer leaves", async () => {
    const user = userEvent.setup();
    renderTip();
    const button = screen.getByRole("button", { name: LABEL });

    await user.hover(button);
    expect(tooltip()).toHaveTextContent(CONTENT);
    expect(button).toHaveAttribute("aria-expanded", "true");

    await user.unhover(button);
    expect(tooltip()).toBeNull();
  });

  it("stays open while the pointer moves onto the explanation", async () => {
    const user = userEvent.setup();
    renderTip();

    await user.hover(screen.getByRole("button", { name: LABEL }));
    await user.hover(screen.getByRole("tooltip"));

    expect(tooltip()).toHaveTextContent(CONTENT);
  });

  it("opens on keyboard focus, closes on Escape, and closes on blur", async () => {
    const user = userEvent.setup();
    renderTip();
    const button = screen.getByRole("button", { name: LABEL });

    await user.tab();
    expect(button).toHaveFocus();
    expect(tooltip()).toHaveTextContent(CONTENT);

    await user.keyboard("{Escape}");
    expect(tooltip()).toBeNull();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(tooltip()).toHaveTextContent(CONTENT);

    await user.tab();
    expect(tooltip()).toBeNull();
  });

  it("does not open on focus that follows a pointer press, such as a dialog's initial focus", async () => {
    const user = userEvent.setup();
    renderTip();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    act(() => screen.getByRole("button", { name: LABEL }).focus());

    expect(tooltip()).toBeNull();
  });

  it("toggles on tap and closes on a tap outside", async () => {
    const user = userEvent.setup();
    renderTip();
    const button = screen.getByRole("button", { name: LABEL });

    await user.pointer({ keys: "[TouchA]", target: button });
    expect(tooltip()).toHaveTextContent(CONTENT);

    await user.pointer({ keys: "[TouchA]", target: button });
    expect(tooltip()).toBeNull();

    await user.pointer({ keys: "[TouchA]", target: button });
    expect(tooltip()).toHaveTextContent(CONTENT);
    await user.pointer({
      keys: "[TouchA]",
      target: screen.getByRole("button", { name: "Elsewhere" }),
    });
    expect(tooltip()).toBeNull();
  });

  it("keeps a tapped explanation open when the user taps the explanation", async () => {
    const user = userEvent.setup();
    renderTip();

    await user.pointer({ keys: "[TouchA]", target: screen.getByRole("button", { name: LABEL }) });
    await user.pointer({ keys: "[TouchA]", target: screen.getByRole("tooltip") });

    expect(tooltip()).toHaveTextContent(CONTENT);
  });

  it("closes a hovered explanation on Escape without keyboard focus", async () => {
    const user = userEvent.setup();
    renderTip();

    await user.hover(screen.getByRole("button", { name: LABEL }));
    expect(tooltip()).not.toBeNull();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });

    expect(tooltip()).toBeNull();
  });

  it("consumes Escape only while open, so a parent dialog keeps its own Escape", async () => {
    const user = userEvent.setup();
    renderTip();
    const button = screen.getByRole("button", { name: LABEL });

    await user.tab();
    expect(tooltip()).not.toBeNull();
    // fireEvent returns false when a handler called preventDefault. A browser
    // then starts no dialog close request for this key press.
    expect(fireEvent.keyDown(button, { key: "Escape" })).toBe(false);
    expect(tooltip()).toBeNull();

    expect(fireEvent.keyDown(button, { key: "Escape" })).toBe(true);
  });

  it("works inside a native dialog", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <NativeDialog ariaLabel="Dialog" onDismiss={onDismiss}>
        {() => <HelpTip label={LABEL} content={CONTENT} />}
      </NativeDialog>,
    );

    await user.pointer({ keys: "[TouchA]", target: screen.getByRole("button", { name: LABEL }) });

    expect(tooltip()).toHaveTextContent(CONTENT);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps the explanation inside a narrow viewport", () => {
    const nearLeft = { left: 10, width: 20, top: 100, bottom: 120 };
    expect(tipPosition(nearLeft, 390, 844)).toEqual({ left: 8, width: 256, top: 124 });

    const nearRight = { left: 360, width: 20, top: 100, bottom: 120 };
    expect(tipPosition(nearRight, 390, 844)).toEqual({ left: 126, width: 256, top: 124 });

    const lowerHalf = { left: 185, width: 20, top: 600, bottom: 620 };
    expect(tipPosition(lowerHalf, 390, 844)).toEqual({ left: 67, width: 256, bottom: 248 });

    expect(tipPosition(nearLeft, 200, 844)).toEqual({ left: 8, width: 184, top: 124 });
  });
});
