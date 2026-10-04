import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  getEncodedToken,
  hashToCurve,
  pointFromHex,
  type Proof,
  type OperationCounters,
} from '@cashu/cashu-ts'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { completedProofAuthorityDigest } from '@bitcaster-market/client-sdk/ctfSplit'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyProofId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { EngineClientError } from '@bitcaster-market/client-sdk/engineClient'
import type {
  AssetMonitoringAssetsResponse,
  AssetMonitoringPortfolioResponse,
} from '@bitcaster-market/client-sdk'
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
  type DurableRecipientDeliverySubmission,
} from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  createParticipationScoreDeliveryMetadata,
  createParticipationScoreDeliverySubmission,
} from '@bitcaster-market/client-sdk/participationScoreDelivery'
import {
  dispatch,
  type EngineClientLike,
  type PrepareSettlementCapabilityInput,
} from '../src/server.ts'
import { profileDir, readProfile } from '../src/profile.ts'
import { readDaemonWalletBalance } from '../src/walletBalance.ts'
import { createDaemonSecrets, readSecrets } from '../src/secrets.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import {
  emptyDaemonState,
  readAvailableCanonicalWalletProofPageFromDatabase,
  readState,
  writeState as persistState,
  type DaemonState,
} from '../src/state.ts'
import {
  createDaemonCounterSource,
  splitAvailableMsatProofsForCtfCollateral,
} from '../src/walletOps.ts'
import { withDaemonStateSqliteTransaction, type StateSqliteFaultPhase } from '../src/stateSqlite.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { canonicalTestKeysetId } from './support/canonicalKeysetId.ts'

const TEST_KEYSET_ID = canonicalTestKeysetId('dispatch')
const CTF_KEYSET_ID = canonicalTestKeysetId('dispatch:ctf')
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { claimCustodyScopeLease, releaseCustodyScopeLease } from '../src/profileFencing.ts'
import { reserveDaemonKeysetCounter } from '../src/state.ts'
import type { OrderDraftParams, ScorePurchaseConsent, SubmitOrderParams } from '../src/protocol.ts'
import { retainNativeOrderLink } from './support/nativeOrderOwnership.ts'

const V2_KEYSET_ID = `01${'a'.repeat(64)}`
const V1_KEYSET_ID = `00${'a'.repeat(14)}`
const OUTCOME_CONDITION_ID = 'ab'.repeat(32)
const OUTCOME_COLLECTION = 'YES'
const OUTCOME_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 9])
const OUTCOME_KEYS = {
  '11': bytesToHex(secp256k1.getPublicKey(OUTCOME_PRIVATE_KEY, true)),
}
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: OUTCOME_CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const OUTCOME_KEYSET_ID = deriveConditionalKeysetId({
  keys: OUTCOME_KEYS,
  unit: 'msat',
  conditionId: OUTCOME_CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})

