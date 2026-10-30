import { memo, useLayoutEffect, useMemo, useRef } from "react";
import {
  Chart,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  type ChartDataset,
} from "chart.js";
import { formatPercent, priceSeriesPieces, type ChartPoint, type Series } from "./priceChartModel";

Chart.register(LineController, LineElement, PointElement, LinearScale);

type PriceCanvasChart = Pick<Chart, "scales" | "chartArea" | "width" | "height">;
type Domain = { min: number; max: number };
type Input = {
  series: readonly Series[];
  domain: Domain;
  formatTime: (timestamp: number, tickValues?: readonly number[]) => string;
};
export type PriceChartRender = Input & {
  chart: PriceCanvasChart;
  revision: number;
  isActive: () => boolean;
};
type PriceDataset = ChartDataset<"line", ChartPoint[]> & {
  seriesId: string;
  pieceIndex: number;
};
type Props = Input & { height: number; onRender: (render: PriceChartRender) => void };

function datasetsFor(series: readonly Series[], cache: Map<string, PriceDataset>): PriceDataset[] {
  const datasets: PriceDataset[] = [];
  const active = new Set<string>();
  for (const [outcomeIndex, item] of series.entries()) {
    const first = item.data[0];
    const coincident =
      Boolean(first) &&
      item.data.every(
        (point) => point.timestampMs === first.timestampMs && point.price === first.price,
      );
    for (const [pieceIndex, points] of priceSeriesPieces(item.data).entries()) {
      const key = JSON.stringify([item.id, pieceIndex]);
      active.add(key);
      let dataset = cache.get(key);
      if (!dataset) {
        dataset = {
          seriesId: item.id,
          pieceIndex,
          data: points,
          stepped: "before",
          borderWidth: 2,
          borderCapStyle: "butt",
          borderJoinStyle: "miter",
          pointHoverRadius: 0,
          fill: false,
          clip: 0,
        };
        cache.set(key, dataset);
      }
      dataset.data = points;
      dataset.label = item.label;
      // Chart.js draws lower order values last. Retain input outcome stacking.
      dataset.order = -outcomeIndex;
      dataset.borderColor = item.color;
      dataset.backgroundColor = item.color;
      dataset.pointRadius =
        coincident && pieceIndex === 0 ? (context) => (context.dataIndex === 0 ? 2 : 0) : 0;
      datasets.push(dataset);
    }
  }
  for (const key of cache.keys()) if (!active.has(key)) cache.delete(key);
  return datasets;
}

/** The Canvas and HTML overlay share only the library's public coordinates. */
export const PriceChartCanvas = memo(function PriceChartCanvas({
  series,
  domain,
  formatTime,
  onRender,
  height,
}: Props) {
  const resizeHeightRef = useRef<((height: number) => void) | null>(null);
  useLayoutEffect(() => {
    resizeHeightRef.current?.(height);
  }, [height]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const input = useMemo(() => ({ series, domain, formatTime }), [series, domain, formatTime]);
  const inputRef = useRef(input);
  const updateRef = useRef<((input: Input) => void) | null>(null);

  useLayoutEffect(() => {
    inputRef.current = input;
    updateRef.current?.(input);
  }, [input]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container) return;
    let active = true;
    let revision = 0;
    let applied = inputRef.current;
    const cache = new Map<string, PriceDataset>();
    canvas.width = Math.max(1, container.clientWidth);
    canvas.height = Math.max(1, container.clientHeight);
    const chart = new Chart<"line", ChartPoint[]>(canvas, {
      type: "line",
      data: { datasets: datasetsFor(applied.series, cache) },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: false,
        events: [],
        layout: { padding: { top: 12, right: 8, bottom: 0, left: 12 } },
        plugins: {
          decimation: { enabled: false },
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            type: "linear",
            min: applied.domain.min,
            max: applied.domain.max,
            grid: { display: false },
            border: { color: "#64748b" },
            ticks: {
              color: "#64748b",
              font: { size: 10 },
              maxRotation: 0,
              maxTicksLimit: 5,
              autoSkipPadding: 12,
              callback: (value, _index, ticks) =>
                applied.formatTime(
                  Number(value),
                  ticks.map((tick) => tick.value),
                ),
            },
          },
          y: {
            type: "linear",
            position: "right",
            min: 0,
            max: 100,
            grid: { display: false },
            border: { color: "#64748b" },
            ticks: {
              color: "#64748b",
              font: { size: 10 },
              stepSize: 50,
              callback: (value) => formatPercent(Number(value)),
            },
          },
        },
      },
      plugins: [
        {
          id: "price-chart-overlay",
          afterRender(renderedChart) {
            // Construction can render before the local chart variable is assigned.
            if (active) {
              onRender({
                ...applied,
                chart: renderedChart,
                revision: ++revision,
                isActive: () => active,
              });
            }
          },
        },
      ],
    });
    updateRef.current = (next) => {
      applied = next;
      chart.data.datasets = datasetsFor(next.series, cache);
      chart.options.scales!.x!.min = next.domain.min;
      chart.options.scales!.x!.max = next.domain.max;
      chart.update("none");
    };
    resizeHeightRef.current = (nextHeight) => {
      if (active && chart.height !== nextHeight) chart.resize(chart.width, nextHeight);
    };
    const resize = () => {
      if (!active) return;
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      if (
        chart.width !== width ||
        chart.height !== height ||
        chart.currentDevicePixelRatio !== window.devicePixelRatio
      ) {
        chart.resize(width, height);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);
    return () => {
      active = false;
      updateRef.current = null;
      resizeHeightRef.current = null;
      observer.disconnect();
      window.removeEventListener("resize", resize);
      chart.destroy();
      cache.clear();
    };
  }, [onRender]);

  return (
    <canvas ref={canvasRef} data-testid="price-chart-canvas" aria-hidden="true" className="block" />
  );
});
