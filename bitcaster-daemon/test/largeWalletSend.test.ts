import assert from 'node:assert/strict'
import test from 'node:test'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  NEW_WALLET_OPERATION_INPUT_LIMIT,
  WalletOperationTooLargeError,
} from '@bitcaster-market/client-sdk/walletOperationSize'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import {
  deriveNativeConditionRegistrationFeeTransferId,
  prepareNativeConditionRegistrationFee,
} from '../src/nativeConditionRegistrationFee.ts'
import {
  deliverMarketFundingCashu,
  deliverParticipationScoreCashu,
  quoteMarketFundingCashu,
  quoteParticipationScoreCashu,
  sendWalletToken,
} from '../src/walletOps.ts'
import {
  DENOMINATIONS,
  MINT_URL,
  OFFLINE_RECIPIENT,
  SEED,
  SEED_HEX,
  withCustodyWallet,
} from './support/custodyWallet.ts'

const secrets = { walletSeedHex: SEED_HEX }
const FUNDING_ID = '33333333-3333-4333-8333-333333333333'
const SCORE_ID = '44444444-4444-4444-8444-444444444444'

for (const perDenomination of [60, 364]) {
  const held = DENOMINATIONS.slice(1, 12).flatMap((amount) =>
    Array<number>(perDenomination).fill(amount),
  )
  test(`each payment of a wallet with ${held.length} spendable proofs survives a restart`, async () => {
    await withCustodyWallet(held, async (fixture) => {
      const { coordinator, deps, mint, profile, walletFactory, openWallet } = fixture
      const before = total(await fixture.spendableAmounts())
      let sent = 0

      /** The quoted debit is approved exactly. The mint answer is lost. A new process recovers. */
      const pay = async (
        transferId: string,
        amountMsat: number,
        quotedDebit: number,
        attempt: (coordinator: DaemonDurableOutgoingCashuCoordinator) => Promise<unknown>,
      ) => {
        const swaps = mint.swaps
        const balance = total(await fixture.spendableAmounts())
        mint.loseNextSwapAnswer = true
        await attempt(coordinator).then(
          () => undefined,
          () => undefined,
        )
        assert.equal(mint.swaps, swaps + 1, `${transferId} must reach the mint`)
        const restarted = new DaemonDurableOutgoingCashuCoordinator(
          fixture.directory,
          fixture.getFence,
          deps,
        )
        await attempt(restarted).catch((error: Error) => {
          if (error.message !== 'recipient is offline') throw error
        })
        assert.equal(mint.swaps, swaps + 1, `${transferId} must not swap again`)
        const transfer = await restarted.loadTransfer(transferId)
        assert.equal(transfer?.deliveryState, 'delivery-pending')
        assert.equal(total(transfer!.token!.proofs.map(amountOf)), amountMsat)
        assert.ok(
          transfer!.walletSendOperation.preview.inputs.length <= NEW_WALLET_OPERATION_INPUT_LIMIT,
        )
        assert.equal(balance - total(await fixture.spendableAmounts()), quotedDebit)
        sent += amountMsat
      }

      const feeWallet = await openWallet()
      const fee = await coordinator.quoteSend({
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet: feeWallet,
      })
      await pay(
        deriveNativeConditionRegistrationFeeTransferId('large-wallet'),
        1_000,
        fee.totalWalletDebitMsat,
        (current) =>
          prepareNativeConditionRegistrationFee(
            { coordinator: current },
            {
              creationId: 'large-wallet',
              mintUrl: MINT_URL,
              requiredFeeMsat: 1_000,
              maxWalletDebitMsat: fee.totalWalletDebitMsat,
              seed: SEED,
              wallet: feeWallet,
              createWallet: walletFactory,
            },
          ),
      )

      const funding = await quoteMarketFundingCashu({
        requestedAmountMsat: 10_000,
        outcomeCount: 2,
        profile,
        secrets,
        deps,
      })
      await pay(FUNDING_ID, 10_000, funding.totalWalletDebitMsat, () =>
        deliverMarketFundingCashu({
          attempt: {
            kind: 'begin',
            expectedPreviousTransferId: null,
            newAttemptId: FUNDING_ID,
            requestedAmount: '10000',
          },
          accountSubject: 'subject-1',
          conditionId: 'b'.repeat(64),
          divisibility: 1_000,
          outcomeCount: 2,
          maxWalletDebitMsat: funding.totalWalletDebitMsat,
          profile,
          secrets,
          client: OFFLINE_RECIPIENT,
          deps,
        }),
      )

      const score = await quoteParticipationScoreCashu({
        amountMsat: 5_000,
        profile,
        secrets,
        deps,
      })
      await pay(SCORE_ID, 5_000, score.totalWalletDebitMsat, () =>
        deliverParticipationScoreCashu({
          deliveryId: SCORE_ID,
          accountSubject: 'subject-1',
          amountMsat: 5_000,
          purchasedTotalEpoch: 0,
          maxWalletDebitMsat: score.totalWalletDebitMsat,
          requireExactRequest: true,
          profile,
          secrets,
          client: OFFLINE_RECIPIENT,
          deps,
        }),
      )

      const send = await coordinator.quoteSend({
        amountMsat: 7_000,
        mintUrl: MINT_URL,
        wallet: await openWallet(),
      })
      await pay('large-wallet-send', 7_000, send.totalWalletDebitMsat, () =>
        sendWalletToken(7_000, profile, secrets, deps, MINT_URL, 'large-wallet-send'),
      )

      const after = total(await fixture.spendableAmounts())
      assert.equal(before, after + sent + mint.inputFeesMsat, 'no value may be lost')
    })
  })
}

