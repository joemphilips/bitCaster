import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useMarketDetailSnapshots } from "../useMarketDetailSnapshots";
import { fetchMarketPriceHistory, fetchMarketComments } from "@/lib/markets";
import {
  onConfirmedTradeRecorded,
  onMarketRejoined,
  onMarketResyncRequired,
} from "@/lib/marketHub";
import {
  decodeMarketPriceHistoryResponse,
  type MarketPriceHistoryResponse,
} from "@bitcaster/client-sdk/engineClient";
import type { MarketDetail, ChartTimeframe } from "@/types/market-detail";

vi.mock("@/lib/markets", () => ({
  fetchMarketPriceHistory: vi.fn(),
  fetchMarketComments: vi.fn(),
}));
vi.mock("@/lib/marketHub", () => ({
  onConfirmedTradeRecorded: vi.fn(() => vi.fn()),
  onMarketResyncRequired: vi.fn(() => vi.fn()),
  onMarketRejoined: vi.fn(() => vi.fn()),
  onMarketCommentsChanged: vi.fn(() => vi.fn()),
}));

const snapshot = (
  asOf = "2026-10-08T10:00:00Z",
  timeframe: ChartTimeframe = "7d",
): MarketPriceHistoryResponse => ({
  conditionId: "condition",
  timeframe,
  asOf,
  snapshotEventOrder: "opaque-position",
  outcomes: [],
});
const market: MarketDetail = {
  id: "condition",
  title: "Confirmed price fixture",
  type: "yesno",
  categoryTags: [],
  volume: 0,
  liquidity: 0,
  liquiditySubunits: 0,
  ammBotBudgetSubunits: 0,
  volumeLifetimeSubunits: 0,
  closingDate: null,
  createdDate: "2026-10-01T00:00:00Z",
  activeSince: "2026-10-01T00:00:00Z",
  baseAsset: "sat",
  baseUnit: "sats",
  creator: { id: "creator", name: "Creator", totalMarketsCreated: 1, feePercent: 0 },
  resolution: { criteria: "Fixture", source: "oracle", resolutionDate: null, status: "open" },
  currentOdds: { yes: 600, no: 400 },
  orderBook: { bids: [], asks: [], spread: 0 },
  recentTrades: [],
  comments: [],
  relatedMarkets: [],
  divisibility: 1000,
  registeredPrimitiveOutcomeIds: ["Yes", "No"],
  outcomes: [
    { id: "Yes", label: "Yes", odds: 600 },
    { id: "No", label: "No", odds: 400 },
  ],
  priceHistory: { timeframe: "7d", data: [], asOf: "2026-10-08T10:00:00Z" },
};
function notify(eventOrder: string) {
  const callback = vi.mocked(onConfirmedTradeRecorded).mock.calls[0][1];
  act(() =>
    callback({ conditionId: market.id, latestConfirmedTrade: { eventOrder } } as Parameters<
      typeof callback
    >[0]),
  );
}

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchMarketComments).mockResolvedValue({
    conditionId: market.id,
    comments: [],
  } as never);
  vi.mocked(fetchMarketPriceHistory).mockResolvedValue(snapshot());
});

