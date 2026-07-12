import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import {
  profileDatabasePath,
  readProfile,
  updateProfile,
  writeProfile,
} from '../src/profile.ts'
import { ensureRpcToken, readRpcToken } from '../src/rpcAuth.ts'
import { acquireDaemonRunLock, runLockPath } from '../src/runLock.ts'
import { generateOrderEphemeralKeypair } from '../src/ephemeralKey.ts'
import {
  createDaemonSecrets,
  createDaemonSecretsFromImport,
  getOrCreateOrderEphemeralKeypair,
  readSecrets,
  secretsPath,
  updateSecrets,
  writeSecrets,
} from '../src/secrets.ts'
import { emptyDaemonState, initializeState, statePath, writeState } from '../src/state.ts'

const execFileAsync = promisify(execFile)

test('bitcaster-daemon init imports wallet seed and nostr key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const walletSeedHex = 'ab'.repeat(32)
  const nostrSecretKeyHex = '01'.padStart(64, '0')

  try {
    await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'init',
        '--wallet-seed-hex',
        walletSeedHex,
        '--nostr-secret-key-hex',
        nostrSecretKeyHex,
        '--engine-url',
        'http://engine.example',
        '--mint-url',
        'http://mint.example',
      ],
      {
        env: {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
        },
      },
    )

    process.env.BITCASTER_DAEMON_HOME = home
    const secrets = await readSecrets()
    const profile = await readProfile()
    const rpcToken = await readRpcToken()
    assert.equal(secrets?.walletSeedHex, walletSeedHex)
    assert.equal(secrets?.nostrSecretKeyHex, nostrSecretKeyHex)
    assert.equal(
      profile?.nostrPublicKey,
      '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    )
    assert.equal(profile?.engineBaseUrl, 'http://engine.example')
    assert.equal(profile?.mintUrl, 'http://mint.example')
    assert.match(rpcToken ?? '', /^[A-Za-z0-9_-]{43}$/)
    const database = new DatabaseSync(profileDatabasePath())
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM daemon_profile').get().count, 1)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM daemon_secrets').get().count, 1)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM daemon_state').get().count, 1)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM daemon_rpc_token').get().count, 1)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM daemon_profile_initialization').get().count, 1)
    } finally {
      database.close()
    }
    for (const legacyName of [
      'daemon-profile.json',
      'daemon-secrets.json',
      'daemon-state.json',
      'daemon-rpc-token',
    ]) {
      await assert.rejects(() => stat(join(home, legacyName)), { code: 'ENOENT' })
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon imported nostr key preserves fixed 32-byte scalar width', () => {
  const secrets = createDaemonSecretsFromImport({
    walletSeedHex: 'ab'.repeat(32),
    nostrSecretKeyHex: '1',
  })

  assert.equal(secrets.nostrSecretKeyHex, '1'.padStart(64, '0'))
  assert.equal(
    secrets.nostrPublicKeyHex,
    '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  )
})

