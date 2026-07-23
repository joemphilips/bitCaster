import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  DAEMON_PROFILE_DATABASE,
  DAEMON_PROFILE_SIDECARS,
  DAEMON_RPC_SOCKET,
  DAEMON_RUN_LOCK,
  LEGACY_DAEMON_PROFILE_ARTIFACTS,
  ProfileSchemaRefusalError,
  assertCompleteProfileSchemaManifest,
  inventoryDaemonProfile,
  normalizeSqliteSchemaSql,
  validateDaemonProfileSchema,
  type ProfileSchemaManifest,
} from '../src/profileSchema.ts'

const APPLICATION_ID = 0x4243444d
const USER_VERSION = 7

const markerTableSql = `
  CREATE TABLE profile_schema_marker (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    schema_name TEXT NOT NULL CHECK (schema_name = 'bitcaster-daemon'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 7)
  ) STRICT
`

const walletScopeTableSql = `
  CREATE TABLE wallet_scope (
    row_id INTEGER PRIMARY KEY NOT NULL,
    scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
    marker_singleton INTEGER NOT NULL DEFAULT 1 CHECK (marker_singleton = 1),
    epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
    FOREIGN KEY (marker_singleton)
      REFERENCES profile_schema_marker(singleton)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT
  ) STRICT
`

const walletScopeIndexSql = `
  CREATE UNIQUE INDEX wallet_scope_digest_uq
  ON wallet_scope(scope_digest COLLATE BINARY ASC)
  WHERE epoch >= 0
`

const markerTriggerSql = `
  CREATE TRIGGER profile_schema_marker_no_delete
  BEFORE DELETE ON profile_schema_marker
  BEGIN
    SELECT RAISE(ABORT, 'profile schema marker is immutable');
  END
`

const fixtureManifest: ProfileSchemaManifest = {
  applicationId: APPLICATION_ID,
  userVersion: USER_VERSION,
  objects: [
    {
      type: 'index',
      name: 'wallet_scope_digest_uq',
      tableName: 'wallet_scope',
      sql: walletScopeIndexSql,
    },
    {
      type: 'table',
      name: 'profile_schema_marker',
      tableName: 'profile_schema_marker',
      sql: markerTableSql,
    },
    {
      type: 'table',
      name: 'wallet_scope',
      tableName: 'wallet_scope',
      sql: walletScopeTableSql,
    },
    {
      type: 'trigger',
      name: 'profile_schema_marker_no_delete',
      tableName: 'profile_schema_marker',
      sql: markerTriggerSql,
    },
  ],
  tables: [
    {
      name: 'profile_schema_marker',
      strict: true,
      withoutRowId: false,
      columns: [
        {
          cid: 0,
          name: 'singleton',
          type: 'INTEGER',
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 1,
          hidden: 0,
        },
        {
          cid: 1,
          name: 'schema_name',
          type: 'TEXT',
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 0,
          hidden: 0,
        },
        {
          cid: 2,
          name: 'schema_version',
          type: 'INTEGER',
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 0,
          hidden: 0,
        },
      ],
      foreignKeys: [],
    },
    {
      name: 'wallet_scope',
      strict: true,
      withoutRowId: false,
      columns: [
        {
          cid: 0,
          name: 'row_id',
          type: 'INTEGER',
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 1,
          hidden: 0,
        },
        {
          cid: 1,
          name: 'scope_digest',
          type: 'TEXT',
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 0,
          hidden: 0,
        },
        {
          cid: 2,
          name: 'marker_singleton',
          type: 'INTEGER',
          notNull: true,
          defaultValue: '1',
          primaryKeyPosition: 0,
          hidden: 0,
        },
        {
          cid: 3,
          name: 'epoch',
          type: 'INTEGER',
          notNull: true,
          defaultValue: '0',
          primaryKeyPosition: 0,
          hidden: 0,
        },
      ],
      foreignKeys: [
        {
          id: 0,
          sequence: 0,
          table: 'profile_schema_marker',
          from: 'marker_singleton',
          to: 'singleton',
          onUpdate: 'RESTRICT',
          onDelete: 'RESTRICT',
          match: 'NONE',
        },
      ],
    },
  ],
  indexes: [
    {
      name: 'wallet_scope_digest_uq',
      tableName: 'wallet_scope',
      unique: true,
      origin: 'c',
      partial: true,
      columns: [
        {
          sequence: 0,
          cid: 1,
          name: 'scope_digest',
          descending: false,
          collation: 'BINARY',
          key: true,
        },
        {
          sequence: 1,
          cid: -1,
          name: null,
          descending: false,
          collation: 'BINARY',
          key: false,
        },
      ],
    },
  ],
  markers: [
    {
      name: 'profile-schema-identity',
      selectSql: `
        SELECT singleton, schema_name AS schemaName,
               schema_version AS schemaVersion
        FROM profile_schema_marker
        ORDER BY singleton
      `,
      expectedRows: [
        {
          singleton: 1,
          schemaName: 'bitcaster-daemon',
          schemaVersion: USER_VERSION,
        },
      ],
    },
  ],
}

