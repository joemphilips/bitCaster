import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  decodeBundleSet,
  objectCount,
  cursor,
  positive,
  bounded,
  exactRecord,
  equalBytes,
  toHex,
} from './encryptedWalletBackupAuthorityValidation.ts'
import {
  cloneEncryptedWalletBackupV2BundleDescriptor,
  digestEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  hexToBytesStrict,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'

/** Durable authority version. It does not change encrypted bundle or key formats. */
export const ENCRYPTED_WALLET_BACKUP_OWNER_AUTHORITY_VERSION = 3 as const
export interface EncryptedWalletBackupOwnerContext {
  readonly ownerScopeId: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
}
export interface EncryptedWalletBackupOwnerCurrentHead extends EncryptedWalletBackupOwnerContext {
  readonly formatVersion: 3
  readonly headVersion: number
  readonly activeBundleCount: number
  readonly activeObjectCount: number
  readonly activeSetDigest: string
}
export interface EncryptedWalletBackupOwnerDescriptorPage {
  readonly head: EncryptedWalletBackupOwnerCurrentHead
  readonly afterBundleId: string | null
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
  readonly nextAfterBundleId: string | null
}
export interface EncryptedWalletBackupOwnerCollectedHeadEvidence {
  readonly head: EncryptedWalletBackupOwnerCurrentHead
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
}
const COLLECTED = new WeakSet<object>()
const CONTEXT_FIELDS = ['ownerScopeId', 'realm', 'walletId', 'enrollmentEpoch'] as const
export function decodeEncryptedWalletBackupOwnerContext(
  value: unknown,
): EncryptedWalletBackupOwnerContext {
  const raw = exactRecord(value, CONTEXT_FIELDS)
  return Object.freeze({
    ownerScopeId: requireLowerHex(raw.ownerScopeId, 32, 'owner scope id'),
    realm: requireRealm(raw.realm),
    walletId: requireLowerHex(raw.walletId, 32, 'wallet id'),
    enrollmentEpoch: positive(raw.enrollmentEpoch, 'enrollment epoch'),
  })
}
export function requireEncryptedWalletBackupOwnerContext(
  actual: EncryptedWalletBackupOwnerContext,
  expected: EncryptedWalletBackupOwnerContext,
): void {
  const scope = decodeEncryptedWalletBackupOwnerContext(expected)
  if (CONTEXT_FIELDS.some((key) => actual[key] !== scope[key]))
    throw new Error('encrypted backup owner context is invalid')
}
export function decodeEncryptedWalletBackupOwnerCurrentHead(
  value: unknown,
): EncryptedWalletBackupOwnerCurrentHead {
  const raw = exactRecord(value, [
    'formatVersion',
    ...CONTEXT_FIELDS,
    'headVersion',
    'activeBundleCount',
    'activeObjectCount',
    'activeSetDigest',
  ])
  if (raw.formatVersion !== 3) throw new Error('encrypted backup owner head version is invalid')
  return Object.freeze({
    formatVersion: 3,
    ...decodeEncryptedWalletBackupOwnerContext({
      ownerScopeId: raw.ownerScopeId,
      realm: raw.realm,
      walletId: raw.walletId,
      enrollmentEpoch: raw.enrollmentEpoch,
    }),
    headVersion: bounded(raw.headVersion, 0, Number.MAX_SAFE_INTEGER, 'head version'),
    activeBundleCount: bounded(
      raw.activeBundleCount,
      0,
      ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
      'active bundle count',
    ),
    activeObjectCount: bounded(
      raw.activeObjectCount,
      0,
      ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX,
      'active object count',
    ),
    activeSetDigest: requireLowerHex(raw.activeSetDigest, 32, 'active set digest'),
  })
}
export function digestEncryptedWalletBackupOwnerActiveSetPairs(
  input: EncryptedWalletBackupOwnerContext & {
    readonly pairs: readonly { readonly bundleId: string; readonly descriptorDigest: string }[]
  },
): string {
  const scope = decodeEncryptedWalletBackupOwnerContext({
    ownerScopeId: input.ownerScopeId,
    realm: input.realm,
    walletId: input.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
  })
  if (!Array.isArray(input.pairs) || input.pairs.length > 256)
    throw new Error('encrypted backup owner active-set pairs are invalid')
  const pairs = input.pairs.map((pair) => ({
    bundleId: requireLowerHex(pair.bundleId, 16, 'bundle id'),
    descriptorDigest: requireLowerHex(pair.descriptorDigest, 32, 'descriptor digest'),
  }))
  if (pairs.some((p, i) => i > 0 && p.bundleId <= pairs[i - 1]!.bundleId))
    throw new Error('encrypted backup owner active-set pairs are unordered')
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode('bitcaster/encrypted-wallet-backup-v2-active-set/v2\0'))
      .update(
        encodeCanonicalBackupCbor([
          3,
          hexToBytesStrict(scope.ownerScopeId, 32, 'owner scope id'),
          scope.realm,
          hexToBytesStrict(scope.walletId, 32, 'wallet id'),
          scope.enrollmentEpoch,
          pairs.map((p) => [
            hexToBytesStrict(p.bundleId, 16, 'bundle id'),
            hexToBytesStrict(p.descriptorDigest, 32, 'descriptor digest'),
          ]),
        ]),
      )
      .digest(),
  )
}
export function createEncryptedWalletBackupOwnerCurrentHead(
  input: EncryptedWalletBackupOwnerContext & {
    readonly headVersion: number
    readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
  },
): EncryptedWalletBackupOwnerCurrentHead {
  const scope = decodeEncryptedWalletBackupOwnerContext({
    ownerScopeId: input.ownerScopeId,
    realm: input.realm,
    walletId: input.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
  })
  const bundles = decodeBundleSet(input.bundles, scope)
  return decodeEncryptedWalletBackupOwnerCurrentHead({
    ...scope,
    formatVersion: 3,
    headVersion: input.headVersion,
    activeBundleCount: bundles.length,
    activeObjectCount: objectCount(bundles),
    activeSetDigest: digestEncryptedWalletBackupOwnerActiveSetPairs({
      ...scope,
      pairs: bundles.map((b) => ({
        bundleId: b.bundleId,
        descriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(b),
      })),
    }),
  })
}
export function encodeEncryptedWalletBackupOwnerCurrentHead(
  value: EncryptedWalletBackupOwnerCurrentHead,
): Uint8Array {
  const h = decodeEncryptedWalletBackupOwnerCurrentHead(value)
  return encodeCanonicalBackupCbor([
    3,
    hexToBytesStrict(h.ownerScopeId, 32, 'owner scope id'),
    h.realm,
    hexToBytesStrict(h.walletId, 32, 'wallet id'),
    h.enrollmentEpoch,
    h.headVersion,
    h.activeBundleCount,
    h.activeObjectCount,
    hexToBytesStrict(h.activeSetDigest, 32, 'active set digest'),
  ])
}
function assertHead(
  head: EncryptedWalletBackupOwnerCurrentHead,
  bundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
): void {
  const actual = createEncryptedWalletBackupOwnerCurrentHead({ ...head, bundles })
  if (
    !equalBytes(
      encodeEncryptedWalletBackupOwnerCurrentHead(head),
      encodeEncryptedWalletBackupOwnerCurrentHead(actual),
    )
  )
    throw new Error('encrypted backup owner head authority is invalid')
}
export function enumerateEncryptedWalletBackupOwnerDescriptorPages(input: {
  readonly head: EncryptedWalletBackupOwnerCurrentHead
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
}): readonly EncryptedWalletBackupOwnerDescriptorPage[] {
  const head = decodeEncryptedWalletBackupOwnerCurrentHead(input.head),
    bundles = decodeBundleSet(input.bundles, head)
  assertHead(head, bundles)
  const pages: EncryptedWalletBackupOwnerDescriptorPage[] = []
  for (let i = 0; i < Math.max(1, bundles.length); i += 15) {
    const chunk = bundles.slice(i, i + 15)
    pages.push(
      Object.freeze({
        head,
        afterBundleId: i === 0 ? null : bundles[i - 1]!.bundleId,
        bundles: Object.freeze(chunk),
        nextAfterBundleId:
          i + chunk.length === bundles.length ? null : chunk[chunk.length - 1]!.bundleId,
      }),
    )
  }
  return Object.freeze(pages)
}
export function decodeEncryptedWalletBackupOwnerDescriptorPage(
  value: unknown,
): EncryptedWalletBackupOwnerDescriptorPage {
  const raw = exactRecord(value, ['head', 'afterBundleId', 'bundles', 'nextAfterBundleId'])
  const head = decodeEncryptedWalletBackupOwnerCurrentHead(raw.head)
  if (!Array.isArray(raw.bundles) || raw.bundles.length > 15)
    throw new Error('encrypted backup owner descriptor page is invalid')
  const afterBundleId = cursor(raw.afterBundleId),
    nextAfterBundleId = cursor(raw.nextAfterBundleId),
    bundles = decodeBundleSet(raw.bundles, head)
  if (
    bundles.length === 0
      ? afterBundleId !== null || nextAfterBundleId !== null
      : (afterBundleId !== null && bundles[0]!.bundleId <= afterBundleId) ||
        (nextAfterBundleId !== null && nextAfterBundleId !== bundles.at(-1)!.bundleId)
  )
    throw new Error('encrypted backup owner page cursor is invalid')
  return Object.freeze({ head, afterBundleId, bundles, nextAfterBundleId })
}
export function collectEncryptedWalletBackupOwnerDescriptorPages(
  value: unknown,
  expectedContext: EncryptedWalletBackupOwnerContext,
): EncryptedWalletBackupOwnerCollectedHeadEvidence {
  if (!Array.isArray(value) || value.length < 1 || value.length > 18)
    throw new Error('encrypted backup owner descriptor pages are invalid')
  const pages = value.map(decodeEncryptedWalletBackupOwnerDescriptorPage),
    head = pages[0]!.head
  requireEncryptedWalletBackupOwnerContext(head, expectedContext)
  const headBytes = encodeEncryptedWalletBackupOwnerCurrentHead(head),
    bundles: EncryptedWalletBackupV2BundleDescriptor[] = []
  let after: string | null = null
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!
    if (
      !equalBytes(headBytes, encodeEncryptedWalletBackupOwnerCurrentHead(page.head)) ||
      page.afterBundleId !== after
    )
      throw new Error('encrypted backup owner page head or cursor is invalid')
    if (page.bundles.length === 0 && (pages.length !== 1 || head.activeBundleCount !== 0))
      throw new Error('encrypted backup owner empty page is invalid')
    if (page.bundles.some((b) => after !== null && b.bundleId <= after))
      throw new Error('encrypted backup owner page order is invalid')
    if (
      i === pages.length - 1
        ? page.nextAfterBundleId !== null
        : page.nextAfterBundleId !== page.bundles.at(-1)?.bundleId
    )
      throw new Error('encrypted backup owner page cursor is invalid')
    bundles.push(...page.bundles)
    after = page.nextAfterBundleId
  }
  const complete = decodeBundleSet(bundles, head)
  assertHead(head, complete)
  const evidence = Object.freeze({
    head,
    bundles: Object.freeze(complete.map(cloneEncryptedWalletBackupV2BundleDescriptor)),
  })
  COLLECTED.add(evidence)
  return evidence
}
export function requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
  value: unknown,
  expectedContext: EncryptedWalletBackupOwnerContext,
): EncryptedWalletBackupOwnerCollectedHeadEvidence {
  if (typeof value !== 'object' || value === null || !COLLECTED.has(value))
    throw new Error('encrypted backup owner collected head evidence is invalid')
  const evidence = value as EncryptedWalletBackupOwnerCollectedHeadEvidence
  requireEncryptedWalletBackupOwnerContext(evidence.head, expectedContext)
  return evidence
}
