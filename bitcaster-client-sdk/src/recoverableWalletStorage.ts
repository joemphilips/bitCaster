/** Persistence-neutral classifications for proof and CTF recovery. */
import * as Cashu from '@cashu/cashu-ts'
import {
  ORACLE_NOT_ATTESTED_OUTCOME_CODE,
  readAuthenticatedCtfRedeemTerminalEvidence,
  type AuthenticatedCtfRedeemTerminalEvidence,
} from './ctfRedeem.ts'
import {
  issueDurableWalletVerifiedLosingCtfClassification,
  requireDurableWalletVerifiedLosingCtfClassification,
} from './walletStorageAuthority.ts'

export interface DurableCustodySafeAbortEvidence {
  readonly operationState: 'dispatch-intent' | 'transport-attempted' | 'reconciled' | 'aborted'
  readonly submissionState: 'not-submitted' | 'submitted' | 'unknown'
  readonly exactInputStates: readonly ('unspent' | 'spent' | 'pending' | 'unknown')[]
  readonly exactRequestDisposition: 'deterministically-rejected' | 'not-rejected' | 'unknown'
  readonly hasDependentJournaledIntent: boolean
  readonly hasStagedResult: boolean
  readonly deliveryState: 'none' | 'pending' | 'acknowledged' | 'expired'
}

export function isDurableCustodySafeAbortEligible(
  evidence: DurableCustodySafeAbortEvidence,
): boolean {
  return (
    evidence.operationState === 'dispatch-intent' &&
    evidence.submissionState === 'not-submitted' &&
    evidence.exactInputStates.length > 0 &&
    evidence.exactInputStates.every((state) => state === 'unspent') &&
    evidence.exactRequestDisposition === 'deterministically-rejected' &&
    !evidence.hasDependentJournaledIntent &&
    !evidence.hasStagedResult &&
    evidence.deliveryState === 'none'
  )
}

export const DURABLE_WALLET_STORAGE_SCHEMA_VERSION = 1 as const
export interface DurableWalletVerifiedLosingCtfClassification {
  readonly schemaVersion: 1
}

export function verifyDurableWalletLosingCtfClassification(input: {
  readonly evidence: AuthenticatedCtfRedeemTerminalEvidence
  readonly operationId: string
  readonly mintUrl: string
  readonly conditionId: string
  readonly outcome: string
  readonly keysetId: string
  readonly proof: Readonly<{ readonly id: string; readonly secret: string }>
}): DurableWalletVerifiedLosingCtfClassification {
  const evidence = readAuthenticatedCtfRedeemTerminalEvidence(input.evidence)
  if (
    evidence.operationId !== input.operationId ||
    evidence.normalizedMint !== input.mintUrl ||
    evidence.rejectionBody.code !== ORACLE_NOT_ATTESTED_OUTCOME_CODE
  )
    throw new Error('CTF terminal evidence does not match proof operation')
  return issueDurableWalletVerifiedLosingCtfClassification()
}

export function requireDurableWalletLosingCtfClassification(
  value: unknown,
): DurableWalletVerifiedLosingCtfClassification {
  return requireDurableWalletVerifiedLosingCtfClassification(value)
}

