import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  decodeDurableBolt11MintQuote,
  hideDurableBolt11MintQuote,
  observeDurableBolt11MintQuoteState,
  type DurableBolt11MintQuote,
} from '@bitcaster-market/client-sdk/durableBolt11MintQuote'
import { CUSTODY_ACTIVE_PAGE_LIMIT } from './durableCustodySqliteStore.ts'

export interface NativeBolt11MintQuoteRecord {
  readonly scopeId: string
  readonly custodyOperationId: string
  readonly quote: DurableBolt11MintQuote
}

interface NativeBolt11MintQuoteRow {
  readonly scopeId: unknown
  readonly quoteRecordId: unknown
  readonly custodyOperationId: unknown
  readonly mintUrl: unknown
  readonly unit: unknown
  readonly paymentMethod: unknown
  readonly requestedAmount: unknown
  readonly quoteId: unknown
  readonly invoiceRequest: unknown
  readonly expiryUnixSeconds: unknown
  readonly presentationState: unknown
  readonly observedState: unknown
  readonly walletMintOperationId: unknown
  readonly walletMintOperationAuthority: unknown
  readonly revision: unknown
}

interface CustodyOperationBindingRow {
  readonly retainedOperationKey: string
  readonly semanticKind: string
  readonly walletStage: string
  readonly mintUrl: string
  readonly unit: string
  readonly outputPlanFingerprint: string
}

const QUOTE_SELECT = `SELECT scope_id AS scopeId,
    quote_record_id AS quoteRecordId,
    custody_operation_id AS custodyOperationId,
    mint_url AS mintUrl,
    unit,
    payment_method AS paymentMethod,
    requested_amount AS requestedAmount,
    quote_id AS quoteId,
    invoice_request AS invoiceRequest,
    expiry_unix_seconds AS expiryUnixSeconds,
    presentation_state AS presentationState,
    observed_state AS observedState,
    wallet_mint_operation_id AS walletMintOperationId,
    wallet_mint_operation_authority AS walletMintOperationAuthority,
    revision
  FROM daemon_bolt11_mint_quotes`

/**
 * Quote-specific storage. The caller owns the database transaction.
 *
 * The quote request fingerprint covers the SDK wallet-mint operation. The
 * custody request fingerprint covers its lowered custody operation. The store
 * checks the retained key and output plan; the coordinator must verify the
 * quote request fingerprint against the saved SDK operation before mint I/O.
 */
export class NativeBolt11MintQuoteSqliteStore {
  readonly #database: DatabaseSync

  constructor(database: DatabaseSync) {
    this.#database = database
  }

