import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router";
import { AppShell } from "@/components/shell";
import { MarketsPage } from "@/pages/MarketsPage";
import { MarketDetailPage } from "@/pages/MarketDetailPage";
import { PortfolioPage } from "@/pages/PortfolioPage";
import { CreatorPage } from "@/pages/CreatorPage";
import { MarketCreationPage } from "@/pages/MarketCreationPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WalletSetupPage } from "@/pages/WalletSetupPage";

function AppRoutes() {
  const navigate = useNavigate();
  const location = useLocation();

  const navigationItems = [
    {
      label: "Markets",
      href: "/markets",
      isActive: location.pathname === "/" || location.pathname.startsWith("/markets"),
    },
  ];

  const mockUser = { name: "Anon", balance: 0 };

  return (
    <AppShell
      navigationItems={navigationItems}
      user={mockUser}
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
        <Route path="/setup" element={<WalletSetupPage />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
