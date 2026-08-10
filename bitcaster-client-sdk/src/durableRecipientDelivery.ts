import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decodeCanonicalMintOrigin } from './durableCustody.ts'

export const DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION = 1 as const
export const DURABLE_RECIPIENT_POST_BYTES_MAX = 65_536
export const DURABLE_RECIPIENT_TOKEN_BYTES_MAX = 61_440

export type DurableRecipientKind = 'matching-engine'
export type DurableRecipientPurpose = 'market-funding' | 'participation-score'
export type DurableRecipientCreditPolicy = 'exact-amount' | 'net-of-receive-fee'
export type DurableRecipientDeliveryState = 'pending' | 'received' | 'credited'

export interface DurableRecipientDeliveryTuple {
  readonly schemaVersion: 1
  readonly deliveryId: string
  readonly accountSubject: string
  readonly recipientKind: DurableRecipientKind
  readonly purpose: DurableRecipientPurpose
  readonly destinationId: string
  readonly productBindingSha256: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly requestedAmount: string
  readonly creditPolicy: DurableRecipientCreditPolicy
  readonly tokenSha256: string
  readonly tokenEncodedLength: number
}

export interface DurableRecipientDeliverySubmission extends DurableRecipientDeliveryTuple {
  readonly token: string
}

export type DurableRecipientDeliveryMetadata = Omit<
  DurableRecipientDeliverySubmission,
  'token' | 'tokenEncodedLength' | 'tokenSha256'
>

export interface DurableRecipientDeliveryResult {
  readonly creditedAmount: string
  readonly receiveFee: string
  readonly creditVerification: DurableRecipientCreditPolicy
  readonly receiveOperationId: string
  readonly receivedAt: string
  readonly businessEventId?: string
  readonly businessEventAt?: string
}

export type DurableRecipientDeliveryStatus =
  | {
      readonly delivery: DurableRecipientDeliveryTuple
      readonly tupleFingerprint: string
      readonly state: 'pending'
      readonly result: null
    }
  | {
      readonly delivery: DurableRecipientDeliveryTuple
      readonly tupleFingerprint: string
      readonly state: 'received'
      readonly result: DurableRecipientDeliveryResult
    }
  | {
      readonly delivery: DurableRecipientDeliveryTuple
      readonly tupleFingerprint: string
      readonly state: 'credited'
      readonly result: DurableRecipientDeliveryResult &
        Required<Pick<DurableRecipientDeliveryResult, 'businessEventId' | 'businessEventAt'>>
    }

/** Decode a submission. This function validates the token but never returns it in a status value. */
export function decodeDurableRecipientDeliverySubmission(
  value: unknown,
): DurableRecipientDeliverySubmission {
  if (!isRecord(value)) throw new Error('durable recipient delivery submission is invalid')
  exactKeys(value, [...tupleKeys, 'token'])
  const tuple = decodeTuple(value, true)
  requireAscii(value.token, 'token', DURABLE_RECIPIENT_TOKEN_BYTES_MAX)
  if (!/^cashuB[A-Za-z0-9_-]+$/.test(value.token))
    throw new Error('durable recipient delivery token is invalid')
  const tokenBytes = new TextEncoder().encode(value.token)
  const tokenEncodedLength = tokenBytes.byteLength
  if (
    tokenEncodedLength !== tuple.tokenEncodedLength ||
    tuple.tokenSha256 !== bytesToHex(sha256(tokenBytes))
  ) {
    throw new Error('durable recipient delivery token authority is invalid')
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > DURABLE_RECIPIENT_POST_BYTES_MAX
  ) {
    throw new Error('durable recipient delivery request body exceeds its limit')
  }
  return { ...tuple, token: value.token }
}

