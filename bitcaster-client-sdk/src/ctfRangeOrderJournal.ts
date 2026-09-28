import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyScopeInput,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import { assertOrderRouteBelongsToCondition } from './orderRoute.ts'
import { parseMarketDivisibility, type MarketDivisibility } from './marketUnits.ts'

export const CTF_RANGE_ORDER_PREPARATION_BYTES_MAX = 256 * 1_024
export const CTF_RANGE_ORDER_PREPARATION_PAGE_LIMIT_MAX = 256

const ID_LENGTH_MAX = 16_384
const SHORT_ID_LENGTH_MAX = 1_024
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IDENTITY_FIELDS = [
  'scopeId',
  'rangeOperationId',
  'sourceOperationId',
  'authorizationId',
  'clientOrderId',
  'orderRouteId',
  'normalizedMint',
  'conditionId',
  'unit',
  'tokenSide',
  'side',
  'priceSubunits',
  'amountSubunits',
  'minimumFillAmountSubunits',
  'divisibility',
  'authorizationExpiresAtUnixSeconds',
  'preparationBytes',
  'createdAtMs',
] as const
const RECORD_FIELDS = [
  ...IDENTITY_FIELDS,
  'lifecycleState',
  'revision',
  'capability',
  'updatedAtMs',
] as const
const CAPABILITY_FIELDS = ['artifactId', 'bindingDigest', 'artifactDigest', 'orderId'] as const

export type CtfRangeOrderPreparationLifecycle =
  | 'prepared'
  | 'capability-requested'
  | 'capability-bound'
  | 'order-submitted'
  | 'submission-rejected'
  | 'terminal'

export interface CtfRangeOrderPreparationCapability {
  readonly artifactId: string
  readonly bindingDigest: string
  readonly artifactDigest: string
  readonly orderId: string
}

export interface CtfRangeOrderPreparationIdentity {
  readonly scopeId: string
  readonly rangeOperationId: string
  readonly sourceOperationId: string
  readonly authorizationId: string
  readonly clientOrderId: string
  readonly orderRouteId: string
  readonly normalizedMint: string
  readonly conditionId: string
  readonly unit: 'msat'
  readonly tokenSide: 'Outcome' | 'Complement'
  readonly side: 'Buy' | 'Sell'
  readonly priceSubunits: number
  readonly amountSubunits: number
  readonly minimumFillAmountSubunits: number
  readonly divisibility: MarketDivisibility
  readonly authorizationExpiresAtUnixSeconds: number
  readonly preparationBytes: Uint8Array
  readonly createdAtMs: number
}

export interface CtfRangeOrderPreparationRecord extends CtfRangeOrderPreparationIdentity {
  readonly lifecycleState: CtfRangeOrderPreparationLifecycle
  readonly revision: number
  readonly capability: CtfRangeOrderPreparationCapability | null
  readonly updatedAtMs: number
}

export interface CtfRangeOrderPreparationPageCursor {
  readonly createdAtMs: number
  readonly rangeOperationId: string
}

export function encodeCtfRangeOrderPreparationArtifact(value: unknown): Uint8Array {
  return encodeBoundedDurableArtifact(value, CTF_RANGE_ORDER_PREPARATION_BYTES_MAX)
}

export function decodeCtfRangeOrderPreparationArtifact(bytes: Uint8Array): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > CTF_RANGE_ORDER_PREPARATION_BYTES_MAX
  ) {
    throw new Error('CTF range preparation bytes exceed their byte limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('CTF range preparation bytes are not canonical JSON')
  }
  if (!sameBytes(bytes, encodeCtfRangeOrderPreparationArtifact(parsed))) {
    throw new Error('CTF range preparation bytes are not canonical')
  }
  return parsed
}

export function decodeCtfRangeOrderPreparationIdentity(
  value: unknown,
): CtfRangeOrderPreparationIdentity {
  return decodeIdentityFields(exactRecord(value, IDENTITY_FIELDS, 'preparation identity'))
}

