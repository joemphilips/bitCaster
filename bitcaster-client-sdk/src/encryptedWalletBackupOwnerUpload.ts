import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import { preflightEncryptedWalletBackupV2CborTuple } from './encryptedWalletBackupV2Cbor.ts'
import { encodeGroupObjects, decodeGroupObjects } from './encryptedWalletBackupUploadObjects.ts'
import {
  decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation,
  verifyEncryptedWalletBackupOwnerBundleSupersessionMutation,
  type EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation,
} from './encryptedWalletBackupOwnerMutation.ts'
import {
  encodeEncryptedWalletBackupOwnerSignedMutation,
  decodeEncryptedWalletBackupOwnerSignedMutationWire,
} from './encryptedWalletBackupOwnerServiceCodec.ts'
import {
  decodeEncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerContext,
} from './encryptedWalletBackupOwnerHead.ts'
import { type EncryptedWalletBackupV2BundleObjectWire } from './encryptedWalletBackupV2Bundle.ts'
import { equalBytes, requireBytes } from './encryptedWalletBackupServerValidation.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES as MAX } from './encryptedWalletBackupV2Limits.ts'
export interface DecodedEncryptedWalletBackupOwnerUploadGroup {
  readonly mutationEvidence: EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation
  readonly objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}
export function encodeEncryptedWalletBackupOwnerUploadGroup(input: {
  readonly envelope: unknown
  readonly objects: unknown
}): Uint8Array {
  const envelope = decodeEncryptedWalletBackupOwnerSignedBundleSupersessionMutation(input.envelope),
    m = envelope.mutation
  const context = decodeEncryptedWalletBackupOwnerContext({
    ownerScopeId: m.ownerScopeId,
    realm: m.realm,
    walletId: m.walletId,
    enrollmentEpoch: m.enrollmentEpoch,
  })
  const evidence = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
    envelope,
    expectedContext: context,
    expectedRequestAuthPublicKey: envelope.requestAuthPublicKey,
  })
  const result = encodeCanonicalBackupCbor([
    3,
    'bundle-supersession-upload-group',
    encodeEncryptedWalletBackupOwnerSignedMutation(envelope),
    encodeGroupObjects(input.objects, evidence.envelope),
  ])
  if (result.length > MAX) throw new Error('backup owner upload group size')
  return result
}
export function decodeEncryptedWalletBackupOwnerUploadGroup(input: {
  readonly bytes: Uint8Array
  readonly expectedContext: EncryptedWalletBackupOwnerContext
  readonly expectedRequestAuthPublicKey: string
}): DecodedEncryptedWalletBackupOwnerUploadGroup {
  preflightEncryptedWalletBackupV2CborTuple(input.bytes, {
    maximumBytes: MAX,
    maximumDepth: 2,
    maximumTokens: 20,
    maximumArrayLength: 15,
    maximumItemLength: 300000,
    fields: [
      { major: 0, exact: 3 },
      { major: 3, exact: 'bundle-supersession-upload-group' },
      { major: 2, minimum: 1, maximum: 65536 },
      { major: 4, minimum: 0, maximum: 15 },
    ],
  })
  const tuple = decode(input.bytes)
  if (!Array.isArray(tuple) || !equalBytes(input.bytes, encodeCanonicalBackupCbor(tuple)))
    throw new Error('backup owner upload group encoding')
  const envelope = decodeEncryptedWalletBackupOwnerSignedMutationWire(
    requireBytes(tuple[2], 1, 65536, 'mutation'),
  )
  const mutationEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
    envelope,
    expectedContext: input.expectedContext,
    expectedRequestAuthPublicKey: input.expectedRequestAuthPublicKey,
  })
  return Object.freeze({
    mutationEvidence,
    objects: Object.freeze(decodeGroupObjects(tuple[3], envelope)),
  })
}
