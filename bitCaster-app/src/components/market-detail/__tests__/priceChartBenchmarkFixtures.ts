import type { ComponentProps } from "react";
import type { PriceChart } from "../PriceChart";
import type { Comment, PriceHistory, PricePoint } from "@/types/market-detail";

export type ChartProps = ComponentProps<typeof PriceChart>;
export type Workload = {
  name: string;
  pointsPerOutcome: number;
  outcomes: number;
  binary: boolean;
};
export type Fixture = {
  props: ChartProps;
  anchor: { timestamp: number; price: number };
  append: number;
};
export const AS_OF = Date.parse("2026-10-08T00:00:00.000Z");
// Retain the historical input size as stress input, not the visible product budget.
export const STRESS_INPUT_COMMENT_COUNT = 40;
export const VISIBLE_COMMENT_COUNT = 10;
const SPAN_MS = 50 * 60_000;
const COLORS = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ec4899",
  "#06b6d4",
  "#eab308",
  "#ef4444",
];
export const WORKLOADS: Workload[] = [
  ...[300, 1_000, 10_000].flatMap((pointsPerOutcome) =>
    [2, 8].map((outcomes) => ({
      name: `categorical-${outcomes}x${pointsPerOutcome}`,
      pointsPerOutcome,
      outcomes,
      binary: false,
    })),
  ),
  { name: "binary-merged-600", pointsPerOutcome: 300, outcomes: 2, binary: true },
];

function point(index: number, series: number, count: number): PricePoint {
  return {
    eventOrder: `${index.toString().padStart(6, "0")}-${series}`,
    timestamp: new Date(
      AS_OF - SPAN_MS + Math.floor((index * (SPAN_MS - 60_000)) / count) + series,
    ).toISOString(),
    price: 10 + ((index * 13 + series * 17) % 81),
    volume: 1_000,
    source: "fill",
  };
}
function history(
  data: PricePoint[],
  timeframe: PriceHistory["timeframe"] = "all",
  asOf = AS_OF,
): PriceHistory {
  return {
    data,
    timeframe,
    asOf: new Date(asOf).toISOString(),
    receivedAt: performance.now(),
    snapshotEventOrder: "fixture",
  };
}
export function makeFixture(workload: Workload): Fixture {
  const series = Array.from({ length: workload.outcomes }, (_, s) =>
    Array.from({ length: workload.pointsPerOutcome }, (_, i) =>
      point(i, s, workload.pointsPerOutcome),
    ),
  );
  const outcomes = series.map((_, s) => ({
    id: `Outcome${s}`,
    label: `Outcome${s}`,
    odds: null,
    color: COLORS[s],
  }));
  const comments: Comment[] = Array.from({ length: STRESS_INPUT_COMMENT_COUNT }, (_, i) => {
    const s = i % workload.outcomes;
    // Keep all comments inside the rolling window after the expiry update.
    const p = series[s][Math.floor(workload.pointsPerOutcome * (0.35 + i * 0.014))];
    const isNo = workload.binary && s === 1;
    return {
      id: `comment-${i}`,
      userId: (i + 1).toString(16).padStart(64, "0"),
      userDisplayName: `Fixture author ${i}`,
      content: `Benchmark comment ${i}. Exact confirmed trade.`,
      timestamp: p.timestamp,
      likeCount: i,
      isLiked: false,
      trade: {
        fillId: `00000000-0000-0000-0000-${(i + 1).toString().padStart(12, "0")}`,
        outcomeId: workload.binary ? (isNo ? "no" : "yes") : outcomes[s].id,
        executedAt: p.timestamp,
        price: isNo ? 100 - p.price : p.price,
        priceDenominator: 100,
        faceAmountSubunits: 1_000,
      },
    };
  });
  // For binary, series[] already holds the YES-basis display points. A NO comment
  // carries its primitive price, so the chart must independently complement it.
  const primary = workload.binary
    ? series.flat().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    : series[0];
  // Equal fill sizes select the ten newest comments. The first visible marker
  // is the earliest of those selected comments, after chronological placement.
  const anchorTrade = comments[STRESS_INPUT_COMMENT_COUNT - VISIBLE_COMMENT_COUNT].trade!;
  return {
    props: {
      priceHistory: history(primary),
      chartTimeframe: "all",
      comments,
      ...(workload.binary
        ? {}
        : {
            outcomes,
            outcomePriceHistories: Object.fromEntries(
              outcomes.map((o, s) => [o.id, history(series[s])]),
            ),
          }),
    },
    anchor: {
      timestamp: Date.parse(anchorTrade.executedAt),
      price:
        workload.binary && anchorTrade.outcomeId === "no"
          ? 100 - anchorTrade.price
          : anchorTrade.price,
    },
    append: 0,
  };
}
export function appendFixture(fixture: Fixture): Fixture {
  const generation = fixture.append + 1;
  const timestamp = AS_OF + generation * 1_000;
  const append = (input: PriceHistory, s: number): PriceHistory =>
    history(
      [
        ...input.data,
        {
          eventOrder: `append-${generation}-${s}`,
          timestamp: new Date(timestamp + s).toISOString(),
          price: 20 + ((generation * 11 + s * 7) % 61),
          volume: 1_000,
          source: "fill",
        },
      ],
      "all",
      timestamp + 100,
    );
  const outcomePriceHistories = fixture.props.outcomePriceHistories
    ? Object.fromEntries(
        Object.entries(fixture.props.outcomePriceHistories).map(([id, h], s) => [id, append(h, s)]),
      )
    : undefined;
  // Append one confirmed point per primitive outcome in the binary merged path too.
  const primary = outcomePriceHistories
    ? Object.values(outcomePriceHistories)[0]
    : append(append(fixture.props.priceHistory, 0), 1);
  return {
    ...fixture,
    append: generation,
    props: {
      ...fixture.props,
      chartTimeframe: "all",
      priceHistory: primary,
      outcomePriceHistories,
    },
  };
}
export function rollingFixture(fixture: Fixture, advanceMinutes = 15): Fixture {
  const asOf = AS_OF + advanceMinutes * 60_000;
  const roll = (h: PriceHistory) => history(h.data, "1h", asOf);
  return {
    ...fixture,
    props: {
      ...fixture.props,
      chartTimeframe: "1h",
      priceHistory: roll(fixture.props.priceHistory),
      outcomePriceHistories: fixture.props.outcomePriceHistories
        ? Object.fromEntries(
            Object.entries(fixture.props.outcomePriceHistories).map(([id, h]) => [id, roll(h)]),
          )
        : undefined,
    },
  };
}
