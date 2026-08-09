import {
  decodeAssetMonitoringAssetReference,
  decodeAssetMonitoringRecoveryHint,
  type AssetMonitoringAssetReference,
  type AssetMonitoringRecoveryHint,
} from './assetMonitoring.ts'
import { decodeDurableCustodyScopeId } from './durableCustody.ts'
import { deriveRootCtfOutcomeCollectionId } from './durableCtfRangeOperation.ts'
import { decodeEncryptedWalletBackupV2AssetIdentity } from './encryptedWalletBackupV2ProofSet.ts'
import type { EncryptedWalletBackupV2AssetIdentity } from './encryptedWalletBackupV2Bundle.ts'

export const TARGETED_ASSET_RECOVERY_KEYSETS_MAX = 16 as const
export const TARGETED_ASSET_RECOVERY_INTERVALS_MAX = 16 as const
export const TARGETED_ASSET_RECOVERY_CANDIDATES_MAX = 4096 as const
export const TARGETED_ASSET_RECOVERY_MINT_REQUESTS_MAX = 64 as const
const activeAttempts = new Map<string, Promise<TargetedAssetRecoveryOutcome>>()
export interface TargetedAssetRecoveryAttemptKey {
  readonly scopeId: string
  readonly assetLocator: string
  readonly backupHeadVersion: number
  readonly monitoringFactVersion: string
}

export type TargetedAssetRecoveryCompletedOutcome =
  | 'restored-mint'
  | 'unavailable'
  | 'persistent-error'

export interface TargetedAssetRecoveryMonitoringFact {
  readonly asset: AssetMonitoringAssetReference
  readonly factVersion: string
  readonly availableSubunits: number
  readonly recoveryHint: AssetMonitoringRecoveryHint | null
}

export interface TargetedAssetRecoveryMintRequest {
  readonly keysetId: string
  readonly counterStart: number
  readonly counterCount: number
}

export interface TargetedAssetRecoveryInput {
  readonly scopeId: string
  /** Opaque encrypted-backup V2 locator for the exact asset. */
  readonly assetLocator: string
  /** Canonical asset identity used by local custody and backup adapters. */
  readonly asset: EncryptedWalletBackupV2AssetIdentity
  /** Canonical monitoring asset used only for the exact monitoring fact. */
  readonly monitoringAsset: AssetMonitoringAssetReference
  readonly monitoringFactVersion: string
}

export type TargetedAssetRecoveryBackupInventory<TBackupEntry> =
  | {
      readonly kind: 'available'
      readonly headVersion: number
      readonly exactEntry: TBackupEntry | null
    }
  | { readonly kind: 'unavailable' }

export interface TargetedAssetRecoveryPorts<TBackupEntry> {
  hasLocalCustody(input: TargetedAssetRecoveryInput): boolean | Promise<boolean>
  readAuthenticatedCurrentBackupInventory(
    input: TargetedAssetRecoveryInput,
  ):
    | TargetedAssetRecoveryBackupInventory<TBackupEntry>
    | Promise<TargetedAssetRecoveryBackupInventory<TBackupEntry>>
  restoreAndAdmitBackup(
    input: TargetedAssetRecoveryInput,
    entry: TBackupEntry,
  ): void | Promise<void>
  readExactMonitoringFact(
    input: TargetedAssetRecoveryInput,
  ): unknown | null | Promise<unknown | null>
  readCompletedAttempt(
    key: TargetedAssetRecoveryAttemptKey,
  ):
    | TargetedAssetRecoveryCompletedOutcome
    | null
    | Promise<TargetedAssetRecoveryCompletedOutcome | null>
  recordCompletedAttempt(
    key: TargetedAssetRecoveryAttemptKey,
    outcome: TargetedAssetRecoveryCompletedOutcome,
  ): void | Promise<void>
  recoverFromMint(input: {
    readonly recovery: TargetedAssetRecoveryInput
    readonly fact: TargetedAssetRecoveryMonitoringFact
    readonly requests: readonly TargetedAssetRecoveryMintRequest[]
  }): 'restored' | 'unavailable' | Promise<'restored' | 'unavailable'>
}

