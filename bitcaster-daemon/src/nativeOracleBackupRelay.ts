import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { normalizeNostrRelayUrls, readOracleBackupRelayEvent } from '@bitcaster-market/client-sdk'
import { NativeNostrRelay, type NativeNostrRelayOptions } from './nativeNostrRelay.ts'

type Relay = Pick<NativeNostrRelay, 'connect' | 'subscribe' | 'publish' | 'close'>
export type NativeOracleBackupRelayFactory = (
  url: string,
  options: NativeNostrRelayOptions,
) => Relay
const defaultFactory: NativeOracleBackupRelayFactory = (url, options) =>
  new NativeNostrRelay(url, options)
const FRAME_BYTES_MAX = 128 * 1024
const QUERY_FRAMES_MAX = 512
const QUERY_DEADLINE_MS = 5000

export interface NativeOracleBackupQuery {
  readonly relayUrl: string
  readonly filter: {
    readonly kinds?: readonly number[]
    readonly authors?: readonly string[]
    readonly ids?: readonly string[]
    readonly '#v'?: readonly string[]
    readonly limit: number
    readonly since?: number
    readonly until?: number
  }
  readonly signal: AbortSignal
  readonly maxEvents: number
  readonly maxBytes: number
}

/** Count raw frames before the relay library filters invalid signatures or duplicate IDs. */
export async function queryNativeOracleBackupRelay(
  request: NativeOracleBackupQuery,
  factory: NativeOracleBackupRelayFactory = defaultFactory,
): Promise<{ events: unknown[]; complete: boolean }> {
  const url = normalizeNostrRelayUrls([request.relayUrl])[0]!
  if (
    !Number.isSafeInteger(request.maxEvents) ||
    request.maxEvents < 1 ||
    request.maxEvents > 128 ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 ||
    request.maxBytes > 32 * 1024 * 1024
  )
    throw new Error('Oracle backup query bound is invalid.')
  const events: unknown[] = []
  let frames = 0,
    bytes = 0,
    complete = false
  const eoseSubscriptions = new Set<string>()
  let finish: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    finish = resolve
  })
  const relay = factory(url, {
    signal: request.signal,
    maxMessageBytes: FRAME_BYTES_MAX,
    onclose: () => finish(),
    acceptMessage(message) {
      frames += 1
      bytes += Buffer.byteLength(message)
      if (frames > QUERY_FRAMES_MAX || bytes > request.maxBytes) return false
      let frame: unknown
      try {
        frame = JSON.parse(message)
      } catch {
        return false
      }
      if (Array.isArray(frame) && frame[0] === 'EOSE' && typeof frame[1] === 'string')
        eoseSubscriptions.add(frame[1])
      if (Array.isArray(frame) && frame[0] === 'EVENT') {
        if (events.length === request.maxEvents) return false
        events.push(frame[2])
      }
      return true
    },
  })
  let subscription: { close(): void; id: string } | undefined
  const abort = () => {
    relay.close()
    finish()
  }
  const timer = setTimeout(abort, QUERY_DEADLINE_MS)
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    if (request.signal.aborted) return { events, complete }
    await relay.connect()
    if (request.signal.aborted) return { events, complete }
    // EOSE completes only this observed query. It makes no retention claim.
    subscription = relay.subscribe([request.filter as Filter], {
      onevent() {},
      oneose() {
        complete = subscription !== undefined && eoseSubscriptions.has(subscription.id)
        subscription?.close()
        finish()
      },
      onclose: () => finish(),
      eoseTimeoutMs: QUERY_DEADLINE_MS,
    })
    await completion
  } catch {
    complete = false
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
    subscription?.close()
    relay.close()
  }
  return { events, complete }
}

/** Separate backup transport. The owner has already validated the saved delivery stage. */
export async function publishNativeOracleBackupEvent(
  relayUrl: string,
  eventJson: string,
  factory: NativeOracleBackupRelayFactory = defaultFactory,
): Promise<{ eventId: string; relayUrl: string }> {
  const url = normalizeNostrRelayUrls([relayUrl])[0]!
  let event: Event
  try {
    if (Buffer.byteLength(eventJson) > FRAME_BYTES_MAX) throw new Error()
    event = readOracleBackupRelayEvent(eventJson)
  } catch {
    throw new Error('Stored oracle backup event is invalid.')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QUERY_DEADLINE_MS)
  const relay = factory(url, { signal: controller.signal })
  try {
    await relay.connect()
    await relay.publish(event)
    return { eventId: event.id, relayUrl: url }
  } catch {
    throw new Error('Oracle backup relay did not acknowledge the saved event.')
  } finally {
    clearTimeout(timer)
    relay.close()
  }
}
