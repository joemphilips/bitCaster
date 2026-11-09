import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { configureDataDirForTest } from '../src/dataDir.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import {
  readBootstrappedProfileSecrets,
  readBootstrappedRpcToken,
} from '../src/profileBootstrap.ts'
import { DAEMON_PROFILE_DATABASE, validateDaemonProfileSchema } from '../src/profileSchema.ts'
import { getFinalProfileSchemaManifest } from '../src/profileSchemaManifest.ts'
import { readState } from '../src/state.ts'
import { readDaemonWalletBalance } from '../src/walletBalance.ts'

// Production daemon profiles are permanent (ADR-049). The fixture is the
// profile that the CLI release cli-v0.1.0-afaa6cc6aa6b (bitCaster 52d412a1)
// wrote: release4-profile-v16.sql holds its SQLite schema and rows, and
// release4-profile-v16.json holds its other files and the results of the
// shipped readers. A generator in a git archive export of 52d412a1 wrote the
// rows with the shipped writers: the bootstrap, two wallet proofs, a prepared
// send operation, a fenced custody cursor and proof, and an oracle creation. The current code must
// open this profile and read the same results. A schema change needs a
// forward-only upgrade that this test runs on open.

interface ShippedProfile {
  readonly files: readonly {
    readonly name: string
    readonly mode: number
    readonly text: string | null
  }[]
  readonly reads: {
    readonly secrets: unknown
    readonly rpcToken: string
    readonly state: unknown
    readonly walletBalance: unknown
    readonly oracleCreation: unknown
  }
}

const shipped = JSON.parse(
  await readFile(new URL('./fixtures/release4-profile-v16.json', import.meta.url), 'utf8'),
) as ShippedProfile
const shippedSql = await readFile(
  new URL('./fixtures/release4-profile-v16.sql', import.meta.url),
  'utf8',
)

const roots: string[] = []
after(async () => {
  configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** Writes the shipped profile directory without the current code. */
async function shippedProfileDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-release4-profile-'))
  roots.push(root)
  const directory = join(root, 'profile')
  await mkdir(directory, { mode: 0o700 })
  for (const file of shipped.files) {
    const path = join(directory, file.name)
    if (file.name === DAEMON_PROFILE_DATABASE) {
      const database = new DatabaseSync(path)
      try {
        database.exec(shippedSql)
      } finally {
        database.close()
      }
    } else {
      assert.notEqual(file.text, null, file.name)
      await writeFile(path, file.text!)
    }
    await chmod(path, file.mode)
  }
  return directory
}

/** Every row of every table, in a stable order. */
function readAllRows(directory: string) {
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE), { readOnly: true })
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    )
  } finally {
    database.close()
  }
}

test('the current daemon opens the shipped release 4 profile and reads every row', async () => {
  const directory = await shippedProfileDirectory()
  const before = readAllRows(directory)
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE), { readOnly: true })
  try {
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(
      (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      16,
    )
  } finally {
    database.close()
  }
  assert.ok(before.custody_proofs?.length === 1 && before.target_wallet_proofs?.length === 2)

  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  assert.deepEqual(await readBootstrappedProfileSecrets(directory), shipped.reads.secrets)
  assert.equal(await readBootstrappedRpcToken(directory), shipped.reads.rpcToken)
  configureDataDirForTest(() => directory)
  assert.deepEqual(await readState(), shipped.reads.state)
  assert.deepEqual(await readDaemonWalletBalance(directory), shipped.reads.walletBalance)
  assert.deepEqual(
    await createNativeOracleCreationStore(directory).readCreation('release4-oracle'),
    shipped.reads.oracleCreation,
  )

  assert.deepEqual(readAllRows(directory), before)
})
