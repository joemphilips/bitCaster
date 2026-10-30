import source from "./priceChartCanvasObserver.install.js?raw";

export interface CanvasCommand {
  type: "M" | "L" | "A";
  x: number;
  y: number;
  r?: number;
}
export interface CanvasPlot {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface CanvasDraw {
  method: "stroke" | "fill";
  color: string;
  commands: CanvasCommand[];
  clip: CanvasPlot;
  revision: number;
}
export interface CanvasObservation {
  revision: number;
  draws: CanvasDraw[];
  plot: CanvasPlot | null;
}
export interface CanvasObserver {
  snapshot(): CanvasObservation;
  restore(): void;
}
export function installCanvasObserver(
  owner: HTMLElement | string,
  options: { geometry?: boolean; colors?: string[] } = {},
): CanvasObserver {
  Function(source)();
  return (
    globalThis as typeof globalThis & {
      __installPriceChartCanvasObserver: (
        owner: HTMLElement | string,
        options: object,
      ) => CanvasObserver;
    }
  ).__installPriceChartCanvasObserver(owner, options);
}
