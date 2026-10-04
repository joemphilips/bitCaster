import type { DatabaseSync } from 'node:sqlite'
import type { Proof } from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  hydrateDurableWalletProof,
  serializeDurableWalletProof,
  type DurableWalletReceiveOperation,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { WalletProofImportSource } from './walletProofImportSqlite.ts'

export const NATIVE_PAYMENT_REQUEST_RECEIPT_SCHEMA_SQL = [
  `CREATE TABLE native_payment_requests (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id),
    request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    receive_public_key TEXT NOT NULL CHECK (length(receive_public_key) = 64 AND receive_public_key NOT GLOB '*[^0-9a-f]*'),
    nprofile TEXT NOT NULL CHECK (length(nprofile) BETWEEN 10 AND 65536 AND substr(nprofile, 1, 9) = 'nprofile1'),
    encoded_request TEXT NOT NULL CHECK (length(encoded_request) BETWEEN 1 AND 65536),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (scope_id, request_id),
    CHECK (length(CAST(scope_id AS BLOB)) + length(CAST(request_id AS BLOB))
      + length(CAST(normalized_mint AS BLOB)) + length(CAST(receive_public_key AS BLOB))
      + length(CAST(nprofile AS BLOB)) + length(CAST(encoded_request AS BLOB)) <= 64512)
  ) STRICT`,
  `CREATE TABLE native_payment_request_receipts (
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
    receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('regular', 'conditional')),
    proof_count INTEGER NOT NULL CHECK (proof_count BETWEEN 1 AND 10000),
    input_amount_msat INTEGER NOT NULL CHECK (input_amount_msat BETWEEN 1 AND 9007199254740991),
    group_count INTEGER NOT NULL CHECK (group_count BETWEEN 0 AND 16),
    regular_operation_id TEXT,
    PRIMARY KEY (scope_id, request_id),
    FOREIGN KEY (scope_id, request_id) REFERENCES native_payment_requests(scope_id, request_id),
    FOREIGN KEY (scope_id, regular_operation_id) REFERENCES custody_operations(scope_id, operation_id),
    CHECK ((receipt_kind = 'regular' AND regular_operation_id IS NOT NULL AND group_count = 0)
      OR (receipt_kind = 'conditional' AND regular_operation_id IS NULL AND group_count BETWEEN 1 AND 16))
  ) STRICT`,
  `CREATE TABLE native_payment_request_receipt_groups (
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    group_index INTEGER NOT NULL CHECK (group_index BETWEEN 0 AND 15),
    root_id TEXT NOT NULL,
    proof_count INTEGER NOT NULL CHECK (proof_count BETWEEN 1 AND 10000),
    page_count INTEGER NOT NULL CHECK (page_count = (proof_count + 31) / 32),
    PRIMARY KEY (scope_id, request_id, group_index),
    UNIQUE (scope_id, request_id, root_id),
    FOREIGN KEY (scope_id, request_id) REFERENCES native_payment_request_receipts(scope_id, request_id),
    FOREIGN KEY (scope_id, root_id) REFERENCES wallet_proof_import_roots(scope_id, root_id)
  ) STRICT`,
  `CREATE TRIGGER native_payment_request_receipt_mint BEFORE INSERT ON native_payment_request_receipts WHEN NEW.receipt_kind = 'regular' AND NOT EXISTS (
    SELECT 1 FROM native_payment_requests r JOIN custody_operations o ON o.scope_id = r.scope_id
      WHERE r.scope_id = NEW.scope_id AND r.request_id = NEW.request_id AND o.operation_id = NEW.regular_operation_id
        AND o.normalized_mint = r.normalized_mint AND o.unit = r.unit AND o.semantic_kind = 'generic-receive' AND o.wallet_stage = 'receive'
  ) BEGIN SELECT RAISE(ABORT, 'payment request receipt operation is foreign'); END`,
  `CREATE TRIGGER native_payment_request_receipt_group_insert BEFORE INSERT ON native_payment_request_receipt_groups WHEN NOT EXISTS (
    SELECT 1 FROM native_payment_request_receipts receipt JOIN native_payment_requests request ON request.scope_id = receipt.scope_id AND request.request_id = receipt.request_id
      JOIN wallet_proof_import_roots root ON root.scope_id = request.scope_id
      WHERE receipt.scope_id = NEW.scope_id AND receipt.request_id = NEW.request_id AND receipt.receipt_kind = 'conditional'
        AND NEW.group_index < receipt.group_count AND root.root_id = NEW.root_id AND root.normalized_mint = request.normalized_mint
        AND root.unit = request.unit AND root.proof_count = NEW.proof_count AND root.page_count = NEW.page_count
  ) BEGIN SELECT RAISE(ABORT, 'payment request receipt group is foreign'); END`,
  ...[
    'native_payment_requests',
    'native_payment_request_receipts',
    'native_payment_request_receipt_groups',
  ].flatMap((table) => [
    `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'payment request authority is immutable'); END`,
    `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'payment request history is retained'); END`,
  ]),
] as const

