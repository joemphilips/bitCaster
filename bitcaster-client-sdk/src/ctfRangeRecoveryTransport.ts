import {
  Amount,
  JSONInt,
  Mint as CashuMint,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  verifyProofsForReceive,
  type CheckStatePayload,
  type CheckStateResponse,
  type GetKeysResponse,
  type HasKeysetKeys,
  type PostRestorePayload,
  type PostRestoreResponse,
  type Proof,
  type ProofState,
  type RequestFn,
  type RequestOptions,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DURABLE_CTF_RANGE_RESULT_BYTES_MAX,
  assertDurableCtfRangeRefundKeysetAuthority,
  assertDurableCtfRangeCustodyAuthority,
  buildDurableCtfRangeRecoveryQuery,
  classifyDurableCtfRangeRecovery,
  decodeDurableCtfRangeOperation,
  decodeDurableCtfRangeResultEnvelopeBytes,
  type DurableCtfRangeAllManifestRecovery,
  type DurableCtfRangeKeysetResolver,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeOperation,
  type DurableCtfRangeRecoveryDecision,
  type DurableCtfRangeRecoveryObservation,
  type DurableCtfRangeResultEnvelope,
} from './durableCtfRangeOperation.ts'
import {
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  canonicalDurableCustodyKeysetIdentity,
  decodeCanonicalMintOrigin,
  deriveDurableCustodyKeysetFingerprint,
  type DurableCustodyRecord,
} from './durableCustody.ts'
import {
  deserializeDurableCustodyOutput,
  type DurableCustodyPlannedOutput,
} from './durableCustodyProofOperation.ts'
import { readAllocationBoundedJsonResponse } from './boundedJsonResponse.ts'
import type {
  BitcasterEngineClient,
  SettlementCapabilityReference,
  SettlementCapabilityResultResponse,
} from './engineClient.ts'

const OPENAPI_BASE64_ENVELOPE_LENGTH_MAX = 4 * Math.ceil(DURABLE_CTF_RANGE_RESULT_BYTES_MAX / 3)
const NUT07_BATCH_SIZE = 100
const RECOVERY_TEXT_BYTES_MAX = 1_024
const CASHU_REQUEST_TIMEOUT_MS = 10_000
const CTF_RANGE_MINT_CHECK_RESPONSE_BYTES_MAX = 384 * 1_024
const CTF_RANGE_MINT_KEYS_RESPONSE_BYTES_MAX = 128 * 1_024
export const CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX = 384 * 1_024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export interface CtfRangeEngineResult {
  readonly resultId: string
  readonly reference: SettlementCapabilityReference
  readonly requestDigest: string
  readonly envelopeDigest: string
  readonly envelopeBytes: Uint8Array
  readonly envelope: DurableCtfRangeResultEnvelope
  readonly acknowledgedAt: string | null
  readonly version: number
}

export interface CtfRangeEngineResultClient {
  getSettlementCapabilityResultByOperation(
    operationId: string,
  ): ReturnType<BitcasterEngineClient['getSettlementCapabilityResultByOperation']>
}

export interface CtfRangeEngineResultAuthority {
  readonly operation: DurableCtfRangeOperation
  readonly reference: SettlementCapabilityReference
  readonly previouslyPersistedRequestDigest?: string
}

export interface CtfRangeMintClient extends CtfRangeProofStateClient {
  restore(payload: PostRestorePayload): Promise<PostRestoreResponse>
  getKeys(keysetId?: string): Promise<GetKeysResponse>
}

export interface CtfRangeMintVerificationContext {
  readonly allManifestRecovery: DurableCtfRangeAllManifestRecovery
  readonly resolveKeyset: DurableCtfRangeKeysetResolver
}

export interface CtfRangeMintRecoveryObservationContext extends CtfRangeMintVerificationContext {
  readonly observation: DurableCtfRangeRecoveryObservation
}

export interface CtfRangeProofStateClient {
  check(payload: CheckStatePayload, signal?: AbortSignal): Promise<CheckStateResponse>
}

export class CtfRangeRecoveryTransportError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'CtfRangeRecoveryTransportError'
  }
}

