import assert from 'node:assert/strict'
import { test } from 'node:test'

import { amountToNumber, sumProofs } from '../src/proofSelection.ts'

test('amountToNumber normalizes Cashu Amount values after IndexedDB structured clone', () => {
  assert.equal(amountToNumber({ value: 100n }), 100)
  assert.equal(sumProofs([{ amount: { value: 60n } }, { amount: { value: 40 } }]), 100)
})
