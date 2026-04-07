import type { OracleAnnouncement } from '@/types/market-creation'
import { getNdk, connectReadOnly, oracleAnnouncementFilter } from '@/lib/nostr'
import type { NDKEvent } from '@nostr-dev-kit/ndk'

function parseAnnouncementEvent(event: NDKEvent): OracleAnnouncement | null {
  try {
    const content = event.content
    // Oracle announcements contain TLV-encoded data in hex
    // The event tags contain structured metadata
    const descriptionTag = event.tags.find((t) => t[0] === 'description')
    const outcomesTag = event.tags.find((t) => t[0] === 'outcomes')
    const maturityTag = event.tags.find((t) => t[0] === 'maturity')

    return {
      id: content, // The announcement hex (TLV data)
      eventId: event.id,
      oraclePubkey: event.pubkey,
      description: descriptionTag?.[1] ?? 'Untitled announcement',
      resolutionDate: maturityTag?.[1] ?? new Date().toISOString(),
      outcomes: outcomesTag ? outcomesTag.slice(1) : [],
    }
  } catch {
    return null
  }
}

export async function fetchOracleAnnouncements(
  oraclePubkey: string,
): Promise<OracleAnnouncement[]> {
  await connectReadOnly()
  const ndk = getNdk()
  const filter = oracleAnnouncementFilter(oraclePubkey)

  const events = await ndk.fetchEvents(filter)
  const announcements: OracleAnnouncement[] = []

  for (const event of events) {
    const parsed = parseAnnouncementEvent(event)
    if (parsed) announcements.push(parsed)
  }

  return announcements
}
