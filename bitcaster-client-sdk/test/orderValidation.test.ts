import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOrderIntent } from '../src/orderValidation.ts'

const validOrder = {
  marketId: 'cond-YES',
  outcomeId: 'YES',
  tokenSide: 'Outcome',
  side: 'Buy',
  price: 4_200,
  amountSubunits: 1_000_000,
  timeInForce: 'GTC',
}

test('validateOrderIntent accepts supported order intent shapes', () => {
  for (const timeInForce of ['FAK', 'FOK', 'GTC']) {
    assert.deepEqual(
      validateOrderIntent({ ...validOrder, timeInForce }),
      { valid: true },
    )
  }
})

test('validateOrderIntent rejects malformed or unsupported order intent', () => {
  for (const [request, message] of [
    [null, /missing order request/],
    [{ ...validOrder, marketId: '' }, /market id is required/],
    [{ ...validOrder, outcomeId: '   ' }, /outcome id is required/],
    [{ ...validOrder, marketId: 'cond-B|C', outcomeId: 'B' }, /market id must be a primitive outcome book/],
    [{ ...validOrder, outcomeId: 'B|C' }, /outcome id must be a primitive outcome name/],
    [
      { ...validOrder, marketId: 'cond-NO', outcomeId: 'YES' },
      /outcome id must match the primitive outcome segment/,
    ],
    [{ ...validOrder, tokenSide: 'Either' }, /tokenSide must be Outcome or Complement/],
    [{ ...validOrder, side: 'Hold' }, /side must be Buy or Sell/],
    [{ ...validOrder, price: 0 }, /price must be an integer from 1 to 9999/],
    [{ ...validOrder, price: 10_000 }, /price must be an integer from 1 to 9999/],
    [{ ...validOrder, price: 42.5 }, /price must be an integer from 1 to 9999/],
    [
      { ...validOrder, amountSubunits: 0 },
      /amountSubunits must be a positive integer in 10000 sub-unit increments/,
    ],
    [
      { ...validOrder, amountSubunits: 10_001 },
      /amountSubunits must be a positive integer in 10000 sub-unit increments/,
    ],
    [
      { ...validOrder, timeInForce: 'IOC' },
      /timeInForce must be FAK, FOK, or GTC/,
    ],
  ] as const) {
    const result = validateOrderIntent(request)
    assert.equal(result.valid, false)
    assert.match(result.valid ? '' : result.message, message)
  }
})

test('validateOrderIntent applies supplied market divisibility', () => {
  assert.deepEqual(
    validateOrderIntent({ ...validOrder, divisibility: 1_000, price: 999, amountSubunits: 2_000 }),
    { valid: true },
  )

  const priceResult = validateOrderIntent({ ...validOrder, divisibility: 1_000, price: 1_000 })
  assert.equal(priceResult.valid, false)
  assert.match(priceResult.valid ? '' : priceResult.message, /from 1 to 999/)

  const amountResult = validateOrderIntent({ ...validOrder, divisibility: 1_000, price: 500, amountSubunits: 1_501 })
  assert.equal(amountResult.valid, false)
  assert.match(amountResult.valid ? '' : amountResult.message, /1000 sub-unit increments/)
})

test('validateOrderIntent validates whole-share amounts by base asset share face', () => {
  assert.deepEqual(
    validateOrderIntent({ ...validOrder, baseAsset: 'usd', price: 500, amountSubunits: 1_000 }),
    { valid: true },
  )

  const usdAmountResult = validateOrderIntent({ ...validOrder, baseAsset: 'usd', price: 500, amountSubunits: 1_001 })
  assert.equal(usdAmountResult.valid, false)
  assert.match(usdAmountResult.valid ? '' : usdAmountResult.message, /1000 sub-unit increments/)
})