export function decodeDurableRecipientDeliveryStatus(
  value: unknown,
): DurableRecipientDeliveryStatus {
  if (!isRecord(value)) throw new Error('durable recipient delivery status is invalid')
  exactKeys(value, ['delivery', 'tupleFingerprint', 'state', 'result'])
  const delivery = decodeTuple(value.delivery)
  if (
    !isDigest(value.tupleFingerprint) ||
    value.tupleFingerprint !== deriveDurableRecipientTupleFingerprint(delivery)
  ) {
    throw new Error('durable recipient delivery status authority is invalid')
  }
  if (!isDeliveryState(value.state)) throw new Error('durable recipient delivery status is invalid')
  const result = value.result === null ? null : decodeResult(value.result)
  assertStatusInvariant(delivery, value.state, result)
  return {
    delivery,
    tupleFingerprint: value.tupleFingerprint,
    state: value.state,
    result,
  } as DurableRecipientDeliveryStatus
}

export function deriveDurableRecipientTupleFingerprint(
  value: DurableRecipientDeliveryTuple,
): string {
  const tuple = decodeTuple(value, isRecord(value) && Object.hasOwn(value, 'token'))
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        [
          'bitcaster/durable-cashu-delivery/v1',
          tuple.schemaVersion,
          tuple.deliveryId,
          tuple.accountSubject,
          tuple.recipientKind,
          tuple.purpose,
          tuple.destinationId,
          tuple.productBindingSha256,
          tuple.mintUrl,
          tuple.unit,
          tuple.requestedAmount,
          tuple.creditPolicy,
          tuple.tokenSha256,
          tuple.tokenEncodedLength,
        ].join('\0'),
      ),
    ),
  )
}

export function deriveDurableRecipientTokenAllowance(
  value: DurableRecipientDeliveryMetadata,
): number {
  if (!isRecord(value)) throw new Error('durable recipient delivery metadata is invalid')
  exactKeys(value, preMintTupleKeys)
  const tuple = decodeTuple({
    ...value,
    tokenSha256: PRE_MINT_TOKEN_SHA256,
    tokenEncodedLength: DURABLE_RECIPIENT_TOKEN_BYTES_MAX,
  })
  const body = { ...tuple, token: '' }
  return Math.max(
    0,
    Math.min(
      DURABLE_RECIPIENT_TOKEN_BYTES_MAX,
      DURABLE_RECIPIENT_POST_BYTES_MAX - new TextEncoder().encode(JSON.stringify(body)).byteLength,
    ),
  )
}

export function assertDurableRecipientDeliveryPathAuthority(
  pathDeliveryId: string,
  submission: DurableRecipientDeliverySubmission,
): void {
  const exact = decodeDurableRecipientDeliverySubmission(submission)
  if (pathDeliveryId !== exact.deliveryId)
    throw new Error('durable recipient delivery path conflicts')
}

/** Fail closed when a same-id status does not bind the caller's exact immutable tuple. */
export function assertDurableRecipientDeliveryStatusAuthority(input: {
  readonly expected: DurableRecipientDeliveryTuple | DurableRecipientDeliverySubmission
  readonly status: DurableRecipientDeliveryStatus
}): void {
  const expected = decodeTuple(input.expected, Object.hasOwn(input.expected, 'token'))
  const status = decodeDurableRecipientDeliveryStatus(input.status)
  if (
    deriveDurableRecipientTupleFingerprint(expected) !== status.tupleFingerprint ||
    expected.deliveryId !== status.delivery.deliveryId
  ) {
    throw new Error('durable recipient delivery tuple conflicts')
  }
}

/** Fingerprint the complete public result that authorizes one payer acknowledgement. */
export function deriveDurableRecipientDeliveryResultFingerprint(
  value: DurableRecipientDeliveryStatus,
): string {
  const status = decodeDurableRecipientDeliveryStatus(value)
  if (status.result === null) {
    throw new Error('durable recipient delivery result is pending')
  }
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        [
          'bitcaster/durable-cashu-delivery-result/v1',
          status.tupleFingerprint,
          status.state,
          status.result.creditedAmount,
          status.result.receiveFee,
          status.result.creditVerification,
          status.result.receiveOperationId,
          status.result.receivedAt,
          status.result.businessEventId ?? '',
          status.result.businessEventAt ?? '',
        ].join('\0'),
      ),
    ),
  )
}

