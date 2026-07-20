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
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'
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
  assertDaemonStorageBindings,
  createDaemonSecrets,
  createDaemonSecretsFromImport,
  getOrCreateOrderEphemeralKeypair,
  readSecrets,
  secretsPath,
  updateSecrets,
  writeSecrets,
} from '../src/secrets.ts'
import {
  emptyDaemonState,
  initializeState,
  migrateDaemonStateStorageV1ToV2,
  statePath,
  writeState,
} from '../src/state.ts'
import {
  initializeDaemonStateV1MigrationFixtureForTest,
  replaceDaemonStateV2RecoveryWithV1FixtureForTest,
} from '../src/stateSqlite.ts'

const execFileAsync = promisify(execFile)

test('bitcaster-daemon init imports wallet seed and nostr key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const walletSeedHex = 'ab'.repeat(32)
  const nostrSecretKeyHex = '01'.padStart(64, '0')
  const walletSeedFile = join(home, 'wallet-seed.hex')
  const nostrSecretKeyFile = join(home, 'nostr-secret-key.hex')

  try {
    await writeFile(walletSeedFile, walletSeedHex, { mode: 0o600 })
    await writeFile(nostrSecretKeyFile, nostrSecretKeyHex, { mode: 0o600 })
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
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM daemon_profile').get()
          .count,
        1,
      )
      assert.equal(
        database
          .prepare('SELECT COUNT(*) AS count FROM daemon_identity_secrets')
          .get().count,
        1,
      )
      assert.equal(
        database
          .prepare('SELECT COUNT(*) AS count FROM daemon_order_ephemeral_keys')
          .get().count,
        0,
      )
      assert.equal(
        database
          .prepare('SELECT COUNT(*) AS count FROM daemon_state_metadata')
          .get().count,
        1,
      )
      const walletId = deriveDurableCustodyWalletId(
        Uint8Array.from(Buffer.from(walletSeedHex, 'hex')),
      )
      const custodyScope = database
        .prepare(
          `SELECT scope_id, scope_kind, wallet_id
             FROM custody_scopes`,
        )
        .get()
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM custody_scopes').get()
          .count,
        1,
      )
      assert.equal(
        custodyScope.scope_id,
        deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
      )
      assert.equal(custodyScope.scope_kind, 'wallet')
      assert.equal(custodyScope.wallet_id, walletId)
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM daemon_rpc_token').get()
          .count,
        1,
      )
      assert.equal(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM daemon_profile_initialization',
          )
          .get().count,
        1,
      )
    } finally {
      database.close()
    }
    for (const legacyName of [
      'daemon-profile.json',
      'daemon-secrets.json',
      'daemon-state.json',
      'daemon-rpc-token',
    ]) {
      await assert.rejects(() => stat(join(home, legacyName)), {
        code: 'ENOENT',
      })
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
    await writeFile(walletSeedFile, `${walletSeedHex}\n`, { mode: 0o600 })
    await writeFile(nostrSecretKeyFile, ` ${nostrSecretKeyHex}\n`, {
      mode: 0o600,
    })
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

test('bitcaster-daemon init rejects group-readable secret files', async () => {
  if (process.platform === 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-mode-'))
  const walletSeedFile = join(home, 'wallet-seed.hex')
  const nostrSecretKeyFile = join(home, 'nostr-secret-key.hex')
  try {
    await writeFile(walletSeedFile, 'ab'.repeat(32), { mode: 0o644 })
    await writeFile(nostrSecretKeyFile, '01'.padStart(64, '0'), {
      mode: 0o600,
    })
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          '--experimental-strip-types',
          join(import.meta.dirname, '..', 'src', 'main.ts'),
          'init',
          '--wallet-seed-hex-file',
          walletSeedFile,
          '--nostr-secret-key-hex-file',
          nostrSecretKeyFile,
        ],
        { env: { ...process.env, BITCASTER_DAEMON_HOME: home } },
      ),
      /must not be accessible by group or other users/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon init requires both private secret files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-init-source-'))
  const walletSeedHex = 'ab'.repeat(32)
  const walletSeedFile = join(home, 'wallet-seed.hex')

  try {
    await writeFile(walletSeedFile, `${walletSeedHex}\n`, { mode: 0o600 })
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            '--experimental-strip-types',
            join(import.meta.dirname, '..', 'src', 'main.ts'),
            'init',
            '--wallet-seed-hex-file',
            walletSeedFile,
          ],
          {
            env: {
              ...process.env,
              BITCASTER_DAEMON_HOME: home,
            },
          },
        ),
      /--wallet-seed-hex-file and --nostr-secret-key-hex-file must be supplied together/,
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
      mintUrl: 'https://mint-a.example',
      proof: {
        id: 'keyset-1',
        amount: 1,
        secret: 'proof-secret',
        C: 'proof-c',
      },
      unit: 'sat',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat' },
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
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-init-pending-key-'),
  )
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
      () =>
        runDaemonInit(home, {
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
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-init-missing-state-schema-'),
  )

  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
    try {
      database.exec('DROP TABLE daemon_state_metadata')
    } finally {
      database.close()
    }

    await assert.rejects(
      () =>
        runDaemonInit(home, {
        walletSeedHex: 'ab'.repeat(32),
        nostrSecretKeyHex: '01'.padStart(64, '0'),
        force: true,
      }),
      /daemon profile initialization is missing daemon_state_metadata/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an initialized daemon never repairs a removed mandatory table or singleton row', async () => {
  const mutations = [
    ...[
      'daemon_profile',
      'daemon_identity_secrets',
      'daemon_order_ephemeral_keys',
      'custody_schema_metadata',
      'daemon_state_metadata',
      'daemon_rpc_token',
      'daemon_profile_initialization',
    ].map((table) => ({
        name: `missing ${table} table`,
        remove(database: DatabaseSync) {
          database.exec(`DROP TABLE ${table}`)
        },
        remainsMissing(database: DatabaseSync) {
        return (
          database
            .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(table) === undefined
        )
        },
      })),
    ...[
      'daemon_profile',
      'daemon_identity_secrets',
      'custody_schema_metadata',
      'daemon_state_metadata',
      'daemon_rpc_token',
      'daemon_profile_initialization',
    ].map((table) => ({
        name: `missing ${table} row`,
        remove(database: DatabaseSync) {
          database.exec(`DELETE FROM ${table} WHERE singleton = 1`)
        },
        remainsMissing(database: DatabaseSync) {
        return (
          database
            .prepare(`SELECT 1 AS present FROM ${table} WHERE singleton = 1`)
            .get() === undefined
        )
        },
      })),
  ]

  for (const mutation of mutations) {
    const home = await mkdtemp(
      join(tmpdir(), 'bitcaster-daemon-init-incomplete-'),
    )
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

      await assert.rejects(() =>
        runDaemonInit(home, {
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
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-init-wiped-schema-'),
  )
  try {
    await runDaemonInit(home, {
      walletSeedHex: 'ab'.repeat(32),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
    const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
    try {
      for (const table of [
        'daemon_profile',
        'daemon_identity_secrets',
        'daemon_order_ephemeral_keys',
        'custody_active_work',
        'custody_verification_bindings',
        'custody_proof_reservations',
        'custody_session_links',
        'custody_operation_inputs',
        'custody_operations',
        'custody_scope_state',
        'custody_scopes',
        'custody_schema_metadata',
        'daemon_state_metadata',
        'daemon_rpc_token',
        'daemon_profile_initialization',
      ]) {
        database.exec(`DROP TABLE ${table}`)
      }
    } finally {
      database.close()
    }

    await assert.rejects(
      () =>
        execFileAsync(
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
        verify
          .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'daemon_profile'",
          )
          .get(),
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
      name: 'state schema marker',
      apply(database: DatabaseSync) {
        database.exec('PRAGMA ignore_check_constraints = ON')
        database
          .prepare(
            'UPDATE daemon_state_metadata SET schema_version = 99 WHERE singleton = 1',
          )
          .run()
      },
    },
    {
      name: 'RPC token',
      apply(database: DatabaseSync) {
        database.exec('PRAGMA ignore_check_constraints = ON')
        database
          .prepare('UPDATE daemon_rpc_token SET token = ? WHERE singleton = 1')
          .run('not-a-valid-rpc-token')
      },
    },
    {
      name: 'profile identity binding',
      apply(database: DatabaseSync) {
        database
          .prepare(
            'UPDATE daemon_profile SET nostr_public_key = ? WHERE singleton = 1',
          )
          .run('ff'.repeat(32))
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
      assert.doesNotMatch(
        result.stdout,
        /bitcaster-daemon listening/,
        corruption.name,
      )
      await assert.rejects(() => stat(join(home, 'daemon-run.lock')), {
        code: 'ENOENT',
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('daemon restart fails closed on missing or substituted live protocol keys', async () => {
  for (const corruption of ['missing', 'substituted'] as const) {
    const home = await mkdtemp(
      join(tmpdir(), `bitcaster-daemon-run-key-${corruption}-`),
    )
    const previousHome = process.env.BITCASTER_DAEMON_HOME
    try {
      await runDaemonInit(home, {
        walletSeedHex: 'ab'.repeat(32),
        nostrSecretKeyHex: '01'.padStart(64, '0'),
      })
      process.env.BITCASTER_DAEMON_HOME = home
      const secrets = await readSecrets()
      assert.ok(secrets)
      const retained = generateOrderEphemeralKeypair()
      secrets.orderEphemeralKeys['live-trade'] = {
        orderId: 'live-order',
        tradeId: 'live-trade',
        marketId: 'cond-YES',
        ...retained,
        createdAt: '2026-07-14T00:00:00.000Z',
      }
      await writeSecrets(secrets)
      const state = emptyDaemonState()
      state.swaps['live-trade'] = {
        tradeId: 'live-trade',
        orderId: 'live-order',
        marketId: 'cond-YES',
        role: 'seller',
        counterpartyPubkey: `03${'22'.repeat(32)}`,
        sellerLocktime: 120,
        buyerLocktime: 100,
        messages: {},
        step: 'opened',
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      }
      state.durableTradeSessions['live-trade'] = {
        schemaVersion: 2,
        revision: 0,
        tradeId: 'live-trade',
        role: 'seller',
        localProtocolPubkey: retained.publicKeyHex,
        counterpartyProtocolPubkey: `03${'22'.repeat(32)}`,
        mintUrl: (await readProfile())!.mintUrl,
        sellerLocktimeSecs: 120,
        buyerLocktimeSecs: 100,
        ephemeralKeyHandle: {
          keyId: 'live-trade',
          tradeId: 'live-trade',
          role: 'seller',
          localProtocolPubkey: retained.publicKeyHex,
          counterpartyProtocolPubkey: `03${'22'.repeat(32)}`,
          mintUrl: (await readProfile())!.mintUrl,
          sellerLocktimeSecs: 120,
          buyerLocktimeSecs: 100,
        },
        stage: 'intent',
        proofOperations: [],
        receivedCiphers: {},
        outboundCiphers: {},
      }
      await writeState(state)

      const database = new DatabaseSync(statePath())
      try {
        if (corruption === 'missing') {
          database.exec('PRAGMA foreign_keys = OFF')
          database
            .prepare('DELETE FROM daemon_order_ephemeral_keys WHERE key_id = ?')
            .run('live-trade')
        } else {
          const substituted = generateOrderEphemeralKeypair()
          database
            .prepare(
              `UPDATE daemon_order_ephemeral_keys
                SET private_key_hex = ?, public_key_hex = ?
              WHERE key_id = ?`,
            )
            .run(
              substituted.privateKeyHex,
              substituted.publicKeyHex,
              'live-trade',
            )
        }
      } finally {
        database.close()
      }

      const result = await runDaemonUntilExit(home)
      assert.notEqual(result.code, 0, corruption)
      assert.doesNotMatch(
        result.stdout,
        /bitcaster-daemon listening/,
        corruption,
      )
      await assert.rejects(() => stat(join(home, 'daemon-run.lock')), {
        code: 'ENOENT',
      })
    } finally {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('daemon startup rejects swap facts that conflict with retained session authority', async () => {
  const corruptions = [
    {
      name: 'role',
      mutate(swap: ReturnType<typeof emptyDaemonState>['swaps'][string]) {
        swap.role = 'buyer'
      },
    },
    {
      name: 'counterparty',
      mutate(swap: ReturnType<typeof emptyDaemonState>['swaps'][string]) {
        swap.counterpartyPubkey = `03${'44'.repeat(32)}`
      },
    },
    {
      name: 'seller-locktime',
      mutate(swap: ReturnType<typeof emptyDaemonState>['swaps'][string]) {
        swap.sellerLocktime = (swap.sellerLocktime ?? 0) + 1
      },
    },
    {
      name: 'buyer-locktime',
      mutate(swap: ReturnType<typeof emptyDaemonState>['swaps'][string]) {
        swap.buyerLocktime = (swap.buyerLocktime ?? 0) + 1
      },
    },
  ]

  for (const corruption of corruptions) {
    const home = await mkdtemp(
      join(tmpdir(), `bitcaster-daemon-startup-authority-${corruption.name}-`),
    )
    const previousHome = process.env.BITCASTER_DAEMON_HOME
    process.env.BITCASTER_DAEMON_HOME = home
    try {
      const tradeId = `trade-startup-authority-${corruption.name}`
      const orderId = `order-startup-authority-${corruption.name}`
      const mintUrl = 'https://mint.example'
      const counterpartyPubkey = `03${'22'.repeat(32)}`
      const sellerLocktimeSecs = 1_779_321_720
      const buyerLocktimeSecs = 1_779_321_660
      const retained = generateOrderEphemeralKeypair()
      const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
      secrets.orderEphemeralKeys[tradeId] = {
        orderId,
        tradeId,
        marketId: 'cond-YES',
        ...retained,
        createdAt: '2026-05-21T00:00:00.000Z',
      }
      await writeProfile({
        engineBaseUrl: 'https://engine.example',
        mintUrl,
        nostrPublicKey: secrets.nostrPublicKeyHex,
        initializedAt: '2026-05-21T00:00:00.000Z',
      })
      await writeSecrets(secrets)

      const state = emptyDaemonState()
      state.swaps[tradeId] = {
        tradeId,
        orderId,
        marketId: 'cond-YES',
        role: 'seller',
        counterpartyPubkey,
        sellerLocktime: sellerLocktimeSecs,
        buyerLocktime: buyerLocktimeSecs,
        messages: {},
        step: 'opened',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      state.durableTradeSessions[tradeId] = {
        schemaVersion: 2,
        revision: 0,
        tradeId,
        role: 'seller',
        localProtocolPubkey: retained.publicKeyHex,
        counterpartyProtocolPubkey: counterpartyPubkey,
        mintUrl,
        sellerLocktimeSecs,
        buyerLocktimeSecs,
        ephemeralKeyHandle: {
          keyId: tradeId,
          tradeId,
          role: 'seller',
          localProtocolPubkey: retained.publicKeyHex,
          counterpartyProtocolPubkey: counterpartyPubkey,
          mintUrl,
          sellerLocktimeSecs,
          buyerLocktimeSecs,
        },
        stage: 'intent',
        proofOperations: [],
        receivedCiphers: {},
        outboundCiphers: {},
      }
      await writeState(state)
      await assert.doesNotReject(() => assertDaemonStorageBindings())

      corruption.mutate(state.swaps[tradeId]!)
      await writeState(state)
      await assert.rejects(
        () => assertDaemonStorageBindings(),
        /protocol authority binding is invalid/,
        corruption.name,
      )
    } finally {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
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
      nostrPublicKey: 'ab'.repeat(32),
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

test('daemon secrets use typed strict rows without a monolithic encrypted payload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-typed-secrets-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home

  try {
    const secrets = createDaemonSecrets('2026-05-22T00:00:00.000Z')
    await writeSecrets(secrets)

    const database = new DatabaseSync(secretsPath())
    try {
      const row = database
        .prepare(
          `SELECT wallet_seed_hex, nostr_secret_key_hex
         FROM daemon_identity_secrets WHERE singleton = 1`,
        )
        .get()
      assert.equal(row.wallet_seed_hex, secrets.walletSeedHex)
      assert.equal(row.nostr_secret_key_hex, secrets.nostrSecretKeyHex)
      assert.equal(
        database
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'daemon_secrets'",
          )
          .get(),
        undefined,
      )
      for (const table of [
        'daemon_identity_secrets',
        'daemon_order_ephemeral_keys',
      ]) {
        assert.match(
          database
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(table).sql,
          /STRICT/,
        )
      }
    } finally {
    database.close()
    }
    assert.equal((await readSecrets())?.walletSeedHex, secrets.walletSeedHex)
  } finally {
    if (previousHome === undefined) {
      delete process.env.BITCASTER_DAEMON_HOME
    } else {
      process.env.BITCASTER_DAEMON_HOME = previousHome
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
    assert.deepEqual(Object.keys(secrets?.orderEphemeralKeys ?? {}).sort(), [
      'order-a',
      'order-b',
      'order-c',
    ])
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
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_identity_secrets SET wallet_seed_hex = ?
         WHERE singleton = 1`,
        )
        .run('not-a-seed')
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readSecrets(),
      /wallet seed must be a 32-byte hex string/,
    )

    await writeSecrets(secrets)

    const unknownColumn = new DatabaseSync(secretsPath())
    try {
      unknownColumn.exec(
        'ALTER TABLE daemon_identity_secrets ADD COLUMN unexpected_private_field TEXT',
      )
    } finally {
      unknownColumn.close()
      }
    await assert.rejects(
      () => readSecrets(),
      /daemon secrets schema is unsupported/,
    )

    await rm(secretsPath(), { force: true })
    await writeSecrets(secrets)
    const unknownKeyVersion = new DatabaseSync(secretsPath())
    try {
      unknownKeyVersion.exec('PRAGMA ignore_check_constraints = ON')
      unknownKeyVersion
        .prepare(
          `UPDATE daemon_order_ephemeral_keys SET schema_version = 2
         WHERE key_id = ?`,
        )
        .run('order-1')
    } finally {
      unknownKeyVersion.close()
    }
    await assert.rejects(
      () => readSecrets(),
      /daemon secrets schema is unsupported/,
    )

    await rm(secretsPath(), { force: true })
    await writeSecrets(secrets)
    const pairMismatch = new DatabaseSync(secretsPath())
    try {
      pairMismatch
        .prepare(
          `UPDATE daemon_order_ephemeral_keys SET public_key_hex = ?
         WHERE key_id = ?`,
        )
        .run(`02${'00'.repeat(32)}`, 'order-1')
    } finally {
      pairMismatch.close()
    }
    await assert.rejects(
      () => readSecrets(),
      /daemon secrets payload is malformed/,
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

test('daemon secrets reject a same-column table with weaker constraints', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-secrets-schema-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-07-12T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = {
      orderId: 'order-1',
      marketId: 'condition-YES',
      ...generateOrderEphemeralKeypair(),
      createdAt: '2026-07-12T00:00:00.000Z',
    }
    await writeSecrets(secrets)
    const database = new DatabaseSync(secretsPath())
    try {
      database.exec(`
        ALTER TABLE daemon_order_ephemeral_keys
          RENAME TO daemon_order_ephemeral_keys_strict;
        CREATE TABLE daemon_order_ephemeral_keys (
          key_id TEXT,
          schema_version INTEGER,
          order_id TEXT,
          trade_id TEXT,
          market_id TEXT,
          private_key_hex TEXT,
          public_key_hex TEXT,
          created_at TEXT
        ) STRICT;
        INSERT INTO daemon_order_ephemeral_keys
          SELECT * FROM daemon_order_ephemeral_keys_strict;
        INSERT INTO daemon_order_ephemeral_keys
          SELECT key_id, schema_version, order_id, trade_id, market_id,
                 private_key_hex, public_key_hex, created_at
            FROM daemon_order_ephemeral_keys_strict;
        DROP TABLE daemon_order_ephemeral_keys_strict;
      `)
    } finally {
      database.close()
    }
    await assert.rejects(
      () => readSecrets(),
      /daemon secrets schema is unsupported/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
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
    rpcToken = initialized
      .prepare('SELECT token FROM daemon_rpc_token WHERE singleton = 1')
      .get().token as string
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
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stdout=${stdout}; stderr=${stderr}`,
      )
    }
    child.kill('SIGTERM')
    const [code, signal] = (await once(child, 'exit')) as [
      number | null,
      string | null,
    ]
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
      () =>
        runDaemonInit(home, {
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

test('daemon run migrates a shipped v1 profile and preserves non-recovery rows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-v1-run-'))
  await runDaemonInit(home, {
    walletSeedHex: 'ab'.repeat(32),
    nostrSecretKeyHex: '01'.padStart(64, '0'),
  })
  const database = new DatabaseSync(join(home, 'daemon-state.sqlite'))
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database
      .prepare(
        `INSERT INTO daemon_keyset_counters (counter_key, counter_value)
         VALUES ('preserved-v1-counter', 41)`,
      )
      .run()
    replaceDaemonStateV2RecoveryWithV1FixtureForTest(database)
  } finally {
    database.close()
  }

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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  daemon.stdout.setEncoding('utf8')
  daemon.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  daemon.stderr.setEncoding('utf8')
  daemon.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = once(daemon, 'exit')
  try {
    await Promise.race([
      waitFor(() => stdout.includes('bitcaster-daemon listening')),
      exited.then(() => {
        throw new Error(`migrating daemon exited before listening: ${stderr}`)
      }),
    ])
    const migrated = new DatabaseSync(join(home, 'daemon-state.sqlite'))
    try {
      assert.equal(
        migrated
          .prepare(
            'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
          )
          .get()?.schema_version,
        2,
      )
      assert.equal(
        migrated
          .prepare(
            `SELECT counter_value FROM daemon_keyset_counters
              WHERE counter_key = 'preserved-v1-counter'`,
          )
          .get()?.counter_value,
        41,
      )
    } finally {
      migrated.close()
    }
  } finally {
    if (daemon.exitCode === null) daemon.kill('SIGTERM')
    await exited
    await rm(home, { recursive: true, force: true })
  }
})

test('an obsolete run-lock handle cannot authorize migration or release a successor owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-lock-owner-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const database = new DatabaseSync(profileDatabasePath())
    try {
      database.exec('PRAGMA foreign_keys = ON')
      initializeDaemonStateV1MigrationFixtureForTest(database)
    } finally {
      database.close()
    }

    const obsolete = await acquireDaemonRunLock()
    await rm(obsolete.path, { recursive: true, force: true })
    const successor = await acquireDaemonRunLock()
    await assert.rejects(
      () => migrateDaemonStateStorageV1ToV2(obsolete),
      /daemon profile run lock is not held/,
    )

    const unchanged = new DatabaseSync(profileDatabasePath())
    try {
      assert.equal(
        unchanged
          .prepare(
            'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
          )
          .get()?.schema_version,
        1,
      )
    } finally {
      unchanged.close()
    }
    await obsolete.release()
    await assert.rejects(
      () => acquireDaemonRunLock(),
      /bitcaster-daemon is already running for profile/,
    )
    await successor.release()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
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
  const walletSeedFile = join(home, 'test-wallet-seed.hex')
  const nostrSecretKeyFile = join(home, 'test-nostr-secret-key.hex')
  await writeFile(walletSeedFile, options.walletSeedHex, { mode: 0o600 })
  await writeFile(nostrSecretKeyFile, options.nostrSecretKeyHex, {
    mode: 0o600,
  })
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

async function runDaemonUntilExit(
  home: string,
): Promise<{ code: number | null; stdout: string }> {
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
        BITCASTER_DAEMON_PORT: String(
          43_871 + Math.floor(Math.random() * 10_000),
        ),
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
      setTimeout(() => resolve({ code: null, timedOut: true }), 5_000)
    }),
  ])
  if (result.timedOut) {
    child.kill('SIGTERM')
    await exited
    throw new Error('corrupt daemon unexpectedly remained running')
  }
  return { code: result.code, stdout }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for daemon run test condition')
}
