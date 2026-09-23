import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
  readBootstrappedRpcToken,
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

const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const seed = '11'.repeat(64)
const nostrSecret = '22'.repeat(32)
const rpcToken = 'R'.repeat(43)
const initializedAtMs = 1_700_000_000_000

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
  assert.deepEqual(await readBootstrappedProfileSecrets(directory), {
    walletSeedHex: seed,
    nostrSecretKeyHex: nostrSecret,
    nostrPublicKeyHex: result.nostrPublicKeyHex,
  })

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

test('production schema manifest is pinned and excludes source-only recovery authority', () => {
  assert.equal(finalProfileSchemaManifestDigest(), FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST)
  const manifest = getFinalProfileSchemaManifest()
  assert.equal(FINAL_PROFILE_SCHEMA_VERSION, 3)
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(Object.isFrozen(manifest.objects), true)
  const names = new Set(manifest.objects.map((object) => object.name))
  for (const required of [
    'custody_proofs',
    'custody_keyset_counters',
    'custody_operations',
    'custody_artifacts',
    'custody_operation_tombstones',
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
  ]) {
    assert.ok(names.has(required), required)
  }
  for (const required of [
    'custody_operations_retained_operation_key_typed_idx',
    'daemon_outgoing_cashu_transfers_due_idx',
    'daemon_outgoing_cashu_transfers_all_mints_due_idx',
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
  assert.deepEqual(await readFile(join(directory, DAEMON_PROFILE_DATABASE)), bytes)
  assert.equal(
    (await readBootstrappedProfileSecrets(directory, 'correct horse')).nostrPublicKeyHex,
    result.nostrPublicKeyHex,
  )
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
  return (error: unknown) => error instanceof ProfileSchemaRefusalError && error.reason === reason
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
