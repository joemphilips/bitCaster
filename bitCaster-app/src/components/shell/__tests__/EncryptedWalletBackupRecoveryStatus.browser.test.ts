import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { DepositLightning } from "@/components/deposit-withdraw/DepositLightning";
import { WalletBackupPresentationProvider } from "@/hooks/WalletBackupPresentation";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const language = i18n.language;
afterEach(async () => {
  root?.unmount();
  host?.remove();
  await i18n.changeLanguage(language);
});
for (const locale of ["en", "ja"] as const) {
  it(`shows original-ID guidance without hiding the deposit action in ${locale}`, async () => {
    await page.viewport(390, 844);
    await i18n.changeLanguage(locale);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      createElement(WalletBackupPresentationProvider, {
        value: {
          recoveryStatus: { kind: "blocked", reason: "wrong-account" },
          retryRecovery: vi.fn(),
        },
        children: createElement(DepositLightning, {
          mints: [
            { id: "mint", name: "Bitcoin mint", url: "https://mint.example", balanceSats: 1200 },
          ],
          selectedMintId: "mint",
          amountSats: 2500,
        }),
      }),
    );
    await expect
      .poll(() => host!.querySelector('[role="status"]')?.textContent)
      .toContain(i18n.t("walletBackupRecovery.blocked.wrong-account.title"));
    await document.fonts.ready;
    const status = host.querySelector('[role="status"]')!;
    const link = status.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/settings?category=nostr");
    expect(status.textContent).toContain(i18n.t("walletBackupRecovery.localWalletKept"));
    const action = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create Invoice"),
    )!;
    expect(action.disabled).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
    await page.screenshot({
      path: `.vitest-attachments/first-account/${locale}-deposit-narrow.png`,
    });
  });
}