test('retired standalone Score quote returns authenticated credit without mint work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-score-retired-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let fence: Awaited<ReturnType<typeof claimCustodyScopeLease>> | undefined
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const secrets = await readSecrets()
    assert.ok(secrets)
    fence = await claimCustodyScopeLease(home, {
      scopeId: profile.walletScopeId,
      incarnationId: 'score-retired-test',
      observedAtMs: Date.now(),
    })
    const coordinator = new DaemonDurableOutgoingCashuCoordinator(profileDir(), () => fence!)
    const retiredId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const currentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    await coordinator.preflightParticipationScoreDelivery({
      transferId: retiredId,
      amountMsat: 3_000,
      purchasedTotal: 7,
      accountSubject: secrets.nostrPublicKeyHex,
      mintUrl: 'https://mint.example',
    })
    await coordinator.preflightParticipationScoreDelivery({
      transferId: currentId,
      amountMsat: 1_000,
      purchasedTotal: 8,
      accountSubject: secrets.nostrPublicKeyHex,
      mintUrl: 'https://mint.example',
    })
    const active = await coordinator.preflightParticipationScoreDelivery({
      transferId: retiredId,
      amountMsat: 3_000,
      purchasedTotal: 8,
      accountSubject: secrets.nostrPublicKeyHex,
      mintUrl: 'https://mint.example',
    })
    assert.equal(active.transferId, currentId)
    assert.equal(await coordinator.loadTransfer(retiredId), null)

    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: retiredId,
      accountSubject: secrets.nostrPublicKeyHex,
      mintUrl: 'https://mint.example',
      requestedAmount: '3000',
    })
    let remoteStatus = creditedRecipientStatus(
      createParticipationScoreDeliverySubmission({ metadata, token: 'cashuBabc123' }),
    )
    const consent: ScorePurchaseConsent = {
      request: {
        deliveryId: retiredId,
        scorePoints: 3,
        amountMsat: 3_000,
        purchasedTotalEpoch: 7,
        engineBaseUrl: 'https://engine.example',
        accountSubject: secrets.nostrPublicKeyHex,
        walletId: profile.walletScopeId.slice('custody:wallet:'.length),
        mintUrl: 'https://mint.example',
      },
      cost: { amountMsat: 3_000, sendPreparationFeeMsat: 1, totalWalletDebitMsat: 3_001 },
    }
    let scoreReads = 0
    let statusReads = 0
    let mintCalls = 0
    const engine: EngineClientLike = {
      ...testOrderEngine(),
      getParticipationScore: async () => {
        scoreReads += 1
        return scoreResponse({ pubkey: secrets.nostrPublicKeyHex, purchasedTotal: 8 })
      },
      getDurableRecipientDeliveryStatus: async () => {
        statusReads += 1
        return remoteStatus
      },
      submitDurableRecipientDelivery: async () => {
        throw new Error('retired status path must not submit a token')
      },
    }
    const response = await dispatch(
      { method: 'score.buy', params: { consent } },
      {
        getCustodyFence: () => fence!,
        createEngineClient: () => engine,
        createCashuWallet: () => {
          mintCalls += 1
          throw new Error('retired status path must not load a mint')
        },
        participationScoreOps: {
          quote: async () => {
            mintCalls += 1
            throw new Error('retired status path must not quote')
          },
          deliver: async () => {
            mintCalls += 1
            throw new Error('retired status path must not buy')
          },
        },
      },
    )
    assert.equal(response.ok, true)
    assert.equal((response.result as { state: string }).state, 'credited')
    assert.equal(statusReads, 1)
    assert.equal(scoreReads, 0)
    assert.equal(mintCalls, 0)

    remoteStatus = pendingRecipientStatus(
      createParticipationScoreDeliverySubmission({ metadata, token: 'cashuBabc123' }),
    ) as typeof remoteStatus
    const pending = await dispatch(
      { method: 'score.buy', params: { consent } },
      {
        getCustodyFence: () => fence!,
        createEngineClient: () => engine,
        createCashuWallet: () => {
          mintCalls += 1
          throw new Error('retired pending status must not load a mint')
        },
      },
    )
    assert.equal(pending.ok, true, JSON.stringify(pending))
    assert.equal((pending.result as { state: string }).state, 'pending')
    assert.equal(statusReads, 2)
    assert.equal(scoreReads, 0)
    assert.equal(mintCalls, 0)
  } finally {
    if (fence !== undefined) {
      await releaseCustodyScopeLease(home, fence, Date.now()).catch(() => undefined)
    }
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('standalone Score purchase binds consent and reuses authenticated recipient status', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-score-command-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let fence: Awaited<ReturnType<typeof claimCustodyScopeLease>> | undefined
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const secrets = await readSecrets()
    assert.ok(secrets)
    fence = await claimCustodyScopeLease(home, {
      scopeId: profile.walletScopeId,
      incarnationId: 'score-command-test',
      observedAtMs: Date.now(),
    })

    const deliveryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    let scoreReads = 0
    let statusReads = 0
    let deliverCalls = 0
    let failStatusRead = false
    let remoteStatus: ReturnType<typeof creditedRecipientStatus> | null = null
    let observedConsent: {
      maxWalletDebitMsat?: number
      requireExactRequest?: boolean
      retryOnly?: boolean
    } | null = null
    const engine: EngineClientLike = {
      ...testOrderEngine(),
      getParticipationScore: async () => {
        scoreReads += 1
        return scoreResponse({ pubkey: secrets.nostrPublicKeyHex, purchasedTotal: 7 })
      },
      getDurableRecipientDeliveryStatus: async () => {
        statusReads += 1
        if (failStatusRead) throw new Error('status transport failed')
        return remoteStatus
      },
      submitDurableRecipientDelivery: async () => {
        throw new Error('standalone status path must not submit directly')
      },
    }
    const deps = {
      getCustodyFence: () => fence!,
      createEngineClient: () => engine,
      participationScoreOps: {
        quote: async ({ amountMsat }: { amountMsat: number }) => ({
          amountMsat,
          sendPreparationFeeMsat: 2,
          totalWalletDebitMsat: amountMsat + 2,
        }),
        deliver: async (input: {
          maxWalletDebitMsat?: number
          requireExactRequest?: boolean
          retryOnly?: boolean
          deliveryId: string
          amountMsat: number
        }) => {
          deliverCalls += 1
          observedConsent = {
            maxWalletDebitMsat: input.maxWalletDebitMsat,
            requireExactRequest: input.requireExactRequest,
            retryOnly: input.retryOnly,
          }
          return {
            deliveryId: input.deliveryId,
            transferId: input.deliveryId,
            state: 'pending' as const,
          }
        },
      },
    }

    const quoteResponse = await dispatch(
      { method: 'score.quote', params: { deliveryId, scorePoints: 3 } },
      deps,
    )
    assert.equal(quoteResponse.ok, true)
    const consent = quoteResponse.result as ScorePurchaseConsent
    assert.deepEqual(consent, {
      request: {
        deliveryId,
        scorePoints: 3,
        amountMsat: 3_000,
        purchasedTotalEpoch: 7,
        engineBaseUrl: 'https://engine.example',
        accountSubject: secrets.nostrPublicKeyHex,
        walletId: profile.walletScopeId.slice('custody:wallet:'.length),
        mintUrl: 'https://mint.example',
      },
      cost: { amountMsat: 3_000, sendPreparationFeeMsat: 2, totalWalletDebitMsat: 3_002 },
    })

    const firstBuy = await dispatch({ method: 'score.buy', params: { consent } }, deps)
    assert.equal(firstBuy.ok, true)
    assert.deepEqual(observedConsent, {
      maxWalletDebitMsat: 3_002,
      requireExactRequest: true,
      retryOnly: false,
    })
    assert.equal(deliverCalls, 1)

    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId,
      accountSubject: secrets.nostrPublicKeyHex,
      mintUrl: 'https://mint.example',
      requestedAmount: '3000',
    })
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: 'cashuBabc123',
    })
    remoteStatus = pendingRecipientStatus(submission)

    const pendingRetry = await dispatch({ method: 'score.buy', params: { consent } }, deps)
    assert.equal(pendingRetry.ok, true)
    assert.equal((pendingRetry.result as { state: string }).state, 'pending')
    assert.deepEqual(observedConsent, {
      maxWalletDebitMsat: 3_002,
      requireExactRequest: true,
      retryOnly: true,
    })
    assert.equal(deliverCalls, 2)

    remoteStatus = creditedRecipientStatus(submission)

    const repeatedBuy = await dispatch({ method: 'score.buy', params: { consent } }, deps)
    assert.equal(repeatedBuy.ok, true)
    assert.equal((repeatedBuy.result as { state: string }).state, 'credited')
    assert.equal(deliverCalls, 2)
    const oldQuoteStatus = await dispatch({ method: 'score.status', params: { consent } }, deps)
    assert.equal(oldQuoteStatus.ok, true)
    assert.equal((oldQuoteStatus.result as { state: string }).state, 'credited')
    assert.equal(deliverCalls, 2)

    const wrongEngineConsent = {
      ...consent,
      request: { ...consent.request, engineBaseUrl: 'https://other-engine.example' },
    }
    const foreignContext = await dispatch(
      { method: 'score.buy', params: { consent: wrongEngineConsent } },
      deps,
    )
    assert.equal(foreignContext.ok, false)
    assert.equal(statusReads, 4)
    assert.equal(deliverCalls, 2)

    const foreignMetadata = createParticipationScoreDeliveryMetadata({
      deliveryId,
      accountSubject: secrets.nostrPublicKeyHex,
      mintUrl: 'https://mint.example',
      requestedAmount: '4000',
    })
    remoteStatus = creditedRecipientStatus(
      createParticipationScoreDeliverySubmission({
        metadata: foreignMetadata,
        token: 'cashuBabc123',
      }),
    )
    const mismatchedStatus = await dispatch({ method: 'score.buy', params: { consent } }, deps)
    assert.equal(mismatchedStatus.ok, false)
    assert.equal(deliverCalls, 2)

    remoteStatus = null
    failStatusRead = true
    const statusFailure = await dispatch({ method: 'score.buy', params: { consent } }, deps)
    assert.equal(statusFailure.ok, false)
    assert.match(statusFailure.error ?? '', /no new payment was started/)
    assert.equal(deliverCalls, 2)
    assert.equal(statusReads, 6)
    assert.equal(scoreReads, 2)
  } finally {
    if (fence !== undefined) {
      await releaseCustodyScopeLease(home, fence, Date.now()).catch(() => undefined)
    }
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

async function writeState(state: DaemonState): Promise<void> {
  for (const record of state.wallet.proofs) {
    const outcome =
      record.asset.kind === 'Outcome' || (record.asset as { kind?: unknown }).kind === 'outcome'
    record.asset = outcome
      ? {
          ...record.asset,
          kind: 'Outcome',
          baseAsset: 'sat',
          unit: 'msat',
        }
      : {
          ...record.asset,
          kind: 'sats',
          baseAsset: 'sat',
          unit: record.asset.unit === 'sat' ? 'sat' : 'msat',
        }
  }
  for (const order of Object.values(state.orders)) {
    order.baseAsset ??= 'sat'
    order.divisibility ??= 1_000
  }
  await persistState(state)
}

test('daemon dispatch rejects raw public FAK before custody or settlement work', async () => {
  let custodyReadyCalls = 0
  let engineCalls = 0
  let preparationCalls = 0
  const response = await dispatch(
    {
      method: 'order.submit',
      params: {
        marketId: 'cond-YES',
        outcomeId: 'YES',
        side: 'Buy',
        price: 420,
        amountSubunits: 1_000,
        timeInForce: 'FAK',
      },
    } as never,
    {
      isCustodyReady() {
        custodyReadyCalls += 1
        return true
      },
      createEngineClient() {
        engineCalls += 1
        throw new Error('FAK must be rejected before engine access')
      },
      prepareSettlementCapability: async () => {
        preparationCalls += 1
        throw new Error('FAK must be rejected before capability preparation')
      },
    },
  )

  assert.deepEqual(response, {
    ok: false,
    code: 'invalid-order-type',
    error: 'Order rejected: public orders require FOK',
  })
  assert.equal(custodyReadyCalls, 0)
  assert.equal(engineCalls, 0)
  assert.equal(preparationCalls, 0)
})

test('native oracle dispatch refuses unknown or differently configured creation before signing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-oracle-dispatch-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const command = {
      method: 'market.attest',
      params: { conditionId: 'ab'.repeat(32), outcome: 'Yes' },
    } as const
    assert.deepEqual(await dispatch(command), {
      ok: false,
      error: 'This profile did not create the oracle announcement.',
    })
    const store = createNativeOracleCreationStore(home)
    await store.reserveCreation({
      creationId: 'creation-1',
      eventId: 'event-1',
      canonicalInput: JSON.stringify({
        destination: { engineBaseUrl: 'https://other.example', relayUrls: ['wss://relay.example'] },
      }),
    })
    await store.persistAnnouncement('creation-1', {
      conditionId: command.params.conditionId,
      announcementTlvHex: 'aabb',
      announcementNostrEventJson: '{"kind":88}',
    })
    assert.deepEqual(await dispatch(command), {
      ok: false,
      error: 'Use the engine configured when this market was created.',
    })
    assert.equal((await store.readCreation('creation-1'))?.chosenOutcome, null)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('daemon dispatch persists wallet and order state', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-test-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'https://mint-a.example',
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
    })
    const profile = (await readProfile())!

    await t.test(
      'wallet.balance summarizes durable proof and custody state',
      async (balanceTest) => {
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord('https://mint-a.example', 100, 'available', {
            kind: 'sats',
            baseAsset: 'sat',
            unit: 'sat',
          }),
          {
            ...proofRecord('https://mint-a.example', 50_000, 'reserved', {
              kind: 'sats',
              baseAsset: 'sat',
              unit: 'msat',
            }),
            reservedBy: 'balance-test',
          },
          {
            ...proofRecord('https://mint-a.example', 25_000, 'locked', {
              kind: 'Outcome',
              conditionId: 'cond',
              outcomeSetId: 'YES',
              baseAsset: 'sat',
              unit: 'msat',
            }),
            reservedBy: 'balance-lock-test',
          },
        )
        await writeState(state)
        await insertCustodyBalanceProof({
          proofId: 'ab'.repeat(32),
          amount: 75_000,
          nut07State: 'UNSPENT',
          selectability: 'locked',
        })
        await insertCustodyBalanceProof({
          proofId: 'cd'.repeat(32),
          amount: 1_000_000,
          nut07State: 'SPENT',
          selectability: 'spent',
        })
        balanceTest.after(async () => {
          await withDaemonStateSqliteTransaction(profileDir(), (database) => {
            database.prepare('DELETE FROM custody_proofs').run()
          })
        })

        const result = await dispatch({ method: 'wallet.balance' })

        assert.equal(result.ok, true)
        assert.deepEqual(result.result, {
          totalAvailableSats: 100,
          totalReservedSats: 50,
          totalLockedSats: 100,
          byMint: [
            {
              mintUrl: 'https://mint-a.example',
              availableSats: 100,
              reservedSats: 50,
              lockedSats: 100,
            },
          ],
          outcomePositions: [
            {
              mintUrl: 'https://mint-a.example',
              conditionId: 'cond',
              outcomeSetId: 'YES',
              availableSats: 0,
              reservedSats: 0,
              lockedSats: 25,
            },
          ],
        })
      },
    )

    await t.test(
      'preflight collateral preparation opens sat markets with msat wallet unit',
      async () => {
        const priorState = await readState()
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            1_000,
            'available',
            { kind: 'sats', baseAsset: 'sat' },
            'msat-proof',
          ),
        )
        await writeState(state)

        const requestedUnits: Array<string | null | undefined> = []
        try {
          await assert.rejects(
            () =>
              splitAvailableMsatProofsForCtfCollateral(
                1_000,
                'https://mint-a.example',
                'preflight-msat-unit',
                secrets,
                {
                  createCashuWallet(_mintUrl, unit) {
                    requestedUnits.push(unit)
                    return {
                      async loadMint() {},
                      async receive() {
                        throw new Error('receive unused')
                      },
                      async send() {
                        throw new Error('send unused')
                      },
                    }
                  },
                },
                'sat',
              ),
            /cashu wallet does not support fee-aware proof selection/,
          )

          assert.deepEqual(requestedUnits, ['msat'])
        } finally {
          if (priorState) {
            await writeState(priorState)
          } else {
            await writeState(emptyDaemonState())
          }
        }
      },
    )

    await t.test('daemon.status returns redacted profile and state summary', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord(
          'https://mint-a.example',
          10,
          'available',
          { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
          'status-secret',
        ),
      )
      state.proofOperations['op-status'] = {
        operationId: 'op-status',
        kind: 'wallet-send',
        state: 'prepared',
        mintUrl: 'https://mint-a.example',
        inputs: [{ amount: 10, secret: 'operation-input-secret', C: 'C-status' }],
        outputs: {},
        metadata: {},
        createdAt: 1,
        updatedAt: 2,
      }
      state.orders['order-status'] = {
        orderId: 'order-status',
        marketId: 'cond-YES',
        status: 'resting',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      await writeState(state)

      const result = await dispatch({ method: 'daemon.status' })

      assert.equal(result.ok, true)
      assert.deepEqual(result.result, {
        profile,
        counts: {
          proofs: 1,
          proofOperations: 1,
          orders: 1,
        },
        wallet: {
          totalAvailableSats: 10,
          totalReservedSats: 0,
          totalLockedSats: 0,
          byMint: [
            {
              mintUrl: 'https://mint-a.example',
              availableSats: 10,
              reservedSats: 0,
              lockedSats: 0,
            },
          ],
          outcomePositions: [],
        },
      })
      const text = JSON.stringify(result.result)
      assert.doesNotMatch(text, /walletSeedHex|nostrSecretKeyHex/)
      assert.doesNotMatch(text, /status-secret|operation-input-secret/)
    })

    await t.test(
      'daemon state serializes native CTF proof operation amounts as numbers',
      async () => {
        const state = emptyDaemonState()
        state.proofOperations['ctf-native-op'] = {
          operationId: 'ctf-native-op',
          kind: 'conditional-keyset-swap',
          state: 'completed',
          mintUrl: 'https://mint-a.example',
          inputs: [{ id: CTF_KEYSET_ID, amount: 136n as never, secret: 'ctf-input', C: 'C-in' }],
          outputs: {
            lock: [
              {
                blindedMessage: { amount: 100n as never, id: CTF_KEYSET_ID, B_: 'B-lock' },
                blindingFactor: '01',
                secret: '02',
              },
            ],
          },
          metadata: { fees: 0n },
          resultProofs: {
            lock: [{ id: CTF_KEYSET_ID, amount: 100n as never, secret: 'ctf-lock', C: 'C-out' }],
          },
          createdAt: 1,
          updatedAt: 2,
        }

        await writeState(state)
        const restored = await readState()

        assert.equal(restored?.proofOperations['ctf-native-op']?.kind, 'conditional-keyset-swap')
        assert.equal(restored?.proofOperations['ctf-native-op']?.inputs[0].amount, 136)
        assert.equal(
          restored?.proofOperations['ctf-native-op']?.outputs.lock[0].blindedMessage.amount,
          100,
        )
        assert.equal(restored?.proofOperations['ctf-native-op']?.resultProofs?.lock[0].amount, 100)
      },
    )

    await t.test('wallet.receive binds exact durable authority before completeSwap', async () => {
      await writeState(emptyDaemonState())
      const keysetId = deriveKeysetId(
        { '1': `02${'11'.repeat(32)}` },
        { unit: 'msat', versionByte: 1 },
      )
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'msat',
        proofs: [{ ...cashuProof(7, 'token-secret'), id: keysetId }],
      })
      const fence = await claimCustodyScopeLease(profileDir(), {
        scopeId: deriveDurableCustodyScopeId({
          scopeKind: 'wallet',
          walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
        }),
        incarnationId: 'wallet-receive-bind-test',
        observedAtMs: Date.now(),
      })
      await reserveDaemonKeysetCounter(
        keysetId,
        1,
        { fence, observedAtMs: Date.now() },
        { normalizedMint: 'https://mint-a.example', unit: 'msat' },
      )
      let completeCalled = false
      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.receive', params: { token } },
            {
              getCustodyFence: () => fence,
              resolveMintKeysetIds: async () => [keysetId],
              resolveTokenImportKeysets: async () => ({
                freshness: 'fresh' as const,
                regularKeysets: [{ keysetId, unit: 'msat', active: true }],
                conditionalKeysets: [],
              }),
              createCashuWallet(mintUrl) {
                assert.equal(mintUrl, 'https://mint-a.example')
                const output = OutputData.createSingleData(
                  Amount.from(7),
                  keysetId,
                  'fresh-secret',
                  1n,
                )
                return {
                  async loadMint() {},
                  async receive() {
                    throw new Error('legacy receive must not be called')
                  },
                  async prepareSwapToReceive(receivedToken, config) {
                    assert.equal(receivedToken, token)
                    assert.deepEqual(config?.proofsWeHave, [])
                    config?.onCountersReserved?.({ keysetId, start: 0, count: 1 })
                    return {
                      amount: Amount.from(7),
                      fees: Amount.zero(),
                      keysetId,
                      inputs: [{ ...cashuProof(7, 'token-secret'), id: keysetId }],
                      keepOutputs: [output],
                    }
                  },
                  async completeSwap() {
                    completeCalled = true
                    const custodyRows = await withDaemonStateSqliteTransaction(
                      profileDir(),
                      (database) =>
                        database.prepare('SELECT operation_id FROM custody_operations').all(),
                    )
                    assert.equal(custodyRows.length, 1)
                    return { keep: [{ ...cashuProof(7, 'fresh-secret'), id: keysetId }], send: [] }
                  },
                  async checkProofsStates() {
                    return []
                  },
                  getKeyset() {
                    return {
                      id: keysetId,
                      unit: 'msat',
                      keys: { '1': `02${'11'.repeat(32)}` },
                      fee: 0,
                      verify: () => true,
                    }
                  },
                  async send() {
                    throw new Error('send unused')
                  },
                }
              },
            },
          ),
        /custody mint proof differs|Invalid point|proof/i,
      )
      assert.equal(completeCalled, true)
    })

    await t.test(
      'wallet.receive rejects sat tokens before keyset resolution or wallet work',
      async () => {
        await writeState(emptyDaemonState())
        const legacyKeysetId = `00${'b'.repeat(14)}`
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'sat',
          proofs: [{ ...cashuProof(7, 'legacy-ordinary-secret'), id: legacyKeysetId }],
        })
        let resolverCalls = 0
        let walletCreated = false
        await assert.rejects(
          () =>
            dispatch(
              { method: 'wallet.receive', params: { token } },
              {
                resolveTokenImportKeysets: async () => {
                  // Sat tokens must fail before this resolver is reached.
                  resolverCalls += 1
                  return {
                    freshness: 'fresh' as const,
                    regularKeysets: [{ keysetId: legacyKeysetId, unit: 'sat', active: true }],
                    conditionalKeysets: [],
                  }
                },
                createCashuWallet() {
                  walletCreated = true
                  throw new Error('wallet must not be created')
                },
              },
            ),
          /product-wallet token imports require msat/,
        )
        assert.equal(resolverCalls, 0)
        assert.equal(walletCreated, false)
        const counterRows = await withDaemonStateSqliteTransaction(
          profileDir(),
          (database) =>
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM target_keyset_counters
                 WHERE normalized_mint = ? AND unit = ? AND keyset_id = ?`,
              )
              .get('https://mint-a.example', 'sat', legacyKeysetId) as { count: number },
        )
        assert.equal(counterRows.count, 0)
      },
    )

    await t.test(
      'wallet.receive rejects resolved V1 proofs before wallet or counter work',
      async () => {
        await writeState(emptyDaemonState())
        const legacyKeysetId = `00${'b'.repeat(14)}`
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'msat',
          proofs: [{ ...cashuProof(7, 'legacy-msat-secret'), id: legacyKeysetId }],
        })
        let resolverCalls = 0
        let walletCreated = false
        await assert.rejects(
          () =>
            dispatch(
              { method: 'wallet.receive', params: { token } },
              {
                resolveTokenImportKeysets: async () => {
                  resolverCalls += 1
                  return {
                    freshness: 'fresh' as const,
                    regularKeysets: [{ keysetId: legacyKeysetId, unit: 'msat', active: true }],
                    conditionalKeysets: [],
                  }
                },
                createCashuWallet() {
                  walletCreated = true
                  throw new Error('wallet must not be created')
                },
              },
            ),
          /daemon wallet receive supports only V2 keysets/,
        )
        assert.equal(resolverCalls, 1)
        assert.equal(walletCreated, false)
        const counterRows = await withDaemonStateSqliteTransaction(
          profileDir(),
          (database) =>
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM target_keyset_counters
                 WHERE normalized_mint = ? AND unit = ? AND keyset_id = ?`,
              )
              .get('https://mint-a.example', 'msat', legacyKeysetId) as { count: number },
        )
        assert.equal(counterRows.count, 0)
      },
    )

    await t.test('wallet.receive can classify imported proofs as outcome tokens', async () => {
      const receiveState = emptyDaemonState()
      const legacyOnlyProof = proofRecord(
        'https://mint-a.example',
        13,
        'available',
        {
          kind: 'Outcome',
          conditionId: OUTCOME_CONDITION_ID,
          outcomeSetId: OUTCOME_COLLECTION,
          baseAsset: 'sat',
          unit: 'msat',
        },
        'legacy-only-outcome-secret',
      )
      legacyOnlyProof.proof.id = OUTCOME_KEYSET_ID
      receiveState.wallet.proofs.push(legacyOnlyProof)
      await writeState(receiveState)
      const proof = signedOutcomeProof(11, 'outcome-token-secret')
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'msat',
        proofs: [proof],
      })
      let beforeCommitCount = 0
      let interruptionObserved = false
      const simulatedInterruptedApply = (phase: StateSqliteFaultPhase) => {
        if (phase !== 'before-commit') return
        beforeCommitCount += 1
        if (beforeCommitCount === 3) {
          interruptionObserved = true
          throw new Error('simulated interrupted proof import')
        }
      }
      const { fence, dependencies } = await outcomeReceiveFixture(
        secrets.walletSeedHex,
        'UNSPENT',
        simulatedInterruptedApply,
      )
      try {
        const operationCountBefore = await genericReceiveOperationCount()
        const canonicalProofId = deriveDurableCustodyProofId({
          scopeId: fence.scopeId,
          normalizedMint: 'https://mint-a.example',
          unit: 'msat',
          keysetId: OUTCOME_KEYSET_ID,
          secret: proof.secret,
        })
        const request = {
          method: 'wallet.receive',
          params: { token, conditionId: OUTCOME_CONDITION_ID, outcomeSetId: OUTCOME_COLLECTION },
        }
        await assert.rejects(() => dispatch(request, dependencies()))
        assert.ok(interruptionObserved)
        const interruptedState = await readState()
        assert.equal(interruptedState?.wallet.proofs.length, 1)
        assert.equal(interruptedState?.wallet.proofs[0]?.proof.secret, 'legacy-only-outcome-secret')
        const interruptedCanonical = await withDaemonStateSqliteTransaction(
          profileDir(),
          (database) =>
            new DurableCustodySqliteStore(database).getProof(fence.scopeId, canonicalProofId),
        )
        assert.equal(interruptedCanonical, null)
        assert.equal(await genericReceiveOperationCount(), operationCountBefore + 1)
        const firstResponse = await dispatch(request, dependencies())
        const replayResponse = await dispatch(request, dependencies())

        assert.equal(firstResponse.ok, true)
        assert.deepEqual(replayResponse, firstResponse)
        assert.deepEqual(firstResponse.result, {
          mintUrl: 'https://mint-a.example',
          amountMsat: 11,
          proofCount: 1,
          asset: {
            kind: 'Outcome',
            conditionId: OUTCOME_CONDITION_ID,
            outcomeSetId: OUTCOME_COLLECTION,
            baseAsset: 'sat',
            unit: 'msat',
          },
          unit: 'msat',
          hasInactiveProofs: false,
        })
        const state = await readState()
        assert.equal(state?.wallet.proofs.length, 2)
        assert.deepEqual(state?.wallet.proofs[0]?.asset, {
          kind: 'Outcome',
          conditionId: OUTCOME_CONDITION_ID,
          outcomeSetId: OUTCOME_COLLECTION,
          baseAsset: 'sat',
          unit: 'msat',
        })
        assert.ok(
          state?.wallet.proofs.some(({ proof: item }) => item.secret === 'outcome-token-secret'),
        )
        const canonicalPage = await withDaemonStateSqliteTransaction(profileDir(), (database) =>
          readAvailableCanonicalWalletProofPageFromDatabase(database, {
            mintUrl: 'https://mint-a.example',
            keysetId: OUTCOME_KEYSET_ID,
            asset: {
              kind: 'Outcome',
              conditionId: OUTCOME_CONDITION_ID,
              outcomeSetId: OUTCOME_COLLECTION,
              baseAsset: 'sat',
              unit: 'msat',
            },
            limit: 10,
          }),
        )
        assert.deepEqual(
          canonicalPage.proofs.map(({ proof: item }) => item.secret),
          ['outcome-token-secret'],
        )
        const canonical = await withDaemonStateSqliteTransaction(profileDir(), (database) =>
          new DurableCustodySqliteStore(database).getProof(fence.scopeId, canonicalProofId),
        )
        assert.equal(canonical?.signatureVerified, true)
        assert.equal(canonical?.dleqState, 'verified')
        assert.equal(canonical?.nut07State, 'UNSPENT')
        assert.equal(canonical?.selectability, 'selectable')
        assert.equal(await genericReceiveOperationCount(), operationCountBefore + 1)
      } finally {
        await releaseCustodyScopeLease(profileDir(), fence, Date.now())
      }
    })

    await t.test(
      'wallet.receive preflights local conflicts across the complete paged outcome token',
      async () => {
        await writeState(emptyDaemonState())
        const { fence, dependencies } = await outcomeReceiveFixture(secrets.walletSeedHex)
        try {
          const proofs = Array.from({ length: 33 }, (_, index) =>
            signedDleqProof(
              OutputData.createSingleData(
                11,
                OUTCOME_KEYSET_ID,
                `paged-outcome-proof-${index}`,
                BigInt(index + 1),
              ),
              OUTCOME_PRIVATE_KEY,
              OUTCOME_KEYS,
            ),
          )
          const lastProof = [...proofs].sort((left, right) => {
            const proofId = (proof: Proof) =>
              deriveDurableCustodyProofId({
                scopeId: fence.scopeId,
                normalizedMint: 'https://mint-a.example',
                unit: 'msat',
                keysetId: proof.id!,
                secret: proof.secret,
              })
            return proofId(left).localeCompare(proofId(right))
          })[proofs.length - 1]!
          const wrongAsset = {
            kind: 'Outcome' as const,
            conditionId: OUTCOME_CONDITION_ID,
            outcomeSetId: 'NO',
            baseAsset: 'sat' as const,
            unit: 'msat' as const,
          }
          const conflictState = await readState()
          assert.ok(conflictState)
          conflictState.wallet.proofs.push({
            proof: lastProof,
            mintUrl: 'https://mint-a.example',
            state: 'available',
            asset: wrongAsset,
            createdAt: new Date(1).toISOString(),
            updatedAt: new Date(1).toISOString(),
          })
          await writeState(conflictState)
          await withDaemonStateSqliteTransaction(profileDir(), (database) => {
            const store = new DurableCustodySqliteStore(database)
            store.putProofCas(
              createCustodyProofSqliteRow({
                scopeId: fence.scopeId,
                normalizedMint: 'https://mint-a.example',
                unit: 'msat',
                proof: {
                  ...lastProof,
                  dleq: lastProof.dleq ?? null,
                  witness: lastProof.witness ?? null,
                  p2pkE: lastProof.p2pk_e ?? null,
                },
                baseAsset: 'sat',
                conditionId: OUTCOME_CONDITION_ID,
                outcomeSetId: 'NO',
                productBinding: null,
                signatureVerified: true,
                dleqState: 'verified',
                nut07State: 'UNSPENT',
                selectability: 'selectable',
                storageClass: 'pinned-operation-bound-deterministic',
                reservationOperationId: null,
                revision: 0,
                nowMs: 1,
              }),
              null,
            )
          })

          const snapshot = () =>
            withDaemonStateSqliteTransaction(profileDir(), (database) => ({
              target: database
                .prepare('SELECT * FROM target_wallet_proofs ORDER BY proof_id')
                .all(),
              canonical: database.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
            }))
          const before = await snapshot()
          const operationCountBefore = await genericReceiveOperationCount()
          const token = getEncodedToken({
            mint: 'https://mint-a.example',
            unit: 'msat',
            proofs,
          })

          await assert.rejects(
            () =>
              dispatch(
                {
                  method: 'wallet.receive',
                  params: {
                    token,
                    conditionId: OUTCOME_CONDITION_ID,
                    outcomeSetId: OUTCOME_COLLECTION,
                  },
                },
                dependencies(),
              ),
            /conflicts with local wallet authority/,
          )

          assert.deepEqual(await snapshot(), before)
          assert.equal(await genericReceiveOperationCount(), operationCountBefore)
        } finally {
          await releaseCustodyScopeLease(profileDir(), fence, Date.now())
        }
      },
    )

    await t.test(
      'wallet.receive rejects non-V2 outcome proof keysets before wallet I/O',
      async () => {
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'msat',
          proofs: [{ ...cashuProof(11, 'legacy-outcome-secret'), id: V1_KEYSET_ID }],
        })
        let walletCreated = false
        await assert.rejects(
          () =>
            dispatch(
              {
                method: 'wallet.receive',
                params: { token, conditionId: 'cond', outcomeSetId: 'YES' },
              },
              {
                resolveTokenImportKeysets: async () => ({
                  freshness: 'fresh' as const,
                  regularKeysets: [],
                  conditionalKeysets: [{ keysetId: V1_KEYSET_ID, unit: 'msat', active: true }],
                }),
                createCashuWallet() {
                  walletCreated = true
                  throw new Error('wallet must not be created')
                },
              },
            ),
          /daemon wallet receive supports only V2 keysets/,
        )
        assert.equal(walletCreated, false)
      },
    )

    await t.test(
      'wallet.receive rejects spent outcome-token proofs before persistence',
      async () => {
        await writeState(emptyDaemonState())
        const proof = signedOutcomeProof(11, 'spent-outcome-secret')
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'msat',
          proofs: [proof],
        })
        const { fence, dependencies } = await outcomeReceiveFixture(secrets.walletSeedHex, 'SPENT')
        try {
          await assert.rejects(
            () =>
              dispatch(
                {
                  method: 'wallet.receive',
                  params: {
                    token,
                    conditionId: OUTCOME_CONDITION_ID,
                    outcomeSetId: OUTCOME_COLLECTION,
                  },
                },
                dependencies(),
              ),
            /cashu outcome proof is not spendable: SPENT/,
          )
          assert.deepEqual((await readState())?.wallet.proofs, [])
          const canonicalProofId = deriveDurableCustodyProofId({
            scopeId: fence.scopeId,
            normalizedMint: 'https://mint-a.example',
            unit: 'msat',
            keysetId: OUTCOME_KEYSET_ID,
            secret: proof.secret,
          })
          const canonical = await withDaemonStateSqliteTransaction(profileDir(), (database) =>
            new DurableCustodySqliteStore(database).getProof(fence.scopeId, canonicalProofId),
          )
          assert.equal(canonical, null)
        } finally {
          await releaseCustodyScopeLease(profileDir(), fence, Date.now())
        }
      },
    )

    await t.test(
      'wallet.receive rejects outcome proofs without DLEQ before persistence',
      async () => {
        await writeState(emptyDaemonState())
        const { dleq: _dleq, ...proofWithoutDleq } = signedOutcomeProof(
          11,
          'outcome-without-dleq-secret',
        )
        const token = getEncodedToken({
          mint: 'https://mint-a.example',
          unit: 'msat',
          proofs: [proofWithoutDleq as Proof],
        })
        const { fence, dependencies } = await outcomeReceiveFixture(secrets.walletSeedHex)
        try {
          await assert.rejects(
            () =>
              dispatch(
                {
                  method: 'wallet.receive',
                  params: {
                    token,
                    conditionId: OUTCOME_CONDITION_ID,
                    outcomeSetId: OUTCOME_COLLECTION,
                  },
                },
                dependencies(),
              ),
            /cashu outcome proof cryptographic verification failed/,
          )
          assert.deepEqual((await readState())?.wallet.proofs, [])
          const canonicalProofId = deriveDurableCustodyProofId({
            scopeId: fence.scopeId,
            normalizedMint: 'https://mint-a.example',
            unit: 'msat',
            keysetId: OUTCOME_KEYSET_ID,
            secret: proofWithoutDleq.secret,
          })
          const canonical = await withDaemonStateSqliteTransaction(profileDir(), (database) =>
            new DurableCustodySqliteStore(database).getProof(fence.scopeId, canonicalProofId),
          )
          assert.equal(canonical, null)
        } finally {
          await releaseCustodyScopeLease(profileDir(), fence, Date.now())
        }
      },
    )

    await t.test('wallet.receive rejects partial outcome metadata', async () => {
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'msat',
        proofs: [cashuProof(7, 'partial-outcome-secret')],
      })

      await assert.rejects(
        () =>
          dispatch(
            {
              method: 'wallet.receive',
              params: { token, conditionId: 'cond' },
            },
            {
              resolveTokenImportKeysets: tokenImportKeysetResolver('conditional', 'msat'),
            },
          ),
        /conditionId and outcomeSetId must be supplied together/,
      )
    })

    await t.test('wallet.receive rejects tokens for unexpected mints', async () => {
      let resolverCalls = 0
      const token = getEncodedToken({
        mint: 'https://unexpected-mint.example',
        unit: 'msat',
        proofs: [cashuProof(7, 'unexpected-mint-secret')],
      })

      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.receive', params: { token } },
            {
              resolveTokenImportKeysets: async (request) => {
                resolverCalls += 1
                return tokenImportKeysetResolver('regular', 'msat')(request)
              },
            },
          ),
        /allowed canonical mint set/,
      )
      assert.equal(resolverCalls, 0)
    })

    await t.test('wallet.receive rejects unsupported units byte-identically', async () => {
      let resolverCalls = 0
      const token = getEncodedToken({
        mint: 'https://mint-a.example',
        unit: 'usd' as never,
        proofs: [cashuProof(7, 'unsupported-unit-secret')],
      })
      const before = await profileFileSnapshot(home)

      await assert.rejects(
        () =>
          dispatch(
            { method: 'wallet.receive', params: { token } },
            {
              resolveTokenImportKeysets: async () => {
                resolverCalls += 1
                throw new Error('unsupported units must fail before keyset resolution')
              },
            },
          ),
        /unsupported.*unit/i,
      )

      assert.equal(resolverCalls, 0)
      assert.deepEqual(await profileFileSnapshot(home), before)
    })

    await t.test('wallet.send requires strict custody authority', async () => {
      await assert.rejects(
        () =>
          dispatch({
            method: 'wallet.send',
            params: { amountMsat: 5, mintUrl: 'https://mint-a.example' },
          }),
        /requires custody authority/,
      )
    })

    await t.test('wallet.send rejects an unsafe outgoing amount before custody work', async () => {
      await assert.rejects(
        () =>
          dispatch({
            method: 'wallet.send',
            params: { amountMsat: Number.MAX_SAFE_INTEGER + 1, mintUrl: 'https://mint-a.example' },
          }),
        /positive safe integer/,
      )
    })

    await t.test('wallet.send uses a leased strict-custody path for a V2 DLEQ proof', async () => {
      const privateKey = Uint8Array.from([...new Uint8Array(31), 9])
      const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
      const keys = { '1': publicKey, '2': publicKey, '4': publicKey, '8': publicKey }
      const keysetId = deriveKeysetId(keys, { unit: 'msat', versionByte: 1 })
      const input = signedDleqProof(
        OutputData.createSingleData(8, keysetId, 'strict-send-input', 1n),
        privateKey,
        keys,
      )
      let sent: Proof[] = []
      let kept: Proof[] = []
      const scopeId = deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
      })
      const fence = await claimCustodyScopeLease(profileDir(), {
        scopeId,
        incarnationId: 'wallet-receive-bind-test',
        observedAtMs: Date.now(),
      })
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord(
          'https://mint-a.example',
          8,
          'available',
          { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
          input.secret,
        ),
      )
      state.wallet.proofs[0]!.proof = input
      await writeState(state)
      await withDurableCustodyUnitOfWork(profileDir(), fence, Date.now(), (database) => {
        const row = createCustodyProofSqliteRow({
          scopeId,
          normalizedMint: 'https://mint-a.example',
          unit: 'msat',
          proof: input,
          baseAsset: 'sat',
          conditionId: null,
          outcomeSetId: null,
          productBinding: null,
          signatureVerified: true,
          dleqState: 'verified',
          nut07State: 'UNSPENT',
          selectability: 'selectable',
          storageClass: 'pinned-operation-bound-deterministic',
          reservationOperationId: null,
          revision: 0,
          nowMs: Date.now(),
        })
        new DurableCustodySqliteStore(database).putProofBatchCas([
          { proof: row, expectedRevision: null },
        ])
      })
      let completeCalls = 0
      const response = await dispatch(
        {
          method: 'wallet.send',
          params: {
            amountMsat: 5,
            mintUrl: 'https://mint-a.example',
            operationId: 'strict-wallet-send',
          },
        },
        {
          getCustodyFence: () => fence,
          createCashuWallet: () => ({
            loadMint: async () => {},
            receive: async () => [],
            send: async () => ({ keep: [], send: [] }),
            prepareSwapToSend: async (_amount, proofs, config) => {
              assert.equal(proofs.length, 1)
              assert.equal(proofs[0]?.secret, input.secret)
              const { sendOutputs, keepOutputs } = await deterministicDispatchOutputs({
                walletSeedHex: secrets.walletSeedHex,
                fence,
                keysetId,
                sendAmounts: [4, 1],
                keepAmounts: [2, 1],
                config,
              })
              sent = sendOutputs.map((output) => signedDleqProof(output, privateKey, keys))
              kept = keepOutputs.map((output) => signedDleqProof(output, privateKey, keys))
              return {
                amount: Amount.from(5),
                fees: Amount.zero(),
                keysetId,
                inputs: proofs,
                sendOutputs,
                keepOutputs,
                unselectedProofs: [],
              }
            },
            completeSwap: async () => {
              completeCalls += 1
              return { keep: kept, send: sent }
            },
            checkProofsStates: async () => [],
            getKeyset: () => ({ id: keysetId, unit: 'msat', keys, fee: 0, verify: () => true }),
          }),
          restoreOutputGroups: async (_mintUrl, outputs) => {
            assert.deepEqual(Object.keys(outputs).sort(), ['keep', 'send'])
            return { keep: kept, send: sent }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal(completeCalls, 1)
      assert.equal((response.result as { proofCount: number }).proofCount, 2)
    })

    await t.test(
      'order.submit bounds delayed Score credit, preserves one delivery identity, and retires it after the purchase epoch advances',
      async () => {
        const privateKey = Uint8Array.from([...new Uint8Array(31), 9])
        const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
        const keys = {
          '1': publicKey,
          '2': publicKey,
          '4': publicKey,
          '8': publicKey,
          '1000': publicKey,
          '2000': publicKey,
          '4000': publicKey,
          '8000': publicKey,
        }
        const keysetId = deriveKeysetId(keys, { unit: 'msat', versionByte: 1 })
        const scopeId = deriveDurableCustodyScopeId({
          scopeKind: 'wallet',
          walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
        })
        const fence = await claimCustodyScopeLease(profileDir(), {
          scopeId,
          incarnationId: 'wallet-receive-bind-test',
          observedAtMs: Date.now(),
        })
        const input = signedDleqProof(
          OutputData.createSingleData(8_000, keysetId, 'score-input', 19n),
          privateKey,
          keys,
        )
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            8_000,
            'available',
            { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
            input.secret,
          ),
        )
        state.wallet.proofs[0]!.proof = input
        await writeState(state)
        await withDurableCustodyUnitOfWork(profileDir(), fence, Date.now(), (database) => {
          const row = createCustodyProofSqliteRow({
            scopeId,
            normalizedMint: 'https://mint-a.example',
            unit: 'msat',
            proof: input,
            baseAsset: 'sat',
            conditionId: null,
            outcomeSetId: null,
            productBinding: null,
            signatureVerified: true,
            dleqState: 'verified',
            nut07State: 'UNSPENT',
            selectability: 'selectable',
            storageClass: 'pinned-operation-bound-deterministic',
            reservationOperationId: null,
            revision: 0,
            nowMs: Date.now(),
          })
          new DurableCustodySqliteStore(database).putProofBatchCas([
            { proof: row, expectedRevision: null },
          ])
        })
        let scoreProofs: Proof[] = []
        let scoreKeepProofs: Proof[] = []
        let completed = 0
        let deliveries = 0
        let deliveryId: string | null = null
        let scoreReads = 0
        let recoveryWakes = 0
        let pendingScoreDelivery: DurableRecipientDeliverySubmission | null = null
        let deliveryRetryWaits = 0
        const deliveryRetryAttempts: number[] = []
        const deliveryRetryDelays: number[] = []
        const submittedDeliveryIds: string[] = []
        const submittedStates: string[] = []
        const observedStates: string[] = []
        const observedDeliveryIds: string[] = []
        let creditAvailable = false
        let deliveryStatusReads = 0
        const command = {
          method: 'order.submit' as const,
          params: withFeeConsent({
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy' as const,
            price: 100,
            amountSubunits: 1_000,
            timeInForce: 'FOK' as const,
          }),
        }
        const dispatchDeps = {
          getCustodyFence: () => fence,
          createCashuWallet: () => ({
            loadMint: async () => {},
            receive: async () => [],
            send: async () => ({ keep: [], send: [] }),
            prepareSwapToSend: async (amount, proofs, config) => {
              assert.equal(amount, 2_000)
              assert.equal(proofs.length, 1)
              assert.equal(Number(proofs[0]?.amount), 8_000)
              const { sendOutputs: scoreOutputs, keepOutputs: scoreKeepOutputs } =
                await deterministicDispatchOutputs({
                  walletSeedHex: secrets.walletSeedHex,
                  fence,
                  keysetId,
                  sendAmounts: [1_000, 1_000],
                  keepAmounts: [2_000, 4_000],
                  config,
                })
              scoreProofs = scoreOutputs.map((output) => signedDleqProof(output, privateKey, keys))
              scoreKeepProofs = scoreKeepOutputs.map((output) =>
                signedDleqProof(output, privateKey, keys),
              )
              return {
                amount: Amount.from(2_000),
                fees: Amount.zero(),
                keysetId,
                inputs: proofs,
                sendOutputs: scoreOutputs,
                keepOutputs: scoreKeepOutputs,
                unselectedProofs: [],
              }
            },
            completeSwap: async () => {
              completed += 1
              return { keep: scoreKeepProofs, send: scoreProofs }
            },
            checkProofsStates: async () => [],
            getKeyset: () => ({ id: keysetId, unit: 'msat', keys, fee: 0, verify: () => true }),
          }),
          restoreOutputGroups: async () => ({ keep: scoreKeepProofs, send: scoreProofs }),
          triggerCustodyRecovery: () => {
            recoveryWakes += 1
          },
          createEngineClient: () => ({
            ...scoreDisabledEngineMethods,
            getParticipationScore: async () => {
              scoreReads += 1
              return scoreReads <= 4
                ? scoreResponse({ balance: -1 })
                : scoreResponse({ balance: 1, purchasedTotal: 2 })
            },
            getDurableRecipientDeliveryStatus: async (requestedDeliveryId) => {
              if (pendingScoreDelivery === null) return null
              assert.equal(requestedDeliveryId, pendingScoreDelivery.deliveryId)
              const status = creditAvailable
                ? creditedRecipientStatus(pendingScoreDelivery)
                : receivedRecipientStatus(pendingScoreDelivery)
              deliveryStatusReads += 1
              observedStates.push(status.state)
              observedDeliveryIds.push(status.delivery.deliveryId)
              return status
            },
            submitDurableRecipientDelivery: async (submission) => {
              deliveries += 1
              deliveryId = submission.deliveryId
              pendingScoreDelivery = submission
              submittedDeliveryIds.push(submission.deliveryId)
              submittedStates.push('pending')
              assert.equal(submission.requestedAmount, '2000')
              assert.match(submission.token, /^cashu/)
              return pendingRecipientStatus(submission)
            },
            submitOrder: async () => ({
              orderId: 'score-paid-order',
              status: 'resting',
              remainingAmountSubunits: 1_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 1_000,
              activeSettlementGroup: null,
            }),
          }),
          prepareSettlementCapability: prepareSettlementCapability('score-paid-order'),
          waitForParticipationScoreDeliveryRetry: async (attempt, delayMs) => {
            deliveryRetryWaits += 1
            deliveryRetryAttempts.push(attempt)
            deliveryRetryDelays.push(delayMs)
          },
        }

        const pendingDelivery = await dispatch(command, dispatchDeps)
        assert.equal(pendingDelivery.ok, false)
        assert.match(pendingDelivery.error ?? '', /preparation is uncertain/)
        assert.ok(pendingDelivery.clientOrderId)
        assert.equal(deliveryStatusReads, 10)
        assert.deepEqual(deliveryRetryAttempts, [1, 2, 3, 4, 5, 6, 7, 8, 9])
        assert.deepEqual(deliveryRetryDelays, Array(9).fill(8_000))
        assert.deepEqual(submittedStates, ['pending'])
        assert.deepEqual(observedStates, Array(10).fill('received'))
        creditAvailable = true
        const pendingCredit = await dispatch(command, dispatchDeps)
        assert.equal(pendingCredit.ok, false)
        assert.match(pendingCredit.error ?? '', /preparation is uncertain/)
        assert.ok(pendingCredit.clientOrderId)
        const response = await dispatch(command, dispatchDeps)

        assert.equal(response.ok, true, JSON.stringify(response))
        assert.equal(completed, 1)
        assert.equal(deliveries, 1)
        assert.equal(deliveryRetryWaits, 9)
        assert.equal(recoveryWakes, 3)
        assert.equal(
          (response.result as { participationScore: { kind: string } }).participationScore.kind,
          'paid',
        )
        assert.ok(deliveryId)
        assert.deepEqual(submittedDeliveryIds, [deliveryId])
        assert.deepEqual(observedDeliveryIds, [...Array(10).fill(deliveryId), deliveryId])
        assert.equal(observedStates.at(-1), 'credited')
        const restarted = new DaemonDurableOutgoingCashuCoordinator(profileDir(), () => fence)
        await restarted.preflightParticipationScoreDelivery({
          transferId: 'f4444444-4444-4444-8444-444444444444',
          amountMsat: 1_000,
          purchasedTotal: 2,
          accountSubject: secrets.nostrPublicKeyHex,
          mintUrl: 'https://mint-a.example',
        })
        assert.equal(await restarted.loadTransfer(deliveryId), null)
      },
    )

    await t.test('wallet.recover delegates manual recovery to wallet operations', async () => {
      await writeState(emptyDaemonState())

      const response = await dispatch({ method: 'wallet.recover' })

      assert.deepEqual(response, {
        ok: true,
        result: { recovered: [], pending: [] },
      })
    })

    await t.test('wallet.operations lists redacted proof operation summaries', async () => {
      const state = emptyDaemonState()
      state.proofOperations['op-a'] = {
        operationId: 'op-a',
        kind: 'wallet-send',
        state: 'prepared',
        mintUrl: 'https://mint-a.example',
        inputs: [
          { amount: 2, secret: 'input-secret-a', C: 'C-a' },
          { amount: 3, secret: 'input-secret-b', C: 'C-b' },
        ],
        outputs: {
          send: [
            {
              blindedMessage: { amount: 5, id: TEST_KEYSET_ID, B_: 'B-a' },
              blindingFactor: 'blind-secret-a',
              secret: 'output-secret-a',
            },
          ],
          keep: [],
        },
        metadata: { note: 'not returned' },
        createdAt: 10,
        updatedAt: 20,
      }
      const completedResults = {
        YES: [{ id: TEST_KEYSET_ID, amount: 8, secret: 'result-secret', C: 'C-result' }],
      }
      state.proofOperations['op-b'] = {
        operationId: 'op-b',
        kind: 'ctf-split',
        state: 'completed',
        mintUrl: 'mint-b',
        inputs: [{ amount: 8, secret: 'input-secret-c', C: 'C-c' }],
        outputs: {},
        metadata: {},
        resultProofs: completedResults,
        resultProofsDigest: completedProofAuthorityDigest(
          completedResults as Record<string, Proof[]>,
        ),
        lastError: null,
        createdAt: 30,
        updatedAt: 40,
      }
      await writeState(state)

      const all = await dispatch({ method: 'wallet.operations', params: {} })
      assert.equal(all.ok, true)
      assert.deepEqual(
        (all.result as Array<{ operationId: string }>).map((operation) => operation.operationId),
        ['op-b', 'op-a'],
      )
      assert.doesNotMatch(JSON.stringify(all.result), /secret|blind-secret/)

      const filtered = await dispatch({
        method: 'wallet.operations',
        params: { kind: 'wallet-send', state: 'prepared' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, [
        {
          operationId: 'op-a',
          kind: 'wallet-send',
          state: 'prepared',
          mintUrl: 'https://mint-a.example',
          inputAmountSats: 5,
          inputCount: 2,
          outputCounts: { send: 1, keep: 0 },
          resultProofCounts: {},
          lastError: null,
          createdAt: 10,
          updatedAt: 20,
        },
      ])
    })

    await t.test(
      'order.submit prepares a capability and submits only its bound reference',
      async () => {
        const timeline: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
        await writeState(backedDaemonState('cond', 1_000_000))
        let capturedOptions: { baseUrl: string; nostrSecretKeyHex: string } | null = null
        let capturedRequest: unknown = null
        let capturedPreparation: PrepareSettlementCapabilityInput | null = null
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            capturedRequest = request
            return {
              orderId: 'order-1',
              status: 'resting',
              remainingAmountSubunits: 20_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 1_000,
              activeSettlementGroup: null,
            }
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 2_000,
              minimumFillAmountSubunits: 1_000,
              consolidateProofs: true,
              timeInForce: 'FOK',
            }),
          },
          {
            createEngineClient(options) {
              capturedOptions = options
              return engine
            },
            prepareSettlementCapability: prepareSettlementCapability('order-1', (input) => {
              capturedPreparation = input
            }),
            observeOrderTimeline: (observation) => {
              timeline.push(observation)
              throw new Error('observer unavailable')
            },
          },
        )

        assert.equal(response.ok, true)
        assert.deepEqual(
          timeline.map(({ phase, outcome }) => [phase, outcome]),
          [
            ['order-submit', 'success'],
            ['submitted-record', 'success'],
          ],
        )
        assert.equal(
          timeline.every(({ orderId }) => orderId === 'order-1'),
          true,
        )
        assert.equal(
          timeline.every(({ groupId }) => groupId === null),
          true,
        )
        assert.equal(timeline[0]!.endedUtc <= timeline[1]!.startedUtc, true)
        assert.deepEqual(capturedOptions, {
          baseUrl: 'http://localhost:5000',
          nostrSecretKeyHex: secrets.nostrSecretKeyHex,
        })
        assert.deepEqual(capturedRequest, {
          settlementCapability: {
            artifactId: '00000000-0000-4000-8000-000000000001',
            bindingDigest: 'ab'.repeat(32),
          },
          comment: null,
        })
        assert.match(
          (capturedPreparation as unknown as { clientOrderId: string }).clientOrderId,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        )
        assert.deepEqual(capturedPreparation, {
          clientOrderId: (capturedPreparation as unknown as { clientOrderId: string })
            .clientOrderId,
          marketId: 'cond-YES',
          conditionId: 'cond',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 420,
          maxQuotePaymentSubunits: 840,
          minQuotePaymentSubunits: null,
          amountSubunits: 2_000,
          minimumFillAmountSubunits: 1_000,
          consolidateProofs: true,
          baseAsset: 'sat',
          collateralUnit: 'msat',
          divisibility: 1_000,
          timeInForce: 'FOK',
          expiresAt: null,
          mintUrl: 'https://mint-a.example',
          walletSeedHex: secrets.walletSeedHex,
        })

        const state = await readState()
        assert.equal(
          state?.orders['order-1']?.clientOrderId,
          (capturedPreparation as unknown as { clientOrderId: string }).clientOrderId,
        )
      },
    )

    await t.test(
      'order.submit validates D=1000000 prices using engine market metadata',
      async () => {
        await writeState(backedDaemonState('cond', 1_000_000))
        let capturedRequest: unknown = null
        let capturedPreparation: PrepareSettlementCapabilityInput | null = null
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            capturedRequest = request
            return {
              orderId: 'order-d1000000',
              status: 'resting',
              remainingAmountSubunits: 1_000_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 1_000_000,
              activeSettlementGroup: null,
            }
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
          async getMarket() {
            return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000_000 }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 500_000,
              amountSubunits: 1_000_000,
              timeInForce: 'FOK',
            }),
          },
          {
            createEngineClient() {
              return engine
            },
            prepareSettlementCapability: prepareSettlementCapability('order-d1000000', (input) => {
              capturedPreparation = input
            }),
          },
        )

        assert.equal(response.ok, true, response.error)
        assert.deepEqual(capturedRequest, {
          settlementCapability: {
            artifactId: '00000000-0000-4000-8000-000000000001',
            bindingDigest: 'ab'.repeat(32),
          },
          comment: null,
        })
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).divisibility,
          1_000_000,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).price,
          500_000,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput)
            .minimumFillAmountSubunits,
          1_000_000,
        )
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).consolidateProofs,
          false,
        )
      },
    )

    await t.test(
      'order.submit delegates source authority to the exact native planner',
      async () => {
        await writeState(emptyDaemonState())
        let submitCalls = 0
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder() {
            submitCalls += 1
            throw new Error('submitOrder should be gated before POST')
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
          async getMarket() {
            return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000_000 }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 500_000,
              amountSubunits: 2_000_000,
              timeInForce: 'FOK',
            }),
          },
          { createEngineClient: () => engine },
        )

        assert.equal(response.ok, false)
        assert.equal(response.error, 'daemon settlement capability coordinator is unavailable')
        assert.equal(submitCalls, 0)
        assert.deepEqual((await readState())?.orders, {})
      },
    )

    await t.test('order.submit allows POST when local buy collateral is sufficient', async () => {
      const state = emptyDaemonState()
      state.wallet.proofs.push(
        proofRecord(
          'https://mint-a.example',
          1_000_000,
          'available',
          {
            kind: 'sats',
            baseAsset: 'sat',
          },
          'base-collateral',
        ),
      )
      await writeState(state)
      let capturedRequest: unknown = null
      let capturedPreparation: PrepareSettlementCapabilityInput | null = null
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          capturedRequest = request
          return {
            orderId: 'order-backed',
            status: 'resting',
            remainingAmountSubunits: 2_000_000,
            fills: [],
            baseAsset: 'sat',
            divisibility: 1_000_000,
            activeSettlementGroup: null,
          }
        },
        async getOrderStatus() {
          return null
        },
        async cancelOrder() {
          throw new Error('cancelOrder unused')
        },
        async getOrderBook() {
          throw new Error('getOrderBook unused')
        },
        async queryMarkets() {
          return { markets: [], nextCursor: null }
        },
        async getMarket() {
          return { conditionId: 'cond', baseAsset: 'sat', divisibility: 1_000_000 }
        },
      }

      const response = await dispatch(
        {
          method: 'order.submit',
          params: withFeeConsent({
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 500_000,
            amountSubunits: 2_000_000,
            timeInForce: 'FOK',
          }),
        },
        {
          createEngineClient: () => engine,
          prepareSettlementCapability: prepareSettlementCapability('order-backed', (input) => {
            capturedPreparation = input
          }),
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedRequest, {
        settlementCapability: {
          artifactId: '00000000-0000-4000-8000-000000000001',
          bindingDigest: 'ab'.repeat(32),
        },
        comment: null,
      })
      assert.equal(
        (capturedPreparation as unknown as PrepareSettlementCapabilityInput).amountSubunits,
        2_000_000,
      )
      assert.equal((await readState())?.orders['order-backed']?.orderId, 'order-backed')
    })

    await t.test('order.submit binds complement intent and tracks its lifecycle', async () => {
      const priorState = await readState()
      await writeState(backedDaemonState())
      try {
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder(_marketId, request) {
            return {
              orderId: 'order-complement',
              status: 'resting',
              remainingAmountSubunits: 1_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 1_000,
              activeSettlementGroup: null,
            }
          },
          async getOrderStatus() {
            throw new Error('getOrderStatus unused')
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            throw new Error('queryMarkets unused')
          },
        }
        let preparedTokenSide: 'Outcome' | 'Complement' | undefined

        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              tokenSide: 'Complement',
              side: 'Buy',
              price: 990,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            }),
          },
          {
            createEngineClient() {
              return engine
            },
            prepareSettlementCapability: prepareSettlementCapability(
              'order-complement',
              (input) => {
                preparedTokenSide = input.tokenSide
              },
            ),
          },
        )

        assert.equal(response.ok, true, response.error)
        assert.equal(preparedTokenSide, 'Complement')
        assert.equal((await readState())?.orders['order-complement']?.tokenSide, 'Complement')
      } finally {
        if (priorState) await writeState(priorState)
      }
    })

    await t.test('order.submit propagates engine machine-code rejections', async () => {
      const priorState = await readState()
      await writeState(backedDaemonState())
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder() {
          throw new EngineClientError(
            400,
            '{"code":"InvalidOutcome","detail":"OutcomeId must match the primitive outcome segment of marketId."}',
            'InvalidOutcome',
            'OutcomeId must match the primitive outcome segment of marketId.',
          )
        },
        async getOrderStatus() {
          return null
        },
        async cancelOrder() {
          throw new Error('cancelOrder unused')
        },
        async getOrderBook() {
          throw new Error('getOrderBook unused')
        },
        async queryMarkets() {
          return { markets: [], nextCursor: null }
        },
      }

      let markedRejected = false
      const response = await dispatch(
        {
          method: 'order.submit',
          params: withFeeConsent({
            marketId: 'cond-Bob',
            outcomeId: 'Bob',
            side: 'Buy',
            price: 420,
            amountSubunits: 1_000,
            timeInForce: 'FOK',
          }),
        },
        {
          createEngineClient() {
            return engine
          },
          prepareSettlementCapability: prepareSettlementCapability(
            'order-rejected',
            undefined,
            () => {
              markedRejected = true
            },
          ),
        },
      )

      assert.equal(response.ok, false)
      assert.equal(response.code, 'InvalidOutcome')
      assert.equal(response.error, 'Order submission was rejected')
      assert.equal(markedRejected, true)
      assert.deepEqual((await readState())?.orders, {})
      if (priorState) await writeState(priorState)
    })

    await t.test(
      'order.submit retains a prepared capability after a retryable 409 conflict',
      async () => {
        const priorState = await readState()
        await writeState(backedDaemonState())
        let markedRejected = false
        let recoveryTriggers = 0
        const engine: EngineClientLike = {
          ...scoreDisabledEngineMethods,
          async submitOrder() {
            throw new EngineClientError(
              409,
              'Order book changed while submitting order; retry the request.',
              undefined,
              'Order book changed while submitting order; retry the request.',
            )
          },
          async getOrderStatus() {
            return null
          },
          async cancelOrder() {
            throw new Error('cancelOrder unused')
          },
          async getOrderBook() {
            throw new Error('getOrderBook unused')
          },
          async queryMarkets() {
            return { markets: [], nextCursor: null }
          },
        }

        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-Bob',
              outcomeId: 'Bob',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            }),
          },
          {
            createEngineClient: () => engine,
            prepareSettlementCapability: prepareSettlementCapability(
              'order-retryable',
              undefined,
              () => {
                markedRejected = true
              },
            ),
            triggerSettlementRecovery: () => {
              recoveryTriggers += 1
            },
          },
        )

        assert.equal(response.ok, false)
        assert.equal(response.code, undefined)
        assert.equal(markedRejected, false)
        assert.equal(recoveryTriggers, 1)
        assert.deepEqual((await readState())?.orders, {})
        if (priorState) await writeState(priorState)
      },
    )

    await t.test(
      'order.submit checks regular msat Score backing before Score payment or capability admission',
      async () => {
        const priorState = await readState()
        const state = emptyDaemonState()
        state.wallet.proofs.push(
          proofRecord(
            'https://mint-a.example',
            1_000,
            'available',
            { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
            'order-backing-proof',
          ),
          proofRecord(
            'https://mint-a.example',
            1_000,
            'available',
            { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
            'score-backing-proof',
          ),
        )
        await writeState(state)
        let preparations = 0
        try {
          const response = await dispatch(
            {
              method: 'order.submit',
              params: withFeeConsent({
                marketId: 'cond-YES',
                outcomeId: 'YES',
                side: 'Buy',
                price: 420,
                amountSubunits: 1_000,
                timeInForce: 'FOK',
              }),
            },
            {
              createEngineClient: () => ({
                ...scoreDisabledEngineMethods,
                getMarket: async (conditionId) => ({
                  conditionId,
                  baseAsset: 'sat',
                  divisibility: 1_000,
                }),
                getParticipationScore: async () => scoreResponse({ balance: -100 }),
              }),
              prepareSettlementCapability: prepareSettlementCapability('unused', () => {
                preparations += 1
              }),
            },
          )

          assert.equal(response.ok, false)
          assert.match(response.error, /insufficient Participation Score backing/)
          assert.equal(preparations, 1)
          assert.deepEqual(
            (await readState())?.wallet.proofs.map((record) => record.proof.secret).sort(),
            ['order-backing-proof', 'score-backing-proof'],
          )
        } finally {
          if (priorState) await writeState(priorState)
        }
      },
    )

    await t.test(
      'order.submit rejects malformed order intent before mutation or submission',
      async () => {
        const priorState = await readState()
        await writeState(backedDaemonState())

        try {
          for (const params of [
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 0,
              amountSubunits: 1_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 500,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 2_000,
              minimumFillAmountSubunits: 500,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 2_000,
              minimumFillAmountSubunits: 3_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 2_000,
              minimumFillAmountSubunits: null,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'IOC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              consolidateProofs: 'yes',
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-Bob|Carol',
              outcomeId: 'Bob',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-Bob',
              outcomeId: 'Bob|Carol',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'GTC',
            },
            {
              marketId: 'cond-Bob',
              outcomeId: 'Carol',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'GTC',
            },
          ]) {
            let prepareCalls = 0
            let submitCalls = 0

            const response = await dispatch(
              {
                method: 'order.submit',
                params,
              } as never,
              {
                createEngineClient() {
                  return {
                    ...scoreDisabledEngineMethods,
                    async submitOrder() {
                      submitCalls += 1
                      throw new Error('submitOrder unused')
                    },
                    async getOrderStatus() {
                      throw new Error('getOrderStatus unused')
                    },
                    async cancelOrder() {
                      throw new Error('cancelOrder unused')
                    },
                    async getOrderBook() {
                      throw new Error('getOrderBook unused')
                    },
                    async queryMarkets() {
                      throw new Error('queryMarkets unused')
                    },
                  }
                },
                prepareSettlementCapability: prepareSettlementCapability('unused', () => {
                  prepareCalls += 1
                }),
              },
            )

            assert.equal(response.ok, false)
            assert.match(response.error ?? '', /Order rejected:/)
            assert.equal(prepareCalls, 0)
            assert.equal(submitCalls, 0)
            assert.deepEqual((await readState())?.orders, {})
          }
        } finally {
          if (priorState) await writeState(priorState)
        }
      },
    )

    await t.test('order.list reads filtered local daemon order state', async () => {
      const state = emptyDaemonState()
      state.orders['order-a'] = {
        orderId: 'order-a',
        marketId: 'cond-YES',
        status: 'resting',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }
      state.orders['order-b'] = {
        orderId: 'order-b',
        marketId: 'cond-NO',
        status: 'matched',
        createdAt: '2026-05-21T00:00:01.000Z',
        updatedAt: '2026-05-21T00:00:02.000Z',
      }
      state.orders['order-c'] = {
        orderId: 'order-c',
        marketId: 'cond-YES',
        status: 'cancelled',
        createdAt: '2026-05-21T00:00:03.000Z',
        updatedAt: '2026-05-21T00:00:03.000Z',
      }
      await writeState(state)

      const orderIds = [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ]
      const scopeId = deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
      })
      for (const [index, row] of Object.values(state.orders).entries()) {
        delete state.orders[row.orderId]
        row.orderId = orderIds[index]!
        row.clientOrderId = `ownership-list-client-${index}`
        state.orders[row.orderId] = row
        await retainNativeOrderLink(
          profileDir(),
          scopeId,
          row.orderId,
          row.marketId,
          row.clientOrderId,
        )
      }
      await writeState(state)

      const all = await dispatch({ method: 'order.list', params: {} })
      assert.equal(all.ok, true)
      assert.deepEqual(
        (all.result as Array<{ orderId: string }>).map((order) => order.orderId),
        [orderIds[2], orderIds[1], orderIds[0]],
      )

      const filtered = await dispatch({
        method: 'order.list',
        params: { marketId: 'cond-YES', status: 'resting' },
      })
      assert.equal(filtered.ok, true)
      assert.deepEqual(filtered.result, [state.orders[orderIds[0]!]])
    })

    await t.test(
      'order.cancel delegates to engine without attributing an unknown wallet order',
      async () => {
        await writeState(emptyDaemonState())
        let capturedCancel: unknown = null

        const response = await dispatch(
          {
            method: 'order.cancel',
            params: {
              marketId: 'cond-YES',
              orderId: 'order-cancel',
            },
          },
          {
            createEngineClient() {
              return {
                async submitOrder() {
                  throw new Error('submitOrder unused')
                },
                async getOrderStatus() {
                  throw new Error('getOrderStatus unused')
                },
                async cancelOrder(marketId, orderId) {
                  capturedCancel = { marketId, orderId }
                  return true
                },
                async getMarket(conditionId) {
                  return { conditionId, baseAsset: 'sat', divisibility: 1_000 }
                },
                async getOrderBook() {
                  throw new Error('getOrderBook unused')
                },
                async queryMarkets() {
                  throw new Error('queryMarkets unused')
                },
              }
            },
          },
        )

        assert.equal(response.ok, true)
        assert.deepEqual(capturedCancel, {
          marketId: 'cond-YES',
          orderId: 'order-cancel',
        })
        assert.deepEqual(response.result, {
          cancelled: true,
          local: null,
        })
        assert.equal((await readState())?.orders['order-cancel'], undefined)
      },
    )

    await t.test('order.book delegates snapshot reads to engine client', async () => {
      let capturedMarketId: string | null = null
      const response = await dispatch(
        {
          method: 'order.book',
          params: { marketId: 'cond-YES' },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder() {
                throw new Error('cancelOrder unused')
              },
              async getOrderBook(marketId) {
                capturedMarketId = marketId
                return {
                  marketId,
                  bids: [{ price: 42, amount: 100 }],
                  asks: [],
                  spread: null,
                }
              },
              async queryMarkets() {
                throw new Error('queryMarkets unused')
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal(capturedMarketId, 'cond-YES')
      assert.deepEqual(response.result, {
        marketId: 'cond-YES',
        bids: [{ price: 42, amount: 100 }],
        asks: [],
        spread: null,
      })
    })

    await t.test('order.submit tracks the order lifecycle after persistence', async () => {
      await writeState(backedDaemonState())
      let tracked: { marketId: string; orderId: string } | null = null
      const engine: EngineClientLike = {
        ...scoreDisabledEngineMethods,
        async submitOrder(_marketId, request) {
          return {
            orderId: 'order-runtime-fail',
            status: 'resting',
            remainingAmountSubunits: 1_000,
            fills: [],
            baseAsset: 'sat',
            divisibility: 1_000,
            activeSettlementGroup: null,
          }
        },
        async getOrderStatus() {
          return null
        },
        async cancelOrder() {
          throw new Error('cancelOrder unused')
        },
        async getOrderBook() {
          throw new Error('getOrderBook unused')
        },
        async queryMarkets() {
          return { markets: [], nextCursor: null }
        },
      }

      const response = await dispatch(
        {
          method: 'order.submit',
          params: withFeeConsent({
            marketId: 'cond-YES',
            outcomeId: 'YES',
            side: 'Buy',
            price: 420,
            amountSubunits: 1_000,
            timeInForce: 'FOK',
          }),
        },
        {
          createEngineClient() {
            return engine
          },
          prepareSettlementCapability: prepareSettlementCapability('order-runtime-fail'),
          async trackOwnedOrder(marketId, orderId) {
            assert.equal((await readState())?.orders[orderId]?.status, 'resting')
            tracked = { marketId, orderId }
            throw new Error('SignalR is unavailable')
          },
        },
      )

      assert.equal(response.ok, true)
      const state = await readState()
      assert.equal(state?.orders['order-runtime-fail']?.status, 'resting')
      assert.deepEqual(tracked, { marketId: 'cond-YES', orderId: 'order-runtime-fail' })
    })

    await t.test(
      'order.submit accepts direct sell flow after same-outcome CTF swaps are supported',
      async () => {
        const state = backedDaemonState()
        const otherOutcome = state.wallet.proofs.find(
          (row) => row.asset.kind === 'Outcome' && row.asset.outcomeSetId === 'NO',
        )
        assert.ok(otherOutcome)
        otherOutcome.proof.amount = 1
        await writeState(state)
        let capturedRequest: unknown = null
        let capturedPreparation: PrepareSettlementCapabilityInput | null = null

        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Sell',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            }),
          },
          {
            createEngineClient() {
              return {
                ...scoreDisabledEngineMethods,
                async submitOrder(_marketId, request) {
                  capturedRequest = request
                  return {
                    orderId: 'order-direct-sell',
                    status: 'resting',
                    remainingAmountSubunits: 1_000,
                    fills: [],
                    baseAsset: 'sat',
                    divisibility: 1_000,
                    activeSettlementGroup: null,
                  }
                },
                async getOrderStatus() {
                  return null
                },
                async cancelOrder() {
                  throw new Error('cancelOrder unused')
                },
                async getOrderBook() {
                  throw new Error('getOrderBook unused')
                },
                async queryMarkets() {
                  return { markets: [], nextCursor: null }
                },
              }
            },
            prepareSettlementCapability: prepareSettlementCapability(
              'order-direct-sell',
              (input) => {
                capturedPreparation = input
              },
            ),
          },
        )

        assert.equal(response.ok, true)
        assert.deepEqual(capturedRequest, {
          settlementCapability: {
            artifactId: '00000000-0000-4000-8000-000000000001',
            bindingDigest: 'ab'.repeat(32),
          },
          comment: null,
        })
        assert.equal(
          (capturedPreparation as unknown as PrepareSettlementCapabilityInput).side,
          'Sell',
        )
        assert.equal((await readState())?.orders['order-direct-sell']?.status, 'resting')
      },
    )

    await t.test(
      'order fee-preview resolves explicit and Auto prices without preparing funds',
      async () => {
        await writeState(backedDaemonState())
        const before = await readState()
        let capacityCalls = 0
        let previewCalls = 0
        let feeCalls = 0
        const engine: EngineClientLike = {
          ...testOrderEngine(),
          async previewFokOrderCapacity() {
            capacityCalls += 1
            return {
              status: 'ready',
              referencePrice: 400,
              effectiveLimitPrice: 420,
              maxFaceAmountSubunits: 1_000,
              quotePaymentSubunits: 350,
              worstPrice: 350,
              priceDenominator: 1_000,
              previewRevision: 'capacity-revision',
            }
          },
          async previewFokOrder(request) {
            previewCalls += 1
            return {
              fullFillAvailable: true,
              reason: 'fillable',
              previewRevision: 'trade-revision',
              quotePaymentSubunits: 350,
              averagePrice: 350,
              worstPrice: 350,
              currentLatestTradePrice: null,
              projectedFinalPrice: 350,
              priceDenominator: 1_000,
              subsidyMayHelp: false,
            }
          },
        }
        const deps = {
          createEngineClient: () => engine,
          previewSettlementCapabilityFees: async () => {
            feeCalls += 1
            return withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            }).feeConsent.feeFacts
          },
        }
        const explicit = await dispatch(
          {
            method: 'order.fee-preview',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            },
          },
          deps,
        )
        const auto = await dispatch(
          {
            method: 'order.fee-preview',
            params: {
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            },
          },
          deps,
        )
        assert.equal(explicit.ok, true, explicit.error)
        assert.equal(auto.ok, true, auto.error)
        assert.equal((explicit.result as { request: { price: number } }).request.price, 420)
        assert.equal((auto.result as { request: { price: number } }).request.price, 350)
        assert.equal(capacityCalls, 1)
        assert.equal(previewCalls, 2)
        assert.equal(feeCalls, 2)
        assert.deepEqual(await readState(), before)
      },
    )

    await t.test('protected submit binds fee consent and signs a canonical comment', async () => {
      await writeState(backedDaemonState())
      let prepareCalls = 0
      let submittedComment: unknown = null
      let forwardedFeeFacts: unknown = null
      const draft = {
        marketId: 'cond-YES',
        outcomeId: 'YES',
        side: 'Buy' as const,
        price: 420,
        amountSubunits: 1_000,
        timeInForce: 'FOK' as const,
      }
      const approved = withFeeConsent(draft)
      const engine: EngineClientLike = {
        ...testOrderEngine(),
        async submitOrder(_marketId, request) {
          submittedComment = request.comment
          return {
            orderId: 'protected-order',
            status: 'resting',
            remainingAmountSubunits: 1_000,
            fills: [],
            baseAsset: 'sat',
            divisibility: 1_000,
            activeSettlementGroup: null,
          }
        },
      }
      const deps = {
        createEngineClient: () => engine,
        prepareSettlementCapability: async (
          input: PrepareSettlementCapabilityInput,
          client: EngineClientLike,
          beforeCreateCapability?: (score: number) => Promise<void>,
          consentedFeeFacts?: unknown,
        ) => {
          prepareCalls += 1
          forwardedFeeFacts = consentedFeeFacts
          return prepareSettlementCapability('protected-order')(
            input,
            client,
            beforeCreateCapability,
          )
        },
      }
      const missing = await dispatch({ method: 'order.submit', params: draft } as never, deps)
      assert.equal(missing.code, 'fee-consent-required')
      const malformed = await dispatch(
        {
          method: 'order.submit',
          params: {
            ...approved,
            feeConsent: {
              ...approved.feeConsent,
              feeFacts: {
                ...approved.feeConsent.feeFacts,
                extraFee: '0',
              },
            },
          },
        } as never,
        deps,
      )
      assert.equal(malformed.code, 'fee-consent-required')
      const foreign = await dispatch(
        {
          method: 'order.submit',
          params: {
            ...approved,
            feeConsent: {
              ...approved.feeConsent,
              request: {
                ...approved.feeConsent.request,
                marketId: 'other-YES',
              },
            },
          },
        },
        deps,
      )
      assert.equal(foreign.code, 'fee-consent-mismatch')
      const stale = await dispatch(
        {
          method: 'order.submit',
          params: {
            ...approved,
            price: 421,
          },
        },
        deps,
      )
      assert.equal(stale.code, 'fee-consent-mismatch')
      const invalidComment = await dispatch(
        {
          method: 'order.submit',
          params: {
            ...approved,
            comment: { content: 'bad', marketUrl: 'https://other.example/markets/foreign' },
          },
        },
        deps,
      )
      assert.equal(invalidComment.ok, false)
      assert.equal(prepareCalls, 0)
      const submitted = await dispatch(
        {
          method: 'order.submit',
          params: {
            ...approved,
            comment: { content: 'hello', marketUrl: 'https://other.example/markets/cond' },
          },
        },
        deps,
      )
      assert.equal(submitted.ok, true, submitted.error)
      assert.equal(prepareCalls, 1)
      assert.deepEqual(forwardedFeeFacts, approved.feeConsent.feeFacts)
      assert.equal((submittedComment as { kind: number }).kind, 1)
      assert.deepEqual((submittedComment as { tags: string[][] }).tags, [
        ['r', 'https://other.example/markets/cond'],
      ])
    })

    await t.test(
      'fee preview refuses an unavailable execution preview before fee or Score work',
      async () => {
        let feeCalls = 0
        let prepareCalls = 0
        const engine: EngineClientLike = {
          ...testOrderEngine(),
          async previewFokOrder() {
            return {
              fullFillAvailable: false,
              reason: 'insufficient_liquidity',
              previewRevision: 'empty-book',
              quotePaymentSubunits: null,
              averagePrice: null,
              worstPrice: null,
              currentLatestTradePrice: null,
              projectedFinalPrice: null,
              priceDenominator: 1_000,
              subsidyMayHelp: true,
            }
          },
        }
        const deps = {
          createEngineClient: () => engine,
          previewSettlementCapabilityFees: async () => {
            feeCalls += 1
            return withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            }).feeConsent.feeFacts
          },
          prepareSettlementCapability: async () => {
            prepareCalls += 1
            throw new Error('preparation must not start')
          },
        }
        const request = withFeeConsent({
          marketId: 'cond-YES',
          outcomeId: 'YES',
          side: 'Buy',
          price: 420,
          amountSubunits: 1_000,
          timeInForce: 'FOK',
        })
        const response = await dispatch({ method: 'order.fee-preview', params: request }, deps)
        assert.equal(response.code, 'order-not-executable')
        assert.equal(feeCalls, 0)
        assert.equal(prepareCalls, 0)
      },
    )

    await t.test(
      'uncertain protected submission returns durable reconciliation identities',
      async () => {
        await writeState(backedDaemonState())
        let recoveryWakes = 0
        const engine: EngineClientLike = {
          ...testOrderEngine(),
          async submitOrder() {
            throw new Error('response lost after POST')
          },
        }
        const response = await dispatch(
          {
            method: 'order.submit',
            params: withFeeConsent({
              marketId: 'cond-YES',
              outcomeId: 'YES',
              side: 'Buy',
              price: 420,
              amountSubunits: 1_000,
              timeInForce: 'FOK',
            }),
          },
          {
            createEngineClient: () => engine,
            prepareSettlementCapability: prepareSettlementCapability('order-lost'),
            triggerSettlementRecovery: () => {
              recoveryWakes += 1
            },
          },
        )
        assert.equal(response.ok, false)
        assert.match(response.error ?? '', /submission is uncertain/)
        assert.ok(response.clientOrderId)
        assert.equal(response.operationId, `range:${response.clientOrderId}`)
        assert.equal(response.orderId, 'order-lost')
        assert.equal(recoveryWakes, 1)
        assert.deepEqual((await readState())?.orders, {})
      },
    )

    await t.test('markets.query delegates catalogue reads to engine client', async () => {
      let capturedParams: unknown = null
      const response = await dispatch(
        {
          method: 'markets.query',
          params: { search: 'weather', limit: 5, state: 'All' },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder() {
                throw new Error('cancelOrder unused')
              },
              async getOrderBook() {
                throw new Error('getOrderBook unused')
              },
              async queryMarkets(params) {
                capturedParams = params
                return {
                  markets: [{ conditionId: 'cond', title: 'Weather' }],
                  nextCursor: null,
                }
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.deepEqual(capturedParams, {
        search: 'weather',
        limit: 5,
        state: 'All',
      })
      assert.deepEqual(response.result, {
        markets: [{ conditionId: 'cond', title: 'Weather' }],
        nextCursor: null,
      })
    })

    await t.test('markets.show delegates single-market reads to engine client', async () => {
      let capturedConditionId = ''
      const response = await dispatch(
        {
          method: 'markets.show',
          params: { conditionId: 'condition-1' },
        },
        {
          createEngineClient() {
            return {
              async submitOrder() {
                throw new Error('submitOrder unused')
              },
              async getOrderStatus() {
                throw new Error('getOrderStatus unused')
              },
              async cancelOrder() {
                throw new Error('cancelOrder unused')
              },
              async getOrderBook() {
                throw new Error('getOrderBook unused')
              },
              async queryMarkets() {
                throw new Error('queryMarkets unused')
              },
              async getMarket(conditionId) {
                capturedConditionId = conditionId
                return { conditionId, title: 'Weather' }
              },
            }
          },
        },
      )

      assert.equal(response.ok, true)
      assert.equal(capturedConditionId, 'condition-1')
      assert.deepEqual(response.result, {
        conditionId: 'condition-1',
        title: 'Weather',
      })
    })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('native submit preserves original aggregate and fee consent after observations change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-native-quote-consent-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    const secrets = createDaemonSecrets('2026-05-21T00:00:00.000Z')
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'http://localhost:5000',
      mintUrl: 'https://mint-a.example',
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
    })
    await writeState(backedDaemonState())
    for (const side of ['Buy', 'Sell'] as const) {
      for (const tokenSide of ['Outcome', 'Complement'] as const) {
        const approved = withFeeConsent({
          marketId: 'cond-YES',
          outcomeId: 'YES',
          tokenSide,
          side,
          price: 500,
          amountSubunits: 10_000,
          timeInForce: 'FOK',
        })
        approved.feeConsent.request.maxQuotePaymentSubunits = side === 'Buy' ? 4_000 : null
        approved.feeConsent.request.minQuotePaymentSubunits = side === 'Sell' ? 4_000 : null
        let captured: PrepareSettlementCapabilityInput | undefined
        let feeFacts: unknown
        let submitted = 0
        const engine: EngineClientLike = {
          ...testOrderEngine(),
          async previewFokOrder() {
            throw new Error('a changed book must not replace consent')
          },
          async submitOrder() {
            submitted += 1
            return {
              orderId: `consent-${side}-${tokenSide}`,
              status: 'resting',
              remainingAmountSubunits: 0,
              fills: [],
              baseAsset: 'sat',
              divisibility: 1_000,
              activeSettlementGroup: null,
            }
          },
        }
        const deps = {
          createEngineClient: () => engine,
          previewSettlementCapabilityFees: async () => {
            throw new Error('current fees cannot replace accepted fees')
          },
          prepareSettlementCapability: async (
            input: PrepareSettlementCapabilityInput,
            client: EngineClientLike,
            before?: (score: number) => Promise<void>,
            acceptedFees?: unknown,
          ) => {
            captured = input
            feeFacts = acceptedFees
            return prepareSettlementCapability(`consent-${side}-${tokenSide}`)(
              input,
              client,
              before,
            )
          },
        }
        for (const changed of [
          { marketId: 'foreign-YES' },
          { outcomeId: 'NO' },
          { side: side === 'Buy' ? 'Sell' : 'Buy' },
          { tokenSide: tokenSide === 'Outcome' ? 'Complement' : 'Outcome' },
          { amountSubunits: 11_000 },
          { price: 501 },
          side === 'Buy' ? { maxQuotePaymentSubunits: 5_000 } : { minQuotePaymentSubunits: 3_000 },
        ]) {
          const refused = await dispatch(
            { method: 'order.submit', params: { ...approved, ...changed } } as never,
            deps,
          )
          assert.equal(refused.ok, false)
          assert.equal(submitted, 0)
          assert.equal(captured, undefined)
        }
        for (const malformed of [
          { maxQuotePaymentSubunits: null, minQuotePaymentSubunits: null },
          { maxQuotePaymentSubunits: 4_000, minQuotePaymentSubunits: 4_000 },
          side === 'Buy' ? { maxQuotePaymentSubunits: -1 } : { minQuotePaymentSubunits: -1 },
          side === 'Buy' ? { maxQuotePaymentSubunits: 1.5 } : { minQuotePaymentSubunits: 1.5 },
          { unexpected: true },
        ]) {
          const refused = await dispatch(
            {
              method: 'order.submit',
              params: {
                ...approved,
                feeConsent: {
                  ...approved.feeConsent,
                  request: { ...approved.feeConsent.request, ...malformed },
                },
              },
            } as never,
            deps,
          )
          assert.equal(refused.code, 'fee-consent-required')
          assert.equal(submitted, 0)
        }
        const result = await dispatch({ method: 'order.submit', params: approved }, deps)
        assert.equal(result.ok, true, result.error)
        assert.equal(submitted, 1)
        assert.equal(captured!.price, 500)
        assert.equal(captured!.maxQuotePaymentSubunits, side === 'Buy' ? 4_000 : null)
        assert.equal(captured!.minQuotePaymentSubunits, side === 'Sell' ? 4_000 : null)
        assert.equal(JSON.stringify(feeFacts), JSON.stringify(approved.feeConsent.feeFacts))
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})

test('wallet positions and portfolio keep custody and display values separate', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-wallet-portfolio-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const walletSeedHex = 'ab'.repeat(64)
  const nostrSecretKeyHex = '22'.repeat(32)
  const conditionId = 'cd'.repeat(32)
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex,
      nostrSecretKeyHex,
    })
    const state = emptyDaemonState()
    state.wallet.proofs.push(
      proofRecord('https://mint.example', 100_000, 'available', {
        kind: 'Outcome',
        conditionId,
        outcomeSetId: 'Alice',
        baseAsset: 'sat',
        unit: 'msat',
      }),
      proofRecord('https://mint.example', 150_000, 'available', {
        kind: 'Outcome',
        conditionId,
        outcomeSetId: 'Bob|Carol',
        baseAsset: 'sat',
        unit: 'msat',
      }),
      {
        ...proofRecord('https://mint.example', 25_000, 'reserved', {
          kind: 'Outcome',
          conditionId,
          outcomeSetId: 'Bob|Carol',
          baseAsset: 'sat',
          unit: 'msat',
        }),
        reservedBy: 'portfolio-test',
      },
    )
    await persistState(state)

    const positions = await dispatch({ method: 'wallet.positions' })
    assert.deepEqual(positions, {
      ok: true,
      result: {
        positions: [
          {
            mintUrl: 'https://mint.example',
            conditionId,
            outcomeSetId: 'Alice',
            availableSats: 100,
            reservedSats: 0,
            lockedSats: 0,
          },
          {
            mintUrl: 'https://mint.example',
            conditionId,
            outcomeSetId: 'Bob|Carol',
            availableSats: 150,
            reservedSats: 25,
            lockedSats: 0,
          },
        ],
      },
    })

    await t.test('disabled monitoring makes no client or network request', async () => {
      let clientCreations = 0
      const result = await dispatch(
        { method: 'wallet.portfolio', params: { timeframe: '1W', pageSize: 200 } },
        {
          isAssetMonitoringEnabled: () => false,
          createEngineClient: () => {
            clientCreations += 1
            throw new Error('disabled portfolio client was constructed')
          },
        },
      )
      assert.deepEqual(result, {
        ok: true,
        result: {
          localHoldings: await readDaemonWalletBalance(profileDir()),
          monitoring: { status: 'disabled' },
        },
      })
      assert.equal(clientCreations, 0)
    })

    await t.test('rejects untrusted wallet identity and out-of-range query options', async () => {
      let clientCreations = 0
      const invalidParams = [
        { walletId: '11'.repeat(32), timeframe: '1W', pageSize: 200 },
        { timeframe: '1W', pageSize: 201 },
      ]
      for (const params of invalidParams) {
        const result = await dispatch({ method: 'wallet.portfolio', params } as never, {
          isAssetMonitoringEnabled: () => true,
          createEngineClient: () => {
            clientCreations += 1
            throw new Error('invalid portfolio query reached the client')
          },
        })
        assert.deepEqual(result, {
          ok: false,
          code: 'invalid-portfolio-query',
          error: 'wallet portfolio accepts only a bounded timeframe and page size',
        })
      }
      assert.equal(clientCreations, 0)
    })

    const portfolio = {
      summary: {
        collateralUnit: 'msat',
        availableValueMsat: null,
        pendingOutgoingValueMsat: null,
        estimatedTotalValueMsat: null,
        unvaluedAssetCount: 1,
        unvaluedAvailableSubunits: 150_000,
        unvaluedPendingOutgoingSubunits: 25_000,
        valuationRevision: 'valuation-v1',
        stale: true,
        incomplete: true,
        building: true,
      },
      assets: {
        assets: [
          {
            asset: {
              canonicalMintUrl: 'https://mint.example',
              kind: 'conditional',
              cashuUnit: 'msat',
              displayBaseAsset: 'sat',
              conditionId,
              parentConditionId: '0'.repeat(64),
              outcomeUniverseDigest: 'ef'.repeat(32),
              internalOutcomeSetId: 'Alice',
            },
            availableSubunits: 100_000,
            pendingOutgoingSubunits: 0,
            availableValueMsat: 40_000,
            pendingOutgoingValueMsat: 0,
            estimatedValueMsat: 40_000,
            valuationStatus: 'valued',
            recoveryHint: null,
          },
          {
            asset: {
              canonicalMintUrl: 'https://mint.example',
              kind: 'conditional',
              cashuUnit: 'msat',
              displayBaseAsset: 'sat',
              conditionId,
              parentConditionId: '0'.repeat(64),
              outcomeUniverseDigest: 'ef'.repeat(32),
              internalOutcomeSetId: 'Bob|Carol',
            },
            availableSubunits: 150_000,
            pendingOutgoingSubunits: 25_000,
            availableValueMsat: null,
            pendingOutgoingValueMsat: null,
            estimatedValueMsat: null,
            valuationStatus: 'unvalued',
            recoveryHint: null,
          },
        ],
        nextCursor: 'next-page',
        valuationRevision: 'valuation-v1',
        stale: true,
        incomplete: true,
        building: true,
      },
      history: {
        timeframe: '1W',
        points: [{ asOf: '2026-09-30T00:00:00.000Z', estimatedTotalValueMsat: null }],
        coverageBoundary: '2026-09-01T00:00:00.000Z',
        valuationRevision: 'valuation-v1',
        stale: true,
        incomplete: true,
        building: true,
      },
    } satisfies AssetMonitoringPortfolioResponse

    await t.test(
      'uses the canonical selected-wallet id and preserves bounded SDK output',
      async () => {
        const clients: Array<{ baseUrl: string; nostrSecretKeyHex: string }> = []
        const queries: unknown[] = []
        const result = await dispatch(
          { method: 'wallet.portfolio', params: { timeframe: '1W', pageSize: 200 } },
          {
            isAssetMonitoringEnabled: () => true,
            createEngineClient: (options) => {
              clients.push(options)
              return {
                getPortfolio: async (query) => {
                  queries.push(query)
                  return portfolio
                },
              } as unknown as EngineClientLike
            },
          },
        )
        assert.deepEqual(clients, [{ baseUrl: 'https://engine.example', nostrSecretKeyHex }])
        assert.deepEqual(queries, [
          {
            walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
            timeframe: '1W',
            pageSize: 200,
          },
        ])
        assert.deepEqual(result, {
          ok: true,
          result: {
            localHoldings: await readDaemonWalletBalance(profileDir()),
            monitoring: { status: 'available', portfolio },
          },
        })
        assert.equal(portfolio.assets.assets[1]?.estimatedValueMsat, null)
      },
    )

    await t.test('keeps local holdings when a monitoring read fails', async () => {
      const result = await dispatch(
        { method: 'wallet.portfolio', params: { timeframe: 'ALL' } },
        {
          isAssetMonitoringEnabled: () => true,
          createEngineClient: () =>
            ({
              getPortfolio: async () => {
                throw new Error('engine unavailable')
              },
            }) as unknown as EngineClientLike,
        },
      )
      assert.deepEqual(result, {
        ok: true,
        result: {
          localHoldings: await readDaemonWalletBalance(profileDir()),
          monitoring: { status: 'unavailable' },
        },
      })
    })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('wallet assets reads bounded display-only pages without changing local custody', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-wallet-assets-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const walletSeedHex = 'ab'.repeat(64)
  const nostrSecretKeyHex = '22'.repeat(32)
  const conditionId = 'cd'.repeat(32)
  const cursor = 'opaque/page +='
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex,
      nostrSecretKeyHex,
    })
    const state = emptyDaemonState()
    state.wallet.proofs.push(
      proofRecord('https://mint.example', 100_000, 'available', {
        kind: 'Outcome',
        conditionId,
        outcomeSetId: 'Alice',
        baseAsset: 'sat',
        unit: 'msat',
      }),
    )
    await persistState(state)
    const localHoldings = await readDaemonWalletBalance(profileDir())
    const assets = assetMonitoringTestPage(conditionId)

    await t.test('disabled monitoring does not construct a client', async () => {
      let clientCreations = 0
      const result = await dispatch(
        { method: 'wallet.assets', params: { cursor, pageSize: 50 } },
        {
          isAssetMonitoringEnabled: () => false,
          createEngineClient: () => {
            clientCreations += 1
            throw new Error('disabled asset query constructed an engine client')
          },
        },
      )
      assert.deepEqual(result, {
        ok: true,
        result: { localHoldings, monitoring: { status: 'disabled' } },
      })
      assert.equal(clientCreations, 0)
    })

    await t.test('refuses injected wallet identity and invalid bounded query fields', async () => {
      const invalidParams = [
        { walletId: '11'.repeat(32), cursor, pageSize: 50 },
        { cursor: '' },
        { cursor: 'x'.repeat(4_097) },
        { pageSize: 201 },
        { timeframe: '1W' },
      ]
      let clientCreations = 0
      for (const params of invalidParams) {
        const result = await dispatch({ method: 'wallet.assets', params } as never, {
          isAssetMonitoringEnabled: () => true,
          createEngineClient: () => {
            clientCreations += 1
            throw new Error('invalid asset query reached the client')
          },
        })
        assert.deepEqual(result, {
          ok: false,
          code: 'invalid-asset-query',
          error: 'wallet assets accepts only a bounded cursor and page size',
        })
      }
      assert.equal(clientCreations, 0)
    })

    await t.test(
      'uses authenticated selected-wallet scope and preserves the second page',
      async () => {
        const clients: Array<{ baseUrl: string; nostrSecretKeyHex: string }> = []
        const queries: unknown[] = []
        const result = await dispatch(
          { method: 'wallet.assets', params: { cursor, pageSize: 50 } },
          {
            isAssetMonitoringEnabled: () => true,
            createEngineClient: (options) => {
              clients.push(options)
              return {
                getAssetMonitoringAssets: async (query) => {
                  queries.push(query)
                  return assets
                },
              } as unknown as EngineClientLike
            },
          },
        )
        assert.deepEqual(clients, [{ baseUrl: 'https://engine.example', nostrSecretKeyHex }])
        assert.deepEqual(queries, [
          {
            walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
            cursor,
            pageSize: 50,
          },
        ])
        assert.deepEqual(result, {
          ok: true,
          result: { localHoldings, monitoring: { status: 'available', assets } },
        })
        assert.equal(assets.assets[0]?.estimatedValueMsat, null)
        assert.equal(assets.nextCursor, 'next/page +?')
      },
    )

    await t.test('keeps local holdings when the asset page is unavailable', async () => {
      const result = await dispatch(
        { method: 'wallet.assets', params: { cursor } },
        {
          isAssetMonitoringEnabled: () => true,
          createEngineClient: () =>
            ({
              getAssetMonitoringAssets: async () => {
                throw new Error('engine unavailable')
              },
            }) as unknown as EngineClientLike,
        },
      )
      assert.deepEqual(result, {
        ok: true,
        result: { localHoldings, monitoring: { status: 'unavailable' } },
      })
    })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function assetMonitoringTestPage(conditionId: string): AssetMonitoringAssetsResponse {
  return {
    assets: [
      {
        asset: {
          canonicalMintUrl: 'https://mint.example',
          kind: 'conditional',
          cashuUnit: 'msat',
          displayBaseAsset: 'sat',
          conditionId,
          parentConditionId: '0'.repeat(64),
          outcomeUniverseDigest: 'ef'.repeat(32),
          internalOutcomeSetId: 'Bob|Carol',
        },
        availableSubunits: 150_000,
        pendingOutgoingSubunits: 25_000,
        availableValueMsat: null,
        pendingOutgoingValueMsat: null,
        estimatedValueMsat: null,
        valuationStatus: 'unvalued',
        recoveryHint: null,
      },
    ],
    nextCursor: 'next/page +?',
    valuationRevision: 'valuation-v1',
    stale: true,
    incomplete: true,
    building: true,
  }
}

