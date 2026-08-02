import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { profilePath, readProfile, writeProfile } from '../src/profile.ts'
import { ensureRpcToken, readRpcToken, rpcTokenPath } from '../src/rpcAuth.ts'
import { acquireDaemonRunLock, runLockPath } from '../src/runLock.ts'
import {
  createDaemonSecretsFromImport,
  readSecrets,
  secretsPath,
  writeSecrets,
} from '../src/secrets.ts'

const execFileAsync = promisify(execFile)
const mainPath = join(import.meta.dirname, '..', 'src', 'main.ts')
const walletSeedHex = 'ab'.repeat(32)
const nostrSecretKeyHex = '01'.padStart(64, '0')

test('fresh init publishes one complete SQLite authority', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(home, {
      walletSeedHex,
      nostrSecretKeyHex,
      engineUrl: 'http://engine.example/',
      mintUrl: 'http://mint.example/',
    })

    await withDaemonHome(home, async () => {
      const profile = await readProfile()
      const secrets = await readSecrets()
      assert.equal(profile?.engineBaseUrl, 'http://engine.example')
      assert.equal(profile?.mintUrl, 'http://mint.example')
      assert.equal(
        profile?.nostrPublicKey,
        '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      )
      assert.equal(secrets?.walletSeedHex, walletSeedHex)
      assert.equal(secrets?.nostrSecretKeyHex, nostrSecretKeyHex)
      assert.match((await readRpcToken()) ?? '', /^[A-Za-z0-9_-]{43}$/)
      assert.equal(await ensureRpcToken(), await readRpcToken())
      assert.equal(profilePath(), secretsPath())
      assert.equal(profilePath(), rpcTokenPath())
    })

    assert.deepEqual(await readdir(home), ['daemon-state.sqlite'])
    if (process.platform !== 'win32') {
      assert.equal((await stat(home)).mode & 0o777, 0o700)
      assert.equal((await stat(join(home, 'daemon-state.sqlite'))).mode & 0o777, 0o600)
    }
  })
})

test('fresh init defaults endpoints and generates identity', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(home)
    await withDaemonHome(home, async () => {
      const profile = await readProfile()
      const secrets = await readSecrets()
      assert.equal(profile?.engineBaseUrl, 'http://localhost:5000')
      assert.equal(profile?.mintUrl, 'http://localhost:8085')
      assert.match(secrets?.walletSeedHex ?? '', /^[0-9a-f]{64}$/)
      assert.match(secrets?.nostrSecretKeyHex ?? '', /^[0-9a-f]{64}$/)
    })
  })
})

test('init refuses argv secrets and incomplete secret-file imports', async () => {
  await withFreshHome(async (home) => {
    await assert.rejects(
      () => runMain(home, ['init', '--wallet-seed-hex', walletSeedHex]),
      /Unknown init option: --wallet-seed-hex/,
    )
    const source = await createSecretSource({ walletSeedHex })
    try {
      await assert.rejects(
        () => runMain(home, ['init', '--wallet-seed-hex-file', source.walletSeedFile]),
        /must be supplied together/,
      )
    } finally {
      await rm(source.directory, { recursive: true, force: true })
    }
  })
})

test('init rejects unsafe and oversized secret files', async () => {
  if (process.platform === 'win32') return
  await withFreshHome(async (home) => {
    const source = await createSecretSource({
      walletSeedHex,
      nostrSecretKeyHex,
    })
    try {
      await chmod(source.walletSeedFile, 0o644)
      await assert.rejects(
        () =>
          runMain(home, [
            'init',
            '--wallet-seed-hex-file',
            source.walletSeedFile,
            '--nostr-secret-key-hex-file',
            source.nostrSecretKeyFile,
          ]),
        /must not be accessible by group or other users/,
      )
      await chmod(source.walletSeedFile, 0o600)
      await writeFile(source.walletSeedFile, 'a'.repeat(257), { mode: 0o600 })
      await assert.rejects(
        () =>
          runMain(home, [
            'init',
            '--wallet-seed-hex-file',
            source.walletSeedFile,
            '--nostr-secret-key-hex-file',
            source.nostrSecretKeyFile,
          ]),
        /exceeds 256 bytes/,
      )
    } finally {
      await rm(source.directory, { recursive: true, force: true })
    }
  })
})

test('init never overwrites or migrates an existing profile', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(home, { walletSeedHex, nostrSecretKeyHex })
    const before = await digestFile(join(home, 'daemon-state.sqlite'))

    await assert.rejects(
      () =>
        runDaemonInit(home, {
          walletSeedHex: 'cd'.repeat(32),
          nostrSecretKeyHex: '02'.padStart(64, '0'),
        }),
      /profile-not-fresh|fresh daemon profile/,
    )
    await assert.rejects(() => runMain(home, ['init', '--force']), /Unknown init option: --force/)
    assert.equal(await digestFile(join(home, 'daemon-state.sqlite')), before)
  })
})

test('passphrase protection keeps plaintext secrets out of SQLite', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(
      home,
      { walletSeedHex, nostrSecretKeyHex },
      { BITCASTER_DAEMON_PASSPHRASE: 'correct horse battery staple' },
    )
    const raw = await readFile(join(home, 'daemon-state.sqlite'))
    assert.equal(raw.includes(Buffer.from(walletSeedHex)), false)
    assert.equal(raw.includes(Buffer.from(nostrSecretKeyHex)), false)

    await withDaemonHome(
      home,
      async () => {
        assert.equal((await readSecrets())?.walletSeedHex, walletSeedHex)
        delete process.env.BITCASTER_DAEMON_PASSPHRASE
        await assert.rejects(() => readSecrets(), /daemon profile passphrase is required/)
      },
      { BITCASTER_DAEMON_PASSPHRASE: 'correct horse battery staple' },
    )
  })
})

