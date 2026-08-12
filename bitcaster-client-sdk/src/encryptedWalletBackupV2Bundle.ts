import { sha256 } from '@noble/hashes/sha2.js'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import { exactEncryptedWalletBackupArrayBuffer } from './encryptedWalletBackupBytes.ts'
import { preflightEncryptedWalletBackupV2CborTuple } from './encryptedWalletBackupV2Cbor.ts'
import {
  deriveEncryptedWalletBackupV2Hkdf,
  requireEncryptedWalletBackupV2KeyAuthority,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import {
  decodeEncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
export type { EncryptedWalletBackupV2BundleDescriptor } from './encryptedWalletBackupV2Descriptor.ts'
import type { EncryptedWalletBackupV2BundleDescriptor } from './encryptedWalletBackupV2Descriptor.ts'
import {
  deriveEncryptedWalletBackupV2AssetLocator,
  ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2Runtime,
} from './encryptedWalletBackupV2Keys.ts'
import {
  equalBytes,
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
  requireUtf8Text,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES = 262_144 as const
export const ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_OBJECT_MAX =
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX

const GCM_TAG_BYTES = 16
const GCM_NONCE_BYTES = 12
const BUNDLE_ID_BYTES = 16
const OBJECT_ID_BYTES = 16
const PAYLOAD_FRAME_BYTES = ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES - GCM_TAG_BYTES
const HEADER_BYTES = 16
const FIRST_OBJECT_PAYLOAD_BYTES = PAYLOAD_FRAME_BYTES - HEADER_BYTES
const HEADER_MAGIC = Uint8Array.of(0x42, 0x4b, 0x56, 0x32)
const PAYLOAD_COMMITMENT_DOMAIN = 'encrypted-wallet-backup-v2-bundle-payload-commitment'
const OBJECT_COMMITMENT_DOMAIN = 'encrypted-wallet-backup-v2-bundle-object-commitment'
export const ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES =
  PAYLOAD_FRAME_BYTES * ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_OBJECT_MAX - HEADER_BYTES
const UNIT_MAX_BYTES = 64
const ASSET_ID_MAX_BYTES = 256
const BUNDLE_ID_COLLISION_ATTEMPTS = 8

export interface EncryptedWalletBackupV2BundleRuntime extends EncryptedWalletBackupV2Runtime {
  readonly subtle: Pick<SubtleCrypto, 'deriveBits' | 'importKey' | 'encrypt' | 'decrypt'>
  getRandomValues(target: Uint8Array): Uint8Array
}

export interface EncryptedWalletBackupV2AssetIdentity {
  readonly mintUrl: string
  readonly unit: string
  readonly assetIdentity: string
}

export interface EncryptedWalletBackupV2BundleObjectWire {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION
  readonly bundleId: string
  readonly objectId: string
  readonly nonce: Uint8Array
  readonly aad: Uint8Array
  readonly body: Uint8Array
  readonly digest: string
}

export interface EncryptedWalletBackupV2PreparedTransportBundle {
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor
  readonly objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}

/** Encodes the exact immutable object wire stored by the backup service. */
export function encodeEncryptedWalletBackupV2BundleObjectWire(
  value: unknown,
  expectedDescriptor: unknown,
): Uint8Array {
  const descriptor = decodeEncryptedWalletBackupV2BundleDescriptor(expectedDescriptor)
  const object = decodeEncryptedWalletBackupV2BundleObjectWireRecord(value, descriptor)
  return encodeCanonicalBackupCbor([
    ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    hexToBytesStrict(object.bundleId, BUNDLE_ID_BYTES, 'bundle id'),
    hexToBytesStrict(object.objectId, OBJECT_ID_BYTES, 'object id'),
    object.nonce,
    object.aad,
    object.body,
    hexToBytesStrict(object.digest, 32, 'object digest'),
  ])
}

/** Decodes one canonical immutable object wire without decrypting its body. */
export function decodeEncryptedWalletBackupV2BundleObjectWire(
  bytes: Uint8Array,
  expectedDescriptor: unknown,
): EncryptedWalletBackupV2BundleObjectWire {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 300_000)
    throw new Error('encrypted backup bundle object wire is invalid')
  const descriptor = decodeEncryptedWalletBackupV2BundleDescriptor(expectedDescriptor)
  preflightEncryptedWalletBackupV2CborTuple(bytes, OBJECT_WIRE_PREFLIGHT)
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    throw new Error('encrypted backup bundle object wire is invalid')
  }
  if (!equalBytes(bytes, encodeCanonicalBackupCbor(decoded)))
    throw new Error('encrypted backup bundle object wire is noncanonical')
  if (!Array.isArray(decoded) || decoded.length !== 7)
    throw new Error('encrypted backup bundle object wire is invalid')
  return freezeWireObject(
    decodeEncryptedWalletBackupV2BundleObjectWireRecord(
      {
        formatVersion: decoded[0],
        bundleId: toHex(requireBytes(decoded[1], BUNDLE_ID_BYTES, BUNDLE_ID_BYTES, 'bundle id')),
        objectId: toHex(requireBytes(decoded[2], OBJECT_ID_BYTES, OBJECT_ID_BYTES, 'object id')),
        nonce: decoded[3],
        aad: decoded[4],
        body: decoded[5],
        digest: toHex(requireBytes(decoded[6], 32, 32, 'object digest')),
      },
      descriptor,
    ),
  )
}

const OBJECT_WIRE_PREFLIGHT = {
  maximumBytes: 300_000,
  maximumDepth: 1,
  maximumTokens: 8,
  maximumArrayLength: 7,
  maximumItemLength: ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES,
  fields: [
    { major: 0, exact: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION },
    { major: 2, exact: BUNDLE_ID_BYTES },
    { major: 2, exact: OBJECT_ID_BYTES },
    { major: 2, exact: GCM_NONCE_BYTES },
    { major: 2, minimum: 1, maximum: 16_384 },
    { major: 2, exact: ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES },
    { major: 2, exact: 32 },
  ],
} as const

/** Encrypts canonical transport bytes. A later compiler owns restore-completeness authority. */
export async function prepareEncryptedWalletBackupV2TransportBundle(input: {
  keyHandle: EncryptedWalletBackupV2KeyHandle
  asset: EncryptedWalletBackupV2AssetIdentity
  declaredAmount: bigint
  custodyRevision: bigint
  canonicalPayload: Uint8Array
  runtime: EncryptedWalletBackupV2BundleRuntime
  bundleIdExists?: (bundleId: string) => boolean | Promise<boolean>
}): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  const authority = requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
  const payload = requireCanonicalTransportPayload(input.canonicalPayload)
  const runtime = requireBundleRuntime(input.runtime)
  const asset = requireAssetIdentity(input.asset)
  const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    ...asset,
  })
  const declaredAmount = requireUint64(input.declaredAmount, 'declared amount')
  const custodyRevision = requireUint64(input.custodyRevision, 'custody revision')
  const bundleId = await allocateBundleId(runtime, input.bundleIdExists)
  const payloadDigest = sha256(payload)
  const payloadCommitment = await derivePayloadCommitment(
    authority.encryptionRoot,
    runtime,
    bundleId,
    payloadDigest,
  )
  const descriptorBase = {
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    bundleId: toHex(bundleId),
    assetLocator,
    declaredAmount,
    custodyRevision,
    payloadCommitment: toHex(payloadCommitment),
  }
  const objectCount = objectCountForPayload(payload.byteLength)
  const objects = await encryptBundleObjects({
    authority,
    runtime,
    bundleId,
    descriptorBase,
    payload,
    objectCount,
  })
  return freezePreparedBundle(descriptorBase, objects)
}

