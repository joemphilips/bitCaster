import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
declare module "vitest/browser" {
  interface BrowserCommands {
    setChartReducedMotion: (preference: "reduce" | "no-preference") => Promise<void>;
  }
}
import "@/index.css";
import i18n from "@/i18n";
import { PriceChart } from "../PriceChart";
import {
  installCanvasObserver,
  type CanvasObserver,
  type CanvasDraw,
} from "./priceChartCanvasObserver";
import {
  appendFixture,
  makeFixture,
  rollingFixture,
  type Fixture,
} from "./priceChartBenchmarkFixtures";

vi.mock("@/lib/nostr", () => ({ fetchPublicNostrProfile: vi.fn(async () => null) }));
let observer: CanvasObserver | undefined;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function RenderFixture({ fixture, committed }: { fixture: Fixture; committed: () => void }) {
  useEffect(committed, [fixture, committed]);
  return createElement(PriceChart, fixture.props);
}
async function renderFixture(fixture: Fixture, expectedMarkers = 10) {
  if (!host) {
    host = document.createElement("div");
    host.style.width = "1000px";
    document.body.append(host);
    observer = installCanvasObserver(host, {
      colors: fixture.props.outcomes?.map((outcome) => outcome.color!) ?? ["#3b82f6"],
    });
    root = createRoot(host);
  }
  let committed = false;
  root!.render(
    createElement(RenderFixture, {
      fixture,
      committed: () => {
        committed = true;
      },
    }),
  );
  await expect.poll(() => committed).toBe(true);
  await expect
    .poll(() => host!.querySelectorAll('[data-testid="price-chart-comment-marker"]').length)
    .toBe(expectedMarkers);
  await expect
    .poll(() =>
      [...host!.querySelectorAll<HTMLElement>('[data-testid="price-chart-comment-marker"]')].every(
        (marker) =>
          marker.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
          Boolean(
            marker
              .closest('[data-testid="price-chart-comment-bubble"]')
              ?.querySelector('[data-testid="price-chart-comment-popover"]')
              ?.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          ),
      ),
    )
    .toBe(true);
  await frame();
  await frame();
}
afterEach(async () => {
  root?.unmount();
  root = undefined;
  host?.remove();
  host = undefined;
  observer?.restore();
  observer = undefined;
  await i18n.changeLanguage("en");
  await commands.setChartReducedMotion("no-preference");
});

