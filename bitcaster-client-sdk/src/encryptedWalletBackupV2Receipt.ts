import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  cloneEncryptedWalletBackupV2BundleDescriptor,
  digestEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2ObjectReference,
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  encodeEncryptedWalletBackupV2CurrentHead,
  decodeEncryptedWalletBackupV2CurrentHead,
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2CurrentHead,
} from './encryptedWalletBackupV2Head.ts'
import {
  ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX,
  requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation,
} from './encryptedWalletBackupV2Mutation.ts'
import {
  hexToBytesStrict,
  equalBytes,
  requireBytes,
  requireLowerHex,
  requireRealm,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'

export interface EncryptedWalletBackupV2BundleSupersessionReceipt {
  readonly formatVersion: 2
  readonly kind: 'bundle-supersession-receipt'
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
  readonly requestAuthPublicKey: string
  readonly mutationId: string
  readonly requestDigest: string
  readonly previousHeadVersion: number
  readonly previousActiveSetDigest: string
  readonly resultHead: EncryptedWalletBackupV2CurrentHead
  readonly bundleId: string | null
  readonly bundleDescriptorDigest: string | null
  readonly finalizedObjects: readonly EncryptedWalletBackupV2ObjectReference[]
  readonly supersededBundleIds: readonly string[]
  readonly signingKeyId: string
  readonly signature: string
}

export interface EncryptedWalletBackupV2VerifiedBundleSupersessionReceipt {
  readonly receipt: EncryptedWalletBackupV2BundleSupersessionReceipt
}

export interface EncryptedWalletBackupV2BackupReachabilityEvidence {
  readonly bundle: EncryptedWalletBackupV2BundleDescriptor
}

const RECEIPT_DOMAIN = 'bitcaster/encrypted-wallet-backup-v2-receipt/v1\0'
const VERIFIED_RECEIPTS = new WeakSet<object>()
const REACHABILITY_EVIDENCES = new WeakSet<object>()

export function verifyEncryptedWalletBackupV2BundleSupersessionReceipt(input: {
  readonly receipt: unknown
  readonly mutationEvidence: unknown
  readonly pinnedSigningKeys: readonly { readonly keyId: string; readonly publicKey: string }[]
}): EncryptedWalletBackupV2VerifiedBundleSupersessionReceipt {
  const mutation = requireMutation(input.mutationEvidence)
  const pins = decodePins(input.pinnedSigningKeys)
  const receipt = decodeReceipt(input.receipt)
  const pin = pins.find((item) => item.keyId === receipt.signingKeyId)
  if (pin === undefined) throw new Error('encrypted backup receipt signing key is invalid')
  bindReceipt(receipt, mutation)
  const digest = receiptDigest(receipt)
  if (
    !schnorr.verify(
      hexToBytesStrict(receipt.signature, 64, 'receipt signature'),
      hexToBytesStrict(digest, 32, 'receipt digest'),
      hexToBytesStrict(pin.publicKey, 32, 'receipt public key'),
    )
  )
    throw new Error('encrypted backup receipt signature is invalid')
  const evidence = Object.freeze({ receipt: freezeReceipt(receipt) })
  VERIFIED_RECEIPTS.add(evidence)
  return evidence
}

export function requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(
  value: unknown,
): EncryptedWalletBackupV2VerifiedBundleSupersessionReceipt {
  if (typeof value !== 'object' || value === null || !VERIFIED_RECEIPTS.has(value))
    throw new Error('encrypted backup verified receipt is invalid')
  return value as EncryptedWalletBackupV2VerifiedBundleSupersessionReceipt
}

/** A fresh transactional custody eligibility check is still required before local deletion. */
export function issueEncryptedWalletBackupV2BackupReachabilityEvidence(input: {
  readonly receiptEvidence: unknown
  readonly collectedHeadEvidence: unknown
}): EncryptedWalletBackupV2BackupReachabilityEvidence {
  const receipt = requireEncryptedWalletBackupV2VerifiedBundleSupersessionReceipt(
    input.receiptEvidence,
  ).receipt
  const collected = requireEncryptedWalletBackupV2CollectedHeadEvidence(input.collectedHeadEvidence)
  if (receipt.bundleId === null || receipt.bundleDescriptorDigest === null)
    throw new Error('encrypted backup receipt does not add a bundle')
  if (
    !equalBytes(
      encodeEncryptedWalletBackupV2CurrentHead(receipt.resultHead),
      encodeEncryptedWalletBackupV2CurrentHead(collected.head),
    )
  )
    throw new Error('encrypted backup reachability head is invalid')
  const bundle = collected.bundles.find((item) => item.bundleId === receipt.bundleId)
  if (
    bundle === undefined ||
    digestEncryptedWalletBackupV2BundleDescriptor(bundle) !== receipt.bundleDescriptorDigest ||
    !sameObjects(bundle.objects, receipt.finalizedObjects)
  )
    throw new Error('encrypted backup reachability bundle is invalid')
  if (
    receipt.supersededBundleIds.some((id) =>
      collected.bundles.some((bundle) => bundle.bundleId === id),
    )
  )
    throw new Error('encrypted backup reachability superseded bundle is active')
  const evidence = Object.freeze({ bundle: cloneEncryptedWalletBackupV2BundleDescriptor(bundle) })
  REACHABILITY_EVIDENCES.add(evidence)
  return evidence
}

export function requireEncryptedWalletBackupV2BackupReachabilityEvidence(
  value: unknown,
): EncryptedWalletBackupV2BackupReachabilityEvidence {
  if (typeof value !== 'object' || value === null || !REACHABILITY_EVIDENCES.has(value))
    throw new Error('encrypted backup reachability evidence is invalid')
  return value as EncryptedWalletBackupV2BackupReachabilityEvidence
}

export function digestEncryptedWalletBackupV2BundleSupersessionReceipt(value: unknown): string {
  return receiptDigest(decodeReceipt(value))
}

/** Validates and snapshots one V2 bundle-supersession receipt. */
export function decodeEncryptedWalletBackupV2BundleSupersessionReceipt(
  value: unknown,
): EncryptedWalletBackupV2BundleSupersessionReceipt {
  return decodeReceipt(value)
}

/** Issues a receipt from verified request evidence without handling private key material. */
export async function issueEncryptedWalletBackupV2BundleSupersessionReceipt(input: {
  readonly mutationEvidence: unknown
  readonly resultHead: unknown
  readonly signingKeyId: string
  readonly signingPublicKey: string
  readonly signDigest: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>
}): Promise<EncryptedWalletBackupV2BundleSupersessionReceipt> {
  const envelope = requireMutation(input.mutationEvidence)
  const resultHead = decodeEncryptedWalletBackupV2CurrentHead(input.resultHead)
  const signingKeyId = requireLowerHex(input.signingKeyId, 16, 'receipt key id')
  const signingPublicKey = requirePublicKey(input.signingPublicKey)
  if (typeof input.signDigest !== 'function')
    throw new Error('encrypted backup receipt signer is invalid')
  const receipt = unsignedReceipt(envelope, resultHead, signingKeyId)
  bindReceipt(receipt, envelope)
  const digest = hexToBytesStrict(receiptDigest(receipt), 32, 'receipt digest')
  const signature = await input.signDigest(digest.slice())
  const signatureBytes = hexToBytesStrict(
    toHex(requireSignature(signature)),
    64,
    'receipt signature',
  )
  if (
    !schnorr.verify(
      signatureBytes,
      digest,
      hexToBytesStrict(signingPublicKey, 32, 'receipt public key'),
    )
  )
    throw new Error('encrypted backup receipt signer is invalid')
  return freezeReceipt({ ...receipt, signature: toHex(signatureBytes) })
}

function requireMutation(value: unknown) {
  return requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation(value).envelope
}

function unsignedReceipt(
  envelope: ReturnType<typeof requireMutation>,
  resultHead: EncryptedWalletBackupV2CurrentHead,
  signingKeyId: string,
): EncryptedWalletBackupV2BundleSupersessionReceipt {
  const added = envelope.mutation.addedBundle
  return Object.freeze({
    formatVersion: 2,
    kind: 'bundle-supersession-receipt',
    realm: envelope.mutation.realm,
    vaultId: envelope.mutation.vaultId,
    enrollmentEpoch: envelope.mutation.enrollmentEpoch,
    requestAuthPublicKey: envelope.requestAuthPublicKey,
    mutationId: envelope.mutation.mutationId,
    requestDigest: envelope.requestDigest,
    previousHeadVersion: envelope.mutation.expectedHeadVersion,
    previousActiveSetDigest: envelope.mutation.expectedActiveSetDigest,
    resultHead,
    bundleId: added?.bundleId ?? null,
    bundleDescriptorDigest:
      added === null ? null : digestEncryptedWalletBackupV2BundleDescriptor(added),
    finalizedObjects: added === null ? Object.freeze([]) : added.objects,
    supersededBundleIds: envelope.mutation.supersededBundleIds,
    signingKeyId,
    signature: '00'.repeat(64),
  })
}

function requireSignature(value: unknown): Uint8Array {
  return new Uint8Array(requireBytes(value, 64, 64, 'receipt signature'))
}

function decodePins(value: unknown): readonly Pin[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    throw new Error('encrypted backup receipt pins are invalid')
  const pins = value.map((item) => {
    const record = exactRecord(item, ['keyId', 'publicKey'])
    const keyId = requireLowerHex(record.keyId, 16, 'receipt key id')
    const publicKey = requirePublicKey(record.publicKey)
    return Object.freeze({ keyId, publicKey })
  })
  if (
    new Set(pins.map((item) => item.keyId)).size !== pins.length ||
    new Set(pins.map((item) => item.publicKey)).size !== pins.length
  )
    throw new Error('encrypted backup receipt pins are duplicated')
  return Object.freeze(pins)
}

function decodeReceipt(value: unknown): EncryptedWalletBackupV2BundleSupersessionReceipt {
  const record = exactRecord(value, receiptFields)
  const raw = snapshotReceipt(record)
  if (raw.formatVersion !== 2 || raw.kind !== 'bundle-supersession-receipt')
    throw new Error('encrypted backup receipt is invalid')
  const resultHead = decodeEncryptedWalletBackupV2CurrentHead(raw.resultHead)
  const finalizedObjects = decodeObjects(raw.finalizedObjects)
  const supersededBundleIds = decodeBundleIds(raw.supersededBundleIds)
  return Object.freeze({
    formatVersion: 2,
    kind: 'bundle-supersession-receipt',
    realm: requireRealm(raw.realm),
    vaultId: requireLowerHex(raw.vaultId, 32, 'vault id'),
    enrollmentEpoch: positive(raw.enrollmentEpoch, 'enrollment epoch'),
    requestAuthPublicKey: requirePublicKey(raw.requestAuthPublicKey),
    mutationId: requireLowerHex(raw.mutationId, 16, 'mutation id'),
    requestDigest: requireLowerHex(raw.requestDigest, 32, 'request digest'),
    previousHeadVersion: bounded(raw.previousHeadVersion, 0, 'previous head version'),
    previousActiveSetDigest: requireLowerHex(raw.previousActiveSetDigest, 32, 'active set digest'),
    resultHead,
    bundleId: nullableHex(raw.bundleId, 16, 'bundle id'),
    bundleDescriptorDigest: nullableHex(raw.bundleDescriptorDigest, 32, 'descriptor digest'),
    finalizedObjects,
    supersededBundleIds,
    signingKeyId: requireLowerHex(raw.signingKeyId, 16, 'receipt key id'),
    signature: requireLowerHex(raw.signature, 64, 'receipt signature'),
  })
}

function bindReceipt(
  receipt: EncryptedWalletBackupV2BundleSupersessionReceipt,
  envelope: ReturnType<typeof requireMutation>,
): void {
  const mutation = envelope.mutation
  if (
    receipt.realm !== mutation.realm ||
    receipt.vaultId !== mutation.vaultId ||
    receipt.enrollmentEpoch !== mutation.enrollmentEpoch ||
    receipt.requestAuthPublicKey !== envelope.requestAuthPublicKey ||
    receipt.mutationId !== mutation.mutationId ||
    receipt.requestDigest !== envelope.requestDigest ||
    receipt.previousHeadVersion !== mutation.expectedHeadVersion ||
    receipt.previousActiveSetDigest !== mutation.expectedActiveSetDigest ||
    !sameIds(receipt.supersededBundleIds, mutation.supersededBundleIds)
  )
    throw new Error('encrypted backup receipt mutation binding is invalid')
  if (
    receipt.resultHead.realm !== receipt.realm ||
    receipt.resultHead.vaultId !== receipt.vaultId ||
    receipt.resultHead.enrollmentEpoch !== receipt.enrollmentEpoch ||
    receipt.resultHead.headVersion !== receipt.previousHeadVersion + 1
  )
    throw new Error('encrypted backup receipt result head is invalid')
  const added = mutation.addedBundle
  if (added === null) {
    if (
      receipt.bundleId !== null ||
      receipt.bundleDescriptorDigest !== null ||
      receipt.finalizedObjects.length !== 0
    )
      throw new Error('encrypted backup removal receipt is invalid')
    return
  }
  if (
    receipt.bundleId !== added.bundleId ||
    receipt.bundleDescriptorDigest !== digestEncryptedWalletBackupV2BundleDescriptor(added) ||
    !sameObjects(receipt.finalizedObjects, added.objects)
  )
    throw new Error('encrypted backup addition receipt is invalid')
}

function receiptDigest(receipt: EncryptedWalletBackupV2BundleSupersessionReceipt): string {
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode(RECEIPT_DOMAIN))
      .update(
        encodeCanonicalBackupCbor([
          2,
          'bundle-supersession-receipt',
          receipt.realm,
          hexToBytesStrict(receipt.vaultId, 32, 'vault id'),
          receipt.enrollmentEpoch,
          hexToBytesStrict(receipt.requestAuthPublicKey, 32, 'request public key'),
          hexToBytesStrict(receipt.mutationId, 16, 'mutation id'),
          hexToBytesStrict(receipt.requestDigest, 32, 'request digest'),
          receipt.previousHeadVersion,
          hexToBytesStrict(receipt.previousActiveSetDigest, 32, 'active set digest'),
          encodeEncryptedWalletBackupV2CurrentHead(receipt.resultHead),
          receipt.bundleId === null ? null : hexToBytesStrict(receipt.bundleId, 16, 'bundle id'),
          receipt.bundleDescriptorDigest === null
            ? null
            : hexToBytesStrict(receipt.bundleDescriptorDigest, 32, 'descriptor digest'),
          receipt.finalizedObjects.map(objectTuple),
          receipt.supersededBundleIds.map((id) => hexToBytesStrict(id, 16, 'superseded bundle id')),
          hexToBytesStrict(receipt.signingKeyId, 16, 'receipt key id'),
        ]),
      )
      .digest(),
  )
}

