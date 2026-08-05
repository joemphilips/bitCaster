import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  decodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX,
  ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import type { EncryptedWalletBackupV2CurrentHead } from './encryptedWalletBackupV2Head.ts'
import {
  deriveEncryptedWalletBackupV2RequestAuthScalar,
  requireEncryptedWalletBackupV2KeyAuthority,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import {
  ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
  type EncryptedWalletBackupV2KeyHandle,
} from './encryptedWalletBackupV2Keys.ts'
import {
  hexToBytesStrict,
  requireLowerHex,
  requireRealm,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX = 256 as const

export interface EncryptedWalletBackupV2BundleSupersessionMutation {
  readonly formatVersion: 2
  readonly kind: 'bundle-supersession'
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
  readonly mutationId: string
  readonly expectedHeadVersion: number
  readonly expectedActiveSetDigest: string
  readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null
  readonly supersededBundleIds: readonly string[]
}

export interface EncryptedWalletBackupV2SignedBundleSupersessionMutation {
  readonly mutation: EncryptedWalletBackupV2BundleSupersessionMutation
  readonly requestAuthPublicKey: string
  readonly requestDigest: string
  readonly signature: string
}

export interface EncryptedWalletBackupV2VerifiedBundleSupersessionMutation {
  readonly envelope: EncryptedWalletBackupV2SignedBundleSupersessionMutation
}

export interface EncryptedWalletBackupV2MutationRuntime {
  getRandomValues(target: Uint8Array): Uint8Array
}

const MUTATION_DIGEST_DOMAIN = 'bitcaster/encrypted-wallet-backup-v2-mutation/v1\0'
const VERIFIED_MUTATIONS = new WeakSet<object>()

export async function prepareEncryptedWalletBackupV2BundleSupersessionMutation(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly expectedHead: EncryptedWalletBackupV2CurrentHead
  readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null
  readonly supersededBundleIds: readonly string[]
  readonly runtime: EncryptedWalletBackupV2MutationRuntime
}): Promise<EncryptedWalletBackupV2SignedBundleSupersessionMutation> {
  const prepared = snapshotPreparationInput(input)
  const authority = requireEncryptedWalletBackupV2KeyAuthority(prepared.keyHandle)
  const mutation = decodeMutation(
    {
      formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
      kind: 'bundle-supersession',
      realm: prepared.context.realm,
      vaultId: prepared.context.vaultId,
      enrollmentEpoch: prepared.context.enrollmentEpoch,
      mutationId: toHex(randomBytes(prepared.runtime, 16)),
      expectedHeadVersion: prepared.context.expectedHeadVersion,
      expectedActiveSetDigest: prepared.context.expectedActiveSetDigest,
      addedBundle: prepared.addedBundle,
      supersededBundleIds: prepared.supersededBundleIds,
    },
    prepared.context,
  )
  const digest = mutationDigest(mutation, prepared.requestAuthPublicKey)
  const aux = randomBytes(prepared.runtime, 32)
  const scalar = await deriveEncryptedWalletBackupV2RequestAuthScalar(
    authority,
    prepared.context.realm,
  )
  const signature = toHex(schnorr.sign(hexToBytesStrict(digest, 32, 'request digest'), scalar, aux))
  return freezeEnvelope(mutation, prepared.requestAuthPublicKey, digest, signature)
}

export function verifyEncryptedWalletBackupV2BundleSupersessionMutation(input: {
  readonly envelope: unknown
  readonly expectedRequestAuthPublicKey: string
  readonly expectedContext: {
    readonly realm: string
    readonly vaultId: string
    readonly enrollmentEpoch: number
  }
}): EncryptedWalletBackupV2VerifiedBundleSupersessionMutation {
  const expected = decodeVerificationContext(input.expectedContext)
  const expectedPublicKey = requirePublicKey(input.expectedRequestAuthPublicKey)
  const envelope = decodeEnvelope(input.envelope, expected)
  if (envelope.requestAuthPublicKey !== expectedPublicKey)
    throw new Error('encrypted backup mutation key is invalid')
  const digest = mutationDigest(envelope.mutation, envelope.requestAuthPublicKey)
  if (
    envelope.requestDigest !== digest ||
    !schnorr.verify(
      hexToBytesStrict(envelope.signature, 64, 'mutation signature'),
      hexToBytesStrict(digest, 32, 'request digest'),
      hexToBytesStrict(envelope.requestAuthPublicKey, 32, 'request public key'),
    )
  ) {
    throw new Error('encrypted backup mutation signature is invalid')
  }
  const evidence = Object.freeze({ envelope })
  VERIFIED_MUTATIONS.add(evidence)
  return evidence
}

export function requireEncryptedWalletBackupV2VerifiedBundleSupersessionMutation(
  value: unknown,
): EncryptedWalletBackupV2VerifiedBundleSupersessionMutation {
  if (typeof value !== 'object' || value === null || !VERIFIED_MUTATIONS.has(value))
    throw new Error('encrypted backup verified mutation is invalid')
  return value as EncryptedWalletBackupV2VerifiedBundleSupersessionMutation
}

export function digestEncryptedWalletBackupV2BundleSupersessionMutation(input: {
  readonly mutation: unknown
  readonly requestAuthPublicKey: string
}): string {
  const mutationValue = input.mutation
  const requestAuthPublicKeyValue = input.requestAuthPublicKey
  return mutationDigest(decodeMutation(mutationValue), requirePublicKey(requestAuthPublicKeyValue))
}

function snapshotPreparationInput(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly expectedHead: EncryptedWalletBackupV2CurrentHead
  readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null
  readonly supersededBundleIds: readonly string[]
  readonly runtime: EncryptedWalletBackupV2MutationRuntime
}): {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly context: ExpectedHeadContext
  readonly requestAuthPublicKey: string
  readonly addedBundle: unknown
  readonly supersededBundleIds: unknown
  readonly runtime: EncryptedWalletBackupV2MutationRuntime
} {
  const keyHandle = input.keyHandle
  const expectedHead = input.expectedHead
  const addedBundle = input.addedBundle
  const supersededBundleIds = input.supersededBundleIds
  const runtime = requireMutationRuntime(input.runtime)
  const key = decodeKeyHandle(keyHandle)
  const context = decodeExpectedHead(expectedHead)
  if (context.realm !== key.realm || context.vaultId !== key.vaultId)
    throw new Error('encrypted backup mutation context is invalid')
  return {
    keyHandle,
    context,
    requestAuthPublicKey: key.requestAuthPublicKey,
    addedBundle,
    supersededBundleIds,
    runtime,
  }
}