async function insertCustodyBalanceProof(input: {
  readonly proofId: string
  readonly amount: number
  readonly nut07State: 'UNSPENT' | 'SPENT'
  readonly selectability: 'locked' | 'spent'
}): Promise<void> {
  await withDaemonStateSqliteTransaction(profileDir(), (database) => {
    const scope = database
      .prepare(`SELECT scope_id AS scopeId FROM custody_scopes WHERE scope_kind = 'wallet'`)
      .get() as { scopeId: string }
    database
      .prepare(
        `INSERT INTO custody_proofs (
          proof_id, scope_id, normalized_mint, unit, keyset_id, amount,
          base_asset, condition_id, outcome_set_id, product_binding,
          proof_body, proof_fingerprint, curve, signature_verified,
          dleq_state, nut07_state, selectability, storage_class,
          reservation_operation_id, revision, created_at_ms, updated_at_ms
        ) VALUES (
          ?, ?, 'https://mint-a.example', 'msat', '${TEST_KEYSET_ID}', ?,
          'sat', NULL, NULL, NULL,
          ?, ?, 'secp256k1', 1,
          'not-present', ?, ?, 'pinned-operation-bound-deterministic',
          'balance-operation', 0, 0, 0
        )`,
      )
      .run(
        input.proofId,
        scope.scopeId,
        input.amount,
        new Uint8Array([1]),
        input.proofId,
        input.nut07State,
        input.selectability,
      )
  })
}

