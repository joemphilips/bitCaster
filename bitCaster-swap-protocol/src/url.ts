/** Normalize mint URLs for equality checks and path joining. */
export function normalizeUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return url.trim().replace(/\/+$/, '')
  }
}

/** Extract hostname from a URL, returning the raw string on parse failure. */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
