import {
  BrowserRouter,
  Routes,
  Route,
  useNavigate,
  useLocation,
} from "react-router";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/shell";
import { MarketsPage } from "@/pages/MarketsPage";
import { MarketDetailPage } from "@/pages/MarketDetailPage";
import { PortfolioPage } from "@/pages/PortfolioPage";
import { CreatorPage } from "@/pages/CreatorPage";
import { MarketCreationPage } from "@/pages/MarketCreationPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { MintDetailPage } from "@/pages/MintDetailPage";
import { UserPage } from "@/pages/UserPage";
import { useEffect, useRef, useState } from "react";
import { useBookmarkSync } from "@/stores/useBookmarkSync";
import { useCreatorSync } from "@/stores/useCreatorSync";
import { useActivityLogSync } from "@/stores/useActivityLogSync";
import { usePendingTradesPoller } from "@/lib/orderStatus";
import { useTradeSettlement } from "@/hooks/useTradeSettlement";
import { useLikedMarketCloseReconcile } from "@/hooks/useLikedMarketCloseReconcile";
import { useSettingsStore } from "@/stores/settings";
import { useBalance, useWalletStore, DEFAULT_MINT_URL } from "@/stores/wallet";
import { ToastContainer } from "@/components/ui/Toast";
import { startNip17Listener } from "@/lib/nip17-listener";
import { effectiveRelayUrls } from "@/lib/relayDefaults";
import {
  refreshMintInfoWithoutActivating,
  userAddAndSelectMint,
} from "@/lib/walletOps";
import {
  rehydratePersistedNostrIdentity,
  resolveCreatorPubkey,
} from "@/lib/identityOps";
import { sweepElapsedPartialLockFailures } from "@/lib/partialLockRecovery";
import { installE2EDiagnostics } from "@/lib/e2eDiagnostics";
import {
  reconcileGuiEcashDeposits,
  type GuiEcashDepositRemote,
} from "@/lib/guiLocalWalletPayment";
import type { PendingEcashDepositRecoveryCursor } from "@/lib/pendingLocalWalletPayments";
import { getDepositStatus, requestEcashDeposit } from "@/lib/markets";
import {
  requestGuiNativeProofOperationRecovery,
  type GuiNativeProofRecoveryStatus,
} from "@/stores/gui-native-proof-operation-recovery";

installE2EDiagnostics();

const GUI_DEPOSIT_RETRY_BASE_MS = 1_000;
const GUI_DEPOSIT_RETRY_MAX_MS = 60_000;

function guiDepositRetryDelay(failureCount: number): number {
  return Math.min(
    GUI_DEPOSIT_RETRY_BASE_MS * 2 ** Math.max(0, failureCount - 1),
    GUI_DEPOSIT_RETRY_MAX_MS,
  );
}

function currentGuiFundingIdentity(): string {
  const settings = useSettingsStore.getState();
  const identity = resolveCreatorPubkey({
    nostrSignerMode: settings.nostrSignerMode,
    nsecSecret: settings.nsecSecret,
    nostrProfilePubkey: settings.nostrProfile?.pubkey,
  });
  if (!identity) throw new Error("Ecash deposit authentication is unavailable");
  return identity;
}

function guiEcashDepositRemote(): GuiEcashDepositRemote {
  return {
    currentFundingIdentity: currentGuiFundingIdentity,
    getStatus: async ({ depositId, request }) =>
      await getDepositStatus(request.conditionId, depositId),
    submit: async ({ depositId, request, token }) =>
      await requestEcashDeposit(
        request.conditionId,
        depositId,
        request.amountSubunits,
        token,
        {
          creatorPubkey: request.creatorPubkey,
          fundAmm: request.fundAmm,
          unit: request.unit,
          divisibility: request.divisibility,
        },
      ),
  };
}

/**
 * Paths that render full-window wizards without the app shell. Keeping
 * this list in one place means the {@link WizardRoutes} route table and
 * the layout-selection check in {@link AppRoutes} can't drift apart.
 */
