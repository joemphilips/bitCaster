import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  Amount,
  CheckStateEnum,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type MintKeys,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { planExactSeedRecoveryBatch } from '@bitcaster-market/client-sdk/conditionalKeysetSeedRecovery'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease, releaseCustodyScopeLease } from '../src/profileFencing.ts'
import { acquireDaemonRunLock } from '../src/runLock.ts'
import {
  runOfflineDaemonSeedRecovery,
  type AllKeysetSeedRecoveryTransport,
} from '../src/emergencySeedRecovery.ts'
import { advanceDaemonKeysetCounter, reserveDaemonKeysetCounter } from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const KEYSET_ID = canonicalTestKeysetId('offline-seed-recovery')

test('offline seed recovery rejects the sat product unit before acquiring the run lock', async () => {
  await assert.rejects(
    () =>
      runOfflineDaemonSeedRecovery({
        recoveryId: 'sat-recovery',
        mintUrl: 'https://mint.example',
        unit: 'sat' as never,
        walletSeedHexFile: '/tmp/forbidden-wallet-seed.hex',
        disclosureAcknowledged: true,
      }),
    /only the msat product unit/,
  )
})

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
              unit: 'msat',
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
            unit: 'msat',
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
              unit: 'msat',
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
        unit: 'msat',
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