function snapshotReceipt(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(receiptFields.map((field) => [field, record[field]]))
}

function decodeObjects(value: unknown): readonly EncryptedWalletBackupV2ObjectReference[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX)
    throw new Error('encrypted backup receipt objects are invalid')
  const objects = Object.freeze(
    value.map((item) => {
      const record = exactRecord(item, ['objectId', 'digest'])
      return Object.freeze({
        objectId: requireLowerHex(record.objectId, 16, 'object id'),
        digest: requireLowerHex(record.digest, 32, 'object digest'),
      })
    }),
  )
  if (new Set(objects.map((item) => item.objectId)).size !== objects.length)
    throw new Error('encrypted backup receipt objects are duplicated')
  return objects
}

function decodeBundleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX)
    throw new Error('encrypted backup receipt superseded bundles are invalid')
  const ids = value.map((item) => requireLowerHex(item, 16, 'superseded bundle id'))
  if (ids.some((item, index) => index > 0 && item <= ids[index - 1]!))
    throw new Error('encrypted backup receipt superseded bundles are invalid')
  return Object.freeze(ids)
}

function freezeReceipt(
  value: EncryptedWalletBackupV2BundleSupersessionReceipt,
): EncryptedWalletBackupV2BundleSupersessionReceipt {
  return decodeReceipt({
    ...value,
    resultHead: { ...value.resultHead },
    finalizedObjects: value.finalizedObjects.map((item) => ({ ...item })),
    supersededBundleIds: [...value.supersededBundleIds],
  })
}

