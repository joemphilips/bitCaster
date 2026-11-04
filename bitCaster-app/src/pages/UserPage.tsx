import { Component, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { nip19 } from "nostr-tools";
import { BadgeCheck, Globe } from "lucide-react";
import {
  parseNostrPublicKey,
  type NostrFollowCount,
  type NostrProfilePageMetadata,
  type NostrProfilePageSnapshot,
} from "@bitcaster/client-sdk/nostrProfilePage";
import type { NostrProfileIndexerStats } from "@bitcaster/client-sdk/primalProfileIndexer";
import { CopyNpubButton } from "@/components/shared/CopyNpubButton";
import { useAbortableLoad, type Loadable } from "@/hooks/useAbortableLoad";
import { assertNever } from "@/lib/enumDiscipline";
import { getMarketThumbnail, getMarkets } from "@/lib/markets";
import {
  loadNip05Verification,
  loadProfileIndexerStats,
  loadProfilePage,
  profilePageRelayUrls,
} from "@/lib/nostrProfilePage";
import { useSettingsStore } from "@/stores/settings";
import type { Market } from "@/types/market";

const CREATED_MARKETS_PAGE_SIZE = 20;

function formatShortNpub(npub: string): string {
  return npub.length <= 24 ? npub : `${npub.slice(0, 12)}...${npub.slice(-8)}`;
}

/** A Date for Unix seconds, or null outside the Date range. */
function dateFromSeconds(seconds: number): Date | null {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A render failure in one profile shows a local message instead of a blank app. */
class ProfileRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <ProfileRenderFailed /> : this.props.children;
  }
}

function ProfileRenderFailed() {
  const { t } = useTranslation();
  return (
    <p className="px-4 py-8 text-sm text-slate-600 dark:text-slate-400">
      {t("userProfile.renderFailed")}
    </p>
  );
}

export function UserPage() {
  const { t } = useTranslation();
  const { pubkey: routeKey = "" } = useParams();
  const pubkey = parseNostrPublicKey(routeKey);
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-3xl pb-10">
        {pubkey ? (
          <ProfileRenderBoundary key={pubkey}>
            <NostrProfileView pubkey={pubkey} />
          </ProfileRenderBoundary>
        ) : (
          <p className="px-4 py-8 text-sm text-slate-600 dark:text-slate-400">
            {t("userProfile.invalidKey")}
          </p>
        )}
      </div>
    </div>
  );
}

function NostrProfileView({ pubkey }: { pubkey: string }) {
  const relayConfigs = useSettingsStore((s) => s.relays);
  const indexerEnabled = useSettingsStore((s) => s.profileIndexerEnabled);
  const relays = useMemo(() => profilePageRelayUrls(relayConfigs), [relayConfigs]);
  const relayKey = `${pubkey} ${relays.join(" ")}`;
  const page = useAbortableLoad(relayKey, (signal) => loadProfilePage(pubkey, relays, signal));
  const indexer = useAbortableLoad(`${pubkey} ${indexerEnabled}`, (signal) =>
    loadProfileIndexerStats(pubkey, indexerEnabled, signal),
  );
  const markets = useAbortableLoad(pubkey, async () => {
    const page = await getMarkets({
      creatorPubkey: pubkey,
      state: "All",
      sort: "new",
      pageSize: CREATED_MARKETS_PAGE_SIZE,
    });
    return page.markets;
  });
  return (
    <>
      <ProfileHeader pubkey={pubkey} page={page} indexer={indexer} />
      <CreatedMarkets markets={markets} />
      <RecentNotes page={page} />
    </>
  );
}

