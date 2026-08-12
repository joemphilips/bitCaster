import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, OutputData, type CounterSource, type Proof } from '@cashu/cashu-ts'
import {
  classifyExactProofConsolidationReplayFailure,
  completeCtfRangeConsolidationOperation,
  completeExactProofConsolidationOperation,
  prepareCtfRangeConsolidationOperation,
  prepareExactProofConsolidationOperation,
  validateCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationProofs,
  validateExactProofConsolidationOperation,
  type ExactProofConsolidationWallet,
} from '../src/ctfRangeConsolidationOperation.ts'

type RegularOutputConfig = Parameters<ExactProofConsolidationWallet['prepareSwapToSend']>[3]
type ConditionalOutputConfig = Parameters<
  ExactProofConsolidationWallet['prepareConditionalSwap']
>[0]

const KEYSET_ID = `01${'a'.repeat(64)}`
const KEYSET = {
  id: KEYSET_ID,
  keys: { '1': '02', '2': '02', '4096': '02', '8192': '02' },
}
const SEED = new Uint8Array(64).fill(7)
const MINT_URL = 'https://mint.example'
const INPUTS = [proof('a', 4096), proof('b', 4096), proof('c', 2)]
const ROUND = {
  inputs: ['4096', '4096', '2'],
  outputs: ['8192', '1'],
  fee: '1',
}

test('prepares and completes one exact regular range consolidation', async () => {
  const counter = countedCounterSource()
  const fixture = completingRegularWallet()

  const operation = await prepareCtfRangeConsolidationOperation({
    operationId: 'source:consolidation:0',
    rangeOperationId: 'range-1',
    mintUrl: MINT_URL,
    keysetId: KEYSET_ID,
    inputs: INPUTS,
    conditional: false,
    inputFeePpk: 100,
    plannedRound: ROUND,
    ...deterministicInput(counter.source),
    wallet: fixture.wallet,
  })

  assert.equal(counter.count(), 1)
  assert.equal(operation.kind, 'proof-consolidation')
  assert.equal(operation.metadata?.transportKind, 'wallet-send')
  assert.equal(operation.metadata?.purpose, 'ctf-range-authorization-consolidation')
  assert.deepEqual(
    operation.outputs.consolidated?.map((output) => output.blindedMessage.amount),
    ['8192', '1'],
  )
  assert.deepEqual(validateCtfRangeConsolidationOperation(operation).operation, operation)
  const result = await completeCtfRangeConsolidationOperation(operation, fixture.wallet)
  assert.equal(counter.count(), 1)
  assert.equal(fixture.completed(), true)
  assert.deepEqual(
    result.map(({ amount }) => Number(amount)),
    [8192, 1],
  )
})

test('prepares a conditional consolidation with the same exact plan', async () => {
  let plannedOutputs: OutputData[] = []
  const wallet: ExactProofConsolidationWallet = {
    prepareSwapToSend: async () => {
      throw new Error('unexpected regular consolidation')
    },
    completeSwap: async () => ({ keep: [], send: [] }),
    prepareConditionalSwap: async (input: ConditionalOutputConfig) => ({
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      outputDataByLabel: { consolidated: (plannedOutputs = input.outputs[0].data) },
    }),
    completeConditionalSwap: async () => ({ consolidated: plannedOutputs.map(proofFromOutput) }),
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
    ...deterministicInput(),
    wallet,
  })

  assert.equal(operation.kind, 'proof-consolidation')
  assert.equal(operation.metadata?.transportKind, 'conditional-keyset-swap')
  const result = await completeCtfRangeConsolidationOperation(operation, wallet)
  assert.deepEqual(
    result.map(({ amount }) => Number(amount)),
    [8192, 1],
  )
})

