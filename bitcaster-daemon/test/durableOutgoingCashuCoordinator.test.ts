import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
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
  getDecodedToken,
  type OperationCounters,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
  type DurableRecipientDeliverySubmission,
} from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  createParticipationScoreDeliveryMetadata,
  createParticipationScoreDeliverySubmission,
  participationScoreDeliveryIntent,
} from '@bitcaster-market/client-sdk/participationScoreDelivery'
import { deriveDurableRecipientTokenAllowance } from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  createMarketFundingDeliveryMetadata,
  createMarketFundingDeliverySubmission,
  marketFundingDeliveryIntent,
} from '@bitcaster-market/client-sdk/marketFundingDelivery'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import {
  createDaemonCounterSource,
  deliverMarketFundingCashu,
  quoteMarketFundingCashu,
  readMarketFundingHeadCashu,
  recoverDurableOutgoingCashuTransfers,
} from '../src/walletOps.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { NativeActivitySqlite } from '../src/nativeActivitySqlite.ts'
import { DurableOutgoingCashuSqliteStore } from '../src/durableOutgoingCashuSqlite.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  addAvailableProofs,
  advanceDaemonKeysetCounter,
  getProofOperation,
  readState,
} from '../src/state.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { replaceDaemonSigner, DaemonSignerEditError } from '../src/secrets.ts'

const MINT_URL = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEY = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))
const KEYS = { '1': KEY, '2': KEY, '4': KEY, '8': KEY, '128': KEY }
const MSAT_KEYS = Object.fromEntries(
  [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 2_048, 4_096, 8_192].map((amount) => [
    String(amount),
    KEY,
  ]),
)
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })
const MSAT_KEYSET_ID = deriveKeysetId(MSAT_KEYS, { unit: 'msat', versionByte: 1 })
const FEE_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  versionByte: 1,
  input_fee_ppk: 500,
})
const TEST_SEED_HEX = '11'.repeat(64)
const TEST_SEED = Buffer.from(TEST_SEED_HEX, 'hex')

for (const state of ['prepared', 'delivery-pending'] as const) {
  test(`signer replacement refuses ${state} recipient delivery and preserves exact work`, async () => {
    const fixture = await createFixture({ scoreFunds: true })
    try {
      const transferId = '77777777-7777-4777-8777-777777777777'
      const metadata = createParticipationScoreDeliveryMetadata({
        deliveryId: transferId,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
        requestedAmount: '8000',
      })
      const prepare = fixture.coordinator.executeParticipationScore({
        transferId,
        amountMsat: 8000,
        purchasedTotalEpoch: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
        maxWalletDebitMsat: 8000,
        deliveryIntent: participationScoreDeliveryIntent({
          accountSubject: metadata.accountSubject,
          productBindingSha256: metadata.productBindingSha256,
          tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
        }),
        wallet: fixture.scoreWallet(async () => {
          if (state === 'prepared') throw new Error('response lost')
          return { keep: fixture.scoreKeepProofs, send: fixture.scoreSendProofs }
        }),
      })
      if (state === 'prepared') await assert.rejects(prepare, /response lost/)
      else await prepare
      const before = await fixture.coordinator.loadTransfer(transferId)
      assert.equal(before?.deliveryState, state)
      const proofsBefore = await readState()
      await assert.rejects(
        replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: '44'.repeat(32) }),
        (e) => e instanceof DaemonSignerEditError && e.reason === 'unfinished-account-work',
      )
      assert.ok(
        isDeepStrictEqual(await fixture.coordinator.loadTransfer(transferId), before),
        'signer refusal changed pending bearer authority',
      )
      assert.ok(
        isDeepStrictEqual(await readState(), proofsBefore),
        'signer refusal changed proofs or counters',
      )
    } finally {
      await fixture.close()
    }
  })
}

test('pending bearer transfer does not block signer replacement or change its authority', async () => {
  const fixture = await createFixture()
  try {
    const transferId = '88888888-8888-4888-8888-888888888888'
    const before = await fixture.coordinator.execute({
      transferId,
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    assert.equal(before.deliveryState, 'delivery-pending')
    const proofsBefore = await readState()
    await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: '44'.repeat(32) })
    assert.ok(
      isDeepStrictEqual(await fixture.coordinator.loadTransfer(transferId), before),
      'replacement changed bearer transfer',
    )
    assert.ok(
      isDeepStrictEqual(await readState(), proofsBefore),
      'replacement changed wallet authority',
    )
  } finally {
    await fixture.close()
  }
})

function testMintAuthority(privateKeyLastByte: number) {
  const privateKey = Uint8Array.from([...new Uint8Array(31), privateKeyLastByte])
  const key = bytesToHex(secp256k1.getPublicKey(privateKey, true))
  const keys = Object.fromEntries([1, 2, 4, 8, 128].map((amount) => [String(amount), key]))
  return {
    keysetId: deriveKeysetId(keys, { unit: 'msat', versionByte: 1 }),
    keys,
    privateKey,
  }
}

type TestCoordinator = Omit<
  DaemonDurableOutgoingCashuCoordinator,
  'execute' | 'executeParticipationScore' | 'executeMarketFundingTransfer'
> & {
  execute(
    input: Omit<Parameters<DaemonDurableOutgoingCashuCoordinator['execute']>[0], 'seed'>,
  ): ReturnType<DaemonDurableOutgoingCashuCoordinator['execute']>
  executeParticipationScore(
    input: Omit<
      Parameters<DaemonDurableOutgoingCashuCoordinator['executeParticipationScore']>[0],
      'seed'
    >,
  ): ReturnType<DaemonDurableOutgoingCashuCoordinator['executeParticipationScore']>
  executeMarketFundingTransfer(
    input: Omit<
      Parameters<DaemonDurableOutgoingCashuCoordinator['executeMarketFundingTransfer']>[0],
      'seed'
    >,
  ): ReturnType<DaemonDurableOutgoingCashuCoordinator['executeMarketFundingTransfer']>
}

function withTestSeed(coordinator: DaemonDurableOutgoingCashuCoordinator): TestCoordinator {
  return new Proxy(coordinator, {
    get(target, property) {
      if (property === 'execute') {
        return (input: Omit<Parameters<typeof target.execute>[0], 'seed'>) =>
          target.execute({ ...input, seed: TEST_SEED })
      }
      if (property === 'executeParticipationScore') {
        return (input: Omit<Parameters<typeof target.executeParticipationScore>[0], 'seed'>) =>
          target.executeParticipationScore({ ...input, seed: TEST_SEED })
      }
      if (property === 'executeMarketFundingTransfer') {
        return (input: Omit<Parameters<typeof target.executeMarketFundingTransfer>[0], 'seed'>) =>
          target.executeMarketFundingTransfer({ ...input, seed: TEST_SEED })
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as TestCoordinator
}

const FUNDING_PRODUCT = {
  accountSubject: 'subject-1',
  conditionId: 'b'.repeat(64),
  divisibility: 1_000,
  mintUrl: MINT_URL,
  unit: 'msat' as const,
}

function recipientStatus(
  submission: DurableRecipientDeliverySubmission,
  state: 'pending' | 'received' | 'credited',
) {
  const { token: _token, ...delivery } = submission
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state,
    result:
      state === 'pending'
        ? null
        : state === 'received'
          ? {
              creditedAmount: submission.requestedAmount,
              receiveFee: '0',
              creditVerification: submission.creditPolicy,
              receiveOperationId: 'receive-1',
              receivedAt: '2026-08-11T00:00:00.000Z',
            }
          : {
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

test('outgoing transfer persists exact authority before mint I/O and returns an identical token on retry', async () => {
  const fixture = await createFixture()
  try {
    let mintCalls = 0
    let preparations = 0
    const preparationRanges: OperationCounters[] = []
    const wallet = fixture.wallet(async () => {
      mintCalls += 1
      assert.equal(await fixture.preMintPersisted(), true)
      await assertWithdrawalActivity(fixture, 'pending', 5)
      return { keep: fixture.keepProofs, send: fixture.sendProofs }
    })
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (amount, proofs, config, outputConfig) => {
      preparations += 1
      const deterministicConfig = config as {
        includeFees: false
        keysetId: string
        onCountersReserved: (counters: OperationCounters) => void
      }
      assert.equal(deterministicConfig.includeFees, false)
      assert.equal(deterministicConfig.keysetId, KEYSET_ID)
      assert.deepEqual(outputConfig, {
        send: { type: 'deterministic', counter: 0 },
        keep: { type: 'deterministic', counter: 0 },
      })
      return prepare(
        amount,
        proofs,
        {
          ...deterministicConfig,
          onCountersReserved: (counters: OperationCounters) => {
            preparationRanges.push(counters)
            deterministicConfig.onCountersReserved(counters)
          },
        },
        outputConfig,
      )
    }
    const first = await fixture.coordinator.execute({
      transferId: 'outgoing-retry',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet,
    })
    assert.ok(first.token)
    assert.deepEqual(first.keepProofDerivationLocators, [
      { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 2 },
      { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 3 },
    ])
    assert.equal(preparations, 1)
    assert.deepEqual(
      preparationRanges.map(({ keysetId, start, count, next }) => ({
        keysetId,
        start,
        count,
        next,
      })),
      [{ keysetId: KEYSET_ID, start: 0, count: 4, next: 4 }],
    )
    const counterBeforeRetry = await fixture.counterNext(KEYSET_ID)
    const retryWallet = fixture.wallet(async () => {
      throw new Error('saved outgoing retry must not mint')
    })
    retryWallet.prepareSwapToSend = async () => {
      throw new Error('saved outgoing retry must not prepare a new operation')
    }
    const second = await fixture.coordinator.execute({
      transferId: first.transferId,
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: retryWallet,
    })
    assert.equal(mintCalls, 1)
    assert.equal(preparations, 1)
    assert.deepEqual(await fixture.counterNext(KEYSET_ID), counterBeforeRetry)
    assert.equal(second.token?.encodedToken, first.token?.encodedToken)
    assert.equal(await fixture.count('target_wallet_proofs'), 2)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
    assert.equal(await fixture.count('custody_active_work'), 0)
    await assert.rejects(
      () => fixture.putForeignTransferBinding(second),
      /custody operation is foreign/,
    )
  } finally {
    await fixture.close()
  }
})

test('outgoing recovery rejects a legacy sat transfer before wallet work', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-legacy-sat',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let walletWork = 0
    await assert.rejects(
      () =>
        fixture.coordinator.recover({
          transfer: { ...transfer, unit: 'sat' },
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet: fixture.wallet(async () => {
            walletWork += 1
            throw new Error('legacy sat recovery must not reach the wallet')
          }),
        }),
      /transfer conflicts with the caller request/,
    )
    assert.equal(walletWork, 0)
  } finally {
    await fixture.close()
  }
})

test('recipient delivery reads credited status before POST and atomically persists its receipt', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '11111111-1111-4111-8111-111111111111',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const transfer = await fixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    assert.equal(transfer.unit, 'msat')
    assert.equal(transfer.requestedAmount, '8000')
    assert.ok(transfer.token)
    const unavailableEngineRecovery = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        throw new Error('recipient delivery recovery must not use mint proof classification')
      },
    })
    assert.equal(unavailableEngineRecovery.hasBlockingPending, true)
    assert.equal(unavailableEngineRecovery.pending.length, 1)
    let posts = 0
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: transfer.token!.encodedToken,
    })
    const restarted = fixture.coordinatorFor(fixture.fence, Date.now())
    const persisted = await restarted.loadTransfer(transfer.transferId)
    assert.ok(persisted?.token)
    assert.equal(persisted?.token?.encodedToken, transfer.token!.encodedToken)
    const result = await restarted.reconcileRecipientDelivery({
      transfer: persisted!,
      submission,
      client: {
        getDurableRecipientDeliveryStatus: async () => recipientStatus(submission, 'credited'),
        submitDurableRecipientDelivery: async () => {
          posts += 1
          throw new Error('credited delivery must not post')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })

    assert.equal(posts, 0)
    assert.equal(result.transfer.deliveryState, 'recipient-acknowledged')
    assert.equal(result.transfer.recipientReceipt?.receiveOperationId, 'receive-1')
    assert.equal(
      (await fixture.transfer(transfer.transferId))?.deliveryState,
      'recipient-acknowledged',
    )
  } finally {
    await fixture.close()
  }
})

test('Score delivery pointer blocks repeated preflight and retires only after the purchase epoch advances', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const first = await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: firstId,
      amountMsat: 8_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    assert.deepEqual(first, { transferId: firstId, amountMsat: 8_000, purchasedTotalEpoch: 3 })
    const restarted = fixture.coordinatorFor(fixture.fence, Date.now())
    const reused = await Promise.all([
      fixture.coordinator.preflightParticipationScoreDelivery({
        transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        amountMsat: 7_000,
        purchasedTotal: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
      }),
      restarted.preflightParticipationScoreDelivery({
        transferId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        amountMsat: 9_000,
        purchasedTotal: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
      }),
    ])
    for (const pointer of reused) {
      assert.equal(pointer.transferId, first.transferId)
      assert.equal(pointer.amountMsat, first.amountMsat)
      assert.equal(pointer.purchasedTotalEpoch, first.purchasedTotalEpoch)
    }
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: first.transferId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const transfer = await restarted.execute({
      transferId: first.transferId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    assert.ok(transfer.token)
    const nonterminal = await restarted.preflightParticipationScoreDelivery({
      transferId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      amountMsat: 6_000,
      purchasedTotal: 4,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    assert.equal(nonterminal.transferId, first.transferId)
    assert.equal(nonterminal.amountMsat, first.amountMsat)
    assert.equal(nonterminal.purchasedTotalEpoch, first.purchasedTotalEpoch)
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: transfer.token.encodedToken,
    })
    await restarted.reconcileRecipientDelivery({
      transfer,
      submission,
      client: {
        getDurableRecipientDeliveryStatus: async () => recipientStatus(submission, 'credited'),
        submitDurableRecipientDelivery: async () => {
          throw new Error('credited Score delivery must not post')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })

    const secondId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const next = await restarted.preflightParticipationScoreDelivery({
      transferId: secondId,
      amountMsat: 6_000,
      purchasedTotal: 4,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })

    assert.deepEqual(next, { transferId: secondId, amountMsat: 6_000, purchasedTotalEpoch: 4 })
    assert.equal(await restarted.loadTransfer(firstId), null)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(
      await fixture.hasArtifact(deriveDurableCustodyArtifactFingerprint(transfer)),
      false,
    )
  } finally {
    await fixture.close()
  }
})

test('standalone Score preflight rejects a competing quote while automatic retry keeps pointer reuse', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const first = await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: '12121212-1212-4212-8212-121212121212',
      amountMsat: 8_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    const exactRetry = await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: first.transferId,
      amountMsat: first.amountMsat,
      purchasedTotal: first.purchasedTotalEpoch,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requireExactRequest: true,
    })
    assert.equal(exactRetry.transferId, first.transferId)
    assert.equal(exactRetry.amountMsat, first.amountMsat)
    assert.equal(exactRetry.purchasedTotalEpoch, first.purchasedTotalEpoch)

    await assert.rejects(
      fixture.coordinator.preflightParticipationScoreDelivery({
        transferId: '34343434-3434-4434-8434-343434343434',
        amountMsat: 7_000,
        purchasedTotal: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
        requireExactRequest: true,
      }),
      /conflicts with the active delivery/,
    )

    const automaticRetry = await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: '56565656-5656-4565-8565-565656565656',
      amountMsat: 6_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    assert.equal(automaticRetry.transferId, first.transferId)
    assert.equal(automaticRetry.amountMsat, first.amountMsat)
    assert.equal(automaticRetry.purchasedTotalEpoch, first.purchasedTotalEpoch)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
  } finally {
    await fixture.close()
  }
})

