import type { SealedEncryptedWalletBackupSyncAttempt } from './encryptedWalletBackup.ts'
import { readCoordinatedEncryptedWalletBackupCasAuthority } from './encryptedWalletBackupCasAuthority.ts'

export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_ROW_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX = 1_048_576 as const

export type EncryptedWalletBackupSnapshotCleanupPhase =
  | 'prepared-sources'
  | 'snapshot-controls'
  | 'snapshot-pins'
  | 'manifest-pass-a-results'
  | 'manifest-cursors'
  | 'manifest-pages'

export type EncryptedWalletBackupSnapshotCleanupCursor =
  | Readonly<{
      readonly phase: 'snapshot-controls' | 'manifest-pass-a-results' | 'manifest-cursors'
      readonly generation: number
      readonly snapshotId: string
      readonly snapshotRevision: number
    }>
  | Readonly<{
      readonly phase: 'prepared-sources'
      readonly generation: number
      readonly snapshotId: string
      readonly snapshotRevision: number
      readonly recordId: string
      readonly revision: number
      readonly bodyReference: string
    }>
  | Readonly<{
      readonly phase: 'snapshot-pins'
      readonly generation: number
      readonly snapshotId: string
      readonly snapshotRevision: number
      readonly recordId: string
      readonly commitment: string
    }>
  | Readonly<{
      readonly phase: 'manifest-pages'
      readonly generation: number
      readonly snapshotId: string
      readonly snapshotRevision: number
      readonly pageIndex: number
    }>

/** Durable cache cleanup work. The acknowledged head is its only authority. */
export interface EncryptedWalletBackupSnapshotCleanupJob {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly acknowledgedGeneration: number
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly phase: EncryptedWalletBackupSnapshotCleanupPhase
  readonly cursor: EncryptedWalletBackupSnapshotCleanupCursor | null
}

export interface EncryptedWalletBackupSnapshotCleanupPage {
  readonly readRows: number
  readonly deletedRows: number
  readonly readBytes: number
  readonly nextCursor: EncryptedWalletBackupSnapshotCleanupCursor | null
  readonly phaseComplete: boolean
}

const PHASES: readonly EncryptedWalletBackupSnapshotCleanupPhase[] = [
  'snapshot-pins',
  'prepared-sources',
  'manifest-pass-a-results',
  'manifest-cursors',
  'manifest-pages',
  'snapshot-controls',
]

/**
 * Creates cleanup work from the SDK-sealed acknowledged CAS result.
 * Callers cannot provide a generation or local snapshot tuple.
 */
export function startEncryptedWalletBackupSnapshotCleanup(
  acknowledged: SealedEncryptedWalletBackupSyncAttempt,
): EncryptedWalletBackupSnapshotCleanupJob {
  const authority = readCoordinatedEncryptedWalletBackupCasAuthority(acknowledged)
  if (
    authority === undefined ||
    authority.record.state !== 'acknowledged' ||
    authority.record.realm !== authority.keyHandle.realm ||
    authority.record.vaultId !== authority.keyHandle.vaultId ||
    authority.record.targetHead.generation < 1
  ) {
    throw new Error('backup cleanup acknowledgement is invalid')
  }
  return freezeJob({
    schemaVersion: 1,
    realm: authority.record.realm,
    vaultId: authority.record.vaultId,
    acknowledgedGeneration: authority.record.targetHead.generation,
    localSnapshotId: authority.record.localSnapshotId,
    localSnapshotRevision: authority.record.localSnapshotRevision,
    phase: 'snapshot-pins',
    cursor: null,
  })
}

/** Decodes persisted cache work before an adapter resumes it. */
export function decodeEncryptedWalletBackupSnapshotCleanupJob(
  value: unknown,
): EncryptedWalletBackupSnapshotCleanupJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('backup cleanup job is invalid')
  const record = value as Record<string, unknown>
  requireKnownFields(record, [
    'schemaVersion',
    'realm',
    'vaultId',
    'acknowledgedGeneration',
    'localSnapshotId',
    'localSnapshotRevision',
    'phase',
    'cursor',
  ])
  if (record.schemaVersion !== 1) throw new Error('backup cleanup job version is invalid')
  const phase = requirePhase(record.phase)
  const cursor = record.cursor === null ? null : decodeCursor(record.cursor, phase)
  return freezeJob({
    schemaVersion: 1,
    realm: requireText(record.realm, 128, 'backup cleanup realm'),
    vaultId: requireLowerHex(record.vaultId, 32, 'backup cleanup vault id'),
    acknowledgedGeneration: requirePositiveInteger(
      record.acknowledgedGeneration,
      'backup cleanup generation',
    ),
    localSnapshotId: requireText(record.localSnapshotId, 128, 'backup cleanup snapshot id'),
    localSnapshotRevision: requireNonNegativeInteger(
      record.localSnapshotRevision,
      'backup cleanup snapshot revision',
    ),
    phase,
    cursor,
  })
}

