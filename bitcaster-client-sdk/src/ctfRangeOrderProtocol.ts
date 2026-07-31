import {
  createPoolSettlementCapabilityArtifact,
  deriveSettlementCapabilityArtifactDigest,
  encodeSettlementCapabilityArtifact,
} from './settlementCapabilityArtifact.ts'
import {
  canonicalizeOutcomeSet,
  complementOutcomeSetId,
  parseMarketOutcomes,
} from './outcomeSets.ts'
import {
  decodeCtfRangeOrderPreparationArtifact,
  decodeCtfRangeOrderPreparationRecord,
  encodeCtfRangeOrderPreparationArtifact,
  type CtfRangeOrderPreparationCapability,
  type CtfRangeOrderPreparationRecord,
  type CtfRangeOrderPreparationSourceKind,
} from './ctfRangeOrderJournal.ts'
import { assertOrderRouteBelongsToCondition } from './orderRoute.ts'
import { decodeCanonicalMintOrigin } from './durableCustody.ts'
import type {
  DurableCtfRangeExpiryObservation,
  DurableCtfRangeKeysetResolver,
  DurableCtfRangeMintKeyset,
  DurableCtfRangeOperation,
} from './durableCtfRangeOperation.ts'
import type { ActiveCtfRangeMintKeyset } from './ctfRangeOrderPreparation.ts'
import { planCtfRangeOrderAuthorization } from './ctfRangeOrderAuthorization.ts'
import type { TokenImportKeysetLookup } from './tokenImportValidation.ts'
import {
  decodeSettlementOrderContinuationReference,
  type CreateSettlementCapabilityRequest,
  type SettlementCapabilityAdmissionPolicyResponse,
  type SettlementCapabilityResponse,
  type SettlementOrderContinuationReference,
} from './engineClient.ts'
import type { MarketDivisibility } from './marketUnits.ts'

const RANGE_REFUND_SAFETY_MARGIN_SECONDS = 300
const COORDINATOR_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PREPARATION_FIELDS = [
  'version',
  'operationId',
  'sourceOperationId',
  'sourceKind',
  'predecessorRangeOperationId',
  'authorizationId',
  'mintUrl',
  'conditionId',
  'coordinatorPublicKey',
  'side',
  'priceNumerator',
  'amountSubunits',
  'divisibility',
  'offerKeyset',
  'receiveKeyset',
  'expiryObservation',
  'expiry',
  'maxPoolEntries',
  'maxInputs',
  'request',
] as const
const REQUEST_FIELDS = [
  'clientOrderId',
  'marketId',
  'conditionId',
  'outcomeId',
  'tokenSide',
  'side',
  'price',
  'amountSubunits',
  'minimumFillAmountSubunits',
  'baseAsset',
  'collateralUnit',
  'divisibility',
  'timeInForce',
  'expiresAt',
  'mintUrl',
] as const
const ACTIVE_KEYSET_FIELDS = [
  'canonicalMintUrl',
  'id',
  'unit',
  'active',
  'keys',
  'inputFeePpk',
  'finalExpiry',
] as const
const CONDITIONAL_KEYSET_FIELDS = [
  ...ACTIVE_KEYSET_FIELDS,
  'conditionId',
  'outcomeCollection',
  'outcomeCollectionId',
] as const
const EXPIRY_OBSERVATION_FIELDS = [
  'canonicalMintUrl',
  'freshness',
  'observedAt',
  'maxExpirySeconds',
  'conditionKeysetIds',
  'conditionalKeysets',
] as const
const OBSERVED_CONDITIONAL_KEYSET_FIELDS = [
  'keysetId',
  'conditionId',
  'unit',
  'inputFeePpk',
  'outcomeCollectionId',
  'keys',
] as const

export interface CtfRangeOrderRequest {
  readonly clientOrderId: string
  readonly marketId: string
  readonly conditionId: string
  readonly outcomeId: string
  readonly tokenSide: 'Outcome' | 'Complement'
  readonly side: 'Buy' | 'Sell'
  readonly price: number
  readonly amountSubunits: number
  readonly minimumFillAmountSubunits: number
  readonly baseAsset: 'sat'
  readonly collateralUnit: 'msat'
  readonly divisibility: MarketDivisibility
  readonly timeInForce: 'FAK' | 'FOK' | 'GTC' | 'GTD'
  readonly expiresAt: string | null
  readonly mintUrl: string
}

export interface CtfRangeConditionalMintKeyset extends ActiveCtfRangeMintKeyset {
  readonly conditionId: string
  readonly outcomeCollection: string
  readonly outcomeCollectionId: string
}

export interface CtfRangeReviewedMintFacts {
  readonly regular: readonly ActiveCtfRangeMintKeyset[]
  readonly conditional: readonly CtfRangeConditionalMintKeyset[]
  readonly maxInputs: number
  readonly maxPoolEntries: number
  readonly observation: DurableCtfRangeExpiryObservation
}