test('standalone Score preparation keeps fee failures unbound and admits a fresh smaller purchase', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const blockedMetadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '61616161-6161-4161-8161-616161616161',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const overCapWallet = fixture.scoreWallet(async () => {
      throw new Error('fee rejection must happen before mint dispatch')
    })
    const overCapPrepare = overCapWallet.prepareSwapToSend!
    overCapWallet.prepareSwapToSend = async (...args) => ({
      ...(await overCapPrepare(...args)),
      fees: Amount.from(2),
    })
    await assert.rejects(
      fixture.coordinator.executeParticipationScore({
        transferId: '61616161-6161-4161-8161-616161616161',
        amountMsat: 8_000,
        purchasedTotalEpoch: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
        wallet: overCapWallet,
        deliveryIntent: participationScoreDeliveryIntent({
          accountSubject: blockedMetadata.accountSubject,
          productBindingSha256: blockedMetadata.productBindingSha256,
          tokenBytesLimit: deriveDurableRecipientTokenAllowance(blockedMetadata),
        }),
        maxWalletDebitMsat: 8_001,
      }),
      /approved maximum/,
    )
    assert.equal(await fixture.count('daemon_participation_score_delivery_pointers'), 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await fixture.count('target_proof_operations'), 0)
    assert.equal(await fixture.count('custody_active_work'), 0)

    const sendOutputs = [2_048, 1_024, 512, 256, 128, 32].map((amount, index) =>
      OutputData.createSingleData(
        amount,
        MSAT_KEYSET_ID,
        `small-score-send-${index}`,
        BigInt(70 + index),
      ),
    )
    const keepOutputs = [2_048, 1_024, 512, 128, 64, 32].map((amount, index) =>
      OutputData.createSingleData(
        amount,
        MSAT_KEYSET_ID,
        `small-score-keep-${index}`,
        BigInt(80 + index),
      ),
    )
    const smallWallet = fixture.scoreWallet(
      async () => ({
        keep: keepOutputs.map((output) => signedProof(output, MSAT_KEYS)),
        send: sendOutputs.map((output) => signedProof(output, MSAT_KEYS)),
      }),
      CheckStateEnum.UNSPENT,
      { sendOutputs, keepOutputs },
      4_000,
    )
    const smallPrepare = smallWallet.prepareSwapToSend!
    smallWallet.prepareSwapToSend = async (...args) => ({
      ...(await smallPrepare(...args)),
      fees: Amount.from(2),
    })
    const deliveryId = '62626262-6262-4262-8262-626262626262'
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '4000',
    })
    const transfer = await fixture.coordinator.executeParticipationScore({
      transferId: deliveryId,
      amountMsat: 4_000,
      purchasedTotalEpoch: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      wallet: smallWallet,
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
      maxWalletDebitMsat: 4_002,
    })
    assert.equal(transfer.deliveryState, 'delivery-pending')
    assert.equal(await fixture.count('daemon_participation_score_delivery_pointers'), 1)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
    assert.equal(await fixture.count('custody_active_work'), 0)
  } finally {
    await fixture.close()
  }
})

test('standalone Score pointer rolls back with failed preparation and preserves a conflicting automatic pointer', async () => {
  const failedFixture = await createFixture({ scoreFunds: true })
  try {
    const deliveryId = '63636363-6363-4363-8363-636363636363'
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const wallet = failedFixture.scoreWallet(async () => ({
      keep: failedFixture.scoreKeepProofs,
      send: failedFixture.scoreSendProofs,
    }))
    await failedFixture.installOutgoingTransferAbort('insert')
    await assert.rejects(
      failedFixture.coordinator.executeParticipationScore({
        transferId: deliveryId,
        amountMsat: 8_000,
        purchasedTotalEpoch: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
        wallet,
        deliveryIntent: participationScoreDeliveryIntent({
          accountSubject: metadata.accountSubject,
          productBindingSha256: metadata.productBindingSha256,
          tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
        }),
        maxWalletDebitMsat: 8_000,
      }),
      /outgoing transfer insert fault/,
    )
    await failedFixture.removeOutgoingTransferAbort('insert')
    assert.equal(await failedFixture.count('daemon_participation_score_delivery_pointers'), 0)
    assert.equal(await failedFixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await failedFixture.count('target_proof_operations'), 0)
    assert.equal(await failedFixture.count('custody_active_work'), 0)
  } finally {
    await failedFixture.removeOutgoingTransferAbort('insert')
    await failedFixture.close()
  }

  const conflictFixture = await createFixture({ scoreFunds: true })
  try {
    const automaticId = '64646464-6464-4464-8464-646464646464'
    await conflictFixture.coordinator.preflightParticipationScoreDelivery({
      transferId: automaticId,
      amountMsat: 8_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    const competingId = '65656565-6565-4565-8565-656565656565'
    const competingMetadata = createParticipationScoreDeliveryMetadata({
      deliveryId: competingId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    await assert.rejects(
      conflictFixture.coordinator.executeParticipationScore({
        transferId: competingId,
        amountMsat: 8_000,
        purchasedTotalEpoch: 4,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
        wallet: conflictFixture.scoreWallet(async () => {
          throw new Error('conflicting automatic pointer must not dispatch')
        }),
        deliveryIntent: participationScoreDeliveryIntent({
          accountSubject: competingMetadata.accountSubject,
          productBindingSha256: competingMetadata.productBindingSha256,
          tokenBytesLimit: deriveDurableRecipientTokenAllowance(competingMetadata),
        }),
        maxWalletDebitMsat: 8_000,
      }),
      /conflicts with the active delivery/,
    )
    const preserved = await conflictFixture.coordinator.preflightParticipationScoreDelivery({
      transferId: competingId,
      amountMsat: 4_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    assert.equal(preserved.transferId, automaticId)
    assert.equal(await conflictFixture.count('daemon_participation_score_delivery_pointers'), 1)
    assert.equal(await conflictFixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await conflictFixture.count('target_proof_operations'), 0)
    assert.equal(await conflictFixture.count('custody_active_work'), 0)
  } finally {
    await conflictFixture.close()
  }
})

test('standalone Score exact retry recovers the same prepared transfer', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const deliveryId = '66666666-6666-4666-8666-666666666666'
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const intent = participationScoreDeliveryIntent({
      accountSubject: metadata.accountSubject,
      productBindingSha256: metadata.productBindingSha256,
      tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
    })
    let mintCalls = 0
    let preparationCalls = 0
    const wallet = fixture.scoreWallet(async () => {
      mintCalls += 1
      if (mintCalls === 1) throw new Error('mint response was interrupted')
      return { keep: fixture.scoreKeepProofs, send: fixture.scoreSendProofs }
    })
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (...args) => {
      preparationCalls += 1
      return prepare(...args)
    }
    const input = {
      transferId: deliveryId,
      amountMsat: 8_000,
      purchasedTotalEpoch: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      wallet,
      deliveryIntent: intent,
      maxWalletDebitMsat: 8_000,
    }
    await assert.rejects(fixture.coordinator.executeParticipationScore(input), /interrupted/)
    assert.equal(preparationCalls, 1)
    const prepared = await fixture.transfer(deliveryId)
    assert.ok(prepared)
    assert.equal(prepared.deliveryState, 'prepared')
    const pointer = await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: deliveryId,
      amountMsat: 8_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requireExactRequest: true,
    })
    assert.equal(pointer.transferId, deliveryId)
    const retried = await fixture.coordinator.executeParticipationScore(input)
    assert.equal(retried.deliveryState, 'delivery-pending')
    assert.equal(preparationCalls, 1)
    assert.equal(mintCalls, 2)
    assert.equal(await fixture.count('daemon_participation_score_delivery_pointers'), 1)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
  } finally {
    await fixture.close()
  }
})

test('standalone Score admits a distinct purchase after the prior purchase is credited', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const firstId = '67676767-6767-4767-8767-676767676767'
    const firstMetadata = createParticipationScoreDeliveryMetadata({
      deliveryId: firstId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const firstIntent = participationScoreDeliveryIntent({
      accountSubject: firstMetadata.accountSubject,
      productBindingSha256: firstMetadata.productBindingSha256,
      tokenBytesLimit: deriveDurableRecipientTokenAllowance(firstMetadata),
    })
    const firstWallet = fixture.scoreWallet(async () => ({
      keep: fixture.scoreKeepProofs,
      send: fixture.scoreSendProofs,
    }))
    const firstTransfer = await fixture.coordinator.executeParticipationScore({
      transferId: firstId,
      amountMsat: 8_000,
      purchasedTotalEpoch: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      wallet: firstWallet,
      deliveryIntent: firstIntent,
      maxWalletDebitMsat: 8_000,
    })
    assert.ok(firstTransfer.token)
    const firstSubmission = createParticipationScoreDeliverySubmission({
      metadata: firstMetadata,
      token: firstTransfer.token.encodedToken,
    })
    const firstCredit = await fixture.coordinator.reconcileRecipientDelivery({
      transfer: firstTransfer,
      submission: firstSubmission,
      client: {
        getDurableRecipientDeliveryStatus: async () => recipientStatus(firstSubmission, 'credited'),
        submitDurableRecipientDelivery: async () => {
          throw new Error('credited Score status must not repost')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })
    assert.equal(firstCredit.transfer.deliveryState, 'recipient-acknowledged')

    const sendOutputs = [2_048, 1_024, 512, 256, 128, 32].map((amount, index) =>
      OutputData.createSingleData(
        amount,
        MSAT_KEYSET_ID,
        `next-score-send-${index}`,
        BigInt(90 + index),
      ),
    )
    const keepOutputs = [2_048, 1_024, 512, 128, 64, 32].map((amount, index) =>
      OutputData.createSingleData(
        amount,
        MSAT_KEYSET_ID,
        `next-score-keep-${index}`,
        BigInt(100 + index),
      ),
    )
    const secondId = '68686868-6868-4868-8868-686868686868'
    const secondMetadata = createParticipationScoreDeliveryMetadata({
      deliveryId: secondId,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '4000',
    })
    const secondWallet = fixture.scoreWallet(
      async () => ({
        keep: keepOutputs.map((output) => signedProof(output, MSAT_KEYS)),
        send: sendOutputs.map((output) => signedProof(output, MSAT_KEYS)),
      }),
      CheckStateEnum.UNSPENT,
      { sendOutputs, keepOutputs },
      4_000,
    )
    const secondTransfer = await fixture.coordinator.executeParticipationScore({
      transferId: secondId,
      amountMsat: 4_000,
      purchasedTotalEpoch: 4,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      wallet: secondWallet,
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: secondMetadata.accountSubject,
        productBindingSha256: secondMetadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(secondMetadata),
      }),
      maxWalletDebitMsat: 4_000,
    })
    assert.ok(secondTransfer.token)
    const secondSubmission = createParticipationScoreDeliverySubmission({
      metadata: secondMetadata,
      token: secondTransfer.token.encodedToken,
    })
    const secondCredit = await fixture.coordinator.reconcileRecipientDelivery({
      transfer: secondTransfer,
      submission: secondSubmission,
      client: {
        getDurableRecipientDeliveryStatus: async () =>
          recipientStatus(secondSubmission, 'credited'),
        submitDurableRecipientDelivery: async () => {
          throw new Error('credited Score status must not repost')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })
    assert.equal(secondCredit.transfer.deliveryState, 'recipient-acknowledged')
    assert.equal(await fixture.transfer(firstId), null)
    assert.equal((await fixture.transfer(secondId))?.deliveryState, 'recipient-acknowledged')
    const active = await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: secondId,
      amountMsat: 4_000,
      purchasedTotal: 4,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requireExactRequest: true,
    })
    assert.equal(active.transferId, secondId)
    assert.equal(await fixture.count('daemon_participation_score_delivery_pointers'), 1)
  } finally {
    await fixture.close()
  }
})

test('Score delivery pointer retires an advanced orphan before reserving the next delivery', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const orphanId = 'f1111111-1111-4111-8111-111111111111'
    await fixture.coordinator.preflightParticipationScoreDelivery({
      transferId: orphanId,
      amountMsat: 8_000,
      purchasedTotal: 3,
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
    })
    const next = await fixture
      .coordinatorFor(fixture.fence, Date.now())
      .preflightParticipationScoreDelivery({
        transferId: 'f2222222-2222-4222-8222-222222222222',
        amountMsat: 7_000,
        purchasedTotal: 4,
        accountSubject: 'subject-1',
        mintUrl: MINT_URL,
      })

    assert.deepEqual(next, {
      transferId: 'f2222222-2222-4222-8222-222222222222',
      amountMsat: 7_000,
      purchasedTotalEpoch: 4,
    })
    assert.equal(await fixture.coordinator.loadTransfer(orphanId), null)
  } finally {
    await fixture.close()
  }
})

test('recipient recovery schedules the minted current revision after a status failure', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: 'f3333333-3333-4333-8333-333333333333',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: metadata.deliveryId,
          amountMsat: 8_000,
          mintUrl: MINT_URL,
          wallet: fixture.scoreWallet(async () => {
            throw new Error('mint response was interrupted')
          }),
          deliveryIntent: participationScoreDeliveryIntent({
            accountSubject: metadata.accountSubject,
            productBindingSha256: metadata.productBindingSha256,
            tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
          }),
        }),
      /mint response was interrupted/,
    )
    const prepared = await fixture.transfer(metadata.deliveryId)
    assert.equal(prepared?.deliveryState, 'prepared')

    const recovery = await fixture.coordinator.recoverDue({
      walletFor: async () =>
        fixture.scoreWallet(async () => ({
          keep: fixture.scoreKeepProofs,
          send: fixture.scoreSendProofs,
        })),
      recipientClient: {
        getDurableRecipientDeliveryStatus: async () => {
          throw new Error('engine status is unavailable')
        },
        submitDurableRecipientDelivery: async () => {
          throw new Error('status failure must contain this row before POST')
        },
      },
      recipientSubmission: (transfer) => {
        assert.equal(transfer.deliveryState, 'delivery-pending')
        assert.ok(transfer.token)
        return createParticipationScoreDeliverySubmission({
          metadata,
          token: transfer.token!.encodedToken,
        })
      },
      acknowledgeRecipientStatus: (status) => status.state === 'credited',
    })

    assert.equal(recovery.recovered.length, 0)
    assert.equal(recovery.pending.length, 1)
    assert.equal(recovery.pending[0]?.transferId, metadata.deliveryId)
    assert.match(recovery.pending[0]?.error ?? '', /engine status is unavailable/)
    const persisted = await fixture.transfer(metadata.deliveryId)
    assert.equal(persisted?.deliveryState, 'delivery-pending')
    assert.equal(persisted?.revision, (prepared?.revision ?? 0) + 2)
    assert.equal(persisted?.recovery.attemptCount, (prepared?.recovery.attemptCount ?? 0) + 1)
  } finally {
    await fixture.close()
  }
})