function prepareSettlementCapability(
  orderId: string,
  onPrepare?: (input: PrepareSettlementCapabilityInput) => void,
  onRejected?: () => void,
) {
  return async (
    input: PrepareSettlementCapabilityInput,
    _client: EngineClientLike,
    beforeCreateCapability?: (requiredScore: number) => Promise<void>,
  ) => {
    onPrepare?.(input)
    await beforeCreateCapability?.(1)
    return {
      operationId: `range:${input.clientOrderId}`,
      markSubmitted: async () => undefined,
      markRejected: async () => onRejected?.(),
      consolidation: { operationIds: [], feeSubunits: 0 },
      capability: {
        reference: {
          artifactId: '00000000-0000-4000-8000-000000000001',
          bindingDigest: 'ab'.repeat(32),
        },
        orderId,
        clientOrderId: input.clientOrderId,
        marketId: input.marketId,
        artifactDigest: 'cd'.repeat(32),
        state: 'bound' as const,
        version: 1,
        authorizationExpiresAt: '2026-08-01T00:00:00.000Z',
        stageExpiresAt: '2026-07-31T23:59:00.000Z',
        settlementGroup: null,
      },
    }
  }
}

function proofRecord(
  mintUrl: string,
  amount: number,
  state: DaemonState['wallet']['proofs'][number]['state'],
  asset: DaemonState['wallet']['proofs'][number]['asset'],
  secret = `secret-${amount}`,
): DaemonState['wallet']['proofs'][number] {
  const strictAsset =
    asset.kind === 'Outcome' || (asset as { kind?: unknown }).kind === 'outcome'
      ? {
          ...asset,
          kind: 'Outcome' as const,
          baseAsset: 'sat' as const,
          unit: 'msat' as const,
        }
      : {
          ...asset,
          kind: 'sats' as const,
          baseAsset: 'sat' as const,
          unit: asset.unit === 'sat' ? ('sat' as const) : ('msat' as const),
        }
  return {
    mintUrl,
    state,
    asset: strictAsset,
    proof: {
      id: canonicalTestKeysetId(`dispatch:${amount}`),
      amount,
      secret,
      C: `c-${amount}`,
    },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }
}

