import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoppedPage } from "../StoppedPage";

const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

function persist(key: string, state: Record<string, unknown>) {
  localStorage.setItem(key, JSON.stringify({ state, version: 0 }));
}

function storageSnapshot(): Record<string, string | null> {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!;
      return [key, localStorage.getItem(key)];
    }),
  );
}

describe("StoppedPage", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows the recovery phrase of this browser only after the user asks", async () => {
    persist("bitcaster-wallet", { mnemonic: SEED, setupComplete: true });
    persist("bitcaster-settings", { nostrSignerMode: "nip07", nsecSecret: null });
    localStorage.setItem("i18nextLng", "en");
    const before = storageSnapshot();
    render(<StoppedPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "bitCaster is temporarily unavailable.",
    );
    expect(screen.queryByText("abandon")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show recovery phrase" }));
    const words = screen.getAllByTestId("seed-word").map((element) => element.textContent);
    expect(words).toEqual(SEED.split(" "));

    expect(screen.getByText(/everyday_animate734@simplelogin\.com/)).toBeInTheDocument();
    // The page has no link: it names no other site.
    expect(screen.queryAllByRole("link")).toEqual([]);

    expect(storageSnapshot()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not show a local Nostr key", async () => {
    persist("bitcaster-wallet", { mnemonic: SEED });
    persist("bitcaster-settings", { nostrSignerMode: "nsec", nsecSecret: NSEC });
    localStorage.setItem("i18nextLng", "en");
    render(<StoppedPage />);

    await userEvent.click(screen.getByRole("button", { name: "Show recovery phrase" }));
    expect(screen.getAllByTestId("seed-word")).toHaveLength(12);
    expect(document.body.textContent).not.toContain(NSEC);
    expect(screen.queryByText(/Nostr/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "日本語",
      "Hide recovery phrase",
      "Copy",
    ]);
  });

  describe("with a controlled clock", () => {
    let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };
    let held: string;

    beforeEach(() => {
      // The React scheduler uses setImmediate. Fake only the timers of the page.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      held = "";
      clipboard = {
        writeText: vi.fn(async (value: string) => {
          held = value;
        }),
        readText: vi.fn(async () => held),
      };
      persist("bitcaster-wallet", { mnemonic: SEED });
      localStorage.setItem("i18nextLng", "en");
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function showAndCopy() {
      // user-event waits on timers, and this clock runs only when a test advances it.
      Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
      render(<StoppedPage />);
      fireEvent.click(screen.getByRole("button", { name: "Show recovery phrase" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      });
    }

    it("clears a copied phrase from the clipboard after 60 seconds", async () => {
      await showAndCopy();
      expect(clipboard.writeText).toHaveBeenLastCalledWith(SEED);
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(held).toBe(SEED);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(held).toBe("");
    });

    it("keeps other clipboard text that the user copied later", async () => {
      await showAndCopy();
      fireEvent.click(screen.getByRole("button", { name: "Hide recovery phrase" }));
      held = "other text";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(held).toBe("other text");
    });

    it("clears the copied phrase after the user hides it", async () => {
      await showAndCopy();
      fireEvent.click(screen.getByRole("button", { name: "Hide recovery phrase" }));
      expect(screen.queryAllByTestId("seed-word")).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(held).toBe(SEED);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(held).toBe("");
    });

    it("clears a recent copy after the phrase automatically hides", async () => {
      await showAndCopy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
        fireEvent.click(screen.getByRole("button", { name: "Copied" }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.queryAllByTestId("seed-word")).toEqual([]);
      expect(held).toBe(SEED);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(held).toBe("");
    });

    it("says that the copy failed when the browser refuses the clipboard", async () => {
      clipboard.writeText.mockRejectedValue(new Error("denied"));
      await showAndCopy();
      expect(screen.getByText("Copy failed. Write the words down.")).toBeInTheDocument();
    });

    it("hides a shown phrase again after five minutes", async () => {
      await showAndCopy();
      expect(screen.getAllByTestId("seed-word")).toHaveLength(12);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(screen.queryAllByTestId("seed-word")).toEqual([]);
      expect(screen.getByRole("button", { name: "Show recovery phrase" })).toBeInTheDocument();
    });
  });

  it("tells a browser without a wallet that it has nothing to keep", () => {
    localStorage.setItem("i18nextLng", "en");
    render(<StoppedPage />);
    expect(screen.getByText("This browser has no bitCaster wallet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show recovery phrase" })).not.toBeInTheDocument();
  });

  it("uses the language of the app, and the user can change it without a write", async () => {
    persist("bitcaster-wallet", { mnemonic: SEED });
    localStorage.setItem("i18nextLng", "ja");
    const before = storageSnapshot();
    render(<StoppedPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "bitcasterは現在一時的に公開を停止しています",
    );
    expect(document.documentElement.lang).toBe("ja");
    // The operator's Japanese contact text keeps its line break as two paragraphs.
    expect(
      screen.getByText("連絡を取りたい方はeveryday_animate734@simplelogin.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("まで連絡ください")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "bitCaster is temporarily unavailable.",
    );
    expect(document.documentElement.lang).toBe("en");
    expect(storageSnapshot()).toEqual(before);
  });
});