export type TargetedAssetRecoveryOutcome =
  | { readonly kind: 'local' }
  | { readonly kind: 'restored-backup' }
  | { readonly kind: 'restored-mint' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'already-attempted'
      readonly completedOutcome: TargetedAssetRecoveryCompletedOutcome
    }
  | { readonly kind: 'persistent-error' }

/** Coordinates one exact recovery. It never discovers assets or broad-scans a mint. */
export async function recoverTargetedAsset<TBackupEntry>(
  input: TargetedAssetRecoveryInput,
  ports: TargetedAssetRecoveryPorts<TBackupEntry>,
): Promise<TargetedAssetRecoveryOutcome> {
  const recovery = decodeTargetedAssetRecoveryInput(input)
  let localPresent: boolean
  try {
    localPresent = requireBoolean(await ports.hasLocalCustody(recovery), 'local custody result')
  } catch {
    return persistentError()
  }
  if (localPresent) return { kind: 'local' }

  let backup: TargetedAssetRecoveryBackupInventory<TBackupEntry>
  try {
    backup = requireBackupInventory(await ports.readAuthenticatedCurrentBackupInventory(recovery))
  } catch {
    return persistentError()
  }
  if (backup.kind === 'unavailable') return persistentError()
  if (backup.exactEntry !== null) {
    try {
      await ports.restoreAndAdmitBackup(recovery, backup.exactEntry)
      return { kind: 'restored-backup' }
    } catch {
      return persistentError()
    }
  }
  return recoverFromMonitoring(recovery, backup.headVersion, ports)
}

async function recoverFromMonitoring<TBackupEntry>(
  recovery: TargetedAssetRecoveryInput,
  backupHeadVersion: number,
  ports: TargetedAssetRecoveryPorts<TBackupEntry>,
): Promise<TargetedAssetRecoveryOutcome> {
  let fact: TargetedAssetRecoveryMonitoringFact | null
  try {
    fact = decodeExactMonitoringFact(await ports.readExactMonitoringFact(recovery), recovery)
  } catch {
    return persistentError()
  }
  if (fact === null || fact.availableSubunits === 0 || fact.recoveryHint === null)
    return { kind: 'unavailable' }

  const key = createTargetedAssetRecoveryAttemptKey(recovery, backupHeadVersion)
  const recoverableFact = { ...fact, recoveryHint: fact.recoveryHint }
  return withActiveAttempt(key, () => recoverMintAttempt(recovery, recoverableFact, key, ports))
}

async function recoverMintAttempt<TBackupEntry>(
  recovery: TargetedAssetRecoveryInput,
  fact: TargetedAssetRecoveryMonitoringFact & {
    readonly recoveryHint: AssetMonitoringRecoveryHint
  },
  key: TargetedAssetRecoveryAttemptKey,
  ports: TargetedAssetRecoveryPorts<TBackupEntry>,
): Promise<TargetedAssetRecoveryOutcome> {
  let completed: TargetedAssetRecoveryCompletedOutcome | null
  try {
    completed = decodeCompletedOutcome(await ports.readCompletedAttempt(key))
  } catch {
    return persistentError()
  }
  if (completed !== null) return { kind: 'already-attempted', completedOutcome: completed }

  let requests: readonly TargetedAssetRecoveryMintRequest[]
  try {
    requests = buildTargetedAssetRecoveryMintRequests(fact.recoveryHint)
  } catch {
    return persistentError()
  }
  let completedOutcome: TargetedAssetRecoveryCompletedOutcome
  try {
    completedOutcome = mintOutcome(await ports.recoverFromMint({ recovery, fact, requests }))
  } catch {
    completedOutcome = 'persistent-error'
  }
  try {
    await ports.recordCompletedAttempt(key, completedOutcome)
  } catch {
    return persistentError()
  }
  return completedOutcome === 'restored-mint'
    ? { kind: 'restored-mint' }
    : completedOutcome === 'unavailable'
      ? { kind: 'unavailable' }
      : persistentError()
}

