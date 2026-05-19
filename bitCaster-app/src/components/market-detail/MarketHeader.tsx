import {
  Heart,
  Share2,
  Clock,
  CheckCircle2,
  Users,
  Landmark,
  Copy,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { MarketDetail } from "@/types/market-detail";
import { formatBtc } from "@/lib/format";
import { fetchPublicNostrProfile, type PublicNostrProfile } from "@/lib/nostr";
import { getMintIconUrl } from "@/lib/mints";
import { useBookmarkStore } from "@/stores/bookmarks";
import { useWalletStore } from "@/stores/wallet";

interface MarketHeaderProps {
  market: MarketDetail;
  onShare?: () => void;
}

const HexPubkeyPattern = /^[0-9a-f]{64}$/i;

function formatCreatorNpub(creatorId: string): string | null {
  const trimmed = creatorId.trim();
  if (!trimmed || trimmed === "unknown") return null;
  if (trimmed.startsWith("npub1")) return trimmed;
  if (HexPubkeyPattern.test(trimmed))
    return nip19.npubEncode(trimmed.toLowerCase());
  return trimmed;
}

function formatShortNpub(npub: string): string {
  if (npub.length <= 24) return npub;
  return `${npub.slice(0, 12)}...${npub.slice(-8)}`;
}

function creatorIdToHex(creatorId: string): string | null {
  const trimmed = creatorId.trim();
  if (HexPubkeyPattern.test(trimmed)) return trimmed.toLowerCase();
  if (!trimmed.startsWith("npub1")) return null;
  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

function formatTimeRemaining(
  closingDate: string | null,
  now: Date,
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: string,
): string {
  if (!closingDate) return "";

  const close = new Date(closingDate);
  const diff = close.getTime() - now.getTime();

  if (diff < 0) return "";

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 7) {
    return new Date(closingDate).toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  if (days > 0) return t("market.daysHoursRemaining", { days, hours });
  if (hours > 0) return t("market.hoursRemaining", { hours });

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return t("market.minutesRemaining", { minutes });
}

export function MarketHeader({ market, onShare }: MarketHeaderProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const activeMint = useWalletStore((s) =>
    s.mints.find((m) => m.url === activeMintUrl),
  );
  const isResolved = market.resolution.status === "resolved";
  const isEngineClosed = market.state === "closed";
  const isClosed = isResolved || isEngineClosed;
  const [now, setNow] = useState(() => new Date());
  const timeRemaining =
    isEngineClosed && !isResolved
      ? t("market.closed")
      : formatTimeRemaining(market.closingDate, now, t, i18n.language);
  const isClosingSoon =
    !isClosed &&
    market.closingDate != null &&
    new Date(market.closingDate).getTime() - now.getTime() <
      7 * 24 * 60 * 60 * 1000;
  const isBookmarked = useBookmarkStore((s) => s.markets.includes(market.id));
  const toggleBookmark = useBookmarkStore((s) => s.toggle);
  const creatorNpub = formatCreatorNpub(market.creator.id);
  const [oracleProfile, setOracleProfile] = useState<PublicNostrProfile | null>(
    null,
  );
  const [oracleProfileLoaded, setOracleProfileLoaded] = useState(false);
  const creatorHex = creatorIdToHex(market.creator.id);
  const creatorLabel =
    oracleProfile?.displayName ??
    (creatorNpub
      ? formatShortNpub(creatorNpub)
      : t("market.oraclePubkeyUnavailable"));
  const mintIconUrl = activeMint
    ? getMintIconUrl(
        activeMint.url,
        activeMint.info as Record<string, unknown> | undefined,
      )
    : undefined;
  const mintLabel = market.mint
    ? `${market.mint.collateral.toUpperCase()} CTF${
        market.mint.keysetCount > 0
          ? ` - ${market.mint.keysetCount} keysets`
          : ""
      }`
    : "Unknown";

  useEffect(() => {
    let cancelled = false;
    setOracleProfile(null);
    setOracleProfileLoaded(false);
    if (!creatorHex) {
      setOracleProfileLoaded(true);
      return;
    }
    fetchPublicNostrProfile(creatorHex).then((profile) => {
      if (cancelled) return;
      setOracleProfile(profile);
      setOracleProfileLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [creatorHex]);

  useEffect(() => {
    if (!market.closingDate || isClosed) return;
    setNow(new Date());
    const intervalId = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(intervalId);
  }, [market.closingDate, isClosed]);

  const resolvedDate = isResolved
    ? new Date(market.resolution.resolutionDate).toLocaleDateString(
        i18n.language,
        {
          month: "long",
          day: "numeric",
          year: "numeric",
        },
      )
    : null;

  return (
    <div className="relative">
      {/* Background Image with Gradient Overlay */}
      {market.imageUrl && (
        <div className="absolute inset-0 h-64 overflow-hidden rounded-t-2xl">
          <img
            src={market.imageUrl}
            alt=""
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-900/60 via-slate-900/80 to-slate-900" />
        </div>
      )}

      {/* Content */}
      <div
        className={`relative ${market.imageUrl ? "pt-8 pb-6 px-6" : "py-6 px-6"}`}
      >
        {/* Category Tags */}
        <div className="flex flex-wrap gap-2 mb-4">
          {market.categoryTags.map((tag) => (
            <span
              key={tag.id}
              className="px-3 py-1 text-xs font-medium rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30"
            >
              {tag.label}
            </span>
          ))}
        </div>

        {/* Title */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h1
            className={`text-2xl md:text-3xl font-bold leading-tight ${market.imageUrl ? "text-white" : "text-slate-900 dark:text-white"}`}
          >
            {market.title}
          </h1>
          {isClosed && (
            <div className="shrink-0">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 uppercase tracking-wider">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {isResolved ? t("marketStatus.resolved") : t("market.closed")}
              </span>
              {market.resolution.finalOutcome && (
                <div className="mt-2 text-right">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-500/80">
                    {t("market.finalOutcome")}
                  </p>
                  <p className="text-2xl font-black leading-tight text-emerald-400">
                    {market.resolution.finalOutcome}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Meta Row */}
        <div className="flex flex-wrap items-center gap-4 mb-4">
          {/* Time Remaining / Resolved Date — hidden when no real deadline known */}
          {(isClosed || timeRemaining) && (
            <div
              className={`flex items-center gap-1.5 ${isClosed ? "text-slate-400" : isClosingSoon ? "text-amber-400" : market.imageUrl ? "text-slate-300" : "text-slate-600 dark:text-slate-400"}`}
            >
              {isClosed ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <Clock className="w-4 h-4" />
              )}
              <span className="text-sm font-medium">
                {isResolved
                  ? t("market.resolvedOn", { date: resolvedDate })
                  : timeRemaining}
              </span>
            </div>
          )}

          {/* Share Button */}
          <button
            onClick={onShare}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors ${market.imageUrl ? "bg-white/10 text-slate-300 hover:bg-white/20" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
          >
            <Share2 className="w-4 h-4" />
            <span className="text-sm font-medium">{t("common.share")}</span>
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          {/* Creator Info */}
          <div
            className={`flex min-w-0 flex-1 items-center gap-3 p-3 rounded-xl ${market.imageUrl ? "bg-white/10" : "bg-slate-100 dark:bg-slate-800"}`}
            title={t("market.oracleAuditHint")}
          >
            {oracleProfile?.avatar || market.creator.avatarUrl ? (
              <img
                src={oracleProfile?.avatar || market.creator.avatarUrl}
                alt={creatorLabel}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold">
                {creatorLabel.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p
                className={`truncate text-sm font-medium ${market.imageUrl ? "text-white" : "text-slate-900 dark:text-white"}`}
              >
                {t("market.oracle")}
              </p>
              <p
                className={`truncate text-xs font-mono ${market.imageUrl ? "text-slate-400" : "text-slate-500 dark:text-slate-400"}`}
              >
                {oracleProfileLoaded
                  ? creatorLabel
                  : t("market.searchingNostr")}
              </p>
            </div>
            {creatorNpub && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(creatorNpub);
                }}
                className={`shrink-0 rounded-full p-2 transition-colors ${market.imageUrl ? "text-slate-300 hover:bg-white/15 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-white"}`}
                aria-label={t("market.copyOraclePubkey")}
                title={t("market.copyOraclePubkey")}
              >
                <Copy className="w-4 h-4" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() =>
              navigate(
                `/mint-details?mintUrl=${encodeURIComponent(activeMintUrl)}`,
              )
            }
            className={`flex min-w-0 flex-1 items-center gap-3 p-3 rounded-xl text-left transition-colors ${market.imageUrl ? "bg-white/10 hover:bg-white/15" : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700"}`}
          >
            <div className="w-10 h-10 overflow-hidden rounded-full bg-amber-500/15 flex items-center justify-center text-amber-500">
              {mintIconUrl ? (
                <img
                  src={mintIconUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display =
                      "none";
                  }}
                />
              ) : (
                <Landmark className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0">
              <p
                className={`truncate text-sm font-medium ${market.imageUrl ? "text-white" : "text-slate-900 dark:text-white"}`}
              >
                Mint
              </p>
              <p
                className={`truncate text-xs font-mono ${market.imageUrl ? "text-slate-400" : "text-slate-500 dark:text-slate-400"}`}
              >
                {mintLabel}
              </p>
            </div>
          </button>
        </div>

        {/* Metrics Footer */}
        <div
          className={`flex items-center justify-between text-xs pt-4 mt-4 border-t ${market.imageUrl ? "border-white/10 text-slate-300" : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400"}`}
        >
          <div
            className="flex items-center gap-1 font-mono font-semibold text-amber-600 dark:text-amber-400"
            title={t("market.volume")}
          >
            <span className="font-sans font-medium text-slate-500 dark:text-slate-400">
              {t("market.volume")}
            </span>
            <span>{formatBtc(market.volume)}</span>
          </div>
          <div className="flex items-center gap-1" title={t("market.traders")}>
            <Users className="w-3.5 h-3.5" />
            <span>{t("market.traders")}</span>
            <span className="font-mono font-medium">
              {market.traderCount.toLocaleString()}
            </span>
          </div>
          <button
            onClick={() => toggleBookmark(market.id)}
            className={`flex items-center cursor-pointer transition-colors ${isBookmarked ? "text-rose-500" : market.imageUrl ? "text-slate-300 hover:text-rose-500" : "text-slate-600 dark:text-slate-400 hover:text-rose-500"}`}
            title={
              isBookmarked ? t("market.removeBookmark") : t("market.bookmark")
            }
            aria-pressed={isBookmarked}
          >
            <Heart
              className="w-3.5 h-3.5"
              fill={isBookmarked ? "currentColor" : "none"}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
