import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  preflightEncryptedWalletBackupV2CborTuple,
  type EncryptedWalletBackupV2CborTuplePreflight,
} from './encryptedWalletBackupV2Cbor.ts'
import {
  decodeEncryptedWalletBackupV2BundleObjectWire,
  encodeEncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleObjectWire,
} from './encryptedWalletBackupV2Bundle.ts'
import {
  decodeEncryptedWalletBackupV2BundleDescriptor,
  decodeEncryptedWalletBackupV2BundleDescriptorWire,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  decodeEncryptedWalletBackupV2CurrentHead,
  type EncryptedWalletBackupV2CurrentHead,
  type EncryptedWalletBackupV2DescriptorPage,
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_MAX,
} from './encryptedWalletBackupV2Head.ts'
import {
  decodeEncryptedWalletBackupV2SignedBundleSupersessionMutation,
  verifyEncryptedWalletBackupV2BundleSupersessionMutation,
  type EncryptedWalletBackupV2SignedBundleSupersessionMutation,
  type EncryptedWalletBackupV2VerifiedBundleSupersessionMutation,
} from './encryptedWalletBackupV2Mutation.ts'
import {
  decodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  type EncryptedWalletBackupV2BundleSupersessionReceipt,
} from './encryptedWalletBackupV2Receipt.ts'
import {
  equalBytes,
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
} from './encryptedWalletBackupServerValidation.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES } from './encryptedWalletBackupV2Limits.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_UPLOAD_GROUP_MAX_BYTES =
  ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES
const PAGE_MAX_BYTES = 65_536
const RECEIPT_MAX_BYTES = 65_536
const OBJECT_WIRE_MAX_BYTES = 300_000

const UPLOAD_GROUP_PREFLIGHT = tuplePreflight(
  ENCRYPTED_WALLET_BACKUP_V2_UPLOAD_GROUP_MAX_BYTES,
  4,
  20,
  15,
  300_000,
  [uint(2), text('bundle-supersession-upload-group'), bytes(1, PAGE_MAX_BYTES), array(0, 15)],
)
const DESCRIPTOR_PAGE_PREFLIGHT = tuplePreflight(PAGE_MAX_BYTES, 2, 22, 15, PAGE_MAX_BYTES, [
  uint(2),
  text('current-head-descriptor-page'),
  bytes(1, PAGE_MAX_BYTES),
  nullableBytes(16),
  array(0, 15),
  nullableBytes(16),
])
const SIGNED_MUTATION_PREFLIGHT = tuplePreflight(PAGE_MAX_BYTES, 3, 300, 256, PAGE_MAX_BYTES, [
  uint(2),
  text('bundle-supersession-mutation'),
  uint(2),
  text('bundle-supersession'),
  textLength(1, 64),
  bytes(32),
  uint(),
  bytes(16),
  uint(),
  bytes(32),
  nullableBytes(1, PAGE_MAX_BYTES),
  array(0, 256),
  bytes(32),
  bytes(32),
  bytes(64),
])
const HEAD_PREFLIGHT = tuplePreflight(PAGE_MAX_BYTES, 1, 9, 8, PAGE_MAX_BYTES, [
  uint(2),
  textLength(1, 64),
  bytes(32),
  uint(1),
  uint(),
  uint(0, 256),
  uint(0, 256),
  bytes(32),
])
const RECEIPT_PREFLIGHT = tuplePreflight(RECEIPT_MAX_BYTES, 3, 340, 256, PAGE_MAX_BYTES, [
  uint(2),
  text('bundle-supersession-receipt-wire'),
  uint(2),
  text('bundle-supersession-receipt'),
  textLength(1, 64),
  bytes(32),
  uint(1),
  bytes(32),
  bytes(16),
  bytes(32),
  uint(),
  bytes(32),
  bytes(1, PAGE_MAX_BYTES),
  nullableBytes(16),
  nullableBytes(32),
  array(0, 15),
  array(0, 256),
  bytes(16),
  bytes(64),
])

