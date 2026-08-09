import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { acquireDaemonRunLock } from '../src/runLock.ts'
import { runOfflineDaemonSeedRecovery } from '../src/emergencySeedRecovery.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'

test('offline seed recovery refuses an active daemon run lock before mint setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-offline-recovery-lock-'))
  try {
    const walletSeedHex = '01'.repeat(64)
    await bootstrap(directory, walletSeedHex)
    const seedPath = await writeSeedFile(directory, walletSeedHex)
    await withDaemonHome(directory, async () => {
      const lock = await acquireDaemonRunLock()
      let walletCreated = false
      try {
        await assert.rejects(
          () =>
            runOfflineDaemonSeedRecovery({
              recoveryId: 'locked-recovery',
              mintUrl: 'https://mint.example',
              unit: 'sat',
              walletSeedHexFile: seedPath,
              disclosureAcknowledged: true,
              transport: guardedTransport(() => {
                walletCreated = true
                throw new Error('mint setup must not run')
              }),
            }),
          /already running/,
        )
      } finally {
        await lock.release()
      }
      assert.equal(walletCreated, false)
    })
  } finally {
    await removeRecoveryTemp(directory)
  }
})

test('offline seed recovery refuses prepared proof operations before mint setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-offline-recovery-prepared-'))
  try {
    const walletSeedHex = '02'.repeat(64)
    const profile = await bootstrap(directory, walletSeedHex)
    const seedPath = await writeSeedFile(directory, walletSeedHex)
    await withDatabase(directory, (database) =>
      insertPreparedProofOperation(database, profile.walletScopeId),
    )
    await withDaemonHome(directory, async () => {
      let walletCreated = false
      await assert.rejects(
        () =>
          runOfflineDaemonSeedRecovery({
            recoveryId: 'prepared-recovery',
            mintUrl: 'https://mint.example',
            unit: 'sat',
            walletSeedHexFile: seedPath,
            disclosureAcknowledged: true,
            transport: guardedTransport(() => {
              walletCreated = true
              throw new Error('mint setup must not run')
            }),
          }),
        /target-proof-operation-prepared/,
      )
      assert.equal(walletCreated, false)
    })
  } finally {
    await removeRecoveryTemp(directory)
  }
})

test('offline seed recovery refuses target-first reserved and locked proofs before mint setup', async () => {
  for (const state of ['reserved', 'locked'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `bitcaster-offline-recovery-${state}-`))
    try {
      const walletSeedHex = state === 'reserved' ? '05'.repeat(64) : '06'.repeat(64)
      const profile = await bootstrap(directory, walletSeedHex)
      const seedPath = await writeSeedFile(directory, walletSeedHex)
      await withDatabase(directory, (database) =>
        insertTargetProofReservation(database, profile.walletScopeId, state),
      )
      await withDaemonHome(directory, async () => {
        let walletCreated = false
        await assert.rejects(
          () =>
            runOfflineDaemonSeedRecovery({
              recoveryId: `${state}-recovery`,
              mintUrl: 'https://mint.example',
              unit: 'sat',
              walletSeedHexFile: seedPath,
              disclosureAcknowledged: true,
              transport: guardedTransport(() => {
                walletCreated = true
                throw new Error('mint setup must not run')
              }),
            }),
          /target-wallet-proof-reserved/,
        )
        assert.equal(walletCreated, false)
      })
      await withDatabase(directory, (database) => {
        assert.equal(readCount(database, 'custody_proofs'), 0)
        assert.equal(readCount(database, 'target_keyset_counters'), 0)
        assert.equal(readCount(database, 'seed_recovery_jobs'), 0)
        assert.equal(readCount(database, 'seed_recovery_keysets'), 0)
      })
    } finally {
      await removeRecoveryTemp(directory)
    }
  }
})

test('offline seed recovery refuses nonterminal swaps before mint setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-offline-recovery-swap-'))
  try {
    const walletSeedHex = '03'.repeat(64)
    const profile = await bootstrap(directory, walletSeedHex)
    const seedPath = await writeSeedFile(directory, walletSeedHex)
    await withDatabase(directory, (database) => {
      database
        .prepare(
          `INSERT INTO daemon_swaps (
             trade_id, scope_id, base_asset, divisibility, step, revision,
             created_at_ms, updated_at_ms
           ) VALUES ('swap-1', ?, 'sat', 10000, 'settling', 0, 0, 0)`,
        )
        .run(profile.walletScopeId)
    })
    await withDaemonHome(directory, async () => {
      let walletCreated = false
      await assert.rejects(
        () =>
          runOfflineDaemonSeedRecovery({
            recoveryId: 'swap-recovery',
            mintUrl: 'https://mint.example',
            unit: 'sat',
            walletSeedHexFile: seedPath,
            disclosureAcknowledged: true,
            transport: guardedTransport(() => {
              walletCreated = true
              throw new Error('mint setup must not run')
            }),
          }),
        /daemon-swap-nonterminal/,
      )
      assert.equal(walletCreated, false)
    })
  } finally {
    await removeRecoveryTemp(directory)
  }
})

