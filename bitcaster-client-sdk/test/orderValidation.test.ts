import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOrderIntent } from '../src/orderValidation.ts'

const validOrder = {
  marketId: 'cond-YES',
  outcomeId: 'YES',
  tokenSide: 'Outcome',
  side: 'Buy',
  price: 42,
  amountSats: 100,
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
    [{ ...validOrder, price: 0 }, /price must be an integer from 1 to 99/],
    [{ ...validOrder, price: 100 }, /price must be an integer from 1 to 99/],
    [{ ...validOrder, price: 42.5 }, /price must be an integer from 1 to 99/],
    [
      { ...validOrder, amountSats: 0 },
      /amountSats must be a positive integer in 100 sat increments/,
    ],
    [
      { ...validOrder, amountSats: 50 },
      /amountSats must be a positive integer in 100 sat increments/,
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
