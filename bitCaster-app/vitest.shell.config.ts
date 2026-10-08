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
      include: ["src/components/shell/__tests__/AppShell.environment.browser.test.ts"],
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
              contextOptions: { locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" },
            }),
          },
        ],
      },
    },
  }),
);
