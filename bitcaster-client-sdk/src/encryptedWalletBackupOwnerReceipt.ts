import {
  requireSignature,
  decodePins,
  decodeObjects,
  decodeBundleIds,
  nullableHex,
  objectTuple,
  sameObjects,
  sameIds,
  requirePublicKey,
  positive,
  bounded,
  exactRecord,
  toHex,
} from './encryptedWalletBackupReceiptValidation.ts'
import {
  decodeEncryptedWalletBackupOwnerContext,
  requireEncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerContext,
} from './encryptedWalletBackupOwnerHead.ts'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  cloneEncryptedWalletBackupV2BundleDescriptor,
  digestEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2ObjectReference,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  encodeEncryptedWalletBackupOwnerCurrentHead,
  decodeEncryptedWalletBackupOwnerCurrentHead,
  requireEncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerCurrentHead,
} from './encryptedWalletBackupOwnerHead.ts'
import { requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation } from './encryptedWalletBackupOwnerMutation.ts'
import {
  hexToBytesStrict,
  equalBytes,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'

export interface EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  readonly formatVersion: 3
  readonly kind: 'bundle-supersession-receipt'
  readonly ownerScopeId: string
  readonly realm: string
  readonly walletId: string
  readonly enrollmentEpoch: number
  readonly requestAuthPublicKey: string
  readonly mutationId: string
  readonly requestDigest: string
  readonly previousHeadVersion: number
  readonly previousActiveSetDigest: string
  readonly resultHead: EncryptedWalletBackupOwnerCurrentHead
  readonly bundleId: string | null
  readonly bundleDescriptorDigest: string | null
  readonly finalizedObjects: readonly EncryptedWalletBackupV2ObjectReference[]
  readonly supersededBundleIds: readonly string[]
  readonly signingKeyId: string
  readonly signature: string
}

export interface EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt {
  readonly receipt: EncryptedWalletBackupOwnerBundleSupersessionReceipt
}

export interface EncryptedWalletBackupOwnerBackupReachabilityEvidence {
  readonly context: EncryptedWalletBackupOwnerContext
  readonly bundle: EncryptedWalletBackupV2BundleDescriptor
  readonly headVersion: number
  readonly activeSetDigest: string
}

const RECEIPT_DOMAIN = 'bitcaster/encrypted-wallet-backup-v2-receipt/v2\0'
const VERIFIED_RECEIPTS = new WeakSet<object>()
const REACHABILITY_EVIDENCES = new WeakMap<object, EncryptedWalletBackupOwnerContext>()