export interface PersistedCtfRangeOrderPreparation {
  readonly version: 1
  readonly operationId: string
  readonly sourceOperationId: string
  readonly sourceKind: CtfRangeOrderPreparationSourceKind
  readonly predecessorRangeOperationId: string | null
  readonly authorizationId: string
  readonly mintUrl: string
  readonly conditionId: string
  readonly coordinatorPublicKey: string
  readonly side: 'Buy' | 'Sell'
  readonly priceNumerator: number
  readonly amountSubunits: number
  readonly divisibility: MarketDivisibility
  readonly offerKeyset: ActiveCtfRangeMintKeyset
  readonly receiveKeyset: ActiveCtfRangeMintKeyset
  readonly expiryObservation: DurableCtfRangeExpiryObservation
  readonly expiry: number
  readonly maxPoolEntries: number
  readonly maxInputs: number
  readonly request: CtfRangeOrderRequest
}

export function buildPersistedCtfRangeOrderPreparation(input: {
  readonly request: CtfRangeOrderRequest
  readonly coordinatorPublicKey: string
  readonly mintFacts: CtfRangeReviewedMintFacts
  readonly market: unknown
  readonly nowUnixSeconds: number
  readonly randomId: () => string
  readonly authorizationAmountSubunits?: number
  readonly sourceKind?: CtfRangeOrderPreparationSourceKind
  readonly predecessorRangeOperationId?: string | null
}): PersistedCtfRangeOrderPreparation {
  const request = decodeCtfRangeOrderRequest(input.request)
  const coordinatorPublicKey = decodeCoordinatorPublicKey(input.coordinatorPublicKey)
  const selectedCollection = selectedOutcomeCollection(input.market, request)
  const { regular, conditional } = selectPreparationKeysets(
    input.mintFacts,
    request.conditionId,
    selectedCollection,
  )
  const nowUnixSeconds = requireNonnegativeSafeInteger(
    input.nowUnixSeconds,
    'range preparation current time',
  )
  const expiry = derivePreparationExpiry(input.mintFacts.observation, nowUnixSeconds, request)
  const operationId = requireText(input.randomId(), 'range preparation operation id')
  const sourceKind = input.sourceKind ?? 'wallet-prepared'
  return decodePersistedCtfRangeOrderPreparation({
    version: 1,
    operationId,
    sourceOperationId: `${operationId}:source`,
    sourceKind,
    predecessorRangeOperationId: input.predecessorRangeOperationId ?? null,
    authorizationId: requireText(input.randomId(), 'range preparation authorization id'),
    mintUrl: input.mintFacts.observation.canonicalMintUrl,
    conditionId: request.conditionId,
    coordinatorPublicKey,
    side: request.side,
    priceNumerator: request.price,
    amountSubunits: input.authorizationAmountSubunits ?? request.amountSubunits,
    divisibility: request.divisibility,
    offerKeyset: request.side === 'Buy' ? regular : conditional,
    receiveKeyset: request.side === 'Buy' ? conditional : regular,
    expiryObservation: input.mintFacts.observation,
    expiry,
    maxPoolEntries: input.mintFacts.maxPoolEntries,
    maxInputs: input.mintFacts.maxInputs,
    request,
  })
}

export function encodePersistedCtfRangeOrderPreparation(
  input: PersistedCtfRangeOrderPreparation,
): Uint8Array {
  return encodeCtfRangeOrderPreparationArtifact(decodePersistedCtfRangeOrderPreparation(input))
}

export function decodePersistedCtfRangeOrderPreparation(
  value: unknown,
): PersistedCtfRangeOrderPreparation {
  const input = exactRecord(value, PREPARATION_FIELDS, 'range preparation input')
  const request = decodeCtfRangeOrderRequest(input.request)
  const sourceKind = requireClosed(
    input.sourceKind,
    ['wallet-prepared', 'residual-change'],
    'range preparation source kind',
  )
  const operationId = requireText(input.operationId, 'range preparation operation id')
  const predecessorRangeOperationId = optionalText(
    input.predecessorRangeOperationId,
    'range preparation predecessor operation id',
  )
  assertSourceLineage(sourceKind, operationId, predecessorRangeOperationId)
  const mintUrl = decodeCanonicalMintOrigin(input.mintUrl)
  const conditionId = requireText(input.conditionId, 'range preparation condition id')
  const offerKeyset = decodeActiveKeyset(input.offerKeyset, mintUrl)
  const receiveKeyset = decodeActiveKeyset(input.receiveKeyset, mintUrl)
  const preparation: PersistedCtfRangeOrderPreparation = {
    version: requireExact(input.version, 1, 'range preparation version'),
    operationId,
    sourceOperationId: requireText(
      input.sourceOperationId,
      'range preparation source operation id',
    ),
    sourceKind,
    predecessorRangeOperationId,
    authorizationId: requireText(input.authorizationId, 'range preparation authorization id'),
    mintUrl,
    conditionId,
    coordinatorPublicKey: decodeCoordinatorPublicKey(input.coordinatorPublicKey),
    side: requireClosed(input.side, ['Buy', 'Sell'], 'range preparation side'),
    priceNumerator: requirePositiveSafeInteger(input.priceNumerator, 'range preparation price'),
    amountSubunits: requirePositiveSafeInteger(input.amountSubunits, 'range preparation amount'),
    divisibility: requireDivisibility(input.divisibility),
    offerKeyset,
    receiveKeyset,
    expiryObservation: decodeExpiryObservation(input.expiryObservation, mintUrl, conditionId),
    expiry: requirePositiveSafeInteger(input.expiry, 'range preparation expiry'),
    maxPoolEntries: requirePositiveSafeInteger(
      input.maxPoolEntries,
      'range preparation pool limit',
    ),
    maxInputs: requirePositiveSafeInteger(input.maxInputs, 'range preparation input limit'),
    request,
  }
  assertPreparationConsistency(preparation)
  return preparation
}

