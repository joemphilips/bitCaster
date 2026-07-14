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
  readState,
  setStateWriteFaultHookForTest,
  writeState,
} from '../src/state.ts'

const WALLET_SEED_HEX = '01'.repeat(32)

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
    assert.equal(state?.wallet.keysetCounters['keyset-1'], 600)

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

test('pending NUT-07 state never advances the cursor or becomes balance', async () => {
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
    assert.equal((await readState())?.wallet.proofs.length, 0)

    mintState = CheckStateEnum.SPENT
    const resumed = await recoverDaemonWalletFromSeed(recoveryInput(), {
      createRecoveryId: () => 'unused-recovery-id',
      createWallet: () => wallet,
      nowMs: () => 2_000,
    })
    assert.equal(resumed.state, 'completed')
    assert.equal(resumed.ignoredSpentProofs, 1)
    assert.deepEqual(starts, [0, 0, 300])
    assert.equal((await readState())?.wallet.proofs.length, 0)
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
  restore(start: number): { proofs: Proof[]; lastCounterWithSignature?: number }
  readonly proofState: ProofState['state']
}): EmergencySeedRecoveryWallet {
  return {
    async loadMint() {},
    keyChain: { getKeysets: () => [{ id: 'keyset-1' }] },
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

function proof(secret: string): Proof {
  return {
    id: 'keyset-1',
    amount: 1,
    secret,
    C: '02'.padEnd(66, '2'),
  }
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
