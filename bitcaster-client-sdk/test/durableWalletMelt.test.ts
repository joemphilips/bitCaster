import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, OutputData, type MeltPreview, type Proof } from '@cashu/cashu-ts'
import {
  runDurableWalletMeltOperation,
  type DurableWalletMeltExecutionInput,
} from '../src/durableWalletMelt.ts'
import { serializeDurableCustodyOutput } from '../src/durableCustodyProofOperation.ts'
import {
  decodeDurableWalletOperation,
  type DurableWalletMeltOperation,
} from '../src/durableWalletOperation.ts'

const KEYSET_ID = `01${'aa'.repeat(32)}`
const INPUT: Proof = {
  id: KEYSET_ID,
  amount: Amount.from(1),
  secret: 'melt-input',
  C: 'input-C',
  dleq: null,
}
const CHANGE: Proof = {
  id: KEYSET_ID,
  amount: Amount.from(1),
  secret: 'melt-change',
  C: 'change-C',
  dleq: null,
}

test('executes the saved melt preview and stages only a paid response', async () => {
  const operation = meltOperation()
  const calls: string[] = []
  let suppliedPreview: MeltPreview<{ quote: string }> | null = null
  const input = meltInput(operation, {
    calls,
    async completeMelt(preview) {
      suppliedPreview = preview
      return { quote: { quote: 'quote-1', state: 'PAID' }, change: [CHANGE] }
    },
  })

  const result = await runDurableWalletMeltOperation(input)

  assert.equal(result.state, 'paid')
  assert.deepEqual(result.proofs, [CHANGE])
  assert.deepEqual(calls, ['complete', 'stage-paid'])
  assert.equal(suppliedPreview?.quote.quote, 'quote-1')
  assert.equal(suppliedPreview?.outputData[0] instanceof OutputData, true)
})

test('returns exact applied change without transport calls', async () => {
  const calls: string[] = []
  const saved = [CHANGE]
  const result = await runDurableWalletMeltOperation(
    meltInput(meltOperation(), {
      resultState: 'applied',
      calls,
      async readAppliedResult() {
        return saved
      },
    }),
  )

  assert.equal(result.state, 'paid')
  assert.equal(result.proofs, saved)
  assert.deepEqual(calls, ['read-applied'])
})

test('finishes staged admission without transport calls', async () => {
  const calls: string[] = []
  const saved = [CHANGE]
  const result = await runDurableWalletMeltOperation(
    meltInput(meltOperation(), {
      resultState: 'verified-staged',
      calls,
      async applyStagedResult() {
        return saved
      },
    }),
  )

  assert.equal(result.state, 'paid')
  assert.equal(result.proofs, saved)
  assert.deepEqual(calls, ['apply-staged'])
})

test('keeps a pending quote reserved and does not retry it', async () => {
  const calls: string[] = []
  await assert.rejects(
    runDurableWalletMeltOperation(
      meltInput(meltOperation(), {
        mode: 'recover',
        calls,
        async checkMeltQuote() {
          return { quote: 'quote-1', state: 'PENDING' }
        },
      }),
    ),
    /remains pending/,
  )

  assert.deepEqual(calls, ['check:quote-1'])
})

test('rejects a foreign quote response before changing custody', async () => {
  const calls: string[] = []
  await assert.rejects(
    runDurableWalletMeltOperation(
      meltInput(meltOperation(), {
        calls,
        async completeMelt() {
          return { quote: { quote: 'foreign-quote', state: 'PAID' }, change: [CHANGE] }
        },
      }),
    ),
    /response quote is foreign/,
  )

  assert.deepEqual(calls, ['complete'])
})

test('rejects a foreign quote status before retrying the saved preview', async () => {
  const calls: string[] = []
  await assert.rejects(
    runDurableWalletMeltOperation(
      meltInput(meltOperation(), {
        mode: 'recover',
        calls,
        async checkMeltQuote() {
          return { quote: 'foreign-quote', state: 'UNPAID' }
        },
      }),
    ),
    /status quote is foreign/,
  )

  assert.deepEqual(calls, ['check:quote-1'])
})

test('recovers an already paid quote from its saved output plan', async () => {
  const calls: string[] = []
  let suppliedOutputs: readonly OutputData[] | null = null
  const result = await runDurableWalletMeltOperation(
    meltInput(meltOperation(), {
      mode: 'recover',
      calls,
      async checkMeltQuote(_method, quote) {
        return {
          quote,
          state: 'PAID',
          change: [{ id: KEYSET_ID, amount: 0, C_: 'signature' }],
        }
      },
      createMeltChangeProofs(outputs) {
        calls.push('restore-change')
        suppliedOutputs = outputs as OutputData[]
        return [CHANGE]
      },
    }),
  )

  assert.equal(result.state, 'paid')
  assert.deepEqual(result.proofs, [CHANGE])
  assert.equal(suppliedOutputs?.length, 1)
  assert.equal(suppliedOutputs?.[0] instanceof OutputData, true)
  assert.deepEqual(calls, ['check:quote-1', 'restore-change', 'stage-paid'])
})

test('releases only after an explicit unpaid payment response', async () => {
  const calls: string[] = []
  const result = await runDurableWalletMeltOperation(
    meltInput(meltOperation(), {
      calls,
      async completeMelt() {
        return { quote: { quote: 'quote-1', state: 'UNPAID' }, change: [] }
      },
    }),
  )

  assert.deepEqual(result, { state: 'unpaid', proofs: [] })
  assert.deepEqual(calls, ['complete', 'release-unpaid'])
})

