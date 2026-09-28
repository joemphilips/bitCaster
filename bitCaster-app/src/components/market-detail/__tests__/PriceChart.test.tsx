import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { PriceChart } from "../PriceChart";
import type { ChartTimeframe, Comment, PriceHistory } from "@/types/market-detail";

const plotInstances = vi.hoisted(
  () =>
    [] as Array<{
      setData: ReturnType<typeof vi.fn>;
      setSize: ReturnType<typeof vi.fn>;
      setScale: ReturnType<typeof vi.fn>;
      setCursor: (position: { left: number; top: number }) => void;
      posToVal: (position: number, scale: string) => number;
      valToPos: (value: number, scale: string) => number;
      destroy: ReturnType<typeof vi.fn>;
      options: { scales?: { x?: { min?: number; max?: number } } };
      data: unknown;
      over: HTMLDivElement;
    }>,
);

vi.mock("uplot", () => {
  class MockUPlot {
    setData = vi.fn();
    setSize = vi.fn();
    setScale = vi.fn();
    destroy = vi.fn();
    setCursor = vi.fn((position: { left: number; top: number }) => {
      this.cursor = { ...position, idx: 0 };
      this.callHook("setCursor");
    });
    posToVal = vi.fn((position: number, scale: string) =>
      scale === "x" ? 1_777_000_000 + position : 50 + position / 10,
    );
    valToPos = vi.fn((value: number, scale: string) => (scale === "x" ? value % 100 : value));
    options: { scales?: { x?: { min?: number; max?: number } }; hooks?: Record<string, unknown> };
    data: unknown;
    cursor: { left: number; top: number; idx: number | null } = { left: -10, top: -10, idx: null };
    over = document.createElement("div");

    constructor(options: unknown, data: unknown, container: HTMLElement) {
      this.options = options as {
        scales?: { x?: { min?: number; max?: number } };
        hooks?: Record<string, unknown>;
      };
      this.data = data;
      plotInstances.push(this);
      container.appendChild(document.createElement("canvas"));
      this.over.className = "u-over";
      Object.defineProperties(this.over, {
        clientWidth: { configurable: true, value: 300 },
        clientHeight: { configurable: true, value: 160 },
      });
      this.over.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 20, y: 24, width: 300, height: 160 });
      container.appendChild(this.over);
    }

    private callHook(name: string) {
      const hook = this.options.hooks?.[name];
      if (Array.isArray(hook)) {
        for (const callback of hook) {
          if (typeof callback === "function") callback(this);
        }
      } else if (typeof hook === "function") {
        hook(this);
      }
    }
  }
  return {
    default: Object.assign(MockUPlot, {
      paths: {
        stepped: vi.fn(() => "stepped-paths"),
      },
    }),
  };
});

