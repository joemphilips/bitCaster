import { defineBrowserCommand, playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";
import { chromiumLaunchOptions } from "../scripts/playwright-launch.mjs";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.browser.test.ts"],
      browser: {
        enabled: true,
        // Parallel test processes must not inherit the app server's fixed port.
        api: { host: "127.0.0.1", strictPort: false },
        // A large tester window keeps the test frame at scale 1, so a page
        // screenshot has no empty band below a scaled frame.
        provider: playwright({
          launchOptions: chromiumLaunchOptions(),
          contextOptions: { viewport: { width: 1600, height: 2600 } },
        }),
        headless: true,
        commands: {
          // A component test checks its prefers-reduced-motion style.
          setReducedMotion: defineBrowserCommand(
            async ({ page }, reducedMotion: "reduce" | "no-preference") => {
              if (reducedMotion !== "reduce" && reducedMotion !== "no-preference")
                throw new Error("Invalid motion preference");
              await page.emulateMedia({ reducedMotion });
            },
          ),
        },
        instances: [{ browser: "chromium" }],
      },
    },
  }),
);
