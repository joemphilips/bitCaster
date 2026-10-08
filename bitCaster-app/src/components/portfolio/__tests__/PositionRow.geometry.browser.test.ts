import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { PositionRow } from "../PositionRow";
import type { Position } from "@/types/portfolio";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  root?.unmount();
  host?.remove();
  await i18n.changeLanguage("en");
});
it.each([
  { language: "en", width: 320 },
  { language: "ja", width: 320 },
  { language: "en", width: 1000 },
  { language: "ja", width: 1000 },
])(
  "keeps $language removal confirmation inside a $width-pixel portfolio",
  async ({ language, width }) => {
    await page.viewport(width, 844);
    await i18n.changeLanguage(language);
    host = document.createElement("div");
    host.className = "mx-auto max-w-3xl px-4";
    document.body.append(host);
    root = createRoot(host);
    const position: Position = {
      id: "loser",
      marketId: "market",
      marketTitle: "A representative losing prediction",
      marketImageUrl: "",
      baseAsset: "sat",
      divisibility: 1000,
      mintUrl: "https://mint.example",
      side: "no",
      shares: 10,
      currentValueSats: 0,
      status: "closed",
      isWinner: false,
      isLoser: true,
      isPending: false,
      acquiredDate: "2026-10-08T00:00:00Z",
    };
    root.render(
      createElement(
        "div",
        { className: "rounded-2xl border p-4" },
        createElement(PositionRow, {
          position,
          confirmingRemoval: true,
          onDiscard: () => {},
          onConfirmDiscard: () => {},
          onCancelDiscard: () => {},
        }),
      ),
    );
    await expect
      .poll(() => host!.querySelector('[data-testid="position-removal-confirmation"]'))
      .not.toBeNull();
    const confirmation = host.querySelector<HTMLElement>(
      '[data-testid="position-removal-confirmation"]',
    )!;
    const bounds = host.firstElementChild!.getBoundingClientRect();
    for (const element of [
      confirmation,
      confirmation.querySelector("p")!,
      ...confirmation.querySelectorAll("button"),
    ]) {
      const box = element.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(bounds.left);
      expect(box.right).toBeLessThanOrEqual(Math.min(bounds.right, width));
      expect(box.width).toBeGreaterThan(0);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const directory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (directory)
      await page.screenshot({ path: `${directory}/confirmation-${language}-${width}.png` });
    for (const button of confirmation.querySelectorAll("button")) {
      const box = button.getBoundingClientRect();
      expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(
        button,
      );
    }
  },
);
