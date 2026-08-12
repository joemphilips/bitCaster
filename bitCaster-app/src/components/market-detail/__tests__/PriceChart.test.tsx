import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PriceChart } from "../PriceChart";
import type { ChartTimeframe, PriceHistory } from "@/types/market-detail";

const plotInstances = vi.hoisted(
  () =>
    [] as Array<{
      setData: ReturnType<typeof vi.fn>;
      setSize: ReturnType<typeof vi.fn>;
      setScale: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      options: { scales?: { x?: { min?: number; max?: number } } };
      data: unknown;
    }>,
);

vi.mock("uplot", () => {
  class MockUPlot {
    setData = vi.fn();
    setSize = vi.fn();
    setScale = vi.fn();
    destroy = vi.fn();
    options: { scales?: { x?: { min?: number; max?: number } } };
    data: unknown;

    constructor(options: unknown, data: unknown, container: HTMLElement) {
      this.options = options as { scales?: { x?: { min?: number; max?: number } } };
      this.data = data;
      plotInstances.push(this);
      container.appendChild(document.createElement("canvas"));
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
            { timestamp: "2026-05-20T10:00:00Z", price: 40 },
            { timestamp: "2026-05-25T10:00:00Z", price: 55 },
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
        splits?: () => number[];
        values?: (_u: unknown, values: number[]) => string[];
      }>;
    };
    expect(options.axes[1].splits?.()).toEqual([0, 50, 100]);
    expect(options.axes[1].values?.({}, [0, 50, 100])).toEqual(["0.00%", "50.00%", "100.00%"]);
  });

  it("updates the existing plot data when history changes", () => {
    const { rerender } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [{ timestamp: "2026-05-20T10:00:00Z", price: 40 }],
        }}
        chartTimeframe="7d"
      />,
    );

    const instance = plotInstances[0];
    rerender(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [
            { timestamp: "2026-05-20T10:00:00Z", price: 40 },
            { timestamp: "2026-05-21T10:00:00Z", price: 50 },
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
        { timestamp: "2026-01-01T00:00:00Z", price: 40 },
        { timestamp: "2026-05-25T10:00:00Z", price: 50 },
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
            { timestamp: "2026-05-25T09:00:00Z", price: 40 },
            { timestamp: "2026-05-25T10:00:00Z", price: 50 },
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
            { timestamp: "2026-05-24T10:00:00Z", price: 35 },
            { timestamp: "2026-05-25T10:00:00Z", price: 50 },
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
            { timestamp: "2026-05-18T10:00:00Z", price: 30 },
            { timestamp: "2026-05-25T10:00:00Z", price: 50 },
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
            { timestamp: "2026-04-25T10:00:00Z", price: 25 },
            { timestamp: "2026-05-25T10:00:00Z", price: 50 },
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
            { timestamp: "2026-01-01T00:00:00Z", price: 20 },
            { timestamp: "2026-05-25T10:00:00Z", price: 50 },
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

  it("uses an initial-only timeframe anchor as the left edge", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "1h",
          data: [{ timestamp: "2026-05-25T09:00:00Z", price: 50, source: "initial" }],
        }}
        chartTimeframe="1h"
      />,
    );

    const anchor = Date.parse("2026-05-25T09:00:00Z") / 1000;
    expect(plotInstances[0].options.scales?.x).toMatchObject({
      min: anchor,
      max: anchor + 60 * 60,
    });
  });

  it("destroys the plot on unmount", () => {
    const { unmount } = render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          data: [{ timestamp: "2026-05-20T10:00:00Z", price: 40 }],
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
            data: [{ timestamp: "2026-05-25T10:00:00Z", price: 33 }],
          },
          Bob: {
            timeframe: "7d",
            data: [{ timestamp: "2026-05-25T10:00:00Z", price: 28 }],
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
});
