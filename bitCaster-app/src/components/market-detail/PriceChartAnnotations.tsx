import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { PriceChartRender } from "./PriceChartCanvas";
import { confirmedPriceAtOrBefore } from "@/lib/priceHistory";
import { fetchPublicNostrProfile, type PublicNostrProfile } from "@/lib/nostr";
import type { ChartTimeframe } from "@/types/market-detail";
import {
  chooseMarkerBodyPosition,
  clampPosition,
  commentTailPath,
  commentMarkerPresentation,
  commentPreview,
  commentLayout,
  createChartTimeFormatter,
  createCommentTimeFormatter,
  formatPercent,
  type CommentGroupResult,
  type PositionedCommentGroup,
  type Series,
} from "./priceChartModel";

import "./priceChartAnnotations.css";

export type ChartProfileRequests = Map<string, Promise<PublicNostrProfile | null>>;

interface Props {
  renderState: PriceChartRender | null;
  layoutReady: boolean;
  profileRequests: ChartProfileRequests;
  overlay: HTMLDivElement | null;
  commentGroupResult: CommentGroupResult;
  series: readonly Series[];
  chartTimeframe: ChartTimeframe;
  isCategorical: boolean;
  cursorTime: number | null;
  onCursorTime: (time: number | null) => void;
}