test('recipient delivery posts an absent exact token once and recovers an ambiguous POST from status', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '22222222-2222-4222-8222-222222222222',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const transfer = await fixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    assert.ok(transfer.token)
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: transfer.token!.encodedToken,
    })
    let reads = 0
    let posted: string | null = null
    const result = await fixture.coordinator.reconcileRecipientDelivery({
      transfer,
      submission,
      client: {
        getDurableRecipientDeliveryStatus: async () => {
          reads += 1
          return reads === 1 ? null : recipientStatus(submission, 'credited')
        },
        submitDurableRecipientDelivery: async (exact) => {
          posted = exact.token
          throw new Error('response lost')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })

    assert.equal(posted, transfer.token!.encodedToken)
    assert.equal(reads, 2)
    assert.equal(result.transfer.deliveryState, 'recipient-acknowledged')
  } finally {
    await fixture.close()
  }
})

test('recipient delivery retries an authenticated pending state with the exact stored token', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '23232323-2323-4232-8232-232323232323',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const transfer = await fixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    assert.ok(transfer.token)
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: transfer.token.encodedToken,
    })
    const retrySubmissions: DurableRecipientDeliverySubmission[] = []
    let statusReads = 0
    const result = await fixture.coordinator.reconcileRecipientDelivery({
      transfer,
      submission,
      client: {
        getDurableRecipientDeliveryStatus: async () => {
          statusReads += 1
          return recipientStatus(submission, 'pending')
        },
        submitDurableRecipientDelivery: async (exact) => {
          retrySubmissions.push(exact)
          return recipientStatus(exact, 'pending')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })
    assert.equal(retrySubmissions.length, 1)
    assert.deepEqual(retrySubmissions[0], submission)
    assert.equal(statusReads, 2)
    assert.equal(result.status?.state, 'pending')
    assert.equal(result.transfer.deliveryState, 'delivery-pending')
  } finally {
    await fixture.close()
  }
})

test('received recipient delivery remains nonterminal and retries from its admitted revision', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: 'abababab-abab-4bab-8bab-abababababab',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const admitted = await fixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    assert.ok(admitted.token)
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: admitted.token.encodedToken,
    })
    const result = await fixture.coordinator.reconcileRecipientDelivery({
      transfer: admitted,
      submission,
      client: {
        getDurableRecipientDeliveryStatus: async () => recipientStatus(submission, 'received'),
        submitDurableRecipientDelivery: async () => {
          throw new Error('received delivery must not post')
        },
      },
      acknowledge: (status) => status.state === 'credited',
    })

    assert.equal(result.status?.state, 'received')
    assert.equal(result.transfer.deliveryState, 'delivery-pending')
    assert.equal(result.transfer.revision, admitted.revision + 1)
    assert.equal((await fixture.transfer(admitted.transferId))?.revision, result.transfer.revision)
  } finally {
    await fixture.close()
  }
})

test('recipient delivery rejects a persisted transfer with a conflicting exact tuple', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '33333333-3333-4333-8333-333333333333',
      accountSubject: 'subject-1',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const intent = participationScoreDeliveryIntent({
      accountSubject: metadata.accountSubject,
      productBindingSha256: metadata.productBindingSha256,
      tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
    })
    const transfer = await fixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: intent,
    })
    assert.ok(transfer.token)
    const submission = createParticipationScoreDeliverySubmission({
      metadata: { ...metadata, accountSubject: 'other-subject' },
      token: transfer.token!.encodedToken,
    })
    await assert.rejects(
      () =>
        fixture.coordinator.reconcileRecipientDelivery({
          transfer,
          submission,
          client: {
            getDurableRecipientDeliveryStatus: async () => null,
            submitDurableRecipientDelivery: async () => recipientStatus(submission, 'pending'),
          },
          acknowledge: (status) => status.state === 'credited',
        }),
      /conflicts/,
    )

    let statusReads = 0
    let posts = 0
    const foreignToken = createParticipationScoreDeliverySubmission({
      metadata,
      token: 'cashuBother-token',
    })
    await assert.rejects(
      () =>
        fixture.coordinator.reconcileRecipientDelivery({
          transfer,
          submission: foreignToken,
          client: {
            getDurableRecipientDeliveryStatus: async () => {
              statusReads += 1
              return recipientStatus(foreignToken, 'pending')
            },
            submitDurableRecipientDelivery: async () => {
              posts += 1
              return recipientStatus(foreignToken, 'pending')
            },
          },
          acknowledge: () => false,
        }),
      /conflicts/,
    )
    assert.equal(statusReads, 0)
    assert.equal(posts, 0)
  } finally {
    await fixture.close()
  }
})

test('post-mint failure remains recoverable from its exact persisted operation without selecting new proofs', async () => {
  const fixture = await createFixture()
  try {
    let selected = 0
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-recover',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet: fixture.wallet(async () => {
            selected += 1
            throw new Error('response lost after mint')
          }),
        }),
      /response lost after mint/,
    )
    const prepared = await fixture.transfer('outgoing-recover')
    assert.ok(prepared)
    const recovered = await fixture.coordinator.recover({
      transfer: prepared!,
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => {
        throw new Error('recovery must not select or mint a new plan')
      }, CheckStateEnum.SPENT),
    })
    assert.equal(selected, 1)
    assert.ok(recovered.token)
    assert.equal(await fixture.count('target_wallet_proofs'), 2)
  } finally {
    await fixture.close()
  }
})

test('automatic recovery classifies a persisted bearer token without minting or emitting it', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-auto',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let wallets = 0
    let checks = 0
    const result = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        wallets += 1
        const wallet = fixture.wallet(async () => {
          throw new Error('automatic recovery must not mint or present a token')
        })
        return {
          ...wallet,
          checkProofsStates: async (proofs) => {
            checks += 1
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            }))
          },
        }
      },
    })
    const persisted = await fixture.transfer(transfer.transferId)
    assert.equal(wallets, 1)
    assert.equal(checks, 1)
    assert.deepEqual(result.pending, [])
    assert.equal(result.hasMore, false)
    assert.equal(result.hasPending, true)
    assert.equal(result.hasBlockingPending, false)
    assert.equal(persisted?.deliveryState, 'delivery-pending')
    assert.equal(persisted?.recovery.attemptCount, 1)
    assert.ok((persisted?.recovery.dueAtMs ?? 0) > 0)
    const futureDue = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        throw new Error('future-due transfer must not open a wallet')
      },
    })
    assert.deepEqual(futureDue.pending, [])
    assert.equal(futureDue.hasMore, false)
    assert.equal(futureDue.hasPending, true)
    assert.equal(futureDue.hasBlockingPending, false)
  } finally {
    await fixture.close()
  }
})

test('automatic recovery retries every transfer in a malformed proof-state response chunk', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-malformed-state-response',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const before = await fixture.transfer(transfer.transferId)
    let mintCalls = 0
    const result = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        const wallet = fixture.wallet(async () => {
          mintCalls += 1
          throw new Error('automatic recovery must not mint')
        })
        return {
          ...wallet,
          checkProofsStates: async (proofs) =>
            proofs.slice(0, -1).map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            })),
        }
      },
    })

    const persisted = await fixture.transfer(transfer.transferId)
    assert.equal(mintCalls, 0)
    assert.deepEqual(result.recovered, [])
    assert.deepEqual(
      result.pending.map(({ transferId }) => transferId),
      [transfer.transferId],
    )
    assert.match(result.pending[0]?.error ?? '', /response length/i)
    assert.equal(persisted?.recovery.attemptCount, (before?.recovery.attemptCount ?? 0) + 1)
    assert.ok((persisted?.recovery.dueAtMs ?? 0) > (before?.recovery.dueAtMs ?? 0))
  } finally {
    await fixture.close()
  }
})

test('fresh explicit reclaim reactivates only its classified bearer proofs and admits exact successors', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-reclaim',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'reclaim-successor-four', 20n),
      OutputData.createSingleData(1, KEYSET_ID, 'reclaim-successor-one', 21n),
    ]
    const successors = successorOutputs.map((output) => signedProof(output))
    await fixture.advanceCounter(22)
    let checks = 0
    const reclaimed = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: fixture.reclaimWallet({
        successorOutputs,
        successors,
        proofState: () => {
          checks += 1
          return CheckStateEnum.UNSPENT
        },
      }),
    })

    assert.equal(reclaimed.deliveryState, 'reclaimed')
    const item = await assertWithdrawalActivity(fixture, 'Failed', 0)
    assert.equal(item.failureReason, 'Cancelled; funds reclaimed')
    assert.equal(checks, 2)
    await assert.rejects(
      () =>
        fixture.coordinator.classifyBearerTransfer({
          transferId: transfer.transferId,
          wallet: fixture.reclaimWallet({
            successorOutputs: [],
            successors: [],
            proofState: () => {
              throw new Error('reclaimed transfer must not query mint state')
            },
          }),
        }),
      /classification is not authorized/,
    )
    assert.equal(checks, 2)
    assert.equal(await fixture.custodySelectability(successors[0]!), 'retained')
    assert.equal(await fixture.targetWalletHasProof(successors[0]!), true)
    const predecessor = reclaimed.reclaim?.proofs[0]
    const evidence = reclaimed.reclaim?.completionEvidence
    assert.ok(predecessor)
    assert.ok(evidence)
    const identity = deriveDurableCustodyArtifactFingerprint({
      id: predecessor.id,
      secret: predecessor.secret,
      C: predecessor.C,
    })
    assert.equal(
      evidence.custodyRevisions.find((entry) => entry.proofIdentity === identity)?.revision,
      await fixture.custodyRevision(predecessor),
    )
  } finally {
    await fixture.close()
  }
})

test('fresh all-spent reclaim returns terminal success and repeats without mint work', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-already-spent',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let checks = 0
    const firstWallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => {
        checks += 1
        return CheckStateEnum.SPENT
      },
    })
    firstWallet.prepareSwapToReceive = async () => {
      throw new Error('all-spent reclaim must not prepare a mint request')
    }

    const terminal = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: firstWallet,
    })
    const retryWallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => {
        throw new Error('terminal reclaim retry must not classify again')
      },
    })
    const retry = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: retryWallet,
    })

    assert.equal(checks, 1)
    assert.equal(terminal.deliveryState, 'bearer-spent')
    assert.equal(retry.deliveryState, 'bearer-spent')
    assert.equal(retry.revision, terminal.revision)
  } finally {
    await fixture.close()
  }
})

test('bearer classification persists exact all-spent state and terminal retries do no mint work', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-classify-spent',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const persistedBefore = await fixture.transfer(transfer.transferId)
    assert.ok(persistedBefore?.token)
    let checks = 0
    const wallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => {
        checks += 1
        return CheckStateEnum.SPENT
      },
    })
    wallet.prepareSwapToReceive = async () => {
      throw new Error('bearer classification must not prepare a reclaim')
    }
    wallet.completeSwap = async () => {
      throw new Error('bearer classification must not complete a swap')
    }
    wallet.send = async () => {
      throw new Error('bearer classification must not send')
    }
    wallet.receive = async () => {
      throw new Error('bearer classification must not receive')
    }

    const classified = await fixture.coordinator.classifyBearerTransfer({
      transferId: transfer.transferId,
      wallet,
    })
    const terminal = await fixture.transfer(transfer.transferId)
    const retry = await fixture.coordinator.classifyBearerTransfer({
      transferId: transfer.transferId,
      wallet: {
        ...wallet,
        checkProofsStates: async () => {
          throw new Error('terminal bearer retry must not query mint state')
        },
      },
    })

    assert.equal(checks, 1)
    assert.equal(classified.deliveryState, 'bearer-spent')
    await assertWithdrawalActivity(fixture, 'completed', 5)
    assert.equal(retry.deliveryState, 'bearer-spent')
    assert.equal(retry.tokenDigest, persistedBefore.token.sha256)
    assert.equal(Object.hasOwn(classified, 'token'), false)
    assert.equal(terminal?.deliveryState, 'bearer-spent')
    assert.equal((await fixture.transfer(transfer.transferId))?.revision, terminal?.revision)
  } finally {
    await fixture.close()
  }
})

test('bearer classification keeps an all-unspent token pending and does not prepare reclaim', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-classify-unspent',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const wallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => CheckStateEnum.UNSPENT,
    })
    wallet.prepareSwapToReceive = async () => {
      throw new Error('read-only bearer classification must not prepare a reclaim')
    }

    const classified = await fixture.coordinator.classifyBearerTransfer({
      transferId: transfer.transferId,
      wallet,
    })
    const persisted = await fixture.transfer(transfer.transferId)

    assert.equal(classified.deliveryState, 'delivery-pending')
    assert.equal(persisted?.deliveryState, 'delivery-pending')
    assert.equal(persisted?.reclaim, null)
    await assertWithdrawalActivity(fixture, 'pending', 5)
    assert.equal(persisted?.token?.unspentProofs?.length, transfer.token?.proofs.length)
  } finally {
    await fixture.close()
  }
})

test('malformed bearer proof-state response cannot terminalize the persisted token', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-classify-malformed',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const wallet = fixture.reclaimWallet({
      successorOutputs: [],
      successors: [],
      proofState: () => CheckStateEnum.SPENT,
    })
    wallet.checkProofsStates = async (proofs) =>
      proofs.map((proof, index) => ({
        Y:
          index === 0
            ? 'malformed-y'
            : hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
        state: CheckStateEnum.SPENT,
        witness: null,
      }))

    const classified = await fixture.coordinator.classifyBearerTransfer({
      transferId: transfer.transferId,
      wallet,
    })
    const persisted = await fixture.transfer(transfer.transferId)

    assert.equal(classified.deliveryState, 'delivery-pending')
    assert.equal(persisted?.deliveryState, 'delivery-pending')
    assert.ok(persisted?.token)
    assert.equal(persisted?.reclaim, null)
    await assertWithdrawalActivity(fixture, 'pending', 5)
  } finally {
    await fixture.close()
  }
})

