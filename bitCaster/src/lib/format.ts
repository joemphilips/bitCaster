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
