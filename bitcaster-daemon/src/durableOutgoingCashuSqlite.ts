import type { DatabaseSync } from 'node:sqlite'
import {
  decodeDurableOutgoingCashuTransfer,
  DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX,
  DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX,
  type DurableOutgoingCashuDuePage,
  type DurableOutgoingCashuRecoveryCursor,
  type DurableOutgoingCashuTransfer,
} from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import {
  deriveDurableCustodyArtifactFingerprint,
  encodeBoundedDurableArtifact,
} from '@bitcaster-market/client-sdk/durableCustody'

const TRANSFER_BYTES_MAX = DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX

/** SQLite authority for one exact ordinary outgoing Cashu transfer. */
export class DurableOutgoingCashuSqliteStore {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  put(input: {
    readonly scopeId: string
    readonly custodyOperationId: string
    readonly transfer: DurableOutgoingCashuTransfer
    readonly nowMs: number
  }): void {
    const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
    if (transfer.walletScopeId !== input.scopeId)
      throw new Error('outgoing transfer scope is foreign')
    if (!this.#hasWalletSendCustodyOperation(input))
      throw new Error('outgoing transfer custody operation is foreign')
    const body = encodeBoundedDurableArtifact(transfer, TRANSFER_BYTES_MAX)
    const fingerprint = deriveDurableCustodyArtifactFingerprint(transfer)
    const existing = this.get(input.scopeId, transfer.transferId)
    if (existing === null) {
      this.#putArtifact(input.scopeId, fingerprint, body, input.nowMs)
      this.#insert(input, transfer, fingerprint)
      return
    }
    if (existing.transfer.revision >= transfer.revision) {
      if (
        existing.custodyOperationId !== input.custodyOperationId ||
        existing.transfer.revision !== transfer.revision ||
        deriveDurableCustodyArtifactFingerprint(existing.transfer) !== fingerprint
      ) {
        throw new Error('outgoing transfer revision conflicts')
      }
      return
    }
    if (existing.transfer.revision + 1 !== transfer.revision) {
      throw new Error('outgoing transfer revision does not advance exactly')
    }
    this.#putArtifact(input.scopeId, fingerprint, body, input.nowMs)
    this.#update(input, transfer, fingerprint, existing.transfer.revision)
    this.#deleteUnreferencedArtifact(input.scopeId, existing.artifactId)
  }

  get(
    scopeId: string,
    transferId: string,
  ): {
    custodyOperationId: string
    artifactId: string
    transfer: DurableOutgoingCashuTransfer
  } | null {
    const row = this.#database
      .prepare(
        `SELECT transfer.custody_operation_id AS custodyOperationId,
           transfer.transfer_artifact_id AS artifactId,
           artifact.body AS transferBody, artifact.artifact_kind AS artifactKind,
           artifact.fingerprint AS artifactFingerprint, transfer.transfer_fingerprint AS transferFingerprint,
           transfer.normalized_mint AS normalizedMint,
           unit, requested_amount AS requestedAmount, delivery_state AS deliveryState,
           due_at_ms AS dueAtMs, attempt_count AS attemptCount, transfer.revision AS revision
         FROM daemon_outgoing_cashu_transfers AS transfer
         JOIN custody_artifacts AS artifact
           ON artifact.scope_id = transfer.scope_id
          AND artifact.artifact_id = transfer.transfer_artifact_id
         WHERE transfer.scope_id = ? AND transfer.transfer_id = ?`,
      )
      .get(scopeId, transferId) as TransferRow | undefined
    return row === undefined ? null : decodeRow(scopeId, transferId, row)
  }

  listDue(input: {
    readonly scopeId: string
    readonly mintUrl: string | null
    readonly dueBeforeMs: number
    readonly cursor: DurableOutgoingCashuRecoveryCursor | null
    readonly limit: number
    readonly maximumBytes: number
  }): DurableOutgoingCashuDuePage {
    validatePage(input.limit, input.maximumBytes)
    const rows = this.#database
      .prepare(
        `SELECT transfer.transfer_id AS transferId,
           transfer.custody_operation_id AS custodyOperationId,
           transfer.transfer_artifact_id AS artifactId, artifact.body AS transferBody,
           artifact.artifact_kind AS artifactKind, artifact.fingerprint AS artifactFingerprint,
           transfer.transfer_fingerprint AS transferFingerprint,
           transfer.normalized_mint AS normalizedMint, transfer.unit,
           transfer.requested_amount AS requestedAmount, transfer.delivery_state AS deliveryState,
           transfer.due_at_ms AS dueAtMs, transfer.attempt_count AS attemptCount,
           transfer.revision AS revision
         FROM daemon_outgoing_cashu_transfers AS transfer
         JOIN custody_artifacts AS artifact
           ON artifact.scope_id = transfer.scope_id
          AND artifact.artifact_id = transfer.transfer_artifact_id
         WHERE transfer.scope_id = ? AND (? IS NULL OR transfer.normalized_mint = ?) AND transfer.due_at_ms <= ?
           AND transfer.delivery_state IN ('prepared', 'delivery-pending', 'bearer-partial', 'reclaim-prepared')
           AND (? IS NULL OR transfer.due_at_ms > ? OR (transfer.due_at_ms = ? AND transfer.transfer_id > ?))
         ORDER BY transfer.due_at_ms, transfer.transfer_id LIMIT ?`,
      )
      .all(
        input.scopeId,
        input.mintUrl,
        input.mintUrl,
        input.dueBeforeMs,
        input.cursor?.dueAtMs ?? null,
        input.cursor?.dueAtMs ?? 0,
        input.cursor?.dueAtMs ?? 0,
        input.cursor?.transferId ?? '',
        input.limit + 1,
      ) as unknown as TransferPageRow[]
    let storedBytes = 0
    const transfers: DurableOutgoingCashuTransfer[] = []
    let hasMore = rows.length > input.limit
    for (const row of rows.slice(0, input.limit)) {
      if (row.transferBody.byteLength > input.maximumBytes && transfers.length === 0) {
        throw new Error('outgoing transfer exceeds its recovery byte budget')
      }
      if (storedBytes + row.transferBody.byteLength > input.maximumBytes) {
        hasMore = true
        break
      }
      transfers.push(decodeRow(input.scopeId, row.transferId, row).transfer)
      storedBytes += row.transferBody.byteLength
    }
    const last = transfers.at(-1)
    return {
      storedBytes,
      transfers,
      nextCursor:
        hasMore && last ? { dueAtMs: last.recovery.dueAtMs, transferId: last.transferId } : null,
    }
  }

  activeSummary(scopeId: string): { hasPending: boolean; hasBlockingPending: boolean } {
    const row = this.#database
      .prepare(
        `SELECT
           EXISTS (
             SELECT 1
             FROM daemon_outgoing_cashu_transfers
             WHERE scope_id = ?
               AND delivery_state IN ('prepared', 'delivery-pending', 'bearer-partial', 'reclaim-prepared')
           ) AS hasPending,
           EXISTS (
             SELECT 1
             FROM daemon_outgoing_cashu_transfers
             WHERE scope_id = ?
               AND delivery_state IN ('prepared', 'reclaim-prepared')
           ) AS hasBlockingPending`,
      )
      .get(scopeId, scopeId) as { hasPending: number; hasBlockingPending: number }
    return {
      hasPending: row.hasPending === 1,
      hasBlockingPending: row.hasBlockingPending === 1,
    }
  }

  #hasWalletSendCustodyOperation(input: {
    readonly scopeId: string
    readonly custodyOperationId: string
    readonly transfer: DurableOutgoingCashuTransfer
  }): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1 AS found
         FROM custody_operations
         WHERE scope_id = ?
           AND operation_id = ?
           AND retained_operation_key = ?
           AND semantic_kind = 'wallet-send'
           AND wallet_stage = 'send'`,
      )
      .get(
        input.scopeId,
        input.custodyOperationId,
        input.transfer.walletSendOperation.operationId,
      ) as { found: number } | undefined
    return row?.found === 1
  }

  #insert(
    input: { scopeId: string; custodyOperationId: string; nowMs: number },
    transfer: DurableOutgoingCashuTransfer,
    fingerprint: string,
  ): void {
    const result = this.#database
      .prepare(
        `INSERT INTO daemon_outgoing_cashu_transfers (
           scope_id, transfer_id, custody_operation_id, normalized_mint, unit,
           requested_amount, delivery_state, due_at_ms, attempt_count, revision,
           transfer_artifact_id, transfer_fingerprint, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scopeId,
        transfer.transferId,
        input.custodyOperationId,
        transfer.mintUrl,
        transfer.unit,
        transfer.requestedAmount,
        transfer.deliveryState,
        transfer.recovery.dueAtMs,
        transfer.recovery.attemptCount,
        transfer.revision,
        fingerprint,
        fingerprint,
        input.nowMs,
        input.nowMs,
      )
    if (result.changes !== 1) throw new Error('outgoing transfer insertion CAS lost')
  }

  #update(
    input: { scopeId: string; custodyOperationId: string; nowMs: number },
    transfer: DurableOutgoingCashuTransfer,
    fingerprint: string,
    expectedRevision: number,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE daemon_outgoing_cashu_transfers SET
           normalized_mint = ?, unit = ?, requested_amount = ?, delivery_state = ?,
           due_at_ms = ?, attempt_count = ?, revision = ?, transfer_artifact_id = ?,
           transfer_fingerprint = ?, updated_at_ms = MAX(created_at_ms, ?)
         WHERE scope_id = ? AND transfer_id = ? AND custody_operation_id = ? AND revision = ?`,
      )
      .run(
        transfer.mintUrl,
        transfer.unit,
        transfer.requestedAmount,
        transfer.deliveryState,
        transfer.recovery.dueAtMs,
        transfer.recovery.attemptCount,
        transfer.revision,
        fingerprint,
        fingerprint,
        input.nowMs,
        input.scopeId,
        transfer.transferId,
        input.custodyOperationId,
        expectedRevision,
      )
    if (result.changes !== 1) throw new Error('outgoing transfer update CAS lost')
  }

  #deleteUnreferencedArtifact(scopeId: string, artifactId: string): void {
    this.#database
      .prepare(
        `DELETE FROM custody_artifacts
         WHERE scope_id = ? AND artifact_id = ? AND artifact_kind = 'outgoing-transfer'
           AND NOT EXISTS (
             SELECT 1 FROM daemon_outgoing_cashu_transfers
             WHERE scope_id = ? AND transfer_artifact_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM custody_operation_artifact_links
             WHERE scope_id = ? AND artifact_id = ?
           )`,
      )
      .run(scopeId, artifactId, scopeId, artifactId, scopeId, artifactId)
  }

  #putArtifact(scopeId: string, artifactId: string, body: Uint8Array, nowMs: number): void {
    const result = this.#database
      .prepare(
        `INSERT INTO custody_artifacts (
           artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
           revision, private_material, created_at_ms
         ) VALUES (?, ?, 'outgoing-transfer', 'canonical-json', ?, ?, 0, 1, ?)
         ON CONFLICT(scope_id, artifact_id) DO NOTHING`,
      )
      .run(artifactId, scopeId, body, artifactId, nowMs)
    if (result.changes !== 0 && result.changes !== 1)
      throw new Error('outgoing transfer artifact CAS lost')
  }
}

interface TransferRow {
  readonly custodyOperationId: string
  readonly artifactId: string
  readonly transferBody: Uint8Array
  readonly artifactKind: string
  readonly artifactFingerprint: string
  readonly transferFingerprint: string
  readonly normalizedMint: string
  readonly unit: string
  readonly requestedAmount: string
  readonly deliveryState: string
  readonly dueAtMs: number
  readonly attemptCount: number
  readonly revision: number
}

interface TransferPageRow extends TransferRow {
  readonly transferId: string
}

function decodeRow(
  scopeId: string,
  transferId: string,
  row: TransferRow,
): { custodyOperationId: string; artifactId: string; transfer: DurableOutgoingCashuTransfer } {
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(row.transferBody))
  } catch {
    throw new Error('outgoing transfer artifact is invalid')
  }
  const transfer = decodeDurableOutgoingCashuTransfer(decoded)
  if (
    transfer.walletScopeId !== scopeId ||
    transfer.transferId !== transferId ||
    transfer.mintUrl !== row.normalizedMint ||
    transfer.unit !== row.unit ||
    transfer.requestedAmount !== row.requestedAmount ||
    transfer.deliveryState !== row.deliveryState ||
    transfer.recovery.dueAtMs !== row.dueAtMs ||
    transfer.recovery.attemptCount !== row.attemptCount ||
    transfer.revision !== row.revision ||
    row.artifactKind !== 'outgoing-transfer' ||
    row.artifactFingerprint !== row.transferFingerprint ||
    deriveDurableCustodyArtifactFingerprint(transfer) !== row.transferFingerprint
  ) {
    throw new Error('outgoing transfer row is foreign')
  }
  return { custodyOperationId: row.custodyOperationId, artifactId: row.artifactId, transfer }
}

function validatePage(limit: number, maximumBytes: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX
  ) {
    throw new Error('outgoing transfer recovery limit is invalid')
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX
  ) {
    throw new Error('outgoing transfer recovery byte limit is invalid')
  }
}