test('bearer classification rejects recipient-ack transfers before querying the mint', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '44444444-4444-4444-8444-444444444444',
      accountSubject: 'subject-classify',
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const transfer = await fixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fixture.scoreWallet(async () => ({
        keep: fixture.scoreKeepProofs,
        send: fixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    let checks = 0
    const wallet = fixture.scoreWallet(async () => ({
      keep: fixture.scoreKeepProofs,
      send: fixture.scoreSendProofs,
    }))
    wallet.checkProofsStates = async () => {
      checks += 1
      return []
    }

    await assert.rejects(
      () =>
        fixture.coordinator.classifyBearerTransfer({
          transferId: transfer.transferId,
          wallet,
        }),
      /classification is not authorized/,
    )
    assert.equal(checks, 0)
    assert.equal((await fixture.activity()).length, 0)
    assert.equal((await fixture.transfer(transfer.transferId))?.revision, transfer.revision)
  } finally {
    await fixture.close()
  }
})

test('recipient-spent reclaim terminalizes its linked receive operation in the same recovery action', async () => {
  const fixture = await createFixture({
    restoreOutputGroups: async () => ({ keep: [], send: [] }),
  })
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-recipient-spent',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    let checks = 0
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'recipient-spent-four', 22n),
      OutputData.createSingleData(1, KEYSET_ID, 'recipient-spent-one', 23n),
    ]
    await fixture.advanceCounter(24)
    const terminal = await fixture.coordinator.reclaim({
      transferId: transfer.transferId,
      wallet: fixture.reclaimWallet({
        successors: successorOutputs.map((output) => signedProof(output)),
        successorOutputs,
        proofState: () => {
          checks += 1
          return checks === 1 ? CheckStateEnum.UNSPENT : CheckStateEnum.SPENT
        },
      }),
    })

    assert.equal(terminal.deliveryState, 'bearer-spent')
    await assertWithdrawalActivity(fixture, 'completed', 5)
    assert.equal(terminal.reclaim, null)
    assert.equal(await fixture.activeReclaimWorkCount(), 0)
  } finally {
    await fixture.close()
  }
})

test('preparation failure leaves the exact custody proof selectable and creates no transfer', async () => {
  const fixture = await createFixture()
  try {
    const wallet = fixture.wallet(async () => {
      throw new Error('completeSwap must not run after a preparation failure')
    })
    wallet.prepareSwapToSend = async () => {
      throw new Error('preparation failed before mint I/O')
    }

    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-preparation-failure',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /preparation failed before mint I\/O/,
    )

    assert.equal(await fixture.transfer('outgoing-preparation-failure'), null)
    assert.equal(await fixture.custodySelectability(fixture.inputProof), 'selectable')
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
  } finally {
    await fixture.close()
  }
})

test('durable send rejects a mint result that differs from its persisted deterministic output plan', async () => {
  const fixture = await createFixture()
  try {
    const wallet = fixture.wallet(async () => ({
      keep: fixture.keepProofs,
      send: fixture.sendProofs,
    }))
    wallet.completeSwap = async () => ({ keep: [], send: [fixture.sendProofs[0]!] })
    const initialTargetProofCount = await fixture.count('target_wallet_proofs')

    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-wrong-mint-result',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /exact output plan/,
    )

    const transfer = await fixture.transfer('outgoing-wrong-mint-result')
    assert.equal(transfer?.deliveryState, 'prepared')
    assert.equal(transfer?.token, null)
    assert.equal(await fixture.count('target_wallet_proofs'), initialTargetProofCount)
  } finally {
    await fixture.close()
  }
})

test('failed deterministic preparation does not reuse its reserved counter range', async () => {
  const fixture = await createFixture()
  try {
    const wallet = fixture.wallet(async () => ({
      keep: fixture.keepProofs,
      send: fixture.sendProofs,
    }))
    const prepare = wallet.prepareSwapToSend
    let failFirstPreparation = true
    const ranges: OperationCounters[] = []
    wallet.prepareSwapToSend = async (amount, proofs, config, outputConfig) => {
      const deterministicConfig = config as {
        onCountersReserved?: (counters: OperationCounters) => void
      }
      const onCountersReserved = deterministicConfig.onCountersReserved
      const preview = await prepare(
        amount,
        proofs,
        {
          ...deterministicConfig,
          onCountersReserved: (counters: OperationCounters) => {
            ranges.push(counters)
            onCountersReserved?.(counters)
          },
        },
        outputConfig,
      )
      if (failFirstPreparation) {
        failFirstPreparation = false
        return { ...preview, keepOutputs: [] }
      }
      return preview
    }

    await assert.rejects(
      fixture.coordinator.execute({
        transferId: 'outgoing-failed-deterministic-prepare',
        amountMsat: 5,
        mintUrl: MINT_URL,
        wallet,
      }),
      /counter reservation conflicts with the output plan/,
    )
    assert.equal(await fixture.transfer('outgoing-failed-deterministic-prepare'), null)
    assert.equal((await fixture.counterNext(KEYSET_ID))?.nextCounter, 4)

    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-after-failed-deterministic-prepare',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet,
    })
    assert.equal(transfer.deliveryState, 'delivery-pending')
    assert.deepEqual(
      ranges.map(({ start, count }) => ({ start, count })),
      [
        { start: 0, count: 4 },
        { start: 4, count: 4 },
      ],
    )
    assert.deepEqual(transfer.keepProofDerivationLocators, [
      { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 6 },
      { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 7 },
    ])
    assert.equal((await fixture.counterNext(KEYSET_ID))?.nextCounter, 8)
  } finally {
    await fixture.close()
  }
})

test('outgoing insert failure rolls back the custody bind and target reservation', async () => {
  const fixture = await createFixture()
  try {
    await fixture.installOutgoingTransferAbort('insert')
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-insert-rollback',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet: fixture.wallet(async () => ({
            keep: fixture.keepProofs,
            send: fixture.sendProofs,
          })),
        }),
      /outgoing transfer insert fault/,
    )
    await fixture.removeOutgoingTransferAbort('insert')

    assert.equal(await fixture.custodySelectability(fixture.inputProof), 'selectable')
    assert.equal(await fixture.count('target_proof_operations'), 0)
    assert.equal(await fixture.count('custody_operations'), 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await fixture.count('custody_artifacts'), 0)
    assert.equal((await fixture.activity()).length, 0)
  } finally {
    await fixture.close()
  }
})

test('outgoing post-mint update failure admits no successors and exact recovery reuses its plan', async () => {
  const fixture = await createFixture()
  try {
    let prepares = 0
    const wallet = fixture.wallet(async () => ({
      keep: fixture.keepProofs,
      send: fixture.sendProofs,
    }))
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (...input) => {
      prepares += 1
      return prepare(...input)
    }
    await fixture.installOutgoingTransferAbort('update')
    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-update-rollback',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /outgoing transfer update fault/,
    )
    await fixture.removeOutgoingTransferAbort('update')

    assert.equal(prepares, 1)
    const originalActivity = await assertWithdrawalActivity(fixture, 'pending', 5)
    assert.equal(await fixture.count('custody_proofs'), 1)
    assert.equal(await fixture.count('target_wallet_proofs'), 1)
    await fixture.removeOutgoingTransferAbort('update')

    const prepared = await fixture.transfer('outgoing-update-rollback')
    assert.ok(prepared)
    const recovered = await fixture.coordinator.recover({
      transfer: prepared!,
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet,
    })
    assert.ok(recovered.token)
    const recoveredActivity = await assertWithdrawalActivity(fixture, 'pending', 5)
    assert.deepEqual(recoveredActivity, originalActivity)
    assert.equal(prepares, 1)
  } finally {
    await fixture.close()
  }
})

test('reclaim-prepared work resumes after restart without preparing a second receive operation', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-reclaim-restart',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'reclaim-restart-four', 30n),
      OutputData.createSingleData(1, KEYSET_ID, 'reclaim-restart-one', 31n),
    ]
    const successors = successorOutputs.map((output) => signedProof(output))
    await fixture.advanceCounter(32)
    const interrupted = fixture.reclaimWallet({
      successors,
      successorOutputs,
      proofState: () => CheckStateEnum.UNSPENT,
    })
    interrupted.completeSwap = async () => {
      throw new Error('mint response was interrupted')
    }
    await assert.rejects(
      () => fixture.coordinator.reclaim({ transferId: transfer.transferId, wallet: interrupted }),
      /mint response was interrupted/,
    )
    assert.equal((await fixture.transfer(transfer.transferId))?.deliveryState, 'reclaim-prepared')
    const originalActivity = await assertWithdrawalActivity(fixture, 'pending', 5)
    interrupted.checkProofsStates = async () => {
      throw new Error('reclaim-prepared classification must not query mint state')
    }
    await assert.rejects(
      () =>
        fixture.coordinator.classifyBearerTransfer({
          transferId: transfer.transferId,
          wallet: interrupted,
        }),
      /classification is not authorized/,
    )

    let preparations = 0
    const recovery = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        const wallet = fixture.reclaimWallet({
          successors,
          successorOutputs,
          proofState: () => CheckStateEnum.UNSPENT,
        })
        const prepare = wallet.prepareSwapToReceive!
        wallet.prepareSwapToReceive = async (...args) => {
          preparations += 1
          return prepare(...args)
        }
        return wallet
      },
    })

    assert.deepEqual(recovery.pending, [])
    assert.deepEqual(recovery.recovered, [transfer.transferId])
    assert.equal(preparations, 0)
    assert.equal((await fixture.transfer(transfer.transferId))?.deliveryState, 'reclaimed')
    assert.equal(await fixture.targetWalletHasProof(successors[0]!), true)
    const recoveredActivity = await assertWithdrawalActivity(fixture, 'Failed', 0)
    assert.equal(recoveredActivity.id, originalActivity.id)
    assert.equal(recoveredActivity.date, originalActivity.date)
  } finally {
    await fixture.close()
  }
})

test('automatic reclaim recovery backs off a nonterminal exact reclaim without a new plan or token', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-reclaim-nonterminal',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'reclaim-pending-four', 34n),
      OutputData.createSingleData(1, KEYSET_ID, 'reclaim-pending-one', 35n),
    ]
    const successors = successorOutputs.map((output) => signedProof(output))
    await fixture.advanceCounter(36)
    const interrupted = fixture.reclaimWallet({
      successors,
      successorOutputs,
      proofState: () => CheckStateEnum.UNSPENT,
    })
    interrupted.completeSwap = async () => {
      throw new Error('reclaim response was interrupted')
    }
    await assert.rejects(
      () => fixture.coordinator.reclaim({ transferId: transfer.transferId, wallet: interrupted }),
      /reclaim response was interrupted/,
    )
    const before = await fixture.transfer(transfer.transferId)
    let preparations = 0
    let mintCalls = 0
    const recovery = await fixture.coordinator.recoverDue({
      walletFor: async () => {
        const wallet = fixture.reclaimWallet({
          successors,
          successorOutputs,
          proofState: () => CheckStateEnum.PENDING,
        })
        const prepare = wallet.prepareSwapToReceive!
        wallet.prepareSwapToReceive = async (...args) => {
          preparations += 1
          return prepare(...args)
        }
        wallet.completeSwap = async () => {
          mintCalls += 1
          throw new Error('nonterminal reclaim must not mint')
        }
        return wallet
      },
    })

    const persisted = await fixture.transfer(transfer.transferId)
    assert.deepEqual(recovery.recovered, [])
    assert.deepEqual(
      recovery.pending.map(({ transferId }) => transferId),
      [transfer.transferId],
    )
    assert.match(recovery.pending[0]?.error ?? '', /reclaim remains pending/i)
    assert.equal(preparations, 0)
    assert.equal(mintCalls, 0)
    assert.equal(persisted?.deliveryState, 'reclaim-prepared')
    assert.equal(recovery.hasPending, true)
    assert.equal(recovery.hasBlockingPending, true)
    assert.equal(persisted?.recovery.attemptCount, (before?.recovery.attemptCount ?? 0) + 1)
    assert.ok((persisted?.recovery.dueAtMs ?? 0) > (before?.recovery.dueAtMs ?? 0))
  } finally {
    await fixture.close()
  }
})

test('durable send gives cashu-ts all eligible proofs for nonzero input fees and reserves only its preview inputs', async () => {
  const fixture = await createFixture()
  try {
    await fixture.addAvailableInput(MINT_URL, 'fee-aware-input-one', FEE_KEYSET_ID, 999n)
    await fixture.addAvailableInput(MINT_URL, 'fee-aware-input-two', FEE_KEYSET_ID, 1000n)
    const sendOutputs = [
      OutputData.createSingleData(4, FEE_KEYSET_ID, 'fee-aware-send-four', 40n),
      OutputData.createSingleData(1, FEE_KEYSET_ID, 'fee-aware-send-one', 41n),
    ]
    const keepOutputs = [
      OutputData.createSingleData(8, FEE_KEYSET_ID, 'fee-aware-keep-eight', 42n),
      OutputData.createSingleData(2, FEE_KEYSET_ID, 'fee-aware-keep-two', 43n),
    ]
    const wallet = fixture.wallet(
      async () => ({
        keep: [...keepOutputs.map((output) => signedProof(output)), fixture.inputProof],
        send: sendOutputs.map((output) => signedProof(output)),
      }),
      CheckStateEnum.UNSPENT,
      { sendOutputs, keepOutputs },
    )
    let previewInputs: Proof[] = []
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (_amount, proofs, config, outputConfig) => {
      const preview = await prepare(_amount, proofs, config, outputConfig)
      assert.equal(proofs.length, 3)
      previewInputs = proofs.filter((proof) => proof.id === FEE_KEYSET_ID)
      assert.equal(previewInputs.length, 2)
      return {
        ...preview,
        amount: Amount.from(5),
        fees: Amount.from(1),
        keysetId: FEE_KEYSET_ID,
        inputs: previewInputs,
        unselectedProofs: proofs.filter((proof) => proof.id !== FEE_KEYSET_ID),
      }
    }
    wallet.getKeyset = (id) => ({
      id: id ?? FEE_KEYSET_ID,
      unit: 'msat',
      keys: KEYS,
      fee: id === FEE_KEYSET_ID ? 500 : 0,
      verify: () => true,
    })

    await fixture.coordinator.execute({
      transferId: 'outgoing-fee-aware-selection',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet,
    })

    assert.equal(previewInputs.length, 2)
    assert.equal(await fixture.custodySelectability(previewInputs[0]!), 'spent')
    assert.equal(await fixture.custodySelectability(previewInputs[1]!), 'spent')
    assert.equal(await fixture.custodySelectability(fixture.inputProof), 'selectable')
    assert.equal(await fixture.custodyRevision(fixture.inputProof), 0)
  } finally {
    await fixture.close()
  }
})

