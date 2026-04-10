/** Format sats with ₿ prefix. Abbreviates large values. */
export function formatBtc(sats: number): string {
  const abs = Math.abs(sats)
  if (abs >= 1_000_000) return `₿${(sats / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `₿${(sats / 1_000).toFixed(1)}K`
  return `₿${sats.toLocaleString()}`
}

export function formatBalance(sats?: number): string {
  if (sats === undefined || sats === 0) return '₿0'
  return formatBtc(sats)
}

/** Short relative-time label ("Just now", "5m ago", "2h ago"). Falls back to a
 *  localized "Mon DD" date after a week. */
export function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp)
  const diff = Date.now() - date.getTime()
  if (!Number.isFinite(diff)) return 'recently'

  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