function decodeEnvelope(
  value: unknown,
  expected: MutationScope,
): EncryptedWalletBackupV2SignedBundleSupersessionMutation {
  const record = exactRecord(value, [
    'mutation',
    'requestAuthPublicKey',
    'requestDigest',
    'signature',
  ])
  const mutationValue = record.mutation
  const requestAuthPublicKeyValue = record.requestAuthPublicKey
  const requestDigestValue = record.requestDigest
  const signatureValue = record.signature
  return freezeEnvelope(
    decodeMutation(mutationValue, expected),
    requirePublicKey(requestAuthPublicKeyValue),
    requireLowerHex(requestDigestValue, 32, 'request digest'),
    requireLowerHex(signatureValue, 64, 'mutation signature'),
  )
}

function freezeEnvelope(
  mutation: EncryptedWalletBackupV2BundleSupersessionMutation,
  requestAuthPublicKey: string,
  requestDigest: string,
  signature: string,
): EncryptedWalletBackupV2SignedBundleSupersessionMutation {
  return Object.freeze({
    mutation: cloneMutation(mutation),
    requestAuthPublicKey,
    requestDigest,
    signature,
  })
}

function decodeMutation(
  value: unknown,
  expected?: MutationScope,
): EncryptedWalletBackupV2BundleSupersessionMutation {
  const raw = snapshotMutationRecord(value)
  if (
    raw.formatVersion !== ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION ||
    raw.kind !== 'bundle-supersession'
  )
    throw new Error('encrypted backup mutation is invalid')
  const context = decodeMutationContext(raw)
  if (expected !== undefined && !sameScope(context, expected))
    throw new Error('encrypted backup mutation context is invalid')
  const supersededBundleIds = decodeSupersededBundleIds(raw.supersededBundleIds)
  const addedBundle = decodeAddedBundle(raw.addedBundle, context)
  requireMutationMode(addedBundle, supersededBundleIds)
  return Object.freeze({ ...context, addedBundle, supersededBundleIds })
}

