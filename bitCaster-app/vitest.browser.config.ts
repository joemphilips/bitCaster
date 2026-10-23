import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.browser.test.ts"],
      browser: {
        enabled: true,
        // Parallel test processes must not inherit the app server's fixed port.
        api: { host: "127.0.0.1", strictPort: false },
        provider: playwright(),
        headless: true,
        instances: [{ browser: "chromium" }],
      },
    },
  }),
);