test('durable send hydrates passthrough proofs before canonical custody completion', async () => {
  const fixture = await createFixture()
  try {
    const selectedProofs = [fixture.inputProof]
    for (let index = 0; index < 16; index += 1) {
      selectedProofs.push(
        await fixture.addAvailableInput(MINT_URL, `passthrough-selected-${index}`),
      )
    }
    const passthroughProofs: Proof[] = []
    for (let index = 0; index < 47; index += 1) {
      const proof = signedProof(
        OutputData.createSingleData(
          8,
          KEYSET_ID,
          `passthrough-unselected-${index}`,
          BigInt(200 + index),
        ),
      )
      const { p2pkE: _p2pkE, ...canonicalProof } = proof
      passthroughProofs.push(await fixture.addAvailableProof(MINT_URL, canonicalProof))
    }
    const sendAmounts = [128, 2, 1, 1, 1, 1, 1, 1]
    const sendOutputs = sendAmounts.map((amount, index) =>
      OutputData.createSingleData(
        amount,
        KEYSET_ID,
        `passthrough-send-${index}`,
        BigInt(300 + index),
      ),
    )
    let preparedPassthrough: Proof[] = []
    const wallet = fixture.wallet(
      async () => ({
        keep: preparedPassthrough,
        send: sendOutputs.map((output) => signedProof(output)),
      }),
      CheckStateEnum.UNSPENT,
      { sendOutputs, keepOutputs: [] },
    )
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (_amount, proofs, config, outputConfig) => {
      const preview = await prepare(_amount, proofs, config, outputConfig)
      const selected = proofs.filter((proof) =>
        selectedProofs.some(({ secret }) => secret === proof.secret),
      )
      preparedPassthrough = proofs.filter(
        (proof) => !selected.some(({ secret }) => secret === proof.secret),
      )
      assert.equal(selected.length, 17)
      assert.equal(preparedPassthrough.length, 47)
      return {
        ...preview,
        amount: Amount.from(136),
        inputs: selected,
        unselectedProofs: preparedPassthrough,
      }
    }

    const beforeState = await readState()
    const passthroughTargetBefore = passthroughProofs.map((proof) =>
      walletProofSnapshot(beforeState, proof),
    )
    const passthroughCustodyBefore = await Promise.all(
      passthroughProofs.map((proof) => fixture.custodyProofSnapshot(proof)),
    )

    const transfer = await fixture.coordinator.execute({
      transferId: 'outgoing-passthrough-hydration',
      amountMsat: 136,
      mintUrl: MINT_URL,
      wallet,
    })

    assert.equal(transfer.deliveryState, 'delivery-pending')
    const token = transfer.token
    assert.ok(token)
    assert.equal(token.proofs.length, sendOutputs.length)
    assert.equal(token.custodyRevisions.length, 17 + 47 + sendOutputs.length)
    assert.equal(await fixture.count('target_wallet_proofs'), passthroughProofs.length)
    const operation = await getProofOperation('outgoing-passthrough-hydration')
    assert.equal(operation?.state, 'completed')
    assert.equal(operation?.resultProofs?.keep?.length ?? 0, 0)
    assert.equal(operation?.resultProofs?.send?.length, sendOutputs.length)
    assert.equal(
      isDeepStrictEqual(
        (operation?.resultProofs?.send ?? [])
          .map(canonicalProofMaterial)
          .sort((left, right) => left.secret.localeCompare(right.secret)),
        token.proofs
          .map(canonicalProofMaterial)
          .sort((left, right) => left.secret.localeCompare(right.secret)),
      ),
      true,
    )
    const afterState = await readState()
    assert.equal(
      isDeepStrictEqual(
        passthroughProofs.map((proof) => walletProofSnapshot(afterState, proof)),
        passthroughTargetBefore,
      ),
      true,
    )
    assert.equal(
      isDeepStrictEqual(
        await Promise.all(passthroughProofs.map((proof) => fixture.custodyProofSnapshot(proof))),
        passthroughCustodyBefore,
      ),
      true,
    )
    for (const proof of passthroughProofs) {
      assert.equal(await fixture.targetWalletHasProof(proof), true)
      assert.equal(await fixture.custodySelectability(proof), 'selectable')
      assert.equal(await fixture.custodyRevision(proof), 0)
      const identity = deriveDurableCustodyArtifactFingerprint({
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      })
      assert.deepEqual(
        transfer.token.custodyRevisions.find((revision) => revision.proofIdentity === identity),
        { proofIdentity: identity, revision: 0 },
      )
    }
    for (const proof of selectedProofs) {
      assert.equal(await fixture.targetWalletHasProof(proof), false)
      assert.equal(await fixture.custodySelectability(proof), 'spent')
    }
    for (const proof of transfer.token.proofs) {
      assert.equal(await fixture.targetWalletHasProof(proof), false)
      assert.equal(await fixture.custodySelectability(proof), 'spent')
    }
    const replayed = await fixture.coordinator.recover({
      transfer,
      amountMsat: 136,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => {
        throw new Error('completed outgoing replay must not mint')
      }),
    })
    assert.equal(replayed.deliveryState, 'delivery-pending')
    assert.equal(replayed.token?.encodedToken, token.encodedToken)
  } finally {
    await fixture.close()
  }
})

test('durable proof admission rejects a non-V2 keyset before cashu-ts preparation', async () => {
  const fixture = await createFixture()
  try {
    await assert.rejects(
      () => fixture.addAvailableInput(MINT_URL, 'legacy-keyset-input', 'AbCdEfGhIjKl'),
      /keyset_id/,
    )
  } finally {
    await fixture.close()
  }
})

test('one bounded automatic page batches bearer classification, reuses its mint wallet, and records backoff', async () => {
  const fixture = await createFixture()
  try {
    const mintUrls = [
      MINT_URL,
      'https://mint-b.example',
      'https://mint-c.example',
      'https://mint-d.example',
      'https://mint-e.example',
    ]
    const authoritiesByMint = new Map(
      mintUrls.map(
        (mintUrl, index) =>
          [
            mintUrl,
            index === 0 ? { keysetId: KEYSET_ID, keys: KEYS } : testMintAuthority(20 + index),
          ] as const,
      ),
    )
    for (const mintUrl of mintUrls) {
      const authority = authoritiesByMint.get(mintUrl)!
      await fixture.addAvailableInput(
        mintUrl,
        `${mintUrl}-first`,
        authority.keysetId,
        999n,
        authority.keys,
        authority.privateKey,
      )
      await fixture.addAvailableInput(
        mintUrl,
        `${mintUrl}-second`,
        authority.keysetId,
        1_000n,
        authority.keys,
        authority.privateKey,
      )
    }
    const transfers = []
    for (const [mintIndex, mintUrl] of mintUrls.entries()) {
      for (const transferIndex of mintIndex === 4 ? [0] : [0, 1]) {
        const authority = authoritiesByMint.get(mintUrl)!
        const outputOffset = BigInt(100 + mintIndex * 10 + transferIndex * 2)
        const sendOutputs = [
          OutputData.createSingleData(
            4,
            authority.keysetId,
            `page-${mintIndex}-${transferIndex}-four`,
            outputOffset,
          ),
          OutputData.createSingleData(
            1,
            authority.keysetId,
            `page-${mintIndex}-${transferIndex}-one`,
            outputOffset + 1n,
          ),
        ]
        const keepOutputs = [
          OutputData.createSingleData(
            2,
            authority.keysetId,
            `page-${mintIndex}-${transferIndex}-keep-two`,
            outputOffset + 2n,
          ),
          OutputData.createSingleData(
            1,
            authority.keysetId,
            `page-${mintIndex}-${transferIndex}-keep-one`,
            outputOffset + 3n,
          ),
        ]
        const wallet = fixture.wallet(
          async () => ({
            keep: keepOutputs.map((output) =>
              signedProof(output, authority.keys, authority.privateKey),
            ),
            send: sendOutputs.map((output) =>
              signedProof(output, authority.keys, authority.privateKey),
            ),
          }),
          CheckStateEnum.UNSPENT,
          { sendOutputs, keepOutputs },
          'msat',
          undefined,
          mintUrl,
          undefined,
          authority.keys,
          authority.privateKey,
        )
        const prepare = wallet.prepareSwapToSend!
        wallet.prepareSwapToSend = async (amount, proofs, config, outputConfig) => {
          const preview = await prepare(amount, proofs, config, outputConfig)
          const selected = proofs.find(
            (proof) => proof.id === authority.keysetId && Number(proof.amount) === 8,
          )
          if (selected === undefined) throw new Error('page fixture input is missing')
          return {
            ...preview,
            inputs: [selected],
            unselectedProofs: proofs.filter((proof) => proof.secret !== selected.secret),
          }
        }
        transfers.push(
          await fixture.coordinator.execute({
            transferId: `outgoing-page-${mintIndex}-${transferIndex}`,
            amountMsat: 5,
            mintUrl,
            wallet,
          }),
        )
      }
    }

    let wallets = 0
    let checks = 0
    const result = await fixture.coordinator.recoverDue({
      walletFor: async (mintUrl) => {
        wallets += 1
        const authority = authoritiesByMint.get(mintUrl)!
        const wallet = fixture.wallet(
          async () => {
            throw new Error('automatic bearer recovery must not mint')
          },
          CheckStateEnum.UNSPENT,
          undefined,
          'msat',
          undefined,
          mintUrl,
          undefined,
          authority.keys,
          authority.privateKey,
        )
        return {
          ...wallet,
          checkProofsStates: async (proofs) => {
            checks += 1
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            }))
          },
        }
      },
    })

    assert.equal(wallets, 4)
    assert.equal(checks, 4)
    assert.equal(result.hasMore, true)
    assert.deepEqual(result.recovered, [])
    assert.equal(result.pending.length, 0)
    for (const transfer of transfers.slice(0, 8)) {
      const persisted = await fixture.transfer(transfer.transferId)
      assert.equal(persisted?.deliveryState, 'delivery-pending')
      assert.equal(persisted?.recovery.attemptCount, 1)
    }
    assert.equal((await fixture.transfer(transfers[8]!.transferId))?.recovery.attemptCount, 0)

    const second = await fixture.coordinator.recoverDue({
      walletFor: async (mintUrl) => {
        wallets += 1
        const authority = authoritiesByMint.get(mintUrl)!
        const wallet = fixture.wallet(
          async () => {
            throw new Error('automatic bearer recovery must not mint')
          },
          CheckStateEnum.UNSPENT,
          undefined,
          'msat',
          undefined,
          mintUrl,
          undefined,
          authority.keys,
          authority.privateKey,
        )
        return {
          ...wallet,
          checkProofsStates: async (proofs) => {
            checks += 1
            return proofs.map((proof) => ({
              Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
              state: CheckStateEnum.UNSPENT,
              witness: null,
            }))
          },
        }
      },
    })
    assert.equal(second.hasMore, false)
    assert.equal(wallets, 5)
    assert.equal(checks, 5)
    assert.equal((await fixture.transfer(transfers[8]!.transferId))?.recovery.attemptCount, 1)
  } finally {
    await fixture.close()
  }
})

test('a stale fence loses before mint I/O and the current fence completes the exact retry once', async () => {
  const fixture = await createFixture()
  try {
    const future = Date.now() + 120_000
    const currentFence = await fixture.takeoverFence(future)
    let mintCalls = 0
    const wallet = fixture.wallet(async () => {
      mintCalls += 1
      return { keep: fixture.keepProofs, send: fixture.sendProofs }
    })

    await assert.rejects(
      () =>
        fixture.coordinator.execute({
          transferId: 'outgoing-stale-fence',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet,
        }),
      /stale|owner changed/,
    )
    assert.equal(mintCalls, 0)
    const current = fixture.coordinatorFor(currentFence, future + 1)
    const transfer = await current.execute({
      transferId: 'outgoing-stale-fence',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(
        async () => {
          mintCalls += 1
          return { keep: fixture.keepProofs, send: fixture.sendProofs }
        },
        CheckStateEnum.UNSPENT,
        undefined,
        'msat',
        undefined,
        MINT_URL,
        currentFence,
      ),
    })
    assert.equal(transfer.deliveryState, 'delivery-pending')
    assert.equal(mintCalls, 1)
  } finally {
    await fixture.close()
  }
})

test('ordinary send quote has no bot activation threshold and does not reserve custody', async () => {
  const fixture = await createFixture()
  try {
    let mintCalls = 0
    const wallet = fixture.wallet(async () => {
      mintCalls += 1
      return { keep: fixture.keepProofs, send: fixture.sendProofs }
    })
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (...args) => ({
      ...(await prepare(...args)),
      fees: Amount.from(2),
    })
    assert.deepEqual(
      await fixture.coordinator.quoteSend({ amountMsat: 5, mintUrl: MINT_URL, wallet }),
      {
        amountMsat: 5,
        sendPreparationFeeMsat: 2,
        totalWalletDebitMsat: 7,
      },
    )
    assert.equal(mintCalls, 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await fixture.count('custody_active_work'), 0)
    assert.equal(await fixture.count('target_keyset_counters'), 0)
  } finally {
    await fixture.close()
  }
})

test('ordinary send checks the actual prepared debit before custody reservation or mint dispatch', async () => {
  const fixture = await createFixture()
  try {
    let mintCalls = 0
    const wallet = fixture.wallet(async () => {
      mintCalls += 1
      return { keep: fixture.keepProofs, send: fixture.sendProofs }
    })
    const prepare = wallet.prepareSwapToSend
    wallet.prepareSwapToSend = async (...args) => ({
      ...(await prepare(...args)),
      fees: Amount.from(2),
    })
    for (const maximum of [0, 6, NaN, 7.5]) {
      await assert.rejects(
        fixture.coordinator.execute({
          transferId: 'registration-fee',
          amountMsat: 5,
          mintUrl: MINT_URL,
          wallet,
          maxWalletDebitMsat: maximum,
        }),
        /approved maximum/,
      )
    }
    assert.equal(mintCalls, 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await fixture.count('custody_active_work'), 0)
    wallet.prepareSwapToSend = prepare
    const transfer = await fixture.coordinator.execute({
      transferId: 'registration-fee',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet,
      maxWalletDebitMsat: 5,
    })
    assert.equal(transfer.deliveryState, 'delivery-pending')
    assert.equal(mintCalls, 1)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
  } finally {
    await fixture.close()
  }
})

test('market funding quote validates the send and receive fees without reserving custody', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const proofRowsBefore = await fixture.count('target_wallet_proofs')
    let mintCalls = 0
    const wallet = fixture.scoreWallet(async () => {
      mintCalls += 1
      throw new Error('quote must not swap')
    })
    const quote = await fixture.coordinator.quoteMarketFunding({
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet,
      outcomeCount: 8,
    })
    assert.deepEqual(quote, {
      grossFundingMsat: 8_000,
      sendPreparationFeeMsat: 0,
      estimatedRecipientReceiveFeeMsat: 0,
      totalWalletDebitMsat: 8_000,
      netFundingMsat: 8_000,
    })
    const originalPreview = wallet.prepareSwapToSend
    const originalKeyset = wallet.getKeyset
    wallet.prepareSwapToSend = async (...args) => ({
      ...(await originalPreview(...args)),
      fees: Amount.from(17),
    })
    wallet.getKeyset = () => ({ ...originalKeyset(), fee: 500 })
    assert.deepEqual(
      await fixture.coordinator.quoteMarketFunding({
        amountMsat: 8_000,
        mintUrl: MINT_URL,
        wallet,
        outcomeCount: 8,
      }),
      {
        grossFundingMsat: 8_000,
        sendPreparationFeeMsat: 17,
        estimatedRecipientReceiveFeeMsat: 3,
        totalWalletDebitMsat: 8_017,
        netFundingMsat: 7_997,
      },
    )
    wallet.getKeyset = () => ({ ...originalKeyset(), fee: 1_333_001 })
    assert.equal(
      (
        await fixture.coordinator.quoteMarketFunding({
          amountMsat: 8_000,
          mintUrl: MINT_URL,
          wallet,
          outcomeCount: 2,
        })
      ).netFundingMsat,
      1,
    )
    await assert.rejects(
      () =>
        fixture.coordinator.quoteMarketFunding({
          amountMsat: 8_000,
          mintUrl: MINT_URL,
          wallet,
          outcomeCount: 8,
        }),
      /too small/,
    )
    assert.equal(mintCalls, 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    assert.equal(await fixture.count('custody_active_work'), 0)
    assert.equal(await fixture.count('target_wallet_proofs'), proofRowsBefore)
  } finally {
    await fixture.close()
  }
})

