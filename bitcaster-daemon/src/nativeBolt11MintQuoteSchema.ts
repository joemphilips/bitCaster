export const NATIVE_BOLT11_MINT_QUOTE_TEXT_BYTES_MAX = 16 * 1_024

export const NATIVE_BOLT11_MINT_QUOTE_SCHEMA_SQL = [
  `CREATE TABLE daemon_bolt11_mint_quotes (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    quote_record_id TEXT NOT NULL CHECK (
      length(quote_record_id) = 64 AND quote_record_id NOT GLOB '*[^0-9a-f]*'
    ),
    custody_operation_id TEXT NOT NULL CHECK (
      length(CAST(custody_operation_id AS BLOB)) BETWEEN 1 AND 16384
    ),
    mint_url TEXT NOT NULL CHECK (length(CAST(mint_url AS BLOB)) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    payment_method TEXT NOT NULL CHECK (payment_method = 'bolt11'),
    requested_amount TEXT NOT NULL CHECK (
      length(CAST(requested_amount AS BLOB)) BETWEEN 1 AND ${NATIVE_BOLT11_MINT_QUOTE_TEXT_BYTES_MAX}
      AND substr(requested_amount, 1, 1) GLOB '[1-9]'
      AND requested_amount NOT GLOB '*[^0-9]*'
    ),
    quote_id TEXT NOT NULL CHECK (
      length(CAST(quote_id AS BLOB)) BETWEEN 1 AND ${NATIVE_BOLT11_MINT_QUOTE_TEXT_BYTES_MAX}
    ),
    invoice_request TEXT NOT NULL CHECK (
      length(CAST(invoice_request AS BLOB)) BETWEEN 1 AND ${NATIVE_BOLT11_MINT_QUOTE_TEXT_BYTES_MAX}
    ),
    expiry_unix_seconds INTEGER CHECK (
      expiry_unix_seconds IS NULL OR expiry_unix_seconds BETWEEN 0 AND 9007199254740991
    ),
    presentation_state TEXT NOT NULL CHECK (presentation_state IN ('visible', 'hidden')),
    observed_state TEXT NOT NULL CHECK (observed_state IN ('UNPAID', 'PAID', 'ISSUED')),
    wallet_mint_operation_id TEXT NOT NULL CHECK (
      length(wallet_mint_operation_id) = 64
      AND wallet_mint_operation_id NOT GLOB '*[^0-9a-f]*'
    ),
    wallet_mint_operation_authority TEXT NOT NULL CHECK (
      length(CAST(wallet_mint_operation_authority AS BLOB)) BETWEEN 1 AND 1024
      AND json_valid(wallet_mint_operation_authority)
      AND json_type(wallet_mint_operation_authority) = 'object'
      AND json_type(wallet_mint_operation_authority, '$.requestFingerprint') = 'text'
      AND length(json_extract(wallet_mint_operation_authority, '$.requestFingerprint')) = 64
      AND json_extract(wallet_mint_operation_authority, '$.requestFingerprint') NOT GLOB '*[^0-9a-f]*'
      AND json_type(wallet_mint_operation_authority, '$.outputPlanFingerprint') = 'text'
      AND length(json_extract(wallet_mint_operation_authority, '$.outputPlanFingerprint')) = 64
      AND json_extract(wallet_mint_operation_authority, '$.outputPlanFingerprint') NOT GLOB '*[^0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (scope_id, quote_record_id),
    UNIQUE (scope_id, mint_url, unit, payment_method, quote_id),
    UNIQUE (scope_id, wallet_mint_operation_id),
    UNIQUE (scope_id, custody_operation_id),
    FOREIGN KEY (scope_id, custody_operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT`,
  `CREATE TRIGGER daemon_bolt11_mint_quote_operation_binding_insert
    BEFORE INSERT ON daemon_bolt11_mint_quotes
    WHEN NOT EXISTS (
      SELECT 1 FROM custody_operations AS operation
      WHERE operation.scope_id = NEW.scope_id
        AND operation.operation_id = NEW.custody_operation_id
        AND operation.retained_operation_key = NEW.wallet_mint_operation_id
        AND operation.semantic_kind = 'generic-receive'
        AND operation.wallet_stage = 'receive'
        AND operation.normalized_mint = NEW.mint_url
        AND operation.unit = NEW.unit
        AND operation.output_plan_fingerprint = json_extract(
          NEW.wallet_mint_operation_authority, '$.outputPlanFingerprint'
        )
    )
    BEGIN SELECT RAISE(ABORT, 'BOLT11 mint quote custody operation binding conflicts'); END`,
  `CREATE TRIGGER daemon_bolt11_mint_quote_no_rebind
    BEFORE UPDATE ON daemon_bolt11_mint_quotes
    WHEN NEW.scope_id IS NOT OLD.scope_id
      OR NEW.quote_record_id IS NOT OLD.quote_record_id
      OR NEW.custody_operation_id IS NOT OLD.custody_operation_id
      OR NEW.mint_url IS NOT OLD.mint_url
      OR NEW.unit IS NOT OLD.unit
      OR NEW.payment_method IS NOT OLD.payment_method
      OR NEW.requested_amount IS NOT OLD.requested_amount
      OR NEW.quote_id IS NOT OLD.quote_id
      OR NEW.invoice_request IS NOT OLD.invoice_request
      OR NEW.expiry_unix_seconds IS NOT OLD.expiry_unix_seconds
      OR NEW.wallet_mint_operation_id IS NOT OLD.wallet_mint_operation_id
      OR NEW.wallet_mint_operation_authority IS NOT OLD.wallet_mint_operation_authority
      OR NEW.revision <> OLD.revision + 1
      OR (OLD.presentation_state = 'hidden' AND NEW.presentation_state <> 'hidden')
      OR CASE OLD.observed_state
        WHEN 'UNPAID' THEN
          CASE NEW.observed_state WHEN 'UNPAID' THEN 0 WHEN 'PAID' THEN 0 WHEN 'ISSUED' THEN 0 ELSE 1 END
        WHEN 'PAID' THEN CASE NEW.observed_state WHEN 'UNPAID' THEN 1 ELSE 0 END
        WHEN 'ISSUED' THEN CASE NEW.observed_state WHEN 'ISSUED' THEN 0 ELSE 1 END
        ELSE 1
      END = 1
      OR (NEW.presentation_state = OLD.presentation_state AND NEW.observed_state = OLD.observed_state)
      OR (NEW.presentation_state <> OLD.presentation_state AND NEW.observed_state <> OLD.observed_state)
    BEGIN SELECT RAISE(ABORT, 'BOLT11 mint quote update conflicts with immutable authority'); END`,
  `CREATE TRIGGER daemon_bolt11_mint_quote_no_delete
    BEFORE DELETE ON daemon_bolt11_mint_quotes
    BEGIN SELECT RAISE(ABORT, 'BOLT11 mint quote recovery state cannot be deleted'); END`,
] as const
