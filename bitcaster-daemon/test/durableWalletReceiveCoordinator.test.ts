import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { serializeDurableWalletReceiveOperation } from '@bitcaster-market/client-sdk/durableWalletOperation'
import { DaemonDurableWalletReceiveCoordinator } from '../src/durableWalletReceiveCoordinator.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { reserveDaemonKeysetCounter } from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'

const MINT_URL = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'sat', versionByte: 1 })

test('durable receive applies a valid exact mint result to custody and target wallet rows', async () => {
  const fixture = await createFixture()
  try {
    const result = await fixture.coordinator.execute({
      prepared: fixture.prepared,
      wallet: wallet({ complete: async () => ({ keep: [fixture.proof], send: [] }) }),
    })
    assert.equal(result.proofs[0]?.secret, fixture.proof.secret)
    const rows = await withDaemonStateSqliteTransaction(fixture.directory, (database) => ({
      custody: database.prepare('SELECT COUNT(*) AS count FROM custody_proofs').get() as {
        count: number
      },
      target: database.prepare('SELECT COUNT(*) AS count FROM target_wallet_proofs').get() as {
        count: number
      },
      active: database.prepare('SELECT COUNT(*) AS count FROM custody_active_work').get() as {
        count: number
      },
    }))
    assert.equal(rows.custody.count, 1)
    assert.equal(rows.target.count, 1)
    assert.equal(rows.active.count, 0)
    const replay = await fixture.coordinator.recover({
      walletFor: async () => {
        throw new Error('terminal receive must not create a wallet or call the mint')
      },
    })
    assert.deepEqual(replay, {
      recovered: [],
      recoveredCount: 0,
      pending: [],
      pendingCount: 0,
      hasMore: false,
    })
  } finally {
    await fixture.close()
  }
})

test('SPENT recovery restores the exact persisted outputs without completing a new swap', async () => {
  const fixture = await createFixture()
  try {
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          prepared: fixture.prepared,
          wallet: wallet({ complete: failMint }),
        }),
      /mint unavailable/,
    )
    let restores = 0
    const coordinator = fixture.withRestore(async (_mint, outputs) => {
      restores += 1
      assert.equal(outputs.receive[0]?.secret, Buffer.from(fixture.output.secret).toString('hex'))
      assert.equal(outputs.receive[0]?.blindingFactor, fixture.output.blindingFactor.toString(16))
      return { receive: [fixture.proof] }
    })
    let completeCalls = 0
    const recovered = await coordinator.recover({
      walletFor: async () =>
        wallet({
          state: CheckStateEnum.SPENT,
          complete: async () => {
            completeCalls += 1
            return { keep: [], send: [] }
          },
        }),
    })
    assert.equal(restores, 1)
    assert.equal(completeCalls, 0)
    assert.equal(recovered.pending.length, 0, recovered.pending[0]?.error)
    assert.equal(recovered.recoveredCount, 1)
    assert.equal(await targetProofCount(fixture.directory), 1)
  } finally {
    await fixture.close()
  }
})

