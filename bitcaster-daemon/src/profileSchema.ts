import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export const DAEMON_PROFILE_DATABASE = 'daemon-state.sqlite'

export const LEGACY_DAEMON_PROFILE_ARTIFACTS = [
  'daemon-profile.json',
  'daemon-secrets.json',
  'daemon-rpc-token',
  'daemon-state.json',
] as const

export const DAEMON_PROFILE_SIDECARS = [
  `${DAEMON_PROFILE_DATABASE}-wal`,
  `${DAEMON_PROFILE_DATABASE}-shm`,
] as const

export const DAEMON_RUN_LOCK = 'daemon-run.lock'
export const DAEMON_RPC_SOCKET = 'daemon.sock'

const recognizedProfileArtifacts = new Set<string>([
  DAEMON_PROFILE_DATABASE,
  ...LEGACY_DAEMON_PROFILE_ARTIFACTS,
  ...DAEMON_PROFILE_SIDECARS,
  DAEMON_RUN_LOCK,
  DAEMON_RPC_SOCKET,
])

export type ProfileArtifactKind =
  | 'file'
  | 'directory'
  | 'symbolic-link'
  | 'socket'
  | 'other'

export interface ProfilePathIdentity {
  readonly device: bigint
  readonly inode: bigint
  readonly ownerId: bigint
  readonly mode: number
  readonly size: bigint
  readonly modifiedAtNanoseconds: bigint
  readonly changedAtNanoseconds: bigint
  readonly realPath?: string
}

export interface ProfileArtifact {
  readonly name: string
  readonly kind: ProfileArtifactKind
  readonly identity: ProfilePathIdentity
}

/**
 * This inventory may contain operator-controlled file names. Callers must not
 * copy it into logs, errors, metrics, or RPC responses.
 */
export interface DaemonProfileInventory {
  readonly directory: string
  readonly directoryExists: boolean
  readonly directoryIsPlain: boolean
  readonly directoryIdentity?: ProfilePathIdentity
  readonly artifacts: readonly ProfileArtifact[]
  readonly legacyArtifacts: readonly ProfileArtifact[]
  readonly sqliteDatabase?: ProfileArtifact
  readonly sqliteSidecars: readonly ProfileArtifact[]
  readonly runLock?: ProfileArtifact
  readonly rpcSocket?: ProfileArtifact
  readonly unknownArtifacts: readonly ProfileArtifact[]
}

export type ProfileSchemaRefusalReason =
  | 'invalid-manifest'
  | 'unsupported-platform'
  | 'profile-directory-not-plain'
  | 'profile-permission-invalid'
  | 'profile-identity-changed'
  | 'legacy-artifact'
  | 'sqlite-sidecar-invalid'
  | 'unknown-artifact'
  | 'sqlite-database-missing'
  | 'sqlite-database-not-plain'
  | 'run-lock-invalid'
  | 'rpc-socket-invalid'
  | 'sqlite-corrupt'
  | 'sqlite-schema-mismatch'

const refusalMessages: Readonly<Record<ProfileSchemaRefusalReason, string>> = {
  'invalid-manifest': 'daemon profile schema manifest is invalid',
  'unsupported-platform': 'daemon profile inspection is unsupported on this platform',
  'profile-directory-not-plain': 'daemon profile directory is not a plain directory',
  'profile-permission-invalid': 'daemon profile ownership or permissions are invalid',
  'profile-identity-changed': 'daemon profile identity changed during inspection',
  'legacy-artifact': 'legacy daemon profile artifacts are not supported',
  'sqlite-sidecar-invalid': 'daemon profile SQLite crash artifacts are invalid',
  'unknown-artifact': 'daemon profile contains an unknown artifact',
  'sqlite-database-missing': 'daemon profile SQLite database is missing',
  'sqlite-database-not-plain': 'daemon profile SQLite database is not a plain file',
  'run-lock-invalid': 'daemon profile run lock is invalid',
  'rpc-socket-invalid': 'daemon profile RPC socket is invalid',
  'sqlite-corrupt': 'daemon profile SQLite database is corrupt or unreadable',
  'sqlite-schema-mismatch': 'daemon profile SQLite schema does not match',
}