export interface NativePaymentRequest {
  readonly scopeId: string
  readonly requestId: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly receivePublicKey: string
  readonly nprofile: string
  readonly encoded: string
  readonly createdAtMs: number
}

export interface NativePaymentRequestReceiptBinding {
  readonly scopeId: string
  readonly requestId: string
  readonly fingerprint: string
  readonly proofCount: number
  readonly inputAmountMsat: number
}

export interface NativePaymentRequestIndexItem {
  readonly requestId: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly createdAtMs: number
  readonly receiptAccepted: boolean
}

export interface NativePaymentRequestIndexPage {
  readonly rows: readonly NativePaymentRequestIndexItem[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export type NativePaymentRequestReceipt = NativePaymentRequestReceiptBinding &
  (
    | { readonly kind: 'regular'; readonly operationId: string; readonly groupCount: 0 }
    | { readonly kind: 'conditional'; readonly operationId: null; readonly groupCount: number }
  )

export function paymentRequestReceiptBinding(input: {
  readonly scopeId: string
  readonly requestId: string
  readonly mintUrl: string
  readonly proofs: readonly Proof[]
}): NativePaymentRequestReceiptBinding {
  if (input.proofs.length < 1 || input.proofs.length > 10000)
    throw new Error('payment request proof count is invalid')
  const ordered = input.proofs
    .map((proof) => ({
      proofId: deriveDurableCustodyProofId({
        scopeId: input.scopeId,
        normalizedMint: input.mintUrl,
        unit: 'msat',
        keysetId: proof.id,
        secret: proof.secret,
      }),
      proof: serializeDurableWalletProof(proof),
    }))
    .sort((left, right) => left.proofId.localeCompare(right.proofId))
  if (new Set(ordered.map((item) => item.proofId)).size !== ordered.length)
    throw new Error('payment request contains duplicate proofs')
  const inputAmountMsat = ordered.reduce(
    (total, item) => total + amountToNumber(item.proof.amount),
    0,
  )
  if (!Number.isSafeInteger(inputAmountMsat)) throw new Error('payment request amount is invalid')
  return {
    scopeId: input.scopeId,
    requestId: input.requestId,
    proofCount: ordered.length,
    inputAmountMsat,
    fingerprint: deriveDurableCustodyArtifactFingerprint({
      kind: 'native-payment-request-receipt-v1',
      scopeId: input.scopeId,
      normalizedMint: input.mintUrl,
      unit: 'msat',
      proofs: ordered.map((item) => item.proof),
    }),
  }
}

export class NativePaymentRequestReceiptSqlite {
  readonly database: DatabaseSync
  constructor(database: DatabaseSync) {
    this.database = database
  }

  /** Do not page retained history or treat a partial receipt as completed. */
  hasUncreditedRequests(scopeId: string, mintUrl: string): boolean {
    const row = this.database
      .prepare(
        `SELECT EXISTS (
      SELECT 1 FROM native_payment_requests request
      WHERE request.scope_id = ? AND request.normalized_mint = ? AND NOT EXISTS (
        SELECT 1 FROM native_payment_request_receipts receipt
        WHERE receipt.scope_id = request.scope_id AND receipt.request_id = request.request_id AND (
          (receipt.receipt_kind = 'regular' AND EXISTS (
            SELECT 1 FROM custody_operations operation
            WHERE operation.scope_id = receipt.scope_id AND operation.operation_id = receipt.regular_operation_id
              AND operation.result_state = 'applied'
          )) OR (receipt.receipt_kind = 'conditional' AND receipt.group_count = (
            SELECT count(*) FROM native_payment_request_receipt_groups receipt_group
            JOIN wallet_proof_import_roots root ON root.scope_id = receipt_group.scope_id AND root.root_id = receipt_group.root_id
            WHERE receipt_group.scope_id = receipt.scope_id AND receipt_group.request_id = receipt.request_id
              AND root.normalized_mint = request.normalized_mint AND root.unit = request.unit
              AND root.proof_count = receipt_group.proof_count AND root.page_count = receipt_group.page_count
              AND root.page_count = (
                SELECT count(*) FROM wallet_proof_import_pages page
                JOIN custody_operations operation ON operation.scope_id = page.scope_id AND operation.operation_id = page.bound_operation_id
                WHERE page.scope_id = root.scope_id AND page.root_id = root.root_id
                  AND page.bound_operation_id = page.expected_operation_id AND operation.result_state = 'applied'
              )
          ))
        )
      ) LIMIT 1
    ) AS pending`,
      )
      .get(scopeId, mintUrl)
    return row?.pending === 1
  }

  /** Enumerate request metadata only. Funds recovery uses the custody active-work index. */
  listRequests(input: {
    readonly scopeId: string
    readonly mintUrl: string
    readonly cursor: string | null
    readonly limit?: number
  }): NativePaymentRequestIndexPage {
    const limit = input.limit ?? 32
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error('payment request page limit is invalid')
    const after = decodeIndexCursor(input)
    const rows = this.database
      .prepare(
        `SELECT r.request_id, r.normalized_mint, r.created_at_ms,
      EXISTS (SELECT 1 FROM native_payment_request_receipts receipt WHERE receipt.scope_id = r.scope_id AND receipt.request_id = r.request_id) AS receipt_accepted
      FROM native_payment_requests r WHERE r.scope_id = ? AND r.normalized_mint = ? AND (? IS NULL OR r.request_id > ?)
      ORDER BY r.request_id LIMIT ?`,
      )
      .all(input.scopeId, input.mintUrl, after, after, limit + 1)
    const selected = rows.slice(0, limit)
    const nextCursor =
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({
              scopeId: input.scopeId,
              mintUrl: input.mintUrl,
              requestId: text(selected.at(-1)!.request_id),
            }),
          ).toString('base64url')
        : null
    return {
      rows: selected.map((row) => ({
        requestId: text(row.request_id),
        mintUrl: text(row.normalized_mint),
        unit: 'msat',
        createdAtMs: integer(row.created_at_ms),
        receiptAccepted: row.receipt_accepted === 1,
      })),
      nextCursor,
      hasMore: nextCursor !== null,
    }
  }

  createRequest(request: NativePaymentRequest): void {
    this.database
      .prepare(`INSERT INTO native_payment_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        request.scopeId,
        request.requestId,
        request.mintUrl,
        request.unit,
        request.receivePublicKey,
        request.nprofile,
        request.encoded,
        request.createdAtMs,
      )
  }

  getRequest(scopeId: string, requestId: string): NativePaymentRequest | null {
    const row = this.database
      .prepare(`SELECT * FROM native_payment_requests WHERE scope_id = ? AND request_id = ?`)
      .get(scopeId, requestId)
    if (row === undefined) return null
    return {
      scopeId,
      requestId,
      mintUrl: text(row.normalized_mint),
      unit: 'msat',
      receivePublicKey: text(row.receive_public_key),
      nprofile: text(row.nprofile),
      encoded: text(row.encoded_request),
      createdAtMs: integer(row.created_at_ms),
    }
  }

  getReceipt(scopeId: string, requestId: string): NativePaymentRequestReceipt | null {
    const row = this.database
      .prepare(
        `SELECT * FROM native_payment_request_receipts WHERE scope_id = ? AND request_id = ?`,
      )
      .get(scopeId, requestId)
    if (row === undefined) return null
    const binding = {
      scopeId,
      requestId,
      fingerprint: text(row.source_fingerprint),
      proofCount: integer(row.proof_count),
      inputAmountMsat: integer(row.input_amount_msat),
    }
    switch (row.receipt_kind) {
      case 'regular':
        return {
          ...binding,
          kind: 'regular',
          operationId: text(row.regular_operation_id),
          groupCount: 0,
        }
      case 'conditional':
        return {
          ...binding,
          kind: 'conditional',
          operationId: null,
          groupCount: integer(row.group_count),
        }
      default:
        throw new Error('payment request receipt kind is invalid')
    }
  }

  assertCandidate(
    candidate: NativePaymentRequestReceiptBinding,
  ): NativePaymentRequestReceipt | null {
    const existing = this.getReceipt(candidate.scopeId, candidate.requestId)
    if (
      existing !== null &&
      (existing.fingerprint !== candidate.fingerprint ||
        existing.proofCount !== candidate.proofCount ||
        existing.inputAmountMsat !== candidate.inputAmountMsat)
    )
      throw new Error('payment request already has a different receipt')
    return existing
  }

  bindRegular(
    candidate: NativePaymentRequestReceiptBinding,
    operationId: string,
    operation: DurableWalletReceiveOperation,
  ): void {
    const request = this.requiredRequest(candidate)
    if (
      operation.mintUrl !== request.mintUrl ||
      operation.unit !== request.unit ||
      operation.asset !== 'regular'
    )
      throw new Error('payment request receive operation is foreign')
    const exact = paymentRequestReceiptBinding({
      ...candidate,
      mintUrl: request.mintUrl,
      proofs: operation.preview.inputs.map(hydrateDurableWalletProof),
    })
    if (
      exact.fingerprint !== candidate.fingerprint ||
      exact.proofCount !== candidate.proofCount ||
      exact.inputAmountMsat !== candidate.inputAmountMsat
    )
      throw new Error('payment request receive input is foreign')
    const existing = this.assertCandidate(candidate)
    if (existing !== null) {
      if (existing.kind !== 'regular' || existing.operationId !== operationId)
        throw new Error('payment request receipt operation is already bound')
      return
    }
    this.insertReceipt(candidate, 'regular', 0, operationId)
  }

  bindConditional(
    candidate: NativePaymentRequestReceiptBinding,
    sources: readonly WalletProofImportSource[],
  ): void {
    const request = this.requiredRequest(candidate)
    const exact = paymentRequestReceiptBinding({
      ...candidate,
      mintUrl: request.mintUrl,
      proofs: sources.flatMap((source) => [...source.proofs]),
    })
    if (
      exact.fingerprint !== candidate.fingerprint ||
      exact.proofCount !== candidate.proofCount ||
      exact.inputAmountMsat !== candidate.inputAmountMsat ||
      sources.length < 1 ||
      sources.length > 16 ||
      sources.some(
        (source) => source.scopeId !== candidate.scopeId || source.mintUrl !== request.mintUrl,
      )
    )
      throw new Error('payment request conditional source is foreign')
    if (this.assertCandidate(candidate) !== null)
      throw new Error('payment request conditional receipt is already bound')
    this.insertReceipt(candidate, 'conditional', sources.length, null)
    sources.forEach((source, index) =>
      this.database
        .prepare(`INSERT INTO native_payment_request_receipt_groups VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          candidate.scopeId,
          candidate.requestId,
          index,
          source.rootId,
          source.proofs.length,
          Math.ceil(source.proofs.length / 32),
        ),
    )
    this.assertGroups(candidate.scopeId, candidate.requestId)
  }

