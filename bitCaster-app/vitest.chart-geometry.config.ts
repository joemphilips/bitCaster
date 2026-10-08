import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    server: { host: "127.0.0.1" },
    optimizeDeps: { include: ["react-dom/client"] },
    test: {
      include: ["src/components/market-detail/__tests__/PriceChart.geometry.browser.test.ts"],
      fileParallelism: false,
      testTimeout: 30_000,
      browser: {
        enabled: true,
        headless: true,
        viewport: { width: 1280, height: 900 },
        instances: [1, 2].map((deviceScaleFactor) => ({
          name: `chart-geometry-dpr${deviceScaleFactor}`,
          browser: "chromium",
          provider: playwright({
            contextOptions: { deviceScaleFactor, locale: "en-US", timezoneId: "UTC" },
          }),
        })),
      },
    },
  }),
);
