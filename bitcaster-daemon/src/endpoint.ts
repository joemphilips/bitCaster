import { isLoopbackHttpUrl } from '@bitcaster-market/client-sdk'

export function normalizeEndpointUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid ${name}: expected http or https URL`)
  }
  if (url.protocol === 'http:' && !isLoopbackHttpUrl(url.toString())) {
    throw new Error(`Invalid ${name}: expected https or loopback http URL`)
  }
  return value.replace(/\/+$/, '')
}