  assertGroups(scopeId: string, requestId: string): readonly string[] {
    const receipt = this.getReceipt(scopeId, requestId)
    if (receipt === null || receipt.kind !== 'conditional')
      throw new Error('payment request conditional receipt is missing')
    const groups = this.database
      .prepare(
        `SELECT * FROM native_payment_request_receipt_groups WHERE scope_id = ? AND request_id = ? ORDER BY group_index`,
      )
      .all(scopeId, requestId)
    if (
      groups.length !== receipt.groupCount ||
      groups.some((row, index) => row.group_index !== index) ||
      groups.reduce((total, row) => total + integer(row.proof_count), 0) !== receipt.proofCount
    )
      throw new Error('payment request conditional manifest is incomplete')
    return groups.map((row) => text(row.root_id))
  }

  private requiredRequest(candidate: NativePaymentRequestReceiptBinding): NativePaymentRequest {
    const request = this.getRequest(candidate.scopeId, candidate.requestId)
    if (request === null) throw new Error('payment request is missing')
    return request
  }

  private insertReceipt(
    candidate: NativePaymentRequestReceiptBinding,
    kind: NativePaymentRequestReceipt['kind'],
    groupCount: number,
    operationId: string | null,
  ): void {
    this.database
      .prepare(`INSERT INTO native_payment_request_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        candidate.scopeId,
        candidate.requestId,
        candidate.fingerprint,
        kind,
        candidate.proofCount,
        candidate.inputAmountMsat,
        groupCount,
        operationId,
      )
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('payment request stored text is invalid')
  return value
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error('payment request stored count is invalid')
  return Number(value)
}

function decodeIndexCursor(input: {
  readonly scopeId: string
  readonly mintUrl: string
  readonly cursor: string | null
}): string | null {
  if (input.cursor === null) return null
  if (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
    throw new Error('payment request cursor is invalid')
  try {
    const value: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('invalid cursor')
    const row = value as Record<string, unknown>
    if (
      Object.keys(row).length !== 3 ||
      row.scopeId !== input.scopeId ||
      row.mintUrl !== input.mintUrl ||
      typeof row.requestId !== 'string' ||
      row.requestId.length === 0 ||
      Buffer.byteLength(row.requestId) > 256
    )
      throw new Error('invalid cursor')
    return row.requestId
  } catch {
    throw new Error('payment request cursor is invalid')
  }
}