export function decodeCtfRangeOrderPreparationRecord(
  value: unknown,
): CtfRangeOrderPreparationRecord {
  const candidate = exactRecord(value, RECORD_FIELDS, 'preparation record')
  const identity = decodeIdentityFields(candidate)
  const lifecycleState = decodeCtfRangeOrderPreparationLifecycle(candidate.lifecycleState)
  const capability =
    candidate.capability === null
      ? null
      : decodeCtfRangeOrderPreparationCapability(candidate.capability)
  assertLifecycleCapability(lifecycleState, capability)
  const updatedAtMs = requireNonnegativeSafeInteger(candidate.updatedAtMs, 'updated time')
  if (updatedAtMs < identity.createdAtMs) {
    throw new Error('CTF range preparation updated time moved backward')
  }
  return {
    ...identity,
    lifecycleState,
    revision: requireNonnegativeSafeInteger(candidate.revision, 'revision'),
    capability,
    updatedAtMs,
  }
}

export function decodeCtfRangeOrderPreparationCapability(
  value: unknown,
): CtfRangeOrderPreparationCapability {
  const candidate = exactRecord(value, CAPABILITY_FIELDS, 'capability')
  const capability = {
    artifactId: requireText(candidate.artifactId, 'capability artifact id'),
    bindingDigest: requireText(candidate.bindingDigest, 'capability binding digest'),
    artifactDigest: requireText(candidate.artifactDigest, 'capability artifact digest'),
    orderId: requireText(candidate.orderId, 'engine order id'),
  }
  if (
    !UUID_PATTERN.test(capability.artifactId) ||
    !SHA256_PATTERN.test(capability.bindingDigest) ||
    !SHA256_PATTERN.test(capability.artifactDigest) ||
    !UUID_PATTERN.test(capability.orderId)
  ) {
    throw new Error('CTF range preparation capability authority is invalid')
  }
  return capability
}

export function decodeCtfRangeOrderPreparationLifecycle(
  value: unknown,
): CtfRangeOrderPreparationLifecycle {
  return requireClosed(
    value,
    [
      'prepared',
      'capability-requested',
      'capability-bound',
      'order-submitted',
      'submission-rejected',
      'terminal',
    ],
    'lifecycle state',
  )
}

export function assertCtfRangeOrderPreparationTransition(
  fromValue: CtfRangeOrderPreparationLifecycle,
  toValue: CtfRangeOrderPreparationLifecycle,
): void {
  const from = decodeCtfRangeOrderPreparationLifecycle(fromValue)
  const to = decodeCtfRangeOrderPreparationLifecycle(toValue)
  let legal: boolean
  switch (from) {
    case 'prepared':
      legal = to === 'capability-requested' || to === 'terminal'
      break
    case 'capability-requested':
      legal = to === 'terminal'
      break
    case 'capability-bound':
      legal = to === 'order-submitted' || to === 'submission-rejected' || to === 'terminal'
      break
    case 'order-submitted':
    case 'submission-rejected':
      legal = to === 'terminal'
      break
    case 'terminal':
      legal = false
      break
    default:
      return assertNever(from)
  }
  if (!legal) throw new Error('CTF range preparation lifecycle transition is invalid')
}

export function bindCtfRangeOrderPreparationCapability(input: {
  readonly current: CtfRangeOrderPreparationRecord
  readonly expectedRevision: number
  readonly capability: CtfRangeOrderPreparationCapability
  readonly updatedAtMs: number
}): CtfRangeOrderPreparationRecord {
  const current = decodeCtfRangeOrderPreparationRecord(input.current)
  const capability = decodeCtfRangeOrderPreparationCapability(input.capability)
  const expectedRevision = requireNonnegativeSafeInteger(input.expectedRevision, 'revision')
  const updatedAtMs = requireNonnegativeSafeInteger(input.updatedAtMs, 'updated time')
  if (current.lifecycleState !== 'capability-requested' || current.revision !== expectedRevision) {
    if (
      current.capability !== null &&
      sameCtfRangeOrderPreparationCapability(current.capability, capability)
    ) {
      return current
    }
    throw new Error('CTF range preparation revision or lifecycle changed')
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('CTF range preparation revision is exhausted')
  }
  return {
    ...current,
    lifecycleState: 'capability-bound',
    revision: current.revision + 1,
    capability,
    updatedAtMs: Math.max(updatedAtMs, current.updatedAtMs),
  }
}