/**
 * Starts an acknowledged job or monotonically replaces it with a newer head.
 * An equal acknowledgement is idempotent. A lower head fails closed.
 */
export function startOrSupersedeEncryptedWalletBackupSnapshotCleanup(
  current: EncryptedWalletBackupSnapshotCleanupJob | null,
  acknowledged: SealedEncryptedWalletBackupSyncAttempt,
): EncryptedWalletBackupSnapshotCleanupJob {
  const next = startEncryptedWalletBackupSnapshotCleanup(acknowledged)
  if (current === null) return next
  const validated = decodeEncryptedWalletBackupSnapshotCleanupJob(current)
  if (validated.realm !== next.realm || validated.vaultId !== next.vaultId)
    throw new Error('backup cleanup profile conflicts with acknowledgement')
  if (next.acknowledgedGeneration < validated.acknowledgedGeneration)
    throw new Error('backup cleanup acknowledgement generation is stale')
  if (next.acknowledgedGeneration === validated.acknowledgedGeneration) {
    if (
      next.localSnapshotId !== validated.localSnapshotId ||
      next.localSnapshotRevision !== validated.localSnapshotRevision
    ) {
      throw new Error('backup cleanup acknowledgement conflicts at this generation')
    }
    return validated
  }
  return next
}

/** Validates one bounded adapter result and advances its exact durable cursor. */
export function advanceEncryptedWalletBackupSnapshotCleanup(
  job: EncryptedWalletBackupSnapshotCleanupJob,
  page: EncryptedWalletBackupSnapshotCleanupPage,
): EncryptedWalletBackupSnapshotCleanupJob | null {
  const current = decodeEncryptedWalletBackupSnapshotCleanupJob(job)
  if (typeof page !== 'object' || page === null) throw new Error('backup cleanup page is invalid')
  requireBoundedPageInteger(page.readRows, 'backup cleanup read rows')
  requireBoundedPageInteger(page.deletedRows, 'backup cleanup deleted rows')
  if (page.deletedRows > page.readRows) throw new Error('backup cleanup deleted rows are invalid')
  if (
    !Number.isSafeInteger(page.readBytes) ||
    page.readBytes < 0 ||
    page.readBytes > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX
  ) {
    throw new Error('backup cleanup read bytes are invalid')
  }
  if (typeof page.phaseComplete !== 'boolean')
    throw new Error('backup cleanup completion is invalid')
  const cursor = page.nextCursor === null ? null : decodeCursor(page.nextCursor, current.phase)
  if (page.phaseComplete) {
    if (cursor !== null) throw new Error('completed backup cleanup phase has a cursor')
    const nextPhase = PHASES[PHASES.indexOf(current.phase) + 1]
    if (nextPhase === undefined) return null
    return freezeJob({ ...current, phase: nextPhase, cursor: null })
  }
  if (cursor === null || page.readRows < 1)
    throw new Error('incomplete backup cleanup page has no cursor')
  if (current.cursor !== null && compareCursor(cursor, current.cursor) <= 0)
    throw new Error('backup cleanup cursor did not advance')
  return freezeJob({ ...current, cursor })
}

function freezeJob(
  job: EncryptedWalletBackupSnapshotCleanupJob,
): EncryptedWalletBackupSnapshotCleanupJob {
  return Object.freeze({
    ...job,
    cursor: job.cursor === null ? null : Object.freeze({ ...job.cursor }),
  })
}

