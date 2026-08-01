import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, OutputData, type Proof } from '@cashu/cashu-ts'
import {
  completeCtfRangeConsolidationOperation,
  prepareCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationOperation,
} from '../src/ctfRangeConsolidationOperation.ts'

const KEYSET_ID = 'keyset-1'
const MINT_URL = 'https://mint.example'
const INPUTS = [proof('a', 4096), proof('b', 4096), proof('c', 2)]
const ROUND = {
  inputs: ['4096', '4096', '2'],
  outputs: ['8192', '1'],
  fee: '1',
}

test('prepares and completes one exact regular range consolidation', async () => {
  const outputs = outputData(ROUND.outputs)
  let completed = false
  const wallet = {
    prepareSwapToSend: async (amount: number, inputs: Proof[]) => ({
      amount: Amount.from(amount),
      fees: Amount.from(1),
      keysetId: KEYSET_ID,
      inputs,
      sendOutputs: outputs,
      keepOutputs: [],
      unselectedProofs: [],
    }),
    completeSwap: async () => {
      completed = true
      return { keep: [], send: [proof('consolidated', 8193)] }
    },
    prepareConditionalSwap: async () => {
      throw new Error('unexpected conditional consolidation')
    },
    completeConditionalSwap: async () => ({}),
  }

  const operation = await prepareCtfRangeConsolidationOperation({
    operationId: 'source:consolidation:0',
    rangeOperationId: 'range-1',
    mintUrl: MINT_URL,
    keysetId: KEYSET_ID,
    inputs: INPUTS,
    conditional: false,
    inputFeePpk: 100,
    plannedRound: ROUND,
    wallet,
  })

  assert.equal(operation.kind, 'wallet-send')
  assert.equal(operation.metadata?.purpose, 'ctf-range-authorization-consolidation')
  assert.deepEqual(
    operation.outputs.consolidated?.map((output) => output.blindedMessage.amount),
    ['8192', '1'],
  )
  assert.deepEqual(validateCtfRangeConsolidationOperation(operation).operation, operation)
  const result = await completeCtfRangeConsolidationOperation(operation, wallet)
  assert.equal(completed, true)
  assert.equal(result[0]?.secret, 'consolidated')
})

test('prepares a conditional consolidation with the same exact plan', async () => {
  const outputs = outputData(ROUND.outputs)
  const wallet = {
    prepareSwapToSend: async () => {
      throw new Error('unexpected regular consolidation')
    },
    completeSwap: async () => ({ keep: [], send: [] }),
    prepareConditionalSwap: async (input: { inputs: Proof[] }) => ({
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      outputDataByLabel: { consolidated: outputs },
    }),
    completeConditionalSwap: async () => ({ consolidated: [proof('conditional-result', 8193)] }),
  }
  const operation = await prepareCtfRangeConsolidationOperation({
    operationId: 'source:consolidation:0',
    rangeOperationId: 'range-1',
    mintUrl: MINT_URL,
    keysetId: KEYSET_ID,
    inputs: INPUTS,
    conditional: true,
    inputFeePpk: 100,
    plannedRound: ROUND,
    wallet,
  })

  assert.equal(operation.kind, 'conditional-keyset-swap')
  const result = await completeCtfRangeConsolidationOperation(operation, wallet)
  assert.equal(result[0]?.secret, 'conditional-result')
})

test('rejects wallet substitution before the operation is exposed', async () => {
  const wallet = {
    prepareSwapToSend: async (amount: number, inputs: Proof[]) => ({
      amount: Amount.from(amount),
      fees: Amount.from(1),
      keysetId: KEYSET_ID,
      inputs: inputs.slice(1),
      sendOutputs: outputData(ROUND.outputs),
      keepOutputs: [],
      unselectedProofs: [],
    }),
    completeSwap: async () => ({ keep: [], send: [] }),
    prepareConditionalSwap: async () => {
      throw new Error('unexpected conditional consolidation')
    },
    completeConditionalSwap: async () => ({}),
  }
  await assert.rejects(
    prepareCtfRangeConsolidationOperation({
      operationId: 'source:consolidation:0',
      rangeOperationId: 'range-1',
      mintUrl: MINT_URL,
      keysetId: KEYSET_ID,
      inputs: INPUTS,
      conditional: false,
      inputFeePpk: 100,
      plannedRound: ROUND,
      wallet,
    }),
    /substituted exact range consolidation inputs/,
  )
})

function proof(secret: string, amount: number): Proof {
  return { id: KEYSET_ID, amount, secret, C: `C-${secret}` }
}

function outputData(amounts: readonly string[]): OutputData[] {
  return amounts.map((amount, index) =>
    OutputData.createSingleData(Number(amount), KEYSET_ID, `output-${index}`, BigInt(index + 1)),
  )
}