const WIZARD_PATHS = ["/creator/new"] as const;

/**
 * Wizard routes render without the app shell.
 * Kept in a separate component so the hook list stays consistent between
 * wizard and shell renders — mixing the two paths inside a single component
 * with a conditional early return violates the Rules of Hooks and causes
 * blank renders when navigating in/out of a wizard.
 */
function WizardRoutes() {
  return (
    <Routes>
      <Route path="/creator/new" element={<MarketCreationPage />} />
    </Routes>
  );
}

function ShellRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const nostrProfile = useSettingsStore((s) => s.nostrProfile);
  const totalBalance = useBalance();

  const navigationItems = [
    {
      label: t("nav.markets"),
      href: "/markets",
      isActive:
        location.pathname === "/" || location.pathname.startsWith("/markets"),
    },
  ];

  const user = {
    name: nostrProfile?.displayName ?? "Anon",
    avatarUrl: nostrProfile?.avatar ?? undefined,
    balance: totalBalance,
  };

  return (
    <AppShell
      navigationItems={navigationItems}
      user={user}
      onNavigate={(href) => navigate(href)}
      onSearchChange={(query) => {
        const trimmed = query.trim();
        navigate(
          {
            pathname: "/markets",
            search: trimmed ? `?search=${encodeURIComponent(trimmed)}` : "",
          },
          { replace: location.pathname.startsWith("/markets") },
        );
      }}
      onCreateClick={() => navigate("/creator")}
    >
      <Routes>
        <Route path="/" element={<MarketsPage />} />
        <Route path="/markets" element={<MarketsPage />} />
        <Route path="/markets/:id" element={<MarketDetailPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/creator" element={<CreatorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/mint-details" element={<MintDetailPage />} />
        <Route path="/user/:pubkey" element={<UserPage />} />
      </Routes>
    </AppShell>
  );
}

function titleForPath(pathname: string): string {
  if (pathname === "/" || pathname === "/markets")
    return "bitCaster/All Markets";
  if (pathname.startsWith("/markets/")) return "bitCaster/Market";
  if (pathname === "/portfolio") return "bitCaster/Portfolio";
  if (pathname === "/creator/new") return "bitCaster/Create Market";
  if (pathname === "/creator") return "bitCaster/Creator";
  if (pathname === "/settings") return "bitCaster/Settings";
  if (pathname === "/mint-details") return "bitCaster/Mint Details";
  if (pathname.startsWith("/user/")) return "bitCaster/User";
  return "bitCaster";
}