export interface DecodedEncryptedWalletBackupV2UploadGroup {
  readonly mutationEvidence: EncryptedWalletBackupV2VerifiedBundleSupersessionMutation
  readonly objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}

/** Encodes one signed mutation and its immutable object wires as a canonical upload group. */
export function encodeEncryptedWalletBackupV2UploadGroup(input: {
  readonly envelope: unknown
  readonly objects: unknown
}): Uint8Array {
  const envelope = decodeEncryptedWalletBackupV2SignedBundleSupersessionMutation(input.envelope)
  const verified = verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope,
    expectedRequestAuthPublicKey: envelope.requestAuthPublicKey,
    expectedContext: mutationScope(envelope),
  })
  const objects = encodeGroupObjects(input.objects, verified.envelope)
  const bytes = encodeCanonicalBackupCbor([
    2,
    'bundle-supersession-upload-group',
    encodeSignedMutation(envelope),
    objects,
  ])
  if (bytes.byteLength > ENCRYPTED_WALLET_BACKUP_V2_UPLOAD_GROUP_MAX_BYTES)
    throw new Error('encrypted backup v2 upload group is too large')
  return bytes
}

/** Decodes and verifies one canonical upload group in its authenticated V2 scope. */
export function decodeEncryptedWalletBackupV2UploadGroup(input: {
  readonly bytes: Uint8Array
  readonly expectedRequestAuthPublicKey: string
  readonly expectedContext: {
    readonly realm: string
    readonly vaultId: string
    readonly enrollmentEpoch: number
  }
}): DecodedEncryptedWalletBackupV2UploadGroup {
  const tuple = decodeTuple(input.bytes, UPLOAD_GROUP_PREFLIGHT, 'upload group')
  if (tuple[0] !== 2 || tuple[1] !== 'bundle-supersession-upload-group')
    throw new Error('encrypted backup v2 upload group is invalid')
  const envelope = decodeSignedMutation(requireBytes(tuple[2], 1, 65_536, 'signed mutation'))
  const mutationEvidence = verifyEncryptedWalletBackupV2BundleSupersessionMutation({
    envelope,
    expectedRequestAuthPublicKey: input.expectedRequestAuthPublicKey,
    expectedContext: input.expectedContext,
  })
  const objects = decodeGroupObjects(tuple[3], mutationEvidence.envelope)
  return Object.freeze({ mutationEvidence, objects: Object.freeze(objects) })
}

/** Encodes one current-head descriptor page for the V2 backup HTTP boundary. */
export function encodeEncryptedWalletBackupV2DescriptorPage(value: unknown): Uint8Array {
  const page = decodeDescriptorPage(value)
  return encodeCanonicalBackupCbor([
    2,
    'current-head-descriptor-page',
    encodeHead(page.head),
    nullableId(page.afterBundleId),
    page.bundles.map(encodeEncryptedWalletBackupV2BundleDescriptor),
    nullableId(page.nextAfterBundleId),
  ])
}

/** Decodes one canonical current-head descriptor page. */
export function decodeEncryptedWalletBackupV2DescriptorPage(
  bytes: Uint8Array,
): EncryptedWalletBackupV2DescriptorPage {
  const tuple = decodeTuple(bytes, DESCRIPTOR_PAGE_PREFLIGHT, 'descriptor page')
  if (tuple[0] !== 2 || tuple[1] !== 'current-head-descriptor-page')
    throw new Error('encrypted backup v2 descriptor page is invalid')
  return decodeDescriptorPage({
    head: decodeHead(requireBytes(tuple[2], 1, PAGE_MAX_BYTES, 'current head')),
    afterBundleId: decodeNullableId(tuple[3], 'bundle cursor'),
    bundles: decodeDescriptorArray(
      tuple[4],
      decodeHead(requireBytes(tuple[2], 1, PAGE_MAX_BYTES, 'current head')),
    ),
    nextAfterBundleId: decodeNullableId(tuple[5], 'bundle cursor'),
  })
}

/** Encodes one signed V2 bundle-supersession receipt for the HTTP boundary. */
export function encodeEncryptedWalletBackupV2BundleSupersessionReceipt(value: unknown): Uint8Array {
  const receipt = decodeEncryptedWalletBackupV2BundleSupersessionReceipt(value)
  return encodeCanonicalBackupCbor(receiptTuple(receipt))
}

