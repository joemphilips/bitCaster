import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShareMarket } from "../useShareMarket";
import { useToastStore } from "@/stores/toast";

interface NavigatorMutable {
  share?: ((data: ShareData) => Promise<void>) | undefined;
  clipboard?: { writeText: (text: string) => Promise<void> };
}

describe("useShareMarket", () => {
  let originalShare: NavigatorMutable["share"];
  let originalClipboard: NavigatorMutable["clipboard"];
  const realLocation = window.location;

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    originalShare = (navigator as unknown as NavigatorMutable).share;
    originalClipboard = (navigator as unknown as NavigatorMutable).clipboard;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, href: "https://app.bitcaster.test/markets/abc123" },
    });
  });

  afterEach(() => {
    if (originalShare === undefined) {
      delete (navigator as unknown as NavigatorMutable).share;
    } else {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: originalShare,
        writable: true,
      });
    }
    if (originalClipboard === undefined) {
      delete (navigator as unknown as NavigatorMutable).clipboard;
    } else {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
        writable: true,
      });
    }
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  });

  it("invokes navigator.share with title + url when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share, writable: true });
    const { result } = renderHook(() => useShareMarket({ title: "Will BTC hit 100K?" }));

    await act(async () => {
      await result.current();
    });

    expect(share).toHaveBeenCalledWith({
      title: "Will BTC hit 100K?",
      url: "https://app.bitcaster.test/markets/abc123",
    });
    // Clipboard path is NOT exercised when navigator.share exists.
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("falls back to clipboard write + success toast when navigator.share is undefined", async () => {
    delete (navigator as unknown as NavigatorMutable).share;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
      writable: true,
    });
    const { result } = renderHook(() => useShareMarket({ title: "m" }));

    await act(async () => {
      await result.current();
    });

    expect(writeText).toHaveBeenCalledWith("https://app.bitcaster.test/markets/abc123");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("success");
  });

  it("swallows AbortError from navigator.share (user cancelled the sheet)", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const share = vi.fn().mockRejectedValue(abort);
    Object.defineProperty(navigator, "share", { configurable: true, value: share, writable: true });
    const { result } = renderHook(() => useShareMarket({ title: "m" }));

    await act(async () => {
      await result.current();
    });

    // No toast — cancel is not a failure.
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does NOT fall back to clipboard when navigator.share rejects (non-cancel)", async () => {
    const share = vi.fn().mockRejectedValue(new Error("share failed"));
    Object.defineProperty(navigator, "share", { configurable: true, value: share, writable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
      writable: true,
    });
    const { result } = renderHook(() => useShareMarket({ title: "m" }));

    await act(async () => {
      await result.current();
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("emits an error toast when clipboard write rejects", async () => {
    delete (navigator as unknown as NavigatorMutable).share;
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
      writable: true,
    });
    const { result } = renderHook(() => useShareMarket({ title: "m" }));

    await act(async () => {
      await result.current();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("error");
  });
});