export function decodePersistedCtfRangeOrderPreparationBytes(
  bytes: Uint8Array,
): PersistedCtfRangeOrderPreparation {
  return decodePersistedCtfRangeOrderPreparation(decodeCtfRangeOrderPreparationArtifact(bytes))
}

export function decodeCtfRangeOrderPreparationFromRecord(
  recordValue: CtfRangeOrderPreparationRecord,
  expectedRequest?: CtfRangeOrderRequest,
): PersistedCtfRangeOrderPreparation {
  const record = decodeCtfRangeOrderPreparationRecord(recordValue)
  const input = decodePersistedCtfRangeOrderPreparationBytes(record.preparationBytes)
  const expected =
    expectedRequest === undefined ? undefined : decodeCtfRangeOrderRequest(expectedRequest)
  if (!recordMatchesPreparation(record, input) || !requestMatches(input.request, expected)) {
    throw new Error(`Range operation ${record.rangeOperationId} preparation is foreign`)
  }
  return input
}

export function decodeSettlementCoordinatorPublicKey(
  policy: SettlementCapabilityAdmissionPolicyResponse,
): string {
  return decodeCoordinatorPublicKey(policy.coordinatorPubkey)
}

export function createCtfRangeSettlementCapabilityRequest(
  preparationValue: PersistedCtfRangeOrderPreparation,
  operation: DurableCtfRangeOperation,
  continuation: SettlementOrderContinuationReference | null = null,
): CreateSettlementCapabilityRequest {
  const preparation = decodePersistedCtfRangeOrderPreparation(preparationValue)
  const request = preparation.request
  assertOperationMatchesPreparation(operation, preparation)
  const artifact = createPoolSettlementCapabilityArtifact(operation)
  const continuationReference =
    continuation === null ? null : decodeSettlementOrderContinuationReference(continuation)
  return {
    stageIdempotencyKey: operation.authorizationId,
    clientOrderId: request.clientOrderId,
    marketId: request.marketId,
    orderIntent: {
      outcomeId: request.outcomeId,
      tokenSide: request.tokenSide,
      side: request.side,
      price: request.price,
      amountSubunits: request.amountSubunits,
      minimumFillAmountSubunits: request.minimumFillAmountSubunits,
      baseAsset: request.baseAsset,
      collateralUnit: request.collateralUnit,
      timeInForce: request.timeInForce,
      expiresAt: request.expiresAt,
    },
    continuation: continuationReference,
    artifact: bytesToBase64(encodeSettlementCapabilityArtifact(artifact)),
  }
}

export function validateAndProjectCtfRangeSettlementCapabilityResponse(input: {
  readonly capability: SettlementCapabilityResponse
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly operation: DurableCtfRangeOperation
  readonly recovering: boolean
}): CtfRangeOrderPreparationCapability {
  const preparation = decodePersistedCtfRangeOrderPreparation(input.preparation)
  const request = preparation.request
  assertOperationMatchesPreparation(input.operation, preparation)
  const expectedDigest = deriveSettlementCapabilityArtifactDigest(
    createPoolSettlementCapabilityArtifact(input.operation),
  )
  const validState =
    input.capability.state === 'bound' ||
    (input.recovering &&
      (input.capability.state === 'selected' ||
        input.capability.state === 'uncertain' ||
        input.capability.state === 'terminal'))
  if (
    input.capability.clientOrderId !== request.clientOrderId ||
    input.capability.marketId !== request.marketId ||
    input.capability.artifactDigest !== expectedDigest ||
    !validState ||
    !UUID_PATTERN.test(input.capability.orderId) ||
    !UUID_PATTERN.test(input.capability.reference?.artifactId ?? '') ||
    !SHA256_PATTERN.test(input.capability.reference?.bindingDigest ?? '') ||
    !Number.isSafeInteger(input.capability.version) ||
    input.capability.version < 1 ||
    !isIsoDateTime(input.capability.authorizationExpiresAt) ||
    !isIsoDateTime(input.capability.stageExpiresAt)
  ) {
    throw new Error('engine returned a foreign settlement capability')
  }
  return {
    artifactId: input.capability.reference.artifactId,
    bindingDigest: input.capability.reference.bindingDigest,
    artifactDigest: input.capability.artifactDigest,
    orderId: input.capability.orderId,
  }
}

