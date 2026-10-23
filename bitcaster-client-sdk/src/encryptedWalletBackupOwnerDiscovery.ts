import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  encodeCanonicalBackupCbor as cbor,
  preflightEncryptedBackupOwnerDiscoveryCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  deriveEncryptedWalletBackupOwnerScope,
  type EncryptedWalletBackupOwnerScope,
} from './encryptedWalletBackupOwnerScope.ts'
import {
  equalBytes,
  requireBytes,
  requireInteger,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'
import {
  encryptedWalletBackupOwnerRequestDigest,
  requireIssuedEncryptedWalletBackupOwnerRequest,
  requireVerifiedEncryptedWalletBackupOwnerRequest,
  type EncryptedWalletBackupOwnerRequestProof,
  type VerifiedEncryptedWalletBackupOwnerRequest,
} from './encryptedWalletBackupOwnerRequestProof.ts'

export interface EncryptedWalletBackupOwnerCandidate extends EncryptedWalletBackupOwnerScope {
  readonly enrollmentEpoch: number
}
export interface EncryptedWalletBackupOwnerDiscoveryPage {
  readonly formatVersion: 2
  readonly requestDigest: string
  readonly realm: string
  readonly walletId: string
  readonly requestAuthPublicKey: string
  readonly requestedCursor: string | null
  readonly entries: readonly EncryptedWalletBackupOwnerCandidate[]
  readonly nextCursor: string | null
  readonly firstAccountOwnerScopeId: string | null
}
const VERIFIED_PAGES = new WeakMap<object, EncryptedWalletBackupOwnerRequestProof>()
const cursor = (v: unknown): string | null =>
  v === null ? null : requireLowerHex(v, 32, 'owner cursor')
function entries(
  values: readonly EncryptedWalletBackupOwnerCandidate[],
  after: string | null,
  next: string | null,
): readonly EncryptedWalletBackupOwnerCandidate[] {
  if (!Array.isArray(values) || values.length > 16) throw new Error('backup owner page size')
  const result = values.map((v) => {
    if (
      typeof v !== 'object' ||
      v === null ||
      Object.keys(v).sort().join(',') !==
        'authorizationScheme,enrollmentEpoch,ownerScopeId,ownerSubject'
    )
      throw new Error('backup owner candidate shape')
    const owner = deriveEncryptedWalletBackupOwnerScope(v)
    if (owner.ownerScopeId !== v.ownerScopeId) throw new Error('backup owner identifier mismatch')
    return Object.freeze({
      ...owner,
      enrollmentEpoch: requireInteger(v.enrollmentEpoch, 1, 'owner epoch'),
    })
  })
  if (
    result.some(
      (v, i) =>
        (after !== null && v.ownerScopeId <= after) ||
        (i > 0 && v.ownerScopeId <= result[i - 1]!.ownerScopeId),
    )
  )
    throw new Error('backup owner page order')
  if (next !== null && (result.length === 0 || next !== result[result.length - 1]!.ownerScopeId))
    throw new Error('backup owner next cursor')
  return Object.freeze(result)
}
function wire(page: EncryptedWalletBackupOwnerDiscoveryPage): Uint8Array {
  const bytes = cbor([
    2,
    'backup-owner-discovery-page',
    hexToBytes(page.requestDigest),
    page.realm,
    hexToBytes(page.walletId),
    hexToBytes(page.requestAuthPublicKey),
    page.requestedCursor,
    page.entries.map((v) => [
      hexToBytes(v.ownerScopeId),
      v.authorizationScheme,
      v.ownerSubject,
      v.enrollmentEpoch,
    ]),
    page.nextCursor,
    page.firstAccountOwnerScopeId === null ? null : hexToBytes(page.firstAccountOwnerScopeId),
  ])
  preflightEncryptedBackupOwnerDiscoveryCbor(bytes)
  return bytes
}
/** Server codec. Verified request is not a substitute for the indexed enrollment query. */
export function encodeEncryptedWalletBackupOwnerDiscoveryPage(input: {
  request: VerifiedEncryptedWalletBackupOwnerRequest
  entries: readonly EncryptedWalletBackupOwnerCandidate[]
  nextCursor: string | null
  firstAccountOwnerScopeId: string | null
}): Uint8Array {
  const request = requireVerifiedEncryptedWalletBackupOwnerRequest(input.request)
  if (request.route.operation !== 'owner-discovery') throw new Error('backup owner page purpose')
  const after = cursor(request.route.requestedCursor),
    next = cursor(input.nextCursor)
  return wire({
    formatVersion: 2,
    requestDigest: request.requestDigest,
    realm: request.claims.realm,
    walletId: request.claims.walletId,
    requestAuthPublicKey: request.claims.requestAuthPublicKey,
    requestedCursor: after,
    entries: entries(input.entries, after, next),
    nextCursor: next,
    firstAccountOwnerScopeId: cursor(input.firstAccountOwnerScopeId),
  })
}
/** Exact request binding over the authenticated transport; this page has no service signature. */
export function verifyEncryptedWalletBackupOwnerDiscoveryPage(input: {
  bytes: Uint8Array
  request: EncryptedWalletBackupOwnerRequestProof
}): EncryptedWalletBackupOwnerDiscoveryPage {
  const route = requireIssuedEncryptedWalletBackupOwnerRequest(input.request)
  if (route.operation !== 'owner-discovery') throw new Error('backup owner page purpose')
  preflightEncryptedBackupOwnerDiscoveryCbor(input.bytes)
  const t = decode(input.bytes)
  if (
    !Array.isArray(t) ||
    t.length !== 10 ||
    t[0] !== 2 ||
    t[1] !== 'backup-owner-discovery-page' ||
    !equalBytes(input.bytes, cbor(t))
  )
    throw new Error('backup owner page encoding')
  const h = (v: unknown) => bytesToHex(requireBytes(v, 32, 32, 'owner page digest'))
  const requestDigest = h(t[2]),
    realm = requireRealm(t[3]),
    walletId = h(t[4]),
    requestAuthPublicKey = h(t[5]),
    after = cursor(t[6]),
    next = cursor(t[8])
  if (
    requestDigest !== encryptedWalletBackupOwnerRequestDigest(input.request) ||
    realm !== input.request.realm ||
    walletId !== input.request.walletId ||
    requestAuthPublicKey !== input.request.requestAuthPublicKey ||
    after !== route.requestedCursor
  )
    throw new Error('backup owner page request binding')
  if (!Array.isArray(t[7]) || t[7].length > 16) throw new Error('backup owner page size')
  const candidates = t[7].map((v: unknown) => {
    if (!Array.isArray(v) || v.length !== 4) throw new Error('backup owner candidate encoding')
    return {
      ownerScopeId: h(v[0]),
      authorizationScheme: v[1],
      ownerSubject: v[2],
      enrollmentEpoch: v[3],
    } as EncryptedWalletBackupOwnerCandidate
  })
  const page = Object.freeze({
    formatVersion: 2 as const,
    requestDigest,
    realm,
    walletId,
    requestAuthPublicKey,
    requestedCursor: after,
    entries: entries(candidates, after, next),
    nextCursor: next,
    firstAccountOwnerScopeId: t[9] === null ? null : h(t[9]),
  })
  VERIFIED_PAGES.set(page, input.request)
  return page
}
export function uniqueEncryptedWalletBackupOwnerCandidate(
  page: EncryptedWalletBackupOwnerDiscoveryPage,
): EncryptedWalletBackupOwnerCandidate | null {
  const request = VERIFIED_PAGES.get(page)
  if (request === undefined) throw new Error('backup owner page is not verified')
  requireIssuedEncryptedWalletBackupOwnerRequest(request)
  return page.requestedCursor === null && page.entries.length === 1 && page.nextCursor === null
    ? page.entries[0]!
    : null
}

export class EncryptedWalletBackupOwnerSelectionError extends Error {
  readonly code: 'selection-required' | 'selection-incomplete' | 'owner-not-listed'
  constructor(code: EncryptedWalletBackupOwnerSelectionError['code']) {
    super(`encrypted backup owner selection failed: ${code}`)
    this.name = 'EncryptedWalletBackupOwnerSelectionError'
    this.code = code
  }
}

/** Selects only an explicitly named owner from a complete verified first page. */
export function selectEncryptedWalletBackupOwnerCandidate(input: {
  readonly page: EncryptedWalletBackupOwnerDiscoveryPage
  readonly ownerScopeId: string | null
}): EncryptedWalletBackupOwnerCandidate {
  const request = VERIFIED_PAGES.get(input.page)
  if (request === undefined) throw new Error('backup owner page is not verified')
  requireIssuedEncryptedWalletBackupOwnerRequest(request)
  if (input.page.requestedCursor !== null || input.page.nextCursor !== null)
    throw new EncryptedWalletBackupOwnerSelectionError('selection-incomplete')
  if (input.ownerScopeId === null)
    throw new EncryptedWalletBackupOwnerSelectionError('selection-required')
  const selected = input.page.entries.find((entry) => entry.ownerScopeId === input.ownerScopeId)
  if (selected === undefined) throw new EncryptedWalletBackupOwnerSelectionError('owner-not-listed')
  return selected
}

/** Validates one complete bounded set of exact issued-request-bound pages. */
export function validateEncryptedWalletBackupOwnerDiscoveryPages(
  pages: readonly EncryptedWalletBackupOwnerDiscoveryPage[],
): Readonly<{
  firstAccountOwnerScopeId: string | null
  entries: readonly EncryptedWalletBackupOwnerCandidate[]
}> {
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 64)
    throw new EncryptedWalletBackupOwnerSelectionError('selection-incomplete')
  let after: string | null = null
  let tuple: readonly [string, string, string] | null = null
  let previousOwner: string | null = null
  let binding: string | null | undefined
  const collected: EncryptedWalletBackupOwnerCandidate[] = []
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!
    const request = VERIFIED_PAGES.get(page)
    if (request === undefined) throw new Error('backup owner page is not verified')
    requireIssuedEncryptedWalletBackupOwnerRequest(request)
    const identity = [page.realm, page.walletId, page.requestAuthPublicKey] as const
    if (
      (binding !== undefined && binding !== page.firstAccountOwnerScopeId) ||
      page.requestedCursor !== after ||
      (tuple !== null && tuple.some((value, i) => value !== identity[i])) ||
      (index > 0 && pages[index - 1]!.nextCursor === null)
    )
      throw new EncryptedWalletBackupOwnerSelectionError('selection-incomplete')
    tuple = identity
    binding = page.firstAccountOwnerScopeId
    for (const candidate of page.entries) {
      if (previousOwner !== null && candidate.ownerScopeId <= previousOwner)
        throw new EncryptedWalletBackupOwnerSelectionError('selection-incomplete')
      previousOwner = candidate.ownerScopeId
      collected.push(candidate)
    }
    after = page.nextCursor
  }
  if (after !== null) throw new EncryptedWalletBackupOwnerSelectionError('selection-incomplete')
  if (binding === undefined)
    throw new EncryptedWalletBackupOwnerSelectionError('selection-incomplete')
  return Object.freeze({ firstAccountOwnerScopeId: binding, entries: Object.freeze(collected) })
}

