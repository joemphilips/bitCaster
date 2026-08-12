import { useState } from "react";
import { TrendingUp, Search, User, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "@/i18n";
import { MainNav } from "./MainNav";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "./NotificationBell";
import { BitCasterLogo } from "./BitCasterLogo";
import { formatMarketSubunits } from "@bitcaster/client-sdk/marketUnits";

export interface AppShellProps {
  children: React.ReactNode;
  navigationItems: Array<{ label: string; href: string; isActive?: boolean }>;
  user?: { name: string; avatarUrl?: string; balance?: number };
  onNavigate?: (href: string) => void;
  onLogout?: () => void;
  onSearchChange?: (query: string) => void;
  onCreateClick?: () => void;
}

export function AppShell({
  children,
  navigationItems,
  user,
  onNavigate,
  onLogout,
  onSearchChange,
  onCreateClick,
}: AppShellProps) {
  const { t, i18n } = useTranslation();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileUserMenuOpen, setMobileUserMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 relative">
      {/* Top Navigation - Desktop/Tablet */}
      <header className="sticky top-0 z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 hidden md:block">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 gap-4">
            {/* Logo */}
            <button onClick={() => onNavigate?.("/")} className="flex-shrink-0">
              <h1 className="text-xl md:text-2xl text-blue-600 dark:text-blue-400 flex items-center">
                <BitCasterLogo className="h-7 md:h-8 w-auto" />
                <span className="sr-only">bitCaster (beta)</span>
              </h1>
            </button>

            {/* Main Navigation with Search */}
            <MainNav
              items={navigationItems}
              onNavigate={onNavigate}
              onSearchChange={onSearchChange}
            />

            {/* Notification Bell */}
            <NotificationBell onNavigate={onNavigate} />

            {/* User Menu */}
            {user && (
              <UserMenu
                user={user}
                onLogout={onLogout}
                onNavigate={onNavigate}
                onCreateClick={onCreateClick}
              />
            )}
          </div>
        </div>
      </header>

      {/* Mobile Top Header - Logo Only */}
      <header className="sticky top-0 z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 md:hidden">
        <div className="px-4 h-14 flex items-center justify-center">
          <button onClick={() => onNavigate?.("/")} className="flex-shrink-0">
            <h1 className="text-xl text-blue-600 dark:text-blue-400 flex items-center">
              <BitCasterLogo className="h-6 w-auto" />
              <span className="sr-only">bitCaster (beta)</span>
            </h1>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="grid grid-cols-5 h-16">
          {/* Markets */}
          <button
            onClick={() => onNavigate?.("/markets")}
            className={`flex flex-col items-center justify-center gap-1 transition-colors ${
              navigationItems.find((item) => item.href === "/markets")?.isActive
                ? "text-blue-400"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            <TrendingUp className="w-5 h-5" />
            <span className="text-xs font-medium">{t("nav.markets")}</span>
          </button>

          {/* Search */}
          <button
            onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
            className="flex flex-col items-center justify-center gap-1 text-slate-500 dark:text-slate-400 transition-colors"
          >
            <Search className="w-5 h-5" />
            <span className="text-xs font-medium">{t("nav.search")}</span>
          </button>

          {/* Notifications */}
          <NotificationBell onNavigate={onNavigate} variant="mobile" />

          {/* Creator */}
          <button
            onClick={onCreateClick}
            className="flex flex-col items-center justify-center gap-1 text-slate-500 dark:text-slate-400 transition-colors"
          >
            <Sparkles className="w-5 h-5" />
            <span className="text-xs font-medium">{t("nav.creator")}</span>
          </button>

          {/* User → Open mobile menu */}
          <button
            onClick={() => setMobileUserMenuOpen(true)}
            className="flex flex-col items-center justify-center gap-1 text-slate-500 dark:text-slate-400 transition-colors"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name || t("nav.user")}
                className="w-5 h-5 rounded-full"
              />
            ) : (
              <User className="w-5 h-5" />
            )}
            <span className="text-xs font-medium">{t("nav.user")}</span>
          </button>
        </div>
      </nav>

      {/* Mobile Search Overlay */}
      {mobileSearchOpen && (
        <div className="fixed inset-0 z-[60] bg-white dark:bg-slate-900 md:hidden">
          <div className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setMobileSearchOpen(false)}
                className="text-slate-500 dark:text-slate-400"
              >
                {t("common.cancel")}
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder={t("nav.searchMarkets")}
                autoFocus
                onChange={(e) => onSearchChange?.(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-base text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile User Menu Overlay */}
      {mobileUserMenuOpen && user && (
        <div className="fixed inset-0 z-[60] bg-black/50 md:hidden">
          <div className="absolute inset-0" onClick={() => setMobileUserMenuOpen(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-white dark:bg-slate-900 rounded-t-xl p-6 space-y-4">
            {/* User Info */}
            <div className="flex items-center gap-3 pb-4 border-b border-slate-200 dark:border-slate-700">
              <div className="w-12 h-12 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt={user.name} className="w-12 h-12 rounded-full" />
                ) : (
                  <User className="w-6 h-6 text-slate-400" />
                )}
              </div>
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-100">{user.name}</div>
                <div className="text-sm text-amber-400 font-mono">
                  {formatMarketSubunits(user.balance ?? 0, "sat")}
                </div>
              </div>
            </div>

            {/* Menu Items */}
            <button
              onClick={() => {
                setMobileUserMenuOpen(false);
                onNavigate?.("/portfolio");
              }}
              className="w-full py-3 text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg px-3"
            >
              {t("nav.portfolio")}
            </button>
            <button
              onClick={() => {
                setMobileUserMenuOpen(false);
                onNavigate?.("/settings");
              }}
              className="w-full py-3 text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg px-3"
            >
              {t("nav.settings")}
            </button>

            {/* Language selector */}
            <div className="py-2 border-t border-slate-200 dark:border-slate-700">
              <div className="px-3 pb-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {t("nav.language")}
              </div>
              <div className="flex gap-2 px-3">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => i18n.changeLanguage(lang.code)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      i18n.language === lang.code
                        ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium"
                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => {
                setMobileUserMenuOpen(false);
                onLogout?.();
              }}
              className="w-full py-3 text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg px-3"
            >
              {t("nav.logout")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
