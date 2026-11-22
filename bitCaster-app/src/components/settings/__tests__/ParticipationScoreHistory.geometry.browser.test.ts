import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import type { ParticipationScoreHistoryResponse } from "@bitcaster/client-sdk/engineClient";
import { ParticipationScoreHistory } from "../ParticipationScoreHistory";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  root?.unmount();
  host?.remove();
  await i18n.changeLanguage("en");
});

// Amounts of different widths. The times and the amounts must still align.
const HISTORY: ParticipationScoreHistoryResponse = {
  balance: -1_229,
  entries: [
    {
      kind: "reused-output-penalty",
      amountScore: -1_234,
      balanceAfter: -1_229,
      occurredAt: "2026-08-21T00:00:03Z",
    },
    {
      kind: "capability-binding",
      amountScore: -2,
      balanceAfter: 5,
      occurredAt: "2026-08-20T00:00:00Z",
    },
    { kind: "purchase", amountScore: 7, balanceAfter: 7, occurredAt: "2026-08-19T00:00:00Z" },
  ],
};

it.each([
  { language: "en", width: 390 },
  { language: "ja", width: 390 },
  { language: "en", width: 1000 },
])(
  "aligns the times and the amounts in $language at $width pixels",
  async ({ language, width }) => {
    await page.viewport(width, 844);
    await i18n.changeLanguage(language);
    host = document.body.appendChild(document.createElement("div"));
    host.className = "mx-auto max-w-3xl px-4";
    root = createRoot(host);
    root.render(createElement(ParticipationScoreHistory, { load: async () => HISTORY }));

    await expect.poll(() => host!.querySelectorAll("li").length).toBe(3);
    const rows = Array.from(host.querySelectorAll("li"));
    const edges = (column: number) =>
      rows.map((row) => Math.round(row.children[column]!.getBoundingClientRect().right));
    const amountWidths = rows.map((row) => row.children[2]!.getBoundingClientRect().width);

    expect(new Set(edges(1)).size).toBe(1);
    expect(new Set(edges(2)).size).toBe(1);
    expect(new Set(amountWidths.map(Math.round)).size).toBe(1);
    // The longest label does not wrap the time onto a second line.
    for (const row of rows) {
      const time = row.children[1] as HTMLElement;
      const lineHeight = Number.parseFloat(getComputedStyle(time).lineHeight);
      expect(time.getBoundingClientRect().height).toBeLessThan(lineHeight * 1.5);
    }
    // The widest amount fits its column.
    for (const row of rows) {
      const amount = row.children[2] as HTMLElement;
      expect(amount.scrollWidth).toBeLessThanOrEqual(amount.clientWidth);
    }
    const directory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (directory)
      await page.screenshot({ path: `${directory}/score-history-${language}-${width}.png` });
  },
);
