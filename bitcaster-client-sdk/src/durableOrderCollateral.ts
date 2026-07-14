import { decodeDurableCustodyScopeId } from './durableCustody.ts'

export const DURABLE_ORDER_COLLATERAL_SCHEMA_VERSION = 1 as const
export const DURABLE_ORDER_COLLATERAL_PROOF_LIMIT_MAX = 256

export type DurableOrderCollateralAsset =
  | { kind: 'base' }
  | { kind: 'outcome'; conditionId: string; outcomeSetId: string }

export interface DurableOrderCollateralProof {
  proofId: string
  keysetId: string
  amount: number
  asset: DurableOrderCollateralAsset
}

export type DurableOrderCollateralReleaseReason =
  | 'pre-submit-rejected'
  | 'filled'
  | 'cancelled'
  | 'failed'
  | 'expired'

export interface DurableOrderSubmissionRequest {
  clientOrderId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  timeInForce: 'GTC'
}

export interface DurableOrderPreflightSplit {
  reservationId: string
  conditionId: string
  keepOutcomeSetId: string
  lockOutcomeSetId: string
  amountSats: number
}

export interface DurableOrderCollateralPin {
  schemaVersion: typeof DURABLE_ORDER_COLLATERAL_SCHEMA_VERSION
  revision: number
  scopeId: string
  pinId: string
  clientOrderId: string
  marketId: string
  mintUrl: string
  unit: string
  orderAmount: number
  requiredAmount: number
  remainingOrderAmount: number
  submissionRequest: DurableOrderSubmissionRequest
  preflightSplit: DurableOrderPreflightSplit | null
  state: 'prepared' | 'active' | 'released'
  orderId: string | null
  releaseReason: DurableOrderCollateralReleaseReason | null
  proofs: DurableOrderCollateralProof[]
}

export type DurableOrderCollateralTransition =
  | {
      kind: 'bind-engine-order' | 'observe-engine-order'
      expectedRevision: number
      orderId: string
      status: string
      remainingAmount: number
    }
  | {
      kind: 'release-before-submit'
      expectedRevision: number
      reason: 'pre-submit-rejected'
    }
  | {
      kind: 'record-fill'
      expectedRevision: number
      remainingOrderAmount: number
      proofs: readonly DurableOrderCollateralProof[]
    }
  | {
      kind: 'replace-proofs'
      expectedRevision: number
      proofs: readonly DurableOrderCollateralProof[]
    }

export function durableOrderCollateralPinId(clientOrderId: string): string {
  return `order-collateral:${requireIdentifier(clientOrderId, 'client order id')}`
}

export function createDurableOrderCollateralPin(input: {
  scopeId: string
  clientOrderId: string
  marketId: string
  mintUrl: string
  unit: string
  orderAmount: number
  requiredAmount: number
  submissionRequest: DurableOrderSubmissionRequest
  preflightSplit?: DurableOrderPreflightSplit | null
  proofs: readonly DurableOrderCollateralProof[]
}): DurableOrderCollateralPin {
  return decodeDurableOrderCollateralPin({
    schemaVersion: DURABLE_ORDER_COLLATERAL_SCHEMA_VERSION,
    revision: 0,
    scopeId: input.scopeId,
    pinId: durableOrderCollateralPinId(input.clientOrderId),
    clientOrderId: input.clientOrderId,
    marketId: input.marketId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    orderAmount: input.orderAmount,
    requiredAmount: input.requiredAmount,
    remainingOrderAmount: input.orderAmount,
    submissionRequest: input.submissionRequest,
    preflightSplit: input.preflightSplit ?? null,
    state: 'prepared',
    orderId: null,
    releaseReason: null,
    proofs: input.proofs,
  })
}

export function reduceDurableOrderCollateralPin(
  value: DurableOrderCollateralPin,
  transition: DurableOrderCollateralTransition,
): DurableOrderCollateralPin {
  const pin = decodeDurableOrderCollateralPin(value)
  requireExpectedRevision(pin, transition.expectedRevision)
  if (transition.kind === 'release-before-submit') {
    if (pin.state !== 'prepared' || pin.orderId !== null) {
      throw new Error('submitted order collateral cannot use pre-submit release')
    }
    return nextPin(pin, {
      state: 'released',
      remainingOrderAmount: 0,
      releaseReason: transition.reason,
    })
  }
  if (transition.kind === 'record-fill') {
    return recordFill(pin, transition)
  }
  if (transition.kind === 'replace-proofs') {
    if (pin.state !== 'active') {
      throw new Error('order collateral proof replacement requires an active pin')
    }
    return nextPin(pin, { proofs: requireProofs(transition.proofs, false) })
  }
  return applyEngineObservation(pin, transition)
}

