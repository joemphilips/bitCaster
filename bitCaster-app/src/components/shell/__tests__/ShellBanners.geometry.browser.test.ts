import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { AppShell } from "../AppShell";
import { RecoveryIndexStatus } from "../RecoveryIndexStatus";
import { ShellBanners } from "../ShellBanners";

// Notifications own unrelated external I/O. The banner is the real component.
vi.mock("../NotificationBell", () => ({ NotificationBell: () => null }));
const status = vi.hoisted(() => ({ blocked: true }));
vi.mock("@/hooks/useBrowserRecoveryIndex", () => ({
  useBrowserRecoveryIndexStatus: () =>
    status.blocked ? { kind: "blocked", reason: "over-cap" } : { kind: "current" },
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(async () => {
  root?.unmount();
  root = undefined;
  host?.remove();
  host = undefined;
  status.blocked = true;
  await i18n.changeLanguage("en");
});

async function renderShell(width: number) {
  await page.viewport(width, 900);
  await i18n.changeLanguage("en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  root.render(
    createElement(AppShell, {
      navigationItems: [{ label: "Markets", href: "/markets", isActive: true }],
      isLoggedIn: false,
      children: [
        createElement(ShellBanners, {
          key: "banners",
          children: createElement(RecoveryIndexStatus),
        }),
        createElement("p", { key: "content", "data-testid": "content" }, "Market content"),
      ],
    }),
  );
  await expect.poll(() => host!.querySelector("main p")).not.toBeNull();
  await document.fonts.ready;
  await frame();
  const header = [...host.querySelectorAll("header")].find((element) => element.checkVisibility())!;
  return { header, main: host.querySelector("main")! };
}

// The page container: max-w-7xl (1280 px), centered, with a 16, 24 or 32 px
// gutter from the sm (640 px) and lg (1024 px) breakpoints.
it.each([
  { width: 390, edge: 16 },
  { width: 800, edge: 24 },
  { width: 1280, edge: 32 },
  { width: 1600, edge: 160 + 32 },
])("starts a banner at the page content edge at $width pixels", async ({ width, edge }) => {
  const { header } = await renderShell(width);

  const banner = host!.querySelector('[data-testid="recovery-index-blocked"]')!;
  const box = banner.getBoundingClientRect();
  expect(box.left).toBeCloseTo(edge, 0);
  expect(box.right).toBeCloseTo(width - edge, 0);
  // The banner keeps a gap below the header border.
  expect(box.top - header.getBoundingClientRect().bottom).toBeCloseTo(16, 0);
  // On desktop it lines up with the header logo, which starts the header content.
  if (width >= 768) {
    const logo = header.querySelector("button")!.getBoundingClientRect();
    expect(box.left).toBeCloseTo(logo.left, 0);
  }
});

it.each([390, 1280])("adds no gap when no banner shows at %i pixels", async (width) => {
  status.blocked = false;
  const { main } = await renderShell(width);

  const content = host!.querySelector('[data-testid="content"]')!;
  expect(content.getBoundingClientRect().top).toBeCloseTo(main.getBoundingClientRect().top, 0);
});
