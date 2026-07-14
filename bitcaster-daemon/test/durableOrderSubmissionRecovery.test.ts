import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SubmitOrderResponse } from '@bitcaster-market/client-sdk/engineClient'
import type { DurableOrderCollateralPin } from '@bitcaster-market/client-sdk/durableOrderCollateral'
import { DaemonOrderCollateralCoordinator, setDaemonOrderCollateralFaultHookForTest } from '../src/durableOrderCollateralCoordinator.ts'
import { daemonWalletCustodyScope, DaemonDurableCustodyLease } from '../src/durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'
import { recoverPreparedOrderSubmissions } from '../src/durableOrderSubmissionRecovery.ts'
import {
  addAvailableSatProofs,
  applyOrderEngineProjection,
  emptyDaemonState,
  orderEngineProjectionScope,
  readState,
  writeState,
} from '../src/state.ts'

const WALLET_SEED = '81'.repeat(32)
const KEYSET_ID = `00${'72'.repeat(7)}`
const PUBLIC_KEY = `02${'63'.repeat(32)}`

test('prepared GTC submission retries its exact request after atomic pre-commit crash', async () => {
  await withFixture(async ({ coordinator, pin }) => {
    const requests: unknown[] = []
    await assert.rejects(
      recover(coordinator, requests, 'before-commit'),
      /accepted-order commit crash/,
    )
    setDaemonOrderCollateralFaultHookForTest(undefined)

    assert.equal((await coordinator.readPreparedPage({ limit: 10 })).pins.length, 1)
    assert.deepEqual((await readState()).orders, {})
    assert.deepEqual(await recover(coordinator, requests), { recoveredCount: 1 })
    assert.deepEqual(requests, [exactRequest(pin), exactRequest(pin)])
    assert.equal((await readState()).orders['order-accepted']?.clientOrderId,
      pin.clientOrderId)
    assert.equal((await coordinator.readPreparedPage({ limit: 10 })).pins.length, 0)
  })
})

test('post-commit crash never resubmits an already projected GTC order', async () => {
  await withFixture(async ({ coordinator }) => {
    const requests: unknown[] = []
    await assert.rejects(
      recover(coordinator, requests, 'after-commit'),
      /post-commit process crash/,
    )
    setDaemonOrderCollateralFaultHookForTest(undefined)

    assert.equal((await readState()).orders['order-accepted']?.status, 'resting')
    assert.deepEqual(await recover(coordinator, requests), { recoveredCount: 0 })
    assert.equal(requests.length, 1)
  })
})

async function recover(
  coordinator: DaemonOrderCollateralCoordinator,
  requests: unknown[],
  faultStage?: 'before-commit' | 'after-commit',
) {
  return recoverPreparedOrderSubmissions({
    coordinator,
    async submitOrder(marketId, request) {
      requests.push({ marketId, request })
      if (faultStage) {
        setDaemonOrderCollateralFaultHookForTest((stage) => {
          if (stage !== faultStage) return
          throw new Error(faultStage === 'before-commit'
            ? 'accepted-order commit crash'
            : 'post-commit process crash')
        })
      }
      return acceptedResponse()
    },
    commitAccepted: (pin, response) => commitAccepted(coordinator, pin, response),
  })
}

async function commitAccepted(
  coordinator: DaemonOrderCollateralCoordinator,
  pin: DurableOrderCollateralPin,
  response: SubmitOrderResponse,
) {
  const request = pin.submissionRequest
  const projection = {
    marketId: pin.marketId,
    orderId: response.orderId,
    engineStatus: response,
    clientOrderId: pin.clientOrderId,
    preflightSplit: pin.preflightSplit,
    tokenSide: request.tokenSide,
    side: request.side,
    priceSubunits: request.price,
    amountSubunits: request.amountSubunits,
    timeInForce: request.timeInForce,
  } as const
  return coordinator.commitAcceptedSubmission({
    pinId: pin.pinId,
    orderId: response.orderId,
    status: response.status,
    remainingAmount: response.remainingAmountSubunits,
    stateScope: orderEngineProjectionScope(projection),
    applyState: (state, now) => applyOrderEngineProjection(state, now, projection),
  })
}

function exactRequest(pin: DurableOrderCollateralPin) {
  return {
    marketId: pin.marketId,
    request: pin.submissionRequest,
  }
}

function acceptedResponse(): SubmitOrderResponse {
  return {
    orderId: 'order-accepted',
    status: 'resting',
    remainingAmountSubunits: 100,
    fills: [],
    baseAsset: 'sat',
    divisibility: 100,
  }
}

async function withFixture(
  run: (fixture: {
    coordinator: DaemonOrderCollateralCoordinator
    pin: DurableOrderCollateralPin
  }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-order-recovery-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  try {
    const store = new SqliteDurableCustodyStore()
    await store.registerScope(daemonWalletCustodyScope(WALLET_SEED))
    await writeState(emptyDaemonState())
    lease = await DaemonDurableCustodyLease.claim({
      store,
      walletSeedHex: WALLET_SEED,
    })
    const [proof] = await addAvailableSatProofs(
      'https://mint.example',
      [{ id: KEYSET_ID, amount: 100, secret: 'order-input', C: PUBLIC_KEY }],
    )
    assert.ok(proof)
    const coordinator = new DaemonOrderCollateralCoordinator(lease)
    const pin = await coordinator.prepare({
      clientOrderId: 'client-order-exact',
      marketId: 'condition-YES',
      mintUrl: 'https://mint.example',
      unit: 'sat',
      orderAmount: 100,
      requiredAmount: 100,
      submissionRequest: {
        clientOrderId: 'client-order-exact',
        outcomeId: 'YES',
        tokenSide: 'Outcome',
        side: 'Buy',
        price: 50,
        amountSubunits: 100,
        timeInForce: 'GTC',
      },
      proofs: [proof],
    })
    await run({ coordinator, pin })
  } finally {
    setDaemonOrderCollateralFaultHookForTest(undefined)
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}
