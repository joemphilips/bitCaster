import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CheckStateEnum, type Proof, type ProofState } from '@cashu/cashu-ts'
import {
  recoverDaemonWalletFromSeed,
  type EmergencySeedRecoveryWallet,
} from '../src/emergencySeedRecovery.ts'
import {
  emptyDaemonState,
  readDaemonStateDatabase,
  readState,
  setStateWriteFaultHookForTest,
  writeState,
} from '../src/state.ts'

const WALLET_SEED_HEX = '01'.repeat(32)
const V2_KEYSET_ID = `01${'11'.repeat(32)}`
const V3_KEYSET_ID = `02${'22'.repeat(32)}`

test('seed recovery imports only unspent proofs and resumes at its durable cursor', async () => {
  await withDaemonHome(async () => {
    const starts: number[] = []
    const wallet = recoveryWallet({
      restore(start) {
        starts.push(start)
        return start === 0
          ? { proofs: [proof('recovered')], lastCounterWithSignature: 299 }
          : { proofs: [] }
      },
      proofState: CheckStateEnum.UNSPENT,
    })

    const result = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'recovery-unspent',
      createWallet: () => wallet,
      nowMs: () => 1_000,
    })

    assert.equal(result.state, 'completed')
    assert.equal(result.importedProofs, 1)
    assert.deepEqual(starts, [0, 300])
    const state = await readState()
    assert.deepEqual(
      state?.wallet.proofs.map((record) => record.proof.secret),
      ['recovered'],
    )
    assert.equal(state?.wallet.keysetCounters[V2_KEYSET_ID], 600)

    const restarted = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'unused-recovery-id',
      createWallet: () => wallet,
      nowMs: () => 2_000,
    })
    assert.equal(restarted.recoveryId, 'recovery-unspent')
    assert.equal(restarted.state, 'completed')
    assert.equal(restarted.importedProofs, 1)
    assert.deepEqual(starts, [0, 300])
  })
})

test('pending NUT-07 state is durably retained and never advances the cursor or becomes balance', async () => {
  await withDaemonHome(async () => {
    let mintState: ProofState['state'] = CheckStateEnum.PENDING
    const starts: number[] = []
    const wallet = recoveryWallet({
      restore(start) {
        starts.push(start)
        return start === 0
          ? { proofs: [proof('pending')], lastCounterWithSignature: 0 }
          : { proofs: [] }
      },
      get proofState() {
        return mintState
      },
    })

    const blocked = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'recovery-pending',
      createWallet: () => wallet,
      nowMs: () => 1_000,
    })
    assert.equal(blocked.state, 'pending-mint-state')
    assert.equal(blocked.pendingProofs, 1)
    const pendingState = await readState()
    assert.equal(pendingState?.wallet.proofs.length, 1)
    assert.equal(pendingState?.wallet.proofs[0]?.state, 'locked')
    assert.equal(
      pendingState?.wallet.proofs[0]?.reservedBy,
      'seed-recovery:recovery-pending',
    )
    assert.equal(
      await readDaemonStateDatabase((database) =>
        database
          .prepare(
            `SELECT reason, mint_state, wallet_proof_id
               FROM daemon_seed_recovery_proof_retention
              WHERE recovery_id = 'recovery-pending'`,
          )
          .get(),
      ).then((row) => row?.reason),
      'pending-mint-state',
    )

    assert.deepEqual(await recoveryAccounting('recovery-pending'), {
      jobRevision: 1,
      workUnits: 1,
      proofCount: 1,
      jobRetainedPendingProofs: 1,
      jobUpdatedAt: 1_000,
      keysetRevision: 1,
      batchCount: 1,
      keysetRetainedPendingProofs: 1,
      curve: 'secp256k1',
      proofYLength: 66,
      retentionCount: 1,
    })

    const blockedAgain = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'unused-recovery-id',
      createWallet: () => wallet,
      nowMs: () => 1_500,
    })
    assert.equal(blockedAgain.state, 'pending-mint-state')
    assert.deepEqual(await recoveryAccounting('recovery-pending'), {
      jobRevision: 2,
      workUnits: 2,
      proofCount: 2,
      jobRetainedPendingProofs: 1,
      jobUpdatedAt: 1_500,
      keysetRevision: 2,
      batchCount: 2,
      keysetRetainedPendingProofs: 1,
      curve: 'secp256k1',
      proofYLength: 66,
      retentionCount: 1,
    })

    mintState = CheckStateEnum.UNSPENT
    const resumed = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'unused-recovery-id',
      createWallet: () => wallet,
      nowMs: () => 2_000,
    })
    assert.equal(resumed.state, 'completed')
    assert.equal(resumed.importedProofs, 1)
    assert.deepEqual(starts, [0, 0, 0, 300])
    assert.equal((await readState())?.wallet.proofs[0]?.state, 'available')
    assert.equal(
      await readDaemonStateDatabase((database) =>
        database
          .prepare(
            `SELECT reason, mint_state, wallet_proof_id
               FROM daemon_seed_recovery_proof_retention
              WHERE recovery_id = 'recovery-pending'`,
          )
          .get(),
      ).then((row) => row),
      undefined,
    )
    assert.deepEqual(await recoveryAccounting('recovery-pending'), {
      jobRevision: 4,
      workUnits: 4,
      proofCount: 3,
      jobRetainedPendingProofs: 1,
      jobUpdatedAt: 2_000,
      keysetRevision: 4,
      batchCount: 4,
      keysetRetainedPendingProofs: 1,
      curve: 'secp256k1',
      proofYLength: null,
      retentionCount: 0,
    })
  })
})