export function decodeDurableOrderCollateralPin(
  value: unknown,
): DurableOrderCollateralPin {
  const pin = requireRecord(value, 'order collateral pin')
  requireKnownFields(pin, [
    'schemaVersion', 'revision', 'scopeId', 'pinId', 'clientOrderId',
    'marketId', 'mintUrl', 'unit', 'orderAmount', 'requiredAmount',
    'remainingOrderAmount', 'submissionRequest', 'preflightSplit',
    'state', 'orderId', 'releaseReason', 'proofs',
  ])
  if (pin.schemaVersion !== DURABLE_ORDER_COLLATERAL_SCHEMA_VERSION) {
    throw new Error('order collateral schema version is unsupported')
  }
  const scopeId = decodeDurableCustodyScopeId(pin.scopeId)
  if (!scopeId.startsWith('custody:wallet:')) {
    throw new Error('order collateral requires a wallet custody scope')
  }
  const clientOrderId = requireIdentifier(pin.clientOrderId, 'client order id')
  const state = requireState(pin.state)
  const proofs = requireProofs(pin.proofs, state === 'released')
  const requiredAmount = requirePositiveInteger(pin.requiredAmount, 'required amount')
  const orderAmount = requirePositiveInteger(pin.orderAmount, 'order amount')
  const remainingOrderAmount = requireNonnegativeInteger(
    pin.remainingOrderAmount,
    'remaining order amount',
  )
  const submissionRequest = decodeSubmissionRequest(pin.submissionRequest)
  const preflightSplit = decodePreflightSplit(pin.preflightSplit)
  if (state !== 'released'
    && proofs.reduce((sum, proof) => safeAdd(sum, proof.amount), 0)
      < requiredCoverage(requiredAmount, orderAmount, remainingOrderAmount)) {
    throw new Error('order collateral proof coverage is insufficient')
  }
  const decoded: DurableOrderCollateralPin = {
    schemaVersion: DURABLE_ORDER_COLLATERAL_SCHEMA_VERSION,
    revision: requireNonnegativeInteger(pin.revision, 'order collateral revision'),
    scopeId,
    pinId: requireIdentifier(pin.pinId, 'order collateral pin id'),
    clientOrderId,
    marketId: requireIdentifier(pin.marketId, 'market id'),
    mintUrl: requireMintUrl(pin.mintUrl),
    unit: requireIdentifier(pin.unit, 'collateral unit'),
    orderAmount,
    requiredAmount,
    remainingOrderAmount,
    submissionRequest,
    preflightSplit,
    state,
    orderId: pin.orderId === null ? null : requireIdentifier(pin.orderId, 'order id'),
    releaseReason: requireReleaseReason(pin.releaseReason),
    proofs,
  }
  validateLifecycle(decoded)
  return decoded
}

function applyEngineObservation(
  pin: DurableOrderCollateralPin,
  transition: Extract<DurableOrderCollateralTransition, { orderId: string }>,
): DurableOrderCollateralPin {
  if (pin.state === 'released') throw new Error('order collateral is released')
  const orderId = requireIdentifier(transition.orderId, 'order id')
  if (pin.orderId !== null && pin.orderId !== orderId) {
    throw new Error('order collateral is bound to another order')
  }
  const remainingAmount = requireNonnegativeInteger(
    transition.remainingAmount,
    'remaining amount',
  )
  if (remainingAmount > pin.orderAmount) {
    throw new Error('engine remaining amount exceeds the order amount')
  }
  const terminal = terminalReleaseReason(transition.status)
  if (terminal !== null) {
    return nextPin(pin, {
      orderId,
      state: 'released',
      remainingOrderAmount: 0,
      releaseReason: terminal,
    })
  }
  requireActiveStatus(transition.status)
  return nextPin(pin, {
    orderId,
    state: 'active',
  })
}

function recordFill(
  pin: DurableOrderCollateralPin,
  transition: Extract<DurableOrderCollateralTransition, { kind: 'record-fill' }>,
): DurableOrderCollateralPin {
  if (pin.state !== 'active' || pin.orderId === null) {
    throw new Error('order collateral cannot record a fill before binding')
  }
  const remainingOrderAmount = requireNonnegativeInteger(
    transition.remainingOrderAmount,
    'remaining order amount',
  )
  if (remainingOrderAmount > pin.remainingOrderAmount) {
    throw new Error('order remaining amount cannot increase')
  }
  if (remainingOrderAmount === 0) {
    return nextPin(pin, {
      state: 'released',
      remainingOrderAmount: 0,
      releaseReason: 'filled',
      proofs: [],
    })
  }
  return nextPin(pin, {
    remainingOrderAmount,
    proofs: requireProofs(transition.proofs, false),
  })
}