function backedDaemonState(conditionId = 'cond', amount = 1_000): DaemonState {
  const state = emptyDaemonState()
  state.wallet.proofs.push(
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
        kind: 'outcome',
        conditionId,
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      },
      `${conditionId}-yes-vcs`,
    ),
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
        kind: 'outcome',
        conditionId,
        outcomeSetId: 'NO',
        baseAsset: 'sat',
        unit: 'msat',
      },
      `${conditionId}-no-vcs`,
    ),
    proofRecord(
      'https://mint-a.example',
      amount,
      'available',
      {
        kind: 'sats',
        baseAsset: 'sat',
        unit: 'msat',
      },
      `${conditionId}-base`,
    ),
  )
  return state
}

const scoreDisabledEngineMethods = {
  async getMarket(conditionId: string) {
    return { conditionId, baseAsset: 'sat', divisibility: 1_000 }
  },
  async getParticipationScore() {
    return scoreResponse({ enabled: false })
  },
  async previewFokOrder(request: { price: number; faceAmountSubunits: number; tokenSide: string }) {
    const denominator = request.price >= 1_000 ? 1_000_000 : 1_000
    return {
      fullFillAvailable: true,
      reason: 'fillable' as const,
      previewRevision: 'test-revision',
      quotePaymentSubunits: (request.faceAmountSubunits * request.price) / denominator,
      averagePrice: request.price,
      worstPrice: request.price,
      currentLatestTradePrice: null,
      projectedFinalPrice:
        request.tokenSide === 'Complement' ? denominator - request.price : request.price,
      priceDenominator: denominator,
      subsidyMayHelp: false,
    }
  },
} satisfies Pick<EngineClientLike, 'getMarket' | 'getParticipationScore' | 'previewFokOrder'>

