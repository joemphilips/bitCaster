import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  assertManagedConditionInventoryMutation,
  completeManagedConditionInventoryRetirement,
  createManagedConditionInventoryState,
  decodeManagedConditionInventoryState,
  persistVerifiedConditionResolution,
  startManagedConditionInventoryRetirement,
  type ManagedConditionInventoryBinding,
  type ManagedConditionInventoryMutation,
  type ManagedConditionInventoryState,
  type ManagedConditionRetirementIntent,
  type VerifiedConditionResolution,
} from '@bitcaster-market/client-sdk/managedConditionInventory'
import type { CustodyScopeFence } from './profileFencing.ts'
import { profileDir } from './profile.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { withDurableCustodyUnitOfWork } from './durableCustodyUnitOfWork.ts'

export interface PersistedManagedConditionInventory {
  readonly state: ManagedConditionInventoryState
  readonly oracleWitness: string
}

export async function loadManagedConditionInventory(
  binding: ManagedConditionInventoryBinding,
): Promise<PersistedManagedConditionInventory | null> {
  return createDaemonStateSqliteSession(profileDir()).read((database) =>
    loadManagedConditionInventoryFromDatabase(database, binding),
  )
}

export function assertManagedConditionMutationFromDatabase(
  database: DatabaseSync,
  binding: ManagedConditionInventoryBinding,
  mutation: ManagedConditionInventoryMutation,
): void {
  const existing = loadManagedConditionInventoryFromDatabase(database, binding)
  if (existing === null) return
  assertManagedConditionInventoryMutation(existing.state, mutation)
}

export async function listRetiringManagedConditionBindings(): Promise<
  ManagedConditionInventoryBinding[]