test('UNSPENT recovery completes only the persisted preview, while PENDING remains active', async () => {
  const fixture = await createFixture()
  try {
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          prepared: fixture.prepared,
          wallet: wallet({ complete: failMint }),
        }),
      /mint unavailable/,
    )
    let restored = 0
    const coordinator = fixture.withRestore(async () => {
      restored += 1
      return { receive: [] }
    })
    let observed: SwapPreview | undefined
    const replayed = await coordinator.recover({
      walletFor: async () =>
        wallet({
          state: CheckStateEnum.UNSPENT,
          complete: async (preview) => {
            observed = preview
            return { keep: [fixture.proof], send: [] }
          },
        }),
    })
    assert.equal(replayed.recoveredCount, 1)
    assert.equal(restored, 0)
    assert.equal(
      new TextDecoder().decode(observed?.keepOutputs[0]?.secret),
      new TextDecoder().decode(fixture.output.secret),
    )
    assert.equal(observed?.keepOutputs[0]?.blindingFactor, fixture.output.blindingFactor)

    const pendingFixture = await createFixture()
    try {
      await assert.rejects(
        () =>
          pendingFixture.coordinator.execute({
            prepared: pendingFixture.prepared,
            wallet: wallet({ complete: failMint }),
          }),
        /mint unavailable/,
      )
      let completeCalls = 0
      const pending = await pendingFixture.coordinator.recover({
        walletFor: async () =>
          wallet({
            state: CheckStateEnum.PENDING,
            complete: async () => {
              completeCalls += 1
              return { keep: [], send: [] }
            },
          }),
      })
      assert.equal(pending.pending.length, 1)
      assert.equal(completeCalls, 0)
      assert.equal(await activeWorkCount(pendingFixture.directory), 1)
    } finally {
      await pendingFixture.close()
    }
    const mixedFixture = await createFixture(2)
    try {
      await assert.rejects(
        () =>
          mixedFixture.coordinator.execute({
            prepared: mixedFixture.prepared,
            wallet: wallet({ complete: failMint }),
          }),
        /mint unavailable/,
      )
      const mixed = await mixedFixture.coordinator.recover({
        walletFor: async () =>
          wallet({ state: [CheckStateEnum.UNSPENT, CheckStateEnum.SPENT], complete: failMint }),
      })
      assert.equal(mixed.pending.length, 1)
      assert.equal(await activeWorkCount(mixedFixture.directory), 1)
    } finally {
      await mixedFixture.close()
    }
  } finally {
    await fixture.close()
  }
})

test('substituted private authority blocks recovery before any mint I/O', async () => {
  const fixture = await createFixture()
  try {
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          prepared: fixture.prepared,
          wallet: wallet({ complete: failMint }),
        }),
      /mint unavailable/,
    )
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      database
        .prepare("UPDATE custody_artifacts SET body = ? WHERE artifact_kind = 'private-material'")
        .run(Buffer.from('{}'))
    })
    let walletCreated = 0
    const recovered = await fixture.coordinator.recover({
      walletFor: async () => {
        walletCreated += 1
        return wallet({ complete: failMint })
      },
    })
    assert.equal(walletCreated, 0)
    assert.equal(recovered.pending.length, 1)
    assert.equal(await activeWorkCount(fixture.directory), 1)
  } finally {
    await fixture.close()
  }
})

test('recovery processes one receive-only page and advances its durable cursor', async () => {
  const fixture = await createFixture()
  try {
    const fence = fixture.fence
    await reserveDaemonKeysetCounter(
      KEYSET_ID,
      256,
      { fence, observedAtMs: Date.now() },
      { normalizedMint: MINT_URL, unit: 'sat' },
    )
    const prepared = [fixture.prepared]
    for (let index = 1; index <= 256; index += 1) {
      prepared.push({
        operation: serializeDurableWalletReceiveOperation({
          operationId: `wallet-receive:page-${index}`,
          mintUrl: MINT_URL,
          unit: 'sat',
          preview: fixture.preview,
          derivationRange: {
            keysetId: KEYSET_ID,
            counterStart: index,
            counterCount: 1,
          },
        }),
      })
    }
    for (const input of prepared) {
      await assert.rejects(
        () =>
          fixture.coordinator.execute({ prepared: input, wallet: wallet({ complete: failMint }) }),
        /mint unavailable/,
      )
    }
    let walletForCalls = 0
    let loadMintCalls = 0
    let checks = 0
    const pendingWallet = () => {
      walletForCalls += 1
      return {
        ...wallet({ complete: failMint, state: CheckStateEnum.PENDING }),
        loadMint: async () => {
          loadMintCalls += 1
        },
        checkProofsStates: async (proofs: Array<Pick<Proof, 'id' | 'secret'>>) => {
          checks += 1
          return proofs.map((proof) => ({
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            state: CheckStateEnum.PENDING,
            witness: null,
          }))
        },
      }
    }
    const first = await fixture.coordinator.recover({ walletFor: async () => pendingWallet() })
    assert.equal(first.pending.length, 256)
    assert.equal(first.pendingCount, 257)
    assert.equal(first.hasMore, true)
    assert.equal(walletForCalls, 1)
    assert.equal(loadMintCalls, 1)
    assert.equal(checks, 256)
    const second = await fixture.coordinator.recover({ walletFor: async () => pendingWallet() })
    assert.equal(second.pending.length, 1)
    assert.equal(second.pendingCount, 257)
    assert.equal(second.hasMore, false)
    assert.equal(walletForCalls, 2)
    assert.equal(loadMintCalls, 2)
    assert.equal(checks, 257)
  } finally {
    await fixture.close()
  }
})

