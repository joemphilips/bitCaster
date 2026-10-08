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
  await page.getByTestId("price-chart-comment-marker").nth(0).hover();
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
