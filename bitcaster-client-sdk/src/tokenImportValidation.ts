import { getDecodedToken, getDecodedTokenBinary, type Token } from '@cashu/cashu-ts'

/**
 * The browser already applies a 100 KiB paste limit. At that size, 512 proofs
 * is a conservative upper bound for ordinary encoded Cashu proofs. The
 * remaining limits independently bound mint fan-out, requested keysets,
 * prefix-collision candidates, and resolver time. Native clients may opt into
 * larger limits, but must choose every bound before network or persistence.
 */
export const DEFAULT_TOKEN_IMPORT_BOUNDS: Readonly<TokenImportBounds> = Object.freeze({
  maxEncodedBytes: 100 * 1_024,
  maxProofs: 512,
  maxMints: 8,
  maxKeysets: 128,
  maxResolverCandidates: 256,
  resolverTimeoutMs: 10_000,
})

export type TokenImportUnit = 'sat' | 'msat'
export type TokenImportKeysetSource = 'regular' | 'conditional'
export type TokenImportKeysetActivity = 'active' | 'inactive'

/**
 * Each context binds both the exact unit and admissible keyset source.
 * `ctf-collateral-msat` is the explicit opt-in for regular msat collateral.
 */
export type TokenImportContext = 'ordinary-sat' | 'ctf-position-msat' | 'ctf-collateral-msat'

export interface TokenImportBounds {
  maxEncodedBytes: number
  maxProofs: number
  maxMints: number
  maxKeysets: number
  maxResolverCandidates: number
  resolverTimeoutMs: number
}

export interface TokenImportKeysetMetadata {
  /** Full canonical keyset ID, or the exact legacy/v0 ID. */
  keysetId: string
  unit: unknown
  active: unknown
}

export interface TokenImportKeysetLookup {
  freshness: 'fresh' | 'stale'
  regularKeysets: readonly TokenImportKeysetMetadata[]
  conditionalKeysets: readonly TokenImportKeysetMetadata[]
}

export interface TokenImportKeysetRequest {
  canonicalMintUrl: string
  /** Exact IDs or encoded modern 8-byte prefixes referenced by the token. */
  encodedKeysetIds: readonly string[]
  signal: AbortSignal
  /** Absolute Unix epoch milliseconds shared by every lookup in this import. */
  deadlineMs: number
  /** Combined regular plus conditional candidate response bound. */
  maxCandidates: number
}

export type DecodeTokenImport = (
  encodedToken: string,
) => Token | readonly Token[] | Promise<Token | readonly Token[]>

export function canonicalizeTokenImportMintUrl(
  mintUrl: string,
  allowInsecureLoopbackHttp = false,
): string {
  return canonicalizeMintUrl(mintUrl, allowInsecureLoopbackHttp)
}

export interface TokenImportJsonResponse {
  readonly body: ReadableStream<Uint8Array> | null
  readonly headers: { get(name: string): string | null }
  /**
   * Optional non-streaming adapter hook that must enforce `maximumBytes`
   * before allocating or returning the complete decoded body.
   */
  readBoundedBody?(maximumBytes: number): Promise<Uint8Array>
}

export interface SelectTokenImportKeysetCandidatesInput {
  request: TokenImportKeysetRequest
  regularResponse: unknown
  conditionalResponse: unknown
}

export function assertTokenImportResolverRequestLive(
  request: TokenImportKeysetRequest,
  nowMs = Date.now(),
): void {
  if (request.signal.aborted || nowMs >= request.deadlineMs) {
    throw new Error('Mint keyset lookup deadline elapsed')
  }
}

/**
 * Parses both keyset responses from unknown input, selects only requested
 * exact IDs/prefixes, and applies one combined candidate cap.
 */
export function selectTokenImportKeysetCandidates(
  input: SelectTokenImportKeysetCandidatesInput,
): TokenImportKeysetLookup {
  assertTokenImportResolverRequestLive(input.request)
  if (!Number.isSafeInteger(input.request.maxCandidates) || input.request.maxCandidates <= 0) {
    throw new Error('Mint keyset lookup candidate bound is invalid')
  }
  const regularKeysets = selectCandidatesFromWireResponse(input.regularResponse, input.request)
  const conditionalKeysets = selectCandidatesFromWireResponse(
    input.conditionalResponse,
    input.request,
  )
  if (regularKeysets.length + conditionalKeysets.length > input.request.maxCandidates) {
    throw new Error('Mint keyset lookup exceeded the candidate bound')
  }
  return { freshness: 'fresh', regularKeysets, conditionalKeysets }
}

