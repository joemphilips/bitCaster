import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, OutputData, type Proof } from '@cashu/cashu-ts'
import {
  classifyExactProofConsolidationReplayFailure,
  completeCtfRangeConsolidationOperation,
  completeExactProofConsolidationOperation,
  prepareCtfRangeConsolidationOperation,
  prepareExactProofConsolidationOperation,
  validateCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationProofs,
  validateExactProofConsolidationOperation,
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
      return { keep: [], send: outputs.map(proofFromOutput) }
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
  assert.deepEqual(
    result.map(({ amount }) => Number(amount)),
    [8192, 1],
  )
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
    completeConditionalSwap: async () => ({ consolidated: outputs.map(proofFromOutput) }),
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
  assert.deepEqual(
    result.map(({ amount }) => Number(amount)),
    [8192, 1],
  )
})

test('generic exact consolidation spends an inactive keyset into an active keyset', async () => {
  const outputKeysetId = 'keyset-active'
  const outputs = outputDataForKeyset(ROUND.outputs, outputKeysetId)
  const wallet = {
    prepareSwapToSend: async (amount: number, inputs: Proof[], config: { keysetId: string }) => {
      assert.equal(config.keysetId, outputKeysetId)
      return {
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: outputKeysetId,
        inputs,
        sendOutputs: outputs,
        keepOutputs: [],
        unselectedProofs: [],
      }
    },
    completeSwap: async () => ({ keep: [], send: outputs.map(proofFromOutput) }),
    prepareConditionalSwap: async () => {
      throw new Error('unexpected conditional consolidation')
    },
    completeConditionalSwap: async () => ({}),
  }
  const operation = await prepareExactProofConsolidationOperation({
    operationId: 'wallet-proof-consolidation:run:0',
    bindingId: 'run',
    purpose: 'wallet-proof-consolidation',
    mintUrl: MINT_URL,
    unit: 'sat',
    inputKeysetId: KEYSET_ID,
    outputKeysetId,
    inputs: INPUTS,
    conditional: false,
    inputFeePpk: 100,
    plannedRound: ROUND,
    wallet,
  })

  const validated = validateExactProofConsolidationOperation(operation, {
    purpose: 'wallet-proof-consolidation',
  })
  assert.equal(validated.operation.metadata?.inputKeysetId, KEYSET_ID)
  assert.equal(validated.operation.metadata?.keysetId, outputKeysetId)
  assert.equal(validated.operation.metadata?.unit, 'sat')
  const result = await completeExactProofConsolidationOperation(validated, wallet, {
    purpose: 'wallet-proof-consolidation',
  })
  assert.deepEqual(
    result.map(({ id }) => id),
    [outputKeysetId, outputKeysetId],
  )
})

test('rejects incomplete, duplicate, and foreign consolidation results', async () => {
  const outputs = outputData(ROUND.outputs)
  const exact = outputs.map(proofFromOutput)
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
    completeSwap: async () => ({ keep: [], send: exact }),
    prepareConditionalSwap: async (input: { inputs: Proof[] }) => ({
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      outputDataByLabel: { consolidated: outputs },
    }),
    completeConditionalSwap: async () => ({ consolidated: exact }),
  }
  for (const conditional of [false, true]) {
    const operation = await prepareCtfRangeConsolidationOperation({
      operationId: `source:consolidation:${conditional ? 1 : 0}`,
      rangeOperationId: 'range-1',
      mintUrl: MINT_URL,
      keysetId: KEYSET_ID,
      inputs: INPUTS,
      conditional,
      inputFeePpk: 100,
      plannedRound: ROUND,
      wallet,
    })
    for (const invalid of [
      undefined,
      [],
      exact.slice(0, 1),
      [exact[0]!, exact[0]!],
      [exact[0]!, proof('foreign', 1)],
    ]) {
      assert.throws(
        () => validateCtfRangeConsolidationProofs(operation, invalid),
        /incomplete|differs/,
      )
    }
  }
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
    /substituted exact proof consolidation inputs/,
  )
})

