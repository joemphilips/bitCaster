import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "../Toast";
import { useToastStore, type Toast } from "@/stores/toast";
import i18n from "@/i18n";

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

  it("names the close control in Japanese", async () => {
    await i18n.changeLanguage("ja");
    try {
      addToast({ id: "error-toast", message: "保存できませんでした", type: "error" });
      render(<ToastContainer />);

      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
      expect(screen.queryByText("保存できませんでした")).not.toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  // A long market title must not push the toast over the page heading on mobile.
  it("shows at most two lines and keeps the whole text for assistive technology", () => {
    const message = `Order filled: 1,000 shares on “${"Will the long market title wrap ".repeat(4)}?”`;
    addToast({ id: "long", message, type: "success" });
    render(<ToastContainer />);

    expect(screen.getByText(message)).toHaveClass("line-clamp-2");
    expect(screen.getByRole("status")).toHaveTextContent(message);
  });

  it("shows a third line for a short notice that names an action", () => {
    addToast({
      id: "used-elsewhere",
      message: "Use one browser at a time.",
      type: "info",
      lines: 3,
    });
    render(<ToastContainer />);

    expect(screen.getByText("Use one browser at a time.")).toHaveClass("line-clamp-3");
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

  it("shows a repeated message once and restarts its display time", () => {
    const addToast = useToastStore.getState().addToast;
    render(<ToastContainer />);

    act(() => {
      addToast({ message: "Oracle Nostr ID copied.", type: "success" });
      addToast({ message: "Oracle Nostr ID copied.", type: "success" });
    });
    expect(screen.getAllByText("Oracle Nostr ID copied.")).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    act(() => {
      addToast({ message: "Oracle Nostr ID copied.", type: "success" });
    });
    expect(screen.getAllByText("Oracle Nostr ID copied.")).toHaveLength(1);

    // The last copy shows for the full 4 s, past the time of the first copy.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getAllByText("Oracle Nostr ID copied.")).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText("Oracle Nostr ID copied.")).not.toBeInTheDocument();
  });

  it("keeps different messages and one copy of a repeated error", () => {
    const addToast = useToastStore.getState().addToast;
    addToast({ message: "Could not save", type: "error" });
    addToast({ message: "Link copied to clipboard", type: "success" });
    addToast({ message: "Could not save", type: "error" });
    addToast({ message: "Could not save", type: "info" });
    render(<ToastContainer />);

    expect(useToastStore.getState().toasts.map(({ message, type }) => [message, type])).toEqual([
      ["Link copied to clipboard", "success"],
      ["Could not save", "error"],
      ["Could not save", "info"],
    ]);
  });
});
