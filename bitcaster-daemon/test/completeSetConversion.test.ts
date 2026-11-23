import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitWalletCompleteSet } from '../src/completeSetConversion.ts'

const MINT_URL = 'https://mint.example'
const CONDITION_ID = 'a'.repeat(64)

test('rejects invalid complete-set msat amounts before custody or mint access', async () => {
  let custodyCalls = 0
  let transportCalls = 0
  for (const amountMsat of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await assert.rejects(
      () =>
        splitWalletCompleteSet({
          mintUrl: MINT_URL,
          conditionId: CONDITION_ID,
          amountMsat,
          operationId: `invalid-${String(amountMsat)}`,
          secrets: null,
          deps: {
            getCustodyFence: () => {
              custodyCalls += 1
              throw new Error('custody must not be read')
            },
            createCtfSplitTransport: () => {
              transportCalls += 1
              throw new Error('mint must not be accessed')
            },
          },
        }),
      /amountMsat must be a positive safe integer/,
    )
  }
  assert.equal(custodyCalls, 0)
  assert.equal(transportCalls, 0)

  await assert.rejects(
    () =>
      splitWalletCompleteSet({
        mintUrl: MINT_URL,
        conditionId: CONDITION_ID,
        amountSats: 1,
        operationId: 'invalid-legacy-amount-field',
        secrets: null,
        deps: {
          getCustodyFence: () => {
            custodyCalls += 1
            throw new Error('custody must not be read')
          },
        },
      } as never),
    /amountMsat must be a positive safe integer/,
  )
  assert.equal(custodyCalls, 0)
})