test('rejects duplicate and predecessor output secrets before mint completion', async () => {
  for (const outputs of [
    outputDataWithSecrets(ROUND.outputs, ['duplicate', 'duplicate']),
    outputDataWithSecrets(ROUND.outputs, [INPUTS[0]!.secret, 'fresh']),
  ]) {
    const wallet = regularWallet(outputs)
    for (const conditional of [false, true]) {
      await assert.rejects(
        prepareCtfRangeConsolidationOperation({
          operationId: `source:consolidation:unsafe-output:${conditional}`,
          rangeOperationId: 'range-1',
          mintUrl: MINT_URL,
          keysetId: KEYSET_ID,
          inputs: INPUTS,
          conditional,
          inputFeePpk: 100,
          plannedRound: ROUND,
          wallet,
        }),
        /output secrets are not fresh and unique/,
      )
    }
  }

  const operation = await prepareCtfRangeConsolidationOperation({
    operationId: 'source:consolidation:persisted-output',
    rangeOperationId: 'range-1',
    mintUrl: MINT_URL,
    keysetId: KEYSET_ID,
    inputs: INPUTS,
    conditional: false,
    inputFeePpk: 100,
    plannedRound: ROUND,
    wallet: regularWallet(outputData(ROUND.outputs)),
  })
  const [first, second] = operation.outputs.consolidated ?? []
  assert.ok(first)
  assert.ok(second)
  assert.throws(
    () =>
      validateCtfRangeConsolidationOperation({
        ...operation,
        outputs: { consolidated: [first, { ...second, secret: first.secret }] },
      }),
    /does not match its exact private material|output secrets are not fresh and unique/,
  )
})

test('releases only a definitely rejected exact replay with all inputs unspent', () => {
  assert.equal(
    classifyExactProofConsolidationReplayFailure({
      definiteMintRejection: true,
      inputStates: ['UNSPENT', 'UNSPENT'],
    }),
    'release-exact-unspent-inputs',
  )
  for (const input of [
    { definiteMintRejection: false, inputStates: ['UNSPENT'] },
    { definiteMintRejection: true, inputStates: ['PENDING'] },
    { definiteMintRejection: true, inputStates: ['UNSPENT', 'SPENT'] },
    { definiteMintRejection: true, inputStates: [] },
  ]) {
    assert.equal(classifyExactProofConsolidationReplayFailure(input), 'remain-pending')
  }
})

test('rejects duplicate input secrets before mint completion', async () => {
  const duplicatedInputs = [proof('a', 4096), proof('a', 4096), proof('c', 2)]
  await assert.rejects(
    prepareCtfRangeConsolidationOperation({
      operationId: 'source:consolidation:duplicate-input',
      rangeOperationId: 'range-1',
      mintUrl: MINT_URL,
      keysetId: KEYSET_ID,
      inputs: duplicatedInputs,
      conditional: false,
      inputFeePpk: 100,
      plannedRound: ROUND,
      wallet: regularWallet(outputData(ROUND.outputs)),
    }),
    /input secrets are not unique/,
  )
})

function proof(secret: string, amount: number): Proof {
  return { id: KEYSET_ID, amount, secret, C: `C-${secret}` }
}

function outputData(amounts: readonly string[]): OutputData[] {
  return outputDataForKeyset(amounts, KEYSET_ID)
}

function outputDataForKeyset(amounts: readonly string[], keysetId: string): OutputData[] {
  return amounts.map((amount, index) =>
    OutputData.createSingleData(Number(amount), keysetId, `output-${index}`, BigInt(index + 1)),
  )
}

function outputDataWithSecrets(
  amounts: readonly string[],
  secrets: readonly string[],
): OutputData[] {
  return amounts.map((amount, index) =>
    OutputData.createSingleData(Number(amount), KEYSET_ID, secrets[index]!, BigInt(index + 1)),
  )
}

function regularWallet(outputs: OutputData[]) {
  return {
    prepareSwapToSend: async (amount: number, inputs: Proof[]) => ({
      amount: Amount.from(amount),
      fees: Amount.from(1),
      keysetId: KEYSET_ID,
      inputs,
      sendOutputs: outputs,
      keepOutputs: [],
      unselectedProofs: [],
    }),
    completeSwap: async () => ({ keep: [], send: outputs.map(proofFromOutput) }),
    prepareConditionalSwap: async (input: { inputs: Proof[] }) => ({
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      outputDataByLabel: { consolidated: outputs },
    }),
    completeConditionalSwap: async () => ({ consolidated: outputs.map(proofFromOutput) }),
  }
}

function proofFromOutput(output: OutputData): Proof {
  return {
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    secret: new TextDecoder().decode(output.secret),
    C: 'C-result',
  }
}