export function ctfRangeOrderPreparationKeysetLookup(
  input: PersistedCtfRangeOrderPreparation,
): TokenImportKeysetLookup {
  const preparation = decodePersistedCtfRangeOrderPreparation(input)
  const keysets = [preparation.offerKeyset, preparation.receiveKeyset]
  const regularKeysets = keysets
    .filter((keyset) => !hasConditionalMetadata(keyset))
    .map(preparationKeysetMetadata)
  const conditionalKeysets = keysets.filter(hasConditionalMetadata).map((keyset) => ({
    ...preparationKeysetMetadata(keyset),
    conditionId: keyset.conditionId,
    outcomeCollection: keyset.outcomeCollection,
    outcomeCollectionId: keyset.outcomeCollectionId,
  }))
  if (regularKeysets.length !== 1 || conditionalKeysets.length !== 1) {
    throw new Error('range preparation keyset source authority is incomplete')
  }
  return {
    canonicalMintUrl: preparation.mintUrl,
    freshness: 'fresh',
    regularKeysets,
    conditionalKeysets,
  }
}

export function exactCtfRangeOrderPreparationMintKeysets(
  input: PersistedCtfRangeOrderPreparation,
): ReadonlyMap<string, DurableCtfRangeMintKeyset> {
  const preparation = decodePersistedCtfRangeOrderPreparation(input)
  return new Map(
    [preparation.offerKeyset, preparation.receiveKeyset].map((keyset) => [
      keyset.id,
      durableMintKeyset(keyset),
    ]),
  )
}

export function createCtfRangeOrderPreparationKeysetResolver(
  input: PersistedCtfRangeOrderPreparation,
): DurableCtfRangeKeysetResolver {
  const preparation = decodePersistedCtfRangeOrderPreparation(input)
  const keysets = exactCtfRangeOrderPreparationMintKeysets(preparation)
  return (mintUrl, keysetId) =>
    mintUrl === preparation.mintUrl ? keysets.get(keysetId) : undefined
}

function decodeCtfRangeOrderRequest(value: unknown): CtfRangeOrderRequest {
  const request = exactRecord(value, REQUEST_FIELDS, 'range preparation request')
  const conditionId = requireText(request.conditionId, 'range preparation request condition id')
  const marketId = requireText(request.marketId, 'range preparation request market id')
  assertOrderRouteBelongsToCondition(marketId, conditionId)
  const divisibility = requireDivisibility(request.divisibility)
  const price = requirePositiveSafeInteger(request.price, 'range preparation request price')
  if (price >= divisibility) throw new Error('range preparation request price is invalid')
  const amountSubunits = requirePositiveSafeInteger(
    request.amountSubunits,
    'range preparation request amount',
  )
  const minimumFillAmountSubunits = requirePositiveSafeInteger(
    request.minimumFillAmountSubunits,
    'range preparation request minimum fill amount',
  )
  if (
    amountSubunits % divisibility !== 0 ||
    minimumFillAmountSubunits % divisibility !== 0 ||
    minimumFillAmountSubunits > amountSubunits
  ) {
    throw new Error('range preparation request fill amount is invalid')
  }
  const timeInForce = requireClosed(
    request.timeInForce,
    ['FAK', 'FOK', 'GTC', 'GTD'],
    'range preparation request time in force',
  )
  const expiresAt = decodeOrderExpiry(request.expiresAt, timeInForce)
  return {
    clientOrderId: requireText(request.clientOrderId, 'range preparation request client order id'),
    marketId,
    conditionId,
    outcomeId: requireText(request.outcomeId, 'range preparation request outcome id'),
    tokenSide: requireClosed(
      request.tokenSide,
      ['Outcome', 'Complement'],
      'range preparation request token side',
    ),
    side: requireClosed(request.side, ['Buy', 'Sell'], 'range preparation request side'),
    price,
    amountSubunits,
    minimumFillAmountSubunits,
    baseAsset: requireExact(request.baseAsset, 'sat', 'range preparation request base asset'),
    collateralUnit: requireExact(
      request.collateralUnit,
      'msat',
      'range preparation request collateral unit',
    ),
    divisibility,
    timeInForce,
    expiresAt,
    mintUrl: decodeCanonicalMintOrigin(request.mintUrl),
  }
}

