import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { dispatch, type DispatchDependencies, type EngineClientLike } from '../src/server.ts'

const CONDITION_ID = 'b'.repeat(64)
const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const BEGIN = {
  kind: 'begin' as const,
  expectedPreviousTransferId: null,
  newAttemptId: FIRST_ID,
  requestedAmount: '8000',
}
const MARKET = {
  conditionId: CONDITION_ID,
  baseAsset: 'sat',
  divisibility: 1_000,
  outcomes: ['Yes', 'No'],
}

async function fundingFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-funding-rpc-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: profile.walletScopeId,
    incarnationId: 'funding-rpc-test',
    observedAtMs: Date.now(),
  })
  const calls = {
    market: 0,
    quote: 0,
    head: 0,
    deliver: [] as Array<{
      conditionId: string
      accountSubject: string
      outcomeCount: number
      attempt: unknown
      maxWalletDebitMsat?: number
    }>,
  }
  let marketResponse: unknown = MARKET
  const client: EngineClientLike = {
    submitOrder: async () => {
      throw new Error('not used')
    },
    getOrderStatus: async () => null,
    cancelOrder: async () => false,
    getOrderBook: async () => {
      throw new Error('not used')
    },
    queryMarkets: async () => {
      throw new Error('not used')
    },
    getParticipationScore: async () => {
      throw new Error('not used')
    },
    getMarket: async (conditionId) => {
      calls.market++
      assert.equal(conditionId, CONDITION_ID)
      return marketResponse
    },
    getDurableRecipientDeliveryStatus: async () => null,
    submitDurableRecipientDelivery: async () => {
      throw new Error('not used')
    },
  }
  const deps: DispatchDependencies = {
    getCustodyFence: () => fence,
    createEngineClient: () => client,
    marketFundingOps: {
      quote: async (input) => {
        calls.quote++
        assert.equal(input.requestedAmountMsat, 8_000)
        assert.equal(input.outcomeCount, 2)
        return {
          grossFundingMsat: 8_000,
          sendPreparationFeeMsat: 2,
          estimatedRecipientReceiveFeeMsat: 1,
          totalWalletDebitMsat: 8_002,
          netFundingMsat: 7_999,
          token: 'must-not-cross-rpc',
        }
      },
      head: async (input) => {
        calls.head++
        assert.equal(input.accountSubject, profile.nostrPublicKeyHex)
        assert.equal(input.conditionId, CONDITION_ID)
        assert.equal(input.divisibility, 1_000)
        return { transferId: FIRST_ID, revision: 1, token: 'must-not-cross-rpc' }
      },
      deliver: async (input) => {
        calls.deliver.push(input)
        return {
          deliveryId: FIRST_ID,
          transferId: FIRST_ID,
          state: 'received',
          token: 'must-not-cross-rpc',
        }
      },
    },
  }
  return {
    profile,
    deps,
    calls,
    setMarket: (value: unknown) => {
      marketResponse = value
    },
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('funding RPC uses market and signer authority for quote, head, begin, and resume', async () => {
  const fixture = await fundingFixture()
  try {
    assert.deepEqual(
      await dispatch(
        {
          method: 'market.funding.quote',
          params: { conditionId: CONDITION_ID, requestedAmountMsat: 8_000 },
        },
        fixture.deps,
      ),
      {
        ok: true,
        result: {
          grossFundingMsat: 8_000,
          sendPreparationFeeMsat: 2,
          estimatedRecipientReceiveFeeMsat: 1,
          totalWalletDebitMsat: 8_002,
          netFundingMsat: 7_999,
        },
      },
    )
    assert.deepEqual(
      await dispatch(
        {
          method: 'market.funding.head',
          params: { conditionId: CONDITION_ID },
        },
        fixture.deps,
      ),
      { ok: true, result: { transferId: FIRST_ID, revision: 1 } },
    )
    const begin = await dispatch(
      {
        method: 'market.fund',
        params: { conditionId: CONDITION_ID, attempt: BEGIN, maxWalletDebitMsat: 8_002 },
      },
      fixture.deps,
    )
    assert.deepEqual(begin, {
      ok: true,
      result: {
        deliveryId: FIRST_ID,
        transferId: FIRST_ID,
        state: 'received',
      },
    })
    assert.deepEqual(
      await dispatch(
        {
          method: 'market.fund',
          params: { conditionId: CONDITION_ID, attempt: { kind: 'resume', transferId: FIRST_ID } },
        },
        fixture.deps,
      ),
      begin,
    )
    assert.equal(fixture.calls.quote, 1)
    assert.equal(fixture.calls.head, 1)
    assert.equal(fixture.calls.market, 4)
    assert.equal(fixture.calls.deliver.length, 2)
    assert.equal(fixture.calls.deliver[0]?.accountSubject, fixture.profile.nostrPublicKeyHex)
    assert.equal(fixture.calls.deliver[0]?.conditionId, CONDITION_ID)
    assert.equal(fixture.calls.deliver[0]?.outcomeCount, 2)
    assert.deepEqual(fixture.calls.deliver[0]?.attempt, BEGIN)
    assert.equal(fixture.calls.deliver[0]?.maxWalletDebitMsat, 8_002)
    assert.equal(fixture.calls.deliver[1]?.maxWalletDebitMsat, undefined)
  } finally {
    await fixture.close()
  }
})

test('funding RPC rejects invalid metadata and redacts storage and transport errors', async () => {
  const fixture = await fundingFixture()
  try {
    for (const invalidMarket of [
      { ...MARKET, conditionId: 'c'.repeat(64) },
      { conditionId: CONDITION_ID, baseAsset: 'sat', outcomes: ['Yes', 'No'] },
      { ...MARKET, outcomes: ['Yes'] },
    ]) {
      fixture.setMarket(invalidMarket)
      assert.deepEqual(
        await dispatch(
          {
            method: 'market.funding.head',
            params: { conditionId: CONDITION_ID },
          },
          fixture.deps,
        ),
        { ok: false, code: 'invalid-market', error: 'market funding metadata is invalid' },
      )
    }
    assert.equal(fixture.calls.head, 0)
    fixture.setMarket(MARKET)
    fixture.deps.marketFundingOps!.head = async () => {
      throw new Error('cashuBprivate-head-error')
    }
    assert.deepEqual(
      await dispatch(
        {
          method: 'market.funding.head',
          params: { conditionId: CONDITION_ID },
        },
        fixture.deps,
      ),
      {
        ok: false,
        code: 'market-funding-unavailable',
        error: 'market funding head is unavailable',
      },
    )
    fixture.deps.marketFundingOps!.deliver = async () => {
      throw new Error('cashuBprivate-bearer-token')
    }
    const uncertain = await dispatch(
      {
        method: 'market.fund',
        params: { conditionId: CONDITION_ID, attempt: { kind: 'resume', transferId: FIRST_ID } },
      },
      fixture.deps,
    )
    assert.deepEqual(uncertain, {
      ok: false,
      code: 'market-funding-unconfirmed',
      error: 'Market funding could not be confirmed. Retry the same attempt.',
      result: { attemptId: FIRST_ID },
    })
    assert.equal(JSON.stringify(uncertain).includes('cashuBprivate'), false)
    fixture.deps.marketFundingOps!.quote = async () => {
      throw new Error('market funding amount is too small after the receive fee')
    }
    assert.deepEqual(
      await dispatch(
        {
          method: 'market.funding.quote',
          params: { conditionId: CONDITION_ID, requestedAmountMsat: 8_000 },
        },
        fixture.deps,
      ),
      {
        ok: false,
        code: 'market-funding-refused',
        error: 'market funding amount is too small after the receive fee',
      },
    )
    fixture.deps.marketFundingOps!.deliver = async () => {
      throw new Error('market funding requires an approved maximum wallet debit')
    }
    assert.deepEqual(
      await dispatch(
        {
          method: 'market.fund',
          params: { conditionId: CONDITION_ID, attempt: BEGIN },
        },
        fixture.deps,
      ),
      {
        ok: false,
        code: 'market-funding-refused',
        error: 'market funding requires an approved maximum wallet debit',
        result: { attemptId: FIRST_ID },
      },
    )
  } finally {
    await fixture.close()
  }
})

test('funding RPC rejects malformed requests and custody-not-ready before I/O', async () => {
  let marketReads = 0
  const createEngineClient = () => {
    marketReads++
    throw new Error('must not read market')
  }
  const blocked = await dispatch(
    {
      method: 'market.fund',
      params: { conditionId: CONDITION_ID, attempt: { kind: 'resume', transferId: FIRST_ID } },
    },
    { isCustodyReady: () => false, createEngineClient },
  )
  assert.equal(blocked.code, 'custody-recovery-pending')
  const malformed = await dispatch(
    {
      method: 'market.fund',
      params: {
        conditionId: CONDITION_ID,
        attempt: { ...BEGIN, requestedAmount: '0' },
        maxWalletDebitMsat: 1,
      },
    },
    { createEngineClient },
  )
  assert.equal(malformed.code, 'invalid-market-funding')
  assert.equal(marketReads, 0)
})
