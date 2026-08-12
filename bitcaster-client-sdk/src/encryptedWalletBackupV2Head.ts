import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  cloneEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2BundleDescriptor,
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

export const ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_MAX = 15 as const
export const ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_COUNT_MAX = 18 as const

export interface EncryptedWalletBackupV2CurrentHead {
  readonly formatVersion: 2
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly headVersion: number
  readonly activeBundleCount: number
  readonly activeObjectCount: number
  readonly activeSetDigest: string
}

export interface EncryptedWalletBackupV2DescriptorPage {
  readonly head: EncryptedWalletBackupV2CurrentHead
  readonly afterBundleId: string | null
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
  readonly nextAfterBundleId: string | null
}

export interface EncryptedWalletBackupV2CollectedHeadEvidence {
  readonly head: EncryptedWalletBackupV2CurrentHead
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
}

const COLLECTED_HEAD_EVIDENCES = new WeakSet<object>()

export function requireEncryptedWalletBackupV2CollectedHeadEvidence(
  value: unknown,
): EncryptedWalletBackupV2CollectedHeadEvidence {
  if (typeof value !== 'object' || value === null || !COLLECTED_HEAD_EVIDENCES.has(value))
    throw new Error('encrypted backup v2 collected head evidence is invalid')
  return value as EncryptedWalletBackupV2CollectedHeadEvidence
}

const ACTIVE_SET_DOMAIN = 'bitcaster/encrypted-wallet-backup-v2-active-set/v1\0'

export function createEncryptedWalletBackupV2CurrentHead(input: {
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly headVersion: number
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
}): EncryptedWalletBackupV2CurrentHead {
  const realmValue = input.realm
  const walletIdValue = input.walletId
  const enrollmentEpochValue = input.enrollmentEpoch
  const headVersionValue = input.headVersion
  const bundleValues = input.bundles
  const realm = requireRealm(realmValue)
  const walletId = requireLowerHex(walletIdValue, 32, 'wallet id')
  const enrollmentEpoch = positive(enrollmentEpochValue, 'enrollment epoch')
  const headVersion = bounded(headVersionValue, 0, Number.MAX_SAFE_INTEGER, 'head version')
  const bundles = decodeBundleSet(bundleValues, { realm, walletId })
  return Object.freeze({
    formatVersion: 2,
    realm,
    walletId,
    enrollmentEpoch,
    headVersion,
    activeBundleCount: bundles.length,
    activeObjectCount: objectCount(bundles),
    activeSetDigest: activeSetDigest(realm, walletId, enrollmentEpoch, bundles),
  })
}

export function enumerateEncryptedWalletBackupV2DescriptorPages(input: {
  readonly head: EncryptedWalletBackupV2CurrentHead
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
}): readonly EncryptedWalletBackupV2DescriptorPage[] {
  const head = decodeEncryptedWalletBackupV2CurrentHead(input.head)
  const bundles = decodeBundleSet(input.bundles, head)
  assertHeadMatches(head, bundles)
  if (bundles.length === 0)
    return Object.freeze([
      Object.freeze({
        head,
        afterBundleId: null,
        bundles: Object.freeze([]),
        nextAfterBundleId: null,
      }),
    ])
  const pages: EncryptedWalletBackupV2DescriptorPage[] = []
  for (
    let index = 0;
    index < bundles.length;
    index += ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_MAX
  ) {
    const pageBundles = bundles.slice(index, index + ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_MAX)
    pages.push(
      Object.freeze({
        head,
        afterBundleId: index === 0 ? null : bundles[index - 1]!.bundleId,
        bundles: Object.freeze(pageBundles.map(cloneEncryptedWalletBackupV2BundleDescriptor)),
        nextAfterBundleId:
          index + pageBundles.length === bundles.length
            ? null
            : pageBundles[pageBundles.length - 1]!.bundleId,
      }),
    )
  }
  return Object.freeze(pages)
}

