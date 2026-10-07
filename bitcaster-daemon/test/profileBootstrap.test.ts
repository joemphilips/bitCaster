import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, mock, test, type TestContext } from 'node:test'
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
  readBootstrappedRpcToken,
  readLiveBootstrappedRpcToken,
  type ProfileBootstrapFaultPhase,
} from '../src/profileBootstrap.ts'
import {
  claimCustodyScopeLease,
  CUSTODY_SCOPE_LEASE_DURATION_MS,
  CUSTODY_SCOPE_RENEW_INTERVAL_MS,
  renewCustodyScopeLease,
  ScopeLeaseRefusalError,
} from '../src/profileFencing.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import {
  DAEMON_PROFILE_DATABASE,
  ProfileSchemaRefusalError,
  validateDaemonProfileSchema,
} from '../src/profileSchema.ts'
import {
  FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST,
  FINAL_PROFILE_SCHEMA_VERSION,
  FINAL_PROFILE_SCHEMA_SQL,
  finalProfileSchemaManifestDigest,
  getFinalProfileSchemaManifest,
} from '../src/profileSchemaManifest.ts'
import { createNativeConfig, defaultNativeConfig } from '../src/nativeConfig.ts'
import { ProfileSecretProtectionError } from '../src/profileSecretProtection.ts'
import files from 'node:fs/promises'
import http from 'node:http'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { configureDaemonStateSqlite } from '../src/stateSqlite.ts'
import { configureDataDirForTest as configureSourceDataDirForTest } from '../src/dataDir.ts'
import { configureDataDirForTest as configurePackageDataDirForTest } from '@bitcaster-market/daemon/dataDir'
import { readRpcToken, readLiveRpcToken } from '../src/rpcAuth.ts'

function configureDataDirForTest(source: () => string | undefined): void {
  // The CLI loads the built daemon package, not this test's source module.
  configureSourceDataDirForTest(source)
  configurePackageDataDirForTest(source)
}

const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const seed = '11'.repeat(64)
const nostrSecret = '22'.repeat(32)
const rpcToken = 'R'.repeat(43)
const initializedAtMs = 1_700_000_000_000

