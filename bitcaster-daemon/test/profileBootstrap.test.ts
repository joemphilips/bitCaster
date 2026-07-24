import assert from 'node:assert/strict'
import { createECDH, createHash } from 'node:crypto'
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
import {
  DAEMON_PROFILE_DATABASE,
  ProfileSchemaRefusalError,
  validateDaemonProfileSchema,
} from '../src/profileSchema.ts'
import {
  FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST,
  finalProfileSchemaManifestDigest,
  getFinalProfileSchemaManifest,
} from '../src/profileSchemaManifest.ts'
import {
  ProfileSecretProtectionError,
  protectTargetEphemeralPrivateKey,
  unlockTargetEphemeralPrivateKey,
} from '../src/profileSecretProtection.ts'

const roots: string[] = []
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const seed = '11'.repeat(32)
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
  assert.deepEqual(await readdir(directory), [DAEMON_PROFILE_DATABASE])

  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  try {
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
    'custody_successor_admissions',
    'custody_successor_admission_proofs',
    'custody_deliveries',
    'custody_active_work',
    'daemon_orders',
    'order_collateral_pins',
    'daemon_swaps',
    'swap_operation_links',
    'target_ephemeral_keys',
    'seed_recovery_jobs',
    'seed_recovery_keysets',
    'seed_recovery_pending_proofs',
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
  for (const forbidden of [
    'daemon_trade_sessions',
    'daemon_trade_ciphers',
    'custody_session_links',
    'trade_cipher_recovery',
    'adaptor_recovery',
    'presignature_recovery',
  ]) {
    assert.ok(!names.has(forbidden), forbidden)
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
          'pinned-operation-bound-deterministic', ?, 0,
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

test('target-v1 ephemeral private keys are passphrase protected and binding exact', () => {
  const privateKeyHex = '33'.repeat(32)
  const ecdh = createECDH('secp256k1')
  ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'))
  const binding = {
    walletScopeId: '44'.repeat(32),
    orderId: 'order-1',
    tradeId: 'trade-1',
    marketId: 'condition-yes',
    publicKeyHex: ecdh.getPublicKey('hex', 'compressed'),
  }
  const protectedBody = protectTargetEphemeralPrivateKey(privateKeyHex, binding, 'key passphrase')
  assert.equal(
    unlockTargetEphemeralPrivateKey(protectedBody, binding, 'key passphrase'),
    privateKeyHex,
  )
  assert.throws(
    () =>
      unlockTargetEphemeralPrivateKey(
        protectedBody,
        { ...binding, orderId: 'other-order' },
        'key passphrase',
      ),
    secretError('unlock-failed'),
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
  await assert.rejects(
    bootstrapFreshDaemonProfile({
      ...bootstrapInput(existing),
      injectFault(phase) {
        if (phase === 'authority-written') throw new Error('existing-dir-fault')
      },
    }),
    /existing-dir-fault/,
  )
  assert.deepEqual(await readdir(existing), [])
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
