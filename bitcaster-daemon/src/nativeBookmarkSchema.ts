/** Public client preferences. This table is not custody or recovery authority. */
export const NATIVE_BOOKMARK_SCHEMA_SQL = [
  `CREATE TABLE daemon_bookmark_preferences (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    markets_json TEXT NOT NULL CHECK (json_valid(markets_json) AND json_type(markets_json) = 'array'),
    sync_context TEXT,
    pending_local_edit INTEGER NOT NULL CHECK (pending_local_edit IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
    last_event_time INTEGER NOT NULL CHECK (last_event_time BETWEEN 0 AND 9007199254740991)
  ) STRICT`,
]
