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

/**
 * Build the full URL for the OrderHub SignalR endpoint.
 * The server checks the `u` tag against the negotiation URL.
 */
export function orderHubUrl(baseUrl: string): string {
  return `${baseUrl}/hubs/order`;
}
