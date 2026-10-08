import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Chart } from "chart.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { PriceChart } from "../PriceChart";
import { chartDomain, preparePriceSeries, windowPriceSeries } from "../priceChartModel";
import type { ChartTimeframe, Comment, PriceHistory } from "@/types/market-detail";
import type { PublicNostrProfile } from "@/lib/nostr";

const fetchPublicNostrProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nostr", () => ({ fetchPublicNostrProfile }));

// jsdom has no Canvas or layout. Use real Chart.js controllers/scales with its
// public BasicPlatform and a drawing sink. Browser tests own painted geometry.
const chartSize = vi.hoisted(() => ({ width: 400, height: 224 }));
vi.mock("chart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chart.js")>();
  return {
    ...actual,
    Chart: new Proxy(actual.Chart, {
      construct(target, [canvas, config]) {
        canvas.width = chartSize.width;
        canvas.height = chartSize.height;
        return new target(canvas, {
          ...config,
          options: { ...config.options, responsive: false },
          platform: actual.BasicPlatform,
        });
      },
    }),
  };
});

const paintedStrokeColors: string[] = [];
beforeEach(() => {
  paintedStrokeColors.length = 0;
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let context = contexts.get(this);
    if (!context) {
      const values: Record<string, unknown> = {
        canvas: this,
        stroke: function (this: CanvasRenderingContext2D) {
          paintedStrokeColors.push(String(this.strokeStyle));
        },
        measureText: (text: string) => ({ width: String(text).length * 6 }),
        getLineDash: () => [],
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      };
      context = new Proxy(values, {
        get: (target, key) => target[String(key)] ?? (() => {}),
        set: (target, key, value) => {
          target[String(key)] = value;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
      contexts.set(this, context);
    }
    return context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
});

function nativeChart() {
  return Chart.getChart(
    screen.getByTestId("price-chart-canvas") as HTMLCanvasElement,
  ) as Chart<"line">;
}

function prepareAllSeries(input: Parameters<typeof preparePriceSeries>[0]) {
  return windowPriceSeries(preparePriceSeries(input), "all", null);
}

function moveCursor(fraction: number, verticalFraction = 0.5) {
  const surface = screen.getByTestId("price-chart-cursor-surface");
  const svg = surface.closest("svg")!;
  svg.getBoundingClientRect = () =>
    DOMRect.fromRect({ width: chartSize.width, height: chartSize.height });
  // jsdom omits SVG screen transforms. The fixed test viewport uses identity
  // screen coordinates; real-browser tests cover scaled SVG transforms.
  svg.getScreenCTM = () => ({ inverse: () => ({}) }) as DOMMatrix;
  vi.stubGlobal(
    "DOMPoint",
    class {
      constructor(
        public x: number,
        public y: number,
      ) {}
      matrixTransform() {
        return this;
      }
    },
  );
  const x = Number(surface.getAttribute("x"));
  const y = Number(surface.getAttribute("y"));
  const width = Number(surface.getAttribute("width"));
  const height = Number(surface.getAttribute("height"));
  fireEvent(
    surface,
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: x + width * fraction,
      clientY: y + height * verticalFraction,
    }),
  );
}

function leaveCursor() {
  fireEvent.pointerLeave(screen.getByTestId("price-chart-cursor-surface"));
}

function markerCoordinate(marker: HTMLElement): [string, number, number] {
  return JSON.parse(
    decodeURIComponent(marker.getAttribute("aria-controls")!.slice("price-chart-comments-".length)),
  );
}

function makeTrade(
  executedAt: string,
  options: {
    outcomeId?: string;
    price?: number;
    priceDenominator?: number;
    fillId?: string;
    faceAmountSubunits?: number | null;
  } = {},
): NonNullable<Comment["trade"]> {
  return {
    fillId: options.fillId ?? "00000000-0000-0000-0000-000000000001",
    outcomeId: options.outcomeId ?? "yes",
    executedAt,
    price: options.price ?? 50,
    priceDenominator: options.priceDenominator ?? 100,
    faceAmountSubunits: options.faceAmountSubunits,
  };
}

function makeComment(id: string, createdAt: string, trade: Comment["trade"] = null): Comment {
  return {
    id,
    userId: `user-${id}`,
    userDisplayName: `Trader ${id}`,
    content: `Comment ${id}`,
    timestamp: createdAt,
    trade,
    likeCount: 0,
    isLiked: false,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PriceChart", () => {
  beforeEach(() => {
    chartSize.width = 400;
    vi.spyOn(performance, "now").mockReturnValue(0);
    fetchPublicNostrProfile.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a real chart with fixed probability axis labels", () => {
    render(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{
          timeframe: "all",
          data: [
            { eventOrder: "001", timestamp: "2026-05-20T10:00:00Z", price: 40 },
            { eventOrder: "002", timestamp: "2026-05-25T10:00:00Z", price: 55 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("price-chart-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("55.00%");
    expect(nativeChart().scales.y.min).toBe(0);
    expect(nativeChart().scales.y.max).toBe(100);
    expect(nativeChart().scales.y.ticks.map((tick) => tick.label)).toContain("50.00%");
    expect(nativeChart().data.datasets[0].pointRadius).toBe(0);
  });

  it("extends the latest confirmed price without appending a history point", () => {
    const history: PriceHistory = {
      timeframe: "1h",
      asOf: "2026-05-25T12:00:00Z",
      receivedAt: 0,
      data: [{ eventOrder: "first", timestamp: "2026-05-25T11:30:00Z", price: 40 }],
    };
    const original = structuredClone(history);
    const view = render(<PriceChart chartTimeframe="1h" priceHistory={history} />);
    const extension = screen.getByTestId("price-chart-current-extension");
    expect(Number(extension.getAttribute("x2"))).toBeGreaterThan(
      Number(extension.getAttribute("x1")),
    );
    expect(extension.getAttribute("y1")).toBe(extension.getAttribute("y2"));
    expect(screen.getByTestId("price-chart-current-endpoint")).toHaveAttribute(
      "data-series-id",
      "primary",
    );
    expect(nativeChart().data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(1);
    expect(history).toEqual(original);
    const appended: PriceHistory = {
      ...history,
      data: [
        ...history.data,
        { eventOrder: "second", timestamp: "2026-05-25T11:45:00Z", price: 60 },
      ],
    };
    view.rerender(<PriceChart chartTimeframe="1h" priceHistory={appended} />);
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("60.00%");
    expect(nativeChart().data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(2);
    expect(appended.data.map((point) => point.eventOrder)).toEqual(["first", "second"]);
    expect(screen.getAllByTestId("price-chart-current-endpoint")).toHaveLength(1);
    const currentTipY = screen.getByTestId("price-chart-current-endpoint").getAttribute("cy");
    moveCursor(0.5);
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("40.00%");
    expect(screen.getByTestId("price-chart-current-endpoint")).toHaveAttribute("cy", currentTipY);
    view.rerender(
      <PriceChart chartTimeframe="all" priceHistory={{ timeframe: "all", data: [] }} />,
    );
    expect(screen.queryByTestId("price-chart-current-extension")).not.toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-current-endpoint")).not.toBeInTheDocument();
  });

  it("shows one endpoint for each populated categorical series without pricing an empty outcome", () => {
    const data = [{ eventOrder: "first", timestamp: "2026-05-25T10:00:00Z", price: 30 }];
    render(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{ timeframe: "all", data: [] }}
        outcomes={[
          { id: "a", label: "A", odds: null, color: "#112233" },
          { id: "b", label: "B", odds: null, color: "#445566" },
          { id: "c", label: "C", odds: null, color: "#778899" },
        ]}
        outcomePriceHistories={{
          A: { timeframe: "all", data },
          B: {
            timeframe: "all",
            data: [{ ...data[0], eventOrder: "b", timestamp: "2026-05-25T11:00:00Z", price: 75 }],
          },
          C: { timeframe: "all", data: [] },
        }}
      />,
    );
    expect(
      screen
        .getAllByTestId("price-chart-current-endpoint")
        .map((endpoint) => endpoint.getAttribute("data-series-id")),
    ).toEqual(["a", "b"]);
    expect(screen.getAllByTestId("latest-price-pill")[2]).toHaveTextContent("CNo trades yet");
    expect(nativeChart().data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(2);
  });

  it("renders the later connected No Sell on the YES-basis latest-price pill", () => {
    const buyPoint = {
      timestamp: "2026-09-27T20:03:00.000Z",
      eventOrder: "063926136246663187701270030825",
      price: 51,
      volume: 1_000,
      source: "fill" as const,
    };
    const sellPoint = {
      timestamp: "2026-09-27T20:04:41.774Z",
      eventOrder: "063926136281821841501289502429",
      price: 49,
      volume: 1_000,
      source: "fill" as const,
    };
    const { rerender } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-09-27T20:05:00Z",
          receivedAt: performance.now(),
          data: [buyPoint],
        }}
        chartTimeframe="7d"
        currentDisplay="51.0%"
      />,
    );

    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("51.00%");
    expect(screen.getByText("51.0%", { exact: true })).toBeInTheDocument();

    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-09-27T20:05:00Z",
          receivedAt: performance.now(),
          data: [buyPoint, sellPoint],
        }}
        chartTimeframe="7d"
        currentDisplay="49.0%"
      />,
    );

    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("49.00%");
    expect(screen.getByText("49.0%", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByTestId("price-chart-chartjs")).toHaveLength(1);
  });

  it("keeps compact cursor labels at the confirmed price regardless of pointer height", () => {
    render(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{
          timeframe: "all",
          data: [
            { eventOrder: "001", timestamp: "2026-05-20T10:00:00Z", price: 46 },
            { eventOrder: "002", timestamp: "2026-05-20T11:00:00Z", price: 52 },
          ],
        }}
      />,
    );
    moveCursor(0.5, 0.2);
    expect(screen.queryByTestId("price-chart-cursor-tooltip")).not.toBeInTheDocument();
    expect(screen.getByTestId("price-chart-x-axis-cursor-label")).toHaveClass(
      "pointer-events-none",
    );
    expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("46.00%");
    moveCursor(0.5, 0.8);
    expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("46.00%");
    leaveCursor();
    expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("52.00%");
  });

  it("refreshes a stationary historical cursor when confirmed history changes", () => {
    const first = { eventOrder: "001", timestamp: "2026-05-20T10:00:00Z", price: 46 };
    const later = { eventOrder: "002", timestamp: "2026-05-20T10:00:10Z", price: 52 };
    const asOf = "2026-05-20T10:00:30Z";
    const history: PriceHistory = { timeframe: "1h", asOf, receivedAt: 0, data: [first] };
    const { rerender } = render(<PriceChart priceHistory={history} chartTimeframe="1h" />);
    moveCursor(1);
    expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("46.00%");
    rerender(
      <PriceChart priceHistory={{ ...history, data: [first, later] }} chartTimeframe="1h" />,
    );
    expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("52.00%");
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("52.00%");
  });

  it.each(["hover", "focus", "pin"] as const)(
    "keeps latest prices when %s selects a comment whose history buckets are replaced",
    (intent) => {
      const timestamp = "2026-05-25T10:10:00.000Z";
      const comments = [makeComment("retained", timestamp, makeTrade(timestamp, { price: 40 }))];
      const history: PriceHistory = {
        timeframe: "1h",
        asOf: "2026-05-25T10:30:00.000Z",
        receivedAt: performance.now(),
        data: [
          { eventOrder: "old-first", timestamp, price: 40 },
          { eventOrder: "old-second", timestamp: "2026-05-25T10:20:00.000Z", price: 50 },
        ],
      };
      const view = render(
        <PriceChart chartTimeframe="1h" priceHistory={history} comments={comments} />,
      );
      moveCursor(0.7);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("40.00%");
      const marker = screen.getByTestId("price-chart-comment-marker");
      const anchor = markerCoordinate(marker);
      if (intent === "hover") fireEvent.pointerEnter(marker, { pointerType: "mouse" });
      else if (intent === "focus") act(() => marker.focus());
      else {
        fireEvent.pointerDown(marker, { pointerType: "touch" });
        fireEvent.click(marker);
      }
      const card = screen.getByRole("dialog");
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("50.00%");
      const replacements = [
        { eventOrder: "new-first", timestamp: "2026-05-25T10:11:00.000Z", price: 45 },
        { eventOrder: "new-second", timestamp: "2026-05-25T10:21:00.000Z", price: 60 },
      ];
      view.rerender(
        <PriceChart
          chartTimeframe="1h"
          priceHistory={{ ...history, data: replacements }}
          comments={comments}
        />,
      );
      expect(screen.getByRole("dialog")).toBe(card);
      expect(card).toHaveTextContent("Comment retained");
      expect(markerCoordinate(marker)).toEqual(anchor);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("60.00%");
      expect(screen.getAllByTestId("price-chart-chartjs")).toHaveLength(1);
      // Pointer motion behind an open card must not restore an invisible inspection cursor.
      moveCursor(0.1);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("60.00%");
      expect(screen.queryByTestId("price-chart-x-axis-cursor-label")).not.toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // Free inspection still uses only the replacement history, without fallback or merging.
      moveCursor(0.67);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("Price unavailable");
      moveCursor(0.7);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("45.00%");
      leaveCursor();
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("60.00%");
    },
  );

  it("preserves the open card and keyboard focus through append and resize", () => {
    const timestamp = "2026-05-25T10:00:00.000Z";
    const comments = [makeComment("focused", timestamp, makeTrade(timestamp))];
    const data = [
      { eventOrder: "first", timestamp, price: 40 },
      { eventOrder: "second", timestamp: "2026-05-25T11:00:00.000Z", price: 50 },
    ];
    const view = render(
      <PriceChart
        priceHistory={{ timeframe: "all", data }}
        chartTimeframe="all"
        comments={comments}
      />,
    );
    const marker = screen.getByTestId("price-chart-comment-marker");
    fireEvent.click(marker);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: /^Close$/ });
    act(() => close.focus());
    view.rerender(
      <PriceChart
        priceHistory={{
          timeframe: "all",
          data: [
            ...data,
            { eventOrder: "third", timestamp: "2026-05-25T12:00:00.000Z", price: 60 },
          ],
        }}
        chartTimeframe="all"
        comments={comments}
      />,
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(close).toHaveFocus();
    act(() => nativeChart().resize(300, 224));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(marker.isConnected).toBe(true);
    expect(marker).toHaveFocus();
  });

  it("keeps a hover card open across pointer transfer and while focus stays inside", () => {
    vi.useFakeTimers();
    const timestamp = "2026-05-25T10:00:00.000Z";
    const outside = document.createElement("button");
    outside.textContent = "Outside chart";
    document.body.append(outside);
    const view = render(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{ timeframe: "all", data: [{ eventOrder: "first", timestamp, price: 50 }] }}
        comments={[makeComment("hover", timestamp, makeTrade(timestamp))]}
      />,
    );
    try {
      outside.focus();
      const marker = screen.getByTestId("price-chart-comment-marker");
      fireEvent.pointerEnter(marker);
      expect(outside).toHaveFocus();
      const dialog = screen.getByRole("dialog");
      fireEvent.pointerLeave(marker);
      fireEvent.pointerEnter(dialog);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole("dialog")).toBe(dialog);
      const close = screen.getByRole("button", { name: /^Close$/ });
      act(() => close.focus());
      fireEvent.pointerLeave(dialog);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole("dialog")).toBe(dialog);
      expect(close).toHaveFocus();
      act(() => outside.focus());
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      outside.remove();
      vi.useRealTimers();
    }
  });

  it("pins a tapped card and does not reopen it when Close or Escape restores focus", () => {
    vi.useFakeTimers();
    const timestamp = "2026-05-25T10:00:00.000Z";
    const view = render(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{ timeframe: "all", data: [{ eventOrder: "first", timestamp, price: 50 }] }}
        comments={[makeComment("pinned", timestamp, makeTrade(timestamp))]}
      />,
    );
    try {
      const marker = screen.getByTestId("price-chart-comment-marker");
      for (const closeWith of ["button", "escape"]) {
        fireEvent.pointerDown(marker, { pointerType: "touch" });
        fireEvent.click(marker);
        const dialog = screen.getByRole("dialog");
        fireEvent.pointerLeave(marker);
        fireEvent.pointerLeave(dialog);
        act(() => vi.advanceTimersByTime(300));
        expect(screen.getByRole("dialog")).toBe(dialog);
        const close = screen.getByRole("button", { name: /^Close$/ });
        act(() => close.focus());
        if (closeWith === "button") fireEvent.click(close);
        else fireEvent.keyDown(document, { key: "Escape" });
        act(() => vi.advanceTimersByTime(300));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(marker).toHaveFocus();
        fireEvent.pointerMove(marker);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      }
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  describe("two-group comment ownership", () => {
    function setupGroups() {
      const data = [
        { eventOrder: "a", timestamp: "2026-05-25T10:00:00Z", price: 30 },
        { eventOrder: "b", timestamp: "2026-05-25T11:00:00Z", price: 70 },
      ];
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      const view = render(
        <PriceChart
          chartTimeframe="all"
          priceHistory={{ timeframe: "all", data }}
          comments={data.map((point) =>
            makeComment(
              point.eventOrder,
              point.timestamp,
              makeTrade(point.timestamp, { price: point.price }),
            ),
          )}
        />,
      );
      return { outside, view, markers: screen.getAllByTestId("price-chart-comment-marker") };
    }

    it.each(["pinned", "close", "region"] as const)(
      "passive hover preserves A when %s owns it; an explicit click switches to B",
      (owner) => {
        vi.useFakeTimers();
        const { outside, view, markers } = setupGroups();
        try {
          if (owner === "pinned") fireEvent.click(markers[0]);
          else fireEvent.pointerEnter(markers[0]);
          const cardA = screen.getByRole("dialog");
          const focusOwner =
            owner === "close"
              ? screen.getByRole("button", { name: /^Close$/ })
              : owner === "region"
                ? screen.getByRole("region", { name: "Price chart comments" })
                : outside;
          act(() => focusOwner.focus());
          fireEvent.pointerEnter(markers[1]);
          act(() => vi.advanceTimersByTime(300));
          expect(screen.getByRole("dialog")).toBe(cardA);
          expect(cardA).toHaveTextContent("Comment a");
          expect(focusOwner).toHaveFocus();
          fireEvent.click(markers[1]);
          const cardB = screen.getByRole("dialog");
          expect(cardB).not.toBe(cardA);
          expect(cardB).toHaveTextContent("Comment b");
          fireEvent.pointerLeave(markers[1].closest('[data-testid="price-chart-comment-bubble"]')!);
          act(() => outside.focus());
          act(() => vi.advanceTimersByTime(300));
          expect(screen.getByRole("dialog")).toBe(cardB);
          fireEvent.keyDown(document, { key: "Escape" });
          expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
          expect(markers[1]).toHaveFocus();
        } finally {
          view.unmount();
          outside.remove();
          vi.useRealTimers();
        }
      },
    );

    it("keyboard focus switches from pinned A to unpinned B without leaving an obsolete pin", () => {
      vi.useFakeTimers();
      const { outside, view, markers } = setupGroups();
      try {
        fireEvent.click(markers[0]);
        expect(screen.getByRole("dialog")).toHaveTextContent("Comment a");
        act(() => markers[1].focus());
        expect(screen.getByRole("dialog")).toHaveTextContent("Comment b");
        expect(markers[1]).toHaveFocus();
        act(() => outside.focus());
        fireEvent.pointerLeave(markers[1].closest('[data-testid="price-chart-comment-bubble"]')!);
        act(() => vi.advanceTimersByTime(300));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } finally {
        view.unmount();
        outside.remove();
        vi.useRealTimers();
      }
    });

    it("allows ordinary hover to switch from A to B when neither owns focus or a pin", () => {
      vi.useFakeTimers();
      const { outside, view, markers } = setupGroups();
      try {
        fireEvent.pointerEnter(markers[0]);
        expect(screen.getByRole("dialog")).toHaveTextContent("Comment a");
        fireEvent.pointerLeave(markers[0]);
        fireEvent.pointerEnter(markers[1]);
        expect(screen.getByRole("dialog")).toHaveTextContent("Comment b");
        expect(outside).toHaveFocus();
        fireEvent.pointerLeave(markers[1].closest('[data-testid="price-chart-comment-bubble"]')!);
        act(() => vi.advanceTimersByTime(300));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } finally {
        view.unmount();
        outside.remove();
        vi.useRealTimers();
      }
    });
  });

  it("bounds reaction appearance without changing confirmed anchors or fill ranking", () => {
    const data = [0, 1, 2].map((index) => ({
      eventOrder: String(index),
      timestamp: new Date(Date.parse("2026-05-25T10:00:00Z") + index * 1000).toISOString(),
      price: 50,
    }));
    const comments = data.map((point, index) => ({
      ...makeComment(String(index), point.timestamp, makeTrade(point.timestamp)),
      likeCount: [-1, 3, 1_000_000][index],
    }));
    const history: PriceHistory = { timeframe: "all", data };
    const view = render(
      <PriceChart chartTimeframe="all" priceHistory={history} comments={comments} />,
    );
    const bubbles = screen.getAllByTestId("price-chart-comment-bubble");
    const widths = bubbles.map((bubble) => Number.parseFloat(bubble.style.width));
    const heights = bubbles.map((bubble) => Number.parseFloat(bubble.style.height));
    const opacity = bubbles.map((bubble) => Number(bubble.style.opacity));
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(opacity[1]).toBeGreaterThan(opacity[0]);
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(24);
      expect(width).toBeLessThanOrEqual(36);
    }
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(18);
      expect(height).toBeLessThanOrEqual(26);
    }
    for (const value of opacity) {
      expect(value).toBeGreaterThanOrEqual(0.6);
      expect(value).toBeLessThanOrEqual(0.9);
    }
    const markers = screen.getAllByTestId("price-chart-comment-marker");
    const anchors = markers.map((marker) => [
      marker.getAttribute("data-anchor-x"),
      marker.getAttribute("data-anchor-y"),
    ]);
    view.rerender(
      <PriceChart
        chartTimeframe="all"
        priceHistory={history}
        comments={comments.map((comment) => ({ ...comment, likeCount: 2_000_000 }))}
      />,
    );
    expect(
      screen
        .getAllByTestId("price-chart-comment-marker")
        .map((marker) => [
          marker.getAttribute("data-anchor-x"),
          marker.getAttribute("data-anchor-y"),
        ]),
    ).toEqual(anchors);
    expect(nativeChart().data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(3);
  });

  it("groups comments by exact trade coordinate and opens a bounded escaped keyboard-accessible list", () => {
    const timestamp = "2026-05-25T10:00:00.000Z";
    const comments: Comment[] = Array.from({ length: 12 }, (_, index) => ({
      id: `comment-${index}`,
      userId: `user-${index}`,
      userDisplayName: index === 0 ? "<img src=x onerror=alert(1)>" : `Trader ${index}`,
      content: index === 0 ? "<script>alert(1)</script>" : `Comment ${index}`,
      timestamp,
      trade: makeTrade(timestamp, { price: 42 }),
      likeCount: 0,
      isLiked: false,
    }));
    comments.push({
      id: "comment-next-second",
      userId: "user-next-second",
      userDisplayName: "Other trader",
      content: "Another time group",
      timestamp: "2026-05-25T10:00:01.000Z",
      trade: makeTrade("2026-05-25T10:00:01.000Z", { price: 43 }),
      likeCount: 0,
      isLiked: false,
    });
    const { unmount } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:05Z",
          receivedAt: performance.now(),
          data: [
            { eventOrder: "2026-05-25T10:00:05Z", timestamp: "2026-05-25T10:00:05Z", price: 42 },
          ],
        }}
        chartTimeframe="7d"
        comments={comments}
      />,
    );

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(2);
    expect(markers[0]).toHaveAccessibleName(expect.stringContaining("12 comments"));
    fireEvent.pointerEnter(markers[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(markers[0]).toHaveFocus();
    fireEvent.focus(markers[0]);

    const dialog = screen.getByRole("dialog");
    expect(markers[0]).not.toHaveAttribute("title");
    expect(dialog.closest('[data-testid="price-chart-comment-bubble"]')).toContainElement(
      markers[0],
    );
    expect(markers[0]).not.toBeVisible();
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveTextContent("");
    expect(closeButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(dialog.querySelectorAll("time")).toHaveLength(12);
    expect(dialog.querySelectorAll('[data-testid="price-chart-comment-author"]')).toHaveLength(12);
    expect(dialog.querySelectorAll('button[aria-label="Close"]')).toHaveLength(1);
    expect(screen.getByTestId("price-chart-comment-panel-tail")).toBeInTheDocument();
    expect(dialog.querySelector("h4")).toBeNull();
    expect(dialog).toHaveAccessibleName("Price chart comments");
    expect(dialog).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(dialog).toHaveTextContent("<script>alert(1)</script>");
    expect(dialog.querySelector("img,script")).toBeNull();
    expect(dialog.querySelectorAll("li")).toHaveLength(12);
    expect(
      Number.parseFloat(
        (dialog.closest('[data-testid="price-chart-comment-bubble"]') as HTMLElement).style.height,
      ),
    ).toBeLessThanOrEqual(176);
    const scrollContainer = dialog.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeInTheDocument();
    expect(scrollContainer).toHaveAttribute("role", "region");
    expect(scrollContainer).toHaveAttribute("tabindex", "0");
    expect(scrollContainer).toHaveAccessibleName("Price chart comments");
    expect(scrollContainer).toHaveClass("focus-visible:ring-2");
    expect(scrollContainer).toContainElement(screen.getByText("Comment 11"));
    act(() => (scrollContainer as HTMLElement).focus());
    expect(scrollContainer).toHaveFocus();
    expect(screen.queryByTestId("price-chart-cursor-tooltip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-x-axis-cursor-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("42.00%");

    fireEvent.pointerDown(markers[1], { pointerType: "touch" });
    fireEvent.click(markers[1]);
    expect(screen.getByRole("dialog")).toHaveTextContent("Another time group");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(markers[0]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markers[0]).toHaveFocus();

    fireEvent.click(markers[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(markers[0]);
    const removeListener = vi.spyOn(document, "removeEventListener");
    const hostileInterpolation = "<img src=x onerror=alert(1)>";
    const translatedInterpolation = i18n.t("market.chartCommentsAt", {
      lng: "en",
      time: hostileInterpolation,
    });
    const interpolationView = render(<p>{translatedInterpolation}</p>);
    expect(interpolationView.container).toHaveTextContent(`Comments at ${hostileInterpolation}`);
    expect(interpolationView.container.querySelector("img,script")).toBeNull();

    unmount();
    expect(removeListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    removeListener.mockRestore();
  });

  it.each([
    { timeframe: "1h", dateOnly: false },
    { timeframe: "24h", dateOnly: false },
    { timeframe: "7d", dateOnly: false },
    { timeframe: "30d", dateOnly: true },
    { timeframe: "all", dateOnly: true },
  ] as const)(
    "$timeframe shows the confirmed date with dateOnly=$dateOnly",
    ({ timeframe, dateOnly }) => {
      const timestamp = "2026-05-25T10:00:00.000Z";
      render(
        <PriceChart
          priceHistory={{
            timeframe,
            asOf: timestamp,
            receivedAt: performance.now(),
            data: [{ eventOrder: "001", timestamp, price: 50 }],
          }}
          chartTimeframe={timeframe}
          comments={[makeComment("dated", timestamp, makeTrade(timestamp))]}
        />,
      );
      const marker = screen.getByTestId("price-chart-comment-marker");
      fireEvent.click(marker);
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAccessibleName("Price chart comments");
      expect(dialog.querySelectorAll("time")).toHaveLength(1);
      for (const time of dialog.querySelectorAll("time")) {
        expect(time).toHaveAttribute("datetime", timestamp);
        expect(time).toHaveTextContent(dateOnly ? /^5\/25\/26$/ : /5\/25\/26, .*\d:\d/);
      }
      expect(screen.queryByTestId("price-chart-x-axis-cursor-label")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^Close$/ }));
      moveCursor(1);
      expect(screen.getByTestId("price-chart-x-axis-cursor-label")).toHaveTextContent(
        dateOnly ? /^5\/25\/26$/ : /5\/25\/26, .*\d:\d/,
      );
    },
  );

  it("loads only opened authors once and preserves the escaped author, text, and written date", async () => {
    const timestamp = "2026-05-25T10:00:00.000Z";
    const author = "a".repeat(64);
    let resolveProfile!: (profile: PublicNostrProfile | null) => void;
    fetchPublicNostrProfile.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );
    const comments = ["first", "second"].map((id) => ({
      ...makeComment(id, timestamp, makeTrade(timestamp)),
      userId: author,
      userDisplayName: "aaaaaaaa…aaaaaaaa",
    }));
    comments.push({ ...makeComment("hidden", timestamp), userId: "b".repeat(64) });
    render(
      <PriceChart
        chartTimeframe="7d"
        comments={comments}
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
          data: [{ eventOrder: timestamp, timestamp, price: 50 }],
        }}
      />,
    );
    expect(fetchPublicNostrProfile).not.toHaveBeenCalled();

    const marker = screen.getByTestId("price-chart-comment-marker");
    fireEvent.click(marker);
    expect(screen.getAllByText("aaaaaaaa…aaaaaaaa")).toHaveLength(2);
    expect(fetchPublicNostrProfile).toHaveBeenCalledExactlyOnceWith(author);
    await act(async () =>
      resolveProfile({
        pubkey: author,
        displayName: "<img src=x onerror=alert(1)>",
        avatar: "",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Price chart comments" });
    expect(dialog.querySelector("h4")).toBeNull();
    expect(dialog.querySelector("img,script")).toBeNull();
    expect(dialog).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(dialog).toHaveTextContent("Comment first");
    expect(dialog.querySelector("time")).toHaveAttribute("datetime", timestamp);
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => fireEvent.click(marker));
    expect(fetchPublicNostrProfile).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "failed"])(
    "keeps the public-key fallback when a profile is %s",
    async (result) => {
      const timestamp = "2026-05-25T10:00:00.000Z";
      if (result === "failed")
        fetchPublicNostrProfile.mockRejectedValue(new Error("relay unavailable"));
      const comment = {
        ...makeComment("public", timestamp, makeTrade(timestamp)),
        userId: "a".repeat(64),
        userDisplayName: "aaaaaaaa…aaaaaaaa",
      };
      render(
        <PriceChart
          chartTimeframe="7d"
          comments={[comment]}
          priceHistory={{
            timeframe: "7d",
            asOf: "2026-05-25T10:00:00Z",
            receivedAt: performance.now(),
            data: [{ eventOrder: timestamp, timestamp, price: 50 }],
          }}
        />,
      );
      await act(async () => fireEvent.click(screen.getByTestId("price-chart-comment-marker")));
      expect(screen.getByRole("dialog")).toHaveTextContent("aaaaaaaa…aaaaaaaa");
      expect(screen.getByRole("dialog")).not.toHaveTextContent("Verified trader");
    },
  );

  it("ignores a late profile after the visible group changes or unmounts", async () => {
    const timestamp = "2026-05-25T10:00:00.000Z";
    const later = "2026-05-25T10:00:01.000Z";
    const resolvers: Array<(profile: PublicNostrProfile | null) => void> = [];
    fetchPublicNostrProfile.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const comments = [timestamp, later].map((time, index) => ({
      ...makeComment(String(index), time, makeTrade(time)),
      userId: (index === 0 ? "a" : "b").repeat(64),
      userDisplayName: index === 0 ? "aaaaaaaa…aaaaaaaa" : "bbbbbbbb…bbbbbbbb",
    }));
    const view = render(
      <PriceChart
        chartTimeframe="7d"
        comments={comments}
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:01Z",
          receivedAt: performance.now(),
          data: [{ eventOrder: later, timestamp: later, price: 50 }],
        }}
      />,
    );
    const markers = screen.getAllByTestId("price-chart-comment-marker");
    fireEvent.click(markers[0]);
    fireEvent.click(markers[1]);
    await act(async () =>
      resolvers[0]({ pubkey: "a".repeat(64), displayName: "Previous author", avatar: "" }),
    );
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Previous author");
    expect(screen.getByRole("dialog")).toHaveTextContent("bbbbbbbb…bbbbbbbb");
    view.unmount();
    await act(async () =>
      resolvers[1]({ pubkey: "b".repeat(64), displayName: "Late author", avatar: "" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("bounds author lookups while retaining every comment and fallback", async () => {
    const timestamp = "2026-05-25T10:00:00.000Z";
    const comments = Array.from({ length: 41 }, (_, index) => ({
      ...makeComment(String(index), timestamp, makeTrade(timestamp)),
      userId: index.toString(16).padStart(64, "0"),
      userDisplayName: `Public author ${index}`,
    }));
    const view = render(
      <PriceChart
        chartTimeframe="7d"
        comments={comments}
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
          data: [{ eventOrder: timestamp, timestamp, price: 50 }],
        }}
      />,
    );
    await act(async () => fireEvent.click(screen.getByTestId("price-chart-comment-marker")));
    expect(fetchPublicNostrProfile).toHaveBeenCalledTimes(40);
    expect(screen.getByRole("dialog").querySelectorAll("li")).toHaveLength(41);
    expect(screen.getByRole("dialog")).toHaveTextContent("Public author 40");
    view.rerender(
      <PriceChart chartTimeframe="all" priceHistory={{ timeframe: "all", data: [] }} />,
    );
    const next = {
      ...makeComment("new-author", timestamp, makeTrade(timestamp)),
      userId: "f".repeat(64),
    };
    view.rerender(
      <PriceChart
        chartTimeframe="all"
        comments={[next]}
        priceHistory={{ timeframe: "all", data: [{ eventOrder: "new", timestamp, price: 50 }] }}
      />,
    );
    await act(async () => fireEvent.click(screen.getByTestId("price-chart-comment-marker")));
    expect(fetchPublicNostrProfile).toHaveBeenCalledTimes(40);
    expect(screen.getByRole("dialog")).toHaveTextContent("Trader new-author");
  });

  it("caps comment markers to the visible history window and a bounded count", () => {
    const newest = Date.parse("2026-05-25T10:00:00Z");
    const comments = Array.from({ length: 42 }, (_, index) => {
      const timestamp = new Date(newest - index * 60 * 60 * 1000).toISOString();
      return makeComment(`comment-${index}`, timestamp, makeTrade(timestamp, { price: index + 1 }));
    });
    const oldTradeTime = new Date(newest - 8 * 24 * 60 * 60 * 1000).toISOString();
    comments.push(
      makeComment(
        "outside-history-window",
        new Date(newest).toISOString(),
        makeTrade(oldTradeTime, { price: 50 }),
      ),
    );

    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: new Date(newest).toISOString(),
          receivedAt: performance.now(),
          data: [
            {
              eventOrder: new Date(newest).toISOString(),
              timestamp: new Date(newest).toISOString(),
              price: 50,
            },
          ],
        }}
        chartTimeframe="7d"
        comments={comments}
      />,
    );

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(40);
    expect(new Set(markers.map((marker) => marker.getAttribute("aria-controls")))).toHaveLength(40);
    expect(screen.getByTestId("price-chart-comment-markers-hidden")).toHaveTextContent(
      "2 comment markers are not shown.",
    );
    expect(screen.queryByText("Outside the selected period")).not.toBeInTheDocument();
    fireEvent.click(markers[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps dense right-edge comments individually accessible in a narrow chart", () => {
    chartSize.width = 240;
    const start = Date.parse("2026-05-25T10:00:00Z");
    const comments = Array.from({ length: 6 }, (_, index) => {
      const executedAt = new Date(start + index * 1000).toISOString();
      return makeComment(
        `dense-${index}`,
        executedAt,
        makeTrade(executedAt, { price: 40 + index }),
      );
    });
    render(
      <PriceChart
        chartTimeframe="all"
        comments={comments}
        priceHistory={{
          timeframe: "all",
          data: comments.map((comment, index) => ({
            eventOrder: String(index),
            timestamp: comment.trade!.executedAt,
            price: 40 + index,
          })),
        }}
      />,
    );
    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(6);
    for (const [index, marker] of markers.entries()) {
      fireEvent.click(marker);
      expect(screen.getByRole("dialog")).toHaveTextContent(`Comment dense-${index}`);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(marker).toHaveFocus();
    }
  });

  it("anchors binary YES and NO comments to exact executed prices on the YES basis", () => {
    const executedAt = "2026-05-25T10:00:00.000Z";
    const comments = [
      makeComment(
        "yes-fill",
        "2026-05-23T10:00:00.000Z",
        makeTrade(executedAt, { outcomeId: "yes", price: 35 }),
      ),
      makeComment(
        "no-fill",
        "2026-05-24T10:00:00.000Z",
        makeTrade(executedAt, { outcomeId: "no", price: 65 }),
      ),
      makeComment(
        "different-price",
        executedAt,
        makeTrade(executedAt, { outcomeId: "yes", price: 40 }),
      ),
    ];

    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
          data: [{ eventOrder: executedAt, timestamp: executedAt, price: 50 }],
        }}
        chartTimeframe="7d"
        comments={comments}
      />,
    );

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => markerCoordinate(marker)[2])).toEqual([35, 40]);
    const yesNoMarker = markers.find((marker) => markerCoordinate(marker)[2] === 35);
    expect(yesNoMarker).toHaveAccessibleName(expect.stringContaining("2 comments"));

    fireEvent.click(yesNoMarker!);
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment yes-fill");
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment no-fill");
  });

  it("keeps an open comment coordinate selected when a newer snapshot inserts an earlier group", () => {
    const firstTime = "2026-05-25T10:00:01.000Z";
    const selectedTime = "2026-05-25T10:00:02.000Z";
    const comments = [
      makeComment("first", firstTime, makeTrade(firstTime, { price: 41 })),
      makeComment("selected", selectedTime, makeTrade(selectedTime, { price: 42 })),
    ];
    const history: PriceHistory = {
      timeframe: "7d",
      asOf: "2026-05-25T10:00:02Z",
      receivedAt: performance.now(),
      data: [{ eventOrder: selectedTime, timestamp: selectedTime, price: 42 }],
    };
    const { rerender } = render(
      <PriceChart priceHistory={history} chartTimeframe="7d" comments={comments} />,
    );

    fireEvent.click(screen.getAllByTestId("price-chart-comment-marker")[1]);
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment selected");

    const insertedEarlier = makeComment(
      "inserted-earlier",
      "2026-05-25T10:00:00.000Z",
      makeTrade("2026-05-25T10:00:00.000Z", { price: 40 }),
    );
    rerender(
      <PriceChart
        priceHistory={history}
        chartTimeframe="7d"
        comments={[insertedEarlier, ...comments]}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Comment selected");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Comment first");
  });

  it("shows only in-window confirmed comments with usable history coordinates", () => {
    const latest = "2026-05-25T10:00:00.000Z";
    const validComment = makeComment(
      "valid",
      "2026-05-20T10:00:00.000Z",
      makeTrade(latest, { price: 52 }),
    );
    const comments = [
      validComment,
      makeComment("no-price", latest, null),
      makeComment("outside-window", latest, makeTrade("2026-05-17T09:59:59.000Z", { price: 48 })),
    ];
    const history: PriceHistory = {
      timeframe: "7d",
      asOf: "2026-05-25T10:00:00Z",
      receivedAt: performance.now(),
      data: [{ eventOrder: latest, timestamp: latest, price: 52 }],
    };

    const { rerender } = render(
      <PriceChart priceHistory={history} chartTimeframe="7d" comments={comments} />,
    );

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(1);
    fireEvent.click(markers[0]);
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment valid");
    expect(screen.queryByRole("dialog")).not.toHaveTextContent("Comment no-price");

    rerender(
      <PriceChart
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        comments={[validComment]}
      />,
    );
    expect(screen.queryByTestId("price-chart-comment-marker")).not.toBeInTheDocument();
    expect(screen.getByTestId("price-chart-empty-state")).toBeInTheDocument();
  });

  it("keeps categorical anchors on visible primitive series and separates outcome identity", () => {
    const executedAt = "2026-05-25T10:00:00.000Z";
    const outcomes = Array.from({ length: 9 }, (_, index) => ({
      id: `outcome-${index}`,
      label: `Outcome ${index}`,
      odds: 10,
    }));
    const outcomePriceHistories = Object.fromEntries(
      [0, 7, 8].map((index) => [
        `Outcome ${index}`,
        {
          timeframe: "7d" as const,
          data: [{ eventOrder: executedAt, timestamp: executedAt, price: 40 }],
        },
      ]),
    );
    const comments = [
      makeComment(
        "visible-zero",
        executedAt,
        makeTrade(executedAt, { outcomeId: "outcome-0", price: 40 }),
      ),
      makeComment(
        "visible-seven",
        executedAt,
        makeTrade(executedAt, { outcomeId: "outcome-7", price: 40 }),
      ),
      makeComment(
        "hidden-eight",
        executedAt,
        makeTrade(executedAt, { outcomeId: "outcome-8", price: 40 }),
      ),
      makeComment(
        "unknown-series",
        executedAt,
        makeTrade(executedAt, { outcomeId: "not-a-series", price: 40 }),
      ),
      makeComment(
        "out-of-window",
        executedAt,
        makeTrade("2026-05-17T09:59:59.000Z", { outcomeId: "outcome-0", price: 40 }),
      ),
    ];

    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: executedAt,
          receivedAt: performance.now(),
          data: [],
        }}
        chartTimeframe="7d"
        outcomes={outcomes}
        outcomePriceHistories={outcomePriceHistories}
        comments={comments}
      />,
    );

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => (marker as HTMLElement).dataset.seriesId)).toEqual([
      "outcome-0",
      "outcome-7",
    ]);
    expect(markers[0]).toHaveAccessibleName(expect.stringContaining("Outcome 0"));
    expect(markers[1]).toHaveAccessibleName(expect.stringContaining("Outcome 7"));
  });

  it("renders no synthetic numeric chart when numeric authority is disabled", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 75 },
          ],
        }}
        chartTimeframe="7d"
        currentDisplay="market.priceUnavailable"
        disabledNumeric
      />,
    );

    expect(screen.getByText("market.priceUnavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-chartjs")).not.toBeInTheDocument();
    expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
    expect(screen.queryByText("75.00%")).not.toBeInTheDocument();
  });

  it.each([undefined, "No trades yet"])(
    "uses the supplied empty state without inventing a price (%s)",
    (emptyDisplay) => {
      render(
        <PriceChart
          priceHistory={{ timeframe: "7d", data: [] }}
          chartTimeframe="7d"
          emptyDisplay={emptyDisplay}
        />,
      );

      expect(screen.getByText(emptyDisplay ?? "No data available")).toBeInTheDocument();
      expect(screen.queryByTestId("price-chart-chartjs")).not.toBeInTheDocument();
      expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
    },
  );

  it("updates the displayed history without leaving duplicate chart surfaces", () => {
    const first = { eventOrder: "001", timestamp: "2026-05-20T10:00:00Z", price: 40 };
    const { rerender } = render(
      <PriceChart chartTimeframe="all" priceHistory={{ timeframe: "all", data: [first] }} />,
    );
    rerender(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{
          timeframe: "all",
          data: [first, { eventOrder: "002", timestamp: "2026-05-21T10:00:00Z", price: 50 }],
        }}
      />,
    );
    expect(screen.getAllByTestId("price-chart-chartjs")).toHaveLength(1);
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("50.00%");
  });

  it("filters old comments when timeframe tabs change and restores them in ALL", () => {
    const latest = "2026-05-25T10:00:00Z";
    const old = "2026-01-01T00:00:00Z";
    const history: PriceHistory = {
      timeframe: "all",
      asOf: latest,
      receivedAt: 0,
      data: [
        { eventOrder: "001", timestamp: old, price: 40 },
        { eventOrder: "002", timestamp: latest, price: 50 },
      ],
    };
    const comments = [
      makeComment("old", old, makeTrade(old)),
      makeComment("latest", latest, makeTrade(latest)),
    ];
    function ControlledChart() {
      const [timeframe, setTimeframe] = useState<ChartTimeframe>("all");
      return (
        <PriceChart
          priceHistory={history}
          chartTimeframe={timeframe}
          onTimeframeChange={setTimeframe}
          comments={comments}
        />
      );
    }
    render(<ControlledChart />);
    expect(screen.getAllByTestId("price-chart-comment-marker")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("price-chart-comment-marker")[0]);
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment old");
    for (const name of ["1H", "24H", "7D", "1 Month"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getAllByTestId("price-chart-comment-marker")).toHaveLength(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "ALL" }));
    expect(screen.getAllByTestId("price-chart-comment-marker")).toHaveLength(2);
  });

  it("retains every server all point without a browser cap", () => {
    const points = Array.from({ length: 1005 }, (_, index) => ({
      eventOrder: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      price: index % 100,
    }));

    render(<PriceChart priceHistory={{ timeframe: "all", data: points }} chartTimeframe="all" />);

    const series = prepareAllSeries({
      priceHistory: { timeframe: "all", data: points },
    });
    expect(series[0].data).toHaveLength(1005);
    expect(series[0].data[0].timestampMs).toBe(Date.parse(points[0].timestamp));
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("4.00%");
  });

  it.each([
    ["1h", 3_600_000],
    ["24h", 86_400_000],
    ["7d", 604_800_000],
    ["30d", 2_592_000_000],
  ] as const)(
    "%s includes its exact cutoff and excludes earlier comments",
    (timeframe, windowMs) => {
      const latest = Date.parse("2026-05-25T10:00:00Z");
      const cutoff = new Date(latest - windowMs).toISOString();
      const expired = new Date(latest - windowMs - 1).toISOString();
      render(
        <PriceChart
          chartTimeframe={timeframe}
          priceHistory={{
            timeframe,
            asOf: new Date(latest).toISOString(),
            receivedAt: 0,
            data: [{ eventOrder: "001", timestamp: cutoff, price: 40 }],
          }}
          comments={[
            makeComment("cutoff", cutoff, makeTrade(cutoff)),
            makeComment("expired", expired, makeTrade(expired)),
          ]}
        />,
      );
      const markers = screen.getAllByTestId("price-chart-comment-marker");
      expect(markers).toHaveLength(1);
      fireEvent.click(markers[0]);
      expect(screen.getByRole("dialog")).toHaveTextContent("Comment cutoff");
      expect(screen.getByRole("dialog")).not.toHaveTextContent("Comment expired");
    },
  );

  it("removes chart and open comment content on unmount", () => {
    const timestamp = "2026-05-25T10:00:00Z";
    const { unmount } = render(
      <PriceChart
        chartTimeframe="all"
        priceHistory={{ timeframe: "all", data: [{ eventOrder: "001", timestamp, price: 40 }] }}
        comments={[makeComment("open", timestamp, makeTrade(timestamp))]}
      />,
    );
    fireEvent.click(screen.getByTestId("price-chart-comment-marker"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    unmount();
    expect(screen.queryByTestId("price-chart-chartjs")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders one latest-value pill per categorical outcome series", () => {
    render(
      <PriceChart
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        divisibility={1000}
        outcomes={[
          { id: "outcome-0", label: "Alice", odds: 330 },
          { id: "outcome-1", label: "Bob", odds: 330 },
          { id: "outcome-2", label: "Carol", odds: null },
        ]}
        outcomePriceHistories={{
          Alice: {
            timeframe: "7d",
            asOf: "2026-05-25T10:00:00Z",
            receivedAt: performance.now(),
            data: [
              { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 33 },
            ],
          },
          Bob: {
            timeframe: "7d",
            asOf: "2026-05-25T10:00:00Z",
            receivedAt: performance.now(),
            data: [
              { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 28 },
            ],
          },
        }}
      />,
    );

    const pills = screen.getAllByTestId("latest-price-pill");
    expect(pills).toHaveLength(3);
    expect(pills[0]).toHaveTextContent("Alice");
    expect(pills[0]).toHaveTextContent("33.00%");
    expect(pills[1]).toHaveTextContent("Bob");
    expect(pills[1]).toHaveTextContent("33.00%");
    expect(pills[2]).toHaveTextContent("CarolNo trades yet");
  });

  it("keeps independent categorical histories and never prices a future trade at the cursor", () => {
    const histories: Record<string, PriceHistory> = {
      Alice: {
        timeframe: "all",
        data: [
          { eventOrder: "a1", timestamp: "2026-05-25T10:00:00Z", price: 20 },
          { eventOrder: "a2", timestamp: "2026-05-25T12:00:00Z", price: 22 },
        ],
      },
      Bob: {
        timeframe: "all",
        data: [{ eventOrder: "b1", timestamp: "2026-05-25T11:00:00Z", price: 78 }],
      },
    };
    render(
      <PriceChart
        priceHistory={{ timeframe: "all", data: [] }}
        chartTimeframe="all"
        outcomes={[
          { id: "alice", label: "Alice", odds: 20, color: "#112233" },
          { id: "bob", label: "Bob", odds: 80, color: "#AABBCC" },
          { id: "carol", label: "Carol", odds: 0, color: "#334455" },
        ]}
        outcomePriceHistories={histories}
      />,
    );
    moveCursor(0.25);
    const pills = screen.getAllByTestId("latest-price-pill");
    expect(pills).toHaveLength(3);
    expect(pills[0]).toHaveTextContent("Alice20.00%");
    expect(pills[1]).toHaveTextContent("BobPrice unavailable");
    expect(pills[2]).toHaveTextContent("CarolPrice unavailable");
    expect(pills[0].querySelector('[data-testid="outcome-color-swatch"]')).toHaveStyle({
      backgroundColor: "#112233",
    });
    moveCursor(0.75);
    expect(pills[0]).toHaveTextContent("Alice20.00%");
    expect(pills[1]).toHaveTextContent("Bob78.00%");
    expect(pills[2]).toHaveTextContent("CarolPrice unavailable");
    expect(screen.queryByTestId("price-chart-cursor-tooltip")).not.toBeInTheDocument();
    expect(screen.getByTestId("price-chart-x-axis-cursor-label")).toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
  });

  it("keeps each categorical series and legend accent bound to exact outcome identity", () => {
    const outcomes = [
      { id: "bob", label: "Bob", odds: 28, color: "#AABBCC" },
      { id: "alice", label: "Alice", odds: 33, color: "#112233" },
    ];
    const histories = {
      Bob: {
        timeframe: "7d" as const,
        data: [
          { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 28 },
        ],
      },
      Alice: {
        timeframe: "7d" as const,
        data: [
          { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 33 },
        ],
      },
    };
    const { rerender } = render(
      <PriceChart
        priceHistory={{ timeframe: "all", data: [] }}
        chartTimeframe="all"
        outcomes={outcomes}
        outcomePriceHistories={histories}
      />,
    );
    const seriesByLabel = (orderedOutcomes: typeof outcomes) =>
      new Map(
        prepareAllSeries({
          priceHistory: { timeframe: "all", data: [] },
          outcomes: orderedOutcomes,
          outcomePriceHistories: histories,
        }).map((series) => [series.label, series.color]),
      );
    expect(seriesByLabel(outcomes)).toEqual(
      new Map([
        ["Bob", "#AABBCC"],
        ["Alice", "#112233"],
      ]),
    );
    expect(nativeChart().data.datasets.map((dataset) => dataset.borderColor)).toEqual([
      "#AABBCC",
      "#112233",
    ]);
    expect(
      paintedStrokeColors
        .filter((color) => color === "#AABBCC" || color === "#112233")
        .filter((color, index, colors) => index === 0 || color !== colors[index - 1])
        .slice(-2),
    ).toEqual(["#AABBCC", "#112233"]);
    expect(
      document.querySelectorAll('[data-outcome-label="Bob"] [data-testid="outcome-color-swatch"]'),
    ).toHaveLength(2);
    for (const swatch of document.querySelectorAll(
      '[data-outcome-label="Bob"] [data-testid="outcome-color-swatch"]',
    )) {
      expect(swatch).toHaveStyle({ backgroundColor: "#AABBCC" });
    }

    rerender(
      <PriceChart
        priceHistory={{ timeframe: "all", data: [] }}
        chartTimeframe="all"
        outcomes={[...outcomes].reverse()}
        outcomePriceHistories={histories}
      />,
    );
    expect(nativeChart().data.datasets.map((dataset) => dataset.borderColor)).toEqual([
      "#112233",
      "#AABBCC",
    ]);
    expect(
      paintedStrokeColors
        .filter((color) => color === "#AABBCC" || color === "#112233")
        .filter((color, index, colors) => index === 0 || color !== colors[index - 1])
        .slice(-2),
    ).toEqual(["#112233", "#AABBCC"]);
    expect(seriesByLabel([...outcomes].reverse())).toEqual(
      new Map([
        ["Alice", "#112233"],
        ["Bob", "#AABBCC"],
      ]),
    );
  });
  describe("linked confirmed fill marker ranking", () => {
    const asOf = "2026-05-25T10:00:00Z";
    const executedAt = (secondsAgo: number) =>
      new Date(Date.parse(asOf) - secondsAgo * 1000).toISOString();
    const comment = (
      id: string,
      secondsAgo: number,
      size?: number | null,
      options: { outcomeId?: string; price?: number; fillId?: string } = {},
    ) =>
      makeComment(
        id,
        executedAt(secondsAgo),
        makeTrade(executedAt(secondsAgo), {
          ...options,
          faceAmountSubunits: size,
        }),
      );
    const history: PriceHistory = {
      timeframe: "7d",
      asOf,
      receivedAt: 0,
      data: [{ eventOrder: "opaque", timestamp: asOf, price: 50 }],
    };
    const coordinates = () =>
      screen
        .getAllByTestId("price-chart-comment-marker")
        .map(
          (marker) =>
            JSON.parse(
              decodeURIComponent(
                marker.getAttribute("aria-controls")!.slice("price-chart-comments-".length),
              ),
            ) as [string, number, number],
        );

    it("selects old large fills over new small fills and duplicate-comment spam without changing the retained list", () => {
      const ordinary = Array.from({ length: 39 }, (_, index) =>
        comment(`normal-${index}`, index, 100),
      );
      const large = comment("old-large", 60, 1000);
      const spam = Array.from({ length: 150 }, (_, index) => comment(`spam-${index}`, 40, 1));
      const unknown = comment("unknown-size", 0.5, null);
      const comments = [...ordinary, large, ...spam, unknown];
      render(<PriceChart priceHistory={history} chartTimeframe="7d" comments={comments} />);
      const selected = coordinates();
      expect(selected).toHaveLength(40);
      expect(selected.map((coordinate) => coordinate[1])).toEqual([
        Date.parse(large.trade!.executedAt),
        ...ordinary
          .slice()
          .reverse()
          .map((item) => Date.parse(item.trade!.executedAt)),
      ]);
      expect(screen.getByTestId("price-chart-comment-markers-hidden")).toHaveTextContent(
        "2 comment markers are not shown.",
      );
      expect(comments).toHaveLength(191);
      expect(comments.filter((item) => item.id.startsWith("spam-"))).toHaveLength(150);
    });

    it("uses the largest linked fill in each coordinate and keeps stable equal-size ties", () => {
      const comments = Array.from({ length: 42 }, (_, index) =>
        comment(`tie-${index}`, 0, 100, { price: index + 1 }),
      );
      // The same coordinate contains different fills. Their sizes do not add.
      comments.push(
        comment("largest-in-group", 0, 1000, {
          price: 9,
          fillId: "00000000-0000-0000-0000-000000000002",
        }),
      );
      const view = render(
        <PriceChart priceHistory={history} chartTimeframe="7d" comments={comments} />,
      );
      const selected = coordinates();
      expect(selected).toHaveLength(40);
      expect(selected.some((coordinate) => Math.round(coordinate[2]) === 9)).toBe(true);
      expect(selected.some((coordinate) => Math.round(coordinate[2]) === 8)).toBe(false);
      expect(selected.some((coordinate) => Math.round(coordinate[2]) === 7)).toBe(false);
      view.rerender(
        <PriceChart
          priceHistory={history}
          chartTimeframe="7d"
          comments={[...comments].reverse()}
        />,
      );
      expect(coordinates()).toEqual(selected);
      const groupedMarker = screen
        .getAllByTestId("price-chart-comment-marker")
        .find(
          (marker) =>
            JSON.parse(
              decodeURIComponent(
                marker.getAttribute("aria-controls")!.slice("price-chart-comments-".length),
              ),
            )[2] === 9,
        )!;
      fireEvent.click(groupedMarker);
      expect(screen.getByRole("dialog").querySelectorAll("li")).toHaveLength(2);
      expect(screen.getByRole("dialog")).toHaveTextContent("largest-in-group");
    });

    it.each(["Yes", "No"])(
      "ranks %s by the same linked fill size despite chart price inversion",
      (outcomeId) => {
        const comments = Array.from({ length: 40 }, (_, index) =>
          comment(`small-${index}`, index, 100),
        );
        const large = comment("large-selected-token-fill", 60, 1000, { outcomeId, price: 25 });
        comments.push(large);
        render(<PriceChart priceHistory={history} chartTimeframe="7d" comments={comments} />);
        const selected = coordinates();
        expect(selected).toHaveLength(40);
        expect(selected[0]).toEqual([
          "primary",
          Date.parse(large.trade!.executedAt),
          outcomeId === "Yes" ? 25 : 75,
        ]);
        expect(selected.some((coordinate) => coordinate[1] === Date.parse(executedAt(39)))).toBe(
          false,
        );
      },
    );

    it("filters unpriced outcomes and out-of-window coordinates before applying the marker bound", () => {
      const comments = Array.from({ length: 39 }, (_, index) =>
        comment(`visible-${index}`, index, 10, { outcomeId: "A" }),
      );
      const large = comment("visible-large", 60, 100, { outcomeId: "A" });
      comments.push(
        large,
        comment("unpriced-b", 61, 1_000_000, { outcomeId: "B" }),
        comment("hidden-complement", 62, 1_000_000, { outcomeId: "B|C" }),
        comment("expired-large", 7 * 86400 + 1, 1_000_000, { outcomeId: "A" }),
        comment("future-large", -1, 1_000_000, { outcomeId: "A" }),
      );
      render(
        <PriceChart
          priceHistory={history}
          chartTimeframe="7d"
          comments={comments}
          outcomes={[
            { id: "A", label: "A", odds: null },
            { id: "B", label: "B", odds: null },
          ]}
          outcomePriceHistories={{ A: history, B: { ...history, data: [] } }}
        />,
      );
      const selected = coordinates();
      expect(selected).toHaveLength(40);
      expect(selected.every((coordinate) => coordinate[0] === "A")).toBe(true);
      expect(selected[0][1]).toBe(Date.parse(large.trade!.executedAt));
      expect(screen.queryByTestId("price-chart-comment-markers-hidden")).not.toBeInTheDocument();
    });
  });
});

describe("server-clock rolling expiry", () => {
  let pendingFrames: Map<number, FrameRequestCallback>;
  let cancelFrame: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pendingFrames = new Map();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pendingFrames.set(++nextFrame, callback);
      return nextFrame;
    });
    cancelFrame = vi.fn((id: number) => pendingFrames.delete(id));
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  });

  function renderPendingFrame() {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    act(() => callbacks.forEach((callback) => callback(performance.now())));
  }

  it("removes clustered expired fills together and renders the final expiry", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const asOf = Date.parse("2026-05-25T10:00:00Z");
    const data = [0, 1, 2, 10].map((offset, index) => ({
      eventOrder: String(index),
      timestamp: new Date(asOf - 3_600_000 + offset).toISOString(),
      price: 30 + index * 10,
    }));
    const view = render(
      <PriceChart
        chartTimeframe="1h"
        priceHistory={{
          timeframe: "1h",
          asOf: new Date(asOf).toISOString(),
          receivedAt: performance.now(),
          data,
        }}
        comments={data.map((point) =>
          makeComment(
            point.eventOrder,
            point.timestamp,
            makeTrade(point.timestamp, { price: point.price }),
          ),
        )}
      />,
    );
    try {
      renderPendingFrame();
      expect(screen.getAllByTestId("price-chart-comment-marker")).toHaveLength(4);
      expect(pendingFrames.size).toBe(0);
      act(() => vi.advanceTimersByTime(1));
      expect(pendingFrames.size).toBe(1);
      act(() => vi.advanceTimersByTime(2));
      expect(pendingFrames.size).toBe(1);
      renderPendingFrame();
      expect(screen.getAllByTestId("price-chart-comment-marker")).toHaveLength(1);
      expect(nativeChart().data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(1);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("60.00%");
      renderPendingFrame();

      act(() => vi.advanceTimersByTime(7));
      expect(pendingFrames.size).toBe(0);
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("60.00%");
      act(() => vi.advanceTimersByTime(1));
      expect(pendingFrames.size).toBe(1);
      renderPendingFrame();
      expect(screen.getByTestId("price-chart-empty-state")).toBeInTheDocument();
      expect(screen.queryByTestId("price-chart-comment-marker")).not.toBeInTheDocument();
      expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it.each(["history", "timeframe", "unmount"] as const)(
    "cancels a pending expiry frame on %s changes",
    (change) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const asOf = Date.parse("2026-05-25T10:00:00Z");
      const history: PriceHistory = {
        timeframe: "1h",
        asOf: new Date(asOf).toISOString(),
        receivedAt: performance.now(),
        data: [
          { eventOrder: "old", timestamp: new Date(asOf - 3_600_000).toISOString(), price: 40 },
        ],
      };
      const view = render(<PriceChart priceHistory={history} chartTimeframe="1h" />);
      try {
        renderPendingFrame();
        act(() => vi.advanceTimersByTime(1));
        expect(pendingFrames.size).toBe(1);
        const frameId = [...pendingFrames.keys()][0];
        if (change === "unmount") {
          view.unmount();
        } else if (change === "timeframe") {
          view.rerender(<PriceChart priceHistory={history} chartTimeframe="all" />);
        } else {
          view.rerender(
            <PriceChart
              chartTimeframe="1h"
              priceHistory={{
                ...history,
                receivedAt: performance.now(),
                data: [{ eventOrder: "new", timestamp: new Date(asOf).toISOString(), price: 52 }],
              }}
            />,
          );
        }
        expect(cancelFrame).toHaveBeenCalledWith(frameId);
        expect(pendingFrames.has(frameId)).toBe(false);
        renderPendingFrame();
        if (change === "unmount") {
          expect(screen.queryByTestId("price-chart-region")).not.toBeInTheDocument();
        } else {
          expect(screen.getByTestId("latest-price-pill")).toHaveTextContent(
            change === "history" ? "52.00%" : "40.00%",
          );
        }
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    },
  );

  it("shows the new fill after an open comment expires through an empty chart", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const asOf = Date.parse("2026-05-25T10:00:00Z");
    const timestamp = new Date(asOf - 3_600_000).toISOString();
    const history: PriceHistory = {
      timeframe: "1h",
      asOf: new Date(asOf).toISOString(),
      receivedAt: performance.now(),
      data: [{ eventOrder: "first", timestamp, price: 40 }],
    };
    const comments = [makeComment("expired", timestamp, makeTrade(timestamp, { price: 40 }))];
    const view = render(
      <PriceChart priceHistory={history} chartTimeframe="1h" comments={comments} />,
    );
    try {
      fireEvent.click(screen.getByTestId("price-chart-comment-marker"));
      expect(screen.getByRole("dialog")).toHaveTextContent("Comment expired");
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("40.00%");
      act(() => vi.advanceTimersByTime(1));
      renderPendingFrame();
      expect(screen.getByTestId("price-chart-empty-state")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      const newTime = new Date(asOf + 1000).toISOString();
      view.rerender(
        <PriceChart
          chartTimeframe="1h"
          comments={comments}
          priceHistory={{
            timeframe: "1h",
            asOf: newTime,
            receivedAt: performance.now(),
            data: [{ eventOrder: "new", timestamp: newTime, price: 52 }],
          }}
        />,
      );
      expect(screen.queryByTestId("price-chart-empty-state")).not.toBeInTheDocument();
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("52.00%");
      expect(screen.queryByTestId("price-chart-x-axis-cursor-label")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("removes an expired hover value while a later confirmed point remains", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    chartSize.width = 400;
    const asOf = Date.parse("2026-05-25T10:00:00Z");
    const first = {
      eventOrder: "opaque",
      timestamp: new Date(asOf - 3_600_000).toISOString(),
      price: 40,
    };
    const history: PriceHistory = {
      timeframe: "1h",
      asOf: new Date(asOf).toISOString(),
      receivedAt: performance.now(),
      data: [
        first,
        { ...first, timestamp: new Date(asOf - 3_600_000 + 5000).toISOString(), price: 50 },
      ],
    };
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const view = render(<PriceChart priceHistory={history} chartTimeframe="1h" />);
    let pendingExpiry: ReturnType<typeof setTimeout> | undefined;
    try {
      moveCursor(0);
      expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("40.00%");
      act(() => vi.advanceTimersByTime(1));
      renderPendingFrame();
      expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("Price unavailable");
      leaveCursor();
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("50.00%");
      const index = scheduled.mock.calls.findIndex(([, delay]) => delay === 5000);
      expect(index).toBeGreaterThanOrEqual(0);
      pendingExpiry = scheduled.mock.results[index].value;
    } finally {
      view.unmount();
      try {
        if (pendingExpiry !== undefined) expect(cleared).toHaveBeenCalledWith(pendingExpiry);
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    }
  });

  it.each(["1h", "24h", "7d", "30d"] as const)(
    "%s expires the inclusive cutoff without requests and cancels scheduled expiry",
    (timeframe) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
      const windowMs = {
        "1h": 3_600_000,
        "24h": 86_400_000,
        "7d": 604_800_000,
        "30d": 2_592_000_000,
      }[timeframe];
      const asOf = Date.parse("2026-05-25T10:00:00Z");
      const point = {
        eventOrder: "opaque",
        timestamp: new Date(asOf - windowMs).toISOString(),
        price: 40,
      };
      const history: PriceHistory = {
        timeframe,
        asOf: new Date(asOf).toISOString(),
        receivedAt: performance.now(),
        data: [point],
      };
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const scheduled = vi.spyOn(globalThis, "setTimeout");
      const cleared = vi.spyOn(globalThis, "clearTimeout");
      const view = render(<PriceChart priceHistory={history} chartTimeframe={timeframe} />);
      try {
        expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("40.00%");
        act(() => vi.advanceTimersByTime(1));
        renderPendingFrame();
        expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
        expect(screen.getByTestId("price-chart-empty-state")).toBeInTheDocument();
        expect(fetchSpy).not.toHaveBeenCalled();
        const pendingHistory: PriceHistory = {
          ...history,
          receivedAt: performance.now(),
          data: [{ ...point, timestamp: new Date(asOf - windowMs + 5000).toISOString() }],
        };
        view.rerender(<PriceChart priceHistory={pendingHistory} chartTimeframe={timeframe} />);
        const expiryIndex = scheduled.mock.calls.findIndex(([, delay]) => delay === 5001);
        expect(expiryIndex).toBeGreaterThanOrEqual(0);
        const expiry = scheduled.mock.results[expiryIndex].value;
        view.rerender(
          <PriceChart priceHistory={{ timeframe: "all", data: [point] }} chartTimeframe="all" />,
        );
        expect(cleared).toHaveBeenCalledWith(expiry);
        scheduled.mockClear();
        view.rerender(<PriceChart priceHistory={pendingHistory} chartTimeframe={timeframe} />);
        const unmountExpiryIndex = scheduled.mock.calls.findIndex(([, delay]) => delay === 5001);
        expect(unmountExpiryIndex).toBeGreaterThanOrEqual(0);
        const unmountExpiry = scheduled.mock.results[unmountExpiryIndex].value;
        view.unmount();
        expect(cleared).toHaveBeenCalledWith(unmountExpiry);
      } finally {
        view.unmount();
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );
});

describe("chart data identity", () => {
  it("reuses prepared points across the inclusive cutoff and its next millisecond", () => {
    const cutoff = Date.parse("2026-05-25T10:00:00.123Z");
    const evaluationMs = cutoff + 3_600_000;
    const prepared = preparePriceSeries({
      priceHistory: {
        timeframe: "1h",
        data: [-1, 0, 1].map((offset) => ({
          eventOrder: String(offset + 2).padStart(3, "0"),
          timestamp: new Date(cutoff + offset).toISOString(),
          price: 50 + offset,
        })),
      },
    });
    expect(windowPriceSeries(prepared, "1h", evaluationMs - 1)[0]).toBe(prepared[0]);

    const atCutoff = windowPriceSeries(prepared, "1h", evaluationMs);
    expect(atCutoff[0].data).toHaveLength(2);
    expect(atCutoff[0].data[0]).toBe(prepared[0].data[1]);
    expect(atCutoff[0].data[1]).toBe(prepared[0].data[2]);

    const afterCutoff = windowPriceSeries(prepared, "1h", evaluationMs + 1);
    expect(afterCutoff[0].data).toHaveLength(1);
    expect(afterCutoff[0].data[0]).toBe(prepared[0].data[2]);
    expect(prepared[0].data).toHaveLength(3);
  });

  it("retains exact milliseconds and distinct fills at the same timestamp", () => {
    const data = [
      { eventOrder: "001", timestamp: "2026-05-25T10:00:00.123Z", price: 35 },
      { eventOrder: "002", timestamp: "2026-05-25T10:00:00.123Z", price: 45 },
      { eventOrder: "003", timestamp: "2026-05-25T10:00:00.124Z", price: 55 },
    ];
    const series = prepareAllSeries({
      priceHistory: { timeframe: "all", data },
    });
    expect(
      series[0].data.map((point) => [point.timestampMs, point.eventOrder, point.price]),
    ).toEqual([
      [1_779_703_200_123, "001", 35],
      [1_779_703_200_123, "002", 45],
      [1_779_703_200_124, "003", 55],
    ]);
    expect(chartDomain(series, "all", null)).toEqual({
      min: 1_779_703_200_123,
      max: 1_779_703_200_124,
    });
  });

  it("keeps disjoint categorical timestamps in their own series without null alignment rows", () => {
    const series = prepareAllSeries({
      priceHistory: { timeframe: "all", data: [] },
      outcomes: [
        { id: "a", label: "A", odds: null },
        { id: "b", label: "B", odds: null },
      ],
      outcomePriceHistories: {
        A: {
          timeframe: "all",
          data: [{ eventOrder: "a", timestamp: "2026-05-25T10:00:00.123Z", price: 30 }],
        },
        B: {
          timeframe: "all",
          data: [{ eventOrder: "b", timestamp: "2026-05-25T10:00:00.124Z", price: 70 }],
        },
      },
    });
    expect(series.map((item) => [item.id, item.data.length, item.data[0].eventOrder])).toEqual([
      ["a", 1, "a"],
      ["b", 1, "b"],
    ]);
  });
});

describe("price history freshness presentation", () => {
  it.each(["refreshing", "unavailable"] as const)(
    "keeps confirmed chart data during %s",
    (historyStatus) => {
      render(
        <PriceChart
          priceHistory={{
            timeframe: "all",
            data: [
              {
                eventOrder: "confirmed",
                timestamp: "2026-10-08T12:00:00Z",
                price: 42,
              },
            ],
          }}
          chartTimeframe="all"
          historyStatus={historyStatus}
        />,
      );
      expect(screen.getByTestId("price-chart-canvas")).toBeInTheDocument();
      expect(screen.queryByTestId("price-chart-empty-state")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        historyStatus === "refreshing" ? "Updating price history" : "Price refresh unavailable",
      );
    },
  );

  it.each([
    ["loading", true, "Loading price history"],
    ["unavailable", true, "Price unavailable"],
    ["ready", true, "No trades in this period"],
    ["ready", false, "No trades yet"],
  ] as const)(
    "separates empty history %s with traded=%s",
    (historyStatus, hasConfirmedTrades, text) => {
      render(
        <PriceChart
          priceHistory={{ timeframe: "1h", data: [] }}
          chartTimeframe="1h"
          historyStatus={historyStatus}
          hasConfirmedTrades={hasConfirmedTrades}
        />,
      );
      expect(screen.getByTestId("price-chart-empty-state")).toHaveTextContent(text);
      expect(screen.queryByTestId("price-chart-canvas")).not.toBeInTheDocument();
    },
  );

  it("shows current categorical prices without manufacturing history for an empty period", () => {
    render(
      <PriceChart
        priceHistory={{ timeframe: "1h", data: [] }}
        chartTimeframe="1h"
        historyStatus="ready"
        hasConfirmedTrades
        divisibility={1000}
        outcomePriceHistories={{}}
        outcomes={[
          { id: "a", label: "Alice", odds: 420 },
          { id: "b", label: "Bob", odds: null },
        ]}
      />,
    );
    expect(screen.getByTestId("price-chart-empty-state")).toHaveTextContent(
      "No trades in this period",
    );
    expect(screen.getAllByTestId("latest-price-pill")[0]).toHaveTextContent("Alice42.00%");
    expect(screen.getAllByTestId("latest-price-pill")[1]).toHaveTextContent("BobNo trades yet");
    expect(screen.queryByTestId("price-chart-canvas")).not.toBeInTheDocument();
  });
});

it("shows a validated categorical price without treating unknown outcomes as never traded", () => {
  render(
    <PriceChart
      priceHistory={{ timeframe: "1h", data: [] }}
      chartTimeframe="1h"
      divisibility={1000}
      priceAuthorityUnavailable
      outcomePriceHistories={{}}
      outcomes={[
        { id: "a", label: "A", odds: 420 },
        { id: "b", label: "B", odds: null },
        { id: "c", label: "C", odds: null },
      ]}
    />,
  );

  const pills = screen.getAllByTestId("latest-price-pill");
  expect(pills[0]).toHaveTextContent("A42.00%");
  expect(pills[1]).toHaveTextContent("BPrice unavailable");
  expect(pills[2]).toHaveTextContent("CPrice unavailable");
  expect(screen.queryByText("No trades yet")).not.toBeInTheDocument();
});
