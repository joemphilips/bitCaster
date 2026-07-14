import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  emptyDaemonState,
  initializeState,
  readState,
  recordSwapMessage,
  recordSubmittedOrder,
  recordOrderStatus,
  recordTradeCreated,
  recordTradeStateChanged,
  writeState,
} from '../src/state.ts'
import { DatabaseSync } from 'node:sqlite'
import { statePath } from '../src/state.ts'
import { profileFromPublicKey, writeProfile } from '../src/profile.ts'
import { createDaemonSecrets, writeSecrets } from '../src/secrets.ts'
import { DURABLE_TRADE_SESSION_SCHEMA_VERSION } from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { generateOrderEphemeralKeypair } from '../src/ephemeralKey.ts'

async function installProtocolKeys(
  specs: Array<{
    keyId: string
    orderId: string
    marketId: string
    tradeId?: string
  }>,
): Promise<Record<string, ReturnType<typeof generateOrderEphemeralKeypair>>> {
  const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
  const pairs: Record<
    string,
    ReturnType<typeof generateOrderEphemeralKeypair>
  > = {}
  for (const spec of specs) {
    const pair = generateOrderEphemeralKeypair()
    pairs[spec.keyId] = pair
    secrets.orderEphemeralKeys[spec.keyId] = {
      orderId: spec.orderId,
      ...(spec.tradeId === undefined ? {} : { tradeId: spec.tradeId }),
      marketId: spec.marketId,
      ...pair,
      createdAt: '2026-05-21T00:00:00.000Z',
    }
  }
  await writeProfile(profileFromPublicKey(secrets.nostrPublicKeyHex))
  await writeSecrets(secrets)
  return pairs
}

