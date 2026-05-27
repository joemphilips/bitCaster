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
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = new DaemonSwapExecutor({
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
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
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
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = new DaemonSwapExecutor({
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
        settlementKind: 'DirectSwap',
      }),
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-partial-lock'].step, 'failed')
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
      ['A'],
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
      step: 'failed',
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
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
      reservedBy: 'trade-partial-refund',
      proof: cashuProof(100, 'partial-locked'),
    })
    await writeState(state)

    const refunded: string[] = []
    const executor = new DaemonSwapExecutor({
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
      step: 'failed',
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
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'A',
      }),
      reservedBy: 'trade-partial-spent',
      proof: cashuProof(100, 'partial-spent'),
    })
    await writeState(state)

    const executor = new DaemonSwapExecutor({
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
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    const executor = new DaemonSwapExecutor({
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
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
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', {
        kind: 'outcome',
        conditionId: 'cond',
        outcomeSetId: 'YES',
      }),
    )
    await writeState(state)

    const executor = new DaemonSwapExecutor({
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
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
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 42, 'available', { kind: 'sats' }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = new DaemonSwapExecutor({
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
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
          row.asset.kind === 'outcome' &&
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
    const executor = new DaemonSwapExecutor({
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
          row.asset.kind === 'outcome' &&
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

test('DaemonSwapExecutor drives complementary seller split before opening swap', async () => {
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
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.wallet.proofs.push(
      proofRecord(profile.mintUrl, 100, 'available', { kind: 'sats' }),
    )
    await writeState(state)

    const sent: string[] = []
    const executor = new DaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: complementaryFakeOps(),
    })

    await executor.onTradeCreated(
      await recordTradeCreated({
        tradeId: 'trade-3',
        sellerPubkey: orderKey(secrets).publicKeyHex,
        buyerPubkey: `03${'55'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'cond-YES',
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
        settlementKind: 'ComplementarySplit',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
      }),
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-3'].step, 'seller-opened')
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'secret-100'),
      false,
    )
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) =>
          row.asset.kind === 'outcome' &&
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

test('DaemonSwapExecutor uses reserved pre-flight proofs for complementary seller open', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-preflight-complement-'))
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
          kind: 'outcome',
          conditionId: 'cond',
          outcomeSetId: 'NO',
        }),
        reservedBy: reservationId,
        proof: cashuProof(100, 'reserved-lock-no'),
      },
      {
        ...proofRecord(profile.mintUrl, 100, 'reserved', {
          kind: 'outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        reservedBy: reservationId,
        proof: cashuProof(100, 'reserved-keep-yes'),
      },
    )
    await writeState(state)

    const sent: string[] = []
    const executor = new DaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(_ctx, proofs) {
          assert.equal(proofs[0].secret, 'reserved-lock-no')
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
            lockedProofs: [cashuProof(100, 'seller-locked')],
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
        settlementKind: 'ComplementarySplit',
        sellerKeepOutcomeSetId: 'YES',
        sellerLockOutcomeSetId: 'NO',
      }),
    )

    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-preflight'].step, 'seller-opened')
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'seller-locked')
        ?.state,
      'locked',
    )
    assert.equal(
      persisted?.wallet.proofs.some((row) => row.proof.secret === 'reserved-lock-no'),
      false,
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
          kind: 'outcome',
          conditionId: 'cond',
          outcomeSetId: 'NO',
        }),
        reservedBy: reservationId,
        proof: cashuProof(136, 'reserved-lock-no-136'),
      },
      {
        ...proofRecord(profile.mintUrl, 136, 'reserved', {
          kind: 'outcome',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        }),
        reservedBy: reservationId,
        proof: cashuProof(136, 'reserved-keep-yes-136'),
      },
    )
    await writeState(state)

    const sent: string[] = []
    const executor = new DaemonSwapExecutor({
      connection: fakeConnection(sent),
      ops: {
        ...fakeOps(),
        async sellerLockOutcomeProofs(_ctx, proofs, amount, operationId) {
          assert.equal(amount, 100)
          assert.match(operationId, /seller-preflight-lock$/)
          assert.equal(proofs[0].secret, 'reserved-lock-no-136')
          return {
            lockedProofs: [cashuProof(100, 'lock-locked-100')],
            changeProofs: [{ ...cashuProof(36, 'lock-change-36'), id: 'keyset-136' }],
          }
        },
        async splitProofsForExactSend(params) {
          assert.equal(params.amountSats, 100)
          assert.equal(params.preserveSourceKeyset, true)
          assert.match(params.operationId, /seller-preflight-keep-exact-v2\/YES$/)
          const prefix = 'keep'
          return {
            sendProofs: [cashuProof(100, `${prefix}-exact-100`)],
            changeProofs: [{ ...cashuProof(36, `${prefix}-change-36`), id: 'keyset-136' }],
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 42,
        settlementKind: 'ComplementarySplit',
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
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'lock-locked-100')
        ?.state,
      'locked',
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'lock-change-36')
        ?.state,
      'reserved',
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'keep-exact-100')
        ?.state,
      'available',
    )
    assert.equal(
      persisted?.wallet.proofs.find((row) => row.proof.secret === 'keep-change-36')
        ?.state,
      'reserved',
    )
    assert.equal(
      persisted?.wallet.proofs.some(
        (row) => row.proof.secret === 'reserved-lock-no-136',
      ),
      false,
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
    const executor = new DaemonSwapExecutor({
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
    const executor = new DaemonSwapExecutor({
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

function fakeConnection(sent: string[]): TradeRuntimeConnection {
  return {
    async start() {},
    async stop() {},
    async joinOrder() {},
    async joinTrade() {},
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
    async joinTrade() {},
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
    async sellerOpenComplementary() {
      throw new Error('complementary path unused in this test')
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
    async sellerOpenComplementary() {
      throw new Error('complementary path unused in this test')
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

function complementaryFakeOps(): DaemonSwapOps {
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
    async sellerOpenComplementary(_ctx, params, collateralProofs) {
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
