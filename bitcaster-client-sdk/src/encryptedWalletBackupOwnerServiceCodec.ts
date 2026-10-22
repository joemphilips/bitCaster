import {
  decodeEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  type EncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from './encryptedWalletBackupOwnerReceipt.ts'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  preflightEncryptedWalletBackupV2CborTuple,
  type EncryptedWalletBackupV2CborField,
} from './encryptedWalletBackupV2Cbor.ts'
import {
  bounded,
  exactRecord,
  equalBytes,
  toHex,
} from './encryptedWalletBackupAuthorityValidation.ts'
import {
  decodeCurrentInventoryEntries,
  type EncryptedWalletBackupV2CurrentInventoryEntry,
} from './encryptedWalletBackupInventoryEntries.ts'
import {
  decodeEncryptedWalletBackupOwnerContext,
  decodeEncryptedWalletBackupOwnerCurrentHead,
  decodeEncryptedWalletBackupOwnerDescriptorPage,
  encodeEncryptedWalletBackupOwnerCurrentHead,
  digestEncryptedWalletBackupOwnerActiveSetPairs,
  requireEncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerCurrentHead,
  type EncryptedWalletBackupOwnerDescriptorPage,
} from './encryptedWalletBackupOwnerHead.ts'
import {
  decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation,
  type EncryptedWalletBackupOwnerSignedBundleSupersessionMutation,
} from './encryptedWalletBackupOwnerMutation.ts'
import {
  encodeEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
} from './encryptedWalletBackupServerValidation.ts'