function withActiveAttempt(
  key: TargetedAssetRecoveryAttemptKey,
  action: () => Promise<TargetedAssetRecoveryOutcome>,
): Promise<TargetedAssetRecoveryOutcome> {
  const id = JSON.stringify([
    key.scopeId,
    key.assetLocator,
    key.backupHeadVersion,
    key.monitoringFactVersion,
  ])
  const active = activeAttempts.get(id)
  if (active !== undefined) return active
  const started = action()
  activeAttempts.set(id, started)
  const clear = () => {
    if (activeAttempts.get(id) === started) activeAttempts.delete(id)
  }
  void started.then(clear, clear)
  return started
}

export function decodeTargetedAssetRecoveryInput(value: unknown): TargetedAssetRecoveryInput {
  if (!isRecord(value) || !exactKeys(value, inputFields)) {
    throw new Error('targeted asset recovery input is invalid')
  }
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(value.asset)
  const monitoringAsset = decodeAssetMonitoringAssetReference(value.monitoringAsset)
  requireSameAsset(asset, monitoringAsset)
  return Object.freeze({
    scopeId: decodeDurableCustodyScopeId(value.scopeId),
    assetLocator: requireAssetLocator(value.assetLocator),
    asset,
    monitoringAsset,
    monitoringFactVersion: requireFactVersion(value.monitoringFactVersion),
  })
}

export function createTargetedAssetRecoveryAttemptKey(
  input: TargetedAssetRecoveryInput,
  backupHeadVersion: number,
): TargetedAssetRecoveryAttemptKey {
  const recovery = decodeTargetedAssetRecoveryInput(input)
  return Object.freeze({
    scopeId: recovery.scopeId,
    assetLocator: recovery.assetLocator,
    backupHeadVersion: requireHeadVersion(backupHeadVersion),
    monitoringFactVersion: recovery.monitoringFactVersion,
  })
}

export function decodeTargetedAssetRecoveryAttemptKey(
  value: unknown,
): TargetedAssetRecoveryAttemptKey {
  if (!isRecord(value) || !exactKeys(value, attemptKeyFields)) {
    throw new Error('targeted asset recovery attempt key is invalid')
  }
  return Object.freeze({
    scopeId: decodeDurableCustodyScopeId(value.scopeId),
    assetLocator: requireAssetLocator(value.assetLocator),
    backupHeadVersion: requireHeadVersion(value.backupHeadVersion),
    monitoringFactVersion: requireFactVersion(value.monitoringFactVersion),
  })
}

export function buildTargetedAssetRecoveryMintRequests(
  value: AssetMonitoringRecoveryHint,
): readonly TargetedAssetRecoveryMintRequest[] {
  const hint = decodeAssetMonitoringRecoveryHint(value)
  if (
    hint.keysetIds.length === 0 ||
    hint.counterIntervals.length === 0 ||
    hint.keysetIds.length > TARGETED_ASSET_RECOVERY_KEYSETS_MAX ||
    hint.counterIntervals.length > TARGETED_ASSET_RECOVERY_INTERVALS_MAX
  ) {
    throw new Error('targeted asset recovery hint exceeds the limit')
  }
  const requests: TargetedAssetRecoveryMintRequest[] = []
  let candidateCount = 0
  for (const keysetId of [...hint.keysetIds].sort(compareOrdinal)) {
    for (const interval of sortedIntervals(hint)) {
      candidateCount += interval.count
      if (candidateCount > TARGETED_ASSET_RECOVERY_CANDIDATES_MAX) {
        throw new Error('targeted asset recovery candidates exceed the limit')
      }
      requests.push(
        Object.freeze({
          keysetId,
          counterStart: interval.start,
          counterCount: interval.count,
        }),
      )
      if (requests.length > TARGETED_ASSET_RECOVERY_MINT_REQUESTS_MAX) {
        throw new Error('targeted asset recovery requests exceed the limit')
      }
    }
  }
  return Object.freeze(requests)
}

