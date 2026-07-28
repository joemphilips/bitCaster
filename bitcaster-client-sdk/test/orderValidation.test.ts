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
  baseAsset: 'sat',
  divisibility: 10_000,
  timeInForce: 'GTC',
}

test('validateOrderIntent accepts supported order intent shapes', () => {
  for (const timeInForce of ['FAK', 'FOK', 'GTC']) {
    assert.deepEqual(validateOrderIntent({ ...validOrder, timeInForce }), { valid: true })
  }
})

test('validateOrderIntent rejects malformed or unsupported order intent', () => {
  for (const [request, message] of [
    [null, /missing order request/],
    [{ ...validOrder, marketId: '' }, /market id is required/],
    [{ ...validOrder, outcomeId: '   ' }, /outcome id is required/],
    [
      { ...validOrder, marketId: 'cond-B|C', outcomeId: 'B' },
      /market id must be a primitive outcome book/,
    ],
    [{ ...validOrder, outcomeId: 'B|C' }, /outcome id must be a primitive outcome name/],
    [
      { ...validOrder, marketId: 'cond-NO', outcomeId: 'YES' },
      /outcome id must match the primitive outcome segment/,
    ],
    [{ ...validOrder, tokenSide: 'Either' }, /tokenSide must be Outcome or Complement/],
    [{ ...validOrder, side: 'Hold' }, /side must be Buy or Sell/],
    [{ ...validOrder, baseAsset: undefined }, /baseAsset must be sat/],
    [{ ...validOrder, baseAsset: 'SAT' }, /baseAsset must be sat/],
    [{ ...validOrder, baseAsset: 'usd' }, /baseAsset must be sat/],
    [{ ...validOrder, divisibility: undefined }, /divisibility must be 10000 or 1000000/],
    [{ ...validOrder, divisibility: 1_000 }, /divisibility must be 10000 or 1000000/],
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
    [{ ...validOrder, timeInForce: 'IOC' }, /timeInForce must be FAK, FOK, or GTC/],
  ] as const) {
    const result = validateOrderIntent(request)
    assert.equal(result.valid, false)
    assert.match(result.valid ? '' : result.message, message)
  }
})

test('validateOrderIntent applies supplied market divisibility', () => {
  assert.deepEqual(
    validateOrderIntent({
      ...validOrder,
      divisibility: 1_000_000,
      price: 999_999,
      amountSubunits: 2_000_000,
    }),
    { valid: true },
  )

  const priceResult = validateOrderIntent({
    ...validOrder,
    divisibility: 1_000_000,
    price: 1_000_000,
  })
  assert.equal(priceResult.valid, false)
  assert.match(priceResult.valid ? '' : priceResult.message, /from 1 to 999999/)

  const amountResult = validateOrderIntent({
    ...validOrder,
    divisibility: 1_000_000,
    price: 500_000,
    amountSubunits: 1_000_001,
  })
  assert.equal(amountResult.valid, false)
  assert.match(amountResult.valid ? '' : amountResult.message, /1000000 sub-unit increments/)
})

test('validateOrderIntent rejects unsupported product units before amount semantics', () => {
  const result = validateOrderIntent({
    ...validOrder,
    baseAsset: 'usd',
    divisibility: 1_000,
    price: 500,
    amountSubunits: 1_000,
  })
  assert.equal(result.valid, false)
  assert.match(result.valid ? '' : result.message, /baseAsset must be sat/)
})
