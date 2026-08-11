import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData } from '@cashu/cashu-ts'
import {
  bindDurableBolt11MintQuoteOperation,
  createDurableBolt11MintQuote,
  decodeDurableBolt11MintQuote,
  deriveDurableBolt11MintQuoteRecordId,
  deriveDurableBolt11MintQuoteWalletMintOperationId,
  hideDurableBolt11MintQuote,
  observeDurableBolt11MintQuoteState,
  verifyDurableBolt11MintQuoteRetry,
} from '../src/durableBolt11MintQuote.ts'
import { serializeDurableWalletMintOperation } from '../src/durableWalletOperation.ts'

const mintUrl = 'https://mint.example'
const KEYSET_ID = `01${'a'.repeat(64)}`

test('derives stable, domain-separated quote and wallet mint identities', () => {
  const input = { mintUrl, unit: 'sat', paymentMethod: 'bolt11' as const, quoteId: 'quote-1' }

  const quoteId = deriveDurableBolt11MintQuoteRecordId(input)
  const operationId = deriveDurableBolt11MintQuoteWalletMintOperationId(input)

  assert.equal(quoteId, deriveDurableBolt11MintQuoteRecordId(input))
  assert.equal(operationId, deriveDurableBolt11MintQuoteWalletMintOperationId(input))
  assert.notEqual(quoteId, operationId)
  assert.notEqual(quoteId, deriveDurableBolt11MintQuoteRecordId({ ...input, quoteId: 'quote-2' }))
})

test('strictly roundtrips a durable BOLT11 mint quote with its payment method', () => {
  const quote = quoteRecord()

  assert.deepEqual(decodeDurableBolt11MintQuote(quote), quote)
  assert.equal(quote.paymentMethod, 'bolt11')
  assert.equal(quote.presentationState, 'visible')
  assert.equal(quote.observedState, 'UNPAID')
  assert.equal(quote.walletMintOperationAuthority, null)
})

test('hiding is idempotent and only increments revision once', () => {
  const hidden = hideDurableBolt11MintQuote(quoteRecord())

  assert.equal(hidden.presentationState, 'hidden')
  assert.equal(hidden.revision, 1)
  assert.deepEqual(hideDurableBolt11MintQuote(hidden), hidden)
})

test('observed NUT-04 states are monotonic', () => {
  const paid = observeDurableBolt11MintQuoteState(quoteRecord(), 'PAID')
  const issued = observeDurableBolt11MintQuoteState(paid, 'ISSUED')

  assert.equal(paid.revision, 1)
  assert.equal(issued.revision, 2)
  assert.deepEqual(observeDurableBolt11MintQuoteState(issued, 'ISSUED'), issued)
  assert.throws(() => observeDurableBolt11MintQuoteState(issued, 'PAID'), /regress/)
  assert.throws(() => observeDurableBolt11MintQuoteState(paid, 'UNPAID'), /regress/)
})

test('binds an exact wallet mint operation once and verifies exact retry authority', () => {
  const quote = quoteRecord()
  const operation = mintOperation(quote)
  const bound = bindDurableBolt11MintQuoteOperation(quote, operation)

  assert.equal(bound.walletMintOperationAuthority === null, false)
  assert.equal(bound.revision, 1)
  assert.deepEqual(bindDurableBolt11MintQuoteOperation(bound, operation), bound)
  assert.deepEqual(verifyDurableBolt11MintQuoteRetry(bound, operation), bound)
})

test('binds only a BOLT11 wallet mint operation with the exact requested amount', () => {
  const quote = quoteRecord()
  const onchain = mintOperation(quote, 'output-1', '21', 'onchain')
  const under = mintOperation(quote, 'output-1', '20')
  const over = mintOperation(quote, 'output-1', '22')
  const exact = mintOperation(quote, 'output-1', ['20', '1'])

  assert.throws(() => bindDurableBolt11MintQuoteOperation(quote, onchain), /foreign/)
  assert.throws(() => bindDurableBolt11MintQuoteOperation(quote, under), /amount/)
  assert.throws(() => bindDurableBolt11MintQuoteOperation(quote, over), /amount/)
  assert.doesNotThrow(() => bindDurableBolt11MintQuoteOperation(quote, exact))
})

test('rejects conflicting operation or output authority during bind and retry', () => {
  const quote = quoteRecord()
  const bound = bindDurableBolt11MintQuoteOperation(quote, mintOperation(quote))
  const conflictingOutput = mintOperation(quote, 'other-output')

  assert.throws(() => bindDurableBolt11MintQuoteOperation(bound, conflictingOutput), /conflict/)
  assert.throws(() => verifyDurableBolt11MintQuoteRetry(bound, conflictingOutput), /conflict/)
})