test('v3 pending recovery persists BLS curve and proof Y while malformed versions fail closed', async () => {
  await withDaemonHome(async () => {
    const wallet = recoveryWallet({
      keysetId: V3_KEYSET_ID,
      restore: () => ({
        proofs: [proof('bls-pending', V3_KEYSET_ID)],
        lastCounterWithSignature: 0,
      }),
      proofState: CheckStateEnum.PENDING,
    })
    const pending = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'recovery-bls',
      createWallet: () => wallet,
      nowMs: () => 1_000,
    })
    assert.equal(pending.state, 'pending-mint-state')
    assert.equal((await recoveryAccounting('recovery-bls')).curve, 'bls12-381')
    assert.equal((await recoveryAccounting('recovery-bls')).proofYLength, 96)
  })

  for (const keysetId of ['keyset-1', `03${'33'.repeat(32)}`]) {
    await withDaemonHome(async () => {
      const wallet = recoveryWallet({
        keysetId,
        restore: () => ({ proofs: [] }),
        proofState: CheckStateEnum.UNSPENT,
      })
      await assert.rejects(
        recoverDaemonWalletFromSeed(recoveryInput(), {
          createRecoveryId: () => 'recovery-invalid-keyset',
          createWallet: () => wallet,
          nowMs: () => 1_000,
        }),
        /keyset ID/,
      )
    })
  }
})

test('pending recovery accounting and proof retention roll back together on a write fault', async () => {
  await withDaemonHome(async () => {
    let injectFault = true
    const wallet = recoveryWallet({
      restore: () => {
        if (injectFault) {
          setStateWriteFaultHookForTest((stage) => {
            if (stage === 'before-commit') {
              throw new Error('simulated pending crash')
            }
          })
          injectFault = false
        }
        return {
          proofs: [proof('pending-fault')],
          lastCounterWithSignature: 0,
        }
      },
      proofState: CheckStateEnum.PENDING,
    })

    await assert.rejects(
      recoverDaemonWalletFromSeed(recoveryInput(), {
        createRecoveryId: () => 'recovery-pending-fault',
        createWallet: () => wallet,
        nowMs: () => 1_000,
      }),
      /simulated pending crash/,
    )
    setStateWriteFaultHookForTest(undefined)
    assert.equal((await readState())?.wallet.proofs.length, 0)
    assert.deepEqual(await recoveryAccounting('recovery-pending-fault'), {
      jobRevision: 0,
      workUnits: 0,
      proofCount: 0,
      jobRetainedPendingProofs: 0,
      jobUpdatedAt: 1_000,
      keysetRevision: 0,
      batchCount: 0,
      keysetRetainedPendingProofs: 0,
      curve: 'secp256k1',
      proofYLength: null,
      retentionCount: 0,
    })
  })
})