function selectPreparationKeysets(
  facts: CtfRangeReviewedMintFacts,
  conditionId: string,
  selectedCollection: string,
): { regular: ActiveCtfRangeMintKeyset; conditional: CtfRangeConditionalMintKeyset } {
  const regular = [...facts.regular].sort(compareKeysetPreference)[0]
  const conditional = facts.conditional.find(
    (keyset) =>
      keyset.conditionId === conditionId &&
      keyset.outcomeCollection === selectedCollection &&
      keyset.active,
  )
  if (regular === undefined || conditional === undefined) {
    throw new Error('mint does not expose the selected active range keysets')
  }
  return { regular, conditional }
}

function compareKeysetPreference(
  left: ActiveCtfRangeMintKeyset,
  right: ActiveCtfRangeMintKeyset,
): number {
  return (
    left.inputFeePpk - right.inputFeePpk ||
    (right.finalExpiry ?? Number.MAX_SAFE_INTEGER) -
      (left.finalExpiry ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  )
}

function derivePreparationExpiry(
  observation: DurableCtfRangeExpiryObservation,
  nowUnixSeconds: number,
  request: CtfRangeOrderRequest,
): number {
  const fallback = observation.observedAt + observation.maxExpirySeconds
  if (!Number.isSafeInteger(fallback)) {
    throw new Error('mint settlement expiry ceiling exceeds the safe integer range')
  }
  const ceiling = observation.conditionalKeysets.reduce((current, keyset) => {
    const finalExpiry = keyset.finalExpiry
    return finalExpiry === undefined
      ? current
      : Math.min(current, requirePositiveSafeInteger(finalExpiry, 'condition keyset final expiry'))
  }, fallback)
  const mintExpiry = ceiling - RANGE_REFUND_SAFETY_MARGIN_SECONDS
  const orderExpiry =
    request.timeInForce === 'GTD'
      ? Math.floor(Date.parse(requireGtdExpiry(request.expiresAt)) / 1_000)
      : Number.MAX_SAFE_INTEGER
  if (request.timeInForce === 'GTD' && orderExpiry <= nowUnixSeconds) {
    throw new Error('GTD order expiry horizon is exhausted')
  }
  const expiry = Math.min(mintExpiry, orderExpiry)
  if (expiry <= nowUnixSeconds) {
    throw new Error('mint CTF range authorization horizon is exhausted')
  }
  return expiry
}

function decodeOrderExpiry(
  value: unknown,
  timeInForce: CtfRangeOrderRequest['timeInForce'],
): string | null {
  if (timeInForce === 'GTD') return requireGtdExpiry(value)
  return requireExact(value, null, 'range preparation request expiry')
}

function requireGtdExpiry(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('range preparation GTD order expiry is invalid')
  }
  return value
}

function selectedOutcomeCollection(market: unknown, request: CtfRangeOrderRequest): string {
  const outcomes = parseMarketOutcomes(market)
  if (outcomes.length < 2) throw new Error('engine market outcome authority is incomplete')
  const route = assertOrderRouteBelongsToCondition(request.marketId, request.conditionId)
  const selected = outcomes.filter(
    (outcome) => outcome.id === request.outcomeId || outcome.label === request.outcomeId,
  )
  if (selected.length !== 1 || selected[0]?.label !== route.outcomeId) {
    throw new Error('selected outcome does not match the exact engine order route')
  }
  const primitive = canonicalizeOutcomeSet([selected[0].label])
  return request.tokenSide === 'Outcome'
    ? primitive
    : complementOutcomeSetId(
        outcomes.map(({ label }) => label),
        primitive,
      )
}

function recordMatchesPreparation(
  record: CtfRangeOrderPreparationRecord,
  input: PersistedCtfRangeOrderPreparation,
): boolean {
  return (
    input.operationId === record.rangeOperationId &&
    input.sourceOperationId === record.sourceOperationId &&
    input.sourceKind === record.sourceKind &&
    input.predecessorRangeOperationId === record.predecessorRangeOperationId &&
    input.authorizationId === record.authorizationId &&
    input.request.clientOrderId === record.clientOrderId &&
    input.request.marketId === record.orderRouteId &&
    input.mintUrl === record.normalizedMint &&
    input.request.mintUrl === record.normalizedMint &&
    input.conditionId === record.conditionId &&
    input.request.conditionId === input.conditionId &&
    input.request.tokenSide === record.tokenSide &&
    input.side === record.side &&
    input.request.side === record.side &&
    input.priceNumerator === record.priceSubunits &&
    input.request.price === record.priceSubunits &&
    input.amountSubunits === record.amountSubunits &&
    sourceAmountMatchesRecord(input, record.amountSubunits) &&
    input.request.minimumFillAmountSubunits === record.minimumFillAmountSubunits &&
    input.divisibility === record.divisibility &&
    input.request.divisibility === record.divisibility &&
    input.expiry === record.authorizationExpiresAtUnixSeconds
  )
}

