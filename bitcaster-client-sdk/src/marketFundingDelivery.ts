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
import { parseMarketDivisibility } from './marketUnits.ts'

const MARKET_FUNDING_DELIVERY_DOMAIN = 'bitcaster/market-funding-delivery/v1'

export interface MarketFundingDeliveryInput {
  readonly deliveryId: string
  readonly accountSubject: string
  readonly conditionId: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly requestedAmount: string
  readonly divisibility: number
}

/** Build the immutable durable-recipient metadata for AMM market funding. */
export function createMarketFundingDeliveryMetadata(
  input: MarketFundingDeliveryInput,
): DurableRecipientDeliveryMetadata {
  if (input.unit !== 'msat') {
    throw new Error('market funding unit must be msat')
  }
  const conditionId = requireConditionId(input.conditionId)
  const accountSubject = requireAccountSubject(input.accountSubject)
  const divisibility = requireDivisibility(input.divisibility)
  const requestedAmount = requireRequestedAmount(input.requestedAmount, divisibility)
  const metadata: DurableRecipientDeliveryMetadata = {
    schemaVersion: 1,
    deliveryId: input.deliveryId,
    accountSubject,
    recipientKind: 'matching-engine',
    purpose: 'market-funding',
    destinationId: conditionId,
    productBindingSha256: deriveMarketFundingProductBinding({
      conditionId,
      divisibility,
      accountSubject,
    }),
    mintUrl: decodeCanonicalMintOrigin(input.mintUrl),
    unit: input.unit,
    requestedAmount,
    creditPolicy: 'net-of-receive-fee',
  }
  deriveDurableRecipientTokenAllowance(metadata)
  return metadata
}

/** Bind the AMM product fields that determine the credited market product. */
export function deriveMarketFundingProductBinding(input: {
  readonly conditionId: string
  readonly divisibility: number
  readonly accountSubject: string
}): string {
  const conditionId = requireConditionId(input.conditionId)
  const accountSubject = requireAccountSubject(input.accountSubject)
  const divisibility = requireDivisibility(input.divisibility)
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        [
          MARKET_FUNDING_DELIVERY_DOMAIN,
          conditionId,
          String(divisibility),
          'true',
          accountSubject,
        ].join('\0'),
      ),
    ),
  )
}

/** Bind the exact persisted bearer token to the already prepared market-funding tuple. */
export function createMarketFundingDeliverySubmission(input: {
  readonly metadata: DurableRecipientDeliveryMetadata
  readonly token: string
}): DurableRecipientDeliverySubmission {
  const encodedToken = new TextEncoder().encode(input.token)
  if (encodedToken.byteLength > DURABLE_RECIPIENT_TOKEN_BYTES_MAX) {
    throw new Error('market funding delivery token exceeds its limit')
  }
  return decodeDurableRecipientDeliverySubmission({
    ...input.metadata,
    tokenSha256: bytesToHex(sha256(encodedToken)),
    tokenEncodedLength: encodedToken.byteLength,
    token: input.token,
  })
}

/** Use the shared durable-recipient policy without creating another payment protocol. */
export function marketFundingDeliveryIntent(input: {
  readonly accountSubject: string
  readonly productBindingSha256: string
  readonly tokenBytesLimit: number
}): DurableOutgoingCashuDeliveryIntent {
  return {
    policy: 'durable-recipient-ack',
    expectedSubject: requireAccountSubject(input.accountSubject),
    opaqueProductBinding: requireDigest(input.productBindingSha256),
    tokenBytesLimit: input.tokenBytesLimit,
    tokenProofLimit: DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX,
  }
}

function requireConditionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{1,128}$/.test(value)) {
    throw new Error('market funding condition id is invalid')
  }
  return value
}

function requireAccountSubject(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    /[^\x20-\x7e]/.test(value) ||
    value.includes('\0')
  ) {
    throw new Error('market funding account subject is invalid')
  }
  return value
}

function requireDivisibility(value: unknown): number {
  const divisibility = parseMarketDivisibility(value)
  if (divisibility === null) {
    throw new Error('market funding divisibility is invalid')
  }
  return divisibility
}

function requireRequestedAmount(value: unknown, divisibility: number): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('market funding requested amount is invalid')
  }
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < 1 || amount % divisibility !== 0) {
    throw new Error('market funding requested amount is invalid')
  }
  return value
}

function requireDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('market funding product binding is invalid')
  }
  return value
}
