import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  CheckStateEnum,
  Wallet as CashuWallet,
  type MintKeys,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeProofOperationLink,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { profileFromPublicKey, writeProfile } from '../src/profile.ts'
import { generateOrderEphemeralKeypair } from '../src/ephemeralKey.ts'
import {
  createDaemonSecrets,
  readSecrets,
  writeSecrets,
  type DaemonSecrets,
} from '../src/secrets.ts'
import {
  emptyDaemonState,
  prepareProofOperation,
  markProofOperationCompleted,
  markProofOperationMintSubmitted,
  installDaemonProofOperationCoordinator,
  readState,
  recordSwapMessage,
  recordTradeCreated,
  recordTradeStateChanged,
  statePath,
  updateState,
  writeState,
  type CashuProofRecord,
  type DaemonState,
} from '../src/state.ts'
import {
  createDaemonDurableTradeRecoveryRunner,
  recoverDaemonDurableTradeSessions,
} from '../src/durableTradeRecovery.ts'
import {
  createRealDaemonSwapOps,
  recoverExactDaemonProofOperation,
} from '../src/swapProtocolAdapter.ts'
import {
  DaemonSwapExecutor,
  type DaemonSwapExecutorOptions,
  type DaemonSwapOps,
} from '../src/swapExecutor.ts'
import type { TradeRuntimeConnection } from '../src/tradeRuntime.ts'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'
import { DaemonProofOperationCoordinator } from '../src/durableProofOperationCoordinator.ts'
import {
  DaemonOrderCollateralCoordinator,
  durableOrderCollateralPinId,
  installDaemonOrderCollateralCoordinator,
  setDaemonOrderCollateralFaultHookForTest,
} from '../src/durableOrderCollateralCoordinator.ts'