> {
  return createDaemonStateSqliteSession(profileDir()).read((database) =>
    (
      database
        .prepare(
          `SELECT scope_id, normalized_mint, unit, condition_id, parent_collection_id
         FROM daemon_managed_condition_inventory
         WHERE state = 'retiring'
         ORDER BY condition_id, normalized_mint, unit, parent_collection_id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      scopeId: text(row.scope_id, 'scope id'),
      normalizedMint: text(row.normalized_mint, 'mint'),
      unit: text(row.unit, 'unit'),
      conditionId: text(row.condition_id, 'condition id'),
      canonicalParentCollectionId: decodeParent(row.parent_collection_id),
    })),
  )
}

export async function startManagedConditionRetirement(input: {
  readonly fence: CustodyScopeFence
  readonly binding: ManagedConditionInventoryBinding
  readonly resolution: VerifiedConditionResolution
  readonly intent: ManagedConditionRetirementIntent
  readonly oracleWitness: string
  readonly observedAtMs: number
}): Promise<PersistedManagedConditionInventory> {
  return withDurableCustodyUnitOfWork(profileDir(), input.fence, input.observedAtMs, (database) => {
    const existing = loadManagedConditionInventoryFromDatabase(database, input.binding)
    if (existing !== null) {
      const expectedResolution = persistVerifiedConditionResolution(input.resolution)
      if (
        existing.state.state === 'active' ||
        !isDeepStrictEqual(existing.state.resolution, expectedResolution) ||
        existing.oracleWitness !== input.oracleWitness
      ) {
        throw new Error('managed condition retirement conflicts with persisted authority')
      }
      return existing
    }
    if (readConditionProofCounts(database, input.binding).reserved !== 0) {
      throw new Error('managed condition inventory has pending proof reservations')
    }
    const state = startManagedConditionInventoryRetirement({
      current: createManagedConditionInventoryState(input.binding),
      resolution: input.resolution,
      retirementIntent: input.intent,
      startedAtMs: input.observedAtMs,
    })
    if (state.state !== 'retiring') throw new Error('managed condition retirement did not start')
    insertManagedConditionInventory(database, state, input.oracleWitness)
    return { state, oracleWitness: input.oracleWitness }
  })
}

export async function completeManagedConditionRetirement(input: {
  readonly fence: CustodyScopeFence
  readonly binding: ManagedConditionInventoryBinding
  readonly observedAtMs: number
}): Promise<PersistedManagedConditionInventory> {
  return withDurableCustodyUnitOfWork(profileDir(), input.fence, input.observedAtMs, (database) => {
    const existing = loadManagedConditionInventoryFromDatabase(database, input.binding)
    if (existing === null) throw new Error('managed condition retirement is absent')
    const proofCounts = readConditionProofCounts(database, input.binding)
    const workCounts = readConditionWorkCounts(database, input.binding)
    const completedAtMs = Math.max(
      input.observedAtMs,
      existing.state.retirementStartedAtMs ?? input.observedAtMs,
    )
    const state = completeManagedConditionInventoryRetirement({
      current: existing.state,
      quiescence: {
        earlierWorkCount: proofCounts.reserved + workCounts.activeRange,
        unknownWorkCount: 0,
        corruptWorkCount: 0,
        pendingRetirementWorkCount: workCounts.operationBoundProofs,
        selectableRetirementProofCount: proofCounts.available,
        unappliedResultCount: 0,
      },
      completedAtMs,
    })
    if (state.state === 'retired' && existing.state.state !== 'retired') {
      const changed = database
        .prepare(
          `UPDATE daemon_managed_condition_inventory
             SET state = 'retired', revision = 2, retirement_completed_at_ms = ?
             WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
               AND condition_id = ? AND parent_collection_id = ?
               AND state = 'retiring' AND revision = 1`,
        )
        .run(
          state.retirementCompletedAtMs,
          state.scopeId,
          state.normalizedMint,
          state.unit,
          state.conditionId,
          encodeParent(state.canonicalParentCollectionId),
        )
      if (changed.changes !== 1) throw new Error('managed condition retirement completion CAS lost')
    }
    return { state, oracleWitness: existing.oracleWitness }
  })
}

function readConditionWorkCounts(
  database: DatabaseSync,
  binding: ManagedConditionInventoryBinding,
): { activeRange: number; operationBoundProofs: number } {
  const activeRange = database
    .prepare(
      `SELECT COUNT(*) AS item_count
       FROM daemon_ctf_range_preparations
       WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
         AND condition_id = ? AND lifecycle_state <> 'terminal'`,
    )
    .get(binding.scopeId, binding.normalizedMint, binding.unit, binding.conditionId) as {
    item_count: unknown
  }
  const operationBoundProofs = database
    .prepare(
      `SELECT COUNT(*) AS item_count
       FROM custody_proofs
       WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
         AND condition_id = ? AND selectability = 'locked'`,
    )
    .get(binding.scopeId, binding.normalizedMint, binding.unit, binding.conditionId) as {
    item_count: unknown
  }
  return {
    activeRange: safeInteger(activeRange.item_count, 'active range work count'),
    operationBoundProofs: safeInteger(
      operationBoundProofs.item_count,
      'operation-bound proof count',
    ),
  }
}

function readConditionProofCounts(
  database: DatabaseSync,
  binding: ManagedConditionInventoryBinding,
): { available: number; reserved: number } {
  const rows = database
    .prepare(
      `SELECT state, COUNT(*) AS proof_count
       FROM target_wallet_proofs
       WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
         AND asset_kind = 'outcome' AND condition_id = ?
         AND state IN ('available', 'reserved')
       GROUP BY state`,
    )
    .all(binding.scopeId, binding.normalizedMint, binding.unit, binding.conditionId) as Record<
    string,
    unknown
  >[]
  let available = 0
  let reserved = 0
  for (const row of rows) {
    const count = safeInteger(row.proof_count, 'proof count')
    if (row.state === 'available') available = count
    else if (row.state === 'reserved') reserved = count
    else throw new Error('managed condition proof state is invalid')
  }
  return { available, reserved }
}

function loadManagedConditionInventoryFromDatabase(
  database: DatabaseSync,
  binding: ManagedConditionInventoryBinding,
): PersistedManagedConditionInventory | null {
  const row = database
    .prepare(
      `SELECT * FROM daemon_managed_condition_inventory
       WHERE scope_id = ? AND normalized_mint = ? AND unit = ?
         AND condition_id = ? AND parent_collection_id = ?`,
    )
    .get(
      binding.scopeId,
      binding.normalizedMint,
      binding.unit,
      binding.conditionId,
      encodeParent(binding.canonicalParentCollectionId),
    ) as Record<string, unknown> | undefined
  return row === undefined ? null : decodeRow(row)
}

function insertManagedConditionInventory(
  database: DatabaseSync,
  state: Extract<ManagedConditionInventoryState, { state: 'retiring' }>,
  oracleWitness: string,
): void {
  const inserted = database
    .prepare(
      `INSERT INTO daemon_managed_condition_inventory (
        scope_id, normalized_mint, unit, condition_id, parent_collection_id,
        state, revision, condition_identity, announcement_identities,
        attestation_identity, resolved_outcome, authority_id, evidence_fingerprint,
        oracle_witness, retirement_intent_kind, retirement_intent_id,
        retirement_intent_created_at_ms, retirement_started_at_ms,
        retirement_completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'retiring', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      state.scopeId,
      state.normalizedMint,
      state.unit,
      state.conditionId,
      encodeParent(state.canonicalParentCollectionId),
      state.resolution.conditionIdentity,
      Buffer.from(JSON.stringify(state.resolution.announcementIdentities), 'utf8'),
      state.resolution.attestationIdentity,
      state.resolution.resolvedOutcome,
      state.resolution.authorityId,
      state.resolution.evidenceFingerprint,
      Buffer.from(oracleWitness, 'utf8'),
      state.retirementIntent.kind,
      state.retirementIntent.intentId,
      state.retirementIntent.createdAtMs,
      state.retirementStartedAtMs,
    )
  if (inserted.changes !== 1) throw new Error('managed condition retirement insert failed')
}

function decodeRow(row: Record<string, unknown>): PersistedManagedConditionInventory {
  const announcementIdentities = parseStringArray(row.announcement_identities)
  const completedAt = nullableSafeInteger(row.retirement_completed_at_ms, 'retirement completion')
  const state = decodeManagedConditionInventoryState({
    schemaVersion: 1,
    scopeId: text(row.scope_id, 'scope id'),
    normalizedMint: text(row.normalized_mint, 'mint'),
    unit: text(row.unit, 'unit'),
    conditionId: text(row.condition_id, 'condition id'),
    canonicalParentCollectionId: decodeParent(row.parent_collection_id),
    revision: safeInteger(row.revision, 'inventory revision'),
    state: text(row.state, 'inventory state'),
    resolution: {
      schemaVersion: 1,
      source: 'dlc-oracle-attestation',
      scopeId: text(row.scope_id, 'scope id'),
      normalizedMint: text(row.normalized_mint, 'mint'),
      unit: text(row.unit, 'unit'),
      conditionId: text(row.condition_id, 'condition id'),
      canonicalParentCollectionId: decodeParent(row.parent_collection_id),
      conditionIdentity: text(row.condition_identity, 'condition identity'),
      announcementIdentities,
      attestationIdentity: text(row.attestation_identity, 'attestation identity'),
      resolvedOutcome: text(row.resolved_outcome, 'resolved outcome'),
      authorityId: text(row.authority_id, 'authority id'),
      evidenceFingerprint: text(row.evidence_fingerprint, 'evidence fingerprint'),
    },
    retirementIntent: {
      schemaVersion: 1,
      scopeId: text(row.scope_id, 'scope id'),
      normalizedMint: text(row.normalized_mint, 'mint'),
      unit: text(row.unit, 'unit'),
      conditionId: text(row.condition_id, 'condition id'),
      canonicalParentCollectionId: decodeParent(row.parent_collection_id),
      kind: text(row.retirement_intent_kind, 'retirement intent kind'),
      intentId: text(row.retirement_intent_id, 'retirement intent id'),
      createdAtMs: safeInteger(row.retirement_intent_created_at_ms, 'retirement intent time'),
    },
    retirementStartedAtMs: safeInteger(row.retirement_started_at_ms, 'retirement start'),
    retirementCompletedAtMs: completedAt,
  })
  return { state, oracleWitness: decodeUtf8(row.oracle_witness, 'oracle witness') }
}

function encodeParent(value: string | null): string {
  return value ?? ''
}

function decodeParent(value: unknown): string | null {
  const result = text(value, 'parent collection')
  return result === '' ? null : result
}

function parseStringArray(value: unknown): string[] {
  const parsed = JSON.parse(decodeUtf8(value, 'announcement identities')) as unknown
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('managed condition announcement identities are invalid')
  }
  return parsed
}

function decodeUtf8(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array)) throw new Error(`managed condition ${label} is invalid`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new Error(`managed condition ${label} is invalid`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`managed condition ${label} is invalid`)
  return value
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`managed condition ${label} is invalid`)
  return Number(value)
}

function nullableSafeInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label)
}
