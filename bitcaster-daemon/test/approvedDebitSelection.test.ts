import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Wallet as CashuWallet } from '@cashu/cashu-ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { prepareNativeConditionRegistrationFee } from '../src/nativeConditionRegistrationFee.ts'
import { NativeWalletPaymentOps } from '../src/nativeWalletPaymentOps.ts'
import {
  deliverMarketFundingCashu,
  deliverParticipationScoreCashu,
  quoteMarketFundingCashu,
  quoteParticipationScoreCashu,
} from '../src/walletOps.ts'
import {
  DENOMINATIONS,
  INVOICE,
  MINT_URL,
  OFFLINE_RECIPIENT,
  SEED,
  SEED_HEX,
  withCustodyWallet,
} from './support/custodyWallet.ts'

const DELIVERY_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_ID = '44444444-4444-4444-8444-444444444444'
/** A wallet after some use: several proofs of each small denomination. */
const HELD_AMOUNTS = DENOMINATIONS.slice(1, 12).flatMap((amount) => Array<number>(4).fill(amount))

test('a send quote is the same for the same spendable proofs', async () => {
  await withCustodyWallet(HELD_AMOUNTS, async ({ coordinator, openWallet }) => {
    const debits = new Set<number>()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const quote = await coordinator.quoteSend({
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet: await openWallet(),
      })
      debits.add(quote.totalWalletDebitMsat)
    }
    assert.equal(debits.size, 1, `quotes differ: ${[...debits].sort((a, b) => a - b).join(', ')}`)
  })
})

test('a registration fee quote that the caller approves exactly is paid', async () => {
  await withCustodyWallet(HELD_AMOUNTS, async ({ coordinator, openWallet, walletFactory }) => {
    for (let creation = 0; creation < 8; creation += 1) {
      const wallet = await openWallet()
      const approved = await coordinator.quoteSend({
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet,
      })
      const paid = await prepareNativeConditionRegistrationFee(
        { coordinator },
        {
          creationId: `creation-${creation}`,
          mintUrl: MINT_URL,
          requiredFeeMsat: 1_000,
          maxWalletDebitMsat: approved.totalWalletDebitMsat,
          seed: SEED,
          wallet,
          createWallet: walletFactory,
        },
      )
      assert.equal(paid.kind, 'prepared')
      const transfer = await coordinator.loadTransfer(paid.transferId!)
      assert.equal(
        amountToNumber(transfer!.walletSendOperation.preview.fees),
        approved.sendPreparationFeeMsat,
        'the execution must use the quoted inputs',
      )
    }
  })
})

test('a debit below the quoted debit is still refused', async () => {
  await withCustodyWallet(HELD_AMOUNTS, async ({ coordinator, openWallet, walletFactory }) => {
    const wallet = await openWallet()
    const quote = await coordinator.quoteSend({ amountMsat: 1_000, mintUrl: MINT_URL, wallet })
    await assert.rejects(
      prepareNativeConditionRegistrationFee(
        { coordinator },
        {
          creationId: 'below-the-quote',
          mintUrl: MINT_URL,
          requiredFeeMsat: 1_000,
          maxWalletDebitMsat: quote.totalWalletDebitMsat - 1,
          seed: SEED,
          wallet,
          createWallet: walletFactory,
        },
      ),
      {
        name: 'ApprovedWalletDebitExceededError',
        message: 'condition registration fee exceeds the approved wallet debit',
      },
    )
    await assert.rejects(
      coordinator.execute({
        transferId: 'below-the-quote',
        amountMsat: 1_000,
        mintUrl: MINT_URL,
        wallet,
        seed: SEED,
        createWallet: walletFactory,
        maxWalletDebitMsat: quote.totalWalletDebitMsat - 1,
      }),
      {
        name: 'ApprovedWalletDebitExceededError',
        message: 'outgoing wallet debit exceeds the approved maximum',
      },
    )
  })
})