test('RPC token reads remain valid during independent WAL commits and checkpoints', async (t) => {
  const directory = await freshProfileDirectory('rpc-wal-checkpoints')
  await bootstrap(directory)
  configureDataDirForTest(() => directory)
  t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
  const writer = spawn(
    process.execPath,
    [
      '--max-old-space-size=1536',
      join(import.meta.dirname, 'fixtures', 'profileWalWriter.mjs'),
      join(directory, DAEMON_PROFILE_DATABASE),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const exited = new Promise<number | null>((resolve, reject) => {
    writer.once('error', reject)
    writer.once('exit', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    writer.stdout.once('data', () => resolve())
    writer.once('error', reject)
    writer.once('exit', () => reject(new Error('WAL writer exited before readiness')))
  })
  let reads = 0
  let refusals = 0
  while (writer.exitCode === null && reads < 400) {
    try {
      const token = await readLiveRpcToken()
      assert.equal(token === rpcToken, true, 'RPC token did not match')
    } catch {
      refusals += 1
    }
    reads += 1
  }
  assert.equal(await exited, 0, 'independent WAL writer failed')
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  assert.equal(reads > 0, true, 'RPC token reader did not run with the writer')
  assert.equal(refusals, 0, 'valid live WAL profile was refused')
  assert.equal((await readLiveRpcToken()) === rpcToken, true)
})

test('fresh bootstrap atomically creates the exact frozen owner-only profile', async () => {
  const directory = join(await freshRoot('plain'), 'profile')
  const priorUmask = process.umask(0)
  let result: Awaited<ReturnType<typeof bootstrap>>
  try {
    result = await bootstrap(directory)
  } finally {
    process.umask(priorUmask)
  }

  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  assert.equal(await readBootstrappedRpcToken(directory), rpcToken)
  const unlockedSecrets = await readBootstrappedProfileSecrets(directory)
  assert.equal(unlockedSecrets.walletSeedHex === seed, true, 'wallet seed did not round trip')
  assert.equal(
    unlockedSecrets.nostrSecretKeyHex === nostrSecret,
    true,
    'Nostr signing key did not round trip',
  )
  assert.equal(
    unlockedSecrets.nostrPublicKeyHex === result.nostrPublicKeyHex,
    true,
    'Nostr public key did not round trip',
  )
  assert.equal(
    /^[0-9a-f]{64}$/.test(unlockedSecrets.nativeOracleNonceSeedHex),
    true,
    'native oracle nonce seed must be 32 bytes of lowercase hex',
  )
  assert.equal(
    unlockedSecrets.nativeOracleNonceSeedHex !== nostrSecret,
    true,
    'native oracle nonce seed must be independent from the Nostr key',
  )
  assert.deepEqual(Object.keys(unlockedSecrets).sort(), [
    'nativeOracleNonceSeedHex',
    'nostrPublicKeyHex',
    'nostrSecretKeyHex',
    'walletSeedHex',
  ])
  const unlockedAgain = await readBootstrappedProfileSecrets(directory)
  assert.equal(
    unlockedAgain.nativeOracleNonceSeedHex === unlockedSecrets.nativeOracleNonceSeedHex,
    true,
    'reading the profile must preserve its nonce seed',
  )

  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, DAEMON_PROFILE_DATABASE))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(directory), ['config.json', DAEMON_PROFILE_DATABASE])

  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
    const profileColumns = database
      .prepare('PRAGMA table_info(daemon_profile)')
      .all()
      .map((row) => (row as { name: string }).name)
    assert.equal(profileColumns.includes('engine_base_url'), false)
    assert.equal(profileColumns.includes('mint_url'), false)
    assert.equal(
      (database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
      'wal',
    )
    assert.equal(
      (database.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous,
      2,
    )
    const state = database
      .prepare(
        `SELECT fencing_epoch AS epoch, owner_incarnation_id AS owner,
          lease_expires_at_ms AS lease, high_water_mark_ms AS highWater
         FROM custody_scope_state`,
      )
      .get() as Record<string, unknown>
    assert.deepEqual(
      { ...state },
      {
        epoch: 0,
        owner: null,
        lease: null,
        highWater: initializedAtMs,
      },
    )
    const nonceAllocator = database
      .prepare(
        `SELECT next_nonce_index AS nextNonceIndex
         FROM daemon_oracle_nonce_allocator WHERE singleton = 1`,
      )
      .get() as { nextNonceIndex: number }
    assert.equal(nonceAllocator.nextNonceIndex, 0)
    const secretBodyRow = database
      .prepare('SELECT secret_body AS body FROM daemon_secret_authority WHERE singleton = 1')
      .get() as { body: Uint8Array }
    const secretBody = JSON.parse(Buffer.from(secretBodyRow.body).toString('utf8')) as Record<
      string,
      unknown
    >
    assert.deepEqual(Object.keys(secretBody).sort(), [
      'nativeOracleNonceSeedHex',
      'nostrSecretKeyHex',
      'version',
      'walletSeedHex',
    ])
    assert.equal(secretBody.version === 2, true)
    assert.equal(
      typeof secretBody.nativeOracleNonceSeedHex === 'string' &&
        /^[0-9a-f]{64}$/.test(secretBody.nativeOracleNonceSeedHex),
      true,
    )
    assert.equal(
      secretBody.nativeOracleNonceSeedHex === unlockedSecrets.nativeOracleNonceSeedHex,
      true,
    )
    const walletId = deriveDurableCustodyWalletId(Buffer.from(seed, 'hex'))
    assert.equal(
      result.walletScopeId,
      deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
    )
    const scope = database
      .prepare(
        `SELECT wallet_id AS walletId, wallet_seed_digest AS seedDigest
         FROM custody_scopes`,
      )
      .get() as { walletId: string; seedDigest: string }
    assert.deepEqual(
      { ...scope },
      {
        walletId,
        seedDigest: createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex'),
      },
    )
    const operationId = deriveDurableCustodyOperationId(result.walletScopeId, {
      retainedOperationKey: 'operation-key',
      binding: { kind: 'wallet', activityId: 'activity-1', stage: 'send' },
    })
    const artifactId = `artifact:${operationId}:request`
    database
      .prepare(
        `INSERT INTO custody_artifacts
          (artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
           revision, private_material, created_at_ms)
         VALUES (?, ?, 'exact-request', 'canonical-json', ?, ?, 0, 0, ?)`,
      )
      .run(artifactId, result.walletScopeId, Buffer.from('{}'), 'a'.repeat(64), initializedAtMs)
    assert.equal(
      (
        database.prepare('SELECT artifact_id AS artifactId FROM custody_artifacts').get() as {
          artifactId: string
        }
      ).artifactId,
      artifactId,
    )
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO custody_artifacts
              (artifact_id, scope_id, artifact_kind, encoding, body,
               fingerprint, revision, private_material, created_at_ms)
             VALUES ('artifact:foreign', ?, 'exact-request',
               'canonical-json', X'7b7d', ?, 0, 0, ?)`,
          )
          .run(result.walletScopeId, 'b'.repeat(64), initializedAtMs),
      /constraint failed/i,
    )
  } finally {
    database.close()
  }
})

test('RPC token snapshot waits for an independent exclusive schema lock to roll back', async () => {
  const directory = await freshProfileDirectory('rpc-schema-lock')
  await bootstrap(directory)
  const writer = spawn(
    process.execPath,
    [
      '--max-old-space-size=1536',
      join(import.meta.dirname, 'fixtures', 'profileWalWriter.mjs'),
      join(directory, DAEMON_PROFILE_DATABASE),
      'schema-lock',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const exited = new Promise<number | null>((resolve, reject) => {
    writer.once('error', reject)
    writer.once('exit', resolve)
  })
  await new Promise<void>((resolve, reject) => {
    writer.stdout.once('data', () => resolve())
    writer.once('error', reject)
    writer.once('exit', () => reject(new Error('schema lock writer exited before readiness')))
  })
  const immediate = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE), { readOnly: true })
  try {
    assert.throws(
      () => immediate.prepare('PRAGMA quick_check(1)').all(),
      (error: unknown) => error instanceof Error && 'errcode' in error && error.errcode === 5,
    )
  } finally {
    immediate.close()
  }
  const token = await readLiveBootstrappedRpcToken(directory)
  assert.equal(token === rpcToken, true, 'RPC token did not match after schema lock release')
  assert.equal(await exited, 0, 'schema lock writer failed')
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
})

test('immutable RPC token admission preserves the stopped profile artifacts', async (t) => {
  const directory = await freshProfileDirectory('rpc-immutable-admission')
  await bootstrap(directory)
  configureDataDirForTest(() => directory)
  t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
  const before = (await readdir(directory)).sort()
  const databasePath = join(directory, DAEMON_PROFILE_DATABASE)
  const databaseBefore = createHash('sha256')
    .update(await readFile(databasePath))
    .digest('hex')
  assert.equal((await readRpcToken()) === rpcToken, true)
  assert.deepEqual((await readdir(directory)).sort(), before)
  assert.equal(
    createHash('sha256')
      .update(await readFile(databasePath))
      .digest('hex'),
    databaseBefore,
  )
})

test('CLI commands and watches authenticate with the exact selected live profile token', async (t) => {
  const directory = await freshProfileDirectory('rpc-cli-auth')
  await bootstrap(directory)
  const other = await freshProfileDirectory('rpc-cli-other')
  await bootstrapFreshDaemonProfile({ ...bootstrapInput(other), rpcToken: 'Z'.repeat(43) })
  configureDataDirForTest(() => directory)
  t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
  const globals = globalThis as Record<symbol, unknown>
  const symbol = Symbol.for('bitcaster.test.daemon-url')
  const previous = globals[symbol]
  globals[symbol] = 'http://daemon.test'
  t.after(() => {
    if (previous === undefined) delete globals[symbol]
    else globals[symbol] = previous
  })
  let calls = 0
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      calls += 1
      assert.equal(_url, 'http://daemon.test/rpc')
      const headers = new Headers(options.headers)
      assert.equal(
        headers.get('authorization') === `Bearer ${rpcToken}`,
        true,
        'wrong selected-profile authorization',
      )
      if (headers.get('accept') === 'application/x-ndjson') {
        return new Response('{"type":"complete"}\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      }
      return Response.json({ ok: true, result: { healthy: true } })
    },
  )
  t.after(() => fetchMock.mock.restore())
  const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
  url.searchParams.set('fixture', 'exact-selected-profile')
  const rpc = await import(url.href)
  assert.equal((await rpc.callDaemon({ method: 'health' })).ok, true)
  const watch = rpc.watchDaemon({ method: 'wallet.watch' })
  assert.equal((await watch.next()).value.type, 'complete')
  await watch.return(undefined)
  assert.equal(calls, 2)
})

test('live RPC token refusals prevent CLI command and watch dispatch', async (t) => {
  for (const drift of [
    'corrupt',
    'foreign-key',
    'marker',
    'permission',
    'symlink',
    'schema',
    'missing-token',
    'malformed-token',
  ] as const) {
    await t.test(drift, async (subtest) => {
      const expectedReason: Record<typeof drift, ProfileSchemaRefusalError['reason']> = {
        corrupt: 'sqlite-corrupt',
        'foreign-key': 'sqlite-corrupt',
        marker: 'sqlite-schema-mismatch',
        permission: 'profile-permission-invalid',
        symlink: 'sqlite-database-not-plain',
        schema: 'sqlite-schema-mismatch',
        'missing-token': 'sqlite-schema-mismatch',
        'malformed-token': 'sqlite-corrupt',
      }
      const directory = await freshProfileDirectory(`rpc-refusal-${drift}`)
      await bootstrap(directory)
      configureDataDirForTest(() => directory)
      subtest.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
      const path = join(directory, DAEMON_PROFILE_DATABASE)
      const writer = new DatabaseSync(path, { enableForeignKeyConstraints: false })
      try {
        switch (drift) {
          case 'foreign-key':
            writer
              .prepare('UPDATE daemon_profile SET wallet_scope_id = ?')
              .run(`custody:wallet:${'0'.repeat(64)}`)
            break
          case 'marker': {
            const trigger = getFinalProfileSchemaManifest().objects.find(
              (object) => object.name === 'profile_schema_marker_no_delete',
            )?.sql
            assert.ok(trigger)
            writer.exec(
              'DROP TRIGGER profile_schema_marker_no_delete; DELETE FROM profile_schema_marker',
            )
            writer.exec(trigger)
            break
          }
          case 'schema':
            writer.exec('CREATE TABLE unexpected (value INTEGER) STRICT')
            break
          case 'missing-token':
            writer.exec('DELETE FROM daemon_rpc_token')
            break
          case 'malformed-token':
            writer.exec(
              "PRAGMA ignore_check_constraints = ON; UPDATE daemon_rpc_token SET token = 'invalid'",
            )
            break
          case 'corrupt':
          case 'permission':
          case 'symlink':
            break
        }
      } finally {
        writer.close()
      }
      if (drift === 'corrupt') await writeFile(path, 'not a SQLite database')
      if (drift === 'permission') await chmod(path, 0o644)
      if (drift === 'symlink') {
        const other = await freshProfileDirectory('rpc-symlink-target')
        await bootstrap(other)
        await unlink(path)
        await symlink(join(other, DAEMON_PROFILE_DATABASE), path)
      }
      await assert.rejects(readLiveRpcToken(), ProfileSchemaRefusalError)
      let calls = 0
      const fetchMock = mock.method(globalThis, 'fetch', async () => {
        calls += 1
        throw new Error('invalid profile reached RPC dispatch')
      })
      subtest.after(() => fetchMock.mock.restore())
      const globals = globalThis as Record<symbol, unknown>
      const symbol = Symbol.for('bitcaster.test.daemon-url')
      const previous = globals[symbol]
      globals[symbol] = 'http://daemon.test'
      subtest.after(() => {
        if (previous === undefined) delete globals[symbol]
        else globals[symbol] = previous
      })
      const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
      url.searchParams.set('fixture', drift)
      const rpc = await import(url.href)
      await assert.rejects(rpc.callDaemon({ method: 'health' }), schemaError(expectedReason[drift]))
      const watch = rpc.watchDaemon({ method: 'wallet.watch' })
      await assert.rejects(watch.next(), schemaError(expectedReason[drift]))
      await watch.return(undefined)
      assert.equal(calls, 0)
    })
  }
  const missing = await freshProfileDirectory('rpc-missing-profile')
  configureDataDirForTest(() => missing)
  t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
  assert.equal(await readLiveRpcToken(), null)
})

for (const kind of ['command', 'watch', 'wait'] as const) {
  test(`real last-WAL-close refusal stops normal Unix ${kind} without autostart and permits a later explicit call`, async (t) => {
    const directory = await freshProfileDirectory(`rpc-wal-close-${kind}`)
    await bootstrap(directory)
    configureDataDirForTest(() => directory)
    t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
    const path = join(directory, DAEMON_PROFILE_DATABASE)
    const before = await stat(path, { bigint: true })
    const writer = new DatabaseSync(path)
    configureDaemonStateSqlite(writer)
    writer.exec('UPDATE daemon_profile SET initialized_at_ms = initialized_at_ms')
    let closed = false
    t.after(() => {
      if (!closed) writer.close()
    })
    const readdirOriginal = files.readdir
    let inspections = 0
    const enumeration = mock.method(files, 'readdir', async (...args: unknown[]) => {
      const entries = await Reflect.apply(readdirOriginal, files, args)
      if (args[0] === directory) {
        inspections += 1
        if (!closed) {
          assert.equal(
            entries.some(
              (entry: { name: string }) => entry.name === `${DAEMON_PROFILE_DATABASE}-wal`,
            ),
            true,
          )
          assert.equal(
            entries.some(
              (entry: { name: string }) => entry.name === `${DAEMON_PROFILE_DATABASE}-shm`,
            ),
            true,
          )
          writer.close()
          closed = true
        }
      }
      return entries
    })
    const transport = installUnixRpcMock(t)
    syncBuiltinESMExports()
    t.after(() => {
      enumeration.mock.restore()
      syncBuiltinESMExports()
    })
    const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
    url.searchParams.set('fixture', `wal-close-${kind}`)
    const rpc = await import(url.href)
    const invoke = async () => {
      if (kind === 'command') return rpc.callDaemon({ method: 'health' })
      if (kind === 'wait') return rpc.waitForDaemon()
      const watch = rpc.watchDaemon({ method: 'wallet.watch' })
      try {
        return await watch.next()
      } finally {
        await watch.return(undefined)
      }
    }
    await assert.rejects(invoke(), schemaError('profile-identity-changed'))
    assert.equal(inspections, 1, 'refusal must not repeat preflight')
    assert.equal(transport.requests, 0)
    assert.equal(transport.spawns, 0)
    const after = await stat(path, { bigint: true })
    assert.equal(before.dev === after.dev && before.ino === after.ino, true)
    assert.equal(
      (await readdir(directory)).some(
        (name) => name === 'daemon-autostart.pid' || name === 'daemon.log',
      ),
      false,
    )
    await invoke()
    assert.equal(transport.requests, 1)
    assert.equal(transport.spawns, 0)
    const completedInspections = inspections
    await invoke()
    assert.equal(inspections, completedInspections, 'successful token must stay cached')
    assert.equal(transport.requests, 2)
  })
}

test('concurrent CLI callers share a refusal and a later explicit call revalidates', async (t) => {
  const directory = await freshProfileDirectory('rpc-coalesced-refusal')
  await bootstrap(directory)
  configureDataDirForTest(() => directory)
  t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
  const original = files.realpath
  const error = Object.assign(new Error('controlled filesystem failure'), { code: 'EIO' })
  let fail = true
  let reads = 0
  const preflight = mock.method(files, 'realpath', async (...args: unknown[]) => {
    if (args[0] === directory && fail) {
      reads += 1
      throw error
    }
    return Reflect.apply(original, files, args)
  })
  const transport = installUnixRpcMock(t)
  syncBuiltinESMExports()
  t.after(() => {
    preflight.mock.restore()
    syncBuiltinESMExports()
  })
  const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
  url.searchParams.set('fixture', 'coalesced-refusal')
  const rpc = await import(url.href)
  const outcomes = await Promise.allSettled([
    rpc.callDaemon({ method: 'health' }),
    rpc.callDaemon({ method: 'health' }),
  ])
  assert.equal(reads, 1)
  for (const outcome of outcomes)
    assert.equal(outcome.status === 'rejected' && outcome.reason === error, true)
  assert.equal(transport.requests, 0)
  assert.equal(transport.spawns, 0)
  fail = false
  await rpc.callDaemon({ method: 'health' })
  assert.equal(transport.requests, 1)
})

test('startup cancellation surrounds token preflight and its deadline includes preflight time', async (t) => {
  const directory = await freshProfileDirectory('rpc-startup-boundary')
  await bootstrap(directory)
  configureDataDirForTest(() => directory)
  t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
  const original = files.realpath
  const controller = new AbortController()
  const reason = new Error('controlled cancellation')
  let inspect = () => {}
  let reads = 0
  const preflight = mock.method(files, 'realpath', async (...args: unknown[]) => {
    if (args[0] === directory) {
      reads += 1
      inspect()
    }
    return Reflect.apply(original, files, args)
  })
  const transport = installUnixRpcMock(t)
  syncBuiltinESMExports()
  t.after(() => {
    preflight.mock.restore()
    syncBuiltinESMExports()
  })
  const load = async (fixture: string) => {
    const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
    url.searchParams.set('fixture', fixture)
    return import(url.href)
  }
  const before = await load('cancel-before-preflight')
  controller.abort(reason)
  await assert.rejects(before.waitForDaemon(controller.signal), (error) => error === reason)
  assert.equal(reads, 0)
  const afterController = new AbortController()
  inspect = () => afterController.abort(reason)
  const after = await load('cancel-after-preflight')
  await assert.rejects(after.waitForDaemon(afterController.signal), (error) => error === reason)
  assert.equal(transport.requests, 0)
  let clock = 1000
  const now = mock.method(Date, 'now', () => clock)
  t.after(() => now.mock.restore())
  inspect = () => {
    clock = 11001
  }
  const expired = await load('preflight-consumes-deadline')
  await assert.rejects(expired.waitForDaemon(), /timed out waiting for bitcaster-daemon to start/)
  assert.equal(transport.requests, 0)
})

for (const code of ['ENOENT', 'ECONNREFUSED']) {
  test(`startup continues Unix health polling after transport ${code}`, async (t) => {
    const directory = await freshProfileDirectory(`rpc-startup-${code}`)
    await bootstrap(directory)
    configureDataDirForTest(() => directory)
    t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
    const transport = installUnixRpcMock(t, code)
    const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
    url.searchParams.set('fixture', `startup-${code}`)
    const rpc = await import(url.href)
    await rpc.waitForDaemon()
    assert.equal(transport.requests, 2)
    assert.equal(transport.spawns, 0)
  })
}

for (const kind of ['command', 'watch'] as const) {
  test(`profile replacement before live token return prevents CLI ${kind} dispatch`, async (t) => {
    const directory = await freshProfileDirectory('rpc-replaced-profile')
    const replacement = await freshProfileDirectory('rpc-replacement-source')
    await bootstrap(directory)
    await bootstrapFreshDaemonProfile({ ...bootstrapInput(replacement), rpcToken: 'Z'.repeat(43) })
    configureDataDirForTest(() => directory)
    t.after(() => configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME))
    const prepare = DatabaseSync.prototype.prepare
    const prepareMock = mock.method(
      DatabaseSync.prototype,
      'prepare',
      function (this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql)
        if (sql === 'SELECT token FROM daemon_rpc_token WHERE singleton = 1') {
          renameSync(
            join(replacement, DAEMON_PROFILE_DATABASE),
            join(directory, DAEMON_PROFILE_DATABASE),
          )
        }
        return statement
      },
    )
    t.after(() => prepareMock.mock.restore())
    let calls = 0
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      calls += 1
      throw new Error('replaced profile reached RPC dispatch')
    })
    t.after(() => fetchMock.mock.restore())
    const globals = globalThis as Record<symbol, unknown>
    const symbol = Symbol.for('bitcaster.test.daemon-url')
    const previous = globals[symbol]
    globals[symbol] = 'http://daemon.test'
    t.after(() => {
      if (previous === undefined) delete globals[symbol]
      else globals[symbol] = previous
    })
    const url = new URL('../../bitcaster-cli/src/rpc.ts', import.meta.url)
    url.searchParams.set('fixture', `profile-replacement-${kind}`)
    const rpc = await import(url.href)
    const refused = schemaError('profile-identity-changed')
    if (kind === 'command') await assert.rejects(rpc.callDaemon({ method: 'health' }), refused)
    else {
      const watch = rpc.watchDaemon({ method: 'wallet.watch' })
      await assert.rejects(watch.next(), refused)
      await watch.return(undefined)
    }
    assert.equal(calls, 0)
  })
}

for (const version of [10, 13, 14]) {
  test(`native custody cutover refuses schema version ${version} without changing profile bytes or modes`, async () => {
    const directory = join(await freshRoot(`claim-old-schema-${version}`), 'profile')
    await bootstrap(directory)
    const path = join(directory, DAEMON_PROFILE_DATABASE)
    const database = new DatabaseSync(path)
    database.exec(`PRAGMA user_version = ${version}`)
    database.close()
    const before = await readFile(path)
    const mode = (await stat(path)).mode
    await assert.rejects(
      validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest()),
      ProfileSchemaRefusalError,
    )
    await assert.rejects(readBootstrappedProfileSecrets(directory), ProfileSchemaRefusalError)
    assert.equal((await readFile(path)).equals(before), true)
    assert.equal((await stat(path)).mode, mode)
  })
}

test('a missing Activity display table is refused without schema repair', async () => {
  const directory = await freshProfileDirectory('activity-schema-missing')
  await bootstrap(directory)
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
    database.exec('DROP TABLE daemon_activity_feed')
  } finally {
    database.close()
  }
  await assert.rejects(
    validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest()),
    schemaError('sqlite-schema-mismatch'),
  )
})

test('production schema manifest is pinned and excludes source-only recovery authority', () => {
  assert.equal(finalProfileSchemaManifestDigest(), FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST)
  const manifest = getFinalProfileSchemaManifest()
  assert.equal(FINAL_PROFILE_SCHEMA_VERSION, 15)
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(Object.isFrozen(manifest.objects), true)
  const names = new Set(manifest.objects.map((object) => object.name))
  for (const required of [
    'custody_proofs',
    'custody_keyset_counters',
    'custody_operations',
    'custody_artifacts',
    'custody_operation_tombstones',
    'custody_position_claim_links',
    'custody_terminal_mint_rejections',
    'custody_verification_keyset_uses',
    'custody_selected_successors',
    'custody_successor_admissions',
    'custody_successor_admission_proofs',
    'custody_deliveries',
    'custody_active_work',
    'daemon_orders',
    'order_collateral_pins',
    'seed_recovery_jobs',
    'seed_recovery_keysets',
    'daemon_market_funding_heads',
    'daemon_bolt11_mint_quotes',
    'daemon_activity_feed',
    'daemon_activity_feed_meta',
    'daemon_oracle_nonce_allocator',
    'daemon_oracle_imports',
  ]) {
    assert.ok(names.has(required), required)
  }
  for (const required of [
    'custody_operations_retained_operation_key_typed_idx',
    'daemon_outgoing_cashu_transfers_due_idx',
    'daemon_outgoing_cashu_transfers_all_mints_due_idx',
    'daemon_market_funding_successor_idx',
    'daemon_bolt11_mint_quote_no_delete',
    'daemon_bolt11_mint_quote_no_rebind',
    'daemon_bolt11_mint_quote_operation_binding_insert',
    'daemon_activity_feed_page_idx',
  ]) {
    assert.ok(names.has(required), required)
  }
  const operationColumns = new Set(
    manifest.tables
      .find((table) => table.name === 'custody_operations')!
      .columns.map((column) => column.name),
  )
  for (const required of [
    'request_id',
    'payload_handle',
    'output_plan_id',
    'output_material_handle',
    'private_material_handle',
    'private_use_id',
    'private_public_fingerprint',
    'result_handle',
    'result_output_plan_fingerprint',
    'successor_admission_mode',
    'successor_selection_staged',
    'verification_output_plan_fingerprint',
    'verification_has_outputs',
    'not_before_ms',
    'not_after_ms',
    'safety_margin_ms',
    'keyset_expiry_ms',
  ]) {
    assert.ok(operationColumns.has(required), required)
  }
  const operationSql = manifest.objects.find(
    (object) => object.type === 'table' && object.name === 'custody_operations',
  )!.sql!
  assert.equal(operationSql.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length, 4)
  const lineage = manifest.tables.find((table) => table.name === 'custody_proof_lineage')!
  assert.equal(
    lineage.foreignKeys.some((foreignKey) => foreignKey.table === 'custody_proofs'),
    false,
  )
  const admissionProofs = manifest.tables.find(
    (table) => table.name === 'custody_successor_admission_proofs',
  )!
  assert.equal(
    admissionProofs.foreignKeys.some((foreignKey) => foreignKey.table === 'custody_proofs'),
    true,
  )
  const recoveryJobs = manifest.tables.find((table) => table.name === 'seed_recovery_jobs')!
  const recoveryKeysets = manifest.tables.find((table) => table.name === 'seed_recovery_keysets')!
  const fundingHeads = manifest.tables.find(
    (table) => table.name === 'daemon_market_funding_heads',
  )!
  const outgoingTransfers = manifest.tables.find(
    (table) => table.name === 'daemon_outgoing_cashu_transfers',
  )!
  assert.equal(fundingHeads.strict, true)
  assert.ok(outgoingTransfers.columns.some((column) => column.name === 'funding_sequence'))
  assert.ok(
    outgoingTransfers.columns.some((column) => column.name === 'funding_predecessor_transfer_id'),
  )
  assert.ok(
    fundingHeads.foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === 'daemon_outgoing_cashu_transfers' &&
        foreignKey.onDelete === 'RESTRICT',
    ),
  )
  assert.ok(
    outgoingTransfers.foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === 'daemon_outgoing_cashu_transfers' &&
        foreignKey.onDelete === 'RESTRICT',
    ),
  )
  assert.match(
    manifest.objects.find(
      (object) => object.name === 'daemon_outgoing_cashu_recipient_active_binding_idx',
    )!.sql!,
    /funding_sequence = 0/,
  )
  assert.equal(recoveryJobs.strict, true)
  assert.equal(recoveryKeysets.strict, true)
  assert.ok(
    recoveryKeysets.foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === 'seed_recovery_jobs' &&
        foreignKey.from === 'recovery_id' &&
        foreignKey.to === 'recovery_id' &&
        foreignKey.onDelete === 'RESTRICT',
    ),
  )
  for (const forbidden of [
    'daemon_trade_sessions',
    'daemon_trade_ciphers',
    'custody_session_links',
    'trade_cipher_recovery',
    'adaptor_recovery',
    'presignature_recovery',
    'daemon_order_trades',
    'daemon_swaps',
    'swap_operation_links',
    'target_ephemeral_keys',
  ]) {
    assert.ok(!names.has(forbidden), forbidden)
  }
})

test('outgoing transfer schema keeps requested amounts within the JavaScript safe integer range', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const statement = FINAL_PROFILE_SCHEMA_SQL.find((sql) =>
      sql.startsWith('CREATE TABLE daemon_outgoing_cashu_transfers'),
    )
    assert.ok(statement)
    database.exec(`
      CREATE TABLE custody_scopes (scope_id TEXT PRIMARY KEY);
      CREATE TABLE custody_operations (
        scope_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (scope_id, operation_id)
      );
      CREATE TABLE custody_artifacts (
        scope_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        PRIMARY KEY (scope_id, artifact_id)
      );
      INSERT INTO custody_scopes VALUES ('scope');
      INSERT INTO custody_operations VALUES ('scope', 'operation-safe');
      INSERT INTO custody_operations VALUES ('scope', 'operation-unsafe');
      INSERT INTO custody_artifacts VALUES ('scope', '${'a'.repeat(64)}');
      INSERT INTO custody_artifacts VALUES ('scope', '${'c'.repeat(64)}');
    `)
    database.exec(statement)
    const insert = database.prepare(
      `INSERT INTO daemon_outgoing_cashu_transfers (
         scope_id, transfer_id, custody_operation_id, normalized_mint, unit,
         requested_amount, delivery_state, delivery_policy, recipient_binding, due_at_ms, attempt_count, revision,
         transfer_artifact_id, transfer_fingerprint, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'https://mint.example', 'sat', ?, 'prepared', 'bearer-spend-classification', NULL, 0, 0, 0, ?, ?, 0, 0)`,
    )
    insert.run(
      'scope',
      'safe',
      'operation-safe',
      '9007199254740991',
      'a'.repeat(64),
      'b'.repeat(64),
    )
    assert.throws(
      () =>
        insert.run(
          'scope',
          'unsafe',
          'operation-unsafe',
          '9007199254740992',
          'c'.repeat(64),
          'd'.repeat(64),
        ),
      /constraint failed/i,
    )
  } finally {
    database.close()
  }
})

test('outgoing transfer schema rejects delivery policy and state substitutions', () => {
  const database = new DatabaseSync(':memory:')
  try {
    const statement = FINAL_PROFILE_SCHEMA_SQL.find((sql) =>
      sql.startsWith('CREATE TABLE daemon_outgoing_cashu_transfers'),
    )
    assert.ok(statement)
    database.exec(`
      CREATE TABLE custody_scopes (scope_id TEXT PRIMARY KEY);
      CREATE TABLE custody_operations (
        scope_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (scope_id, operation_id)
      );
      CREATE TABLE custody_artifacts (
        scope_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        PRIMARY KEY (scope_id, artifact_id)
      );
      INSERT INTO custody_scopes VALUES ('scope');
      INSERT INTO custody_operations VALUES ('scope', 'operation-a');
      INSERT INTO custody_operations VALUES ('scope', 'operation-b');
      INSERT INTO custody_artifacts VALUES ('scope', '${'a'.repeat(64)}');
      INSERT INTO custody_artifacts VALUES ('scope', '${'b'.repeat(64)}');
    `)
    database.exec(statement)
    const insert = database.prepare(
      `INSERT INTO daemon_outgoing_cashu_transfers (
         scope_id, transfer_id, custody_operation_id, normalized_mint, unit,
         requested_amount, delivery_state, delivery_policy, recipient_binding, due_at_ms, attempt_count, revision,
         transfer_artifact_id, transfer_fingerprint, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'https://mint.example', 'sat', '1', ?, ?, ?, 0, 0, 0, ?, ?, 0, 0)`,
    )
    assert.throws(
      () =>
        insert.run(
          'scope',
          'recipient-bearer-state',
          'operation-a',
          'bearer-spent',
          'durable-recipient-ack',
          'c'.repeat(64),
          'a'.repeat(64),
          'd'.repeat(64),
        ),
      /constraint failed/i,
    )
    assert.throws(
      () =>
        insert.run(
          'scope',
          'bearer-recipient-state',
          'operation-b',
          'recipient-acknowledged',
          'bearer-spend-classification',
          null,
          'b'.repeat(64),
          'e'.repeat(64),
        ),
      /constraint failed/i,
    )
  } finally {
    database.close()
  }
})

test('operation-first UoW defers artifacts and permits planned successor lineage', async () => {
  const directory = await freshProfileDirectory('deferred-artifacts')
  const { walletScopeId } = await bootstrap(directory)
  const operationId = deriveDurableCustodyOperationId(walletScopeId, {
    retainedOperationKey: 'deferred-operation',
    binding: { kind: 'wallet', activityId: 'deferred-activity', stage: 'send' },
  })
  const requestArtifact = `artifact:${operationId}:request`
  const outputArtifact = `artifact:${operationId}:output`
  const privateArtifact = `artifact:${operationId}:private`
  const fingerprint = 'a'.repeat(64)
  const plannedSuccessor = 'b'.repeat(64)
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    database
      .prepare(
        `INSERT INTO custody_operations (
          operation_id, scope_id, schema_version, revision,
          retained_operation_key, semantic_kind, operation_state,
          activity_id, wallet_stage, normalized_mint, unit,
          inventory_account_id, reservation_id, parent_reservation_id,
          input_count, request_id, payload_handle, request_method,
          request_path, idempotency_key, request_fingerprint,
          request_artifact_id, output_plan_fingerprint, output_plan_id,
          output_material_handle, output_artifact_id,
          private_material_handle, private_use_id, private_public_fingerprint,
          private_artifact_id, result_state, result_handle,
          result_artifact_id, result_fingerprint,
          result_output_plan_fingerprint, proof_storage_class,
          successor_admission_mode, successor_selection_staged,
          verification_output_plan_fingerprint, verification_has_outputs,
          transport_attempted, retry_attempt, retry_reason, next_attempt_at_ms,
          not_before_ms, not_after_ms, safety_margin_ms, keyset_expiry_ms,
          terminal_replay_evidence_required, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, 1, 0, 'deferred-operation', 'wallet-send',
          'dispatch-intent', 'deferred-activity', 'send',
          'https://mint.example', 'sat', NULL, 'reservation-1', NULL, 0,
          'request-1', 'payload-1', 'POST', '/v1/swap', 'idempotency-1', ?,
          ?, ?, 'plan-1', 'output-material-1', ?,
          'private-material-1', 'private-use-1', ?, ?,
          'none', NULL, NULL, NULL, NULL,
          'pinned-operation-bound-deterministic', 'exact', 0, ?, 0,
          0, 0, 'none', NULL, NULL, NULL, 0, NULL, 0, ?, ?
        )`,
      )
      .run(
        operationId,
        walletScopeId,
        fingerprint,
        requestArtifact,
        fingerprint,
        outputArtifact,
        fingerprint,
        privateArtifact,
        fingerprint,
        initializedAtMs,
        initializedAtMs,
      )
    database
      .prepare(
        `INSERT INTO custody_proof_lineage
          (scope_id, operation_id, lineage_kind, lineage_position, proof_id)
         VALUES (?, ?, 'successor', 0, ?)`,
      )
      .run(walletScopeId, operationId, plannedSuccessor)
    const insertArtifact = database.prepare(
      `INSERT INTO custody_artifacts
        (artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
         revision, private_material, created_at_ms)
       VALUES (?, ?, ?, 'canonical-json', X'7b7d', ?, 0, ?, ?)`,
    )
    insertArtifact.run(
      requestArtifact,
      walletScopeId,
      'exact-request',
      fingerprint,
      0,
      initializedAtMs,
    )
    insertArtifact.run(
      outputArtifact,
      walletScopeId,
      'output-plan',
      fingerprint,
      0,
      initializedAtMs,
    )
    insertArtifact.run(
      privateArtifact,
      walletScopeId,
      'private-material',
      fingerprint,
      1,
      initializedAtMs,
    )
    database.exec('COMMIT')
    assert.equal(
      (
        database
          .prepare(
            `SELECT count(*) AS count FROM custody_proof_lineage
             WHERE proof_id = ?`,
          )
          .get(plannedSuccessor) as { count: number }
      ).count,
      1,
    )
  } finally {
    database.close()
  }
})

test('passphrase encryption fails closed without exposing seed or Nostr secret', async () => {
  const directory = await freshProfileDirectory('encrypted')
  const result = await bootstrap(directory, { passphrase: 'correct horse' })
  const bytes = await readFile(join(directory, DAEMON_PROFILE_DATABASE))
  assert.equal(bytes.includes(Buffer.from(seed, 'utf8')), false)
  assert.equal(bytes.includes(Buffer.from(nostrSecret, 'utf8')), false)

  await assert.rejects(
    readBootstrappedProfileSecrets(directory),
    secretError('passphrase-required'),
  )
  await assert.rejects(
    readBootstrappedProfileSecrets(directory, 'wrong battery'),
    secretError('unlock-failed'),
  )
  assert.equal((await readFile(join(directory, DAEMON_PROFILE_DATABASE))).equals(bytes), true)
  const unlocked = await readBootstrappedProfileSecrets(directory, 'correct horse')
  assert.equal(unlocked.nostrPublicKeyHex === result.nostrPublicKeyHex, true)
  const unlockedAgain = await readBootstrappedProfileSecrets(directory, 'correct horse')
  assert.equal(
    unlocked.nativeOracleNonceSeedHex === unlockedAgain.nativeOracleNonceSeedHex,
    true,
    'encrypted profile must preserve the same nonce seed after repeated unlock',
  )
  assert.equal(
    bytes.includes(Buffer.from(unlocked.nativeOracleNonceSeedHex, 'utf8')),
    false,
    'encrypted profile must not expose the native oracle nonce seed',
  )
})

test('strict versioned secrets refuse missing or malformed native oracle nonce seeds', async () => {
  const malformedBodies = [
    JSON.stringify({ version: 1, walletSeedHex: seed, nostrSecretKeyHex: nostrSecret }),
    JSON.stringify({ version: 2, walletSeedHex: seed, nostrSecretKeyHex: nostrSecret }),
    JSON.stringify({
      version: 2,
      walletSeedHex: seed,
      nostrSecretKeyHex: nostrSecret,
      nativeOracleNonceSeedHex: 'g'.repeat(64),
    }),
  ]

  for (let index = 0; index < malformedBodies.length; index += 1) {
    const directory = await freshProfileDirectory(`invalid-oracle-secret-${index}`)
    await bootstrap(directory)
    const malformedBody = Buffer.from(malformedBodies[index]!, 'utf8')
    const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
    try {
      database
        .prepare('UPDATE daemon_secret_authority SET secret_body = ? WHERE singleton = 1')
        .run(malformedBody)
    } finally {
      database.close()
    }

    await assert.rejects(
      readBootstrappedProfileSecrets(directory),
      secretError('secret-body-invalid'),
    )
    await assert.rejects(
      readBootstrappedProfileSecrets(directory),
      secretError('secret-body-invalid'),
    )

    const afterRead = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE), {
      readOnly: true,
    })
    try {
      const persisted = afterRead
        .prepare('SELECT secret_body AS body FROM daemon_secret_authority WHERE singleton = 1')
        .get() as { body: Uint8Array }
      assert.equal(Buffer.from(persisted.body).equals(malformedBody), true)
    } finally {
      afterRead.close()
    }
  }
})

test('every injected bootstrap fault removes only this invocation artifacts', async () => {
  const phases: ProfileBootstrapFaultPhase[] = [
    'database-reserved',
    'before-database-open',
    'schema-created',
    'authority-written',
    'during-initialization',
    'before-commit',
    'after-commit',
  ]
  for (const phase of phases) {
    const root = await freshRoot(`fault-${phase}`)
    const directory = join(root, 'profile')
    await assert.rejects(
      bootstrapFreshDaemonProfile({
        ...bootstrapInput(directory),
        injectFault(current) {
          if (current === phase) throw new Error(`fault:${phase}`)
        },
      }),
      new RegExp(`fault:${phase}`),
    )
    await assert.rejects(stat(directory), missingFile)
  }

  const existing = await freshProfileDirectory('fault-existing')
  createNativeConfig(defaultNativeConfig(), existing)
  const existingConfig = await readFile(join(existing, 'config.json'), 'utf8')
  await assert.rejects(
    bootstrapFreshDaemonProfile({
      ...bootstrapInput(existing),
      injectFault(phase) {
        if (phase === 'authority-written') throw new Error('existing-dir-fault')
      },
    }),
    /existing-dir-fault/,
  )
  assert.deepEqual(await readdir(existing), ['config.json'])
  assert.equal(await readFile(join(existing, 'config.json'), 'utf8'), existingConfig)
})

test('unlock rederives and compares every persisted public and wallet binding', async () => {
  for (const tamper of ['public-key', 'seed-digest', 'wallet-namespace'] as const) {
    const directory = await freshProfileDirectory(`tamper-${tamper}`)
    const original = await bootstrap(directory)
    const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
    try {
      database.exec('PRAGMA foreign_keys = OFF')
      if (tamper === 'public-key') {
        const replacementPublicKey = '55'.repeat(32)
        database
          .prepare('UPDATE daemon_profile SET nostr_public_key_hex = ? WHERE singleton = 1')
          .run(replacementPublicKey)
        database
          .prepare(
            `UPDATE daemon_secret_authority SET nostr_public_key_hex = ?
             WHERE singleton = 1`,
          )
          .run(replacementPublicKey)
      } else if (tamper === 'seed-digest') {
        database.prepare('UPDATE custody_scopes SET wallet_seed_digest = ?').run('66'.repeat(32))
      } else {
        const otherSeed = Buffer.from('77'.repeat(32), 'hex')
        const otherWalletId = deriveDurableCustodyWalletId(otherSeed)
        const otherScope = deriveDurableCustodyScopeId({
          scopeKind: 'wallet',
          walletId: otherWalletId,
        })
        database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
        try {
          database
            .prepare(
              `UPDATE custody_scopes
               SET scope_id = ?, wallet_id = ?, wallet_seed_digest = ?`,
            )
            .run(otherScope, otherWalletId, createHash('sha256').update(otherSeed).digest('hex'))
          database.prepare('UPDATE custody_scope_state SET scope_id = ?').run(otherScope)
          database.prepare('UPDATE daemon_profile SET wallet_scope_id = ?').run(otherScope)
          database.prepare('UPDATE daemon_secret_authority SET wallet_scope_id = ?').run(otherScope)
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      }
    } finally {
      database.close()
    }
    await assert.rejects(
      readBootstrappedProfileSecrets(directory),
      secretError('secret-binding-mismatch'),
      `${tamper}:${original.walletScopeId}`,
    )
  }
})

test('reserved final inode rejects pre-open and mid-init pathname replacement', async () => {
  for (const replacementPhase of ['before-database-open', 'during-initialization'] as const) {
    const directory = await freshProfileDirectory(`inode-race-${replacementPhase}`)
    const attackerBytes = Buffer.from(`attacker-owned:${replacementPhase}`)
    await assert.rejects(
      bootstrapFreshDaemonProfile({
        ...bootstrapInput(directory),
        injectFault(phase) {
          if (phase === replacementPhase) {
            unlinkSync(join(directory, DAEMON_PROFILE_DATABASE))
            writeFileSync(join(directory, DAEMON_PROFILE_DATABASE), attackerBytes, {
              mode: 0o600,
              flag: 'wx',
            })
          }
        },
      }),
      /inode identity changed/,
    )
    const persisted = await readFile(join(directory, DAEMON_PROFILE_DATABASE))
    assert.deepEqual(persisted, attackerBytes)
    assert.equal(persisted.includes(Buffer.from(seed)), false)
    assert.equal(persisted.includes(Buffer.from(nostrSecret)), false)
    assert.deepEqual(await readdir(directory), [DAEMON_PROFILE_DATABASE])
  }
})

test('legacy, partial, valid, and insecure-directory profiles are refused byte-identically', async () => {
  const legacy = await freshProfileDirectory('legacy')
  await writeFile(join(legacy, 'daemon-profile.json'), 'legacy-profile\n', {
    mode: 0o600,
  })
  const legacyBefore = await snapshotDirectory(legacy)
  await assert.rejects(
    bootstrapFreshDaemonProfile(bootstrapInput(legacy)),
    schemaError('legacy-artifact'),
  )
  assert.deepEqual(await snapshotDirectory(legacy), legacyBefore)

  const partial = await freshProfileDirectory('partial')
  await writeFile(join(partial, DAEMON_PROFILE_DATABASE), 'not-sqlite', {
    mode: 0o600,
  })
  const partialBefore = await snapshotDirectory(partial)
  await assert.rejects(
    bootstrapFreshDaemonProfile(bootstrapInput(partial)),
    schemaError('profile-not-fresh'),
  )
  assert.deepEqual(await snapshotDirectory(partial), partialBefore)

  const complete = await freshProfileDirectory('complete')
  await bootstrap(complete)
  const completeBefore = await snapshotDirectory(complete)
  await assert.rejects(
    bootstrapFreshDaemonProfile(bootstrapInput(complete)),
    schemaError('profile-not-fresh'),
  )
  assert.deepEqual(await snapshotDirectory(complete), completeBefore)

  const insecure = await freshProfileDirectory('insecure')
  await mkdir(insecure, { recursive: true })
  await import('node:fs/promises').then(({ chmod }) => chmod(insecure, 0o755))
  await assert.rejects(
    bootstrapFreshDaemonProfile(bootstrapInput(insecure)),
    schemaError('profile-permission-invalid'),
  )
  assert.equal((await stat(insecure)).mode & 0o777, 0o755)
})

test('scope fencing tolerates clock rollback and takeover advances epoch', async () => {
  assert.equal(CUSTODY_SCOPE_RENEW_INTERVAL_MS, 20_000)
  assert.equal(CUSTODY_SCOPE_LEASE_DURATION_MS, 60_000)
  const directory = await freshProfileDirectory('lease')
  const { walletScopeId } = await bootstrap(directory)
  const first = await claimCustodyScopeLease(directory, {
    scopeId: walletScopeId,
    incarnationId: 'incarnation-first',
    observedAtMs: initializedAtMs,
  })
  assert.equal(first.fencingEpoch, 1)
  assert.equal(first.leaseExpiresAtMs, initializedAtMs + 60_000)

  await assert.rejects(
    claimCustodyScopeLease(directory, {
      scopeId: walletScopeId,
      incarnationId: 'incarnation-second',
      observedAtMs: initializedAtMs + 1,
    }),
    leaseError('already-owned'),
  )
  const renewed = await renewCustodyScopeLease(
    directory,
    first,
    initializedAtMs + CUSTODY_SCOPE_RENEW_INTERVAL_MS,
  )
  assert.equal(renewed.fencingEpoch, 1)
  assert.equal(renewed.leaseExpiresAtMs, initializedAtMs + 80_000)
  await withDurableCustodyUnitOfWork(
    directory,
    first,
    initializedAtMs + CUSTODY_SCOPE_RENEW_INTERVAL_MS - 1,
    () => undefined,
  )

  const second = await claimCustodyScopeLease(directory, {
    scopeId: walletScopeId,
    incarnationId: 'incarnation-second',
    observedAtMs: renewed.leaseExpiresAtMs,
  })
  assert.equal(second.fencingEpoch, 2)
  await assert.rejects(
    renewCustodyScopeLease(directory, renewed, second.leaseExpiresAtMs - 1),
    leaseError('stale-fence'),
  )
  const renewedAfterClockRollback = await renewCustodyScopeLease(directory, second, initializedAtMs)
  assert.equal(renewedAfterClockRollback.fencingEpoch, second.fencingEpoch)
  assert.equal(renewedAfterClockRollback.leaseExpiresAtMs, second.leaseExpiresAtMs)
  const renewedAfterForwardJump = await renewCustodyScopeLease(
    directory,
    renewedAfterClockRollback,
    second.leaseExpiresAtMs + 1,
  )
  assert.equal(
    renewedAfterForwardJump.leaseExpiresAtMs,
    second.leaseExpiresAtMs + CUSTODY_SCOPE_LEASE_DURATION_MS + 1,
  )
})

test('session-backed lease renewals validate the profile only once', async () => {
  const directory = await freshProfileDirectory('lease-session')
  const { walletScopeId } = await bootstrap(directory)
  const claimed = await claimCustodyScopeLease(directory, {
    scopeId: walletScopeId,
    incarnationId: 'session-validation-owner',
    observedAtMs: initializedAtMs,
  })
  const storage = createDaemonStateSqliteSession(directory)
  const first = await renewCustodyScopeLease(
    storage,
    claimed,
    initializedAtMs + CUSTODY_SCOPE_RENEW_INTERVAL_MS,
  )
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
    database.exec('CREATE TABLE session_validation_probe (value INTEGER)')
  } finally {
    database.close()
  }
  const second = await renewCustodyScopeLease(
    storage,
    first,
    initializedAtMs + CUSTODY_SCOPE_RENEW_INTERVAL_MS * 2,
  )
  assert.equal(second.fencingEpoch, first.fencingEpoch)
  await assert.rejects(
    renewCustodyScopeLease(
      directory,
      second,
      initializedAtMs + CUSTODY_SCOPE_RENEW_INTERVAL_MS * 3,
    ),
    ProfileSchemaRefusalError,
  )
})

async function bootstrap(directory: string, overrides: { readonly passphrase?: string } = {}) {
  return bootstrapFreshDaemonProfile({
    ...bootstrapInput(directory),
    ...overrides,
  })
}

function bootstrapInput(directory: string) {
  return {
    directory,
    engineBaseUrl: 'http://localhost:5000/',
    mintUrl: 'http://localhost:8085/',
    walletSeedHex: seed,
    nostrSecretKeyHex: nostrSecret,
    rpcToken,
    initializedAtMs,
  }
}

async function freshRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `bitcaster-${name}-`))
  roots.push(root)
  return root
}

async function freshProfileDirectory(name: string): Promise<string> {
  const directory = join(await freshRoot(name), 'profile')
  await mkdir(directory, { mode: 0o700 })
  return directory
}

async function snapshotDirectory(directory: string) {
  const names = (await readdir(directory)).sort()
  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name)
      const metadata = await stat(path)
      return {
        name,
        mode: metadata.mode,
        bytes: metadata.isFile() ? await readFile(path) : null,
      }
    }),
  )
}

function schemaError(reason: ProfileSchemaRefusalError['reason']) {
  return (error: unknown) =>
    error instanceof Error &&
    error.name === 'ProfileSchemaRefusalError' &&
    'reason' in error &&
    error.reason === reason
}

function secretError(reason: ProfileSecretProtectionError['reason']) {
  return (error: unknown) =>
    error instanceof ProfileSecretProtectionError && error.reason === reason
}

function leaseError(reason: ScopeLeaseRefusalError['reason']) {
  return (error: unknown) => error instanceof ScopeLeaseRefusalError && error.reason === reason
}

function missingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function installUnixRpcMock(t: TestContext, firstErrorCode?: string) {
  const observed = { requests: 0, spawns: 0 }
  const request = mock.method(
    http,
    'request',
    (
      options: { socketPath: string; headers?: Record<string, string> },
      callback: (response: Readable) => void,
    ) => {
      observed.requests += 1
      assert.equal(options.socketPath.endsWith('/daemon.sock'), true)
      const pending = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
      pending.destroy = () => {}
      pending.end = () =>
        queueMicrotask(() => {
          if (firstErrorCode && observed.requests === 1) {
            pending.emit(
              'error',
              Object.assign(new Error('controlled transport failure'), { code: firstErrorCode }),
            )
            return
          }
          const watch = options.headers?.accept === 'application/x-ndjson'
          const response = Readable.from([
            Buffer.from(watch ? '{"type":"complete"}\n' : '{"ok":true,"result":{}}'),
          ]) as Readable & { statusCode: number; headers: Record<string, string> }
          response.statusCode = 200
          response.headers = { 'content-type': watch ? 'application/x-ndjson' : 'application/json' }
          callback(response)
        })
      return pending
    },
  )
  const spawn = mock.method(childProcess, 'spawn', () => {
    observed.spawns += 1
    throw new Error('unexpected daemon autostart')
  })
  const globals = globalThis as Record<symbol, unknown>
  const symbol = Symbol.for('bitcaster.test.daemon-url')
  const prior = globals[symbol]
  delete globals[symbol]
  syncBuiltinESMExports()
  t.after(() => {
    request.mock.restore()
    spawn.mock.restore()
    syncBuiltinESMExports()
    if (prior !== undefined) globals[symbol] = prior
  })
  return observed
}
