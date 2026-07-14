import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { DaemonProofOperationCoordinator } from '../src/durableProofOperationCoordinator.ts'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import {
  SqliteDurableCustodyStore,
} from '../src/durableCustodySqliteStore.ts'
import {
  setDaemonCustodyUnitOfWorkFaultHookForTest,
} from '../src/durableCustodyUnitOfWork.ts'
import { recoverPreparedWalletSends } from '../src/walletOps.ts'
import {
  addAvailableSatProofs,
  completeProofOperationWithWalletUpdate,
  emptyDaemonState,
  getProofOperation,
  installDaemonProofOperationCoordinator,
  markProofOperationMintSubmitted,
  prepareProofOperation,
  readState,
  updateState,
  writeState,
} from '../src/state.ts'
import { deriveDaemonWalletProofIdFromProof } from '../src/stateSqlite.ts'
import { writeStateWithDurableSessionKeys } from './durableSessionTestStore.ts'

const WALLET_SEED = '11'.repeat(32)
const KEYSET_ID = `00${'22'.repeat(7)}`
const PUBLIC_KEY = `02${'33'.repeat(32)}`

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-coordinator-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run()
  } finally {
    setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

async function installedCoordinator() {
  const store = new SqliteDurableCustodyStore()
  const scope = daemonWalletCustodyScope(WALLET_SEED)
  await store.registerScope(scope)
  await writeState(emptyDaemonState())
  const lease = await DaemonDurableCustodyLease.claim({
    store,
    walletSeedHex: WALLET_SEED,
  })
  return {
    store,
    scope,
    lease,
    uninstall: installCoordinator(lease),
  }
}

function installCoordinator(lease: DaemonDurableCustodyLease): () => void {
  const coordinator = new DaemonProofOperationCoordinator({
    authority: lease,
    resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
      keysetIds.map((keysetId) => [keysetId, {
        id: keysetId,
        unit: 'sat',
        keys: { '1': PUBLIC_KEY, '2': PUBLIC_KEY },
      }]),
    ),
  })
  return installDaemonProofOperationCoordinator(coordinator)
}

function preparedWalletSend() {
  return {
    operationId: 'wallet-send-001',
    kind: 'wallet-send' as const,
    mintUrl: 'https://mint.example',
    inputs: [{
      id: KEYSET_ID,
      amount: 2,
      secret: 'input-secret',
      C: PUBLIC_KEY,
    }],
    outputs: {
      send: [storedOutput('send-secret', '44')],
      keep: [storedOutput('keep-secret', '55')],
    },
    metadata: {
      amount: 1,
      fees: 0,
      keysetId: KEYSET_ID,
      unit: 'sat',
      baseAsset: 'sat',
      unselectedProofs: [],
    },
  }
}

function reservingWalletSend() {
  const prepared = preparedWalletSend()
  const reservationId = `wallet-send:${prepared.operationId}`
  return {
    ...prepared,
    metadata: { ...prepared.metadata, reservationId },
    walletProofReservation: { reservationId, unit: 'sat' as const },
  }
}

function storedOutput(secret: string, byte: string) {
  return {
    blindedMessage: { amount: 1, id: KEYSET_ID, B_: `02${byte.repeat(32)}` },
    blindingFactor: byte.repeat(32),
    secret,
  }
}

