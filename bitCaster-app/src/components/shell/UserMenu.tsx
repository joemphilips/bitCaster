import { useState } from 'react'
import { User, LogOut, ChevronDown, Wallet, Sparkles, Settings } from 'lucide-react'
import { formatBalance } from '@/lib/format'

interface UserMenuProps {
  user: { name: string; avatarUrl?: string; balance?: number }
  onLogout?: () => void
  onNavigate?: (href: string) => void
  onCreateClick?: () => void
}

export function UserMenu({ user, onLogout, onNavigate, onCreateClick }: UserMenuProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-800 transition-colors"
      >
        {/* Avatar */}
        <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.name} className="w-8 h-8 rounded-full" />
          ) : (
            <User className="w-5 h-5 text-slate-400" />
          )}
        </div>

        {/* User Info */}
        <div className="text-left">
          <div className="text-sm font-medium text-slate-100">{user.name}</div>
          <div className="text-xs text-amber-400 font-mono">{formatBalance(user.balance)}</div>
        </div>

        <ChevronDown className="w-4 h-4 text-slate-500" />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-2 w-48 bg-slate-800 rounded-lg shadow-lg border border-slate-700 z-20 overflow-hidden">
            {onCreateClick && (
              <button onClick={() => { setIsOpen(false); onCreateClick() }}
                className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-700 flex items-center space-x-2">
                <Sparkles className="w-4 h-4" /><span>Creator</span>
              </button>
            )}
            <div className="border-t border-slate-700" />
            <button onClick={() => { setIsOpen(false); onNavigate?.('/portfolio') }}
              className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-700 flex items-center space-x-2">
              <Wallet className="w-4 h-4" /><span>Portfolio</span>
            </button>
            <div className="border-t border-slate-700" />
            <button onClick={() => { setIsOpen(false); onNavigate?.('/settings') }}
              className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-700 flex items-center space-x-2">
              <Settings className="w-4 h-4" /><span>Settings</span>
            </button>
            <div className="border-t border-slate-700" />
            <button onClick={() => { setIsOpen(false); onLogout?.() }}
              className="w-full px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-700 flex items-center space-x-2">
              <LogOut className="w-4 h-4" /><span>Logout</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
