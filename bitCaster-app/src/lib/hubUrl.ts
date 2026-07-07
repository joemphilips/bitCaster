const DEFAULT_DEV_SERVER_URL = 'http://localhost:5000'

interface HubUrlEnv {
  DEV?: boolean
  VITE_HUB_SERVER_URL?: string
  VITE_SERVER_URL?: string
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Resolve the browser-facing origin used for SignalR hubs.
 *
 * Production goes through the frontend Express proxy (`/hubs/**`) so the
 * browser never talks to the IP-restricted backend App Service directly.
 * Local dev may still point hubs at a specific engine through Vite env.
 */
export function resolveHubServerUrl(
  env: HubUrlEnv = import.meta.env,
  browserOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined,
): string {
  const explicitHubUrl = env.VITE_HUB_SERVER_URL
  if (explicitHubUrl) return trimTrailingSlash(explicitHubUrl)

  if (env.DEV && env.VITE_SERVER_URL) {
    return trimTrailingSlash(env.VITE_SERVER_URL)
  }

  if (browserOrigin) {
    return trimTrailingSlash(browserOrigin)
  }

  return DEFAULT_DEV_SERVER_URL
}

export function resolveApiServerUrl(
  env: HubUrlEnv = import.meta.env,
  browserOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined,
): string {
  if (env.DEV) {
    const explicitApiUrl = env.VITE_SERVER_URL ?? env.VITE_HUB_SERVER_URL
    if (explicitApiUrl) return trimTrailingSlash(explicitApiUrl)
  }

  if (browserOrigin) {
    return trimTrailingSlash(browserOrigin)
  }

  return DEFAULT_DEV_SERVER_URL
}

export function resolveApiSigningUrl(
  requestUrl: string,
  _env: HubUrlEnv = import.meta.env,
  _browserOrigin = typeof window !== 'undefined' ? window.location?.origin : undefined,
): string {
  return requestUrl
}