function decodeCursor(
  value: unknown,
  phase: EncryptedWalletBackupSnapshotCleanupPhase,
): EncryptedWalletBackupSnapshotCleanupCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('backup cleanup cursor is invalid')
  const cursor = value as Record<string, unknown>
  if (cursor.phase !== phase) throw new Error('backup cleanup cursor phase is invalid')
  const base = {
    generation: requirePositiveInteger(cursor.generation, 'backup cleanup cursor generation'),
    snapshotId: requireText(cursor.snapshotId, 128, 'backup cleanup cursor snapshot id'),
    snapshotRevision: requireNonNegativeInteger(
      cursor.snapshotRevision,
      'backup cleanup cursor snapshot revision',
    ),
  }
  switch (phase) {
    case 'snapshot-controls':
    case 'manifest-pass-a-results':
    case 'manifest-cursors':
      requireKnownFields(cursor, ['phase', 'generation', 'snapshotId', 'snapshotRevision'])
      break
    case 'snapshot-pins':
      requireKnownFields(cursor, [
        'phase',
        'generation',
        'snapshotId',
        'snapshotRevision',
        'recordId',
        'commitment',
      ])
      return Object.freeze({
        phase,
        ...base,
        recordId: requireLowerHex(cursor.recordId, 32, 'backup cleanup cursor record id'),
        commitment: requireLowerHex(cursor.commitment, 32, 'backup cleanup cursor commitment'),
      })
    case 'prepared-sources':
      requireKnownFields(cursor, [
        'phase',
        'generation',
        'snapshotId',
        'snapshotRevision',
        'recordId',
        'revision',
        'bodyReference',
      ])
      return Object.freeze({
        phase,
        ...base,
        recordId: requireLowerHex(cursor.recordId, 32, 'backup cleanup cursor record id'),
        revision: requireNonNegativeInteger(
          cursor.revision,
          'backup cleanup cursor source revision',
        ),
        bodyReference: requireLowerHex(
          cursor.bodyReference,
          32,
          'backup cleanup cursor body reference',
        ),
      })
    case 'manifest-pages':
      requireKnownFields(cursor, [
        'phase',
        'generation',
        'snapshotId',
        'snapshotRevision',
        'pageIndex',
      ])
      return Object.freeze({
        phase,
        ...base,
        pageIndex: requireNonNegativeInteger(cursor.pageIndex, 'backup cleanup cursor page index'),
      })
    default:
      return assertNever(phase)
  }
  return Object.freeze({ phase, ...base })
}

function compareCursor(
  left: EncryptedWalletBackupSnapshotCleanupCursor,
  right: EncryptedWalletBackupSnapshotCleanupCursor,
): number {
  if (left.phase !== right.phase) throw new Error('backup cleanup cursor phase conflicts')
  const prefix =
    left.generation - right.generation ||
    compareText(left.snapshotId, right.snapshotId) ||
    left.snapshotRevision - right.snapshotRevision
  if (prefix !== 0) return prefix
  if (left.phase === 'snapshot-pins' && right.phase === 'snapshot-pins')
    return (
      compareText(left.recordId, right.recordId) || compareText(left.commitment, right.commitment)
    )
  if (left.phase === 'manifest-pages' && right.phase === 'manifest-pages')
    return left.pageIndex - right.pageIndex
  if (left.phase === 'prepared-sources' && right.phase === 'prepared-sources')
    return (
      compareText(left.recordId, right.recordId) ||
      left.revision - right.revision ||
      compareText(left.bodyReference, right.bodyReference)
    )
  return 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function requirePhase(value: unknown): EncryptedWalletBackupSnapshotCleanupPhase {
  if (!PHASES.includes(value as EncryptedWalletBackupSnapshotCleanupPhase))
    throw new Error('backup cleanup phase is invalid')
  return value as EncryptedWalletBackupSnapshotCleanupPhase
}

function requireBoundedPageInteger(value: unknown, label: string): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_ROW_MAX
  )
    throw new Error(`${label} is invalid`)
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid`)
  return value as number
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function requireText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
    throw new Error(`${label} is invalid`)
  return value
}

function requireLowerHex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value))
    throw new Error(`${label} is invalid`)
  return value
}

function requireKnownFields(record: Record<string, unknown>, names: readonly string[]): void {
  if (
    Object.keys(record).length !== names.length ||
    Object.keys(record).some((key) => !names.includes(key))
  )
    throw new Error('backup cleanup record has unknown fields')
}

function assertNever(value: never): never {
  throw new Error(`unsupported backup cleanup phase: ${String(value)}`)
}