function testOrderEngine(): EngineClientLike {
  return {
    ...scoreDisabledEngineMethods,
    async submitOrder() {
      throw new Error('submitOrder unused')
    },
    async getOrderStatus() {
      return null
    },
    async cancelOrder() {
      throw new Error('cancelOrder unused')
    },
    async getOrderBook() {
      throw new Error('getOrderBook unused')
    },
    async queryMarkets() {
      return { markets: [], nextCursor: null }
    },
  }
}

function withFeeConsent<T extends OrderDraftParams>(
  params: T,
): T & Pick<SubmitOrderParams, 'feeConsent'> {
  const tokenSide = params.tokenSide ?? 'Outcome'
  const regularAsset = { kind: 'regular' as const, unit: 'msat' as const }
  return {
    ...params,
    feeConsent: {
      request: {
        marketId: params.marketId,
        outcomeId: params.outcomeId,
        tokenSide,
        side: params.side,
        price: params.price!,
        maxQuotePaymentSubunits:
          params.side === 'Buy'
            ? Math.floor(
                (params.amountSubunits * params.price!) /
                  (params.price! >= 1_000 ? 1_000_000 : 1_000),
              )
            : null,
        minQuotePaymentSubunits:
          params.side === 'Sell'
            ? Math.floor(
                (params.amountSubunits * params.price!) /
                  (params.price! >= 1_000 ? 1_000_000 : 1_000),
              )
            : null,
        amountSubunits: params.amountSubunits,
        minimumFillAmountSubunits:
          params.minimumFillAmountSubunits ?? (params.price! >= 1_000 ? 1_000_000 : 1_000),
        consolidateProofs: params.consolidateProofs === true,
        timeInForce: 'FOK',
      },
      feeFacts: {
        settlementInputFeeSubunits: '0',
        sourcePreparationFeeSubunits: '0',
        consolidationFeeSubunits: '0',
        settlementAsset: regularAsset,
        sourcePreparationAsset: regularAsset,
        consolidationAsset: regularAsset,
        sourceMode: 'wallet-send',
      },
    },
  }
}

