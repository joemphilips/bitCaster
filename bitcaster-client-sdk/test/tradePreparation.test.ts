import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import {
  prepareBuyerSwapInputs,
  prepareSellerSwapInputs,
  prepareSwapInputsForTrade,
} from '../src/tradePreparation.ts'

test('prepareSellerSwapInputs uses existing outcome tokens before splitting regular collateral', async () => {
  let splitCalled = false
  const result = await prepareSellerSwapInputs({
    lockOutcomeSetId: 'Beta',
    amountSubunits: 10,
    outcomeProofsByCollection: {
      Beta: [proof('keyset-beta', 12, 'beta')],
    },
    regularProofs: [proof('regular-keyset', 20, 'regular')],
    splitRegularToOutcome: async () => {
      splitCalled = true
      throw new Error('split should not be called')
    },
  })

  assert.equal(result.status, 'prepared')
  assert.equal(result.source, 'existing-outcome')
  assert.equal(result.outcomeProofs[0]?.secret, 'beta')
  assert.equal(splitCalled, false)
})

test('prepareSellerSwapInputs falls back to regular-to-outcome pre-flight split', async () => {
  const result = await prepareSellerSwapInputs({
    lockOutcomeSetId: 'Gamma',
    amountSubunits: 10,
    outcomeProofsByCollection: {},
    regularProofs: [proof('regular-keyset', 20, 'regular')],
    splitRegularToOutcome: async (input) => {
      assert.equal(input.lockOutcomeSetId, 'Gamma')
      assert.equal(input.amountSubunits, 10)
      return {
        proofsByCollection: {
          Gamma: [proof('keyset-gamma', 10, 'gamma')],
          'Alpha|Beta': [proof('keyset-not-gamma', 10, 'not-gamma')],
        },
        spentRegularProofs: input.regularProofs,
        regularChangeProofs: [proof('regular-keyset', 10, 'change')],
      }
    },
  })

  assert.equal(result.status, 'prepared')
  assert.equal(result.source, 'regular-ctf-split')
  assert.equal(result.outcomeProofs[0]?.secret, 'gamma')
  assert.equal(result.spentRegularProofs[0]?.secret, 'regular')
  assert.equal(result.regularChangeProofs[0]?.secret, 'change')
})

test('prepareBuyerSwapInputs uses existing regular collateral before merging complete sets', async () => {
  let mergeCalled = false
  let feeLookupCalled = false
  const result = await prepareBuyerSwapInputs({
    quotePaymentSubunits: 8,
    regularProofs: [proof('regular-keyset', 9, 'regular')],
    completeSetProofsByCollection: {
      Alpha: [proof('keyset-alpha', 20, 'alpha')],
      Beta: [proof('keyset-beta', 20, 'beta')],
      Gamma: [proof('keyset-gamma', 20, 'gamma')],
    },
    conditionalInputFeePpkByKeyset: async () => {
      feeLookupCalled = true
      throw new Error('fee lookup should not be called')
    },
    mergeCompleteSetToRegular: async () => {
      mergeCalled = true
      throw new Error('merge should not be called')
    },
  })

  assert.equal(result.status, 'prepared')
  assert.equal(result.source, 'existing-regular')
  assert.equal(result.regularProofs[0]?.secret, 'regular')
  assert.equal(mergeCalled, false)
  assert.equal(feeLookupCalled, false)
})

test('prepareBuyerSwapInputs falls back to complete-set-to-regular pre-flight merge', async () => {
  const result = await prepareBuyerSwapInputs({
    quotePaymentSubunits: 8,
    regularProofs: [],
    completeSetProofsByCollection: {
      Alpha: [proof('keyset-alpha', 11, 'alpha')],
      Beta: [proof('keyset-beta', 11, 'beta')],
      Gamma: [proof('keyset-gamma', 11, 'gamma')],
    },
    conditionalInputFeePpkByKeyset: {
      'keyset-alpha': 1_000,
      'keyset-beta': 1_000,
      'keyset-gamma': 1_000,
    },
    mergeCompleteSetToRegular: async ({ selection, outputAmountSubunits }) => {
      assert.equal(selection.grossInputSats, 11)
      assert.equal(outputAmountSubunits, 8)
      return {
        regularProofs: [proof('regular-keyset', outputAmountSubunits, 'regular')],
        spentOutcomeProofsByCollection: selection.selectedProofsByCollection,
      }
    },
  })

  assert.equal(result.status, 'prepared')
  assert.equal(result.source, 'complete-set-ctf-merge')
  assert.equal(result.regularProofs[0]?.secret, 'regular')
  assert.equal(result.mergeSelection?.convertFeeSats, 3)
  assert.deepEqual(Object.keys(result.spentOutcomeProofsByCollection).sort(), [
    'Alpha',
    'Beta',
    'Gamma',
  ])
})

test('prepareBuyerSwapInputs fails closed when complete-set selection is impossible', async () => {
  const result = await prepareBuyerSwapInputs({
    quotePaymentSubunits: 8,
    regularProofs: [],
    maxMergeScanExtraSats: 2,
    completeSetProofsByCollection: {
      Alpha: [proof('keyset-alpha', 8, 'alpha')],
      Beta: [proof('keyset-beta', 9, 'beta')],
      Gamma: [proof('keyset-gamma', 8, 'gamma')],
    },
    conditionalInputFeePpkByKeyset: {
      'keyset-alpha': 0,
      'keyset-beta': 0,
      'keyset-gamma': 0,
    },
    mergeCompleteSetToRegular: async () => {
      throw new Error('merge should not be called')
    },
  })

  assert.deepEqual(result, {
    status: 'unavailable',
    reason: 'missing-complete-set-proofs',
  })
})

test('prepareSwapInputsForTrade dispatches seller intent through shared policy', async () => {
  const result = await prepareSwapInputsForTrade({
    role: 'seller',
    lockOutcomeSetId: 'Alpha',
    amountSubunits: 5,
    outcomeProofsByCollection: {
      Alpha: [proof('keyset-alpha', 5, 'alpha')],
    },
    regularProofs: [],
  })

  assert.equal(result.role, 'seller')
  assert.equal(result.status, 'prepared')
  assert.equal(result.source, 'existing-outcome')
  assert.equal(result.outcomeProofs[0]?.secret, 'alpha')
})

test('prepareSwapInputsForTrade dispatches buyer intent through shared policy', async () => {
  const result = await prepareSwapInputsForTrade({
    role: 'buyer',
    quotePaymentSubunits: 5,
    regularProofs: [proof('regular-keyset', 6, 'regular')],
    completeSetProofsByCollection: {},
    conditionalInputFeePpkByKeyset: {},
  })

  assert.equal(result.role, 'buyer')
  assert.equal(result.status, 'prepared')
  assert.equal(result.source, 'existing-regular')
  assert.equal(result.regularProofs[0]?.secret, 'regular')
})

function proof(id: string, amount: number, secret: string): Proof {
  return {
    id,
    amount,
    secret,
    C: `${secret}-C`,
  } as Proof
}
