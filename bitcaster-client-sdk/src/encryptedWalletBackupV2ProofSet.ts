import { requireLowerHex, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'
import { canonicalizeMintIdentityUrl } from './tokenImportValidation.ts'

// The recovery index replaced the encrypted backup that defined these values.
// Browser custody rows and local removal markers still store them, so the
// names and the encodings stay unchanged.

const MINT_MAX_BYTES = 2_048
const OUTCOME_MAX_BYTES = 256

export type EncryptedWalletBackupV2ProofSetAsset =
  | { readonly kind: 'ordinary' }
  | {
      readonly kind: 'ctf'
      readonly conditionId: string
      readonly outcomeLabel: string
      readonly outcomeCollectionId: string
      readonly registeredAt: number
      readonly finalExpiry: number | null
    }

export interface EncryptedWalletBackupV2AssetIdentity {
  readonly mintUrl: string
  readonly unit: string
  readonly assetIdentity: string
}

export interface EncryptedWalletBackupV2TerminalSeal {
  readonly schemaVersion: 1 | 2
  readonly kind: 'ctf-verified-losing' | 'ctf-verified-losing-v2'
  readonly operationIdDigest: string
  readonly requestDigest: string
  readonly code: 13015
  readonly classifiedAtMs: number
  readonly proofCommitment: string
  readonly verifiedContextDigest?: string
  readonly authenticationCode?: string
}

/** Decode retained terminal history. This alone does not establish losing authority. */
export function decodeEncryptedWalletBackupV2TerminalSeal(
  value: unknown,
): EncryptedWalletBackupV2TerminalSeal {
  if (!isRecord(value)) throw new Error('encrypted backup terminal seal is invalid')
  const compact = value.schemaVersion === 2 && value.kind === 'ctf-verified-losing-v2'
  const historical = value.schemaVersion === 1 && value.kind === 'ctf-verified-losing'
  if (
    (!compact && !historical) ||
    value.code !== 13015 ||
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'operationIdDigest',
      'requestDigest',
      'code',
      'classifiedAtMs',
      'proofCommitment',
      ...(compact ? ['verifiedContextDigest', 'authenticationCode'] : []),
    ])
  )
    throw new Error('encrypted backup terminal seal is invalid')
  return Object.freeze({
    schemaVersion: compact ? 2 : 1,
    kind: compact ? 'ctf-verified-losing-v2' : 'ctf-verified-losing',
    operationIdDigest: requireLowerHex(value.operationIdDigest, 32, 'terminal operation digest'),
    requestDigest: requireLowerHex(value.requestDigest, 32, 'terminal request digest'),
    code: 13015,
    classifiedAtMs: requireUnixTime(value.classifiedAtMs),
    proofCommitment: requireLowerHex(value.proofCommitment, 32, 'terminal proof commitment'),
    ...(compact
      ? {
          verifiedContextDigest: requireLowerHex(
            value.verifiedContextDigest,
            32,
            'terminal context digest',
          ),
          authenticationCode: requireLowerHex(
            value.authenticationCode,
            32,
            'terminal authentication code',
          ),
        }
      : {}),
  })
}

/** Creates the canonical asset identity of one mint, unit, and asset. */
export function createEncryptedWalletBackupV2AssetIdentity(input: {
  readonly mintUrl: string
  readonly unit: string
  readonly asset: EncryptedWalletBackupV2ProofSetAsset
}): EncryptedWalletBackupV2AssetIdentity {
  const asset = decodeAsset(input.asset)
  return decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: input.mintUrl,
    unit: input.unit,
    assetIdentity: assetIdentity(asset),
  })
}

/** Encodes one canonical local asset key without delimiter ambiguity. */
export function encryptedWalletBackupV2LocalAssetKey(value: unknown): string {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(value)
  return JSON.stringify([asset.mintUrl, asset.unit, asset.assetIdentity])
}

/** Strictly decodes a canonical V2 asset identity. */
export function decodeEncryptedWalletBackupV2AssetIdentity(
  value: unknown,
): EncryptedWalletBackupV2AssetIdentity {
  if (!isRecord(value) || !exactKeys(value, ['mintUrl', 'unit', 'assetIdentity']))
    throw new Error('encrypted backup proof set asset is invalid')
  const assetIdentity = requireAssetIdentity(value.assetIdentity)
  return Object.freeze({
    mintUrl: requireCanonicalMint(value.mintUrl),
    unit: requireUnit(value.unit),
    assetIdentity,
  })
}

function decodeAsset(value: unknown): EncryptedWalletBackupV2ProofSetAsset {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new Error('encrypted backup proof set asset is invalid')
  switch (value.kind) {
    case 'ordinary':
      if (!exactKeys(value, ['kind'])) break
      return Object.freeze({ kind: 'ordinary' })
    case 'ctf':
      if (
        !exactKeys(value, [
          'kind',
          'conditionId',
          'outcomeLabel',
          'outcomeCollectionId',
          'registeredAt',
          'finalExpiry',
        ])
      )
        break
      const registeredAt = requireUnixTime(value.registeredAt)
      const finalExpiry = requireOptionalPositiveUnixTime(value.finalExpiry)
      if (finalExpiry !== null && finalExpiry <= registeredAt)
        throw new Error('encrypted backup proof set asset is invalid')
      return Object.freeze({
        kind: 'ctf',
        conditionId: requireLowerHex(value.conditionId, 32, 'condition id'),
        outcomeLabel: requireUtf8Text(value.outcomeLabel, OUTCOME_MAX_BYTES, 'outcome label'),
        outcomeCollectionId: requireLowerHex(
          value.outcomeCollectionId,
          32,
          'outcome collection id',
        ),
        registeredAt,
        finalExpiry,
      })
  }
  throw new Error('encrypted backup proof set asset is invalid')
}

function requireAssetIdentity(value: unknown): string {
  const identity = requireUtf8Text(value, 256, 'encrypted backup asset identity')
  if (identity === 'cashu:ordinary' || /^ctf:[0-9a-f]{64}:[0-9a-f]{64}$/.test(identity)) {
    return identity
  }
  throw new Error('encrypted backup asset identity is invalid')
}

function assetIdentity(asset: EncryptedWalletBackupV2ProofSetAsset): string {
  switch (asset.kind) {
    case 'ordinary':
      return 'cashu:ordinary'
    case 'ctf':
      return `ctf:${asset.conditionId}:${asset.outcomeCollectionId}`
  }
}

function requireCanonicalMint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('encrypted backup mint URL is invalid')
  const canonical = canonicalizeMintIdentityUrl(value)
  if (canonical !== value || new TextEncoder().encode(value).byteLength > MINT_MAX_BYTES)
    throw new Error('encrypted backup mint URL is invalid')
  return value
}

function requireUnit(value: unknown): 'sat' | 'msat' {
  if (value !== 'sat' && value !== 'msat') throw new Error('encrypted backup unit is invalid')
  return value
}

function requireUnixTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('encrypted backup time is invalid')
  return value
}

function requireOptionalPositiveUnixTime(value: unknown): number | null {
  if (value === null) return null
  const timestamp = requireUnixTime(value)
  if (timestamp < 1) throw new Error('encrypted backup time is invalid')
  return timestamp
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}