it.each([
  { language: "en", width: 1000 },
  { language: "ja", width: 390 },
])("keeps chart controls stationary during $language refreshes", async ({ language, width }) => {
  await page.viewport(width + 40, 900);
  await i18n.changeLanguage(language);
  const fixture = makeFixture({
    name: "refresh",
    outcomes: 2,
    binary: true,
    pointsPerOutcome: 300,
  });
  fixture.props.comments = [];
  await renderFixture(fixture, 0);
  host!.style.width = `${width}px`;
  await expect.poll(() => observer!.snapshot().plot?.width ?? Infinity).toBeLessThan(width);
  await frame();
  await frame();
  const bounds = () => {
    const elements = [
      host!,
      host!.querySelector("canvas")!,
      host!.querySelector('[data-testid="latest-price-pills"]')!,
      host!.querySelector("button")!,
    ];
    return elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
  };
  const readyBounds = bounds();
  for (const historyStatus of ["ready", "refreshing", "unavailable", "ready"] as const) {
    await renderFixture({ ...fixture, props: { ...fixture.props, historyStatus } }, 0);
    expect(bounds()).toEqual(readyBounds);
    const status = host!.querySelector('[role="status"]');
    if (historyStatus === "ready") expect(status).toBeNull();
    else
      expect(status?.textContent).toBe(
        i18n.t(
          historyStatus === "refreshing"
            ? "market.priceHistoryUpdating"
            : "market.priceRefreshUnavailable",
        ),
      );
    const captureDirectory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (captureDirectory) {
      await page.screenshot({
        path: `${captureDirectory}/${language}-${historyStatus}.png`,
        element: host!,
      });
    }
  }
  await page.viewport(1280, 900);
});
function plotRectangle() {
  const observation = observer!.snapshot();
  if (!observation.plot) throw new Error("The real chart plot clipping rectangle is absent");
  for (const draw of observation.draws) expect(draw.clip).toEqual(observation.plot);
  return observation.plot;
}
function currentLines() {
  return observer!
    .snapshot()
    .draws.filter(
      (draw) => draw.method === "stroke" && draw.commands.some((point) => point.type === "L"),
    );
}
function expectedPointer(fixture: Fixture) {
  const rect = plotRectangle();
  const histories = fixture.props.outcomePriceHistories
    ? Object.values(fixture.props.outcomePriceHistories)
    : [fixture.props.priceHistory];
  let min = Infinity;
  let max = -Infinity;
  if (fixture.props.chartTimeframe === "all") {
    for (const history of histories)
      for (const point of history.data) {
        min = Math.min(min, Date.parse(point.timestamp));
        max = Math.max(max, Date.parse(point.timestamp));
      }
  } else {
    const history = fixture.props.priceHistory;
    max =
      Date.parse(history.asOf!) + Math.floor(Math.max(0, performance.now() - history.receivedAt!));
    min = max - 3_600_000;
  }
  if (min === max) {
    min -= 3_600_000;
    max += 3_600_000;
  }
  return {
    x: rect.left + ((fixture.anchor.timestamp - min) / (max - min)) * rect.width,
    y: rect.top + (1 - fixture.anchor.price / 100) * rect.height,
  };
}
function pointerError(fixture: Fixture) {
  const tail = host!.querySelector<SVGPathElement>(
    '[data-testid="price-chart-comment-panel-tail"]',
  );
  const card = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-popover"]');
  if (
    !card?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
    !tail?.getScreenCTM()
  )
    return Infinity;
  // SVG graphics do not consistently expose a CSS box to checkVisibility.
  // Check their actual ancestor visibility while keeping the SVG geometry oracle.
  for (let element: Element | null = tail; element; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (Number(style.opacity) === 0 || style.visibility !== "visible" || style.display === "none")
      return Infinity;
  }
  const actual = tail.getPointAtLength(0).matrixTransform(tail.getScreenCTM()!);
  const expected = expectedPointer(fixture);
  return Math.hypot(actual.x - expected.x, actual.y - expected.y);
}
function lineVertices(line: CanvasDraw) {
  expect(line.commands.every((command) => command.type === "M" || command.type === "L")).toBe(true);
  return line.commands;
}
function expectBlueInkAt(point: { x: number; y: number }) {
  const canvas = host!.querySelector<HTMLCanvasElement>('[data-testid="price-chart-canvas"]')!;
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width,
    sy = canvas.height / rect.height;
  const left = Math.max(0, Math.floor((point.x - rect.left - 2) * sx));
  const top = Math.max(0, Math.floor((point.y - rect.top - 2) * sy));
  const pixels = canvas
    .getContext("2d")!
    .getImageData(left, top, Math.ceil(4 * sx), Math.ceil(4 * sy)).data;
  let hasInk = false;
  for (let index = 0; index < pixels.length; index += 4) {
    if (
      pixels[index + 3] > 0 &&
      pixels[index + 2] - pixels[index + 1] > 50 &&
      pixels[index + 2] - pixels[index] > 80
    )
      hasInk = true;
  }
  expect(hasInk).toBe(true);
}
function stepLineDistance(expected: { x: number; y: number }, line: CanvasDraw) {
  const points = lineVertices(line);
  let distance = Infinity;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const fraction = Math.max(
      0,
      Math.min(1, ((expected.x - a.x) * dx + (expected.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    distance = Math.min(
      distance,
      Math.hypot(expected.x - a.x - fraction * dx, expected.y - a.y - fraction * dy),
    );
  }
  return distance;
}
async function assertPointerAndStep(fixture: Fixture, lineIndex = 0) {
  await expect.poll(() => pointerError(fixture)).toBeLessThanOrEqual(1);
  const lines = currentLines();
  const expectedColors = fixture.props.outcomes?.map((outcome) => outcome.color!.toLowerCase()) ?? [
    "#3b82f6",
  ];
  expect([...new Set(lines.map((line) => line.color))].sort()).toEqual(expectedColors.sort());
  const color = fixture.props.outcomes?.[lineIndex].color?.toLowerCase() ?? "#3b82f6";
  const matching = lines.filter((line) => line.color === color);
  expect(matching.length).toBeGreaterThan(0);
  expect(
    Math.min(...matching.map((line) => stepLineDistance(expectedPointer(fixture), line))),
  ).toBeLessThanOrEqual(1);
}

it.each([
  { name: "binary", outcomes: 2, binary: true },
  { name: "categorical-two", outcomes: 2, binary: false },
  { name: "categorical-eight", outcomes: 8, binary: false },
])(
  "keeps the real $name comment pointer on its step line through live changes",
  async (workload) => {
    await i18n.changeLanguage("en");
    let fixture = makeFixture({ ...workload, pointsPerOutcome: 300 });
    await renderFixture(fixture);
    host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
    await assertPointerAndStep(fixture);
    fixture = appendFixture(fixture);
    await renderFixture(fixture);
    await assertPointerAndStep(fixture);
    fixture = rollingFixture(fixture, 0);
    await renderFixture(fixture);
    await assertPointerAndStep(fixture);
    fixture = rollingFixture(fixture, 15);
    await renderFixture(fixture);
    await assertPointerAndStep(fixture);
    const oldWidth = plotRectangle().width;
    host!.style.width = "640px";
    await expect.poll(() => plotRectangle().width).toBeLessThan(oldWidth);
    await assertPointerAndStep(fixture);
    expect(
      host!.querySelector('[data-testid="price-chart-comment-popover"]')?.textContent,
    ).toContain("Benchmark comment 30.");
  },
);

it("anchors a binary NO fill at its exact YES-complement price", async () => {
  const fixture = makeFixture({
    name: "binary-complement",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const trade = fixture.props.comments![31].trade!;
  fixture.anchor = {
    timestamp: Date.parse(trade.executedAt),
    price: 100 - (trade.price / trade.priceDenominator) * 100,
  };
  await renderFixture(fixture);
  host!
    .querySelectorAll<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')[1]
    .click();
  await assertPointerAndStep(fixture);
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')?.textContent).toContain(
    "Benchmark comment 31.",
  );
});

it("retains distinct confirmed fills at the same millisecond on the step line", async () => {
  const fixture = makeFixture({
    name: "same-time",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const timestamp = new Date(fixture.anchor.timestamp).toISOString();
  const original = fixture.props.priceHistory.data.find((point) => point.timestamp === timestamp)!;
  fixture.props.priceHistory = {
    ...fixture.props.priceHistory,
    data: fixture.props.priceHistory.data.flatMap((point) =>
      point === original
        ? [point, { ...point, price: 90, eventOrder: `${point.eventOrder}-second` }]
        : [point],
    ),
  };
  fixture.props.comments = fixture.props.comments!.map((comment, index) =>
    index === 31
      ? {
          ...comment,
          trade: { ...comment.trade!, executedAt: timestamp, outcomeId: "yes", price: 90 },
        }
      : comment,
  );
  await renderFixture(fixture);
  const markers = host!.querySelectorAll<HTMLButtonElement>(
    '[data-testid="price-chart-comment-marker"]',
  );
  const vertices = currentLines().flatMap(lineVertices);
  const first = expectedPointer(fixture);
  const second = expectedPointer({ ...fixture, anchor: { ...fixture.anchor, price: 90 } });
  for (const expected of [first, second]) {
    expect(
      Math.min(...vertices.map((point) => Math.hypot(point.x - expected.x, point.y - expected.y))),
    ).toBeLessThanOrEqual(0.1);
  }
  markers[0].click();
  await assertPointerAndStep(fixture);
  markers[1].click();
  fixture.anchor = { timestamp: fixture.anchor.timestamp, price: 90 };
  await assertPointerAndStep(fixture);
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')?.textContent).toContain(
    "Benchmark comment 31.",
  );
});

it("closes the card when its source leaves the range and does not reopen it on return", async () => {
  const fixture = makeFixture({
    name: "range-expiry",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  await renderFixture(fixture);
  host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
  await assertPointerAndStep(fixture);
  await renderFixture(rollingFixture(fixture, 75), 0);
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBeNull();
  await renderFixture(fixture);
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBeNull();
});

it("removes an expired point and its open card through real browser frames", async () => {
  const fixture = makeFixture({
    name: "paint-expiry",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const point = fixture.props.priceHistory.data.find(
    (item) => Date.parse(item.timestamp) === fixture.anchor.timestamp,
  )!;
  const receivedAt = performance.now();
  fixture.props.priceHistory = {
    timeframe: "1h",
    data: [point],
    asOf: new Date(fixture.anchor.timestamp + 3_600_000 - 2_000).toISOString(),
    receivedAt,
  };
  fixture.props.chartTimeframe = "1h";
  fixture.props.comments = [fixture.props.comments![30]];
  await renderFixture(fixture, 1);
  host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
  await expect
    .poll(() => !!host!.querySelector('[data-testid="price-chart-comment-popover"]'))
    .toBe(true);
  const expiresAt = receivedAt + 2_001;
  let dueFrames = 0;
  while (performance.now() < expiresAt + 5_000) {
    await frame();
    const now = performance.now();
    if (now >= expiresAt) dueFrames++;
    if (host!.querySelector('[data-testid="price-chart-empty-state"]')) {
      expect(now).toBeGreaterThanOrEqual(expiresAt);
      expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBeNull();
      expect(observer!.snapshot().draws).toHaveLength(0);
      expect(host!.querySelector('[data-testid="price-chart-canvas"]')).toBeNull();
      // Observe the committed DOM across actual animation frames. This permits
      // React's deferred commit, but not repeated paints of expired data.
      expect(dueFrames).toBeLessThanOrEqual(3);
      return;
    }
  }
  throw new Error("The expired price and card did not leave the rendered chart");
});

it.each(["rise", "fall", "duplicate-run"] as const)(
  "paints every native step through a %s piece seam and removes obsolete pieces",
  async (shape) => {
    const fixture = makeFixture({
      name: `seam-${shape}`,
      binary: true,
      outcomes: 2,
      pointsPerOutcome: 300,
    });
    const start = Date.parse("2026-05-25T10:00:00Z");
    const data = Array.from({ length: 520 }, (_, index) => {
      const duplicate = shape === "duplicate-run" && index >= 250 && index <= 512;
      const offset =
        shape === "duplicate-run" && index > 512
          ? 500 + (index - 512) * 2
          : duplicate
            ? 500
            : index * 2;
      const price =
        shape === "duplicate-run"
          ? index === 511
            ? 90
            : index === 512
              ? 10
              : 40
          : shape === "rise"
            ? index < 255
              ? 20
              : 80
            : index < 255
              ? 80
              : 20;
      return {
        eventOrder: String(index).padStart(4, "0"),
        timestamp: new Date(start + offset).toISOString(),
        price,
      };
    });
    fixture.props.priceHistory = { timeframe: "all", data };
    fixture.props.comments = [];
    await renderFixture(fixture, 0);
    const projected = data.map((point) =>
      expectedPointer({
        ...fixture,
        anchor: { timestamp: Date.parse(point.timestamp), price: point.price },
      }),
    );
    const expected = [projected[0]];
    for (let index = 1; index < projected.length; index++) {
      expected.push({ x: projected[index].x, y: projected[index - 1].y }, projected[index]);
    }
    const same = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y) <= 0.01;
    const lines = currentLines();
    expect(lines.length).toBeGreaterThan(1);
    // Pieces can overlap, but each complete native command stream must be an
    // ordered contiguous slice of independently projected confirmed steps.
    for (const line of lines) {
      const vertices = lineVertices(line);
      expect(
        expected.some(
          (point, startIndex) =>
            same(point, vertices[0]) &&
            vertices.every(
              (vertex, offset) =>
                expected[startIndex + offset] && same(vertex, expected[startIndex + offset]),
            ),
        ),
      ).toBe(true);
    }
    expectBlueInkAt(projected[255]);
    expectBlueInkAt(projected[256]);
    const vertices = lines.flatMap(lineVertices);
    expect(vertices.length).toBeGreaterThanOrEqual(expected.length);
    for (const point of expected) expect(vertices.some((vertex) => same(vertex, point))).toBe(true);
    fixture.props.priceHistory = { timeframe: "all", data: data.slice(0, 20) };
    await renderFixture(fixture, 0);
    expect(currentLines()).toHaveLength(1);
    expect(currentLines()[0].commands).toHaveLength(39);
  },
);

it("paints one native marker for a coincident run and clears it on replacement", async () => {
  const fixture = makeFixture({
    name: "coincident",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const timestamp = "2026-05-25T10:00:00.123Z";
  fixture.props.priceHistory = {
    timeframe: "all",
    data: Array.from({ length: 600 }, (_, index) => ({
      eventOrder: String(index),
      timestamp,
      price: 45,
    })),
  };
  fixture.props.comments = [];
  fixture.anchor = { timestamp: Date.parse(timestamp), price: 45 };
  await renderFixture(fixture, 0);
  const points = observer!
    .snapshot()
    .draws.filter((draw) => draw.method === "fill")
    .flatMap((draw) => draw.commands.filter((command) => command.type === "A"));
  expect(points).toHaveLength(1);
  const expected = expectedPointer(fixture);
  expect(Math.hypot(points[0].x - expected.x, points[0].y - expected.y)).toBeLessThanOrEqual(0.01);
  expect(points[0].r).toBeGreaterThan(0);
  expectBlueInkAt(expected);
  fixture.props.priceHistory = { timeframe: "all", data: [] };
  await renderFixture(fixture, 0);
  expect(observer!.snapshot().draws).toHaveLength(0);
  expect(host!.querySelector('[data-testid="price-chart-empty-state"]')).not.toBeNull();
});

function assertCurrentExtensions(fixture: Fixture) {
  const plot = plotRectangle();
  const series = fixture.props.outcomes
    ? fixture.props.outcomes.map((outcome) => ({
        id: outcome.id,
        data: fixture.props.outcomePriceHistories![outcome.label]?.data ?? [],
      }))
    : [{ id: "primary", data: fixture.props.priceHistory.data }];
  const populated = series.filter((item) => item.data.length > 0);
  const lines = [
    ...host!.querySelectorAll<SVGLineElement>('[data-testid="price-chart-current-extension"]'),
  ];
  const endpoints = [
    ...host!.querySelectorAll<SVGCircleElement>('[data-testid="price-chart-current-endpoint"]'),
  ];
  expect(lines).toHaveLength(populated.length);
  expect(endpoints).toHaveLength(populated.length);
  for (const item of populated) {
    const last = item.data[item.data.length - 1];
    const expected = expectedPointer({
      ...fixture,
      anchor: { timestamp: Date.parse(last.timestamp), price: last.price },
    });
    const line = lines.find((node) => node.dataset.seriesId === item.id)!;
    const endpoint = endpoints.find((node) => node.dataset.seriesId === item.id)!;
    const first = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(
      line.getScreenCTM()!,
    );
    const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(
      line.getScreenCTM()!,
    );
    const tip = new DOMPoint(endpoint.cx.baseVal.value, endpoint.cy.baseVal.value).matrixTransform(
      endpoint.getScreenCTM()!,
    );
    expect(Math.hypot(first.x - expected.x, first.y - expected.y)).toBeLessThanOrEqual(1);
    expect(Math.hypot(end.x - (plot.left + plot.width), end.y - expected.y)).toBeLessThanOrEqual(1);
    expect(Math.hypot(tip.x - end.x, tip.y - end.y)).toBeLessThanOrEqual(0.01);
  }
}

it.each([true, false])(
  "keeps presentation endpoints on confirmed prices through append and resize (binary=%s)",
  async (binary) => {
    let fixture = makeFixture({ name: "current-tip", binary, outcomes: 2, pointsPerOutcome: 300 });
    fixture.props.comments = [];
    await renderFixture(fixture, 0);
    assertCurrentExtensions(fixture);
    fixture = appendFixture(fixture);
    fixture.props.comments = [];
    await renderFixture(fixture, 0);
    assertCurrentExtensions(fixture);
    fixture = rollingFixture(fixture, 15);
    fixture.props.comments = [];
    await renderFixture(fixture, 0);
    assertCurrentExtensions(fixture);
    const oldWidth = plotRectangle().width;
    host!.style.width = "320px";
    await expect.poll(() => plotRectangle().width).toBeLessThan(oldWidth);
    assertCurrentExtensions(fixture);
  },
);

function edgeFixture(edge: "left" | "right") {
  const fixture = makeFixture({
    name: `expansion-${edge}`,
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const data = [
    { eventOrder: "first", timestamp: "2026-05-25T10:00:00.000Z", price: 1 },
    { eventOrder: "last", timestamp: "2026-05-25T11:00:00.000Z", price: 99 },
  ];
  const point = data[edge === "left" ? 0 : 1];
  fixture.props.priceHistory = { timeframe: "all", data };
  fixture.props.comments = [
    {
      ...fixture.props.comments![0],
      timestamp: point.timestamp,
      trade: {
        ...fixture.props.comments![0].trade!,
        outcomeId: "yes",
        executedAt: point.timestamp,
        price: point.price,
      },
    },
  ];
  fixture.anchor = { timestamp: Date.parse(point.timestamp), price: point.price };
  return fixture;
}

it.each([
  { language: "en", width: 1000 },
  { language: "ja", width: 390 },
])("shows ten selected previews in a $language $width-pixel chart", async ({ language, width }) => {
  await i18n.changeLanguage(language);
  const fixture = makeFixture({
    name: "dense-previews",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const messages =
    language === "ja"
      ? [
          "今後の需要増加に期待しています。",
          "価格の変化を慎重に見守っています。",
          "今回の発表で予想が変わりました。",
          "長期的には成長すると思います。",
          "まだ不確実な要素が多いと感じます。",
        ]
      : [
          "Demand should grow after this announcement.",
          "I'm watching the next update closely.",
          "This changes my earlier prediction.",
          "The long-term outlook still looks strong.",
          "There is still considerable uncertainty.",
        ];
  fixture.props.comments = fixture.props.comments!.map((comment, index) => ({
    ...comment,
    content: messages[index % messages.length],
  }));
  await renderFixture(fixture);
  host!.style.width = `${width}px`;
  await expect.poll(() => Math.round(host!.getBoundingClientRect().width)).toBe(width);
  await frame();
  await frame();
  const previewNodes = host!.querySelectorAll('[data-testid="price-chart-comment-preview"]');
  expect(previewNodes).toHaveLength(10);
  await expect
    .poll(() =>
      [...previewNodes].every((preview) => preview.checkVisibility({ visibilityProperty: true })),
    )
    .toBe(true);
  const bodies = [
    ...host!.querySelectorAll<HTMLElement>('[data-testid="price-chart-comment-bubble"]'),
  ];
  const assertPacked = () => {
    const plot = plotRectangle();
    const bounds = bodies.map((body) => body.getBoundingClientRect());
    for (const body of bounds) {
      expect(body.left).toBeGreaterThanOrEqual(plot.left - 1);
      expect(body.right).toBeLessThanOrEqual(plot.left + plot.width + 1);
      expect(body.top).toBeGreaterThanOrEqual(plot.top - 1);
      expect(body.bottom).toBeLessThanOrEqual(plot.top + plot.height + 1);
    }
    for (let first = 0; first < bounds.length; first++) {
      for (let second = first + 1; second < bounds.length; second++) {
        const a = bounds[first],
          b = bounds[second];
        expect(
          a.right <= b.left + 0.5 ||
            b.right <= a.left + 0.5 ||
            a.bottom <= b.top + 0.5 ||
            b.bottom <= a.top + 0.5,
        ).toBe(true);
      }
    }
  };
  await expect
    .poll(() => {
      assertPacked();
      return true;
    })
    .toBe(true);

  const captureDirectory = import.meta.env.VITE_UI_REVIEW_DIR;
  if (captureDirectory)
    await page.screenshot({
      path: `${captureDirectory}/${language}-ten-previews-${width}-dpr${devicePixelRatio}.png`,
      element: host!,
    });
  if (captureDirectory)
    await page.screenshot({
      path: `${captureDirectory}/layout-${language}-${width}-plot${plotRectangle().width.toFixed(2)}-height${host!.querySelector('[data-testid="price-chart-region"]')!.getBoundingClientRect().height}-dpr${devicePixelRatio}.png`,
      element: host!,
    });
});

it("converges through wide narrow wide layout without losing the pinned card or anchor", async () => {
  const fixture = makeFixture({
    name: "packing-resize",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  await renderFixture(fixture);
  const region = host!.querySelector<HTMLElement>('[data-testid="price-chart-region"]')!;
  const initialHeight = region.getBoundingClientRect().height;
  const initialPlotWidth = plotRectangle().width;
  host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
  await expect
    .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
    .not.toBeNull();
  const card = host!.querySelector('[data-testid="price-chart-comment-popover"]');
  for (const width of [390, 1000]) {
    host!.style.width = `${width}px`;
    await expect.poll(() => Math.round(host!.getBoundingClientRect().width)).toBe(width);
    if (width === 390)
      await expect.poll(() => region.getBoundingClientRect().height).toBeGreaterThan(initialHeight);
    else await expect.poll(() => region.getBoundingClientRect().height).toBe(initialHeight);
    await assertPointerAndStep(fixture);
    expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBe(card);
    const settled = region.getBoundingClientRect().height;
    await frame();
    await frame();
    expect(region.getBoundingClientRect().height).toBe(settled);
  }
  expect(plotRectangle().width).toBe(initialPlotWidth);
});

it.each(["no-preference", "reduce"] as const)(
  "keeps Japanese previews and full comments readable inside a narrow plot (%s)",
  async (motion) => {
    await commands.setChartReducedMotion(motion);
    await i18n.changeLanguage("ja");
    const fixture = edgeFixture("right");
    const content = "日本語のコメントを最後まで安全に読むための確認です。".repeat(10).slice(0, 280);
    fixture.props.comments![0] = {
      ...fixture.props.comments![0],
      content,
      userDisplayName: "表示名",
    };
    await renderFixture(fixture, 1);
    host!.style.width = "320px";
    await expect.poll(() => plotRectangle().width).toBeLessThan(320);
    await frame();
    // Canvas observer snapshots already use viewport coordinates, including canvas offsets.
    const plot = plotRectangle();
    const bubble = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-bubble"]')!;
    const assertWithinPlot = () => {
      const body = bubble.getBoundingClientRect();
      expect(body.left).toBeGreaterThanOrEqual(plot.left - 1);
      expect(body.right).toBeLessThanOrEqual(plot.left + plot.width + 1);
      expect(body.top).toBeGreaterThanOrEqual(plot.top - 1);
      expect(body.bottom).toBeLessThanOrEqual(plot.top + plot.height + 1);
    };
    assertWithinPlot();
    const preview = host!.querySelector<HTMLElement>(
      '[data-testid="price-chart-comment-preview"]',
    )!;
    expect(preview.textContent).toBe(
      `${Array.from(
        new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(content),
        (item) => item.segment,
      )
        .slice(0, 20)
        .join("")}…`,
    );
    expect(bubble.querySelector("time")).toBeNull();
    expect(bubble.textContent).not.toContain("表示名");
    const captureDirectory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (captureDirectory)
      await page.screenshot({
        path: `${captureDirectory}/ja-preview-${motion}-dpr${devicePixelRatio}.png`,
        element: host!,
      });
    host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
    await expect.poll(() => bubble.querySelector('[role="region"]')).not.toBeNull();
    // Wait for the bounded expansion to settle without hiding animation defects in other tests.
    await expect
      .poll(() => Math.round(bubble.getBoundingClientRect().height))
      .toBe(Math.round(Math.min(176, plot.height - 8)));
    assertWithinPlot();
    const region = bubble.querySelector<HTMLElement>('[role="region"]')!;
    const body = region.querySelector("li p")!;
    expect(body.textContent).toBe(content);
    expect(getComputedStyle(body).fontSize).toBe("14px");
    expect(region.scrollHeight).toBeGreaterThan(region.clientHeight);
    if (captureDirectory)
      await page.screenshot({
        path: `${captureDirectory}/ja-expanded-top-${motion}-dpr${devicePixelRatio}.png`,
        element: host!,
      });
    region.scrollTop = region.scrollHeight;
    expect(region.scrollTop).toBeGreaterThan(0);
    if (captureDirectory)
      await page.screenshot({
        path: `${captureDirectory}/ja-expanded-${motion}-dpr${devicePixelRatio}.png`,
        element: host!,
      });
    await commands.setChartReducedMotion("no-preference");
    await i18n.changeLanguage("en");
  },
);

it.each(["left", "right"] as const)(
  "keeps the %s-edge confirmed pointer fixed throughout bubble expansion",
  async (edge) => {
    const fixture = edgeFixture(edge);
    await renderFixture(fixture, 1);
    const oldWidth = plotRectangle().width;
    host!.style.width = "320px";
    await expect.poll(() => plotRectangle().width).toBeLessThan(oldWidth);
    const marker = host!.querySelector<HTMLButtonElement>(
      '[data-testid="price-chart-comment-marker"]',
    )!;
    const bubble = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-bubble"]')!;
    const initialWidth = bubble.getBoundingClientRect().width;
    const hit = marker.getBoundingClientRect();
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    expect(marker.hasAttribute("title")).toBe(false);
    await page.getByTestId("price-chart-comment-marker").hover();
    const until = performance.now() + 240;
    let visibleFrames = 0;
    while (performance.now() < until) {
      await frame();
      const card = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-popover"]');
      if (!card?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      visibleFrames++;
      expect(pointerError(fixture)).toBeLessThanOrEqual(1);
      const region = host!
        .querySelector<HTMLElement>('[data-testid="price-chart-region"]')!
        .getBoundingClientRect();
      const bounds = bubble.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(region.left - 1);
      expect(bounds.right).toBeLessThanOrEqual(region.right + 1);
      expect(bounds.top).toBeGreaterThanOrEqual(region.top - 1);
      expect(bounds.bottom).toBeLessThanOrEqual(region.bottom + 1);
    }
    expect(visibleFrames).toBeGreaterThan(1);
    expect(bubble.getBoundingClientRect().width).toBeGreaterThan(initialWidth);
    const unfocusedShadow = getComputedStyle(bubble).boxShadow;
    marker.focus();
    await frame();
    expect(getComputedStyle(bubble).boxShadow).not.toBe(unfocusedShadow);
    expect(document.activeElement).toBe(marker);
    expect(marker.checkVisibility({ opacityProperty: true, visibilityProperty: true })).toBe(false);
    expect(bubble.querySelectorAll('[data-testid="price-chart-comment-popover"]')).toHaveLength(1);
    expect(host!.querySelectorAll('[data-testid="price-chart-comment-tail"]')).toHaveLength(0);
    expect(host!.querySelectorAll('[data-testid="price-chart-comment-panel-tail"]')).toHaveLength(
      1,
    );
    await assertPointerAndStep(fixture);
  },
);

it("disables endpoint pulse and bubble motion under the real reduced-motion preference", async () => {
  const initial = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "reduce"
    : "no-preference";
  try {
    await commands.setChartReducedMotion("no-preference");
    const fixture = edgeFixture("right");
    await renderFixture(fixture, 1);
    const tip = host!.querySelector<SVGCircleElement>(
      '[data-testid="price-chart-current-endpoint"]',
    )!;
    expect(getComputedStyle(tip).animationName).not.toBe("none");
    const position = [tip.cx.baseVal.value, tip.cy.baseVal.value];
    await frame();
    expect([tip.cx.baseVal.value, tip.cy.baseVal.value]).toEqual(position);
    await commands.setChartReducedMotion("reduce");
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(getComputedStyle(tip).animationName).toBe("none");
    host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
    await frame();
    await frame();
    const bubble = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-bubble"]')!;
    const card = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-popover"]')!;
    expect(
      getComputedStyle(bubble)
        .transitionDuration.split(",")
        .every((value) => Number.parseFloat(value) === 0),
    ).toBe(true);
    expect(getComputedStyle(card).animationName).toBe("none");
    expect(pointerError(fixture)).toBeLessThanOrEqual(1);
    assertCurrentExtensions(fixture);
  } finally {
    await commands.setChartReducedMotion(initial);
  }
});

it("preserves a pinned or focused card under real hover over another group", async () => {
  const fixture = edgeFixture("left");
  const second = fixture.props.priceHistory.data[1];
  fixture.props.comments = [
    fixture.props.comments![0],
    {
      ...fixture.props.comments![0],
      id: "other-comment",
      content: "Other confirmed comment",
      timestamp: second.timestamp,
      trade: {
        ...fixture.props.comments![0].trade!,
        executedAt: second.timestamp,
        price: second.price,
      },
    },
  ];
  await renderFixture(fixture, 2);
  const markers = host!.querySelectorAll<HTMLButtonElement>(
    '[data-testid="price-chart-comment-marker"]',
  );
  await page.getByTestId("price-chart-comment-marker").nth(0).hover();
  await page.getByTestId("price-chart-comment-popover").click();
  const pinnedCard = host!.querySelector('[data-testid="price-chart-comment-popover"]');
  await page.getByTestId("price-chart-comment-marker").nth(1).hover();
  await frame();
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBe(pinnedCard);
  await assertPointerAndStep(fixture);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await expect
    .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
    .toBeNull();
  // Explicit dismissal suppresses only the stationary pointer. Leave before starting a new hover.
  await page.getByTestId("price-chart-region").hover({ position: { x: 500, y: 210 } });
  await page.getByTestId("price-chart-comment-marker").nth(0).hover();
  await expect
    .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
    .not.toBeNull();
  const focusedCard = host!.querySelector<HTMLElement>(
    '[data-testid="price-chart-comment-popover"]',
  )!;
  const close = focusedCard.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
  close.focus();
  await page.getByTestId("price-chart-comment-marker").nth(1).hover();
  await frame();
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBe(focusedCard);
  expect(document.activeElement).toBe(close);
  markers[1].focus();
  await expect
    .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]')?.textContent)
    .toContain("Other confirmed comment");
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    outside.focus();
    await page.getByTestId("price-chart-region").hover({ position: { x: 500, y: 210 } });
    await expect
      .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
      .toBeNull();
  } finally {
    outside.remove();
  }
});

it.each(["en", "ja"])(
  "keeps the %s narrow comment author and close control usable",
  async (language) => {
    await page.viewport(320, 900);
    await i18n.changeLanguage(language);
    const fixture = edgeFixture("right");
    const displayName =
      language === "ja"
        ? "長い表示名でも閉じる操作を妨げない投稿者"
        : "A deliberately long commenter display name";
    fixture.props.comments![0] = { ...fixture.props.comments![0], userDisplayName: displayName };
    await renderFixture(fixture, 1);
    // A 320px page also needs its outer content gutters. Exercise the actual smaller plot.
    host!.style.width = "280px";
    await expect.poll(() => plotRectangle().width).toBeLessThan(200);
    await frame();
    await frame();
    host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
    await expect
      .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
      .not.toBeNull();
    const card = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-popover"]')!;
    const close = card.querySelector<HTMLButtonElement>("button")!;
    const author = card.querySelector<HTMLElement>('[data-testid="price-chart-comment-author"]')!;
    await expect
      .poll(() => Math.round(card.parentElement!.getBoundingClientRect().height))
      .toBe(Math.round(Math.min(176, plotRectangle().height - 8)));
    const bounds = card.getBoundingClientRect();
    const button = close.getBoundingClientRect();
    const authorBounds = author.getBoundingClientRect();
    expect(author.textContent).toBe(displayName);
    expect(authorBounds.width).toBeGreaterThanOrEqual(32);
    expect(authorBounds.right).toBeLessThanOrEqual(button.left);
    expect(button.left).toBeGreaterThanOrEqual(bounds.left);
    expect(button.right).toBeLessThanOrEqual(bounds.right);
    expect(button.top).toBeGreaterThanOrEqual(bounds.top);
    expect(button.bottom).toBeLessThanOrEqual(bounds.bottom);
    const hit = document.elementFromPoint(
      button.left + button.width / 2,
      button.top + button.height / 2,
    );
    expect(hit === close || close.contains(hit)).toBe(true);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    const captureDirectory = import.meta.env.VITE_UI_REVIEW_DIR;
    if (captureDirectory)
      await page.screenshot({
        path: `${captureDirectory}/${language}-expanded-header-320-dpr${devicePixelRatio}.png`,
        element: host!,
      });
    await page.getByRole("button", { name: i18n.t("common.close"), exact: true }).click();
    await expect
      .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
      .toBeNull();
    // The pointer stays still while the bubble collapses. Finish real CSS transitions.
    await frame();
    const bubble = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-bubble"]')!;
    await Promise.all(
      bubble
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await frame();
    expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBeNull();
    await page.getByRole("heading", { name: i18n.t("market.priceChart"), exact: true }).hover();
    await page.getByTestId("price-chart-comment-marker").hover();
    await expect
      .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
      .not.toBeNull();
  },
);

it("keeps a pinned confirmed NO comment at its fill after its history bucket is replaced", async () => {
  const fixture = edgeFixture("right");
  const oldTime = "2026-05-25T10:10:00.000Z";
  const newTime = "2026-05-25T10:20:00.000Z";
  const first = { eventOrder: "first", timestamp: "2026-05-25T10:01:00.000Z", price: 40 };
  fixture.props.chartTimeframe = "1h";
  fixture.props.priceHistory = {
    timeframe: "1h",
    asOf: "2026-05-25T11:00:00.000Z",
    receivedAt: performance.now(),
    data: [first, { eventOrder: "old", timestamp: oldTime, price: 51 }],
  };
  fixture.props.comments![0] = {
    ...fixture.props.comments![0],
    trade: {
      ...fixture.props.comments![0].trade!,
      outcomeId: "no",
      executedAt: oldTime,
      price: 490,
      priceDenominator: 1000,
    },
  };
  fixture.anchor = { timestamp: Date.parse(oldTime), price: 51 };
  await renderFixture(fixture, 1);
  host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.click();
  await assertPointerAndStep(fixture);
  const card = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-popover"]')!;
  const close = card.querySelector<HTMLButtonElement>("button")!;
  close.focus();
  const replacement = {
    ...fixture,
    props: {
      ...fixture.props,
      priceHistory: {
        ...fixture.props.priceHistory,
        data: [first, { eventOrder: "new", timestamp: newTime, price: 49 }],
      },
    },
  };
  expect(replacement.props.priceHistory.data.some((point) => point.timestamp === oldTime)).toBe(
    false,
  );
  await renderFixture(replacement, 1);
  await expect.poll(() => pointerError(replacement)).toBeLessThanOrEqual(1);
  expect(host!.querySelector('[data-testid="price-chart-comment-popover"]')).toBe(card);
  expect(document.activeElement).toBe(close);
  const expectedNew = expectedPointer({
    ...replacement,
    anchor: { timestamp: Date.parse(newTime), price: 49 },
  });
  const expectedOld = expectedPointer(replacement);
  const distanceTo = (expected: { x: number; y: number }) =>
    Math.min(
      ...currentLines()
        .flatMap(lineVertices)
        .map((point) => Math.hypot(point.x - expected.x, point.y - expected.y)),
    );
  await expect.poll(() => distanceTo(expectedNew)).toBeLessThanOrEqual(1);
  expect(distanceTo(expectedOld)).toBeGreaterThan(1);
});

it.each(
  [
    { language: "en", width: 320 },
    { language: "ja", width: 320 },
    { language: "en", width: 1280 },
    { language: "ja", width: 1280 },
  ].flatMap((input) =>
    (["7d", "all", "all90s", "all30h"] as const).map((span) => ({ ...input, span })),
  ),
)(
  "keeps actual $language axis labels separate for $span at $width pixels",
  async ({ language, width, span }) => {
    const timeframe = span === "7d" ? "7d" : "all";
    const first =
      span === "all90s"
        ? "2026-10-09T09:13:30.000Z"
        : span === "all30h"
          ? "2026-10-08T03:15:00.000Z"
          : "2026-10-09T08:15:00.000Z";
    await page.viewport(width, 900);
    await i18n.changeLanguage(language);
    const textDraws: Array<{ text: string; left: number; right: number }> = [];
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    const originalClear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas === host?.querySelector("canvas")) textDraws.length = 0;
      originalClear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (this.canvas === host?.querySelector("canvas") && /[/:月]/.test(text)) {
        const metric = this.measureText(text),
          matrix = this.getTransform();
        const rect = this.canvas.getBoundingClientRect();
        const start = new DOMPoint(x - metric.actualBoundingBoxLeft, y).matrixTransform(matrix);
        const end = new DOMPoint(x + metric.actualBoundingBoxRight, y).matrixTransform(matrix);
        textDraws.push({
          text,
          left: rect.left + (start.x * rect.width) / this.canvas.width,
          right: rect.left + (end.x * rect.width) / this.canvas.width,
        });
      }
      if (maxWidth === undefined) originalText.call(this, text, x, y);
      else originalText.call(this, text, x, y, maxWidth);
    };
    try {
      const fixture = makeFixture({
        name: "seven-day-axis",
        binary: true,
        outcomes: 2,
        pointsPerOutcome: 300,
      });
      fixture.props.comments = [];
      fixture.props.chartTimeframe = timeframe;
      fixture.props.priceHistory = {
        timeframe,
        asOf: "2026-10-09T09:15:00.000Z",
        receivedAt: performance.now(),
        data: [
          {
            eventOrder: "first",
            timestamp: timeframe === "all" ? first : "2026-10-06T10:00:00.000Z",
            price: 40,
          },
          {
            eventOrder: "last",
            timestamp:
              timeframe === "all" ? "2026-10-09T09:15:00.000Z" : "2026-10-08T10:00:00.000Z",
            price: 60,
          },
        ],
      };
      fixture.props.historyStatus = "ready";
      fixture.props.priceRefreshUnavailable = true;
      await renderFixture(fixture, 0);
      host!.style.width = `${width === 320 ? 288 : 1000}px`;
      await expect
        .poll(() => host!.querySelector("canvas")!.getBoundingClientRect().width)
        .toBeLessThan(width);
      await frame();
      await frame();
      await expect.poll(() => textDraws.length).toBeGreaterThanOrEqual(2);
      const labels = [...textDraws].sort((a, b) => a.left - b.left);
      const canvasBounds = host!.querySelector("canvas")!.getBoundingClientRect();
      for (let i = 0; i < labels.length; i++) {
        expect(labels[i].left).toBeGreaterThanOrEqual(canvasBounds.left - 1);
        expect(labels[i].right).toBeLessThanOrEqual(canvasBounds.right + 1);
        if (i) expect(labels[i].left - labels[i - 1].right).toBeGreaterThanOrEqual(4);
      }
      expect(new Set(labels.map((label) => label.text)).size).toBe(labels.length);
      if (timeframe === "7d") {
        expect(labels[0].text).toBe("10/2");
        expect(labels.at(-1)!.text).toBe("10/9");
      } else if (span === "all") {
        expect(labels[0].text).toBe(language === "en" ? "8:15 AM" : "8:15");
        expect(labels.at(-1)!.text).toBe(language === "en" ? "9:15 AM" : "9:15");
      }
      if (span === "all90s") {
        expect(labels[0].text).toMatch(/9:13(?::30)?/);
        expect(labels.at(-1)!.text).toMatch(/9:15(?::00)?/);
      }
      if (span === "all30h") {
        expect(labels[0].text).toContain("10/8");
        expect(labels.at(-1)!.text).toContain("10/9");
      }
      const captureDirectory = import.meta.env.VITE_UI_REVIEW_DIR;
      if (captureDirectory)
        await page.screenshot({
          path: `${captureDirectory}/${language}-axis-${span}-${width}-dpr${devicePixelRatio}.png`,
          element: host!,
        });
      const surface = host!.querySelector<HTMLElement>(
        '[data-testid="price-chart-cursor-surface"]',
      )!;
      const bounds = surface.getBoundingClientRect();
      await page
        .getByTestId("price-chart-cursor-surface")
        .hover({ position: { x: bounds.width * 0.6, y: bounds.height * 0.5 } });
      const detail = host!.querySelector('[data-testid="price-chart-x-axis-cursor-label"]')!;
      expect(detail.textContent).toMatch(/\d:\d{2}/);
    } finally {
      CanvasRenderingContext2D.prototype.fillText = originalText;
      CanvasRenderingContext2D.prototype.clearRect = originalClear;
    }
  },
);

it("reopens after physical exit when closing removes the pointer leave ancestry", async () => {
  await page.viewport(320, 900);
  await i18n.changeLanguage("en");
  await renderFixture(edgeFixture("right"), 1);
  host!.style.width = "280px";
  await expect.poll(() => plotRectangle().width).toBeLessThan(200);
  const marker = page.getByTestId("price-chart-comment-marker");
  host!.querySelector<HTMLButtonElement>('[data-testid="price-chart-comment-marker"]')!.focus();
  await expect
    .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
    .not.toBeNull();
  await frame();
  const bubble = host!.querySelector<HTMLElement>('[data-testid="price-chart-comment-bubble"]')!;
  await Promise.all(
    bubble
      .getAnimations({ subtree: true })
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  // The connected browser lost the bubble leave after its hit descendant was removed.
  // Reproduce that observed missing event deterministically, with real mouse operations.
  const omitLeave = (event: Event) => event.stopImmediatePropagation();
  document.addEventListener("pointerout", omitLeave, true);
  document.addEventListener("pointerleave", omitLeave, true);
  try {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect
      .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
      .toBeNull();
    await page.getByRole("heading", { name: "Price Chart", exact: true }).hover();
  } finally {
    document.removeEventListener("pointerout", omitLeave, true);
    document.removeEventListener("pointerleave", omitLeave, true);
  }
  await marker.hover();
  await expect
    .poll(() => host!.querySelector('[data-testid="price-chart-comment-popover"]'))
    .not.toBeNull();
});