function sourceAmountMatchesRecord(
  input: PersistedCtfRangeOrderPreparation,
  recordAmount: number,
): boolean {
  return input.sourceKind === 'wallet-prepared'
    ? input.request.amountSubunits === recordAmount
    : input.request.amountSubunits >= recordAmount
}

function requestMatches(
  actual: CtfRangeOrderRequest,
  expected: CtfRangeOrderRequest | undefined,
): boolean {
  if (expected === undefined) return true
  return sameBytes(
    encodeCtfRangeOrderPreparationArtifact(actual),
    encodeCtfRangeOrderPreparationArtifact(expected),
  )
}

function decodeActiveKeyset(
  value: unknown,
  mintUrl: string,
): ActiveCtfRangeMintKeyset | CtfRangeConditionalMintKeyset {
  const candidate = requireRecord(value, 'range preparation keyset')
  const keyset = exactRecord(
    value,
    hasAnyConditionalMetadata(candidate) ? CONDITIONAL_KEYSET_FIELDS : ACTIVE_KEYSET_FIELDS,
    'range preparation keyset',
  )
  const canonicalMintUrl = decodeCanonicalMintOrigin(keyset.canonicalMintUrl)
  if (
    keyset.active !== true ||
    keyset.unit !== 'msat' ||
    canonicalMintUrl !== mintUrl ||
    (keyset.finalExpiry !== null &&
      (!Number.isSafeInteger(keyset.finalExpiry) || (keyset.finalExpiry as number) <= 0))
  ) {
    throw new Error('range preparation keyset is invalid')
  }
  const keys = decodeKeysetKeys(keyset.keys)
  const base = {
    canonicalMintUrl,
    id: requireText(keyset.id, 'range preparation keyset id'),
    unit: 'msat' as const,
    keys,
    inputFeePpk: requirePositiveSafeInteger(
      keyset.inputFeePpk,
      'range preparation keyset input fee',
    ),
    finalExpiry: keyset.finalExpiry as number | null,
    active: true as const,
  }
  if (hasAnyConditionalMetadata(keyset) && !hasConditionalMetadata(keyset)) {
    throw new Error('range preparation keyset conditional authority is incomplete')
  }
  if (!hasConditionalMetadata(keyset)) return base
  return {
    ...base,
    conditionId: keyset.conditionId,
    outcomeCollection: keyset.outcomeCollection,
    outcomeCollectionId: keyset.outcomeCollectionId,
  }
}

function decodeExpiryObservation(
  value: unknown,
  mintUrl: string,
  conditionId: string,
): DurableCtfRangeExpiryObservation {
  const observation = exactRecord(
    value,
    EXPIRY_OBSERVATION_FIELDS,
    'range preparation expiry observation',
  )
  const canonicalMintUrl = decodeCanonicalMintOrigin(observation.canonicalMintUrl)
  if (canonicalMintUrl !== mintUrl || observation.freshness !== 'fresh') {
    throw new Error('range preparation expiry observation is invalid')
  }
  const conditionKeysetIds = requireTextArray(
    observation.conditionKeysetIds,
    'range preparation condition keyset ids',
  )
  const conditionalKeysets = requireArray(
    observation.conditionalKeysets,
    'range preparation conditional keysets',
  ).map((keyset) => decodeObservedConditionalKeyset(keyset, conditionId))
  if (conditionKeysetIds.length === 0 || conditionalKeysets.length === 0) {
    throw new Error('range preparation expiry observation is invalid')
  }
  return {
    canonicalMintUrl,
    freshness: 'fresh',
    observedAt: requireNonnegativeSafeInteger(
      observation.observedAt,
      'range preparation observation time',
    ),
    maxExpirySeconds: requirePositiveSafeInteger(
      observation.maxExpirySeconds,
      'range preparation maximum expiry',
    ),
    conditionKeysetIds,
    conditionalKeysets,
  }
}

