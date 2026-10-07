import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { cdp, commands, page } from "vitest/browser";
import type {} from "@vitest/browser-playwright";
import "@/index.css";
import i18n from "@/i18n";
import { PriceChart } from "../PriceChart";
import {
  appendFixture,
  makeFixture,
  rollingFixture,
  WORKLOADS,
  type Fixture,
  type Workload,
} from "./priceChartBenchmarkFixtures";

// The only stub is optional external profile enrichment. Rendering, scales,
// ResizeObserver, clocks, browser layout, and clipboard/events are real.
vi.mock("@/lib/nostr", () => ({ fetchPublicNostrProfile: vi.fn(async () => null) }));

declare const __P8_CHART_BENCHMARK__: {
  renderer: "uplot" | "recharts";
  repetitions: number;
  warmups: number;
  updates: number;
  dpr: number;
  reportPath: string;
  diagnostics: {
    runMode: "diagnostic" | "measurement";
    stageLogging: boolean;
    profileEnabled: boolean;
    profileDurationMs: number;
    profilePath: string | null;
  };
  packages: Record<string, string>;
  source: {
    revision: string;
    sourceSha256: string;
    harnessSha256: string;
    lockSha256: string;
    dirty: boolean;
  };
  host: { hostname: string; platform: string; arch: string; node: string };
};
declare module "vitest/browser" {
  interface BrowserCommands {
    writeChartReport: (payload: string) => Promise<void>;
    recordChartStage: (message: string) => Promise<void>;
    startChartProfile: () => Promise<void>;
    finishChartProfile: () => Promise<void>;
  }
}
const options = __P8_CHART_BENCHMARK__;
async function stage(message: string) {
  if (options.diagnostics.stageLogging) await commands.recordChartStage(message);
}
console.log(`[p8-chart] module loaded; mode=${options.diagnostics.runMode}`);
const markerSelector = '[data-testid="price-chart-comment-marker"]';
const cardSelector = '[data-testid="price-chart-comment-popover"]';
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

