import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { DayPicker, getDefaultClassNames } from 'react-day-picker'
import { Calendar } from 'lucide-react'
import 'react-day-picker/style.css'

interface DateTimePickerProps {
  /** Current value as YYYY-MM-DDTHH:mm local string, or '' when unset. */
  value: string
  /** Called with a new YYYY-MM-DDTHH:mm local string when the user applies a choice. */
  onChange: (value: string) => void
  /** Lower bound (inclusive). Defaults to the start of today. */
  min?: Date
  /** Placeholder text when no value is selected. */
  placeholder?: string
  /** Optional id for the trigger button. */
  id?: string
  /** Optional aria-label for the trigger button. */
  'aria-label'?: string
}

/** Parse YYYY-MM-DDTHH:mm local string to Date, or undefined. */
function parseLocalString(value: string): Date | undefined {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** Format Date as YYYY-MM-DD in local time (no timezone shift). */
function toDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Format Date's time as HH:mm in local time. */
function toTimeString(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export function DateTimePicker({
  value,
  onChange,
  min,
  placeholder = 'Select date & time',
  id,
  'aria-label': ariaLabel,
}: DateTimePickerProps) {
  const parsed = parseLocalString(value)
  const [open, setOpen] = useState(false)
  const [draftDate, setDraftDate] = useState<Date | undefined>(parsed)
  const [draftTime, setDraftTime] = useState<string>(parsed ? toTimeString(parsed) : '12:00')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const autoId = useId()
  const triggerId = id ?? `dtp-${autoId}`

  // When the popover opens (or the external value changes), snapshot the value into draft state.
  useEffect(() => {
    if (!open) return
    const v = parseLocalString(value)
    setDraftDate(v)
    setDraftTime(v ? toTimeString(v) : '12:00')
  }, [open, value])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const effectiveMin = min ?? startOfToday()
  const displayText = parsed
    ? parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : placeholder

  // Combine draft date + time into a Date (for validation) and into the committed string.
  function combineDraft(): Date | undefined {
    if (!draftDate) return undefined
    const [hStr, mStr] = draftTime.split(':')
    const h = parseInt(hStr ?? '', 10)
    const m = parseInt(mStr ?? '', 10)
    if (Number.isNaN(h) || Number.isNaN(m)) return undefined
    const combined = new Date(draftDate)
    combined.setHours(h, m, 0, 0)
    return combined
  }

  const combined = combineDraft()
  const canApply = !!combined && combined >= effectiveMin

  function handleApply() {
    if (!combined) return
    const str = `${toDateString(combined)}T${toTimeString(combined)}`
    onChange(str)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function handleCancel() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const defaultClassNames = getDefaultClassNames()

  // CSS variables scoped to the popover so react-day-picker's default styles blend with the dark theme.
  const popoverStyle: CSSProperties = {
    ['--rdp-accent-color' as string]: '#2563eb',
    ['--rdp-accent-background-color' as string]: '#1e3a8a',
    ['--rdp-background-color' as string]: '#0f172a',
    ['--rdp-day-height' as string]: '40px',
    ['--rdp-day-width' as string]: '40px',
    ['--rdp-outside-opacity' as string]: '0.4',
    color: '#e2e8f0',
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
      >
        <span className={parsed ? 'text-white' : 'text-slate-500'}>{displayText}</span>
        <Calendar className="w-4 h-4 text-slate-400 shrink-0 ml-2" strokeWidth={1.5} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pick date and time"
          className="absolute left-0 right-0 z-50 mt-2 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-4"
          style={popoverStyle}
        >
          <DayPicker
            mode="single"
            selected={draftDate}
            onSelect={setDraftDate}
            disabled={{ before: effectiveMin }}
            classNames={{
              root: `${defaultClassNames.root} text-slate-200`,
              today: `${defaultClassNames.today} font-bold`,
              selected: `${defaultClassNames.selected} !bg-blue-600 !text-white`,
              chevron: `${defaultClassNames.chevron} fill-slate-200`,
              disabled: `${defaultClassNames.disabled} text-slate-600`,
              month_caption: `${defaultClassNames.month_caption} text-slate-100`,
              weekday: `${defaultClassNames.weekday} text-slate-400`,
            }}
          />

          <div className="mt-3 pt-3 border-t border-slate-800">
            <label className="flex items-center justify-between gap-3 text-sm text-slate-300">
              <span>Time</span>
              <input
                type="time"
                value={draftTime}
                onChange={(e) => setDraftTime(e.target.value)}
                aria-label="Time"
                className="px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
              />
            </label>
          </div>

          <div className="mt-4 flex gap-2 justify-end">
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!canApply}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                canApply
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
              }`}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