test('bitcaster-daemon init imports wallet seed and nostr key from files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-files-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const walletSeedHex = 'ab'.repeat(32)
  const nostrSecretKeyHex = '01'.padStart(64, '0')
  const walletSeedFile = join(home, 'wallet-seed.hex')
  const nostrSecretKeyFile = join(home, 'nostr-secret-key.hex')

  try {
    await writeFile(walletSeedFile, `${walletSeedHex}\n`)
    await writeFile(nostrSecretKeyFile, ` ${nostrSecretKeyHex}\n`)
    await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'init',
        '--wallet-seed-hex-file',
        walletSeedFile,
        '--nostr-secret-key-hex-file',
        nostrSecretKeyFile,
        '--engine-url',
        'http://engine.example',
        '--mint-url',
        'http://mint.example',
      ],
      {
        env: {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
        },
      },
    )

    process.env.BITCASTER_DAEMON_HOME = home
    const secrets = await readSecrets()
    const profile = await readProfile()
    assert.equal(secrets?.walletSeedHex, walletSeedHex)
    assert.equal(secrets?.nostrSecretKeyHex, nostrSecretKeyHex)
    assert.equal(profile?.engineBaseUrl, 'http://engine.example')
    assert.equal(profile?.mintUrl, 'http://mint.example')
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon init rejects mixed direct and file secret sources', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-source-'))
  const walletSeedHex = 'ab'.repeat(32)
  const nostrSecretKeyHex = '01'.padStart(64, '0')
  const walletSeedFile = join(home, 'wallet-seed.hex')

  try {
    await writeFile(walletSeedFile, `${walletSeedHex}\n`)
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            '--experimental-strip-types',
            join(import.meta.dirname, '..', 'src', 'main.ts'),
            'init',
            '--wallet-seed-hex',
            walletSeedHex,
            '--wallet-seed-hex-file',
            walletSeedFile,
            '--nostr-secret-key-hex',
            nostrSecretKeyHex,
          ],
          {
            env: {
              ...process.env,
              BITCASTER_DAEMON_HOME: home,
            },
          },
        ),
      /--wallet-seed-hex and --wallet-seed-hex-file are mutually exclusive/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon init --force refuses to replace keys over non-empty state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-force-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME

  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    process.env.BITCASTER_DAEMON_HOME = home
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      mintUrl: 'mint-a',
      proof: {
        amount: 1,
        secret: 'proof-secret',
        C: 'proof-c',
      },
      state: 'available',
      asset: { kind: 'sats' },
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
    })
    await writeState(state)

    await assert.rejects(
      () =>
        runDaemonInit(home, {
          walletSeedHex: 'cd'.repeat(32),
          nostrSecretKeyHex: '02'.padStart(64, '0'),
          force: true,
        }),
      /daemon state is not empty/,
    )
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon init --force refuses to replace retained pending protocol keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-pending-key-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME

  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    process.env.BITCASTER_DAEMON_HOME = home
    await getOrCreateOrderEphemeralKeypair({
      tradeId: 'trade-pending',
      orderId: 'order-pending',
      marketId: 'cond-YES',
    })

    await assert.rejects(
      () => runDaemonInit(home, {
        walletSeedHex: 'cd'.repeat(32),
        nostrSecretKeyHex: '02'.padStart(64, '0'),
        force: true,
      }),
      /daemon secrets retain ephemeral protocol keys/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon init preserves default engine and mint URLs when omitted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-defaults-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME

  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    process.env.BITCASTER_DAEMON_HOME = home
    const profile = await readProfile()
    assert.equal(profile?.engineBaseUrl, 'http://localhost:5000')
    assert.equal(profile?.mintUrl, 'http://localhost:8085')
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('an initialized daemon fails closed instead of recreating a missing state schema', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-missing-state-schema-'))

  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
    try {
      database.exec('DROP TABLE daemon_state')
    } finally {
      database.close()
    }

    await assert.rejects(
      () => runDaemonInit(home, {
        walletSeedHex: 'ab'.repeat(32),
        nostrSecretKeyHex: '01'.padStart(64, '0'),
        force: true,
      }),
      /daemon profile initialization is missing daemon_state/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an initialized daemon never repairs a removed mandatory table or singleton row', async () => {
  const mutations = [
    ...['daemon_profile', 'daemon_secrets', 'daemon_state', 'daemon_rpc_token', 'daemon_profile_initialization']
      .map((table) => ({
        name: `missing ${table} table`,
        remove(database: DatabaseSync) {
          database.exec(`DROP TABLE ${table}`)
        },
        remainsMissing(database: DatabaseSync) {
          return database.prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
          ).get(table) === undefined
        },
      })),
    ...['daemon_profile', 'daemon_secrets', 'daemon_state', 'daemon_rpc_token', 'daemon_profile_initialization']
      .map((table) => ({
        name: `missing ${table} row`,
        remove(database: DatabaseSync) {
          database.exec(`DELETE FROM ${table} WHERE singleton = 1`)
        },
        remainsMissing(database: DatabaseSync) {
          return database.prepare(`SELECT 1 AS present FROM ${table} WHERE singleton = 1`).get()
            === undefined
        },
      })),
  ]

  for (const mutation of mutations) {
    const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-incomplete-'))
    try {
      await runDaemonInit(home, {
        walletSeedHex: 'ab'.repeat(32),
        nostrSecretKeyHex: '01'.padStart(64, '0'),
      })
      const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
      try {
        mutation.remove(database)
      } finally {
        database.close()
      }

      await assert.rejects(
        () => runDaemonInit(home, {
          walletSeedHex: 'cd'.repeat(32),
          nostrSecretKeyHex: '02'.padStart(64, '0'),
          force: true,
        }),
      )

      const verify = new DatabaseSync(join(home, 'daemon-state.sqlite'))
      try {
        assert.equal(mutation.remainsMissing(verify), true, mutation.name)
      } finally {
        verify.close()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('an existing database with every profile table removed is never treated as a new profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-wiped-schema-'))
  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
    try {
      for (const table of [
        'daemon_profile',
        'daemon_secrets',
        'daemon_state',
        'daemon_rpc_token',
        'daemon_profile_initialization',
      ]) {
        database.exec(`DROP TABLE ${table}`)
      }
    } finally {
      database.close()
    }

    await assert.rejects(
      () => execFileAsync(
        process.execPath,
        [
          '--experimental-strip-types',
          join(import.meta.dirname, '..', 'src', 'main.ts'),
          'init',
        ],
        {
          env: {
            ...process.env,
            BITCASTER_DAEMON_HOME: home,
          },
        },
      ),
      /daemon profile storage is incomplete/,
    )

    const verify = new DatabaseSync(join(home, 'daemon-state.sqlite'))
    try {
      assert.equal(
        verify.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'daemon_profile'",
        ).get(),
        undefined,
      )
    } finally {
      verify.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon run fails closed before listening when decoded state or RPC authority is corrupt', async () => {
  const corruptions = [
    {
      name: 'state payload',
      apply(database: DatabaseSync) {
        database.prepare('UPDATE daemon_state SET payload = ? WHERE singleton = 1').run('{')
      },
    },
    {
      name: 'RPC token',
      apply(database: DatabaseSync) {
        database.prepare('UPDATE daemon_rpc_token SET token = ? WHERE singleton = 1')
          .run('not-a-valid-rpc-token')
      },
    },
  ]

  for (const corruption of corruptions) {
    const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-run-corrupt-'))
    try {
      await runDaemonInit(home, {
        walletSeedHex: 'ab'.repeat(32),
        nostrSecretKeyHex: '01'.padStart(64, '0'),
      })
      const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
      try {
        corruption.apply(database)
      } finally {
        database.close()
      }

      const result = await runDaemonUntilExit(home)
      assert.notEqual(result.code, 0, corruption.name)
      assert.doesNotMatch(result.stdout, /bitcaster-daemon listening/, corruption.name)
      await assert.rejects(() => stat(join(home, 'daemon-run.lock')), { code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('concurrent profile updates preserve both independent configuration fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-profile-update-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home

  try {
    await writeProfile({
      engineBaseUrl: 'http://engine.initial',
      mintUrl: 'http://mint.initial',
      initializedAt: '2026-07-12T00:00:00.000Z',
    })

    await Promise.all([
      updateProfile({ engineBaseUrl: 'http://engine.updated' }),
      updateProfile({ mintUrl: 'http://mint.updated' }),
    ])

    assert.deepEqual(await readProfile(), {
      engineBaseUrl: 'http://engine.updated',
      mintUrl: 'http://mint.updated',
      initializedAt: '2026-07-12T00:00:00.000Z',
    })
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon local storage repairs profile directory and file modes', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-modes-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home

  try {
    await chmod(home, 0o777)
    await writeProfile({
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'http://localhost:8085',
      initializedAt: '2026-05-22T00:00:00.000Z',
      nostrPublicKey: 'npub-test',
    })
    await writeSecrets(createDaemonSecrets('2026-05-22T00:00:00.000Z'))
    await initializeState()
    await writeState(emptyDaemonState())
    await ensureRpcToken()

    assert.equal((await stat(home)).mode & 0o777, 0o700)
    for (const path of [profileDatabasePath()]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600)
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon secrets are passphrase encrypted when configured', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-encrypted-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const previousPassphrase = process.env.BITCASTER_DAEMON_PASSPHRASE
  process.env.BITCASTER_DAEMON_HOME = home
  process.env.BITCASTER_DAEMON_PASSPHRASE = 'correct horse battery staple'

  try {
    const secrets = createDaemonSecrets('2026-05-22T00:00:00.000Z')
    await writeSecrets(secrets)

    const database = new DatabaseSync(secretsPath())
    const raw = database.prepare('SELECT payload FROM daemon_secrets WHERE singleton = 1').get()
      .payload as string
    database.close()
    assert.match(raw, /"protection":"passphrase-aes-256-gcm"/)
    assert.doesNotMatch(raw, new RegExp(secrets.walletSeedHex))
    assert.doesNotMatch(raw, new RegExp(secrets.nostrSecretKeyHex))
    assert.equal((await readSecrets())?.walletSeedHex, secrets.walletSeedHex)

    delete process.env.BITCASTER_DAEMON_PASSPHRASE
    await assert.rejects(
      () => readSecrets(),
      /BITCASTER_DAEMON_PASSPHRASE is required/,
    )
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    if (previousPassphrase === undefined) {
      delete process.env.BITCASTER_DAEMON_PASSPHRASE
    } else {
      process.env.BITCASTER_DAEMON_PASSPHRASE = previousPassphrase
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon secret updates preserve concurrent order ephemeral keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-secrets-race-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home

  try {
    await writeSecrets(createDaemonSecrets('2026-05-22T00:00:00.000Z'))
    const orderKeys = Object.fromEntries(
      ['order-a', 'order-b', 'order-c'].map((orderId) => [
        orderId,
        generateOrderEphemeralKeypair(),
      ]),
    )
    await Promise.all(
      ['order-a', 'order-b', 'order-c'].map((orderId) =>
        updateSecrets((secrets, now) => {
          secrets.orderEphemeralKeys[orderId] = {
            orderId,
            marketId: `cond-${orderId}`,
            ...orderKeys[orderId],
            createdAt: now,
          }
        }),
      ),
    )

    const secrets = await readSecrets()
    assert.deepEqual(
      Object.keys(secrets?.orderEphemeralKeys ?? {}).sort(),
      ['order-a', 'order-b', 'order-c'],
    )
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon secrets fail closed on missing or unknown private-key fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-secrets-strict-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home

  try {
    const secrets = createDaemonSecrets('2026-07-12T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      ...generateOrderEphemeralKeypair(),
      createdAt: '2026-07-12T00:00:00.000Z',
    }
    await writeSecrets(secrets)
    const database = new DatabaseSync(secretsPath())
    let originalPayload: string
    try {
      originalPayload = database.prepare(
        'SELECT payload FROM daemon_secrets WHERE singleton = 1',
      ).get().payload as string

      const missing = JSON.parse(originalPayload) as {
        secrets: Record<string, unknown>
      }
      delete missing.secrets.orderEphemeralKeys
      database.prepare('UPDATE daemon_secrets SET payload = ? WHERE singleton = 1')
        .run(JSON.stringify(missing))
    } finally {
      database.close()
    }
    await assert.rejects(() => readSecrets(), /daemon secrets payload is invalid/)

    const restore = new DatabaseSync(secretsPath())
    try {
      const unknown = JSON.parse(originalPayload) as {
        secrets: Record<string, unknown>
      }
      unknown.secrets.unexpectedPrivateField = 'must-not-default'
      restore.prepare('UPDATE daemon_secrets SET payload = ? WHERE singleton = 1')
        .run(JSON.stringify(unknown))
    } finally {
      restore.close()
    }
    await assert.rejects(() => readSecrets(), /daemon secrets payload is invalid/)

    const pairMismatch = new DatabaseSync(secretsPath())
    try {
      const invalidPair = JSON.parse(originalPayload) as {
        secrets: {
          orderEphemeralKeys: Record<string, { publicKeyHex: string }>
        }
      }
      invalidPair.secrets.orderEphemeralKeys['order-1'].publicKeyHex = `02${'00'.repeat(32)}`
      pairMismatch.prepare('UPDATE daemon_secrets SET payload = ? WHERE singleton = 1')
        .run(JSON.stringify(invalidPair))
    } finally {
      pairMismatch.close()
    }
    await assert.rejects(() => readSecrets(), /daemon secrets payload is malformed/)
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon run exits cleanly on SIGTERM', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-run-'))
  const port = 42_871 + Math.floor(Math.random() * 10_000)
  await runDaemonInit(home, {
    walletSeedHex: 'ab'.repeat(32),
    nostrSecretKeyHex: '01'.padStart(64, '0'),
  })
  const initialized = new DatabaseSync(join(home, 'daemon-state.sqlite'))
  let rpcToken: string
  try {
    rpcToken = initialized.prepare(
      'SELECT token FROM daemon_rpc_token WHERE singleton = 1',
    ).get().token as string
  } finally {
    initialized.close()
  }
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'run',
    ],
    {
      env: {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_DAEMON_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    try {
      await waitFor(async () => {
        if (!stdout.includes('bitcaster-daemon listening')) return false
        try {
          const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${rpcToken}`,
            },
            body: JSON.stringify({ method: 'health' }),
          })
          return response.ok
        } catch {
          return false
        }
      })
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stdout=${stdout}; stderr=${stderr}`)
    }
    child.kill('SIGTERM')
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null]
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.match(stderr, /received SIGTERM, shutting down/)
  } finally {
    if (!child.killed) child.kill('SIGTERM')
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon run rejects a second process for the same profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-run-lock-'))
  const portA = 52_871 + Math.floor(Math.random() * 10_000)
  const portB = 62_871 + Math.floor(Math.random() * 10_000)
  await runDaemonInit(home, {
    walletSeedHex: 'ab'.repeat(32),
    nostrSecretKeyHex: '01'.padStart(64, '0'),
  })
  const first = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'run',
    ],
    {
      env: {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_DAEMON_PORT: String(portA),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let firstStdout = ''
  first.stdout.setEncoding('utf8')
  first.stdout.on('data', (chunk) => {
    firstStdout += chunk
  })

  try {
    await waitFor(() => firstStdout.includes('bitcaster-daemon listening'))

    const second = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'run',
      ],
      {
        env: {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
          BITCASTER_DAEMON_PORT: String(portB),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    let secondStderr = ''
    second.stderr.setEncoding('utf8')
    second.stderr.on('data', (chunk) => {
      secondStderr += chunk
    })
    const [secondCode] = (await once(second, 'exit')) as [
      number | null,
      string | null,
    ]

    assert.notEqual(secondCode, 0)
    assert.match(
      secondStderr,
      /bitcaster-daemon is already running for profile/,
    )

    first.kill('SIGTERM')
    const [firstCode] = (await once(first, 'exit')) as [
      number | null,
      string | null,
    ]
    assert.equal(firstCode, 0)
    await waitFor(async () => {
      try {
        await stat(join(home, 'daemon-run.lock'))
        return false
      } catch (err) {
        return err instanceof Error && 'code' in err && err.code === 'ENOENT'
      }
    })
  } finally {
    if (!first.killed) first.kill('SIGTERM')
    await rm(home, { recursive: true, force: true })
  }
})

test('init --force refuses while a daemon owns the profile lock', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-lock-'))
  const port = 36_871 + Math.floor(Math.random() * 10_000)
  await runDaemonInit(home, {
    walletSeedHex: 'ab'.repeat(32),
    nostrSecretKeyHex: '01'.padStart(64, '0'),
  })
  const daemon = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'run',
    ],
    {
      env: {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_DAEMON_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  daemon.stdout.setEncoding('utf8')
  daemon.stdout.on('data', (chunk) => {
    stdout += chunk
  })

  try {
    await waitFor(() => stdout.includes('bitcaster-daemon listening'))
    await assert.rejects(
      () => runDaemonInit(home, {
        walletSeedHex: 'cd'.repeat(32),
        nostrSecretKeyHex: '02'.padStart(64, '0'),
        force: true,
      }),
      /bitcaster-daemon is already running for profile/,
    )
  } finally {
    if (!daemon.killed) daemon.kill('SIGTERM')
    await once(daemon, 'exit')
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon run lock reclaims stale lock files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-stale-lock-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME

  try {
    process.env.BITCASTER_DAEMON_HOME = home
    await writeFile(
      runLockPath(),
      JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
    )

    const lock = await acquireDaemonRunLock()
    assert.equal(lock.path, join(home, 'daemon-run.lock'))
    await lock.release()
    await assert.rejects(stat(lock.path), { code: 'ENOENT' })
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
    }
    await rm(home, { recursive: true, force: true })
  }
})

async function runDaemonInit(
  home: string,
  options: {
    walletSeedHex: string
    nostrSecretKeyHex: string
    engineUrl?: string
    mintUrl?: string
    force?: boolean
  },
): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'init',
      '--wallet-seed-hex',
      options.walletSeedHex,
      '--nostr-secret-key-hex',
      options.nostrSecretKeyHex,
      ...(options.engineUrl ? ['--engine-url', options.engineUrl] : []),
      ...(options.mintUrl ? ['--mint-url', options.mintUrl] : []),
      ...(options.force ? ['--force'] : []),
    ],
    {
      env: {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
      },
    },
  )
}

async function runDaemonUntilExit(home: string): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'run',
    ],
    {
      env: {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_DAEMON_PORT: String(43_871 + Math.floor(Math.random() * 10_000)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const exited = once(child, 'exit') as Promise<[number | null, string | null]>
  const result = await Promise.race([
    exited.then(([code]) => ({ code, timedOut: false })),
    new Promise<{ code: null; timedOut: true }>((resolve) => {
      setTimeout(() => resolve({ code: null, timedOut: true }), 1_000)
    }),
  ])
  if (result.timedOut) {
    child.kill('SIGTERM')
    await exited
    throw new Error('corrupt daemon unexpectedly remained running')
  }
  return { code: result.code, stdout }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for daemon run test condition')
}
