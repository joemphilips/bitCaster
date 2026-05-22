import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  UNSUPPORTED_DIRECT_CTF_SELL_MESSAGE,
  assertOrderSettlementSupported,
  checkOrderSettlementSupport,
} from '../src/settlementSupport.ts'

test('checkOrderSettlementSupport allows direct CTF sell by default', () => {
  assert.deepEqual(
    checkOrderSettlementSupport({ request: { side: 'Sell' } }),
    { supported: true },
  )
})

test('checkOrderSettlementSupport rejects direct CTF sell when disabled for old mints', () => {
  assert.deepEqual(
    checkOrderSettlementSupport({
      request: { side: 'Sell' },
      capabilities: { directCtfSellLocking: false },
    }),
    {
      supported: false,
      code: 'unsupported-direct-ctf-sell',
      message: UNSUPPORTED_DIRECT_CTF_SELL_MESSAGE,
    },
  )
})

test('checkOrderSettlementSupport allows buys and explicitly enabled direct sells', () => {
  assert.deepEqual(checkOrderSettlementSupport({ request: { side: 'Buy' } }), {
    supported: true,
  })
  assert.deepEqual(
    checkOrderSettlementSupport({
      request: { side: 'Sell' },
      capabilities: { directCtfSellLocking: true },
    }),
    { supported: true },
  )
})

test('assertOrderSettlementSupported throws typed direct-sell support error', () => {
  assert.throws(
    () =>
      assertOrderSettlementSupported({
        request: { side: 'Sell' },
        capabilities: { directCtfSellLocking: false },
      }),
    (error) =>
      error instanceof Error &&
      error.name === 'SettlementSupportError' &&
      'code' in error &&
      error.code === 'unsupported-direct-ctf-sell',
  )
})