/** Decodes one canonical signed V2 bundle-supersession receipt. */
export function decodeEncryptedWalletBackupV2BundleSupersessionReceiptWire(
  bytes: Uint8Array,
): EncryptedWalletBackupV2BundleSupersessionReceipt {
  const tuple = decodeTuple(bytes, RECEIPT_PREFLIGHT, 'receipt')
  if (tuple[0] !== 2 || tuple[1] !== 'bundle-supersession-receipt-wire')
    throw new Error('encrypted backup v2 receipt wire is invalid')
  return decodeEncryptedWalletBackupV2BundleSupersessionReceipt({
    formatVersion: tuple[2],
    kind: tuple[3],
    realm: tuple[4],
    vaultId: toHex(requireBytes(tuple[5], 32, 32, 'vault id')),
    enrollmentEpoch: tuple[6],
    requestAuthPublicKey: toHex(requireBytes(tuple[7], 32, 32, 'request public key')),
    mutationId: toHex(requireBytes(tuple[8], 16, 16, 'mutation id')),
    requestDigest: toHex(requireBytes(tuple[9], 32, 32, 'request digest')),
    previousHeadVersion: tuple[10],
    previousActiveSetDigest: toHex(requireBytes(tuple[11], 32, 32, 'active set digest')),
    resultHead: decodeHead(requireBytes(tuple[12], 1, PAGE_MAX_BYTES, 'result head')),
    bundleId: decodeNullableId(tuple[13], 'bundle id'),
    bundleDescriptorDigest: decodeNullableDigest(tuple[14]),
    finalizedObjects: decodeObjectReferences(tuple[15]),
    supersededBundleIds: decodeBundleIds(tuple[16]),
    signingKeyId: toHex(requireBytes(tuple[17], 16, 16, 'receipt key id')),
    signature: toHex(requireBytes(tuple[18], 64, 64, 'receipt signature')),
  })
}

function encodeGroupObjects(
  value: unknown,
  envelope: EncryptedWalletBackupV2SignedBundleSupersessionMutation,
): readonly Uint8Array[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup v2 upload objects are invalid')
  const added = envelope.mutation.addedBundle
  if (added === null) {
    if (value.length !== 0) throw new Error('encrypted backup v2 removal group has objects')
    return Object.freeze([])
  }
  if (value.length !== added.objects.length)
    throw new Error('encrypted backup v2 upload objects are invalid')
  return Object.freeze(value.map((item, index) => encodeOrderedObject(item, added, index)))
}

function decodeGroupObjects(
  value: unknown,
  envelope: EncryptedWalletBackupV2SignedBundleSupersessionMutation,
): EncryptedWalletBackupV2BundleObjectWire[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup v2 upload objects are invalid')
  const added = envelope.mutation.addedBundle
  if (added === null) {
    if (value.length !== 0) throw new Error('encrypted backup v2 removal group has objects')
    return []
  }
  if (
    value.length !== added.objects.length ||
    value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX
  )
    throw new Error('encrypted backup v2 upload objects are invalid')
  return value.map((item, index) => {
    const object = decodeEncryptedWalletBackupV2BundleObjectWire(
      requireBytes(item, 1, OBJECT_WIRE_MAX_BYTES, 'bundle object wire'),
      added,
    )
    assertObjectOrder(object, added, index)
    return object
  })
}

function encodeOrderedObject(
  value: unknown,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  index: number,
): Uint8Array {
  const wire = encodeEncryptedWalletBackupV2BundleObjectWire(value, descriptor)
  assertObjectOrder(
    decodeEncryptedWalletBackupV2BundleObjectWire(wire, descriptor),
    descriptor,
    index,
  )
  return wire
}

function assertObjectOrder(
  object: EncryptedWalletBackupV2BundleObjectWire,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  index: number,
): void {
  const expected = descriptor.objects[index]
  if (
    expected === undefined ||
    object.objectId !== expected.objectId ||
    object.digest !== expected.digest
  )
    throw new Error('encrypted backup v2 upload object order is invalid')
}

