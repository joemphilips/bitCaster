import type { Token } from '@cashu/cashu-ts'

/**
 * The browser already applies a 100 KiB paste limit. Keeping that as the shared
 * default bounds decode work and resolver fan-out consistently. At that size,
 * 512 proofs is already a conservative upper bound for ordinary encoded Cashu
 * proofs; 128 distinct keysets and 8 canonical mints separately bound metadata
 * lookup fan-out for alternate/legacy decoders. Native clients may opt into a
 * larger encoded limit, but must still choose explicit count limits before
 * accepting network or persistence work.
 */
export const DEFAULT_TOKEN_IMPORT_BOUNDS: Readonly<TokenImportBounds> = Object.freeze({
  maxEncodedBytes: 100 * 1_024,
  maxProofs: 512,
  maxMints: 8,
  maxKeysets: 128,
})

export type TokenImportUnit = 'sat' | 'msat'
export type TokenImportKeysetSource = 'regular' | 'conditional'
export type TokenImportKeysetActivity = 'active' | 'inactive'

export interface TokenImportBounds {
  maxEncodedBytes: number
  maxProofs: number
  maxMints: number
  maxKeysets: number
}

export interface TokenImportKeysetMetadata {
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
  keysetIds: readonly string[]
}

export type DecodeTokenImport = (
  encodedToken: string,
) => Token | readonly Token[] | Promise<Token | readonly Token[]>

export type ResolveTokenImportKeysets = (
  request: TokenImportKeysetRequest,
) => Promise<TokenImportKeysetLookup>

export interface ValidateTokenImportInput {
  encodedToken: string
  contextUnit: TokenImportUnit
  /** A local, side-effect-free parser. It must never perform network I/O. */
  decode: DecodeTokenImport
  resolveKeysets: ResolveTokenImportKeysets
  bounds?: Partial<TokenImportBounds>
}

export interface ValidatedTokenImportProof {
  tokenIndex: number
  proofIndex: number
  canonicalMintUrl: string
  keysetId: string
  source: TokenImportKeysetSource
  activity: TokenImportKeysetActivity
}

export interface ValidatedTokenImport {
  /** The exact caller-provided bearer token; never trim or re-encode it. */
  encodedToken: string
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
  | 'stale_keyset_metadata'
  | 'keyset_resolution_indeterminate'
  | 'unknown_keyset'
  | 'spoofed_keyset_metadata'

export class TokenImportValidationError extends Error {
  readonly code: TokenImportValidationErrorCode

