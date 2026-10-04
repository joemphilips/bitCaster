import type { Filter } from 'nostr-tools/filter'
import { validateEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'

export interface NostrPublicProfile {
  readonly pubkey: string
  readonly displayName: string
  readonly avatar: string
  readonly nip05: string
  readonly nip05verified: false
  readonly bio: string
  readonly eventId: string
  readonly createdAt: number
}

export interface NostrProfileReadResult {
  readonly status: 'found' | 'not-found'
  readonly profile: NostrPublicProfile | null
  readonly completedRelayCount: number
  readonly failedRelayCount: number
}

export type NostrProfileQuery = (
  relayUrl: string,
  filter: Filter,
  onEvent: (event: Event) => void,
) => Promise<void>

function verifiedProfileEvent(value: unknown, publicKeyHex: string): Event | null {
  try {
    if (!validateEvent(value)) return null
    const event = value as Event
    if (
      event.kind !== 0 ||
      event.pubkey !== publicKeyHex ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 ||
      new TextEncoder().encode(event.content).byteLength > 65_536
    )
      return null
    // Do not inherit nostr-tools' cached verification symbol from a caller's object.
    const signed = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    }
    return verifyEvent(signed) ? signed : null
  } catch {
    return null
  }
}

export function decodeNostrProfileEvent(
  value: unknown,
  publicKeyHex: string,
): NostrPublicProfile | null {
  const event = verifiedProfileEvent(value, publicKeyHex)
  if (!event) return null
  try {
    const metadata: unknown = JSON.parse(event.content)
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null
    const fields = metadata as Record<string, unknown>
    const text = (key: string): string | undefined =>
      typeof fields[key] === 'string' ? (fields[key] as string) : undefined
    return {
      pubkey: publicKeyHex,
      displayName:
        text('display_name') ?? text('displayName') ?? text('name') ?? publicKeyHex.slice(0, 8),
      avatar: text('picture') ?? text('image') ?? '',
      nip05: text('nip05') ?? '',
      // A kind-0 claim is not proof of control of the NIP-05 address.
      nip05verified: false,
      bio: text('bio') ?? text('about') ?? '',
      eventId: event.id,
      createdAt: event.created_at,
    }
  } catch {
    return null
  }
}

/** Each read queries only the selected relays. It has no persistent metadata cache. */
export async function readNostrProfile(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrProfileQuery,
): Promise<NostrProfileReadResult> {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) throw new Error('Nostr profile public key is invalid.')
  const relays = normalizeNostrRelayUrls(relayUrls)
  if (relays.length === 0)
    throw new Error('Configure a Nostr relay before reading the signer profile.')
  let latest: Event | null = null
  let completedRelayCount = 0
  let failedRelayCount = 0
  await Promise.all(
    relays.map(async (url) => {
      let active = true
      try {
        await query(url, { kinds: [0], authors: [publicKeyHex], limit: 1 }, (value) => {
          if (!active) return
          const event = verifiedProfileEvent(value, publicKeyHex)
          if (
            event &&
            (!latest ||
              event.created_at > latest.created_at ||
              (event.created_at === latest.created_at && event.id < latest.id))
          )
            latest = event
        })
        completedRelayCount += 1
      } catch {
        failedRelayCount += 1
      } finally {
        active = false
      }
    }),
  )
  if (completedRelayCount === 0)
    throw new Error('Nostr profile read failed. Check the configured relays and retry.')
  const profile = decodeNostrProfileEvent(latest, publicKeyHex)
  return { status: profile ? 'found' : 'not-found', profile, completedRelayCount, failedRelayCount }
}
