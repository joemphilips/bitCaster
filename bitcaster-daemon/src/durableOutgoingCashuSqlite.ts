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
import { createParticipationScoreDeliveryMetadata } from '@bitcaster-market/client-sdk/participationScoreDelivery'

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
           delivery_policy AS deliveryPolicy, recipient_binding AS recipientBinding,
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
           transfer.delivery_policy AS deliveryPolicy, transfer.recipient_binding AS recipientBinding,
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
               AND (
                 delivery_state IN ('prepared', 'reclaim-prepared')
                 OR (delivery_state = 'delivery-pending' AND delivery_policy = 'durable-recipient-ack')
               )
           ) AS hasBlockingPending`,
      )
      .get(scopeId, scopeId) as { hasPending: number; hasBlockingPending: number }
    return {
      hasPending: row.hasPending === 1,
      hasBlockingPending: row.hasBlockingPending === 1,
    }
  }

  /** Reserve one Score delivery or retire an observed credited predecessor. */
  preflightParticipationScoreDelivery(input: {
    readonly scopeId: string
    readonly transferId: string
    readonly amountSats: number
    readonly purchasedTotal: number
    readonly accountSubject: string
    readonly mintUrl: string
    readonly nowMs: number
  }): {
    readonly transferId: string
    readonly amountSats: number
    readonly purchasedTotalEpoch: number
  } {
    assertPurchasedTotal(input.purchasedTotal)
    assertTransferId(input.transferId)
    assertParticipationScoreAmount(input.amountSats)
    const pointer = this.#readParticipationScorePointer(input.scopeId)
    if (pointer !== null) {
      const current = this.get(input.scopeId, pointer.transferId)
      if (current === null) {
        if (input.purchasedTotal <= pointer.purchasedTotalEpoch) return pointer
        this.#deleteParticipationScorePointer(input.scopeId, pointer)
      } else {
        this.#assertParticipationScorePointerTransfer({ pointer, current, input })
        if (current.transfer.deliveryState !== 'recipient-acknowledged') return pointer
        if (input.purchasedTotal <= pointer.purchasedTotalEpoch) return pointer
        this.#retireParticipationScorePointer(input.scopeId, pointer, current)
      }
    }
    const inserted = this.#database
      .prepare(
        `INSERT INTO daemon_participation_score_delivery_pointers (
           scope_id, transfer_id, amount_sats, purchased_total_epoch, created_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.scopeId, input.transferId, input.amountSats, input.purchasedTotal, input.nowMs)
    if (inserted.changes !== 1) throw new Error('Participation Score delivery pointer CAS lost')
    return {
      transferId: input.transferId,
      amountSats: input.amountSats,
      purchasedTotalEpoch: input.purchasedTotal,
    }
  }

  #readParticipationScorePointer(scopeId: string): {
    readonly transferId: string
    readonly amountSats: number
    readonly purchasedTotalEpoch: number
  } | null {
    const row = this.#database
      .prepare(
        `SELECT transfer_id AS transferId, amount_sats AS amountSats,
           purchased_total_epoch AS purchasedTotalEpoch
           FROM daemon_participation_score_delivery_pointers WHERE scope_id = ?`,
      )
      .get(scopeId) as
      | { transferId: string; amountSats: number; purchasedTotalEpoch: number }
      | undefined
    if (row === undefined) return null
    assertTransferId(row.transferId)
    assertParticipationScoreAmount(row.amountSats)
    assertPurchasedTotal(row.purchasedTotalEpoch)
    return row
  }

  #retireParticipationScorePointer(
    scopeId: string,
    pointer: {
      readonly transferId: string
      readonly amountSats: number
      readonly purchasedTotalEpoch: number
    },
    current: {
      readonly custodyOperationId: string
      readonly artifactId: string
      readonly transfer: DurableOutgoingCashuTransfer
    },
  ): void {
    if (current.transfer.deliveryState !== 'recipient-acknowledged') {
      throw new Error('Participation Score delivery pointer is not acknowledged')
    }
    this.#deleteParticipationScorePointer(scopeId, pointer)
    this.#retireAcknowledgedParticipationScoreTransfer(scopeId, current)
  }

  #deleteParticipationScorePointer(
    scopeId: string,
    pointer: {
      readonly transferId: string
      readonly amountSats: number
      readonly purchasedTotalEpoch: number
    },
  ): void {
    const pointerDeleted = this.#database
      .prepare(
        `DELETE FROM daemon_participation_score_delivery_pointers
         WHERE scope_id = ? AND transfer_id = ? AND amount_sats = ? AND purchased_total_epoch = ?`,
      )
      .run(scopeId, pointer.transferId, pointer.amountSats, pointer.purchasedTotalEpoch)
    if (pointerDeleted.changes !== 1)
      throw new Error('Participation Score delivery pointer CAS lost')
  }

  #retireAcknowledgedParticipationScoreTransfer(
    scopeId: string,
    current: {
      readonly custodyOperationId: string
      readonly artifactId: string
      readonly transfer: DurableOutgoingCashuTransfer
    },
  ): void {
    const deleted = this.#database
      .prepare(
        `DELETE FROM daemon_outgoing_cashu_transfers
         WHERE scope_id = ? AND transfer_id = ? AND revision = ?
           AND delivery_state = 'recipient-acknowledged'
           AND delivery_policy = 'durable-recipient-ack'`,
      )
      .run(scopeId, current.transfer.transferId, current.transfer.revision)
    if (deleted.changes !== 1) throw new Error('Participation Score delivery retirement CAS lost')
    this.#deleteUnreferencedArtifact(scopeId, current.artifactId)
  }

  #assertParticipationScorePointerTransfer(input: {
    readonly pointer: {
      readonly transferId: string
      readonly amountSats: number
      readonly purchasedTotalEpoch: number
    }
    readonly current: {
      readonly custodyOperationId: string
      readonly artifactId: string
      readonly transfer: DurableOutgoingCashuTransfer
    }
    readonly input: {
      readonly accountSubject: string
      readonly mintUrl: string
    }
  }): void {
    const expected = createParticipationScoreDeliveryMetadata({
      deliveryId: input.pointer.transferId,
      accountSubject: input.input.accountSubject,
      mintUrl: input.input.mintUrl,
      requestedAmount: String(input.pointer.amountSats),
    })
    const transfer = input.current.transfer
    if (
      transfer.transferId !== input.pointer.transferId ||
      transfer.requestedAmount !== expected.requestedAmount ||
      transfer.mintUrl !== expected.mintUrl ||
      transfer.unit !== 'sat' ||
      transfer.deliveryIntent.policy !== 'durable-recipient-ack' ||
      transfer.deliveryIntent.expectedSubject !== expected.accountSubject ||
      transfer.deliveryIntent.opaqueProductBinding !== expected.productBindingSha256
    ) {
      throw new Error('Participation Score delivery pointer authority conflicts')
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
           requested_amount, delivery_state, delivery_policy, recipient_binding, due_at_ms, attempt_count, revision,
           transfer_artifact_id, transfer_fingerprint, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scopeId,
        transfer.transferId,
        input.custodyOperationId,
        transfer.mintUrl,
        transfer.unit,
        transfer.requestedAmount,
        transfer.deliveryState,
        transfer.deliveryIntent.policy,
        recipientBinding(transfer),
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
           normalized_mint = ?, unit = ?, requested_amount = ?, delivery_state = ?, delivery_policy = ?, recipient_binding = ?,
           due_at_ms = ?, attempt_count = ?, revision = ?, transfer_artifact_id = ?,
           transfer_fingerprint = ?, updated_at_ms = MAX(created_at_ms, ?)
         WHERE scope_id = ? AND transfer_id = ? AND custody_operation_id = ? AND revision = ?`,
      )
      .run(
        transfer.mintUrl,
        transfer.unit,
        transfer.requestedAmount,
        transfer.deliveryState,
        transfer.deliveryIntent.policy,
        recipientBinding(transfer),
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
  readonly deliveryPolicy: string
  readonly recipientBinding: string | null
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
    transfer.deliveryIntent.policy !== row.deliveryPolicy ||
    recipientBinding(transfer) !== row.recipientBinding ||
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

function recipientBinding(transfer: DurableOutgoingCashuTransfer): string | null {
  return transfer.deliveryIntent.policy === 'durable-recipient-ack'
    ? transfer.deliveryIntent.opaqueProductBinding
    : null
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

function assertPurchasedTotal(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Participation Score purchased total is invalid')
  }
}

function assertParticipationScoreAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Participation Score delivery amount is invalid')
  }
}

function assertTransferId(value: string): void {
  if (value.length < 1 || value.length > 16_384) {
    throw new Error('Participation Score delivery transfer identity is invalid')
  }
}
