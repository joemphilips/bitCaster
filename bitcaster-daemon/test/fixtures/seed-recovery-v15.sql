-- Exact changed schema objects from v15, digest fc13f1764e4b4add56c62e74441fe4d10bd3e53f95ed4ee4c837732e648edd9f.
CREATE TABLE profile_schema_marker (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    schema_name TEXT NOT NULL CHECK (schema_name = 'bitcaster-daemon-profile'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 15),
    initialized_at_ms INTEGER NOT NULL CHECK (initialized_at_ms >= 0)
  ) STRICT;
CREATE TABLE seed_recovery_jobs (
    recovery_id TEXT PRIMARY KEY NOT NULL CHECK (length(recovery_id) BETWEEN 1 AND 1024),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id) ON DELETE RESTRICT,
    invocation_id TEXT NOT NULL UNIQUE CHECK (length(invocation_id) BETWEEN 1 AND 1024),
    disclosure_acknowledged INTEGER NOT NULL CHECK (disclosure_acknowledged = 1),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit IN ('sat', 'msat')),
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    scan_offset INTEGER NOT NULL CHECK (scan_offset BETWEEN 0 AND 2047),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    imported_proofs INTEGER NOT NULL CHECK (imported_proofs >= 0),
    ignored_spent_proofs INTEGER NOT NULL CHECK (ignored_spent_proofs >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
  ) STRICT;
CREATE TABLE seed_recovery_keysets (
    recovery_id TEXT NOT NULL,
    keyset_id TEXT NOT NULL CHECK (length(keyset_id) = 66 AND substr(keyset_id, 1, 2) = '01' AND keyset_id NOT GLOB '*[^0-9a-f]*'),
    next_counter INTEGER NOT NULL CHECK (next_counter >= 0),
    trailing_empty_counters INTEGER NOT NULL CHECK (
      trailing_empty_counters BETWEEN 0 AND 9007199254740991
    ),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'completed')),
    PRIMARY KEY (recovery_id, keyset_id),
    FOREIGN KEY (recovery_id)
      REFERENCES seed_recovery_jobs(recovery_id) ON DELETE RESTRICT,
    CHECK (
      state = 'active'
      OR (state = 'completed' AND trailing_empty_counters >= 300)
    )
  ) STRICT;
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
CREATE TRIGGER seed_recovery_jobs_no_rebind
    BEFORE UPDATE OF recovery_id, scope_id, invocation_id, disclosure_acknowledged,
      normalized_mint, unit ON seed_recovery_jobs
    BEGIN
      SELECT RAISE(ABORT, 'seed recovery job identity is immutable');
    END;
CREATE TRIGGER seed_recovery_keysets_no_rekey
    BEFORE UPDATE OF recovery_id, keyset_id ON seed_recovery_keysets
    BEGIN
      SELECT RAISE(ABORT, 'seed recovery keyset identity is immutable');
    END;
CREATE INDEX seed_recovery_jobs_active_idx
    ON seed_recovery_jobs (scope_id, state, updated_at_ms, recovery_id);