function nextPin(
  pin: DurableOrderCollateralPin,
  changes: Partial<DurableOrderCollateralPin>,
): DurableOrderCollateralPin {
  return decodeDurableOrderCollateralPin({
    ...pin,
    ...changes,
    revision: pin.revision + 1,
  })
}

function requireProofs(value: unknown, allowEmpty: boolean): DurableOrderCollateralProof[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.length > DURABLE_ORDER_COLLATERAL_PROOF_LIMIT_MAX) {
    throw new Error('order collateral proof count is invalid')
  }
  const proofs = value.map(decodeProof)
  if (new Set(proofs.map((proof) => proof.proofId)).size !== proofs.length) {
    throw new Error('order collateral proof id is duplicated')
  }
  return proofs
}

function decodeProof(value: unknown): DurableOrderCollateralProof {
  const proof = requireRecord(value, 'order collateral proof')
  requireKnownFields(proof, ['proofId', 'keysetId', 'amount', 'asset'])
  return {
    proofId: requireLowerHex32(proof.proofId, 'proof id'),
    keysetId: requireIdentifier(proof.keysetId, 'keyset id'),
    amount: requirePositiveInteger(proof.amount, 'proof amount'),
    asset: decodeAsset(proof.asset),
  }
}

function decodeAsset(value: unknown): DurableOrderCollateralAsset {
  const asset = requireRecord(value, 'order collateral asset')
  if (asset.kind === 'base') {
    requireKnownFields(asset, ['kind'])
    return { kind: 'base' }
  }
  requireKnownFields(asset, ['kind', 'conditionId', 'outcomeSetId'])
  if (asset.kind !== 'outcome') throw new Error('order collateral asset is invalid')
  return {
    kind: 'outcome',
    conditionId: requireIdentifier(asset.conditionId, 'condition id'),
    outcomeSetId: requireIdentifier(asset.outcomeSetId, 'outcome set id'),
  }
}

function decodeSubmissionRequest(value: unknown): DurableOrderSubmissionRequest {
  const request = requireRecord(value, 'order submission request')
  requireKnownFields(request, [
    'clientOrderId', 'outcomeId', 'tokenSide', 'side', 'price',
    'amountSubunits', 'timeInForce',
  ])
  if (request.tokenSide !== 'Outcome' && request.tokenSide !== 'Complement') {
    throw new Error('order submission token side is invalid')
  }
  if (request.side !== 'Buy' && request.side !== 'Sell') {
    throw new Error('order submission side is invalid')
  }
  if (request.timeInForce !== 'GTC') {
    throw new Error('order collateral submission must be GTC')
  }
  return {
    clientOrderId: requireIdentifier(request.clientOrderId, 'client order id'),
    outcomeId: requireIdentifier(request.outcomeId, 'outcome id'),
    tokenSide: request.tokenSide,
    side: request.side,
    price: requirePositiveInteger(request.price, 'order price'),
    amountSubunits: requirePositiveInteger(
      request.amountSubunits,
      'order submission amount',
    ),
    timeInForce: request.timeInForce,
  }
}

function decodePreflightSplit(value: unknown): DurableOrderPreflightSplit | null {
  if (value === null) return null
  const split = requireRecord(value, 'order preflight split')
  requireKnownFields(split, [
    'reservationId', 'conditionId', 'keepOutcomeSetId', 'lockOutcomeSetId',
    'amountSats',
  ])
  const keepOutcomeSetId = requireIdentifier(
    split.keepOutcomeSetId,
    'preflight keep outcome set id',
  )
  const lockOutcomeSetId = requireIdentifier(
    split.lockOutcomeSetId,
    'preflight lock outcome set id',
  )
  if (keepOutcomeSetId === lockOutcomeSetId) {
    throw new Error('preflight outcome sets must be distinct')
  }
  return {
    reservationId: requireIdentifier(split.reservationId, 'preflight reservation id'),
    conditionId: requireIdentifier(split.conditionId, 'preflight condition id'),
    keepOutcomeSetId,
    lockOutcomeSetId,
    amountSats: requirePositiveInteger(split.amountSats, 'preflight amount'),
  }
}