function snapshotMutationRecord(value: unknown): Record<string, unknown> {
  const record = exactRecord(value, [
    'formatVersion',
    'kind',
    'realm',
    'vaultId',
    'enrollmentEpoch',
    'mutationId',
    'expectedHeadVersion',
    'expectedActiveSetDigest',
    'addedBundle',
    'supersededBundleIds',
  ])
  return {
    formatVersion: record.formatVersion,
    kind: record.kind,
    realm: record.realm,
    vaultId: record.vaultId,
    enrollmentEpoch: record.enrollmentEpoch,
    mutationId: record.mutationId,
    expectedHeadVersion: record.expectedHeadVersion,
    expectedActiveSetDigest: record.expectedActiveSetDigest,
    addedBundle: record.addedBundle,
    supersededBundleIds: record.supersededBundleIds,
  }
}

function decodeMutationContext(value: Record<string, unknown>): MutationContext {
  return Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    kind: 'bundle-supersession' as const,
    realm: requireRealm(value.realm),
    vaultId: requireLowerHex(value.vaultId, 32, 'vault id'),
    enrollmentEpoch: positive(value.enrollmentEpoch, 'enrollment epoch'),
    mutationId: requireLowerHex(value.mutationId, 16, 'mutation id'),
    expectedHeadVersion: bounded(
      value.expectedHeadVersion,
      0,
      Number.MAX_SAFE_INTEGER,
      'expected head version',
    ),
    expectedActiveSetDigest: requireLowerHex(
      value.expectedActiveSetDigest,
      32,
      'active set digest',
    ),
  })
}

function decodeSupersededBundleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX)
    throw new Error('encrypted backup superseded bundles are invalid')
  const bundleIds = value.map((item) => requireLowerHex(item, 16, 'superseded bundle id'))
  if (bundleIds.some((item, index) => index > 0 && item <= bundleIds[index - 1]!))
    throw new Error('encrypted backup superseded bundles are invalid')
  return Object.freeze(bundleIds)
}

function decodeAddedBundle(
  value: unknown,
  context: MutationScope,
): EncryptedWalletBackupV2BundleDescriptor | null {
  return value === null ? null : decodeEncryptedWalletBackupV2BundleDescriptor(value, context)
}

function requireMutationMode(
  addedBundle: EncryptedWalletBackupV2BundleDescriptor | null,
  supersededBundleIds: readonly string[],
): void {
  if (addedBundle === null && supersededBundleIds.length === 0)
    throw new Error('encrypted backup mutation is a no-op')
  if (addedBundle !== null && supersededBundleIds.includes(addedBundle.bundleId))
    throw new Error('encrypted backup mutation supersedes its added bundle')
}

function mutationDigest(
  mutation: EncryptedWalletBackupV2BundleSupersessionMutation,
  requestAuthPublicKey: string,
): string {
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode(MUTATION_DIGEST_DOMAIN))
      .update(encodeMutationPreimage(mutation, requestAuthPublicKey))
      .digest(),
  )
}

function encodeMutationPreimage(
  mutation: EncryptedWalletBackupV2BundleSupersessionMutation,
  requestAuthPublicKey: string,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
    'bundle-supersession',
    hexToBytesStrict(requestAuthPublicKey, 32, 'request public key'),
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
    mutation.supersededBundleIds.map((bundleId) =>
      hexToBytesStrict(bundleId, 16, 'superseded bundle id'),
    ),
  ])
}