export async function restoreDurableCtfRangeRefundOutputs(input: {
  mintUrl: string
  outputs: readonly DurableCustodyPlannedOutput[]
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  keyset: DurableCtfRangeMintKeyset
  mint?: CtfRangeMintClient
}): Promise<Proof[]> {
  const operation = decodeDurableCtfRangeOperation(input.operation)
  const mintUrl = decodeCanonicalMintOrigin(input.mintUrl)
  if (mintUrl !== operation.mintUrl) {
    throw new Error('CTF range refund restore mint is foreign')
  }
  assertDurableCtfRangeRefundKeysetAuthority({
    record: input.record,
    operation,
    keyset: input.keyset,
  })
  const outputData = input.outputs.map(deserializeDurableCustodyOutput)
  if (outputData.length === 0 || outputData.length > 256) {
    throw new Error('CTF range refund restore output limit is invalid')
  }
  const mint = input.mint ?? createCtfRangeMintClient(mintUrl)
  let response: PostRestoreResponse
  try {
    response = await mint.restore({
      outputs: outputData.map(({ blindedMessage }) => blindedMessage),
    })
  } catch (error) {
    throw new CtfRangeRecoveryTransportError('CTF range refund restore transport failed', error)
  }
  if (
    !Array.isArray(response.outputs) ||
    !Array.isArray(response.signatures) ||
    response.outputs.length !== outputData.length ||
    response.signatures.length !== response.outputs.length
  ) {
    throw new Error('CTF range refund restore response size is invalid')
  }
  const expected = new Map(
    outputData.map(({ blindedMessage }) => [blindedMessage.B_, blindedMessage]),
  )
  const restored = new Set<string>()
  const signatures = new Map<string, SerializedBlindedSignature>()
  response.outputs.forEach((output, index) => {
    const signature = response.signatures[index]!
    assertRestoredPair(output, signature, expected, restored)
    signatures.set(output.B_, signature)
  })
  return verifyDurableCtfRangeRefundSignatures({
    record: input.record,
    operation: input.operation,
    keyset: input.keyset,
    outputs: input.outputs,
    signatures: outputData.map((output) => {
      const signature = signatures.get(output.blindedMessage.B_)
      if (signature === undefined) {
        throw new Error('CTF range refund restore authority is incomplete')
      }
      return signature
    }),
  })
}

export function verifyDurableCtfRangeRefundSignatures(input: {
  record: DurableCustodyRecord
  operation: DurableCtfRangeOperation
  keyset: DurableCtfRangeMintKeyset
  outputs: readonly DurableCustodyPlannedOutput[]
  signatures: readonly SerializedBlindedSignature[]
}): Proof[] {
  const operation = decodeDurableCtfRangeOperation(input.operation)
  const keyset = assertDurableCtfRangeRefundKeysetAuthority({
    record: input.record,
    operation,
    keyset: input.keyset,
  })
  const outputs = input.outputs.map(deserializeDurableCustodyOutput)
  if (
    outputs.length === 0 ||
    outputs.length > 256 ||
    input.signatures.length !== outputs.length ||
    outputs.some(({ blindedMessage }) => blindedMessage.id !== operation.offerKeysetId)
  ) {
    throw new Error('CTF range refund signature authority is incomplete')
  }
  const signatures = outputs.map((output, index) => {
    const signature = input.signatures[index]
    if (
      signature === undefined ||
      signature.id !== output.blindedMessage.id ||
      signature.amount.toString() !== output.blindedMessage.amount.toString()
    ) {
      throw new Error('CTF range refund signature differs from its exact output')
    }
    return signature
  })
  try {
    const proofs = outputs.map((output, index) =>
      output.toProof({ ...signatures[index]!, amount: output.blindedMessage.amount }, keyset),
    )
    verifyProofsForReceive(
      proofs,
      (keysetId) => {
        if (keysetId !== keyset.id) throw new Error('CTF range refund proof keyset is foreign')
        return keyset
      },
      { requireDleq: true },
    )
    return proofs
  } catch (error) {
    throw new Error('CTF range refund proof cryptographic verification failed', { cause: error })
  }
}

export interface CtfRangeInputProofIdentity {
  readonly id: string
  readonly secret: string
}

export async function fetchCtfRangeEngineResultByOperation(
  client: CtfRangeEngineResultClient,
  authority: CtfRangeEngineResultAuthority,
): Promise<CtfRangeEngineResult | null> {
  const operation = decodeDurableCtfRangeOperation(authority.operation)
  const operationId = operation.operationId
  requireBoundedText(operationId)
  let response: SettlementCapabilityResultResponse | null
  try {
    response = await client.getSettlementCapabilityResultByOperation(operationId)
  } catch {
    throw new Error('CTF range engine result request failed')
  }
  return response === null
    ? null
    : decodeCtfRangeEngineResult(response, { ...authority, operation })
}