describe("history refresh observations", () => {
  it("discards an older successful empty response when another fill races it", async () => {
    const onHistory = vi.fn();
    const onHistoryStatus = vi.fn();
    let release!: (value: MarketPriceHistoryResponse) => void;
    renderHook(() =>
      useMarketDetailSnapshots({
        market,
        timeframe: "7d",
        onHistory,
        onHistoryStatus,
        onComments: vi.fn(),
        onInvalidateHistory: vi.fn(),
      }),
    );
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(1));
    vi.mocked(fetchMarketPriceHistory)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot("2026-10-08T10:02:00Z"));
    notify("source-a");
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2));
    notify("source-b");
    await act(async () => release(snapshot("2026-10-08T09:00:00Z")));
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(2));
    expect(onHistory.mock.calls.map(([value]) => value.asOf)).toEqual([
      "2026-10-08T10:00:00Z",
      "2026-10-08T10:02:00Z",
    ]);
    expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
      "condition",
      "7d",
      expect.objectContaining({
        minimumEventOrder: "source-b",
        minimumAsOf: "2026-10-08T10:00:00Z",
      }),
    );
    expect(onHistoryStatus).toHaveBeenLastCalledWith("ready");
  });

  it("keeps accepted history on a stale HTTP 200 or failed read and clears failure on recovery", async () => {
    const onHistory = vi.fn();
    const onHistoryStatus = vi.fn();
    renderHook(() =>
      useMarketDetailSnapshots({
        market,
        timeframe: "7d",
        onHistory,
        onHistoryStatus,
        onComments: vi.fn(),
        onInvalidateHistory: vi.fn(),
      }),
    );
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(1));
    // Use the real boundary decoder with mocked I/O, as the SDK client does.
    vi.mocked(fetchMarketPriceHistory).mockImplementationOnce(
      async (conditionId, timeframe, options) =>
        decodeMarketPriceHistoryResponse(snapshot("2026-10-08T09:59:00Z"), {
          ...options,
          conditionId,
          timeframe: timeframe!,
        }),
    );
    notify("source-a");
    await waitFor(() => expect(onHistoryStatus).toHaveBeenLastCalledWith("unavailable"));
    expect(onHistory).toHaveBeenCalledTimes(1);
    vi.mocked(fetchMarketPriceHistory).mockRejectedValueOnce(new Error("503"));
    notify("source-b");
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(onHistoryStatus).toHaveBeenLastCalledWith("unavailable"));
    expect(onHistory).toHaveBeenCalledTimes(1);
    notify("source-c");
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(2));
    expect(onHistoryStatus).toHaveBeenLastCalledWith("ready");
  });

  it("aborts an old price context and rejects its late response after context recovery", async () => {
    const onHistory = vi.fn();
    let release!: (value: MarketPriceHistoryResponse) => void;
    vi.mocked(fetchMarketPriceHistory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { rerender } = renderHook(
      ({ current }: { current: MarketDetail }) =>
        useMarketDetailSnapshots({
          market: current,
          timeframe: "7d",
          onHistory,
          onComments: vi.fn(),
          onInvalidateHistory: vi.fn(),
        }),
      { initialProps: { current: { ...market, divisibility: 1_000_000 } as MarketDetail } },
    );
    await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(1));
    const oldOptions = vi.mocked(fetchMarketPriceHistory).mock.calls[0][2];
    rerender({ current: market });
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(1));
    expect(oldOptions?.signal?.aborted).toBe(true);
    expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
      "condition",
      "7d",
      expect.objectContaining({ divisibility: 1000 }),
    );
    await act(async () => release(snapshot("2026-10-08T11:00:00Z")));
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it("retains each range's asOf and the live watermark across range switches and reconnect", async () => {
    const onHistory = vi.fn();
    const callbacks = { onHistory, onComments: vi.fn(), onInvalidateHistory: vi.fn() };
    vi.mocked(fetchMarketPriceHistory).mockImplementation(async (_, timeframe) =>
      snapshot("2026-10-08T10:00:00Z", timeframe),
    );
    const { rerender } = renderHook(
      ({ timeframe }: { timeframe: ChartTimeframe }) =>
        useMarketDetailSnapshots({ market, timeframe, ...callbacks }),
      { initialProps: { timeframe: "7d" as ChartTimeframe } },
    );
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(1));
    notify("live-token");
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(2));
    rerender({ timeframe: "1h" });
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(3));
    expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
      "condition",
      "1h",
      expect.objectContaining({ minimumEventOrder: "live-token" }),
    );
    rerender({ timeframe: "7d" });
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(4));
    const rejoin = vi.mocked(onMarketRejoined).mock.calls.at(-1)![1];
    act(() => rejoin());
    await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(5));
    expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
      "condition",
      "7d",
      expect.objectContaining({
        minimumEventOrder: "live-token",
        minimumAsOf: "2026-10-08T10:00:00Z",
      }),
    );
  });
});

it("retains displayed history and retries explicit loss without another control", async () => {
  const onHistory = vi.fn();
  const onHistoryStatus = vi.fn();
  const view = renderHook(() =>
    useMarketDetailSnapshots({
      market,
      timeframe: "7d",
      onHistory,
      onHistoryStatus,
      onComments: vi.fn(),
      onInvalidateHistory: vi.fn(),
    }),
  );
  await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(1));
  vi.mocked(fetchMarketPriceHistory)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(snapshot("2026-10-08T10:10:00Z"));
  act(() => vi.mocked(onMarketResyncRequired).mock.calls[0][1]("a".repeat(32)));
  await waitFor(() => expect(onHistoryStatus).toHaveBeenCalledWith("unavailable"));
  expect(onHistory).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(2));
  expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
    market.id,
    "7d",
    expect.objectContaining({ refresh: true }),
  );
  view.unmount();
});

it("discards an old route repair response after disposal", async () => {
  const onHistory = vi.fn();
  let release!: (value: MarketPriceHistoryResponse) => void;
  const view = renderHook(() =>
    useMarketDetailSnapshots({
      market,
      timeframe: "7d",
      onHistory,
      onComments: vi.fn(),
      onInvalidateHistory: vi.fn(),
    }),
  );
  await waitFor(() => expect(onHistory).toHaveBeenCalledTimes(1));
  vi.mocked(fetchMarketPriceHistory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  act(() => vi.mocked(onMarketResyncRequired).mock.calls[0][1]("b".repeat(32)));
  await waitFor(() => expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2));
  view.unmount();
  await act(async () => release(snapshot("2026-10-08T10:10:00Z")));
  expect(onHistory).toHaveBeenCalledTimes(1);
});