function ProfileHeader({
  pubkey,
  page,
  indexer,
}: {
  pubkey: string;
  page: Loadable<NostrProfilePageSnapshot>;
  indexer: Loadable<NostrProfileIndexerStats | null>;
}) {
  const { t } = useTranslation();
  const npub = nip19.npubEncode(pubkey);
  const profile =
    page.status === "ready" && page.value.metadata.status === "found"
      ? page.value.metadata.metadata
      : null;
  // Single-line names have no invisible characters, so an empty name falls back to the key.
  const title = profile?.displayName || formatShortNpub(npub);
  // Without a banner image the page shows no banner area, so the picture does not overlap it.
  const [failedBanner, setFailedBanner] = useState<string | null>(null);
  const banner = profile?.banner && profile.banner !== failedBanner ? profile.banner : null;
  return (
    <header aria-busy={page.status === "loading"}>
      {banner && (
        <img
          src={banner}
          alt=""
          data-testid="profile-banner"
          className="h-32 w-full object-cover sm:h-48"
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailedBanner(banner)}
        />
      )}
      <div className="px-4 sm:px-6">
        <div
          className={`${banner ? "-mt-10" : "mt-6"} h-20 w-20 overflow-hidden rounded-full border-4 border-slate-50 bg-slate-200 dark:border-slate-950 dark:bg-slate-800`}
        >
          <ProfileImage
            url={profile?.picture ?? null}
            testId="profile-picture"
            className="h-full w-full object-cover"
            fallback={
              <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-slate-500 dark:text-slate-400">
                {Array.from(title)[0]?.toUpperCase()}
              </div>
            }
          />
        </div>
        {/* Without a name the heading is the short Nostr ID, so its copy control sits beside it. */}
        <div className="mt-3 flex items-center gap-1">
          <h1 className="min-w-0 text-2xl font-bold text-slate-900 [overflow-wrap:anywhere] dark:text-white">
            {title}
          </h1>
          {!profile?.displayName && <NpubCopyButton npub={npub} />}
        </div>
        {profile?.name && profile.name !== profile.displayName && (
          <p className="text-sm text-slate-500 [overflow-wrap:anywhere] dark:text-slate-400">
            @{profile.name}
          </p>
        )}
        {profile?.nip05 && <Nip05Address address={profile.nip05} pubkey={pubkey} />}
        {profile?.displayName && (
          <div className="mt-1 flex items-center gap-1 text-slate-500 dark:text-slate-400">
            <span className="font-mono text-xs" title={npub}>
              {formatShortNpub(npub)}
            </span>
            <NpubCopyButton npub={npub} />
          </div>
        )}
        {profile && <ProfileDetails profile={profile} />}
        <ProfileStats
          follows={page.status === "ready" ? page.value.follows : null}
          loading={page.status === "loading" || indexer.status === "loading"}
          indexer={indexer}
        />
        <ProfileReadState page={page} />
        {page.status === "loading" && (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {t("userProfile.loading")}
          </p>
        )}
      </div>
    </header>
  );
}

/** The profile owner names the image hosts. Send those hosts no referrer. */
function ProfileImage({
  url,
  testId,
  className,
  fallback,
}: {
  url: string | null;
  testId: string;
  className: string;
  fallback: React.ReactNode;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) return <>{fallback}</>;
  return (
    <img
      src={url}
      alt=""
      data-testid={testId}
      className={className}
      referrerPolicy="no-referrer"
      decoding="async"
      onError={() => setFailedUrl(url)}
    />
  );
}

/** Show the address only after its domain maps it to this key. A failed check shows nothing. */
function Nip05Address({ address, pubkey }: { address: string; pubkey: string }) {
  const verified = useAbortableLoad(`${pubkey} ${address}`, (signal) =>
    loadNip05Verification(address, pubkey, signal),
  );
  if (verified.status !== "ready" || !verified.value) return null;
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-slate-600 dark:text-slate-300">
      <BadgeCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-500" />
      <span className="truncate">{address.startsWith("_@") ? address.slice(2) : address}</span>
    </p>
  );
}

/** On a narrow screen a long description shows its first lines until the user opens it. */
const ABOUT_CLAMP_LINES = 6;
const ABOUT_CLAMP_CHARACTERS = 320;

function ProfileDetails({ profile }: { profile: NostrProfilePageMetadata }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const longAbout =
    profile.about.length > ABOUT_CLAMP_CHARACTERS ||
    profile.about.split("\n").length > ABOUT_CLAMP_LINES;
  const clamped = longAbout && !expanded;
  return (
    <>
      {profile.website && (
        <a
          href={profile.website}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex max-w-full items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          <Globe aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="truncate">{new URL(profile.website).hostname}</span>
        </a>
      )}
      {profile.about && (
        <p
          id="profile-about"
          data-testid="profile-about"
          data-user-content
          className={`mt-3 whitespace-pre-wrap text-sm text-slate-700 [overflow-wrap:anywhere] dark:text-slate-300 ${
            clamped ? "line-clamp-6 sm:line-clamp-none" : ""
          }`}
        >
          {profile.about}
        </p>
      )}
      {longAbout && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="profile-about"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400 sm:hidden"
        >
          {t(expanded ? "userProfile.showLess" : "userProfile.showMore")}
        </button>
      )}
    </>
  );
}

function ProfileReadState({ page }: { page: Loadable<NostrProfilePageSnapshot> }) {
  const { t } = useTranslation();
  const message =
    page.status === "unavailable"
      ? t("userProfile.relaysUnavailable")
      : page.status === "ready" && page.value.metadata.status === "not-found"
        ? t("userProfile.notFound")
        : null;
  return message ? (
    <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{message}</p>
  ) : null;
}

function NpubCopyButton({ npub }: { npub: string }) {
  const { t } = useTranslation();
  return (
    <CopyNpubButton
      npub={npub}
      label={t("userProfile.copyNpub")}
      copiedMessage={t("userProfile.npubCopied")}
      failedMessage={t("userProfile.npubCopyFailed")}
      iconSize="sm"
      className="p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
    />
  );
}