test('inventory identifies every legacy artifact and SQLite candidate without mutation', async (t) => {
  const directory = await temporaryProfile(t)
  for (const artifact of LEGACY_DAEMON_PROFILE_ARTIFACTS) {
    await writeFile(join(directory, artifact), `legacy:${artifact}`)
  }
  await writeFile(join(directory, DAEMON_PROFILE_DATABASE), 'candidate')
  await writeFile(join(directory, DAEMON_PROFILE_SIDECARS[0]), 'wal')
  await writeFile(join(directory, 'unknown.private'), 'unknown')
  const before = await snapshotDirectory(directory)

  const inventory = await inventoryDaemonProfile(directory)

  assert.deepEqual(
    inventory.legacyArtifacts.map(({ name }) => name),
    [...LEGACY_DAEMON_PROFILE_ARTIFACTS],
  )
  assert.equal(inventory.sqliteDatabase?.name, DAEMON_PROFILE_DATABASE)
  assert.deepEqual(
    inventory.sqliteSidecars.map(({ name }) => name),
    [DAEMON_PROFILE_SIDECARS[0]],
  )
  assert.deepEqual(
    inventory.unknownArtifacts.map(({ name }) => name),
    ['unknown.private'],
  )
  await assertDirectoryUnchanged(directory, before)
})

for (const legacyArtifact of LEGACY_DAEMON_PROFILE_ARTIFACTS) {
  test(`refuses ${legacyArtifact} byte-identically`, async (t) => {
    const directory = await temporaryProfile(t)
    await createFixtureDatabase(directory)
    await writeFile(join(directory, legacyArtifact), `legacy:${legacyArtifact}`)
    await assertByteIdenticalRefusal(
      directory,
      'legacy-artifact',
      fixtureManifest,
    )
  })
}

for (const crashState of ['committed', 'uncommitted'] as const) {
  test(`preflights a byte-identical ${crashState} WAL crash and leaves recovery to RW open`, async (t) => {
    const directory = await temporaryProfile(t)
    await createWalCrashFixture(directory, crashState)
    const before = await snapshotDirectory(directory)

    const result = await validateDaemonProfileSchema(directory, fixtureManifest)

    assert.deepEqual(
      result.inventory.sqliteSidecars.map(({ name }) => name),
      [...DAEMON_PROFILE_SIDECARS],
    )
    await assertDirectoryUnchanged(directory, before)

    const recoveryRoot = await temporaryProfile(t)
    const recoveryCopy = join(recoveryRoot, 'copy')
    await cp(directory, recoveryCopy, { recursive: true, force: true })
    const recovered = new DatabaseSync(
      join(recoveryCopy, DAEMON_PROFILE_DATABASE),
    )
    try {
      const row = recovered
        .prepare('SELECT count(*) AS count FROM wallet_scope')
        .get() as { count: number }
      assert.equal(row.count, crashState === 'committed' ? 1 : 0)
    } finally {
      recovered.close()
    }
  })
}

test('allows a WAL crash artifact without SHM', async (t) => {
  const directory = await temporaryProfile(t)
  await createWalCrashFixture(directory, 'committed')
  await unlink(join(directory, `${DAEMON_PROFILE_DATABASE}-shm`))
  const before = await snapshotDirectory(directory)

  const inventory = await validateDaemonProfileSchema(
    directory,
    fixtureManifest,
  )

  assert.deepEqual(
    inventory.inventory.sqliteSidecars.map(({ name }) => name),
    [`${DAEMON_PROFILE_DATABASE}-wal`],
  )
  await assertDirectoryUnchanged(directory, before)
})

