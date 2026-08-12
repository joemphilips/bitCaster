import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX,
  type DurableOutgoingCashuDeliveryIntent,
} from './durableOutgoingCashuTransfer.ts'
import {
  DURABLE_RECIPIENT_TOKEN_BYTES_MAX,
  decodeDurableRecipientDeliverySubmission,
  deriveDurableRecipientTokenAllowance,
  type DurableRecipientDeliveryMetadata,
  type DurableRecipientDeliverySubmission,
} from './durableRecipientDelivery.ts'
import { decodeCanonicalMintOrigin } from './durableCustody.ts'

const PARTICIPATION_SCORE_DELIVERY_DOMAIN = 'bitcaster/participation-score-delivery/v1'

export interface ParticipationScoreDeliveryInput {
  readonly deliveryId: string
  readonly accountSubject: string
  readonly mintUrl: string
  readonly requestedAmount: string
}

/** Build the immutable durable-recipient metadata for a Participation Score credit. */
export function createParticipationScoreDeliveryMetadata(
  input: ParticipationScoreDeliveryInput,
): DurableRecipientDeliveryMetadata {
  const requestedAmount = requireRequestedAmount(input.requestedAmount)
  const metadata: DurableRecipientDeliveryMetadata = {
    schemaVersion: 1,
    deliveryId: input.deliveryId,
    accountSubject: input.accountSubject,
    recipientKind: 'matching-engine',
    purpose: 'participation-score',
    destinationId: input.deliveryId,
    productBindingSha256: deriveParticipationScoreProductBinding(),
    mintUrl: decodeCanonicalMintOrigin(input.mintUrl),
    unit: 'sat',
    requestedAmount,
    creditPolicy: 'exact-amount',
  }
  deriveDurableRecipientTokenAllowance(metadata)
  return metadata
}

/** Return the fixed domain-separated Participation Score product binding. */
export function deriveParticipationScoreProductBinding(): string {
  return bytesToHex(sha256(new TextEncoder().encode(PARTICIPATION_SCORE_DELIVERY_DOMAIN)))
}

/** Bind the exact persisted bearer token to the already prepared Score tuple. */
export function createParticipationScoreDeliverySubmission(input: {
  readonly metadata: DurableRecipientDeliveryMetadata
  readonly token: string
}): DurableRecipientDeliverySubmission {
  const encodedToken = new TextEncoder().encode(input.token)
  if (encodedToken.byteLength > DURABLE_RECIPIENT_TOKEN_BYTES_MAX) {
    throw new Error('Participation Score delivery token exceeds its limit')
  }
  return decodeDurableRecipientDeliverySubmission({
    ...input.metadata,
    tokenSha256: bytesToHex(sha256(encodedToken)),
    tokenEncodedLength: encodedToken.byteLength,
    token: input.token,
  })
}

/** Use the shared durable-recipient policy without creating another payment protocol. */
export function participationScoreDeliveryIntent(input: {
  readonly accountSubject: string
  readonly productBindingSha256: string
  readonly tokenBytesLimit: number
}): DurableOutgoingCashuDeliveryIntent {
  return {
    policy: 'durable-recipient-ack',
    expectedSubject: input.accountSubject,
    opaqueProductBinding: input.productBindingSha256,
    tokenBytesLimit: input.tokenBytesLimit,
    tokenProofLimit: DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX,
  }
}

function requireRequestedAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('Participation Score requested amount is invalid')
  }
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Participation Score requested amount is invalid')
  }
  return value
}
