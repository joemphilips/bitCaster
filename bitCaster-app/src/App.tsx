import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router";
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
import { normalizeStoredMintUrls } from "@/stores/proof-db";
import { recoverKeysetCountersForMint, recoverPendingTokenReceives } from "@/lib/cashu";
import { startNip17Listener } from "@/lib/nip17-listener";
import { effectiveRelayUrls } from "@/lib/relayDefaults";
import { refreshMintInfoWithoutActivating, userAddAndSelectMint } from "@/lib/walletOps";
import { rehydratePersistedNostrIdentity } from "@/lib/identityOps";
import { sweepElapsedPartialLockFailures } from "@/lib/partialLockRecovery";
import { installE2EDiagnostics } from "@/lib/e2eDiagnostics";
import { reconcileAcceptedLocalWalletPayments } from "@/lib/pendingLocalWalletPayments";

installE2EDiagnostics();

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

  // One-shot migration: pre-fix proofs stored their mintUrl verbatim from
  // the decoded token / NIP-17 payload, which could differ from the
  // normalized `activeMintUrl` by a trailing slash. That mismatch made
  // `getBalance(activeMintUrl)` return 0 even with proofs in IndexedDB —
  // breaking the buy gate on market detail.
  const proofMigrationAttempted = useRef(false);
  useEffect(() => {
    if (proofMigrationAttempted.current) return;
    proofMigrationAttempted.current = true;
    normalizeStoredMintUrls().catch(() => {});
  }, []);

  // P8 follow-up: cashu-ts deterministic counter recovery.
  //
  // CDK rejects re-used deterministic blinded outputs as a database duplicate
  // and reports the misleadingly-named error "Invoice already paid or
  // pending" (`cdk-common/src/error.rs:1017`). For wallets that existed
  // before `ZustandCounterSource` (submodule commit `8711c73`, Apr 8) — or
  // that were minted from a different device with the same seed — the local
  // `keysetCounters` are missing or stale and the next `mintProofs` call
  // collides at counter 0.
  //
  // Recovery walks `wallet.batchRestore(...)` for default sat keysets and
  // advances `keysetCounters[keysetId]` past the highest signed output.
  // Non-default units recover on the duplicate-output repair path with an
  // explicit unit, so startup does not fan out across every mint unit.
  // Idempotent via `keysetCountersRecovered`. Runs ONCE per (mint, keyset)
  // at startup, gated on persist hydration so the mints / mnemonic are loaded.
  const counterRecoveryAttempted = useRef(false);
  useEffect(() => {
    if (counterRecoveryAttempted.current) return;
    const runRecovery = () => {
      if (counterRecoveryAttempted.current) return;
      counterRecoveryAttempted.current = true;
      const { mints, mnemonic } = useWalletStore.getState();
      if (!mnemonic) return;
      void (async () => {
        // Exact write-ahead receive journals own custody recovery and must
        // finish before the broader counter migration touches the same proof
        // secrets. Both paths now persist exact keyset units, but sequencing
        // also prevents a stale generic row from winning a concurrent bulkPut.
        await recoverPendingTokenReceives().catch(() => {});
        for (const m of mints) {
          await recoverKeysetCountersForMint(m.url, {
            baseAsset: "sat",
          }).catch(() => {});
        }
      })();
    };
    if (useWalletStore.persist.hasHydrated()) runRecovery();
    else {
      const unsub = useWalletStore.persist.onFinishHydration(() => {
        runRecovery();
        unsub();
      });
    }
  }, []);

  const partialLockSweepAttempted = useRef(false);
  useEffect(() => {
    if (partialLockSweepAttempted.current) return;
    const runSweep = () => {
      if (partialLockSweepAttempted.current) return;
      partialLockSweepAttempted.current = true;
      sweepElapsedPartialLockFailures().catch(() => {});
    };
    if (useWalletStore.persist.hasHydrated()) runSweep();
    else {
      const unsub = useWalletStore.persist.onFinishHydration(() => {
        runSweep();
        unsub();
      });
    }
  }, []);

  const pendingWalletPaymentReconcileAttempted = useRef(false);
  useEffect(() => {
    if (pendingWalletPaymentReconcileAttempted.current) return;
    pendingWalletPaymentReconcileAttempted.current = true;
    reconcileAcceptedLocalWalletPayments()
      .then((remaining) => setPendingWalletWarning(remaining.length > 0))
      .catch((error) => {
        console.warn("[wallet] pending local-wallet payment reconciliation failed", error);
        setPendingWalletWarning(true);
      });
  }, []);

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
