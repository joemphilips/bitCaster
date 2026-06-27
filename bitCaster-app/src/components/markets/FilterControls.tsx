import { Filter } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MarketType, VolumeRange } from '@/types/market'

interface FilterControlsProps {
  isVisible: boolean
  selectedMarketTypes: MarketType[]
  volumeRange: VolumeRange
  closingInDays?: number
  includeClosed?: boolean
  onMarketTypeChange?: (types: MarketType[]) => void
  onVolumeRangeChange?: (range: VolumeRange) => void
  onClosingDateChange?: (days?: number) => void
  onIncludeClosedChange?: (includeClosed: boolean) => void
}

const MARKET_TYPE_OPTIONS: { value: MarketType; labelKey: string }[] = [
  { value: 'yesno', labelKey: 'filter.yesNo' },
  { value: 'categorical', labelKey: 'filter.categorical' },
]

const VOLUME_OPTIONS: { value: number | undefined; labelKey: string; rawLabel?: string }[] = [
  { value: undefined, labelKey: 'filter.volAny' },
  { value: 10000, labelKey: '', rawLabel: '10K+' },
  { value: 100000, labelKey: '', rawLabel: '100K+' },
  { value: 500000, labelKey: '', rawLabel: '500K+' },
  { value: 1000000, labelKey: '', rawLabel: '1M+' },
  { value: 5000000, labelKey: '', rawLabel: '5M+' },
]

const CLOSING_DATE_OPTIONS: { value: number | undefined; labelKey: string }[] = [
  { value: undefined, labelKey: 'filter.anyTime' },
  { value: 7, labelKey: 'filter.within7Days' },
  { value: 30, labelKey: 'filter.within30Days' },
  { value: 90, labelKey: 'filter.within90Days' },
  { value: 180, labelKey: 'filter.within6Months' },
  { value: 365, labelKey: 'filter.within1Year' },
]

export function FilterControls({
  isVisible,
  selectedMarketTypes,
  volumeRange,
  closingInDays,
  includeClosed = false,
  onMarketTypeChange,
  onVolumeRangeChange,
  onClosingDateChange,
  onIncludeClosedChange,
}: FilterControlsProps) {
  const { t } = useTranslation()

  const handleMarketTypeToggle = (type: MarketType) => {
    const newTypes = selectedMarketTypes.includes(type)
      ? selectedMarketTypes.filter((t) => t !== type)
      : [...selectedMarketTypes, type]
    onMarketTypeChange?.(newTypes)
  }

  if (!isVisible) {
    return null
  }

  return (
    <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-[7rem] md:top-[7rem] z-30 animate-in slide-in-from-top-2 duration-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        {/* Filter Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <Filter className="w-4 h-4" />
            <span className="text-sm font-semibold">{t('common.filters')}</span>
          </div>

          {/* Market Type Filter */}
          <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
            {MARKET_TYPE_OPTIONS.map((option) => {
              const isSelected = selectedMarketTypes.includes(option.value)
              return (
                <button
                  key={option.value}
                  onClick={() => handleMarketTypeToggle(option.value)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                    isSelected
                      ? 'bg-blue-600 dark:bg-blue-500 text-white shadow-md'
                      : 'bg-transparent text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {t(option.labelKey)}
                </button>
              )
            })}
          </div>

          {/* Volume Range Filter */}
          <select
            value={volumeRange.min || ''}
            onChange={(e) =>
              onVolumeRangeChange?.({
                ...volumeRange,
                min: e.target.value ? parseInt(e.target.value) : undefined,
              })
            }
            className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            {VOLUME_OPTIONS.map((option) => (
              <option key={option.value || 'any'} value={option.value || ''}>
                {option.value === undefined ? t('filter.volAny') : option.rawLabel}
              </option>
            ))}
          </select>

          {/* Closing Date Filter */}
          <select
            value={closingInDays || ''}
            onChange={(e) =>
              onClosingDateChange?.(e.target.value ? parseInt(e.target.value) : undefined)
            }
            className="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            {CLOSING_DATE_OPTIONS.map((option) => (
              <option key={option.value || 'any'} value={option.value || ''}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>

          <label className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => onIncludeClosedChange?.(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-900"
            />
            {t('filter.includeClosed')}
          </label>

          {/* Active Filter Count */}
          {(selectedMarketTypes.length > 0 ||
            volumeRange.min !== undefined ||
            closingInDays !== undefined ||
            includeClosed) && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                {t('common.active_filters', {
                  count: [
                    selectedMarketTypes.length > 0 ? 1 : 0,
                    volumeRange.min !== undefined ? 1 : 0,
                    closingInDays !== undefined ? 1 : 0,
                    includeClosed ? 1 : 0,
                  ].reduce((a, b) => a + b, 0),
                })}
              </span>
              <button
                onClick={() => {
                  onMarketTypeChange?.([])
                  onVolumeRangeChange?.({})
                  onClosingDateChange?.(undefined)
                  onIncludeClosedChange?.(false)
                }}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300 underline"
              >
                {t('common.clearAll')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