/**
 * Reads JSON under an allocation bound. Streams stop as soon as the cap is
 * crossed; runtimes without a stream must supply an adapter-owned bounded body
 * reader. Content-Length is only an early rejection signal because Fetch may
 * expose a decompressed body while retaining the compressed transfer length.
 */
export async function readBoundedTokenImportJsonResponse(
  response: TokenImportJsonResponse,
  maximumBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('Mint keyset response byte limit is invalid')
  }
  const declaredBytes = parseDeclaredResponseBytes(response.headers.get('content-length'))
  if (declaredBytes !== null && declaredBytes > maximumBytes) {
    throw new Error('Mint keyset response byte limit exceeded')
  }
  const bytes =
    response.body === null
      ? await readBoundedFallbackResponse(response, maximumBytes)
      : await readBoundedResponseStream(response.body, maximumBytes)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error('Mint keyset lookup returned invalid JSON')
  }
}

function selectCandidatesFromWireResponse(
  value: unknown,
  request: TokenImportKeysetRequest,
): TokenImportKeysetMetadata[] {
  if (!isRecord(value) || !Array.isArray(value.keysets)) {
    throw new Error('Mint keyset lookup returned invalid data')
  }
  return value.keysets
    .map((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') {
        throw new Error('Mint keyset lookup returned invalid data')
      }
      return item
    })
    .filter((item) =>
      request.encodedKeysetIds.some((encodedId) =>
        keysetMatches(parseEncodedKeysetId(encodedId), item.id as string),
      ),
    )
    .map((item) => ({
      keysetId: item.id as string,
      unit: item.unit,
      active: item.active,
    }))
}

function parseDeclaredResponseBytes(value: string | null): number | null {
  if (value === null) return null
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Mint keyset response Content-Length is invalid')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Mint keyset response Content-Length is invalid')
  }
  return parsed
}

async function readBoundedFallbackResponse(
  response: TokenImportJsonResponse,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (response.readBoundedBody === undefined) {
    throw new Error('Mint keyset response fallback requires an adapter-owned bounded body reader')
  }
  const bytes = await response.readBoundedBody(maximumBytes)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) {
    throw new Error('Mint keyset response byte limit exceeded')
  }
  return bytes
}

async function readBoundedResponseStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!ArrayBuffer.isView(next.value) || next.value.BYTES_PER_ELEMENT !== 1) {
        throw new Error('Mint keyset response stream returned invalid data')
      }
      const chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      totalBytes += chunk.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('Mint keyset response byte limit exceeded')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * The resolver must query both regular and conditional registries and return
 * only bounded candidates matching the requested exact IDs/prefixes. It must
 * honor `signal`, `deadlineMs`, and `maxCandidates`.
 *
 * The adapter remains responsible for environment-appropriate redirect and
 * private-target admission. Native adapters can resolve and pin public
 * destinations; browser adapters must reject redirects and apply the strictest
 * target checks their runtime exposes. Response bytes must be bounded before
 * JSON parsing.
 */
export type ResolveTokenImportKeysets = (
  request: TokenImportKeysetRequest,
) => Promise<TokenImportKeysetLookup>

export interface ValidateTokenImportInput {
  encodedToken: string
  context: TokenImportContext
  resolveKeysets: ResolveTokenImportKeysets
  bounds?: Partial<TokenImportBounds>
  /**
   * Optional exact canonical mint identities admitted by the caller. Native
   * single-profile wallets should pass their configured mint; interactive
   * browser imports may omit this after explicit user mint admission.
   */
  allowedCanonicalMintUrls?: ReadonlySet<string>
  /** Explicit development-only permission; never permits non-loopback HTTP. */
  allowInsecureLoopbackHttp?: boolean
  signal?: AbortSignal
  /** Defaults to the shared local Cashu parser and must never perform I/O. */
  decode?: DecodeTokenImport
}

export type ValidateProductWalletTokenImportInput = Omit<ValidateTokenImportInput, 'context'>