function decodeObservedConditionalKeyset(
  value: unknown,
  conditionId: string,
): DurableCtfRangeExpiryObservation['conditionalKeysets'][number] {
  const candidate = requireRecord(value, 'range preparation observed conditional keyset')
  const keyset = exactRecord(
    value,
    candidate.finalExpiry === undefined
      ? OBSERVED_CONDITIONAL_KEYSET_FIELDS
      : [...OBSERVED_CONDITIONAL_KEYSET_FIELDS, 'finalExpiry'],
    'range preparation observed conditional keyset',
  )
  const observedConditionId = requireText(
    keyset.conditionId,
    'range preparation observed condition id',
  )
  if (observedConditionId !== conditionId || keyset.unit !== 'msat') {
    throw new Error('range preparation expiry observation is invalid')
  }
  const finalExpiry =
    keyset.finalExpiry === undefined
      ? undefined
      : requirePositiveSafeInteger(keyset.finalExpiry, 'range preparation observed final expiry')
  return {
    keysetId: requireText(keyset.keysetId, 'range preparation observed keyset id'),
    conditionId: observedConditionId,
    unit: 'msat',
    inputFeePpk: requirePositiveSafeInteger(
      keyset.inputFeePpk,
      'range preparation observed input fee',
    ),
    ...(finalExpiry === undefined ? {} : { finalExpiry }),
    outcomeCollectionId: requireText(
      keyset.outcomeCollectionId,
      'range preparation observed collection id',
    ),
    keys: decodeKeysetKeys(keyset.keys),
  }
}

function decodeKeysetKeys(value: unknown): Record<string, string> {
  const keys = requireRecord(value, 'range preparation keyset keys')
  if (
    Object.keys(keys).length === 0 ||
    Object.entries(keys).some(
      ([amount, publicKey]) => !/^[1-9][0-9]*$/.test(amount) || typeof publicKey !== 'string',
    )
  ) {
    throw new Error('range preparation keyset keys are invalid')
  }
  return { ...(keys as Record<string, string>) }
}

function assertSourceLineage(
  sourceKind: CtfRangeOrderPreparationSourceKind,
  operationId: string,
  predecessorRangeOperationId: string | null,
): void {
  if (
    (sourceKind === 'wallet-prepared' && predecessorRangeOperationId !== null) ||
    (sourceKind === 'residual-change' &&
      (predecessorRangeOperationId === null || predecessorRangeOperationId === operationId))
  ) {
    throw new Error('range preparation predecessor authority is invalid')
  }
}

function assertPreparationConsistency(input: PersistedCtfRangeOrderPreparation): void {
  const offerIsConditional = hasConditionalMetadata(input.offerKeyset)
  const receiveIsConditional = hasConditionalMetadata(input.receiveKeyset)
  const conditional = offerIsConditional
    ? input.offerKeyset
    : receiveIsConditional
      ? input.receiveKeyset
      : null
  if (
    input.conditionId !== input.request.conditionId ||
    input.mintUrl !== input.request.mintUrl ||
    input.side !== input.request.side ||
    input.priceNumerator !== input.request.price ||
    input.divisibility !== input.request.divisibility ||
    !sourceAmountIsConsistent(input) ||
    input.priceNumerator >= input.divisibility ||
    input.offerKeyset.id === input.receiveKeyset.id ||
    offerIsConditional === receiveIsConditional ||
    conditional === null ||
    conditional.conditionId !== input.conditionId ||
    (input.side === 'Buy' && offerIsConditional) ||
    (input.side === 'Sell' && !offerIsConditional) ||
    input.expiry <= input.expiryObservation.observedAt
  ) {
    throw new Error('range preparation authority is inconsistent')
  }
}

function sourceAmountIsConsistent(input: PersistedCtfRangeOrderPreparation): boolean {
  return input.sourceKind === 'wallet-prepared'
    ? input.amountSubunits === input.request.amountSubunits
    : input.amountSubunits <= input.request.amountSubunits
}

function assertOperationMatchesPreparation(
  operation: DurableCtfRangeOperation,
  preparation: PersistedCtfRangeOrderPreparation,
): void {
  const request = preparation.request
  const expectedPolicy = planCtfRangeOrderAuthorization({
    side: preparation.side,
    priceNumerator: preparation.priceNumerator,
    amountSubunits: preparation.amountSubunits,
    divisibility: preparation.divisibility,
    inputFeePpk: preparation.offerKeyset.inputFeePpk,
    offerKeysetKeys: preparation.offerKeyset.keys,
    maxPoolEntries: preparation.maxPoolEntries,
    maxInputs: preparation.maxInputs,
  }).policy
  if (
    operation.operationId !== preparation.operationId ||
    operation.sourceOperationId !== preparation.sourceOperationId ||
    operation.authorizationId !== preparation.authorizationId ||
    operation.conditionId !== request.conditionId ||
    operation.mintUrl !== request.mintUrl ||
    operation.unit !== request.collateralUnit ||
    operation.parentCollectionId !== '0'.repeat(64) ||
    operation.coordinatorPublicKey !== preparation.coordinatorPublicKey ||
    operation.offerKeysetId !== preparation.offerKeyset.id ||
    operation.receiveKeysetId !== preparation.receiveKeyset.id ||
    operation.expiry !== preparation.expiry ||
    operation.policy.rateN !== expectedPolicy.rateN ||
    operation.policy.rateD !== expectedPolicy.rateD ||
    operation.policy.minReceive !== expectedPolicy.minReceive ||
    operation.policy.maxDebit !== expectedPolicy.maxDebit ||
    Object.keys(operation.inputFeePpkByKeyset).length !== 1 ||
    operation.inputFeePpkByKeyset[preparation.offerKeyset.id] !==
      preparation.offerKeyset.inputFeePpk ||
    !operationAssetsMatchPreparation(operation, preparation)
  ) {
    throw new Error('range operation is foreign to its persisted order preparation')
  }
}

