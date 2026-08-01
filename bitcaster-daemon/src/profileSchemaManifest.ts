import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  captureProfileSchemaManifest,
  type ProfileSchemaManifest,
  type ProfileSchemaMarker,
} from './profileSchema.ts'

export const FINAL_PROFILE_APPLICATION_ID = 0x4243444d
export const FINAL_PROFILE_SCHEMA_VERSION = 1
export const FINAL_PROFILE_SCHEMA_NAME = 'bitcaster-daemon-profile'
export const FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST =
  '42d40723de0749a8ae4ba22110b467a3acb7511cc0049d656aa2d19bdef13c28'

const artifactBytesMax = 16 * 1_024 * 1_024
const recordBytesMax = 64 * 1_024

/**
 * The one clean-start production schema. It deliberately contains target-v1
 * swap authority and no source-era trade session/cipher/recovery tables.
 * This custody schema is not deployed yet, so v1 revisions replace an empty
 * store instead of migrating previously initialized profiles.
 */
export const FINAL_PROFILE_SCHEMA_SQL = [
  `CREATE TABLE profile_schema_marker (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    schema_name TEXT NOT NULL CHECK (schema_name = '${FINAL_PROFILE_SCHEMA_NAME}'),
    schema_version INTEGER NOT NULL CHECK (schema_version = ${FINAL_PROFILE_SCHEMA_VERSION}),
    initialized_at_ms INTEGER NOT NULL CHECK (initialized_at_ms >= 0)
  ) STRICT`,
  `CREATE TABLE daemon_profile (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    engine_base_url TEXT NOT NULL CHECK (length(engine_base_url) BETWEEN 1 AND 2048),
    mint_url TEXT NOT NULL CHECK (length(mint_url) BETWEEN 1 AND 2048),
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
    UNIQUE (wallet_scope_id, nostr_public_key_hex)
  ) STRICT`,
  `CREATE TABLE daemon_secret_authority (
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
      ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE daemon_rpc_token (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    token TEXT NOT NULL CHECK (
      length(token) = 43
      AND token NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) STRICT`,
  `CREATE TABLE custody_scopes (
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
  ) STRICT`,
  `CREATE TABLE custody_scope_state (
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
  ) STRICT`,
  `CREATE TABLE target_state_metadata (
    scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1)
  ) STRICT`,
  `CREATE TABLE target_wallet_proofs (
    proof_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'
    ),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    amount INTEGER NOT NULL CHECK (amount > 0),
    secret TEXT NOT NULL CHECK (length(secret) BETWEEN 1 AND 16384),
    signature TEXT NOT NULL CHECK (length(signature) BETWEEN 1 AND 16384),
    proof_body BLOB NOT NULL CHECK (length(proof_body) BETWEEN 1 AND ${recordBytesMax}),
    state TEXT NOT NULL CHECK (state IN ('available', 'reserved', 'locked')),
    reserved_by TEXT CHECK (reserved_by IS NULL OR length(reserved_by) BETWEEN 1 AND 16384),
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('sats', 'outcome')),
    condition_id TEXT CHECK (condition_id IS NULL OR length(condition_id) BETWEEN 1 AND 1024),
    outcome_set_id TEXT CHECK (outcome_set_id IS NULL OR length(outcome_set_id) BETWEEN 1 AND 1024),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, normalized_mint, secret),
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
  ) STRICT`,
  `CREATE TABLE target_keyset_counters (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    next_counter INTEGER NOT NULL CHECK (next_counter >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (scope_id, keyset_id)
  ) STRICT`,
  `CREATE TABLE target_proof_operations (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 16384),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN (
      'swap-lock', 'swap-claim', 'conditional-keyset-swap',
      'ctf-split', 'ctf-merge', 'ctf-consolidation', 'ctf-redeem',
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
    reservation_id TEXT CHECK (
      reservation_id IS NULL OR length(reservation_id) BETWEEN 1 AND 16384
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, operation_id),
    UNIQUE (scope_id, operation_id, reservation_id, purpose),
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
  ) STRICT`,
  `CREATE TABLE daemon_ctf_range_preparations (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    range_operation_id TEXT NOT NULL CHECK (
      length(range_operation_id) BETWEEN 1 AND 16384
    ),
    source_operation_id TEXT NOT NULL CHECK (
      length(source_operation_id) BETWEEN 1 AND 16384
    ),
    source_kind TEXT NOT NULL CHECK (
      source_kind IN ('wallet-prepared', 'residual-change')
    ),
    predecessor_range_operation_id TEXT CHECK (
      predecessor_range_operation_id IS NULL
      OR length(predecessor_range_operation_id) BETWEEN 1 AND 16384
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
    continue_after_partial_fill INTEGER NOT NULL CHECK (
      continue_after_partial_fill IN (0, 1)
    ),
    consolidate_proofs INTEGER NOT NULL CHECK (consolidate_proofs IN (0, 1)),
    continuation_predecessor_order_id TEXT CHECK (
      continuation_predecessor_order_id IS NULL OR (
        length(continuation_predecessor_order_id) = 36
        AND substr(continuation_predecessor_order_id, 9, 1) = '-'
        AND substr(continuation_predecessor_order_id, 14, 1) = '-'
        AND substr(continuation_predecessor_order_id, 19, 1) = '-'
        AND substr(continuation_predecessor_order_id, 24, 1) = '-'
        AND replace(continuation_predecessor_order_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
    continuation_settlement_group_id TEXT CHECK (
      continuation_settlement_group_id IS NULL OR (
        length(continuation_settlement_group_id) = 36
        AND substr(continuation_settlement_group_id, 9, 1) = '-'
        AND substr(continuation_settlement_group_id, 14, 1) = '-'
        AND substr(continuation_settlement_group_id, 19, 1) = '-'
        AND substr(continuation_settlement_group_id, 24, 1) = '-'
        AND replace(continuation_settlement_group_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      )
    ),
    continuation_settlement_group_revision INTEGER CHECK (
      continuation_settlement_group_revision IS NULL
      OR continuation_settlement_group_revision BETWEEN 1 AND 9007199254740991
    ),
    continuation_revision INTEGER CHECK (
      continuation_revision IS NULL OR continuation_revision BETWEEN 1 AND 9007199254740991
    ),
    divisibility INTEGER NOT NULL CHECK (divisibility IN (10000, 1000000)),
    authorization_expires_at_unix_seconds INTEGER NOT NULL CHECK (
      authorization_expires_at_unix_seconds BETWEEN 1 AND 9007199254740991
    ),
    preparation_body BLOB NOT NULL CHECK (
      length(preparation_body) BETWEEN 1 AND 262144
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
    FOREIGN KEY (scope_id, predecessor_range_operation_id)
      REFERENCES daemon_ctf_range_preparations(scope_id, range_operation_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (scope_id, source_operation_id),
    UNIQUE (scope_id, authorization_id),
    UNIQUE (scope_id, client_order_id),
    UNIQUE (scope_id, predecessor_range_operation_id),
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
      (source_kind = 'wallet-prepared'
        AND predecessor_range_operation_id IS NULL
        AND continuation_predecessor_order_id IS NULL
        AND continuation_settlement_group_id IS NULL
        AND continuation_settlement_group_revision IS NULL
        AND continuation_revision IS NULL)
      OR
      (source_kind = 'residual-change'
        AND predecessor_range_operation_id IS NOT NULL
        AND predecessor_range_operation_id <> range_operation_id
        AND continue_after_partial_fill = 1
        AND continuation_predecessor_order_id IS NOT NULL
        AND continuation_settlement_group_id IS NOT NULL
        AND continuation_settlement_group_revision IS NOT NULL
        AND continuation_revision IS NOT NULL)
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
  ) STRICT`,
  `CREATE TABLE daemon_ctf_range_successor_intents (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    predecessor_range_operation_id TEXT NOT NULL CHECK (
      length(predecessor_range_operation_id) BETWEEN 1 AND 16384
    ),
    successor_range_operation_id TEXT NOT NULL CHECK (
      length(successor_range_operation_id) BETWEEN 1 AND 16384
    ),
    successor_authorization_id TEXT NOT NULL CHECK (
      length(successor_authorization_id) BETWEEN 1 AND 16384
    ),
    successor_client_order_id TEXT NOT NULL CHECK (
      length(successor_client_order_id) BETWEEN 1 AND 1024
    ),
    remaining_amount_subunits INTEGER NOT NULL CHECK (
      remaining_amount_subunits BETWEEN 1 AND 9007199254740991
    ),
    continuation_predecessor_order_id TEXT NOT NULL CHECK (
      length(continuation_predecessor_order_id) = 36
      AND substr(continuation_predecessor_order_id, 9, 1) = '-'
      AND substr(continuation_predecessor_order_id, 14, 1) = '-'
      AND substr(continuation_predecessor_order_id, 19, 1) = '-'
      AND substr(continuation_predecessor_order_id, 24, 1) = '-'
      AND replace(continuation_predecessor_order_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    continuation_settlement_group_id TEXT NOT NULL CHECK (
      length(continuation_settlement_group_id) = 36
      AND substr(continuation_settlement_group_id, 9, 1) = '-'
      AND substr(continuation_settlement_group_id, 14, 1) = '-'
      AND substr(continuation_settlement_group_id, 19, 1) = '-'
      AND substr(continuation_settlement_group_id, 24, 1) = '-'
      AND replace(continuation_settlement_group_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    continuation_settlement_group_revision INTEGER NOT NULL CHECK (
      continuation_settlement_group_revision BETWEEN 1 AND 9007199254740991
    ),
    continuation_revision INTEGER NOT NULL CHECK (
      continuation_revision BETWEEN 1 AND 9007199254740991
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (scope_id, predecessor_range_operation_id),
    UNIQUE (scope_id, successor_range_operation_id),
    UNIQUE (scope_id, successor_authorization_id),
    UNIQUE (scope_id, successor_client_order_id),
    FOREIGN KEY (scope_id, predecessor_range_operation_id)
      REFERENCES daemon_ctf_range_preparations(scope_id, range_operation_id)
      ON DELETE RESTRICT,
    CHECK (successor_range_operation_id <> predecessor_range_operation_id)
  ) STRICT`,
  `CREATE TABLE daemon_ctf_range_sources (
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
  ) STRICT`,
  `CREATE TABLE daemon_ctf_range_consolidations (
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
  ) STRICT`,
  `CREATE TABLE custody_proofs (
    proof_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(proof_id) = 64 AND proof_id NOT GLOB '*[^0-9a-f]*'
    ),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    amount INTEGER NOT NULL CHECK (amount > 0),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    condition_id TEXT CHECK (condition_id IS NULL OR length(condition_id) BETWEEN 1 AND 1024),
    outcome_set_id TEXT CHECK (outcome_set_id IS NULL OR length(outcome_set_id) BETWEEN 1 AND 1024),
    product_binding TEXT CHECK (product_binding IS NULL OR length(product_binding) BETWEEN 1 AND 1024),
    proof_body BLOB NOT NULL CHECK (length(proof_body) BETWEEN 1 AND ${recordBytesMax}),
    proof_fingerprint TEXT NOT NULL CHECK (
      length(proof_fingerprint) = 64
      AND proof_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
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
  ) STRICT`,
  `CREATE TABLE custody_keyset_counters (
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    next_counter INTEGER NOT NULL CHECK (next_counter >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (scope_id, normalized_mint, unit, keyset_id)
  ) STRICT`,
  `CREATE TABLE custody_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (
      length(artifact_id) BETWEEN 1 AND 16384
      AND (
        (
          artifact_id GLOB 'artifact:custody-operation:?*:request'
          OR artifact_id GLOB 'artifact:custody-operation:?*:output'
          OR artifact_id GLOB 'artifact:custody-operation:?*:private'
          OR artifact_id GLOB 'artifact:custody-operation:?*:result'
          OR artifact_id GLOB 'artifact:custody-operation:?*:delivery'
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
      'delivery-payload', 'locked-proofs', 'relay-ciphertext',
      'adaptor-secret', 'adaptor-point', 'buyer-pre-signatures',
      'seller-pre-signatures', 'failure'
    )),
    encoding TEXT NOT NULL CHECK (encoding IN ('canonical-json', 'utf8', 'binary')),
    body BLOB NOT NULL CHECK (length(body) BETWEEN 1 AND ${artifactBytesMax}),
    fingerprint TEXT NOT NULL CHECK (
      length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    revision INTEGER NOT NULL CHECK (revision = 0),
    private_material INTEGER NOT NULL CHECK (private_material IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    UNIQUE (scope_id, artifact_id)
  ) STRICT`,
  `CREATE TABLE custody_operations (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 16384),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    retained_operation_key TEXT NOT NULL CHECK (length(retained_operation_key) BETWEEN 1 AND 1024),
    semantic_kind TEXT NOT NULL CHECK (semantic_kind IN (
      'swap-lock', 'swap-claim', 'swap-refund', 'conditional-keyset-swap',
      'generic-receive', 'generic-send', 'wallet-send',
      'ctf-split', 'ctf-merge', 'ctf-redeem'
    )),
    operation_state TEXT NOT NULL CHECK (
      operation_state IN ('dispatch-intent', 'transport-attempted', 'reconciled', 'aborted')
    ),
    activity_id TEXT NOT NULL CHECK (length(activity_id) BETWEEN 1 AND 1024),
    wallet_stage TEXT NOT NULL CHECK (
      wallet_stage IN ('lock', 'claim', 'refund', 'receive', 'send', 'ctf-split', 'ctf-merge', 'ctf-redeem')
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
  ) STRICT`,
  `CREATE TABLE custody_operation_inputs (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    input_position INTEGER NOT NULL CHECK (input_position BETWEEN 0 AND 255),
    proof_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
    PRIMARY KEY (scope_id, operation_id, input_position),
    UNIQUE (scope_id, operation_id, proof_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, proof_id)
      REFERENCES custody_proofs(scope_id, proof_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE custody_proof_reservations (
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
  ) STRICT`,
  `CREATE TABLE custody_operation_artifact_links (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    link_kind TEXT NOT NULL CHECK (link_kind IN (
      'request', 'output', 'private', 'result', 'locked-proof',
      'relay-ciphertext', 'adaptor-secret', 'adaptor-point',
      'buyer-pre-signature', 'seller-pre-signature', 'failure'
    )),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 511),
    artifact_id TEXT NOT NULL,
    PRIMARY KEY (scope_id, operation_id, link_kind, position),
    UNIQUE (scope_id, operation_id, artifact_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE custody_verification_bindings (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
    keyset_fingerprint TEXT NOT NULL CHECK (length(keyset_fingerprint) = 64),
    require_dleq INTEGER NOT NULL CHECK (require_dleq IN (0, 1)),
    binding_position INTEGER NOT NULL CHECK (binding_position BETWEEN 0 AND 255),
    PRIMARY KEY (scope_id, operation_id, keyset_id, curve),
    UNIQUE (scope_id, operation_id, binding_position),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE custody_verification_keyset_uses (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    use_kind TEXT NOT NULL CHECK (use_kind IN ('input', 'output')),
    use_position INTEGER NOT NULL CHECK (use_position BETWEEN 0 AND 255),
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
    PRIMARY KEY (scope_id, operation_id, use_kind, use_position),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id, keyset_id, curve)
      REFERENCES custody_verification_bindings(
        scope_id, operation_id, keyset_id, curve
      ) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE custody_operation_pins (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    pin_reason TEXT NOT NULL CHECK (pin_reason IN (
      'active-reservation', 'pending-outbox', 'active-retry-cursor', 'replay-tombstone'
    )),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (scope_id, operation_id, pin_reason),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE custody_proof_lineage (
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
  ) STRICT`,
  `CREATE TABLE custody_selected_successors (
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
  ) STRICT`,
  `CREATE TABLE custody_successor_admissions (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    admission_id TEXT NOT NULL CHECK (length(admission_id) BETWEEN 1 AND 16384),
    PRIMARY KEY (scope_id, operation_id),
    UNIQUE (scope_id, admission_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE custody_successor_admission_proofs (
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
  ) STRICT`,
  `CREATE TABLE custody_operation_tombstones (
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
  ) STRICT`,
  `CREATE TABLE custody_deliveries (
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
  ) STRICT`,
  `CREATE TABLE custody_active_work (
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
    estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes BETWEEN 1 AND 4194304),
    PRIMARY KEY (scope_id, operation_id),
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE daemon_orders (
    order_id TEXT PRIMARY KEY NOT NULL CHECK (length(order_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    market_id TEXT NOT NULL CHECK (length(market_id) BETWEEN 1 AND 1024),
    token_side TEXT CHECK (token_side IN ('Outcome', 'Complement')),
    side TEXT CHECK (side IN ('Buy', 'Sell')),
    price_subunits INTEGER CHECK (price_subunits >= 0),
    amount_subunits INTEGER CHECK (amount_subunits >= 0),
    status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 256),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    ephemeral_pubkey TEXT CHECK (
      ephemeral_pubkey IS NULL OR (
        length(ephemeral_pubkey) = 66
        AND substr(ephemeral_pubkey, 1, 2) IN ('02', '03')
        AND ephemeral_pubkey NOT GLOB '*[^0-9a-f]*'
      )
    ),
    client_order_id TEXT,
    preflight_reservation_id TEXT,
    preflight_condition_id TEXT,
    preflight_keep_outcome_set_id TEXT,
    preflight_lock_outcome_set_id TEXT,
    preflight_amount_subunits INTEGER CHECK (preflight_amount_subunits > 0),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    divisibility INTEGER NOT NULL CHECK (divisibility IN (10000, 1000000)),
    engine_status_present INTEGER NOT NULL CHECK (engine_status_present IN (0, 1)),
    engine_status_body BLOB CHECK (
      engine_status_body IS NULL OR length(engine_status_body) <= ${recordBytesMax}
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
  ) STRICT`,
  `CREATE TABLE daemon_order_trades (
    scope_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 511),
    trade_id TEXT NOT NULL CHECK (length(trade_id) BETWEEN 1 AND 1024),
    PRIMARY KEY (scope_id, order_id, position),
    UNIQUE (scope_id, order_id, trade_id),
    FOREIGN KEY (scope_id, order_id)
      REFERENCES daemon_orders(scope_id, order_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE order_collateral_pins (
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
  ) STRICT`,
  `CREATE TABLE order_collateral_proofs (
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
  ) STRICT`,
  `CREATE TABLE daemon_swaps (
    trade_id TEXT PRIMARY KEY NOT NULL CHECK (length(trade_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    order_id TEXT,
    market_id TEXT CHECK (market_id IS NULL OR length(market_id) BETWEEN 1 AND 1024),
    role TEXT CHECK (role IS NULL OR role IN ('seller', 'buyer')),
    counterparty_pubkey TEXT CHECK (
      counterparty_pubkey IS NULL OR length(counterparty_pubkey) BETWEEN 1 AND 256
    ),
    seller_locktime INTEGER CHECK (seller_locktime >= 0),
    buyer_locktime INTEGER CHECK (buyer_locktime >= 0),
    fill_amount_sats INTEGER CHECK (fill_amount_sats >= 0),
    fill_amount_subunits INTEGER CHECK (fill_amount_subunits >= 0),
    outcome_face_amount_sats INTEGER CHECK (outcome_face_amount_sats >= 0),
    outcome_face_amount_subunits INTEGER CHECK (outcome_face_amount_subunits >= 0),
    quote_payment_sats INTEGER CHECK (quote_payment_sats >= 0),
    quote_payment_subunits INTEGER CHECK (quote_payment_subunits >= 0),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    divisibility INTEGER NOT NULL CHECK (divisibility IN (10000, 1000000)),
    settlement_kind TEXT CHECK (
      settlement_kind IS NULL OR length(settlement_kind) BETWEEN 1 AND 128
    ),
    seller_keep_outcome_set_id TEXT,
    seller_lock_outcome_set_id TEXT,
    step TEXT NOT NULL CHECK (step IN (
      'awaiting-trade-created', 'opened', 'seller-opened', 'buyer-responded',
      'settling', 'awaiting-confirmation', 'confirmed', 'refunded', 'failed'
    )),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    engine_state TEXT,
    adaptor_point_cipher_artifact_id TEXT,
    locked_seller_cipher_artifact_id TEXT,
    locked_buyer_cipher_artifact_id TEXT,
    buyer_locked_proofs_artifact_id TEXT,
    seller_adaptor_secret_artifact_id TEXT,
    seller_adaptor_point_artifact_id TEXT,
    buyer_pre_sigs_artifact_id TEXT,
    seller_pre_sigs_artifact_id TEXT,
    failure_artifact_id TEXT,
    error TEXT CHECK (error IS NULL OR length(error) <= 4096),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (scope_id, trade_id),
    FOREIGN KEY (scope_id, adaptor_point_cipher_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, locked_seller_cipher_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, locked_buyer_cipher_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, buyer_locked_proofs_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, seller_adaptor_secret_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, seller_adaptor_point_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, buyer_pre_sigs_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, seller_pre_sigs_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, failure_artifact_id)
      REFERENCES custody_artifacts(scope_id, artifact_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE swap_operation_links (
    scope_id TEXT NOT NULL,
    trade_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('seller', 'buyer')),
    stage TEXT NOT NULL CHECK (stage IN ('lock', 'claim', 'refund')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    PRIMARY KEY (scope_id, trade_id, operation_id),
    UNIQUE (scope_id, trade_id, role, stage),
    FOREIGN KEY (scope_id, trade_id)
      REFERENCES daemon_swaps(scope_id, trade_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, order_id)
      REFERENCES daemon_orders(scope_id, order_id) ON DELETE RESTRICT,
    FOREIGN KEY (scope_id, operation_id)
      REFERENCES custody_operations(scope_id, operation_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE target_ephemeral_keys (
    key_id TEXT PRIMARY KEY NOT NULL CHECK (length(key_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    order_id TEXT NOT NULL,
    trade_id TEXT,
    market_id TEXT NOT NULL CHECK (length(market_id) BETWEEN 1 AND 1024),
    public_key_hex TEXT NOT NULL CHECK (
      length(public_key_hex) = 66
      AND substr(public_key_hex, 1, 2) IN ('02', '03')
      AND public_key_hex NOT GLOB '*[^0-9a-f]*'
    ),
    protection TEXT NOT NULL CHECK (protection IN ('owner-only-plaintext', 'scrypt-aes-256-gcm')),
    kdf TEXT CHECK (kdf IS NULL OR kdf = 'scrypt-v1'),
    salt BLOB CHECK (salt IS NULL OR length(salt) = 16),
    iv BLOB CHECK (iv IS NULL OR length(iv) = 12),
    auth_tag BLOB CHECK (auth_tag IS NULL OR length(auth_tag) = 16),
    private_key_body BLOB NOT NULL CHECK (length(private_key_body) BETWEEN 1 AND 512),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    CHECK (
      (protection = 'owner-only-plaintext'
        AND kdf IS NULL AND salt IS NULL AND iv IS NULL AND auth_tag IS NULL)
      OR
      (protection = 'scrypt-aes-256-gcm'
        AND kdf = 'scrypt-v1'
        AND salt IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE seed_recovery_jobs (
    recovery_id TEXT PRIMARY KEY NOT NULL CHECK (length(recovery_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    invocation_id TEXT NOT NULL UNIQUE CHECK (length(invocation_id) BETWEEN 1 AND 1024),
    disclosure_acknowledged INTEGER NOT NULL CHECK (disclosure_acknowledged = 1),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    imported_proofs INTEGER NOT NULL CHECK (imported_proofs >= 0),
    ignored_spent_proofs INTEGER NOT NULL CHECK (ignored_spent_proofs >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (recovery_id, scope_id),
    UNIQUE (scope_id, normalized_mint, unit)
  ) STRICT`,
  `CREATE TABLE seed_recovery_keysets (
    recovery_id TEXT NOT NULL REFERENCES seed_recovery_jobs(recovery_id) ON DELETE RESTRICT,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) BETWEEN 1 AND 1024),
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
    next_counter INTEGER NOT NULL CHECK (next_counter >= 0),
    trailing_empty_counters INTEGER NOT NULL CHECK (
      trailing_empty_counters BETWEEN 0 AND 9007199254740991
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    PRIMARY KEY (recovery_id, keyset_id),
    UNIQUE (recovery_id, ordinal),
    CHECK (
      (state = 'active' AND trailing_empty_counters < 300)
      OR (state = 'completed' AND trailing_empty_counters >= 300)
    )
  ) STRICT`,
  `CREATE TABLE seed_recovery_pending_proofs (
    recovery_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL,
    proof_y TEXT NOT NULL CHECK (length(proof_y) BETWEEN 1 AND 1024),
    proof_position INTEGER NOT NULL CHECK (proof_position BETWEEN 0 AND 299),
    scope_id TEXT NOT NULL,
    normalized_mint TEXT NOT NULL,
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    curve TEXT NOT NULL CHECK (curve IN ('secp256k1', 'bls12-381')),
    proof_body BLOB NOT NULL CHECK (length(proof_body) BETWEEN 1 AND ${recordBytesMax}),
    retained_reason TEXT NOT NULL CHECK (retained_reason = 'PENDING'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (recovery_id, keyset_id, proof_y),
    UNIQUE (recovery_id, keyset_id, proof_position),
    FOREIGN KEY (recovery_id, keyset_id)
      REFERENCES seed_recovery_keysets(recovery_id, keyset_id) ON DELETE RESTRICT,
    FOREIGN KEY (recovery_id, scope_id)
      REFERENCES seed_recovery_jobs(recovery_id, scope_id) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE INDEX custody_proofs_selection_idx
    ON custody_proofs (
      scope_id, normalized_mint, unit, selectability,
      condition_id, outcome_set_id, amount DESC, proof_id
    )`,
  `CREATE INDEX custody_proofs_reservation_idx
    ON custody_proofs (scope_id, reservation_operation_id, selectability, proof_id)`,
  `CREATE INDEX target_wallet_proofs_selection_idx
    ON target_wallet_proofs (
      scope_id, normalized_mint, unit, asset_kind, condition_id, outcome_set_id,
      keyset_id, state, amount DESC, proof_id
    )`,
  `CREATE INDEX target_wallet_proofs_holdings_idx
    ON target_wallet_proofs (
      scope_id, normalized_mint, state, base_asset, asset_kind,
      condition_id, unit, outcome_set_id, amount
    )`,
  `CREATE INDEX target_wallet_proofs_reservation_idx
    ON target_wallet_proofs (scope_id, normalized_mint, reserved_by, state, proof_id)`,
  `CREATE INDEX target_proof_operations_recovery_idx
    ON target_proof_operations (
      scope_id, purpose, state, updated_at_ms, operation_id
    )`,
  `CREATE INDEX daemon_ctf_range_active_recovery_idx
    ON daemon_ctf_range_preparations (
      scope_id, updated_at_ms, range_operation_id, client_order_id
    )
    WHERE lifecycle_state <> 'terminal'`,
  `CREATE UNIQUE INDEX daemon_ctf_range_active_client_order_idx
    ON daemon_ctf_range_preparations (scope_id, client_order_id)
    WHERE lifecycle_state <> 'terminal'`,
  `CREATE INDEX daemon_orders_client_id_idx
    ON daemon_orders (scope_id, client_order_id)`,
  `CREATE INDEX custody_operations_history_idx
    ON custody_operations (scope_id, updated_at_ms DESC, operation_id DESC)`,
  `CREATE INDEX custody_operations_retry_idx
    ON custody_operations (scope_id, operation_state, next_attempt_at_ms, operation_id)`,
  `CREATE INDEX custody_active_work_page_idx
    ON custody_active_work (scope_id, next_attempt_at_ms, operation_id)`,
  `CREATE INDEX custody_deliveries_pending_idx
    ON custody_deliveries (scope_id, state, expires_at_ms, delivery_id)`,
  `CREATE INDEX daemon_orders_listing_idx
    ON daemon_orders (scope_id, market_id, status, updated_at_ms DESC, order_id)`,
  `CREATE INDEX order_collateral_pins_active_idx
    ON order_collateral_pins (scope_id, pin_state, order_id, pin_id)`,
  `CREATE INDEX daemon_swaps_listing_idx
    ON daemon_swaps (scope_id, market_id, step, updated_at_ms DESC, trade_id)`,
  `CREATE INDEX daemon_swaps_order_idx
    ON daemon_swaps (scope_id, order_id, updated_at_ms DESC, trade_id)`,
  `CREATE INDEX swap_operation_links_operation_idx
    ON swap_operation_links (scope_id, operation_id, trade_id)`,
  `CREATE INDEX target_ephemeral_keys_trade_idx
    ON target_ephemeral_keys (scope_id, trade_id, order_id)`,
  `CREATE INDEX seed_recovery_jobs_active_idx
    ON seed_recovery_jobs (scope_id, state, updated_at_ms, recovery_id)`,
  `CREATE INDEX seed_recovery_pending_idx
    ON seed_recovery_pending_proofs (scope_id, normalized_mint, unit, recovery_id, keyset_id)`,
  `CREATE TRIGGER profile_schema_marker_no_update
    BEFORE UPDATE ON profile_schema_marker
    BEGIN
      SELECT RAISE(ABORT, 'profile schema marker is immutable');
    END`,
  `CREATE TRIGGER profile_schema_marker_no_delete
    BEFORE DELETE ON profile_schema_marker
    BEGIN
      SELECT RAISE(ABORT, 'profile schema marker is immutable');
    END`,
  `CREATE TRIGGER custody_scope_epoch_monotonic
    BEFORE UPDATE OF fencing_epoch ON custody_scope_state
    WHEN NEW.fencing_epoch < OLD.fencing_epoch
    BEGIN
      SELECT RAISE(ABORT, 'custody fencing epoch cannot decrease');
    END`,
] as const

