import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, platform, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { defineBrowserCommand, playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config";

function boundedInteger(name: string, fallback: number, maximum: number) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) > maximum) throw new Error(`Invalid ${name}`);
  return Number(value);
}
const renderer = process.env.P8_CHART_RENDERER ?? "uplot";
if (renderer !== "uplot" && renderer !== "recharts") throw new Error("Invalid P8_CHART_RENDERER");
const profileFlag = process.env.P8_CHART_PROFILE ?? "0";
if (profileFlag !== "0" && profileFlag !== "1") throw new Error("Invalid P8_CHART_PROFILE");
const profileEnabled = profileFlag === "1";
const repetitions = boundedInteger("P8_CHART_REPETITIONS", 5, 20);
if (repetitions < 1) throw new Error("P8_CHART_REPETITIONS must be positive");
const warmups = boundedInteger("P8_CHART_WARMUPS", 1, 5);
const updates = boundedInteger("P8_CHART_UPDATES", 5, 20);
if (updates < 1) throw new Error("P8_CHART_UPDATES must be positive");
const dpr = boundedInteger("P8_CHART_DPR", 1, 2);
if (dpr < 1) throw new Error("P8_CHART_DPR must be 1 or 2");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const require = createRequire(import.meta.url);
function packageVersion(name: string): string {
  let directory = dirname(require.resolve(name));
  for (let depth = 0; depth < 8; depth++) {
    const file = resolve(directory, "package.json");
    if (existsSync(file)) {
      const metadata = JSON.parse(readFileSync(file, "utf8"));
      if (metadata.name === name) return metadata.version;
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate package metadata for ${name}`);
}
const hashFiles = (files: string[]) => {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(resolve(file)));
  return hash.digest("hex");
};
const sourceFiles = ["src/components/market-detail/PriceChart.tsx", "src/lib/priceHistory.ts"];
const harnessFiles = [
  "vitest.chart.config.ts",
  "src/components/market-detail/__tests__/PriceChart.benchmark.ts",
  "src/components/market-detail/__tests__/priceChartBenchmarkFixtures.ts",
];
const packages = Object.fromEntries(
  [renderer, "react", "vitest", "@vitest/browser-playwright", "playwright"].map((name) => [
    name,
    packageVersion(name),
  ]),
);
const reportPath = resolve(
  process.env.P8_CHART_REPORT ?? `/tmp/p8-chart-${renderer}-dpr${dpr}.json`,
);

const profilePath = `${reportPath}.cpuprofile`;
const profileDurationMs = 10_000;
let profileFinished: Promise<string | null> | undefined;

export default mergeConfig(
  viteConfig,
  defineConfig({
    server: { host: "127.0.0.1" },
    optimizeDeps: { include: ["react-dom/client"] },
    define: {
      __P8_CHART_BENCHMARK__: JSON.stringify({
        renderer,
        repetitions,
        warmups,
        updates,
        dpr,
        reportPath,
        diagnostics: {
          runMode: profileEnabled ? "diagnostic" : "measurement",
          stageLogging: true,
          profileEnabled,
          profileDurationMs,
          profilePath: profileEnabled ? profilePath : null,
        },
        packages,
        source: {
          revision: git("rev-parse", "HEAD"),
          sourceSha256: hashFiles(sourceFiles),
          harnessSha256: hashFiles(harnessFiles),
          lockSha256: hashFiles(["../package-lock.json"]),
          dirty: git("status", "--porcelain").length > 0,
        },
        host: { hostname: hostname(), platform: platform(), arch: arch(), node: process.version },
      }),
    },
    test: {
      include: ["src/components/market-detail/__tests__/PriceChart.benchmark.ts"],
      fileParallelism: false,
      testTimeout: 600_000,
      browser: {
        commands: {
          recordChartStage: defineBrowserCommand(async (_context, message: string) => {
            if (message.length > 300) throw new Error("Chart stage is too long");
            console.log(`[p8-chart] ${message}`);
            await writeFile(
              `${reportPath}.stage.json`,
              JSON.stringify({ message, at: new Date().toISOString() }),
              { encoding: "utf8", mode: 0o600 },
            );
          }),
          startChartProfile: defineBrowserCommand(async ({ context, page }) => {
            if (!profileEnabled || profileFinished) return;
            const session = await context.newCDPSession(page);
            try {
              await session.send("Profiler.enable");
              await session.send("Profiler.setSamplingInterval", { interval: 1_000 });
              await session.send("Profiler.start");
            } catch (error) {
              await session.detach();
              throw error;
            }
            console.log(`[p8-chart] CPU profile started (${profileDurationMs}ms)`);
            // The runner owns this timer. A blocked browser event loop cannot
            // prevent the runner from requesting and saving the profile.
            profileFinished = new Promise((resolveProfile) => {
              setTimeout(async () => {
                let failure: string | null = null;
                try {
                  const { profile } = await session.send("Profiler.stop");
                  await mkdir(dirname(profilePath), { recursive: true });
                  await writeFile(profilePath, JSON.stringify(profile), {
                    encoding: "utf8",
                    mode: 0o600,
                  });
                  console.log(`[p8-chart] CPU profile saved: ${profilePath}`);
                } catch (error) {
                  failure = error instanceof Error ? error.message : String(error);
                  console.error(`[p8-chart] CPU profile failed: ${failure}`);
                } finally {
                  await session.detach().catch(() => undefined);
                  resolveProfile(failure);
                }
              }, profileDurationMs);
            });
          }),
          finishChartProfile: defineBrowserCommand(async () => {
            const failure = await profileFinished;
            if (failure) throw new Error(`Chart CPU profile failed: ${failure}`);
          }),
          writeChartReport: defineBrowserCommand(async (_context, payload: string) => {
            if (payload.length > 5_000_000)
              throw new Error("Chart report exceeds the bounded report size");
            await mkdir(dirname(reportPath), { recursive: true });
            await writeFile(reportPath, payload, { encoding: "utf8", mode: 0o600 });
          }),
        },
        enabled: true,
        headless: true,
        provider: playwright({
          contextOptions: { locale: "en-US", timezoneId: "UTC", deviceScaleFactor: dpr },
        }),
        instances: [{ browser: "chromium" }],
        viewport: { width: 1280, height: 900 },
      },
    },
  }),
);