export async function decryptEncryptedWalletBackupV2TransportBundle(input: {
  keyHandle: EncryptedWalletBackupV2KeyHandle
  runtime: EncryptedWalletBackupV2BundleRuntime
  descriptor: EncryptedWalletBackupV2BundleDescriptor
  objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}): Promise<Uint8Array> {
  try {
    const authority = requireEncryptedWalletBackupV2KeyAuthority(input.keyHandle)
    const runtime = requireBundleRuntime(input.runtime)
    const descriptor = decodeDescriptor(input.descriptor, input.keyHandle)
    const objects = decodeObjects(input.objects, descriptor)
    const payload = await decryptBundleObjects(authority, runtime, descriptor, objects)
    const commitment = await derivePayloadCommitment(
      authority.encryptionRoot,
      runtime,
      hexToBytesStrict(descriptor.bundleId, BUNDLE_ID_BYTES, 'bundle id'),
      sha256(payload),
    )
    if (
      !equalBytes(
        commitment,
        hexToBytesStrict(descriptor.payloadCommitment, 32, 'payload commitment'),
      )
    ) {
      throw new Error('payload commitment')
    }
    return payload.slice()
  } catch {
    throw new Error('corrupt encrypted wallet backup v2 bundle')
  }
}

function requireAssetIdentity(value: unknown): EncryptedWalletBackupV2AssetIdentity {
  const record = requireExactRecord(value, ['mintUrl', 'unit', 'assetIdentity'], 'asset identity')
  return {
    mintUrl: requireUtf8Text(record.mintUrl, 2_048, 'encrypted backup mint URL'),
    unit: requireUtf8Text(record.unit, UNIT_MAX_BYTES, 'encrypted backup unit'),
    assetIdentity: requireUtf8Text(
      record.assetIdentity,
      ASSET_ID_MAX_BYTES,
      'encrypted backup asset identity',
    ),
  }
}