test('separate authority writers cannot recreate legacy files', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(home, { walletSeedHex, nostrSecretKeyHex })
    await withDaemonHome(home, async () => {
      await assert.rejects(
        () =>
          writeProfile({
            engineBaseUrl: 'http://replacement.invalid',
            mintUrl: 'http://replacement.invalid',
            initializedAt: new Date().toISOString(),
          }),
        /fresh atomic init/,
      )
      await assert.rejects(
        () =>
          writeSecrets(
            createDaemonSecretsFromImport({
              walletSeedHex,
              nostrSecretKeyHex,
            }),
          ),
        /immutable after fresh atomic init/,
      )
    })
    assert.deepEqual(await readdir(home), ['daemon-state.sqlite'])
  })
})

test('read helpers fail closed for a symlinked profile path', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-symlink-'))
  const target = join(root, 'target')
  const home = join(root, 'profile')
  try {
    await mkdir(target, { mode: 0o700 })
    await symlink(target, home)
    await withDaemonHome(home, async () => {
      await assert.rejects(() => readProfile(), /plain directory/)
      await assert.rejects(() => readSecrets(), /plain directory/)
      await assert.rejects(() => readRpcToken(), /plain directory/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('run lock is exclusive, stale-reclaimable, and identity-bound', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(home, { walletSeedHex, nostrSecretKeyHex })
    await withDaemonHome(home, async () => {
      const first = await acquireDaemonRunLock()
      await assert.rejects(() => acquireDaemonRunLock(), /already running for profile/)
      await first.release()

      await writeFile(
        runLockPath(),
        JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
        { mode: 0o600 },
      )
      const reclaimed = await acquireDaemonRunLock()
      assert.equal(reclaimed.path, join(home, 'daemon-run.lock'))
      await reclaimed.release()
      await assert.rejects(stat(reclaimed.path), { code: 'ENOENT' })
    })
  })
})

test('secret authority row uses passphrase encryption metadata', async () => {
  await withFreshHome(async (home) => {
    await runDaemonInit(
      home,
      { walletSeedHex, nostrSecretKeyHex },
      { BITCASTER_DAEMON_PASSPHRASE: 'passphrase' },
    )
    const database = new DatabaseSync(join(home, 'daemon-state.sqlite'), {
      readOnly: true,
    })
    try {
      const row = database
        .prepare(
          `SELECT protection, kdf, salt, iv, auth_tag AS authTag
           FROM daemon_secret_authority WHERE singleton = 1`,
        )
        .get() as Record<string, unknown>
      assert.equal(row.protection, 'scrypt-aes-256-gcm')
      assert.equal(row.kdf, 'scrypt-v1')
      assert.ok(ArrayBuffer.isView(row.salt))
      assert.ok(ArrayBuffer.isView(row.iv))
      assert.ok(ArrayBuffer.isView(row.authTag))
    } finally {
      database.close()
    }
  })
})

async function runDaemonInit(
  home: string,
  secrets?: {
    walletSeedHex: string
    nostrSecretKeyHex: string
    engineUrl?: string
    mintUrl?: string
  },
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  if (secrets === undefined) {
    await runMain(home, ['init'], extraEnv)
    return
  }
  const source = await createSecretSource(secrets)
  try {
    const args = [
      'init',
      '--wallet-seed-hex-file',
      source.walletSeedFile,
      '--nostr-secret-key-hex-file',
      source.nostrSecretKeyFile,
    ]
    if (secrets.engineUrl) args.push('--engine-url', secrets.engineUrl)
    if (secrets.mintUrl) args.push('--mint-url', secrets.mintUrl)
    await runMain(home, args, extraEnv)
  } finally {
    await rm(source.directory, { recursive: true, force: true })
  }
}

async function runMain(
  home: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', mainPath, '--datadir', home, ...args],
    {
      env: {
        ...process.env,
        ...extraEnv,
      },
    },
  )
}

async function createSecretSource(input: {
  walletSeedHex: string
  nostrSecretKeyHex?: string
}): Promise<{
  directory: string
  walletSeedFile: string
  nostrSecretKeyFile: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-source-'))
  const walletSeedFile = join(directory, 'wallet-seed.hex')
  const nostrSecretKeyFile = join(directory, 'nostr-secret-key.hex')
  await writeFile(walletSeedFile, input.walletSeedHex, { mode: 0o600 })
  if (input.nostrSecretKeyHex !== undefined) {
    await writeFile(nostrSecretKeyFile, input.nostrSecretKeyHex, { mode: 0o600 })
  }
  return { directory, walletSeedFile, nostrSecretKeyFile }
}

async function withFreshHome(run: (home: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-test-'))
  const home = join(root, 'profile')
  try {
    await run(home)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withDaemonHome(
  home: string,
  run: () => Promise<void>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  const previous = {
    home: process.env.BITCASTER_DAEMON_HOME,
    passphrase: process.env.BITCASTER_DAEMON_PASSPHRASE,
  }
  process.env.BITCASTER_DAEMON_HOME = home
  if (extraEnv.BITCASTER_DAEMON_PASSPHRASE === undefined) {
    delete process.env.BITCASTER_DAEMON_PASSPHRASE
  } else {
    process.env.BITCASTER_DAEMON_PASSPHRASE = extraEnv.BITCASTER_DAEMON_PASSPHRASE
  }
  try {
    await run()
  } finally {
    restoreEnv('BITCASTER_DAEMON_HOME', previous.home)
    restoreEnv('BITCASTER_DAEMON_PASSPHRASE', previous.passphrase)
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function digestFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
