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
import { WalletSetupPage } from "@/pages/WalletSetupPage";
import { useEffect, useRef } from "react";
import { useBookmarkSync } from "@/stores/useBookmarkSync";
import { useCreatorSync } from "@/stores/useCreatorSync";
import { usePendingTradesPoller } from "@/lib/orderStatus";
import { useSettingsStore } from "@/stores/settings";
import { useBalance, useWalletStore, DEFAULT_MINT_URL } from "@/stores/wallet";
import { ToastContainer } from "@/components/ui/Toast";
import { rehydrateNostrSigner } from "@/lib/nostr";
import { normalizeStoredMintUrls } from "@/stores/proof-db";
import { startNip17Listener } from "@/lib/nip17-listener";

/**
 * Paths that render full-window wizards without the app shell. Keeping
 * this list in one place means the {@link WizardRoutes} route table and
 * the layout-selection check in {@link AppRoutes} can't drift apart.
 */
const WIZARD_PATHS = ["/setup", "/creator/new"] as const;

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
      <Route path="/setup" element={<WalletSetupPage />} />
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
      </Routes>
    </AppShell>
  );
}

function AppRoutes() {
  const location = useLocation();
  useBookmarkSync();
  useCreatorSync();
  usePendingTradesPoller();

  // Re-install the Nostr signer from localStorage once on mount — the nsec
  // lives in the settings store but NDK.signer is RAM-only, so after any
  // reload the runtime signer is absent until this rehydrates it.
  const signerRehydrated = useRef(false);
  useEffect(() => {
    if (signerRehydrated.current) return;
    signerRehydrated.current = true;
    rehydrateNostrSigner().catch(() => {});
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

  // Continuous NIP-17 listener so inbound payment-request DMs are
  // processed regardless of which route is mounted. The per-view
  // subscription inside `useDepositWithdrawState` was lost on reload and
  // missed payments that arrived while the user wasn't on the Receive
  // view — P5 item 5 regression.
  const mnemonic = useWalletStore((s) => s.mnemonic);
  const relayUrlsKey = useSettingsStore((s) =>
    s.relays.map((r) => r.url).join("|")
  );
  useEffect(() => {
    if (!mnemonic) return;
    const relays = useSettingsStore.getState().relays.map((r) => r.url);
    startNip17Listener(mnemonic, relays).catch((e) => {
      console.warn("[app] startNip17Listener failed:", e);
    });
    // No cleanup — the listener is module-scoped and intentionally
    // outlives React's mount/unmount dance (StrictMode, HMR).
  }, [mnemonic, relayUrlsKey]);

  // Ensure stored mints have full info (CTF badge, NUTs, contact) and that
  // the status indicator reflects reality. Re-fetches any mint missing
  // `info.nuts` — covers pre-P3 users who have a stale mint row in storage.
  // Also seeds the default mint for first-run users who land directly on
  // /settings or /mint-details without going through the wizard (P5 item 1);
  // the wizard's own `completeSetup()` handles the in-wizard case.
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
      const { mints, addMint } = useWalletStore.getState();
      if (mints.length === 0) {
        // Skip seeding while the wallet-setup wizard is visible — the
        // wizard owns mint configuration and `completeSetup()` adds the
        // default mint itself. Seeding here races with in-wizard state
        // seeding (tests, power users reloading mid-wizard) and can
        // overwrite the mint info they just chose.
        const onWizard = (WIZARD_PATHS as readonly string[]).includes(
          window.location.pathname
        );
        if (!onWizard) {
          addMint(DEFAULT_MINT_URL).catch(() => {});
        }
        return;
      }
      for (const m of mints) {
        const nuts = (m.info as { nuts?: Record<string, unknown> } | undefined)?.nuts;
        if (!nuts) {
          addMint(m.url).catch(() => {});
        }
      }
    };
    if (useWalletStore.persist.hasHydrated()) {
      runMintRehydrate();
      return;
    }
    const unsub = useWalletStore.persist.onFinishHydration(runMintRehydrate);
    return () => { unsub(); };
  }, []);

  const isWizard = (WIZARD_PATHS as readonly string[]).includes(location.pathname);
  return isWizard ? <WizardRoutes /> : <ShellRoutes />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <ToastContainer />
    </BrowserRouter>
  );
}