function decodeExactMonitoringFact(
  value: unknown,
  recovery: TargetedAssetRecoveryInput,
): TargetedAssetRecoveryMonitoringFact | null {
  if (value === null) return null
  if (!isRecord(value) || !exactKeys(value, monitoringFactFields)) {
    throw new Error('targeted asset recovery monitoring fact is invalid')
  }
  const asset = decodeAssetMonitoringAssetReference(value.asset)
  if (JSON.stringify(asset) !== JSON.stringify(recovery.monitoringAsset)) {
    throw new Error('targeted asset recovery monitoring fact is foreign')
  }
  const factVersion = requireFactVersion(value.factVersion)
  if (factVersion !== recovery.monitoringFactVersion) {
    throw new Error('targeted asset recovery monitoring fact version is stale')
  }
  const availableSubunits = requireNonnegativeSafeInteger(value.availableSubunits)
  const recoveryHint =
    value.recoveryHint === null ? null : decodeAssetMonitoringRecoveryHint(value.recoveryHint)
  return Object.freeze({ asset, factVersion, availableSubunits, recoveryHint })
}

function sortedIntervals(hint: AssetMonitoringRecoveryHint) {
  return [...hint.counterIntervals].sort(
    (left, right) => left.start - right.start || left.count - right.count,
  )
}

function mintOutcome(value: unknown): TargetedAssetRecoveryCompletedOutcome {
  if (value === 'restored') return 'restored-mint'
  if (value === 'unavailable') return 'unavailable'
  throw new Error('targeted asset recovery mint result is invalid')
}

function decodeCompletedOutcome(value: unknown): TargetedAssetRecoveryCompletedOutcome | null {
  if (value === null) return null
  if (value === 'restored-mint' || value === 'unavailable' || value === 'persistent-error')
    return value
  throw new Error('targeted asset recovery completed outcome is invalid')
}

function requireBackupInventory<T>(value: unknown): TargetedAssetRecoveryBackupInventory<T> {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('targeted asset recovery backup inventory is invalid')
  }
  if (value.kind === 'unavailable' && exactKeys(value, ['kind'])) return { kind: 'unavailable' }
  if (value.kind === 'available' && exactKeys(value, ['kind', 'headVersion', 'exactEntry'])) {
    if (value.exactEntry === undefined)
      throw new Error('targeted asset recovery backup inventory is invalid')
    return {
      kind: 'available',
      headVersion: requireHeadVersion(value.headVersion),
      exactEntry: value.exactEntry as T | null,
    }
  }
  throw new Error('targeted asset recovery backup inventory is invalid')
}

function requireAssetLocator(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('targeted asset recovery asset locator is invalid')
  }
  return value
}

function requireSameAsset(
  asset: EncryptedWalletBackupV2AssetIdentity,
  monitoring: AssetMonitoringAssetReference,
): void {
  if (asset.mintUrl !== monitoring.canonicalMintUrl || asset.unit !== monitoring.cashuUnit) {
    throw new Error('targeted asset recovery authorities identify different assets')
  }
  if (asset.assetIdentity === 'cashu:ordinary') {
    if (monitoring.kind !== 'collateral') {
      throw new Error('targeted asset recovery authorities identify different assets')
    }
    return
  }
  const conditionId = asset.assetIdentity.split(':')[1]
  const outcomeCollectionId = asset.assetIdentity.split(':')[2]
  if (
    monitoring.kind !== 'conditional' ||
    monitoring.conditionId !== conditionId ||
    deriveRootCtfOutcomeCollectionId({
      conditionId: monitoring.conditionId,
      outcomeCollection: monitoring.internalOutcomeSetId,
    }) !== outcomeCollectionId
  ) {
    throw new Error('targeted asset recovery authorities identify different assets')
  }
}

function requireFactVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('targeted asset recovery monitoring fact version is invalid')
  }
  return value
}

function requireHeadVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('targeted asset recovery backup head version is invalid')
  }
  return value as number
}

function requireNonnegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('targeted asset recovery monitoring amount is invalid')
  }
  return value as number
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function persistentError(): TargetedAssetRecoveryOutcome {
  return { kind: 'persistent-error' }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareOrdinal)
  const expected = [...fields].sort(compareOrdinal)
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

const inputFields = [
  'scopeId',
  'assetLocator',
  'asset',
  'monitoringAsset',
  'monitoringFactVersion',
] as const
const attemptKeyFields = [
  'scopeId',
  'assetLocator',
  'backupHeadVersion',
  'monitoringFactVersion',
] as const
const monitoringFactFields = ['asset', 'factVersion', 'availableSubunits', 'recoveryHint'] as const