test('generic exact consolidation spends an inactive keyset into an active keyset', async () => {
  const outputKeysetId = `01${'b'.repeat(64)}`
  let plannedOutputs: OutputData[] = []
  const wallet: ExactProofConsolidationWallet = {
    prepareSwapToSend: async (
      amount: number,
      inputs: Proof[],
      config: { keysetId: string },
      outputConfig: RegularOutputConfig,
    ) => {
      assert.equal(config.keysetId, outputKeysetId)
      return {
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: outputKeysetId,
        inputs,
        sendOutputs: (plannedOutputs = outputConfig.send.data),
        keepOutputs: [],
        unselectedProofs: [],
      }
    },
    completeSwap: async () => ({ keep: [], send: plannedOutputs.map(proofFromOutput) }),
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
    outputKeyset: { ...KEYSET, id: outputKeysetId },
    inputs: INPUTS,
    conditional: false,
    inputFeePpk: 100,
    plannedRound: ROUND,
    seed: SEED,
    counterSource: counterSource(),
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
  let outputs: OutputData[] = []
  let exact: Proof[] = []
  const wallet: ExactProofConsolidationWallet = {
    prepareSwapToSend: async (
      amount: number,
      inputs: Proof[],
      _config: unknown,
      config: RegularOutputConfig,
    ) => ({
      amount: Amount.from(amount),
      fees: Amount.from(1),
      keysetId: KEYSET_ID,
      inputs,
      sendOutputs: (outputs = config.send.data),
      keepOutputs: [],
      unselectedProofs: [],
    }),
    completeSwap: async () => ({ keep: [], send: exact }),
    prepareConditionalSwap: async (input: ConditionalOutputConfig) => ({
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      outputDataByLabel: { consolidated: (outputs = input.outputs[0].data) },
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
      ...deterministicInput(),
      wallet,
    })
    exact = outputs.map(proofFromOutput)
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
      ...deterministicInput(),
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
          ...deterministicInput(),
          wallet,
        }),
        /substituted exact proof consolidation outputs/,
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
    ...deterministicInput(),
    wallet: regularWallet(),
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

test('rejects a substituted deterministic blinding factor before persistence', async () => {
  const wallet: ExactProofConsolidationWallet = {
    prepareSwapToSend: async (amount, inputs, _config, outputConfig) => {
      const [first] = outputConfig.send.data
      assert.ok(first)
      Reflect.set(first, 'blindingFactor', first.blindingFactor + 1n)
      return {
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: KEYSET_ID,
        inputs,
        sendOutputs: outputConfig.send.data,
        keepOutputs: [],
        unselectedProofs: [],
      }
    },
    completeSwap: async () => ({ keep: [], send: [] }),
    prepareConditionalSwap: async () => {
      throw new Error('unexpected conditional consolidation')
    },
    completeConditionalSwap: async () => ({}),
  }

  await assert.rejects(
    prepareCtfRangeConsolidationOperation({
      operationId: 'source:consolidation:substituted-blinding-factor',
      rangeOperationId: 'range-1',
      mintUrl: MINT_URL,
      keysetId: KEYSET_ID,
      inputs: INPUTS,
      conditional: false,
      inputFeePpk: 100,
      plannedRound: ROUND,
      ...deterministicInput(),
      wallet,
    }),
    /substituted exact proof consolidation outputs/,
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
      ...deterministicInput(),
      wallet: regularWallet(),
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

function regularWallet(outputs?: OutputData[]): ExactProofConsolidationWallet {
  return {
    prepareSwapToSend: async (
      amount: number,
      inputs: Proof[],
      _config: unknown,
      config: RegularOutputConfig,
    ) => ({
      amount: Amount.from(amount),
      fees: Amount.from(1),
      keysetId: KEYSET_ID,
      inputs,
      sendOutputs: outputs ?? config.send.data,
      keepOutputs: [],
      unselectedProofs: [],
    }),
    completeSwap: async () => ({ keep: [], send: [] }),
    prepareConditionalSwap: async (input: ConditionalOutputConfig) => ({
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      outputDataByLabel: { consolidated: outputs ?? input.outputs[0].data },
    }),
    completeConditionalSwap: async () => ({ consolidated: [] }),
  }
}

function completingRegularWallet(): {
  readonly wallet: ExactProofConsolidationWallet
  readonly completed: () => boolean
} {
  let plannedOutputs: OutputData[] = []
  let completed = false
  return {
    wallet: {
      prepareSwapToSend: async (amount, inputs, _config, outputConfig) => ({
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: KEYSET_ID,
        inputs,
        sendOutputs: (plannedOutputs = outputConfig.send.data),
        keepOutputs: [],
        unselectedProofs: [],
      }),
      completeSwap: async () => {
        completed = true
        return { keep: [], send: plannedOutputs.map(proofFromOutput) }
      },
      prepareConditionalSwap: async () => {
        throw new Error('unexpected conditional consolidation')
      },
      completeConditionalSwap: async () => ({}),
    },
    completed: () => completed,
  }
}

function deterministicInput(source = counterSource()) {
  return { outputKeyset: KEYSET, seed: SEED, counterSource: source }
}

function counterSource(onReserve: () => void = () => undefined): CounterSource {
  let next = 0
  return {
    reserve: async (_keysetId, count) => {
      onReserve()
      const start = next
      next += count
      return { start, count }
    },
    advanceToAtLeast: async () => undefined,
  }
}

function countedCounterSource(): { readonly source: CounterSource; readonly count: () => number } {
  let reservations = 0
  return {
    source: counterSource(() => {
      reservations += 1
    }),
    count: () => reservations,
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