test('market funding spends exactly the quoted inputs and refuses a lower approval', async (t) => {
  const selections = recordSelections(t)
  await withCustodyWallet(HELD_AMOUNTS, async ({ profile, deps, coordinator }) => {
    const secrets = { walletSeedHex: SEED_HEX }
    const quoted = await assertStableQuote(selections, () =>
      quoteMarketFundingCashu({
        requestedAmountMsat: 10_000,
        outcomeCount: 2,
        profile,
        secrets,
        deps,
      }),
    )
    const deliver = (newAttemptId: string, maxWalletDebitMsat: number) =>
      deliverMarketFundingCashu({
        attempt: {
          kind: 'begin',
          expectedPreviousTransferId: null,
          newAttemptId,
          requestedAmount: '10000',
        },
        accountSubject: 'subject-1',
        conditionId: 'b'.repeat(64),
        divisibility: 1_000,
        outcomeCount: 2,
        maxWalletDebitMsat,
        profile,
        secrets,
        client: OFFLINE_RECIPIENT,
        deps,
      })
    await assert.rejects(deliver(OTHER_ID, quoted.debit - 1), {
      name: 'ApprovedWalletDebitExceededError',
      message: 'market funding wallet debit exceeds the approved maximum',
    })
    assert.equal(await coordinator.loadTransfer(OTHER_ID), null)
    await assert.rejects(deliver(DELIVERY_ID, quoted.debit), /recipient is offline/)
    assert.deepEqual(await transferInputs(coordinator, DELIVERY_ID), quoted.inputs)
  })
})

test('a Score top-up spends exactly the quoted inputs and refuses a lower approval', async (t) => {
  const selections = recordSelections(t)
  await withCustodyWallet(HELD_AMOUNTS, async ({ profile, deps, coordinator }) => {
    const secrets = { walletSeedHex: SEED_HEX }
    const quoted = await assertStableQuote(selections, () =>
      quoteParticipationScoreCashu({ amountMsat: 5_000, profile, secrets, deps }),
    )
    const deliver = (deliveryId: string, maxWalletDebitMsat: number) =>
      deliverParticipationScoreCashu({
        deliveryId,
        accountSubject: 'subject-1',
        amountMsat: 5_000,
        purchasedTotalEpoch: 0,
        maxWalletDebitMsat,
        requireExactRequest: true,
        profile,
        secrets,
        client: OFFLINE_RECIPIENT,
        deps,
      })
    await assert.rejects(deliver(OTHER_ID, quoted.debit - 1), {
      name: 'ApprovedWalletDebitExceededError',
      message: 'outgoing wallet debit exceeds the approved maximum',
    })
    assert.equal(await coordinator.loadTransfer(OTHER_ID), null)
    await assert.rejects(deliver(DELIVERY_ID, quoted.debit), /recipient is offline/)
    assert.deepEqual(await transferInputs(coordinator, DELIVERY_ID), quoted.inputs)
  })
})

test('a payment spends exactly the quoted inputs', async (t) => {
  const selections = recordSelections(t)
  await withCustodyWallet(HELD_AMOUNTS, async ({ profile, deps, directory, getFence }) => {
    const prepared: string[][] = []
    const ops = new NativeWalletPaymentOps({
      profile,
      secrets: { walletSeedHex: SEED_HEX },
      getFence,
      deps,
      directory,
      observePrepared: async (operation) => {
        prepared.push(secretsOf(operation.preview.inputs))
      },
    })
    const quoted = await assertStableQuote(selections, () => ops.quote({ invoice: INVOICE }))
    const result = await ops.pay({ ...quoted.quote, approvedMaxDebitMsat: quoted.debit })
    assert.equal(result.state, 'pending', 'the fake mint gives no payment answer')
    assert.deepEqual(prepared, [quoted.inputs])
  })
})

/** Record each result of the real wallet selection. The recorder does not change the result. */
function recordSelections(t: TestContext) {
  const recorder = t.mock.method(CashuWallet.prototype, 'selectProofsToSend')
  return () => recorder.mock.calls.map(({ result }) => secretsOf(result!.send))
}

/** Quote several times. Every quote must select the same inputs and the same debit. */
async function assertStableQuote<T extends { readonly totalWalletDebitMsat: number }>(
  selections: () => string[][],
  readQuote: () => Promise<T>,
) {
  const quotes: T[] = []
  for (let attempt = 0; attempt < 20; attempt += 1) quotes.push(await readQuote())
  const quote = quotes[0]!
  const inputs = selections()[0]!
  assert.ok(inputs.length > 1)
  assert.equal(selections().length, 20)
  for (const selected of selections()) assert.deepEqual(selected, inputs)
  for (const { totalWalletDebitMsat } of quotes)
    assert.equal(totalWalletDebitMsat, quote.totalWalletDebitMsat)
  return { quote, inputs, debit: quote.totalWalletDebitMsat }
}

async function transferInputs(
  coordinator: DaemonDurableOutgoingCashuCoordinator,
  transferId: string,
): Promise<string[]> {
  const transfer = await coordinator.loadTransfer(transferId)
  return secretsOf(transfer!.walletSendOperation.preview.inputs)
}

function secretsOf(proofs: readonly { readonly secret: string }[]): string[] {
  return proofs.map(({ secret }) => secret).sort()
}
