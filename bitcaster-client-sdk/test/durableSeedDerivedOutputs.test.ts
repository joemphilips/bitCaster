import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData, type CounterRange, type CounterSource } from '@cashu/cashu-ts'
import {
  DurableSeedDerivedOutputReservationError,
  matchDurableSeedDerivedProofsToPlan,
  reconstructDurableSeedDerivedOutputs,
  reserveAndConstructDurableSeedDerivedOutputs,
  reserveDurableSeedDerivedOutputs,
  type DurableSeedDerivedOutputPlan,
} from '../src/durableSeedDerivedOutputs.ts'

const KEYSET_ID = `01${'a'.repeat(64)}`
const KEYSET = {
  id: KEYSET_ID,
  keys: {
    '1': '02',
    '2': '02',
    '3': '02',
    '5': '02',
    '8': '02',
  },
}
const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)

test('reserves and reconstructs one exact deterministic output plan', async () => {
  const source = new MemoryCounterSource(7)
  const plan = await reserveDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: source,
    keyset: KEYSET,
    amounts: [2, 3],
  })

  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.keysetId, KEYSET_ID)
  assert.equal(plan.counterStart, 7)
  assert.equal(plan.counterCount, 2)
  assert.equal(plan.outputs.length, 2)
  assert.equal(plan.outputs[0]!.blindedMessage.amount, '2')
  assert.equal(plan.outputs[1]!.blindedMessage.amount, '3')

  const rebuilt = reconstructDurableSeedDerivedOutputs({
    seed: SEED,
    keyset: KEYSET,
    amounts: [2, 3],
    plan,
  })
  assert.equal(rebuilt.plan.counterStart, 7)
  assert.equal(rebuilt.outputData.length, 2)
  assert.equal(rebuilt.outputData[0]!.blindedMessage.B_, plan.outputs[0]!.blindedMessage.B_)
  assert.equal(rebuilt.outputData[1]!.blindedMessage.B_, plan.outputs[1]!.blindedMessage.B_)
})

test('preserves an ordered custom split exactly', async () => {
  const plan = await reserveDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: new MemoryCounterSource(11),
    keyset: KEYSET,
    amounts: [5, 1, 2],
  })

  assert.deepEqual(
    plan.outputs.map((output) => output.blindedMessage.amount),
    ['5', '1', '2'],
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [1, 5, 2],
        plan,
      }),
    /does not match/,
  )
})

test('rejects malformed and foreign plans', async () => {
  const plan = await reserveDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: new MemoryCounterSource(),
    keyset: KEYSET,
    amounts: [2],
  })
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: { ...plan, unexpected: true },
      }),
    /invalid/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: { ...plan, keysetId: `01${'f'.repeat(64)}` },
      }),
    /keyset/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: changedOutput(plan, (output) => ({
          ...output,
          secret: `${output.secret}00`,
        })),
      }),
    /does not match/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: changedOutput(plan, (output) => ({
          ...output,
          blindedMessage: { ...output.blindedMessage, unexpected: true },
        })),
      }),
    /invalid/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: { ...plan, schemaVersion: 2 },
      }),
    /invalid/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: { ...plan, counterStart: 0.5 },
      }),
    /invalid/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: {
          ...plan,
          outputs: [
            { blindedMessage: plan.outputs[0]!.blindedMessage, secret: plan.outputs[0]!.secret },
          ],
        },
      }),
    /invalid/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: changedOutput(plan, (output) => ({
          ...output,
          blindedMessage: { ...output.blindedMessage, amount: '1' },
        })),
      }),
    /does not match/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: changedOutput(plan, (output) => ({
          ...output,
          blindingFactor: '1',
        })),
      }),
    /does not match/,
  )
  assert.throws(
    () =>
      reconstructDurableSeedDerivedOutputs({
        seed: SEED,
        keyset: KEYSET,
        amounts: [2],
        plan: changedOutput(plan, (output) => ({
          ...output,
          blindedMessage: { ...output.blindedMessage, B_: 'foreign' },
        })),
      }),
    /does not match/,
  )
})

test('preserves only bounded safe reservation failure categories', async (context) => {
  const secretLikeContent = 'proof-secret=reserve-test key=private-test-key'
  const cases: readonly {
    readonly name: string
    readonly rejection: unknown
    readonly category: 'recovery_incomplete' | 'stale_profile' | 'unavailable'
  }[] = [
    {
      name: 'recovery is incomplete',
      rejection: Object.assign(new Error(secretLikeContent), { code: 'recovery_incomplete' }),
      category: 'recovery_incomplete',
    },
    {
      name: 'profile is stale',
      rejection: Object.assign(new Error(secretLikeContent), { code: 'stale_profile' }),
      category: 'stale_profile',
    },
    {
      name: 'unknown error code',
      rejection: Object.assign(new Error(secretLikeContent), { code: 'foreign_database' }),
      category: 'unavailable',
    },
    {
      name: 'non-Error rejection',
      rejection: secretLikeContent,
      category: 'unavailable',
    },
  ]

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      let reservations = 0
      let result: unknown
      const failed: CounterSource = {
        reserve: async () => {
          reservations += 1
          throw scenario.rejection
        },
        advanceToAtLeast: async () => undefined,
      }

      await assert.rejects(
        async () => {
          result = await reserveAndConstructDurableSeedDerivedOutputs({
            seed: SEED,
            counterSource: failed,
            keyset: KEYSET,
            amounts: [2],
          })
        },
        (error: unknown) => {
          assert.ok(error instanceof DurableSeedDerivedOutputReservationError)
          assert.equal(error.category, scenario.category)
          assert.equal(error.message, 'durable seed-derived output reservation failed')
          assert.equal(Object.hasOwn(error, 'cause'), false)
          const ownProperties = Object.getOwnPropertyNames(error)
            .map((name) => `${name}:${String((error as unknown as Record<string, unknown>)[name])}`)
            .join('\n')
          assert.equal(ownProperties.includes(secretLikeContent), false)
          return true
        },
      )

      assert.equal(reservations, 1)
      assert.equal(result, undefined)
    })
  }
})

