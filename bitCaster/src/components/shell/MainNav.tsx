import { useState } from 'react'
import { TrendingUp, Search } from 'lucide-react'

interface MainNavProps {
  items: Array<{ label: string; href: string; isActive?: boolean }>
  onNavigate?: (href: string) => void
  onSearchChange?: (query: string) => void
}

export function MainNav({ items, onNavigate, onSearchChange }: MainNavProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value
    setSearchQuery(query)
    onSearchChange?.(query)
  }

  return (
    <nav className="flex items-center gap-2 md:gap-4 flex-1">
      {/* Markets Navigation Item */}
      {items.map((item) => (
        <button
          key={item.href}
          onClick={() => onNavigate?.(item.href)}
          className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
            item.isActive
              ? 'bg-blue-900/30 text-blue-300'
              : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <TrendingUp className="w-4 h-4" />
          <span className="hidden sm:inline">{item.label}</span>
        </button>
      ))}

      {/* Search Box */}
      <div className="flex-1 max-w-md">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onFocus={() => setSearchExpanded(true)}
            onBlur={() => setSearchExpanded(false)}
            placeholder="Search markets..."
            className={`w-full pl-9 pr-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all ${
              searchExpanded ? 'ring-2 ring-blue-500' : ''
            }`}
          />
        </div>
      </div>
    </nav>
  )
}
