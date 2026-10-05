import { ORACLE_EXPLANATION_UTF8_BYTES_MAX } from '@bitcaster-market/client-sdk'

export const NATIVE_ORACLE_NONCE_INDEX_LIMIT = 2 ** 31
export const NATIVE_ORACLE_INPUT_BYTES_MAX = 1024 * 1024
export const NATIVE_ORACLE_HEX_BYTES_MAX = 48 * 1024
export const NATIVE_ORACLE_EVENT_JSON_BYTES_MAX = 256 * 1024
export const NATIVE_ORACLE_OUTCOME_BYTES_MAX = 191

export const NATIVE_ORACLE_SCHEMA_SQL = [
  `CREATE TABLE daemon_oracle_nonce_allocator (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    next_nonce_index INTEGER NOT NULL CHECK (next_nonce_index BETWEEN 0 AND ${NATIVE_ORACLE_NONCE_INDEX_LIMIT})
  ) STRICT`,
  `CREATE TABLE daemon_oracle_creations (
    creation_id TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(creation_id AS BLOB)) BETWEEN 1 AND 128),
    event_id TEXT NOT NULL UNIQUE CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 512),
    nonce_index INTEGER NOT NULL UNIQUE CHECK (nonce_index >= 0 AND nonce_index < ${NATIVE_ORACLE_NONCE_INDEX_LIMIT}),
    wallet_scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    creator_public_key_hex TEXT NOT NULL CHECK (length(creator_public_key_hex) = 64 AND creator_public_key_hex NOT GLOB '*[^0-9a-f]*'),
    signer_protection TEXT NOT NULL CHECK (signer_protection IN ('owner-only-plaintext', 'scrypt-aes-256-gcm')),
    signer_kdf TEXT CHECK (signer_kdf IS NULL OR signer_kdf = 'scrypt-v1'),
    signer_salt BLOB CHECK (signer_salt IS NULL OR length(signer_salt) = 16),
    signer_iv BLOB CHECK (signer_iv IS NULL OR length(signer_iv) = 12),
    signer_auth_tag BLOB CHECK (signer_auth_tag IS NULL OR length(signer_auth_tag) = 16),
    signer_body BLOB NOT NULL CHECK (length(signer_body) = 32),
    canonical_input TEXT NOT NULL CHECK (
      length(CAST(canonical_input AS BLOB)) BETWEEN 1 AND ${NATIVE_ORACLE_INPUT_BYTES_MAX}
      AND json_valid(canonical_input) AND json_type(canonical_input) = 'object'
    ),
    condition_id TEXT UNIQUE CHECK (condition_id IS NULL OR (
      length(condition_id) = 64 AND condition_id NOT GLOB '*[^0-9a-f]*'
    )),
    announcement_hex TEXT CHECK (announcement_hex IS NULL OR (
      length(announcement_hex) BETWEEN 2 AND ${NATIVE_ORACLE_HEX_BYTES_MAX}
      AND length(announcement_hex) % 2 = 0 AND announcement_hex NOT GLOB '*[^0-9a-f]*'
    )),
    announcement_event_json TEXT CHECK (announcement_event_json IS NULL OR (
      length(CAST(announcement_event_json AS BLOB)) BETWEEN 1 AND ${NATIVE_ORACLE_EVENT_JSON_BYTES_MAX}
      AND json_valid(announcement_event_json) AND json_type(announcement_event_json) = 'object'
    )),
    chosen_outcome TEXT CHECK (chosen_outcome IS NULL OR length(CAST(chosen_outcome AS BLOB)) BETWEEN 1 AND ${NATIVE_ORACLE_OUTCOME_BYTES_MAX}),
    explanation_draft TEXT CHECK (explanation_draft IS NULL OR (
      length(CAST(explanation_draft AS BLOB)) BETWEEN 1 AND ${ORACLE_EXPLANATION_UTF8_BYTES_MAX}
    )),
    attestation_hex TEXT CHECK (attestation_hex IS NULL OR (
      length(attestation_hex) BETWEEN 2 AND ${NATIVE_ORACLE_HEX_BYTES_MAX}
      AND length(attestation_hex) % 2 = 0 AND attestation_hex NOT GLOB '*[^0-9a-f]*'
    )),
    attestation_event_json TEXT CHECK (attestation_event_json IS NULL OR (
      length(CAST(attestation_event_json AS BLOB)) BETWEEN 1 AND ${NATIVE_ORACLE_EVENT_JSON_BYTES_MAX}
      AND json_valid(attestation_event_json) AND json_type(attestation_event_json) = 'object'
    )),
    attestation_relay_published INTEGER NOT NULL DEFAULT 0 CHECK (attestation_relay_published IN (0, 1)),
    attestation_engine_evidence_json TEXT CHECK (attestation_engine_evidence_json IS NULL OR (
      length(CAST(attestation_engine_evidence_json AS BLOB)) BETWEEN 1 AND 4096
      AND json_valid(attestation_engine_evidence_json) AND json_type(attestation_engine_evidence_json) = 'object'
    )),
    explanation_event_json TEXT CHECK (explanation_event_json IS NULL OR (
      length(CAST(explanation_event_json AS BLOB)) BETWEEN 1 AND ${NATIVE_ORACLE_EVENT_JSON_BYTES_MAX}
      AND json_valid(explanation_event_json) AND json_type(explanation_event_json) = 'object'
    )),
    explanation_relay_published INTEGER NOT NULL DEFAULT 0 CHECK (explanation_relay_published IN (0, 1)),
    backup_terminal INTEGER NOT NULL DEFAULT 0 CHECK (backup_terminal IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    creation_metadata_json TEXT CHECK (creation_metadata_json IS NULL OR (
      length(CAST(creation_metadata_json AS BLOB)) BETWEEN 1 AND 262144
      AND json_valid(creation_metadata_json) AND json_type(creation_metadata_json) = 'object'
    )),
    creation_mint_url TEXT CHECK (creation_mint_url IS NULL OR length(CAST(creation_mint_url AS BLOB)) BETWEEN 1 AND 2048),
    creation_engine_base_url TEXT CHECK (creation_engine_base_url IS NULL OR length(CAST(creation_engine_base_url AS BLOB)) BETWEEN 1 AND 2048),
    creation_fee_operation_ref TEXT CHECK (creation_fee_operation_ref IS NULL OR length(CAST(creation_fee_operation_ref AS BLOB)) BETWEEN 1 AND 256),
    creation_fee_amount INTEGER CHECK (creation_fee_amount IS NULL OR creation_fee_amount BETWEEN 0 AND 1000000),
    creation_fee_unit TEXT CHECK (creation_fee_unit IS NULL OR creation_fee_unit = 'msat'),
    creation_thumbnail_bytes BLOB CHECK (creation_thumbnail_bytes IS NULL OR length(creation_thumbnail_bytes) BETWEEN 1 AND 5242880),
    creation_thumbnail_filename TEXT CHECK (creation_thumbnail_filename IS NULL OR length(CAST(creation_thumbnail_filename AS BLOB)) BETWEEN 1 AND 6291456),
    creation_thumbnail_content_type TEXT CHECK (creation_thumbnail_content_type IS NULL OR length(CAST(creation_thumbnail_content_type AS BLOB)) BETWEEN 0 AND 6291456),
    creation_mint_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (creation_mint_confirmed IN (0, 1)),
    creation_engine_result_json TEXT CHECK (creation_engine_result_json IS NULL OR (
      length(CAST(creation_engine_result_json AS BLOB)) BETWEEN 1 AND 65536
      AND json_valid(creation_engine_result_json) AND json_type(creation_engine_result_json) = 'object'
    )),
    CHECK ((creation_thumbnail_bytes IS NULL AND creation_thumbnail_filename IS NULL AND creation_thumbnail_content_type IS NULL)
      OR (creation_thumbnail_bytes IS NOT NULL AND creation_thumbnail_filename IS NOT NULL AND creation_thumbnail_content_type IS NOT NULL)),
    CHECK ((creation_metadata_json IS NULL AND creation_mint_url IS NULL AND creation_engine_base_url IS NULL
        AND creation_fee_amount IS NULL AND creation_fee_unit IS NULL AND creation_fee_operation_ref IS NULL
        AND creation_thumbnail_bytes IS NULL AND creation_mint_confirmed = 0 AND creation_engine_result_json IS NULL)
      OR (creation_metadata_json IS NOT NULL AND condition_id IS NOT NULL
        AND creation_mint_url IS NOT NULL AND creation_engine_base_url IS NOT NULL
        AND creation_fee_amount IS NOT NULL AND creation_fee_unit IS NOT NULL
        AND ((creation_fee_amount = 0 AND creation_fee_operation_ref IS NULL)
          OR (creation_fee_amount > 0 AND creation_fee_operation_ref IS NOT NULL)))),
    CHECK (backup_terminal = 0 OR (attestation_hex IS NOT NULL AND attestation_relay_published = 1)),
    CHECK (creation_engine_result_json IS NULL OR creation_mint_confirmed = 1),
    CHECK ((signer_protection = 'owner-only-plaintext' AND signer_kdf IS NULL
      AND signer_salt IS NULL AND signer_iv IS NULL AND signer_auth_tag IS NULL)
      OR (signer_protection = 'scrypt-aes-256-gcm' AND signer_kdf = 'scrypt-v1'
      AND signer_salt IS NOT NULL AND signer_iv IS NOT NULL AND signer_auth_tag IS NOT NULL)),
    CHECK ((condition_id IS NULL AND announcement_hex IS NULL AND announcement_event_json IS NULL)
      OR (condition_id IS NOT NULL AND announcement_hex IS NOT NULL AND announcement_event_json IS NOT NULL)),
    CHECK (chosen_outcome IS NULL OR condition_id IS NOT NULL),
    CHECK (explanation_draft IS NULL OR chosen_outcome IS NOT NULL),
    CHECK (explanation_event_json IS NULL OR (explanation_draft IS NOT NULL
      AND json_extract(explanation_event_json, '$.content') = explanation_draft)),
    CHECK ((attestation_hex IS NULL AND attestation_event_json IS NULL)
      OR (attestation_hex IS NOT NULL AND attestation_event_json IS NOT NULL AND chosen_outcome IS NOT NULL)),
    CHECK (attestation_hex IS NOT NULL OR (attestation_relay_published = 0
      AND attestation_engine_evidence_json IS NULL AND explanation_event_json IS NULL)),
    CHECK (explanation_event_json IS NOT NULL OR explanation_relay_published = 0)
  ) STRICT`,
  `CREATE TRIGGER oracle_nonce_allocator_no_lowering
    BEFORE UPDATE ON daemon_oracle_nonce_allocator
    WHEN NEW.singleton != OLD.singleton OR NEW.next_nonce_index < OLD.next_nonce_index
    BEGIN SELECT RAISE(ABORT, 'oracle nonce allocator cannot move backwards'); END`,
  `CREATE TRIGGER oracle_nonce_allocator_no_delete
    BEFORE DELETE ON daemon_oracle_nonce_allocator
    BEGIN SELECT RAISE(ABORT, 'oracle nonce allocator cannot be deleted'); END`,
  `CREATE TRIGGER oracle_creation_no_rebind
    BEFORE UPDATE ON daemon_oracle_creations
    WHEN NEW.creation_id != OLD.creation_id OR NEW.event_id != OLD.event_id
      OR NEW.nonce_index != OLD.nonce_index OR NEW.canonical_input != OLD.canonical_input
      OR NEW.wallet_scope_id != OLD.wallet_scope_id OR NEW.creator_public_key_hex != OLD.creator_public_key_hex
      OR NEW.signer_protection != OLD.signer_protection OR NEW.signer_kdf IS NOT OLD.signer_kdf
      OR NEW.signer_salt IS NOT OLD.signer_salt OR NEW.signer_iv IS NOT OLD.signer_iv
      OR NEW.signer_auth_tag IS NOT OLD.signer_auth_tag OR NEW.signer_body IS NOT OLD.signer_body
      OR NEW.backup_terminal < OLD.backup_terminal
      OR NEW.created_at_ms != OLD.created_at_ms
      OR (OLD.condition_id IS NOT NULL AND (NEW.condition_id IS NOT OLD.condition_id
        OR NEW.announcement_hex IS NOT OLD.announcement_hex
        OR NEW.announcement_event_json IS NOT OLD.announcement_event_json))
      OR (OLD.chosen_outcome IS NOT NULL AND NEW.chosen_outcome IS NOT OLD.chosen_outcome)
      OR (OLD.chosen_outcome IS NOT NULL AND NEW.explanation_draft IS NOT OLD.explanation_draft)
      OR (OLD.attestation_hex IS NOT NULL AND (NEW.attestation_hex IS NOT OLD.attestation_hex
        OR NEW.attestation_event_json IS NOT OLD.attestation_event_json))
      OR NEW.attestation_relay_published < OLD.attestation_relay_published
      OR NEW.explanation_relay_published < OLD.explanation_relay_published
      OR (OLD.attestation_engine_evidence_json IS NOT NULL
        AND NEW.attestation_engine_evidence_json IS NOT OLD.attestation_engine_evidence_json)
      OR (OLD.explanation_event_json IS NOT NULL
        AND NEW.explanation_event_json IS NOT OLD.explanation_event_json)
      OR (OLD.creation_metadata_json IS NOT NULL AND (
        NEW.creation_metadata_json IS NOT OLD.creation_metadata_json
        OR NEW.creation_mint_url IS NOT OLD.creation_mint_url
        OR NEW.creation_engine_base_url IS NOT OLD.creation_engine_base_url
        OR NEW.creation_fee_operation_ref IS NOT OLD.creation_fee_operation_ref
        OR NEW.creation_fee_amount IS NOT OLD.creation_fee_amount
        OR NEW.creation_fee_unit IS NOT OLD.creation_fee_unit
        OR NEW.creation_thumbnail_bytes IS NOT OLD.creation_thumbnail_bytes
        OR NEW.creation_thumbnail_filename IS NOT OLD.creation_thumbnail_filename
        OR NEW.creation_thumbnail_content_type IS NOT OLD.creation_thumbnail_content_type))
      OR NEW.creation_mint_confirmed < OLD.creation_mint_confirmed
      OR (OLD.creation_engine_result_json IS NOT NULL
        AND NEW.creation_engine_result_json IS NOT OLD.creation_engine_result_json)
    BEGIN SELECT RAISE(ABORT, 'oracle creation is immutable after commitment'); END`,
  `CREATE TRIGGER oracle_creation_no_delete
    BEFORE DELETE ON daemon_oracle_creations
    BEGIN SELECT RAISE(ABORT, 'oracle creation cannot be deleted'); END`,
  `CREATE TABLE daemon_oracle_imports (
    condition_id TEXT PRIMARY KEY NOT NULL CHECK (length(condition_id) = 64 AND condition_id NOT GLOB '*[^0-9a-f]*'),
    event_id TEXT NOT NULL UNIQUE CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 512),
    wallet_scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    oracle_pubkey TEXT NOT NULL CHECK (length(oracle_pubkey) = 64 AND oracle_pubkey NOT GLOB '*[^0-9a-f]*'),
    announcement_hex TEXT NOT NULL CHECK (length(announcement_hex) BETWEEN 2 AND ${NATIVE_ORACLE_HEX_BYTES_MAX} AND length(announcement_hex) % 2 = 0 AND announcement_hex NOT GLOB '*[^0-9a-f]*'),
    announcement_event_json TEXT NOT NULL CHECK (length(CAST(announcement_event_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(announcement_event_json) AND json_type(announcement_event_json) = 'object'),
    outcomes_json TEXT NOT NULL CHECK (length(CAST(outcomes_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(outcomes_json) AND json_type(outcomes_json) = 'array'),
    destinations_json TEXT NOT NULL CHECK (length(CAST(destinations_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(destinations_json) AND json_type(destinations_json) = 'object'),
    chosen_outcome TEXT CHECK (chosen_outcome IS NULL OR length(CAST(chosen_outcome AS BLOB)) BETWEEN 1 AND ${NATIVE_ORACLE_OUTCOME_BYTES_MAX}),
    relay_published INTEGER NOT NULL DEFAULT 0 CHECK (relay_published IN (0, 1)),
    explanation_relay_published INTEGER NOT NULL DEFAULT 0 CHECK (explanation_relay_published IN (0, 1)),
    publication_json TEXT CHECK (publication_json IS NULL OR (length(CAST(publication_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(publication_json) AND json_type(publication_json) = 'object')),
    explanation_draft TEXT CHECK (explanation_draft IS NULL OR length(CAST(explanation_draft AS BLOB)) BETWEEN 1 AND ${ORACLE_EXPLANATION_UTF8_BYTES_MAX}),
    nonce_protection TEXT CHECK (nonce_protection IS NULL OR nonce_protection IN ('owner-only-plaintext', 'scrypt-aes-256-gcm')),
    nonce_kdf TEXT CHECK (nonce_kdf IS NULL OR nonce_kdf = 'scrypt-v1'),
    nonce_salt BLOB CHECK (nonce_salt IS NULL OR length(nonce_salt) = 16),
    nonce_iv BLOB CHECK (nonce_iv IS NULL OR length(nonce_iv) = 12),
    nonce_auth_tag BLOB CHECK (nonce_auth_tag IS NULL OR length(nonce_auth_tag) = 16),
    nonce_body BLOB CHECK (nonce_body IS NULL OR length(nonce_body) = 32),
    CHECK ((nonce_protection IS NULL AND nonce_kdf IS NULL AND nonce_salt IS NULL AND nonce_iv IS NULL AND nonce_auth_tag IS NULL AND nonce_body IS NULL AND publication_json IS NOT NULL
      AND json_type(publication_json, '$.attestation') IS 'object' AND json_extract(publication_json, '$.relayPublished') IS 1)
      OR (nonce_body IS NOT NULL AND ((nonce_protection IS 'owner-only-plaintext' AND nonce_kdf IS NULL AND nonce_salt IS NULL AND nonce_iv IS NULL AND nonce_auth_tag IS NULL)
      OR (nonce_protection IS 'scrypt-aes-256-gcm' AND nonce_kdf IS 'scrypt-v1' AND nonce_salt IS NOT NULL AND nonce_iv IS NOT NULL AND nonce_auth_tag IS NOT NULL)))),
    CHECK (explanation_draft IS NULL OR publication_json IS NOT NULL),
    CHECK ((publication_json IS NULL AND chosen_outcome IS NULL AND relay_published = 0 AND explanation_relay_published = 0) OR (publication_json IS NOT NULL AND chosen_outcome IS NOT NULL)),
    CHECK (publication_json IS NULL OR (
      json_extract(publication_json, '$.chosenOutcome') IS chosen_outcome
      AND json_extract(publication_json, '$.relayPublished') IS relay_published
      AND json_extract(publication_json, '$.explanationRelayPublished') IS explanation_relay_published
      AND json_type(publication_json, '$.chosenOutcome') IS 'text'
      AND json_type(publication_json, '$.binding') IS 'object'
      AND json_extract(publication_json, '$.binding.conditionId') IS condition_id
      AND json_extract(publication_json, '$.binding.oracleEventId') IS event_id
      AND json_extract(publication_json, '$.binding.oraclePubkey') IS oracle_pubkey
      AND json_extract(publication_json, '$.binding.announcementEventJson') IS announcement_event_json
      AND json_extract(publication_json, '$.binding.outcomes') IS outcomes_json
      AND (json_type(publication_json, '$.relayPublished') IS 'true' OR json_type(publication_json, '$.relayPublished') IS 'false')
      AND (json_type(publication_json, '$.explanationRelayPublished') IS 'true' OR json_type(publication_json, '$.explanationRelayPublished') IS 'false')
      AND (json_type(publication_json, '$.attestation') IS 'object' OR json_type(publication_json, '$.attestation') IS 'null')
      AND (json_type(publication_json, '$.engineEvidence') IS 'object' OR json_type(publication_json, '$.engineEvidence') IS 'null')
      AND (json_type(publication_json, '$.explanationEventJson') IS 'text' OR json_type(publication_json, '$.explanationEventJson') IS 'null')
      AND (json_type(publication_json, '$.attestation') IS 'object' OR (json_extract(publication_json, '$.relayPublished') = 0 AND json_type(publication_json, '$.engineEvidence') IS 'null' AND json_type(publication_json, '$.explanationEventJson') IS 'null'))
      AND (json_type(publication_json, '$.explanationEventJson') IS 'null' OR (explanation_draft IS NOT NULL AND json_extract(json_extract(publication_json, '$.explanationEventJson'), '$.content') IS explanation_draft))
      AND (json_type(publication_json, '$.explanationEventJson') IS 'text' OR json_extract(publication_json, '$.explanationRelayPublished') = 0)
    ))
  ) STRICT`,
  `CREATE TRIGGER oracle_import_no_rebind BEFORE UPDATE ON daemon_oracle_imports
    WHEN NEW.condition_id != OLD.condition_id OR NEW.event_id != OLD.event_id
      OR NEW.wallet_scope_id != OLD.wallet_scope_id OR NEW.oracle_pubkey != OLD.oracle_pubkey
      OR NEW.announcement_hex != OLD.announcement_hex OR NEW.announcement_event_json != OLD.announcement_event_json
      OR NEW.outcomes_json != OLD.outcomes_json OR NEW.destinations_json != OLD.destinations_json
      OR (OLD.chosen_outcome IS NOT NULL AND NEW.chosen_outcome IS NOT OLD.chosen_outcome)
      OR NEW.relay_published < OLD.relay_published OR NEW.explanation_relay_published < OLD.explanation_relay_published
      OR (OLD.nonce_body IS NULL AND NEW.nonce_body IS NOT NULL)
      OR (NEW.nonce_body IS NOT NULL AND (NEW.nonce_body IS NOT OLD.nonce_body
        OR NEW.nonce_protection IS NOT OLD.nonce_protection OR NEW.nonce_kdf IS NOT OLD.nonce_kdf
        OR NEW.nonce_salt IS NOT OLD.nonce_salt OR NEW.nonce_iv IS NOT OLD.nonce_iv OR NEW.nonce_auth_tag IS NOT OLD.nonce_auth_tag))
      OR (OLD.publication_json IS NOT NULL AND (NEW.publication_json IS NULL
        OR json_extract(NEW.publication_json,'$.chosenOutcome') IS NOT json_extract(OLD.publication_json,'$.chosenOutcome')
        OR (json_type(OLD.publication_json,'$.attestation') = 'object' AND (
          json_extract(NEW.publication_json,'$.attestation.attestationHex') IS NOT json_extract(OLD.publication_json,'$.attestation.attestationHex')
          OR json_extract(NEW.publication_json,'$.attestation.eventJson') IS NOT json_extract(OLD.publication_json,'$.attestation.eventJson')))
        OR json_extract(NEW.publication_json,'$.relayPublished') < json_extract(OLD.publication_json,'$.relayPublished')
        OR json_extract(NEW.publication_json,'$.explanationRelayPublished') < json_extract(OLD.publication_json,'$.explanationRelayPublished')
        OR (json_type(OLD.publication_json,'$.engineEvidence') = 'object' AND json_extract(NEW.publication_json,'$.engineEvidence') IS NOT json_extract(OLD.publication_json,'$.engineEvidence'))
        OR (json_type(OLD.publication_json,'$.explanationEventJson') = 'text' AND json_extract(NEW.publication_json,'$.explanationEventJson') IS NOT json_extract(OLD.publication_json,'$.explanationEventJson'))))
      OR (OLD.publication_json IS NOT NULL AND NEW.explanation_draft IS NOT OLD.explanation_draft)
    BEGIN SELECT RAISE(ABORT, 'oracle import is immutable after commitment'); END`,
  `CREATE TRIGGER oracle_import_no_delete BEFORE DELETE ON daemon_oracle_imports
    BEGIN SELECT RAISE(ABORT, 'oracle import cannot be deleted'); END`,
  `CREATE TRIGGER oracle_import_no_created_collision BEFORE INSERT ON daemon_oracle_imports
    WHEN EXISTS (SELECT 1 FROM daemon_oracle_creations WHERE condition_id = NEW.condition_id OR event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'oracle authority conflicts'); END`,
  `CREATE TRIGGER oracle_creation_no_import_collision BEFORE INSERT ON daemon_oracle_creations
    WHEN EXISTS (SELECT 1 FROM daemon_oracle_imports WHERE event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'oracle authority conflicts'); END`,
  `CREATE TRIGGER oracle_creation_announcement_no_import_collision BEFORE UPDATE OF condition_id ON daemon_oracle_creations
    WHEN EXISTS (SELECT 1 FROM daemon_oracle_imports WHERE condition_id = NEW.condition_id)
    BEGIN SELECT RAISE(ABORT, 'oracle authority conflicts'); END`,
] as const
