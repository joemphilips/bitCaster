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
import { useBookmarkSync } from "@/stores/useBookmarkSync";
import { useCreatorSync } from "@/stores/useCreatorSync";
import { usePendingTradesPoller } from "@/lib/orderStatus";
import { ToastContainer } from "@/components/ui/Toast";

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  useBookmarkSync();
  useCreatorSync();
  usePendingTradesPoller();

  // These routes render without AppShell
  if (location.pathname === "/setup" || location.pathname === "/creator/new") {
    return (
      <Routes>
        <Route path="/setup" element={<WalletSetupPage />} />
        <Route path="/creator/new" element={<MarketCreationPage />} />
      </Routes>
    );
  }

  const navigationItems = [
    {
      label: t("nav.markets"),
      href: "/markets",
      isActive: location.pathname === "/" || location.pathname.startsWith("/markets"),
    },
  ];

  const user = { name: "Anon", balance: 0 };

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
        <Route path="/creator/new" element={<MarketCreationPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/mint-details" element={<MintDetailPage />} />
      </Routes>
    </AppShell>
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