function requireCanonicalTransportPayload(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES
  ) {
    throw new Error('encrypted backup canonical transport payload is invalid')
  }
  return new Uint8Array(value)
}

function requireBundleRuntime(value: unknown): EncryptedWalletBackupV2BundleRuntime {
  if (!isRecord(value) || typeof value.getRandomValues !== 'function') {
    throw new Error('encrypted backup bundle crypto runtime is unavailable')
  }
  const subtle = requireBundleSubtle(value.subtle)
  const getRandomValues = value.getRandomValues as (target: Uint8Array) => Uint8Array
  return { subtle, getRandomValues: (target) => getRandomValues.call(value, target) }
}

function requireBundleSubtle(
  value: unknown,
): Pick<SubtleCrypto, 'deriveBits' | 'importKey' | 'encrypt' | 'decrypt'> {
  if (
    !isRecord(value) ||
    typeof value.importKey !== 'function' ||
    typeof value.deriveBits !== 'function' ||
    typeof value.encrypt !== 'function' ||
    typeof value.decrypt !== 'function'
  ) {
    throw new Error('encrypted backup bundle crypto runtime is unavailable')
  }
  return value as Pick<SubtleCrypto, 'deriveBits' | 'importKey' | 'encrypt' | 'decrypt'>
}

async function encryptBundleObjects(input: {
  authority: ReturnType<typeof requireEncryptedWalletBackupV2KeyAuthority>
  runtime: EncryptedWalletBackupV2BundleRuntime
  bundleId: Uint8Array
  descriptorBase: DescriptorBase
  payload: Uint8Array
  objectCount: number
}): Promise<EncryptedWalletBackupV2BundleObjectWire[]> {
  const objects: EncryptedWalletBackupV2BundleObjectWire[] = []
  for (let index = 0; index < input.objectCount; index += 1) {
    objects.push(await encryptBundleObject({ ...input, index }))
  }
  return objects
}