test('fails closed when reservation is malformed', async () => {
  const malformed: CounterSource = {
    reserve: async () => ({ start: 3, count: 2 }),
    advanceToAtLeast: async () => undefined,
  }

  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: malformed,
        keyset: KEYSET,
        amounts: [2],
      }),
    /reservation is invalid/,
  )
})

test('rejects invalid input before it reserves a counter', async () => {
  const source = new MemoryCounterSource()
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: source,
        keyset: KEYSET,
        amounts: [0],
      }),
    /input is invalid/,
  )
  assert.equal(source.reservations, 0)
  for (const legacyId of ['0000000000000001', '0000000080000000']) {
    await assert.rejects(
      () =>
        reserveDurableSeedDerivedOutputs({
          seed: SEED,
          counterSource: source,
          keyset: { ...KEYSET, id: legacyId },
          amounts: [2],
        }),
      /input is invalid/,
    )
    assert.equal(source.reservations, 0)
  }
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: source,
        keyset: { ...KEYSET, id: KEYSET_ID.toUpperCase() },
        amounts: [2],
      }),
    /input is invalid/,
  )
  assert.equal(source.reservations, 0)
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: source,
        keyset: { ...KEYSET, id: `01${'a'.repeat(65)}` },
        amounts: [2],
      }),
    /input is invalid/,
  )
  assert.equal(source.reservations, 0)
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: source,
        keyset: {
          ...KEYSET,
          keys: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [String(index + 1), '02']),
          ),
        },
        amounts: [2],
      }),
    /input is invalid/,
  )
  assert.equal(source.reservations, 0)
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: source,
        keyset: KEYSET,
        amounts: Array.from({ length: 257 }, () => 1),
      }),
    /input is invalid/,
  )
  assert.equal(source.reservations, 0)
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: new Uint8Array(32),
        counterSource: source,
        keyset: KEYSET,
        amounts: [2],
      }),
    /input is invalid/,
  )
  assert.equal(source.reservations, 0)
})

test('fails closed when the reserved counter range overflows', async () => {
  const source = new MemoryCounterSource(2_147_483_647)
  await assert.rejects(
    () =>
      reserveDurableSeedDerivedOutputs({
        seed: SEED,
        counterSource: source,
        keyset: KEYSET,
        amounts: [2, 3],
      }),
    /reservation is invalid/,
  )
  assert.equal(source.reservations, 1)
})

test('leaves an accepted abandoned reservation as a monotonic counter gap', async () => {
  const source = new MemoryCounterSource()
  const abandoned = await reserveDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: source,
    keyset: KEYSET,
    amounts: [2, 3],
  })
  assert.equal(abandoned.counterStart, 0)

  const next = await reserveDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: source,
    keyset: KEYSET,
    amounts: [5],
  })
  assert.equal(next.counterStart, 2)
  assert.equal(source.next, 3)
})

test('maps exact proofs to plan order and rejects duplicate or foreign identities', async () => {
  const plan = await reserveDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: new MemoryCounterSource(),
    keyset: KEYSET,
    amounts: [2, 3],
  })
  const proofs = plan.outputs.map((output) => {
    const value = OutputData.deserialize(output)
    return {
      id: value.blindedMessage.id,
      amount: Number(value.blindedMessage.amount),
      secret: new TextDecoder().decode(value.secret),
    }
  })

  assert.deepEqual(
    matchDurableSeedDerivedProofsToPlan({ plan, proofs: [...proofs].reverse() }),
    proofs,
  )
  assert.throws(
    () => matchDurableSeedDerivedProofsToPlan({ plan, proofs: [proofs[0]!, proofs[0]!] }),
    /duplicated/,
  )
  assert.throws(
    () =>
      matchDurableSeedDerivedProofsToPlan({
        plan,
        proofs: [{ ...proofs[0]!, secret: 'foreign' }, proofs[1]!],
      }),
    /foreign/,
  )
})

function changedOutput(
  plan: DurableSeedDerivedOutputPlan,
  change: (
    output: DurableSeedDerivedOutputPlan['outputs'][number],
  ) => DurableSeedDerivedOutputPlan['outputs'][number],
): DurableSeedDerivedOutputPlan {
  return { ...plan, outputs: [change(plan.outputs[0]!)] }
}

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
