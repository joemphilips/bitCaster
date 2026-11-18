import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { SeedRestoreResult } from "../SeedRestoreResult";
import { WalletSetupModal } from "../WalletSetupModal";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  root?.unmount();
  host?.remove();
  await i18n.changeLanguage("en");
});

function renderAt(element: ReactElement): HTMLDivElement {
  host = document.body.appendChild(document.createElement("div"));
  host.className = "mx-auto max-w-3xl px-4";
  root = createRoot(host);
  const current = root;
  flushSync(() => current.render(element));
  return host;
}

/** Each command shows in the monospace font, and a line breaks only between its tokens. */
function expectCommandsUnbroken(scope: ParentNode, count: number, width: number): void {
  const codes = Array.from(scope.querySelectorAll("code"));
  expect(codes).toHaveLength(count);
  for (const code of codes) {
    expect(getComputedStyle(code).fontFamily).toContain("JetBrains Mono");
    for (const token of code.children) {
      expect(token.getClientRects()).toHaveLength(1);
      expect(token.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    }
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
}

it.each([
  { language: "en", width: 320 },
  { language: "ja", width: 320 },
  { language: "en", width: 390 },
])(
  "keeps each restore result command unbroken in $language at $width pixels",
  async ({ language, width }) => {
    await page.viewport(width, 844);
    await i18n.changeLanguage(language);
    const scope = renderAt(
      createElement(SeedRestoreResult, {
        result: { scopeId: "scope", partial: true, retryable: true, gapLineShown: true },
      }),
    );

    expectCommandsUnbroken(scope, 2, width);
    const directory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (directory)
      await page.screenshot({ path: `${directory}/restore-result-${language}-${width}.png` });
  },
);

it.each([
  { language: "en", width: 320 },
  { language: "ja", width: 320 },
  { language: "en", width: 390 },
])(
  "keeps the counter gap command unbroken in $language at $width pixels",
  async ({ language, width }) => {
    await page.viewport(width, 844);
    await i18n.changeLanguage(language);
    renderAt(
      createElement(WalletSetupModal, {
        mode: "replace",
        warning: { code: "counter-gap", command: "bitcaster wallet recover-seed --gap-limit 401" },
        confirmWarning: true,
        onClose: () => {},
        onCreateNew: () => {},
        onImportSeed: () => {},
      }),
    );

    await expect.poll(() => document.querySelector("dialog [role='alert']")).not.toBeNull();
    expectCommandsUnbroken(document.querySelector("dialog")!, 1, width);
    const directory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (directory)
      await page.screenshot({ path: `${directory}/counter-gap-${language}-${width}.png` });
  },
);
