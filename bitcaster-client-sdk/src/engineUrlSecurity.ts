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

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}