test('pending-to-unspent reconciliation rolls back exact recovery authority and retries once', async () => {
  await withDaemonHome(async () => {
    let mintState: ProofState['state'] = CheckStateEnum.PENDING
    let injectReconciliationFault = false
    const starts: number[] = []
    const wallet = recoveryWallet({
      restore(start) {
        starts.push(start)
        if (injectReconciliationFault) {
          setStateWriteFaultHookForTest((stage) => {
            if (stage === 'before-commit') {
              throw new Error('simulated reconciliation crash')
            }
          })
          injectReconciliationFault = false
        }
        return start === 0
          ? {
              proofs: [proof('reconciliation-fault')],
              lastCounterWithSignature: 0,
            }
          : { proofs: [] }
      },
      get proofState() {
        return mintState
      },
    })

    const pending = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'recovery-reconciliation-fault',
      createWallet: () => wallet,
      nowMs: () => 1_000,
    })
    assert.equal(pending.state, 'pending-mint-state')
    const beforeFault = await recoveryAuthoritySnapshot(
      'recovery-reconciliation-fault',
      'reconciliation-fault',
    )
    assert.equal(beforeFault.retention?.mint_state, 'PENDING')
    assert.equal(beforeFault.walletProof?.state, 'locked')
    assert.equal(
      beforeFault.walletProof?.reserved_by,
      'seed-recovery:recovery-reconciliation-fault',
    )

    mintState = CheckStateEnum.UNSPENT
    injectReconciliationFault = true
    await assert.rejects(
      recoverDaemonWalletFromSeed(recoveryInput(), {
        createRecoveryId: () => 'unused-recovery-id',
        createWallet: () => wallet,
        nowMs: () => 1_000,
      }),
      /simulated reconciliation crash/,
    )
    setStateWriteFaultHookForTest(undefined)

    assert.deepEqual(
      await recoveryAuthoritySnapshot(
        'recovery-reconciliation-fault',
        'reconciliation-fault',
      ),
      beforeFault,
    )

    const retried = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'unused-recovery-id',
      createWallet: () => wallet,
      nowMs: () => 2_000,
    })
    assert.equal(retried.state, 'completed')
    assert.equal(retried.importedProofs, 1)
    assert.deepEqual(starts, [0, 0, 0, 300])

    const afterRetry = await recoveryAuthoritySnapshot(
      'recovery-reconciliation-fault',
      'reconciliation-fault',
    )
    assert.equal(afterRetry.retention, undefined)
    assert.equal(afterRetry.walletProof?.state, 'available')
    assert.equal(afterRetry.walletProof?.reserved_by, null)
    assert.equal(afterRetry.walletCounter?.counter_value, 600)
    assert.equal(
      afterRetry.job?.revision,
      Number(beforeFault.job?.revision) + 2,
    )
    assert.equal(
      afterRetry.job?.work_units,
      Number(beforeFault.job?.work_units) + 2,
    )
    assert.equal(
      afterRetry.job?.proof_count,
      Number(beforeFault.job?.proof_count) + 1,
    )
    assert.equal(afterRetry.job?.imported_proofs, 1)
    assert.equal(afterRetry.job?.ignored_spent_proofs, 0)
    assert.equal(
      afterRetry.job?.retained_pending_proofs,
      beforeFault.job?.retained_pending_proofs,
    )
    assert.equal(afterRetry.job?.current_cursor, null)
    assert.equal(afterRetry.job?.current_cursor_digest, null)
    assert.equal(
      afterRetry.keyset?.revision,
      Number(beforeFault.keyset?.revision) + 2,
    )
    assert.equal(
      afterRetry.keyset?.batch_count,
      Number(beforeFault.keyset?.batch_count) + 2,
    )
    assert.equal(afterRetry.keyset?.imported_proofs, 1)
    assert.equal(afterRetry.keyset?.ignored_spent_proofs, 0)
    assert.equal(
      afterRetry.keyset?.retained_pending_proofs,
      beforeFault.keyset?.retained_pending_proofs,
    )
    assert.equal(afterRetry.keyset?.next_counter, 600)
    assert.equal(afterRetry.keyset?.state, 'completed')
  })
})

test('a crash after restore response retries the same counter without duplicates', async () => {
  await withDaemonHome(async () => {
    const starts: number[] = []
    let injectFault = true
    const wallet = recoveryWallet({
      restore(start) {
        starts.push(start)
        if (injectFault) {
          setStateWriteFaultHookForTest((stage) => {
            if (stage === 'before-commit') throw new Error('simulated crash')
          })
          injectFault = false
        }
        return start === 0
          ? { proofs: [proof('crash-boundary')], lastCounterWithSignature: 299 }
          : { proofs: [] }
      },
      proofState: CheckStateEnum.UNSPENT,
    })

    await assert.rejects(
      recoverDaemonWalletFromSeed(recoveryInput(), {
        createRecoveryId: () => 'recovery-crash',
        createWallet: () => wallet,
        nowMs: () => 1_000,
      }),
      /simulated crash/,
    )
    setStateWriteFaultHookForTest(undefined)
    assert.equal((await readState())?.wallet.proofs.length, 0)

    const resumed = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'unused-recovery-id',
      createWallet: () => wallet,
      nowMs: () => 2_000,
    })
    assert.equal(resumed.state, 'completed')
    assert.deepEqual(starts, [0, 0, 300])
    assert.deepEqual(
      (await readState())?.wallet.proofs.map((record) => record.proof.secret),
      ['crash-boundary'],
    )
  })
})

