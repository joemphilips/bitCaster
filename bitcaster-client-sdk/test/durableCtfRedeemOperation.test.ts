import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CheckStateEnum,
  MintOperationError,
  hashToCurve,
  type CounterRange,
  type CounterSource,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts'
import {
  buildKeysetRedeemOperationId,
  classifyPreparedDurableCtfRedeemInputs,
  executePreparedDurableCtfRedeem,
  ORACLE_NOT_ATTESTED_OUTCOME_CODE,
  prepareDurableCtfRedeemOperation,
  readAuthenticatedCtfRedeemTerminalEvidence,
  readPreparedDurableCtfRedeemRequest,
  UneconomicCtfRedeemError,
} from '../src/ctfRedeem.ts'
import { reconstructDurableSeedDerivedOutputs } from '../src/durableSeedDerivedOutputs.ts'

const MINT = 'https://mint.example'
const CONDITION = 'aa'.repeat(32)
const CONDITIONAL_KEYSET_ID = `01${'bb'.repeat(32)}`
const REGULAR_KEYSET_ID = `01${'cc'.repeat(32)}`
const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
const REGULAR_KEYSET = {
  id: REGULAR_KEYSET_ID,
  unit: 'msat',
  active: true,
  keys: { 1: '02', 2: '02', 4: '02' },
} as unknown as MintKeys

function proof(amount: number): Proof {
  return { id: CONDITIONAL_KEYSET_ID, amount, secret: 'ctf-input', C: '02' } as Proof
}

function preparation(source: CounterSource, amount = 7) {
  const inputs = [proof(amount)]
  return {
    operationId: buildKeysetRedeemOperationId({
      mintUrl: MINT,
      unit: 'msat',
      conditionId: CONDITION,
      keysetId: CONDITIONAL_KEYSET_ID,
      proofs: inputs,
    }),
    mintUrl: MINT,
    conditionId: CONDITION,
    outcomeCollection: 'Alpha',
    inputKeyset: { id: CONDITIONAL_KEYSET_ID, unit: 'msat', input_fee_ppk: 0 },
    regularKeyset: REGULAR_KEYSET,
    inputs,
    oracleWitness: '{"attestation":"witness"}',
    seed: SEED,
    counterSource: source,
  }
}

test('CTF redeem preparation reserves exact seed outputs and no mint effect', async () => {
  const source = new MemoryCounterSource(9)
  const prepared = await prepareDurableCtfRedeemOperation(preparation(source))
  const again = await prepareDurableCtfRedeemOperation(preparation(new MemoryCounterSource(9)))

  assert.equal(source.reservations, 1)
  assert.equal(source.next, 12)
  assert.equal(prepared.operation.kind, 'ctf-redeem')
  assert.equal(prepared.operation.metadata?.unit, 'msat')
  assert.equal(prepared.operation.metadata?.netOutputSubunits, 7)
  assert.equal(prepared.operation.inputs[0]?.conditionId, CONDITION)
  assert.equal(prepared.operation.inputs[0]?.outcomeCollection, 'Alpha')
  assert.equal(prepared.outputPlan.counterStart, 9)
  assert.equal(prepared.outputPlan.counterCount, 3)
  assert.deepEqual(
    prepared.operation.outputs.regular?.map((output) => output.blindedMessage.amount),
    ['4', '2', '1'],
  )
  assert.deepEqual(
    prepared.operation.outputs.regular?.map((output) => output.blindedMessage.B_),
    again.operation.outputs.regular?.map((output) => output.blindedMessage.B_),
  )
  const rebuilt = reconstructDurableSeedDerivedOutputs({
    seed: SEED,
    keyset: REGULAR_KEYSET,
    amounts: [4, 2, 1],
    plan: prepared.outputPlan,
  })
  assert.equal(rebuilt.outputData[0]?.blindedMessage.B_, prepared.outputData[0]?.blindedMessage.B_)
  const request = readPreparedDurableCtfRedeemRequest({
    operation: prepared.operation,
    seed: SEED,
    regularKeyset: REGULAR_KEYSET,
  })
  assert.equal(request.outputs[0]?.blindedMessage.B_, prepared.outputData[0]?.blindedMessage.B_)
})