function creditedRecipientStatus(submission: DurableRecipientDeliverySubmission) {
  const { token: _token, ...delivery } = submission
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state: 'credited',
    result: {
      creditedAmount: submission.requestedAmount,
      receiveFee: '0',
      creditVerification: submission.creditPolicy,
      receiveOperationId: 'receive-1',
      receivedAt: '2026-08-11T00:00:00.000Z',
      businessEventId: 'event-1',
      businessEventAt: '2026-08-11T00:00:00.000Z',
    },
  })
}

function pendingRecipientStatus(submission: DurableRecipientDeliverySubmission) {
  const { token: _token, ...delivery } = submission
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state: 'pending',
    result: null,
  })
}

function receivedRecipientStatus(submission: DurableRecipientDeliverySubmission) {
  const { token: _token, ...delivery } = submission
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state: 'received',
    result: {
      creditedAmount: submission.requestedAmount,
      receiveFee: '0',
      creditVerification: submission.creditPolicy,
      receiveOperationId: 'receive-1',
      receivedAt: '2026-08-11T00:00:00.000Z',
    },
  })
}

function scoreResponse(
  overrides: Partial<Awaited<ReturnType<EngineClientLike['getParticipationScore']>>> = {},
): Awaited<ReturnType<EngineClientLike['getParticipationScore']>> {
  return {
    pubkey: 'a'.repeat(64),
    balance: 0,
    purchasedTotal: 0,
    consumedTotal: 0,
    enabled: true,
    ...overrides,
  }
}

