import { defineBrowserCommand, playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";
import { chromiumLaunchOptions } from "../scripts/playwright-launch.mjs";

// vitest.browser.config.ts excludes these files, because they need the instances below.
export const chartGeometryBrowserTests = [
  "src/components/market-detail/__tests__/PriceChart.geometry.browser.test.ts",
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    server: { host: "127.0.0.1" },
    optimizeDeps: { include: ["react-dom/client"] },
    test: {
      include: chartGeometryBrowserTests,
      fileParallelism: false,
      testTimeout: 30_000,
      browser: {
        enabled: true,
        headless: true,
        viewport: { width: 1280, height: 900 },
        commands: {
          setChartReducedMotion: defineBrowserCommand(
            async ({ page }, reducedMotion: "reduce" | "no-preference") => {
              if (reducedMotion !== "reduce" && reducedMotion !== "no-preference")
                throw new Error("Invalid motion preference");
              await page.emulateMedia({ reducedMotion });
            },
          ),
        },
        instances: [1, 2].map((deviceScaleFactor) => ({
          name: `chart-geometry-dpr${deviceScaleFactor}`,
          browser: "chromium",
          provider: playwright({
            launchOptions: chromiumLaunchOptions(),
            contextOptions: { deviceScaleFactor, locale: "en-US", timezoneId: "UTC" },
          }),
        })),
      },
    },
  }),
);