/** Safe diagnostics. Bearer token material is excluded. */
export function redactedDurableRecipientDeliveryMetadata(
  input: DurableRecipientDeliverySubmission,
): {
  deliveryId: string
  tupleFingerprint: string
  tokenSha256: string
  tokenEncodedLength: number
} {
  const submission = decodeDurableRecipientDeliverySubmission(input)
  return {
    deliveryId: submission.deliveryId,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    tokenSha256: submission.tokenSha256,
    tokenEncodedLength: submission.tokenEncodedLength,
  }
}

const tupleKeys = [
  'schemaVersion',
  'deliveryId',
  'accountSubject',
  'recipientKind',
  'purpose',
  'destinationId',
  'productBindingSha256',
  'mintUrl',
  'unit',
  'requestedAmount',
  'creditPolicy',
  'tokenSha256',
  'tokenEncodedLength',
] as const

const preMintTupleKeys = tupleKeys.filter(
  (key) => key !== 'tokenSha256' && key !== 'tokenEncodedLength',
)
const PRE_MINT_TOKEN_SHA256 = '0'.repeat(64)

function decodeTuple(value: unknown, allowToken = false): DurableRecipientDeliveryTuple {
  if (!isRecord(value)) throw new Error('durable recipient delivery tuple is invalid')
  exactKeys(value, allowToken ? [...tupleKeys, 'token'] : tupleKeys)
  if (value.schemaVersion !== DURABLE_RECIPIENT_DELIVERY_SCHEMA_VERSION) {
    throw new Error('durable recipient delivery schema is unsupported')
  }
  if (!isUuid(value.deliveryId)) throw new Error('durable recipient delivery id is invalid')
  requireAscii(value.accountSubject, 'account subject', 256)
  if (value.recipientKind !== 'matching-engine')
    throw new Error('durable recipient kind is invalid')
  if (value.purpose !== 'market-funding' && value.purpose !== 'participation-score') {
    throw new Error('durable recipient purpose is invalid')
  }
  requireAscii(value.destinationId, 'destination id', 1024)
  if (!isDigest(value.productBindingSha256) || !isDigest(value.tokenSha256)) {
    throw new Error('durable recipient delivery digest is invalid')
  }
  let mintUrl: string
  try {
    requireAscii(value.mintUrl, 'mint URL', 512)
    const parsed = new URL(value.mintUrl)
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      value.mintUrl.endsWith('/') ||
      (parsed.protocol === 'https:' && /:443$/.test(value.mintUrl)) ||
      (parsed.protocol === 'http:' && /:80$/.test(value.mintUrl))
    )
      throw new Error()
    mintUrl = decodeCanonicalMintOrigin(value.mintUrl)
  } catch {
    throw new Error('durable recipient delivery mint URL is not normalized')
  }
  if (value.unit !== 'sat' && value.unit !== 'msat')
    throw new Error('durable recipient unit is invalid')
  requireAmount(value.requestedAmount, 'requested amount')
  if (value.creditPolicy !== 'exact-amount' && value.creditPolicy !== 'net-of-receive-fee') {
    throw new Error('durable recipient credit policy is invalid')
  }
  const tokenEncodedLength = value.tokenEncodedLength
  if (
    typeof tokenEncodedLength !== 'number' ||
    !Number.isSafeInteger(tokenEncodedLength) ||
    tokenEncodedLength < 1 ||
    tokenEncodedLength > DURABLE_RECIPIENT_TOKEN_BYTES_MAX
  ) {
    throw new Error('durable recipient token length is invalid')
  }
  return {
    schemaVersion: 1,
    deliveryId: value.deliveryId,
    accountSubject: value.accountSubject,
    recipientKind: value.recipientKind,
    purpose: value.purpose,
    destinationId: value.destinationId,
    productBindingSha256: value.productBindingSha256,
    mintUrl,
    unit: value.unit,
    requestedAmount: value.requestedAmount,
    creditPolicy: value.creditPolicy,
    tokenSha256: value.tokenSha256,
    tokenEncodedLength,
  }
}

