import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { AppShell } from "../AppShell";

// Exercise the actual shell and menus. Notifications own unrelated external I/O.
vi.mock("../NotificationBell", () => ({ NotificationBell: () => null }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalLanguage = i18n.language;
const originalDark = document.documentElement.classList.contains("dark");
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const visible = (element: Element) =>
  element.checkVisibility({ opacityProperty: true, visibilityProperty: true });

function assertInsideViewport(element: Element) {
  const rect = element.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(innerWidth + 1);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(innerHeight + 1);
}

afterEach(async () => {
  root?.unmount();
  root = undefined;
  host?.remove();
  host = undefined;
  vi.unstubAllEnvs();
  document.documentElement.classList.toggle("dark", originalDark);
  await i18n.changeLanguage(originalLanguage);
});

for (const layout of ["desktop", "mobile"] as const) {
  for (const environment of ["mainnet", "testnet", "absent"] as const) {
    it(`${layout} shows the correct brand and ${environment} environment menu`, async () => {
      await page.viewport(layout === "desktop" ? 1280 : 390, 900);
      await i18n.changeLanguage("en");
      document.documentElement.classList.remove("dark");
      const origin =
        environment === "mainnet"
          ? "https://testnet.example"
          : environment === "testnet"
            ? "https://mainnet.example"
            : "";
      vi.stubEnv("VITE_BITCASTER_ENVIRONMENT", environment === "absent" ? "" : environment);
      vi.stubEnv("VITE_ALTERNATE_ORIGIN", origin);
      const onNavigate = vi.fn();
      const onLogout = vi.fn();
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      root.render(
        createElement(AppShell, {
          navigationItems: [{ label: "Markets", href: "/markets", isActive: true }],
          user: { name: "Alice", balance: 7001 },
          onNavigate,
          onLogout,
          children: createElement("p", { className: "p-6" }, "Market content"),
        }),
      );
      await expect.poll(() => host!.querySelectorAll("header").length).toBe(2);
      await document.fonts.ready;
      await frame();
      const headers = [...host.querySelectorAll("header")];
      expect(headers.map(visible)).toEqual(layout === "desktop" ? [true, false] : [false, true]);
      const header = headers[layout === "desktop" ? 0 : 1]!;
      const brand = header.querySelector<SVGSVGElement>('svg[role="img"]')!;
      expect(brand.getAttribute("aria-label")).toBe("bitCaster");
      expect(brand.textContent?.trim()).toBe("bitCaster");
      expect(host.textContent).not.toMatch(/beta|β/i);
      assertInsideViewport(brand);
      // Check the real font fits the reduced SVG viewBox, rather than trusting its declared width.
      const glyphs = brand.querySelector("text")!.getBBox();
      expect(glyphs.x).toBeGreaterThanOrEqual(brand.viewBox.baseVal.x - 1);
      expect(glyphs.x + glyphs.width).toBeLessThanOrEqual(brand.viewBox.baseVal.width + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await page.screenshot({ path: `/tmp/p9-shell-browser/${environment}-${layout}-header.png` });

      await page
        .getByRole("button", {
          name: layout === "desktop" ? /^Alice/ : "User",
          exact: layout === "mobile",
        })
        .click();
      await expect
        .poll(() =>
          [...host!.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Settings" && visible(button),
          ),
        )
        .toBe(true);
      const environmentLinks = [...host.querySelectorAll<HTMLAnchorElement>("a")].filter((link) =>
        /Go to (mainnet|testnet)/.test(link.textContent ?? ""),
      );
      if (environment === "absent") {
        expect(environmentLinks).toHaveLength(0);
      } else {
        expect(environmentLinks).toHaveLength(1);
        const link = environmentLinks[0]!;
        expect(visible(link)).toBe(true);
        expect(link.textContent?.trim()).toBe(
          environment === "mainnet" ? "Go to testnet" : "Go to mainnet",
        );
        assertInsideViewport(link);
        expect(link.getAttribute("href")).toBe(`${origin}/`);
        expect(link.target).toBe("_blank");
        expect(link.rel.split(/\s+/).sort()).toEqual(["noopener", "noreferrer"]);
        const destination = new URL(link.href);
        expect(destination.protocol).toBe("https:");
        expect(destination.pathname).toBe("/");
        expect(destination.search).toBe("");
        expect(destination.hash).toBe("");
        expect(destination.username).toBe("");
        expect(destination.password).toBe("");
        expect(destination.origin).not.toBe(location.origin);
        link.focus();
        expect(document.activeElement).toBe(link);
        // Do not click: approved live destinations are not part of this fixture.
      }
      expect(onNavigate).not.toHaveBeenCalled();
      expect(onLogout).not.toHaveBeenCalled();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await page.screenshot({ path: `/tmp/p9-shell-browser/${environment}-${layout}-menu.png` });
    });
  }
}