export class ProfileSchemaRefusalError extends Error {
  readonly reason: ProfileSchemaRefusalReason

  constructor(reason: ProfileSchemaRefusalReason) {
    super(refusalMessages[reason])
    this.name = 'ProfileSchemaRefusalError'
    this.reason = reason
  }
}

export interface ProfileSchemaObject {
  readonly type: 'table' | 'index' | 'trigger'
  readonly name: string
  readonly tableName: string
  /**
   * The normalized sqlite_schema SQL. SQLite-owned automatic indexes are the
   * only objects whose expected SQL may be null.
   */
  readonly sql: string | null
}

export interface ProfileSchemaColumn {
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly notNull: boolean
  readonly defaultValue: string | null
  readonly primaryKeyPosition: number
  readonly hidden: number
}

export interface ProfileSchemaForeignKey {
  readonly id: number
  readonly sequence: number
  readonly table: string
  readonly from: string
  readonly to: string | null
  readonly onUpdate: string
  readonly onDelete: string
  readonly match: string
}

export interface ProfileSchemaTable {
  readonly name: string
  readonly strict: true
  readonly withoutRowId: boolean
  readonly columns: readonly ProfileSchemaColumn[]
  readonly foreignKeys: readonly ProfileSchemaForeignKey[]
}

export interface ProfileSchemaIndexColumn {
  readonly sequence: number
  readonly cid: number
  readonly name: string | null
  readonly descending: boolean
  readonly collation: string
  readonly key: boolean
}

export interface ProfileSchemaIndex {
  readonly name: string
  readonly tableName: string
  readonly unique: boolean
  readonly origin: 'c' | 'u' | 'pk'
  readonly partial: boolean
  readonly columns: readonly ProfileSchemaIndexColumn[]
}

export type ProfileSchemaMarkerValue =
  | null
  | string
  | number
  | bigint
  | Uint8Array

export interface ProfileSchemaMarker {
  readonly name: string
  /** A single read-only SELECT with no statement separator. */
  readonly selectSql: string
  /** At least one exact row is required for every marker query. */
  readonly expectedRows: readonly Readonly<
    Record<string, ProfileSchemaMarkerValue>
  >[]
}

/**
 * Internal, nondeployable schema-description primitive. This module does not
 * declare a production manifest or authorize bootstrap/cutover. The later
 * bootstrap integration must provide one complete frozen manifest; validation
 * refuses an empty or partial value.
 *
 * @internal
 */
export interface ProfileSchemaManifest {
  readonly applicationId: number
  readonly userVersion: number
  readonly objects: readonly ProfileSchemaObject[]
  readonly tables: readonly ProfileSchemaTable[]
  readonly indexes: readonly ProfileSchemaIndex[]
  readonly markers: readonly ProfileSchemaMarker[]
}

export interface ValidatedProfileSchema {
  readonly inventory: DaemonProfileInventory
  readonly applicationId: number
  readonly userVersion: number
}

