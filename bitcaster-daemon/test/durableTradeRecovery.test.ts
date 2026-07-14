import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  CheckStateEnum,
  Wallet as CashuWallet,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { recoverDaemonDurableTradeSessions } from '../src/durableTradeRecovery.ts'
import { recoverExactDaemonProofOperation } from '../src/swapProtocolAdapter.ts'
import {
  emptyDaemonState,
  installDaemonProofOperationCoordinator,
  markProofOperationCompletedStateProjectionForTest as markProofOperationCompleted,
  markProofOperationMintSubmittedStateProjectionForTest as markProofOperationMintSubmitted,
  prepareProofOperationStateProjectionForTest as prepareProofOperation,
  readState,
  setStateWriteFaultHookForTest,
  statePath,
  updateState,
  writeState,
} from '../src/state.ts'
import { writeStateWithDurableSessionKeys } from './durableSessionTestStore.ts'

// These tests isolate the legacy daemon projection and SDK trade classifier.
// Canonical SQLite custody restart behavior is covered by the coordinator suite.
const uninstallProjectionCoordinator = installDaemonProofOperationCoordinator({
  prepare: prepareProofOperation,
  markMintSubmitted: markProofOperationMintSubmitted,
  complete: markProofOperationCompleted,
  async completeWithWalletUpdate() {
    throw new Error('wallet completion is outside this test fixture')
  },
  async assertRecoveryBound() {},
  async decideRecovery() {
    throw new Error('wallet recovery is outside this test fixture')
  },
  async listRecoverablePage() {
    throw new Error('canonical paging is outside this projection fixture')
  },
})
after(uninstallProjectionCoordinator)