  constructor(code: TokenImportValidationErrorCode, message: string) {
    super(message)
    this.name = 'TokenImportValidationError'
    this.code = code
  }
}

interface DecodedProofReference {
  tokenIndex: number
  proofIndex: number
  canonicalMintUrl: string
  keysetId: string
}

interface DecodedImportPreflight {
  unit: TokenImportUnit
  canonicalMintUrls: string[]
  proofs: DecodedProofReference[]
  keysetsByMint: Map<string, Set<string>>
}

interface ClassifiedKeyset {
  source: TokenImportKeysetSource
  activity: TokenImportKeysetActivity
}

/**
 * Performs bounded metadata admission before any caller mutation.
 *
 * This does not establish proof signatures or unspentness. A caller must pass
 * `result.encodedToken` unchanged through the Cashu wallet's receive protocol
 * and wait for mint verification before crediting or persisting spendable
 * balance.
 */
export async function validateTokenImport(
  input: ValidateTokenImportInput,
): Promise<ValidatedTokenImport> {
  const bounds = completeBounds(input.bounds)
  assertEncodedBound(input.encodedToken, bounds)
  const contextUnit = requireSupportedUnit(input.contextUnit, 'import context')
  const decoded = await decodeToken(input.decode, input.encodedToken)
  const preflight = preflightDecodedImport(decoded, contextUnit, bounds)
  const classifications = await resolveAllKeysets(
    preflight.keysetsByMint,
    preflight.unit,
    input.resolveKeysets,
  )
  const proofs = classifyProofs(preflight.proofs, classifications)
  return {
    encodedToken: input.encodedToken,
    unit: preflight.unit,
    canonicalMintUrls: preflight.canonicalMintUrls,
    proofs,
    hasInactiveProofs: proofs.some((proof) => proof.activity === 'inactive'),
  }
}

async function decodeToken(
  decode: DecodeTokenImport,
  encodedToken: string,
): Promise<Token | readonly Token[]> {
  try {
    return await decode(encodedToken)
  } catch (error) {
    void error
    throw new TokenImportValidationError('invalid_token', 'cashu token decoding failed')
  }
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
  // UTF-8 byte length is never smaller than JavaScript's UTF-16 code-unit
  // length. Reject that cheap lower bound before allocating an encoded copy.
  if (encodedToken.length > bounds.maxEncodedBytes) {
    fail('encoded_too_large', `encoded token exceeds ${bounds.maxEncodedBytes} bytes`)
  }
  const encodedBytes = new TextEncoder().encode(encodedToken).byteLength
  if (encodedBytes > bounds.maxEncodedBytes) {
    fail('encoded_too_large', `encoded token exceeds ${bounds.maxEncodedBytes} bytes`)
  }
}

function preflightDecodedImport(
  decoded: Token | readonly Token[],
  contextUnit: TokenImportUnit,
  bounds: TokenImportBounds,
): DecodedImportPreflight {
  const tokens = Array.isArray(decoded) ? decoded : [decoded]
  if (tokens.length === 0) fail('invalid_token', 'decoded token set is empty')

  const proofs: DecodedProofReference[] = []
  const keysetsByMint = new Map<string, Set<string>>()
  for (const [tokenIndex, token] of tokens.entries()) {
    collectTokenPreflight(token, tokenIndex, contextUnit, bounds, proofs, keysetsByMint)
  }
  return {
    unit: contextUnit,
    canonicalMintUrls: [...keysetsByMint.keys()].sort(),
    proofs,
    keysetsByMint,
  }
}

function collectTokenPreflight(
  token: Token,
  tokenIndex: number,
  contextUnit: TokenImportUnit,
  bounds: TokenImportBounds,
  proofs: DecodedProofReference[],
  keysetsByMint: Map<string, Set<string>>,
): void {
  if (!token || typeof token !== 'object' || !Array.isArray(token.proofs)) {
    fail('invalid_token', `decoded token ${tokenIndex} has an invalid shape`)
  }
  if (token.proofs.length === 0) {
    fail('invalid_token', `decoded token ${tokenIndex} contains no proofs`)
  }
  const tokenUnit = requireSupportedUnit(token.unit, `token ${tokenIndex}`)
  if (tokenUnit !== contextUnit) {
    fail('unit_mismatch', `token ${tokenIndex} unit does not match import context`)
  }
  const canonicalMintUrl = canonicalizeMintUrl(token.mint)
  const mintKeysets = keysetsByMint.get(canonicalMintUrl) ?? new Set<string>()
  keysetsByMint.set(canonicalMintUrl, mintKeysets)
  enforceCountBounds(proofs.length, keysetsByMint, bounds)

  for (const [proofIndex, proof] of token.proofs.entries()) {
    if (!proof || typeof proof !== 'object' || typeof proof.id !== 'string' || !proof.id) {
      fail('invalid_token', `token ${tokenIndex} proof ${proofIndex} has no keyset id`)
    }
    mintKeysets.add(proof.id)
    proofs.push({ tokenIndex, proofIndex, canonicalMintUrl, keysetId: proof.id })
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

async function resolveAllKeysets(
  keysetsByMint: Map<string, Set<string>>,
  expectedUnit: TokenImportUnit,
  resolver: ResolveTokenImportKeysets,
): Promise<Map<string, ClassifiedKeyset>> {
  const classifications = new Map<string, ClassifiedKeyset>()
  for (const [mintUrl, keysetIds] of keysetsByMint) {
    const request = { canonicalMintUrl: mintUrl, keysetIds: [...keysetIds].sort() }
    const lookup = await callResolver(resolver, request)
    addLookupClassifications(lookup, request, expectedUnit, classifications)
  }
  return classifications
}

async function callResolver(
  resolver: ResolveTokenImportKeysets,
  request: TokenImportKeysetRequest,
): Promise<TokenImportKeysetLookup> {
  try {
    const lookup = await resolver(request)
    if (!lookup || typeof lookup !== 'object') {
      fail('spoofed_keyset_metadata', 'keyset resolver returned invalid metadata')
    }
    switch (lookup.freshness) {
      case 'fresh':
        return lookup
      case 'stale':
        fail('stale_keyset_metadata', `keyset metadata for ${request.canonicalMintUrl} is stale`)
      default:
        fail('spoofed_keyset_metadata', 'keyset resolver returned invalid freshness metadata')
    }
  } catch (error) {
    if (error instanceof TokenImportValidationError) throw error
    void error
    throw new TokenImportValidationError(
      'keyset_resolution_indeterminate',
      `keyset metadata for ${request.canonicalMintUrl} could not be resolved`,
    )
  }
}

function addLookupClassifications(
  lookup: TokenImportKeysetLookup,
  request: TokenImportKeysetRequest,
  expectedUnit: TokenImportUnit,
  output: Map<string, ClassifiedKeyset>,
): void {
  const requested = new Set(request.keysetIds)
  addMetadataList(lookup.regularKeysets, 'regular', request, requested, expectedUnit, output)
  addMetadataList(
    lookup.conditionalKeysets,
    'conditional',
    request,
    requested,
    expectedUnit,
    output,
  )
  for (const keysetId of requested) {
    if (!output.has(classificationKey(request.canonicalMintUrl, keysetId))) {
      fail('unknown_keyset', `mint did not return keyset metadata for ${keysetId}`)
    }
  }
}

function addMetadataList(
  metadata: readonly TokenImportKeysetMetadata[],
  source: TokenImportKeysetSource,
  request: TokenImportKeysetRequest,
  requested: Set<string>,
  expectedUnit: TokenImportUnit,
  output: Map<string, ClassifiedKeyset>,
): void {
  if (!Array.isArray(metadata)) fail('spoofed_keyset_metadata', `${source} metadata is invalid`)
  for (const item of metadata) {
    if (!item || typeof item.keysetId !== 'string' || !requested.has(item.keysetId)) {
      fail('spoofed_keyset_metadata', `${source} metadata contains an unrequested keyset`)
    }
    const unit = requireSupportedUnit(item.unit, `${source} keyset ${item.keysetId}`)
    if (unit !== expectedUnit) {
      fail('unit_mismatch', `${source} keyset ${item.keysetId} unit does not match import context`)
    }
    if (typeof item.active !== 'boolean') {
      fail('spoofed_keyset_metadata', `${source} keyset ${item.keysetId} has invalid activity`)
    }
    const key = classificationKey(request.canonicalMintUrl, item.keysetId)
    if (output.has(key)) {
      fail('spoofed_keyset_metadata', `keyset ${item.keysetId} has ambiguous metadata`)
    }
    output.set(key, { source, activity: item.active ? 'active' : 'inactive' })
  }
}

function classifyProofs(
  proofs: readonly DecodedProofReference[],
  classifications: ReadonlyMap<string, ClassifiedKeyset>,
): ValidatedTokenImportProof[] {
  return proofs.map((proof) => {
    const classification = classifications.get(
      classificationKey(proof.canonicalMintUrl, proof.keysetId),
    )
    if (!classification) fail('unknown_keyset', `keyset ${proof.keysetId} was not classified`)
    return { ...proof, ...classification }
  })
}

function canonicalizeMintUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) fail('invalid_token', 'token mint URL is missing')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('invalid_token', 'token mint URL is invalid')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail('invalid_token', 'token mint URL is not an admissible mint identity')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '' ? '' : path}`
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

function classificationKey(mintUrl: string, keysetId: string): string {
  return `${mintUrl}\u0000${keysetId}`
}

function fail(code: TokenImportValidationErrorCode, message: string): never {
  throw new TokenImportValidationError(code, message)
}