function cashuProof(amount: number, secret: string): Proof {
  return {
    id: V2_KEYSET_ID,
    amount,
    secret,
    C: `02${'11'.repeat(32)}`,
  }
}

async function deterministicDispatchOutputs(input: {
  walletSeedHex: string
  fence: Parameters<typeof withDurableCustodyUnitOfWork>[1]
  keysetId: string
  sendAmounts: number[]
  keepAmounts: number[]
  config: { onCountersReserved?: (counters: OperationCounters) => void } | undefined
}): Promise<{ sendOutputs: OutputData[]; keepOutputs: OutputData[] }> {
  assert.equal(
    typeof input.config?.onCountersReserved,
    'function',
    'deterministic dispatch fixture needs a counter callback',
  )
  const counterSource = createDaemonCounterSource(
    () => ({ fence: input.fence, observedAtMs: Date.now() }),
    { normalizedMint: 'https://mint-a.example', unit: 'msat' },
  )
  const range = await counterSource.reserve(
    input.keysetId,
    input.sendAmounts.length + input.keepAmounts.length,
  )
  input.config!.onCountersReserved!({
    keysetId: input.keysetId,
    start: range.start,
    count: range.count,
    next: range.start + range.count,
  })
  const seed = Buffer.from(input.walletSeedHex, 'hex')
  const sendOutputs = input.sendAmounts.map((amount, index) =>
    OutputData.createSingleDeterministicData(amount, seed, range.start + index, input.keysetId),
  )
  const keepOutputs = input.keepAmounts.map((amount, index) =>
    OutputData.createSingleDeterministicData(
      amount,
      seed,
      range.start + input.sendAmounts.length + index,
      input.keysetId,
    ),
  )
  return { sendOutputs, keepOutputs }
}

function signedDleqProof(
  output: OutputData,
  privateKey: Uint8Array,
  keys: Record<string, string>,
): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    privateKey,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey)
  const proof = output.toProof(
    {
      id: output.blindedMessage.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys },
  )
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq === undefined ? null : { ...proof.dleq, r: proof.dleq.r ?? null },
    p2pkE: null,
    witness: null,
  } as Proof
}

function signedOutcomeProof(amount: number, secret: string): Proof {
  return signedDleqProof(
    OutputData.createSingleData(amount, OUTCOME_KEYSET_ID, secret, BigInt(secret.length)),
    OUTCOME_PRIVATE_KEY,
    OUTCOME_KEYS,
  )
}

async function outcomeReceiveFixture(
  walletSeedHex: string,
  state: 'UNSPENT' | 'SPENT' = 'UNSPENT',
  injectFault?: (phase: StateSqliteFaultPhase) => void,
) {
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
  })
  const fence = await claimCustodyScopeLease(profileDir(), {
    scopeId,
    incarnationId: 'wallet-receive-bind-test',
    observedAtMs: Date.now(),
  })
  return {
    fence,
    dependencies: () => ({
      getCustodyFence: () => fence,
      ...(injectFault === undefined ? {} : { injectCustodyFault: injectFault }),
      resolveTokenImportKeysets: async () => ({
        freshness: 'fresh' as const,
        regularKeysets: [],
        conditionalKeysets: [{ keysetId: OUTCOME_KEYSET_ID, unit: 'msat', active: true }],
      }),
      resolveMintKeysetIds: async (mintUrl: string) => {
        assert.equal(mintUrl, 'https://mint-a.example')
        return [OUTCOME_KEYSET_ID]
      },
      async resolveConditionKeysetIds(mintUrl: string, conditionId: string) {
        assert.equal(mintUrl, 'https://mint-a.example')
        assert.equal(conditionId, OUTCOME_CONDITION_ID)
        return [OUTCOME_KEYSET_ID]
      },
      async resolveDurableCustodyKeysets(
        mintUrl: string,
        keysetIds: string[],
        conditionId: string,
      ) {
        assert.equal(mintUrl, 'https://mint-a.example')
        assert.deepEqual(keysetIds, [OUTCOME_KEYSET_ID])
        assert.equal(conditionId, OUTCOME_CONDITION_ID)
        return [
          {
            canonicalMintUrl: mintUrl,
            id: OUTCOME_KEYSET_ID,
            unit: 'msat',
            keys: OUTCOME_KEYS,
            inputFeePpk: 0,
            finalExpiry: null,
            identity: {
              kind: 'conditional' as const,
              conditionId: OUTCOME_CONDITION_ID,
              outcomeCollection: OUTCOME_COLLECTION,
              outcomeCollectionId: OUTCOME_COLLECTION_ID,
            },
          },
        ]
      },
      createCashuWallet() {
        return {
          async loadMint() {},
          async receive() {
            throw new Error('receive unused for outcome imports')
          },
          async send() {
            throw new Error('send unused')
          },
          async checkProofsStates(proofs: Array<Pick<Proof, 'id' | 'secret'>>) {
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state,
              witness: null,
            }))
          },
        }
      },
    }),
  }
}

async function genericReceiveOperationCount(): Promise<number> {
  return withDaemonStateSqliteTransaction(profileDir(), (database) => {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM custody_operations WHERE semantic_kind = 'generic-receive'",
      )
      .get() as { count: number }
    return row.count
  })
}

function tokenImportKeysetResolver(registry: 'regular' | 'conditional', unit: 'sat' | 'msat') {
  return async () => ({
    freshness: 'fresh' as const,
    regularKeysets: registry === 'regular' ? [{ keysetId: V2_KEYSET_ID, unit, active: true }] : [],
    conditionalKeysets:
      registry === 'conditional' ? [{ keysetId: V2_KEYSET_ID, unit, active: true }] : [],
  })
}

async function profileFileSnapshot(directory: string): Promise<Array<[string, Buffer]>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  return Promise.all(files.map(async (file) => [file, await readFile(join(directory, file))]))
}
