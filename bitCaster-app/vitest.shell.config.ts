import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";
import { chromiumLaunchOptions } from "../scripts/playwright-launch.mjs";

// vitest.browser.config.ts excludes these files, because they need the context below.
export const shellBrowserTests = [
  "src/components/shell/__tests__/AppShell.environment.browser.test.ts",
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    server: { host: "127.0.0.1" },
    optimizeDeps: { include: ["react-dom/client"] },
    test: {
      include: shellBrowserTests,
      fileParallelism: false,
      testTimeout: 20_000,
      browser: {
        enabled: true,
        headless: true,
        viewport: { width: 1280, height: 900 },
        instances: [
          {
            name: "shell-environment",
            browser: "chromium",
            provider: playwright({
              launchOptions: chromiumLaunchOptions(),
              contextOptions: { locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" },
            }),
          },
        ],
      },
    },
  }),
);