test('market funding stores the head with its custody operation and rejects a stale competing head', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createMarketFundingDeliveryMetadata({
      ...FUNDING_PRODUCT,
      deliveryId: '11111111-1111-4111-8111-111111111111',
      requestedAmount: '8000',
    })
    const intent = marketFundingDeliveryIntent({
      accountSubject: metadata.accountSubject,
      productBindingSha256: metadata.productBindingSha256,
      tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
    })
    let mintCalls = 0
    const wallet = fixture.scoreWallet(async () => {
      mintCalls += 1
      return { keep: fixture.scoreKeepProofs, send: fixture.scoreSendProofs }
    })
    await assert.rejects(
      () =>
        fixture.coordinator.executeMarketFundingTransfer({
          transferId: metadata.deliveryId,
          amountMsat: 8_000,
          mintUrl: MINT_URL,
          wallet,
          deliveryIntent: intent,
          product: FUNDING_PRODUCT,
          expectedPreviousTransferId: null,
          outcomeCount: 8,
          maxWalletDebitMsat: 7_999,
          requireCredited: async () => {
            throw new Error('initial funding has no predecessor')
          },
        }),
      /approved maximum/,
    )
    assert.equal(mintCalls, 0)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 0)
    const first = await fixture.coordinator.executeMarketFundingTransfer({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet,
      deliveryIntent: intent,
      product: FUNDING_PRODUCT,
      expectedPreviousTransferId: null,
      outcomeCount: 8,
      maxWalletDebitMsat: 8_000,
      requireCredited: async () => {
        throw new Error('initial funding has no predecessor')
      },
    })
    assert.equal(first.deliveryState, 'delivery-pending')
    assert.equal((await fixture.activity()).length, 0)
    assert.equal(first.recipientSequence?.predecessorTransferId, null)
    assert.equal(mintCalls, 1)
    assert.equal(
      (await fixture.coordinator.readMarketFundingHead(FUNDING_PRODUCT))?.transferId,
      first.transferId,
    )
    assert.equal(
      (await fixture.coordinator.findMarketFundingSuccessor(FUNDING_PRODUCT, null))?.transferId,
      first.transferId,
    )
    assert.equal(
      (await fixture.coordinator.readMarketFundingProductForTransfer(first.transferId))
        ?.conditionId,
      FUNDING_PRODUCT.conditionId,
    )
    const nextOutputs = {
      sendOutputs: [4_096, 2_048, 1_024, 512, 256, 64].map((amount, index) =>
        OutputData.createSingleData(
          amount,
          MSAT_KEYSET_ID,
          `competing-send-${index}`,
          BigInt(40 + index),
        ),
      ),
      keepOutputs: [4_096, 2_048, 1_024, 512, 256, 64].map((amount, index) =>
        OutputData.createSingleData(
          amount,
          MSAT_KEYSET_ID,
          `competing-keep-${index}`,
          BigInt(50 + index),
        ),
      ),
    }
    const competingWallet = fixture.scoreWallet(
      async () => {
        mintCalls += 1
        throw new Error('stale head must not mint')
      },
      CheckStateEnum.UNSPENT,
      nextOutputs,
    )
    await assert.rejects(
      () =>
        fixture.coordinator.executeMarketFundingTransfer({
          transferId: '22222222-2222-4222-8222-222222222222',
          amountMsat: 8_000,
          mintUrl: MINT_URL,
          wallet: competingWallet,
          deliveryIntent: intent,
          product: FUNDING_PRODUCT,
          expectedPreviousTransferId: null,
          outcomeCount: 8,
          maxWalletDebitMsat: 8_000,
          requireCredited: async () => {
            throw new Error('stale initial attempt has no predecessor')
          },
        }),
      /head changed|successor|predecessor/,
    )
    assert.equal(mintCalls, 1)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
    assert.equal(await fixture.count('custody_active_work'), 0)
  } finally {
    await fixture.close()
  }
})

test('native funding exact begin retry needs no new debit consent or mint swap', async () => {
  const fixture = await createFixture({ scoreFunds: true })
  try {
    let mintCalls = 0
    let posts = 0
    let lastSubmission: DurableRecipientDeliverySubmission | null = null
    let firstStatus: 'received' | 'credited' = 'received'
    let activeWallet = fixture.scoreWallet(async () => {
      mintCalls += 1
      return { keep: fixture.scoreKeepProofs, send: fixture.scoreSendProofs }
    })
    const deps = {
      getCustodyFence: () => fixture.fence,
      createCashuWallet: () => activeWallet,
    }
    const client = {
      getDurableRecipientDeliveryStatus: async (deliveryId: string) =>
        lastSubmission?.deliveryId === deliveryId
          ? recipientStatus(
              lastSubmission,
              deliveryId === attempt.newAttemptId ? firstStatus : 'received',
            )
          : null,
      submitDurableRecipientDelivery: async (submission: DurableRecipientDeliverySubmission) => {
        posts += 1
        lastSubmission = submission
        if (posts === 1) throw new Error('uncertain recipient response')
        return recipientStatus(submission, 'received')
      },
    }
    const common = {
      ...FUNDING_PRODUCT,
      outcomeCount: 8,
      profile: {
        engineBaseUrl: 'https://engine.example',
        mintUrl: MINT_URL,
        initializedAt: '2026-01-01T00:00:00.000Z',
      },
      secrets: { walletSeedHex: '11'.repeat(64) },
      client,
      deps,
    }
    const attempt = {
      kind: 'begin' as const,
      expectedPreviousTransferId: null,
      newAttemptId: '33333333-3333-4333-8333-333333333333',
      requestedAmount: '8000',
    }
    assert.deepEqual(
      await quoteMarketFundingCashu({
        requestedAmountMsat: 8_000,
        outcomeCount: 8,
        profile: common.profile,
        secrets: common.secrets,
        deps,
      }),
      {
        grossFundingMsat: 8_000,
        sendPreparationFeeMsat: 0,
        estimatedRecipientReceiveFeeMsat: 0,
        totalWalletDebitMsat: 8_000,
        netFundingMsat: 8_000,
      },
    )
    assert.equal(mintCalls, 0)
    const first = await deliverMarketFundingCashu({
      ...common,
      attempt,
      maxWalletDebitMsat: 8_000,
    })
    assert.equal(first.state, 'received')
    assert.equal(mintCalls, 1)
    assert.equal(posts, 1)
    assert.deepEqual(await readMarketFundingHeadCashu(common), {
      transferId: attempt.newAttemptId,
      revision: 1,
    })
    const retry = await deliverMarketFundingCashu({ ...common, attempt })
    assert.deepEqual(retry, first)
    assert.equal(mintCalls, 1)
    assert.equal(posts, 1)
    const secondAttempt = {
      kind: 'begin' as const,
      expectedPreviousTransferId: attempt.newAttemptId,
      newAttemptId: '44444444-4444-4444-8444-444444444444',
      requestedAmount: '8000',
    }
    await assert.rejects(
      deliverMarketFundingCashu({ ...common, attempt: secondAttempt, maxWalletDebitMsat: 8_000 }),
      /not credited/,
    )
    assert.equal(mintCalls, 1)
    assert.equal(await fixture.count('daemon_outgoing_cashu_transfers'), 1)
    firstStatus = 'credited'
    const sendOutputs = [4_096, 2_048, 1_024, 512, 256, 64].map((amount, index) =>
      OutputData.createSingleData(
        amount,
        MSAT_KEYSET_ID,
        `second-send-${index}`,
        BigInt(60 + index),
      ),
    )
    activeWallet = fixture.scoreWallet(
      async () => {
        mintCalls += 1
        return { keep: [], send: sendOutputs.map((output) => signedProof(output, MSAT_KEYS)) }
      },
      CheckStateEnum.UNSPENT,
      { sendOutputs, keepOutputs: [] },
    )
    const second = await deliverMarketFundingCashu({
      ...common,
      attempt: secondAttempt,
      maxWalletDebitMsat: 8_000,
    })
    assert.equal(second.state, 'received')
    assert.equal(mintCalls, 2)
    assert.equal(posts, 2)
    assert.deepEqual(await readMarketFundingHeadCashu(common), {
      transferId: secondAttempt.newAttemptId,
      revision: 2,
    })
    assert.equal(
      (await fixture.transfer(attempt.newAttemptId))?.deliveryState,
      'recipient-acknowledged',
    )
  } finally {
    await fixture.close()
  }
})

test('native restart dispatch accepts funding received but keeps Score credited-only', async () => {
  const fundingFixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createMarketFundingDeliveryMetadata({
      ...FUNDING_PRODUCT,
      deliveryId: '55555555-5555-4555-8555-555555555555',
      requestedAmount: '8000',
    })
    const transfer = await fundingFixture.coordinator.executeMarketFundingTransfer({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: fundingFixture.scoreWallet(async () => ({
        keep: fundingFixture.scoreKeepProofs,
        send: fundingFixture.scoreSendProofs,
      })),
      deliveryIntent: marketFundingDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
      product: FUNDING_PRODUCT,
      expectedPreviousTransferId: null,
      outcomeCount: 8,
      maxWalletDebitMsat: 8_000,
      requireCredited: async () => {
        throw new Error('initial funding has no predecessor')
      },
    })
    assert.ok(transfer.token)
    const submission = createMarketFundingDeliverySubmission({
      metadata,
      token: transfer.token.encodedToken,
    })
    let posts = 0
    const result = await recoverDurableOutgoingCashuTransfers(
      { walletSeedHex: '11'.repeat(64) },
      { getCustodyFence: () => fundingFixture.fence },
      {
        accountSubject: FUNDING_PRODUCT.accountSubject,
        client: {
          getDurableRecipientDeliveryStatus: async () => recipientStatus(submission, 'received'),
          submitDurableRecipientDelivery: async () => {
            posts++
            throw new Error('stored funding status must avoid POST')
          },
        },
      },
    )
    assert.equal(posts, 0)
    assert.deepEqual(result.recovered, [metadata.deliveryId])
    assert.equal(
      (await fundingFixture.transfer(metadata.deliveryId))?.deliveryState,
      'recipient-acknowledged',
    )
  } finally {
    await fundingFixture.close()
  }

  const scoreFixture = await createFixture({ scoreFunds: true })
  try {
    const metadata = createParticipationScoreDeliveryMetadata({
      deliveryId: '66666666-6666-4666-8666-666666666666',
      accountSubject: FUNDING_PRODUCT.accountSubject,
      mintUrl: MINT_URL,
      requestedAmount: '8000',
    })
    const transfer = await scoreFixture.coordinator.execute({
      transferId: metadata.deliveryId,
      amountMsat: 8_000,
      mintUrl: MINT_URL,
      wallet: scoreFixture.scoreWallet(async () => ({
        keep: scoreFixture.scoreKeepProofs,
        send: scoreFixture.scoreSendProofs,
      })),
      deliveryIntent: participationScoreDeliveryIntent({
        accountSubject: metadata.accountSubject,
        productBindingSha256: metadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
      }),
    })
    assert.ok(transfer.token)
    const submission = createParticipationScoreDeliverySubmission({
      metadata,
      token: transfer.token.encodedToken,
    })
    const result = await recoverDurableOutgoingCashuTransfers(
      { walletSeedHex: '11'.repeat(64) },
      { getCustodyFence: () => scoreFixture.fence },
      {
        accountSubject: FUNDING_PRODUCT.accountSubject,
        client: {
          getDurableRecipientDeliveryStatus: async () => recipientStatus(submission, 'received'),
          submitDurableRecipientDelivery: async () => {
            throw new Error('stored Score status must avoid POST')
          },
        },
      },
    )
    assert.deepEqual(result.recovered, [])
    assert.equal(
      (await scoreFixture.transfer(metadata.deliveryId))?.deliveryState,
      'delivery-pending',
    )
  } finally {
    await scoreFixture.close()
  }
})