function encodeSignedMutation(
  value: EncryptedWalletBackupV2SignedBundleSupersessionMutation,
): Uint8Array {
  const mutation = value.mutation
  return encodeCanonicalBackupCbor([
    2,
    'bundle-supersession-mutation',
    mutation.formatVersion,
    mutation.kind,
    mutation.realm,
    hexToBytesStrict(mutation.vaultId, 32, 'vault id'),
    mutation.enrollmentEpoch,
    hexToBytesStrict(mutation.mutationId, 16, 'mutation id'),
    mutation.expectedHeadVersion,
    hexToBytesStrict(mutation.expectedActiveSetDigest, 32, 'active set digest'),
    mutation.addedBundle === null
      ? null
      : encodeEncryptedWalletBackupV2BundleDescriptor(mutation.addedBundle),
    mutation.supersededBundleIds.map((id) => hexToBytesStrict(id, 16, 'superseded bundle id')),
    hexToBytesStrict(value.requestAuthPublicKey, 32, 'request public key'),
    hexToBytesStrict(value.requestDigest, 32, 'request digest'),
    hexToBytesStrict(value.signature, 64, 'mutation signature'),
  ])
}

/** Encodes one canonical signed mutation for local receipt verification after restart. */
export function encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
  value: unknown,
): Uint8Array {
  return encodeSignedMutation(decodeEncryptedWalletBackupV2SignedBundleSupersessionMutation(value))
}

/** Decodes one canonical signed mutation retained with a local receipt. */
export function decodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
  bytes: Uint8Array,
): EncryptedWalletBackupV2SignedBundleSupersessionMutation {
  const mutation = decodeSignedMutation(bytes)
  if (!equalBytes(bytes, encodeSignedMutation(mutation)))
    throw new Error('encrypted backup v2 signed mutation wire is noncanonical')
  return mutation
}

function decodeSignedMutation(
  bytes: Uint8Array,
): EncryptedWalletBackupV2SignedBundleSupersessionMutation {
  const tuple = decodeTuple(bytes, SIGNED_MUTATION_PREFLIGHT, 'signed mutation')
  if (tuple[0] !== 2 || tuple[1] !== 'bundle-supersession-mutation')
    throw new Error('encrypted backup v2 signed mutation is invalid')
  const realm = tuple[4]
  const vaultId = toHex(requireBytes(tuple[5], 32, 32, 'vault id'))
  const context = { realm: typeof realm === 'string' ? realm : '', vaultId }
  return decodeEncryptedWalletBackupV2SignedBundleSupersessionMutation(
    {
      mutation: {
        formatVersion: tuple[2],
        kind: tuple[3],
        realm,
        vaultId,
        enrollmentEpoch: tuple[6],
        mutationId: toHex(requireBytes(tuple[7], 16, 16, 'mutation id')),
        expectedHeadVersion: tuple[8],
        expectedActiveSetDigest: toHex(requireBytes(tuple[9], 32, 32, 'active set digest')),
        addedBundle:
          tuple[10] === null
            ? null
            : decodeDescriptor(
                requireBytes(tuple[10], 1, PAGE_MAX_BYTES, 'bundle descriptor'),
                context,
              ),
        supersededBundleIds: decodeBundleIds(tuple[11]),
      },
      requestAuthPublicKey: toHex(requireBytes(tuple[12], 32, 32, 'request public key')),
      requestDigest: toHex(requireBytes(tuple[13], 32, 32, 'request digest')),
      signature: toHex(requireBytes(tuple[14], 64, 64, 'mutation signature')),
    },
    undefined,
  )
}