export const FINAL_PROFILE_SCHEMA_MARKERS: readonly ProfileSchemaMarker[] = [
  {
    name: 'schema-identity',
    selectSql: `SELECT singleton, schema_name AS schemaName,
      schema_version AS schemaVersion
      FROM profile_schema_marker ORDER BY singleton`,
    expectedRows: [
      {
        singleton: 1,
        schemaName: FINAL_PROFILE_SCHEMA_NAME,
        schemaVersion: FINAL_PROFILE_SCHEMA_VERSION,
      },
    ],
  },
  {
    name: 'complete-bootstrap-singletons',
    selectSql: `SELECT
      (SELECT count(*) FROM daemon_profile) AS profileCount,
      (SELECT count(*) FROM daemon_secret_authority) AS secretCount,
      (SELECT count(*) FROM daemon_rpc_token) AS rpcTokenCount,
      (SELECT count(*) FROM custody_scopes) AS scopeCount,
      (SELECT count(*) FROM custody_scope_state) AS scopeStateCount`,
    expectedRows: [
      {
        profileCount: 1,
        secretCount: 1,
        rpcTokenCount: 1,
        scopeCount: 1,
        scopeStateCount: 1,
      },
    ],
  },
  {
    name: 'forbidden-source-schema-absent',
    selectSql: `SELECT count(*) AS forbiddenCount
      FROM sqlite_schema
      WHERE name IN (
        'daemon_trade_sessions',
        'daemon_trade_expected_operations',
        'daemon_trade_planned_operations',
        'daemon_trade_proof_links',
        'daemon_trade_ciphers',
        'custody_session_links',
        'trade_cipher_recovery',
        'adaptor_recovery',
        'presignature_recovery',
        'locktime_recovery'
      )`,
    expectedRows: [{ forbiddenCount: 0 }],
  },
]

let cachedManifest: ProfileSchemaManifest | undefined

export function getFinalProfileSchemaManifest(): ProfileSchemaManifest {
  if (cachedManifest !== undefined) return cachedManifest
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`
      PRAGMA application_id = ${FINAL_PROFILE_APPLICATION_ID};
      PRAGMA user_version = ${FINAL_PROFILE_SCHEMA_VERSION};
      ${FINAL_PROFILE_SCHEMA_SQL.join(';\n')};
    `)
    const captured = captureProfileSchemaManifest(database, {
      applicationId: FINAL_PROFILE_APPLICATION_ID,
      userVersion: FINAL_PROFILE_SCHEMA_VERSION,
      markers: FINAL_PROFILE_SCHEMA_MARKERS,
    })
    const digest = createHash('sha256').update(JSON.stringify(captured)).digest('hex')
    if (digest !== FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST) {
      throw new Error(`frozen daemon profile schema manifest digest changed: ${digest}`)
    }
    cachedManifest = deepFreeze(captured)
  } finally {
    database.close()
  }
  return cachedManifest
}

export function finalProfileSchemaManifestDigest(): string {
  return createHash('sha256').update(JSON.stringify(getFinalProfileSchemaManifest())).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