export interface EncryptedWalletBackupOwnerCurrentInventory extends EncryptedWalletBackupOwnerContext {
  readonly headVersion: number
  readonly activeSetDigest: string
  readonly entries: readonly EncryptedWalletBackupV2CurrentInventoryEntry[]
}
const u = (min = 0, max = Number.MAX_SAFE_INTEGER): EncryptedWalletBackupV2CborField => ({
  major: 0,
  minimum: min,
  maximum: max,
})
const b = (min: number, max = min): EncryptedWalletBackupV2CborField => ({
  major: 2,
  minimum: min,
  maximum: max,
})
const t = (value: string): EncryptedWalletBackupV2CborField => ({ major: 3, exact: value })
const realm: EncryptedWalletBackupV2CborField = { major: 3, minimum: 1, maximum: 64 }
const a = (max: number): EncryptedWalletBackupV2CborField => ({
  major: 4,
  minimum: 0,
  maximum: max,
})
const nullable = (field: EncryptedWalletBackupV2CborField): EncryptedWalletBackupV2CborField => ({
  major: 7,
  alternatives: [field, { major: 7, exact: 22 }],
})
function tuple(
  bytes: Uint8Array,
  fields: readonly EncryptedWalletBackupV2CborField[],
  maximumBytes = 65536,
): unknown[] {
  preflightEncryptedWalletBackupV2CborTuple(bytes, {
    fields,
    maximumBytes,
    maximumDepth: 3,
    maximumTokens: 1800,
    maximumArrayLength: 256,
    maximumItemLength: 65536,
  })
  let value: unknown
  try {
    value = decode(bytes)
  } catch {
    throw new Error('encrypted backup owner wire is invalid')
  }
  if (
    !Array.isArray(value) ||
    value.length !== fields.length ||
    !equalBytes(bytes, encodeCanonicalBackupCbor(value))
  )
    throw new Error('encrypted backup owner wire is invalid')
  return value
}
const hex = (v: unknown, n: number) => toHex(requireBytes(v, n, n, 'identifier'))
const bin = (s: string, n: number) => hexToBytesStrict(s, n, 'identifier')
const optionalId = (s: string | null) => (s === null ? null : bin(s, 16))
const decodedId = (v: unknown) => (v === null ? null : hex(v, 16))
export function decodeEncryptedWalletBackupOwnerCurrentHeadWire(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerCurrentHead {
  const r = tuple(bytes, [u(3, 3), b(32), realm, b(32), u(1), u(), u(0, 256), u(0, 256), b(32)])
  return decodeEncryptedWalletBackupOwnerCurrentHead({
    formatVersion: r[0],
    ownerScopeId: hex(r[1], 32),
    realm: r[2],
    walletId: hex(r[3], 32),
    enrollmentEpoch: r[4],
    headVersion: r[5],
    activeBundleCount: r[6],
    activeObjectCount: r[7],
    activeSetDigest: hex(r[8], 32),
  })
}
export function encodeEncryptedWalletBackupOwnerDescriptorPage(value: unknown): Uint8Array {
  const page = decodeEncryptedWalletBackupOwnerDescriptorPage(value)
  const bytes = encodeCanonicalBackupCbor([
    3,
    'current-head-descriptor-page',
    encodeEncryptedWalletBackupOwnerCurrentHead(page.head),
    optionalId(page.afterBundleId),
    page.bundles.map(encodeEncryptedWalletBackupV2BundleDescriptor),
    optionalId(page.nextAfterBundleId),
  ])
  if (bytes.length > 65536) throw new Error('encrypted backup owner descriptor page is too large')
  return bytes
}
export function decodeEncryptedWalletBackupOwnerDescriptorPageWire(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerDescriptorPage {
  const r = tuple(bytes, [
    u(3, 3),
    t('current-head-descriptor-page'),
    b(1, 65536),
    nullable(b(16)),
    a(15),
    nullable(b(16)),
  ])
  const head = decodeEncryptedWalletBackupOwnerCurrentHeadWire(requireBytes(r[2], 1, 65536, 'head'))
  return decodeEncryptedWalletBackupOwnerDescriptorPage({
    head,
    afterBundleId: decodedId(r[3]),
    bundles: (r[4] as unknown[]).map((v) =>
      decodeEncryptedWalletBackupV2BundleDescriptorWire(
        requireBytes(v, 1, 65536, 'descriptor'),
        head,
      ),
    ),
    nextAfterBundleId: decodedId(r[5]),
  })
}
function inventory(value: unknown): EncryptedWalletBackupOwnerCurrentInventory {
  const r = exactRecord(value, [
    'ownerScopeId',
    'realm',
    'walletId',
    'enrollmentEpoch',
    'headVersion',
    'activeSetDigest',
    'entries',
  ])
  return Object.freeze({
    ...decodeEncryptedWalletBackupOwnerContext({
      ownerScopeId: r.ownerScopeId,
      realm: r.realm,
      walletId: r.walletId,
      enrollmentEpoch: r.enrollmentEpoch,
    }),
    headVersion: bounded(r.headVersion, 0, Number.MAX_SAFE_INTEGER, 'head version'),
    activeSetDigest: requireLowerHex(r.activeSetDigest, 32, 'active set digest'),
    entries: Object.freeze(decodeCurrentInventoryEntries(r.entries)),
  })
}
export function requireEncryptedWalletBackupOwnerCurrentInventoryScope(input: {
  readonly inventory: EncryptedWalletBackupOwnerCurrentInventory
  readonly expectedContext: EncryptedWalletBackupOwnerContext
}): EncryptedWalletBackupOwnerCurrentInventory {
  const value = inventory(input.inventory)
  requireEncryptedWalletBackupOwnerContext(value, input.expectedContext)
  if (
    value.activeSetDigest !==
    digestEncryptedWalletBackupOwnerActiveSetPairs({
      ...value,
      pairs: value.entries.map((e) => ({
        bundleId: e.bundleId,
        descriptorDigest: e.descriptorDigest,
      })),
    })
  )
    throw new Error('encrypted backup owner inventory digest is invalid')
  return value
}
export function encodeEncryptedWalletBackupOwnerCurrentInventory(value: unknown): Uint8Array {
  const i = inventory(value)
  const bytes = encodeCanonicalBackupCbor([
    3,
    'current-inventory',
    bin(i.ownerScopeId, 32),
    i.realm,
    bin(i.walletId, 32),
    i.enrollmentEpoch,
    i.headVersion,
    bin(i.activeSetDigest, 32),
    i.entries.map((e) => [
      bin(e.assetLocator, 32),
      e.declaredAmount,
      e.custodyRevision,
      bin(e.bundleId, 16),
      bin(e.descriptorDigest, 32),
    ]),
  ])
  if (bytes.length > 60000) throw new Error('encrypted backup owner inventory is too large')
  return bytes
}
export function decodeEncryptedWalletBackupOwnerCurrentInventory(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerCurrentInventory {
  const r = tuple(
    bytes,
    [u(3, 3), t('current-inventory'), b(32), realm, b(32), u(1), u(), b(32), a(256)],
    60000,
  )
  return inventory({
    ownerScopeId: hex(r[2], 32),
    realm: r[3],
    walletId: hex(r[4], 32),
    enrollmentEpoch: r[5],
    headVersion: r[6],
    activeSetDigest: hex(r[7], 32),
    entries: r[8],
  })
}
export function encodeEncryptedWalletBackupOwnerSignedMutation(value: unknown): Uint8Array {
  const e = decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation(value),
    m = e.mutation
  const bytes = encodeCanonicalBackupCbor([
    3,
    'bundle-supersession-mutation',
    3,
    'bundle-supersession',
    bin(m.ownerScopeId, 32),
    m.realm,
    bin(m.walletId, 32),
    m.enrollmentEpoch,
    bin(m.mutationId, 16),
    m.expectedHeadVersion,
    bin(m.expectedActiveSetDigest, 32),
    m.addedBundle === null ? null : encodeEncryptedWalletBackupV2BundleDescriptor(m.addedBundle),
    m.supersededBundleIds.map((id) => bin(id, 16)),
    bin(e.requestAuthPublicKey, 32),
    bin(e.requestDigest, 32),
    bin(e.signature, 64),
  ])
  if (bytes.length > 65536) throw new Error('encrypted backup owner mutation is too large')
  return bytes
}
export function decodeEncryptedWalletBackupOwnerSignedMutationWire(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerSignedBundleSupersessionMutation {
  const r = tuple(bytes, [
    u(3, 3),
    t('bundle-supersession-mutation'),
    u(3, 3),
    t('bundle-supersession'),
    b(32),
    realm,
    b(32),
    u(1),
    b(16),
    u(),
    b(32),
    nullable(b(1, 65536)),
    a(256),
    b(32),
    b(32),
    b(64),
  ])
  const context = decodeEncryptedWalletBackupOwnerContext({
    ownerScopeId: hex(r[4], 32),
    realm: r[5],
    walletId: hex(r[6], 32),
    enrollmentEpoch: r[7],
  })
  return decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation({
    mutation: {
      formatVersion: r[2],
      kind: r[3],
      ...context,
      mutationId: hex(r[8], 16),
      expectedHeadVersion: r[9],
      expectedActiveSetDigest: hex(r[10], 32),
      addedBundle:
        r[11] === null
          ? null
          : decodeEncryptedWalletBackupV2BundleDescriptorWire(
              requireBytes(r[11], 1, 65536, 'descriptor'),
              context,
            ),
      supersededBundleIds: (r[12] as unknown[]).map((v) => hex(v, 16)),
    },
    requestAuthPublicKey: hex(r[13], 32),
    requestDigest: hex(r[14], 32),
    signature: hex(r[15], 64),
  })
}

/** Structural wire parsing does not grant receipt authority. */
export function encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(
  value: unknown,
): Uint8Array {
  const receipt = decodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(value)
  const bytes = encodeCanonicalBackupCbor([
    3,
    'bundle-supersession-receipt-wire',
    3,
    receipt.kind,
    bin(receipt.ownerScopeId, 32),
    receipt.realm,
    bin(receipt.walletId, 32),
    receipt.enrollmentEpoch,
    bin(receipt.requestAuthPublicKey, 32),
    bin(receipt.mutationId, 16),
    bin(receipt.requestDigest, 32),
    receipt.previousHeadVersion,
    bin(receipt.previousActiveSetDigest, 32),
    encodeEncryptedWalletBackupOwnerCurrentHead(receipt.resultHead),
    optionalId(receipt.bundleId),
    receipt.bundleDescriptorDigest === null ? null : bin(receipt.bundleDescriptorDigest, 32),
    receipt.finalizedObjects.map((item) => [bin(item.objectId, 16), bin(item.digest, 32)]),
    receipt.supersededBundleIds.map((id) => bin(id, 16)),
    bin(receipt.signingKeyId, 16),
    bin(receipt.signature, 64),
  ])
  if (bytes.length > 65536) throw new Error('encrypted backup owner receipt is too large')
  return bytes
}
export function decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire(
  bytes: Uint8Array,
): EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  const record = tuple(bytes, [
    u(3, 3),
    t('bundle-supersession-receipt-wire'),
    u(3, 3),
    t('bundle-supersession-receipt'),
    b(32),
    realm,
    b(32),
    u(1),
    b(32),
    b(16),
    b(32),
    u(),
    b(32),
    b(1, 65536),
    nullable(b(16)),
    nullable(b(32)),
    a(15),
    a(256),
    b(16),
    b(64),
  ])
  return decodeEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    formatVersion: record[2],
    kind: record[3],
    ownerScopeId: hex(record[4], 32),
    realm: record[5],
    walletId: hex(record[6], 32),
    enrollmentEpoch: record[7],
    requestAuthPublicKey: hex(record[8], 32),
    mutationId: hex(record[9], 16),
    requestDigest: hex(record[10], 32),
    previousHeadVersion: record[11],
    previousActiveSetDigest: hex(record[12], 32),
    resultHead: decodeEncryptedWalletBackupOwnerCurrentHeadWire(
      requireBytes(record[13], 1, 65536, 'result head'),
    ),
    bundleId: decodedId(record[14]),
    bundleDescriptorDigest: record[15] === null ? null : hex(record[15], 32),
    finalizedObjects: (record[16] as unknown[]).map((item) => {
      if (!Array.isArray(item) || item.length !== 2)
        throw new Error('encrypted backup owner receipt object is invalid')
      return { objectId: hex(item[0], 16), digest: hex(item[1], 32) }
    }),
    supersededBundleIds: (record[17] as unknown[]).map((item) => hex(item, 16)),
    signingKeyId: hex(record[18], 16),
    signature: hex(record[19], 64),
  })
}