function operationAssetsMatchPreparation(
  operation: DurableCtfRangeOperation,
  preparation: PersistedCtfRangeOrderPreparation,
): boolean {
  const conditional =
    preparation.side === 'Buy' ? preparation.receiveKeyset : preparation.offerKeyset
  if (!hasConditionalMetadata(conditional)) return false
  const regularAsset = { kind: 'regular' as const, unit: 'msat' as const }
  const conditionalAsset = {
    kind: 'conditional' as const,
    unit: 'msat' as const,
    conditionId: conditional.conditionId,
    outcomeCollection: conditional.outcomeCollection,
  }
  const expectedOffer = preparation.side === 'Buy' ? regularAsset : conditionalAsset
  const expectedReceive = preparation.side === 'Buy' ? conditionalAsset : regularAsset
  return (
    assetMatches(operation.offerAsset, expectedOffer) &&
    assetMatches(operation.receiveAsset, expectedReceive)
  )
}

function assetMatches(
  actual: DurableCtfRangeOperation['offerAsset'],
  expected:
    | { readonly kind: 'regular'; readonly unit: 'msat' }
    | {
        readonly kind: 'conditional'
        readonly unit: 'msat'
        readonly conditionId: string
        readonly outcomeCollection: string
      },
): boolean {
  return actual.kind === 'regular' && expected.kind === 'regular'
    ? actual.unit === expected.unit
    : actual.kind === 'conditional' && expected.kind === 'conditional'
      ? actual.unit === expected.unit &&
        actual.conditionId === expected.conditionId &&
        actual.outcomeCollection === expected.outcomeCollection
      : false
}

function preparationKeysetMetadata(keyset: ActiveCtfRangeMintKeyset) {
  return {
    keysetId: keyset.id,
    unit: keyset.unit,
    active: keyset.active,
    inputFeePpk: keyset.inputFeePpk,
    ...(keyset.finalExpiry === null ? {} : { finalExpiry: keyset.finalExpiry }),
  }
}

function hasConditionalMetadata(value: unknown): value is ActiveCtfRangeMintKeyset & {
  conditionId: string
  outcomeCollection: string
  outcomeCollectionId: string
} {
  if (value === null || typeof value !== 'object') return false
  const keyset = value as Record<string, unknown>
  return (
    typeof keyset.conditionId === 'string' &&
    keyset.conditionId.length > 0 &&
    typeof keyset.outcomeCollection === 'string' &&
    keyset.outcomeCollection.length > 0 &&
    typeof keyset.outcomeCollectionId === 'string' &&
    keyset.outcomeCollectionId.length > 0
  )
}

function hasAnyConditionalMetadata(value: Record<string, unknown>): boolean {
  return 'conditionId' in value || 'outcomeCollection' in value || 'outcomeCollectionId' in value
}

function durableMintKeyset(keyset: ActiveCtfRangeMintKeyset): DurableCtfRangeMintKeyset {
  const { active: _, ...durable } = keyset
  return durable
}

function decodeCoordinatorPublicKey(value: unknown): string {
  const key = requireText(value, 'coordinator public key').toLowerCase()
  if (!COORDINATOR_PUBLIC_KEY_PATTERN.test(key)) {
    throw new Error('coordinator public key is invalid')
  }
  return key
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactRecord<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
  label: string,
): Readonly<Record<Fields[number], unknown>> {
  const record = requireRecord(value, label)
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} fields are invalid`)
  }
  return record as Readonly<Record<Fields[number], unknown>>
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value
}

function requireTextArray(value: unknown, label: string): string[] {
  const entries = requireArray(value, label)
  if (entries.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`${label} is invalid`)
  }
  return [...entries] as string[]
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`)
  return value
}

function optionalText(value: unknown, label: string): string | null {
  return value === null ? null : requireText(value, label)
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const integer = requireNonnegativeSafeInteger(value, label)
  if (integer === 0) throw new Error(`${label} is invalid`)
  return integer
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireDivisibility(value: unknown): MarketDivisibility {
  if (value !== 10_000 && value !== 1_000_000) {
    throw new Error('range preparation divisibility is invalid')
  }
  return value
}

function requireClosed<const T extends string>(
  value: unknown,
  accepted: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !accepted.includes(value as T)) {
    throw new Error(`${label} is invalid`)
  }
  return value as T
}

function requireExact<const T>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} is invalid`)
  return expected
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((value, index) => value === right[index])
}