test('a payment above the input limit is refused by its quote', async () => {
  // Each proof of 2 msat pays 1 msat after its fee, so the amount is the input count.
  await withCustodyWallet(Array<number>(300).fill(2), async ({ coordinator, openWallet }) => {
    const limit = NEW_WALLET_OPERATION_INPUT_LIMIT
    const request = { mintUrl: MINT_URL, wallet: await openWallet() }
    const quote = await coordinator.quoteSend({ ...request, amountMsat: limit })
    assert.equal(quote.sendPreparationFeeMsat, limit)
    await assert.rejects(
      coordinator.quoteSend({ ...request, amountMsat: limit + 1 }),
      WalletOperationTooLargeError,
    )
  })
})

test('a send is paid completely or refused by its quote and its execution before any effect', async () => {
  const limit = NEW_WALLET_OPERATION_INPUT_LIMIT
  for (const inputs of [limit - 1, limit, limit + 1, 188, 190, 195, 256]) {
    await withCustodyWallet(Array<number>(inputs).fill(2), async (fixture) => {
      const { coordinator, openWallet, walletFactory, mint } = fixture
      const request = { amountMsat: inputs, mintUrl: MINT_URL, wallet: await openWallet() }
      const quote = coordinator.quoteSend(request)
      const execute = () =>
        coordinator.execute({
          ...request,
          transferId: 'many-inputs',
          seed: SEED,
          createWallet: walletFactory,
        })
      if (inputs <= limit) {
        await quote
        assert.equal((await execute()).deliveryState, 'delivery-pending')
        assert.equal(mint.swaps, 1)
        return
      }
      await assert.rejects(quote, WalletOperationTooLargeError)
      await assert.rejects(execute(), WalletOperationTooLargeError)
      assert.equal(await coordinator.loadTransfer('many-inputs'), null)
      assert.equal(mint.swaps, 0)
      assert.equal((await fixture.spendableAmounts()).length, inputs)
    })
  }
})

function amountOf(proof: { readonly amount: unknown }): number {
  return amountToNumber(proof.amount)
}

function total(amounts: readonly number[]): number {
  return amounts.reduce((sum, amount) => sum + amount, 0)
}