test('installed daemon coordinator commits custody, operation, and wallet proof lifecycle together', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      await prepareProofOperation(prepared)
      const reserved = (await readState()).wallet.proofs[0]
      assert.equal(reserved?.state, 'reserved')
      assert.equal(reserved?.reservedBy, prepared.walletProofReservation.reservationId)
      await markProofOperationMintSubmitted(prepared.operationId)
      const keep = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'keep-secret',
        C: PUBLIC_KEY,
      }
      const send = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'send-secret',
        C: PUBLIC_KEY,
      }
      const inputProofId = deriveDaemonWalletProofIdFromProof(
        prepared.mintUrl,
        'sat',
        prepared.inputs[0]!,
      )
      const keepProofId = deriveDaemonWalletProofIdFromProof(
        prepared.mintUrl,
        'sat',
        keep,
      )
      await completeProofOperationWithWalletUpdate({
        operationId: prepared.operationId,
        resultProofs: { send: [send], keep: [keep] },
        walletProofs: [{ proofIds: [inputProofId, keepProofId] }],
        walletDelta: (now) => ({
          deleteProofIds: [inputProofId],
          upsertProofs: [{
            proof: keep,
            mintUrl: prepared.mintUrl,
            unit: 'sat',
            state: 'available',
            asset: { kind: 'sats', baseAsset: 'sat' },
            createdAt: now,
            updatedAt: now,
          }],
        }),
      })

      assert.equal((await getProofOperation(prepared.operationId))?.state, 'completed')
      assert.deepEqual((await readState()).wallet.proofs.map(({ proof }) => proof), [keep])
      const custodyId = deriveDurableCustodyOperationId(scope.scopeId, {
        retainedOperationKey: prepared.operationId,
        binding: {
          kind: 'wallet',
          activityId: prepared.operationId,
          stage: 'send',
        },
      })
      const canonical = await store.transact(
        { scope, owner: lease.authorization() },
        (transaction) => transaction.getOperation(custodyId),
      )
      assert.equal(canonical?.operation.state, 'reconciled')
      assert.equal((await store.listRecoverablePage({
        scope,
        cursor: null,
        limit: 10,
      })).records.length, 0)
      assert.equal(canonical?.operation.reservation.inputs[0]?.proofId,
        deriveDurableCustodyProofId({
          normalizedMint: prepared.mintUrl,
          unit: 'sat',
          keysetId: KEYSET_ID,
          secret: prepared.inputs[0]!.secret,
        }))
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('daemon coordinator rolls back both authorities on a prepare crash', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
        if (stage === 'before-commit') throw new Error('simulated crash')
      })
      await assert.rejects(
        () => prepareProofOperation(prepared),
        /simulated crash/,
      )
      setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
      assert.equal(await getProofOperation('wallet-send-001'), null)
      const available = (await readState()).wallet.proofs[0]
      assert.equal(available?.state, 'available')
      assert.equal(available?.reservedBy, undefined)
      assert.equal((await store.listRecoverablePage({
        scope,
        cursor: null,
        limit: 10,
      })).records.length, 0)
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('daemon restart recovers one exact wallet operation through canonical custody', async () => {
  await withDaemonHome(async () => {
    const installed = await installedCoordinator()
    let lease = installed.lease
    let uninstall = installed.uninstall
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      await prepareProofOperation(prepared)
      await markProofOperationMintSubmitted(prepared.operationId)

      uninstall()
      await lease.stopAndRelease()
      lease = await DaemonDurableCustodyLease.claim({
        store: installed.store,
        walletSeedHex: WALLET_SEED,
      })
      uninstall = installCoordinator(lease)

      const send = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'restored-send-secret',
        C: PUBLIC_KEY,
      }
      const keep = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'restored-keep-secret',
        C: PUBLIC_KEY,
      }
      const recovery = await recoverPreparedWalletSends(
        { walletSeedHex: WALLET_SEED },
        {
          createCashuWallet: () => ({
            async loadMint() {},
            async receive() { throw new Error('receive unused') },
            async send() { throw new Error('send unused') },
            async checkProofsStates(proofs) {
              return proofs.map(({ secret }) => ({
                Y: secret,
                state: 'SPENT',
                witness: null,
              }))
            },
          }),
          async restoreOutputGroups() {
            return { send: [send], keep: [keep] }
          },
        },
      )

      assert.deepEqual(recovery, {
        recoveredCount: 1,
        pendingCount: 0,
        recovered: [prepared.operationId],
        pending: [],
        summaryTruncated: false,
      })
      assert.equal((await getProofOperation(prepared.operationId))?.state, 'completed')
      assert.deepEqual((await readState()).wallet.proofs.map(({ proof }) => proof), [keep])
      const custodyId = deriveDurableCustodyOperationId(installed.scope.scopeId, {
        retainedOperationKey: prepared.operationId,
        binding: {
          kind: 'wallet',
          activityId: prepared.operationId,
          stage: 'send',
        },
      })
      assert.equal(
        (await readCanonical(
          installed.store,
          installed.scope,
          lease,
          custodyId,
        ))?.operation.state,
        'reconciled',
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('canonical active work is not hidden by a stale terminal daemon projection', async () => {
  await withDaemonHome(async () => {
    const { lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      await prepareProofOperation(prepared)
      await updateState(
        { proofOperationIds: [prepared.operationId] },
        (state) => {
          const operation = state.proofOperations[prepared.operationId]
          assert.ok(operation)
          operation.state = 'Failed'
          operation.lastError = 'stale terminal projection'
        },
      )

      const recovery = await recoverPreparedWalletSends({
        walletSeedHex: WALLET_SEED,
      })

      assert.equal(recovery.recoveredCount, 0)
      assert.equal(recovery.pendingCount, 1)
      assert.equal(recovery.pending[0]?.operationId, prepared.operationId)
      assert.match(
        recovery.pending[0]?.error ?? '',
        /canonical wallet work has a terminal daemon projection/,
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('trade session and canonical custody advance together across a submit fault', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const operationId = 'trade-001/seller-lock'
      const link = createDurableTradeProofOperationLink({
        tradeId: 'trade-001',
        role: 'seller',
        stage: 'proof-reservation',
        state: 'prepared',
        operationKey: operationId,
        kind: 'cashu-atomic',
      })
      const session = tradeSession(link)
      const state = emptyDaemonState()
      state.durableTradeSessions[session.tradeId] = session
      await writeStateWithDurableSessionKeys(state)
      const prepared = {
        ...preparedWalletSend(),
        operationId,
        durableTradeRecovery: link,
        kind: 'swap-lock' as const,
      }
      await prepareProofOperation(prepared)

      const custodyId = deriveDurableCustodyOperationId(scope.scopeId, {
        retainedOperationKey: operationId,
        binding: {
          kind: 'trade',
          tradeId: session.tradeId,
          role: session.role,
          stage: 'lock',
        },
      })
      setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
        if (stage === 'before-commit') throw new Error('submit crash')
      })
      await assert.rejects(
        () => markProofOperationMintSubmitted(operationId),
        /submit crash/,
      )
      setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
      assert.equal((await getProofOperation(operationId))?.state, 'prepared')
      assert.equal((await readCanonical(store, scope, lease, custodyId))?.operation.state,
        'dispatch-intent')

      await markProofOperationMintSubmitted(operationId)
      const after = await readState()
      assert.equal(after.proofOperations[operationId]?.state, 'mint-submitted')
      assert.equal(
        after.durableTradeSessions[session.tradeId]?.proofOperations[0]?.state,
        'mint-submitted',
      )
      assert.equal((await readCanonical(store, scope, lease, custodyId))?.operation.state,
        'transport-attempted')
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

function tradeSession(
  operation: ReturnType<typeof createDurableTradeProofOperationLink>,
): DurableTradeSession {
  const nowSecs = Math.floor(Date.now() / 1_000)
  const sellerLocktimeSecs = nowSecs + 120
  const buyerLocktimeSecs = nowSecs + 100
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: operation.tradeId,
    role: operation.role,
    localProtocolPubkey: 'a'.repeat(64),
    counterpartyProtocolPubkey: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs,
    buyerLocktimeSecs,
    ephemeralKeyHandle: {
      keyId: operation.tradeId,
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs,
      buyerLocktimeSecs,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}

async function readCanonical(
  store: SqliteDurableCustodyStore,
  scope: ReturnType<typeof daemonWalletCustodyScope>,
  lease: DaemonDurableCustodyLease,
  operationId: string,
) {
  return store.transact(
    { scope, owner: lease.authorization() },
    (transaction) => transaction.getOperation(operationId),
  )
}
