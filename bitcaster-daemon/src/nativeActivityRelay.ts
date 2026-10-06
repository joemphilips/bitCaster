import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { normalizeNostrRelayUrls } from '@bitcaster-market/client-sdk/nostrRelays'
import { NativeNostrRelay, type NativeNostrRelayOptions } from './nativeNostrRelay.ts'

type Relay = Pick<NativeNostrRelay, 'connect' | 'subscribe' | 'publish' | 'close'>
export type NativeActivityRelayFactory = (url: string, options: NativeNostrRelayOptions) => Relay
const defaultFactory: NativeActivityRelayFactory = (url, options) =>
  new NativeNostrRelay(url, options)
export const NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX = 128 * 1024
export const NATIVE_ACTIVITY_RELAY_FRAMES_MAX = 64
export const NATIVE_ACTIVITY_RELAY_EVENTS_MAX = 16
const QUERY_BYTES_MAX = 1024 * 1024
const DEADLINE_MS = 5000

export interface NativeActivityRelayOptions {
  readonly factory?: NativeActivityRelayFactory
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

/** Raw bounds precede upstream signature filtering and exact-event deduplication. */
export async function queryNativeActivityRelay(
  url: string,
  filter: Filter,
  options: NativeActivityRelayOptions = {},
): Promise<{ readonly events: readonly unknown[]; readonly complete: boolean }> {
  const deadline = checkedDeadline(options.deadlineMs)
  const candidates: { readonly subscriptionId: unknown; readonly event: unknown }[] = []
  const events = () =>
    candidates
      .filter((candidate) => candidate.subscriptionId === subscription?.id)
      .map((candidate) => candidate.event)
  let frames = 0,
    bytes = 0,
    complete = false,
    finished = false
  const observedEose = new Set<string>()
  let finish: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    finish = () => {
      finished = true
      resolve()
    }
  })
  const owner = new AbortController()
  const relay = (options.factory ?? defaultFactory)(normalizeNostrRelayUrls([url])[0]!, {
    signal: owner.signal,
    connectTimeoutMs: deadline,
    maxMessageBytes: NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX,
    onclose: () => finish(),
    acceptMessage(message) {
      frames += 1
      bytes += Buffer.byteLength(message)
      if (frames > NATIVE_ACTIVITY_RELAY_FRAMES_MAX || bytes > QUERY_BYTES_MAX) return false
      let frame: unknown
      try {
        frame = JSON.parse(message)
      } catch {
        return false
      }
      if (!Array.isArray(frame)) return false
      if (frame[0] === 'EOSE' && typeof frame[1] === 'string') observedEose.add(frame[1])
      if (frame[0] === 'EVENT') {
        if (candidates.length === NATIVE_ACTIVITY_RELAY_EVENTS_MAX) return false
        candidates.push({ subscriptionId: frame[1], event: frame[2] })
      }
      return true
    },
  })
  let subscription: { close(): void; id: string } | undefined
  const abort = () => {
    owner.abort()
    relay.close()
    finish()
  }
  const timer = setTimeout(abort, deadline)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (options.signal?.aborted) return { events: events(), complete }
    await Promise.race([relay.connect(), completion])
    if (finished || options.signal?.aborted) return { events: events(), complete }
    subscription = relay.subscribe([filter], {
      onevent() {},
      oneose() {
        complete = subscription !== undefined && observedEose.has(subscription.id)
        finish()
      },
      onclose: () => finish(),
      eoseTimeoutMs: deadline + 1,
    })
    await completion
  } catch {
    complete = false
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    subscription?.close()
    relay.close()
    owner.abort()
  }
  return { events: events(), complete }
}

/** An acknowledgement is one relay result, not durable global history. */
export async function publishNativeActivityRelay(
  url: string,
  event: Event,
  options: NativeActivityRelayOptions = {},
  beforePublish?: () => Promise<void>,
): Promise<boolean> {
  const deadline = checkedDeadline(options.deadlineMs)
  if (Buffer.byteLength(JSON.stringify(['EVENT', event])) > NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX)
    throw new Error('Activity publication exceeds its frame bound')
  const owner = new AbortController()
  let stopped = false,
    frames = 0,
    bytes = 0
  let finish: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    finish = () => {
      stopped = true
      resolve()
    }
  })
  const relay = (options.factory ?? defaultFactory)(normalizeNostrRelayUrls([url])[0]!, {
    signal: owner.signal,
    connectTimeoutMs: deadline,
    publishTimeoutMs: deadline,
    maxMessageBytes: NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX,
    onclose: () => finish(),
    acceptMessage: (message) => {
      frames += 1
      bytes += Buffer.byteLength(message)
      if (frames > NATIVE_ACTIVITY_RELAY_FRAMES_MAX || bytes > QUERY_BYTES_MAX) return false
      try {
        const frame: unknown = JSON.parse(message)
        return Array.isArray(frame) && frame.length <= 4 && Buffer.byteLength(message) <= 4096
      } catch {
        return false
      }
    },
  })
  const abort = () => {
    owner.abort()
    relay.close()
    finish()
  }
  const timer = setTimeout(abort, deadline)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (options.signal?.aborted) return false
    await Promise.race([relay.connect(), completion])
    if (stopped || options.signal?.aborted) return false
    await Promise.race([Promise.resolve(beforePublish?.()), completion])
    if (stopped || options.signal?.aborted) return false
    const acknowledged = await Promise.race([
      relay.publish(event).then(() => true),
      completion.then(() => false),
    ])
    return acknowledged && !stopped && !options.signal?.aborted
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    relay.close()
    owner.abort()
  }
}

function checkedDeadline(value = DEADLINE_MS): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEADLINE_MS)
    throw new Error('Activity relay deadline is invalid')
  return value
}