function decodeExpectedHead(value: unknown): ExpectedHeadContext {
  const record = exactRecord(value, [
    'formatVersion',
    'realm',
    'vaultId',
    'enrollmentEpoch',
    'headVersion',
    'activeBundleCount',
    'activeObjectCount',
    'activeSetDigest',
  ])
  const formatVersion = record.formatVersion
  const realm = record.realm
  const vaultId = record.vaultId
  const enrollmentEpoch = record.enrollmentEpoch
  const headVersion = record.headVersion
  const activeBundleCount = record.activeBundleCount
  const activeObjectCount = record.activeObjectCount
  const activeSetDigest = record.activeSetDigest
  if (formatVersion !== ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION)
    throw new Error('encrypted backup expected head is invalid')
  bounded(activeBundleCount, 0, ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_BUNDLE_MAX, 'active bundle count')
  bounded(
    activeObjectCount,
    0,
    ENCRYPTED_WALLET_BACKUP_V2_ACTIVE_OBJECT_REFERENCE_MAX,
    'active object count',
  )
  return Object.freeze({
    realm: requireRealm(realm),
    vaultId: requireLowerHex(vaultId, 32, 'vault id'),
    enrollmentEpoch: positive(enrollmentEpoch, 'enrollment epoch'),
    expectedHeadVersion: bounded(headVersion, 0, Number.MAX_SAFE_INTEGER, 'head version'),
    expectedActiveSetDigest: requireLowerHex(activeSetDigest, 32, 'active set digest'),
  })
}

function decodeVerificationContext(value: unknown): MutationScope {
  const record = exactRecord(value, ['realm', 'vaultId', 'enrollmentEpoch'])
  return Object.freeze({
    realm: requireRealm(record.realm),
    vaultId: requireLowerHex(record.vaultId, 32, 'vault id'),
    enrollmentEpoch: positive(record.enrollmentEpoch, 'enrollment epoch'),
  })
}

function decodeKeyHandle(value: EncryptedWalletBackupV2KeyHandle): KeyContext {
  const formatVersion = value.formatVersion
  const realm = value.realm
  const vaultId = value.vaultId
  const requestAuthPublicKey = value.requestAuthPublicKey
  if (formatVersion !== ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION)
    throw new Error('encrypted backup v2 key handle is invalid')
  return Object.freeze({
    realm: requireRealm(realm),
    vaultId: requireLowerHex(vaultId, 32, 'vault id'),
    requestAuthPublicKey: requirePublicKey(requestAuthPublicKey),
  })
}

function requireMutationRuntime(value: unknown): EncryptedWalletBackupV2MutationRuntime {
  if (typeof value !== 'object' || value === null)
    throw new Error('encrypted backup mutation runtime is invalid')
  const getRandomValues = (value as { getRandomValues?: unknown }).getRandomValues
  if (typeof getRandomValues !== 'function')
    throw new Error('encrypted backup mutation runtime is invalid')
  return Object.freeze({
    getRandomValues: (target: Uint8Array) => getRandomValues.call(value, target) as Uint8Array,
  })
}

function randomBytes(runtime: EncryptedWalletBackupV2MutationRuntime, length: number): Uint8Array {
  const target = new Uint8Array(length)
  if (runtime.getRandomValues(target) !== target)
    throw new Error('encrypted backup mutation randomness is invalid')
  return target
}

function cloneMutation(
  mutation: EncryptedWalletBackupV2BundleSupersessionMutation,
): EncryptedWalletBackupV2BundleSupersessionMutation {
  return Object.freeze({
    ...mutation,
    addedBundle:
      mutation.addedBundle === null
        ? null
        : decodeEncryptedWalletBackupV2BundleDescriptor(mutation.addedBundle),
    supersededBundleIds: Object.freeze([...mutation.supersededBundleIds]),
  })
}

function sameScope(left: MutationScope, right: MutationScope): boolean {
  return (
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.enrollmentEpoch === right.enrollmentEpoch
  )
}

function requirePublicKey(value: unknown): string {
  const publicKey = requireLowerHex(value, 32, 'request public key')
  requireValidXOnlyPublicKey(
    hexToBytesStrict(publicKey, 32, 'request public key'),
    'request public key',
  )
  return publicKey
}

function positive(value: unknown, name: string): number {
  return bounded(value, 1, Number.MAX_SAFE_INTEGER, name)
}

function bounded(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`encrypted backup ${name} is invalid`)
  return value as number
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('encrypted backup mutation is invalid')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
  )
    throw new Error('encrypted backup mutation is invalid')
  return record
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface MutationScope {
  readonly realm: string
  readonly vaultId: string
  readonly enrollmentEpoch: number
}

interface ExpectedHeadContext extends MutationScope {
  readonly expectedHeadVersion: number
  readonly expectedActiveSetDigest: string
}

interface MutationContext extends ExpectedHeadContext {
  readonly formatVersion: 2
  readonly kind: 'bundle-supersession'
  readonly mutationId: string
}

interface KeyContext {
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
}