it("repairs an ordinary trade hint after 503 without another event, preserving its minimum", async () => {
  vi.useFakeTimers();
  const onHistory = vi.fn();
  const onComments = vi.fn();
  const onHistoryStatus = vi.fn();
  const view = renderHook(() =>
    useMarketDetailSnapshots({
      market,
      timeframe: "7d",
      onHistory,
      onComments,
      onHistoryStatus,
      onInvalidateHistory: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    expect(onHistory).toHaveBeenCalledTimes(1);
    vi.mocked(fetchMarketPriceHistory)
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(snapshot("2026-10-08T10:10:00Z"));
    vi.mocked(fetchMarketComments).mockRejectedValueOnce(new Error("503"));
    for (const [, callback] of vi.mocked(onConfirmedTradeRecorded).mock.calls)
      act(() =>
        callback({
          conditionId: market.id,
          latestConfirmedTrade: { eventOrder: "new-fill" },
        } as Parameters<typeof callback>[0]),
      );
    await act(async () => {});
    expect(onHistoryStatus).toHaveBeenLastCalledWith("unavailable");
    expect(onHistory).toHaveBeenCalledTimes(1);
    // A repeated hint must not restart the failed attempt or erase its delay.
    notify("new-fill");
    await act(async () => {});
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(onHistory).toHaveBeenCalledTimes(2);
    expect(onComments).toHaveBeenCalledTimes(2);
    expect(onHistoryStatus).toHaveBeenLastCalledWith("ready");
    expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
      market.id,
      "7d",
      expect.objectContaining({ minimumEventOrder: "new-fill", refresh: true }),
    );
    expect(fetchMarketComments).toHaveBeenLastCalledWith(
      market.id,
      expect.objectContaining({ minimumEventOrder: "new-fill", refresh: true }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
  }
});

it("keeps newer ordinary minima when a control races a held read", async () => {
  vi.useFakeTimers();
  const onHistory = vi.fn();
  let release!: (value: MarketPriceHistoryResponse) => void;
  const view = renderHook(() =>
    useMarketDetailSnapshots({
      market,
      timeframe: "7d",
      onHistory,
      onComments: vi.fn(),
      onInvalidateHistory: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    vi.mocked(fetchMarketPriceHistory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    notify("older-fill");
    await act(async () => {});
    const control = vi.mocked(onMarketResyncRequired).mock.calls[0][1];
    act(() => control("a".repeat(32)));
    notify("newer-fill");
    act(() => control("a".repeat(32)));
    await act(async () => release(snapshot("2026-10-08T09:00:00Z")));
    expect(onHistory).toHaveBeenCalledTimes(2);
    expect(onHistory.mock.calls.some(([value]) => value.asOf === "2026-10-08T09:00:00Z")).toBe(
      false,
    );
    expect(fetchMarketPriceHistory).toHaveBeenLastCalledWith(
      market.id,
      "7d",
      expect.objectContaining({ minimumEventOrder: "newer-fill" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release?.(snapshot());
    view.unmount();
  }
});

it("retries an initial failed snapshot and stops its pending retry on unmount", async () => {
  vi.useFakeTimers();
  const onHistory = vi.fn();
  vi.mocked(fetchMarketPriceHistory).mockRejectedValueOnce(new Error("503"));
  const view = renderHook(() =>
    useMarketDetailSnapshots({
      market,
      timeframe: "7d",
      onHistory,
      onComments: vi.fn(),
      onInvalidateHistory: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    expect(onHistory).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(onHistory).toHaveBeenCalledTimes(1);
    vi.mocked(fetchMarketPriceHistory).mockRejectedValueOnce(new Error("503"));
    notify("last-fill");
    await act(async () => {});
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3);
    expect(onHistory).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
  }
});

it("applies B when a completed A control repeats during B's held read", async () => {
  vi.useFakeTimers();
  const onHistory = vi.fn();
  const onHistoryStatus = vi.fn();
  let release!: (value: MarketPriceHistoryResponse) => void;
  const view = renderHook(() =>
    useMarketDetailSnapshots({
      market,
      timeframe: "7d",
      onHistory,
      onHistoryStatus,
      onComments: vi.fn(),
      onInvalidateHistory: vi.fn(),
    }),
  );
  try {
    await act(async () => {});
    const control = vi.mocked(onMarketResyncRequired).mock.calls[0][1];
    act(() => control("a".repeat(32)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(onHistory).toHaveBeenCalledTimes(2);
    vi.mocked(fetchMarketPriceHistory).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    act(() => control("b".repeat(32)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3);
    act(() => control("a".repeat(32)));
    await act(async () => release(snapshot("2026-10-08T10:20:00Z")));
    expect(onHistory).toHaveBeenLastCalledWith(snapshot("2026-10-08T10:20:00Z"));
    expect(onHistoryStatus).toHaveBeenLastCalledWith("ready");
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMarketPriceHistory).toHaveBeenCalledTimes(3);
  } finally {
    release?.(snapshot());
    view.unmount();
  }
});