test('daemon durable recovery resumes only the retained persisted operation after restart', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-durable-recovery-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const originalLoadMint = CashuWallet.prototype.loadMint
  const originalCheckProofsStates = CashuWallet.prototype.checkProofsStates
  try {
    const operationKey = 'trade-durable/seller-lock'
    const operation = createDurableTradeProofOperationLink({
      tradeId: 'trade-durable',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey,
      kind: 'cashu-atomic',
    })
    const session: DurableTradeSession = {
      schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
      revision: 0,
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
      ephemeralKeyHandle: {
        keyId: 'ephemeral-durable',
        tradeId: operation.tradeId,
        role: operation.role,
        localProtocolPubkey: 'a'.repeat(64),
        counterpartyProtocolPubkey: 'b'.repeat(64),
        mintUrl: 'https://mint.example',
        sellerLocktimeSecs: 120,
        buyerLocktimeSecs: 100,
      },
      stage: 'proof-reserved',
      proofOperations: [operation],
      receivedCiphers: {},
      outboundCiphers: {},
    }
    const state = emptyDaemonState()
    state.durableTradeSessions[session.tradeId] = session
    state.proofOperations[operationKey] = {
      operationId: operationKey,
      durableTradeRecovery: operation,
      kind: 'swap-lock',
      state: 'prepared',
      mintUrl: session.mintUrl,
      inputs: [
        {
          id: 'keyset-1',
          amount: 1,
          secret: 'persisted-input',
          C: '02'.padEnd(66, '1'),
        },
      ],
      outputs: {
        send: [
          {
            blindedMessage: { amount: 1, id: 'keyset-1', B_: 'blinded-send' },
            blindingFactor: '01',
            secret: 'persisted-output-secret',
          },
        ],
        keep: [],
      },
      metadata: { unit: 'sat', unselectedProofs: [] },
      createdAt: 1,
      updatedAt: 1,
    }
    await writeStateWithDurableSessionKeys(state)
    CashuWallet.prototype.loadMint = async () => undefined
    CashuWallet.prototype.checkProofsStates = async () =>
      [{ state: CheckStateEnum.UNSPENT }] as ProofState[]
    const resumed: string[] = []

    const recovery = await recoverDaemonDurableTradeSessions({
      tradeId: operation.tradeId,
      authorityPreflight: async () => {},
      executor: {} as never,
      exactOperationAdapter: async (record, action) => {
        assert.equal(action, 'resume')
        resumed.push(record.operationId)
        await markProofOperationCompleted(record.operationId, {
          send: [
            {
              id: 'keyset-1',
              amount: 1,
              secret: 'persisted-output',
              C: '03'.padEnd(66, '2'),
            },
          ],
          keep: [],
        })
      },
      connection: {
        async joinTrade() {},
        async sendSwapMessage() {},
      } as never,
    })

    assert.deepEqual(resumed, [operationKey])
    assert.deepEqual(recovery.sessions, [
      { kind: 'ready', tradeId: operation.tradeId },
    ])
    const persisted = await readState()
    assert.equal(
      persisted?.proofOperations[operationKey]?.durableTradeRecovery?.state,
      'reconciled',
    )
    assert.equal(
      persisted?.durableTradeSessions[session.tradeId]?.stage,
      'reconciliation-complete',
    )
    assert.equal(
      persisted?.durableTradeSessions[session.tradeId]?.proofOperations[0]
        ?.state,
      'reconciled',
    )
    assert.equal(persisted?.durableTradeSessions[session.tradeId]?.revision, 2)
  } finally {
    CashuWallet.prototype.loadMint = originalLoadMint
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('daemon restart resumes the bound record without selecting from a changed proof pool', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-exact-operation-restart-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const originalLoadMint = CashuWallet.prototype.loadMint
  const originalCheckProofsStates = CashuWallet.prototype.checkProofsStates
  try {
    const operationKey = 'trade-exact/seller-lock'
    const operation = createDurableTradeProofOperationLink({
      tradeId: 'trade-exact',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey,
      kind: 'cashu-atomic',
    })
    const session = durableSession(operation)
    const state = emptyDaemonState()
    state.durableTradeSessions[session.tradeId] = session
    state.wallet.proofs.push({
      mintUrl: session.mintUrl,
      proof: {
        id: 'changed-keyset',
        amount: 999,
        secret: 'changed-proof-pool',
        C: '03'.padEnd(66, '2'),
      },
      unit: 'sat',
      asset: { kind: 'sats', baseAsset: 'sat' },
      state: 'available',
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    })
    state.proofOperations[operationKey] = {
      operationId: operationKey,
      durableTradeRecovery: operation,
      kind: 'swap-lock',
      state: 'prepared',
      mintUrl: session.mintUrl,
      inputs: [
        {
          id: 'persisted-keyset',
        amount: 42,
          secret: 'persisted-input-only',
          C: '02'.padEnd(66, '3'),
        },
      ],
      outputs: {
        send: [
          {
            blindedMessage: {
              amount: 42,
              id: 'persisted-keyset',
              B_: 'blinded-send',
            },
            blindingFactor: '01',
            secret: 'persisted-output-secret',
          },
        ],
        keep: [],
      },
      metadata: { unit: 'sat', unselectedProofs: [] },
      createdAt: 1,
      updatedAt: 1,
    }
    await writeStateWithDurableSessionKeys(state)
    CashuWallet.prototype.loadMint = async () => undefined
    CashuWallet.prototype.checkProofsStates = async () =>
      [{ state: CheckStateEnum.UNSPENT }] as ProofState[]

    let exactDispatches = 0
    let selectedCurrentProofs = 0
    const recovery = await recoverDaemonDurableTradeSessions({
      tradeId: operation.tradeId,
      authorityPreflight: async () => {},
      executor: {} as never,
      exactOperationAdapter: async (record, action) =>
        recoverExactDaemonProofOperation(record, action, {
          async loadAtomicSwapModule() {
            return {
              async resumeExactPreparedProofOperation(_wallet, entry) {
                exactDispatches += 1
                assert.deepEqual(
                  entry.inputs.map((proof) => proof.secret),
                  ['persisted-input-only'],
                )
                return {
                  send: [{ ...entry.inputs[0]!, secret: 'exact-result' }],
                  keep: [],
                }
              },
              async restoreExactPreparedProofOperation() {
                throw new Error('restore path was not expected')
              },
              async sellerPrepareSwap() {
                selectedCurrentProofs += 1
                throw new Error(
                  'normal seller proof selection must not run during recovery',
                )
          },
            } as never
        },
        }),
      connection: {
        async joinTrade() {},
        async sendSwapMessage() {},
      } as never,
    })

    assert.equal(exactDispatches, 1)
    assert.equal(selectedCurrentProofs, 0)
    assert.deepEqual(recovery.sessions, [
      { kind: 'ready', tradeId: operation.tradeId },
    ])
    const persisted = await readState()
    assert.equal(persisted?.proofOperations[operationKey]?.state, 'completed')
    assert.deepEqual(
      persisted?.proofOperations[operationKey]?.resultProofs?.send.map(
        (proof) => proof.secret,
      ),
      ['exact-result'],
    )
    assert.equal(
      persisted?.wallet.proofs.some(
        (proof) => proof.proof.secret === 'changed-proof-pool',
      ),
      true,
    )
  } finally {
    CashuWallet.prototype.loadMint = originalLoadMint
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('daemon restart replays a reconciled session while its swap remains active', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-reconciled-session-replay-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const tradeId = 'trade-reconciled-replay'
    const operation = createDurableTradeProofOperationLink({
      tradeId,
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey: `${tradeId}/seller-lock`,
      kind: 'cashu-atomic',
    })
    const ciphertext = 'persisted-adaptor-cipher'
    const session: DurableTradeSession = {
      ...durableSession(operation),
      stage: 'reconciliation-complete',
      proofOperations: [],
      outboundCiphers: {
        'adaptor-point': {
          ciphertext,
          sha256: createHash('sha256').update(ciphertext).digest('hex'),
        },
      },
    }
    const state = emptyDaemonState()
    state.durableTradeSessions[tradeId] = session
    state.swaps[tradeId] = {
      tradeId,
      marketId: 'condition-YES',
      orderId: 'order-reconciled-replay',
      role: session.role,
      counterpartyPubkey: session.counterpartyProtocolPubkey,
      sellerLocktime: session.sellerLocktimeSecs,
      buyerLocktime: session.buyerLocktimeSecs,
      messages: {},
      step: 'awaiting-confirmation',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }
    await writeStateWithDurableSessionKeys(state)

    const calls: string[] = []
    const recovery = await recoverDaemonDurableTradeSessions({
      tradeId: operation.tradeId,
      authorityPreflight: async () => {},
      executor: {} as never,
      connection: {
        async joinTrade(id: string) {
          calls.push(`join:${id}`)
        },
        async sendSwapMessage(
          id: string,
          messageType: string,
          payload: string,
        ) {
          calls.push(`${id}:${messageType}:${payload}`)
        },
      } as never,
    })

    assert.deepEqual(calls, [
      `join:${tradeId}`,
      `${tradeId}:adaptor-point:${ciphertext}`,
    ])
    assert.deepEqual(recovery.sessions, [
      {
        kind: 'replayed',
        tradeId,
        sentMessageTypes: ['adaptor-point'],
      },
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('daemon SQLite transaction survives faults before and after commit without split session metadata', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-atomic-rename-fault-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const operationKey = 'trade-atomic/seller-lock'
    const operation = createDurableTradeProofOperationLink({
      tradeId: 'trade-atomic',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey,
      kind: 'cashu-atomic',
    })
    const state = emptyDaemonState()
    state.durableTradeSessions[operation.tradeId] = durableSession(operation)
    state.proofOperations[operationKey] = {
      operationId: operationKey,
      durableTradeRecovery: operation,
      kind: 'swap-lock',
      state: 'prepared',
      mintUrl: 'https://mint.example',
      inputs: [],
      outputs: {},
      metadata: { unit: 'sat' },
      createdAt: 1,
      updatedAt: 1,
    }
    await writeStateWithDurableSessionKeys(state)

    setStateWriteFaultHookForTest((stage) => {
      if (stage === 'before-commit') throw new Error('fault before commit')
    })
    await assert.rejects(
      () => markProofOperationMintSubmitted(operationKey),
      /fault before commit/,
    )
    setStateWriteFaultHookForTest(undefined)
    await assertAtomicTransitionSnapshot(
      operationKey,
      'prepared',
      'prepared',
      'proof-reserved',
    )

    setStateWriteFaultHookForTest((stage) => {
      if (stage === 'after-commit') throw new Error('fault after commit')
    })
    await assert.rejects(
      () => markProofOperationMintSubmitted(operationKey),
      /fault after commit/,
    )
    setStateWriteFaultHookForTest(undefined)
    await assertAtomicTransitionSnapshot(
      operationKey,
      'mint-submitted',
      'mint-submitted',
      'mint-submitted',
    )
  } finally {
    setStateWriteFaultHookForTest(undefined)
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('daemon durable recovery fails closed on an invalid persisted link before it can resume or send', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-invalid-durable-recovery-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const valid = createDurableTradeProofOperationLink({
      tradeId: 'trade-invalid',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey: 'trade-invalid/seller-lock',
      kind: 'cashu-atomic',
    })
    const state = emptyDaemonState()
    const session = durableSession(valid)
    state.durableTradeSessions[valid.tradeId] = session
    state.swaps[valid.tradeId] = {
      tradeId: valid.tradeId,
      marketId: 'condition-YES',
      orderId: 'order-invalid',
      role: session.role,
      counterpartyPubkey: session.counterpartyProtocolPubkey,
      sellerLocktime: session.sellerLocktimeSecs,
      buyerLocktime: session.buyerLocktimeSecs,
      messages: {},
      step: 'opened',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }
    state.proofOperations[valid.operationKey!] = {
      operationId: valid.operationKey!,
      durableTradeRecovery: valid,
      kind: 'swap-lock',
      state: 'prepared',
      mintUrl: 'https://mint.example',
      inputs: [],
      outputs: {},
      metadata: { unit: 'sat' },
      createdAt: 1,
      updatedAt: 1,
    }
    await writeStateWithDurableSessionKeys(state)
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_proof_operations SET durable_state = ?
         WHERE operation_id = ?`,
        )
        .run('not-a-durable-state', valid.operationKey!)
    } finally {
      database.close()
    }
    let exactResumes = 0
    let sentMessages = 0

    await assert.rejects(
      () =>
        recoverDaemonDurableTradeSessions({
          tradeId: valid.tradeId,
          authorityPreflight: async () => {},
        executor: {} as never,
        exactOperationAdapter: async () => {
            exactResumes += 1
        },
        connection: {
          async joinTrade() {
              sentMessages += 1
          },
          async sendSwapMessage() {
              sentMessages += 1
          },
        } as never,
      }),
      /durable trade recovery storage is unavailable/,
    )
    assert.equal(exactResumes, 0)
    assert.equal(sentMessages, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('daemon durable recovery rejects a foreign persisted ledger key before mint inspection or dispatch', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-foreign-durable-operation-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const originalLoadMint = CashuWallet.prototype.loadMint
  try {
    const operation = createDurableTradeProofOperationLink({
      tradeId: 'trade-owner',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey: 'trade-owner/seller-lock',
      kind: 'cashu-atomic',
    })
    const session: DurableTradeSession = {
      schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
      revision: 0,
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
      ephemeralKeyHandle: {
        keyId: 'foreign-key',
        tradeId: operation.tradeId,
        role: operation.role,
        localProtocolPubkey: 'a'.repeat(64),
        counterpartyProtocolPubkey: 'b'.repeat(64),
        mintUrl: 'https://mint.example',
        sellerLocktimeSecs: 120,
        buyerLocktimeSecs: 100,
      },
      stage: 'proof-reserved',
      proofOperations: [operation],
      receivedCiphers: {},
      outboundCiphers: {},
    }
    const state = emptyDaemonState()
    state.durableTradeSessions[session.tradeId] = session
    state.proofOperations[operation.operationKey!] = {
      operationId: operation.operationKey!,
      durableTradeRecovery: operation,
      kind: 'swap-lock',
      state: 'prepared',
      mintUrl: session.mintUrl,
      inputs: [
        {
          id: 'keyset-1',
          amount: 1,
          secret: 'foreign-input',
          C: '02'.padEnd(66, '1'),
        },
      ],
      outputs: {},
      metadata: { unit: 'sat' },
      createdAt: 1,
      updatedAt: 1,
    }
    await writeStateWithDurableSessionKeys(state)
    const database = new DatabaseSync(statePath())
    try {
      database
        .prepare(
          `UPDATE daemon_proof_operations SET operation_id = ?
         WHERE operation_id = ?`,
        )
        .run('trade-foreign/seller-lock', operation.operationKey!)
    } finally {
      database.close()
    }
    let mintInspections = 0
    let exactResumes = 0
    let sentMessages = 0
    CashuWallet.prototype.loadMint = async () => {
      mintInspections += 1
    }

    await assert.rejects(
      () =>
        recoverDaemonDurableTradeSessions({
          tradeId: operation.tradeId,
          authorityPreflight: async () => {},
        executor: {} as never,
        exactOperationAdapter: async () => {
            exactResumes += 1
        },
        connection: {
          async joinTrade() {
              sentMessages += 1
          },
          async sendSwapMessage() {
              sentMessages += 1
          },
        } as never,
      }),
      /durable trade recovery storage is unavailable/,
    )
    assert.equal(mintInspections, 0)
    assert.equal(exactResumes, 0)
    assert.equal(sentMessages, 0)
  } finally {
    CashuWallet.prototype.loadMint = originalLoadMint
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

test('daemon refuses a durable proof link before its TradeCreated session exists', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-unbound-durable-operation-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await writeState(emptyDaemonState())
    const operation = createDurableTradeProofOperationLink({
      tradeId: 'trade-unbound',
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey: 'trade-unbound/seller-lock',
      kind: 'cashu-atomic',
    })

    await assert.rejects(
      () =>
        prepareProofOperation({
        operationId: operation.operationKey!,
        durableTradeRecovery: operation,
          kind: 'swap-lock',
          mintUrl: 'https://mint.example',
        inputs: [],
        outputs: {},
      }),
      /has no durable trade session/,
    )
    assert.deepEqual(await readState(), emptyDaemonState())
  } finally {
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
  }
})

function durableSession(
  operation: ReturnType<typeof createDurableTradeProofOperationLink>,
): DurableTradeSession {
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: operation.tradeId,
    role: operation.role,
    localProtocolPubkey: 'a'.repeat(64),
    counterpartyProtocolPubkey: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 100,
    ephemeralKeyHandle: {
      keyId: `key-${operation.tradeId}`,
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
    },
    stage: 'proof-reserved',
    proofOperations: [operation],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}

async function assertAtomicTransitionSnapshot(
  operationKey: string,
  recordState: 'prepared' | 'mint-submitted',
  linkState: 'prepared' | 'mint-submitted',
  sessionStage: 'proof-reserved' | 'mint-submitted',
): Promise<void> {
  const reloaded = await readState()
  assert.equal(reloaded?.proofOperations[operationKey]?.state, recordState)
  assert.equal(
    reloaded?.proofOperations[operationKey]?.durableTradeRecovery?.state,
    linkState,
  )
  assert.equal(
    reloaded?.durableTradeSessions['trade-atomic']?.proofOperations[0]?.state,
    linkState,
  )
  assert.equal(
    reloaded?.durableTradeSessions['trade-atomic']?.stage,
    sessionStage,
  )
}