test('recovery releases only after the saved-preview retry explicitly returns unpaid', async () => {
  const calls: string[] = []
  const result = await runDurableWalletMeltOperation(
    meltInput(meltOperation(), {
      mode: 'recover',
      calls,
      async checkMeltQuote() {
        return { quote: 'quote-1', state: 'UNPAID' }
      },
      async completeMelt() {
        return { quote: { quote: 'quote-1', state: 'UNPAID' }, change: [] }
      },
    }),
  )

  assert.deepEqual(result, { state: 'unpaid', proofs: [] })
  assert.deepEqual(calls, ['check:quote-1', 'complete', 'release-unpaid'])
})

test('an unpaid status does not release when the saved-preview retry is uncertain', async () => {
  const calls: string[] = []
  let statuses = 0
  await assert.rejects(
    runDurableWalletMeltOperation(
      meltInput(meltOperation(), {
        mode: 'recover',
        calls,
        async checkMeltQuote() {
          statuses += 1
          return { quote: 'quote-1', state: 'UNPAID' }
        },
        async completeMelt() {
          throw new Error('ambiguous retry')
        },
      }),
    ),
    /ambiguous retry/,
  )

  assert.equal(statuses, 2)
  assert.deepEqual(calls, ['check:quote-1', 'complete', 'check:quote-1'])
})

test('rechecks the same quote after an uncertain retry and restores saved paid change', async () => {
  const calls: string[] = []
  let suppliedOutputs: readonly OutputData[] | null = null
  let statusCount = 0
  const result = await runDurableWalletMeltOperation(
    meltInput(meltOperation(), {
      mode: 'recover',
      calls,
      async checkMeltQuote(_method, quote) {
        statusCount += 1
        return {
          quote,
          state: statusCount === 1 ? 'UNPAID' : 'PAID',
          change: [{ id: KEYSET_ID, amount: 0, C_: 'signature' }],
        }
      },
      async completeMelt() {
        throw new Error('lost response')
      },
      createMeltChangeProofs(outputs) {
        calls.push('restore-change')
        suppliedOutputs = outputs as OutputData[]
        return [CHANGE]
      },
    }),
  )

  assert.equal(result.state, 'paid')
  assert.deepEqual(result.proofs, [CHANGE])
  assert.equal(suppliedOutputs?.length, 1)
  assert.equal(suppliedOutputs?.[0] instanceof OutputData, true)
  assert.deepEqual(calls, [
    'check:quote-1',
    'complete',
    'check:quote-1',
    'restore-change',
    'stage-paid',
  ])
})

function meltInput(
  operation: DurableWalletMeltOperation,
  options: {
    mode?: 'execute' | 'recover'
    resultState?: 'none' | 'verified-staged' | 'applied'
    calls: string[]
    completeMelt?: DurableWalletMeltExecutionInput['transport']['completeMelt']
    checkMeltQuote?: DurableWalletMeltExecutionInput['transport']['checkMeltQuote']
    createMeltChangeProofs?: DurableWalletMeltExecutionInput['transport']['createMeltChangeProofs']
    readAppliedResult?: DurableWalletMeltExecutionInput['store']['readAppliedResult']
    applyStagedResult?: DurableWalletMeltExecutionInput['store']['applyStagedResult']
  },
): DurableWalletMeltExecutionInput {
  return {
    mode: options.mode ?? 'execute',
    operation,
    resultState: options.resultState ?? 'none',
    transport: {
      async completeMelt(preview) {
        options.calls.push('complete')
        if (options.completeMelt !== undefined) return options.completeMelt(preview)
        return { quote: { quote: 'quote-1', state: 'PAID' }, change: [CHANGE] }
      },
      async checkMeltQuote(method, quote) {
        options.calls.push(`check:${quote}`)
        if (options.checkMeltQuote !== undefined) return options.checkMeltQuote(method, quote)
        return { quote, state: 'PAID', change: [] }
      },
      createMeltChangeProofs(outputs, signatures) {
        if (options.createMeltChangeProofs !== undefined) {
          return options.createMeltChangeProofs(outputs, signatures)
        }
        options.calls.push('restore-change')
        return [CHANGE]
      },
    },
    store: {
      async readAppliedResult() {
        options.calls.push('read-applied')
        if (options.readAppliedResult !== undefined) return options.readAppliedResult()
        return [CHANGE]
      },
      async applyStagedResult() {
        options.calls.push('apply-staged')
        if (options.applyStagedResult !== undefined) return options.applyStagedResult()
        return [CHANGE]
      },
      async stageAndApplyPaidChange(change) {
        options.calls.push('stage-paid')
        return [...change]
      },
      async releaseUnpaidReservation() {
        options.calls.push('release-unpaid')
      },
    },
  }
}

function meltOperation(): DurableWalletMeltOperation {
  const output = OutputData.createSingleData(0, KEYSET_ID, 'planned-change', 7n)
  const serializedOutput = serializeDurableCustodyOutput(output)
  return decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId: 'wallet-melt-1',
    kind: 'wallet-melt',
    mintUrl: 'https://mint.example',
    unit: 'msat',
    preview: {
      method: 'bolt11',
      inputs: [
        {
          id: INPUT.id,
          amount: '1',
          secret: INPUT.secret,
          C: INPUT.C,
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      outputData: [{ ...serializedOutput, ephemeralE: serializedOutput.ephemeralE ?? null }],
      keysetId: KEYSET_ID,
      quote: { quote: 'quote-1', amount: '1' },
      requestOptions: { preferAsync: false, extraPayload: {} },
    },
  }) as DurableWalletMeltOperation
}