test('TradeHub event records are durable swap state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const keys = await installProtocolKeys([
      {
        keyId: 'trade-1',
        orderId: 'order-1',
        marketId: 'cond-YES',
        tradeId: 'trade-1',
      },
    ])
    const localPubkey = keys['trade-1']!.publicKeyHex
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      side: 'Sell',
      tokenSide: 'Outcome',
      priceSubunits: 42,
      amountSubunits: 100,
      status: 'resting',
      ephemeralPubkey: localPubkey,
      tradeIds: ['trade-1'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      marketId: 'cond-YES',
      orderId: 'order-1',
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.durableTradeSessions['trade-1'] = durableSessionForEvent(
      'trade-1',
      'seller',
      { keyId: 'trade-1', localProtocolPubkey: localPubkey },
    )
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-1',
      sellerPubkey: localPubkey,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      baseAsset: 'sat',
      divisibility: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.role, 'seller')
    assert.equal(created?.counterpartyPubkey, `03${'22'.repeat(32)}`)
    assert.equal(created?.step, 'opened')
    assert.equal(created?.baseAsset, 'sat')
    assert.equal(created?.divisibility, 100)
    assert.equal(created?.outcomeFaceAmountSubunits, 100)
    assert.equal(created?.quotePaymentSubunits, 42)

    await recordSwapMessage('trade-1', 'adaptor-point', 'cipher-a')
    await recordSwapMessage('trade-1', 'locked-proofs-seller', 'cipher-b')
    await recordTradeStateChanged('trade-1', 'Settling')
    await recordTradeStateChanged(
      'trade-1',
      'Failed',
      'maker-collateral-failure',
    )

    const persisted = await readState()
    assert.equal(persisted?.orders['order-1'].tradeIds[0], 'trade-1')
    assert.deepEqual(persisted?.swaps['trade-1'].messages, {
      adaptorPoint: 'cipher-a',
      lockedProofsSeller: 'cipher-b',
    })
    assert.equal(persisted?.swaps['trade-1'].engineState, 'Failed')
    assert.equal(persisted?.swaps['trade-1'].step, 'Failed')
    assert.equal(
      persisted?.swaps['trade-1'].failureReason,
      'maker-collateral-failure',
    )
    assert.equal(persisted?.swaps['trade-1'].baseAsset, 'sat')
    assert.equal(persisted?.swaps['trade-1'].divisibility, 100)
    assert.equal(persisted?.swaps['trade-1'].outcomeFaceAmountSubunits, 100)
    assert.equal(persisted?.swaps['trade-1'].quotePaymentSubunits, 42)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('order refresh preserves private swaps linked only by persisted order history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-order-refresh-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'condition-YES',
      status: 'Open',
      tradeIds: ['trade-existing'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.swaps['trade-existing'] = {
      tradeId: 'trade-existing',
      marketId: 'condition-YES',
      orderId: 'order-1',
      messages: { adaptorPoint: 'retained-cipher' },
      sellerAdaptorSecretHex: 'aa',
      sellerAdaptorPointHex: '02aa',
      step: 'seller-opened',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    await recordOrderStatus('condition-YES', 'order-1', {
      status: 'PartiallyFilled',
      fills: [{ tradeId: 'trade-new' }],
    })

    const persisted = await readState()
    assert.equal(
      persisted?.swaps['trade-existing']?.messages.adaptorPoint,
      'retained-cipher',
    )
    assert.equal(
      persisted?.swaps['trade-existing']?.sellerAdaptorSecretHex,
      'aa',
    )
    assert.deepEqual(persisted?.orders['order-1']?.tradeIds, [
      'trade-existing',
      'trade-new',
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated lookup never hydrates unrelated order or protocol-key history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-trade-lookup-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await writeProfile(profileFromPublicKey('a'.repeat(64)))
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    secrets.orderEphemeralKeys['unrelated-order'] = {
      orderId: 'unrelated-order',
      marketId: 'condition-YES',
      ...generateOrderEphemeralKeypair(),
      createdAt: '2026-05-21T00:00:00.000Z',
    }
    await writeSecrets(secrets)
    const state = emptyDaemonState()
    state.orders['unrelated-order'] = {
      orderId: 'unrelated-order',
      marketId: 'condition-YES',
      status: 'Open',
      ephemeralPubkey:
        secrets.orderEphemeralKeys['unrelated-order'].publicKeyHex,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)
    const database = new DatabaseSync(statePath())
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare(
          `UPDATE daemon_orders SET status = '' WHERE order_id = 'unrelated-order'`,
        )
        .run()
      database
        .prepare(
          `UPDATE daemon_order_ephemeral_keys SET private_key_hex = 'bad'
          WHERE key_id = 'unrelated-order'`,
        )
        .run()
    } finally {
      database.close()
    }

    assert.equal(
      await recordTradeCreated({
        tradeId: 'trade-new',
        sellerPubkey: `02${'22'.repeat(32)}`,
        buyerPubkey: `03${'33'.repeat(32)}`,
        sellerLocktime: '2026-05-21T00:02:00.000Z',
        buyerLocktime: '2026-05-21T00:01:00.000Z',
        marketId: 'condition-NO',
      }),
      null,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated exact trade history outranks an earlier pubkey fallback', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-trade-exact-precedence-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    const protocolKey = generateOrderEphemeralKeypair()
    secrets.orderEphemeralKeys['z-exact-order'] = {
      orderId: 'z-exact-order',
      marketId: 'cond-YES',
      ...protocolKey,
      createdAt: '2026-05-21T00:00:00.000Z',
    }
    await writeSecrets(secrets)
    await writeProfile(profileFromPublicKey(secrets.nostrPublicKeyHex))
    const state = emptyDaemonState()
    for (const [orderId, tradeIds] of [
      ['a-fallback-order', []],
      ['z-exact-order', ['trade-exact-precedence']],
    ] as const) {
      state.orders[orderId] = {
        orderId,
        marketId: 'cond-YES',
        side: 'Sell',
        tokenSide: 'Outcome',
        priceSubunits: 42,
        amountSubunits: 100,
        status: 'resting',
        ephemeralPubkey: protocolKey.publicKeyHex,
        tradeIds: [...tradeIds],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-exact-precedence',
      sellerPubkey: protocolKey.publicKeyHex,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.orderId, 'z-exact-order')
    const persisted = await readState()
    assert.deepEqual(persisted?.orders['a-fallback-order']?.tradeIds, [])
    assert.deepEqual(persisted?.orders['z-exact-order']?.tradeIds, [
      'trade-exact-precedence',
    ])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated exact history rejects wrong direct and mint market paths before mutation', async () => {
  for (const settlementKind of ['DirectSwap', 'Mint'] as const) {
    const home = await mkdtemp(
      join(
        tmpdir(),
        `bitcaster-daemon-trade-exact-wrong-${settlementKind.toLowerCase()}-`,
      ),
    )
    const previousHome = process.env.BITCASTER_DAEMON_HOME
    process.env.BITCASTER_DAEMON_HOME = home
    try {
      const tradeId = `trade-exact-wrong-${settlementKind.toLowerCase()}`
      const keys = await installProtocolKeys([
        {
          keyId: 'exact-order',
          orderId: 'exact-order',
          marketId: 'cond-YES',
        },
      ])
      const publicKey = keys['exact-order']!.publicKeyHex
      const state = emptyDaemonState()
      state.orders['exact-order'] = {
        orderId: 'exact-order',
        marketId: 'cond-YES',
        side: settlementKind === 'DirectSwap' ? 'Sell' : 'Buy',
        tokenSide: 'Outcome',
        priceSubunits: 42,
        amountSubunits: 100,
        status: 'matched',
        ephemeralPubkey: publicKey,
        tradeIds: [tradeId],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      await writeState(state)

      await assert.rejects(
        () =>
          recordTradeCreated({
            tradeId,
            sellerPubkey:
              settlementKind === 'DirectSwap'
                ? publicKey
                : `02${'33'.repeat(32)}`,
            buyerPubkey:
              settlementKind === 'Mint' ? publicKey : `03${'22'.repeat(32)}`,
            sellerLocktime: '2026-05-21T00:02:00.000Z',
            buyerLocktime: '2026-05-21T00:01:00.000Z',
            marketId: 'cond-NO',
            fillAmountSubunits: 100,
            outcomeFaceAmountSubunits: 100,
            quotePaymentSubunits: 42,
            settlementKind,
            ...(settlementKind === 'Mint'
              ? {
                  sellerKeepOutcomeSetId: 'YES',
                  sellerLockOutcomeSetId: 'NO',
                }
              : {}),
          }),
        /exact local order has an invalid market path/,
      )
      const persisted = await readState()
      assert.deepEqual(persisted?.orders['exact-order']?.tradeIds, [tradeId])
      assert.equal(persisted?.swaps[tradeId], undefined)
      assert.equal(persisted?.durableTradeSessions[tradeId], undefined)
    } finally {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('TradeCreated cannot open a swap without its retained protocol key', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-trade-missing-key-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const publicKey = generateOrderEphemeralKeypair().publicKeyHex
    const state = emptyDaemonState()
    state.orders['missing-key-order'] = {
      orderId: 'missing-key-order',
      marketId: 'cond-YES',
      side: 'Sell',
      tokenSide: 'Outcome',
      priceSubunits: 42,
      amountSubunits: 100,
      status: 'matched',
      ephemeralPubkey: publicKey,
      tradeIds: ['trade-missing-key'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    await assert.rejects(
      () =>
        recordTradeCreated({
          tradeId: 'trade-missing-key',
          sellerPubkey: publicKey,
          buyerPubkey: `03${'22'.repeat(32)}`,
          sellerLocktime: '2026-05-21T00:02:00.000Z',
          buyerLocktime: '2026-05-21T00:01:00.000Z',
          marketId: 'cond-YES',
          fillAmountSubunits: 100,
          outcomeFaceAmountSubunits: 100,
          quotePaymentSubunits: 42,
          settlementKind: 'DirectSwap',
        }),
      /protocol key is missing/,
    )
    const persisted = await readState()
    assert.deepEqual(persisted?.orders['missing-key-order']?.tradeIds, [
      'trade-missing-key',
    ])
    assert.equal(persisted?.swaps['trade-missing-key'], undefined)
    assert.equal(
      persisted?.durableTradeSessions['trade-missing-key'],
      undefined,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated rejects an ambiguous pubkey fallback without persisting a swap', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-trade-ambiguous-fallback-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const protocolKey = generateOrderEphemeralKeypair()
    const state = emptyDaemonState()
    for (const orderId of ['fallback-order-a', 'fallback-order-b']) {
      state.orders[orderId] = {
        orderId,
        marketId: 'cond-YES',
        side: 'Sell',
        tokenSide: 'Outcome',
        priceSubunits: 42,
        amountSubunits: 100,
        status: 'resting',
        ephemeralPubkey: protocolKey.publicKeyHex,
        tradeIds: [],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
    }
    await writeState(state)

    await assert.rejects(
      () =>
        recordTradeCreated({
          tradeId: 'ambiguous-trade',
          sellerPubkey: protocolKey.publicKeyHex,
          buyerPubkey: `03${'22'.repeat(32)}`,
          sellerLocktime: '2026-05-21T00:02:00.000Z',
          buyerLocktime: '2026-05-21T00:01:00.000Z',
          marketId: 'cond-YES',
          fillAmountSubunits: 100,
          outcomeFaceAmountSubunits: 100,
          quotePaymentSubunits: 42,
          settlementKind: 'DirectSwap',
        }),
      /ambiguous local order fallback/,
    )
    const persisted = await readState()
    assert.equal(persisted?.swaps['ambiguous-trade'], undefined)
    assert.deepEqual(persisted?.orders['fallback-order-a']?.tradeIds, [])
    assert.deepEqual(persisted?.orders['fallback-order-b']?.tradeIds, [])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated promotes a local ephemeral key into an SDK durable session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-durable-trade-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    const publicKeyHex =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    secrets.orderEphemeralKeys['trade-durable-1'] = {
      orderId: 'order-durable-1',
      tradeId: 'trade-durable-1',
      marketId: 'cond-YES',
      privateKeyHex: '1'.padStart(64, '0'),
      publicKeyHex,
      createdAt: '2026-05-21T00:00:00.000Z',
    }
    await writeSecrets(secrets)
    const profile = profileFromPublicKey(secrets.nostrPublicKeyHex)
    await writeProfile(profile)
    const state = emptyDaemonState()
    state.orders['order-durable-1'] = {
      orderId: 'order-durable-1',
      marketId: 'cond-YES',
      side: 'Sell',
      tokenSide: 'Outcome',
      priceSubunits: 42,
      amountSubunits: 100,
      status: 'resting',
      ephemeralPubkey: publicKeyHex,
      tradeIds: ['trade-durable-1'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    await recordTradeCreated({
      tradeId: 'trade-durable-1',
      sellerPubkey: publicKeyHex,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      baseAsset: 'sat',
      divisibility: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })

    const session = (await readState())?.durableTradeSessions['trade-durable-1']
    assert.equal(session?.role, 'seller')
    assert.equal(session?.localProtocolPubkey, publicKeyHex)
    assert.equal(session?.counterpartyProtocolPubkey, `03${'22'.repeat(32)}`)
    assert.equal(session?.ephemeralKeyHandle.keyId, 'trade-durable-1')
    assert.equal(session?.stage, 'intent')
    assert.deepEqual(session?.proofOperations, [])
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('submitted daemon taker fills retain recovery source metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-taker-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await initializeState()
    await recordSubmittedOrder(
      'condition-YES',
      'client-order-1',
      {
        orderId: 'taker-order-1',
        status: 'filled',
        fills: [
          {
            tradeId: 'taker-trade-1',
            takerOrderId: 'taker-order-1',
          },
        ],
      },
      null,
      'Outcome',
      'Buy',
      5_000,
      10_000,
      'FAK',
      1,
    )

    const persisted = await readState()
    assert.equal(persisted?.orders['taker-order-1']?.timeInForce, 'FAK')
    assert.equal(persisted?.orders['taker-order-1']?.recoveryAttempt, 1)
    assert.equal(persisted?.swaps['taker-trade-1']?.isTaker, true)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated direct match must use the same local order market path', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-path-direct-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-wrong-market',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created, null)
    const persisted = await readState()
    assert.equal(persisted?.orders['order-1'].tradeIds.length, 0)
    assert.equal(persisted?.swaps['trade-wrong-market'], undefined)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated rejects unit metadata that does not match the local order', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-unit-mismatch-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-usd'] = {
      orderId: 'order-usd',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      baseAsset: 'usd',
      divisibility: 100,
      side: 'Sell',
      tokenSide: 'Outcome',
      priceSubunits: 42,
      amountSubunits: 100,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-unit-mismatch',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      baseAsset: 'sat',
      divisibility: 100,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.step, 'Failed')
    assert.match(created?.error ?? '', /Trade unit mismatch/)
    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-unit-mismatch'].step, 'Failed')
    assert.match(
      persisted?.swaps['trade-unit-mismatch'].error ?? '',
      /Trade unit mismatch/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated rejects quote payment that violates local submitted order economics', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-order-economics-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-ask'] = {
      orderId: 'order-ask',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      baseAsset: 'sat',
      divisibility: 100,
      side: 'Sell',
      tokenSide: 'Outcome',
      priceSubunits: 40,
      amountSubunits: 100,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-price-mismatch',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 39,
      baseAsset: 'sat',
      divisibility: 100,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.step, 'Failed')
    assert.match(
      created?.error ?? '',
      /does not satisfy the submitted order price/,
    )
    const persisted = await readState()
    assert.equal(persisted?.swaps['trade-price-mismatch'].step, 'Failed')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated rejects legacy local orders without submitted order economics', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-missing-economics-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-legacy'] = {
      orderId: 'order-legacy',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      baseAsset: 'sat',
      divisibility: 100,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-missing-economics',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 40,
      baseAsset: 'sat',
      divisibility: 100,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.step, 'Failed')
    assert.match(created?.error ?? '', /Expected order economics are missing/)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated rejects non-default rows without canonical settlement amounts', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-canonical-missing-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-usd'] = {
      orderId: 'order-usd',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      baseAsset: 'usd',
      divisibility: 100,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-canonical-missing',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      fillAmountSubunits: 100,
      quotePaymentSubunits: 42,
      baseAsset: 'usd',
      divisibility: 100,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.step, 'Failed')
    assert.match(
      created?.error ?? '',
      /outcome face subunits must be a positive safe integer|missing outcome face subunits/,
    )
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated mint seller matches keep path and buyer matches lock path', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-path-complement-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const keys = await installProtocolKeys([
      { keyId: 'seller-order', orderId: 'seller-order', marketId: 'cond-YES' },
      { keyId: 'buyer-order', orderId: 'buyer-order', marketId: 'cond-NO' },
    ])
    const sellerPubkey = keys['seller-order']!.publicKeyHex
    const buyerPubkey = keys['buyer-order']!.publicKeyHex
    const state = emptyDaemonState()
    state.orders['seller-order'] = {
      orderId: 'seller-order',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: sellerPubkey,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.orders['buyer-order'] = {
      orderId: 'buyer-order',
      marketId: 'cond-NO',
      side: 'Buy',
      tokenSide: 'Outcome',
      priceSubunits: 42,
      amountSubunits: 100,
      status: 'matched',
      ephemeralPubkey: buyerPubkey,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const sellerCreated = await recordTradeCreated({
      tradeId: 'trade-seller',
      sellerPubkey,
      buyerPubkey: `03${'33'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })
    const buyerCreated = await recordTradeCreated({
      tradeId: 'trade-buyer',
      sellerPubkey: `02${'33'.repeat(32)}`,
      buyerPubkey,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })

    assert.equal(sellerCreated?.orderId, 'seller-order')
    assert.equal(sellerCreated?.role, 'seller')
    assert.equal(buyerCreated?.orderId, 'buyer-order')
    assert.equal(buyerCreated?.role, 'buyer')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated binds known public complement order by submitted trade id', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-public-complement-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const keys = await installProtocolKeys([
      {
        keyId: 'buyer-order',
        orderId: 'buyer-order',
        marketId: 'cond-A',
      },
    ])
    const buyerPubkey = keys['buyer-order']!.publicKeyHex
    const state = emptyDaemonState()
    state.orders['buyer-order'] = {
      orderId: 'buyer-order',
      marketId: 'cond-A',
      side: 'Buy',
      tokenSide: 'Complement',
      priceSubunits: 99,
      amountSubunits: 100,
      status: 'matched',
      ephemeralPubkey: buyerPubkey,
      tradeIds: ['trade-known-complement'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.swaps['trade-known-complement'] = {
      tradeId: 'trade-known-complement',
      marketId: 'cond-A',
      orderId: 'buyer-order',
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-known-complement',
      sellerPubkey: `02${'33'.repeat(32)}`,
      buyerPubkey,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-B|C',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 99,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'A',
      sellerLockOutcomeSetId: 'B|C',
    })

    assert.equal(created?.orderId, 'buyer-order')
    assert.equal(created?.marketId, 'cond-A')
    assert.equal(created?.role, 'buyer')
    assert.equal(created?.step, 'opened')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated binds buyer complement order by settlement metadata', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-buyer-complement-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const keys = await installProtocolKeys([
      {
        keyId: 'buyer-order',
        orderId: 'buyer-order',
        marketId: 'cond-YES',
      },
    ])
    const buyerPubkey = keys['buyer-order']!.publicKeyHex
    const state = emptyDaemonState()
    state.orders['buyer-order'] = {
      orderId: 'buyer-order',
      marketId: 'cond-YES',
      tokenSide: 'Complement',
      side: 'Buy',
      priceSubunits: 99,
      amountSubunits: 100,
      status: 'matched',
      ephemeralPubkey: buyerPubkey,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-buyer-complement',
      sellerPubkey: `02${'33'.repeat(32)}`,
      buyerPubkey,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 99,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })

    assert.equal(created?.orderId, 'buyer-order')
    assert.equal(created?.marketId, 'cond-YES')
    assert.equal(created?.role, 'buyer')
    assert.equal(created?.sellerKeepOutcomeSetId, 'YES')
    assert.equal(created?.sellerLockOutcomeSetId, 'NO')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated mint match rejects mismatched keep or lock paths', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-path-mismatch-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['seller-order'] = {
      orderId: 'seller-order',
      marketId: 'cond-NO',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.orders['buyer-order'] = {
      orderId: 'buyer-order',
      marketId: 'cond-YES',
      status: 'matched',
      ephemeralPubkey: `03${'22'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const sellerCreated = await recordTradeCreated({
      tradeId: 'trade-seller-wrong-path',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'33'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })
    const buyerCreated = await recordTradeCreated({
      tradeId: 'trade-buyer-wrong-path',
      sellerPubkey: `02${'33'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      fillAmountSubunits: 100,
      outcomeFaceAmountSubunits: 100,
      quotePaymentSubunits: 42,
      settlementKind: 'Mint',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })

    assert.equal(sellerCreated, null)
    assert.equal(buyerCreated, null)
    const persisted = await readState()
    assert.equal(persisted?.orders['seller-order'].tradeIds.length, 0)
    assert.equal(persisted?.orders['buyer-order'].tradeIds.length, 0)
    assert.equal(persisted?.swaps['trade-seller-wrong-path'], undefined)
    assert.equal(persisted?.swaps['trade-buyer-wrong-path'], undefined)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('concurrent TradeHub events serialize daemon state writes', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'bitcaster-daemon-events-concurrent-'),
  )
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const keys = await installProtocolKeys([
      {
        keyId: 'trade-1',
        orderId: 'order-1',
        marketId: 'cond-YES',
        tradeId: 'trade-1',
      },
    ])
    const localPubkey = keys['trade-1']!.publicKeyHex
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: localPubkey,
      tradeIds: ['trade-1'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      marketId: 'cond-YES',
      orderId: 'order-1',
      role: 'seller',
      counterpartyPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: 1_779_389_200,
      buyerLocktime: 1_779_385_600,
      messages: {},
      step: 'opened',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.durableTradeSessions['trade-1'] = durableSessionForEvent(
      'trade-1',
      'seller',
      { keyId: 'trade-1', localProtocolPubkey: localPubkey },
    )
    await writeState(state)

    await Promise.all([
      recordSwapMessage('trade-1', 'adaptor-point', 'cipher-a'),
      recordSwapMessage('trade-1', 'locked-proofs-seller', 'cipher-b'),
      recordSwapMessage('trade-1', 'locked-proofs-buyer', 'cipher-c'),
      recordTradeStateChanged('trade-1', 'Settling'),
    ])

    const persisted = await readState()
    assert.deepEqual(persisted?.swaps['trade-1'].messages, {
      adaptorPoint: 'cipher-a',
      lockedProofsSeller: 'cipher-b',
      lockedProofsBuyer: 'cipher-c',
    })
    assert.equal(persisted?.swaps['trade-1'].engineState, 'Settling')
    assert.equal(persisted?.swaps['trade-1'].step, 'settling')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function durableSessionForEvent(
  tradeId: string,
  role: 'seller' | 'buyer',
  overrides: Partial<{ keyId: string; localProtocolPubkey: string }> = {},
) {
  const localProtocolPubkey =
    overrides.localProtocolPubkey ??
    (role === 'seller' ? `02${'11'.repeat(32)}` : `03${'22'.repeat(32)}`)
  const counterpartyProtocolPubkey =
    role === 'seller' ? `03${'22'.repeat(32)}` : `02${'11'.repeat(32)}`
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId,
    role,
    localProtocolPubkey,
    counterpartyProtocolPubkey,
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 1_779_389_200,
    buyerLocktimeSecs: 1_779_385_600,
    ephemeralKeyHandle: {
      keyId: overrides.keyId ?? `key-${tradeId}`,
      tradeId,
      role,
      localProtocolPubkey,
      counterpartyProtocolPubkey,
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 1_779_389_200,
      buyerLocktimeSecs: 1_779_385_600,
    },
    stage: 'intent' as const,
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}
