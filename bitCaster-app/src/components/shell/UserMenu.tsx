import { useState } from 'react'
import { User, LogOut, ChevronDown, Wallet, Sparkles, Settings, BookOpen, ExternalLink, Languages, Check } from 'lucide-react'
import { formatBalance } from '@/lib/format'
import { useTranslation } from 'react-i18next'
import { LANGUAGES } from '@/i18n'

interface UserMenuProps {
  user: { name: string; avatarUrl?: string; balance?: number }
  onLogout?: () => void
  onNavigate?: (href: string) => void
  onCreateClick?: () => void
}

export function UserMenu({ user, onLogout, onNavigate, onCreateClick }: UserMenuProps) {
  const { t, i18n } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        {/* Avatar */}
        <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt={user.name} className="w-8 h-8 rounded-full" />
          ) : (
            <User className="w-5 h-5 text-slate-400" />
          )}
        </div>

        {/* User Info */}
        <div className="text-left">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{user.name}</div>
          <div className="text-xs text-amber-400 font-mono">{formatBalance(user.balance)}</div>
        </div>

        <ChevronDown className="w-4 h-4 text-slate-500" />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setIsOpen(false); setLangOpen(false) }} />
          <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 z-20 overflow-hidden">
            {onCreateClick && (
              <button onClick={() => { setIsOpen(false); onCreateClick() }}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2">
                <Sparkles className="w-4 h-4" /><span>{t('nav.creator')}</span>
              </button>
            )}
            <div className="border-t border-slate-200 dark:border-slate-700" />
            <button onClick={() => { setIsOpen(false); onNavigate?.('/portfolio') }}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2">
              <Wallet className="w-4 h-4" /><span>{t('nav.portfolio')}</span>
            </button>
            <div className="border-t border-slate-200 dark:border-slate-700" />
            <button onClick={() => { setIsOpen(false); onNavigate?.('/settings') }}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2">
              <Settings className="w-4 h-4" /><span>{t('nav.settings')}</span>
            </button>
            <div className="border-t border-slate-200 dark:border-slate-700" />
            {/* Language selector — inline within dropdown */}
            <div>
              <button
                onClick={() => setLangOpen(!langOpen)}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2"
              >
                <Languages className="w-4 h-4" />
                <span>{t('nav.language')}</span>
                <ChevronDown className={`w-4 h-4 ml-auto transition-transform ${langOpen ? 'rotate-180' : ''}`} />
              </button>
              {langOpen && (
                <div className="border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-750">
                  {LANGUAGES.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => {
                        i18n.changeLanguage(lang.code)
                        setLangOpen(false)
                        setIsOpen(false)
                      }}
                      className="w-full px-6 py-2.5 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2"
                    >
                      <span>{lang.flag}</span>
                      <span>{lang.label}</span>
                      {i18n.language === lang.code && (
                        <Check className="w-4 h-4 ml-auto text-blue-500" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="border-t border-slate-200 dark:border-slate-700" />
            <a href="https://bitcasterdoc.com/" target="_blank" rel="noopener noreferrer"
              onClick={() => setIsOpen(false)}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2">
              <BookOpen className="w-4 h-4" /><span>{t('nav.docs')}</span><ExternalLink className="w-3 h-3 ml-auto text-slate-500" />
            </a>
            <div className="border-t border-slate-200 dark:border-slate-700" />
            <button onClick={() => { setIsOpen(false); onLogout?.() }}
              className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center space-x-2">
              <LogOut className="w-4 h-4" /><span>{t('nav.logout')}</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