test('prepared CTF redeem execution uses the persisted request and classifies only mint code 13015', async () => {
  const prepared = await prepareDurableCtfRedeemOperation(preparation(new MemoryCounterSource()))
  let submittedInputWitness: unknown
  let submittedOutput: string | undefined
  const wallet = {
    loadMint: async () => undefined,
    redeemOutcomeProofs: async (request: {
      inputs: Proof[]
      outputs: Array<{ blindedMessage: { B_: string } }>
    }) => {
      submittedInputWitness = request.inputs[0]?.witness
      submittedOutput = request.outputs[0]?.blindedMessage.B_
      return []
    },
  }
  const result = await executePreparedDurableCtfRedeem({
    operation: prepared.operation,
    seed: SEED,
    regularKeyset: REGULAR_KEYSET,
    wallet,
  })
  assert.equal(result.kind, 'redeemed')
  assert.equal(submittedInputWitness, '{"attestation":"witness"}')
  assert.equal(submittedOutput, prepared.outputData[0]?.blindedMessage.B_)

  const losing = await executePreparedDurableCtfRedeem({
    operation: prepared.operation,
    seed: SEED,
    regularKeyset: REGULAR_KEYSET,
    wallet: {
      loadMint: async () => undefined,
      redeemOutcomeProofs: async () => {
        throw new MintOperationError(ORACLE_NOT_ATTESTED_OUTCOME_CODE, 'losing outcome')
      },
    },
  })
  assert.equal(losing.kind, 'losing')
  if (losing.kind !== 'losing') throw new Error('expected losing evidence')
  assert.equal(
    readAuthenticatedCtfRedeemTerminalEvidence(losing.evidence).operationId,
    prepared.operation.operationId,
  )

  await assert.rejects(
    () =>
      executePreparedDurableCtfRedeem({
        operation: prepared.operation,
        seed: SEED,
        regularKeyset: REGULAR_KEYSET,
        wallet: {
          loadMint: async () => undefined,
          redeemOutcomeProofs: async () => {
            throw new Error('timeout')
          },
        },
      }),
    /timeout/,
  )
})

test('prepared CTF redeem recovery requires complete exact mint-state evidence', async () => {
  const prepared = await prepareDurableCtfRedeemOperation(preparation(new MemoryCounterSource()))
  const Y = hashToCurve(new TextEncoder().encode('ctf-input')).toHex(true)
  const cases = [
    { states: [{ Y, state: CheckStateEnum.SPENT, witness: null }], expected: 'spent' },
    { states: [{ Y, state: CheckStateEnum.UNSPENT, witness: null }], expected: 'unspent' },
    { states: [], expected: 'pending' },
    { states: [{ Y: 'foreign', state: CheckStateEnum.SPENT, witness: null }], expected: 'pending' },
  ] as const
  for (const scenario of cases) {
    const actual = await classifyPreparedDurableCtfRedeemInputs({
      operation: prepared.operation,
      wallet: {
        loadMint: async () => undefined,
        redeemOutcomeProofs: async () => [],
        checkProofsStates: async () => [...scenario.states],
      },
    })
    assert.equal(actual, scenario.expected)
  }
})

test('CTF redeem preparation rejects foreign unit and input keyset before counter use', async () => {
  const source = new MemoryCounterSource()
  const valid = preparation(source)
  await assert.rejects(
    () =>
      prepareDurableCtfRedeemOperation({
        ...valid,
        regularKeyset: { ...REGULAR_KEYSET, unit: 'sat' },
      }),
    /keyset authority/,
  )
  await assert.rejects(
    () =>
      prepareDurableCtfRedeemOperation({
        ...valid,
        inputKeyset: { ...valid.inputKeyset, id: `01${'dd'.repeat(32)}` },
      }),
    /exact conditional keyset/,
  )
  assert.equal(source.reservations, 0)
})

test('CTF redeem preparation rejects uneconomic and oversized pages before counter use', async () => {
  const source = new MemoryCounterSource()
  const one = preparation(source, 1)
  await assert.rejects(
    () =>
      prepareDurableCtfRedeemOperation({
        ...one,
        inputKeyset: { ...one.inputKeyset, input_fee_ppk: 1 },
      }),
    UneconomicCtfRedeemError,
  )
  const oversized = preparation(source, 257)
  await assert.rejects(
    () =>
      prepareDurableCtfRedeemOperation({
        ...oversized,
        regularKeyset: { ...REGULAR_KEYSET, keys: { 1: '02' } },
      }),
    /output count/,
  )
  assert.equal(source.reservations, 0)
})

class MemoryCounterSource implements CounterSource {
  reservations = 0
  next: number

  constructor(next = 0) {
    this.next = next
  }

  async reserve(_keysetId: string, count: number): Promise<CounterRange> {
    this.reservations += 1
    const start = this.next
    this.next += count
    return { start, count }
  }

  async advanceToAtLeast(_keysetId: string, minNext: number): Promise<void> {
    this.next = Math.max(this.next, minNext)
  }
}