function decodeResult(value: unknown): DurableRecipientDeliveryResult {
  if (!isRecord(value)) throw new Error('durable recipient delivery result is invalid')
  exactKeys(
    value,
    [
      'creditedAmount',
      'receiveFee',
      'creditVerification',
      'receiveOperationId',
      'receivedAt',
      'businessEventId',
      'businessEventAt',
    ],
    true,
  )
  requireAmount(value.creditedAmount, 'credited amount', true)
  requireAmount(value.receiveFee, 'receive fee', true)
  if (
    value.creditVerification !== 'exact-amount' &&
    value.creditVerification !== 'net-of-receive-fee'
  ) {
    throw new Error('durable recipient credit verification is invalid')
  }
  requireAscii(value.receiveOperationId, 'receive operation id', 256)
  requireTimestamp(value.receivedAt, 'received time')
  const businessEventId = value.businessEventId
  const businessEventAt = value.businessEventAt
  const hasEventId = businessEventId !== undefined
  const hasEventAt = businessEventAt !== undefined
  if (hasEventId !== hasEventAt)
    throw new Error('durable recipient business event authority is invalid')
  if (hasEventId) {
    requireAscii(businessEventId, 'business event id', 256)
    requireTimestamp(businessEventAt, 'business event time')
  }
  return {
    creditedAmount: value.creditedAmount,
    receiveFee: value.receiveFee,
    creditVerification: value.creditVerification,
    receiveOperationId: value.receiveOperationId,
    receivedAt: value.receivedAt,
    ...(hasEventId
      ? { businessEventId: businessEventId as string, businessEventAt: businessEventAt as string }
      : {}),
  }
}

function assertStatusInvariant(
  tuple: DurableRecipientDeliveryTuple,
  state: DurableRecipientDeliveryState,
  result: DurableRecipientDeliveryResult | null,
): void {
  if (state === 'pending') {
    if (result !== null) throw new Error('pending durable recipient delivery has a result')
    return
  }
  if (result === null)
    throw new Error('received durable recipient delivery lacks receive authority')
  if (result.creditVerification !== tuple.creditPolicy)
    throw new Error('durable recipient credit policy conflicts')
  const credited = BigInt(result.creditedAmount)
  const fee = BigInt(result.receiveFee)
  const requested = BigInt(tuple.requestedAmount)
  if (
    (tuple.creditPolicy === 'exact-amount' && credited !== requested) ||
    (tuple.creditPolicy === 'net-of-receive-fee' && credited + fee !== requested)
  ) {
    throw new Error('durable recipient credit amount conflicts')
  }
  const hasEvent = result.businessEventId !== undefined
  if ((state === 'received' && hasEvent) || (state === 'credited' && !hasEvent)) {
    throw new Error('durable recipient delivery terminal authority is invalid')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optionalEvent = false,
): void {
  const allowed = optionalEvent ? [...keys] : keys
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    keys.some((key) => !optionalEvent && value[key] === undefined)
  )
    throw new Error('durable recipient delivery contains foreign fields')
}
function requireAmount(value: unknown, label: string, zero = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n ||
    (!zero && value === '0')
  )
    throw new Error(`durable recipient ${label} is invalid`)
}
function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new Error(`durable recipient ${label} is invalid`)
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
}
function isDeliveryState(value: unknown): value is DurableRecipientDeliveryState {
  return value === 'pending' || value === 'received' || value === 'credited'
}
function requireAscii(value: unknown, label: string, maximum: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    throw new Error(`durable recipient ${label} is invalid`)
}