export function decodeCtfRangeEngineResult(
  value: SettlementCapabilityResultResponse,
  authority: CtfRangeEngineResultAuthority,
): CtfRangeEngineResult {
  try {
    const { operation, reference } = decodeEngineResultAuthority(value, authority)
    const envelopeBytes = decodeCanonicalBase64Envelope(value.envelope)
    const computedDigest = bytesToHex(sha256(envelopeBytes))
    if (computedDigest !== value.envelopeDigest) {
      throw new Error('engine result digest mismatch')
    }
    const envelope = decodeDurableCtfRangeResultEnvelopeBytes(envelopeBytes)
    if (
      envelope.operationId !== operation.operationId ||
      envelope.authorizationId !== operation.authorizationId ||
      envelope.requestDigest !== value.requestDigest
    ) {
      throw new Error('engine result envelope authority mismatch')
    }
    return {
      resultId: value.resultId,
      reference,
      requestDigest: value.requestDigest,
      envelopeDigest: value.envelopeDigest,
      envelopeBytes,
      envelope,
      acknowledgedAt:
        value.acknowledgedAt === undefined || value.acknowledgedAt === null
          ? null
          : requireIsoDateTime(value.acknowledgedAt),
      version: value.version,
    }
  } catch {
    throw new Error('CTF range engine result is invalid')
  }
}

function requireIsoDateTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('engine result acknowledgement time is invalid')
  }
  return value
}

function decodeEngineResultAuthority(
  value: SettlementCapabilityResultResponse,
  authority: CtfRangeEngineResultAuthority,
): {
  operation: DurableCtfRangeOperation
  reference: SettlementCapabilityReference
} {
  const operation = decodeDurableCtfRangeOperation(authority.operation)
  requireBoundedText(operation.operationId)
  if (
    typeof value !== 'object' ||
    value === null ||
    !UUID_PATTERN.test(value.resultId) ||
    value.operationId !== operation.operationId ||
    !DIGEST_PATTERN.test(value.requestDigest) ||
    !DIGEST_PATTERN.test(value.envelopeDigest) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0
  ) {
    throw new Error('invalid engine result authority')
  }
  const reference = decodeCapabilityReference(value.reference)
  const expectedReference = decodeCapabilityReference(authority.reference)
  if (
    reference.artifactId !== expectedReference.artifactId ||
    reference.bindingDigest !== expectedReference.bindingDigest
  ) {
    throw new Error('engine result capability authority mismatch')
  }
  if (
    authority.previouslyPersistedRequestDigest !== undefined &&
    (!DIGEST_PATTERN.test(authority.previouslyPersistedRequestDigest) ||
      value.requestDigest !== authority.previouslyPersistedRequestDigest)
  ) {
    throw new Error('engine result request authority mismatch')
  }
  return { operation, reference }
}

/**
 * Exact NUT-07 input classification is shared by pre-admission validation and
 * uncertain recovery. The durable format admits at most 256 inputs, so mint
 * requests are explicitly split into batches.
 */
export async function checkCtfRangeInputProofStates(
  mint: CtfRangeProofStateClient,
  inputs: readonly CtfRangeInputProofIdentity[],
  signal?: AbortSignal,
): Promise<ProofState[]> {
  try {
    if (inputs.length === 0 || inputs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
      throw new Error('range input proof limit is invalid')
    }
    const Ys = inputs.map(({ id, secret }) => {
      requireBoundedText(id)
      requireBoundedText(secret)
      const bytes = new TextEncoder().encode(secret)
      return isBlsKeyset(id) ? hashToCurveBls(bytes).toHex(true) : hashToCurve(bytes).toHex(true)
    })
    const ordered: ProofState[] = []
    for (let offset = 0; offset < Ys.length; offset += NUT07_BATCH_SIZE) {
      signal?.throwIfAborted()
      const batch = Ys.slice(offset, offset + NUT07_BATCH_SIZE)
      let response: CheckStateResponse
      try {
        response = await mint.check({ Ys: batch }, signal)
      } catch (error) {
        throw new CtfRangeRecoveryTransportError('CTF range proof-state transport failed', error)
      }
      if (!Array.isArray(response.states) || response.states.length > batch.length) {
        throw new Error('invalid range proof-state response size')
      }
      const expected = new Set(batch)
      const byY = new Map<string, ProofState>()
      for (const state of response.states) {
        assertProofState(state, expected, byY)
        byY.set(state.Y, state)
      }
      for (const Y of batch) {
        const state = byY.get(Y)
        if (state === undefined) throw new Error('range proof state is missing')
        ordered.push(state)
      }
    }
    return ordered
  } catch (error) {
    if (error instanceof CtfRangeRecoveryTransportError) throw error
    throw new Error('CTF range proof-state response is invalid')
  }
}

