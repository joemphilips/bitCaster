import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isWalletPaymentOperationId,
  isWalletPaymentQuote,
  type WalletPaymentQuote,
} from '../src/walletPaymentQuote.ts'

const quote: WalletPaymentQuote = {
  operationId: `wallet-melt:${'a'.repeat(64)}`,
  walletId: 'b'.repeat(64),
  mintUrl: 'https://mint.example',
  unit: 'msat',
  method: 'bolt11',
  invoice: 'lnbc-valid-invoice',
  quoteId: 'quote-1',
  amountMsat: 1_000,
  feeReserveMsat: 25,
  selectedInputFeeMsat: 2,
  totalWalletDebitMsat: 1_027,
  expiryUnixSeconds: 1_900_000_000,
  state: 'UNPAID',
}

test('wallet payment quote validator accepts only the exact approved debit view', () => {
  assert.equal(isWalletPaymentQuote(quote), true)
  assert.equal(isWalletPaymentOperationId(quote.operationId), true)
  assert.equal(isWalletPaymentOperationId('wallet-melt:not-a-hash'), false)

  const invalid: unknown[] = [
    null,
    [],
    { ...quote, extra: true },
    { ...quote, operationId: 'wallet-melt:ABC' },
    { ...quote, walletId: 'b'.repeat(63) },
    { ...quote, invoice: ` ${quote.invoice}` },
    { ...quote, feeReserveMsat: -1 },
    { ...quote, totalWalletDebitMsat: 1_026 },
    { ...quote, amountMsat: Number.MAX_SAFE_INTEGER },
    { ...quote, state: 'PAID' },
  ]
  for (const value of invalid) assert.equal(isWalletPaymentQuote(value), false)
})
