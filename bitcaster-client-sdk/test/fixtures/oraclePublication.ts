import { finalizeEvent } from 'nostr-tools/pure'
import { deriveDlcConditionId } from '../../src/managedConditionInventory.ts'
import {
  createOracleExplanationTemplate,
  type OracleExplanationContext,
} from '../../src/oracleResolutionExplanation.ts'
import type {
  OraclePublicationBinding,
  PreparedOracleAttestation,
  VerifiedOraclePublicationEvidence,
} from '../../src/oraclePublication.ts'

// Public test key. It is not an application credential.
export const oracleTestKey = Uint8Array.from({ length: 32 }, () => 0x11)
export const otherOracleTestKey = Uint8Array.from({ length: 32 }, () => 0x22)

export function oracleFixture() {
  const announcement = finalizeEvent(
    {
      kind: 88,
      created_at: 1_700_000_000,
      tags: [],
      content: 'public-announcement',
    },
    oracleTestKey,
  )
  const binding: OraclePublicationBinding = {
    conditionId: deriveDlcConditionId({
      eventId: 'retained-oracle-event',
      outcomeCount: 2,
      oraclePublicKeys: [announcement.pubkey],
    }),
    oracleEventId: 'retained-oracle-event',
    oraclePubkey: announcement.pubkey,
    outcomes: ['YES', 'NO'],
    announcementEventJson: JSON.stringify(announcement),
  }
  const attestation = finalizeEvent(
    {
      kind: 89,
      created_at: 1_700_000_001,
      tags: [['e', announcement.id]],
      content: 'qrs=',
    },
    oracleTestKey,
  )
  const artifact: PreparedOracleAttestation = {
    attestationHex: 'aabb',
    eventJson: JSON.stringify(attestation),
  }
  const evidence: VerifiedOraclePublicationEvidence = {
    conditionId: binding.conditionId,
    oracleEventId: binding.oracleEventId,
    oraclePubkey: binding.oraclePubkey,
    outcome: 'YES',
    announcementEventId: announcement.id,
    attestationEventId: attestation.id,
  }
  const context: OracleExplanationContext = {
    oraclePubkey: binding.oraclePubkey,
    announcementEventJson: binding.announcementEventJson,
    attestationEventJson: artifact.eventJson,
  }
  return { binding, announcement, attestation, artifact, evidence, context }
}

export function signedExplanation(
  context: OracleExplanationContext,
  content = 'The published result is YES.',
) {
  return JSON.stringify(
    finalizeEvent(createOracleExplanationTemplate(context, content, 1_700_000_002), oracleTestKey),
  )
}