type Rectangle = { left: number; top: number; width: number; height: number };
type Geometry = {
  phase: string;
  expected: { x: number; y: number };
  actual: { x: number; y: number };
  errorCssPixels: number;
};
type MemorySample = {
  heap: Awaited<ReturnType<typeof heapUsage>>;
  dom: Awaited<ReturnType<typeof domCounters>>;
};
type Sample = {
  mountMs: number;
  openMs: number;
  appendMs: number[];
  rollingMs: number;
  resizeMs: number;
  memory: {
    before: MemorySample;
    mounted: MemorySample;
    updated: MemorySample;
    unmounted: MemorySample;
  };
  geometry: Geometry[];
};
const heapUsage = () => cdp().send("Runtime.getHeapUsage");
const domCounters = () => cdp().send("Memory.getDOMCounters");
async function memory(): Promise<MemorySample> {
  await cdp().send("HeapProfiler.collectGarbage");
  return { heap: await heapUsage(), dom: await domCounters() };
}
function svgRectangle(rect: SVGRectElement): Rectangle {
  const matrix = rect.getScreenCTM();
  if (!matrix) throw new Error("SVG plot rectangle has no screen transform");
  const box = rect.getBBox();
  const a = new DOMPoint(box.x, box.y).matrixTransform(matrix);
  const b = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
  return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
}
function plotRectangle(host: HTMLElement): Rectangle | null {
  if (options.renderer === "uplot") {
    const over = host.querySelector<HTMLElement>(".u-over");
    return over?.getBoundingClientRect() ?? null;
  }
  // Renderer adapter only: read the rendered clipping rectangle, never a
  // production scale hook or separately exported anchor/layout coordinates.
  const rect = host.querySelector<SVGRectElement>(".recharts-surface clipPath rect");
  return rect ? svgRectangle(rect) : null;
}
function observeRendererDraws(host: HTMLElement, fixture: Fixture) {
  let revision = 0;
  // Instrument real output without replacing renderer behavior or reading every
  // point. Only line-colored strokes in this test's canvas count as a draw.
  const colors = new Set(
    fixture.props.outcomes?.map((outcome) => outcome.color?.toLowerCase()) ?? ["#3b82f6"],
  );
  const original = CanvasRenderingContext2D.prototype.stroke;
  const observedStroke: typeof original = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    Reflect.apply(original, this, args);
    if (
      host.contains(this.canvas) &&
      typeof this.strokeStyle === "string" &&
      colors.has(this.strokeStyle.toLowerCase())
    )
      revision++;
  };
  if (options.renderer === "uplot") CanvasRenderingContext2D.prototype.stroke = observedStroke;
  const observer = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type === "attributes" &&
          record.attributeName === "d" &&
          record.target instanceof SVGPathElement &&
          record.target.classList.contains("recharts-line-curve"),
      )
    )
      revision++;
    if (
      records.some(
        (record) =>
          record.type === "childList" &&
          [...record.addedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(".recharts-line-curve[d]") ||
                node.querySelector(".recharts-line-curve[d]")),
          ),
      )
    )
      revision++;
  });
  if (options.renderer === "recharts")
    observer.observe(host, {
      subtree: true,
      attributes: true,
      attributeFilter: ["d"],
      childList: true,
    });
  return {
    revision: () => revision,
    close: () => {
      observer.disconnect();
      if (options.renderer === "uplot") CanvasRenderingContext2D.prototype.stroke = original;
    },
  };
}
type DrawObserver = ReturnType<typeof observeRendererDraws>;
async function ready(
  host: HTMLElement,
  draws: DrawObserver,
  cardOpen = false,
  afterRevision?: number,
  committed: () => boolean = () => true,
) {
  const deadline = performance.now() + 15_000;
  let previous = "";
  let stableFrames = 0;
  while (performance.now() < deadline) {
    await nextFrame();
    const box = plotRectangle(host);
    const markers = [...host.querySelectorAll<HTMLButtonElement>(markerSelector)];
    const tails = [
      ...host.querySelectorAll<SVGPathElement>('[data-testid="price-chart-comment-tail"]'),
    ];
    const signature = box
      ? [box.left, box.top, box.width, box.height, draws.revision()].join(":")
      : "";
    const valid =
      committed() &&
      box &&
      box.width > 0 &&
      box.height > 0 &&
      (afterRevision === undefined || draws.revision() > afterRevision) &&
      markers.length === 40 &&
      tails.length === 40 &&
      markers.every((marker) => marker.getBoundingClientRect().width > 0) &&
      tails.every((tail) => !/NaN|Infinity/.test(tail.getAttribute("d") ?? "NaN")) &&
      (!cardOpen || host.querySelector(cardSelector));
    stableFrames = valid && signature === previous ? stableFrames + 1 : 0;
    previous = signature;
    if (stableFrames >= 2) return;
  }
  throw new Error(
    `${options.renderer} readiness failed: draws=${draws.revision()}, requiredAfter=${afterRevision}, markers=${host.querySelectorAll(markerSelector).length}, card=${Boolean(host.querySelector(cardSelector))}`,
  );
}
function geometry(host: HTMLElement, fixture: Fixture, phase: string): Geometry {
  const box = plotRectangle(host);
  const tip = host.querySelector<SVGPathElement>('[data-testid="price-chart-comment-panel-tail"]');
  if (!box || !tip) throw new Error("Open-card plot geometry is unavailable");
  const matrix = tip.getScreenCTM();
  if (!matrix) throw new Error("Visible pointer has no screen transform");
  const actual = tip.getPointAtLength(0).matrixTransform(matrix);
  const histories = fixture.props.outcomePriceHistories
    ? Object.values(fixture.props.outcomePriceHistories)
    : [fixture.props.priceHistory];
  let min = Infinity;
  let max = -Infinity;
  if (fixture.props.chartTimeframe === "all") {
    // Independent fixture arithmetic. Do not import production window/scale helpers.
    for (const h of histories)
      for (const p of h.data) {
        const time = Date.parse(p.timestamp);
        min = Math.min(min, time);
        max = Math.max(max, time);
      }
  } else {
    const h = fixture.props.priceHistory;
    max = Date.parse(h.asOf!) + Math.floor(Math.max(0, performance.now() - h.receivedAt!));
    min = max - 3_600_000;
  }
  const expected = {
    x: box.left + ((fixture.anchor.timestamp - min) / (max - min)) * box.width,
    y: box.top + (1 - fixture.anchor.price / 100) * box.height,
  };
  return {
    phase,
    expected,
    actual: { x: actual.x, y: actual.y },
    errorCssPixels: Math.hypot(actual.x - expected.x, actual.y - expected.y),
  };
}
function ChartFixture({ fixture, onCommit }: { fixture: Fixture; onCommit: () => void }) {
  useEffect(onCommit, [fixture, onCommit]);
  return createElement(PriceChart, fixture.props);
}
async function render(
  root: Root,
  host: HTMLElement,
  fixture: Fixture,
  draws: DrawObserver,
  cardOpen = false,
) {
  const revision = draws.revision();
  const start = performance.now();
  let committed = false;
  root.render(
    createElement(ChartFixture, {
      fixture,
      onCommit: () => {
        committed = true;
      },
    }),
  );
  await ready(host, draws, cardOpen, revision, () => committed);
  return performance.now() - start;
}
async function sample(workload: Workload): Promise<Sample> {
  let fixture = makeFixture(workload);
  const host = document.createElement("div");
  host.style.width = "1000px";
  document.body.append(host);
  let root: Root | undefined;
  const draws = observeRendererDraws(host, fixture);
  try {
    await stage(`${workload.name}: before baseline GC`);
    const before = await memory();
    await stage(`${workload.name}: after baseline GC; before mount`);
    root = createRoot(host);
    const mountMs = await render(root, host, fixture, draws);
    await stage(`${workload.name}: after mount; before open`);
    const opened = performance.now();
    const marker = host.querySelector<HTMLButtonElement>(markerSelector);
    if (!marker) throw new Error("First comment marker is absent");
    marker.click();
    await ready(host, draws, true);
    const openMs = performance.now() - opened;
    await stage(`${workload.name}: after open`);
    // Fixture comment0 is the earliest group; confirm identity before measuring.
    expect(host.querySelector(cardSelector)?.textContent).toContain("Benchmark comment 0.");
    const checks = [geometry(host, fixture, "mounted-open")];
    await stage(`${workload.name}: before mounted GC`);
    const mounted = await memory();
    await stage(`${workload.name}: after mounted GC`);
    const appendMs: number[] = [];
    for (let update = 0; update < options.updates; update++) {
      fixture = appendFixture(fixture);
      await stage(`${workload.name}: before append ${update + 1}`);
      appendMs.push(await render(root, host, fixture, draws, true));
      await stage(`${workload.name}: after append ${update + 1}`);
      checks.push(geometry(host, fixture, `append-${update + 1}`));
    }
    await stage(`${workload.name}: before rolling setup`);
    fixture = rollingFixture(fixture, 0);
    await render(root, host, fixture, draws, true); // Timeframe switch is not the rolling-update sample.
    await stage(`${workload.name}: after rolling setup; before rolling update`);
    fixture = rollingFixture(fixture, 15);
    const rollingMs = await render(root, host, fixture, draws, true);
    await stage(`${workload.name}: after rolling update`);
    checks.push(geometry(host, fixture, "rolling-expiry"));
    await stage(`${workload.name}: before resize`);
    const resizeRevision = draws.revision();
    const resizing = performance.now();
    host.style.width = "640px";
    await ready(host, draws, true, resizeRevision);
    const resizeMs = performance.now() - resizing;
    await stage(`${workload.name}: after resize`);
    checks.push(geometry(host, fixture, "resize"));
    await stage(`${workload.name}: before updated GC`);
    const updated = await memory();
    await stage(`${workload.name}: after updated GC; before unmount`);
    root.unmount();
    root = undefined;
    host.remove();
    await nextFrame();
    await nextFrame();
    await stage(`${workload.name}: after unmount; before unmounted GC`);
    const unmounted = await memory();
    await stage(`${workload.name}: after unmounted GC`);
    return {
      mountMs,
      openMs,
      appendMs,
      rollingMs,
      resizeMs,
      memory: { before, mounted, updated, unmounted },
      geometry: checks,
    };
  } finally {
    root?.unmount();
    draws.close();
    host.remove();
  }
}
function statistics(raw: number[]) {
  const sorted = [...raw].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    raw,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
function summarize(samples: Sample[]) {
  return {
    mountMs: statistics(samples.map((s) => s.mountMs)),
    openMs: statistics(samples.map((s) => s.openMs)),
    appendMs: statistics(samples.flatMap((s) => s.appendMs)),
    rollingMs: statistics(samples.map((s) => s.rollingMs)),
    resizeMs: statistics(samples.map((s) => s.resizeMs)),
  };
}

it("records the real chart renderer on fixed P8 workloads", async () => {
  await stage("test entered; before language/viewport/fonts setup");
  await i18n.changeLanguage("en");
  await page.viewport(1280, 900);
  await document.fonts.ready;
  expect(devicePixelRatio).toBe(options.dpr);
  const rows: { workload: Workload; samples: Sample[] }[] = [];
  let currentWorkload: string | null = null;
  await stage("setup complete; before browser metadata");
  const browser = await cdp().send("Browser.getVersion");
  await stage("browser metadata complete");
  const startedAt = new Date().toISOString();
  let failure: string | null = null;
  try {
    await commands.startChartProfile();
    for (const workload of WORKLOADS) {
      currentWorkload = workload.name;
      for (let warmup = 0; warmup < options.warmups; warmup++) {
        await stage(`${workload.name}: warmup ${warmup + 1}/${options.warmups}`);
        await sample(workload);
      }
      const samples: Sample[] = [];
      rows.push({ workload, samples });
      for (let repetition = 0; repetition < options.repetitions; repetition++) {
        await stage(`${workload.name}: repetition ${repetition + 1}/${options.repetitions}`);
        samples.push(await sample(workload));
      }
      currentWorkload = null;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await stage("writing report");
    await commands.writeChartReport(
      JSON.stringify(
        {
          schemaVersion: 1,
          options,
          browser,
          startedAt,
          finishedAt: new Date().toISOString(),
          failure,
          currentWorkload,
          notes: [
            "Component render under Vite/Vitest; production route bundle sizes are separate evidence.",
            "Heap/DOM counts include the runner isolate. They are not total renderer/GPU memory.",
            "Input fixtures are allocated before baseline memory sampling; no forced GC occurs inside timed actions.",
            "The uPlot baseline records alignment errors. Recharts must pass the independent geometry check.",
          ],
          rows: rows.map((row) => ({
            ...row,
            timings: row.samples.length ? summarize(row.samples) : null,
            geometryWithinOneCssPixel:
              row.samples.length > 0 &&
              row.samples.every((sample) =>
                sample.geometry.every((check) => check.errorCssPixels <= 1),
              ),
          })),
        },
        null,
        2,
      ),
    );
    await commands.finishChartProfile();
  }
  await stage("test complete");
  if (options.renderer === "recharts") {
    for (const row of rows)
      for (const measurement of row.samples)
        for (const check of measurement.geometry) {
          expect(check.errorCssPixels, `${row.workload.name}: ${check.phase}`).toBeLessThanOrEqual(
            1,
          );
        }
  }
});