export function sameCtfRangeOrderPreparationIdentity(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = decodeComparableIdentity(leftValue)
  const right = decodeComparableIdentity(rightValue)
  return (
    left.scopeId === right.scopeId &&
    left.rangeOperationId === right.rangeOperationId &&
    left.sourceOperationId === right.sourceOperationId &&
    left.authorizationId === right.authorizationId &&
    left.clientOrderId === right.clientOrderId &&
    left.orderRouteId === right.orderRouteId &&
    left.normalizedMint === right.normalizedMint &&
    left.conditionId === right.conditionId &&
    left.unit === right.unit &&
    left.tokenSide === right.tokenSide &&
    left.side === right.side &&
    left.priceSubunits === right.priceSubunits &&
    left.amountSubunits === right.amountSubunits &&
    left.minimumFillAmountSubunits === right.minimumFillAmountSubunits &&
    left.divisibility === right.divisibility &&
    left.authorizationExpiresAtUnixSeconds === right.authorizationExpiresAtUnixSeconds &&
    left.createdAtMs === right.createdAtMs &&
    sameBytes(left.preparationBytes, right.preparationBytes)
  )
}

function decodeComparableIdentity(value: unknown): CtfRangeOrderPreparationIdentity {
  return isRecord(value) && 'lifecycleState' in value
    ? decodeCtfRangeOrderPreparationRecord(value)
    : decodeCtfRangeOrderPreparationIdentity(value)
}

export function sameCtfRangeOrderPreparationCapability(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = decodeCtfRangeOrderPreparationCapability(leftValue)
  const right = decodeCtfRangeOrderPreparationCapability(rightValue)
  return (
    left.artifactId === right.artifactId &&
    left.bindingDigest === right.bindingDigest &&
    left.artifactDigest === right.artifactDigest &&
    left.orderId === right.orderId
  )
}

export function decodeCtfRangeOrderPreparationPageCursor(
  value: unknown,
): CtfRangeOrderPreparationPageCursor {
  let candidate: Record<string, unknown>
  try {
    candidate = exactRecord(value, ['createdAtMs', 'rangeOperationId'], 'page cursor')
    return {
      createdAtMs: requireNonnegativeSafeInteger(candidate.createdAtMs, 'page cursor time'),
      rangeOperationId: requireText(candidate.rangeOperationId, 'page cursor operation id'),
    }
  } catch {
    throw new Error('CTF range preparation page cursor is invalid')
  }
}

export function decodeCtfRangeOrderPreparationPageLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > CTF_RANGE_ORDER_PREPARATION_PAGE_LIMIT_MAX
  ) {
    throw new Error('CTF range preparation page limit is invalid')
  }
  return value
}

