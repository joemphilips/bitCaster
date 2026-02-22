import { useState } from 'react'
import { TrendingUp, Search, User, Bell, Sparkles } from 'lucide-react'
import { MainNav } from './MainNav'
import { UserMenu } from './UserMenu'
import { formatBalance } from '@/lib/format'

export interface AppShellProps {
  children: React.ReactNode
  navigationItems: Array<{ label: string; href: string; isActive?: boolean }>
  user?: { name: string; avatarUrl?: string; balance?: number }
  onNavigate?: (href: string) => void
  onLogout?: () => void
  onSearchChange?: (query: string) => void
  onCreateClick?: () => void
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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [mobileUserMenuOpen, setMobileUserMenuOpen] = useState(false)

  return (
    <div className="min-h-screen bg-slate-950 relative">
      {/* Brand Motto Background Image */}
      <div
        className="fixed inset-0 pointer-events-none select-none overflow-hidden opacity-[0.02]"
        style={{
          backgroundImage: 'url(/brand_motto.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      />

      {/* Top Navigation - Desktop/Tablet */}
      <header className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 hidden md:block">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 gap-4">
            {/* Logo */}
            <div className="flex-shrink-0">
              <h1 className="text-xl md:text-2xl font-bold text-blue-400">
                bitCaster
              </h1>
            </div>

            {/* Main Navigation with Search */}
            <MainNav
              items={navigationItems}
              onNavigate={onNavigate}
              onSearchChange={onSearchChange}
            />

            {/* Notification Bell */}
            <button
              className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <Bell className="w-5 h-5" />
            </button>

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
      <header className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-800 md:hidden">
        <div className="px-4 h-14 flex items-center justify-center">
          <h1 className="text-xl font-bold text-blue-400">
            bitCaster
          </h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 pb-20 md:pb-0">{children}</main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-slate-900 border-t border-slate-800 md:hidden">
        <div className="grid grid-cols-5 h-16">
          {/* Markets */}
          <button
            onClick={() => onNavigate?.('/markets')}
            className={`flex flex-col items-center justify-center gap-1 transition-colors ${
              navigationItems.find((item) => item.href === '/markets')?.isActive
                ? 'text-blue-400'
                : 'text-slate-400'
            }`}
          >
            <TrendingUp className="w-5 h-5" />
            <span className="text-xs font-medium">Markets</span>
          </button>

          {/* Search */}
          <button
            onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
            className="flex flex-col items-center justify-center gap-1 text-slate-400 transition-colors"
          >
            <Search className="w-5 h-5" />
            <span className="text-xs font-medium">Search</span>
          </button>

          {/* Notifications (placeholder — no route yet) */}
          <button
            className="flex flex-col items-center justify-center gap-1 text-slate-400 transition-colors relative"
          >
            <div className="relative">
              <Bell className="w-5 h-5" />
              <span className="absolute -top-1 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-[#f7931a] text-white text-[10px] font-bold flex items-center justify-center">
                3
              </span>
            </div>
            <span className="text-xs font-medium">Notifications</span>
          </button>

          {/* Creator */}
          <button
            onClick={onCreateClick}
            className="flex flex-col items-center justify-center gap-1 text-slate-400 transition-colors"
          >
            <Sparkles className="w-5 h-5" />
            <span className="text-xs font-medium">Creator</span>
          </button>

          {/* User → Open mobile menu */}
          <button
            onClick={() => setMobileUserMenuOpen(true)}
            className="flex flex-col items-center justify-center gap-1 text-slate-400 transition-colors"
          >
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name || 'User'}
                className="w-5 h-5 rounded-full"
              />
            ) : (
              <User className="w-5 h-5" />
            )}
            <span className="text-xs font-medium">User</span>
          </button>
        </div>
      </nav>

      {/* Mobile Search Overlay */}
      {mobileSearchOpen && (
        <div className="fixed inset-0 z-[60] bg-slate-900 md:hidden">
          <div className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setMobileSearchOpen(false)}
                className="text-slate-400"
              >
                Cancel
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                placeholder="Search markets..."
                autoFocus
                onChange={(e) => onSearchChange?.(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-slate-800 border border-slate-700 rounded-lg text-base text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile User Menu Overlay */}
      {mobileUserMenuOpen && user && (
        <div className="fixed inset-0 z-[60] bg-black/50 md:hidden">
          <div
            className="absolute inset-0"
            onClick={() => setMobileUserMenuOpen(false)}
          />
          <div className="absolute bottom-0 left-0 right-0 bg-slate-900 rounded-t-xl p-6 space-y-4">
            {/* User Info */}
            <div className="flex items-center gap-3 pb-4 border-b border-slate-700">
              <div className="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center">
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.name}
                    className="w-12 h-12 rounded-full"
                  />
                ) : (
                  <User className="w-6 h-6 text-slate-400" />
                )}
              </div>
              <div>
                <div className="font-medium text-slate-100">
                  {user.name}
                </div>
                <div className="text-sm text-amber-400 font-mono">
                  {formatBalance(user.balance)}
                </div>
              </div>
            </div>

            {/* Menu Items */}
            <button
              onClick={() => {
                setMobileUserMenuOpen(false)
                onNavigate?.('/portfolio')
              }}
              className="w-full py-3 text-left text-slate-300 hover:bg-slate-800 rounded-lg px-3"
            >
              Portfolio
            </button>
            <button
              onClick={() => {
                setMobileUserMenuOpen(false)
                onNavigate?.('/settings')
              }}
              className="w-full py-3 text-left text-slate-300 hover:bg-slate-800 rounded-lg px-3"
            >
              Settings
            </button>
            <button
              onClick={() => {
                setMobileUserMenuOpen(false)
                onLogout?.()
              }}
              className="w-full py-3 text-left text-slate-300 hover:bg-slate-800 rounded-lg px-3"
            >
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