function recoveryInput() {
  return {
    mintUrl: 'https://mint.example',
    walletSeedHex: WALLET_SEED_HEX,
    disclosureAcknowledged: true,
  }
}

function recoveryWallet(input: {
  keysetId?: string
  restore(start: number): { proofs: Proof[]; lastCounterWithSignature?: number }
  readonly proofState: ProofState['state']
}): EmergencySeedRecoveryWallet {
  return {
    async loadMint() {},
    keyChain: { getKeysets: () => [{ id: input.keysetId ?? V2_KEYSET_ID }] },
    async restore(start) {
      return input.restore(start)
    },
    async checkProofsStates(proofs) {
      return proofs.map(() => ({
        Y: '02'.padEnd(66, '1'),
        state: input.proofState,
        witness: null,
      }))
    },
  }
}

function proof(secret: string, keysetId = V2_KEYSET_ID): Proof {
  return {
    id: keysetId,
    amount: 1,
    secret,
    C: '02'.padEnd(66, '2'),
  }
}

async function recoveryAccounting(recoveryId: string) {
  return readDaemonStateDatabase((database) => {
    const job = database
      .prepare(
        `SELECT revision, work_units, proof_count, retained_pending_proofs,
                updated_at
           FROM daemon_seed_recovery_jobs
          WHERE recovery_id = ?`,
      )
      .get(recoveryId)
    const keyset = database
      .prepare(
        `SELECT revision, batch_count, retained_pending_proofs, curve
           FROM daemon_seed_recovery_keysets
          WHERE recovery_id = ?`,
      )
      .get(recoveryId)
    const retention = database
      .prepare(
        `SELECT COUNT(*) AS count, length(MAX(proof_y)) AS proof_y_length
           FROM daemon_seed_recovery_proof_retention
          WHERE recovery_id = ?`,
      )
      .get(recoveryId)
    return {
      jobRevision: job?.revision,
      workUnits: job?.work_units,
      proofCount: job?.proof_count,
      jobRetainedPendingProofs: job?.retained_pending_proofs,
      jobUpdatedAt: job?.updated_at,
      keysetRevision: keyset?.revision,
      batchCount: keyset?.batch_count,
      keysetRetainedPendingProofs: keyset?.retained_pending_proofs,
      curve: keyset?.curve,
      proofYLength: retention?.proof_y_length,
      retentionCount: retention?.count,
    }
  })
}

async function recoveryAuthoritySnapshot(
  recoveryId: string,
  proofSecret: string,
) {
  return readDaemonStateDatabase((database) => ({
    job: database
      .prepare(
        `SELECT revision, current_cursor, current_cursor_digest, page_count,
                keyset_count, transport_bytes, serialized_bytes, work_units,
                proof_count, imported_proofs, ignored_spent_proofs,
                retained_pending_proofs, updated_at
           FROM daemon_seed_recovery_jobs
          WHERE recovery_id = ?`,
      )
      .get(recoveryId),
    keyset: database
      .prepare(
        `SELECT state, next_counter, trailing_empty_counters, revision,
                batch_count, imported_proofs, ignored_spent_proofs,
                retained_pending_proofs, key_count
           FROM daemon_seed_recovery_keysets
          WHERE recovery_id = ?`,
      )
      .get(recoveryId),
    retention: database
      .prepare(
        `SELECT keyset_id, retention_id, wallet_proof_id, proof_digest,
                proof_y, mint_state, reason, observed_at
           FROM daemon_seed_recovery_proof_retention
          WHERE recovery_id = ?`,
      )
      .get(recoveryId),
    walletProof: database
      .prepare(
        `SELECT proof_id, keyset_id, state, reserved_by, updated_at
           FROM daemon_wallet_proofs
          WHERE proof_secret = ?`,
      )
      .get(proofSecret),
    walletCounter: database
      .prepare(
        `SELECT counter_value
           FROM daemon_keyset_counters
          WHERE counter_key = ?`,
      )
      .get(V2_KEYSET_ID),
  }))
}

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-seed-recovery-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await writeState(emptyDaemonState())
    await run()
  } finally {
    setStateWriteFaultHookForTest(undefined)
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
}