export async function inventoryDaemonProfile(
  directory: string,
): Promise<DaemonProfileInventory> {
  let directoryStat
  try {
    directoryStat = await lstat(directory, { bigint: true })
  } catch (error) {
    if (isNotFound(error)) {
      return emptyInventory(directory)
    }
    throw error
  }

  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return {
      ...emptyInventory(directory),
      directoryExists: true,
    }
  }

  const directoryRealPath = await realpath(directory)
  const directoryIdentity = pathIdentity(directoryStat, directoryRealPath)
  const entries = await readdir(directory, { withFileTypes: true })
  const artifacts = (
    await Promise.all(
      entries.map(async (entry): Promise<ProfileArtifact> => {
        const path = join(directory, entry.name)
        const entryStat = await lstat(path, { bigint: true })
        return {
          name: entry.name,
          kind: statKind(entryStat),
          identity: pathIdentity(
            entryStat,
            entryStat.isSymbolicLink() ? undefined : await realpath(path),
          ),
        }
      }),
    )
  ).sort(compareArtifacts)
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))
  const legacyArtifacts = LEGACY_DAEMON_PROFILE_ARTIFACTS
    .map((name) => byName.get(name))
    .filter(isDefined)
  const sqliteSidecars = DAEMON_PROFILE_SIDECARS
    .map((name) => byName.get(name))
    .filter(isDefined)

  return {
    directory,
    directoryExists: true,
    directoryIsPlain: true,
    directoryIdentity,
    artifacts,
    legacyArtifacts,
    sqliteDatabase: byName.get(DAEMON_PROFILE_DATABASE),
    sqliteSidecars,
    runLock: byName.get(DAEMON_RUN_LOCK),
    rpcSocket: byName.get(DAEMON_RPC_SOCKET),
    unknownArtifacts: artifacts.filter(
      (artifact) => !recognizedProfileArtifacts.has(artifact.name),
    ),
  }
}

export async function validateDaemonProfileSchema(
  directory: string,
  manifest: ProfileSchemaManifest,
): Promise<ValidatedProfileSchema> {
  assertCompleteProfileSchemaManifest(manifest)
  assertSupportedPlatform()
  const inventory = await inventoryDaemonProfile(directory)
  assertAdmissibleInventory(inventory)

  const databasePath = join(directory, DAEMON_PROFILE_DATABASE)
  const immutableUrl = pathToFileURL(databasePath)
  immutableUrl.searchParams.set('mode', 'ro')
  immutableUrl.searchParams.set('immutable', '1')

  let database: DatabaseSync
  try {
    database = new DatabaseSync(immutableUrl, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    })
  } catch {
    await assertProfileIdentityUnchanged(directory, inventory)
    throw new ProfileSchemaRefusalError('sqlite-corrupt')
  }

  let validationError: ProfileSchemaRefusalError | undefined
  try {
    validateOpenDatabase(database, manifest)
  } catch (error) {
    validationError =
      error instanceof ProfileSchemaRefusalError
        ? error
        : new ProfileSchemaRefusalError('sqlite-corrupt')
  } finally {
    database.close()
  }

  await assertProfileIdentityUnchanged(directory, inventory)
  if (validationError !== undefined) throw validationError

  return {
    inventory,
    applicationId: manifest.applicationId,
    userVersion: manifest.userVersion,
  }
}

export function assertCompleteProfileSchemaManifest(
  manifest: ProfileSchemaManifest,
): void {
  try {
    validateManifestShape(manifest)
  } catch {
    throw new ProfileSchemaRefusalError('invalid-manifest')
  }
}

