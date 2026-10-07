import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { PriceChart } from "../PriceChart";
import type { ChartTimeframe, Comment, PriceHistory } from "@/types/market-detail";
import type { PublicNostrProfile } from "@/lib/nostr";

const fetchPublicNostrProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nostr", () => ({ fetchPublicNostrProfile }));

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

vi.mock("uplot", () => {
  class MockUPlot {
    xValuesByPosition = new Map<number, number>();
    setData = vi.fn();
    setSize = vi.fn();
    setScale = vi.fn();
    destroy = vi.fn();
    setCursor = vi.fn((position: { left: number; top: number }) => {
      this.cursor = { ...position, idx: 0 };
      this.callHook("setCursor");
    });
    posToVal = vi.fn((position: number, scale: string) =>
      scale === "x"
        ? (this.xValuesByPosition.get(position) ?? 1_777_000_000 + position)
        : 50 + position / 10,
    );
    valToPos = vi.fn((value: number, scale: string) => {
      if (scale !== "x") return value;
      const position = value % 100;
      this.xValuesByPosition.set(position, value);
      return position;
    });
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
    vi.spyOn(performance, "now").mockReturnValue(0);
    fetchPublicNostrProfile.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a uPlot chart with fixed probability axis labels", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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

  it("keeps compact cursor axis labels without the large sampled-price popup", () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: "7d",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
          data: [
            { eventOrder: "2026-05-20T10:00:00Z", timestamp: "2026-05-20T10:00:00Z", price: 46 },
          ],
        }}
        chartTimeframe="7d"
      />,
    );

    const plot = plotInstances[0];
    const selectedTime = Date.parse("2026-05-20T10:00:25Z") / 1000;
    vi.mocked(plot.posToVal).mockImplementation((position, scale) =>
      scale === "x" ? selectedTime : 50 + position / 10,
    );
    act(() => plot.setCursor({ left: 40, top: 25 }));

    expect(screen.queryByTestId("price-chart-cursor-tooltip")).not.toBeInTheDocument();
    const xAxisLabel = screen.getByTestId("price-chart-x-axis-cursor-label");
    const yAxisLabel = screen.getByTestId("price-chart-y-axis-cursor-label");
    expect(xAxisLabel).toHaveClass("pointer-events-none");
    expect(yAxisLabel).toHaveClass("pointer-events-none");
    expect(yAxisLabel).toHaveTextContent("46.00%");
    expect(plot.posToVal).toHaveBeenCalledWith(40, "x");
    expect(plot.posToVal).not.toHaveBeenCalledWith(25, "y");
    expect(plot.valToPos).toHaveBeenCalledWith(selectedTime, "x");
    expect(plot.valToPos).toHaveBeenCalledWith(46, "y");
    act(() => plot.setCursor({ left: 40, top: 90 }));
    expect(yAxisLabel).toHaveTextContent("46.00%");
  });

  it("refreshes a stationary historical cursor when confirmed history changes", () => {
    const first = { eventOrder: "001", timestamp: "2026-05-20T10:00:00Z", price: 46 };
    const later = { eventOrder: "002", timestamp: "2026-05-20T10:00:10Z", price: 52 };
    const { rerender } = render(
      <PriceChart priceHistory={{ timeframe: "7d", data: [first] }} chartTimeframe="7d" />,
    );
    const plot = plotInstances[0];
    const selectedTime = Date.parse("2026-05-20T10:00:25Z") / 1000;
    vi.mocked(plot.posToVal).mockImplementation(() => selectedTime);
    act(() => plot.setCursor({ left: 40, top: 25 }));
    expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("46.00%");

    rerender(
      <PriceChart priceHistory={{ timeframe: "7d", data: [first, later] }} chartTimeframe="7d" />,
    );
    expect(plotInstances).toHaveLength(1);
    expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("52.00%");
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("52.00%");
    expect(plot.valToPos).toHaveBeenCalledWith(52, "y");
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
    expect(markers[0]).toHaveClass("bg-slate-400/60");
    expect(dialog).toHaveClass("bg-white", "dark:bg-slate-800");
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveTextContent("");
    expect(closeButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(closeButton.parentElement?.querySelector("time")).toHaveAttribute("datetime", timestamp);
    const panelTail = screen.getByTestId("price-chart-comment-panel-tail");
    expect(panelTail.getAttribute("d")).toMatch(
      new RegExp(`^M ${markers[0].dataset.anchorX} ${markers[0].dataset.anchorY} L `),
    );
    expect(dialog.querySelector("h4")).toBeNull();
    expect(dialog).toHaveAccessibleName(expect.stringContaining("5/25/26"));
    expect(dialog).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(dialog).toHaveTextContent("<script>alert(1)</script>");
    expect(dialog.querySelector("img,script")).toBeNull();
    expect(dialog.querySelectorAll("li")).toHaveLength(12);
    expect(dialog.style.maxHeight).toBe("146px");
    const scrollContainer = dialog.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeInTheDocument();
    expect(scrollContainer).toHaveAttribute("role", "region");
    expect(scrollContainer).toHaveAttribute("tabindex", "0");
    expect(scrollContainer).toHaveAccessibleName(/Comments at/);
    expect(scrollContainer).toHaveClass("focus-visible:ring-2");
    expect(scrollContainer).toContainElement(screen.getByText("Comment 11"));
    (scrollContainer as HTMLElement).focus();
    expect(scrollContainer).toHaveFocus();
    expect(screen.queryByTestId("price-chart-cursor-tooltip")).not.toBeInTheDocument();
    expect(screen.getByTestId("price-chart-x-axis-cursor-label")).toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("Price unavailable");

    const expectedMarkerX = Math.floor(Date.parse(timestamp) / 1000) % 100;
    expect(plotInstances[0].setCursor).toHaveBeenCalledWith({ left: expectedMarkerX, top: 42 });
    fireEvent.pointerDown(markers[1], { pointerType: "touch" });
    fireEvent.click(markers[1]);
    expect(dialog).toHaveTextContent("Another time group");
    expect(plotInstances[0].setCursor).toHaveBeenLastCalledWith({
      left: expectedMarkerX + 1,
      top: 43,
    });
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
      expect(dialog).toHaveAccessibleName(/Comments at 5\/25\/26/);
      expect(dialog.querySelectorAll("time")).toHaveLength(2);
      for (const time of dialog.querySelectorAll("time")) {
        expect(time).toHaveAttribute("datetime", timestamp);
        expect(time).toHaveTextContent(dateOnly ? /^5\/25\/26$/ : /5\/25\/26, .*\d:\d/);
      }
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
    const dialog = screen.getByRole("dialog", { name: /Comments at/ });
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
    await act(async () => fireEvent.click(screen.getByTestId("price-chart-comment-marker")));
    expect(fetchPublicNostrProfile).toHaveBeenCalledTimes(40);
    expect(screen.getByRole("dialog").querySelectorAll("li")).toHaveLength(41);
    expect(screen.getByRole("dialog")).toHaveTextContent("Public author 40");
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
    expect(
      new Set(
        markers.map((marker) => {
          const element = marker as HTMLElement;
          return `${element.dataset.anchorX}:${element.dataset.anchorY}`;
        }),
      ),
    ).toHaveLength(40);
    expect(screen.getByTestId("price-chart-comment-markers-hidden")).toHaveTextContent(
      "2 comment markers are not shown.",
    );
    expect(screen.queryByText("Outside the selected period")).not.toBeInTheDocument();
    fireEvent.click(markers[0]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps a dense right-edge marker and its popover reachable in a narrow chart", () => {
    const start = Date.parse("2026-05-25T10:00:00Z");
    const comments: Comment[] = Array.from({ length: 6 }, (_, index) => {
      const executedAt = new Date(start + index * 1000).toISOString();
      return makeComment(
        `dense-${index}`,
        new Date(start - 60_000).toISOString(),
        makeTrade(executedAt, { price: 40 + index }),
      );
    });
    const history: PriceHistory = {
      timeframe: "7d",
      asOf: "2026-05-25T10:00:10Z",
      receivedAt: performance.now(),
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
      scale === "x" ? 200 + value - start / 1000 : value,
    );
    rerender(<PriceChart priceHistory={history} chartTimeframe="7d" comments={[...comments]} />);

    const markers = screen.getAllByTestId("price-chart-comment-marker");
    expect(markers).toHaveLength(6);
    const tails = screen.getAllByTestId("price-chart-comment-tail");
    expect(tails).toHaveLength(6);
    for (const tail of tails) {
      const anchorX = tail.getAttribute("data-anchor-x");
      const anchorY = tail.getAttribute("data-anchor-y");
      expect(tail.getAttribute("d")?.startsWith(`M ${anchorX} ${anchorY} L `)).toBe(true);
    }
    const marker = markers[markers.length - 1];
    const markerElement = marker as HTMLElement;
    const markerLeft = Number.parseFloat(markerElement.style.left);
    expect(markerLeft).toBeLessThanOrEqual(216);
    expect(markerLeft + 24).toBeLessThanOrEqual(region.clientWidth);
    expect(markerLeft + 12).not.toBe(Number.parseFloat(markerElement.dataset.anchorX ?? "NaN"));
    fireEvent.click(marker);

    const dialog = screen.getByRole("dialog");
    const popupLeft = Number.parseFloat((dialog as HTMLElement).style.left);
    const popupWidth = Number.parseFloat((dialog as HTMLElement).style.width);
    const popupTop = Number.parseFloat((dialog as HTMLElement).style.top);
    const popupHeight = Number.parseFloat((dialog as HTMLElement).style.maxHeight);
    expect(popupLeft + popupWidth).toBeLessThanOrEqual(region.clientWidth);
    expect(popupTop + popupHeight).toBeLessThanOrEqual(region.clientHeight);
    const anchorTop = Number.parseFloat(markerElement.dataset.anchorY ?? "NaN");
    expect(popupTop > anchorTop || popupTop + popupHeight < anchorTop).toBe(true);

    expect(plot.setCursor).toHaveBeenLastCalledWith({ left: 205, top: 45 });
    expect(dialog).toHaveTextContent("Comment dense-5");
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
    const anchorPrices = markers.map((marker) => (marker as HTMLElement).dataset.anchorY);
    expect(anchorPrices).toContain("59");
    expect(anchorPrices).toContain("64");
    const yesNoMarker = markers.find((marker) => (marker as HTMLElement).dataset.anchorY === "59");
    expect(yesNoMarker).toHaveAccessibleName(expect.stringContaining("2 comments"));

    fireEvent.click(yesNoMarker!);
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment yes-fill");
    expect(screen.getByRole("dialog")).toHaveTextContent("Comment no-fill");
    expect(plotInstances[0].setCursor).toHaveBeenLastCalledWith({
      left: (Date.parse(executedAt) / 1000) % 100,
      top: 35,
    });
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
      asOf: "2026-05-25T10:00:00Z",
      receivedAt: performance.now(),
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

  it("retains every server all point without a browser cap", () => {
    const points = Array.from({ length: 1005 }, (_, index) => ({
      eventOrder: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      price: index % 100,
    }));

    render(<PriceChart priceHistory={{ timeframe: "all", data: points }} chartTimeframe="all" />);

    const alignedData = plotInstances[0].data as [number[], Array<number | null>];
    expect(alignedData[0]).toHaveLength(1005);
    expect(alignedData[0][0]).toBe(Date.parse(points[0].timestamp) / 1000);
    expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("4.00%");
  });

  it("applies x-scale bounds for selected timeframes", () => {
    const { rerender } = render(
      <PriceChart
        priceHistory={{
          timeframe: "1h",
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
          asOf: "2026-05-25T10:00:00Z",
          receivedAt: performance.now(),
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
    expect(pills[1]).toHaveTextContent("28.00%");
    expect(pills[2]).toHaveTextContent("CarolPrice unavailable");
  });

  it("spans categorical alignment gaps and shows historical values without pricing future trades", () => {
    render(
      <PriceChart
        priceHistory={{ timeframe: "7d", data: [] }}
        chartTimeframe="7d"
        outcomes={[
          { id: "alice", label: "Alice", odds: 20, color: "#112233" },
          { id: "bob", label: "Bob", odds: 80, color: "#AABBCC" },
          { id: "carol", label: "Carol", odds: 0, color: "#334455" },
        ]}
        outcomePriceHistories={{
          Alice: {
            timeframe: "7d",
            asOf: "2026-05-25T10:00:00Z",
            receivedAt: performance.now(),
            data: [
              { eventOrder: "2026-05-25T10:00:00Z", timestamp: "2026-05-25T10:00:00Z", price: 20 },
              { eventOrder: "2026-05-25T12:00:00Z", timestamp: "2026-05-25T12:00:00Z", price: 22 },
            ],
          },
          Bob: {
            timeframe: "7d",
            asOf: "2026-05-25T10:00:00Z",
            receivedAt: performance.now(),
            data: [
              { eventOrder: "2026-05-25T11:00:00Z", timestamp: "2026-05-25T11:00:00Z", price: 78 },
            ],
          },
        }}
      />,
    );

    const plot = plotInstances[0];
    let selectedTime = Date.parse("2026-05-25T10:30:00Z") / 1000;
    vi.mocked(plot.posToVal).mockImplementation((_, scale) => (scale === "x" ? selectedTime : 99));
    act(() => plot.setCursor({ left: 10, top: 30 }));

    const alignedData = plotInstances[0].data as [
      number[],
      Array<number | null>,
      Array<number | null>,
    ];
    expect(alignedData[1]).toEqual([20, null, 22]);
    expect(alignedData[2]).toEqual([null, 78, null]);
    const plottedSeries = (plot.options as { series: Array<{ spanGaps?: boolean }> }).series;
    expect(plottedSeries.slice(1).map((series) => series.spanGaps)).toEqual([true, true]);
    const pills = screen.getAllByTestId("latest-price-pill");
    expect(pills).toHaveLength(3);
    expect(pills[0]).toHaveTextContent("Alice20.00%");
    expect(pills[1]).toHaveTextContent("BobPrice unavailable");
    expect(pills[2]).toHaveTextContent("CarolPrice unavailable");
    expect(pills[0].querySelector('[data-testid="outcome-color-swatch"]')).toHaveStyle({
      backgroundColor: "#112233",
    });
    selectedTime = Date.parse("2026-05-25T11:30:00Z") / 1000;
    act(() => plot.setCursor({ left: 20, top: 5 }));
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
  it("removes an expired hover value while a later confirmed point remains", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    plotInstances.length = 0;
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
    const view = render(<PriceChart priceHistory={history} chartTimeframe="1h" />);
    try {
      const plot = plotInstances[0];
      plot.posToVal = (_position, scale) =>
        scale === "x" ? Date.parse(first.timestamp) / 1000 : 99;
      act(() => plot.setCursor({ left: 20, top: 90 }));
      expect(screen.getByTestId("price-chart-y-axis-cursor-label")).toHaveTextContent("40.00%");
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("Price unavailable");
      act(() => plot.setCursor({ left: -10, top: -10 }));
      expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("50.00%");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it.each(["1h", "24h", "7d", "30d"] as const)(
    "%s expires the inclusive cutoff without requests and clears its timer",
    (timeframe) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
      const width = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[
        timeframe
      ];
      const asOf = Date.parse("2026-05-25T10:00:00Z");
      const point = {
        eventOrder: "opaque",
        timestamp: new Date(asOf - width).toISOString(),
        price: 40,
      };
      const history: PriceHistory = {
        timeframe,
        asOf: new Date(asOf).toISOString(),
        receivedAt: performance.now(),
        data: [point],
      };
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const view = render(<PriceChart priceHistory={history} chartTimeframe={timeframe} />);
      try {
        expect(screen.getByTestId("latest-price-pill")).toHaveTextContent("40.00%");
        expect(vi.getTimerCount()).toBe(1);
        act(() => vi.advanceTimersByTime(1));
        expect(screen.queryByTestId("latest-price-pill")).not.toBeInTheDocument();
        expect(screen.queryByTestId("price-chart-y-axis-cursor-label")).not.toBeInTheDocument();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        view.rerender(
          <PriceChart
            priceHistory={{
              ...history,
              data: [{ ...point, timestamp: new Date(asOf - width + 5000).toISOString() }],
              receivedAt: performance.now(),
            }}
            chartTimeframe={timeframe}
          />,
        );
        expect(vi.getTimerCount()).toBe(1);
        view.rerender(
          <PriceChart priceHistory={{ timeframe: "all", data: [point] }} chartTimeframe="all" />,
        );
        expect(vi.getTimerCount()).toBe(0);
        view.rerender(<PriceChart priceHistory={history} chartTimeframe={timeframe} />);
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        view.unmount();
        fetchSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