export function PriceChartAnnotations({
  renderState,
  layoutReady,
  profileRequests,
  overlay,
  commentGroupResult,
  series,
  chartTimeframe,
  isCategorical,
  cursorTime,
  onCursorTime,
}: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const formatChartTime = useMemo(
    () => createChartTimeFormatter(locale, chartTimeframe),
    [locale, chartTimeframe],
  );
  const formatCommentTime = useMemo(
    () => createCommentTimeFormatter(locale, chartTimeframe),
    [locale, chartTimeframe],
  );
  const coordinates = useMemo(() => {
    if (!renderState?.isActive()) return null;
    const { chart } = renderState;
    const x = chart.scales.x;
    const y = chart.scales.y;
    const area = chart.chartArea;
    if (!x || !y || !area || area.width <= 0 || area.height <= 0) return null;
    return {
      xScale: (timestamp: number) => x.getPixelForValue(timestamp),
      yScale: (price: number) => y.getPixelForValue(price),
      inverseX: (pixel: number) => x.getValueForPixel(pixel),
      plot: { x: area.left, y: area.top, width: area.width, height: area.height },
      width: chart.width,
      height: chart.height,
    };
  }, [renderState]);
  const { xScale, yScale, inverseX, plot } = coordinates ?? {};
  const chartRegionWidth = coordinates?.width ?? 0;
  const chartRegionHeight = coordinates?.height ?? 0;
  const previousRenderRef = useRef(renderState);
  const geometryChanged = previousRenderRef.current !== renderState;
  useLayoutEffect(() => {
    previousRenderRef.current = renderState;
  }, [renderState]);
  const pointerGroupRef = useRef<string | null>(null);
  const dismissedHoverGroupRef = useRef<string | null>(null);
  const commentMarkerLayerRef = useRef<HTMLDivElement | null>(null);
  const commentPopoverRef = useRef<HTMLDivElement | null>(null);
  const activeMarkerRef = useRef<HTMLButtonElement | null>(null);
  const ignoreNextMarkerFocusRef = useRef(false);
  const dismissTimerRef = useRef<number | null>(null);
  const pinnedCommentGroupIdRef = useRef<string | null>(null);
  const [activeCommentGroupId, setActiveCommentGroupId] = useState<string | null>(null);
  useEffect(() => {
    let lastPosition: { x: number; y: number } | null = null;
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const moved =
        lastPosition !== null &&
        (event.clientX !== lastPosition.x || event.clientY !== lastPosition.y);
      lastPosition = { x: event.clientX, y: event.clientY };
      const dismissed = dismissedHoverGroupRef.current;
      if (!moved || dismissed === null) return;
      const bubble = activeMarkerRef.current?.closest('[data-testid="price-chart-comment-bubble"]');
      if (bubble && event.target instanceof Node && bubble.contains(event.target)) return;
      // Close removes the hit descendant; its later pointerleave may never reach React.
      // Actual movement outside the surviving bubble releases only that hover dismissal.
      dismissedHoverGroupRef.current = null;
      if (pointerGroupRef.current === dismissed) pointerGroupRef.current = null;
    };
    document.addEventListener("pointermove", onPointerMove, true);
    return () => document.removeEventListener("pointermove", onPointerMove, true);
  }, []);
  const [authorProfiles, setAuthorProfiles] = useState(
    new Map<string, PublicNostrProfile | null>(),
  );
  const activeGroup = commentGroupResult.groups.find((group) => group.id === activeCommentGroupId);
  const positionedCommentGroups = useMemo(() => {
    const positioned: PositionedCommentGroup[] = [];
    if (!xScale || !yScale || !plot) return positioned;
    for (const group of commentGroupResult.groups) {
      const anchorLeft = xScale(group.timestamp);
      const anchorTop = yScale(group.price);
      if (
        anchorLeft === undefined ||
        anchorTop === undefined ||
        !Number.isFinite(anchorLeft) ||
        !Number.isFinite(anchorTop)
      )
        continue;
      const marker = commentMarkerPresentation(group.comments, plot?.width);
      positioned.push({
        ...group,
        anchorLeft,
        anchorTop,
        plotLeft: anchorLeft - plot.x,
        plotTop: anchorTop - plot.y,
        width: marker.width,
        height: marker.height,
        ...chooseMarkerBodyPosition(
          anchorLeft,
          anchorTop,
          chartRegionWidth,
          chartRegionHeight,
          positioned,
          marker.width,
          marker.height,
          plot,
        ),
      });
    }
    return positioned;
  }, [commentGroupResult, xScale, yScale, plot, chartRegionWidth, chartRegionHeight]);
  const activeCommentGroup = positionedCommentGroups.find(
    (group) => group.id === activeCommentGroupId,
  );
  const selectedAuthors = useMemo(
    () =>
      new Set(
        commentGroupResult.groups.flatMap((group) =>
          group.comments
            .map((comment) => comment.userId)
            .filter((author) => /^[0-9a-f]{64}$/.test(author)),
        ),
      ),
    [commentGroupResult],
  );
  useEffect(() => {
    // Range changes release obsolete authors instead of exhausting a chart-lifetime budget.
    for (const author of profileRequests.keys()) {
      if (!selectedAuthors.has(author)) profileRequests.delete(author);
    }
    setAuthorProfiles(
      (previous) => new Map([...previous].filter(([author]) => selectedAuthors.has(author))),
    );
  }, [selectedAuthors, profileRequests]);
  useEffect(() => {
    if (!activeGroup) return undefined;
    let cancelled = false;
    const authors = [...new Set(activeGroup.comments.map((comment) => comment.userId))].filter(
      (author) => selectedAuthors.has(author),
    );
    const requests = profileRequests;
    for (const author of authors) {
      if (requests.has(author)) continue;
      requests.set(
        author,
        fetchPublicNostrProfile(author).catch(() => null),
      );
    }
    void Promise.all(
      authors.map(async (author) => [author, (await requests.get(author)) ?? null] as const),
    ).then((profiles) => {
      if (!cancelled) setAuthorProfiles(new Map(profiles));
    });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, profileRequests, selectedAuthors]);
  const plotBounds = plot ?? { x: 0, y: 0, width: chartRegionWidth, height: chartRegionHeight };
  const commentPopoverWidth = Math.max(1, Math.min(288, plotBounds.width - 8));
  const activeResting = activeCommentGroup
    ? commentMarkerPresentation(activeCommentGroup.comments, plotBounds.width)
    : { width: 172, height: 56, opacity: 0.8 };
  const commentPopoverBelow = activeCommentGroup
    ? activeCommentGroup.top + activeResting.height / 2 >= activeCommentGroup.anchorTop
    : true;
  const commentPopoverHeight = Math.max(1, Math.min(176, plotBounds.height - 8));
  const commentPopoverLeft =
    plotBounds.x +
    clampPosition(
      (activeCommentGroup?.left ?? plotBounds.x) - plotBounds.x,
      commentPopoverWidth,
      plotBounds.width,
    );
  const commentPopoverTop =
    plotBounds.y +
    clampPosition(
      (activeCommentGroup
        ? commentPopoverBelow
          ? activeCommentGroup.top
          : activeCommentGroup.top + activeResting.height - commentPopoverHeight
        : plotBounds.y) - plotBounds.y,
      commentPopoverHeight,
      plotBounds.height,
    );

  const cursorPrice =
    cursorTime === null ? null : confirmedPriceAtOrBefore(series[0]?.data ?? [], cursorTime / 1000);
  const cursorX = cursorTime === null ? undefined : xScale?.(cursorTime);
  const cursorY = cursorPrice === null ? undefined : yScale?.(cursorPrice);
  const cursorReadout =
    cursorTime !== null && cursorX !== undefined && plot
      ? {
          time: cursorTime,
          price: cursorPrice,
          xLabelLeft: clampPosition(cursorX - 48, 96, chartRegionWidth),
          xLabelTop: clampPosition(plot.y + plot.height - 24, 20, chartRegionHeight),
          yLabelLeft: clampPosition(plot.x + plot.width - 72, 72, chartRegionWidth),
          yLabelTop: clampPosition((cursorY ?? plot.y) - 10, 20, chartRegionHeight),
        }
      : null;
  const closeCommentPopover = (restoreFocus: boolean) => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    pinnedCommentGroupIdRef.current = null;
    if (restoreFocus && pointerGroupRef.current === activeCommentGroupId)
      dismissedHoverGroupRef.current = activeCommentGroupId;
    setActiveCommentGroupId(null);
    onCursorTime(null);
    if (
      restoreFocus &&
      activeMarkerRef.current &&
      document.activeElement !== activeMarkerRef.current
    ) {
      ignoreNextMarkerFocusRef.current = true;
      activeMarkerRef.current.focus();
    }
  };

  const activateCommentMarker = (
    group: PositionedCommentGroup,
    marker: HTMLButtonElement,
    intent: "hover" | "focus" | "pin",
  ) => {
    if (intent === "hover" && dismissedHoverGroupRef.current === group.id) return;
    if (intent !== "hover") dismissedHoverGroupRef.current = null;
    const focused = document.activeElement;
    if (
      intent === "hover" &&
      activeCommentGroupId !== null &&
      activeCommentGroupId !== group.id &&
      (pinnedCommentGroupIdRef.current !== null ||
        (focused &&
          (commentPopoverRef.current?.contains(focused) || activeMarkerRef.current === focused)))
    )
      return;
    if (intent === "pin") pinnedCommentGroupIdRef.current = group.id;
    else if (intent === "focus" && pinnedCommentGroupIdRef.current !== group.id)
      pinnedCommentGroupIdRef.current = null;
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    activeMarkerRef.current = marker;
    setActiveCommentGroupId(group.id);
    // Comment selection owns its confirmed trade anchor, not the inspection cursor.
    onCursorTime(null);
  };

  const scheduleCommentPopoverDismiss = () => {
    if (pinnedCommentGroupIdRef.current !== null || dismissTimerRef.current !== null) return;
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      const focused = document.activeElement;
      if (
        pointerGroupRef.current === activeCommentGroupId ||
        (focused &&
          (commentPopoverRef.current?.contains(focused) || activeMarkerRef.current === focused))
      )
        return;
      closeCommentPopover(false);
    }, 200);
  };

  useEffect(() => {
    dismissedHoverGroupRef.current = null;
  }, [chartTimeframe]);

  useEffect(() => {
    if (!commentGroupResult.groups.some((group) => group.id === dismissedHoverGroupRef.current))
      dismissedHoverGroupRef.current = null;
    if (
      activeCommentGroupId === null ||
      commentGroupResult.groups.some((group) => group.id === activeCommentGroupId)
    ) {
      return;
    }
    closeCommentPopover(false);
  }, [activeCommentGroupId, commentGroupResult]);

  useEffect(() => {
    if (activeCommentGroupId === null) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        commentPopoverRef.current?.contains(target) ||
        commentMarkerLayerRef.current?.contains(target)
      ) {
        return;
      }
      closeCommentPopover(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeCommentPopover(true);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [activeCommentGroupId]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    },
    [],
  );

  if (!plot || !overlay || !xScale || !yScale) return null;
  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        width={chartRegionWidth}
        height={chartRegionHeight}
        viewBox={`0 0 ${chartRegionWidth} ${chartRegionHeight}`}
        style={{ opacity: layoutReady ? 1 : 0 }}
      >
        {series.map((item) => {
          const latest = item.data[item.data.length - 1];
          if (!latest) return null;
          const left = xScale(latest.timestampMs);
          const top = yScale(latest.price);
          if (!Number.isFinite(left) || !Number.isFinite(top) || left > plot.x + plot.width)
            return null;
          return (
            <g key={item.id} data-series-id={item.id}>
              <line
                data-series-id={item.id}
                data-testid="price-chart-current-extension"
                x1={Math.max(plot.x, left)}
                x2={plot.x + plot.width}
                y1={top}
                y2={top}
                stroke={item.color}
                strokeWidth={2}
              />
              <circle
                data-series-id={item.id}
                data-testid="price-chart-current-endpoint"
                className="price-chart-endpoint-pulse"
                cx={plot.x + plot.width}
                cy={top}
                r={4}
                fill={item.color}
              />
            </g>
          );
        })}
        {!activeCommentGroupId && cursorX !== undefined && cursorTime !== null && (
          <line
            x1={cursorX}
            x2={cursorX}
            y1={plot.y}
            y2={plot.y + plot.height}
            stroke="#94a3b8"
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}
        {!activeCommentGroupId && !isCategorical && cursorY !== undefined && (
          <line
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={cursorY}
            y2={cursorY}
            stroke="#94a3b8"
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}
        <rect
          data-testid="price-chart-cursor-surface"
          x={plot.x}
          y={plot.y}
          width={plot.width}
          height={plot.height}
          fill="transparent"
          className="pointer-events-auto"
          style={{ pointerEvents: layoutReady ? "auto" : "none" }}
          onPointerMove={(event) => {
            if (activeCommentGroupId) return;
            const svg = event.currentTarget.ownerSVGElement;
            const matrix = svg?.getScreenCTM();
            if (!matrix) return;
            const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(
              matrix.inverse(),
            );
            const time = inverseX?.(local.x);
            if (typeof time === "number" && Number.isFinite(time)) onCursorTime(time);
          }}
          onPointerLeave={() => {
            if (!activeCommentGroupId) onCursorTime(null);
          }}
        />
      </svg>
      {createPortal(
        <div className="absolute inset-0" style={{ opacity: layoutReady ? 1 : 0 }}>
          {!activeCommentGroupId && cursorReadout && (
            <>
              <div
                data-testid="price-chart-x-axis-cursor-label"
                aria-hidden="true"
                className="pointer-events-none absolute z-10 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-white shadow"
                style={{ left: cursorReadout.xLabelLeft, top: cursorReadout.xLabelTop }}
              >
                {formatChartTime(cursorReadout.time)}
              </div>
              {!isCategorical && cursorReadout.price !== null && (
                <div
                  data-testid="price-chart-y-axis-cursor-label"
                  aria-hidden="true"
                  className="pointer-events-none absolute z-10 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-white shadow"
                  style={{ left: cursorReadout.yLabelLeft, top: cursorReadout.yLabelTop }}
                >
                  {formatPercent(cursorReadout.price)}
                </div>
              )}
            </>
          )}
          <div
            ref={commentMarkerLayerRef}
            data-testid="price-chart-comment-markers"
            style={{
              visibility:
                plot &&
                plot.height + 0.5 <
                  commentLayout(plot.width, commentGroupResult.groups.length).requiredPlotHeight
                  ? "hidden"
                  : undefined,
            }}
            aria-label={t("market.chartComments")}
            className="pointer-events-none absolute inset-0 z-20"
          >
            {positionedCommentGroups.map((group) => {
              const markerText = t("market.chartCommentMarker", {
                time: formatCommentTime(group.timestamp),
                count: group.comments.length,
              });
              const label = group.seriesLabel ? `${group.seriesLabel}: ${markerText}` : markerText;
              const expanded = activeCommentGroupId === group.id;
              const resting = commentMarkerPresentation(group.comments, plot?.width);
              const left = expanded ? commentPopoverLeft : group.left;
              const top = expanded ? commentPopoverTop : group.top;
              const width = expanded ? commentPopoverWidth : resting.width;
              const height = expanded ? commentPopoverHeight : resting.height;
              const transition = geometryChanged || !layoutReady ? "none" : undefined;
              return (
                <div key={group.id} className="contents">
                  <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-0 overflow-visible"
                    width={chartRegionWidth}
                    height={chartRegionHeight}
                    viewBox={`0 0 ${chartRegionWidth} ${chartRegionHeight}`}
                  >
                    <path
                      data-testid={
                        expanded ? "price-chart-comment-panel-tail" : "price-chart-comment-tail"
                      }
                      data-anchor-x={group.anchorLeft}
                      data-anchor-y={group.anchorTop}
                      data-series-id={group.seriesId}
                      d={commentTailPath({ ...group, left, top }, width, height)}
                      className="price-chart-comment-tail fill-slate-200 stroke-slate-400 dark:fill-slate-800 dark:stroke-slate-600"
                      style={{ opacity: expanded ? 1 : resting.opacity, transition }}
                    />
                  </svg>
                  <div
                    data-testid="price-chart-comment-bubble"
                    data-expanded={expanded}
                    data-series-id={group.seriesId}
                    className={`price-chart-comment-bubble absolute rounded-lg border border-slate-400 bg-slate-200 text-slate-800 shadow-sm focus-within:ring-2 focus-within:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 ${expanded ? "z-30 shadow-xl" : "z-10"}`}
                    style={{
                      left,
                      top,
                      width,
                      height,
                      opacity: expanded ? 1 : resting.opacity,
                      transition,
                      pointerEvents: layoutReady ? "auto" : "none",
                    }}
                    onPointerDown={() => {
                      if (expanded) pinnedCommentGroupIdRef.current = group.id;
                    }}
                    onPointerEnter={() => {
                      pointerGroupRef.current = group.id;
                      if (dismissTimerRef.current !== null)
                        window.clearTimeout(dismissTimerRef.current);
                      dismissTimerRef.current = null;
                    }}
                    onPointerLeave={() => {
                      if (dismissedHoverGroupRef.current === group.id)
                        dismissedHoverGroupRef.current = null;
                      pointerGroupRef.current = null;
                      scheduleCommentPopoverDismiss();
                    }}
                    onFocusCapture={() => {
                      if (dismissTimerRef.current !== null)
                        window.clearTimeout(dismissTimerRef.current);
                      dismissTimerRef.current = null;
                    }}
                    onBlurCapture={scheduleCommentPopoverDismiss}
                  >
                    <button
                      type="button"
                      data-testid="price-chart-comment-marker"
                      data-chart-comment-marker="true"
                      data-series-id={group.seriesId}
                      data-anchor-x={group.anchorLeft}
                      data-anchor-y={group.anchorTop}
                      aria-label={label}
                      aria-haspopup="dialog"
                      aria-expanded={expanded}
                      aria-controls={`price-chart-comments-${group.id}`}
                      className="absolute flex min-h-11 items-center rounded-lg px-2 py-1 text-left text-sm leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      style={{
                        left: group.left - left,
                        top: group.top - top,
                        width: resting.width,
                        height: resting.height,
                        opacity: expanded ? 0 : 1,
                        pointerEvents: expanded || !layoutReady ? "none" : "auto",
                      }}
                      onPointerDown={(event) => {
                        // Explicit selection owns the pin before touch's default focus.
                        activateCommentMarker(group, event.currentTarget, "pin");
                      }}
                      onPointerEnter={(event) => {
                        if (event.pointerType !== "touch")
                          activateCommentMarker(group, event.currentTarget, "hover");
                      }}
                      onFocus={(event) => {
                        if (ignoreNextMarkerFocusRef.current) {
                          ignoreNextMarkerFocusRef.current = false;
                          return;
                        }
                        activateCommentMarker(group, event.currentTarget, "focus");
                      }}
                      onClick={(event) => {
                        activateCommentMarker(group, event.currentTarget, "pin");
                      }}
                    >
                      <span
                        data-testid="price-chart-comment-preview"
                        className="line-clamp-2 break-words [overflow-wrap:anywhere]"
                      >
                        {commentPreview(group.comments[0]?.content ?? "")}
                      </span>
                    </button>
                    {expanded && (
                      <div
                        ref={commentPopoverRef}
                        id={`price-chart-comments-${group.id}`}
                        data-testid="price-chart-comment-popover"
                        role="dialog"
                        aria-label={t("market.chartComments")}
                        className="price-chart-comment-content relative h-full overflow-hidden rounded-lg"
                        onClick={() => {
                          pinnedCommentGroupIdRef.current = group.id;
                        }}
                      >
                        <div
                          role="region"
                          aria-label={t("market.chartComments")}
                          tabIndex={0}
                          className="h-full overflow-y-auto p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                        >
                          <ul className="space-y-3">
                            {group.comments.map((comment, index) => (
                              <li
                                key={comment.id}
                                className="border-b border-slate-300 pb-2 last:border-0 last:pb-0 dark:border-slate-700"
                              >
                                <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-[11px] text-slate-600 dark:text-slate-300">
                                  <span
                                    className="col-start-1 row-start-1 min-w-0 truncate font-medium"
                                    data-testid="price-chart-comment-author"
                                    title={comment.userId}
                                  >
                                    {authorProfiles.get(comment.userId)?.displayName.trim() ||
                                      comment.userDisplayName}
                                  </span>
                                  <time
                                    className="col-span-2 row-start-2 min-w-0 [overflow-wrap:anywhere]"
                                    dateTime={comment.timestamp}
                                  >
                                    {formatCommentTime(Date.parse(comment.timestamp))}
                                  </time>
                                  {index === 0 && (
                                    <button
                                      type="button"
                                      aria-label={t("common.close")}
                                      className="col-start-2 row-start-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-slate-700"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        closeCommentPopover(true);
                                      }}
                                    >
                                      <X aria-hidden="true" className="h-4 w-4" />
                                    </button>
                                  )}
                                </div>
                                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
                                  {comment.content}
                                </p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {commentGroupResult.hiddenCount > 0 && (
              <div
                data-testid="price-chart-comment-markers-hidden"
                className="pointer-events-none absolute bottom-1 left-1 rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] text-white"
              >
                {t("market.chartCommentMarkersHidden", {
                  count: commentGroupResult.hiddenCount,
                })}
              </div>
            )}
          </div>
        </div>,
        overlay,
      )}
    </>
  );
}
