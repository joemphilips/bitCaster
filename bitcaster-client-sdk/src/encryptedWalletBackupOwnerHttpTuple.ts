import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  preflightEncryptedWalletBackupV2CborTuple,
  type EncryptedWalletBackupV2CborField,
} from './encryptedWalletBackupV2Cbor.ts'
import { equalBytes } from './encryptedWalletBackupServerValidation.ts'
/** Bounded structural parsing only; each caller must bind the decoded authority. */
export function decodeOwnerHttpTuple(
  bytes: Uint8Array,
  maximumBytes: number,
  fields: readonly EncryptedWalletBackupV2CborField[],
): unknown[] {
  preflightEncryptedWalletBackupV2CborTuple(bytes, {
    maximumBytes,
    maximumDepth: 1,
    maximumTokens: fields.length + 1,
    maximumArrayLength: fields.length,
    maximumItemLength: maximumBytes,
    fields,
  })
  let value: unknown
  try {
    value = decode(bytes)
  } catch {
    throw new Error('encrypted backup owner HTTP tuple is invalid')
  }
  if (
    !Array.isArray(value) ||
    value.length !== fields.length ||
    !equalBytes(bytes, encodeCanonicalBackupCbor(value))
  )
    throw new Error('encrypted backup owner HTTP tuple is invalid')
  return value
}
export const ownerHttpUint = (exact?: number): EncryptedWalletBackupV2CborField =>
  exact === undefined
    ? { major: 0, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
    : { major: 0, exact }
export const ownerHttpBytes = (
  minimum: number,
  maximum = minimum,
): EncryptedWalletBackupV2CborField => ({ major: 2, minimum, maximum })
export const ownerHttpText = (exact: string): EncryptedWalletBackupV2CborField => ({
  major: 3,
  exact,
})
export const ownerHttpTextLength = (maximum: number): EncryptedWalletBackupV2CborField => ({
  major: 3,
  minimum: 1,
  maximum,
})
export const ownerHttpNullable = (
  field: EncryptedWalletBackupV2CborField,
): EncryptedWalletBackupV2CborField => ({
  major: 7,
  alternatives: [field, { major: 7, exact: 22 }],
})