function decodeDescriptorPage(value: unknown): EncryptedWalletBackupV2DescriptorPage {
  const record = exactRecord(
    value,
    ['head', 'afterBundleId', 'bundles', 'nextAfterBundleId'],
    'descriptor page',
  )
  const head = decodeEncryptedWalletBackupV2CurrentHead(record.head)
  const afterBundleId = decodeStringNullableId(record.afterBundleId, 'bundle cursor')
  const nextAfterBundleId = decodeStringNullableId(record.nextAfterBundleId, 'bundle cursor')
  const bundles = decodeDescriptorArray(record.bundles, head)
  validatePageOrder(afterBundleId, bundles, nextAfterBundleId)
  return Object.freeze({ head, afterBundleId, bundles: Object.freeze(bundles), nextAfterBundleId })
}

function validatePageOrder(
  afterBundleId: string | null,
  bundles: readonly EncryptedWalletBackupV2BundleDescriptor[],
  nextAfterBundleId: string | null,
): void {
  if (bundles.length === 0) {
    if (afterBundleId !== null || nextAfterBundleId !== null)
      throw new Error('encrypted backup v2 empty page is invalid')
    return
  }
  if (afterBundleId !== null && bundles[0]!.bundleId <= afterBundleId)
    throw new Error('encrypted backup v2 descriptor page order is invalid')
  if (bundles.some((bundle, index) => index > 0 && bundle.bundleId <= bundles[index - 1]!.bundleId))
    throw new Error('encrypted backup v2 descriptor page order is invalid')
  if (nextAfterBundleId !== null && nextAfterBundleId !== bundles[bundles.length - 1]!.bundleId)
    throw new Error('encrypted backup v2 descriptor page cursor is invalid')
}

function decodeDescriptorArray(
  value: unknown,
  context: { readonly realm: string; readonly vaultId: string },
): EncryptedWalletBackupV2BundleDescriptor[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_PAGE_MAX)
    throw new Error('encrypted backup v2 descriptor page is invalid')
  return value.map((item) =>
    item instanceof Uint8Array
      ? decodeDescriptor(item, context)
      : decodeEncryptedWalletBackupV2BundleDescriptor(item, context),
  )
}

function decodeDescriptor(
  bytes: Uint8Array,
  context: { readonly realm: string; readonly vaultId: string },
): EncryptedWalletBackupV2BundleDescriptor {
  return decodeEncryptedWalletBackupV2BundleDescriptorWire(bytes, context)
}

function encodeHead(value: EncryptedWalletBackupV2CurrentHead): Uint8Array {
  return encodeCanonicalBackupCbor([
    value.formatVersion,
    value.realm,
    hexToBytesStrict(value.vaultId, 32, 'vault id'),
    value.enrollmentEpoch,
    value.headVersion,
    value.activeBundleCount,
    value.activeObjectCount,
    hexToBytesStrict(value.activeSetDigest, 32, 'active set digest'),
  ])
}

function decodeHead(bytes: Uint8Array): EncryptedWalletBackupV2CurrentHead {
  const tuple = decodeTuple(bytes, HEAD_PREFLIGHT, 'current head')
  return decodeEncryptedWalletBackupV2CurrentHead({
    formatVersion: tuple[0],
    realm: tuple[1],
    vaultId: toHex(requireBytes(tuple[2], 32, 32, 'vault id')),
    enrollmentEpoch: tuple[3],
    headVersion: tuple[4],
    activeBundleCount: tuple[5],
    activeObjectCount: tuple[6],
    activeSetDigest: toHex(requireBytes(tuple[7], 32, 32, 'active set digest')),
  })
}

function receiptTuple(
  receipt: EncryptedWalletBackupV2BundleSupersessionReceipt,
): readonly unknown[] {
  return [
    2,
    'bundle-supersession-receipt-wire',
    receipt.formatVersion,
    receipt.kind,
    receipt.realm,
    hexToBytesStrict(receipt.vaultId, 32, 'vault id'),
    receipt.enrollmentEpoch,
    hexToBytesStrict(receipt.requestAuthPublicKey, 32, 'request public key'),
    hexToBytesStrict(receipt.mutationId, 16, 'mutation id'),
    hexToBytesStrict(receipt.requestDigest, 32, 'request digest'),
    receipt.previousHeadVersion,
    hexToBytesStrict(receipt.previousActiveSetDigest, 32, 'active set digest'),
    encodeHead(receipt.resultHead),
    nullableId(receipt.bundleId),
    receipt.bundleDescriptorDigest === null
      ? null
      : hexToBytesStrict(receipt.bundleDescriptorDigest, 32, 'descriptor digest'),
    receipt.finalizedObjects.map((object) => [
      hexToBytesStrict(object.objectId, 16, 'object id'),
      hexToBytesStrict(object.digest, 32, 'object digest'),
    ]),
    receipt.supersededBundleIds.map((id) => hexToBytesStrict(id, 16, 'superseded bundle id')),
    hexToBytesStrict(receipt.signingKeyId, 16, 'receipt key id'),
    hexToBytesStrict(receipt.signature, 64, 'receipt signature'),
  ]
}