export function verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt(input: {
  readonly receipt: unknown
  readonly mutationEvidence: unknown
  readonly expectedContext: EncryptedWalletBackupOwnerContext
  readonly pinnedSigningKeys: readonly { readonly keyId: string; readonly publicKey: string }[]
}): EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt {
  const mutation = requireMutation(input.mutationEvidence, input.expectedContext)
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

export function requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt(
  value: unknown,
  expectedContext: EncryptedWalletBackupOwnerContext,
): EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt {
  if (typeof value !== 'object' || value === null || !VERIFIED_RECEIPTS.has(value))
    throw new Error('encrypted backup verified receipt is invalid')
  const evidence = value as EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt
  requireEncryptedWalletBackupOwnerContext(evidence.receipt, expectedContext)
  return evidence
}

/** A fresh transactional custody eligibility check is still required before local deletion. */
export function issueEncryptedWalletBackupOwnerBackupReachabilityEvidence(input: {
  readonly receiptEvidence: unknown
  readonly expectedContext: EncryptedWalletBackupOwnerContext
  readonly collectedHeadEvidence: unknown
}): EncryptedWalletBackupOwnerBackupReachabilityEvidence {
  const context = decodeEncryptedWalletBackupOwnerContext(input.expectedContext)
  const receipt = requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt(
    input.receiptEvidence,
    context,
  ).receipt
  const collected = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
    input.collectedHeadEvidence,
    context,
  )
  if (receipt.bundleId === null || receipt.bundleDescriptorDigest === null)
    throw new Error('encrypted backup receipt does not add a bundle')
  if (collected.head.headVersion < receipt.resultHead.headVersion)
    throw new Error('encrypted backup reachability head is stale')
  if (
    collected.head.headVersion === receipt.resultHead.headVersion &&
    !equalBytes(
      encodeEncryptedWalletBackupOwnerCurrentHead(receipt.resultHead),
      encodeEncryptedWalletBackupOwnerCurrentHead(collected.head),
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
  const evidence = Object.freeze({
    context,
    bundle: cloneEncryptedWalletBackupV2BundleDescriptor(bundle),
    headVersion: collected.head.headVersion,
    activeSetDigest: collected.head.activeSetDigest,
  })
  REACHABILITY_EVIDENCES.set(evidence, context)
  return evidence
}

export function requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(
  value: unknown,
  expectedContext: EncryptedWalletBackupOwnerContext,
): EncryptedWalletBackupOwnerBackupReachabilityEvidence {
  if (typeof value !== 'object' || value === null || !REACHABILITY_EVIDENCES.has(value))
    throw new Error('encrypted backup reachability evidence is invalid')
  requireEncryptedWalletBackupOwnerContext(REACHABILITY_EVIDENCES.get(value)!, expectedContext)
  return value as EncryptedWalletBackupOwnerBackupReachabilityEvidence
}

export function digestEncryptedWalletBackupOwnerBundleSupersessionReceipt(value: unknown): string {
  return receiptDigest(decodeReceipt(value))
}

/** Validates and snapshots one owner-bound bundle-supersession receipt. */
export function decodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(
  value: unknown,
): EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  return decodeReceipt(value)
}

/** Issues a receipt from verified request evidence without handling private key material. */
export async function issueEncryptedWalletBackupOwnerBundleSupersessionReceipt(input: {
  readonly mutationEvidence: unknown
  readonly expectedContext: EncryptedWalletBackupOwnerContext
  readonly resultHead: unknown
  readonly signingKeyId: string
  readonly signingPublicKey: string
  readonly signDigest: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>
}): Promise<EncryptedWalletBackupOwnerBundleSupersessionReceipt> {
  const envelope = requireMutation(input.mutationEvidence, input.expectedContext)
  const resultHead = decodeEncryptedWalletBackupOwnerCurrentHead(input.resultHead)
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

function requireMutation(value: unknown, context: EncryptedWalletBackupOwnerContext) {
  return requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation(value, context)
    .envelope
}

function unsignedReceipt(
  envelope: ReturnType<typeof requireMutation>,
  resultHead: EncryptedWalletBackupOwnerCurrentHead,
  signingKeyId: string,
): EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  const added = envelope.mutation.addedBundle
  return Object.freeze({
    formatVersion: 3,
    kind: 'bundle-supersession-receipt',
    ownerScopeId: envelope.mutation.ownerScopeId,
    realm: envelope.mutation.realm,
    walletId: envelope.mutation.walletId,
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

function decodeReceipt(value: unknown): EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  const record = exactRecord(value, receiptFields)
  const raw = snapshotReceipt(record)
  if (raw.formatVersion !== 3 || raw.kind !== 'bundle-supersession-receipt')
    throw new Error('encrypted backup receipt is invalid')
  const resultHead = decodeEncryptedWalletBackupOwnerCurrentHead(raw.resultHead)
  const finalizedObjects = decodeObjects(raw.finalizedObjects)
  const supersededBundleIds = decodeBundleIds(raw.supersededBundleIds)
  return Object.freeze({
    formatVersion: 3,
    kind: 'bundle-supersession-receipt',
    ownerScopeId: requireLowerHex(raw.ownerScopeId, 32, 'owner scope id'),
    realm: requireRealm(raw.realm),
    walletId: requireLowerHex(raw.walletId, 32, 'wallet id'),
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
  receipt: EncryptedWalletBackupOwnerBundleSupersessionReceipt,
  envelope: ReturnType<typeof requireMutation>,
): void {
  const mutation = envelope.mutation
  if (
    receipt.ownerScopeId !== mutation.ownerScopeId ||
    receipt.realm !== mutation.realm ||
    receipt.walletId !== mutation.walletId ||
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
    receipt.resultHead.ownerScopeId !== receipt.ownerScopeId ||
    receipt.resultHead.realm !== receipt.realm ||
    receipt.resultHead.walletId !== receipt.walletId ||
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

function receiptDigest(receipt: EncryptedWalletBackupOwnerBundleSupersessionReceipt): string {
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode(RECEIPT_DOMAIN))
      .update(
        encodeCanonicalBackupCbor([
          3,
          'bundle-supersession-receipt',
          hexToBytesStrict(receipt.ownerScopeId, 32, 'owner scope id'),
          receipt.realm,
          hexToBytesStrict(receipt.walletId, 32, 'wallet id'),
          receipt.enrollmentEpoch,
          hexToBytesStrict(receipt.requestAuthPublicKey, 32, 'request public key'),
          hexToBytesStrict(receipt.mutationId, 16, 'mutation id'),
          hexToBytesStrict(receipt.requestDigest, 32, 'request digest'),
          receipt.previousHeadVersion,
          hexToBytesStrict(receipt.previousActiveSetDigest, 32, 'active set digest'),
          encodeEncryptedWalletBackupOwnerCurrentHead(receipt.resultHead),
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

function freezeReceipt(
  value: EncryptedWalletBackupOwnerBundleSupersessionReceipt,
): EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  return decodeReceipt({
    ...value,
    resultHead: { ...value.resultHead },
    finalizedObjects: value.finalizedObjects.map((item) => ({ ...item })),
    supersededBundleIds: [...value.supersededBundleIds],
  })
}

const receiptFields = [
  'formatVersion',
  'kind',
  'ownerScopeId',
  'realm',
  'walletId',
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
/** Rebinds two genuine capabilities before deriving local receipt-result evidence. */
export function requireEncryptedWalletBackupOwnerReceiptMutation(input: {
  readonly receiptEvidence: unknown
  readonly mutationEvidence: unknown
  readonly expectedContext: EncryptedWalletBackupOwnerContext
}): EncryptedWalletBackupOwnerBundleSupersessionReceipt {
  const context = decodeEncryptedWalletBackupOwnerContext(input.expectedContext)
  const receipt = requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt(
    input.receiptEvidence,
    context,
  ).receipt
  const mutation = requireMutation(input.mutationEvidence, context)
  bindReceipt(receipt, mutation)
  return receipt
}
