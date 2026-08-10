import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { AppShell, DurableWalletErrors } from "@/components/shell";
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
import { useOrderSettlementLifecycle } from "@/hooks/useOrderSettlementLifecycle";
import { useLikedMarketCloseReconcile } from "@/hooks/useLikedMarketCloseReconcile";
import { useSettingsStore } from "@/stores/settings";
import { useBalance, useWalletStore, DEFAULT_MINT_URL } from "@/stores/wallet";
import { ToastContainer } from "@/components/ui/Toast";
import { normalizeStoredMintUrls } from "@/stores/proof-db";
import {
  recoverKeysetCountersForMint,
  recoverPendingTokenReceives,
  recoverPendingWalletMints,
} from "@/lib/cashu";
import { recoverBrowserDurableBolt11MintQuotesInPass } from "@/lib/browserDurableBolt11MintQuote";
import { startNip17Listener } from "@/lib/nip17-listener";
import { effectiveRelayUrls } from "@/lib/relayDefaults";
import { refreshMintInfoWithoutActivating, userAddAndSelectMint } from "@/lib/walletOps";
import { rehydratePersistedNostrIdentity } from "@/lib/identityOps";
import { reconcileAcceptedLocalWalletPayments } from "@/lib/pendingLocalWalletPayments";
import { recoverBrowserCtfRangeOrders } from "@/lib/browserCtfRangeOrderSubmission";
import { useEncryptedWalletBackupDriver } from "@/hooks/useEncryptedWalletBackupDriver";
import { useAssetMonitoringReporter } from "@/hooks/useAssetMonitoringReporter";
import { DEFAULT_MARKET_BASE_ASSET } from "@bitcaster/client-sdk/marketUnits";

