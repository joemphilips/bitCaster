import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  bounded,
  exactRecord,
  toHex,
  decodeSupersededBundleIds,
  requireExactAssetReplacement,
  requireMutationMode,
} from './encryptedWalletBackupAuthorityValidation.ts'
import {
  decodeEncryptedWalletBackupV2BundleDescriptor,
  encodeEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  decodeEncryptedWalletBackupOwnerContext,
  requireEncryptedWalletBackupOwnerContext,
  requireEncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerCollectedHeadEvidence,
} from './encryptedWalletBackupOwnerHead.ts'
import {
  deriveEncryptedWalletBackupV2RequestAuthScalar,
  requireEncryptedWalletBackupV2KeyAuthority,
} from './encryptedWalletBackupV2KeyAuthority.ts'
import { type EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import { type EncryptedWalletBackupV2MutationRuntime } from './encryptedWalletBackupV2Mutation.ts'
import {
  hexToBytesStrict,
  requireLowerHex,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'

export interface EncryptedWalletBackupOwnerBundleSupersessionMutation extends EncryptedWalletBackupOwnerContext {
  readonly formatVersion: 3
  readonly kind: 'bundle-supersession'
  readonly mutationId: string
  readonly expectedHeadVersion: number
  readonly expectedActiveSetDigest: string
  readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null
  readonly supersededBundleIds: readonly string[]
}
export interface EncryptedWalletBackupOwnerSignedBundleSupersessionMutation {
  readonly mutation: EncryptedWalletBackupOwnerBundleSupersessionMutation
  readonly requestAuthPublicKey: string
  readonly requestDigest: string
  readonly signature: string
}
export interface EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation {
  readonly envelope: EncryptedWalletBackupOwnerSignedBundleSupersessionMutation
}
const VERIFIED = new WeakSet<object>()
function publicKey(value: unknown): string {
  const key = requireLowerHex(value, 32, 'request public key')
  requireValidXOnlyPublicKey(hexToBytesStrict(key, 32, 'request public key'), 'request public key')
  return key
}
function decodeMutation(value: unknown): EncryptedWalletBackupOwnerBundleSupersessionMutation {
  const r = exactRecord(value, [
    'formatVersion',
    'kind',
    'ownerScopeId',
    'realm',
    'walletId',
    'enrollmentEpoch',
    'mutationId',
    'expectedHeadVersion',
    'expectedActiveSetDigest',
    'addedBundle',
    'supersededBundleIds',
  ])
  if (r.formatVersion !== 3 || r.kind !== 'bundle-supersession')
    throw new Error('encrypted backup owner mutation version is invalid')
  const context = decodeEncryptedWalletBackupOwnerContext({
    ownerScopeId: r.ownerScopeId,
    realm: r.realm,
    walletId: r.walletId,
    enrollmentEpoch: r.enrollmentEpoch,
  })
  const addedBundle =
      r.addedBundle === null
        ? null
        : decodeEncryptedWalletBackupV2BundleDescriptor(r.addedBundle, context),
    supersededBundleIds = decodeSupersededBundleIds(r.supersededBundleIds)
  requireMutationMode(addedBundle, supersededBundleIds)
  return Object.freeze({
    formatVersion: 3,
    kind: 'bundle-supersession',
    ...context,
    mutationId: requireLowerHex(r.mutationId, 16, 'mutation id'),
    expectedHeadVersion: bounded(
      r.expectedHeadVersion,
      0,
      Number.MAX_SAFE_INTEGER,
      'expected head version',
    ),
    expectedActiveSetDigest: requireLowerHex(r.expectedActiveSetDigest, 32, 'active set digest'),
    addedBundle,
    supersededBundleIds,
  })
}
/** Structural decoding does not verify a signature or grant mutation authority. */
export function decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation(
  value: unknown,
): EncryptedWalletBackupOwnerSignedBundleSupersessionMutation {
  const r = exactRecord(value, ['mutation', 'requestAuthPublicKey', 'requestDigest', 'signature'])
  return Object.freeze({
    mutation: decodeMutation(r.mutation),
    requestAuthPublicKey: publicKey(r.requestAuthPublicKey),
    requestDigest: requireLowerHex(r.requestDigest, 32, 'request digest'),
    signature: requireLowerHex(r.signature, 64, 'signature'),
  })
}
export function digestEncryptedWalletBackupOwnerBundleSupersessionMutation(input: {
  readonly mutation: unknown
  readonly requestAuthPublicKey: string
}): string {
  const m = decodeMutation(input.mutation),
    key = publicKey(input.requestAuthPublicKey)
  return toHex(
    sha256
      .create()
      .update(new TextEncoder().encode('bitcaster/encrypted-wallet-backup-v2-mutation/v2\0'))
      .update(
        encodeCanonicalBackupCbor([
          3,
          'bundle-supersession',
          hexToBytesStrict(key, 32, 'request public key'),
          3,
          'bundle-supersession',
          hexToBytesStrict(m.ownerScopeId, 32, 'owner scope id'),
          m.realm,
          hexToBytesStrict(m.walletId, 32, 'wallet id'),
          m.enrollmentEpoch,
          hexToBytesStrict(m.mutationId, 16, 'mutation id'),
          m.expectedHeadVersion,
          hexToBytesStrict(m.expectedActiveSetDigest, 32, 'active set digest'),
          m.addedBundle === null
            ? null
            : encodeEncryptedWalletBackupV2BundleDescriptor(m.addedBundle),
          m.supersededBundleIds.map((id) => hexToBytesStrict(id, 16, 'bundle id')),
        ]),
      )
      .digest(),
  )
}
export async function prepareEncryptedWalletBackupOwnerBundleSupersessionMutation(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly expectedContext: EncryptedWalletBackupOwnerContext
  readonly expectedHeadEvidence: EncryptedWalletBackupOwnerCollectedHeadEvidence
  readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null
  readonly supersededBundleIds: readonly string[]
  readonly runtime: EncryptedWalletBackupV2MutationRuntime
}): Promise<EncryptedWalletBackupOwnerSignedBundleSupersessionMutation> {
  const context = decodeEncryptedWalletBackupOwnerContext(input.expectedContext)
  const evidence = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
    input.expectedHeadEvidence,
    context,
  )
  const key = input.keyHandle,
    authority = requireEncryptedWalletBackupV2KeyAuthority(key)
  if (key.realm !== context.realm || key.walletId !== context.walletId)
    throw new Error('encrypted backup owner mutation key context is invalid')
  const requestAuthPublicKey = publicKey(key.requestAuthPublicKey)
  const addedBundle =
      input.addedBundle === null
        ? null
        : decodeEncryptedWalletBackupV2BundleDescriptor(input.addedBundle, context),
    supersededBundleIds = decodeSupersededBundleIds(input.supersededBundleIds)
  requireMutationMode(addedBundle, supersededBundleIds)
  requireExactAssetReplacement(addedBundle, supersededBundleIds, evidence.bundles)
  const runtime = input.runtime,
    getRandomValues = runtime?.getRandomValues
  if (typeof getRandomValues !== 'function')
    throw new Error('encrypted backup mutation runtime is invalid')
  const random = (length: number) => {
    const bytes = new Uint8Array(length)
    if (getRandomValues.call(runtime, bytes) !== bytes)
      throw new Error('encrypted backup mutation randomness is invalid')
    return bytes
  }
  const mutation = decodeMutation({
    formatVersion: 3,
    kind: 'bundle-supersession',
    ...context,
    mutationId: toHex(random(16)),
    expectedHeadVersion: evidence.head.headVersion,
    expectedActiveSetDigest: evidence.head.activeSetDigest,
    addedBundle,
    supersededBundleIds,
  })
  const requestDigest = digestEncryptedWalletBackupOwnerBundleSupersessionMutation({
      mutation,
      requestAuthPublicKey,
    }),
    aux = random(32)
  const scalar = await deriveEncryptedWalletBackupV2RequestAuthScalar(authority, context.realm)
  try {
    return Object.freeze({
      mutation,
      requestAuthPublicKey,
      requestDigest,
      signature: toHex(
        schnorr.sign(hexToBytesStrict(requestDigest, 32, 'request digest'), scalar, aux),
      ),
    })
  } finally {
    scalar.fill(0)
  }
}
export function verifyEncryptedWalletBackupOwnerBundleSupersessionMutation(input: {
  readonly envelope: unknown
  readonly expectedRequestAuthPublicKey: string
  readonly expectedContext: EncryptedWalletBackupOwnerContext
}): EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation {
  const context = decodeEncryptedWalletBackupOwnerContext(input.expectedContext),
    key = publicKey(input.expectedRequestAuthPublicKey),
    envelope = decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation(input.envelope)
  requireEncryptedWalletBackupOwnerContext(envelope.mutation, context)
  const digest = digestEncryptedWalletBackupOwnerBundleSupersessionMutation(envelope)
  if (
    envelope.requestAuthPublicKey !== key ||
    envelope.requestDigest !== digest ||
    !schnorr.verify(
      hexToBytesStrict(envelope.signature, 64, 'signature'),
      hexToBytesStrict(digest, 32, 'digest'),
      hexToBytesStrict(key, 32, 'public key'),
    )
  )
    throw new Error('encrypted backup owner mutation signature is invalid')
  const evidence = Object.freeze({ envelope })
  VERIFIED.add(evidence)
  return evidence
}
export function requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation(
  value: unknown,
  expectedContext: EncryptedWalletBackupOwnerContext,
): EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation {
  if (typeof value !== 'object' || value === null || !VERIFIED.has(value))
    throw new Error('encrypted backup owner verified mutation is invalid')
  const evidence = value as EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation
  requireEncryptedWalletBackupOwnerContext(evidence.envelope.mutation, expectedContext)
  return evidence
}