export class CtfRangeMintRecoveryAdapter {
  readonly #operation: DurableCtfRangeOperation
  readonly #mint: CtfRangeMintClient

  constructor(
    operation: DurableCtfRangeOperation,
    mint?: CtfRangeMintClient,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#operation = decodeDurableCtfRangeOperation(operation)
    decodeCanonicalMintOrigin(this.#operation.mintUrl)
    if (this.#operation.unit !== 'msat') {
      throw new Error('CTF range mint authority is invalid')
    }
    this.#mint = mint ?? createCtfRangeMintClient(this.#operation.mintUrl, fetchImpl)
  }

  async classifyUncertainRecovery(input: {
    record: DurableCustodyRecord
    selection: string | null
    now: number
    signal?: AbortSignal
  }): Promise<DurableCtfRangeRecoveryDecision> {
    try {
      const recovery = await this.loadUncertainRecoveryObservation(input)
      return classifyDurableCtfRangeRecovery({
        operation: this.#operation,
        record: input.record,
        observation: recovery.observation,
        resolveKeyset: recovery.resolveKeyset,
      })
    } catch (error) {
      if (error instanceof CtfRangeRecoveryTransportError) {
        throw new CtfRangeRecoveryTransportError('CTF range mint recovery failed', error)
      }
      throw new Error('CTF range mint recovery failed')
    }
  }

  async loadUncertainRecoveryObservation(input: {
    record: DurableCustodyRecord
    selection: string | null
    now: number
    signal?: AbortSignal
  }): Promise<CtfRangeMintRecoveryObservationContext> {
    try {
      assertDurableCtfRangeCustodyAuthority(input.record, this.#operation)
      const [verification, inputStates] = await Promise.all([
        this.loadExactVerificationContext(input.record),
        checkCtfRangeInputProofStates(this.#mint, this.#operation.inputs, input.signal),
      ])
      return {
        ...verification,
        observation: {
          selection: input.selection,
          inputStates,
          ...verification.allManifestRecovery,
          now: input.now,
        },
      }
    } catch (error) {
      if (error instanceof CtfRangeRecoveryTransportError) {
        throw new CtfRangeRecoveryTransportError(
          'CTF range mint recovery observation failed',
          error,
        )
      }
      throw new Error('CTF range mint recovery observation failed')
    }
  }

  async loadExactVerificationContext(
    record: DurableCustodyRecord,
  ): Promise<CtfRangeMintVerificationContext> {
    try {
      assertDurableCtfRangeCustodyAuthority(record, this.#operation)
      const [allManifestRecovery, resolveKeyset] = await Promise.all([
        this.#restoreExactAllManifest(),
        this.#loadBoundKeysets(record),
      ])
      return { allManifestRecovery, resolveKeyset }
    } catch (error) {
      if (error instanceof CtfRangeRecoveryTransportError) {
        throw new CtfRangeRecoveryTransportError(
          'CTF range mint verification context failed',
          error,
        )
      }
      throw new Error('CTF range mint verification context failed')
    }
  }

  async #restoreExactAllManifest(): Promise<DurableCtfRangeAllManifestRecovery> {
    const query = buildDurableCtfRangeRecoveryQuery(this.#operation, null)
    const queriedOutputs = query.outputs
    if (queriedOutputs.length === 0) throw new Error('empty range recovery query')
    let response: PostRestoreResponse
    try {
      response = await this.#mint.restore({ outputs: queriedOutputs })
    } catch (error) {
      throw new CtfRangeRecoveryTransportError('CTF range restore transport failed', error)
    }
    if (
      !Array.isArray(response.outputs) ||
      !Array.isArray(response.signatures) ||
      response.outputs.length > queriedOutputs.length ||
      response.signatures.length !== response.outputs.length
    ) {
      throw new Error('invalid range restore response size')
    }

    const expected = new Map(queriedOutputs.map((output) => [output.B_, output]))
    const restored = new Set<string>()
    response.outputs.forEach((output, index) => {
      const signature = response.signatures[index]!
      assertRestoredPair(output, signature, expected, restored)
    })
    return {
      queriedOutputs,
      restoredOutputs: response.outputs,
      signatures: response.signatures,
      queryCompleted: true,
    }
  }

  async #loadBoundKeysets(record: DurableCustodyRecord): Promise<DurableCtfRangeKeysetResolver> {
    const authorizedIds = [
      ...new Set(record.operation.verification.outputKeysets.map(({ keysetId }) => keysetId)),
    ]
    const keysets = new Map<string, HasKeysetKeys>()
    for (const authorizedId of authorizedIds) {
      let response: GetKeysResponse
      try {
        response = await this.#mint.getKeys(authorizedId)
      } catch (error) {
        throw new CtfRangeRecoveryTransportError('CTF range key transport failed', error)
      }
      if (!Array.isArray(response.keysets) || response.keysets.length > 4) {
        throw new Error('invalid range keyset response size')
      }
      const canonicalId = canonicalDurableCustodyKeysetIdentity(authorizedId)
      const matches = response.keysets.filter(
        ({ id }) => canonicalDurableCustodyKeysetIdentity(id) === canonicalId,
      )
      if (matches.length !== 1) throw new Error('bound range keyset is missing')
      const keyset = matches[0]!
      if (keyset.unit !== this.#operation.unit) {
        throw new Error('bound range keyset unit is foreign')
      }
      deriveDurableCustodyKeysetFingerprint({
        keysetId: authorizedId,
        unit: keyset.unit,
        curve: isBlsKeyset(authorizedId) ? 'bls12-381' : 'secp256k1',
        publicKeys: keyset.keys,
      })
      keysets.set(canonicalId, { id: authorizedId, keys: keyset.keys })
    }
    const mintUrl = this.#operation.mintUrl
    return (canonicalMintUrl, keysetId) => {
      if (canonicalMintUrl !== mintUrl) return undefined
      return keysets.get(canonicalDurableCustodyKeysetIdentity(keysetId))
    }
  }
}

export function createCtfRangeMintClient(
  canonicalMintUrl: string,
  fetchImpl: typeof fetch = fetch,
): CtfRangeMintClient {
  const mint = new CashuMint(canonicalMintUrl)
  const request = createBoundedCashuRequest(canonicalMintUrl, fetchImpl)
  return {
    restore: (payload) => mint.restore(payload, request),
    check: (payload, signal) =>
      mint.check(payload, (options) => request({ ...options, signal: signal ?? options.signal })),
    getKeys: (keysetId) => mint.getKeys(keysetId, undefined, request),
  }
}

function createBoundedCashuRequest(canonicalMintUrl: string, fetchImpl: typeof fetch): RequestFn {
  return async function boundedCashuRequest<T = unknown>(options: RequestOptions): Promise<T> {
    const lifetime = createRequestLifetime(options.signal, options.requestTimeout)
    try {
      const responseBytes = cashuResponseByteLimit(canonicalMintUrl, options)
      const body =
        options.requestBody === undefined ? undefined : JSONInt.stringify(options.requestBody)
      const headers = new Headers(options.headers)
      headers.set('accept', 'application/json')
      if (body !== undefined) headers.set('content-type', 'application/json')
      const response = await fetchImpl(options.endpoint, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        body,
        headers,
        cache: 'no-store',
        credentials: 'omit',
        referrer: '',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: lifetime.signal,
      })
      options.onResponseMeta?.({
        endpoint: options.endpoint,
        status: response.status,
        headers: response.headers,
      })
      if (response.redirected || !response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error('mint response status is invalid')
      }
      return (await readAllocationBoundedJsonResponse(response, responseBytes, JSONInt.parse)) as T
    } catch {
      throw new Error('CTF range mint request failed')
    } finally {
      lifetime.dispose()
    }
  }
}

function cashuResponseByteLimit(canonicalMintUrl: string, options: RequestOptions): number {
  const endpoint = new URL(options.endpoint)
  if (
    endpoint.origin !== canonicalMintUrl ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error('mint recovery endpoint is foreign')
  }
  const method = options.method ?? (options.requestBody === undefined ? 'GET' : 'POST')
  if (endpoint.pathname === '/v1/restore' && method === 'POST') {
    return CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX
  }
  if (endpoint.pathname === '/v1/checkstate' && method === 'POST') {
    return CTF_RANGE_MINT_CHECK_RESPONSE_BYTES_MAX
  }
  if (/^\/v1\/keys\/[^/]+$/.test(endpoint.pathname) && method === 'GET') {
    return CTF_RANGE_MINT_KEYS_RESPONSE_BYTES_MAX
  }
  throw new Error('mint recovery endpoint is unsupported')
}

function createRequestLifetime(
  callerSignal: AbortSignal | null | undefined,
  requestedTimeoutMs: number | undefined,
): { signal: AbortSignal; dispose(): void } {
  const timeoutMs =
    requestedTimeoutMs === undefined
      ? CASHU_REQUEST_TIMEOUT_MS
      : Math.min(requestedTimeoutMs, CASHU_REQUEST_TIMEOUT_MS)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('mint recovery timeout is invalid')
  }
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(forwardAbort, timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', forwardAbort)
    },
  }
}