function validateLifecycle(pin: DurableOrderCollateralPin): void {
  if (pin.pinId !== durableOrderCollateralPinId(pin.clientOrderId)) {
    throw new Error('order collateral pin id is not canonical')
  }
  if (pin.remainingOrderAmount > pin.orderAmount) {
    throw new Error('remaining order amount is invalid')
  }
  if (pin.submissionRequest.amountSubunits !== pin.orderAmount) {
    throw new Error('order submission amount does not match collateral pin')
  }
  if (pin.submissionRequest.clientOrderId !== pin.clientOrderId) {
    throw new Error('order submission client id does not match collateral pin')
  }
  if (pin.preflightSplit !== null
    && (pin.preflightSplit.reservationId !== pin.pinId
      || pin.preflightSplit.amountSats !== pin.orderAmount
      || pin.submissionRequest.side !== 'Buy')) {
    throw new Error('order preflight split does not match collateral pin')
  }
  if (pin.state === 'prepared'
    && (pin.orderId !== null || pin.releaseReason !== null
      || pin.remainingOrderAmount !== pin.orderAmount)) {
    throw new Error('prepared order collateral lifecycle is invalid')
  }
  if (pin.state === 'active'
    && (pin.orderId === null || pin.releaseReason !== null)) {
    throw new Error('active order collateral lifecycle is invalid')
  }
  if (pin.state === 'released'
    && (pin.releaseReason === null || pin.remainingOrderAmount !== 0)) {
    throw new Error('released order collateral lifecycle is invalid')
  }
  if (pin.releaseReason === 'pre-submit-rejected' && pin.orderId !== null) {
    throw new Error('pre-submit release cannot name an engine order')
  }
}

function terminalReleaseReason(status: string): DurableOrderCollateralReleaseReason | null {
  const normalized = requireIdentifier(status, 'order status').toLowerCase()
  return normalized === 'cancelled' || normalized === 'failed'
    || normalized === 'expired'
    ? normalized
    : null
}

function requireActiveStatus(status: string): void {
  const normalized = requireIdentifier(status, 'order status').toLowerCase()
  if (!['resting', 'matched', 'partially_filled', 'filled'].includes(normalized)) {
    throw new Error('order status cannot retain collateral')
  }
}

function requireReleaseReason(value: unknown): DurableOrderCollateralReleaseReason | null {
  if (value === null) return null
  const reason = requireIdentifier(value, 'release reason')
  if (!['pre-submit-rejected', 'filled', 'cancelled', 'failed', 'expired'].includes(reason)) {
    throw new Error('order collateral release reason is invalid')
  }
  return reason as DurableOrderCollateralReleaseReason
}

function requireState(value: unknown): DurableOrderCollateralPin['state'] {
  if (value !== 'prepared' && value !== 'active' && value !== 'released') {
    throw new Error('order collateral state is invalid')
  }
  return value
}

function requireExpectedRevision(pin: DurableOrderCollateralPin, revision: number): void {
  if (requireNonnegativeInteger(revision, 'expected revision') !== pin.revision) {
    throw new Error('order collateral revision conflict')
  }
}

function requireMintUrl(value: unknown): string {
  let url: URL
  try {
    url = new URL(requireIdentifier(value, 'mint URL'))
  } catch {
    throw new Error('mint URL is invalid')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username || url.password || url.hash || url.search
    || /%[0-9a-f]{2}/i.test(url.pathname)) {
    throw new Error('mint URL is invalid')
  }
  return url.href.replace(/\/$/, '')
}

function requireLowerHex32(value: unknown, label: string): string {
  const text = requireIdentifier(value, label)
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${label} is invalid`)
  return text
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireNonnegativeInteger(value, label)
  if (number === 0) throw new Error(`${label} must be positive`)
  return number
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`)
  }
  return value as number
}

function safeAdd(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) throw new Error('collateral amount overflow')
  return total
}

function requiredCoverage(
  requiredAmount: number,
  orderAmount: number,
  remainingOrderAmount: number,
): number {
  if (remainingOrderAmount === 0) return 0
  const numerator = BigInt(requiredAmount) * BigInt(remainingOrderAmount)
  const coverage = (numerator + BigInt(orderAmount) - 1n) / BigInt(orderAmount)
  const value = Number(coverage)
  if (!Number.isSafeInteger(value)) {
    throw new Error('order collateral coverage exceeds safe integer range')
  }
  return value
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function requireKnownFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error('order collateral contains an unknown field')
  }
}