/** Selects only a named owner; the browser first-account path does not use this API. */
export function selectEncryptedWalletBackupOwnerCandidateFromPages(input: {
  readonly pages: readonly EncryptedWalletBackupOwnerDiscoveryPage[]
  readonly ownerScopeId: string | null
}): EncryptedWalletBackupOwnerCandidate {
  const validated = validateEncryptedWalletBackupOwnerDiscoveryPages(input.pages)
  if (input.ownerScopeId === null)
    throw new EncryptedWalletBackupOwnerSelectionError('selection-required')
  const selected = validated.entries.find(
    (candidate) => candidate.ownerScopeId === input.ownerScopeId,
  )
  if (selected === undefined) throw new EncryptedWalletBackupOwnerSelectionError('owner-not-listed')
  return selected
}

export class EncryptedWalletBackupFirstAccountError extends Error {
  readonly code: 'account-required' | 'wrong-account' | 'incompatible-discovery'
  constructor(code: EncryptedWalletBackupFirstAccountError['code']) {
    super(`encrypted backup first-account resolution failed: ${code}`)
    this.name = 'EncryptedWalletBackupFirstAccountError'
    this.code = code
  }
}

export type EncryptedWalletBackupFirstAccountResolution =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'inactive'; ownerScopeId: string }>
  | Readonly<{ kind: 'active'; owner: EncryptedWalletBackupOwnerCandidate }>