test('offline seed recovery scans and commits a clean profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-offline-recovery-clean-'))
  try {
    const walletSeedHex = '04'.repeat(64)
    await bootstrap(directory, walletSeedHex)
    const seedPath = await writeSeedFile(directory, walletSeedHex)
    await withDaemonHome(directory, async () => {
      const result = await runOfflineDaemonSeedRecovery({
        recoveryId: 'clean-recovery',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        walletSeedHexFile: seedPath,
        disclosureAcknowledged: true,
        transport: emptyTransport(`01${'a'.repeat(64)}`),
      })
      assert.deepEqual(result, {
        recoveryId: 'clean-recovery',
        state: 'completed',
        selectedKeysetCount: 1,
        completedChildCount: 1,
        batchesProcessed: 1,
        gapLimit: 300,
      })
    })
  } finally {
    await removeRecoveryTemp(directory)
  }
})

async function bootstrap(directory: string, walletSeedHex: string) {
  return bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex,
    nostrSecretKeyHex: 'aa'.repeat(32),
    initializedAtMs: 1,
  })
}

async function writeSeedFile(directory: string, walletSeedHex: string): Promise<string> {
  const seedDirectory = `${directory}-seed`
  await mkdir(seedDirectory, { mode: 0o700 })
  const path = join(seedDirectory, 'wallet-seed.hex')
  await writeFile(path, `${walletSeedHex}\n`, { mode: 0o600 })
  return path
}

async function removeRecoveryTemp(directory: string): Promise<void> {
  await Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(`${directory}-seed`, { recursive: true, force: true }),
  ])
}

async function withDatabase(
  directory: string,
  action: (database: DatabaseSync) => void,
): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    action(database)
  } finally {
    database.close()
  }
}

function insertPreparedProofOperation(database: DatabaseSync, scopeId: string): void {
  for (const [id, kind] of [
    ['10'.repeat(32), 'exact-request'],
    ['20'.repeat(32), 'output-plan'],
  ] as const) {
    database
      .prepare(
        `INSERT INTO custody_artifacts (
           artifact_id, scope_id, artifact_kind, encoding, body, fingerprint,
           revision, private_material, created_at_ms
         ) VALUES (?, ?, ?, 'canonical-json', ?, ?, 0, 0, 0)`,
      )
      .run(id, scopeId, kind, Buffer.from('{}'), 'ff'.repeat(32))
  }
  database
    .prepare(
      `INSERT INTO target_proof_operations (
         operation_id, scope_id, kind, purpose, state, normalized_mint,
         request_artifact_id, output_artifact_id, result_artifact_id,
         result_proofs_digest, input_count, input_amount, last_error,
         reservation_id, created_at_ms, updated_at_ms
       ) VALUES ('prepared-1', ?, 'wallet-send', 'wallet-send', 'prepared',
         'https://mint.example', ?, ?, NULL, NULL, 0, 0, NULL, NULL, 0, 0)`,
    )
    .run(scopeId, '10'.repeat(32), '20'.repeat(32))
}

function insertTargetProofReservation(
  database: DatabaseSync,
  scopeId: string,
  state: 'reserved' | 'locked',
): void {
  database
    .prepare(
      `INSERT INTO target_wallet_proofs (
         proof_id, scope_id, normalized_mint, unit, keyset_id, amount, secret,
         signature, proof_body, state, reserved_by, asset_kind, condition_id,
         outcome_set_id, base_asset, created_at_ms, updated_at_ms
       ) VALUES (?, ?, 'https://mint.example', 'sat', 'keyset-1', 1, ?,
         'signature', X'7b7d', ?, 'reservation-1', 'sats', NULL, NULL, 'sat', 0, 0)`,
    )
    .run(state === 'reserved' ? 'a'.repeat(64) : 'b'.repeat(64), scopeId, `secret-${state}`, state)
}

function readCount(
  database: DatabaseSync,
  table:
    | 'custody_proofs'
    | 'target_keyset_counters'
    | 'seed_recovery_jobs'
    | 'seed_recovery_keysets',
): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
    .count
}

function emptyTransport(keysetId: string) {
  return {
    wallet: {
      async loadMint() {},
      keyChain: {
        getKeysets: () => [{ id: keysetId }],
        getKeyset: () => ({ id: keysetId, unit: 'sat', keys: {} }),
        async ensureKeysetKeys() {
          return { id: keysetId, unit: 'sat', keys: {} }
        },
      },
      getKeyset: () => ({ id: keysetId, unit: 'sat', keys: {} }),
      async checkProofsStates() {
        throw new Error('empty recovery batch must not call NUT-07')
      },
    },
    async listRegularKeysets() {
      return { keysets: [{ id: keysetId, unit: 'sat' }] }
    },
    async listConditionalKeysets() {
      return { keysets: [] }
    },
    async getConditionalKeyset() {
      throw new Error('empty recovery must not fetch conditional keys')
    },
    async restoreCandidates() {
      return { outputs: [], signatures: [] }
    },
  }
}

function guardedTransport(onUse: () => never) {
  const transport = emptyTransport(`01${'a'.repeat(64)}`)
  return {
    ...transport,
    listRegularKeysets: async () => onUse(),
    listConditionalKeysets: async () => onUse(),
  }
}

async function withDaemonHome(directory: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
  }
}
