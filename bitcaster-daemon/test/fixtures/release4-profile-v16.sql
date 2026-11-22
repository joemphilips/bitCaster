-- The daemon profile that the CLI release cli-v0.1.0-afaa6cc6aa6b (bitCaster 52d412a1)
-- wrote: schema version 16 and its rows, dumped as SQL text. A generator in a git
-- archive export of 52d412a1 wrote the rows with the shipped writers. Do not regenerate.
PRAGMA application_id = 1111704653;
PRAGMA user_version = 16;
PRAGMA journal_mode = wal;
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE daemon_bookmark_preferences (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    markets_json TEXT NOT NULL CHECK (json_valid(markets_json) AND json_type(markets_json) = 'array'),
    sync_context TEXT,
    pending_local_edit INTEGER NOT NULL CHECK (pending_local_edit IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    last_event_time INTEGER NOT NULL CHECK (last_event_time BETWEEN 0 AND 9007199254740991)
  ) STRICT;
CREATE TABLE daemon_oracle_nonce_allocator (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    next_nonce_index INTEGER NOT NULL CHECK (next_nonce_index BETWEEN 0 AND 2147483648)
  ) STRICT;
INSERT INTO "daemon_oracle_nonce_allocator" ("singleton", "next_nonce_index") VALUES (1, 1);
CREATE TABLE daemon_oracle_creations (
    creation_id TEXT PRIMARY KEY NOT NULL CHECK (length(CAST(creation_id AS BLOB)) BETWEEN 1 AND 128),
    event_id TEXT NOT NULL UNIQUE CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 512),
    nonce_index INTEGER NOT NULL UNIQUE CHECK (nonce_index >= 0 AND nonce_index < 2147483648),
    wallet_scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    creator_public_key_hex TEXT NOT NULL CHECK (length(creator_public_key_hex) = 64 AND creator_public_key_hex NOT GLOB '*[^0-9a-f]*'),
    signer_protection TEXT NOT NULL CHECK (signer_protection IN ('owner-only-plaintext', 'scrypt-aes-256-gcm')),
    signer_kdf TEXT CHECK (signer_kdf IS NULL OR signer_kdf = 'scrypt-v1'),
    signer_salt BLOB CHECK (signer_salt IS NULL OR length(signer_salt) = 16),
    signer_iv BLOB CHECK (signer_iv IS NULL OR length(signer_iv) = 12),
    signer_auth_tag BLOB CHECK (signer_auth_tag IS NULL OR length(signer_auth_tag) = 16),
    signer_body BLOB NOT NULL CHECK (length(signer_body) = 32),
    canonical_input TEXT NOT NULL CHECK (
      length(CAST(canonical_input AS BLOB)) BETWEEN 1 AND 1048576
      AND json_valid(canonical_input) AND json_type(canonical_input) = 'object'
    ),
    condition_id TEXT UNIQUE CHECK (condition_id IS NULL OR (
      length(condition_id) = 64 AND condition_id NOT GLOB '*[^0-9a-f]*'
    )),
    announcement_hex TEXT CHECK (announcement_hex IS NULL OR (
      length(announcement_hex) BETWEEN 2 AND 49152
      AND length(announcement_hex) % 2 = 0 AND announcement_hex NOT GLOB '*[^0-9a-f]*'
    )),
    announcement_event_json TEXT CHECK (announcement_event_json IS NULL OR (
      length(CAST(announcement_event_json AS BLOB)) BETWEEN 1 AND 262144
      AND json_valid(announcement_event_json) AND json_type(announcement_event_json) = 'object'
    )),
    chosen_outcome TEXT CHECK (chosen_outcome IS NULL OR length(CAST(chosen_outcome AS BLOB)) BETWEEN 1 AND 191),
    explanation_draft TEXT CHECK (explanation_draft IS NULL OR (
      length(CAST(explanation_draft AS BLOB)) BETWEEN 1 AND 4096
    )),
    attestation_hex TEXT CHECK (attestation_hex IS NULL OR (
      length(attestation_hex) BETWEEN 2 AND 49152
      AND length(attestation_hex) % 2 = 0 AND attestation_hex NOT GLOB '*[^0-9a-f]*'
    )),
    attestation_event_json TEXT CHECK (attestation_event_json IS NULL OR (
      length(CAST(attestation_event_json AS BLOB)) BETWEEN 1 AND 262144
      AND json_valid(attestation_event_json) AND json_type(attestation_event_json) = 'object'
    )),
    attestation_relay_published INTEGER NOT NULL DEFAULT 0 CHECK (attestation_relay_published IN (0, 1)),
    attestation_engine_evidence_json TEXT CHECK (attestation_engine_evidence_json IS NULL OR (
      length(CAST(attestation_engine_evidence_json AS BLOB)) BETWEEN 1 AND 4096
      AND json_valid(attestation_engine_evidence_json) AND json_type(attestation_engine_evidence_json) = 'object'
    )),
    explanation_event_json TEXT CHECK (explanation_event_json IS NULL OR (
      length(CAST(explanation_event_json AS BLOB)) BETWEEN 1 AND 262144
      AND json_valid(explanation_event_json) AND json_type(explanation_event_json) = 'object'
    )),
    explanation_relay_published INTEGER NOT NULL DEFAULT 0 CHECK (explanation_relay_published IN (0, 1)),
    backup_delivery_json TEXT CHECK (backup_delivery_json IS NULL OR (
  length(CAST(backup_delivery_json AS BLOB)) BETWEEN 1 AND 262144
  AND json_valid(backup_delivery_json) AND json_type(backup_delivery_json) IS 'object'
  AND condition_id IS NOT NULL
  AND json_extract(backup_delivery_json,'$.schemaVersion') IS 1
  AND json_type(backup_delivery_json,'$.binding') IS 'object'
  AND json_extract(backup_delivery_json,'$.binding.conditionId') IS condition_id
  AND json_type(backup_delivery_json,'$.binding.oraclePubkey') IS 'text'
  AND length(json_extract(backup_delivery_json,'$.binding.announcementEventId')) IS 64
  AND json_type(backup_delivery_json,'$.relayUrls') IS 'array'
  AND json_array_length(backup_delivery_json,'$.relayUrls') BETWEEN 0 AND 64
  AND json_type(backup_delivery_json,'$.knownEventIds') IS 'array'
  AND json_array_length(backup_delivery_json,'$.knownEventIds') BETWEEN 0 AND 64
  AND (json_extract(backup_delivery_json,'$.current.mode') IS 'terminal' OR json_array_length(backup_delivery_json,'$.knownEventIds') <= 63)
  AND json_type(backup_delivery_json,'$.timestampHighWater') IS 'integer'
  AND json_extract(backup_delivery_json,'$.timestampHighWater') BETWEEN 0 AND 9007199254740991
  AND (json_type(backup_delivery_json,'$.terminalCommitPending') IS 'true' OR json_type(backup_delivery_json,'$.terminalCommitPending') IS 'false')
  AND (json_type(backup_delivery_json,'$.current') IS 'null' OR (
    json_type(backup_delivery_json,'$.current') IS 'object'
    AND ((json_extract(backup_delivery_json,'$.current.mode') IS 'initial' AND json_extract(backup_delivery_json,'$.current.generation') IS 1 AND json_type(backup_delivery_json,'$.current.attestationEventId') IS 'null')
      OR (json_extract(backup_delivery_json,'$.current.mode') IS 'terminal' AND json_extract(backup_delivery_json,'$.current.generation') IS 2 AND length(json_extract(backup_delivery_json,'$.current.attestationEventId')) IS 64))
    AND length(json_extract(backup_delivery_json,'$.current.eventId')) IS 64
    AND json_type(backup_delivery_json,'$.current.eventJson') IS 'text'
    AND json_valid(json_extract(backup_delivery_json,'$.current.eventJson'))
    AND json_type(backup_delivery_json,'$.current.acknowledgedRelayIndexes') IS 'array'
    AND json_array_length(backup_delivery_json,'$.current.acknowledgedRelayIndexes') BETWEEN 0 AND 64
  ))
  AND (json_type(backup_delivery_json,'$.deletion') IS 'null' OR (
    json_type(backup_delivery_json,'$.deletion') IS 'object'
    AND json_extract(backup_delivery_json,'$.current.mode') IS 'terminal'
    AND length(json_extract(backup_delivery_json,'$.deletion.eventId')) IS 64
    AND json_type(backup_delivery_json,'$.deletion.eventJson') IS 'text'
    AND json_valid(json_extract(backup_delivery_json,'$.deletion.eventJson'))
    AND json_type(backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') IS 'array'
    AND json_array_length(backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') BETWEEN 0 AND 64
  ))
  AND ((json_type(backup_delivery_json,'$.terminalAdmission') IS 'null' AND json_extract(backup_delivery_json,'$.terminalCommitPending') IS 0 AND json_extract(backup_delivery_json,'$.current.mode') IS NOT 'terminal') OR (
    json_type(backup_delivery_json,'$.terminalAdmission') IS 'object'
    AND json_extract(backup_delivery_json,'$.current.mode') IS 'terminal'
    AND json_extract(backup_delivery_json,'$.terminalAdmission.generation') IS 2
    AND json_extract(backup_delivery_json,'$.terminalAdmission.backupEventId') IS json_extract(backup_delivery_json,'$.current.eventId')
    AND json_extract(backup_delivery_json,'$.terminalAdmission.announcementEventId') IS json_extract(backup_delivery_json,'$.binding.announcementEventId')
    AND json_extract(backup_delivery_json,'$.terminalAdmission.attestationEventId') IS json_extract(backup_delivery_json,'$.current.attestationEventId')
  ))
)),
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
  ) STRICT;
INSERT INTO "daemon_oracle_creations" ("creation_id", "event_id", "nonce_index", "wallet_scope_id", "creator_public_key_hex", "signer_protection", "signer_kdf", "signer_salt", "signer_iv", "signer_auth_tag", "signer_body", "canonical_input", "condition_id", "announcement_hex", "announcement_event_json", "chosen_outcome", "explanation_draft", "attestation_hex", "attestation_event_json", "attestation_relay_published", "attestation_engine_evidence_json", "explanation_event_json", "explanation_relay_published", "backup_delivery_json", "backup_terminal", "created_at_ms", "creation_metadata_json", "creation_mint_url", "creation_engine_base_url", "creation_fee_operation_ref", "creation_fee_amount", "creation_fee_unit", "creation_thumbnail_bytes", "creation_thumbnail_filename", "creation_thumbnail_content_type", "creation_mint_confirmed", "creation_engine_result_json") VALUES ('release4-oracle', 'event-release4-oracle', 0, 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', '6776bee20c9bf74c421e703c23a132f6dbdf6c882c7f6634b128e66820139db1', 'owner-only-plaintext', NULL, NULL, NULL, NULL, X'3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c', '{"outcomes":["YES","NO"]}', 'abababababababababababababababababababababababababababababababab', 'aabb', '{"kind":88}', NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, NULL, 0, 1794230409160, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL);
CREATE TABLE daemon_oracle_imports (
    condition_id TEXT PRIMARY KEY NOT NULL CHECK (length(condition_id) = 64 AND condition_id NOT GLOB '*[^0-9a-f]*'),
    event_id TEXT NOT NULL UNIQUE CHECK (length(CAST(event_id AS BLOB)) BETWEEN 1 AND 512),
    wallet_scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    oracle_pubkey TEXT NOT NULL CHECK (length(oracle_pubkey) = 64 AND oracle_pubkey NOT GLOB '*[^0-9a-f]*'),
    announcement_hex TEXT NOT NULL CHECK (length(announcement_hex) BETWEEN 2 AND 49152 AND length(announcement_hex) % 2 = 0 AND announcement_hex NOT GLOB '*[^0-9a-f]*'),
    announcement_event_json TEXT NOT NULL CHECK (length(CAST(announcement_event_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(announcement_event_json) AND json_type(announcement_event_json) = 'object'),
    backup_delivery_json TEXT CHECK (backup_delivery_json IS NULL OR (
  length(CAST(backup_delivery_json AS BLOB)) BETWEEN 1 AND 262144
  AND json_valid(backup_delivery_json) AND json_type(backup_delivery_json) IS 'object'
  AND condition_id IS NOT NULL
  AND json_extract(backup_delivery_json,'$.schemaVersion') IS 1
  AND json_type(backup_delivery_json,'$.binding') IS 'object'
  AND json_extract(backup_delivery_json,'$.binding.conditionId') IS condition_id
  AND json_type(backup_delivery_json,'$.binding.oraclePubkey') IS 'text'
  AND length(json_extract(backup_delivery_json,'$.binding.announcementEventId')) IS 64
  AND json_type(backup_delivery_json,'$.relayUrls') IS 'array'
  AND json_array_length(backup_delivery_json,'$.relayUrls') BETWEEN 0 AND 64
  AND json_type(backup_delivery_json,'$.knownEventIds') IS 'array'
  AND json_array_length(backup_delivery_json,'$.knownEventIds') BETWEEN 0 AND 64
  AND (json_extract(backup_delivery_json,'$.current.mode') IS 'terminal' OR json_array_length(backup_delivery_json,'$.knownEventIds') <= 63)
  AND json_type(backup_delivery_json,'$.timestampHighWater') IS 'integer'
  AND json_extract(backup_delivery_json,'$.timestampHighWater') BETWEEN 0 AND 9007199254740991
  AND (json_type(backup_delivery_json,'$.terminalCommitPending') IS 'true' OR json_type(backup_delivery_json,'$.terminalCommitPending') IS 'false')
  AND (json_type(backup_delivery_json,'$.current') IS 'null' OR (
    json_type(backup_delivery_json,'$.current') IS 'object'
    AND ((json_extract(backup_delivery_json,'$.current.mode') IS 'initial' AND json_extract(backup_delivery_json,'$.current.generation') IS 1 AND json_type(backup_delivery_json,'$.current.attestationEventId') IS 'null')
      OR (json_extract(backup_delivery_json,'$.current.mode') IS 'terminal' AND json_extract(backup_delivery_json,'$.current.generation') IS 2 AND length(json_extract(backup_delivery_json,'$.current.attestationEventId')) IS 64))
    AND length(json_extract(backup_delivery_json,'$.current.eventId')) IS 64
    AND json_type(backup_delivery_json,'$.current.eventJson') IS 'text'
    AND json_valid(json_extract(backup_delivery_json,'$.current.eventJson'))
    AND json_type(backup_delivery_json,'$.current.acknowledgedRelayIndexes') IS 'array'
    AND json_array_length(backup_delivery_json,'$.current.acknowledgedRelayIndexes') BETWEEN 0 AND 64
  ))
  AND (json_type(backup_delivery_json,'$.deletion') IS 'null' OR (
    json_type(backup_delivery_json,'$.deletion') IS 'object'
    AND json_extract(backup_delivery_json,'$.current.mode') IS 'terminal'
    AND length(json_extract(backup_delivery_json,'$.deletion.eventId')) IS 64
    AND json_type(backup_delivery_json,'$.deletion.eventJson') IS 'text'
    AND json_valid(json_extract(backup_delivery_json,'$.deletion.eventJson'))
    AND json_type(backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') IS 'array'
    AND json_array_length(backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') BETWEEN 0 AND 64
  ))
  AND ((json_type(backup_delivery_json,'$.terminalAdmission') IS 'null' AND json_extract(backup_delivery_json,'$.terminalCommitPending') IS 0 AND json_extract(backup_delivery_json,'$.current.mode') IS NOT 'terminal') OR (
    json_type(backup_delivery_json,'$.terminalAdmission') IS 'object'
    AND json_extract(backup_delivery_json,'$.current.mode') IS 'terminal'
    AND json_extract(backup_delivery_json,'$.terminalAdmission.generation') IS 2
    AND json_extract(backup_delivery_json,'$.terminalAdmission.backupEventId') IS json_extract(backup_delivery_json,'$.current.eventId')
    AND json_extract(backup_delivery_json,'$.terminalAdmission.announcementEventId') IS json_extract(backup_delivery_json,'$.binding.announcementEventId')
    AND json_extract(backup_delivery_json,'$.terminalAdmission.attestationEventId') IS json_extract(backup_delivery_json,'$.current.attestationEventId')
  ))
)),
    outcomes_json TEXT NOT NULL CHECK (length(CAST(outcomes_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(outcomes_json) AND json_type(outcomes_json) = 'array'),
    destinations_json TEXT NOT NULL CHECK (length(CAST(destinations_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(destinations_json) AND json_type(destinations_json) = 'object'),
    chosen_outcome TEXT CHECK (chosen_outcome IS NULL OR length(CAST(chosen_outcome AS BLOB)) BETWEEN 1 AND 191),
    relay_published INTEGER NOT NULL DEFAULT 0 CHECK (relay_published IN (0, 1)),
    explanation_relay_published INTEGER NOT NULL DEFAULT 0 CHECK (explanation_relay_published IN (0, 1)),
    publication_json TEXT CHECK (publication_json IS NULL OR (length(CAST(publication_json AS BLOB)) BETWEEN 1 AND 65535 AND json_valid(publication_json) AND json_type(publication_json) = 'object')),
    explanation_draft TEXT CHECK (explanation_draft IS NULL OR length(CAST(explanation_draft AS BLOB)) BETWEEN 1 AND 4096),
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
  ) STRICT;
CREATE TABLE profile_schema_marker (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    schema_name TEXT NOT NULL CHECK (schema_name = 'bitcaster-daemon-profile'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 16),
    initialized_at_ms INTEGER NOT NULL CHECK (initialized_at_ms >= 0)
  ) STRICT;
INSERT INTO "profile_schema_marker" ("singleton", "schema_name", "schema_version", "initialized_at_ms") VALUES (1, 'bitcaster-daemon-profile', 16, 1762000000000);
CREATE TABLE daemon_profile (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    nostr_public_key_hex TEXT NOT NULL CHECK (
      length(nostr_public_key_hex) = 64
      AND nostr_public_key_hex NOT GLOB '*[^0-9a-f]*'
    ),
    wallet_scope_id TEXT NOT NULL UNIQUE REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT CHECK (
      length(wallet_scope_id) = 79
      AND substr(wallet_scope_id, 1, 15) = 'custody:wallet:'
      AND substr(wallet_scope_id, 16) NOT GLOB '*[^0-9a-f]*'
    ),
    initialized_at_ms INTEGER NOT NULL CHECK (initialized_at_ms >= 0),
    signer_enabled INTEGER NOT NULL DEFAULT 1 CHECK (signer_enabled IN (0, 1)),
    signer_revision INTEGER NOT NULL DEFAULT 0 CHECK (signer_revision BETWEEN 0 AND 9007199254740991),
    UNIQUE (wallet_scope_id, nostr_public_key_hex)
  ) STRICT;
INSERT INTO "daemon_profile" ("singleton", "nostr_public_key_hex", "wallet_scope_id", "initialized_at_ms", "signer_enabled", "signer_revision") VALUES (1, '6776bee20c9bf74c421e703c23a132f6dbdf6c882c7f6634b128e66820139db1', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 1762000000000, 1, 0);
CREATE TABLE daemon_secret_authority (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    wallet_scope_id TEXT NOT NULL UNIQUE,
    nostr_public_key_hex TEXT NOT NULL CHECK (
      length(nostr_public_key_hex) = 64
      AND nostr_public_key_hex NOT GLOB '*[^0-9a-f]*'
    ),
    protection TEXT NOT NULL CHECK (protection IN ('owner-only-plaintext', 'scrypt-aes-256-gcm')),
    kdf TEXT CHECK (kdf IS NULL OR kdf = 'scrypt-v1'),
    salt BLOB CHECK (salt IS NULL OR length(salt) = 16),
    iv BLOB CHECK (iv IS NULL OR length(iv) = 12),
    auth_tag BLOB CHECK (auth_tag IS NULL OR length(auth_tag) = 16),
    secret_body BLOB NOT NULL CHECK (length(secret_body) BETWEEN 1 AND 4096),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (
      (protection = 'owner-only-plaintext'
        AND kdf IS NULL AND salt IS NULL AND iv IS NULL AND auth_tag IS NULL)
      OR
      (protection = 'scrypt-aes-256-gcm'
        AND kdf = 'scrypt-v1'
        AND salt IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)
    ),
    FOREIGN KEY (wallet_scope_id, nostr_public_key_hex)
      REFERENCES daemon_profile(wallet_scope_id, nostr_public_key_hex)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
INSERT INTO "daemon_secret_authority" ("singleton", "wallet_scope_id", "nostr_public_key_hex", "protection", "kdf", "salt", "iv", "auth_tag", "secret_body", "created_at_ms") VALUES (1, 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', '6776bee20c9bf74c421e703c23a132f6dbdf6c882c7f6634b128e66820139db1', 'owner-only-plaintext', NULL, NULL, NULL, NULL, X'7b2276657273696f6e223a322c2277616c6c657453656564486578223a223561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561356135613561222c226e6f7374725365637265744b6579486578223a2233633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363336333633363222c226e61746976654f7261636c654e6f6e636553656564486578223a2237643764376437643764376437643764376437643764376437643764376437643764376437643764376437643764376437643764376437643764376437643764227d', 1762000000000);
CREATE TABLE daemon_rpc_token (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    token TEXT NOT NULL CHECK (
      length(token) = 43
      AND token NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT;
INSERT INTO "daemon_rpc_token" ("singleton", "token", "created_at_ms") VALUES (1, 'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT', 1762000000000);
CREATE TABLE custody_scopes (
    scope_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(scope_id) = 79
      AND substr(scope_id, 1, 15) = 'custody:wallet:'
      AND substr(scope_id, 16) NOT GLOB '*[^0-9a-f]*'
    ),
    scope_kind TEXT NOT NULL CHECK (scope_kind = 'wallet'),
    wallet_id TEXT NOT NULL UNIQUE CHECK (
      length(wallet_id) = 64 AND wallet_id NOT GLOB '*[^0-9a-f]*'
    ),
    wallet_seed_digest TEXT NOT NULL UNIQUE CHECK (
      length(wallet_seed_digest) = 64
      AND wallet_seed_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (scope_id = 'custody:wallet:' || wallet_id)
  ) STRICT;
INSERT INTO "custody_scopes" ("scope_id", "scope_kind", "wallet_id", "wallet_seed_digest", "created_at_ms") VALUES ('custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'wallet', 'd838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'cc7321cce5e4409bd8077d58422e1214969059bbd40b4eeb0de0a642f40f7282', 1762000000000);
CREATE TABLE custody_scope_state (
    scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
    owner_incarnation_id TEXT CHECK (
      owner_incarnation_id IS NULL OR length(owner_incarnation_id) BETWEEN 16 AND 256
    ),
    lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    high_water_mark_ms INTEGER NOT NULL CHECK (high_water_mark_ms >= 0),
    CHECK (
      (owner_incarnation_id IS NULL AND lease_expires_at_ms IS NULL)
      OR
      (owner_incarnation_id IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    )
  ) STRICT;
INSERT INTO "custody_scope_state" ("scope_id", "fencing_epoch", "owner_incarnation_id", "lease_expires_at_ms", "high_water_mark_ms") VALUES ('custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 1, 'incarnation-release4', 1762000060001, 1762000000002);
CREATE TABLE target_state_metadata (
    scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1)
  ) STRICT;
INSERT INTO "target_state_metadata" ("scope_id", "schema_version") VALUES ('custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 1);
CREATE TABLE daemon_managed_condition_inventory (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    condition_id TEXT NOT NULL CHECK (
      length(condition_id) = 64 AND condition_id NOT GLOB '*[^0-9a-f]*'
    ),
    parent_collection_id TEXT NOT NULL CHECK (
      parent_collection_id = '' OR (
        length(parent_collection_id) = 64
        AND parent_collection_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
    state TEXT NOT NULL CHECK (state IN ('retiring', 'retired')),
    revision INTEGER NOT NULL CHECK (revision IN (1, 2)),
    condition_identity TEXT NOT NULL CHECK (
      length(condition_identity) = 64 AND condition_identity NOT GLOB '*[^0-9a-f]*'
    ),
    announcement_identities BLOB NOT NULL CHECK (
      length(announcement_identities) BETWEEN 3 AND 16384
    ),
    attestation_identity TEXT NOT NULL CHECK (
      length(attestation_identity) = 64 AND attestation_identity NOT GLOB '*[^0-9a-f]*'
    ),
    resolved_outcome TEXT NOT NULL CHECK (length(resolved_outcome) BETWEEN 1 AND 16384),
    authority_id TEXT NOT NULL CHECK (
      length(authority_id) = 64 AND authority_id NOT GLOB '*[^0-9a-f]*'
    ),
    evidence_fingerprint TEXT NOT NULL CHECK (
      length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    oracle_witness BLOB NOT NULL CHECK (length(oracle_witness) BETWEEN 1 AND 65536),
    retirement_intent_kind TEXT NOT NULL CHECK (
      retirement_intent_kind IN ('daemon-standing-policy', 'explicit-user-command')
    ),
    retirement_intent_id TEXT NOT NULL CHECK (length(retirement_intent_id) BETWEEN 1 AND 16384),
    retirement_intent_created_at_ms INTEGER NOT NULL CHECK (
      retirement_intent_created_at_ms >= 0
    ),
    retirement_started_at_ms INTEGER NOT NULL CHECK (
      retirement_started_at_ms >= retirement_intent_created_at_ms
    ),
    retirement_completed_at_ms INTEGER CHECK (
      retirement_completed_at_ms IS NULL
      OR retirement_completed_at_ms >= retirement_started_at_ms
    ),
    PRIMARY KEY (scope_id, normalized_mint, unit, condition_id, parent_collection_id),
    CHECK (
      (state = 'retiring' AND revision = 1 AND retirement_completed_at_ms IS NULL)
      OR
      (state = 'retired' AND revision = 2 AND retirement_completed_at_ms IS NOT NULL)
    )
  ) STRICT;
CREATE TABLE target_wallet_proofs (
    proof_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'
    ),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (
      length(keyset_id) = 66
      AND substr(keyset_id, 1, 2) = '01'
      AND keyset_id NOT GLOB '*[^0-9a-f]*'
    ),
    amount INTEGER NOT NULL CHECK (amount > 0),
    secret TEXT NOT NULL CHECK (length(secret) BETWEEN 1 AND 16384),
    signature TEXT NOT NULL CHECK (length(signature) BETWEEN 1 AND 16384),
    proof_body BLOB NOT NULL CHECK (length(proof_body) BETWEEN 1 AND 65536),
    state TEXT NOT NULL CHECK (state IN ('available', 'reserved', 'locked')),
    reserved_by TEXT CHECK (reserved_by IS NULL OR length(reserved_by) BETWEEN 1 AND 16384),
    retired_by_operation_id TEXT,
    retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
    retired_custody_proof_id TEXT CHECK (
      retired_custody_proof_id IS NULL OR (
        length(retired_custody_proof_id) = 64
        AND retired_custody_proof_id NOT GLOB '*[^0-9a-f]*'
      )
    ),
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('sats', 'outcome')),
    condition_id TEXT CHECK (condition_id IS NULL OR length(condition_id) BETWEEN 1 AND 1024),
    outcome_set_id TEXT CHECK (outcome_set_id IS NULL OR length(outcome_set_id) BETWEEN 1 AND 1024),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, normalized_mint, secret),
    FOREIGN KEY (scope_id, retired_by_operation_id)
      REFERENCES target_proof_operations(scope_id, operation_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (retired_by_operation_id IS NULL AND retired_at_ms IS NULL AND retired_custody_proof_id IS NULL)
      OR (retired_by_operation_id IS NOT NULL AND retired_at_ms IS NOT NULL
        AND retired_custody_proof_id IS NOT NULL AND state = 'locked'
        AND asset_kind = 'outcome' AND reserved_by = retired_by_operation_id)
    ),
    CHECK (
      (state IN ('reserved', 'locked') AND reserved_by IS NOT NULL)
      OR (state = 'available' AND reserved_by IS NULL)
    ),
    CHECK (
      (asset_kind = 'sats' AND condition_id IS NULL AND outcome_set_id IS NULL)
      OR
      (asset_kind = 'outcome' AND condition_id IS NOT NULL AND outcome_set_id IS NOT NULL)
    ),
    CHECK (
      asset_kind = 'sats' OR unit = 'msat'
    )
  ) STRICT;
INSERT INTO "target_wallet_proofs" ("proof_id", "scope_id", "normalized_mint", "unit", "keyset_id", "amount", "secret", "signature", "proof_body", "state", "reserved_by", "retired_by_operation_id", "retired_at_ms", "retired_custody_proof_id", "asset_kind", "condition_id", "outcome_set_id", "base_asset", "created_at_ms", "updated_at_ms") VALUES ('6c447cdc1e0fc8a18f654a37357ad6fe57c196d1cc6a0c5f2d4edbb77a2fec55', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'https://mint.example', 'sat', '01ac16ec25a243ba9a2670a92cedc703f9d57f88e9592d891dd1d5d293518cb949', 8, 'release4-daemon-sats', '022222222222222222222222222222222222222222222222222222222222222222', X'7b226964223a22303161633136656332356132343362613961323637306139326365646337303366396435376638386539353932643839316464316435643239333531386362393439222c22616d6f756e74223a382c22736563726574223a2272656c65617365342d6461656d6f6e2d73617473222c2243223a22303232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232227d', 'available', NULL, NULL, NULL, NULL, 'sats', NULL, NULL, 'sat', 1794230408574, 1794230408574);
INSERT INTO "target_wallet_proofs" ("proof_id", "scope_id", "normalized_mint", "unit", "keyset_id", "amount", "secret", "signature", "proof_body", "state", "reserved_by", "retired_by_operation_id", "retired_at_ms", "retired_custody_proof_id", "asset_kind", "condition_id", "outcome_set_id", "base_asset", "created_at_ms", "updated_at_ms") VALUES ('f00bbe175513616206638807d06ce88e6f0a82a2a845a6bb6c0c61e9d085f03e', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'https://mint.example', 'msat', '01ac16ec25a243ba9a2670a92cedc703f9d57f88e9592d891dd1d5d293518cb949', 1000, 'release4-daemon-outcome', '022222222222222222222222222222222222222222222222222222222222222222', X'7b226964223a22303161633136656332356132343362613961323637306139326365646337303366396435376638386539353932643839316464316435643239333531386362393439222c22616d6f756e74223a313030302c22736563726574223a2272656c65617365342d6461656d6f6e2d6f7574636f6d65222c2243223a22303232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232227d', 'available', NULL, NULL, NULL, NULL, 'outcome', 'abababababababababababababababababababababababababababababababab', 'YES', 'sat', 1794230408666, 1794230408666);
CREATE TABLE target_keyset_counters (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (
      length(keyset_id) = 66
      AND substr(keyset_id, 1, 2) = '01'
      AND keyset_id NOT GLOB '*[^0-9a-f]*'
    ),
    next_counter INTEGER NOT NULL CHECK (next_counter BETWEEN 0 AND 2147483648),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (scope_id, normalized_mint, unit, keyset_id)
  ) STRICT;
CREATE TABLE target_proof_operations (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 16384),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('conditional-keyset-swap',
      'ctf-split', 'ctf-merge', 'ctf-consolidation', 'proof-consolidation', 'ctf-redeem',
      'regular-split', 'wallet-send', 'proof-split', 'swap-refund'
    )),
    purpose TEXT NOT NULL CHECK (length(purpose) <= 256),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'failed')),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    request_artifact_id TEXT NOT NULL,
    output_artifact_id TEXT NOT NULL,
    result_artifact_id TEXT,
    result_proofs_digest TEXT CHECK (
      result_proofs_digest IS NULL
      OR (
        length(result_proofs_digest) = 64
        AND result_proofs_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    input_count INTEGER NOT NULL CHECK (input_count BETWEEN 0 AND 256),
    input_amount INTEGER NOT NULL CHECK (input_amount >= 0),
    last_error TEXT CHECK (
      last_error IS NULL OR length(last_error) BETWEEN 1 AND 1024
    ),
    failure_code INTEGER CHECK (
      failure_code IS NULL OR (kind = 'ctf-redeem' AND state = 'failed' AND failure_code = 13015)
    ),
    reservation_id TEXT CHECK (
      reservation_id IS NULL OR length(reservation_id) BETWEEN 1 AND 16384
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, operation_id),
    UNIQUE (scope_id, operation_id, reservation_id, purpose),
    UNIQUE (scope_id, operation_id, reservation_id, purpose, normalized_mint),
    FOREIGN KEY (scope_id, request_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, output_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, result_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (state = 'completed' AND result_artifact_id IS NOT NULL)
      OR (state <> 'completed' AND result_artifact_id IS NULL)
    ),
    CHECK (
      (state = 'failed' AND last_error IS NOT NULL)
      OR (state <> 'failed' AND last_error IS NULL)
    ),
    CHECK (
      (kind IN ('ctf-split', 'ctf-merge')
        AND state = 'completed'
        AND result_proofs_digest IS NOT NULL)
      OR
      ((kind NOT IN ('ctf-split', 'ctf-merge') OR state <> 'completed')
        AND result_proofs_digest IS NULL)
    )
  ) STRICT;
INSERT INTO "target_proof_operations" ("operation_id", "scope_id", "kind", "purpose", "state", "normalized_mint", "request_artifact_id", "output_artifact_id", "result_artifact_id", "result_proofs_digest", "input_count", "input_amount", "last_error", "failure_code", "reservation_id", "created_at_ms", "updated_at_ms") VALUES ('release4-daemon-send', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'wallet-send', '', 'prepared', 'https://mint.example', '671141d8ad02784bf2a446556d28b4c6208e815d4c06602a1202bde5bec3b7b5', 'aed5a59b9ed8ba91720f4004b02f8103696e71a92981fb3e7133fe2cd6176ccf', NULL, NULL, 1, 8, NULL, NULL, NULL, 1794230408858, 1794230408858);
CREATE TABLE daemon_complete_set_recovery_roots (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    root_operation_id TEXT NOT NULL CHECK (length(root_operation_id) BETWEEN 1 AND 16358),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    condition_id TEXT NOT NULL CHECK (length(condition_id) BETWEEN 1 AND 1024),
    amount_msat INTEGER NOT NULL CHECK (amount_msat BETWEEN 1 AND 9007199254740991),
    regular_operation_id TEXT CHECK (length(regular_operation_id) BETWEEN 1 AND 16384),
    regular_reservation_id TEXT CHECK (length(regular_reservation_id) BETWEEN 1 AND 16384),
    regular_purpose TEXT CHECK (
      regular_purpose IS NULL OR regular_purpose = 'daemon-complete-set-regular-split'
    ),
    ctf_operation_id TEXT CHECK (length(ctf_operation_id) BETWEEN 1 AND 16384),
    ctf_reservation_id TEXT CHECK (length(ctf_reservation_id) BETWEEN 1 AND 16384),
    ctf_purpose TEXT CHECK (
      ctf_purpose IS NULL OR ctf_purpose = 'daemon-complete-set-ctf-split'
    ),
    state TEXT NOT NULL CHECK (state IN ('regular-prepared', 'ctf-handoff', 'ctf-prepared')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (scope_id, root_operation_id),
    UNIQUE (scope_id, regular_operation_id),
    UNIQUE (scope_id, ctf_operation_id),
    FOREIGN KEY (
      scope_id, regular_operation_id, regular_reservation_id, regular_purpose, normalized_mint
    ) REFERENCES target_proof_operations(
      scope_id, operation_id, reservation_id, purpose, normalized_mint
    ) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (
      scope_id, ctf_operation_id, ctf_reservation_id, ctf_purpose, normalized_mint
    ) REFERENCES target_proof_operations(
      scope_id, operation_id, reservation_id, purpose, normalized_mint
    ) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (state IN ('regular-prepared', 'ctf-handoff')
        AND regular_operation_id IS NOT NULL
        AND regular_reservation_id IS NOT NULL
        AND regular_purpose IS NOT NULL
        AND ctf_operation_id IS NULL
        AND ctf_reservation_id IS NULL
        AND ctf_purpose IS NULL)
      OR (state = 'ctf-prepared'
        AND ctf_operation_id IS NOT NULL
        AND ctf_reservation_id IS NOT NULL
        AND ctf_purpose IS NOT NULL)
    ),
    CHECK (
      (regular_operation_id IS NULL AND regular_reservation_id IS NULL AND regular_purpose IS NULL)
      OR
      (regular_operation_id IS NOT NULL AND regular_reservation_id IS NOT NULL AND regular_purpose IS NOT NULL)
    ),
    CHECK (
      (ctf_operation_id IS NULL AND ctf_reservation_id IS NULL AND ctf_purpose IS NULL)
      OR
      (ctf_operation_id IS NOT NULL AND ctf_reservation_id IS NOT NULL AND ctf_purpose IS NOT NULL)
    ),
    CHECK (
      regular_operation_id IS NULL OR regular_operation_id = root_operation_id || ':regular-split'
    ),
    CHECK (
      regular_reservation_id IS NULL
      OR regular_reservation_id = root_operation_id || ':regular-split:reservation'
    ),
    CHECK (
      ctf_operation_id IS NULL OR ctf_operation_id = root_operation_id || ':ctf-split'
    ),
    CHECK (
      ctf_reservation_id IS NULL
      OR ctf_reservation_id = root_operation_id || ':ctf-split:reservation'
    ),
    CHECK (ctf_operation_id IS NULL OR root_operation_id <> ctf_operation_id),
    CHECK (regular_operation_id IS NULL OR root_operation_id <> regular_operation_id),
    CHECK (regular_operation_id IS NULL OR regular_operation_id <> ctf_operation_id)
  ) STRICT;
CREATE TABLE daemon_ctf_range_preparations (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    range_operation_id TEXT NOT NULL CHECK (
      length(range_operation_id) BETWEEN 1 AND 16384
    ),
    source_operation_id TEXT NOT NULL CHECK (
      length(source_operation_id) BETWEEN 1 AND 16384
    ),
    authorization_id TEXT NOT NULL CHECK (
      length(authorization_id) BETWEEN 1 AND 16384
    ),
    client_order_id TEXT NOT NULL CHECK (
      length(client_order_id) BETWEEN 1 AND 1024
    ),
    order_route_id TEXT NOT NULL CHECK (length(order_route_id) BETWEEN 1 AND 1024),
    normalized_mint TEXT NOT NULL CHECK (
      length(normalized_mint) BETWEEN 1 AND 2048
    ),
    condition_id TEXT NOT NULL CHECK (length(condition_id) BETWEEN 1 AND 1024),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    token_side TEXT NOT NULL CHECK (token_side IN ('Outcome', 'Complement')),
    side TEXT NOT NULL CHECK (side IN ('Buy', 'Sell')),
    price_subunits INTEGER NOT NULL CHECK (
      price_subunits >= 1 AND price_subunits < divisibility
    ),
    amount_subunits INTEGER NOT NULL CHECK (
      amount_subunits BETWEEN 1 AND 9007199254740991
      AND amount_subunits % divisibility = 0
    ),
    minimum_fill_amount_subunits INTEGER NOT NULL CHECK (
      minimum_fill_amount_subunits BETWEEN 1 AND amount_subunits
      AND minimum_fill_amount_subunits % divisibility = 0
    ),
    consolidate_proofs INTEGER NOT NULL CHECK (consolidate_proofs IN (0, 1)),
    divisibility INTEGER NOT NULL CHECK (divisibility IN (1000, 1000000)),
    authorization_expires_at_unix_seconds INTEGER NOT NULL CHECK (
      authorization_expires_at_unix_seconds BETWEEN 1 AND 9007199254740991
    ),
    preparation_body BLOB NOT NULL CHECK (
      length(preparation_body) BETWEEN 1 AND 262144
    ),
    fee_consent_body BLOB CHECK (
      fee_consent_body IS NULL OR length(fee_consent_body) BETWEEN 1 AND 4096
    ),
    lifecycle_state TEXT NOT NULL CHECK (
      lifecycle_state IN (
        'prepared', 'capability-requested', 'capability-bound',
        'order-submitted', 'submission-rejected', 'terminal'
      )
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    capability_artifact_id TEXT CHECK (
      capability_artifact_id IS NULL OR (
        length(capability_artifact_id) = 36
        AND substr(capability_artifact_id, 9, 1) = '-'
        AND substr(capability_artifact_id, 14, 1) = '-'
        AND substr(capability_artifact_id, 19, 1) = '-'
        AND substr(capability_artifact_id, 24, 1) = '-'
        AND replace(capability_artifact_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
    capability_binding_digest TEXT CHECK (
      capability_binding_digest IS NULL OR (
        length(capability_binding_digest) = 64
        AND capability_binding_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    capability_artifact_digest TEXT CHECK (
      capability_artifact_digest IS NULL OR (
        length(capability_artifact_digest) = 64
        AND capability_artifact_digest NOT GLOB '*[^0-9a-f]*'
      )
    ),
    engine_order_id TEXT CHECK (
      engine_order_id IS NULL OR (
        length(engine_order_id) = 36
        AND substr(engine_order_id, 9, 1) = '-'
        AND substr(engine_order_id, 14, 1) = '-'
        AND substr(engine_order_id, 19, 1) = '-'
        AND substr(engine_order_id, 24, 1) = '-'
        AND replace(engine_order_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (scope_id, range_operation_id),
    UNIQUE (scope_id, source_operation_id),
    UNIQUE (scope_id, authorization_id),
    UNIQUE (scope_id, client_order_id),
    UNIQUE (scope_id, range_operation_id, source_operation_id),
    CHECK (
      trim(order_route_id, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')
        = order_route_id
      AND trim(condition_id, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')
        = condition_id
      AND instr(order_route_id, '|') = 0
      AND length(order_route_id) > length(condition_id) + 1
      AND substr(order_route_id, 1, length(condition_id) + 1) = condition_id || '-'
      AND instr(substr(order_route_id, length(condition_id) + 2), '-') = 0
    ),
    CHECK (
      (
        capability_artifact_id IS NULL
        AND capability_binding_digest IS NULL
        AND capability_artifact_digest IS NULL
        AND engine_order_id IS NULL
      )
      OR
      (
        capability_artifact_id IS NOT NULL
        AND capability_binding_digest IS NOT NULL
        AND capability_artifact_digest IS NOT NULL
        AND engine_order_id IS NOT NULL
      )
    ),
    CHECK (
      (lifecycle_state IN ('prepared', 'capability-requested')
        AND capability_artifact_id IS NULL)
      OR
      (lifecycle_state IN ('capability-bound', 'order-submitted', 'submission-rejected')
        AND capability_artifact_id IS NOT NULL)
      OR lifecycle_state = 'terminal'
    )
  ) STRICT;
CREATE TABLE daemon_ctf_range_sources (
    scope_id TEXT NOT NULL,
    range_operation_id TEXT NOT NULL CHECK (
      length(range_operation_id) BETWEEN 1 AND 16384
    ),
    source_operation_id TEXT NOT NULL CHECK (
      length(source_operation_id) BETWEEN 1 AND 16384
    ),
    reservation_id TEXT NOT NULL CHECK (
      length(reservation_id) BETWEEN 1 AND 16384
    ),
    operation_purpose TEXT NOT NULL CHECK (
      operation_purpose = 'ctf-range-authorization-source'
    ),
    PRIMARY KEY (scope_id, range_operation_id),
    UNIQUE (scope_id, source_operation_id),
    UNIQUE (scope_id, reservation_id),
    FOREIGN KEY (scope_id, range_operation_id, source_operation_id)
      REFERENCES daemon_ctf_range_preparations(
        scope_id, range_operation_id, source_operation_id
      ) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, source_operation_id, reservation_id, operation_purpose)
      REFERENCES target_proof_operations(
        scope_id, operation_id, reservation_id, purpose
      ) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE daemon_ctf_range_consolidations (
    scope_id TEXT NOT NULL,
    range_operation_id TEXT NOT NULL CHECK (
      length(range_operation_id) BETWEEN 1 AND 16384
    ),
    round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 255),
    operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 16384),
    reservation_id TEXT NOT NULL CHECK (
      length(reservation_id) BETWEEN 1 AND 16384
    ),
    operation_purpose TEXT NOT NULL CHECK (
      operation_purpose = 'ctf-range-authorization-consolidation'
    ),
    PRIMARY KEY (scope_id, range_operation_id, round),
    UNIQUE (scope_id, operation_id),
    UNIQUE (scope_id, reservation_id),
    FOREIGN KEY (scope_id, range_operation_id)
      REFERENCES daemon_ctf_range_preparations(scope_id, range_operation_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id, reservation_id, operation_purpose)
      REFERENCES target_proof_operations(
        scope_id, operation_id, reservation_id, purpose
      ) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_proofs (
    proof_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'
    ),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (
      length(keyset_id) = 66
      AND substr(keyset_id, 1, 2) = '01'
      AND keyset_id NOT GLOB '*[^0-9a-f]*'
    ),
    amount INTEGER NOT NULL CHECK (amount > 0),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    condition_id TEXT CHECK (condition_id IS NULL OR length(condition_id) BETWEEN 1 AND 1024),
    outcome_set_id TEXT CHECK (outcome_set_id IS NULL OR length(outcome_set_id) BETWEEN 1 AND 1024),
    product_binding TEXT CHECK (product_binding IS NULL OR length(product_binding) BETWEEN 1 AND 1024),
    proof_body BLOB NOT NULL CHECK (length(proof_body) BETWEEN 1 AND 65536),
    proof_fingerprint TEXT NOT NULL CHECK (
      length(proof_fingerprint) = 64
      AND proof_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    curve TEXT NOT NULL CHECK (curve = 'secp256k1'),
    signature_verified INTEGER NOT NULL CHECK (signature_verified IN (0, 1)),
    dleq_state TEXT NOT NULL CHECK (dleq_state IN ('not-present', 'verified')),
    nut07_state TEXT NOT NULL CHECK (nut07_state IN ('UNSPENT', 'PENDING', 'SPENT')),
    selectability TEXT NOT NULL CHECK (selectability IN ('selectable', 'locked', 'spent', 'retained')),
    storage_class TEXT NOT NULL CHECK (
      storage_class IN ('pinned-operation-bound-deterministic', 'terminal-replay-retained')
    ),
    reservation_operation_id TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, proof_id),
    UNIQUE (scope_id, normalized_mint, unit, keyset_id, proof_id),
    CHECK (
      (condition_id IS NULL AND outcome_set_id IS NULL)
      OR (condition_id IS NOT NULL AND outcome_set_id IS NOT NULL)
    ),
    CHECK (
      unit IN ('sat', 'msat') AND base_asset = 'sat'
    ),
    CHECK (
      (selectability = 'selectable'
        AND signature_verified = 1 AND nut07_state = 'UNSPENT')
      OR selectability <> 'selectable'
    )
  ) STRICT;
INSERT INTO "custody_proofs" ("proof_id", "scope_id", "normalized_mint", "unit", "keyset_id", "amount", "base_asset", "condition_id", "outcome_set_id", "product_binding", "proof_body", "proof_fingerprint", "curve", "signature_verified", "dleq_state", "nut07_state", "selectability", "storage_class", "reservation_operation_id", "revision", "created_at_ms", "updated_at_ms") VALUES ('c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'https://mint.example', 'sat', '01ac16ec25a243ba9a2670a92cedc703f9d57f88e9592d891dd1d5d293518cb949', 2, 'sat', NULL, NULL, NULL, X'7b2270726f6f66223a2272656c6561736534227d', 'd5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5', 'secp256k1', 1, 'not-present', 'UNSPENT', 'selectable', 'pinned-operation-bound-deterministic', NULL, 0, 1762000000002, 1762000000002);
CREATE TABLE custody_keyset_counters (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (
      length(keyset_id) = 66
      AND substr(keyset_id, 1, 2) = '01'
      AND keyset_id NOT GLOB '*[^0-9a-f]*'
    ),
    next_counter INTEGER NOT NULL CHECK (next_counter >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (scope_id, normalized_mint, unit, keyset_id)
  ) STRICT;
INSERT INTO "custody_keyset_counters" ("scope_id", "normalized_mint", "unit", "keyset_id", "next_counter", "revision", "updated_at_ms") VALUES ('custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'https://mint.example', 'sat', '01ac16ec25a243ba9a2670a92cedc703f9d57f88e9592d891dd1d5d293518cb949', 12, 0, 1762000000002);
CREATE TABLE custody_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(artifact_id) BETWEEN 1 AND 16384
      AND (
        (
          artifact_id GLOB 'artifact:custody-operation:?*:request'
          OR artifact_id GLOB 'artifact:custody-operation:?*:output'
          OR artifact_id GLOB 'artifact:custody-operation:?*:private'
          OR artifact_id GLOB 'artifact:custody-operation:?*:result'
          OR artifact_id GLOB 'artifact:custody-operation:?*:delivery'
          OR artifact_id GLOB 'artifact:custody-operation:?*:terminal-mint-rejection'
        )
        OR (
          length(artifact_id) = 64
          AND artifact_id NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
      'exact-request', 'output-plan', 'private-material', 'exact-result',
      'delivery-payload', 'outgoing-transfer', 'terminal-mint-rejection'
    )),
    encoding TEXT NOT NULL CHECK (encoding IN ('canonical-json', 'utf8', 'binary')),
    body BLOB NOT NULL CHECK (length(body) BETWEEN 1 AND 16777216),
    fingerprint TEXT NOT NULL CHECK (
      length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (revision = 0),
    private_material INTEGER NOT NULL CHECK (private_material IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (scope_id, artifact_id)
  ) STRICT;
INSERT INTO "custody_artifacts" ("artifact_id", "scope_id", "artifact_kind", "encoding", "body", "fingerprint", "revision", "private_material", "created_at_ms") VALUES ('671141d8ad02784bf2a446556d28b4c6208e815d4c06602a1202bde5bec3b7b5', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'exact-request', 'canonical-json', X'7b22696e70757473223a5b7b226964223a22303161633136656332356132343362613961323637306139326365646337303366396435376638386539353932643839316464316435643239333531386362393439222c22616d6f756e74223a382c22736563726574223a2272656c65617365342d6461656d6f6e2d73617473222c2243223a22303232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232227d5d2c226d65746164617461223a7b22736f75726365223a2272656c65617365342d66697874757265227d7d', '4b8d0cc9cd8f61263417a8f0d51ff17e5f604efbd00e2b5fb36f758d6ff2e6d0', 0, 0, 1794230408861);
INSERT INTO "custody_artifacts" ("artifact_id", "scope_id", "artifact_kind", "encoding", "body", "fingerprint", "revision", "private_material", "created_at_ms") VALUES ('aed5a59b9ed8ba91720f4004b02f8103696e71a92981fb3e7133fe2cd6176ccf', 'custody:wallet:d838805de7febb07eb958c39f06532a86049d348f037fdc6265ec36e734a48fb', 'output-plan', 'canonical-json', X'7b7d', '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 0, 0, 1794230408861);
CREATE TABLE custody_operations (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 16384),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    retained_operation_key TEXT NOT NULL CHECK (length(retained_operation_key) BETWEEN 1 AND 1024),
    semantic_kind TEXT NOT NULL CHECK (semantic_kind IN ('swap-refund', 'conditional-keyset-swap',
      'generic-receive', 'generic-send', 'wallet-send',
      'ctf-range-regular-source', 'ctf-range-conditional-source',
      'ctf-split', 'ctf-merge', 'proof-consolidation', 'ctf-redeem'
    )),
    operation_state TEXT NOT NULL CHECK (
      operation_state IN ('dispatch-intent', 'transport-attempted', 'reconciled', 'aborted')
    ),
    activity_id TEXT NOT NULL CHECK (length(activity_id) BETWEEN 1 AND 1024),
    wallet_stage TEXT NOT NULL CHECK (
      wallet_stage IN (
        'lock', 'claim', 'refund', 'receive', 'send', 'ctf-split', 'ctf-merge',
        'proof-consolidation', 'ctf-redeem', 'capability-preparation'
      )
    ),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    inventory_account_id TEXT CHECK (
      inventory_account_id IS NULL OR length(inventory_account_id) BETWEEN 1 AND 1024
    ),
    reservation_id TEXT NOT NULL CHECK (length(reservation_id) BETWEEN 1 AND 1024),
    parent_reservation_id TEXT CHECK (
      parent_reservation_id IS NULL OR length(parent_reservation_id) BETWEEN 1 AND 1024
    ),
    input_count INTEGER NOT NULL CHECK (input_count BETWEEN 0 AND 256),
    request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 16384),
    payload_handle TEXT NOT NULL CHECK (length(payload_handle) BETWEEN 1 AND 16384),
    request_method TEXT NOT NULL CHECK (
      request_method IN ('POST', 'PUT', 'PATCH', 'DELETE')
    ),
    request_path TEXT NOT NULL CHECK (length(request_path) BETWEEN 1 AND 2048),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 16384),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    request_artifact_id TEXT NOT NULL,
    output_plan_fingerprint TEXT NOT NULL CHECK (length(output_plan_fingerprint) = 64),
    output_plan_id TEXT NOT NULL CHECK (length(output_plan_id) BETWEEN 1 AND 16384),
    output_material_handle TEXT NOT NULL CHECK (
      length(output_material_handle) BETWEEN 1 AND 16384
    ),
    output_artifact_id TEXT NOT NULL,
    private_material_handle TEXT NOT NULL CHECK (
      length(private_material_handle) BETWEEN 1 AND 16384
    ),
    private_use_id TEXT NOT NULL CHECK (length(private_use_id) BETWEEN 1 AND 16384),
    private_public_fingerprint TEXT NOT NULL CHECK (
      length(private_public_fingerprint) = 64
      AND private_public_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    private_artifact_id TEXT NOT NULL,
    result_state TEXT NOT NULL CHECK (result_state IN ('none', 'verified-staged', 'applied')),
    result_handle TEXT,
    result_artifact_id TEXT,
    result_fingerprint TEXT CHECK (result_fingerprint IS NULL OR length(result_fingerprint) = 64),
    result_output_plan_fingerprint TEXT CHECK (
      result_output_plan_fingerprint IS NULL
      OR length(result_output_plan_fingerprint) = 64
    ),
    proof_storage_class TEXT NOT NULL CHECK (
      proof_storage_class IN (
        'pinned-operation-bound-deterministic', 'terminal-replay-retained'
      )
    ),
    successor_admission_mode TEXT NOT NULL CHECK (
      successor_admission_mode IN ('exact', 'subset')
    ),
    successor_selection_staged INTEGER NOT NULL CHECK (
      successor_selection_staged IN (0, 1)
    ),
    verification_output_plan_fingerprint TEXT NOT NULL CHECK (
      length(verification_output_plan_fingerprint) = 64
    ),
    verification_has_outputs INTEGER NOT NULL CHECK (
      verification_has_outputs IN (0, 1)
    ),
    transport_attempted INTEGER NOT NULL CHECK (transport_attempted IN (0, 1)),
    retry_attempt INTEGER NOT NULL CHECK (retry_attempt >= 0),
    retry_reason TEXT NOT NULL CHECK (retry_reason IN (
      'none', 'pending-or-mixed', 'mint-response-unknown',
      'rate-limited', 'reservation-race', 'storage-unavailable'
    )),
    next_attempt_at_ms INTEGER CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0),
    not_before_ms INTEGER CHECK (not_before_ms IS NULL OR not_before_ms >= 0),
    not_after_ms INTEGER CHECK (not_after_ms IS NULL OR not_after_ms >= 0),
    safety_margin_ms INTEGER NOT NULL CHECK (safety_margin_ms >= 0),
    keyset_expiry_ms INTEGER CHECK (
      keyset_expiry_ms IS NULL OR keyset_expiry_ms >= 0
    ),
    terminal_replay_evidence_required INTEGER NOT NULL CHECK (
      terminal_replay_evidence_required IN (0, 1)
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, operation_id),
    UNIQUE (scope_id, reservation_id),
    UNIQUE (scope_id, operation_id, reservation_id),
    FOREIGN KEY (scope_id, request_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, output_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, private_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, result_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (result_state = 'none'
        AND result_handle IS NULL
        AND result_artifact_id IS NULL
        AND result_fingerprint IS NULL
        AND result_output_plan_fingerprint IS NULL
        AND successor_selection_staged = 0)
      OR
      (result_state <> 'none'
        AND result_handle IS NOT NULL
        AND result_artifact_id IS NOT NULL
        AND result_fingerprint IS NOT NULL
        AND result_output_plan_fingerprint IS NOT NULL
        AND successor_selection_staged = 1)
    ),
    CHECK (verification_output_plan_fingerprint = output_plan_fingerprint),
    CHECK (
      not_before_ms IS NULL OR not_after_ms IS NULL
      OR not_before_ms <= not_after_ms
    )
  ) STRICT;
CREATE TABLE custody_operation_inputs (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    input_position INTEGER NOT NULL CHECK (input_position BETWEEN 0 AND 255),
    proof_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) = 66 AND substr(keyset_id, 1, 2) = '01' AND keyset_id NOT GLOB '*[^0-9a-f]*'),
    curve TEXT NOT NULL CHECK (curve = 'secp256k1'),
    PRIMARY KEY (scope_id, operation_id, input_position),
    UNIQUE (scope_id, operation_id, proof_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, proof_id)
      REFERENCES custody_proofs(scope_id, proof_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_proof_reservations (
    scope_id TEXT NOT NULL,
    proof_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    input_position INTEGER NOT NULL CHECK (input_position BETWEEN 0 AND 255),
    PRIMARY KEY (scope_id, proof_id),
    UNIQUE (scope_id, operation_id, input_position),
    FOREIGN KEY (scope_id, operation_id, reservation_id)
      REFERENCES custody_operations(scope_id, operation_id, reservation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id, proof_id)
      REFERENCES custody_operation_inputs(scope_id, operation_id, proof_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_operation_artifact_links (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    link_kind TEXT NOT NULL CHECK (link_kind IN ('request', 'output', 'private', 'result', 'terminal-mint-rejection')),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 511),
    artifact_id TEXT NOT NULL,
    PRIMARY KEY (scope_id, operation_id, link_kind, position),
    UNIQUE (scope_id, operation_id, artifact_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_verification_bindings (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) = 66 AND substr(keyset_id, 1, 2) = '01' AND keyset_id NOT GLOB '*[^0-9a-f]*'),
    curve TEXT NOT NULL CHECK (curve = 'secp256k1'),
    keyset_fingerprint TEXT NOT NULL CHECK (length(keyset_fingerprint) = 64),
    require_dleq INTEGER NOT NULL CHECK (require_dleq IN (0, 1)),
    binding_position INTEGER NOT NULL CHECK (binding_position BETWEEN 0 AND 255),
    PRIMARY KEY (scope_id, operation_id, keyset_id, curve),
    UNIQUE (scope_id, operation_id, binding_position),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_verification_keyset_uses (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    use_kind TEXT NOT NULL CHECK (use_kind IN ('input', 'output')),
    use_position INTEGER NOT NULL CHECK (use_position BETWEEN 0 AND 255),
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) = 66 AND substr(keyset_id, 1, 2) = '01' AND keyset_id NOT GLOB '*[^0-9a-f]*'),
    curve TEXT NOT NULL CHECK (curve = 'secp256k1'),
    PRIMARY KEY (scope_id, operation_id, use_kind, use_position),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id, keyset_id, curve)
      REFERENCES custody_verification_bindings(
        scope_id, operation_id, keyset_id, curve
      ) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_operation_pins (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    pin_reason TEXT NOT NULL CHECK (pin_reason IN (
      'active-reservation', 'pending-outbox', 'active-retry-cursor', 'replay-tombstone'
    )),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (scope_id, operation_id, pin_reason),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_proof_lineage (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    lineage_kind TEXT NOT NULL CHECK (
      lineage_kind IN ('predecessor', 'successor')
    ),
    lineage_position INTEGER NOT NULL CHECK (lineage_position BETWEEN 0 AND 511),
    proof_id TEXT NOT NULL,
    PRIMARY KEY (scope_id, operation_id, lineage_kind, lineage_position),
    UNIQUE (scope_id, operation_id, lineage_kind, proof_id),
    UNIQUE (scope_id, operation_id, proof_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_selected_successors (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    proof_position INTEGER NOT NULL CHECK (proof_position BETWEEN 0 AND 511),
    proof_id TEXT NOT NULL,
    PRIMARY KEY (scope_id, operation_id, proof_position),
    UNIQUE (scope_id, operation_id, proof_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id, proof_id)
      REFERENCES custody_proof_lineage(scope_id, operation_id, proof_id)
      ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_successor_admissions (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    admission_id TEXT NOT NULL CHECK (length(admission_id) BETWEEN 1 AND 16384),
    PRIMARY KEY (scope_id, operation_id),
    UNIQUE (scope_id, admission_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_successor_admission_proofs (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    proof_position INTEGER NOT NULL CHECK (proof_position BETWEEN 0 AND 511),
    proof_id TEXT NOT NULL,
    expected_revision INTEGER CHECK (
      expected_revision IS NULL OR expected_revision >= 0
    ),
    admitted_revision INTEGER NOT NULL CHECK (admitted_revision >= 0),
    PRIMARY KEY (scope_id, operation_id, proof_position),
    UNIQUE (scope_id, operation_id, proof_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_successor_admissions(scope_id, operation_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, proof_id)
      REFERENCES custody_proofs(scope_id, proof_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id, proof_id)
      REFERENCES custody_proof_lineage(scope_id, operation_id, proof_id)
      ON DELETE RESTRICT,
    CHECK (admitted_revision = coalesce(expected_revision, 0))
  ) STRICT;
CREATE TABLE custody_position_claim_links (
    scope_id TEXT NOT NULL,
    target_operation_id TEXT NOT NULL,
    custody_operation_id TEXT NOT NULL,
    PRIMARY KEY (scope_id, target_operation_id),
    UNIQUE (scope_id, custody_operation_id),
    FOREIGN KEY (scope_id, target_operation_id)
      REFERENCES target_proof_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, custody_operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_terminal_mint_rejections (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    code INTEGER NOT NULL CHECK (code = 13015),
    predecessor_disposition TEXT NOT NULL CHECK (predecessor_disposition = 'retain'),
    rejection_handle TEXT NOT NULL CHECK (length(rejection_handle) BETWEEN 1 AND 16384),
    rejection_fingerprint TEXT NOT NULL CHECK (
      length(rejection_fingerprint) = 64 AND rejection_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    rejection_artifact_id TEXT NOT NULL,
    CHECK (rejection_artifact_id = 'artifact:' || operation_id || ':terminal-mint-rejection'),
    PRIMARY KEY (scope_id, operation_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, rejection_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
CREATE TABLE custody_operation_tombstones (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    tombstone_id TEXT NOT NULL CHECK (length(tombstone_id) BETWEEN 1 AND 16384),
    terminal_authority_id TEXT NOT NULL CHECK (
      length(terminal_authority_id) BETWEEN 1 AND 16384
    ),
    authenticated_terminal_status INTEGER NOT NULL CHECK (
      authenticated_terminal_status IN (0, 1)
    ),
    replay_cutoff_observed INTEGER NOT NULL CHECK (
      replay_cutoff_observed IN (0, 1)
    ),
    PRIMARY KEY (scope_id, operation_id),
    UNIQUE (scope_id, tombstone_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_deliveries (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 1024),
    delivery_kind TEXT NOT NULL CHECK (delivery_kind = 'outbox'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'expired')),
    payload_artifact_id TEXT NOT NULL,
    expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
    receipt_id TEXT,
    receipt_fingerprint TEXT,
    acknowledged_at_ms INTEGER,
    PRIMARY KEY (scope_id, operation_id, delivery_id),
    UNIQUE (scope_id, delivery_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, payload_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    CHECK (
      (state = 'acknowledged'
        AND receipt_id IS NOT NULL
        AND receipt_fingerprint IS NOT NULL
        AND acknowledged_at_ms IS NOT NULL)
      OR
      (state <> 'acknowledged'
        AND receipt_id IS NULL
        AND receipt_fingerprint IS NULL
        AND acknowledged_at_ms IS NULL)
    )
  ) STRICT;
CREATE TABLE custody_active_work (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
    estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes BETWEEN 1 AND 4194304),
    PRIMARY KEY (scope_id, operation_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_wallet_receive_active_work (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
    estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes BETWEEN 1 AND 4194304),
    PRIMARY KEY (scope_id, operation_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE custody_wallet_receive_recovery_cursors (
    scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE CASCADE,
    cursor TEXT CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 4096)
  ) STRICT;
CREATE TABLE daemon_orders (
    order_id TEXT PRIMARY KEY NOT NULL CHECK (length(order_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    market_id TEXT NOT NULL CHECK (length(market_id) BETWEEN 1 AND 1024),
    token_side TEXT CHECK (token_side IN ('Outcome', 'Complement')),
    side TEXT CHECK (side IN ('Buy', 'Sell')),
    price_subunits INTEGER CHECK (price_subunits >= 0),
    amount_subunits INTEGER CHECK (amount_subunits >= 0),
    status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 256),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    client_order_id TEXT,
    preflight_reservation_id TEXT,
    preflight_condition_id TEXT,
    preflight_keep_outcome_set_id TEXT,
    preflight_lock_outcome_set_id TEXT,
    preflight_amount_subunits INTEGER CHECK (preflight_amount_subunits > 0),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    divisibility INTEGER NOT NULL CHECK (divisibility IN (1000, 1000000)),
    engine_status_present INTEGER NOT NULL CHECK (engine_status_present IN (0, 1)),
    engine_status_body BLOB CHECK (
      engine_status_body IS NULL OR length(engine_status_body) <= 65536
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, order_id),
    UNIQUE (scope_id, client_order_id),
    CHECK (
      (preflight_reservation_id IS NULL
        AND preflight_condition_id IS NULL
        AND preflight_keep_outcome_set_id IS NULL
        AND preflight_lock_outcome_set_id IS NULL
        AND preflight_amount_subunits IS NULL)
      OR
      (preflight_reservation_id IS NOT NULL
        AND preflight_condition_id IS NOT NULL
        AND preflight_keep_outcome_set_id IS NOT NULL
        AND preflight_lock_outcome_set_id IS NOT NULL
        AND preflight_amount_subunits IS NOT NULL)
    ),
    CHECK (
      (engine_status_present = 0 AND engine_status_body IS NULL)
      OR (engine_status_present = 1 AND engine_status_body IS NOT NULL)
    )
  ) STRICT;
CREATE TABLE order_collateral_pins (
    scope_id TEXT NOT NULL,
    pin_id TEXT NOT NULL CHECK (length(pin_id) BETWEEN 1 AND 1024),
    order_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    pin_state TEXT NOT NULL CHECK (pin_state IN ('active', 'released', 'consumed')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (scope_id, pin_id),
    FOREIGN KEY (scope_id, order_id)
      REFERENCES daemon_orders(scope_id, order_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE order_collateral_proofs (
    scope_id TEXT NOT NULL,
    pin_id TEXT NOT NULL,
    proof_position INTEGER NOT NULL CHECK (proof_position BETWEEN 0 AND 255),
    proof_id TEXT NOT NULL,
    PRIMARY KEY (scope_id, pin_id, proof_position),
    UNIQUE (scope_id, pin_id, proof_id),
    FOREIGN KEY (scope_id, pin_id)
      REFERENCES order_collateral_pins(scope_id, pin_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, proof_id)
      REFERENCES custody_proofs(scope_id, proof_id) ON DELETE RESTRICT
  ) STRICT;
CREATE TABLE seed_recovery_jobs (
    recovery_id TEXT PRIMARY KEY NOT NULL CHECK (length(recovery_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    invocation_id TEXT NOT NULL UNIQUE CHECK (length(invocation_id) BETWEEN 1 AND 1024),
    disclosure_acknowledged INTEGER NOT NULL CHECK (disclosure_acknowledged = 1),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    scan_policy_version INTEGER NOT NULL CHECK (scan_policy_version = 1),
    scan_scope TEXT NOT NULL CHECK (scan_scope IN ('regular-msat', 'condition')),
    condition_selector TEXT NOT NULL CHECK (
      (scan_scope = 'regular-msat' AND condition_selector = '') OR
      (scan_scope = 'condition' AND length(condition_selector) = 64 AND condition_selector NOT GLOB '*[^0-9a-f]*')
    ),
    gap_limit INTEGER NOT NULL CHECK (gap_limit BETWEEN 1 AND 2147483648),
    discovery_state TEXT NOT NULL CHECK (discovery_state IN ('pending', 'complete')),
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    scan_offset INTEGER NOT NULL CHECK (scan_offset BETWEEN 0 AND 2047),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    imported_proofs INTEGER NOT NULL CHECK (imported_proofs >= 0),
    ignored_spent_proofs INTEGER NOT NULL CHECK (ignored_spent_proofs >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (recovery_id, scan_policy_version, scan_scope, condition_selector, gap_limit),
    CHECK (state <> 'completed' OR discovery_state = 'complete')
  ) STRICT;
CREATE TABLE seed_recovery_keysets (
    recovery_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) = 66 AND substr(keyset_id, 1, 2) = '01' AND keyset_id NOT GLOB '*[^0-9a-f]*'),
    scan_policy_version INTEGER NOT NULL CHECK (scan_policy_version = 1),
    scan_scope TEXT NOT NULL CHECK (scan_scope IN ('regular-msat', 'condition')),
    condition_selector TEXT NOT NULL CHECK (
      (scan_scope = 'regular-msat' AND condition_selector = '') OR
      (scan_scope = 'condition' AND length(condition_selector) = 64 AND condition_selector NOT GLOB '*[^0-9a-f]*')
    ),
    gap_limit INTEGER NOT NULL CHECK (gap_limit BETWEEN 1 AND 2147483648),
    stop_reason TEXT CHECK (stop_reason IN ('gap-limit', 'counter-exhausted')),
    next_counter INTEGER NOT NULL CHECK (next_counter BETWEEN 0 AND 2147483648),
    trailing_empty_counters INTEGER NOT NULL CHECK (
      trailing_empty_counters BETWEEN 0 AND 9007199254740991
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    PRIMARY KEY (recovery_id, keyset_id),
    FOREIGN KEY (recovery_id, scan_policy_version, scan_scope, condition_selector, gap_limit)
      REFERENCES seed_recovery_jobs(recovery_id, scan_policy_version, scan_scope, condition_selector, gap_limit) ON DELETE RESTRICT,
    CHECK (
      (state = 'active' AND stop_reason IS NULL AND next_counter < 2147483648)
      OR (state = 'completed' AND stop_reason IS NOT NULL AND ((stop_reason = 'gap-limit' AND trailing_empty_counters >= gap_limit AND next_counter < 2147483648)
        OR (stop_reason = 'counter-exhausted' AND next_counter = 2147483648)))
    )
  ) STRICT;
CREATE TABLE daemon_outgoing_cashu_transfers (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    transfer_id TEXT NOT NULL CHECK (length(transfer_id) BETWEEN 1 AND 16384),
    custody_operation_id TEXT NOT NULL CHECK (length(custody_operation_id) BETWEEN 1 AND 16384),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    requested_amount TEXT NOT NULL CHECK (
      length(requested_amount) BETWEEN 1 AND 16
      AND requested_amount NOT GLOB '*[^0-9]*'
      AND requested_amount <> '0'
      AND substr(requested_amount, 1, 1) <> '0'
      AND (
        length(requested_amount) < 16
        OR requested_amount <= '9007199254740991'
      )
    ),
    delivery_state TEXT NOT NULL CHECK (delivery_state IN (
      'prepared', 'delivery-pending', 'recipient-acknowledged', 'bearer-spent',
      'bearer-partial', 'reclaim-prepared', 'reclaimed'
    )),
    delivery_policy TEXT NOT NULL CHECK (delivery_policy IN (
      'durable-recipient-ack', 'bearer-spend-classification'
    )),
    recipient_binding TEXT CHECK (
      recipient_binding IS NULL OR (
        length(recipient_binding) = 64 AND recipient_binding NOT GLOB '*[^0-9a-f]*'
      )
    ),
    funding_sequence INTEGER NOT NULL DEFAULT 0 CHECK (funding_sequence IN (0, 1)),
    funding_predecessor_transfer_id TEXT CHECK (
      funding_predecessor_transfer_id IS NULL
      OR length(funding_predecessor_transfer_id) BETWEEN 1 AND 16384
    ),
    due_at_ms INTEGER NOT NULL CHECK (due_at_ms BETWEEN 0 AND 9007199254740991),
    attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    transfer_artifact_id TEXT NOT NULL CHECK (
      length(transfer_artifact_id) = 64
      AND transfer_artifact_id NOT GLOB '*[^0-9a-f]*'
    ),
    transfer_fingerprint TEXT NOT NULL CHECK (
      length(transfer_fingerprint) = 64 AND transfer_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    PRIMARY KEY (scope_id, transfer_id),
    UNIQUE (scope_id, custody_operation_id),
    FOREIGN KEY (scope_id, custody_operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, transfer_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (scope_id, funding_predecessor_transfer_id)
      REFERENCES daemon_outgoing_cashu_transfers(scope_id, transfer_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (
      (delivery_state IN ('prepared', 'delivery-pending', 'bearer-partial', 'reclaim-prepared')
        AND due_at_ms >= 0)
      OR delivery_state IN ('recipient-acknowledged', 'bearer-spent', 'reclaimed')
    ),
    CHECK (
      (delivery_policy = 'durable-recipient-ack'
        AND recipient_binding IS NOT NULL
        AND delivery_state IN ('prepared', 'delivery-pending', 'recipient-acknowledged'))
      OR (
        delivery_policy = 'bearer-spend-classification'
        AND recipient_binding IS NULL
        AND delivery_state IN (
          'prepared', 'delivery-pending', 'bearer-spent', 'bearer-partial',
          'reclaim-prepared', 'reclaimed'
        )
      )
    ),
    CHECK (
      (funding_sequence = 0 AND funding_predecessor_transfer_id IS NULL)
      OR (funding_sequence = 1 AND delivery_policy = 'durable-recipient-ack')
    )
  ) STRICT;
CREATE TABLE daemon_market_funding_heads (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    recipient_binding TEXT NOT NULL CHECK (
      length(recipient_binding) = 64 AND recipient_binding NOT GLOB '*[^0-9a-f]*'
    ),
    transfer_id TEXT NOT NULL CHECK (length(transfer_id) BETWEEN 1 AND 16384),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    account_subject TEXT NOT NULL CHECK (
      length(account_subject) BETWEEN 1 AND 256
      AND account_subject NOT GLOB '*[^ -~]*'
    ),
    condition_id TEXT NOT NULL CHECK (
      length(condition_id) BETWEEN 1 AND 128 AND condition_id NOT GLOB '*[^0-9a-f]*'
    ),
    divisibility INTEGER NOT NULL CHECK (divisibility IN (1000, 1000000)),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    PRIMARY KEY (scope_id, recipient_binding),
    FOREIGN KEY (scope_id, transfer_id)
      REFERENCES daemon_outgoing_cashu_transfers(scope_id, transfer_id) ON DELETE RESTRICT
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
CREATE TABLE daemon_participation_score_delivery_pointers (
    scope_id TEXT PRIMARY KEY REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    transfer_id TEXT NOT NULL CHECK (length(transfer_id) BETWEEN 1 AND 16384),
    amount_msat INTEGER NOT NULL CHECK (
      amount_msat BETWEEN 1 AND 9007199254740991
      AND amount_msat % 1000 = 0
    ),
    purchased_total_epoch INTEGER NOT NULL CHECK (
      purchased_total_epoch BETWEEN 0 AND 9007199254740991
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
  ) STRICT;
CREATE TABLE daemon_bolt11_mint_quotes (
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
      length(CAST(requested_amount AS BLOB)) BETWEEN 1 AND 16384
      AND substr(requested_amount, 1, 1) GLOB '[1-9]'
      AND requested_amount NOT GLOB '*[^0-9]*'
    ),
    quote_id TEXT NOT NULL CHECK (
      length(CAST(quote_id AS BLOB)) BETWEEN 1 AND 16384
    ),
    invoice_request TEXT NOT NULL CHECK (
      length(CAST(invoice_request AS BLOB)) BETWEEN 1 AND 16384
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
  ) STRICT;
CREATE TABLE wallet_proof_import_roots (
    root_id TEXT PRIMARY KEY NOT NULL CHECK (length(root_id) BETWEEN 1 AND 256),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    condition_id TEXT NOT NULL CHECK (length(condition_id) BETWEEN 1 AND 1024),
    outcome_set_id TEXT NOT NULL CHECK (length(outcome_set_id) BETWEEN 1 AND 1024),
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
    proof_count INTEGER NOT NULL CHECK (proof_count BETWEEN 1 AND 65536),
    page_count INTEGER NOT NULL CHECK (page_count = (proof_count + 31) / 32),
    source_body BLOB NOT NULL CHECK (length(source_body) BETWEEN 1 AND 16777216),
    state TEXT NOT NULL CHECK (state IN ('active', 'complete')),
    UNIQUE (scope_id, root_id)
  ) STRICT;
CREATE TABLE wallet_proof_import_pages (
    scope_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index BETWEEN 0 AND 2047),
    proof_count INTEGER NOT NULL CHECK (proof_count BETWEEN 1 AND 32),
    expected_operation_id TEXT NOT NULL CHECK (length(expected_operation_id) BETWEEN 1 AND 16384),
    bound_operation_id TEXT CHECK (bound_operation_id IS NULL OR bound_operation_id = expected_operation_id),
    PRIMARY KEY (scope_id, root_id, page_index),
    UNIQUE (scope_id, expected_operation_id),
    FOREIGN KEY (scope_id, root_id) REFERENCES wallet_proof_import_roots(scope_id, root_id),
    FOREIGN KEY (scope_id, bound_operation_id) REFERENCES custody_operations(scope_id, operation_id)
  ) STRICT;
CREATE TABLE wallet_proof_import_recovery_cursors (
    scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id),
    root_id TEXT,
    FOREIGN KEY (scope_id, root_id) REFERENCES wallet_proof_import_roots(scope_id, root_id)
  ) STRICT;
CREATE TABLE native_payment_requests (
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
  ) STRICT;
CREATE TABLE native_payment_request_receipts (
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
  ) STRICT;
CREATE TABLE native_payment_request_receipt_groups (
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
  ) STRICT;
CREATE TABLE daemon_activity_feed_meta (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    instance_id TEXT NOT NULL CHECK (
      length(instance_id) = 36
      AND substr(instance_id, 9, 1) = '-'
      AND substr(instance_id, 14, 1) = '-'
      AND substr(instance_id, 19, 1) = '-'
      AND substr(instance_id, 24, 1) = '-'
      AND replace(instance_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  ) STRICT;
INSERT INTO "daemon_activity_feed_meta" ("singleton", "instance_id") VALUES (1, '2a005bcb-224c-48fe-841c-562cf0bd90a0');
CREATE TABLE daemon_activity_feed (
    sequence INTEGER PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    activity_id TEXT NOT NULL CHECK (length(CAST(activity_id AS BLOB)) BETWEEN 1 AND 1024),
    origin TEXT NOT NULL CHECK (origin IN ('native', 'relay')),
    source_id TEXT NOT NULL CHECK (length(CAST(source_id AS BLOB)) BETWEEN 1 AND 1024),
    item_json TEXT NOT NULL CHECK (
      length(CAST(item_json AS BLOB)) BETWEEN 1 AND 16384
      AND json_valid(item_json)
      AND json_type(item_json) = 'object'
    ),
    UNIQUE (scope_id, activity_id)
  ) STRICT;
CREATE TRIGGER oracle_nonce_allocator_no_lowering
    BEFORE UPDATE ON daemon_oracle_nonce_allocator
    WHEN NEW.singleton != OLD.singleton OR NEW.next_nonce_index < OLD.next_nonce_index
    BEGIN SELECT RAISE(ABORT, 'oracle nonce allocator cannot move backwards'); END;
CREATE TRIGGER oracle_nonce_allocator_no_delete
    BEFORE DELETE ON daemon_oracle_nonce_allocator
    BEGIN SELECT RAISE(ABORT, 'oracle nonce allocator cannot be deleted'); END;
CREATE TRIGGER oracle_creation_no_rebind
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
    BEGIN SELECT RAISE(ABORT, 'oracle creation is immutable after commitment'); END;
CREATE TRIGGER oracle_creation_no_delete
    BEFORE DELETE ON daemon_oracle_creations
    BEGIN SELECT RAISE(ABORT, 'oracle creation cannot be deleted'); END;
CREATE TRIGGER oracle_import_no_rebind BEFORE UPDATE ON daemon_oracle_imports
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
    BEGIN SELECT RAISE(ABORT, 'oracle import is immutable after commitment'); END;
CREATE TRIGGER oracle_import_no_delete BEFORE DELETE ON daemon_oracle_imports
    BEGIN SELECT RAISE(ABORT, 'oracle import cannot be deleted'); END;
CREATE TRIGGER oracle_import_no_created_collision BEFORE INSERT ON daemon_oracle_imports
    WHEN EXISTS (SELECT 1 FROM daemon_oracle_creations WHERE condition_id = NEW.condition_id OR event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'oracle authority conflicts'); END;
CREATE TRIGGER oracle_creation_no_import_collision BEFORE INSERT ON daemon_oracle_creations
    WHEN EXISTS (SELECT 1 FROM daemon_oracle_imports WHERE event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'oracle authority conflicts'); END;
CREATE TRIGGER oracle_creation_announcement_no_import_collision BEFORE UPDATE OF condition_id ON daemon_oracle_creations
    WHEN EXISTS (SELECT 1 FROM daemon_oracle_imports WHERE condition_id = NEW.condition_id)
    BEGIN SELECT RAISE(ABORT, 'oracle authority conflicts'); END;
CREATE TRIGGER daemon_oracle_creations_delivery_validate BEFORE UPDATE OF backup_delivery_json ON daemon_oracle_creations
      WHEN NEW.backup_delivery_json IS NOT NULL AND (
        (SELECT count(*) FROM json_each(NEW.backup_delivery_json)) != 9
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json) WHERE key NOT IN ('schemaVersion','binding','relayUrls','timestampHighWater','knownEventIds','current','deletion','terminalAdmission','terminalCommitPending'))
        OR (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.binding')) != 3
        OR (json_type(NEW.backup_delivery_json,'$.current') IS 'object' AND (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.current')) != 6)
        OR (json_type(NEW.backup_delivery_json,'$.deletion') IS 'object' AND (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.deletion')) != 3)
        OR (json_type(NEW.backup_delivery_json,'$.terminalAdmission') IS 'object' AND (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.terminalAdmission')) != 4)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.relayUrls') GROUP BY value HAVING count(*) > 1)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.knownEventIds') GROUP BY value HAVING count(*) > 1)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.current.acknowledgedRelayIndexes') GROUP BY value HAVING count(*) > 1)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') GROUP BY value HAVING count(*) > 1)
        OR json_extract(NEW.backup_delivery_json,'$.binding.oraclePubkey') IS NOT NEW.creator_public_key_hex
        OR json_extract(NEW.backup_delivery_json,'$.binding.announcementEventId') IS NOT json_extract(NEW.announcement_event_json,'$.id')
        OR (json_type(NEW.backup_delivery_json,'$.current') IS 'object' AND (
          json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.id') IS NOT json_extract(NEW.backup_delivery_json,'$.current.eventId')
          OR json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.kind') IS NOT 30078
          OR json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.pubkey') IS NOT NEW.creator_public_key_hex
          OR json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.created_at') > json_extract(NEW.backup_delivery_json,'$.timestampHighWater')))
        OR (json_extract(NEW.backup_delivery_json,'$.current.mode') IS 'terminal' AND (
          NEW.attestation_relay_published IS NOT 1
          OR json_extract(NEW.attestation_event_json,'$.id') IS NOT json_extract(NEW.backup_delivery_json,'$.current.attestationEventId')
          OR (json_extract(NEW.backup_delivery_json,'$.terminalCommitPending') IS 0 AND NOT (NEW.backup_terminal = 1))))
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.relayUrls') WHERE type != 'text' OR length(CAST(value AS BLOB)) NOT BETWEEN 1 AND 2048)
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.knownEventIds') WHERE type != 'text' OR length(value) != 64 OR value GLOB '*[^0-9a-f]*')
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.current.acknowledgedRelayIndexes') WHERE type != 'integer' OR value < 0 OR value >= json_array_length(NEW.backup_delivery_json,'$.relayUrls'))
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') WHERE type != 'integer' OR value < 0 OR value >= json_array_length(NEW.backup_delivery_json,'$.relayUrls'))
      ) BEGIN SELECT RAISE(ABORT, 'oracle backup delivery is invalid'); END;
CREATE TRIGGER daemon_oracle_creations_delivery_monotonic BEFORE UPDATE OF backup_delivery_json ON daemon_oracle_creations
      WHEN OLD.backup_delivery_json IS NOT NULL AND (
        NEW.backup_delivery_json IS NULL
        OR json_extract(NEW.backup_delivery_json,'$.timestampHighWater') < json_extract(OLD.backup_delivery_json,'$.timestampHighWater')
        OR json_extract(NEW.backup_delivery_json,'$.binding') IS NOT json_extract(OLD.backup_delivery_json,'$.binding')
        OR json_extract(NEW.backup_delivery_json,'$.relayUrls') IS NOT json_extract(OLD.backup_delivery_json,'$.relayUrls')
        OR (json_type(OLD.backup_delivery_json,'$.current') IS 'object' AND json_type(NEW.backup_delivery_json,'$.current') IS NOT 'object')
        OR (json_extract(NEW.backup_delivery_json,'$.current.eventId') IS json_extract(OLD.backup_delivery_json,'$.current.eventId') AND EXISTS (
          SELECT 1 FROM json_each(OLD.backup_delivery_json,'$.current.acknowledgedRelayIndexes') old
          WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.current.acknowledgedRelayIndexes') fresh WHERE fresh.value = old.value)))
        OR (json_type(OLD.backup_delivery_json,'$.deletion') IS 'object' AND json_type(NEW.backup_delivery_json,'$.deletion') IS 'object' AND (
          json_extract(NEW.backup_delivery_json,'$.deletion.eventJson') IS NOT json_extract(OLD.backup_delivery_json,'$.deletion.eventJson')
          OR EXISTS (SELECT 1 FROM json_each(OLD.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') old
            WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') fresh WHERE fresh.value = old.value))))
        OR (json_extract(OLD.backup_delivery_json,'$.current.mode') IS 'terminal' AND (
          json_extract(NEW.backup_delivery_json,'$.current.eventId') IS NOT json_extract(OLD.backup_delivery_json,'$.current.eventId')
          OR json_extract(NEW.backup_delivery_json,'$.terminalAdmission') IS NOT json_extract(OLD.backup_delivery_json,'$.terminalAdmission')
          OR json_extract(NEW.backup_delivery_json,'$.terminalCommitPending') > json_extract(OLD.backup_delivery_json,'$.terminalCommitPending')))
        OR (json_extract(NEW.backup_delivery_json,'$.current.mode') IS json_extract(OLD.backup_delivery_json,'$.current.mode') AND json_extract(NEW.backup_delivery_json,'$.current.eventJson') IS NOT json_extract(OLD.backup_delivery_json,'$.current.eventJson'))
      ) BEGIN SELECT RAISE(ABORT, 'oracle backup delivery cannot move backwards'); END;
CREATE TRIGGER daemon_oracle_imports_delivery_validate BEFORE UPDATE OF backup_delivery_json ON daemon_oracle_imports
      WHEN NEW.backup_delivery_json IS NOT NULL AND (
        (SELECT count(*) FROM json_each(NEW.backup_delivery_json)) != 9
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json) WHERE key NOT IN ('schemaVersion','binding','relayUrls','timestampHighWater','knownEventIds','current','deletion','terminalAdmission','terminalCommitPending'))
        OR (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.binding')) != 3
        OR (json_type(NEW.backup_delivery_json,'$.current') IS 'object' AND (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.current')) != 6)
        OR (json_type(NEW.backup_delivery_json,'$.deletion') IS 'object' AND (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.deletion')) != 3)
        OR (json_type(NEW.backup_delivery_json,'$.terminalAdmission') IS 'object' AND (SELECT count(*) FROM json_each(NEW.backup_delivery_json,'$.terminalAdmission')) != 4)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.relayUrls') GROUP BY value HAVING count(*) > 1)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.knownEventIds') GROUP BY value HAVING count(*) > 1)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.current.acknowledgedRelayIndexes') GROUP BY value HAVING count(*) > 1)
        OR EXISTS (SELECT value FROM json_each(NEW.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') GROUP BY value HAVING count(*) > 1)
        OR json_extract(NEW.backup_delivery_json,'$.binding.oraclePubkey') IS NOT NEW.oracle_pubkey
        OR json_extract(NEW.backup_delivery_json,'$.binding.announcementEventId') IS NOT json_extract(NEW.announcement_event_json,'$.id')
        OR (json_type(NEW.backup_delivery_json,'$.current') IS 'object' AND (
          json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.id') IS NOT json_extract(NEW.backup_delivery_json,'$.current.eventId')
          OR json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.kind') IS NOT 30078
          OR json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.pubkey') IS NOT NEW.oracle_pubkey
          OR json_extract(json_extract(NEW.backup_delivery_json,'$.current.eventJson'),'$.created_at') > json_extract(NEW.backup_delivery_json,'$.timestampHighWater')))
        OR (json_extract(NEW.backup_delivery_json,'$.current.mode') IS 'terminal' AND (
          NEW.relay_published IS NOT 1
          OR json_extract(json_extract(NEW.publication_json,'$.attestation.eventJson'),'$.id') IS NOT json_extract(NEW.backup_delivery_json,'$.current.attestationEventId')
          OR (json_extract(NEW.backup_delivery_json,'$.terminalCommitPending') IS 0 AND NOT (NEW.nonce_body IS NULL))))
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.relayUrls') WHERE type != 'text' OR length(CAST(value AS BLOB)) NOT BETWEEN 1 AND 2048)
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.knownEventIds') WHERE type != 'text' OR length(value) != 64 OR value GLOB '*[^0-9a-f]*')
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.current.acknowledgedRelayIndexes') WHERE type != 'integer' OR value < 0 OR value >= json_array_length(NEW.backup_delivery_json,'$.relayUrls'))
        OR EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') WHERE type != 'integer' OR value < 0 OR value >= json_array_length(NEW.backup_delivery_json,'$.relayUrls'))
      ) BEGIN SELECT RAISE(ABORT, 'oracle backup delivery is invalid'); END;
CREATE TRIGGER daemon_oracle_imports_delivery_monotonic BEFORE UPDATE OF backup_delivery_json ON daemon_oracle_imports
      WHEN OLD.backup_delivery_json IS NOT NULL AND (
        NEW.backup_delivery_json IS NULL
        OR json_extract(NEW.backup_delivery_json,'$.timestampHighWater') < json_extract(OLD.backup_delivery_json,'$.timestampHighWater')
        OR json_extract(NEW.backup_delivery_json,'$.binding') IS NOT json_extract(OLD.backup_delivery_json,'$.binding')
        OR json_extract(NEW.backup_delivery_json,'$.relayUrls') IS NOT json_extract(OLD.backup_delivery_json,'$.relayUrls')
        OR (json_type(OLD.backup_delivery_json,'$.current') IS 'object' AND json_type(NEW.backup_delivery_json,'$.current') IS NOT 'object')
        OR (json_extract(NEW.backup_delivery_json,'$.current.eventId') IS json_extract(OLD.backup_delivery_json,'$.current.eventId') AND EXISTS (
          SELECT 1 FROM json_each(OLD.backup_delivery_json,'$.current.acknowledgedRelayIndexes') old
          WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.current.acknowledgedRelayIndexes') fresh WHERE fresh.value = old.value)))
        OR (json_type(OLD.backup_delivery_json,'$.deletion') IS 'object' AND json_type(NEW.backup_delivery_json,'$.deletion') IS 'object' AND (
          json_extract(NEW.backup_delivery_json,'$.deletion.eventJson') IS NOT json_extract(OLD.backup_delivery_json,'$.deletion.eventJson')
          OR EXISTS (SELECT 1 FROM json_each(OLD.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') old
            WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.backup_delivery_json,'$.deletion.acknowledgedRelayIndexes') fresh WHERE fresh.value = old.value))))
        OR (json_extract(OLD.backup_delivery_json,'$.current.mode') IS 'terminal' AND (
          json_extract(NEW.backup_delivery_json,'$.current.eventId') IS NOT json_extract(OLD.backup_delivery_json,'$.current.eventId')
          OR json_extract(NEW.backup_delivery_json,'$.terminalAdmission') IS NOT json_extract(OLD.backup_delivery_json,'$.terminalAdmission')
          OR json_extract(NEW.backup_delivery_json,'$.terminalCommitPending') > json_extract(OLD.backup_delivery_json,'$.terminalCommitPending')))
        OR (json_extract(NEW.backup_delivery_json,'$.current.mode') IS json_extract(OLD.backup_delivery_json,'$.current.mode') AND json_extract(NEW.backup_delivery_json,'$.current.eventJson') IS NOT json_extract(OLD.backup_delivery_json,'$.current.eventJson'))
      ) BEGIN SELECT RAISE(ABORT, 'oracle backup delivery cannot move backwards'); END;
CREATE INDEX daemon_managed_condition_inventory_state_idx
    ON daemon_managed_condition_inventory(scope_id, state, condition_id);
CREATE TRIGGER custody_position_claim_links_exact_insert
    BEFORE INSERT ON custody_position_claim_links
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM target_proof_operations AS target JOIN custody_operations AS custody
          ON custody.scope_id = target.scope_id
        WHERE target.scope_id = NEW.scope_id AND target.operation_id = NEW.target_operation_id
          AND target.kind = 'ctf-redeem' AND target.purpose = 'position-claim'
          AND custody.operation_id = NEW.custody_operation_id
          AND custody.semantic_kind = 'ctf-redeem' AND custody.wallet_stage = 'ctf-redeem'
          AND custody.retained_operation_key = target.operation_id
          AND custody.reservation_id = target.reservation_id
          AND custody.normalized_mint = target.normalized_mint AND custody.unit = 'msat'
      ) THEN RAISE(ABORT, 'position claim mapping is foreign') END;
    END;
CREATE TRIGGER custody_position_claim_links_no_update
    BEFORE UPDATE ON custody_position_claim_links
    BEGIN SELECT RAISE(ABORT, 'position claim mapping is immutable'); END;
CREATE TRIGGER custody_terminal_mint_rejections_exact_insert
    BEFORE INSERT ON custody_terminal_mint_rejections
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM custody_operations WHERE scope_id = NEW.scope_id AND operation_id = NEW.operation_id
          AND semantic_kind = 'ctf-redeem' AND operation_state = 'aborted' AND result_state = 'none'
      ) THEN RAISE(ABORT, 'terminal mint rejection operation is foreign') END;
    END;
CREATE TRIGGER custody_terminal_mint_rejections_no_update
    BEFORE UPDATE ON custody_terminal_mint_rejections
    BEGIN SELECT RAISE(ABORT, 'terminal mint rejection is immutable'); END;
CREATE INDEX custody_proofs_selection_idx
    ON custody_proofs (
      scope_id, normalized_mint, unit, selectability,
      condition_id, outcome_set_id, amount DESC, proof_id
    );
CREATE INDEX custody_proofs_reservation_idx
    ON custody_proofs (scope_id, reservation_operation_id, selectability, proof_id);
CREATE INDEX target_keyset_counters_scope_keyset_mint_idx
    ON target_keyset_counters (scope_id, keyset_id, normalized_mint);
CREATE INDEX custody_keyset_counters_scope_keyset_mint_idx
    ON custody_keyset_counters (scope_id, keyset_id, normalized_mint);
CREATE INDEX target_wallet_proofs_selection_idx
    ON target_wallet_proofs (
      scope_id, normalized_mint, unit, asset_kind, condition_id, outcome_set_id,
      keyset_id, state, amount DESC, proof_id
    );
CREATE INDEX target_wallet_proofs_retired_canonical_idx
    ON target_wallet_proofs (scope_id, retired_custody_proof_id)
    WHERE retired_custody_proof_id IS NOT NULL;
CREATE INDEX target_proof_operations_pending_mint_idx
    ON target_proof_operations (scope_id, normalized_mint)
    WHERE state = 'prepared';
CREATE INDEX target_wallet_proofs_remove_idx
    ON target_wallet_proofs (scope_id, normalized_mint, condition_id, outcome_set_id, proof_id)
    WHERE retired_at_ms IS NULL;
CREATE INDEX target_wallet_proofs_holdings_idx
    ON target_wallet_proofs (
      scope_id, normalized_mint, state, base_asset, asset_kind,
      condition_id, unit, outcome_set_id, amount
    );
CREATE INDEX target_wallet_proofs_reservation_idx
    ON target_wallet_proofs (scope_id, normalized_mint, reserved_by, state, proof_id);
CREATE INDEX target_wallet_proofs_receive_amount_idx
    ON target_wallet_proofs (
      scope_id, normalized_mint, unit, asset_kind, base_asset, state, amount, proof_id
    )
    WHERE condition_id IS NULL AND outcome_set_id IS NULL;
CREATE INDEX target_proof_operations_recovery_idx
    ON target_proof_operations (
      scope_id, purpose, state, updated_at_ms, operation_id
    );
CREATE INDEX target_proof_operations_prepared_idx
    ON target_proof_operations (scope_id, state, operation_id);
CREATE INDEX daemon_complete_set_recovery_roots_active_idx
    ON daemon_complete_set_recovery_roots (scope_id, updated_at_ms, root_operation_id);
CREATE INDEX daemon_ctf_range_active_recovery_idx
    ON daemon_ctf_range_preparations (
      scope_id, updated_at_ms, range_operation_id, client_order_id
    )
    WHERE lifecycle_state <> 'terminal';
CREATE UNIQUE INDEX daemon_ctf_range_active_client_order_idx
    ON daemon_ctf_range_preparations (scope_id, client_order_id)
    WHERE lifecycle_state <> 'terminal';
CREATE INDEX daemon_orders_client_id_idx
    ON daemon_orders (scope_id, client_order_id);
CREATE INDEX custody_operations_history_idx
    ON custody_operations (scope_id, updated_at_ms DESC, operation_id DESC);
CREATE INDEX custody_operations_retry_idx
    ON custody_operations (scope_id, operation_state, next_attempt_at_ms, operation_id);
CREATE INDEX custody_operations_retained_operation_key_typed_idx
    ON custody_operations (scope_id, retained_operation_key, semantic_kind, wallet_stage);
CREATE INDEX custody_proof_reservations_scope_idx
    ON custody_proof_reservations (scope_id, proof_id);
CREATE INDEX custody_active_work_page_idx
    ON custody_active_work (scope_id, next_attempt_at_ms, operation_id);
CREATE INDEX custody_wallet_receive_active_work_page_idx
    ON custody_wallet_receive_active_work (scope_id, next_attempt_at_ms, operation_id);
CREATE INDEX custody_deliveries_pending_idx
    ON custody_deliveries (scope_id, state, expires_at_ms, delivery_id);
CREATE INDEX daemon_orders_listing_idx
    ON daemon_orders (scope_id, market_id, status, updated_at_ms DESC, order_id);
CREATE INDEX order_collateral_pins_active_idx
    ON order_collateral_pins (scope_id, pin_state, order_id, pin_id);
CREATE INDEX seed_recovery_jobs_active_idx
    ON seed_recovery_jobs (scope_id, state, updated_at_ms, recovery_id);
CREATE INDEX daemon_outgoing_cashu_transfers_due_idx
    ON daemon_outgoing_cashu_transfers (
      scope_id, normalized_mint, due_at_ms, transfer_id
    )
    WHERE delivery_state IN ('prepared', 'delivery-pending', 'bearer-partial', 'reclaim-prepared');
CREATE INDEX daemon_outgoing_cashu_transfers_all_mints_due_idx
    ON daemon_outgoing_cashu_transfers (scope_id, due_at_ms, transfer_id)
    WHERE delivery_state IN ('prepared', 'delivery-pending', 'bearer-partial', 'reclaim-prepared');
CREATE INDEX daemon_outgoing_cashu_account_recovery_idx
    ON daemon_outgoing_cashu_transfers (scope_id)
    WHERE delivery_policy = 'durable-recipient-ack'
      AND delivery_state IN ('prepared', 'delivery-pending');
CREATE UNIQUE INDEX daemon_outgoing_cashu_recipient_active_binding_idx
    ON daemon_outgoing_cashu_transfers (scope_id, recipient_binding)
    WHERE delivery_policy = 'durable-recipient-ack'
      AND funding_sequence = 0
      AND delivery_state IN ('prepared', 'delivery-pending', 'recipient-acknowledged');
CREATE UNIQUE INDEX daemon_market_funding_successor_idx
    ON daemon_outgoing_cashu_transfers (
      scope_id, recipient_binding, COALESCE(funding_predecessor_transfer_id, '')
    ) WHERE funding_sequence = 1;
CREATE TRIGGER profile_schema_marker_no_update
    BEFORE UPDATE ON profile_schema_marker
    BEGIN
      SELECT RAISE(ABORT, 'profile schema marker is immutable');
    END;
CREATE TRIGGER profile_schema_marker_no_delete
    BEFORE DELETE ON profile_schema_marker
    BEGIN
      SELECT RAISE(ABORT, 'profile schema marker is immutable');
    END;
CREATE TRIGGER custody_scope_epoch_monotonic
    BEFORE UPDATE OF fencing_epoch ON custody_scope_state
    WHEN NEW.fencing_epoch < OLD.fencing_epoch
    BEGIN
      SELECT RAISE(ABORT, 'custody fencing epoch cannot decrease');
    END;
CREATE TRIGGER target_keyset_counters_no_lowering
    BEFORE UPDATE OF next_counter ON target_keyset_counters
    WHEN NEW.next_counter < OLD.next_counter
    BEGIN
      SELECT RAISE(ABORT, 'keyset counter cannot decrease');
    END;
CREATE TRIGGER target_keyset_counters_no_rekey
    BEFORE UPDATE OF scope_id, normalized_mint, unit, keyset_id ON target_keyset_counters
    WHEN NEW.scope_id <> OLD.scope_id OR NEW.normalized_mint <> OLD.normalized_mint
      OR NEW.unit <> OLD.unit OR NEW.keyset_id <> OLD.keyset_id
    BEGIN
      SELECT RAISE(ABORT, 'keyset counter identity is immutable');
    END;
CREATE TRIGGER target_keyset_counters_no_delete
    BEFORE DELETE ON target_keyset_counters
    BEGIN
      SELECT RAISE(ABORT, 'keyset counter cannot be deleted');
    END;
CREATE TRIGGER seed_recovery_jobs_no_rebind
    BEFORE UPDATE OF recovery_id, scope_id, invocation_id, disclosure_acknowledged,
      normalized_mint, unit, scan_policy_version, scan_scope, condition_selector, gap_limit ON seed_recovery_jobs
    BEGIN
      SELECT RAISE(ABORT, 'seed recovery job identity is immutable');
    END;
CREATE TRIGGER seed_recovery_keysets_no_rekey
    BEFORE UPDATE OF recovery_id, keyset_id, scan_policy_version, scan_scope, condition_selector, gap_limit ON seed_recovery_keysets
    BEGIN
      SELECT RAISE(ABORT, 'seed recovery keyset identity is immutable');
    END;
CREATE TRIGGER daemon_bolt11_mint_quote_operation_binding_insert
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
    BEGIN SELECT RAISE(ABORT, 'BOLT11 mint quote custody operation binding conflicts'); END;
CREATE TRIGGER daemon_bolt11_mint_quote_no_rebind
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
    BEGIN SELECT RAISE(ABORT, 'BOLT11 mint quote update conflicts with immutable authority'); END;
CREATE TRIGGER daemon_bolt11_mint_quote_no_delete
    BEFORE DELETE ON daemon_bolt11_mint_quotes
    BEGIN SELECT RAISE(ABORT, 'BOLT11 mint quote recovery state cannot be deleted'); END;
CREATE INDEX wallet_proof_import_active_idx ON wallet_proof_import_roots(scope_id, root_id) WHERE state = 'active';
CREATE TRIGGER wallet_proof_import_root_immutable BEFORE UPDATE OF root_id, scope_id, normalized_mint, unit, base_asset, condition_id, outcome_set_id, source_fingerprint, proof_count, page_count, source_body ON wallet_proof_import_roots BEGIN SELECT RAISE(ABORT, 'wallet import source is immutable'); END;
CREATE TRIGGER wallet_proof_import_page_insert BEFORE INSERT ON wallet_proof_import_pages WHEN NOT EXISTS (
    SELECT 1 FROM wallet_proof_import_roots r WHERE r.scope_id = NEW.scope_id AND r.root_id = NEW.root_id
      AND r.state = 'active' AND NEW.page_index < r.page_count
      AND NEW.proof_count = min(32, r.proof_count - NEW.page_index * 32)
  ) BEGIN SELECT RAISE(ABORT, 'wallet import page is foreign'); END;
CREATE TRIGGER wallet_proof_import_page_immutable BEFORE UPDATE OF scope_id, root_id, page_index, proof_count, expected_operation_id ON wallet_proof_import_pages BEGIN SELECT RAISE(ABORT, 'wallet import page is immutable'); END;
CREATE TRIGGER wallet_proof_import_page_binding_immutable BEFORE UPDATE OF bound_operation_id ON wallet_proof_import_pages WHEN OLD.bound_operation_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'wallet import page binding is immutable'); END;
CREATE TRIGGER wallet_proof_import_complete BEFORE UPDATE OF state ON wallet_proof_import_roots WHEN OLD.state = 'complete' OR NEW.state <> 'complete' OR
    (SELECT count(*) FROM wallet_proof_import_pages p JOIN custody_operations o ON o.scope_id = p.scope_id AND o.operation_id = p.bound_operation_id
      WHERE p.scope_id = NEW.scope_id AND p.root_id = NEW.root_id AND o.result_state = 'applied') <> NEW.page_count
    BEGIN SELECT RAISE(ABORT, 'wallet import is incomplete'); END;
CREATE TRIGGER wallet_proof_import_roots_no_delete BEFORE DELETE ON wallet_proof_import_roots BEGIN SELECT RAISE(ABORT, 'wallet import history is retained'); END;
CREATE TRIGGER wallet_proof_import_pages_no_delete BEFORE DELETE ON wallet_proof_import_pages BEGIN SELECT RAISE(ABORT, 'wallet import history is retained'); END;
CREATE TRIGGER native_payment_request_receipt_mint BEFORE INSERT ON native_payment_request_receipts WHEN NEW.receipt_kind = 'regular' AND NOT EXISTS (
    SELECT 1 FROM native_payment_requests r JOIN custody_operations o ON o.scope_id = r.scope_id
      WHERE r.scope_id = NEW.scope_id AND r.request_id = NEW.request_id AND o.operation_id = NEW.regular_operation_id
        AND o.normalized_mint = r.normalized_mint AND o.unit = r.unit AND o.semantic_kind = 'generic-receive' AND o.wallet_stage = 'receive'
  ) BEGIN SELECT RAISE(ABORT, 'payment request receipt operation is foreign'); END;
CREATE TRIGGER native_payment_request_receipt_group_insert BEFORE INSERT ON native_payment_request_receipt_groups WHEN NOT EXISTS (
    SELECT 1 FROM native_payment_request_receipts receipt JOIN native_payment_requests request ON request.scope_id = receipt.scope_id AND request.request_id = receipt.request_id
      JOIN wallet_proof_import_roots root ON root.scope_id = request.scope_id
      WHERE receipt.scope_id = NEW.scope_id AND receipt.request_id = NEW.request_id AND receipt.receipt_kind = 'conditional'
        AND NEW.group_index < receipt.group_count AND root.root_id = NEW.root_id AND root.normalized_mint = request.normalized_mint
        AND root.unit = request.unit AND root.proof_count = NEW.proof_count AND root.page_count = NEW.page_count
  ) BEGIN SELECT RAISE(ABORT, 'payment request receipt group is foreign'); END;
CREATE TRIGGER native_payment_requests_immutable BEFORE UPDATE ON native_payment_requests BEGIN SELECT RAISE(ABORT, 'payment request authority is immutable'); END;
CREATE TRIGGER native_payment_requests_retained BEFORE DELETE ON native_payment_requests BEGIN SELECT RAISE(ABORT, 'payment request history is retained'); END;
CREATE TRIGGER native_payment_request_receipts_immutable BEFORE UPDATE ON native_payment_request_receipts BEGIN SELECT RAISE(ABORT, 'payment request authority is immutable'); END;
CREATE TRIGGER native_payment_request_receipts_retained BEFORE DELETE ON native_payment_request_receipts BEGIN SELECT RAISE(ABORT, 'payment request history is retained'); END;
CREATE TRIGGER native_payment_request_receipt_groups_immutable BEFORE UPDATE ON native_payment_request_receipt_groups BEGIN SELECT RAISE(ABORT, 'payment request authority is immutable'); END;
CREATE TRIGGER native_payment_request_receipt_groups_retained BEFORE DELETE ON native_payment_request_receipt_groups BEGIN SELECT RAISE(ABORT, 'payment request history is retained'); END;
CREATE INDEX daemon_activity_feed_page_idx
    ON daemon_activity_feed (scope_id, sequence DESC);
CREATE TRIGGER daemon_activity_feed_no_delete
    BEFORE DELETE ON daemon_activity_feed
    BEGIN SELECT RAISE(ABORT, 'native Activity display rows cannot be deleted'); END;
CREATE TRIGGER daemon_activity_feed_identity_immutable
    BEFORE UPDATE ON daemon_activity_feed
    WHEN NEW.sequence <> OLD.sequence
      OR NEW.scope_id <> OLD.scope_id
      OR NEW.activity_id <> OLD.activity_id
    BEGIN SELECT RAISE(ABORT, 'native Activity display identity is immutable'); END;
CREATE TRIGGER daemon_activity_feed_meta_immutable
    BEFORE UPDATE ON daemon_activity_feed_meta
    BEGIN SELECT RAISE(ABORT, 'native Activity feed identity is immutable'); END;
CREATE TRIGGER daemon_activity_feed_meta_no_delete
    BEFORE DELETE ON daemon_activity_feed_meta
    BEGIN SELECT RAISE(ABORT, 'native Activity feed identity cannot be deleted'); END;
COMMIT;