/** Resolve only complete issued-request-bound pages. Never discover or adopt another owner. */
export function resolveEncryptedWalletBackupFirstAccount(input: {
  pages: readonly EncryptedWalletBackupOwnerDiscoveryPage[]
  authenticatedOwner: EncryptedWalletBackupOwnerScope | null
}): EncryptedWalletBackupFirstAccountResolution {
  const validated = validateEncryptedWalletBackupOwnerDiscoveryPages(input.pages)
  const binding = validated.firstAccountOwnerScopeId
  const candidates = validated.entries
  if (
    candidates.length > 1 ||
    (binding === null && candidates.length !== 0) ||
    candidates.some((candidate) => candidate.ownerScopeId !== binding)
  )
    throw new EncryptedWalletBackupFirstAccountError('incompatible-discovery')
  if (input.authenticatedOwner === null)
    throw new EncryptedWalletBackupFirstAccountError('account-required')
  const expected = deriveEncryptedWalletBackupOwnerScope(input.authenticatedOwner)
  if (expected.ownerScopeId !== input.authenticatedOwner.ownerScopeId)
    throw new Error('backup account scope is invalid')
  if (binding === null) return Object.freeze({ kind: 'absent' })
  if (binding !== expected.ownerScopeId)
    throw new EncryptedWalletBackupFirstAccountError('wrong-account')
  const owner = candidates[0]
  return owner === undefined
    ? Object.freeze({ kind: 'inactive', ownerScopeId: binding })
    : Object.freeze({ kind: 'active', owner })
}