  get(scopeId: string, quoteRecordId: string): NativeBolt11MintQuoteRecord | null {
    requireText(scopeId, 'scope id', 256)
    requireText(quoteRecordId, 'quote record id', 64)
    const row = this.#database
      .prepare(`${QUOTE_SELECT} WHERE scope_id = ? AND quote_record_id = ?`)
      .get(scopeId, quoteRecordId) as NativeBolt11MintQuoteRow | undefined
    return row === undefined ? null : decodeQuoteRow(this.#database, row)
  }

  getByCustodyOperationId(
    scopeId: string,
    custodyOperationId: string,
  ): NativeBolt11MintQuoteRecord | null {
    requireText(scopeId, 'scope id', 256)
    requireText(custodyOperationId, 'custody operation id', 16_384)
    const row = this.#database
      .prepare(`${QUOTE_SELECT} WHERE scope_id = ? AND custody_operation_id = ?`)
      .get(scopeId, custodyOperationId) as NativeBolt11MintQuoteRow | undefined
    return row === undefined ? null : decodeQuoteRow(this.#database, row)
  }

  /** Join one bounded custody page to its quote rows. */
  getActiveByCustodyOperationIds(
    scopeId: string,
    custodyOperationIds: readonly string[],
  ): readonly NativeBolt11MintQuoteRecord[] {
    requireText(scopeId, 'scope id', 256)
    if (
      custodyOperationIds.length > CUSTODY_ACTIVE_PAGE_LIMIT ||
      new Set(custodyOperationIds).size !== custodyOperationIds.length
    ) {
      throw new Error('native BOLT11 mint quote recovery page is invalid')
    }
    if (custodyOperationIds.length === 0) return []
    for (const operationId of custodyOperationIds) {
      requireText(operationId, 'custody operation id', 16_384)
    }
    const placeholders = custodyOperationIds.map(() => '?').join(', ')
    const rows = this.#database
      .prepare(
        `SELECT quote.scope_id AS scopeId,
            quote.quote_record_id AS quoteRecordId,
            quote.custody_operation_id AS custodyOperationId,
            quote.mint_url AS mintUrl,
            quote.unit,
            quote.payment_method AS paymentMethod,
            quote.requested_amount AS requestedAmount,
            quote.quote_id AS quoteId,
            quote.invoice_request AS invoiceRequest,
            quote.expiry_unix_seconds AS expiryUnixSeconds,
            quote.presentation_state AS presentationState,
            quote.observed_state AS observedState,
            quote.wallet_mint_operation_id AS walletMintOperationId,
            quote.wallet_mint_operation_authority AS walletMintOperationAuthority,
            quote.revision
         FROM custody_active_work AS active
         JOIN daemon_bolt11_mint_quotes AS quote
           ON quote.scope_id = active.scope_id
          AND quote.custody_operation_id = active.operation_id
         WHERE active.scope_id = ?
           AND active.operation_id IN (${placeholders})
         ORDER BY active.next_attempt_at_ms, active.operation_id`,
      )
      .all(scopeId, ...custodyOperationIds) as unknown as NativeBolt11MintQuoteRow[]
    return rows.map((row) => decodeQuoteRow(this.#database, row))
  }

  insert(input: {
    readonly scopeId: string
    readonly custodyOperationId: string
    readonly quote: DurableBolt11MintQuote
  }): NativeBolt11MintQuoteRecord {
    const record = decodeInput(this.#database, input)
    const quote = record.quote
    const authority = quote.walletMintOperationAuthority!
    const inserted = this.#database
      .prepare(
        `INSERT INTO daemon_bolt11_mint_quotes (
           scope_id, quote_record_id, custody_operation_id, mint_url, unit,
           payment_method, requested_amount, quote_id, invoice_request,
           expiry_unix_seconds, presentation_state, observed_state,
           wallet_mint_operation_id, wallet_mint_operation_authority, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        record.scopeId,
        quote.quoteRecordId,
        record.custodyOperationId,
        quote.mintUrl,
        quote.unit,
        quote.paymentMethod,
        quote.requestedAmount,
        quote.quoteId,
        quote.invoiceRequest,
        quote.expiryUnixSeconds,
        quote.presentationState,
        quote.observedState,
        quote.walletMintOperationId,
        JSON.stringify(authority),
        quote.revision,
      )
    const persisted = this.get(record.scopeId, quote.quoteRecordId)
    if (
      persisted === null ||
      persisted.custodyOperationId !== record.custodyOperationId ||
      !isDeepStrictEqual(persisted.quote, quote)
    ) {
      throw new Error(
        inserted.changes === 1
          ? 'native BOLT11 mint quote insert could not be read back'
          : 'native BOLT11 mint quote identity conflicts with persisted authority',
      )
    }
    return persisted
  }

  update(input: {
    readonly scopeId: string
    readonly custodyOperationId: string
    readonly expectedRevision: number
    readonly quote: DurableBolt11MintQuote
  }): NativeBolt11MintQuoteRecord {
    requireRevision(input.expectedRevision)
    const next = decodeInput(this.#database, input)
    const current = this.get(next.scopeId, next.quote.quoteRecordId)
    if (
      current === null ||
      current.custodyOperationId !== next.custodyOperationId ||
      current.quote.revision !== input.expectedRevision
    ) {
      throw new Error('native BOLT11 mint quote revision or authority changed')
    }
    if (next.quote.revision === current.quote.revision) {
      if (isDeepStrictEqual(next.quote, current.quote)) return current
      throw new Error('native BOLT11 mint quote same-revision content conflicts')
    }
    if (
      next.quote.revision !== input.expectedRevision + 1 ||
      !isSdkQuoteTransition(current.quote, next.quote)
    ) {
      throw new Error('native BOLT11 mint quote transition is invalid')
    }
    const result = this.#database
      .prepare(
        `UPDATE daemon_bolt11_mint_quotes
         SET presentation_state = ?, observed_state = ?, revision = ?
         WHERE scope_id = ? AND quote_record_id = ?
           AND custody_operation_id = ? AND revision = ?`,
      )
      .run(
        next.quote.presentationState,
        next.quote.observedState,
        next.quote.revision,
        next.scopeId,
        next.quote.quoteRecordId,
        next.custodyOperationId,
        input.expectedRevision,
      )
    if (result.changes !== 1) {
      throw new Error('native BOLT11 mint quote revision or authority changed')
    }
    const persisted = this.get(next.scopeId, next.quote.quoteRecordId)
    if (persisted === null || !isDeepStrictEqual(persisted.quote, next.quote)) {
      throw new Error('native BOLT11 mint quote update could not be read back')
    }
    return persisted
  }
}

function decodeInput(
  database: DatabaseSync,
  input: {
    readonly scopeId: string
    readonly custodyOperationId: string
    readonly quote: DurableBolt11MintQuote
  },
): NativeBolt11MintQuoteRecord {
  requireText(input.scopeId, 'scope id', 256)
  requireText(input.custodyOperationId, 'custody operation id', 16_384)
  const quote = decodeDurableBolt11MintQuote(input.quote)
  if (quote.unit !== 'msat') throw new Error('native BOLT11 mint quote unit must be msat')
  if (quote.walletMintOperationAuthority === null) {
    throw new Error('native BOLT11 mint quote operation authority is not bound')
  }
  const record = {
    scopeId: input.scopeId,
    custodyOperationId: input.custodyOperationId,
    quote,
  }
  assertCustodyOperationBinding(database, record)
  return record
}

function decodeQuoteRow(
  database: DatabaseSync,
  row: NativeBolt11MintQuoteRow,
): NativeBolt11MintQuoteRecord {
  const authority = decodeAuthorityBody(row.walletMintOperationAuthority)
  const quote = decodeDurableBolt11MintQuote({
    schemaVersion: 1,
    quoteRecordId: row.quoteRecordId,
    mintUrl: row.mintUrl,
    unit: row.unit,
    paymentMethod: row.paymentMethod,
    requestedAmount: row.requestedAmount,
    quoteId: row.quoteId,
    invoiceRequest: row.invoiceRequest,
    expiryUnixSeconds: row.expiryUnixSeconds,
    presentationState: row.presentationState,
    observedState: row.observedState,
    walletMintOperationId: row.walletMintOperationId,
    walletMintOperationAuthority: authority,
    revision: row.revision,
  })
  if (quote.unit !== 'msat' || quote.walletMintOperationAuthority === null) {
    throw new Error('native BOLT11 mint quote persisted authority is invalid')
  }
  const record = {
    scopeId: readText(row.scopeId, 'scope id', 256),
    custodyOperationId: readText(row.custodyOperationId, 'custody operation id', 16_384),
    quote,
  }
  assertCustodyOperationBinding(database, record)
  return record
}

function decodeAuthorityBody(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('native BOLT11 mint quote authority body is invalid')
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error('native BOLT11 mint quote authority body is invalid')
  }
}

function assertCustodyOperationBinding(
  database: DatabaseSync,
  record: NativeBolt11MintQuoteRecord,
): void {
  const row = database
    .prepare(
      `SELECT retained_operation_key AS retainedOperationKey,
          semantic_kind AS semanticKind,
          wallet_stage AS walletStage,
          normalized_mint AS mintUrl,
          unit,
          output_plan_fingerprint AS outputPlanFingerprint
       FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(record.scopeId, record.custodyOperationId) as CustodyOperationBindingRow | undefined
  const authority = record.quote.walletMintOperationAuthority
  if (
    row === undefined ||
    authority === null ||
    row.retainedOperationKey !== record.quote.walletMintOperationId ||
    row.semanticKind !== 'generic-receive' ||
    row.walletStage !== 'receive' ||
    row.mintUrl !== record.quote.mintUrl ||
    row.unit !== record.quote.unit ||
    row.outputPlanFingerprint !== authority.outputPlanFingerprint
  ) {
    throw new Error('native BOLT11 mint quote custody operation binding conflicts')
  }
}

function isSdkQuoteTransition(
  current: DurableBolt11MintQuote,
  next: DurableBolt11MintQuote,
): boolean {
  if (isDeepStrictEqual(hideDurableBolt11MintQuote(current), next)) return true
  try {
    return isDeepStrictEqual(observeDurableBolt11MintQuoteState(current, next.observedState), next)
  } catch {
    return false
  }
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('native BOLT11 mint quote revision is invalid')
  }
}

function requireText(value: string, label: string, byteLimit: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > byteLimit
  ) {
    throw new Error(`native BOLT11 mint quote ${label} is invalid`)
  }
}

function readText(value: unknown, label: string, byteLimit: number): string {
  if (typeof value !== 'string') {
    throw new Error(`native BOLT11 mint quote ${label} is invalid`)
  }
  requireText(value, label, byteLimit)
  return value
}