async function createFixture(
  options: {
    readonly restoreOutputGroups?: (
      mintUrl: string,
      outputs: Record<string, unknown[]>,
    ) => Promise<Record<string, Proof[]>>
    readonly scoreFunds?: boolean
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-outgoing-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = TEST_SEED_HEX
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
    incarnationId: 'durable-outgoing-test',
    observedAtMs: Date.now(),
  })
  const inputOutput = OutputData.createSingleData(8, KEYSET_ID, 'input-secret', 1n)
  const sendOutputs = [
    OutputData.createSingleData(4, KEYSET_ID, 'send-four', 2n),
    OutputData.createSingleData(1, KEYSET_ID, 'send-one', 3n),
  ]
  const keepOutputs = [
    OutputData.createSingleData(2, KEYSET_ID, 'keep-two', 4n),
    OutputData.createSingleData(1, KEYSET_ID, 'keep-one', 5n),
  ]
  const scoreInputOutputs = [
    OutputData.createSingleData(8_192, MSAT_KEYSET_ID, 'score-input-8192', 6n),
    OutputData.createSingleData(4_096, MSAT_KEYSET_ID, 'score-input-4096', 19n),
    OutputData.createSingleData(2_048, MSAT_KEYSET_ID, 'score-input-2048', 20n),
    OutputData.createSingleData(1_024, MSAT_KEYSET_ID, 'score-input-1024', 21n),
    OutputData.createSingleData(512, MSAT_KEYSET_ID, 'score-input-512', 22n),
    OutputData.createSingleData(128, MSAT_KEYSET_ID, 'score-input-128', 23n),
  ]
  const scoreSendOutputs = [
    OutputData.createSingleData(4_096, MSAT_KEYSET_ID, 'score-send-4096', 7n),
    OutputData.createSingleData(2_048, MSAT_KEYSET_ID, 'score-send-2048', 8n),
    OutputData.createSingleData(1_024, MSAT_KEYSET_ID, 'score-send-1024', 11n),
    OutputData.createSingleData(512, MSAT_KEYSET_ID, 'score-send-512', 12n),
    OutputData.createSingleData(256, MSAT_KEYSET_ID, 'score-send-256', 13n),
    OutputData.createSingleData(64, MSAT_KEYSET_ID, 'score-send-64', 14n),
  ]
  const scoreKeepOutputs = [
    OutputData.createSingleData(4_096, MSAT_KEYSET_ID, 'score-keep-4096', 9n),
    OutputData.createSingleData(2_048, MSAT_KEYSET_ID, 'score-keep-2048', 10n),
    OutputData.createSingleData(1_024, MSAT_KEYSET_ID, 'score-keep-1024', 15n),
    OutputData.createSingleData(512, MSAT_KEYSET_ID, 'score-keep-512', 16n),
    OutputData.createSingleData(256, MSAT_KEYSET_ID, 'score-keep-256', 17n),
    OutputData.createSingleData(64, MSAT_KEYSET_ID, 'score-keep-64', 18n),
  ]
  const inputProof = signedProof(inputOutput)
  const sendProofs = sendOutputs.map((output) => signedProof(output))
  const keepProofs = keepOutputs.map((output) => signedProof(output))
  const scoreInputProofs = scoreInputOutputs.map((output) => signedProof(output, MSAT_KEYS))
  const scoreSendProofs = scoreSendOutputs.map((output) => signedProof(output, MSAT_KEYS))
  const scoreKeepProofs = scoreKeepOutputs.map((output) => signedProof(output, MSAT_KEYS))
  const outputProofs = new Map<string, Proof>([
    ...sendOutputs.map((output, index) => [output.blindedMessage.B_, sendProofs[index]!] as const),
    ...keepOutputs.map((output, index) => [output.blindedMessage.B_, keepProofs[index]!] as const),
    ...scoreSendOutputs.map(
      (output, index) => [output.blindedMessage.B_, scoreSendProofs[index]!] as const,
    ),
    ...scoreKeepOutputs.map(
      (output, index) => [output.blindedMessage.B_, scoreKeepProofs[index]!] as const,
    ),
  ])
  await addAvailableProofs(MINT_URL, [inputProof], { kind: 'sats', baseAsset: 'sat', unit: 'msat' })
  if (options.scoreFunds) {
    await addAvailableProofs(MINT_URL, scoreInputProofs, {
      kind: 'sats',
      baseAsset: 'sat',
      unit: 'msat',
    })
  }
  await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
    const row = createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: MINT_URL,
      unit: 'msat',
      proof: inputProof,
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
  if (options.scoreFunds) {
    await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
      new DurableCustodySqliteStore(database).putProofBatchCas(
        scoreInputProofs.map((proof) => ({
          proof: createCustodyProofSqliteRow({
            scopeId,
            normalizedMint: MINT_URL,
            unit: 'msat',
            proof,
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
          }),
          expectedRevision: null,
        })),
      )
    })
  }
  const coordinatorCore = new DaemonDurableOutgoingCashuCoordinator(directory, () => fence, {
    restoreOutputGroups:
      options.restoreOutputGroups ??
      (async (_mintUrl, outputs) => {
        const restore = (group: string) =>
          (outputs[group] ?? []).map((output) => {
            const proof = outputProofs.get(
              (output as { blindedMessage: { B_: string } }).blindedMessage.B_,
            )
            if (proof === undefined) throw new Error('output fixture is missing')
            return proof
          })
        return { send: restore('send'), keep: restore('keep') }
      }),
  })
  const coordinator = withTestSeed(coordinatorCore)
  const outgoingTransferAbortRestore = new Map<'insert' | 'update', () => void>()
  const wallet = (
    complete: () => Promise<{ keep: Proof[]; send: Proof[] }>,
    state: CheckStateEnum = CheckStateEnum.UNSPENT,
    outputPlan: {
      readonly sendOutputs: readonly OutputData[]
      readonly keepOutputs: readonly OutputData[]
    } = {
      sendOutputs,
      keepOutputs,
    },
    unit: 'msat' = 'msat',
    scoreAmountMsat?: number,
    mintUrl = MINT_URL,
    counterFence: typeof fence = fence,
    keysetKeys?: Record<string, string>,
    proofPrivateKey: Uint8Array = PRIVATE_KEY,
  ) => {
    const score =
      unit === 'msat' &&
      outputPlan.sendOutputs.every((output) => output.blindedMessage.id === MSAT_KEYSET_ID)
    const selectedKeysetId = outputPlan.sendOutputs[0]?.blindedMessage.id ?? KEYSET_ID
    const selectedAmount = score ? (scoreAmountMsat ?? 8_000) : 5
    const selectedKeys = keysetKeys ?? (score ? MSAT_KEYS : KEYS)
    for (const output of outputPlan.sendOutputs)
      outputProofs.set(output.blindedMessage.B_, signedProof(output, selectedKeys, proofPrivateKey))
    for (const output of outputPlan.keepOutputs)
      outputProofs.set(output.blindedMessage.B_, signedProof(output, selectedKeys, proofPrivateKey))
    const counterSource = createDaemonCounterSource(
      () => ({ fence: counterFence, observedAtMs: Date.now() }),
      {
        normalizedMint: mintUrl,
        unit,
      },
    )
    return {
      loadMint: async () => {},
      receive: async () => [],
      send: async () => ({ keep: [], send: [] }),
      prepareSwapToSend: async (
        _amount: number,
        proofs: Proof[],
        config?: unknown,
        outputConfig?: unknown,
      ) => {
        const deterministicConfig = config as
          | { onCountersReserved?: (counters: OperationCounters) => void }
          | undefined
        const deterministicOutputConfig = outputConfig as
          | { send?: { type?: string }; keep?: { type?: string } }
          | undefined
        if (
          deterministicOutputConfig?.send?.type !== 'deterministic' ||
          deterministicOutputConfig.keep?.type !== 'deterministic'
        ) {
          return {
            amount: Amount.from(selectedAmount),
            fees: Amount.zero(),
            keysetId: selectedKeysetId,
            inputs: score ? proofs.filter((proof) => proof.id === MSAT_KEYSET_ID) : proofs,
            sendOutputs: outputPlan.sendOutputs,
            keepOutputs: outputPlan.keepOutputs,
            unselectedProofs: [],
          }
        }
        if (deterministicConfig?.onCountersReserved === undefined) {
          throw new Error('deterministic fixture preparation requires a counter callback')
        }
        const outputCount = outputPlan.sendOutputs.length + outputPlan.keepOutputs.length
        const range = await counterSource.reserve(selectedKeysetId, outputCount)
        const counters: OperationCounters = {
          keysetId: selectedKeysetId,
          start: range.start,
          count: range.count,
          next: range.start + range.count,
        }
        deterministicConfig.onCountersReserved(counters)
        let nextCounter = range.start
        const keys = selectedKeys
        const createOutputs = (templates: readonly OutputData[]) =>
          templates.map((template) => {
            const output = OutputData.createSingleDeterministicData(
              template.blindedMessage.amount,
              TEST_SEED,
              nextCounter++,
              selectedKeysetId,
            )
            outputProofs.set(output.blindedMessage.B_, signedProof(output, keys, proofPrivateKey))
            return output
          })
        const deterministicSend = createOutputs(outputPlan.sendOutputs)
        const deterministicKeep = createOutputs(outputPlan.keepOutputs)
        return {
          amount: Amount.from(selectedAmount),
          fees: Amount.zero(),
          keysetId: selectedKeysetId,
          inputs: score ? proofs.filter((proof) => proof.id === MSAT_KEYSET_ID) : proofs,
          sendOutputs: deterministicSend,
          keepOutputs: deterministicKeep,
          unselectedProofs: [],
        }
      },
      completeSwap: async (preview: SwapPreview) => {
        // The callback models mint side effects; derive successful fake results from persisted authority.
        await complete()
        return {
          send: (preview.sendOutputs ?? []).map((output) =>
            signedProof(output, selectedKeys, proofPrivateKey),
          ),
          keep: [
            ...(preview.keepOutputs ?? []).map((output) =>
              signedProof(output, selectedKeys, proofPrivateKey),
            ),
            ...(preview.unselectedProofs ?? []),
          ],
        }
      },
      checkProofsStates: async (proofs: Array<Pick<Proof, 'secret'>>) =>
        proofs.map((proof) => ({
          Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
          state,
          witness: null,
        })),
      getKeyset: () => ({
        id: selectedKeysetId,
        unit,
        keys: selectedKeys,
        fee: 0,
        verify: () => true,
      }),
    }
  }
  const addAvailableProof = async (mintUrl: string, proof: Proof) => {
    await addAvailableProofs(mintUrl, [proof], { kind: 'sats', baseAsset: 'sat', unit: 'msat' })
    await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
      const row = createCustodyProofSqliteRow({
        scopeId,
        normalizedMint: mintUrl,
        unit: 'msat',
        proof: {
          ...proof,
          dleq: proof.dleq ?? null,
          p2pkE: proof.p2pk_e ?? null,
          witness: proof.witness ?? null,
        },
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
    return proof
  }
  return {
    directory,
    scopeId,
    activity: (walletId = deriveDurableCustodyWalletId(TEST_SEED)) =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) => new NativeActivitySqlite(database).page({ walletId }).items,
      ),
    transferCreatedAt: (transferId: string) =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          (
            database
              .prepare(
                'SELECT created_at_ms AS createdAtMs FROM daemon_outgoing_cashu_transfers WHERE scope_id = ? AND transfer_id = ?',
              )
              .get(scopeId, transferId) as { createdAtMs: number }
          ).createdAtMs,
      ),
    activitySequence: () =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          database
            .prepare('SELECT sequence FROM daemon_activity_feed WHERE scope_id = ?')
            .get(scopeId) as { sequence: number } | undefined,
      ),
    coordinator,
    fence,
    inputProof,
    sendProofs,
    keepProofs,
    scoreInputProofs,
    scoreSendProofs,
    scoreKeepProofs,
    scoreWallet: (
      complete: () => Promise<{ keep: Proof[]; send: Proof[] }>,
      state: CheckStateEnum = CheckStateEnum.UNSPENT,
      outputPlan: {
        readonly sendOutputs: readonly OutputData[]
        readonly keepOutputs: readonly OutputData[]
      } = { sendOutputs: scoreSendOutputs, keepOutputs: scoreKeepOutputs },
      amountMsat = 8_000,
      mintUrl = MINT_URL,
    ) => wallet(complete, state, outputPlan, 'msat', amountMsat, mintUrl),
    wallet,
    reclaimWallet: ({
      successors,
      successorOutputs,
      proofState,
    }: {
      readonly successors: readonly Proof[]
      readonly successorOutputs: readonly OutputData[]
      readonly proofState: () => CheckStateEnum
    }) => ({
      loadMint: async () => {},
      receive: async () => [],
      send: async () => ({ keep: [], send: [] }),
      prepareSwapToReceive: async (
        token: string,
        config?: {
          onCountersReserved?: (range: { keysetId: string; start: number; count: number }) => void
        },
      ) => {
        config?.onCountersReserved?.({ keysetId: KEYSET_ID, start: 20, count: 2 })
        return {
          amount: Amount.from(5),
          fees: Amount.zero(),
          keysetId: KEYSET_ID,
          inputs: getDecodedToken(token, [KEYSET_ID, MSAT_KEYSET_ID, FEE_KEYSET_ID]).proofs,
          keepOutputs: successorOutputs,
          unselectedProofs: [],
        }
      },
      completeSwap: async () => ({ keep: [...successors], send: [] }),
      checkProofsStates: async (proofs: Array<Pick<Proof, 'secret'>>) => {
        const state = proofState()
        return proofs.map((proof) => ({
          Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
          state,
          witness: null,
        }))
      },
      getKeyset: () => ({ id: KEYSET_ID, unit: 'msat', keys: KEYS, fee: 0, verify: () => true }),
    }),
    preMintPersisted: async () => {
      const transfer = await coordinator.loadTransfer('outgoing-retry')
      return transfer?.deliveryState === 'prepared'
    },
    transfer: (transferId: string) => coordinator.loadTransfer(transferId),
    counterNext: async (keysetId: string, mintUrl = MINT_URL) =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          database
            .prepare(
              `SELECT next_counter AS nextCounter FROM target_keyset_counters
             WHERE scope_id = ? AND normalized_mint = ? AND unit = 'msat' AND keyset_id = ?`,
            )
            .get(scopeId, mintUrl, keysetId) as { nextCounter: number } | undefined,
      ),
    putForeignTransferBinding: async (
      transfer: Awaited<ReturnType<typeof coordinator.loadTransfer>>,
    ) => {
      if (transfer === null) throw new Error('fixture transfer is missing')
      await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        new DurableOutgoingCashuSqliteStore(database).put({
          scopeId,
          custodyOperationId: 'foreign-custody-operation',
          transfer,
          nowMs: Date.now(),
        })
      })
    },
    installActivityAbort: (status: 'completed' | 'Failed') => {
      const originalExec = DatabaseSync.prototype.exec
      DatabaseSync.prototype.exec = function (sql: string) {
        const result = originalExec.call(this, sql)
        if (sql === 'BEGIN IMMEDIATE')
          originalExec.call(
            this,
            `CREATE TEMP TRIGGER test_activity_abort BEFORE INSERT ON daemon_activity_feed
           WHEN json_extract(NEW.item_json, '$.status') = '${status}'
           BEGIN SELECT RAISE(ABORT, 'Activity write fault'); END`,
          )
        return result
      }
      return () => {
        DatabaseSync.prototype.exec = originalExec
      }
    },
    installOutgoingTransferAbort: async (phase: 'insert' | 'update') => {
      const name = `test_outgoing_transfer_${phase}_abort`
      const statement =
        phase === 'insert'
          ? `CREATE TEMP TRIGGER ${name}
               BEFORE INSERT ON daemon_outgoing_cashu_transfers
               BEGIN SELECT RAISE(ABORT, 'outgoing transfer insert fault'); END`
          : `CREATE TEMP TRIGGER ${name}
               BEFORE UPDATE ON daemon_outgoing_cashu_transfers
               WHEN OLD.delivery_state = 'prepared' AND NEW.delivery_state = 'delivery-pending'
               BEGIN SELECT RAISE(ABORT, 'outgoing transfer update fault'); END`
      const originalExec = DatabaseSync.prototype.exec
      DatabaseSync.prototype.exec = function (sql: string) {
        const result = originalExec.call(this, sql)
        if (sql === 'BEGIN IMMEDIATE') originalExec.call(this, statement)
        return result
      }
      outgoingTransferAbortRestore.set(phase, () => {
        DatabaseSync.prototype.exec = originalExec
      })
    },
    removeOutgoingTransferAbort: async (phase: 'insert' | 'update') => {
      outgoingTransferAbortRestore.get(phase)?.()
      outgoingTransferAbortRestore.delete(phase)
    },
    count: async (table: string) => {
      if (
        ![
          'target_wallet_proofs',
          'daemon_participation_score_delivery_pointers',
          'target_keyset_counters',
          'target_proof_operations',
          'custody_proofs',
          'custody_operations',
          'custody_artifacts',
          'custody_active_work',
          'daemon_outgoing_cashu_transfers',
        ].includes(table)
      )
        throw new Error('table is foreign')
      return withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
            .count,
      )
    },
    hasArtifact: async (artifactId: string) =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          (
            database
              .prepare(
                `SELECT EXISTS (
                 SELECT 1 FROM custody_artifacts WHERE scope_id = ? AND artifact_id = ?
               ) AS found`,
              )
              .get(scopeId, artifactId) as { found: number }
          ).found === 1,
      ),
    custodySelectability: async (proof: Proof) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const proofId = deriveDurableCustodyProofId({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'msat',
          keysetId: proof.id,
          secret: proof.secret,
        })
        return (
          (
            database
              .prepare(
                'SELECT selectability FROM custody_proofs WHERE scope_id = ? AND proof_id = ?',
              )
              .get(scopeId, proofId) as { selectability: string } | undefined
          )?.selectability ?? null
        )
      }),
    custodyRevision: async (proof: Pick<Proof, 'id' | 'secret'>) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const proofId = deriveDurableCustodyProofId({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'msat',
          keysetId: proof.id,
          secret: proof.secret,
        })
        return (
          (
            database
              .prepare('SELECT revision FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
              .get(scopeId, proofId) as { revision: number } | undefined
          )?.revision ?? null
        )
      }),
    custodyProofSnapshot: async (proof: Pick<Proof, 'id' | 'secret'>) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const proofId = deriveDurableCustodyProofId({
          scopeId,
          normalizedMint: MINT_URL,
          unit: 'msat',
          keysetId: proof.id,
          secret: proof.secret,
        })
        return (
          (database
            .prepare(
              `SELECT proof_fingerprint AS proofFingerprint, proof_body AS proofBody,
                      revision, selectability, nut07_state AS nut07State
               FROM custody_proofs WHERE scope_id = ? AND proof_id = ?`,
            )
            .get(scopeId, proofId) as
            | {
                proofFingerprint: string
                proofBody: Uint8Array
                revision: number
                selectability: string
                nut07State: string
              }
            | undefined) ?? null
        )
      }),
    targetWalletHasProof: async (proof: Proof) =>
      withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
        const row = database
          .prepare('SELECT 1 AS found FROM target_wallet_proofs WHERE secret = ?')
          .get(proof.secret) as { found: number } | undefined
        return row?.found === 1
      }),
    activeReclaimWorkCount: async () =>
      withDurableCustodyUnitOfWork(
        directory,
        fence,
        Date.now(),
        (database) =>
          (
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM custody_active_work AS active
               JOIN custody_operations AS operation
                 ON operation.scope_id = active.scope_id
                AND operation.operation_id = active.operation_id
               WHERE active.scope_id = ? AND operation.retained_operation_key LIKE 'bearer-reclaim:%'`,
              )
              .get(scopeId) as { count: number }
          ).count,
      ),
    addAvailableProof,
    addAvailableInput: async (
      mintUrl: string,
      secret: string,
      keysetId = KEYSET_ID,
      counter = 999n,
      keys: Record<string, string> = KEYS,
      privateKey: Uint8Array = PRIVATE_KEY,
    ) => {
      const proof = signedProof(
        OutputData.createSingleData(8, keysetId, secret, counter),
        keys,
        privateKey,
      )
      return addAvailableProof(mintUrl, proof)
    },
    takeoverFence: (observedAtMs: number) =>
      claimCustodyScopeLease(directory, {
        scopeId,
        incarnationId: 'durable-outgoing-test-takeover',
        observedAtMs,
      }),
    coordinatorFor: (currentFence: typeof fence, nowMs: number) =>
      withTestSeed(
        new DaemonDurableOutgoingCashuCoordinator(
          directory,
          () => currentFence,
          {
            restoreOutputGroups:
              options.restoreOutputGroups ??
              (async (_mintUrl, outputs) => {
                const restore = (group: string) =>
                  (outputs[group] ?? []).map((output) => {
                    const proof = outputProofs.get(
                      (output as { blindedMessage: { B_: string } }).blindedMessage.B_,
                    )
                    if (proof === undefined) throw new Error('output fixture is missing')
                    return proof
                  })
                return { send: restore('send'), keep: restore('keep') }
              }),
          },
          () => nowMs,
        ),
      ),
    advanceCounter: async (minimum: number) =>
      advanceDaemonKeysetCounter(
        KEYSET_ID,
        minimum,
        { fence, observedAtMs: Date.now() },
        { normalizedMint: MINT_URL, unit: 'msat' },
      ),
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function canonicalProofMaterial(proof: {
  readonly id: string
  readonly amount: unknown
  readonly secret: string
  readonly C: string
  readonly dleq?: unknown
  readonly p2pkE?: string | null
  readonly p2pk_e?: string
  readonly witness?: unknown
}) {
  return {
    id: proof.id,
    amount: String(proof.amount),
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    p2pkE: proof.p2pkE ?? proof.p2pk_e ?? null,
    witness: proof.witness ?? null,
  }
}

function walletProofSnapshot(state: Awaited<ReturnType<typeof readState>>, proof: Proof) {
  const record = state?.wallet.proofs.find(({ proof: value }) => value.secret === proof.secret)
  return record === undefined
    ? null
    : {
        proof: canonicalProofMaterial(record.proof),
        state: record.state,
        asset: record.asset,
        reservedBy: record.reservedBy ?? null,
      }
}

function signedProof(
  output: OutputData,
  keys: Record<string, string> = KEYS,
  privateKey: Uint8Array = PRIVATE_KEY,
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

async function assertWithdrawalActivity(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  status: 'pending' | 'completed' | 'Failed',
  amountSubunits: number,
) {
  const items = await fixture.activity()
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.type, 'withdrawal')
  assert.equal(item.status, status)
  assert.equal(item.amountSubunits, amountSubunits)
  assert.equal(item.walletId, deriveDurableCustodyWalletId(TEST_SEED))
  assert.equal(item.baseAsset, 'sat')
  assert.equal(item.lightningInvoice, null)
  assert.equal(item.date, new Date(await fixture.transferCreatedAt(item.txId!)).toISOString())
  assert.equal((await fixture.activity('b'.repeat(64))).length, 0)
  assert.equal(JSON.stringify(item).includes('send-four'), false)
  return item
}

test('Cashu Activity keeps one dated row through partial and full redemption after database reopen', async () => {
  const fixture = await createFixture()
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'activity-partial-spent',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const initial = await assertWithdrawalActivity(fixture, 'pending', 5)
    const sequence = await fixture.activitySequence()
    const wallet = fixture.reclaimWallet({
      successors: [],
      successorOutputs: [],
      proofState: () => CheckStateEnum.UNSPENT,
    })
    wallet.checkProofsStates = async (proofs) =>
      proofs.map((proof, index) => ({
        Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
        state: index === 0 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
        witness: null,
      }))
    const partial = await fixture.coordinator.classifyBearerTransfer({
      transferId: transfer.transferId,
      wallet,
    })
    assert.equal(partial.deliveryState, 'bearer-partial')
    assert.deepEqual(await assertWithdrawalActivity(fixture, 'pending', 5), initial)
    wallet.checkProofsStates = async (proofs) =>
      proofs.map((proof) => ({
        Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
        state: CheckStateEnum.SPENT,
        witness: null,
      }))
    const restarted = fixture.coordinatorFor(fixture.fence, Date.now())
    await restarted.classifyBearerTransfer({ transferId: transfer.transferId, wallet })
    const spent = await assertWithdrawalActivity(fixture, 'completed', 5)
    assert.equal(spent.id, initial.id)
    assert.equal(spent.date, initial.date)
    assert.equal(spent.txId, transfer.transferId)
    assert.deepEqual(await fixture.activitySequence(), sequence)
    await restarted.classifyBearerTransfer({ transferId: transfer.transferId, wallet })
    assert.deepEqual(await assertWithdrawalActivity(fixture, 'completed', 5), spent)
    assert.deepEqual(await fixture.activitySequence(), sequence)
  } finally {
    await fixture.close()
  }
})

for (const partial of [false, true]) {
  test(`Cashu Activity excludes reclaimed principal and fees after ${partial ? 'partial' : 'full'} reclaim`, async () => {
    const fixture = await createFixture()
    try {
      await fixture.addAvailableInput(MINT_URL, 'activity-fee-input-one', FEE_KEYSET_ID, 999n)
      await fixture.addAvailableInput(MINT_URL, 'activity-fee-input-two', FEE_KEYSET_ID, 1000n)
      const sendOutputs = [
        OutputData.createSingleData(4, FEE_KEYSET_ID, 'activity-fee-send-four', 40n),
        OutputData.createSingleData(1, FEE_KEYSET_ID, 'activity-fee-send-one', 41n),
      ]
      const keepOutputs = [
        OutputData.createSingleData(8, FEE_KEYSET_ID, 'activity-fee-keep-eight', 42n),
        OutputData.createSingleData(2, FEE_KEYSET_ID, 'activity-fee-keep-two', 43n),
      ]
      const wallet = fixture.wallet(
        async () => ({
          keep: [...keepOutputs.map((output) => signedProof(output)), fixture.inputProof],
          send: sendOutputs.map((output) => signedProof(output)),
        }),
        CheckStateEnum.UNSPENT,
        { sendOutputs, keepOutputs },
      )
      const prepareSend = wallet.prepareSwapToSend
      wallet.prepareSwapToSend = async (amount, proofs, config, outputConfig) => ({
        ...(await prepareSend(amount, proofs, config, outputConfig)),
        fees: Amount.from(1),
        keysetId: FEE_KEYSET_ID,
        inputs: proofs.filter((proof) => proof.id === FEE_KEYSET_ID),
        unselectedProofs: proofs.filter((proof) => proof.id !== FEE_KEYSET_ID),
      })
      const keyset = (id?: string) => ({
        id: id ?? KEYSET_ID,
        unit: 'msat',
        keys: KEYS,
        fee: id === FEE_KEYSET_ID ? 500 : 0,
        verify: () => true,
      })
      wallet.getKeyset = keyset
      const transfer = await fixture.coordinator.execute({
        transferId: `activity-fee-reclaim-${partial}`,
        amountMsat: 5,
        mintUrl: MINT_URL,
        wallet,
      })
      const initial = await assertWithdrawalActivity(fixture, 'pending', 5)
      const sequence = await fixture.activitySequence()
      const successorOutputs = (partial ? [2, 1] : [4]).map((amount, index) =>
        OutputData.createSingleData(
          amount,
          KEYSET_ID,
          `activity-fee-reclaimed-${amount}`,
          BigInt(20 + index),
        ),
      )
      const successors = successorOutputs.map((output) => signedProof(output))
      await fixture.advanceCounter(20 + successors.length)
      const reclaimWallet = fixture.reclaimWallet({
        successors,
        successorOutputs,
        proofState: () => CheckStateEnum.UNSPENT,
      })
      reclaimWallet.getKeyset = keyset
      reclaimWallet.prepareSwapToReceive = async (token, config) => {
        config?.onCountersReserved?.({ keysetId: KEYSET_ID, start: 20, count: successors.length })
        return {
          amount: Amount.from(partial ? 3 : 4),
          fees: Amount.from(1),
          keysetId: KEYSET_ID,
          inputs: getDecodedToken(token, [FEE_KEYSET_ID]).proofs,
          keepOutputs: successorOutputs,
          unselectedProofs: [],
        }
      }
      reclaimWallet.checkProofsStates = async (proofs) =>
        proofs.map((proof) => ({
          Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
          state:
            partial &&
            proof.secret ===
              transfer.token!.proofs.find((candidate) => candidate.amount === '1')!.secret
              ? CheckStateEnum.SPENT
              : CheckStateEnum.UNSPENT,
          witness: null,
        }))
      const reclaimed = await fixture.coordinator.reclaim({
        transferId: transfer.transferId,
        wallet: reclaimWallet,
      })
      assert.equal(reclaimed.deliveryState, 'reclaimed')
      assert.equal(reclaimed.reclaim?.walletReceiveOperation.preview.fees, '1')
      const final = await assertWithdrawalActivity(
        fixture,
        partial ? 'completed' : 'Failed',
        partial ? 1 : 0,
      )
      assert.equal(final.id, initial.id)
      assert.equal(final.date, initial.date)
      assert.deepEqual(await fixture.activitySequence(), sequence)
      const restarted = fixture.coordinatorFor(fixture.fence, Date.now())
      await restarted.reclaim({ transferId: transfer.transferId, wallet: reclaimWallet })
      assert.deepEqual(
        await assertWithdrawalActivity(fixture, partial ? 'completed' : 'Failed', partial ? 1 : 0),
        final,
      )
      assert.equal(await fixture.targetWalletHasProof(successors[0]!), true)
    } finally {
      await fixture.close()
    }
  })
}

test('Cashu Activity write failure rolls back classification and reclaim admission with their source', async () => {
  const fixture = await createFixture()
  let removeFault = () => {}
  try {
    const transfer = await fixture.coordinator.execute({
      transferId: 'activity-rollback',
      amountMsat: 5,
      mintUrl: MINT_URL,
      wallet: fixture.wallet(async () => ({ keep: fixture.keepProofs, send: fixture.sendProofs })),
    })
    const initial = await assertWithdrawalActivity(fixture, 'pending', 5)
    const sequence = await fixture.activitySequence()
    const spentWallet = fixture.reclaimWallet({
      successors: [],
      successorOutputs: [],
      proofState: () => CheckStateEnum.SPENT,
    })
    removeFault = fixture.installActivityAbort('completed')
    await assert.rejects(
      () =>
        fixture.coordinator.classifyBearerTransfer({
          transferId: transfer.transferId,
          wallet: spentWallet,
        }),
      /Activity write fault/,
    )
    removeFault()
    assert.equal((await fixture.transfer(transfer.transferId))?.deliveryState, 'delivery-pending')
    assert.deepEqual(await assertWithdrawalActivity(fixture, 'pending', 5), initial)
    const successorOutputs = [
      OutputData.createSingleData(4, KEYSET_ID, 'activity-rollback-returned-four', 20n),
      OutputData.createSingleData(1, KEYSET_ID, 'activity-rollback-returned-one', 21n),
    ]
    const successors = successorOutputs.map((output) => signedProof(output))
    await fixture.advanceCounter(22)
    const reclaimWallet = fixture.reclaimWallet({
      successors,
      successorOutputs,
      proofState: () => CheckStateEnum.UNSPENT,
    })
    removeFault = fixture.installActivityAbort('Failed')
    await assert.rejects(
      () => fixture.coordinator.reclaim({ transferId: transfer.transferId, wallet: reclaimWallet }),
      /Activity write fault/,
    )
    removeFault()
    assert.equal((await fixture.transfer(transfer.transferId))?.deliveryState, 'reclaim-prepared')
    assert.equal(await fixture.targetWalletHasProof(successors[0]!), false)
    assert.deepEqual(await assertWithdrawalActivity(fixture, 'pending', 5), initial)
    const restarted = fixture.coordinatorFor(fixture.fence, Date.now())
    await restarted.reclaim({ transferId: transfer.transferId, wallet: reclaimWallet })
    const final = await assertWithdrawalActivity(fixture, 'Failed', 0)
    assert.equal(final.id, initial.id)
    assert.equal(final.date, initial.date)
    assert.deepEqual(await fixture.activitySequence(), sequence)
    assert.equal(await fixture.targetWalletHasProof(successors[0]!), true)
  } finally {
    removeFault()
    await fixture.close()
  }
})
