import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts'
import { recoverDaemonWalletFromSeed } from '../src/emergencySeedRecovery.ts'
import { advanceDaemonKeysetCounter, reserveDaemonKeysetCounter } from '../src/state.ts'
import {
  createSeedRecoveryProfile,
  emptyRecoveryWallet,
  RECOVERY_COUNTER_BINDING,
  withDaemonHome,
} from './seedRecoveryTestSupport.ts'

test('recovery resumes after four pages to scan an inactive keyset high-water mark', async () => {
  const fixture = await recoveryFixture('high-water', '56', '67')
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(
        'keyset-inactive',
        1_500,
        fixture.mutation,
        RECOVERY_COUNTER_BINDING,
      ),
    )
    const starts: number[] = []
    const first = await recoverEmpty(fixture, 'recovery-high-water', 'keyset-inactive', starts)
    const second = await recoverEmpty(fixture, 'recovery-high-water', 'keyset-inactive', starts)
    assert.deepEqual(starts, [0, 300, 600, 900, 1_200])
    assert.deepEqual(first, {
      recoveryId: 'recovery-high-water',
      state: 'active',
      nextCounter: 1_200,
      batchesProcessed: 4,
    })
    assert.deepEqual(second, {
      recoveryId: 'recovery-high-water',
      state: 'completed',
      nextCounter: 1_500,
      batchesProcessed: 1,
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('distinct keyset recovery jobs keep their exact counter bindings', async () => {
  const fixture = await recoveryFixture('keysets', '57', '68')
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(
        'keyset-inactive',
        900,
        fixture.mutation,
        RECOVERY_COUNTER_BINDING,
      ),
    )
    const activeStarts: number[] = []
    const inactiveStarts: number[] = []
    await recoverEmpty(fixture, 'recovery-active', 'keyset-active', activeStarts)
    await recoverEmpty(fixture, 'recovery-inactive', 'keyset-inactive', inactiveStarts)
    assert.deepEqual(activeStarts, [0])
    assert.deepEqual(inactiveStarts, [0, 300, 600])
    await withDaemonHome(fixture.directory, async () => {
      assert.deepEqual(
        await reserveDaemonKeysetCounter(
          'keyset-active',
          1,
          fixture.mutation,
          RECOVERY_COUNTER_BINDING,
        ),
        { start: 300, count: 1 },
      )
      assert.deepEqual(
        await reserveDaemonKeysetCounter(
          'keyset-inactive',
          1,
          fixture.mutation,
          RECOVERY_COUNTER_BINDING,
        ),
        { start: 900, count: 1 },
      )
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('typed recovery runner performs one bounded mint scan and fenced commit', async () => {
  const fixture = await recoveryFixture('runner', '55', '66')
  try {
    const starts: number[] = []
    const result = await recoverEmpty(fixture, 'recovery-runner', 'keyset-1', starts)
    assert.deepEqual(result, {
      recoveryId: 'recovery-runner',
      state: 'completed',
      nextCounter: 300,
      batchesProcessed: 1,
    })
    assert.deepEqual(starts, [0])
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('typed recovery runner does not advance past a pending proof', async () => {
  const fixture = await recoveryFixture('pending', '58', '69')
  try {
    const { keyset, proof } = signedRecoveryProof()
    const starts: number[] = []
    const result = await recoverDaemonWalletFromSeed(
      recoveryInput(fixture, 'recovery-pending', keyset.id),
      recoveryDependencies(
        fixture,
        pendingRecoveryWallet(keyset, proof, starts),
        'recovery-pending',
      ),
    )
    assert.deepEqual(result, {
      recoveryId: 'recovery-pending',
      state: 'active',
      nextCounter: 0,
      batchesProcessed: 0,
    })
    assert.deepEqual(starts, [0])
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function recoveryFixture(label: string, seedByte: string, nostrByte: string) {
  const directory = await mkdtemp(join(tmpdir(), `bitcaster-recovery-${label}-`))
  const walletSeedHex = seedByte.repeat(64)
  const { fence } = await createSeedRecoveryProfile({
    directory,
    walletSeedHex,
    nostrSecretKeyHex: nostrByte.repeat(32),
    incarnationId: `seed-recovery-${label}`,
  })
  return { directory, walletSeedHex, fence, mutation: { fence, observedAtMs: 3 } }
}

function recoverEmpty(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  recoveryId: string,
  keysetId: string,
  starts: number[],
) {
  return recoverDaemonWalletFromSeed(
    recoveryInput(fixture, recoveryId, keysetId),
    recoveryDependencies(fixture, emptyRecoveryWallet(keysetId, starts), recoveryId),
  )
}

function recoveryInput(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  recoveryId: string,
  keysetId: string,
) {
  return {
    recoveryId,
    mintUrl: 'https://mint.example',
    unit: 'sat' as const,
    keysetId,
    walletSeedHex: fixture.walletSeedHex,
    disclosureAcknowledged: true as const,
  }
}

function recoveryDependencies(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  wallet: ReturnType<typeof emptyRecoveryWallet> | ReturnType<typeof pendingRecoveryWallet>,
  recoveryId: string,
) {
  return {
    directory: fixture.directory,
    getFence: () => fixture.fence,
    nowMs: () => 4,
    invocationId: () => `invocation-${recoveryId}`,
    createWallet: () => wallet,
  }
}

function pendingRecoveryWallet(keyset: MintKeys, proof: Proof, starts: number[]) {
  return {
    async loadMint() {},
    keyChain: { getKeysets: () => [{ id: keyset.id }] },
    getKeyset: () => keyset,
    async restore(start: number) {
      starts.push(start)
      return { proofs: [proof], lastCounterWithSignature: start }
    },
    async checkProofsStates() {
      return [
        {
          Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
          state: CheckStateEnum.PENDING,
          witness: null,
        },
      ]
    },
  }
}

function signedRecoveryProof(): { readonly keyset: MintKeys; readonly proof: Proof } {
  const privateKey = Uint8Array.from([...new Uint8Array(31), 1])
  const publicKey = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
  const keys = { '1': publicKey }
  const keyset: MintKeys = { id: deriveKeysetId(keys), unit: 'sat', keys }
  const output = OutputData.createRandomData(Amount.from(1), keyset)[0]!
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    privateKey,
    keyset.id,
  )
  const proof = output.toProof(
    {
      id: keyset.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
    },
    keyset,
  )
  return { keyset, proof }
}