function nullableHex(value: unknown, bytes: number, name: string): string | null {
  return value === null ? null : requireLowerHex(value, bytes, name)
}
function objectTuple(value: EncryptedWalletBackupV2ObjectReference): readonly Uint8Array[] {
  return [
    hexToBytesStrict(value.objectId, 16, 'object id'),
    hexToBytesStrict(value.digest, 32, 'object digest'),
  ]
}
function sameObjects(
  left: readonly EncryptedWalletBackupV2ObjectReference[],
  right: readonly EncryptedWalletBackupV2ObjectReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.objectId === right[index]?.objectId && item.digest === right[index]?.digest,
    )
  )
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
function requirePublicKey(value: unknown): string {
  const key = requireLowerHex(value, 32, 'receipt public key')
  requireValidXOnlyPublicKey(hexToBytesStrict(key, 32, 'receipt public key'), 'receipt public key')
  return key
}
function positive(value: unknown, name: string): number {
  return bounded(value, 1, name)
}
function bounded(value: unknown, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error(`encrypted backup ${name} is invalid`)
  return value as number
}
function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error('encrypted backup receipt is invalid')
  return value as Record<string, unknown>
}
function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const receiptFields = [
  'formatVersion',
  'kind',
  'realm',
  'vaultId',
  'enrollmentEpoch',
  'requestAuthPublicKey',
  'mutationId',
  'requestDigest',
  'previousHeadVersion',
  'previousActiveSetDigest',
  'resultHead',
  'bundleId',
  'bundleDescriptorDigest',
  'finalizedObjects',
  'supersededBundleIds',
  'signingKeyId',
  'signature',
] as const
interface Pin {
  readonly keyId: string
  readonly publicKey: string
}
