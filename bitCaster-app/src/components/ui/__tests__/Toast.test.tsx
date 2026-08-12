import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "../Toast";
import { useToastStore, type Toast } from "@/stores/toast";

function addToast(toast: Toast): void {
  useToastStore.setState({ toasts: [toast] });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe("ToastContainer", () => {
  it("keeps an error notification visible until the user dismisses it", () => {
    addToast({ id: "error-toast", message: "Could not save", type: "error", duration: 1 });
    render(<ToastContainer />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText("Could not save")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Could not save")).not.toBeInTheDocument();
  });

  it.each([
    ["success", "Saved"],
    ["info", "Syncing"],
  ] as const)("automatically dismisses a %s notification", (type, message) => {
    addToast({ id: `${type}-toast`, message, type });
    render(<ToastContainer />);

    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it("keeps errors when transient notifications exceed the queue limit", () => {
    const addToast = useToastStore.getState().addToast;
    addToast({ message: "Could not save", type: "error" });
    for (let index = 0; index < 11; index += 1) {
      addToast({ message: `Update ${index}`, type: "info" });
    }
    render(<ToastContainer />);

    expect(useToastStore.getState().toasts.filter((toast) => toast.type !== "error")).toHaveLength(
      10,
    );
    expect(screen.getByText("Could not save")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("overflow-y-auto");

    const errorToast = screen.getByText("Could not save").parentElement;
    expect(errorToast).not.toBeNull();
    fireEvent.click(within(errorToast!).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Could not save")).not.toBeInTheDocument();
  });
});
