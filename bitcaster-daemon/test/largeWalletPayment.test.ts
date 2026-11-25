import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NEW_WALLET_OPERATION_INPUT_LIMIT,
  WalletOperationTooLargeError,
} from '@bitcaster-market/client-sdk/walletOperationSize'
import { NativeWalletPaymentOps } from '../src/nativeWalletPaymentOps.ts'
import { INVOICE, SEED_HEX, withCustodyWallet } from './support/custodyWallet.ts'

const LIMIT = NEW_WALLET_OPERATION_INPUT_LIMIT

// Each proof of 2 msat pays 1 msat after its fee, so the amount is the input count.
for (const inputs of [LIMIT - 1, LIMIT, LIMIT + 1, 190, 256]) {
  const payable = inputs <= LIMIT
  test(`a payment of ${inputs} inputs is ${payable ? 'paid completely' : 'refused before it is paid'}`, async () => {
    await withCustodyWallet(
      Array<number>(inputs).fill(2),
      async ({ profile, deps, directory, getFence, mint, spendableAmounts }) => {
        const ops = new NativeWalletPaymentOps({
          profile,
          secrets: { walletSeedHex: SEED_HEX },
          getFence,
          deps,
          directory,
        })
        mint.payInvoices = true
        const quoted = await ops.quote({ invoice: INVOICE }).catch((error: Error) => error)
        if (quoted instanceof Error) {
          assert.ok(quoted instanceof WalletOperationTooLargeError, quoted.message)
          assert.equal(payable, false, 'a payment at the limit must be quoted')
          assert.equal(mint.payments, 0)
          assert.equal((await spendableAmounts()).length, inputs)
          return
        }
        const approval = { ...quoted, approvedMaxDebitMsat: quoted.totalWalletDebitMsat }
        const paid = await ops.pay(approval)
        assert.equal(mint.payments, 1)
        assert.equal(
          paid.state,
          'paid',
          `the mint was paid for ${inputs} inputs, but the payment is ${paid.state}`,
        )
        assert.ok(payable, 'a payment above the limit must be refused')
        assert.deepEqual(await spendableAmounts(), [2, 8], 'the unused fee reserve returns')
      },
      { dleq: true, paymentMsat: inputs },
    )
  })
}
