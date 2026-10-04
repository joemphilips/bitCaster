import { DatabaseSync } from 'node:sqlite'

process.umask(0o077)
const database = new DatabaseSync(process.argv[2])
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA wal_autocheckpoint = 0;
`)
const write = database.prepare(
  'INSERT OR REPLACE INTO daemon_bookmark_preferences VALUES (1, ?, NULL, 1, ?, 1)',
)
const large = JSON.stringify(
  Array.from({ length: 20_000 }, (_, index) => index.toString(16).padStart(64, '0')),
)
switch (process.argv[3] ?? 'checkpoint') {
  case 'schema-lock':
    database.exec(`
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      CREATE TABLE uncommitted_schema_probe (value INTEGER NOT NULL) STRICT;
    `)
    process.stdout.write('ready\n')
    setTimeout(() => {
      database.exec('ROLLBACK')
      database.close()
    }, 250)
    break
  case 'checkpoint':
    process.stdout.write('ready\n')
    for (let revision = 0; revision < 80; revision += 1) {
      database.exec('BEGIN IMMEDIATE')
      write.run(large, revision * 2)
      database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); BEGIN IMMEDIATE')
      write.run('[]', revision * 2 + 1)
      database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    }
    database.close()
    break
  default:
    throw new Error('unsupported SQLite writer fixture mode')
}