/** The indexer values name their source: they are not relay data. */
function ProfileStats({
  follows,
  loading,
  indexer,
}: {
  follows: NostrFollowCount | null;
  loading: boolean;
  indexer: Loadable<NostrProfileIndexerStats | null>;
}) {
  const { t, i18n } = useTranslation();
  const counted = (count: number) => ({
    count,
    formattedCount: count.toLocaleString(i18n.language),
  });
  const stats = indexer.status === "ready" ? indexer.value : null;
  const items: string[] = [];
  if (follows?.status === "counted") items.push(t("userProfile.following", counted(follows.count)));
  if (stats?.followersCount != null)
    items.push(t("userProfile.followers", counted(stats.followersCount)));
  const firstSeen = stats?.firstActivityAt != null ? dateFromSeconds(stats.firstActivityAt) : null;
  if (firstSeen)
    items.push(
      t("userProfile.firstSeen", {
        date: firstSeen.toLocaleDateString(i18n.language, { year: "numeric", month: "long" }),
      }),
    );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
      {loading && (
        <span
          aria-hidden="true"
          data-testid={indexer.status === "loading" ? "indexer-loading" : undefined}
          className="h-4 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800"
        />
      )}
    </div>
  );
}

function SectionMessage({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{children}</p>;
}

function ProfileSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-8 px-4 sm:px-6">
      <h2
        id={id}
        className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function RecentNotes({ page }: { page: Loadable<NostrProfilePageSnapshot> }) {
  const { t } = useTranslation();
  const notes = page.status === "ready" ? page.value.notes : [];
  return (
    <ProfileSection id="profile-notes-heading" title={t("userProfile.notes")}>
      {page.status === "loading" && <SectionMessage>{t("common.loading")}</SectionMessage>}
      {page.status === "unavailable" && (
        <SectionMessage>{t("userProfile.notesUnavailable")}</SectionMessage>
      )}
      {page.status === "ready" && notes.length === 0 && (
        <SectionMessage>{t("userProfile.noNotes")}</SectionMessage>
      )}
      {notes.length > 0 && (
        <ol className="mt-3 space-y-3">
          {notes.map((note) => (
            <li
              key={note.id}
              data-testid="profile-note"
              className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
            >
              <NoteTime seconds={note.createdAt} />
              <p
                data-user-content
                className="mt-1 whitespace-pre-wrap text-sm text-slate-800 [overflow-wrap:anywhere] dark:text-slate-200"
              >
                {note.content}
              </p>
            </li>
          ))}
        </ol>
      )}
    </ProfileSection>
  );
}

/** The reader bounds note times. The check keeps an out-of-range time from failing the render. */
function NoteTime({ seconds }: { seconds: number }) {
  const { i18n } = useTranslation();
  const date = dateFromSeconds(seconds);
  if (!date) return null;
  return (
    <time dateTime={date.toISOString()} className="text-xs text-slate-500 dark:text-slate-400">
      {date.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}

function marketStateLabel(state: Market["state"], t: (key: string) => string): string {
  switch (state) {
    case "open":
      return t("marketStatus.active");
    case "closed":
      return t("market.closed");
    default:
      return assertNever(state);
  }
}

function CreatedMarkets({ markets }: { markets: Loadable<Market[]> }) {
  const { t } = useTranslation();
  return (
    <ProfileSection id="profile-markets-heading" title={t("userProfile.createdMarkets")}>
      {markets.status === "loading" && <SectionMessage>{t("common.loading")}</SectionMessage>}
      {markets.status === "unavailable" && (
        <SectionMessage>{t("userProfile.createdMarketsUnavailable")}</SectionMessage>
      )}
      {markets.status === "ready" && markets.value.length === 0 && (
        <SectionMessage>{t("userProfile.noCreatedMarkets")}</SectionMessage>
      )}
      {markets.status === "ready" && markets.value.length > 0 && (
        <ul className="mt-3 space-y-2">
          {markets.value.map((market) => (
            <li key={market.id}>
              <CreatedMarketLink market={market} />
            </li>
          ))}
        </ul>
      )}
    </ProfileSection>
  );
}

function CreatedMarketLink({ market }: { market: Market }) {
  const { t } = useTranslation();
  const thumbnail = getMarketThumbnail(market);
  return (
    <Link
      to={`/markets/${encodeURIComponent(market.id)}`}
      className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
      ) : (
        <div className="h-10 w-10 shrink-0 rounded-md bg-slate-200 dark:bg-slate-800" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-white">
        {market.title}
      </span>
      <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
        {marketStateLabel(market.state, t)}
      </span>
    </Link>
  );
}