export interface ValidatedTokenImportProof {
  tokenIndex: number
  proofIndex: number
  canonicalMintUrl: string
  encodedKeysetId: string
  resolvedKeysetId: string
  source: TokenImportKeysetSource
  activity: TokenImportKeysetActivity
}

export interface ValidatedTokenImport {
  /** The exact caller-provided bearer token; never trim or re-encode it. */
  encodedToken: string
  context: TokenImportContext
  unit: TokenImportUnit
  canonicalMintUrls: readonly string[]
  proofs: readonly ValidatedTokenImportProof[]
  hasInactiveProofs: boolean
}

export type TokenImportValidationErrorCode =
  | 'invalid_bounds'
  | 'encoded_too_large'
  | 'invalid_token'
  | 'proof_limit_exceeded'
  | 'mint_limit_exceeded'
  | 'keyset_limit_exceeded'
  | 'unsupported_unit'
  | 'unit_mismatch'
  | 'source_mismatch'
  | 'mint_mismatch'
  | 'insecure_mint_url'
  | 'private_mint_url'
  | 'stale_keyset_metadata'
  | 'keyset_resolution_indeterminate'
  | 'resolver_response_too_large'
  | 'unknown_keyset'
  | 'ambiguous_keyset'
  | 'spoofed_keyset_metadata'

export class TokenImportValidationError extends Error {
  readonly code: TokenImportValidationErrorCode

  constructor(code: TokenImportValidationErrorCode, message: string) {
    super(message)
    this.name = 'TokenImportValidationError'
    this.code = code
  }
}

interface ImportContextPolicy {
  unit: TokenImportUnit
  source: TokenImportKeysetSource | 'either'
}

interface DecodedProofReference {
  tokenIndex: number
  proofIndex: number
  canonicalMintUrl: string
  encodedKeysetId: string
}

interface DecodedImportPreflight {
  canonicalMintUrls: string[]
  proofs: DecodedProofReference[]
  keysetsByMint: Map<string, Set<string>>
}

interface ClassifiedKeyset {
  resolvedKeysetId: string
  source: TokenImportKeysetSource
  activity: TokenImportKeysetActivity
}

interface ResolutionLifetime {
  signal: AbortSignal
  deadlineMs: number
  dispose(): void
}

interface ParsedKeysetId {
  kind: 'exact' | 'prefix'
  value: string
}

/**
 * Locally decodes Cashu tokens without fetching keyset metadata.
 *
 * Textual v4 tokens are base64url-decoded and passed to cashu-ts's binary
 * decoder so modern 8-byte keyset prefixes remain available for bounded
 * resolution. Legacy and non-v4 forms use the ordinary local decoder.
 */
export function decodeTokenImportLocally(encodedToken: string): Token {
  const text = unwrapCashuUriScheme(encodedToken)
  if (!text.startsWith('cashuB')) return getDecodedToken(encodedToken, [])

  const payload = decodeBase64Url(text.slice('cashuB'.length))
  const binary = new Uint8Array(5 + payload.length)
  binary.set([0x63, 0x72, 0x61, 0x77, 0x42])
  binary.set(payload, 5)
  return getDecodedTokenBinary(binary)
}

/**
 * Performs bounded metadata admission before any caller mutation.
 *
 * This does not establish proof signatures or unspentness. The caller must
 * pass `result.encodedToken` unchanged through Cashu receive and await mint
 * verification before crediting or persisting spendable balance.
 */
export async function validateTokenImport(
  input: ValidateTokenImportInput,
): Promise<ValidatedTokenImport> {
  const bounds = completeBounds(input.bounds)
  assertEncodedBound(input.encodedToken, bounds)
  const policy = contextPolicy(input.context)
  const decoded = await decodeToken(input.decode ?? decodeTokenImportLocally, input.encodedToken)
  return completeTokenImportValidation(input, decoded, bounds, policy, () => input.context)
}

/**
 * Admits ordinary sat, conditional CTF msat, or regular collateral msat for a
 * general product wallet without making the caller decode first. The decoded
 * unit selects the bounded policy; resolved keyset source selects one closed
 * context. Mixed regular/conditional msat imports fail closed.
 */