function decodeCapabilityReference(value: SettlementCapabilityReference) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !UUID_PATTERN.test(value.artifactId) ||
    !DIGEST_PATTERN.test(value.bindingDigest)
  ) {
    throw new Error('engine result capability reference is invalid')
  }
  return { artifactId: value.artifactId, bindingDigest: value.bindingDigest }
}

function decodeCanonicalBase64Envelope(value: string): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > OPENAPI_BASE64_ENVELOPE_LENGTH_MAX ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('engine result envelope base64 is invalid')
  }
  assertCanonicalBase64Tail(value)
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  if (bytes.byteLength > DURABLE_CTF_RANGE_RESULT_BYTES_MAX) {
    throw new Error('engine result envelope base64 is noncanonical')
  }
  return bytes
}

function assertCanonicalBase64Tail(value: string): void {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (value.endsWith('==')) {
    const last = alphabet.indexOf(value.at(-3)!)
    if (last < 0 || (last & 0b1111) !== 0) {
      throw new Error('engine result envelope base64 is noncanonical')
    }
  } else if (value.endsWith('=')) {
    const last = alphabet.indexOf(value.at(-2)!)
    if (last < 0 || (last & 0b11) !== 0) {
      throw new Error('engine result envelope base64 is noncanonical')
    }
  }
}