async function encryptBundleObject(input: {
  authority: ReturnType<typeof requireEncryptedWalletBackupV2KeyAuthority>
  runtime: EncryptedWalletBackupV2BundleRuntime
  bundleId: Uint8Array
  descriptorBase: DescriptorBase
  payload: Uint8Array
  objectCount: number
  index: number
}): Promise<EncryptedWalletBackupV2BundleObjectWire> {
  const objectId = deriveObjectId(input.bundleId, input.index)
  const aad = encodeObjectAad({ ...input, objectId })
  const keyBytes = await deriveObjectKey(input.authority.encryptionRoot, input.runtime, aad)
  const nonce = randomBytes(input.runtime, GCM_NONCE_BYTES)
  const frame = framePayload(input.payload, input.index, input.objectCount)
  const key = await input.runtime.subtle.importKey(
    'raw',
    exactEncryptedWalletBackupArrayBuffer(keyBytes),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const body = new Uint8Array(
    await input.runtime.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: exactEncryptedWalletBackupArrayBuffer(nonce),
        additionalData: exactEncryptedWalletBackupArrayBuffer(aad),
        tagLength: 128,
      },
      key,
      exactEncryptedWalletBackupArrayBuffer(frame),
    ),
  )
  if (body.byteLength !== ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES) {
    throw new Error('encrypted backup bundle body length is invalid')
  }
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    bundleId: toHex(input.bundleId),
    objectId: toHex(objectId),
    nonce: new Uint8Array(nonce),
    aad: new Uint8Array(aad),
    body: new Uint8Array(body),
    digest: toHex(encryptedWalletBackupV2ObjectCommitment(nonce, aad, body)),
  })
}

function framePayload(payload: Uint8Array, index: number, objectCount: number): Uint8Array {
  const frame = new Uint8Array(PAYLOAD_FRAME_BYTES)
  const payloadOffset = framePayloadOffset(index)
  const frameOffset = index === 0 ? HEADER_BYTES : 0
  if (index === 0) writeFrameHeader(frame, payload.byteLength, objectCount)
  frame.set(
    payload.subarray(
      payloadOffset,
      Math.min(payload.byteLength, payloadOffset + PAYLOAD_FRAME_BYTES - frameOffset),
    ),
    frameOffset,
  )
  return frame
}

async function deriveObjectKey(
  encryptionRoot: Uint8Array,
  runtime: EncryptedWalletBackupV2Runtime,
  aad: Uint8Array,
): Promise<Uint8Array> {
  return deriveEncryptedWalletBackupV2Hkdf(
    runtime,
    encryptionRoot,
    encodeCanonicalBackupCbor([
      ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
      'bundle-object-key',
      sha256(aad),
    ]),
  )
}

function encodeObjectAad(input: {
  descriptorBase: DescriptorBase
  bundleId: Uint8Array
  objectId: Uint8Array
  index: number
  objectCount: number
}): Uint8Array {
  return encodeCanonicalBackupCbor([
    ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    'encrypted-wallet-backup-v2-bundle-object',
    input.descriptorBase.realm,
    fromHex(input.descriptorBase.walletId, 32),
    input.bundleId,
    fromHex(input.descriptorBase.assetLocator, 32),
    input.descriptorBase.declaredAmount,
    input.descriptorBase.custodyRevision,
    fromHex(input.descriptorBase.payloadCommitment, 32),
    input.objectId,
    input.index,
    input.objectCount,
  ])
}

function deriveObjectId(bundleId: Uint8Array, index: number): Uint8Array {
  return sha256(
    encodeCanonicalBackupCbor([
      ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
      'encrypted-wallet-backup-v2-bundle-object-id',
      bundleId,
      index,
    ]),
  ).slice(0, OBJECT_ID_BYTES)
}

function freezePreparedBundle(
  descriptorBase: DescriptorBase,
  objects: readonly EncryptedWalletBackupV2BundleObjectWire[],
): EncryptedWalletBackupV2PreparedTransportBundle {
  const descriptor = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    ...descriptorBase,
    objects: Object.freeze(
      objects.map((object) => Object.freeze({ objectId: object.objectId, digest: object.digest })),
    ),
  })
  const prepared = { descriptor } as EncryptedWalletBackupV2PreparedTransportBundle
  PREPARED_OBJECT_AUTHORITIES.set(prepared, {
    objects: Object.freeze(objects.map(cloneWireObject)),
  })
  Object.defineProperty(prepared, 'objects', {
    enumerable: true,
    get: () => {
      const authority = PREPARED_OBJECT_AUTHORITIES.get(prepared)
      if (authority === undefined)
        throw new Error('encrypted backup prepared objects are unavailable')
      return Object.freeze(authority.objects.map(cloneWireObject))
    },
  })
  return Object.freeze(prepared)
}