test('offline recovery imports only unspent change after operation and proof payload loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-offline-recovery-high-water-'))
  try {
    const walletSeedHex = '07'.repeat(64)
    const profile = await bootstrap(directory, walletSeedHex)
    const seedPath = await writeSeedFile(directory, walletSeedHex)
    const mintPrivateKey = Uint8Array.from([...new Uint8Array(31), 2])
    const mintPublicKey = Buffer.from(secp256k1.getPublicKey(mintPrivateKey, true)).toString('hex')
    const keyset = regularKeyset({ '1': mintPublicKey })
    const expectedCandidates = planExactSeedRecoveryBatch({
      seed: Uint8Array.from(Buffer.from(walletSeedHex, 'hex')),
      keysetId: keyset.id,
      startCounter: 0,
      count: 4,
    })
    let expectedProofs: Proof[] = []
    let restoreCalls = 0
    let stateCalls = 0
    const expectedCandidateBlindedOutputs = new Set(
      expectedCandidates.map(({ blindedOutput }) => blindedOutput.B_),
    )
    const transport = offlineRecoveryTransport({
      keyset,
      onProofs(proofs) {
        stateCalls += 1
        assert.equal(proofs.length, 4)
        const expectedCounterBySecret = new Map(
          expectedProofs.map((proof, counter) => [proof.secret, counter]),
        )
        return [...proofs].reverse().map((proof) => {
          const counter = expectedCounterBySecret.get(proof.secret)
          assert.notEqual(counter, undefined, 'NUT-07 proof secret must bind to a candidate Y')
          return {
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            state: counter! < 2 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
            witness: null,
          }
        })
      },
      async onRestore(outputs) {
        restoreCalls += 1
        assert.equal(outputs.length, 300)
        const candidates = outputs as readonly SerializedBlindedMessage[]
        assert.equal(candidates[0]?.id, keyset.id)
        if (restoreCalls === 1) {
          assert.deepEqual(
            candidates.slice(0, 4).map(({ B_ }) => B_),
            expectedCandidates.map(({ blindedOutput }) => blindedOutput.B_),
          )
        }
        const recoveredOutputs = candidates.filter(({ B_ }) =>
          expectedCandidateBlindedOutputs.has(B_),
        )
        if (restoreCalls > 1) assert.equal(recoveredOutputs.length, 0)
        if (recoveredOutputs.length === 0) return { outputs: [], signatures: [] }
        const signatures = recoveredOutputs.map((output) => {
          const blindedPoint = pointFromHex(output.B_)
          const signature = createBlindSignature(blindedPoint, mintPrivateKey, output.id)
          const dleq = createDLEQProof(blindedPoint, mintPrivateKey)
          return {
            id: output.id,
            amount: Amount.from(1),
            C_: signature.C_.toHex(true),
            dleq: {
              e: Buffer.from(dleq.e).toString('hex'),
              s: Buffer.from(dleq.s).toString('hex'),
            },
          }
        })
        expectedProofs = expectedCandidates.map((candidate, index) =>
          candidate.outputData.toProof(signatures[index]!, keyset),
        )
        return {
          outputs: recoveredOutputs.map((output) => ({ ...output, amount: Amount.from(0) })),
          signatures,
        }
      },
    })

    await withDaemonHome(directory, async () => {
      const fence = await claimCustodyScopeLease(directory, {
        scopeId: profile.walletScopeId,
        incarnationId: 'offline-recovery-high-water-setup',
        observedAtMs: 2,
      })
      try {
        await advanceDaemonKeysetCounter(
          keyset.id,
          4,
          { fence, observedAtMs: 3 },
          { normalizedMint: 'https://mint.example', unit: 'msat' },
        )
      } finally {
        await releaseCustodyScopeLease(directory, fence, 4)
      }

      await withDatabase(directory, (database) => {
        assert.deepEqual(readRecoveryPayloadCounts(database), {
          targetProofOperations: 0,
          custodyOperations: 0,
          custodyArtifacts: 0,
          targetProofs: 0,
          custodyProofs: 0,
        })
      })

      const result = await runOfflineDaemonSeedRecovery({
        recoveryId: 'high-water-recovery',
        mintUrl: 'https://mint.example',
        unit: 'msat',
        walletSeedHexFile: seedPath,
        disclosureAcknowledged: true,
        transport,
      })
      assert.equal(result.state, 'completed')
      assert.equal(result.selectedKeysetCount, 1)
      assert.equal(restoreCalls, 2)
      assert.equal(stateCalls, 1)

      await withDatabase(directory, (database) => {
        const rows = readCustodyProofs(database, profile.walletScopeId)
        const expectedRecoveredProofs = expectedProofs
          .slice(2)
          .map((proof) => ({
            proof: {
              id: proof.id,
              amount: String(proof.amount),
              secret: proof.secret,
              C: proof.C,
            },
            nut07State: 'UNSPENT',
            selectability: 'selectable',
          }))
          .sort((left, right) => left.proof.secret.localeCompare(right.proof.secret))
        assert.deepEqual(
          rows.map(({ proof, nut07State, selectability }) => ({
            proof: {
              id: proof.id,
              amount: proof.amount,
              secret: proof.secret,
              C: proof.C,
            },
            nut07State,
            selectability,
          })),
          expectedRecoveredProofs,
        )
        assert.deepEqual(readCounterRows(database, profile.walletScopeId), {
          target: [{ keysetId: keyset.id, nextCounter: 4 }],
          custody: [{ keysetId: keyset.id, nextCounter: 4 }],
        })
      })

      const reserveAtMs = Date.now()
      const reservationFence = await claimCustodyScopeLease(directory, {
        scopeId: profile.walletScopeId,
        incarnationId: 'offline-recovery-next-reservation',
        observedAtMs: reserveAtMs,
      })
      try {
        assert.deepEqual(
          await reserveDaemonKeysetCounter(
            keyset.id,
            1,
            { fence: reservationFence, observedAtMs: reserveAtMs },
            { normalizedMint: 'https://mint.example', unit: 'msat' },
          ),
          { start: 4, count: 1 },
        )
      } finally {
        await releaseCustodyScopeLease(directory, reservationFence, reserveAtMs + 1)
      }
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
       ) VALUES (?, ?, 'https://mint.example', 'msat', '${KEYSET_ID}', 1, ?,
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
    | 'seed_recovery_keysets'
    | 'target_proof_operations'
    | 'custody_operations'
    | 'custody_artifacts'
    | 'target_wallet_proofs',
): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
    .count
}

function readRecoveryPayloadCounts(database: DatabaseSync) {
  return {
    targetProofOperations: readCount(database, 'target_proof_operations'),
    custodyOperations: readCount(database, 'custody_operations'),
    custodyArtifacts: readCount(database, 'custody_artifacts'),
    targetProofs: readCount(database, 'target_wallet_proofs'),
    custodyProofs: readCount(database, 'custody_proofs'),
  }
}

function readCustodyProofs(database: DatabaseSync, scopeId: string) {
  const rows = database
    .prepare(
      `SELECT proof_body AS proofBody, nut07_state AS nut07State,
              selectability
       FROM custody_proofs WHERE scope_id = ? ORDER BY proof_id`,
    )
    .all(scopeId) as Array<{
    proofBody: Uint8Array
    nut07State: 'UNSPENT' | 'SPENT' | 'PENDING'
    selectability: 'selectable' | 'locked' | 'spent' | 'retained'
  }>
  return rows
    .map(({ proofBody, ...state }) => ({
      ...state,
      proof: JSON.parse(new TextDecoder().decode(proofBody)) as {
        id: string
        amount: string
        secret: string
        C: string
      },
    }))
    .sort((left, right) => left.proof.secret.localeCompare(right.proof.secret))
}

function readCounterRows(database: DatabaseSync, scopeId: string) {
  const read = (table: 'target_keyset_counters' | 'custody_keyset_counters') =>
    (
      database
        .prepare(
          `SELECT keyset_id AS keysetId, next_counter AS nextCounter
           FROM ${table} WHERE scope_id = ? ORDER BY keyset_id`,
        )
        .all(scopeId) as Array<{ keysetId: string; nextCounter: number }>
    ).map(({ keysetId, nextCounter }) => ({ keysetId, nextCounter }))
  return { target: read('target_keyset_counters'), custody: read('custody_keyset_counters') }
}

function regularKeyset(keys: Record<string, string>): MintKeys {
  const unit = 'msat'
  return { id: deriveKeysetId(keys, { unit, versionByte: 1 }), unit, keys }
}

function offlineRecoveryTransport(input: {
  readonly keyset: MintKeys
  readonly onProofs: (proofs: readonly Proof[]) => ProofState[]
  readonly onRestore: (outputs: readonly unknown[]) => unknown
}): AllKeysetSeedRecoveryTransport {
  return {
    wallet: {
      async loadMint() {},
      keyChain: {
        getKeyset: () => input.keyset,
        async ensureKeysetKeys() {
          return input.keyset
        },
      },
      async checkProofsStates(proofs) {
        return input.onProofs(proofs)
      },
    },
    async listRegularKeysets() {
      return { keysets: [{ id: input.keyset.id, unit: input.keyset.unit }] }
    },
    async listConditionalKeysets() {
      return { keysets: [] }
    },
    async getConditionalKeyset() {
      throw new Error('regular recovery must not fetch conditional keys')
    },
    async restoreCandidates(outputs) {
      return input.onRestore(outputs)
    },
  }
}

function emptyTransport(keysetId: string) {
  return {
    wallet: {
      async loadMint() {},
      keyChain: {
        getKeysets: () => [{ id: keysetId }],
        getKeyset: () => ({ id: keysetId, unit: 'msat', keys: {} }),
        async ensureKeysetKeys() {
          return { id: keysetId, unit: 'msat', keys: {} }
        },
      },
      getKeyset: () => ({ id: keysetId, unit: 'msat', keys: {} }),
      async checkProofsStates() {
        throw new Error('empty recovery batch must not call NUT-07')
      },
    },
    async listRegularKeysets() {
      return { keysets: [{ id: keysetId, unit: 'msat' }] }
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