describe("PriceChart", () => {
  beforeEach(() => {
    plotInstances.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a uPlot chart with fixed probability axis labels", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 40 },
            { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 55 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );

    expect(screen.getByTestId("price-chart-uplot")).toBeInTheDocument();
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("55.00%");
    expect(plotInstances).toHaveLength(1);
    const options = plotInstances[0].options as {
      axes: Array<{
        size?: number;
        splits?: () => number[];
        values?: (_u: unknown, values: number[]) => string[];
      }>;
    };
    expect(options.axes[1].splits?.()).toEqual([0, 50, 100]);
    expect(options.axes[1].values?.({}, [0, 50, 100])).toEqual(["0.00%", "50.00%", "100.00%"]);
    expect(options.axes[1].size).toBe(64);
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
          data: [buyPoint],
        }}
        chartTimeframe="7d"
        currentDisplay="51.0%"
      />,
    );

    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("51.00%");
    expect(screen.getByText("51.0%", { exact: true })).toBeInTheDocument();
    const setData = plotInstances[0]?.setData;
    expect(setData).toBeDefined();
    const setDataCallsBeforeSell = setData?.mock.calls.length ?? 0;

    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [buyPoint, sellPoint],
        }}
        chartTimeframe="7d"
        currentDisplay="49.0%"
      />,
    );

    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("49.00%");
    expect(screen.getByText("49.0%", { exact: true })).toBeInTheDocument();
    expect(plotInstances).toHaveLength(1);
    expect(setData).toHaveBeenCalledTimes(setDataCallsBeforeSell + 1);
  });

  it("distinguishes the cursor-axis coordinate from the sampled confirmed price", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 46 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );

    const plot = plotInstances[0];
    act(() => plot.setCursor({ left: 40, top: 25 }));

    const tooltip = screen.getByTestId("price-chart-cursor-tooltip");
    expect(tooltip).toHaveTextContent("Cursor-axis price: 52.50%");
    expect(tooltip).toHaveTextContent("Sampled price: 46.00%");
    expect(tooltip).toHaveTextContent("Sample time:");
    const xAxisLabel = screen.getByTestId("price-chart-x-axis-cursor-label");
    const yAxisLabel = screen.getByTestId("price-chart-y-axis-cursor-label");
    expect(xAxisLabel).toHaveClass("pointer-events-none");
    expect(yAxisLabel).toHaveClass("pointer-events-none");
    expect(yAxisLabel).toHaveTextContent("52.50%");
    expect(plot.posToVal).toHaveBeenCalledWith(40, "x");
    expect(plot.posToVal).toHaveBeenCalledWith(25, "y");
    expect(plot.valToPos).toHaveBeenCalledWith(1_777_000_040, "x");
    expect(plot.valToPos).toHaveBeenCalledWith(52.5, "y");
  });

  it("groups comments by timestamp and opens a bounded escaped keyboard-accessible list", () => {
    const timestamp = "2026-05-25T10:00:00.000Z";
    const comments: Comment[] = Array.from({ length: 12 }, (_, index) => ({
      id: `comment-${index}`,
      userId: `user-${index}`,
      userDisplayName: index === 0 ? "<img src=x onerror=alert(1)>" : `Trader ${index}`,
      content: index === 0 ? "<script>alert(1)</script>" : `Comment ${index}`,
      timestamp,
      likeCount: 0,
      isLiked: false,
    }));
    comments.push({
      id: "comment-next-second",
      userId: "user-next-second",
      userDisplayName: "Other trader",
      content: "Another time group",
      timestamp: "2026-05-25T10:00:01.000Z",
      likeCount: 0,
      isLiked: false,
    });
    const { unmount } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
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
    fireEvent.focus(markers[0]);

    const dialog = screen.getByRole("dialog");
    const heading = dialog.querySelector("h4");
    expect(heading?.textContent).toContain("5/25/26");
    expect(heading?.textContent).not.toContain("&#x2F;");
    expect(dialog).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(dialog).toHaveTextContent("<script>alert(1)</script>");
    expect(dialog.querySelector("img,script")).toBeNull();
    expect(dialog.querySelectorAll("li")).toHaveLength(12);
    expect(dialog.style.maxHeight).toBe("176px");
    const scrollContainer = dialog.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeInTheDocument();
    expect(scrollContainer).toHaveAttribute("role", "region");
    expect(scrollContainer).toHaveAttribute("tabindex", "0");
    expect(scrollContainer).toHaveAccessibleName(/Comments at/);
    expect(scrollContainer).toHaveClass("focus-visible:ring-2");
    expect(scrollContainer).toContainElement(screen.getByText("Comment 11"));
    (scrollContainer as HTMLElement).focus();
    expect(scrollContainer).toHaveFocus();
    expect(screen.getByTestId("price-chart-cursor-tooltip")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("price-chart-x-axis-cursor-label")).toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();

    const expectedMarkerX = Math.floor(Date.parse(timestamp) / 1000) % 100;
    expect(plotInstances[0].setCursor).toHaveBeenCalledWith({ left: expectedMarkerX, top: 80 });
    fireEvent.click(markers[1]);
    expect(dialog).toHaveTextContent("Another time group");
    expect(plotInstances[0].setCursor).toHaveBeenLastCalledWith({
      left: expectedMarkerX + 1,
      top: 80,
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(markers[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(markers[0]);
    const removeListener = vi.spyOn(document, "removeEventListener");
    const plot = plotInstances[0];

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
    expect(plot.destroy).toHaveBeenCalled();
    removeListener.mockRestore();
  });

  it("caps comment markers to the visible history window and a bounded count", () => {
    const newest = Date.parse("2026-05-25T10:00:00Z");
    const comments = Array.from({ length: 42 }, (_, index) => {
      const timestamp = new Date(newest - index * 60 * 60 * 1000).toISOString();
      return {
        id: `comment-${index}`,
        userId: `user-${index}`,
        userDisplayName: `Trader ${index}`,
        content: `Comment ${index}`,
        timestamp,
        likeCount: 0,
        isLiked: false,
      };
    });
    comments.push({
      id: "outside-history-window",
      userId: "user-old",
      userDisplayName: "Old trader",
      content: "Outside the selected period",
      timestamp: new Date(newest - 8 * 24 * 60 * 60 * 1000).toISOString(),
      likeCount: 0,
      isLiked: false,
    });

    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
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
    expect(markers).toHaveLength(4);
    expect(new Set(markers.map((marker) => (marker as HTMLElement).style.top))).toHaveLength(4);
    expect(screen.getByTestId("price-chart-comment-markers-hidden")).toHaveTextContent(
      "2 earlier comment times are not shown.",
    );
    expect(screen.queryByText("Outside the selected period")).not.toBeInTheDocument();
    fireEvent.click(markers[0]);
    expect(screen.getAllByTestId("price-chart-comment-time-choice")).toHaveLength(37);
  });

  it("keeps a dense right-edge marker and its popover reachable in a narrow chart", () => {
    const start = Date.parse("2026-05-25T10:00:00Z");
    const comments: Comment[] = Array.from({ length: 6 }, (_, index) => ({
      id: `dense-comment-${index}`,
      userId: `dense-user-${index}`,
      userDisplayName: `Dense trader ${index}`,
      content: `Dense comment ${index}`,
      timestamp: new Date(start + index * 1000).toISOString(),
      likeCount: 0,
      isLiked: false,
    }));
    const history: PriceHistory = {
      timeframe: "7d",
      data: [
        {
          eventOrder: new Date(start + 10_000).toISOString(),
          timestamp: new Date(start + 10_000).toISOString(),
          price: 50,
        },
      ],
    };
    const { rerender } = render(
      <PriceChart priceHistory={history} chartTimeframe="7d" comments={comments} />,
    );

    const region = screen.getByTestId("price-chart-region");
    Object.defineProperties(region, {
      clientWidth: { configurable: true, value: 240 },
      clientHeight: { configurable: true, value: 224 },
    });
    region.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 240, height: 224 });
    const plot = plotInstances[0];
    const valToPosMock = plot.valToPos as unknown as {
      mockImplementation: (implementation: (value: number, scale: string) => number) => void;
    };
    valToPosMock.mockImplementation((value, scale) =>
      scale === "x" ? 500 + value - start / 1000 : value,
    );
    rerender(<PriceChart priceHistory={history} chartTimeframe="7d" comments={[...comments]} />);

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(4);
    expect(new Set(markers.map((marker) => (marker as HTMLElement).style.top))).toHaveLength(4);
    const marker = markers[markers.length - 1];
    expect(Number.parseFloat((marker as HTMLElement).style.left)).toBeLessThanOrEqual(216);
    expect(Number.parseFloat((marker as HTMLElement).style.left) + 24).toBeLessThanOrEqual(
      region.clientWidth,
    );
    fireEvent.click(marker);

    const dialog = screen.getByRole("dialog");
    const popupLeft = Number.parseFloat((dialog as HTMLElement).style.left);
    const popupWidth = Number.parseFloat((dialog as HTMLElement).style.width);
    const popupTop = Number.parseFloat((dialog as HTMLElement).style.top);
    const popupHeight = Number.parseFloat((dialog as HTMLElement).style.maxHeight);
    expect(popupLeft + popupWidth).toBeLessThanOrEqual(region.clientWidth);
    expect(popupTop + popupHeight).toBeLessThanOrEqual(region.clientHeight);

    const choices = screen.getAllByTestId("price-chart-comment-time-choice");
    expect(new Set(choices.map((choice) => choice.textContent))).toHaveLength(3);
    fireEvent.click(choices[choices.length - 1]);
    expect(plot.setCursor).toHaveBeenLastCalledWith({ left: 505, top: 80 });
    expect(dialog).toHaveTextContent("Dense comment 5");
  });

  it("renders no synthetic numeric chart when numeric authority is disabled", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
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
    expect(screen.queryByTestId("price-chart-uplot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
    expect(screen.queryByText("75.00%")).not.toBeInTheDocument();
    expect(plotInstances).toHaveLength(0);
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
      expect(screen.queryByTestId("price-chart-uplot")).not.toBeInTheDocument();
      expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
      expect(plotInstances).toHaveLength(0);
    },
  );

  it("updates the existing plot data when history changes", () => {
    const { rerender } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 40 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );

    const instance = plotInstances[0];
    const options = instance.options as { series: Array<{ points?: { show?: boolean } }> };
    expect(options.series[1].points?.show).toBe(true);
    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 40 },
            { eventOrder: "2026-05-21T10:00:00Z", timestamp: "2026-05-21T10:00:00Z", price: 50 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );

    expect(plotInstances).toHaveLength(1);
    expect(instance.setData).toHaveBeenCalled();
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("50.00%");
  });

  it("updates the existing uPlot x-scale when timeframe tabs are clicked", () => {
    const history: PriceHistory = {
      timeframe: "all",
      data: [
        { eventOrder: "2026-01-01T00:00:00Z", timestamp: "2026-01-01T00:00:00Z", price: 40 },
        { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 50 },
      ],
    };
    function ControlledChart() {
      const [timeframe, setTimeframe] = useState<ChartTimeframe>("all");
      return (
        <PriceChart
          priceHistory={history}
          chartTimeframe={timeframe}
          onTimeframeChange={setTimeframe}
        />
      );
    }

    render(<ControlledChart />);

    const instance = plotInstances[0];
    const latest = Date.parse("2026-05-25T10:00:00Z") / 1000;
    expect(instance.options.scales?.x).toMatchObject({
      min: Date.parse("2026-01-01T00:00:00Z") / 1000,
      max: latest,
    });

    fireEvent.click(screen.getByRole("button", { name: "1H" }));
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 60 * 60,
      max: latest,
    });

    fireEvent.click(screen.getByRole("button", { name: "24H" }));
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 24 * 60 * 60,
      max: latest,
    });

    fireEvent.click(screen.getByRole("button", { name: "7D" }));
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 7 * 24 * 60 * 60,
      max: latest,
    });

    fireEvent.click(screen.getByRole("button", { name: "1 Month" }));
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 30 * 24 * 60 * 60,
      max: latest,
    });

    fireEvent.click(screen.getByRole("button", { name: "ALL" }));
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: Date.parse("2026-01-01T00:00:00Z") / 1000,
      max: latest,
    });
  });

  it("deduplicates and caps retained chart points before rendering", () => {
    const points = Array.from({ length: 1005 }, (_, index) => ({
      eventOrder: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      price: index % 100,
    }));
    const duplicate = { ...points[500], price: 53.27 };

    render(
      <PriceChart
        priceHistory={{ timeframe: "all", data: [...points, duplicate] }}
        chartTimeframe="all"
      />,
    );

    const alignedData = plotInstances[0].data as [number[], Array<number | null>];
    expect(alignedData[0]).toHaveLength(1000);
    expect(alignedData[0][0]).toBe(Date.parse(points[5].timestamp) / 1000);
    expect(alignedData[0]).toContain(Date.parse(duplicate.timestamp) / 1000);
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("4.00%");
  });

  it("applies x-scale bounds for selected timeframes", () => {
    const { rerender } = render(
      <PriceChart
        priceHistory={{
          timeframe: "1h",
          data: [
            { eventOrder: "2026-05-25T09:00:00Z", timestamp: "2026-05-25T09:00:00Z", price: 40 },
            { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 50 },
          ],
        }}
        chartTimeframe="1h"
      />,
    );

    const instance = plotInstances[0];
    const latest = Date.parse("2026-05-25T10:00:00Z") / 1000;
    expect(instance.options.scales?.x).toMatchObject({
      min: latest - 60 * 60,
      max: latest,
    });

    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "24h",
          data: [
            { eventOrder: "2026-05-24T10:00:00Z", timestamp: "2026-05-24T10:00:00Z", price: 35 },
            { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 50 },
          ],
        }}
        chartTimeframe="24h"
      />,
    );

    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 24 * 60 * 60,
      max: latest,
    });

    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { eventOrder: "2026-05-18T10:00:00Z", timestamp: "2026-05-18T10:00:00Z", price: 30 },
            { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 50 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 7 * 24 * 60 * 60,
      max: latest,
    });

    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "30d",
          data: [
            { eventOrder: "2026-04-25T10:00:00Z", timestamp: "2026-04-25T10:00:00Z", price: 25 },
            { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 50 },
          ],
        }}
        chartTimeframe="30d"
      />,
    );
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: latest - 30 * 24 * 60 * 60,
      max: latest,
    });

    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "all",
          data: [
            { eventOrder: "2026-01-01T00:00:00Z", timestamp: "2026-01-01T00:00:00Z", price: 20 },
            { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 50 },
          ],
        }}
        chartTimeframe="all"
      />,
    );
    expect(instance.setScale).toHaveBeenLastCalledWith("x", {
      min: Date.parse("2026-01-01T00:00:00Z") / 1000,
      max: latest,
    });
  });

  it("destroys the plot on unmount", () => {
    const { unmount } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 40 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );

    const instance = plotInstances[0];
    unmount();
    expect(instance.destroy).toHaveBeenCalled();
  });

  it("renders one latest-value pill per categorical outcome series", () => {
    render(
      <PriceChart
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        outcomes={[
          { id: "outcome-0", label: "Alice", odds: 33 },
          { id: "outcome-1", label: "Bob", odds: 33 },
          { id: "outcome-2", label: "Carol", odds: 34 },
        ]}
        outcomePriceHistories={{
          Alice: {
            timeframe: "7d",
            data: [
              { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 33 },
            ],
          },
          Bob: {
            timeframe: "7d",
            data: [
              { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 28 },
            ],
          },
        }}
      />,
    );

    const pills = screen.getAllByTestId("latest-price-pill");
    expect(pills).toHaveLength(2);
    expect(pills[0]).toHaveTextContent("Alice");
    expect(pills[0]).toHaveTextContent("33.00%");
    expect(pills[1]).toHaveTextContent("Bob");
    expect(pills[1]).toHaveTextContent("28.00%");
  });

  it("shows sampled categorical series values without filling gaps", () => {
    render(
      <PriceChart
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        outcomes={[
          { id: "alice", label: "Alice", odds: 20 },
          { id: "bob", label: "Bob", odds: 80 },
          { id: "carol", label: "Carol", odds: 0 },
        ]}
        outcomePriceHistories={{
          Alice: {
            timeframe: "7d",
            data: [
              { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 20 },
              { eventOrder: "2026-05-25T11:00:00Z", timestamp: "2026-05-25T11:00:00Z", price: 22 },
            ],
          },
          Bob: {
            timeframe: "7d",
            data: [
              { eventOrder: "2026-05-25T11:00:00Z", timestamp: "2026-05-25T11:00:00Z", price: 78 },
            ],
          },
        }}
      />,
    );

    act(() => plotInstances[0].setCursor({ left: 10, top: 30 }));

    const tooltip = screen.getByTestId("price-chart-cursor-tooltip");
    expect(tooltip).toHaveTextContent("Alice: 20.00%");
    expect(tooltip).not.toHaveTextContent("Bob: 78.00%");
    expect(tooltip).not.toHaveTextContent("Carol");
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
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        outcomes={outcomes}
        outcomePriceHistories={histories}
      />,
    );
    const seriesByLabel = (index: number) => {
      const options = plotInstances[index].options as {
        series: Array<{ label?: string; stroke?: string }>;
      };
      return new Map(options.series.slice(1).map((series) => [series.label, series.stroke]));
    };
    expect(seriesByLabel(0)).toEqual(
      new Map([
        ["Bob", "#AABBCC"],
        ["Alice", "#112233"],
      ]),
    );
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
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        outcomes={[...outcomes].reverse()}
        outcomePriceHistories={histories}
      />,
    );
    expect(seriesByLabel(1)).toEqual(
      new Map([
        ["Alice", "#112233"],
        ["Bob", "#AABBCC"],
      ]),
    );
  });
});
