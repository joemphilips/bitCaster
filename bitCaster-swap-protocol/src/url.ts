/** Strip trailing slashes from mint URLs to avoid double-slash bugs (e.g. `mint.com//v1/info`). */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Extract hostname from a URL, returning the raw string on parse failure. */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