const RANGE_RECOVERY_RETRY_MS = 15_000;

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
  const totalBalance = useBalance(undefined, { baseAsset: DEFAULT_MARKET_BASE_ASSET });

  const navigationItems = [
    {
      label: t("nav.markets"),
      href: "/markets",
      isActive: location.pathname === "/" || location.pathname.startsWith("/markets"),
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
      <DurableWalletErrors />
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
  if (pathname === "/" || pathname === "/markets") return "bitCaster/All Markets";
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
  useBookmarkSync();
  useCreatorSync();
  useActivityLogSync();
  usePendingTradesPoller();
  useLikedMarketCloseReconcile();
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const walletMnemonic = useWalletStore((s) => s.mnemonic);
  const walletMintUrls = useWalletStore((s) => s.mints.map(({ url }) => url).join("\n"));
  const [nostrSignerReady, setNostrSignerReady] = useState(false);
  useOrderSettlementLifecycle(nostrSignerReady && nostrSignerMode !== "none", {
    mnemonic: walletMnemonic,
    mintUrls: walletMintUrls.split("\n").filter(Boolean),
  });
  useEncryptedWalletBackupDriver(nostrSignerReady && nostrSignerMode !== "none");
  useAssetMonitoringReporter(nostrSignerReady && nostrSignerMode !== "none");

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

  // One-shot migration: pre-fix proofs stored their mintUrl verbatim from
  // the decoded token / NIP-17 payload, which could differ from the
  // normalized `activeMintUrl` by a trailing slash. That mismatch made
  // `getBalance(activeMintUrl)` return 0 even with proofs in IndexedDB —
  // breaking the buy gate on market detail.
  const proofMigrationAttempted = useRef(false);
  useEffect(() => {
    if (!walletMnemonic || proofMigrationAttempted.current) return;
    proofMigrationAttempted.current = true;
    normalizeStoredMintUrls().catch(() => {});
  }, [walletMnemonic]);

  // P8 follow-up: cashu-ts deterministic counter recovery.
  //
  // CDK rejects re-used deterministic blinded outputs as a database duplicate.
  // A different device can advance the same seed's mint-side cursor.
  //
  // Recovery walks `wallet.batchRestore(...)` for default sat keysets and
  // advances the canonical keyset cursor past the highest signed output.
  // Non-default units recover on the duplicate-output repair path with an
  // explicit unit, so startup does not fan out across every mint unit.
  // Each scan is monotonic. The effect runs once per mint at startup.
  useEffect(() => {
    if (!walletMnemonic || !nostrSignerReady) return;
    const mintUrls = walletMintUrls.split("\n").filter(Boolean);
    let cancelled = false;
    let running = false;
    let rerunRequested = false;
    let receivesRecovered = false;
    let receiveCacheRepaired = false;
    let receiveRecoveryAfterOperationId: string | null = null;
    let mintsRecovered = false;
    let countersRecovered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void runRecovery();
      }, RANGE_RECOVERY_RETRY_MS);
    };
    const runRecovery = async () => {
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      let retryRequired = false;
      try {
        if (!receivesRecovered) {
          try {
            const result = await recoverPendingTokenReceives({
              repairCurrentInventory: !receiveCacheRepaired,
              afterOperationId: receiveRecoveryAfterOperationId,
            });
            receiveCacheRepaired = true;
            receiveRecoveryAfterOperationId = result.lastAttemptedOperationId;
            receivesRecovered = result.pending === 0;
            retryRequired ||= !receivesRecovered;
          } catch {
            retryRequired = true;
          }
        }
        if (!mintsRecovered) {
          try {
            const result = await recoverPendingWalletMints();
            mintsRecovered = result.pending === 0;
            retryRequired ||= !mintsRecovered;
          } catch {
            retryRequired = true;
          }
        }
        try {
          const result = await recoverBrowserCtfRangeOrders({
            mnemonic: walletMnemonic,
            mintUrls,
          });
          retryRequired ||= result.pending.length > 0;
        } catch {
          retryRequired = true;
        }
        if (!countersRecovered) {
          try {
            let complete = true;
            for (const mintUrl of mintUrls) {
              const result = await recoverKeysetCountersForMint(mintUrl, { baseAsset: "sat" });
              complete &&= result.complete;
            }
            countersRecovered = complete;
            retryRequired ||= !complete;
          } catch {
            retryRequired = true;
          }
        }
      } finally {
        running = false;
        if (retryRequired) schedule();
        if (rerunRequested && !cancelled) {
          rerunRequested = false;
          void runRecovery();
        }
      }
    };
    const onOnline = () => void runRecovery();
    window.addEventListener("online", onOnline);
    void runRecovery();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [nostrSignerReady, walletMnemonic, walletMintUrls]);

  // BOLT11 quote recovery is independent from CTF range recovery. One pass
  // checks each pending quote at most once. An online event starts a new pass.
  useEffect(() => {
    if (!walletMnemonic || !nostrSignerReady) return;
    let cancelled = false;
    let running = false;
    let rerunRequested = false;
    const runPass = async () => {
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      try {
        do {
          rerunRequested = false;
          const passCutoffMs = Date.now();
          let hasMore: boolean;
          try {
            do {
              const result = await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs });
              hasMore = result.hasMore;
            } while (!cancelled && hasMore);
          } catch {
            // A later online event can request one fresh bounded pass.
          }
        } while (!cancelled && rerunRequested);
      } finally {
        running = false;
      }
    };
    const onOnline = () => void runPass();
    window.addEventListener("online", onOnline);
    void runPass();
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [nostrSignerReady, walletMnemonic]);

  const pendingWalletPaymentReconcileAttempted = useRef(false);
  useEffect(() => {
    if (!walletMnemonic || pendingWalletPaymentReconcileAttempted.current) return;
    pendingWalletPaymentReconcileAttempted.current = true;
    reconcileAcceptedLocalWalletPayments()
      .then((remaining) => setPendingWalletWarning(remaining.length > 0))
      .catch((error) => {
        console.warn("[wallet] pending local-wallet payment reconciliation failed", error);
        setPendingWalletWarning(true);
      });
  }, [walletMnemonic]);

  // Continuous NIP-17 listener so inbound payment-request DMs are
  // processed regardless of which route is mounted. The per-view
  // subscription inside `useDepositWithdrawState` was lost on reload and
  // missed payments that arrived while the user wasn't on the Receive
  // view — P5 item 5 regression.
  const mnemonic = useWalletStore((s) => s.mnemonic);
  const relayUrlsKey = useSettingsStore((s) => s.relays.map((r) => r.url).join("|"));
  useEffect(() => {
    if (!mnemonic) return;
    const relays = effectiveRelayUrls(useSettingsStore.getState().relays);
    startNip17Listener(mnemonic, relays).catch((e) => {
      console.warn("[app] startNip17Listener failed:", e);
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
        const onWizard = (WIZARD_PATHS as readonly string[]).includes(window.location.pathname);
        if (!onWizard) {
          userAddAndSelectMint(DEFAULT_MINT_URL).catch(() => {});
        }
        return;
      }
      for (const m of mints) {
        const nuts = (m.info as { nuts?: Record<string, unknown> } | undefined)?.nuts;
        const isDefault = m.url === DEFAULT_MINT_URL;
        const missingCtfOnDefault = isDefault && nuts != null && !("CTF" in nuts);
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

  const isWizard = (WIZARD_PATHS as readonly string[]).includes(location.pathname);
  return (
    <>
      {pendingWalletWarning && (
        <div className="border-b border-amber-400/40 bg-amber-500/15 px-4 py-3 text-sm text-amber-100">
          Payment was sent but local wallet state may be inconsistent. Please restart the app to
          reconcile.
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
