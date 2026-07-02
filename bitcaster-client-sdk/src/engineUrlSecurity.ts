export const MARKET_CREATE_HTTPS_ENGINE_ERROR =
  'market.create requires https engine URL (or BITCASTER_ALLOW_INSECURE_ENGINE=1 for localhost)'

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
  if (url.protocol === 'http:' && allowInsecureLocalhost && isMarketCreateLocalhost(url.hostname)) {
    return { ok: true }
  }
  return {
    ok: false,
    error: MARKET_CREATE_HTTPS_ENGINE_ERROR,
    code: MARKET_CREATE_INSECURE_ENGINE_CODE,
  }
}

function isMarketCreateLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}
