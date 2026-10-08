import { useEffect, useMemo, useRef, useState } from "react";
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
  createChartTimeFormatter,
  createCommentTimeFormatter,
  formatPercent,
  type CommentGroupResult,
  type PositionedCommentGroup,
  type Series,
} from "./priceChartModel";

const MAX_AUTHOR_PROFILE_LOOKUPS = 40;
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
  const commentMarkerLayerRef = useRef<HTMLDivElement | null>(null);
  const commentPopoverRef = useRef<HTMLDivElement | null>(null);
  const activeMarkerRef = useRef<HTMLButtonElement | null>(null);
  const ignoreNextMarkerFocusRef = useRef(false);
  const dismissTimerRef = useRef<number | null>(null);
  const pinnedCommentGroupIdRef = useRef<string | null>(null);
  const [activeCommentGroupId, setActiveCommentGroupId] = useState<string | null>(null);
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
      positioned.push({
        ...group,
        anchorLeft,
        anchorTop,
        plotLeft: anchorLeft - plot.x,
        plotTop: anchorTop - plot.y,
        ...chooseMarkerBodyPosition(
          anchorLeft,
          anchorTop,
          chartRegionWidth,
          chartRegionHeight,
          positioned,
        ),
      });
    }
    return positioned;
  }, [commentGroupResult, xScale, yScale, plot, chartRegionWidth, chartRegionHeight]);
  const activeCommentGroup = positionedCommentGroups.find(
    (group) => group.id === activeCommentGroupId,
  );
  useEffect(() => {
    if (!activeGroup) return undefined;
    let cancelled = false;
    const authors = [...new Set(activeGroup.comments.map((comment) => comment.userId))].filter(
      (author) => /^[0-9a-f]{64}$/.test(author),
    );
    const requests = profileRequests;
    for (const author of authors) {
      if (requests.has(author)) continue;
      // Best-effort display enrichment must remain bounded even across repeated group changes.
      if (requests.size >= MAX_AUTHOR_PROFILE_LOOKUPS) break;
      requests.set(
        author,
        fetchPublicNostrProfile(author).catch(() => null),
      );
    }
    if (!authors.some((author) => requests.has(author))) return undefined;
    void Promise.all(
      authors
        .filter((author) => requests.has(author))
        .map(async (author) => [author, (await requests.get(author)) ?? null] as const),
    ).then((profiles) => {
      if (!cancelled) setAuthorProfiles(new Map(profiles));
    });
    return () => {
      cancelled = true;
    };
  }, [activeGroup, profileRequests]);
  const commentPopoverWidth = Math.max(1, Math.min(288, chartRegionWidth - 8));
  const commentPopoverBelow = activeCommentGroup
    ? chartRegionHeight - activeCommentGroup.anchorTop >= activeCommentGroup.anchorTop
    : true;
  const commentPopoverSpace = activeCommentGroup
    ? (commentPopoverBelow
        ? chartRegionHeight - activeCommentGroup.anchorTop
        : activeCommentGroup.anchorTop) - 12
    : chartRegionHeight - 8;
  const commentPopoverHeight = Math.max(1, Math.min(176, commentPopoverSpace));
  const commentPopoverLeft = activeCommentGroup
    ? clampPosition(activeCommentGroup.anchorLeft + 8, commentPopoverWidth, chartRegionWidth)
    : 4;
  const commentPopoverTop = activeCommentGroup
    ? clampPosition(
        commentPopoverBelow
          ? activeCommentGroup.anchorTop + 8
          : activeCommentGroup.anchorTop - commentPopoverHeight - 8,
        commentPopoverHeight,
        chartRegionHeight,
      )
    : 4;

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
    setActiveCommentGroupId(null);
    if (
      restoreFocus &&
      activeMarkerRef.current &&
      document.activeElement !== activeMarkerRef.current
    ) {
      ignoreNextMarkerFocusRef.current = true;
      activeMarkerRef.current.focus();
    }
  };

  const activateCommentMarker = (group: PositionedCommentGroup, marker: HTMLButtonElement) => {
    if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    activeMarkerRef.current = marker;
    setActiveCommentGroupId(group.id);
    onCursorTime(group.timestamp);
  };

  const scheduleCommentPopoverDismiss = () => {
    if (pinnedCommentGroupIdRef.current !== null || dismissTimerRef.current !== null) return;
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      setActiveCommentGroupId(null);
    }, 120);
  };

  useEffect(() => {
    if (
      activeCommentGroupId === null ||
      commentGroupResult.groups.some((group) => group.id === activeCommentGroupId)
    ) {
      return;
    }
    pinnedCommentGroupIdRef.current = null;
    setActiveCommentGroupId(null);
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
        {cursorX !== undefined && cursorTime !== null && (
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
        {!isCategorical && cursorY !== undefined && (
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
          {cursorReadout && (
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
            aria-label={t("market.chartComments")}
            className="pointer-events-none absolute inset-0 z-20"
          >
            <svg
              data-testid="price-chart-comment-tails"
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              width={chartRegionWidth}
              height={chartRegionHeight}
              viewBox={`0 0 ${chartRegionWidth} ${chartRegionHeight}`}
              preserveAspectRatio="none"
            >
              {positionedCommentGroups.map((group) => (
                <path
                  key={group.id}
                  data-testid="price-chart-comment-tail"
                  data-anchor-x={group.anchorLeft}
                  data-anchor-y={group.anchorTop}
                  data-series-id={group.seriesId}
                  d={commentTailPath(group)}
                  className="fill-slate-400/60 stroke-slate-600 dark:fill-slate-500/60 dark:stroke-slate-300"
                  strokeWidth="1"
                />
              ))}
            </svg>
            {positionedCommentGroups.map((group) => {
              const markerText = t("market.chartCommentMarker", {
                time: formatCommentTime(group.timestamp),
                count: group.comments.length,
              });
              const label = group.seriesLabel ? `${group.seriesLabel}: ${markerText}` : markerText;
              const expanded = activeCommentGroupId === group.id;
              return (
                <button
                  key={group.id}
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
                  title={label}
                  className="pointer-events-auto absolute flex h-[18px] w-6 items-center justify-center rounded-full border border-slate-600 bg-slate-400/60 px-1 text-[10px] font-bold leading-none text-slate-950 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-300 dark:bg-slate-500/60 dark:text-white"
                  style={{
                    left: group.left,
                    top: group.top,
                    pointerEvents: layoutReady ? "auto" : "none",
                  }}
                  onPointerEnter={(event) => activateCommentMarker(group, event.currentTarget)}
                  onPointerLeave={scheduleCommentPopoverDismiss}
                  onFocus={(event) => {
                    if (ignoreNextMarkerFocusRef.current) {
                      ignoreNextMarkerFocusRef.current = false;
                      return;
                    }
                    activateCommentMarker(group, event.currentTarget);
                  }}
                  onBlur={scheduleCommentPopoverDismiss}
                  onClick={(event) => {
                    if (pinnedCommentGroupIdRef.current === group.id) {
                      closeCommentPopover(false);
                    } else {
                      pinnedCommentGroupIdRef.current = group.id;
                      activateCommentMarker(group, event.currentTarget);
                    }
                  }}
                >
                  {group.comments.length > 1 ? group.comments.length : "•"}
                </button>
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
          {activeCommentGroup && (
            <>
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 z-30"
                width={chartRegionWidth}
                height={chartRegionHeight}
                viewBox={`0 0 ${chartRegionWidth} ${chartRegionHeight}`}
                preserveAspectRatio="none"
              >
                <path
                  data-testid="price-chart-comment-panel-tail"
                  data-anchor-x={activeCommentGroup.anchorLeft}
                  data-anchor-y={activeCommentGroup.anchorTop}
                  d={commentTailPath(
                    {
                      ...activeCommentGroup,
                      left: commentPopoverLeft,
                      top: commentPopoverTop,
                    },
                    commentPopoverWidth,
                    commentPopoverHeight,
                  )}
                  className="fill-white stroke-slate-200 dark:fill-slate-800 dark:stroke-slate-600"
                />
              </svg>
              <div
                ref={commentPopoverRef}
                id={`price-chart-comments-${activeCommentGroup.id}`}
                data-testid="price-chart-comment-popover"
                role="dialog"
                aria-label={t("market.chartCommentsAt", {
                  time: formatCommentTime(activeCommentGroup.timestamp),
                })}
                className="pointer-events-auto absolute z-30 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-800 shadow-xl dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                style={{
                  left: commentPopoverLeft,
                  top: commentPopoverTop,
                  width: commentPopoverWidth,
                  height: commentPopoverHeight,
                  maxHeight: commentPopoverHeight,
                  pointerEvents: layoutReady ? "auto" : "none",
                }}
                onPointerEnter={() => {
                  if (dismissTimerRef.current !== null)
                    window.clearTimeout(dismissTimerRef.current);
                  dismissTimerRef.current = null;
                }}
                onPointerLeave={scheduleCommentPopoverDismiss}
                onFocusCapture={() => {
                  if (dismissTimerRef.current !== null)
                    window.clearTimeout(dismissTimerRef.current);
                  dismissTimerRef.current = null;
                }}
                onBlurCapture={scheduleCommentPopoverDismiss}
              >
                <div className="flex items-center justify-between gap-2 px-3 pt-2">
                  <time
                    className="text-[11px] text-slate-500 dark:text-slate-400"
                    dateTime={new Date(activeCommentGroup.timestamp).toISOString()}
                  >
                    {formatCommentTime(activeCommentGroup.timestamp)}
                  </time>
                  <button
                    type="button"
                    aria-label={t("common.close")}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-300 dark:hover:bg-slate-700"
                    onClick={() => closeCommentPopover(true)}
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
                <div
                  role="region"
                  aria-label={t("market.chartCommentsAt", {
                    time: formatCommentTime(activeCommentGroup.timestamp),
                  })}
                  tabIndex={0}
                  className="min-h-0 overflow-y-auto p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:focus-visible:ring-blue-300"
                >
                  <ul className="space-y-3">
                    {activeCommentGroup.comments.map((comment) => (
                      <li
                        key={comment.id}
                        className="border-b border-slate-100 pb-2 last:border-0 last:pb-0 dark:border-slate-700"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                          <span
                            className="truncate font-medium"
                            data-testid="price-chart-comment-author"
                            title={comment.userId}
                          >
                            {authorProfiles.get(comment.userId)?.displayName.trim() ||
                              comment.userDisplayName}
                          </span>
                          <time className="shrink-0" dateTime={comment.timestamp}>
                            {formatCommentTime(Date.parse(comment.timestamp))}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-xs">{comment.content}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}
        </div>,
        overlay,
      )}
    </>
  );
}