async function createFixture(inputCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-receive-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = '11'.repeat(64)
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: seed,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(Buffer.from(seed, 'hex')),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'durable-receive-test',
    observedAtMs: Date.now(),
  })
  await reserveDaemonKeysetCounter(
    KEYSET_ID,
    1,
    { fence, observedAtMs: Date.now() },
    { normalizedMint: MINT_URL, unit: 'sat' },
  )
  const output = OutputData.createSingleData(1, KEYSET_ID, 'receive-secret', 0x12345n)
  const preview: SwapPreview = {
    amount: Amount.from(1),
    fees: Amount.zero(),
    keysetId: KEYSET_ID,
    inputs: Array.from({ length: inputCount }, (_, index) => ({
      id: KEYSET_ID,
      amount: 1,
      secret: `external-secret-${index}`,
      C: `02${'11'.repeat(32)}`,
    })),
    keepOutputs: [output],
  }
  const operation = serializeDurableWalletReceiveOperation({
    operationId: 'wallet-receive:fixture',
    mintUrl: MINT_URL,
    unit: 'sat',
    preview,
    derivationRange: { keysetId: KEYSET_ID, counterStart: 0, counterCount: 1 },
  })
  const proof = signedProof(output)
  const withRestore = (
    restore: ConstructorParameters<typeof DaemonDurableWalletReceiveCoordinator>[2],
  ) => new DaemonDurableWalletReceiveCoordinator(directory, () => fence, restore)
  return {
    directory,
    fence,
    output,
    preview,
    proof,
    prepared: { operation },
    coordinator: withRestore(async () => ({ receive: [] })),
    withRestore,
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function wallet(input: {
  state?: CheckStateEnum | readonly CheckStateEnum[]
  complete: (preview: SwapPreview) => Promise<{ keep: Proof[]; send: Proof[] }>
}) {
  return {
    loadMint: async () => {},
    receive: async () => [],
    send: async () => ({ keep: [], send: [] }),
    completeSwap: input.complete,
    checkProofsStates: async (proofs: Array<Pick<Proof, 'id' | 'secret'>>) =>
      proofs.map((proof, index) => ({
        Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
        state:
          (Array.isArray(input.state) ? input.state[index] : input.state) ?? CheckStateEnum.UNSPENT,
        witness: null,
      })),
    getKeyset: () => ({ id: KEYSET_ID, unit: 'sat', keys: KEYS, fee: 0, verify: () => true }),
  }
}

function signedProof(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: KEYS },
  )
}

async function targetProofCount(directory: string): Promise<number> {
  return withDaemonStateSqliteTransaction(
    directory,
    (database) =>
      (
        database.prepare('SELECT COUNT(*) AS count FROM target_wallet_proofs').get() as {
          count: number
        }
      ).count,
  )
}
async function activeWorkCount(directory: string): Promise<number> {
  return withDaemonStateSqliteTransaction(
    directory,
    (database) =>
      (
        database.prepare('SELECT COUNT(*) AS count FROM custody_active_work').get() as {
          count: number
        }
      ).count,
  )
}
async function failMint(): Promise<{ keep: Proof[]; send: Proof[] }> {
  throw new Error('mint unavailable')
}