export async function validateProductWalletTokenImport(
  input: ValidateProductWalletTokenImportInput,
): Promise<ValidatedTokenImport> {
  const bounds = completeBounds(input.bounds)
  assertEncodedBound(input.encodedToken, bounds)
  const decoded = await decodeToken(input.decode ?? decodeTokenImportLocally, input.encodedToken)
  const policy = productWalletPolicy(decoded)
  return completeTokenImportValidation(input, decoded, bounds, policy, deriveProductWalletContext)
}

async function completeTokenImportValidation(
  input: ValidateProductWalletTokenImportInput,
  decoded: Token | readonly Token[],
  bounds: TokenImportBounds,
  policy: ImportContextPolicy,
  selectContext: (
    proofs: readonly ValidatedTokenImportProof[],
    unit: TokenImportUnit,
  ) => TokenImportContext,
): Promise<ValidatedTokenImport> {
  const preflight = preflightDecodedImport(decoded, policy, bounds, input)
  requireAllowedCanonicalMints(preflight.canonicalMintUrls, input.allowedCanonicalMintUrls)
  const lifetime = createResolutionLifetime(input.signal, bounds.resolverTimeoutMs)
  try {
    const classifications = await resolveAllKeysets(
      preflight.keysetsByMint,
      policy,
      bounds,
      lifetime,
      input.resolveKeysets,
    )
    const proofs = classifyProofs(preflight.proofs, classifications)
    const context = selectContext(proofs, policy.unit)
    return {
      encodedToken: input.encodedToken,
      context,
      unit: policy.unit,
      canonicalMintUrls: preflight.canonicalMintUrls,
      proofs,
      hasInactiveProofs: proofs.some((proof) => proof.activity === 'inactive'),
    }
  } finally {
    lifetime.dispose()
  }
}

function requireAllowedCanonicalMints(
  canonicalMintUrls: readonly string[],
  allowedCanonicalMintUrls: ReadonlySet<string> | undefined,
): void {
  if (allowedCanonicalMintUrls === undefined) return
  if (!allowedCanonicalMintUrls || typeof allowedCanonicalMintUrls.has !== 'function') {
    fail('invalid_bounds', 'allowed canonical mint URL set is invalid')
  }
  if (canonicalMintUrls.some((mintUrl) => !allowedCanonicalMintUrls.has(mintUrl))) {
    fail('mint_mismatch', 'cashu token mint does not match the allowed canonical mint set')
  }
}

async function decodeToken(
  decode: DecodeTokenImport,
  encodedToken: string,
): Promise<Token | readonly Token[]> {
  try {
    return await decode(encodedToken)
  } catch {
    throw new TokenImportValidationError('invalid_token', 'cashu token decoding failed')
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    fail('invalid_token', 'cashu v4 token has invalid base64url')
  }
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch {
    fail('invalid_token', 'cashu v4 token has invalid base64url')
  }
}

function unwrapCashuUriScheme(value: string): string {
  for (const prefix of ['web+cashu://', 'cashu://', 'cashu:']) {
    if (value.startsWith(prefix)) return value.slice(prefix.length)
  }
  return value
}

function completeBounds(overrides: Partial<TokenImportBounds> | undefined): TokenImportBounds {
  const bounds = { ...DEFAULT_TOKEN_IMPORT_BOUNDS, ...overrides }
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('invalid_bounds', `${name} must be a positive safe integer`)
    }
  }
  return bounds
}

function assertEncodedBound(encodedToken: string, bounds: TokenImportBounds): void {
  if (typeof encodedToken !== 'string') fail('invalid_token', 'encoded token must be a string')
  // UTF-8 byte length cannot be smaller than UTF-16 code-unit length.
  if (encodedToken.length > bounds.maxEncodedBytes) {
    fail('encoded_too_large', `encoded token exceeds ${bounds.maxEncodedBytes} bytes`)
  }
  if (new TextEncoder().encode(encodedToken).byteLength > bounds.maxEncodedBytes) {
    fail('encoded_too_large', `encoded token exceeds ${bounds.maxEncodedBytes} bytes`)
  }
}

function contextPolicy(context: TokenImportContext): ImportContextPolicy {
  switch (context) {
    case 'ordinary-sat':
      return { unit: 'sat', source: 'regular' }
    case 'ctf-position-msat':
      return { unit: 'msat', source: 'conditional' }
    case 'ctf-collateral-msat':
      return { unit: 'msat', source: 'regular' }
    default:
      return assertNever(context)
  }
}