async function decryptBundleObjects(
  authority: ReturnType<typeof requireEncryptedWalletBackupV2KeyAuthority>,
  runtime: EncryptedWalletBackupV2BundleRuntime,
  descriptor: DecodedDescriptor,
  objects: readonly DecodedObject[],
): Promise<Uint8Array> {
  const firstFrame = await decryptBundleObject(authority, runtime, descriptor, objects[0]!, 0)
  const payloadLength = decodeFrameHeader(firstFrame, objects.length)
  const payload = new Uint8Array(payloadLength)
  copyFramePayload(payload, firstFrame, 0)
  for (let index = 1; index < objects.length; index += 1) {
    const frame = await decryptBundleObject(authority, runtime, descriptor, objects[index]!, index)
    copyFramePayload(payload, frame, index)
  }
  return payload
}

async function decryptBundleObject(
  authority: ReturnType<typeof requireEncryptedWalletBackupV2KeyAuthority>,
  runtime: EncryptedWalletBackupV2BundleRuntime,
  descriptor: DecodedDescriptor,
  object: DecodedObject,
  index: number,
): Promise<Uint8Array> {
  const bundleId = fromHex(descriptor.bundleId, BUNDLE_ID_BYTES)
  const expectedObjectId = deriveObjectId(bundleId, index)
  if (object.objectId !== toHex(expectedObjectId)) throw new Error('object id')
  const expectedAad = encodeObjectAad({
    descriptorBase: descriptor,
    bundleId,
    objectId: expectedObjectId,
    index,
    objectCount: descriptor.objects.length,
  })
  if (!equalBytes(object.aad, expectedAad)) throw new Error('aad')
  if (
    toHex(encryptedWalletBackupV2ObjectCommitment(object.nonce, object.aad, object.body)) !==
    object.digest
  ) {
    throw new Error('object digest')
  }
  const keyBytes = await deriveObjectKey(authority.encryptionRoot, runtime, expectedAad)
  const key = await runtime.subtle.importKey(
    'raw',
    exactEncryptedWalletBackupArrayBuffer(keyBytes),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const frame = new Uint8Array(
    await runtime.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: exactEncryptedWalletBackupArrayBuffer(object.nonce),
        additionalData: exactEncryptedWalletBackupArrayBuffer(object.aad),
        tagLength: 128,
      },
      key,
      exactEncryptedWalletBackupArrayBuffer(object.body),
    ),
  )
  if (frame.byteLength !== PAYLOAD_FRAME_BYTES) throw new Error('frame')
  return frame
}

function copyFramePayload(payload: Uint8Array, frame: Uint8Array, index: number): void {
  const payloadOffset = framePayloadOffset(index)
  const frameOffset = index === 0 ? HEADER_BYTES : 0
  const copied = Math.min(PAYLOAD_FRAME_BYTES - frameOffset, payload.byteLength - payloadOffset)
  payload.set(frame.subarray(frameOffset, frameOffset + copied), payloadOffset)
  for (let cursor = frameOffset + copied; cursor < frame.byteLength; cursor += 1) {
    if (frame[cursor] !== 0) throw new Error('padding')
  }
}

function decodeDescriptor(
  value: unknown,
  keyHandle: EncryptedWalletBackupV2KeyHandle,
): DecodedDescriptor {
  return decodeEncryptedWalletBackupV2BundleDescriptor(value, keyHandle)
}

function decodeObjects(value: unknown, descriptor: DecodedDescriptor): readonly DecodedObject[] {
  if (!Array.isArray(value) || value.length !== descriptor.objects.length)
    throw new Error('bundle objects')
  return Object.freeze(
    value.map((entry, index) => decodeObject(entry, descriptor, descriptor.objects[index]!)),
  )
}