export function collectEncryptedWalletBackupV2DescriptorPages(
  value: unknown,
): EncryptedWalletBackupV2CollectedHeadEvidence {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_COUNT_MAX
  )
    throw new Error('encrypted backup v2 descriptor pages are invalid')
  const pages = value.map(decodePage)
  const head = pages[0]!.head
  const headBytes = encodeEncryptedWalletBackupV2CurrentHead(head)
  const bundles: EncryptedWalletBackupV2BundleDescriptor[] = []
  let cursor: string | null = null
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!
    if (
      !equalBytes(headBytes, encodeEncryptedWalletBackupV2CurrentHead(page.head)) ||
      page.afterBundleId !== cursor
    )
      throw new Error('encrypted backup v2 descriptor page head or cursor is invalid')
    if (head.activeBundleCount === 0) {
      if (pages.length !== 1 || page.bundles.length !== 0 || page.nextAfterBundleId !== null)
        throw new Error('encrypted backup v2 empty descriptor page is invalid')
      assertHeadMatches(head, [])
      return issueCollectedEvidence(head, [])
    }
    if (
      page.bundles.length < 1 ||
      page.bundles.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_MAX
    )
      throw new Error('encrypted backup v2 descriptor page is invalid')
    for (const bundle of page.bundles) {
      if (
        (cursor !== null && bundle.bundleId <= cursor) ||
        (bundles.length > 0 && bundle.bundleId <= bundles[bundles.length - 1]!.bundleId)
      )
        throw new Error('encrypted backup v2 descriptor page order is invalid')
      bundles.push(bundle)
    }
    const terminal = index === pages.length - 1
    if (
      terminal
        ? page.nextAfterBundleId !== null
        : page.nextAfterBundleId !== page.bundles[page.bundles.length - 1]!.bundleId
    )
      throw new Error('encrypted backup v2 descriptor page cursor is invalid')
    cursor = page.nextAfterBundleId
  }
  const complete = decodeBundleSet(bundles, head)
  assertHeadMatches(head, complete)
  return issueCollectedEvidence(head, complete)
}

export function digestEncryptedWalletBackupV2ActiveSet(input: {
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]
}): string {
  const realm = requireRealm(input.realm)
  const walletId = requireLowerHex(input.walletId, 32, 'wallet id')
  const epoch = positive(input.enrollmentEpoch, 'enrollment epoch')
  return activeSetDigest(
    realm,
    walletId,
    epoch,
    decodeBundleSet(input.bundles, { realm, walletId }),
  )
}

function decodePage(value: unknown): EncryptedWalletBackupV2DescriptorPage {
  const record = exactRecord(value, ['head', 'afterBundleId', 'bundles', 'nextAfterBundleId'])
  const head = decodeEncryptedWalletBackupV2CurrentHead(record.head)
  const afterBundleId = cursor(record.afterBundleId)
  const nextAfterBundleId = cursor(record.nextAfterBundleId)
  const bundleValues = record.bundles
  if (!Array.isArray(bundleValues))
    throw new Error('encrypted backup v2 descriptor page is invalid')
  const bundles = bundleValues.map((bundle) =>
    decodeEncryptedWalletBackupV2BundleDescriptor(bundle, head),
  )
  return Object.freeze({ head, afterBundleId, bundles: Object.freeze(bundles), nextAfterBundleId })
}

export function decodeEncryptedWalletBackupV2CurrentHead(
  value: unknown,
): EncryptedWalletBackupV2CurrentHead {
  const record = exactRecord(value, [
    'formatVersion',
    'realm',
    'walletId',
    'enrollmentEpoch',
    'headVersion',
    'activeBundleCount',
    'activeObjectCount',
    'activeSetDigest',
  ])
  if (record.formatVersion !== 2) throw new Error('encrypted backup v2 head version is invalid')
  return Object.freeze({
    formatVersion: 2,
    realm: requireRealm(record.realm),
    walletId: requireLowerHex(record.walletId, 32, 'wallet id'),
    enrollmentEpoch: positive(record.enrollmentEpoch, 'enrollment epoch'),
    headVersion: bounded(record.headVersion, 0, Number.MAX_SAFE_INTEGER, 'head version'),
    activeBundleCount: bounded(
      record.activeBundleCount,
      0,
      ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
      'active bundle count',
    ),
    activeObjectCount: bounded(
      record.activeObjectCount,
      0,
      ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX,
      'active object count',
    ),
    activeSetDigest: requireLowerHex(record.activeSetDigest, 32, 'active set digest'),
  })
}

