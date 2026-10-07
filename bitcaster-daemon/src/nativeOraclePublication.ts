import { Relay } from 'nostr-tools/relay'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import {
  verifyOracleResolutionExplanation,
  type OracleExplanationContext,
} from '@bitcaster-market/client-sdk'

type PublicationRelay = Pick<Relay, 'connect' | 'publish' | 'close' | 'publishTimeout'>

const MAX_CONCURRENT_RELAY_PUBLICATIONS = 4

export async function publishNativeOracleEvent(
  relayUrls: readonly string[],
  eventJson: string,
  createRelay: (url: string) => PublicationRelay = (url) =>
    new Relay(url, { enableReconnect: false, enablePing: false }),
  explanationContext?: OracleExplanationContext,
) {
  const urls = normalizeOracleRelayUrls(relayUrls)
  let event: Event
  try {
    event = JSON.parse(eventJson) as Event
    if (event.kind === 1111 && explanationContext !== undefined)
      event = verifyOracleResolutionExplanation(explanationContext, eventJson)
    else if ((event.kind !== 88 && event.kind !== 89) || !verifyEvent(event)) throw new Error()
  } catch {
    throw new Error('Stored oracle event is invalid.')
  }
  const accepted = new Array<boolean>(urls.length).fill(false)
  let nextUrlIndex = 0
  const publishNext = async () => {
    while (nextUrlIndex < urls.length) {
      const index = nextUrlIndex++
      const url = urls[index]
      try {
        // The pool can resolve a connection failure as a string. Require a relay publish acknowledgement.
        const relay = createRelay(url)
        relay.publishTimeout = 5_000
        let acknowledged = false
        try {
          await relay.connect({ timeout: 3_000 })
          await relay.publish(event)
          acknowledged = true
        } finally {
          relay.close()
        }
        accepted[index] = acknowledged
      } catch {
        // Continue so one failed relay does not prevent attempts to the rest.
      }
    }
  }
  const workerCount = Math.min(MAX_CONCURRENT_RELAY_PUBLICATIONS, urls.length)
  await Promise.all(Array.from({ length: workerCount }, () => publishNext()))
  const acceptedRelays = urls.filter((_, index) => accepted[index])
  if (acceptedRelays.length === 0) {
    throw new Error('No relay acknowledged the oracle event. Retry the same operation.')
  }
  return {
    eventId: event.id,
    acceptedRelays,
    rejectedRelayCount: urls.length - acceptedRelays.length,
  }
}

export function normalizeOracleRelayUrls(relayUrls: readonly string[]): string[] {
  // Match the existing durable market-creation relay bound before starting transports.
  if (relayUrls.length > 64) throw new Error('At most 64 oracle relays are supported.')
  const urls = [...new Set(relayUrls.map(normalizeRelayUrl))]
  if (urls.length === 0) throw new Error('At least one oracle relay is required.')
  return urls
}

function normalizeRelayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Oracle relay URL is invalid.')
  }
  if (
    (url.protocol !== 'wss:' && url.protocol !== 'ws:') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Oracle relay URL must use ws or wss without credentials or a fragment.')
  }
  return url.href
}