export function normalizeSqliteSchemaSql(sql: string): string {
  let normalized = ''
  let quote: "'" | '"' | '`' | ']' | null = null
  let pendingSpace = false

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!
    if (quote !== null) {
      normalized += character
      if (character === quote) {
        const next = sql[index + 1]
        if (quote !== ']' && next === quote) {
          normalized += next
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if (/\s/.test(character)) {
      pendingSpace = normalized.length > 0
      continue
    }
    if (pendingSpace) {
      normalized += ' '
      pendingSpace = false
    }
    normalized += character
    if (character === "'" || character === '"' || character === '`') {
      quote = character
    } else if (character === '[') {
      quote = ']'
    }
  }

  return normalized.trim().replace(/;$/, '').trim()
}

function validateOpenDatabase(
  database: DatabaseSync,
  manifest: ProfileSchemaManifest,
): void {
  const quickCheck = database.prepare('PRAGMA quick_check(1)').all() as Record<
    string,
    unknown
  >[]
  if (
    quickCheck.length !== 1 ||
    Object.values(quickCheck[0] ?? {}).length !== 1 ||
    Object.values(quickCheck[0] ?? {})[0] !== 'ok'
  ) {
    throw new ProfileSchemaRefusalError('sqlite-corrupt')
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw new ProfileSchemaRefusalError('sqlite-corrupt')
  }

  const applicationId = readSinglePragmaNumber(database, 'application_id')
  const userVersion = readSinglePragmaNumber(database, 'user_version')
  if (
    applicationId !== manifest.applicationId ||
    userVersion !== manifest.userVersion
  ) {
    schemaMismatch()
  }

  validateSchemaObjects(database, manifest.objects)
  for (const table of manifest.tables) validateTable(database, table)
  validateIndexes(database, manifest)
  validateMarkers(database, manifest.markers)
}

function validateSchemaObjects(
  database: DatabaseSync,
  expected: readonly ProfileSchemaObject[],
): void {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
       ORDER BY type, name`,
    )
    .all() as {
    type: string
    name: string
    tableName: string
    sql: string | null
  }[]
  const actual = rows.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tableName,
    sql: row.sql === null ? null : normalizeSqliteSchemaSql(row.sql),
  }))
  const normalizedExpected = expected
    .map((object) => ({
      ...object,
      sql:
        object.sql === null ? null : normalizeSqliteSchemaSql(object.sql),
    }))
    .sort(compareSchemaObjects)

  actual.sort(compareSchemaObjects)
  if (!recordsEqual(actual, normalizedExpected)) schemaMismatch()
}

function validateTable(
  database: DatabaseSync,
  expected: ProfileSchemaTable,
): void {
  const tableList = database
    .prepare(`PRAGMA table_list(${quoteSqlString(expected.name)})`)
    .all() as {
    schema: string
    name: string
    type: string
    ncol: number
    wr: number
    strict: number
  }[]
  const table = tableList.find(
    (row) =>
      row.schema === 'main' &&
      row.name === expected.name &&
      row.type === 'table',
  )
  if (
    table === undefined ||
    table.strict !== 1 ||
    Boolean(table.wr) !== expected.withoutRowId ||
    table.ncol !== expected.columns.length
  ) {
    schemaMismatch()
  }

  const columns = database
    .prepare(`PRAGMA table_xinfo(${quoteSqlString(expected.name)})`)
    .all()
    .map((row) => {
      const column = row as {
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
        hidden: number
      }
      return {
        cid: column.cid,
        name: column.name,
        type: column.type,
        notNull: Boolean(column.notnull),
        defaultValue: column.dflt_value,
        primaryKeyPosition: column.pk,
        hidden: column.hidden,
      }
    })
  if (!recordsEqual(columns, expected.columns)) schemaMismatch()

  const foreignKeys = database
    .prepare(`PRAGMA foreign_key_list(${quoteSqlString(expected.name)})`)
    .all()
    .map((row) => {
      const foreignKey = row as {
        id: number
        seq: number
        table: string
        from: string
        to: string | null
        on_update: string
        on_delete: string
        match: string
      }
      return {
        id: foreignKey.id,
        sequence: foreignKey.seq,
        table: foreignKey.table,
        from: foreignKey.from,
        to: foreignKey.to,
        onUpdate: foreignKey.on_update,
        onDelete: foreignKey.on_delete,
        match: foreignKey.match,
      }
    })
  if (!recordsEqual(foreignKeys, expected.foreignKeys)) schemaMismatch()
}

function validateIndexes(
  database: DatabaseSync,
  manifest: ProfileSchemaManifest,
): void {
  for (const table of manifest.tables) {
    const expectedIndexes = manifest.indexes
      .filter((index) => index.tableName === table.name)
      .map(({ name, unique, origin, partial }) => ({
        name,
        unique,
        origin,
        partial,
      }))
      .sort(compareNamedRecords)
    const actualIndexes = database
      .prepare(`PRAGMA index_list(${quoteSqlString(table.name)})`)
      .all()
      .map((row) => {
        const index = row as {
          name: string
          unique: number
          origin: 'c' | 'u' | 'pk'
          partial: number
        }
        return {
          name: index.name,
          unique: Boolean(index.unique),
          origin: index.origin,
          partial: Boolean(index.partial),
        }
      })
      .sort(compareNamedRecords)
    if (!recordsEqual(actualIndexes, expectedIndexes)) schemaMismatch()
  }

  for (const expected of manifest.indexes) {
    const columns = database
      .prepare(`PRAGMA index_xinfo(${quoteSqlString(expected.name)})`)
      .all()
      .map((row) => {
        const column = row as {
          seqno: number
          cid: number
          name: string | null
          desc: number
          coll: string
          key: number
        }
        return {
          sequence: column.seqno,
          cid: column.cid,
          name: column.name,
          descending: Boolean(column.desc),
          collation: column.coll,
          key: Boolean(column.key),
        }
      })
    if (!recordsEqual(columns, expected.columns)) schemaMismatch()
  }
}

function validateMarkers(
  database: DatabaseSync,
  markers: readonly ProfileSchemaMarker[],
): void {
  for (const marker of markers) {
    const rows = database.prepare(marker.selectSql).all() as Readonly<
      Record<string, ProfileSchemaMarkerValue>
    >[]
    if (!recordsEqual(rows, marker.expectedRows)) schemaMismatch()
  }
}

function validateManifestShape(manifest: ProfileSchemaManifest): void {
  if (!isPositiveInt32(manifest.applicationId)) throw new Error()
  if (!Number.isSafeInteger(manifest.userVersion) || manifest.userVersion <= 0) {
    throw new Error()
  }
  if (
    manifest.objects.length === 0 ||
    manifest.tables.length === 0 ||
    manifest.markers.length === 0
  ) {
    throw new Error()
  }

  assertUniqueNames(manifest.objects)
  assertUniqueNames(manifest.tables)
  assertUniqueNames(manifest.indexes)
  assertUniqueNames(manifest.markers)

  const tableObjects = manifest.objects.filter(
    (object) => object.type === 'table',
  )
  const indexObjects = manifest.objects.filter(
    (object) => object.type === 'index',
  )
  if (
    tableObjects.length !== manifest.tables.length ||
    indexObjects.length !== manifest.indexes.length
  ) {
    throw new Error()
  }

  const tables = new Set(manifest.tables.map((table) => table.name))
  for (const object of manifest.objects) {
    if (
      object.name.length === 0 ||
      object.tableName.length === 0 ||
      !tables.has(object.tableName)
    ) {
      throw new Error()
    }
    if (object.type === 'table') {
      if (
        object.name !== object.tableName ||
        object.sql === null ||
        !/^CREATE TABLE\b/i.test(normalizeSqliteSchemaSql(object.sql)) ||
        !/\)\s*(?:STRICT(?:\s*,\s*WITHOUT ROWID)?|WITHOUT ROWID\s*,\s*STRICT)$/i.test(
          normalizeSqliteSchemaSql(object.sql),
        )
      ) {
        throw new Error()
      }
    } else if (object.type === 'index') {
      if (
        (object.sql === null &&
          !object.name.startsWith('sqlite_autoindex_')) ||
        (object.sql !== null &&
          !/^CREATE (?:UNIQUE )?INDEX\b/i.test(
            normalizeSqliteSchemaSql(object.sql),
          ))
      ) {
        throw new Error()
      }
    } else if (
      object.sql === null ||
      !/^CREATE TRIGGER\b/i.test(normalizeSqliteSchemaSql(object.sql))
    ) {
      throw new Error()
    }
  }

  for (const table of manifest.tables) {
    if (
      table.strict !== true ||
      table.columns.length === 0 ||
      !tableObjects.some((object) => object.name === table.name)
    ) {
      throw new Error()
    }
    assertUniqueNames(table.columns)
    if (
      table.columns.some(
        (column, index) =>
          column.cid !== index ||
          column.name.length === 0 ||
          column.type.length === 0,
      )
    ) {
      throw new Error()
    }
  }

  for (const index of manifest.indexes) {
    if (
      index.columns.length === 0 ||
      !tables.has(index.tableName) ||
      !indexObjects.some(
        (object) =>
          object.name === index.name && object.tableName === index.tableName,
      )
    ) {
      throw new Error()
    }
  }

  for (const marker of manifest.markers) {
    const sql = marker.selectSql.trim()
    if (
      marker.name.length === 0 ||
      marker.expectedRows.length === 0 ||
      !/^SELECT\b/i.test(sql) ||
      sql.includes(';')
    ) {
      throw new Error()
    }
  }
}

function assertAdmissibleInventory(inventory: DaemonProfileInventory): void {
  if (!inventory.directoryExists || !inventory.directoryIsPlain) {
    throw new ProfileSchemaRefusalError('profile-directory-not-plain')
  }
  if (inventory.legacyArtifacts.length > 0) {
    throw new ProfileSchemaRefusalError('legacy-artifact')
  }
  if (inventory.unknownArtifacts.length > 0) {
    throw new ProfileSchemaRefusalError('unknown-artifact')
  }
  if (inventory.sqliteDatabase === undefined) {
    throw new ProfileSchemaRefusalError('sqlite-database-missing')
  }
  if (inventory.sqliteDatabase.kind !== 'file') {
    throw new ProfileSchemaRefusalError('sqlite-database-not-plain')
  }
  const wal = inventory.sqliteSidecars.find(
    ({ name }) => name === `${DAEMON_PROFILE_DATABASE}-wal`,
  )
  const shm = inventory.sqliteSidecars.find(
    ({ name }) => name === `${DAEMON_PROFILE_DATABASE}-shm`,
  )
  if (
    (wal !== undefined && wal.kind !== 'file') ||
    (shm !== undefined && shm.kind !== 'file') ||
    (shm !== undefined && wal === undefined)
  ) {
    throw new ProfileSchemaRefusalError('sqlite-sidecar-invalid')
  }
  // The schema is frozen and checkpointed before funded work. A crash WAL may
  // therefore contain later data commits, but never a schema transition.
  // Immutable inspection intentionally validates the frozen main database;
  // the later fenced read/write open owns WAL recovery.
  if (inventory.runLock !== undefined && inventory.runLock.kind !== 'file') {
    throw new ProfileSchemaRefusalError('run-lock-invalid')
  }
  if (inventory.rpcSocket !== undefined && inventory.rpcSocket.kind !== 'socket') {
    throw new ProfileSchemaRefusalError('rpc-socket-invalid')
  }
  // Presence alone does not prove whether a lock/socket is live or stale.
  // Classification is non-mutating; lifecycle checks and cleanup belong to
  // the later runtime admission flow.
  assertOwnerOnlyProfile(inventory)
}

function emptyInventory(directory: string): DaemonProfileInventory {
  return {
    directory,
    directoryExists: false,
    directoryIsPlain: false,
    artifacts: [],
    legacyArtifacts: [],
    sqliteSidecars: [],
    unknownArtifacts: [],
  }
}

function assertSupportedPlatform(): void {
  if (process.platform === 'win32') {
    throw new ProfileSchemaRefusalError('unsupported-platform')
  }
}

function assertOwnerOnlyProfile(inventory: DaemonProfileInventory): void {
  const directoryIdentity = inventory.directoryIdentity
  const currentOwnerId =
    typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined
  if (
    directoryIdentity === undefined ||
    directoryIdentity.realPath === undefined ||
    currentOwnerId === undefined ||
    directoryIdentity.ownerId !== currentOwnerId ||
    (directoryIdentity.mode & 0o777) !== 0o700
  ) {
    throw new ProfileSchemaRefusalError('profile-permission-invalid')
  }

  for (const artifact of inventory.artifacts) {
    const { identity } = artifact
    if (
      identity.realPath === undefined ||
      identity.ownerId !== currentOwnerId ||
      (identity.mode & 0o077) !== 0 ||
      (identity.mode & 0o600) !== 0o600 ||
      identity.realPath !== join(directoryIdentity.realPath, artifact.name)
    ) {
      throw new ProfileSchemaRefusalError('profile-permission-invalid')
    }
  }
}

async function assertProfileIdentityUnchanged(
  directory: string,
  before: DaemonProfileInventory,
): Promise<void> {
  let after: DaemonProfileInventory
  try {
    after = await inventoryDaemonProfile(directory)
  } catch {
    throw new ProfileSchemaRefusalError('profile-identity-changed')
  }
  if (!recordsEqual(before, after)) {
    throw new ProfileSchemaRefusalError('profile-identity-changed')
  }
}

function readSinglePragmaNumber(
  database: DatabaseSync,
  pragma: 'application_id' | 'user_version',
): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as
    | Record<string, unknown>
    | undefined
  const values = Object.values(row ?? {})
  if (values.length !== 1 || typeof values[0] !== 'number') schemaMismatch()
  return values[0]
}

function recordsEqual(actual: unknown, expected: unknown): boolean {
  return canonicalValue(actual) === canonicalValue(expected)
}

function canonicalValue(value: unknown): string {
  if (value instanceof Uint8Array) {
    return framed('bytes', Buffer.from(value).toString('base64'))
  }
  if (typeof value === 'bigint') return framed('bigint', value.toString())
  if (Array.isArray(value)) {
    return framed('array', value.map(canonicalValue).join(''))
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    )
    return framed(
      'object',
      entries
        .map(
          ([key, entry]) =>
            `${framed('key', key)}${canonicalValue(entry)}`,
        )
        .join(''),
    )
  }
  return framed(typeof value, JSON.stringify(value))
}

function framed(type: string, value: string | undefined): string {
  const body = value ?? 'undefined'
  return `${type}:${body.length}:${body}`
}

function compareArtifacts(left: ProfileArtifact, right: ProfileArtifact): number {
  return left.name.localeCompare(right.name)
}

function compareSchemaObjects(
  left: { readonly type: string; readonly name: string },
  right: { readonly type: string; readonly name: string },
): number {
  return left.type.localeCompare(right.type) || left.name.localeCompare(right.name)
}

function compareNamedRecords(
  left: { name: string },
  right: { name: string },
): number {
  return left.name.localeCompare(right.name)
}

function assertUniqueNames(
  records: readonly {
    readonly name: string
  }[],
): void {
  if (new Set(records.map((record) => record.name)).size !== records.length) {
    throw new Error()
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function isPositiveInt32(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff
}

function schemaMismatch(): never {
  throw new ProfileSchemaRefusalError('sqlite-schema-mismatch')
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function pathIdentity(
  stat: {
    readonly dev: bigint
    readonly ino: bigint
    readonly uid: bigint
    readonly mode: bigint
    readonly size: bigint
    readonly mtimeNs: bigint
    readonly ctimeNs: bigint
  },
  resolvedPath: string | undefined,
): ProfilePathIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    ownerId: stat.uid,
    mode: Number(stat.mode & 0o7777n),
    size: stat.size,
    modifiedAtNanoseconds: stat.mtimeNs,
    changedAtNanoseconds: stat.ctimeNs,
    realPath: resolvedPath,
  }
}

function statKind(entry: {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isSocket(): boolean
}): ProfileArtifactKind {
  if (entry.isSymbolicLink()) return 'symbolic-link'
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'directory'
  if (entry.isSocket()) return 'socket'
  return 'other'
}