function decodeObject(
  value: unknown,
  descriptor: DecodedDescriptor,
  expected: DescriptorObject,
): DecodedObject {
  const object = decodeEncryptedWalletBackupV2BundleObjectWireRecord(value, descriptor)
  if (object.objectId !== expected.objectId || object.digest !== expected.digest)
    throw new Error('object reference')
  return object
}

function decodeEncryptedWalletBackupV2BundleObjectWireRecord(
  value: unknown,
  descriptor: DecodedDescriptor,
): DecodedObject {
  const record = requireExactRecord(
    value,
    ['formatVersion', 'bundleId', 'objectId', 'nonce', 'aad', 'body', 'digest'],
    'bundle object',
  )
  if (record.formatVersion !== ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION) throw new Error('version')
  const objectId = requireLowerHex(record.objectId, OBJECT_ID_BYTES, 'object id')
  const digest = requireLowerHex(record.digest, 32, 'object digest')
  const index = descriptor.objects.findIndex((item) => item.objectId === objectId)
  if (index < 0 || descriptor.objects[index]!.digest !== digest) throw new Error('object reference')
  const bundleId = requireLowerHex(record.bundleId, BUNDLE_ID_BYTES, 'bundle id')
  if (bundleId !== descriptor.bundleId) throw new Error('bundle id')
  const nonce = new Uint8Array(
    requireBytes(record.nonce, GCM_NONCE_BYTES, GCM_NONCE_BYTES, 'nonce'),
  )
  const aad = new Uint8Array(requireBytes(record.aad, 1, 16_384, 'aad'))
  const body = new Uint8Array(
    requireBytes(
      record.body,
      ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES,
      ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_BODY_BYTES,
      'body',
    ),
  )
  const expectedAad = encodeObjectAad({
    descriptorBase: descriptor,
    bundleId: fromHex(descriptor.bundleId, BUNDLE_ID_BYTES),
    objectId: fromHex(objectId, OBJECT_ID_BYTES),
    index,
    objectCount: descriptor.objects.length,
  })
  if (!equalBytes(aad, expectedAad)) throw new Error('aad')
  if (toHex(encryptedWalletBackupV2ObjectCommitment(nonce, aad, body)) !== digest)
    throw new Error('object digest')
  return Object.freeze({
    objectId,
    digest,
    bundleId,
    nonce,
    aad,
    body,
  })
}

function freezeWireObject(value: DecodedObject): EncryptedWalletBackupV2BundleObjectWire {
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    bundleId: value.bundleId,
    objectId: value.objectId,
    nonce: value.nonce.slice(),
    aad: value.aad.slice(),
    body: value.body.slice(),
    digest: value.digest,
  })
}

function objectCountForPayload(payloadLength: number): number {
  return (
    1 + Math.ceil(Math.max(0, payloadLength - FIRST_OBJECT_PAYLOAD_BYTES) / PAYLOAD_FRAME_BYTES)
  )
}

function randomBytes(runtime: EncryptedWalletBackupV2BundleRuntime, length: number): Uint8Array {
  const target = new Uint8Array(length)
  const result = runtime.getRandomValues(target)
  if (result !== target || result.byteLength !== length)
    throw new Error('encrypted backup randomness is invalid')
  return target
}

async function derivePayloadCommitment(
  encryptionRoot: Uint8Array,
  runtime: EncryptedWalletBackupV2BundleRuntime,
  bundleId: Uint8Array,
  payloadDigest: Uint8Array,
): Promise<Uint8Array> {
  return deriveEncryptedWalletBackupV2Hkdf(
    runtime,
    encryptionRoot,
    encodeCanonicalBackupCbor([
      ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
      PAYLOAD_COMMITMENT_DOMAIN,
      bundleId,
      payloadDigest,
    ]),
  )
}

function encryptedWalletBackupV2ObjectCommitment(
  nonce: Uint8Array,
  aad: Uint8Array,
  body: Uint8Array,
): Uint8Array {
  return sha256
    .create()
    .update(new TextEncoder().encode(OBJECT_COMMITMENT_DOMAIN))
    .update(uint32Bytes(nonce.byteLength))
    .update(nonce)
    .update(uint32Bytes(aad.byteLength))
    .update(aad)
    .update(uint32Bytes(body.byteLength))
    .update(body)
    .digest()
}