function assertRestoredPair(
  output: SerializedBlindedMessage,
  signature: SerializedBlindedSignature,
  expected: ReadonlyMap<string, SerializedBlindedMessage>,
  restored: Set<string>,
): void {
  if (typeof output?.B_ !== 'string' || output.B_.length > 192 || restored.has(output.B_)) {
    throw new Error('range restore output is invalid')
  }
  const queried = expected.get(output.B_)
  if (
    queried === undefined ||
    output.id !== queried.id ||
    !boundedAmountEquals(output.amount, queried.amount) ||
    signature.id !== output.id ||
    !boundedAmountEquals(signature.amount, output.amount) ||
    typeof signature.C_ !== 'string' ||
    signature.C_.length !== (isBlsKeyset(output.id) ? 96 : 66) ||
    !/^[0-9a-f]+$/.test(signature.C_)
  ) {
    throw new Error('range restore authority is foreign')
  }
  restored.add(output.B_)
}

function assertProofState(
  state: ProofState,
  expected: ReadonlySet<string>,
  observed: ReadonlyMap<string, ProofState>,
): void {
  if (
    typeof state?.Y !== 'string' ||
    !expected.has(state.Y) ||
    observed.has(state.Y) ||
    (state.state !== 'UNSPENT' && state.state !== 'PENDING' && state.state !== 'SPENT') ||
    (state.witness !== null &&
      (typeof state.witness !== 'string' ||
        new TextEncoder().encode(state.witness).byteLength > RECOVERY_TEXT_BYTES_MAX))
  ) {
    throw new Error('range proof state authority is foreign')
  }
}

function boundedAmountEquals(left: unknown, right: unknown): boolean {
  const leftText = String(left)
  const rightText = String(right)
  if (
    leftText.length === 0 ||
    leftText.length > 20 ||
    rightText.length === 0 ||
    rightText.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(leftText) ||
    !/^(0|[1-9][0-9]*)$/.test(rightText)
  ) {
    return false
  }
  return Amount.from(leftText).equals(Amount.from(rightText))
}

function requireBoundedText(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > RECOVERY_TEXT_BYTES_MAX
  ) {
    throw new Error('recovery text is invalid')
  }
  return true
}