test('refuses SHM without WAL byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory)
  await writeFile(join(directory, `${DAEMON_PROFILE_DATABASE}-shm`), 'shm', {
    mode: 0o600,
  })
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-sidecar-invalid',
    fixtureManifest,
  )
})

test('refuses non-file WAL and SHM crash artifacts', async (t) => {
  for (const sidecar of DAEMON_PROFILE_SIDECARS) {
    await t.test(sidecar, async (subtest) => {
      const directory = await temporaryProfile(subtest)
      await createFixtureDatabase(directory)
      if (sidecar.endsWith('-shm')) {
        await writeFile(
          join(directory, `${DAEMON_PROFILE_DATABASE}-wal`),
          'wal',
          { mode: 0o600 },
        )
      }
      await mkdir(join(directory, sidecar), { mode: 0o700 })
      await assertByteIdenticalRefusal(
        directory,
        'sqlite-sidecar-invalid',
        fixtureManifest,
      )
    })
  }
})

test('validates a complete exact schema through an immutable read-only connection', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory)
  const before = await snapshotDirectory(directory)

  const result = await validateDaemonProfileSchema(directory, fixtureManifest)

  assert.equal(result.applicationId, APPLICATION_ID)
  assert.equal(result.userVersion, USER_VERSION)
  assert.deepEqual(
    result.inventory.artifacts.map(({ name }) => name),
    [DAEMON_PROFILE_DATABASE],
  )
  await assertDirectoryUnchanged(directory, before)
})

test('classifies safe run-lock and RPC-socket lifecycle artifacts without cleanup', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory)
  await writeFile(join(directory, DAEMON_RUN_LOCK), '{"pid":1}\n', {
    mode: 0o600,
  })
  const socketPath = join(directory, DAEMON_RPC_SOCKET)
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    await chmod(socketPath, 0o600)
    const before = await snapshotDirectory(directory)

    const result = await validateDaemonProfileSchema(
      directory,
      fixtureManifest,
    )

    assert.equal(result.inventory.runLock?.kind, 'file')
    assert.equal(result.inventory.rpcSocket?.kind, 'socket')
    await assertDirectoryUnchanged(directory, before)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('fails closed on win32 before reading a profile path', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  assert.ok(descriptor)
  Object.defineProperty(process, 'platform', {
    ...descriptor,
    value: 'win32',
  })
  try {
    await assert.rejects(
      () =>
        validateDaemonProfileSchema(
          join(tmpdir(), 'must-not-be-inventoried'),
          fixtureManifest,
        ),
      (error) =>
        error instanceof ProfileSchemaRefusalError &&
        error.reason === 'unsupported-platform',
    )
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
})