test('rejects foreign wallet mint operation identity and quote authority', () => {
  const quote = quoteRecord()
  const operation = mintOperation(quote)
  const foreignQuote = serializeDurableWalletMintOperation({
    operationId: operation.operationId,
    mintUrl,
    unit: 'sat',
    preview: mintPreview('foreign-quote', 'output-1'),
  })
  const foreignMint = serializeDurableWalletMintOperation({
    operationId: operation.operationId,
    mintUrl: 'https://foreign-mint.example',
    unit: 'sat',
    preview: mintPreview(quote.quoteId, 'output-1'),
  })
  const foreignUnit = serializeDurableWalletMintOperation({
    operationId: operation.operationId,
    mintUrl,
    unit: 'msat',
    preview: mintPreview(quote.quoteId, 'output-1'),
  })
  const foreignOperation = serializeDurableWalletMintOperation({
    operationId: 'foreign-operation',
    mintUrl,
    unit: 'sat',
    preview: mintPreview(quote.quoteId, 'output-1'),
  })

  for (const candidate of [foreignQuote, foreignMint, foreignUnit, foreignOperation]) {
    assert.throws(() => bindDurableBolt11MintQuoteOperation(quote, candidate), /foreign/)
  }
})

test('strict decoding rejects foreign fields, unknown states, and malformed persisted values', () => {
  const quote = quoteRecord() as Record<string, unknown>
  const cases: readonly [unknown, RegExp][] = [
    [{ ...quote, extra: true }, /foreign/],
    [{ ...quote, observedState: 'EXPIRED' }, /state/],
    [{ ...quote, observedState: null }, /state/],
    [withoutPaymentMethod(quote), /foreign/],
    [{ ...quote, paymentMethod: 'bolt12' }, /payment method/],
    [{ ...quote, mintUrl: 'https://mint.example/' }, /mint URL/],
    [{ ...quote, quoteRecordId: 'foreign' }, /identity/],
    [{ ...quote, walletMintOperationId: 'foreign' }, /identity/],
    [{ ...quote, requestedAmount: '01' }, /amount/],
    [{ ...quote, requestedAmount: '0' }, /amount/],
    [{ ...quote, requestedAmount: '1'.repeat(16 * 1024 + 1) }, /amount/],
    [{ ...quote, invoiceRequest: '' }, /invoice request/],
    [{ ...quote, invoiceRequest: 'x'.repeat(16 * 1024 + 1) }, /invoice request/],
    [{ ...quote, expiryUnixSeconds: -1 }, /expiry/],
    [{ ...quote, expiryUnixSeconds: 1.5 }, /expiry/],
    [{ ...quote, revision: -1 }, /revision/],
    [{ ...quote, revision: 1.5 }, /revision/],
    [
      {
        ...quote,
        walletMintOperationAuthority: {
          requestFingerprint: 'not-a-fingerprint',
          outputPlanFingerprint: '0'.repeat(64),
        },
      },
      /authority/,
    ],
    [
      {
        ...quote,
        walletMintOperationAuthority: {
          requestFingerprint: '0'.repeat(64),
          outputPlanFingerprint: '1'.repeat(64),
          extra: true,
        },
      },
      /foreign/,
    ],
  ]

  for (const [value, expected] of cases) {
    assert.throws(() => decodeDurableBolt11MintQuote(value), expected)
  }
})

test('does not support an EXPIRED transition or deletion transition', () => {
  const quote = quoteRecord()
  assert.throws(() => observeDurableBolt11MintQuoteState(quote, 'EXPIRED' as never), /state/)
  assert.equal(typeof hideDurableBolt11MintQuote(quote), 'object')
})

test('does not default a null observed state', () => {
  assert.throws(
    () => createDurableBolt11MintQuote({ ...quoteInput(), observedState: null as never }),
    /state/,
  )
})

function quoteRecord() {
  return createDurableBolt11MintQuote(quoteInput())
}

function quoteInput() {
  return {
    mintUrl,
    unit: 'sat',
    requestedAmount: '21',
    quoteId: 'quote-1',
    invoiceRequest: 'lnbc21u1example',
    expiryUnixSeconds: 1_700_000_000,
    observedState: 'UNPAID',
  }
}

function withoutPaymentMethod(quote: ReturnType<typeof quoteRecord>): Record<string, unknown> {
  const { paymentMethod: _, ...withoutMethod } = quote
  return withoutMethod
}

function mintOperation(
  quote: ReturnType<typeof quoteRecord>,
  outputSecret = 'output-1',
  amount: string | readonly string[] = '21',
  method = 'bolt11',
) {
  return serializeDurableWalletMintOperation({
    operationId: quote.walletMintOperationId,
    mintUrl: quote.mintUrl,
    unit: quote.unit,
    preview: mintPreview(quote.quoteId, outputSecret, amount, method),
  })
}

function mintPreview(
  quoteId: string,
  outputSecret: string,
  amount: string | readonly string[] = '21',
  method = 'bolt11',
) {
  const amounts = typeof amount === 'string' ? [amount] : amount
  const outputData = amounts.map((entry, index) =>
    OutputData.createSingleData(entry, KEYSET_ID, `${outputSecret}-${index}`, BigInt(index + 3)),
  )
  return {
    method,
    payload: { quote: quoteId, outputs: outputData.map((output) => output.blindedMessage) },
    outputData,
    keysetId: KEYSET_ID,
    quote: { quote: quoteId },
  }
}