function decodeBundleSet(
  value: readonly EncryptedWalletBackupV2BundleDescriptor[],
  context: { readonly realm: string; readonly walletId: string },
): readonly EncryptedWalletBackupV2BundleDescriptor[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX)
    throw new Error('encrypted backup v2 active bundles are invalid')
  const bundles = value.map((bundle) =>
    decodeEncryptedWalletBackupV2BundleDescriptor(bundle, context),
  )
  const assets = new Set<string>()
  const objects = new Set<string>()
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index]!
    if (index > 0 && bundle.bundleId <= bundles[index - 1]!.bundleId)
      throw new Error('encrypted backup v2 active bundles are unordered or duplicated')
    if (assets.has(bundle.assetLocator))
      throw new Error('encrypted backup v2 asset locator is duplicated')
    assets.add(bundle.assetLocator)
    for (const object of bundle.objects) {
      if (objects.has(object.objectId))
        throw new Error('encrypted backup v2 object id is duplicated')
      objects.add(object.objectId)
    }
  }
  if (objects.size > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX)
    throw new Error('encrypted backup v2 active object count is invalid')
  return Object.freeze(bundles)
}

function assertHeadMatches(
  head: EncryptedWalletBackupV2CurrentHead,
  bundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
): void {
  if (
    head.activeBundleCount !== bundles.length ||
    head.activeObjectCount !== objectCount(bundles) ||
    head.activeSetDigest !==
      activeSetDigest(head.realm, head.walletId, head.enrollmentEpoch, bundles)
  )
    throw new Error('encrypted backup v2 head authority is invalid')
}
function issueCollectedEvidence(
  head: EncryptedWalletBackupV2CurrentHead,
  bundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
): EncryptedWalletBackupV2CollectedHeadEvidence {
  const evidence = Object.freeze({
    head: Object.freeze({ ...head }),
    bundles: Object.freeze(bundles.map(cloneEncryptedWalletBackupV2BundleDescriptor)),
  })
  COLLECTED_HEAD_EVIDENCES.add(evidence)
  return evidence
}
function activeSetDigest(
  realm: string,
  walletId: string,
  epoch: number,
  bundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
): string {
  return digestEncryptedWalletBackupV2ActiveSetPairs({
    realm,
    walletId,
    enrollmentEpoch: epoch,
    pairs: bundles.map((bundle) => ({
      bundleId: bundle.bundleId,
      descriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(bundle),
    })),
  })
}

/** Computes the canonical active-set digest from ordered bundle descriptor digests. */
export function digestEncryptedWalletBackupV2ActiveSetPairs(input: {
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly pairs: readonly { readonly bundleId: string; readonly descriptorDigest: string }[]
}): string {
  const realm = requireRealm(input.realm)
  const walletId = requireLowerHex(input.walletId, 32, 'wallet id')
  const enrollmentEpoch = positive(input.enrollmentEpoch, 'enrollment epoch')
  if (
    !Array.isArray(input.pairs) ||
    input.pairs.length > ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX
  )
    throw new Error('encrypted backup v2 active-set pairs are invalid')
  const pairs = input.pairs.map((pair) => ({
    bundleId: requireLowerHex(pair.bundleId, 16, 'bundle id'),
    descriptorDigest: requireLowerHex(pair.descriptorDigest, 32, 'descriptor digest'),
  }))
  if (pairs.some((pair, index) => index > 0 && pair.bundleId <= pairs[index - 1]!.bundleId))
    throw new Error('encrypted backup v2 active-set pairs are unordered or duplicated')
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode(ACTIVE_SET_DOMAIN))
      .update(
        encodeCanonicalBackupCbor([
          realm,
          hexToBytesStrict(walletId, 32, 'wallet id'),
          enrollmentEpoch,
          pairs.map((pair) => [
            hexToBytesStrict(pair.bundleId, 16, 'bundle id'),
            hexToBytesStrict(pair.descriptorDigest, 32, 'descriptor digest'),
          ]),
        ]),
      )
      .digest(),
  )
}
function objectCount(bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]): number {
  return bundles.reduce((count, bundle) => count + bundle.objects.length, 0)
}
export function encodeEncryptedWalletBackupV2CurrentHead(
  head: EncryptedWalletBackupV2CurrentHead,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    head.formatVersion,
    head.realm,
    hexToBytesStrict(head.walletId, 32, 'wallet id'),
    head.enrollmentEpoch,
    head.headVersion,
    head.activeBundleCount,
    head.activeObjectCount,
    hexToBytesStrict(head.activeSetDigest, 32, 'active set digest'),
  ])
}
function cursor(value: unknown): string | null {
  return value === null ? null : requireLowerHex(value, 16, 'bundle cursor')
}
function positive(value: unknown, name: string): number {
  return bounded(value, 1, Number.MAX_SAFE_INTEGER, name)
}
function bounded(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`encrypted backup v2 ${name} is invalid`)
  return value
}
function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup v2 record is invalid')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('encrypted backup v2 record is invalid')
  return record
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}
function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}
