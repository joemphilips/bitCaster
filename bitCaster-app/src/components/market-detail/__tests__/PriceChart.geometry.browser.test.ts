import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
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
async function renderFixture(fixture: Fixture, expectedMarkers = 40) {
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
        (marker) => marker.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      ),
    )
    .toBe(true);
  await frame();
  await frame();
}
afterEach(() => {
  root?.unmount();
  root = undefined;
  host?.remove();
  host = undefined;
  observer?.restore();
  observer = undefined;
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
    ).toContain("Benchmark comment 0.");
  },
);

it("anchors a binary NO fill at its exact YES-complement price", async () => {
  const fixture = makeFixture({
    name: "binary-complement",
    binary: true,
    outcomes: 2,
    pointsPerOutcome: 300,
  });
  const trade = fixture.props.comments![1].trade!;
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
    "Benchmark comment 1.",
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
    index === 1
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
    "Benchmark comment 1.",
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
  fixture.props.comments = [fixture.props.comments![0]];
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