function productWalletPolicy(decoded: Token | readonly Token[]): ImportContextPolicy {
  const tokens = Array.isArray(decoded) ? decoded : [decoded]
  if (tokens.length === 0) fail('invalid_token', 'decoded token set is empty')
  let unit: TokenImportUnit | undefined
  for (const [tokenIndex, token] of tokens.entries()) {
    if (!token || typeof token !== 'object') {
      fail('invalid_token', `decoded token ${tokenIndex} has an invalid shape`)
    }
    const tokenUnit = requireSupportedUnit(token.unit, `token ${tokenIndex}`)
    if (unit !== undefined && tokenUnit !== unit) {
      fail('unit_mismatch', 'decoded token set contains mixed units')
    }
    unit = tokenUnit
  }
  return unit === 'sat' ? { unit, source: 'regular' } : { unit: 'msat', source: 'either' }
}

function deriveProductWalletContext(
  proofs: readonly ValidatedTokenImportProof[],
  unit: TokenImportUnit,
): TokenImportContext {
  const sources = new Set(proofs.map((proof) => proof.source))
  if (sources.size !== 1) {
    fail('source_mismatch', 'product-wallet import contains mixed regular and conditional keysets')
  }
  const proof = proofs[0]
  if (!proof) fail('invalid_token', 'product-wallet import contains no proofs')
  if (proof.source === 'conditional') {
    if (unit !== 'msat') fail('source_mismatch', 'conditional sat keysets are not admissible')
    return 'ctf-position-msat'
  }
  return unit === 'sat' ? 'ordinary-sat' : 'ctf-collateral-msat'
}

function preflightDecodedImport(
  decoded: Token | readonly Token[],
  policy: ImportContextPolicy,
  bounds: TokenImportBounds,
  input: ValidateProductWalletTokenImportInput,
): DecodedImportPreflight {
  const tokens = Array.isArray(decoded) ? decoded : [decoded]
  if (tokens.length === 0) fail('invalid_token', 'decoded token set is empty')

  const proofs: DecodedProofReference[] = []
  const keysetsByMint = new Map<string, Set<string>>()
  for (const [tokenIndex, token] of tokens.entries()) {
    collectTokenPreflight(token, tokenIndex, policy, bounds, input, proofs, keysetsByMint)
  }
  return { canonicalMintUrls: [...keysetsByMint.keys()].sort(), proofs, keysetsByMint }
}

function collectTokenPreflight(
  token: Token,
  tokenIndex: number,
  policy: ImportContextPolicy,
  bounds: TokenImportBounds,
  input: ValidateProductWalletTokenImportInput,
  proofs: DecodedProofReference[],
  keysetsByMint: Map<string, Set<string>>,
): void {
  if (!token || typeof token !== 'object' || !Array.isArray(token.proofs)) {
    fail('invalid_token', `decoded token ${tokenIndex} has an invalid shape`)
  }
  if (token.proofs.length === 0) fail('invalid_token', `decoded token ${tokenIndex} has no proofs`)
  if (requireSupportedUnit(token.unit, `token ${tokenIndex}`) !== policy.unit) {
    fail('unit_mismatch', `token ${tokenIndex} unit does not match import context`)
  }
  const canonicalMintUrl = canonicalizeMintUrl(token.mint, input.allowInsecureLoopbackHttp === true)
  const mintKeysets = keysetsByMint.get(canonicalMintUrl) ?? new Set<string>()
  keysetsByMint.set(canonicalMintUrl, mintKeysets)
  enforceCountBounds(proofs.length, keysetsByMint, bounds)

  for (const [proofIndex, proof] of token.proofs.entries()) {
    const encodedKeysetId = requireEncodedKeysetId(proof?.id, tokenIndex, proofIndex)
    mintKeysets.add(encodedKeysetId)
    proofs.push({ tokenIndex, proofIndex, canonicalMintUrl, encodedKeysetId })
    enforceCountBounds(proofs.length, keysetsByMint, bounds)
  }
}