test('refuses a dev/inode/realpath identity replacement during inspection', async (t) => {
  const directory = await temporaryProfile(t)
  const replacementDirectory = await temporaryProfile(t)
  await createFixtureDatabase(directory)
  await createFixtureDatabase(replacementDirectory)
  const replacementPath = join(
    replacementDirectory,
    DAEMON_PROFILE_DATABASE,
  )
  const databasePath = join(directory, DAEMON_PROFILE_DATABASE)
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { renameSync } from 'node:fs'
        process.stdout.write('ready\\n')
        setTimeout(
          () => renameSync(
            process.env.DAEMON_TEST_REPLACEMENT,
            process.env.DAEMON_TEST_DATABASE
          ),
          25
        )
      `,
    ],
    {
      env: {
        ...process.env,
        DAEMON_TEST_REPLACEMENT: replacementPath,
        DAEMON_TEST_DATABASE: databasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  await waitForChildReady(child)
  const slowManifest: ProfileSchemaManifest = {
    ...fixtureManifest,
    markers: [
      ...fixtureManifest.markers,
      {
        name: 'identity-race-delay',
        selectSql: `
          SELECT (
            WITH RECURSIVE counter(value) AS (
              VALUES (0)
              UNION ALL
              SELECT value + 1 FROM counter WHERE value < 2000000
            )
            SELECT sum(value) FROM counter
          ) AS checksum
        `,
        expectedRows: [{ checksum: 2_000_001_000_000 }],
      },
    ],
  }

  await assert.rejects(
    () => validateDaemonProfileSchema(directory, slowManifest),
    (error) =>
      error instanceof ProfileSchemaRefusalError &&
      error.reason === 'profile-identity-changed',
  )
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
})

test('requires Node 22.15 for immutable SQLite URL support', async () => {
  const daemonDirectory = join(import.meta.dirname, '..')
  const packageJson = JSON.parse(
    await readFile(join(daemonDirectory, 'package.json'), 'utf8'),
  ) as { engines?: { node?: unknown } }
  assert.equal(packageJson.engines?.node, '>=22.15')
  const packageLock = JSON.parse(
    await readFile(join(daemonDirectory, 'package-lock.json'), 'utf8'),
  ) as { packages?: { ''?: { engines?: { node?: unknown } } } }
  assert.equal(packageLock.packages?.['']?.engines?.node, '>=22.15')
  const workspaceLock = JSON.parse(
    await readFile(join(daemonDirectory, '..', 'package-lock.json'), 'utf8'),
  ) as {
    packages?: {
      'bitcaster-daemon'?: { engines?: { node?: unknown } }
    }
  }
  assert.equal(
    workspaceLock.packages?.['bitcaster-daemon']?.engines?.node,
    '>=22.15',
  )
})

test('refuses a missing database without creating the profile or database', async (t) => {
  const directory = await temporaryProfile(t)
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-database-missing',
    fixtureManifest,
  )
})

test('refuses unsafe owner-visible permission modes without chmod repair', async (t) => {
  for (const profilePart of ['directory', 'database', 'wal', 'lock'] as const) {
    await t.test(profilePart, async (subtest) => {
      const directory = await temporaryProfile(subtest)
      if (profilePart === 'wal') {
        await createWalCrashFixture(directory, 'committed')
      } else {
        await createFixtureDatabase(directory)
      }
      if (profilePart === 'lock') {
        await writeFile(join(directory, DAEMON_RUN_LOCK), 'lock', {
          mode: 0o640,
        })
      } else {
        const path =
          profilePart === 'directory'
            ? directory
            : join(
                directory,
                profilePart === 'database'
                  ? DAEMON_PROFILE_DATABASE
                  : `${DAEMON_PROFILE_DATABASE}-wal`,
              )
        await chmod(path, profilePart === 'directory' ? 0o750 : 0o640)
      }
      await assertByteIdenticalRefusal(
        directory,
        'profile-permission-invalid',
        fixtureManifest,
      )
    })
  }
})

test('refuses directory, database, sidecar, lock, and socket symlinks', async (t) => {
  const cases = [
    {
      name: 'directory',
      reason: 'profile-directory-not-plain',
      setup: async (directory: string, target: string) => {
        await symlink(target, join(directory, 'profile-link'), 'dir')
        return join(directory, 'profile-link')
      },
    },
    {
      name: 'database',
      reason: 'sqlite-database-not-plain',
      setup: async (directory: string, target: string) => {
        await symlink(
          join(target, DAEMON_PROFILE_DATABASE),
          join(directory, DAEMON_PROFILE_DATABASE),
        )
        return directory
      },
    },
    {
      name: 'wal',
      reason: 'sqlite-sidecar-invalid',
      setup: async (directory: string, target: string) => {
        await createFixtureDatabase(directory)
        await symlink(
          join(target, DAEMON_PROFILE_DATABASE),
          join(directory, `${DAEMON_PROFILE_DATABASE}-wal`),
        )
        return directory
      },
    },
    {
      name: 'lock',
      reason: 'run-lock-invalid',
      setup: async (directory: string, target: string) => {
        await createFixtureDatabase(directory)
        await symlink(
          join(target, DAEMON_PROFILE_DATABASE),
          join(directory, DAEMON_RUN_LOCK),
        )
        return directory
      },
    },
    {
      name: 'socket',
      reason: 'rpc-socket-invalid',
      setup: async (directory: string, target: string) => {
        await createFixtureDatabase(directory)
        await symlink(
          join(target, DAEMON_PROFILE_DATABASE),
          join(directory, DAEMON_RPC_SOCKET),
        )
        return directory
      },
    },
  ] as const

  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const directory = await temporaryProfile(subtest)
      const target = await temporaryProfile(subtest)
      await createFixtureDatabase(target)
      const inspectedPath = await testCase.setup(directory, target)
      const before = await snapshotDirectory(directory)
      await assert.rejects(
        () => validateDaemonProfileSchema(inspectedPath, fixtureManifest),
        (error) =>
          error instanceof ProfileSchemaRefusalError &&
          error.reason === testCase.reason,
      )
      await assertDirectoryUnchanged(directory, before)
    })
  }
})

test('refuses an unknown profile artifact byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory)
  await writeFile(join(directory, 'operator-note.txt'), 'must remain unchanged')
  await assertByteIdenticalRefusal(
    directory,
    'unknown-artifact',
    fixtureManifest,
  )
})

test('refuses a non-file SQLite candidate without traversing it', async (t) => {
  const directory = await temporaryProfile(t)
  await mkdir(join(directory, DAEMON_PROFILE_DATABASE))
  await writeFile(
    join(directory, DAEMON_PROFILE_DATABASE, 'authority'),
    'nested authority',
  )
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-database-not-plain',
    fixtureManifest,
  )
})

test('refuses corrupt SQLite bytes byte-identically and creates no sidecars', async (t) => {
  const directory = await temporaryProfile(t)
  await writeFile(
    join(directory, DAEMON_PROFILE_DATABASE),
    'not a SQLite database',
    { mode: 0o600 },
  )
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-corrupt',
    fixtureManifest,
  )
})

test('refuses a partial schema byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory, { omitWalletScope: true })
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-schema-mismatch',
    fixtureManifest,
  )
})

test('refuses an extra schema object byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory, {
    extraSql: 'CREATE TABLE unexpected_authority (id INTEGER NOT NULL) STRICT',
  })
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-schema-mismatch',
    fixtureManifest,
  )
})

test('refuses drifted STRICT and CHECK SQL byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory, {
    walletTableSql: walletScopeTableSql.replace(
      'CHECK (epoch >= 0)',
      'CHECK (epoch >= 1)',
    ),
  })
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-schema-mismatch',
    fixtureManifest,
  )
})

test('refuses a non-STRICT table byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory, {
    walletTableSql: walletScopeTableSql.replace(/\)\s*STRICT\s*$/, ')'),
  })
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-schema-mismatch',
    fixtureManifest,
  )
})

test('refuses persisted foreign-key violations as corrupt', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory)
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE), {
    enableForeignKeyConstraints: false,
  })
  try {
    database.exec('DROP TRIGGER profile_schema_marker_no_delete')
    database
      .prepare(
        `INSERT INTO wallet_scope
           (row_id, scope_digest, marker_singleton, epoch)
         VALUES (1, ?, 1, 0)`,
      )
      .run('a'.repeat(64))
    database.exec('DELETE FROM profile_schema_marker')
  } finally {
    database.close()
  }
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-corrupt',
    fixtureManifest,
  )
})

test('refuses drifted columns, foreign keys, indexes, and triggers', async (t) => {
  const drifts = [
    {
      name: 'column',
      transform: (manifest: ProfileSchemaManifest): ProfileSchemaManifest => ({
        ...manifest,
        tables: manifest.tables.map((table) =>
          table.name === 'wallet_scope'
            ? {
                ...table,
                columns: table.columns.map((column) =>
                  column.name === 'epoch'
                    ? { ...column, defaultValue: '1' }
                    : column,
                ),
              }
            : table,
        ),
      }),
    },
    {
      name: 'foreign-key',
      transform: (manifest: ProfileSchemaManifest): ProfileSchemaManifest => ({
        ...manifest,
        tables: manifest.tables.map((table) =>
          table.name === 'wallet_scope'
            ? {
                ...table,
                foreignKeys: table.foreignKeys.map((foreignKey) => ({
                  ...foreignKey,
                  onDelete: 'CASCADE',
                })),
              }
            : table,
        ),
      }),
    },
    {
      name: 'index-column',
      transform: (manifest: ProfileSchemaManifest): ProfileSchemaManifest => ({
        ...manifest,
        indexes: manifest.indexes.map((index) => ({
          ...index,
          columns: index.columns.map((column) =>
            column.key ? { ...column, descending: true } : column,
          ),
        })),
      }),
    },
    {
      name: 'trigger',
      transform: (manifest: ProfileSchemaManifest): ProfileSchemaManifest => ({
        ...manifest,
        objects: manifest.objects.map((object) =>
          object.type === 'trigger'
            ? {
                ...object,
                sql: object.sql?.replace(
                  'profile schema marker is immutable',
                  'different trigger',
                ) ?? null,
              }
            : object,
        ),
      }),
    },
  ] as const

  for (const drift of drifts) {
    await t.test(drift.name, async (subtest) => {
      const directory = await temporaryProfile(subtest)
      await createFixtureDatabase(directory)
      await assertByteIdenticalRefusal(
        directory,
        'sqlite-schema-mismatch',
        drift.transform(fixtureManifest),
      )
    })
  }
})

test('refuses wrong application and user versions byte-identically', async (t) => {
  for (const versionDrift of [
    { applicationId: APPLICATION_ID + 1 },
    { userVersion: USER_VERSION + 1 },
  ]) {
    await t.test(JSON.stringify(versionDrift), async (subtest) => {
      const directory = await temporaryProfile(subtest)
      await createFixtureDatabase(directory)
      await assertByteIdenticalRefusal(
        directory,
        'sqlite-schema-mismatch',
        { ...fixtureManifest, ...versionDrift },
      )
    })
  }
})

test('refuses a missing mandatory marker row byte-identically', async (t) => {
  const directory = await temporaryProfile(t)
  await createFixtureDatabase(directory, { omitMarker: true })
  await assertByteIdenticalRefusal(
    directory,
    'sqlite-schema-mismatch',
    fixtureManifest,
  )
})

test('rejects empty or partial deployment manifests before filesystem access', () => {
  for (const manifest of [
    { ...fixtureManifest, objects: [] },
    { ...fixtureManifest, tables: [] },
    { ...fixtureManifest, markers: [] },
    {
      ...fixtureManifest,
      markers: [{ ...fixtureManifest.markers[0]!, expectedRows: [] }],
    },
    {
      ...fixtureManifest,
      tables: fixtureManifest.tables.slice(1),
    },
  ]) {
    assert.throws(
      () => assertCompleteProfileSchemaManifest(manifest),
      (error) =>
        error instanceof ProfileSchemaRefusalError &&
        error.reason === 'invalid-manifest',
    )
  }
})

test('normalizes schema whitespace without changing quoted values', () => {
  assert.equal(
    normalizeSqliteSchemaSql(
      " CREATE   TABLE t (\n value TEXT CHECK(value = 'two  spaces')\n ) STRICT; ",
    ),
    "CREATE TABLE t ( value TEXT CHECK(value = 'two  spaces') ) STRICT",
  )
})

interface FixtureOptions {
  readonly omitMarker?: boolean
  readonly omitWalletScope?: boolean
  readonly walletTableSql?: string
  readonly extraSql?: string
  readonly walMode?: boolean
}

async function createFixtureDatabase(
  directory: string,
  options: FixtureOptions = {},
): Promise<void> {
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
    if (options.walMode) database.exec('PRAGMA journal_mode = WAL')
    database.exec(`
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${USER_VERSION};
      ${markerTableSql};
    `)
    if (!options.omitWalletScope) {
      database.exec(`
        ${options.walletTableSql ?? walletScopeTableSql};
        ${walletScopeIndexSql};
        ${markerTriggerSql};
      `)
    }
    if (!options.omitMarker) {
      database
        .prepare(
          `INSERT INTO profile_schema_marker
             (singleton, schema_name, schema_version)
           VALUES (1, 'bitcaster-daemon', ?)`,
        )
        .run(USER_VERSION)
    }
    if (options.extraSql !== undefined) database.exec(options.extraSql)
  } finally {
    database.close()
  }
  await chmod(join(directory, DAEMON_PROFILE_DATABASE), 0o600)
}

async function createWalCrashFixture(
  directory: string,
  crashState: 'committed' | 'uncommitted',
): Promise<void> {
  await createFixtureDatabase(directory, { walMode: true })
  const childScript = `
    import { DatabaseSync } from 'node:sqlite'
    process.umask(0o077)
    const database = new DatabaseSync(process.env.DAEMON_TEST_DATABASE)
    database.exec(
      'PRAGMA journal_mode = WAL;' +
      'PRAGMA synchronous = FULL;' +
      'PRAGMA wal_autocheckpoint = 0;' +
      'PRAGMA foreign_keys = ON;' +
      'PRAGMA cache_size = 1;'
    )
    database.exec('BEGIN IMMEDIATE')
    const insert = database.prepare(
      'INSERT INTO wallet_scope ' +
      '(row_id, scope_digest, marker_singleton, epoch) VALUES (?, ?, 1, 0)'
    )
    const count = process.env.DAEMON_TEST_CRASH_STATE === 'committed' ? 1 : 256
    for (let index = 1; index <= count; index += 1) {
      insert.run(index, index.toString(16).padStart(64, '0'))
    }
    if (process.env.DAEMON_TEST_CRASH_STATE === 'committed') {
      database.exec('COMMIT')
    }
    process.stdout.write('ready\\n')
    setInterval(() => undefined, 60_000)
  `
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', childScript],
    {
      env: {
        ...process.env,
        DAEMON_TEST_DATABASE: join(directory, DAEMON_PROFILE_DATABASE),
        DAEMON_TEST_CRASH_STATE: crashState,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  await waitForChildReady(child)
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))

  const artifacts = await readdir(directory)
  assert.ok(artifacts.includes(`${DAEMON_PROFILE_DATABASE}-wal`))
  assert.ok(artifacts.includes(`${DAEMON_PROFILE_DATABASE}-shm`))
  for (const artifact of [
    DAEMON_PROFILE_DATABASE,
    ...DAEMON_PROFILE_SIDECARS,
  ]) {
    await chmod(join(directory, artifact), 0o600)
  }
}

async function waitForChildReady(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let ready = false
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`WAL crash child timed out: ${stderr}`))
    }, 10_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (!stdout.includes('ready\n')) return
      ready = true
      clearTimeout(timeout)
      resolve()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (ready) return
      clearTimeout(timeout)
      reject(
        new Error(
          `WAL crash child exited before ready: code=${code} signal=${signal} ${stderr}`,
        ),
      )
    })
  })
}

interface DirectorySnapshot {
  readonly names: readonly string[]
  readonly directoryMode: number
  readonly entries: ReadonlyMap<
    string,
    {
      readonly mode: number
      readonly device: bigint
      readonly inode: bigint
      readonly size: bigint
      readonly modifiedAtNanoseconds: bigint
      readonly changedAtNanoseconds: bigint
    }
  >
  readonly files: ReadonlyMap<
    string,
    {
      readonly length: number
      readonly digest: string
      readonly bytes: Buffer
    }
  >
}

async function snapshotDirectory(
  directory: string,
): Promise<DirectorySnapshot> {
  const directoryStat = await lstat(directory, { bigint: true })
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )
  const files = new Map<
    string,
    { length: number; digest: string; bytes: Buffer }
  >()
  const entryIdentities = new Map<
    string,
    {
      mode: number
      device: bigint
      inode: bigint
      size: bigint
      modifiedAtNanoseconds: bigint
      changedAtNanoseconds: bigint
    }
  >()
  for (const entry of entries) {
    const entryStat = await lstat(join(directory, entry.name), { bigint: true })
    entryIdentities.set(entry.name, {
      mode: Number(entryStat.mode & 0o7777n),
      device: entryStat.dev,
      inode: entryStat.ino,
      size: entryStat.size,
      modifiedAtNanoseconds: entryStat.mtimeNs,
      changedAtNanoseconds: entryStat.ctimeNs,
    })
    if (!entry.isFile()) continue
    const bytes = await readFile(join(directory, entry.name))
    files.set(entry.name, {
      length: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    })
  }
  return {
    names: entries.map(({ name }) => name),
    directoryMode: Number(directoryStat.mode & 0o7777n),
    entries: entryIdentities,
    files,
  }
}

async function assertByteIdenticalRefusal(
  directory: string,
  reason: ProfileSchemaRefusalError['reason'],
  manifest: ProfileSchemaManifest,
): Promise<void> {
  const before = await snapshotDirectory(directory)
  await assert.rejects(
    () => validateDaemonProfileSchema(directory, manifest),
    (error) =>
      error instanceof ProfileSchemaRefusalError && error.reason === reason,
  )
  await assertDirectoryUnchanged(directory, before)
}

async function assertDirectoryUnchanged(
  directory: string,
  before: DirectorySnapshot,
): Promise<void> {
  const after = await snapshotDirectory(directory)
  assert.deepEqual(after.names, before.names)
  assert.equal(after.directoryMode, before.directoryMode)
  assert.deepEqual(after.entries, before.entries)
  assert.deepEqual([...after.files.keys()], [...before.files.keys()])
  for (const [name, expected] of before.files) {
    const actual = after.files.get(name)
    assert.equal(actual?.length, expected.length)
    assert.equal(actual?.digest, expected.digest)
    assert.ok(
      actual?.bytes.equals(expected.bytes),
      'profile artifact bytes changed during refused validation',
    )
  }
}

async function temporaryProfile(
  t: TestContext,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daemon-profile-schema-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}