function AppRoutes() {
  const location = useLocation();
  const [pendingWalletWarning, setPendingWalletWarning] = useState(false);
  const [blockedWalletDepositWarning, setBlockedWalletDepositWarning] =
    useState(false);
  const [nativeRecoveryStatus, setNativeRecoveryStatus] =
    useState<GuiNativeProofRecoveryStatus>("clear");
  useBookmarkSync();
  useCreatorSync();
  useActivityLogSync();
  usePendingTradesPoller();
  useLikedMarketCloseReconcile();
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const mnemonic = useWalletStore((s) => s.mnemonic);
  const [nostrSignerReady, setNostrSignerReady] = useState(false);
  useTradeSettlement(nostrSignerReady && nostrSignerMode !== "none");

  useEffect(() => {
    document.title = titleForPath(location.pathname);
  }, [location.pathname]);

  // Re-install the Nostr signer from persisted settings after Zustand
  // hydration. The identityOps helper owns the one-shot/hydration semantics.
  useEffect(() => {
    rehydratePersistedNostrIdentity()
      .catch(() => {})
      .finally(() => setNostrSignerReady(true));
  }, []);

  useEffect(() => {
    if (!mnemonic) return;
    sweepElapsedPartialLockFailures().catch(() => {});
  }, [mnemonic]);

  useEffect(() => {
    if (!mnemonic || !nostrSignerReady) return;
    let active = true;
    let running = false;
    let rerunRequested = false;
    let failureCount = 0;
    let retryNotBefore = 0;
    let timer: number | undefined;
    const remote = guiEcashDepositRemote();

    const schedule = (
      cursor: PendingEcashDepositRecoveryCursor | null,
      delay: number,
    ) => {
      if (!active) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(
        () => runPage(cursor),
        Math.min(Math.max(0, delay), 2_147_483_647),
      );
    };
    const requestCycle = () => {
      if (running) {
        rerunRequested = true;
        return;
      }
      schedule(null, Math.max(0, retryNotBefore - Date.now()));
    };
    const runPage = async (
      cursor: PendingEcashDepositRecoveryCursor | null,
    ) => {
      timer = undefined;
      if (!active || running) return;
      running = true;
      try {
        const result = await reconcileGuiEcashDeposits(remote, cursor);
        if (!active) return;
        failureCount = 0;
        retryNotBefore = 0;
        setPendingWalletWarning(
          result.hasMore ||
            result.remaining.length > 0 ||
            result.nextAttemptAt !== null,
        );
        setBlockedWalletDepositWarning(result.blocked.length > 0);
        if (rerunRequested) {
          rerunRequested = false;
          schedule(null, 0);
        } else if (result.hasMore && result.nextCursor) {
          schedule(result.nextCursor, 0);
        } else if (result.nextAttemptAt !== null) {
          schedule(null, result.nextAttemptAt - Date.now());
        }
      } catch (error) {
        if (!active) return;
        failureCount = Math.min(failureCount + 1, 16);
        const delay = guiDepositRetryDelay(failureCount);
        retryNotBefore = Date.now() + delay;
        rerunRequested = false;
        console.warn(
          "[wallet] pending local-wallet payment reconciliation failed",
          error,
        );
        setPendingWalletWarning(true);
        schedule(null, delay);
      } finally {
        running = false;
      }
    };
    const requestCycleWhenVisible = () => {
      if (document.visibilityState === "visible") requestCycle();
    };

    requestCycle();
    window.addEventListener("online", requestCycle);
    document.addEventListener("visibilitychange", requestCycleWhenVisible);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("online", requestCycle);
      document.removeEventListener("visibilitychange", requestCycleWhenVisible);
    };
  }, [mnemonic, nostrSignerReady]);

  useEffect(() => {
    if (!mnemonic) {
      setNativeRecoveryStatus("clear");
      return;
    }
    let active = true;
    const recover = () => {
      setNativeRecoveryStatus((current) =>
        current === "blocked" ? current : "pending",
      );
      requestGuiNativeProofOperationRecovery()
        .then((status) => {
          if (active) setNativeRecoveryStatus(status);
        })
        .catch(() => {
          if (active) setNativeRecoveryStatus("blocked");
        });
    };
    const recoverWhenVisible = () => {
      if (document.visibilityState === "visible") recover();
    };
    recover();
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recoverWhenVisible);
    return () => {
      active = false;
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recoverWhenVisible);
    };
  }, [mnemonic]);

  // Continuous NIP-17 listener so inbound payment-request DMs are
  // processed regardless of which route is mounted. The per-view
  // subscription inside `useDepositWithdrawState` was lost on reload and
  // missed payments that arrived while the user wasn't on the Receive
  // view — P5 item 5 regression.
  const relayUrlsKey = useSettingsStore((s) =>
    s.relays.map((r) => r.url).join("|"),
  );
  useEffect(() => {
    if (!mnemonic) return;
    const relays = effectiveRelayUrls(useSettingsStore.getState().relays);
    startNip17Listener(mnemonic, relays).catch(() => {
      console.warn("[app] NIP-17 listener startup failed");
    });
    // No cleanup — the listener is module-scoped and intentionally
    // outlives React's mount/unmount dance (StrictMode, HMR).
  }, [mnemonic, relayUrlsKey]);

  // Ensure stored mints have full info (CTF badge, NUTs, contact) and that
  // the status indicator reflects reality. Re-fetches any mint missing
  // `info.nuts` — covers pre-P3 users who have a stale mint row in storage.
  // The default mint additionally re-fetches if `nuts.CTF` is missing, since
  // staging enabled NUT-CTF after some users had already snapshot their
  // mint info; without the refresh those users see a stale "Ecash only"
  // badge despite the mint now advertising CTF (P6 P4.4).
  // Also seeds the default mint for first-run users who land directly on
  // /settings or /mint-details (P5 item 1). Wallet creation is now lazy and
  // origin-local; there is no setup wizard route to own mint configuration.
  //
  // Why defer to `onFinishHydration`: Zustand's persist middleware rehydrates
  // asynchronously. On the first render `useWalletStore.getState().mints` is
  // `[]` even for a returning user with persisted mints — reading it here
  // would mis-fire `addMint(DEFAULT_MINT_URL)` and overwrite the seeded
  // info.nuts once hydration lands.
  const mintRehydrateAttempted = useRef(false);
  useEffect(() => {
    if (mintRehydrateAttempted.current) return;
    const runMintRehydrate = () => {
      if (mintRehydrateAttempted.current) return;
      mintRehydrateAttempted.current = true;
      const { mints } = useWalletStore.getState();
      if (mints.length === 0) {
        // Skip seeding while full-window creation flows are visible; those
        // flows can own their setup state while mounted.
        const onWizard = (WIZARD_PATHS as readonly string[]).includes(
          window.location.pathname,
        );
        if (!onWizard) {
          userAddAndSelectMint(DEFAULT_MINT_URL).catch(() => {});
        }
        return;
      }
      for (const m of mints) {
        const nuts = (m.info as { nuts?: Record<string, unknown> } | undefined)
          ?.nuts;
        const isDefault = m.url === DEFAULT_MINT_URL;
        const missingCtfOnDefault =
          isDefault && nuts != null && !("CTF" in nuts);
        if (!nuts || missingCtfOnDefault) {
          refreshMintInfoWithoutActivating(m.url).catch(() => {});
        }
      }
    };
    if (useWalletStore.persist.hasHydrated()) {
      runMintRehydrate();
      return;
    }
    const unsub = useWalletStore.persist.onFinishHydration(runMintRehydrate);
    return () => {
      unsub();
    };
  }, []);

  const isWizard = (WIZARD_PATHS as readonly string[]).includes(
    location.pathname,
  );
  return (
    <>
      {pendingWalletWarning && (
        <div className="border-b border-amber-400/40 bg-amber-500/15 px-4 py-3 text-sm text-amber-100">
          Wallet payment recovery is continuing automatically. Submitted funds
          remain reserved until the deposit is confirmed.
        </div>
      )}
      {blockedWalletDepositWarning && (
        <div className="border-b border-red-400/40 bg-red-500/15 px-4 py-3 text-sm text-red-100">
          Wallet deposit recovery found inconsistent durable state. Its funds
          remain reserved to prevent unsafe spending.
        </div>
      )}
      {nativeRecoveryStatus === "pending" && (
        <div className="border-b border-amber-400/40 bg-amber-500/15 px-4 py-3 text-sm text-amber-100">
          Wallet recovery is continuing automatically. Funds in unfinished
          operations remain reserved.
        </div>
      )}
      {nativeRecoveryStatus === "blocked" && (
        <div className="border-b border-red-400/40 bg-red-500/15 px-4 py-3 text-sm text-red-100">
          Wallet recovery found an inconsistent or unsupported unfinished
          operation. Its funds remain reserved to prevent unsafe spending.
        </div>
      )}
      {isWizard ? <WizardRoutes /> : <ShellRoutes />}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <ToastContainer />
    </BrowserRouter>
  );
}