test('DaemonSwapExecutor drives seller open and claim with durable wallet state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-swap-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: fakeOps(),
    })
    const created = await recordTradeCreated({
      tradeId: 'trade-1',
      sellerPubkey: orderKey(secrets).publicKeyHex,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })

    await executor.onTradeCreated(created)

    let persisted = await readState()
    assert.equal(persisted?.swaps['trade-1'].step, 'seller-opened')
    assert.equal(persisted?.swaps['trade-1'].sellerAdaptorSecretHex, 'aa')
    assert.equal(persisted?.swaps['trade-1'].sellerAdaptorPointHex, 'bb')
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'secret-100'),
      false,
    )
    const lockedSellerProof = persisted?.wallet.proofs.find(
      (row) => row.proof.secret === 'seller-locked',
    )
    assert.equal(lockedSellerProof?.state, 'locked')
    assert.equal(lockedSellerProof?.reservedBy, 'trade-1')
    assert.deepEqual(sent, [
      'trade-1:adaptor-point:cipher-adaptor',
      'trade-1:locked-proofs-seller:cipher-seller',
    ])

    const withBuyerCipher = await recordSwapMessage(
      'trade-1',
      'locked-proofs-buyer',
      'cipher-buyer',
    )
    await executor.onSwapMessage(withBuyerCipher)

    persisted = await readState()
    assert.equal(persisted?.swaps['trade-1'].step, 'awaiting-confirmation')
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) =>
          row.asset.kind === 'sats' && row.proof.secret === 'seller-claim',
      ),
      true,
    )
    assert.equal(sent.at(-1), 'trade-1:settlement-complete:')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor ignores unrelated native proof operations while resuming a live swap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-recovery-sweep-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    state.proofOperations['order-1/preflight-ctf-split'] = {
      operationId: 'order-1/preflight-ctf-split',
      kind: 'ctf-split',
      state: 'mint-submitted',
      mintUrl: profile.mintUrl,
      inputs: [],
      outputs: {},
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-live',
      sellerPubkey: orderKey(secrets).publicKeyHex,
      buyerPubkey: `03${'23'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: fakeOps(),
    })

    assert.deepEqual(
      await executor.resumeActiveSwaps((await readState()) as DaemonState),
      {
      activeSwaps: 1,
      },
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps[created!.tradeId].step, 'seller-opened')
    assert.equal(
      persisted?.proofOperations['order-1/preflight-ctf-split']
        .durableTradeRecovery,
      undefined,
    )
    assert.deepEqual(sent, [
      'trade-live:adaptor-point:cipher-adaptor',
      'trade-live:locked-proofs-seller:cipher-seller',
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor classifies each durable link state before resuming matching swaps', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-durable-link-state-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: fakeOps(),
    })

    for (const state of ['prepared', 'mint-submitted'] as const) {
      await writeStateWithSessionKeys(stateWithLiveSwapAndDurableLink(state))

      assert.deepEqual(
        await executor.resumeActiveSwaps((await readState()) as DaemonState),
        {
        activeSwaps: 0,
        },
      )
      assert.equal(
        (await readState())?.swaps['trade-live'].step,
        'seller-opened',
      )
    }

    await writeStateWithSessionKeys(
      stateWithLiveSwapAndDurableLink('reconciled'),
    )

    assert.deepEqual(
      await executor.resumeActiveSwaps((await readState()) as DaemonState),
      {
      activeSwaps: 1,
      },
    )
    assert.equal((await readState())?.swaps['trade-live'].step, 'seller-opened')

    sent.length = 0
    await writeStateWithSessionKeys(stateWithLiveSwapAndDurableLink('prepared'))
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_proof_operations SET durable_state = ?
         WHERE operation_id = ?`,
        )
        .run('unknown-state', 'trade-live/seller-lock')
    } finally {
      database.close()
    }

    await assert.rejects(
      () => readState(),
      /durable proof operation link is invalid/,
    )
    assert.deepEqual(sent, [])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-lock-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = {
      ...orderKey(secrets),
      marketId: 'cond-A',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-A',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs() {
          const err = new Error('leg 2 mint swap failed') as Error & {
            failure: {
              kind: 'PartialLockHeld'
              refundLocktime: number
              affectedKeysets: string[]
              detail: string
            }
            partialLock: {
              spentProofs: ReturnType<typeof cashuProof>[]
              lockedProofs: ReturnType<typeof cashuProof>[]
              changeProofs: ReturnType<typeof cashuProof>[]
            }
          }
          err.failure = {
            kind: 'PartialLockHeld',
            refundLocktime: 1_779_393_600,
            affectedKeysets: ['A'],
            detail: 'leg 1 locked; leg 2 failed',
          }
          err.partialLock = {
            spentProofs: [cashuProof(100, 'secret-100')],
            lockedProofs: [cashuProof(100, 'partial-locked')],
            changeProofs: [],
          }
          throw err
        },
        async sellerOpenPrelocked() {
          throw new Error('sellerOpenPrelocked must not run after partial lock')
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-partial-lock',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'22'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-A',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'DirectSwap',
      }),
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-partial-lock'].step, 'Failed')
    assert.equal(
      persisted?.swaps['trade-partial-lock'].failure?.kind,
      'PartialLockHeld',
    )
    assert.equal(
      persisted?.swaps['trade-partial-lock'].failure?.refundLocktime,
      1_779_393_600,
    )
    assert.deepEqual(
      persisted?.swaps['trade-partial-lock'].failure?.affectedKeysets,
      ['keyset-100'],
    )
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'secret-100'),
      false,
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'partial-locked',
      )?.state,
      'locked',
    )
    assert.deepEqual(sent, [])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('PartialLockHeld projection alone cannot authorize a refund', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-refund-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = {
      ...orderKey(secrets),
      marketId: 'cond-A',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.swaps['trade-partial-refund'] = {
      tradeId: 'trade-partial-refund',
      orderId: 'order-1',
      marketId: 'cond-A',
      role: 'seller',
      counterpartyPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: 1_800_000_120,
      buyerLocktime: 1_800_000_100,
      fillAmountSats: 100,
      messages: {},
      step: 'Failed',
      error: 'leg 1 locked; leg 2 failed',
      failure: {
        kind: 'PartialLockHeld',
        refundLocktime: 1,
        affectedKeysets: ['A'],
        detail: 'leg 1 locked; leg 2 failed',
      },
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.durableTradeSessions['trade-partial-refund'] = durableSessionForTest(
      'trade-partial-refund',
      'seller',
      {
        keyId: 'order-1',
        localProtocolPubkey: secrets.orderEphemeralKeys['order-1'].publicKeyHex,
        counterpartyProtocolPubkey: `03${'22'.repeat(32)}`,
        mintUrl: profile.mintUrl,
        sellerLocktimeSecs: 1_800_000_120,
        buyerLocktimeSecs: 1_800_000_100,
      },
    )
    state.wallet.proofs.push({
      ...proofRecord(profile.mintUrl, 100, 'locked', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
      reservedBy: 'trade-partial-refund',
      proof: cashuProof(100, 'partial-locked'),
    })
    await writeState(state)

    const refunded: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async refundLockedProofs(_ctx, proofs, operationId) {
          refunded.push(`${operationId}:${proofs[0].secret}`)
          return [cashuProof(100, 'partial-refunded')]
        },
      },
    })

    await assert.rejects(
      executor.resumeActiveSwaps((await readState()) as DaemonState),
      /partial lock refund has no reconciled output authority/,
    )

    const persisted = await readState()
    assert.deepEqual(refunded, [])
    assert.equal(persisted?.swaps['trade-partial-refund'].step, 'Failed')
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) => row.proof.secret === 'partial-locked',
      ),
      true,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('PartialLockHeld_MultiKeyset_AnnotatesRefundedProofsPerKeyset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-multi-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = {
      ...orderKey(secrets),
      marketId: 'cond-B|C',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.swaps['trade-partial-multi'] = {
      tradeId: 'trade-partial-multi',
      orderId: 'order-1',
      marketId: 'cond-B|C',
      role: 'seller',
      counterpartyPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: 1_800_000_120,
      buyerLocktime: 1_800_000_100,
      fillAmountSats: 100,
      messages: {},
      step: 'Failed',
      error: 'leg 1 locked; leg 2 failed',
      failure: {
        kind: 'PartialLockHeld',
        tradeId: 'trade-partial-multi',
        refundLocktime: 1,
        affectedKeysets: ['keyset-B', 'keyset-C'],
        detail: 'leg 1 locked; leg 2 failed',
        outcomeByKeyset: {
          'keyset-B': {
            conditionId: 'cond',
            outcomeCollection: 'B',
            marketId: 'cond-B',
          },
          'keyset-C': {
            conditionId: 'cond',
            outcomeCollection: 'C',
            marketId: 'cond-C',
          },
        },
        lockedProofs: [
          { ...cashuProof(100, 'partial-locked-B'), id: 'keyset-B' },
          { ...cashuProof(100, 'partial-locked-C'), id: 'keyset-C' },
        ],
      },
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.durableTradeSessions['trade-partial-multi'] = durableSessionForTest(
      'trade-partial-multi',
      'seller',
      {
        keyId: 'order-1',
        localProtocolPubkey: secrets.orderEphemeralKeys['order-1'].publicKeyHex,
        counterpartyProtocolPubkey: `03${'22'.repeat(32)}`,
        mintUrl: profile.mintUrl,
        sellerLocktimeSecs: 1_800_000_120,
        buyerLocktimeSecs: 1_800_000_100,
      },
    )
    const sourceB = {
      ...proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome' as const,
        conditionId: 'cond',
        outcomeSetId: 'B',
      }),
      proof: {
        ...cashuProof(100, 'partial-source-B'),
        id: 'keyset-B',
        conditionId: 'cond',
        outcomeCollection: 'B',
      },
    }
    const sourceC = {
      ...proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome' as const,
        conditionId: 'cond',
        outcomeSetId: 'C',
      }),
      proof: {
        ...cashuProof(100, 'partial-source-C'),
        id: 'keyset-C',
        conditionId: 'cond',
        outcomeCollection: 'C',
      },
    }
    state.wallet.proofs.push(
      sourceB,
      sourceC,
      {
        ...proofRecord(profile.mintUrl, 100, 'locked', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'B',
        }),
        reservedBy: 'trade-partial-multi',
        proof: { ...cashuProof(100, 'partial-locked-B'), id: 'keyset-B' },
      },
      {
        ...proofRecord(profile.mintUrl, 100, 'locked', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'C',
        }),
        reservedBy: 'trade-partial-multi',
        proof: { ...cashuProof(100, 'partial-locked-C'), id: 'keyset-C' },
      },
    )
    await writeState(state)
    ;({ lease, uninstall: uninstallCoordinator } =
      await installCanonicalProofCoordinatorForTest(secrets, sourceB.unit))
    await recordReconciledSwapLockForTest({
      tradeId: 'trade-partial-multi',
      operationId: 'trade-partial-multi/seller-lock/B',
      source: sourceB,
      lockedProofs: [
        { ...cashuProof(100, 'partial-locked-B'), id: 'keyset-B' },
      ],
    })
    await recordReconciledSwapLockForTest({
      tradeId: 'trade-partial-multi',
      operationId: 'trade-partial-multi/seller-lock/C',
      source: sourceC,
      lockedProofs: [
        { ...cashuProof(100, 'partial-locked-C'), id: 'keyset-C' },
      ],
    })

    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async refundLockedProofs(_ctx, proofs) {
          return proofs.map((proof) => ({
            ...cashuProof(proof.amount, `refunded-${proof.secret}`),
            id: proof.id,
          }))
        },
      },
    })

    await executor.resumeActiveSwaps((await readState()) as DaemonState)

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-partial-multi'].step, 'refunded')
    const refundedB = persisted?.wallet.proofs.find(
      (row) => row.proof.secret === 'refunded-partial-locked-B',
    )
    const refundedC = persisted?.wallet.proofs.find(
      (row) => row.proof.secret === 'refunded-partial-locked-C',
    )
    assert.equal(refundedB?.asset.kind, 'Outcome')
    assert.equal(
      refundedB?.asset.kind === 'Outcome' ? refundedB.asset.outcomeSetId : '',
      'B',
    )
    assert.equal(refundedC?.asset.kind, 'Outcome')
    assert.equal(
      refundedC?.asset.kind === 'Outcome' ? refundedC.asset.outcomeSetId : '',
      'C',
    )
  } finally {
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('Block2_PartialLockHeld_AlreadySpentReconcilesAsRefunded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-spent-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = {
      ...orderKey(secrets),
      marketId: 'cond-A',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.swaps['trade-partial-spent'] = {
      tradeId: 'trade-partial-spent',
      orderId: 'order-1',
      marketId: 'cond-A',
      role: 'seller',
      counterpartyPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: 1_800_000_120,
      buyerLocktime: 1_800_000_100,
      fillAmountSats: 100,
      messages: {},
      step: 'Failed',
      error: 'leg 1 locked; leg 2 failed',
      failure: {
        kind: 'PartialLockHeld',
        tradeId: 'trade-partial-spent',
        refundLocktime: 1,
        affectedKeysets: ['A'],
        detail: 'leg 1 locked; leg 2 failed',
        outcomeByKeyset: {
          'keyset-100': {
            conditionId: 'cond',
            outcomeCollection: 'A',
            marketId: 'cond-A',
          },
        },
        lockedProofs: [cashuProof(100, 'partial-spent')],
      },
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.durableTradeSessions['trade-partial-spent'] = durableSessionForTest(
      'trade-partial-spent',
      'seller',
      {
        keyId: 'order-1',
        localProtocolPubkey: secrets.orderEphemeralKeys['order-1'].publicKeyHex,
        counterpartyProtocolPubkey: `03${'22'.repeat(32)}`,
        mintUrl: profile.mintUrl,
        sellerLocktimeSecs: 1_800_000_120,
        buyerLocktimeSecs: 1_800_000_100,
      },
    )
    const source = {
      ...proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome' as const,
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
      proof: {
        ...cashuProof(100, 'partial-spent-source'),
        conditionId: 'cond',
        outcomeCollection: 'A',
      },
    }
    state.wallet.proofs.push(source, {
      ...proofRecord(profile.mintUrl, 100, 'locked', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
      reservedBy: 'trade-partial-spent',
      proof: cashuProof(100, 'partial-spent'),
    })
    await writeState(state)
    ;({ lease, uninstall: uninstallCoordinator } =
      await installCanonicalProofCoordinatorForTest(secrets, source.unit))
    await recordReconciledSwapLockForTest({
      tradeId: 'trade-partial-spent',
      operationId: 'trade-partial-spent/seller-lock',
      source,
      lockedProofs: [cashuProof(100, 'partial-spent')],
    })

    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async refundLockedProofs() {
          throw new Error('proof already spent')
        },
      },
    })

    await executor.resumeActiveSwaps((await readState()) as DaemonState)

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-partial-spent'].step, 'refunded')
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) => row.proof.secret === 'partial-spent',
      ),
      false,
    )
  } finally {
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor leaves persisted seller open resumable when hub send fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-send-fail-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    const executor = newTestDaemonSwapExecutor({
      connection: throwingSendConnection(),
      ops: fakeOps(),
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-send-fail',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'88'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-YES',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'DirectSwap',
      }),
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-send-fail'].step, 'seller-opened')
    assert.equal(
      persisted?.swaps['trade-send-fail'].messages.lockedProofsSeller,
      'cipher-seller',
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor keeps pending proof operations retryable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-proof-pending-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs() {
          throw new Error(
            'Proof operation trade-pending/seller-lock is still pending at the mint',
          )
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-pending',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'89'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-YES',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'DirectSwap',
      }),
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-pending'].step, 'opened')
    assert.match(
      persisted?.swaps['trade-pending'].error ?? '',
      /still pending at the mint/,
    )
    assert.equal(persisted?.wallet.proofs[0].state, 'available')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor routes a mint-pending retry through the durable recovery owner', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-proof-pending-retry-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    let lockAttempts = 0
    const sent: string[] = []
    const recoverySchedules: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      retryDelayMs: 5,
      maxRetryAttempts: 3,
      scheduleRecovery: (tradeId) => {
        recoverySchedules.push(tradeId)
      },
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(ctx, proofs, amount, operationId) {
          lockAttempts += 1
          if (lockAttempts === 1) {
            throw new Error(
              'Proof operation trade-retry/seller-lock is still pending at the mint',
            )
          }
          return fakeOps().sellerLockOutcomeProofs(
            ctx,
            proofs,
            amount,
            operationId,
          )
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-retry',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'90'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-YES',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'DirectSwap',
      }),
    )

    for (
      let attempt = 0;
      attempt < 20 && recoverySchedules.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(lockAttempts, 1)
    assert.deepEqual(recoverySchedules, ['trade-retry'])
    assert.deepEqual(sent, [])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor drives buyer response and claim with durable wallet state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-swap-buyer-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-2'] = {
      ...orderKey(secrets),
      orderId: 'order-2',
      marketId: 'cond-NO',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-2'] = {
      orderId: 'order-2',
      marketId: 'cond-NO',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...directBuyerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 42, 'available', { kind: 'sats' }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: buyerFakeOps(),
    })
    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-2',
        sellerPubkey: `02${'44'.repeat(32)}`,
        buyerPubkey: orderKey(secrets).publicKeyHex,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-NO',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'DirectSwap',
      }),
    )

    await executor.onSwapMessage(
      await recordSwapMessage('trade-2', 'adaptor-point', 'cipher-adaptor'),
    )
    await executor.onSwapMessage(
      await recordSwapMessage(
        'trade-2',
        'locked-proofs-seller',
        'cipher-seller',
      ),
    )

    let persisted = await readState()
    assert.equal(persisted?.swaps['trade-2'].step, 'buyer-responded')
    assert.equal(persisted?.swaps['trade-2'].buyerPreSigsHex?.[0], 'pre-b')
    assert.equal(persisted?.wallet.proofs[0].state, 'locked')
    assert.equal(sent.at(-1), 'trade-2:locked-proofs-buyer:cipher-buyer')

    await executor.onTradeStateChanged(
      await recordTradeStateChanged('trade-2', 'Settling'),
    )

    persisted = await readState()
    assert.equal(persisted?.swaps['trade-2'].step, 'awaiting-confirmation')
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) =>
          row.asset.kind === 'Outcome' &&
          row.asset.outcomeSetId === 'NO' &&
          row.proof.secret === 'buyer-claim',
      ),
      true,
    )
    assert.equal(sent.at(-1), 'trade-2:settlement-complete:')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor resume sweep retries active claim after retryable timeout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-claim-retry-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-retry'] = {
      ...orderKey(secrets),
      orderId: 'order-retry',
      marketId: 'cond-NO',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.swaps['trade-retry'] = {
      tradeId: 'trade-retry',
      marketId: 'cond-NO',
      orderId: 'order-retry',
      role: 'buyer',
      counterpartyPubkey: `02${'98'.repeat(32)}`,
      sellerLocktime: 1_779_321_720,
      buyerLocktime: 1_779_321_660,
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      messages: {
        adaptorPoint: 'cipher-adaptor',
        lockedProofsSeller: 'cipher-seller',
        lockedProofsBuyer: 'cipher-buyer',
      },
      buyerLockedProofs: [cashuProof(42, 'buyer-locked')],
      buyerPreSigsHex: ['pre-b'],
      sellerPreSigsHex: ['pre-s'],
      step: 'settling',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:30.000Z',
    }
    state.durableTradeSessions['trade-retry'] = durableSessionForTest(
      'trade-retry',
      'buyer',
      {
        keyId: 'order-retry',
        localProtocolPubkey:
          secrets.orderEphemeralKeys['order-retry'].publicKeyHex,
        counterpartyProtocolPubkey: `02${'98'.repeat(32)}`,
        mintUrl: profile.mintUrl,
        sellerLocktimeSecs: 1_779_321_720,
        buyerLocktimeSecs: 1_779_321_660,
      },
    )
    await writeState(state)

    const sent: string[] = []
    let attempts = 0
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...buyerFakeOps(),
        async buyerClaim() {
          attempts += 1
          if (attempts === 1) {
            throw new Error('Timed out waiting for seller to spend at mint')
          }
          return [cashuProof(100, 'buyer-claim-retry')]
        },
      },
    })

    await executor.resumeActiveSwaps(state)
    let persisted = await readState()
    assert.equal(persisted?.swaps['trade-retry'].step, 'settling')
    assert.match(
      persisted?.swaps['trade-retry'].error ?? '',
      /Timed out waiting for seller to spend at mint/,
    )

    await executor.resumeActiveSwaps((await readState()) as DaemonState)

    persisted = await readState()
    assert.equal(persisted?.swaps['trade-retry'].step, 'awaiting-confirmation')
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) =>
          row.asset.kind === 'Outcome' &&
          row.asset.outcomeSetId === 'NO' &&
          row.proof.secret === 'buyer-claim-retry',
      ),
      true,
    )
    assert.equal(sent.at(-1), 'trade-retry:settlement-complete:')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor drives mint seller split before opening swap', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-swap-complement-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-3'] = {
      ...orderKey(secrets),
      orderId: 'order-3',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-3'] = {
      orderId: 'order-3',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...mintSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', { kind: 'sats' }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: mintFakeOps(),
      walletOpsDeps: {
        createCashuWallet() {
          return {
            keysetId: 'keyset-100',
            async loadMint() {},
            async receive() {
              return []
            },
            async send() {
              return { keep: [], send: [] }
            },
            selectProofsToSend(proofs) {
              return { keep: [], send: proofs }
            },
            getFeesForProofs() {
              return 0
            },
            async prepareSwapToSend(amount, proofs) {
              return {
                amount,
                fees: 0,
                inputs: proofs,
                keysetId: 'keyset-100',
                sendOutputs: [],
                keepOutputs: [],
                unselectedProofs: [],
              }
            },
            async completeSwap(preview) {
              return { keep: [], send: preview.inputs }
            },
          }
        },
        async resolveMintKeysByKeyset(_mintUrl, keysetIds) {
          return Object.fromEntries(
            keysetIds.map((id) => [
              id,
              {
                id,
                unit: 'sat',
                keys: { 1: 'k1' },
                input_fee_ppk: 0,
              },
            ]),
          )
        },
        async resolveInputFeePpkByKeyset(_mintUrl, keysetIds) {
          return Object.fromEntries(keysetIds.map((id) => [id, 0]))
        },
        async resolveRootDirectLockOutputAmountSats(params) {
          assert.deepEqual(params, {
            mintUrl: profile.mintUrl,
            baseAsset: 'sat',
            conditionId: 'cond',
            amountSats: 100,
            keepOutcomeSetId: 'YES',
            lockOutcomeSetId: 'NO',
          })
          return 100
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-3',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'55'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-YES',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'Mint',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
      }),
    )

    const persisted = await readState()
    assert.equal(
      persisted?.swaps['trade-3'].step,
      'seller-opened',
      persisted?.swaps['trade-3'].error,
    )
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'secret-100'),
      false,
    )
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) =>
          row.asset.kind === 'Outcome' &&
          row.asset.outcomeSetId === 'YES' &&
          row.proof.secret === 'keep-proof',
      ),
      true,
    )
    assert.equal(sent[0], 'trade-3:adaptor-point:cipher-adaptor')
    assert.equal(sent[1], 'trade-3:locked-proofs-seller:cipher-seller')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor uses pinned pre-flight inventory for mint seller open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-preflight-mint-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  let uninstallOrderCollateral: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-preflight'] = {
      ...orderKey(secrets),
      orderId: 'order-preflight',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const clientOrderId = 'client-order-preflight'
    const reservationId = durableOrderCollateralPinId(clientOrderId)
    const state = emptyDaemonState()
    state.orders['order-preflight'] = {
      orderId: 'order-preflight',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      clientOrderId,
      timeInForce: 'GTC',
      ...mintSellerOrderEconomics(),
      preflightSplit: {
        reservationId,
        conditionId: 'cond',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: 100,
      },
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    const lockRow = {
        ...proofRecord(profile.mintUrl, 100, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'NO',
        }),
        proof: cashuProof(100, 'reserved-lock-no'),
      }
    const keepRow = {
        ...proofRecord(profile.mintUrl, 100, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        proof: cashuProof(100, 'reserved-keep-yes'),
      }
    state.wallet.proofs.push(lockRow, keepRow)
    await writeState(state)
    ;({ lease, uninstall: uninstallCoordinator } =
      await installCanonicalProofCoordinatorForTest(secrets, lockRow.unit))
    const orderCollateral = new DaemonOrderCollateralCoordinator(lease)
    uninstallOrderCollateral = installDaemonOrderCollateralCoordinator(
      orderCollateral,
    )
    const pin = await orderCollateral.prepare({
      clientOrderId,
      marketId: 'cond-YES',
      mintUrl: profile.mintUrl,
      unit: lockRow.unit,
      orderAmount: 100,
      requiredAmount: 100,
      submissionRequest: {
        clientOrderId,
        outcomeId: 'YES',
        tokenSide: 'Complement',
        side: 'Buy',
        price: 58,
        amountSubunits: 100,
        timeInForce: 'GTC',
      },
      preflightSplit: state.orders['order-preflight'].preflightSplit,
      proofs: [lockRow, keepRow],
    })
    await orderCollateral.bindOrObserve({
      pinId: pin.pinId,
      orderId: 'order-preflight',
      status: 'resting',
      remainingAmount: 100,
    })
    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(ctx, proofs, amount, operationId) {
          assert.equal(proofs[0].secret, 'reserved-lock-no')
          assert.equal(amount, 100)
          assert.match(operationId, /seller-inventory-lock$/)
          const result = {
            lockedProofs: [cashuProof(100, 'lock-locked-100')],
            changeProofs: [],
          }
          await recordReconciledProofOperationForTest({
            tradeId: ctx.tradeId,
            operationId,
            mintUrl: profile.mintUrl,
            unit: lockRow.unit,
            sourceProofs: proofs,
            resultProofs: {
              send: result.lockedProofs,
              keep: result.changeProofs,
            },
            parentOrderCollateralPinId: pin.pinId,
          })
          return result
        },
        async sellerOpenPrelocked(_ctx, proofs) {
          assert.equal(proofs[0].secret, 'lock-locked-100')
          return {
            adaptorPointCipher: 'cipher-adaptor',
            lockedProofsCipher: 'cipher-seller',
            adaptorSecretHex: 'aa',
            adaptorPointHex: 'bb',
            lockedProofs: proofs,
            changeProofs: [],
          }
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-preflight',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'56'.repeat(32)}`,
        sellerLocktime: '2027-01-15T00:02:00.000Z',
        buyerLocktime: '2027-01-15T00:01:00.000Z',
        marketId: 'cond-YES',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'Mint',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
      }),
    )

    const persisted = await readState()
    assert.equal(
      persisted?.swaps['trade-preflight'].step,
      'seller-opened',
      persisted?.swaps['trade-preflight'].error,
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'reserved-lock-no',
      )?.state,
      undefined,
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'lock-locked-100',
      )?.state,
      'locked',
    )
    const keep = persisted?.wallet.proofs.find(
      (row) => row.proof.secret === 'reserved-keep-yes',
    )
    assert.equal(keep?.state, 'available')
    assert.equal(keep?.reservedBy, undefined)
    assert.deepEqual(sent, [
      'trade-preflight:adaptor-point:cipher-adaptor',
      'trade-preflight:locked-proofs-seller:cipher-seller',
    ])
  } finally {
    uninstallOrderCollateral?.()
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor uses primitive local inventory before pre-flight for composite mint seller open', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-primitive-before-preflight-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-preflight'] = {
      ...orderKey(secrets),
      orderId: 'order-preflight',
      marketId: 'cond-A',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const reservationId = `order-preflight:${orderKey(secrets).publicKeyHex}`
    const state = emptyDaemonState()
    state.orders['order-preflight'] = {
      orderId: 'order-preflight',
      marketId: 'cond-A',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...mintSellerOrderEconomics(),
      preflightSplit: {
        reservationId,
        conditionId: 'cond',
        keepOutcomeSetId: 'A',
        lockOutcomeSetId: 'B|C',
        amountSats: 100,
      },
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      {
        ...proofRecord(profile.mintUrl, 100, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'B',
        }),
        proof: { ...cashuProof(100, 'primitive-b'), id: 'keyset-B' },
      },
      {
        ...proofRecord(profile.mintUrl, 100, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'C',
        }),
        proof: { ...cashuProof(100, 'primitive-c'), id: 'keyset-C' },
      },
      {
        ...proofRecord(profile.mintUrl, 100, 'reserved', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'B|C',
        }),
        reservedBy: reservationId,
        proof: { ...cashuProof(100, 'reserved-composite'), id: 'keyset-BC' },
      },
    )
    await writeState(state)

    const sent: string[] = []
    const lockCalls: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(_ctx, proofs, amount, operationId) {
          assert.equal(amount, 100)
          lockCalls.push(`${operationId}:${proofs[0].secret}`)
          return {
            lockedProofs: [
              {
                ...cashuProof(100, `locked-${proofs[0].secret}`),
                id: proofs[0].id,
              },
            ],
            changeProofs: [],
          }
        },
        async sellerOpenPrelocked(_ctx, proofs) {
          assert.deepEqual(proofs.map((proof) => proof.secret).sort(), [
            'locked-primitive-b',
            'locked-primitive-c',
          ])
          return {
            adaptorPointCipher: 'cipher-adaptor',
            lockedProofsCipher: 'cipher-seller',
            adaptorSecretHex: 'aa',
            adaptorPointHex: 'bb',
            lockedProofs: proofs,
            changeProofs: [],
          }
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-primitive-before-preflight',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'57'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-A',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'Mint',
        sellerKeepOutcomeSetId: 'A',
        sellerLockOutcomeSetId: 'B|C',
      }),
    )

    const persisted = await readState()
    assert.equal(
      persisted?.swaps['trade-primitive-before-preflight'].step,
      'seller-opened',
      persisted?.swaps['trade-primitive-before-preflight'].error,
    )
    assert.deepEqual(lockCalls.sort(), [
      'trade-primitive-before-preflight/seller-inventory-lock/B:primitive-b',
      'trade-primitive-before-preflight/seller-inventory-lock/C:primitive-c',
    ])
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'reserved-composite',
      )?.state,
      'reserved',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'locked-primitive-b',
      )?.asset.kind,
      'Outcome',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'locked-primitive-b',
      )?.asset.outcomeSetId,
      'B',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'locked-primitive-c',
      )?.asset.outcomeSetId,
      'C',
    )
    assert.deepEqual(sent, [
      'trade-primitive-before-preflight:adaptor-point:cipher-adaptor',
      'trade-primitive-before-preflight:locked-proofs-seller:cipher-seller',
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('production CTF seller lock uses a canonical key and recovers its retained operation after restart', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-ctf-lock-restart-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const originalLoadMint = CashuWallet.prototype.loadMint
  const originalCheckProofsStates = CashuWallet.prototype.checkProofsStates
  let custodyLease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  let uninstallOrderCollateral: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-ctf'] = {
      ...orderKey(secrets),
      orderId: 'order-ctf',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex, {
      mintUrl: 'https://mint.example',
    })
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-ctf'] = {
      orderId: 'order-ctf',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      clientOrderId: 'client-order-ctf',
      timeInForce: 'GTC',
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    const pinnedInput = {
      ...proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
      proof: { ...cashuProof(100, 'ctf-retained-input'), id: 'ctf-keyset' },
    }
    state.wallet.proofs.push(
      pinnedInput,
      {
        ...proofRecord(profile.mintUrl, 200, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        proof: { ...cashuProof(200, 'fresh-decoy'), id: 'ctf-keyset' },
      },
    )
    await writeState(state)
    const custodyStore = new SqliteDurableCustodyStore()
    await custodyStore.registerScope(
      daemonWalletCustodyScope(secrets.walletSeedHex),
    )
    custodyLease = await DaemonDurableCustodyLease.claim({
      store: custodyStore,
      walletSeedHex: secrets.walletSeedHex,
    })
    uninstallCoordinator = installDaemonProofOperationCoordinator(
      new DaemonProofOperationCoordinator({
        authority: custodyLease,
        resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
          keysetIds.map((keysetId) => [keysetId, {
            id: keysetId,
            unit: pinnedInput.unit,
            active: true,
            input_fee_ppk: 0,
            keys: { '100': `02${'44'.repeat(32)}` },
          } as MintKeys]),
        ),
      }),
    )
    const orderCollateral = new DaemonOrderCollateralCoordinator(custodyLease)
    uninstallOrderCollateral = installDaemonOrderCollateralCoordinator(
      orderCollateral,
    )
    const pin = await orderCollateral.prepare({
      clientOrderId: 'client-order-ctf',
      marketId: 'cond-YES',
      mintUrl: profile.mintUrl,
      unit: pinnedInput.unit,
      orderAmount: 100,
      requiredAmount: 100,
      submissionRequest: {
        clientOrderId: 'client-order-ctf',
        outcomeId: 'YES',
        tokenSide: 'Outcome',
        side: 'Sell',
        price: 50,
        amountSubunits: 100,
        timeInForce: 'GTC',
      },
      proofs: [pinnedInput],
    })
    await orderCollateral.bindOrObserve({
      pinId: pin.pinId,
      orderId: 'order-ctf',
      status: 'resting',
      remainingAmount: 100,
    })

    let preparedKey: string | undefined
    let resumedKey: string | undefined
    let exactResumed = 0
    let injectFillCommitCrash = true
    let canonicalStateBeforeFill: string | undefined
    let allocatedOperationKeyBeforeFill: string | undefined
    const loadAtomicSwapModule = async () => ({
      async sellerLockOutcomeProofs(
        _ctx: unknown,
        proofs: CashuProofRecord[],
        _amount: number,
        options: {
        operationId?: string
        proofOperationStore?: {
          prepareProofOperation(input: {
            operationId: string
            kind: 'conditional-keyset-swap'
            mintUrl: string
            inputs: CashuProofRecord[]
            outputs: Record<string, never[]>
            metadata: Record<string, unknown>
          }): Promise<unknown>
            markProofOperationMintSubmitted(
              operationId: string,
            ): Promise<unknown>
        }
        },
      ) {
        if (exactResumed > 0) {
          resumedKey = options.operationId
          assert.deepEqual(
            proofs.map((proof) => proof.secret),
            ['ctf-retained-input'],
          )
          return {
            lockedProofs: [
              { ...proofs[0]!, secret: 'ctf-recovered-lock' },
            ],
            changeProofs: [],
          }
        }
        preparedKey = options.operationId
        await options.proofOperationStore!.prepareProofOperation({
          operationId: options.operationId!,
          kind: 'conditional-keyset-swap',
          mintUrl: profile.mintUrl,
          inputs: proofs,
          outputs: {
            lock: [
              {
                blindedMessage: {
                  amount: 100,
                  id: 'ctf-keyset',
                  B_: 'ctf-retained-output',
                },
                blindingFactor: '01',
                secret: 'ctf-retained-output-secret',
              },
            ],
          },
          metadata: { unit: pinnedInput.unit, keysetId: 'ctf-keyset' },
        })
        const submitted = await options.proofOperationStore!.markProofOperationMintSubmitted(
          options.operationId!,
        )
        assert.equal(
          (submitted as { state?: unknown }).state,
          'mint-submitted',
        )
        assert.equal(
          (await readState()).proofOperations[options.operationId!]?.state,
          'mint-submitted',
        )
        throw new Error(
          `Proof operation ${options.operationId} is still pending at the mint`,
        )
      },
      async resumeExactPreparedProofOperation(
        _wallet: unknown,
        entry: { inputs: CashuProofRecord[] },
      ) {
        exactResumed += 1
        assert.deepEqual(
          entry.inputs.map((proof) => proof.secret),
          ['ctf-retained-input'],
        )
        return {
          lock: [{ ...entry.inputs[0]!, secret: 'ctf-recovered-lock' }],
        }
      },
      async restoreExactPreparedProofOperation() {
        throw new Error('restore path was not expected')
      },
      async sellerPreparePrelockedSwap(
        _ctx: unknown,
        proofs: CashuProofRecord[],
      ) {
        assert.deepEqual(
          proofs.map((proof) => proof.secret),
          ['ctf-recovered-lock'],
        )
        const database = new DatabaseSync(statePath(), { readOnly: true })
        try {
          canonicalStateBeforeFill = (database.prepare(
            `SELECT operation_state
               FROM custody_operations
              WHERE retained_operation_key = ?`,
          ).get('trade-ctf/seller-lock') as
            | { operation_state: string }
            | undefined)?.operation_state
          allocatedOperationKeyBeforeFill = (database.prepare(
            `SELECT operation.retained_operation_key
               FROM custody_order_collateral_allocations AS allocation
               JOIN custody_operations AS operation
                 ON operation.scope_id = allocation.scope_id
                AND operation.operation_id = allocation.operation_id
              WHERE allocation.pin_id = ?`,
          ).get(pin.pinId) as
            | { retained_operation_key: string }
            | undefined)?.retained_operation_key
        } finally {
          database.close()
        }
        if (injectFillCommitCrash) {
          injectFillCommitCrash = false
          setDaemonOrderCollateralFaultHookForTest((stage) => {
            if (stage === 'before-commit') {
              throw new Error(
                'Proof operation trade-ctf/seller-lock is still pending at the mint',
              )
            }
          })
        }
        return {
          adaptorPointCipher: 'ctf-adaptor-cipher',
          lockedProofsCipher: 'ctf-locked-cipher',
          adaptorPoint: {
            secret: Uint8Array.of(1),
            point: Uint8Array.of(2),
          },
          lockedProofs: proofs,
          changeProofs: [],
        }
      },
    })
    const connection = fakeConnection([])
    const executor = newTestDaemonSwapExecutor({
      connection,
      retryDelayMs: 60_000,
      ops: createRealDaemonSwapOps({
        loadAtomicSwapModule: loadAtomicSwapModule as never,
      }),
    })
    const swap = await recordTradeCreated({
      tradeId: 'trade-ctf',
      sellerPubkey: orderKey(secrets).publicKeyHex,
      buyerPubkey: `03${'58'.repeat(32)}`,
      sellerLocktime: '2099-05-21T00:02:00.000Z',
      buyerLocktime: '2099-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })
    await executor.onTradeCreated(swap)

    assert.equal(preparedKey, 'trade-ctf/seller-lock')
    const beforeRestart = await readState()
    assert.equal(
      beforeRestart?.proofOperations[preparedKey!]?.state,
      'mint-submitted',
      beforeRestart?.swaps['trade-ctf']?.error,
    )
    assert.equal(
      beforeRestart?.proofOperations[preparedKey!]?.durableTradeRecovery
        ?.operationKey,
      'trade-ctf/seller-lock',
    )

    CashuWallet.prototype.loadMint = async () => undefined
    CashuWallet.prototype.checkProofsStates = async () =>
      [{ state: CheckStateEnum.UNSPENT }] as ProofState[]
    const runner = createDaemonDurableTradeRecoveryRunner({
      executor,
      connection,
      recoverDurableSessions: ({ scheduleRetry, tradeId }) =>
        recoverDaemonDurableTradeSessions({
          executor,
          connection,
          scheduleRetry,
          ...(tradeId === undefined ? {} : { tradeId }),
          exactOperationAdapter: (record, action) =>
            recoverExactDaemonProofOperation(record, action, {
              loadAtomicSwapModule: loadAtomicSwapModule as never,
            }),
        }),
    })
    const firstRecovery = await runner.recover()

    assert.equal(exactResumed, 1)
    assert.deepEqual(firstRecovery.durableRecovery.sessions, [
      { kind: 'ready', tradeId: 'trade-ctf' },
    ])
    assert.equal(firstRecovery.activeSwaps, 1)
    assert.equal(canonicalStateBeforeFill, 'reconciled')
    assert.equal(resumedKey, 'trade-ctf/seller-lock')
    assert.equal(
      allocatedOperationKeyBeforeFill,
      'trade-ctf/seller-lock',
    )
    const afterInjectedCrash = await readState()
    assert.equal(afterInjectedCrash?.swaps['trade-ctf']?.step, 'opened')
    assert.equal(
      afterInjectedCrash?.wallet.proofs.find(
        (proof) => proof.proof.secret === 'ctf-retained-input',
      )?.reservedBy,
      'trade-ctf/seller-lock',
    )
    setDaemonOrderCollateralFaultHookForTest(undefined)
    const recovered = await runner.recover()
    assert.equal(recovered.activeSwaps, 1)
    const afterRestart = await readState()
    assert.equal(
      afterRestart?.proofOperations[preparedKey!]?.state,
      'completed',
    )
    assert.equal(
      afterRestart?.durableTradeSessions['trade-ctf']?.stage,
      'reconciliation-complete',
    )
    assert.equal(
      afterRestart?.swaps['trade-ctf']?.step,
      'seller-opened',
      afterRestart?.swaps['trade-ctf']?.error,
    )
    assert.equal(
      afterRestart?.wallet.proofs.some(
        (proof) => proof.proof.secret === 'ctf-retained-input',
      ),
      false,
    )
    assert.equal(
      afterRestart?.wallet.proofs.find(
        (proof) => proof.proof.secret === 'ctf-recovered-lock',
      )?.reservedBy,
      'trade-ctf',
    )
    await assert.rejects(
      orderCollateral.readProofIds(pin.pinId),
      /order collateral pin is released/,
    )
  } finally {
    setDaemonOrderCollateralFaultHookForTest(undefined)
    uninstallOrderCollateral?.()
    uninstallCoordinator?.()
    await custodyLease?.stopAndRelease()
    CashuWallet.prototype.loadMint = originalLoadMint
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('non-GTC seller recovery reuses its exact reserved input instead of a fresh proof', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-fak-restart-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const originalLoadMint = CashuWallet.prototype.loadMint
  const originalCheckProofsStates = CashuWallet.prototype.checkProofsStates
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-fak'] = {
      ...orderKey(secrets),
      orderId: 'order-fak',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex, {
      mintUrl: 'https://mint.example',
    })
    await writeProfile(profile)
    await writeSecrets(secrets)
    const retained = {
      ...proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
      proof: { ...cashuProof(100, 'fak-retained'), id: 'ctf-keyset' },
    }
    const state = emptyDaemonState()
    state.orders['order-fak'] = {
      orderId: 'order-fak',
      marketId: 'cond-YES',
      status: 'filled',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      timeInForce: 'FAK',
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    const decoy = {
      ...retained,
      proof: { ...cashuProof(200, 'fak-decoy'), id: 'ctf-keyset' },
    }
    state.wallet.proofs.push(retained)
    await writeState(state)

    const store = new SqliteDurableCustodyStore()
    await store.registerScope(daemonWalletCustodyScope(secrets.walletSeedHex))
    lease = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: secrets.walletSeedHex,
    })
    uninstallCoordinator = installDaemonProofOperationCoordinator(
      new DaemonProofOperationCoordinator({
        authority: lease,
        resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
          keysetIds.map((keysetId) => [keysetId, {
            id: keysetId,
            unit: retained.unit,
            active: true,
            input_fee_ppk: 0,
            keys: { '100': `02${'44'.repeat(32)}` },
          } as MintKeys]),
        ),
      }),
    )
    let recoveryCalls = 0
    const loadAtomicSwapModule = async () => ({
      async sellerLockOutcomeProofs(
        _ctx: unknown,
        proofs: CashuProofRecord[],
        _amount: number,
        options: {
          operationId?: string
          proofOperationStore?: {
            prepareProofOperation(input: unknown): Promise<unknown>
            markProofOperationMintSubmitted(operationId: string): Promise<unknown>
          }
        },
      ) {
        assert.deepEqual(proofs.map(({ secret }) => secret), ['fak-retained'])
        if (recoveryCalls > 0) {
          return {
            lockedProofs: [{ ...proofs[0]!, secret: 'fak-recovered-lock' }],
            changeProofs: [],
          }
        }
        await options.proofOperationStore!.prepareProofOperation({
          operationId: options.operationId!,
          kind: 'conditional-keyset-swap',
          mintUrl: profile.mintUrl,
          inputs: proofs,
          outputs: {
            lock: [{
              blindedMessage: {
                amount: 100,
                id: 'ctf-keyset',
                B_: 'fak-retained-output',
              },
              blindingFactor: '01',
              secret: 'fak-retained-output-secret',
            }],
          },
          metadata: { unit: retained.unit, keysetId: 'ctf-keyset' },
        })
        await options.proofOperationStore!.markProofOperationMintSubmitted(
          options.operationId!,
        )
        throw new Error(`Proof operation ${options.operationId} is still pending at the mint`)
      },
      async resumeExactPreparedProofOperation(
        _wallet: unknown,
        entry: { inputs: CashuProofRecord[] },
      ) {
        recoveryCalls += 1
        assert.deepEqual(entry.inputs.map(({ secret }) => secret), ['fak-retained'])
        return {
          lock: [{ ...entry.inputs[0]!, secret: 'fak-recovered-lock' }],
        }
      },
      async restoreExactPreparedProofOperation() {
        throw new Error('restore path was not expected')
      },
      async sellerPreparePrelockedSwap(
        _ctx: unknown,
        proofs: CashuProofRecord[],
      ) {
        return {
          adaptorPointCipher: 'fak-adaptor-cipher',
          lockedProofsCipher: 'fak-lock-cipher',
          adaptorPoint: { secret: Uint8Array.of(1), point: Uint8Array.of(2) },
          lockedProofs: proofs,
          changeProofs: [],
        }
      },
    })
    const connection = fakeConnection([])
    const executor = newTestDaemonSwapExecutor({
      connection,
      retryDelayMs: 60_000,
      ops: createRealDaemonSwapOps({
        loadAtomicSwapModule: loadAtomicSwapModule as never,
      }),
    })
    await executor.onTradeCreated(await recordTradeCreated({
      tradeId: 'trade-fak',
      sellerPubkey: orderKey(secrets).publicKeyHex,
      buyerPubkey: `03${'59'.repeat(32)}`,
      sellerLocktime: '2099-05-21T00:02:00.000Z',
      buyerLocktime: '2099-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    }))
    const submittedState = await readState()
    assert.equal(
      submittedState?.proofOperations['trade-fak/seller-lock']?.state,
      'mint-submitted',
      submittedState?.swaps['trade-fak']?.error,
    )
    assert.equal(submittedState?.wallet.proofs.find(
      ({ proof }) => proof.secret === 'fak-retained',
    )?.reservedBy, 'trade-fak/seller-lock')
    await updateState({ walletProofs: 'all' }, (walletState) => {
      walletState.wallet.proofs.push(decoy)
    })
    const beforeRestart = await readState()
    assert.equal(beforeRestart?.wallet.proofs.find(
      ({ proof }) => proof.secret === 'fak-decoy',
    )?.state, 'available')

    CashuWallet.prototype.loadMint = async () => undefined
    CashuWallet.prototype.checkProofsStates = async () =>
      [{ state: CheckStateEnum.UNSPENT }] as ProofState[]
    const runner = createDaemonDurableTradeRecoveryRunner({
      executor,
      connection,
      recoverDurableSessions: ({ scheduleRetry, tradeId }) =>
        recoverDaemonDurableTradeSessions({
          executor,
          connection,
          scheduleRetry,
          ...(tradeId === undefined ? {} : { tradeId }),
          exactOperationAdapter: (record, action) =>
            recoverExactDaemonProofOperation(record, action, {
              loadAtomicSwapModule: loadAtomicSwapModule as never,
            }),
        }),
    })
    const recovery = await runner.recover()
    assert.equal(recovery.activeSwaps, 1)
    assert.equal(recoveryCalls, 1)
    const afterRestart = await readState()
    assert.equal(afterRestart?.swaps['trade-fak']?.step, 'seller-opened')
    assert.equal(afterRestart?.wallet.proofs.some(
      ({ proof }) => proof.secret === 'fak-retained',
    ), false)
    assert.equal(afterRestart?.wallet.proofs.find(
      ({ proof }) => proof.secret === 'fak-decoy',
    )?.state, 'available')
  } finally {
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    CashuWallet.prototype.loadMint = originalLoadMint
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('non-GTC buyer continuation consumes the recovered lock input and stores its successor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-buyer-resume-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-buyer-resume'] = {
      ...orderKey(secrets),
      orderId: 'order-buyer-resume',
      marketId: 'cond-NO',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex, {
      mintUrl: 'https://mint.example',
    })
    await writeProfile(profile)
    await writeSecrets(secrets)
    const input = {
      ...proofRecord(profile.mintUrl, 42, 'available', { kind: 'sats' }),
      proof: { ...cashuProof(42, 'buyer-resume-input'), id: 'buyer-keyset' },
    }
    const state = emptyDaemonState()
    state.orders['order-buyer-resume'] = {
      orderId: 'order-buyer-resume',
      marketId: 'cond-NO',
      status: 'filled',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      timeInForce: 'FAK',
      ...directBuyerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(input)
    await writeState(state)
    const store = new SqliteDurableCustodyStore()
    await store.registerScope(daemonWalletCustodyScope(secrets.walletSeedHex))
    lease = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: secrets.walletSeedHex,
    })
    uninstallCoordinator = installDaemonProofOperationCoordinator(
      new DaemonProofOperationCoordinator({
        authority: lease,
        resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
          keysetIds.map((keysetId) => [keysetId, {
            id: keysetId,
            unit: input.unit,
            active: true,
            input_fee_ppk: 0,
            keys: { '42': `02${'45'.repeat(32)}` },
          } as MintKeys]),
        ),
      }),
    )
    await recordTradeCreated({
      tradeId: 'trade-buyer-resume',
      sellerPubkey: `02${'60'.repeat(32)}`,
      buyerPubkey: orderKey(secrets).publicKeyHex,
      sellerLocktime: '2099-05-21T00:02:00.000Z',
      buyerLocktime: '2099-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })
    const operationId = 'trade-buyer-resume/buyer-lock'
    const link = createDurableTradeProofOperationLink({
      tradeId: 'trade-buyer-resume',
      role: 'buyer',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey: operationId,
      kind: 'cashu-atomic',
    })
    await prepareProofOperation({
      operationId,
      durableTradeRecovery: link,
      kind: 'swap-lock',
      mintUrl: profile.mintUrl,
      inputs: [input.proof],
      outputs: {
        send: [{
          blindedMessage: {
            amount: 42,
            id: 'buyer-keyset',
            B_: 'buyer-resume-output',
          },
          blindingFactor: '01',
          secret: 'buyer-resume-output-secret',
        }],
        keep: [],
      },
      metadata: {
        unit: input.unit,
        keysetId: 'buyer-keyset',
        reservationId: operationId,
        unselectedProofs: [],
      },
      walletProofReservation: { reservationId: operationId, unit: input.unit },
    })
    await markProofOperationMintSubmitted(operationId)
    await markProofOperationCompleted(operationId, {
      send: [{ ...input.proof, secret: 'buyer-resume-locked' }],
      keep: [],
    })
    await recordSwapMessage(
      'trade-buyer-resume',
      'adaptor-point',
      'buyer-resume-adaptor',
    )
    await recordSwapMessage(
      'trade-buyer-resume',
      'locked-proofs-seller',
      'buyer-resume-seller-lock',
    )
    await updateState({ walletProofs: 'all' }, (walletState) => {
      walletState.wallet.proofs.push({
        ...input,
        state: 'available',
        proof: { ...cashuProof(100, 'buyer-resume-decoy'), id: 'buyer-keyset' },
      })
    })

    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...buyerFakeOps(),
        async buyerRespond(_ctx, _messages, proofs) {
          assert.deepEqual(proofs.map(({ secret }) => secret), [
            'buyer-resume-input',
          ])
          return {
            lockedProofsCipher: 'buyer-resume-cipher',
            lockedProofs: [{ ...proofs[0]!, secret: 'buyer-resume-locked' }],
            changeProofs: [],
            preSigsHex: ['buyer-resume-pre'],
            sellerPreSigsHex: ['buyer-resume-seller-pre'],
          }
        },
      },
    })
    const recovery = await executor.resumeActiveSwaps(
      (await readState()) as DaemonState,
    )
    assert.equal(recovery.activeSwaps, 1)
    const after = await readState()
    assert.equal(after?.swaps['trade-buyer-resume']?.step, 'buyer-responded')
    assert.equal(after?.wallet.proofs.some(
      ({ proof }) => proof.secret === 'buyer-resume-input',
    ), false)
    assert.equal(after?.wallet.proofs.find(
      ({ proof }) => proof.secret === 'buyer-resume-locked',
    )?.reservedBy, 'trade-buyer-resume')
    assert.equal(after?.wallet.proofs.find(
      ({ proof }) => proof.secret === 'buyer-resume-decoy',
    )?.state, 'available')
  } finally {
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor locks oversized pinned inventory and releases unused collateral', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-preflight-overpay-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallCoordinator: (() => void) | undefined
  let uninstallOrderCollateral: (() => void) | undefined
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-preflight'] = {
      ...orderKey(secrets),
      orderId: 'order-preflight',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const clientOrderId = 'client-order-preflight-overpay'
    const reservationId = durableOrderCollateralPinId(clientOrderId)
    const state = emptyDaemonState()
    state.orders['order-preflight'] = {
      orderId: 'order-preflight',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      clientOrderId,
      timeInForce: 'GTC',
      ...mintSellerOrderEconomics(),
      preflightSplit: {
        reservationId,
        conditionId: 'cond',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: 100,
      },
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    const lockRow = {
        ...proofRecord(profile.mintUrl, 136, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'NO',
        }),
        proof: cashuProof(136, 'reserved-lock-no-136'),
      }
    const keepRow = {
        ...proofRecord(profile.mintUrl, 136, 'available', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        proof: cashuProof(136, 'reserved-keep-yes-136'),
      }
    state.wallet.proofs.push(lockRow, keepRow)
    await writeState(state)
    ;({ lease, uninstall: uninstallCoordinator } =
      await installCanonicalProofCoordinatorForTest(secrets, lockRow.unit))
    const orderCollateral = new DaemonOrderCollateralCoordinator(lease)
    uninstallOrderCollateral = installDaemonOrderCollateralCoordinator(
      orderCollateral,
    )
    const pin = await orderCollateral.prepare({
      clientOrderId,
      marketId: 'cond-YES',
      mintUrl: profile.mintUrl,
      unit: lockRow.unit,
      orderAmount: 100,
      requiredAmount: 100,
      submissionRequest: {
        clientOrderId,
        outcomeId: 'YES',
        tokenSide: 'Complement',
        side: 'Buy',
        price: 58,
        amountSubunits: 100,
        timeInForce: 'GTC',
      },
      preflightSplit: state.orders['order-preflight'].preflightSplit,
      proofs: [lockRow, keepRow],
    })
    await orderCollateral.bindOrObserve({
      pinId: pin.pinId,
      orderId: 'order-preflight',
      status: 'resting',
      remainingAmount: 100,
    })

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(ctx, proofs, amount, operationId) {
          assert.equal(proofs[0].secret, 'reserved-lock-no-136')
          assert.equal(amount, 100)
          assert.match(operationId, /seller-inventory-lock$/)
          const result = {
            lockedProofs: [
              { ...cashuProof(100, 'lock-locked-100'), id: 'keyset-136' },
            ],
            changeProofs: [
              { ...cashuProof(36, 'lock-change-36'), id: 'keyset-136' },
            ],
          }
          await recordReconciledProofOperationForTest({
            tradeId: ctx.tradeId,
            operationId,
            mintUrl: profile.mintUrl,
            unit: lockRow.unit,
            sourceProofs: proofs,
            resultProofs: {
              send: result.lockedProofs,
              keep: result.changeProofs,
            },
            parentOrderCollateralPinId: pin.pinId,
          })
          return result
        },
        async sellerOpenPrelocked(_ctx, proofs) {
          assert.equal(proofs[0].secret, 'lock-locked-100')
          return {
            adaptorPointCipher: 'cipher-adaptor',
            lockedProofsCipher: 'cipher-seller',
            adaptorSecretHex: 'aa',
            adaptorPointHex: 'bb',
            lockedProofs: proofs,
            changeProofs: [],
          }
        },
      },
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-preflight-overpay',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'56'.repeat(32)}`,
        sellerLocktime: '2027-01-15T00:02:00.000Z',
        buyerLocktime: '2027-01-15T00:01:00.000Z',
        marketId: 'cond-YES',
        fillAmountSubunits: 100,
        outcomeFaceAmountSubunits: 100,
        quotePaymentSubunits: 42,
        settlementKind: 'Mint',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
      }),
    )

    const persisted = await readState()
    assert.equal(
      persisted?.swaps['trade-preflight-overpay'].step,
      'seller-opened',
      persisted?.swaps['trade-preflight-overpay'].error,
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'reserved-lock-no-136',
      )?.state,
      undefined,
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'lock-locked-100',
      )?.state,
      'locked',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'lock-change-36',
      )?.state,
      'available',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'reserved-keep-yes-136',
      )?.state,
      'available',
    )
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) => row.proof.secret === 'keep-exact-100',
      ),
      false,
    )
    assert.deepEqual(sent, [
      'trade-preflight-overpay:adaptor-point:cipher-adaptor',
      'trade-preflight-overpay:locked-proofs-seller:cipher-seller',
    ])
  } finally {
    uninstallOrderCollateral?.()
    uninstallCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor resends persisted seller opening messages after restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-resend-seller-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    const session = durableSessionForTest('trade-resume-seller', 'seller')
    state.swaps['trade-resume-seller'] = {
      tradeId: 'trade-resume-seller',
      marketId: 'cond-YES',
      orderId: 'order-resume-seller',
      role: 'seller',
      counterpartyPubkey: session.counterpartyProtocolPubkey,
      sellerLocktime: session.sellerLocktimeSecs,
      buyerLocktime: session.buyerLocktimeSecs,
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      messages: {
        adaptorPoint: 'persisted-adaptor',
        lockedProofsSeller: 'persisted-seller',
      },
      step: 'seller-opened',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:30.000Z',
    }
    state.durableTradeSessions['trade-resume-seller'] = session
    await writeProfile(durableSessionProfile(session))
    await writeStateWithSessionKeys(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
    })

    await executor.onTradeCreated(state.swaps['trade-resume-seller'])

    assert.deepEqual(sent, [
      'trade-resume-seller:adaptor-point:persisted-adaptor',
      'trade-resume-seller:locked-proofs-seller:persisted-seller',
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor resends persisted buyer response and completion after restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-resend-buyer-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    const session = durableSessionForTest('trade-resume-buyer', 'buyer')
    state.swaps['trade-resume-buyer'] = {
      tradeId: 'trade-resume-buyer',
      marketId: 'cond-NO',
      orderId: 'order-resume-buyer',
      role: 'buyer',
      counterpartyPubkey: session.counterpartyProtocolPubkey,
      sellerLocktime: session.sellerLocktimeSecs,
      buyerLocktime: session.buyerLocktimeSecs,
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      messages: {
        adaptorPoint: 'persisted-adaptor',
        lockedProofsSeller: 'persisted-seller',
        lockedProofsBuyer: 'persisted-buyer',
      },
      step: 'awaiting-confirmation',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:30.000Z',
    }
    state.durableTradeSessions['trade-resume-buyer'] = session
    await writeProfile(durableSessionProfile(session))
    await writeStateWithSessionKeys(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
    })

    await executor.onTradeCreated(state.swaps['trade-resume-buyer'])

    assert.deepEqual(sent, [
      'trade-resume-buyer:locked-proofs-buyer:persisted-buyer',
      'trade-resume-buyer:settlement-complete:',
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor rejects mismatched resend authority before journal or transport', async () => {
  const corruptions = [
    {
      name: 'role',
      sessionRole: 'buyer' as const,
      mutate(swap: DaemonState['swaps'][string]) {
        swap.role = 'seller'
      },
    },
    {
      name: 'counterparty',
      sessionRole: 'seller' as const,
      mutate(swap: DaemonState['swaps'][string]) {
        swap.counterpartyPubkey = `03${'44'.repeat(32)}`
      },
    },
    {
      name: 'seller-locktime',
      sessionRole: 'seller' as const,
      mutate(swap: DaemonState['swaps'][string]) {
        swap.sellerLocktime = (swap.sellerLocktime ?? 0) + 1
      },
    },
    {
      name: 'buyer-locktime',
      sessionRole: 'seller' as const,
      mutate(swap: DaemonState['swaps'][string]) {
        swap.buyerLocktime = (swap.buyerLocktime ?? 0) + 1
      },
    },
  ]

  for (const corruption of corruptions) {
    const home = await mkdtemp(
      join(tmpdir(), `bitcaster-daemon-resend-authority-${corruption.name}-`),
    )
    const previousHome = process.env.BITCASTER_DAEMON_HOME
    process.env.BITCASTER_DAEMON_HOME = home
    try {
      const tradeId = `trade-resend-authority-${corruption.name}`
      const session = durableSessionForTest(tradeId, corruption.sessionRole)
      const state = emptyDaemonState()
      state.swaps[tradeId] = {
        tradeId,
        marketId: 'cond-YES',
        orderId: `order-resend-authority-${corruption.name}`,
        role: session.role,
        counterpartyPubkey: session.counterpartyProtocolPubkey,
        sellerLocktime: session.sellerLocktimeSecs,
        buyerLocktime: session.buyerLocktimeSecs,
        messages: {
          adaptorPoint: 'persisted-adaptor',
          lockedProofsSeller: 'persisted-seller',
        },
        step: 'seller-opened',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:30.000Z',
      }
      corruption.mutate(state.swaps[tradeId]!)
      state.durableTradeSessions[tradeId] = session
      await writeProfile(durableSessionProfile(session))
      await writeStateWithSessionKeys(state)

      const sent: string[] = []
      const executor = newTestDaemonSwapExecutor({
        connection: fakeConnection(sent),
      })

      await executor.onTradeCreated(state.swaps[tradeId]!)

      assert.equal(sent.length, 0, corruption.name)
      const persisted = await readState()
      assert.equal(
        Object.keys(
          persisted?.durableTradeSessions[tradeId]?.outboundCiphers ?? {},
        ).length,
        0,
        corruption.name,
      )
    } finally {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('DaemonSwapExecutor fails closed before recovery or send when its durable session is missing or corrupt', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-missing-durable-session-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    for (const sessionKind of ['missing', 'corrupt'] as const) {
      const state = emptyDaemonState()
      state.swaps['trade-no-session'] = {
        tradeId: 'trade-no-session',
        marketId: 'cond-YES',
        orderId: 'order-no-session',
        role: 'seller',
        messages: {
          adaptorPoint: 'persisted-adaptor',
          lockedProofsSeller: 'persisted-seller',
        },
        step: 'seller-opened',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      }
      if (sessionKind === 'corrupt') {
        state.durableTradeSessions['trade-no-session'] = {
          ...durableSessionForTest('trade-no-session', 'seller'),
        }
      }
      await writeStateWithSessionKeys(state)
      if (sessionKind === 'corrupt') {
        const database = new DatabaseSync(statePath())
        try {
          database.exec('PRAGMA ignore_check_constraints = ON')
          database
            .prepare(
              `UPDATE daemon_trade_sessions SET schema_version = 1
             WHERE trade_id = ?`,
            )
            .run('trade-no-session')
        } finally {
          database.close()
        }
        await assert.rejects(
          () => readState(),
          /durable trade session is invalid/,
        )
        continue
      }
      const sent: string[] = []
      const executor = newTestDaemonSwapExecutor({
        connection: fakeConnection(sent),
        ops: fakeOps(),
      })

      assert.deepEqual(await executor.resumeActiveSwaps(state), {
        activeSwaps: 0,
      })
      await executor.onTradeCreated(state.swaps['trade-no-session']!)
      assert.deepEqual(sent, [])
    }
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor retains a live session when its named key is substituted', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-substituted-key-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-bound-key'] = {
      ...orderKey(secrets),
      orderId: 'order-bound-key',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-bound-key'] = {
      orderId: 'order-bound-key',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey:
        secrets.orderEphemeralKeys['order-bound-key'].publicKeyHex,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)
    const created = await recordTradeCreated({
      tradeId: 'trade-bound-key',
      sellerPubkey: secrets.orderEphemeralKeys['order-bound-key'].publicKeyHex,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })
    assert.equal(created?.step, 'opened')

    const substituted = generateOrderEphemeralKeypair()
    secrets.orderEphemeralKeys['order-bound-key'] = {
      orderId: 'order-bound-key',
      marketId: 'cond-YES',
      ...substituted,
      createdAt: '2026-05-21T00:00:01.000Z',
    }
    const substitutedDatabase = new DatabaseSync(statePath())
    try {
      substitutedDatabase
        .prepare(
          `UPDATE daemon_order_ephemeral_keys
            SET private_key_hex = ?, public_key_hex = ?, created_at = ?
          WHERE key_id = ?`,
        )
        .run(
          substituted.privateKeyHex,
          substituted.publicKeyHex,
          '2026-05-21T00:00:01.000Z',
          'order-bound-key',
        )
    } finally {
      substitutedDatabase.close()
    }
    let custodyCalls = 0
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs() {
          custodyCalls += 1
          throw new Error(
            'substituted key must fail before this custody effect',
          )
        },
      },
    })

    await executor.onTradeCreated(created)
    assert.equal(custodyCalls, 0)
    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-bound-key']?.step, 'opened')
    assert.equal(persisted?.swaps['trade-bound-key']?.error, undefined)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor resolves only the durable session named key handle', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-exact-key-handle-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-exact-key'] = {
      ...orderKey(secrets),
      orderId: 'order-exact-key',
    }
    const expectedPublicKey =
      secrets.orderEphemeralKeys['order-exact-key'].publicKeyHex
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-exact-key'] = {
      orderId: 'order-exact-key',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: expectedPublicKey,
      ...directSellerOrderEconomics(),
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)
    const created = await recordTradeCreated({
      tradeId: 'trade-exact-key',
      sellerPubkey: expectedPublicKey,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })
    const competing = generateOrderEphemeralKeypair()
    secrets.orderEphemeralKeys['trade-exact-key'] = {
      orderId: 'order-exact-key',
      tradeId: 'trade-exact-key',
      marketId: 'cond-YES',
      ...competing,
      createdAt: '2026-05-21T00:00:01.000Z',
    }
    await writeSecrets(secrets)
    let selectedPublicKey: string | undefined
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(ctx, proofs, amount, operationId) {
          selectedPublicKey = ctx.ephemeralKey.publicKey
          return fakeOps().sellerLockOutcomeProofs(
            ctx,
            proofs,
            amount,
            operationId,
          )
        },
      },
    })

    await executor.onTradeCreated(created)
    assert.equal(selectedPublicKey, expectedPublicKey)
    assert.equal(
      (await readState())?.swaps['trade-exact-key']?.step,
      'seller-opened',
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function orderKey(
  secrets: DaemonSecrets,
): DaemonSecrets['orderEphemeralKeys'][string] {
  return {
    orderId: 'order-1',
    marketId: 'cond-YES',
    privateKeyHex: '11'.repeat(32),
    publicKeyHex:
      '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
    createdAt: secrets.createdAt,
  }
}

function directSellerOrderEconomics() {
  return {
    side: 'Sell' as const,
    tokenSide: 'Outcome' as const,
    priceSubunits: 42,
    amountSubunits: 100,
  }
}

function directBuyerOrderEconomics() {
  return {
    side: 'Buy' as const,
    tokenSide: 'Outcome' as const,
    priceSubunits: 42,
    amountSubunits: 100,
  }
}

function mintSellerOrderEconomics() {
  return {
    side: 'Buy' as const,
    tokenSide: 'Complement' as const,
    priceSubunits: 58,
    amountSubunits: 100,
  }
}

function fakeConnection(sent: string[]): TradeRuntimeConnection {
  return {
    async start() {},
    async stop() {},
    async joinOrder() {},
    async joinTrade() {
      return { success: true }
    },
    async sendSwapMessage(tradeId, messageType, ciphertext) {
      sent.push(`${tradeId}:${messageType}:${ciphertext}`)
    },
  }
}

function throwingSendConnection(): TradeRuntimeConnection {
  return {
    async start() {},
    async stop() {},
    async joinOrder() {},
    async joinTrade() {
      return { success: true }
    },
    async sendSwapMessage() {
      throw new Error('hub send unavailable')
    },
  }
}

function fakeOps(): DaemonSwapOps {
  return {
    async sellerOpen() {
      throw new Error('raw seller open path unused in this test')
    },
    async sellerOpenPrelocked(_ctx, proofs) {
      assert.equal(proofs[0].secret, 'direct-lock-100')
      return {
        adaptorPointCipher: 'cipher-adaptor',
        lockedProofsCipher: 'cipher-seller',
        adaptorSecretHex: 'aa',
        adaptorPointHex: 'bb',
        lockedProofs: [cashuProof(100, 'seller-locked')],
        changeProofs: [],
      }
    },
    async sellerLockOutcomeProofs(_ctx, proofs, amount, operationId) {
      assert.equal(proofs[0].secret, 'secret-100')
      assert.equal(amount, 100)
      assert.match(operationId, /seller-lock$/)
      return {
        lockedProofs: [cashuProof(100, 'direct-lock-100')],
        changeProofs: [],
      }
    },
    async buyerRespond() {
      throw new Error('buyer path unused in this test')
    },
    async sellerOpenMint() {
      throw new Error('mint path unused in this test')
    },
    async sellerClaim() {
      return [cashuProof(42, 'seller-claim')]
    },
    async buyerClaim() {
      throw new Error('buyer path unused in this test')
    },
    async refundLockedProofs() {
      throw new Error('refund path unused in this test')
    },
  }
}

function buyerFakeOps(): DaemonSwapOps {
  return {
    async sellerOpen() {
      throw new Error('seller path unused in this test')
    },
    async sellerOpenPrelocked() {
      throw new Error('prelocked seller path unused in this test')
    },
    async sellerLockOutcomeProofs() {
      throw new Error('outcome lock path unused in this test')
    },
    async buyerRespond() {
      return {
        lockedProofsCipher: 'cipher-buyer',
        lockedProofs: [cashuProof(42, 'buyer-locked')],
        changeProofs: [],
        preSigsHex: ['pre-b'],
        sellerPreSigsHex: ['pre-s'],
      }
    },
    async sellerOpenMint() {
      throw new Error('mint path unused in this test')
    },
    async sellerClaim() {
      throw new Error('seller path unused in this test')
    },
    async buyerClaim() {
      return [cashuProof(100, 'buyer-claim')]
    },
    async refundLockedProofs() {
      throw new Error('refund path unused in this test')
    },
  }
}

function mintFakeOps(): DaemonSwapOps {
  return {
    async sellerOpen() {
      throw new Error('direct seller path unused in this test')
    },
    async sellerOpenPrelocked() {
      throw new Error('prelocked seller path unused in this test')
    },
    async sellerLockOutcomeProofs() {
      throw new Error('outcome lock path unused in this test')
    },
    async sellerOpenMint(_ctx, params, collateralProofs) {
      assert.deepEqual(params, {
        conditionId: 'cond',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: 100,
      })
      assert.equal(collateralProofs[0].secret, 'secret-100')
      return {
        adaptorPointCipher: 'cipher-adaptor',
        lockedProofsCipher: 'cipher-seller',
        adaptorSecretHex: 'aa',
        adaptorPointHex: 'bb',
        lockedProofs: [cashuProof(100, 'lock-proof')],
        changeProofs: [],
        spentSatProofs: collateralProofs,
        keepProofs: [cashuProof(100, 'keep-proof')],
        proofsByCollection: {
          YES: [cashuProof(100, 'keep-proof')],
          NO: [cashuProof(100, 'lock-proof')],
        },
        lockCollections: ['NO'],
        keepCollections: ['YES'],
        resolvedKeepOutcomeSetId: 'YES',
        resolvedLockOutcomeSetId: 'NO',
      }
    },
    async buyerRespond() {
      throw new Error('buyer path unused in this test')
    },
    async sellerClaim() {
      return [cashuProof(42, 'seller-claim')]
    },
    async buyerClaim() {
      throw new Error('buyer path unused in this test')
    },
    async refundLockedProofs() {
      throw new Error('refund path unused in this test')
    },
  }
}

function proofRecord(
  mintUrl: string,
  amount: number,
  state: DaemonState['wallet']['proofs'][number]['state'],
  asset: DaemonState['wallet']['proofs'][number]['asset'],
): DaemonState['wallet']['proofs'][number] {
  const baseAsset = asset.baseAsset ?? 'sat'
  return {
    mintUrl,
    unit: baseAsset === 'usd' ? 'usd' : 'msat',
    state,
    asset: { ...asset, baseAsset },
    proof: cashuProof(amount, `secret-${amount}`),
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}

function cashuProof(amount: number, secret: string): CashuProofRecord {
  return {
    id: `keyset-${amount}`,
    amount,
    secret,
    C: `c-${secret}`,
  }
}

const TEST_SESSION_PRIVATE_KEY = '11'.repeat(32)
const TEST_SESSION_PUBLIC_KEY =
  '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'

async function writeStateWithSessionKeys(state: DaemonState): Promise<void> {
  const secrets =
    (await readSecrets()) ?? createDaemonSecrets('2026-05-21T00:00:00.000Z')
  for (const session of Object.values(state.durableTradeSessions)) {
    if (session.localProtocolPubkey !== TEST_SESSION_PUBLIC_KEY) {
      throw new Error('test durable session does not use the retained test key')
    }
    const swap = state.swaps[session.tradeId]
    if (!swap?.orderId || !swap.marketId) {
      throw new Error('test durable session requires its swap order and market')
    }
    secrets.orderEphemeralKeys[session.ephemeralKeyHandle.keyId] = {
      orderId: swap.orderId,
      tradeId: session.tradeId,
      marketId: swap.marketId,
      privateKeyHex: TEST_SESSION_PRIVATE_KEY,
      publicKeyHex: TEST_SESSION_PUBLIC_KEY,
      createdAt: '2026-05-21T00:00:00.000Z',
    }
  }
  await writeSecrets(secrets)
  await writeState(state)
}

function stateWithLiveSwapAndDurableLink(linkState: string): DaemonState {
  const state = emptyDaemonState()
  const tradeId = 'trade-live'
  const operationKey = `${tradeId}/seller-lock`
  const operation = {
    ...createDurableTradeProofOperationLink({
      tradeId,
      role: 'seller',
      stage: 'proof-reservation',
      state: 'prepared',
      operationKey,
      kind: 'cashu-atomic',
    }),
    state: linkState,
  }
  state.swaps[tradeId] = {
    tradeId,
    orderId: 'order-live',
    marketId: 'cond-YES',
    role: 'seller',
    messages: {},
    step: 'seller-opened',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
  state.proofOperations[operationKey] = {
    operationId: operationKey,
    durableTradeRecovery: operation as DurableTradeProofOperationLink,
    kind: 'swap-lock',
    state: 'mint-submitted',
    mintUrl: 'https://mint.example',
    inputs: [],
    outputs: {},
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
  const session = durableSessionForTest(tradeId, 'seller')
  session.proofOperations = [operation as DurableTradeProofOperationLink]
  session.stage =
    linkState === 'reconciled'
    ? 'reconciliation-complete'
    : linkState === 'mint-submitted'
      ? 'mint-submitted'
      : 'proof-reserved'
  state.durableTradeSessions[tradeId] = session
  return state
}

function durableSessionForTest(
  tradeId: string,
  role: 'seller' | 'buyer',
  overrides: Partial<{
    keyId: string
    localProtocolPubkey: string
    counterpartyProtocolPubkey: string
    mintUrl: string
    sellerLocktimeSecs: number
    buyerLocktimeSecs: number
  }> = {},
): DaemonState['durableTradeSessions'][string] {
  const localProtocolPubkey =
    overrides.localProtocolPubkey ?? TEST_SESSION_PUBLIC_KEY
  const counterpartyProtocolPubkey =
    overrides.counterpartyProtocolPubkey ??
    (role === 'seller' ? `02${'77'.repeat(32)}` : `03${'66'.repeat(32)}`)
  const mintUrl = overrides.mintUrl ?? 'https://mint.example'
  const sellerLocktimeSecs = overrides.sellerLocktimeSecs ?? 1_779_321_720
  const buyerLocktimeSecs = overrides.buyerLocktimeSecs ?? 1_779_321_660
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId,
    role,
    localProtocolPubkey,
    counterpartyProtocolPubkey,
    mintUrl,
    sellerLocktimeSecs,
    buyerLocktimeSecs,
    ephemeralKeyHandle: {
      keyId: overrides.keyId ?? tradeId,
      tradeId,
      role,
      localProtocolPubkey,
      counterpartyProtocolPubkey,
      mintUrl,
      sellerLocktimeSecs,
      buyerLocktimeSecs,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}

function durableSessionProfile(
  session: DaemonState['durableTradeSessions'][string],
) {
  return {
    engineBaseUrl: 'https://engine.example',
    mintUrl: session.mintUrl,
    initializedAt: '2026-05-21T00:00:00.000Z',
  }
}

function newTestDaemonSwapExecutor(
  options: DaemonSwapExecutorOptions,
): DaemonSwapExecutor {
  return new DaemonSwapExecutor({
    ...options,
    walletOpsDeps: {
      resolveInputFeePpkByKeyset: async (_mintUrl, keysetIds) =>
        Object.fromEntries(keysetIds.map((keysetId) => [keysetId, 0])),
      ...options.walletOpsDeps,
    },
  })
}

async function installCanonicalProofCoordinatorForTest(
  secrets: DaemonSecrets,
  unit: string,
): Promise<{
  lease: DaemonDurableCustodyLease
  uninstall: () => void
}> {
  const store = new SqliteDurableCustodyStore()
  await store.registerScope(daemonWalletCustodyScope(secrets.walletSeedHex))
  const lease = await DaemonDurableCustodyLease.claim({
    store,
    walletSeedHex: secrets.walletSeedHex,
  })
  const uninstall = installDaemonProofOperationCoordinator(
    new DaemonProofOperationCoordinator({
      authority: lease,
      resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
        keysetIds.map((keysetId) => [keysetId, {
          id: keysetId,
          unit,
          active: true,
          input_fee_ppk: 0,
          keys: { '100': `02${'44'.repeat(32)}` },
        } as MintKeys]),
      ),
    }),
  )
  return { lease, uninstall }
}

async function recordReconciledSwapLockForTest(input: {
  tradeId: string
  operationId: string
  source: DaemonState['wallet']['proofs'][number]
  lockedProofs: CashuProofRecord[]
}): Promise<void> {
  await recordReconciledProofOperationForTest({
    tradeId: input.tradeId,
    operationId: input.operationId,
    kind: 'swap-lock',
    mintUrl: input.source.mintUrl,
    unit: input.source.unit,
    sourceProofs: [input.source.proof],
    resultProofs: { send: input.lockedProofs, keep: [] },
  })
}

async function recordReconciledProofOperationForTest(input: {
  tradeId: string
  operationId: string
  mintUrl: string
  unit: DaemonState['wallet']['proofs'][number]['unit']
  sourceProofs: CashuProofRecord[]
  resultProofs: Record<string, CashuProofRecord[]>
  parentOrderCollateralPinId?: string
}): Promise<void> {
  const link = createDurableTradeProofOperationLink({
    tradeId: input.tradeId,
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: input.operationId,
    kind: 'cashu-atomic',
  })
  await prepareProofOperation({
    operationId: input.operationId,
    durableTradeRecovery: link,
    kind: 'swap-lock',
    mintUrl: input.mintUrl,
    inputs: input.sourceProofs,
    outputs: Object.fromEntries(
      Object.entries(input.resultProofs).map(([label, proofs]) => [
        label,
        proofs.map((proof, index) => ({
        blindedMessage: {
          amount: proof.amount,
          id: proof.id as string,
              B_: `${input.operationId}:${label}:${index}`,
        },
        blindingFactor: `${index + 1}`.padStart(64, '0'),
        secret: `${index + 2}`.padStart(64, '0'),
        })),
      ]),
    ),
    metadata: {
      reservationId: input.operationId,
      unit: input.unit,
      unselectedProofs: [],
    },
    walletProofReservation: {
      reservationId: input.operationId,
      unit: input.unit,
      ...(input.parentOrderCollateralPinId === undefined
        ? {}
        : { parentOrderCollateralPinId: input.parentOrderCollateralPinId }),
    },
  })
  await markProofOperationMintSubmitted(input.operationId)
  await markProofOperationCompleted(input.operationId, input.resultProofs)
}
