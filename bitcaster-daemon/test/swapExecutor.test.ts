import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { profileFromPublicKey, writeProfile } from '../src/profile.ts'
import {
  createDaemonSecrets,
  writeSecrets,
  type DaemonSecrets,
} from '../src/secrets.ts'
import {
  emptyDaemonState,
  readState,
  recordSwapMessage,
  recordTradeCreated,
  recordTradeStateChanged,
  writeState,
  type CashuProofRecord,
  type DaemonState,
} from '../src/state.ts'
import {
  DaemonSwapExecutor,
  type DaemonSwapExecutorOptions,
  type DaemonSwapOps,
} from '../src/swapExecutor.ts'
import type { TradeRuntimeConnection } from '../src/tradeRuntime.ts'

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
        (row) => row.asset.kind === 'sats' && row.proof.secret === 'seller-claim',
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

test('Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-lock-'))
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
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'partial-locked')
        ?.state,
      'locked',
    )
    assert.deepEqual(sent, [])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('Block2_PartialLockHeld_DaemonRecoverySweepFires', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-refund-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
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
      sellerLocktime: 1,
      buyerLocktime: 1,
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

    await executor.resumeActiveSwaps(await readState() as DaemonState)

    const persisted = await readState()
    assert.deepEqual(refunded, [
      'trade-partial-refund:partial-lock-refund:partial-locked',
    ])
    assert.equal(persisted?.swaps['trade-partial-refund'].step, 'refunded')
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'partial-locked'),
      false,
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'partial-refunded')
        ?.state,
      'available',
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
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
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
      sellerLocktime: 1,
      buyerLocktime: 1,
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
    state.wallet.proofs.push(
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

    await executor.resumeActiveSwaps(await readState() as DaemonState)

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
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('Block2_PartialLockHeld_AlreadySpentReconcilesAsRefunded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-partial-spent-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-1'] = orderKey(secrets)
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
      sellerLocktime: 1,
      buyerLocktime: 1,
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
    state.wallet.proofs.push({
      ...proofRecord(profile.mintUrl, 100, 'locked', {
        kind: 'Outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
      reservedBy: 'trade-partial-spent',
      proof: cashuProof(100, 'partial-spent'),
    })
    await writeState(state)

    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection([]),
      ops: {
        ...fakeOps(),
        async refundLockedProofs() {
          throw new Error('proof already spent')
        },
      },
    })

    await executor.resumeActiveSwaps(await readState() as DaemonState)

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-partial-spent'].step, 'refunded')
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'partial-spent'),
      false,
    )
  } finally {
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
          throw new Error('Proof operation trade-pending/seller-lock is still pending at the mint')
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

test('DaemonSwapExecutor retries mint-pending seller open without another event', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-proof-pending-retry-'))
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
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      retryDelayMs: 5,
      maxRetryAttempts: 3,
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(ctx, proofs, amount, operationId) {
          lockAttempts += 1
          if (lockAttempts === 1) {
            throw new Error('Proof operation trade-retry/seller-lock is still pending at the mint')
          }
          return fakeOps().sellerLockOutcomeProofs(ctx, proofs, amount, operationId)
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

    const persisted = await waitForSwapStep('trade-retry', 'seller-opened')
    for (let attempt = 0; attempt < 20 && sent.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(lockAttempts, 2)
    assert.equal(persisted?.swaps['trade-retry'].sellerAdaptorSecretHex, 'aa')
    assert.deepEqual(sent, [
      'trade-retry:adaptor-point:cipher-adaptor',
      'trade-retry:locked-proofs-seller:cipher-seller',
    ])
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
      publicKeyHex: `03${'33'.repeat(32)}`,
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['order-2'] = {
      orderId: 'order-2',
      marketId: 'cond-NO',
      status: 'resting',
      ephemeralPubkey: `03${'33'.repeat(32)}`,
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
        buyerPubkey: `03${'33'.repeat(32)}`,
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
      await recordSwapMessage('trade-2', 'locked-proofs-seller', 'cipher-seller'),
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
      publicKeyHex: `03${'99'.repeat(32)}`,
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

    await executor.resumeActiveSwaps(await readState() as DaemonState)

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
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-swap-complement-'))
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

test('DaemonSwapExecutor uses reserved pre-flight proofs for mint seller open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-preflight-mint-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-preflight'] = {
      ...orderKey(secrets),
      orderId: 'order-preflight',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const reservationId = `order-preflight:${orderKey(secrets).publicKeyHex}`
    const state = emptyDaemonState()
    state.orders['order-preflight'] = {
      orderId: 'order-preflight',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
      ...mintSellerOrderEconomics(),
      preflightSplit: {
        reservationId,
        conditionId: 'cond',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: 200,
      },
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      {
        ...proofRecord(profile.mintUrl, 100, 'reserved', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'NO',
        }),
        reservedBy: reservationId,
        proof: cashuProof(100, 'reserved-lock-no'),
      },
      {
        ...proofRecord(profile.mintUrl, 100, 'reserved', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        reservedBy: reservationId,
        proof: cashuProof(100, 'reserved-keep-yes'),
      },
    )
    await writeState(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(_ctx, proofs, amount, operationId) {
          assert.equal(proofs[0].secret, 'reserved-lock-no')
          assert.equal(amount, 100)
          assert.match(operationId, /seller-preflight-lock$/)
          return {
            lockedProofs: [cashuProof(100, 'lock-locked-100')],
            changeProofs: [],
          }
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
    assert.equal(persisted?.swaps['trade-preflight'].step, 'seller-opened')
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
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('DaemonSwapExecutor uses primitive local inventory before pre-flight for composite mint seller open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-primitive-before-preflight-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-preflight'] = {
      ...orderKey(secrets),
      orderId: 'order-preflight',
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
        async splitProofsForExactSend() {
          throw new Error('pre-flight split proof path must not run when primitive inventory is available')
        },
        async sellerOpenPrelocked(_ctx, proofs) {
          assert.deepEqual(
            proofs.map((proof) => proof.secret).sort(),
            ['locked-primitive-b', 'locked-primitive-c'],
          )
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
      'trade-primitive-before-preflight:seller-inventory-lock:B:primitive-b',
      'trade-primitive-before-preflight:seller-inventory-lock:C:primitive-c',
    ])
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'reserved-composite')?.state,
      'reserved',
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'locked-primitive-b')?.asset.kind,
      'Outcome',
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'locked-primitive-b')?.asset
        .outcomeSetId,
      'B',
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'locked-primitive-c')?.asset
        .outcomeSetId,
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

test('DaemonSwapExecutor splits oversized reserved pre-flight proofs before seller open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-preflight-overpay-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['order-preflight'] = {
      ...orderKey(secrets),
      orderId: 'order-preflight',
    }
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    await writeSecrets(secrets)
    const reservationId = `order-preflight:${orderKey(secrets).publicKeyHex}`
    const state = emptyDaemonState()
    state.orders['order-preflight'] = {
      orderId: 'order-preflight',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: orderKey(secrets).publicKeyHex,
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
    state.wallet.proofs.push(
      {
        ...proofRecord(profile.mintUrl, 136, 'reserved', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'NO',
        }),
        reservedBy: reservationId,
        proof: cashuProof(136, 'reserved-lock-no-136'),
      },
      {
        ...proofRecord(profile.mintUrl, 136, 'reserved', {
          kind: 'Outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        reservedBy: reservationId,
        proof: cashuProof(136, 'reserved-keep-yes-136'),
      },
    )
    await writeState(state)

    const sent: string[] = []
    const executor = newTestDaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(_ctx, proofs, amount, operationId) {
          assert.equal(proofs[0].secret, 'reserved-lock-no-136')
          assert.equal(amount, 100)
          assert.match(operationId, /seller-preflight-lock$/)
          return {
            lockedProofs: [cashuProof(100, 'lock-locked-100')],
            changeProofs: [
              { ...cashuProof(36, 'lock-change-36'), id: 'keyset-136' },
            ],
          }
        },
        async splitProofsForExactSend(params) {
          assert.equal(params.amountSats, 100)
          assert.equal(params.preserveSourceKeyset, true)
          assert.match(
            params.operationId,
            /seller-preflight-(lock|keep)-exact-v2\/(NO|YES)$/,
          )
          const prefix = params.operationId.includes('seller-preflight-lock')
            ? 'lock'
            : 'keep'
          return {
            sendProofs: [cashuProof(100, `${prefix}-exact-100`)],
            changeProofs: [
              { ...cashuProof(36, `${prefix}-change-36`), id: 'keyset-136' },
            ],
            spentProofs: params.sourceProofs,
          }
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
      'reserved',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'keep-exact-100',
      )?.state,
      'available',
    )
    assert.equal(
      persisted?.wallet.proofs.find(
        (row) => row.proof.secret === 'keep-change-36',
      )?.state,
      'reserved',
    )
    assert.deepEqual(sent, [
      'trade-preflight-overpay:adaptor-point:cipher-adaptor',
      'trade-preflight-overpay:locked-proofs-seller:cipher-seller',
    ])
  } finally {
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
    state.swaps['trade-resume-seller'] = {
      tradeId: 'trade-resume-seller',
      marketId: 'cond-YES',
      orderId: 'order-resume-seller',
      role: 'seller',
      counterpartyPubkey: `03${'66'.repeat(32)}`,
      sellerLocktime: Date.parse('2026-05-21T00:02:00.000Z'),
      buyerLocktime: Date.parse('2026-05-21T00:01:00.000Z'),
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
    await writeState(state)

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
    state.swaps['trade-resume-buyer'] = {
      tradeId: 'trade-resume-buyer',
      marketId: 'cond-NO',
      orderId: 'order-resume-buyer',
      role: 'buyer',
      counterpartyPubkey: `02${'77'.repeat(32)}`,
      sellerLocktime: Date.parse('2026-05-21T00:02:00.000Z'),
      buyerLocktime: Date.parse('2026-05-21T00:01:00.000Z'),
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
    await writeState(state)

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

function orderKey(secrets: DaemonSecrets): DaemonSecrets['orderEphemeralKeys'][string] {
  return {
    orderId: 'order-1',
    marketId: 'cond-YES',
    privateKeyHex: '11'.repeat(32),
    publicKeyHex: `02${'11'.repeat(32)}`,
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

async function waitForSwapStep(
  tradeId: string,
  step: string,
): Promise<DaemonState | null> {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    const state = await readState()
    if (state?.swaps[tradeId]?.step === step) return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readState()
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
    async splitProofsForExactSend() {
      throw new Error('proof split path unused in this test')
    },
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
    async splitProofsForExactSend() {
      throw new Error('proof split path unused in this test')
    },
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
    async splitProofsForExactSend() {
      throw new Error('proof split path unused in this test')
    },
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
  return {
    mintUrl,
    state,
    asset,
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