/** Validates the mint-provided CTF keyset before recovery or custody admission. */
export function verifyDurableWalletConditionalKeyset(input: {
  readonly mint: string
  readonly unit: string
  readonly outcomeLabel: string
  readonly registeredAtUnixSeconds: number
  readonly mintKeys: unknown
  readonly conditionalMetadata: unknown
}): Readonly<{ readonly keysetId: string }> {
  const mint = requireMint(input.mint)
  const unit = requireText(input.unit, 64, 'conditional keyset unit')
  const outcomeLabel = requireText(input.outcomeLabel, 256, 'conditional outcome label')
  const registeredAt = requireInteger(
    input.registeredAtUnixSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'conditional registration time',
  )
  const keys = requireRecord(input.mintKeys, 'conditional mint keys')
  requireFields(
    keys,
    ['id', 'unit', 'keys'],
    ['active', 'input_fee_ppk', 'final_expiry', 'conditional'],
  )
  const keysetId = requireConditionalKeysetId(keys.id)
  if (keys.unit !== unit) throw new Error('conditional mint keys are invalid')
  const finalExpiry =
    keys.final_expiry === undefined
      ? null
      : requireInteger(keys.final_expiry, 1, Number.MAX_SAFE_INTEGER, 'conditional final expiry')
  if (finalExpiry !== null && finalExpiry <= registeredAt)
    throw new Error('conditional final expiry is invalid')
  const metadata = requireRecord(input.conditionalMetadata, 'conditional keyset metadata')
  requireFields(metadata, [
    'conditionId',
    'outcomeCollection',
    'outcomeCollectionId',
    'registeredAt',
  ])
  const conditionId = requireHex(metadata.conditionId, 32, 'conditional condition id')
  const outcomeCollection = requireText(
    metadata.outcomeCollection,
    256,
    'conditional outcome collection',
  )
  const outcomeCollectionId = requireHex(
    metadata.outcomeCollectionId,
    32,
    'conditional outcome collection id',
  )
  if (
    outcomeCollection !== outcomeLabel ||
    requireInteger(
      metadata.registeredAt,
      0,
      Number.MAX_SAFE_INTEGER,
      'conditional metadata registration',
    ) !== registeredAt
  )
    throw new Error('conditional keyset metadata does not match context')
  const denominations = requireRecord(keys.keys, 'conditional denomination keys')
  const entries = Object.entries(denominations)
  if (
    entries.length < 1 ||
    entries.length > 64 ||
    new TextEncoder().encode(JSON.stringify(denominations)).byteLength > 65_536
  )
    throw new Error('conditional denomination keys exceed bounds')
  for (const [amount, publicKey] of entries)
    if (
      !/^[1-9][0-9]{0,19}$/u.test(amount) ||
      BigInt(amount) > 18_446_744_073_709_551_615n ||
      typeof publicKey !== 'string' ||
      !/^(?:02|03)[0-9a-f]{64}$/u.test(publicKey)
    )
      throw new Error('conditional denomination key is invalid')
  if (keys.input_fee_ppk !== undefined)
    requireInteger(keys.input_fee_ppk, 0, 2_147_483_647, 'conditional input fee')
  if (keys.active !== undefined && typeof keys.active !== 'boolean')
    throw new Error('conditional active marker is invalid')
  const embedded =
    keys.conditional === undefined
      ? metadata
      : requireRecord(keys.conditional, 'embedded conditional metadata')
  requireFields(embedded, [
    'conditionId',
    'outcomeCollection',
    'outcomeCollectionId',
    'registeredAt',
  ])
  if (
    embedded.conditionId !== conditionId ||
    embedded.outcomeCollection !== outcomeCollection ||
    embedded.outcomeCollectionId !== outcomeCollectionId ||
    embedded.registeredAt !== registeredAt
  )
    throw new Error('embedded conditional metadata conflicts')
  const keysetApi = (
    Cashu as unknown as {
      Keyset?: { verifyConditionalKeysetId(keys: unknown, metadata: unknown): boolean }
    }
  ).Keyset
  if (
    keysetApi === undefined ||
    !keysetApi.verifyConditionalKeysetId(
      {
        id: keysetId,
        unit,
        ...(keys.active === undefined ? {} : { active: keys.active }),
        ...(keys.input_fee_ppk === undefined ? {} : { input_fee_ppk: keys.input_fee_ppk }),
        ...(finalExpiry === null ? {} : { final_expiry: finalExpiry }),
        keys: denominations,
        conditional: { conditionId, outcomeCollection, outcomeCollectionId, registeredAt },
      },
      { conditionId, outcomeCollection, outcomeCollectionId, registeredAt },
    )
  )
    throw new Error('conditional keyset cryptographic verification failed')
  void mint
  return Object.freeze({ keysetId })
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}
function requireFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key)) ||
    required.some((key) => !(key in record))
  )
    throw new Error('conditional keyset fields are invalid')
}
function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error(`${name} is invalid`)
  return value as number
}
function requireHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u').test(value))
    throw new Error(`${name} is invalid`)
  return value
}
function requireText(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error(`${name} is invalid`)
  return value
}
function requireMint(value: unknown): string {
  const mint = requireText(value, 2_048, 'normalized mint')
  const url = new URL(mint)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href.replace(/\/+$/u, '') !== mint
  )
    throw new Error('normalized mint is invalid')
  return mint
}
function requireConditionalKeysetId(value: unknown): string {
  if (typeof value !== 'string' || !/^01[0-9a-f]{64}$/u.test(value))
    throw new Error('conditional keyset id is invalid')
  return value
}
