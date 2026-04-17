/**
 * NIP-98 HTTP Auth token generation for bitCaster.
 *
 * The server's Nip98AuthenticationHandler expects:
 *   Authorization: Nostr <base64url(JSON(kind-27235 event))>
 *
 * The event must be freshly signed (within ±60 s) and committed to the
 * request URL and HTTP method via tags.
 *
 * Reference: https://github.com/nostr-protocol/nips/blob/master/98.md
 */

import { finalizeEvent } from 'nostr-tools/pure'
import type { EventTemplate } from 'nostr-tools/core'

const KIND_HTTP_AUTH = 27235

/**
 * Generate a NIP-98 `Authorization: Nostr <token>` header value.
 *
 * @param privateKey - 32-byte raw secp256k1 private key
 * @param url        - Full URL the request targets (must match server-side check)
 * @param method     - HTTP method in uppercase ("GET", "POST", …)
 */
export function generateNip98AuthHeader(
  privateKey: Uint8Array,
  url: string,
  method: string,
): string {
  const template: EventTemplate = {
    kind: KIND_HTTP_AUTH,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', method.toUpperCase()],
    ],
    content: '',
  }
  const event = finalizeEvent(template, privateKey)
  const token = btoa(JSON.stringify(event))
  return `Nostr ${token}`
}

/**
 * Build the full URL for the TradeHub SignalR endpoint.
 * The server checks the `u` tag against the negotiation URL.
 */
export function tradeHubUrl(baseUrl: string): string {
  return `${baseUrl}/hubs/trade`
}