function writeFrameHeader(frame: Uint8Array, payloadLength: number, objectCount: number): void {
  frame.set(HEADER_MAGIC, 0)
  frame[4] = ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION
  frame[5] = objectCount
  writeUint32(frame, 8, payloadLength)
  writeUint32(frame, 12, HEADER_BYTES)
}

function decodeFrameHeader(frame: Uint8Array, objectCount: number): number {
  if (!equalBytes(frame.subarray(0, HEADER_MAGIC.byteLength), HEADER_MAGIC))
    throw new Error('header')
  if (
    frame[4] !== ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION ||
    frame[5] !== objectCount ||
    frame[6] !== 0 ||
    frame[7] !== 0 ||
    readUint32(frame, 12) !== HEADER_BYTES
  ) {
    throw new Error('header')
  }
  const payloadLength = readUint32(frame, 8)
  if (
    payloadLength < 1 ||
    payloadLength > ENCRYPTED_WALLET_BACKUP_V2_BUNDLE_PAYLOAD_MAX_BYTES ||
    objectCountForPayload(payloadLength) !== objectCount
  ) {
    throw new Error('header')
  }
  return payloadLength
}

function framePayloadOffset(index: number): number {
  return index === 0 ? 0 : FIRST_OBJECT_PAYLOAD_BYTES + (index - 1) * PAYLOAD_FRAME_BYTES
}

function uint32Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  writeUint32(bytes, 0, value)
  return bytes
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value >>> 24
  target[offset + 1] = value >>> 16
  target[offset + 2] = value >>> 8
  target[offset + 3] = value
}

function readUint32(value: Uint8Array, offset: number): number {
  return (
    value[offset]! * 0x1_000000 +
    (value[offset + 1]! << 16) +
    (value[offset + 2]! << 8) +
    value[offset + 3]!
  )
}

async function allocateBundleId(
  runtime: EncryptedWalletBackupV2BundleRuntime,
  bundleIdExists: ((bundleId: string) => boolean | Promise<boolean>) | undefined,
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < BUNDLE_ID_COLLISION_ATTEMPTS; attempt += 1) {
    const bundleId = randomBytes(runtime, BUNDLE_ID_BYTES)
    if (bundleIdExists === undefined || !(await bundleIdExists(toHex(bundleId)))) return bundleId
  }
  throw new Error('encrypted backup bundle id collision limit exceeded')
}

function cloneWireObject(
  object: EncryptedWalletBackupV2BundleObjectWire,
): EncryptedWalletBackupV2BundleObjectWire {
  return Object.freeze({
    ...object,
    nonce: new Uint8Array(object.nonce),
    aad: new Uint8Array(object.aad),
    body: new Uint8Array(object.body),
  })
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${name} is invalid`)
  const record = value
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  ) {
    throw new Error(`${name} is invalid`)
  }
  return record
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function fromHex(value: string, bytes: number): Uint8Array {
  return hexToBytesStrict(value, bytes, 'hex')
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface DescriptorBase {
  readonly realm: string
  readonly walletId: string
  readonly bundleId: string
  readonly assetLocator: string
  readonly declaredAmount: bigint
  readonly custodyRevision: bigint
  readonly payloadCommitment: string
}

function requireUint64(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX)
    throw new Error(`encrypted backup ${name} is invalid`)
  return value
}

interface DescriptorObject {
  readonly objectId: string
  readonly digest: string
}

interface DecodedDescriptor extends DescriptorBase {
  readonly objects: readonly DescriptorObject[]
}

interface DecodedObject {
  readonly bundleId: string
  readonly objectId: string
  readonly nonce: Uint8Array
  readonly aad: Uint8Array
  readonly body: Uint8Array
  readonly digest: string
}

interface PreparedObjectAuthority {
  readonly objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}

const PREPARED_OBJECT_AUTHORITIES = new WeakMap<
  EncryptedWalletBackupV2PreparedTransportBundle,
  PreparedObjectAuthority
>()
