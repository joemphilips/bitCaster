import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeDialog } from "../NativeDialog";

describe("NativeDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a dialog open until a deferred owner removes it", () => {
    let completeDismissal: (() => void) | null = null;
    let closedWhileConnected = false;
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function close(
      this: HTMLDialogElement,
    ) {
      closedWhileConnected = this.isConnected;
      this.open = false;
    });
    function DeferredOwner() {
      const [isOpen, setIsOpen] = useState(true);
      if (!isOpen) return null;
      return (
        <NativeDialog
          ariaLabel="Test dialog"
          onDismiss={() => {
            completeDismissal = () => setIsOpen(false);
          }}
        >
          {(dismiss) => <button onClick={dismiss}>Close</button>}
        </NativeDialog>
      );
    }
    render(<DeferredOwner />);
    const dialog = screen.getByRole("dialog", { name: "Test dialog" }) as HTMLDialogElement;

    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(dialog.open).toBe(true);
    expect(completeDismissal).not.toBeNull();

    act(() => completeDismissal?.());

    expect(closedWhileConnected).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Test dialog" })).not.toBeInTheDocument();
  });

  it("uses the owner dismissal for a backdrop click", () => {
    const onDismiss = vi.fn();
    render(
      <NativeDialog ariaLabel="Test dialog" onDismiss={onDismiss}>
        {() => <div>content</div>}
      </NativeDialog>,
    );

    fireEvent.click(screen.getByRole("dialog", { name: "Test dialog" }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps owner dismissal disabled for a backdrop click when requested", () => {
    const onDismiss = vi.fn();
    render(
      <NativeDialog ariaLabel="Test dialog" dismissOnBackdrop={false} onDismiss={onDismiss}>
        {() => <div>content</div>}
      </NativeDialog>,
    );

    fireEvent.click(screen.getByRole("dialog", { name: "Test dialog" }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps native cancel open while dismissal is guarded", () => {
    const onDismiss = vi.fn();
    render(
      <NativeDialog ariaLabel="Test dialog" canDismiss={false} onDismiss={onDismiss}>
        {() => <div>content</div>}
      </NativeDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Test dialog" }) as HTMLDialogElement;

    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });
});