function decodeTuple(
  bytes: Uint8Array,
  specification: EncryptedWalletBackupV2CborTuplePreflight,
  name: string,
): unknown[] {
  preflightEncryptedWalletBackupV2CborTuple(bytes, specification)
  let value: unknown
  try {
    value = decode(bytes)
  } catch {
    throw new Error(`encrypted backup v2 ${name} is invalid`)
  }
  if (
    !equalBytes(bytes, encodeCanonicalBackupCbor(value)) ||
    !Array.isArray(value) ||
    value.length !== specification.fields.length
  )
    throw new Error(`encrypted backup v2 ${name} is invalid`)
  return value
}

function decodeNullableId(value: unknown, name: string): string | null {
  return value === null ? null : toHex(requireBytes(value, 16, 16, name))
}

function decodeStringNullableId(value: unknown, name: string): string | null {
  return value === null ? null : requireLowerHex(value, 16, name)
}

function nullableId(value: string | null): Uint8Array | null {
  return value === null ? null : hexToBytesStrict(value, 16, 'bundle id')
}

function decodeNullableDigest(value: unknown): string | null {
  return value === null ? null : toHex(requireBytes(value, 32, 32, 'descriptor digest'))
}

function decodeObjectReferences(
  value: unknown,
): readonly { readonly objectId: string; readonly digest: string }[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX)
    throw new Error('encrypted backup v2 object references are invalid')
  return value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2)
      throw new Error('encrypted backup v2 object reference is invalid')
    return Object.freeze({
      objectId: toHex(requireBytes(item[0], 16, 16, 'object id')),
      digest: toHex(requireBytes(item[1], 32, 32, 'object digest')),
    })
  })
}

function decodeBundleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup v2 superseded bundles are invalid')
  return value.map((item) => toHex(requireBytes(item, 16, 16, 'superseded bundle id')))
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`encrypted backup v2 ${name} is invalid`)
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error(`encrypted backup v2 ${name} is invalid`)
  return record
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, '0')).join('')
}

function mutationScope(value: EncryptedWalletBackupV2SignedBundleSupersessionMutation): {
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
} {
  return {
    realm: value.mutation.realm,
    vaultId: value.mutation.vaultId,
    enrollmentEpoch: value.mutation.enrollmentEpoch,
  }
}

function tuplePreflight(
  maximumBytes: number,
  maximumDepth: number,
  maximumTokens: number,
  maximumArrayLength: number,
  maximumItemLength: number,
  fields: readonly EncryptedWalletBackupV2CborTuplePreflight['fields'][number][],
): EncryptedWalletBackupV2CborTuplePreflight {
  return {
    maximumBytes,
    maximumDepth,
    maximumTokens,
    maximumArrayLength,
    maximumItemLength,
    fields,
  }
}

function uint(minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return { major: 0 as const, minimum, maximum }
}

function bytes(minimum: number, maximum = minimum) {
  return { major: 2 as const, minimum, maximum }
}

function nullableBytes(minimum: number, maximum = minimum) {
  return {
    major: 7 as const,
    alternatives: [bytes(minimum, maximum), { major: 7 as const, exact: 22 }],
  }
}

function text(value: string) {
  return { major: 3 as const, exact: value }
}

function textLength(minimum: number, maximum: number) {
  return { major: 3 as const, minimum, maximum }
}

function array(minimum: number, maximum: number) {
  return { major: 4 as const, minimum, maximum }
}