function enforceCountBounds(
  proofCount: number,
  keysetsByMint: Map<string, Set<string>>,
  bounds: TokenImportBounds,
): void {
  if (proofCount > bounds.maxProofs) {
    fail('proof_limit_exceeded', `decoded token exceeds ${bounds.maxProofs} proofs`)
  }
  if (keysetsByMint.size > bounds.maxMints) {
    fail('mint_limit_exceeded', `decoded token exceeds ${bounds.maxMints} mints`)
  }
  const keysetCount = [...keysetsByMint.values()].reduce((sum, ids) => sum + ids.size, 0)
  if (keysetCount > bounds.maxKeysets) {
    fail('keyset_limit_exceeded', `decoded token exceeds ${bounds.maxKeysets} keysets`)
  }
}

function createResolutionLifetime(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ResolutionLifetime {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const deadlineMs = Date.now() + timeoutMs
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    deadlineMs,
    dispose: () => {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

async function resolveAllKeysets(
  keysetsByMint: Map<string, Set<string>>,
  policy: ImportContextPolicy,
  bounds: TokenImportBounds,
  lifetime: ResolutionLifetime,
  resolver: ResolveTokenImportKeysets,
): Promise<Map<string, ClassifiedKeyset>> {
  const classifications = new Map<string, ClassifiedKeyset>()
  for (const [mintUrl, keysetIds] of keysetsByMint) {
    const request: TokenImportKeysetRequest = {
      canonicalMintUrl: mintUrl,
      encodedKeysetIds: [...keysetIds].sort(),
      signal: lifetime.signal,
      deadlineMs: lifetime.deadlineMs,
      maxCandidates: bounds.maxResolverCandidates,
    }
    const lookup = await callResolver(resolver, request)
    addLookupClassifications(lookup, request, policy, classifications)
  }
  return classifications
}

async function callResolver(
  resolver: ResolveTokenImportKeysets,
  request: TokenImportKeysetRequest,
): Promise<TokenImportKeysetLookup> {
  if (request.signal.aborted) {
    fail('keyset_resolution_indeterminate', 'keyset resolution was cancelled')
  }
  let removeAbortListener = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(
        new TokenImportValidationError(
          'keyset_resolution_indeterminate',
          'keyset resolution was cancelled',
        ),
      )
    request.signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => request.signal.removeEventListener('abort', onAbort)
  })
  try {
    const lookup = await Promise.race([resolver(request), aborted])
    if (request.signal.aborted) {
      fail('keyset_resolution_indeterminate', 'keyset resolution was cancelled')
    }
    return requireFreshLookup(lookup, request)
  } catch (error) {
    if (error instanceof TokenImportValidationError) throw error
    fail('keyset_resolution_indeterminate', 'keyset metadata could not be resolved')
  } finally {
    removeAbortListener()
  }
}

function requireFreshLookup(
  lookup: TokenImportKeysetLookup,
  request: TokenImportKeysetRequest,
): TokenImportKeysetLookup {
  if (!lookup || typeof lookup !== 'object') {
    fail('spoofed_keyset_metadata', 'keyset resolver returned invalid metadata')
  }
  if (lookup.freshness === 'stale') {
    fail('stale_keyset_metadata', `keyset metadata for ${request.canonicalMintUrl} is stale`)
  }
  if (lookup.freshness !== 'fresh') {
    fail('spoofed_keyset_metadata', 'keyset resolver returned invalid freshness metadata')
  }
  const count =
    (Array.isArray(lookup.regularKeysets) ? lookup.regularKeysets.length : 0) +
    (Array.isArray(lookup.conditionalKeysets) ? lookup.conditionalKeysets.length : 0)
  if (count > request.maxCandidates) {
    fail('resolver_response_too_large', 'keyset resolver returned too many candidates')
  }
  return lookup
}

function addLookupClassifications(
  lookup: TokenImportKeysetLookup,
  request: TokenImportKeysetRequest,
  policy: ImportContextPolicy,
  output: Map<string, ClassifiedKeyset>,
): void {
  const requested = new Map(
    request.encodedKeysetIds.map((id) => [id, parseEncodedKeysetId(id)] as const),
  )
  const candidates = [
    ...parseCandidates(lookup.regularKeysets, 'regular', requested, policy),
    ...parseCandidates(lookup.conditionalKeysets, 'conditional', requested, policy),
  ]
  for (const [encodedId, parsed] of requested) {
    const matches = candidates.filter((candidate) => keysetMatches(parsed, candidate.keysetId))
    if (matches.length === 0) fail('unknown_keyset', `mint did not return keyset ${encodedId}`)
    if (matches.length > 1) fail('ambiguous_keyset', `keyset ${encodedId} is ambiguous`)
    const match = matches[0]!
    output.set(classificationKey(request.canonicalMintUrl, encodedId), {
      resolvedKeysetId: match.keysetId,
      source: match.source,
      activity: match.active ? 'active' : 'inactive',
    })
  }
}

function parseCandidates(
  metadata: readonly TokenImportKeysetMetadata[],
  source: TokenImportKeysetSource,
  requested: ReadonlyMap<string, ParsedKeysetId>,
  policy: ImportContextPolicy,
): Array<TokenImportKeysetMetadata & { source: TokenImportKeysetSource; active: boolean }> {
  if (!Array.isArray(metadata)) fail('spoofed_keyset_metadata', `${source} metadata is invalid`)
  return metadata.map((item) => {
    const keysetId = requireCandidateKeysetId(item?.keysetId, source)
    if (![...requested.values()].some((request) => keysetMatches(request, keysetId))) {
      fail('spoofed_keyset_metadata', `${source} metadata contains an unrequested keyset`)
    }
    if (requireSupportedUnit(item.unit, `${source} keyset ${keysetId}`) !== policy.unit) {
      fail('unit_mismatch', `${source} keyset ${keysetId} unit does not match import context`)
    }
    if (policy.source !== 'either' && source !== policy.source) {
      fail('source_mismatch', `${source} keyset is not admissible in this import context`)
    }
    if (typeof item.active !== 'boolean') {
      fail('spoofed_keyset_metadata', `${source} keyset ${keysetId} has invalid activity`)
    }
    return { ...item, keysetId, source, active: item.active }
  })
}

function classifyProofs(
  proofs: readonly DecodedProofReference[],
  classifications: ReadonlyMap<string, ClassifiedKeyset>,
): ValidatedTokenImportProof[] {
  return proofs.map((proof) => {
    const classification = classifications.get(
      classificationKey(proof.canonicalMintUrl, proof.encodedKeysetId),
    )
    if (!classification) fail('unknown_keyset', `keyset ${proof.encodedKeysetId} is unclassified`)
    return { ...proof, ...classification }
  })
}

function requireEncodedKeysetId(value: unknown, tokenIndex: number, proofIndex: number): string {
  if (typeof value !== 'string') {
    fail('invalid_token', `token ${tokenIndex} proof ${proofIndex} has no keyset id`)
  }
  parseEncodedKeysetId(value)
  return value
}

function parseEncodedKeysetId(value: string): ParsedKeysetId {
  if (isLegacyKeysetId(value)) return { kind: 'exact', value }
  if (!isLowerHex(value)) fail('invalid_token', 'proof keyset id has invalid encoding or case')
  if (value.length === 16) {
    return { kind: value.startsWith('00') ? 'exact' : 'prefix', value }
  }
  if (value.length === 66 && !value.startsWith('00')) return { kind: 'exact', value }
  fail('invalid_token', 'proof keyset id has an invalid length')
}

function requireCandidateKeysetId(value: unknown, source: TokenImportKeysetSource): string {
  if (typeof value !== 'string') {
    fail('spoofed_keyset_metadata', `${source} metadata has no keyset id`)
  }
  if (isLegacyKeysetId(value)) return value
  if (!isLowerHex(value)) {
    fail('spoofed_keyset_metadata', `${source} keyset id has invalid encoding or case`)
  }
  if (value.length === 16 && value.startsWith('00')) return value
  if (value.length === 66 && !value.startsWith('00')) return value
  fail('spoofed_keyset_metadata', `${source} keyset id has an invalid length`)
}

function keysetMatches(request: ParsedKeysetId, candidate: string): boolean {
  return request.kind === 'exact'
    ? candidate === request.value
    : candidate.startsWith(request.value)
}

function isLowerHex(value: string): boolean {
  return /^[0-9a-f]+$/.test(value)
}

function isLegacyKeysetId(value: string): boolean {
  return value.length === 12 && /^[A-Za-z0-9_-]+$/.test(value)
}

function canonicalizeMintUrl(value: unknown, allowInsecureLoopbackHttp: boolean): string {
  if (typeof value !== 'string' || !value) fail('invalid_token', 'token mint URL is missing')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('invalid_token', 'token mint URL is invalid')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.includes('?') ||
    url.href.includes('#') ||
    /%[0-9a-f]{2}/i.test(url.pathname)
  ) {
    fail('invalid_token', 'token mint URL is not an admissible mint identity')
  }
  if (!url.hostname.startsWith('[') && url.hostname.endsWith('.')) {
    const canonicalHostname = url.hostname.replace(/\.+$/, '')
    if (!canonicalHostname) fail('invalid_token', 'token mint URL has no hostname')
    url.hostname = canonicalHostname
  }
  enforceMintTargetPolicy(url, allowInsecureLoopbackHttp)
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '' ? '' : path}`
}

function enforceMintTargetPolicy(url: URL, allowInsecureLoopbackHttp: boolean): void {
  const target = classifyLiteralHost(url.hostname)
  if (target === 'private' || target === 'link-local') {
    fail('private_mint_url', 'mint URL uses a private or link-local address')
  }
  if (target === 'loopback') {
    if (url.protocol === 'http:' && allowInsecureLoopbackHttp) return
    if (url.protocol === 'http:') {
      fail('insecure_mint_url', 'loopback HTTP requires explicit development permission')
    }
    fail('private_mint_url', 'mint URL uses a loopback address')
  }
  if (url.protocol === 'https:') return
  if (url.protocol !== 'http:') fail('insecure_mint_url', 'mint URL must use HTTPS')
  fail('insecure_mint_url', 'HTTP is permitted only for explicitly allowed loopback development')
}

function classifyLiteralHost(
  hostname: string,
): 'name' | 'public' | 'loopback' | 'private' | 'link-local' {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  const ipv4 = parseIpv4(host)
  if (ipv4) return classifyIpv4(ipv4)
  const ipv6 = parseIpv6(host)
  if (!ipv6) return 'name'
  if (ipv6.every((word, index) => word === (index === 7 ? 1 : 0))) return 'loopback'
  const embeddedIpv4 = embeddedIpv4Words(ipv6)
  if (embeddedIpv4) return classifyIpv4(embeddedIpv4)
  if ((ipv6[0]! & 0xfe00) === 0xfc00 || ipv6.every((word) => word === 0)) return 'private'
  if ((ipv6[0]! & 0xffc0) === 0xfe80) return 'link-local'
  if ((ipv6[0]! & 0xffc0) === 0xfec0) return 'private'
  return 'public'
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null
  const values = parts.map(Number)
  return values.every((part) => part >= 0 && part <= 255) ? values : null
}

function classifyIpv4(parts: number[]): 'public' | 'loopback' | 'private' | 'link-local' {
  const [a, b] = parts
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local'
  if (
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  ) {
    return 'private'
  }
  return 'public'
}

function parseIpv6(host: string): number[] | null {
  if (!host.includes(':') || host.includes('%')) return null
  const halves = host.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const missing = 8 - left.length - right.length
  if (missing < (halves.length === 2 ? 1 : 0)) return null
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null
  return words.map((word) => Number.parseInt(word, 16))
}

function embeddedIpv4Words(ipv6: number[]): number[] | null {
  const firstFiveZero = ipv6.slice(0, 5).every((word) => word === 0)
  const mapped = firstFiveZero && ipv6[5] === 0xffff
  const compatible = ipv6.slice(0, 6).every((word) => word === 0)
  if (!mapped && !compatible) return null
  return [ipv6[6]! >> 8, ipv6[6]! & 0xff, ipv6[7]! >> 8, ipv6[7]! & 0xff]
}

function requireSupportedUnit(value: unknown, subject: string): TokenImportUnit {
  switch (value) {
    case 'sat':
      return 'sat'
    case 'msat':
      return 'msat'
    default:
      fail('unsupported_unit', `${subject} has missing or unsupported unit metadata`)
  }
}

function classificationKey(mintUrl: string, encodedKeysetId: string): string {
  return `${mintUrl}\u0000${encodedKeysetId}`
}

function assertNever(value: never): never {
  throw new TokenImportValidationError('invalid_token', `unknown import context: ${String(value)}`)
}

function fail(code: TokenImportValidationErrorCode, message: string): never {
  throw new TokenImportValidationError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