function decodeIdentityFields(
  candidate: Readonly<Record<string, unknown>>,
): CtfRangeOrderPreparationIdentity {
  const rangeOperationId = requireText(candidate.rangeOperationId, 'range operation id')
  const divisibility = requireDivisibility(candidate.divisibility)
  const priceSubunits = requirePositiveSafeInteger(candidate.priceSubunits, 'price')
  if (priceSubunits >= divisibility) {
    throw new Error('CTF range preparation price is outside its divisibility')
  }
  const conditionId = requireText(candidate.conditionId, 'condition id', SHORT_ID_LENGTH_MAX)
  const orderRouteId = requireText(candidate.orderRouteId, 'order route id', SHORT_ID_LENGTH_MAX)
  assertOrderRouteBelongsToCondition(orderRouteId, conditionId)
  const normalizedMint = decodeCanonicalMintOrigin(candidate.normalizedMint)
  const unit = requireExact(candidate.unit, 'msat', 'unit')
  const amountSubunits = requirePositiveSafeInteger(candidate.amountSubunits, 'amount')
  const minimumFillAmountSubunits = requirePositiveSafeInteger(
    candidate.minimumFillAmountSubunits,
    'minimum fill amount',
  )
  if (
    amountSubunits % divisibility !== 0 ||
    minimumFillAmountSubunits % divisibility !== 0 ||
    minimumFillAmountSubunits > amountSubunits
  ) {
    throw new Error('CTF range preparation amount policy is invalid')
  }
  const scopeId = requireText(candidate.scopeId, 'scope id')
  const scope = decodeDurableCustodyScopeInput(scopeId)
  if (
    scope.scopeKind === 'condition-inventory' &&
    (scope.conditionId !== conditionId ||
      scope.normalizedMint !== normalizedMint ||
      scope.unit !== unit)
  ) {
    throw new Error('CTF range preparation crosses its condition-inventory scope')
  }
  return {
    scopeId,
    rangeOperationId,
    sourceOperationId: requireText(candidate.sourceOperationId, 'source operation id'),
    authorizationId: requireText(candidate.authorizationId, 'authorization id'),
    clientOrderId: requireText(candidate.clientOrderId, 'client order id', SHORT_ID_LENGTH_MAX),
    orderRouteId,
    normalizedMint,
    conditionId,
    unit,
    tokenSide: requireClosed(candidate.tokenSide, ['Outcome', 'Complement'], 'token side'),
    side: requireClosed(candidate.side, ['Buy', 'Sell'], 'side'),
    priceSubunits,
    amountSubunits,
    minimumFillAmountSubunits,
    divisibility,
    authorizationExpiresAtUnixSeconds: requirePositiveSafeInteger(
      candidate.authorizationExpiresAtUnixSeconds,
      'authorization expiry',
    ),
    preparationBytes: requireCanonicalBytes(candidate.preparationBytes),
    createdAtMs: requireNonnegativeSafeInteger(candidate.createdAtMs, 'created time'),
  }
}

function assertLifecycleCapability(
  lifecycle: CtfRangeOrderPreparationLifecycle,
  capability: CtfRangeOrderPreparationCapability | null,
): void {
  switch (lifecycle) {
    case 'prepared':
    case 'capability-requested':
      if (capability !== null) {
        throw new Error('CTF range preparation lifecycle authority is invalid')
      }
      return
    case 'capability-bound':
    case 'order-submitted':
    case 'submission-rejected':
      if (capability === null) {
        throw new Error('CTF range preparation lifecycle authority is invalid')
      }
      return
    case 'terminal':
      return
    default:
      return assertNever(lifecycle)
  }
}

function exactRecord<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
  label: string,
): Readonly<Record<Fields[number], unknown>> {
  if (!isRecord(value)) throw new Error(`CTF range preparation ${label} is invalid`)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`CTF range preparation ${label} fields are invalid`)
  }
  return value as Readonly<Record<Fields[number], unknown>>
}

function requireCanonicalBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error('CTF range preparation body is invalid')
  }
  decodeCtfRangeOrderPreparationArtifact(value)
  return Uint8Array.from(value)
}

function requireText(value: unknown, label: string, maximum = ID_LENGTH_MAX): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`CTF range preparation ${label} is invalid`)
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const integer = requireNonnegativeSafeInteger(value, label)
  if (integer < 1) throw new Error(`CTF range preparation ${label} is invalid`)
  return integer
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`CTF range preparation ${label} is invalid`)
  }
  return value
}

function requireDivisibility(value: unknown): MarketDivisibility {
  const divisibility = parseMarketDivisibility(value)
  if (divisibility === null) {
    throw new Error('CTF range preparation divisibility is invalid')
  }
  return divisibility
}

function requireExact<const T extends string>(value: unknown, exact: T, label: string): T {
  if (value !== exact) throw new Error(`CTF range preparation ${label} is invalid`)
  return exact
}

function requireClosed<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`CTF range preparation ${label} is invalid`)
  }
  return value as T
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertNever(value: never): never {
  throw new Error(`unhandled CTF range preparation value: ${String(value)}`)
}
