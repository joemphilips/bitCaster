export const MARKET_CREATE_HTTPS_ENGINE_ERROR =
  'market.create requires an https or loopback engine URL'

export const MARKET_CREATE_INSECURE_ENGINE_CODE = 'insecure-engine-url'

export interface MarketCreateEngineUrlValidationResult {
  ok: boolean
  error?: typeof MARKET_CREATE_HTTPS_ENGINE_ERROR
  code?: typeof MARKET_CREATE_INSECURE_ENGINE_CODE
}

export function validateMarketCreateEngineUrl(
  engineUrl: string,
  allowInsecureLocalhost: boolean,
): MarketCreateEngineUrlValidationResult {
  const url = new URL(engineUrl)
  if (url.protocol === 'https:') return { ok: true }
  if (url.protocol === 'http:' && allowInsecureLocalhost && isLoopbackHostname(url.hostname)) {
    return { ok: true }
  }
  return {
    ok: false,
    error: MARKET_CREATE_HTTPS_ENGINE_ERROR,
    code: MARKET_CREATE_INSECURE_ENGINE_CODE,
  }
}

export function isLoopbackHttpUrl(value: string): boolean {
  const url = new URL(value)
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
}

/**
 * Validate an endpoint URL and return its text without trailing slashes. The
 * text is what a prompt and the config file show. So the text must show the
 * host that the URL reaches: no control character, no space, no non-ASCII
 * character, and no user name before the host.
 */
export function normalizeEndpointUrl(value: string, name: string): string {
  // Check the text before an error message can repeat it.
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(
      `Invalid ${name}: the URL must contain only printable ASCII characters, with no space or control character`,
    )
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid ${name}: expected http or https URL`)
  }
  // `https://@host` parses to an empty user name, but its text still has the at sign.
  if (url.username !== '' || url.password !== '' || /^[^:]+:\/\/[^/?#]*@/.test(value)) {
    throw new Error(`Invalid ${name}: the URL must not contain a user name or password`)
  }
  if (url.protocol === 'http:' && !isLoopbackHttpUrl(url.toString())) {
    throw new Error(`Invalid ${name}: expected https or loopback http URL`)
  }
  return value.replace(/\/+$/, '')
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}
