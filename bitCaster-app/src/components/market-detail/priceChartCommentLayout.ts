import type { CommentGroup, PositionedCommentGroup, Series } from "./priceChartModel";

type Bounds = { x: number; y: number; width: number; height: number };
type Scales = { x: (time: number) => number; y: (price: number) => number };
const GAP = 8;
const PADDING = 4;
export const COMMENT_BODY_HEIGHT = 44;
export const COMMENT_BODY_WIDTH = 172;

/** A conservative collision index. It never samples or changes rendered history. */
function lineOccupancy(series: readonly Series[], plot: Bounds, scales: Scales) {
  const columns = Math.max(1, Math.min(1024, Math.ceil(plot.width / 4)));
  const rows = Math.max(1, Math.min(128, Math.ceil(plot.height / 4)));
  const words = Math.ceil(rows / 32);
  const cells = new Uint32Array(columns * words);
  const column = (x: number) =>
    Math.max(0, Math.min(columns - 1, Math.floor(((x - plot.x) / plot.width) * columns)));
  const row = (y: number) =>
    Math.max(0, Math.min(rows - 1, Math.floor(((y - plot.y) / plot.height) * rows)));
  const mask = (first: number, last: number, word: number) => {
    const low = Math.max(0, first - word * 32);
    const high = Math.min(31, last - word * 32);
    return (0xffffffff << low) & (0xffffffff >>> (31 - high));
  };
  const mark = (x1: number, y1: number, x2: number, y2: number) => {
    const left = Math.min(x1, x2) - 4,
      right = Math.max(x1, x2) + 4;
    const top = Math.min(y1, y2) - 4,
      bottom = Math.max(y1, y2) + 4;
    if (
      right < plot.x ||
      left > plot.x + plot.width ||
      bottom < plot.y ||
      top > plot.y + plot.height
    )
      return;
    const first = row(top),
      last = row(bottom);
    for (let x = column(left); x <= column(right); x++) {
      for (let word = Math.floor(first / 32); word <= Math.floor(last / 32); word++) {
        cells[x * words + word] |= mask(first, last, word);
      }
    }
  };
  for (const item of series) {
    let previous: { x: number; y: number } | undefined;
    for (const point of item.data) {
      const current = { x: scales.x(point.timestampMs), y: scales.y(point.price) };
      if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) continue;
      if (previous) {
        mark(previous.x, previous.y, current.x, previous.y);
        mark(current.x, previous.y, current.x, current.y);
      } else mark(current.x, current.y, current.x, current.y);
      previous = current;
    }
    if (previous) mark(previous.x, previous.y, plot.x + plot.width, previous.y);
  }
  return (box: Bounds) => {
    const first = row(box.y),
      last = row(box.y + box.height);
    for (let x = column(box.x); x <= column(box.x + box.width); x++) {
      for (let word = Math.floor(first / 32); word <= Math.floor(last / 32); word++) {
        if ((cells[x * words + word] & mask(first, last, word)) !== 0) return true;
      }
    }
    return false;
  };
}

export function layoutChartComments(
  groups: readonly CommentGroup[],
  series: readonly Series[],
  plot: Bounds,
  scales: Scales,
  canvasHeight: number,
): { groups: PositionedCommentGroup[]; overflowHeight: number } {
  if (plot.width <= 0 || plot.height <= 0 || groups.length === 0)
    return { groups: [], overflowHeight: 0 };
  const width = Math.max(1, Math.min(COMMENT_BODY_WIDTH, plot.width - PADDING * 2));
  const height = COMMENT_BODY_HEIGHT;
  const anchors = [...groups]
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
    .map((group) => {
      const anchorLeft = scales.x(group.timestamp),
        anchorTop = scales.y(group.price);
      return {
        ...group,
        anchorLeft,
        anchorTop,
        plotLeft: anchorLeft - plot.x,
        plotTop: anchorTop - plot.y,
        width,
        height,
      };
    });
  const occupied = lineOccupancy(series, plot, scales);
  const clampX = (x: number) =>
    Math.max(plot.x + PADDING, Math.min(x, plot.x + plot.width - width - PADDING));
  const clampY = (y: number) =>
    Math.max(plot.y + PADDING, Math.min(y, plot.y + plot.height - height - PADDING));
  type State = { placed: PositionedCommentGroup[]; cost: number };
  let states: State[] = [{ placed: [], cost: 0 }];
  for (const group of anchors) {
    const center = group.anchorLeft - width / 2;
    const xs = [
      ...new Set(
        [
          center,
          center - 24,
          center + 24,
          center - 64,
          center + 64,
          center - width,
          center + width,
          plot.x + PADDING,
          plot.x + plot.width - width - PADDING,
        ].map(clampX),
      ),
    ];
    const ys = [
      ...new Set(
        [
          group.anchorTop - height - GAP,
          group.anchorTop + GAP,
          plot.y + PADDING,
          plot.y + plot.height - height - PADDING,
          plot.y + plot.height / 2 - height / 2,
        ].map(clampY),
      ),
    ];
    const candidates = xs
      .flatMap((left) => ys.map((top) => ({ ...group, left, top })))
      .filter((box) => !occupied({ x: box.left, y: box.top, width, height }));
    const next: State[] = [];
    for (const state of states) {
      for (const candidate of candidates) {
        const last = state.placed.at(-1);
        if (last && candidate.left < last.left + GAP) continue;
        if (
          state.placed.some(
            (other) =>
              candidate.left < other.left + width + GAP &&
              candidate.left + width + GAP > other.left &&
              candidate.top < other.top + height + GAP &&
              candidate.top + height + GAP > other.top,
          )
        )
          continue;
        next.push({
          placed: [...state.placed, candidate],
          cost:
            state.cost +
            Math.hypot(
              candidate.left + width / 2 - group.anchorLeft,
              candidate.top + height / 2 - group.anchorTop,
            ),
        });
      }
    }
    next.sort((a, b) => a.cost - b.cost);
    states = next.slice(0, 16);
    if (states.length === 0) break;
  }
  if (states[0]?.placed.length === anchors.length)
    return { groups: states[0].placed, overflowHeight: 0 };
  const columns =
    plot.width < 480
      ? 1
      : Math.max(1, Math.floor((plot.width - PADDING * 2 + GAP) / (width + GAP)));
  const rows = Math.ceil(anchors.length / columns);
  const gridWidth = columns * width + (columns - 1) * GAP;
  return {
    groups: anchors.map((group, index) => ({
      ...group,
      left: plot.x + (plot.width - gridWidth) / 2 + (index % columns) * (width + GAP),
      top: canvasHeight + GAP + Math.floor(index / columns) * (height + GAP),
    })),
    overflowHeight: GAP + rows * (height + GAP),
  };
}
