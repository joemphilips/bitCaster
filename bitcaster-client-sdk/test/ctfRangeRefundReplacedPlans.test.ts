import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX,
  CtfRangeRefundReplacedPlanSignedError,
  restoreSpentCtfRangeRefund,
  savedReplacedCtfRangeRefundOutputPlans,
} from '../src/ctfRangeRefundReplacedPlans.ts'

class TransportFailure extends Error {}

type PlanState = 'signed' | 'unsigned' | 'partial' | 'invalid' | 'transport'

/** A restore port that answers each plan with its named state, and records each request. */
function restorePort(states: Readonly<Record<string, PlanState>>) {
  const requests: string[] = []
  return {
    requests,
    restore: async (plan: string) => {
      requests.push(plan)
      switch (states[plan] ?? 'unsigned') {
        case 'signed':
          return { kind: 'signed' as const, proofs: [`proof of ${plan}`] }
        case 'unsigned':
          return { kind: 'unsigned' as const }
        case 'partial':
          return { kind: 'incomplete' as const }
        case 'invalid':
          throw new Error(`plan ${plan} is invalid`)
        case 'transport':
          throw new TransportFailure(`no answer for ${plan}`)
      }
    },
  }
}

const isTransportFailure = (error: unknown) => error instanceof TransportFailure

test('a spent refund restores its current plan without a replaced plan', async () => {
  const port = restorePort({ current: 'signed', 'replaced-1': 'signed' })

  const restored = await restoreSpentCtfRangeRefund({
    currentPlan: 'current',
    replacedPlans: ['replaced-1'],
    restore: port.restore,
    isTransportFailure,
  })

  assert.deepEqual(restored, { kind: 'refunded', proofs: ['proof of current'] })
  assert.deepEqual(port.requests, ['current'])
})

test('a hit only on a replaced plan halts the refund and admits nothing', async () => {
  // Backlog "Refund restore from a replaced output plan": another client with
  // the same seed signed every counter of a replaced plan with the same
  // amounts. The refund inputs read SPENT, and the current plan has no
  // signature. The replaced-plan hit does not prove that this refund
  // committed with that plan.
  for (const current of ['unsigned', 'partial'] as const) {
    const port = restorePort({ current, 'replaced-1': 'signed' })

    await assert.rejects(
      restoreSpentCtfRangeRefund({
        currentPlan: 'current',
        replacedPlans: ['replaced-1', 'replaced-2'],
        restore: port.restore,
        isTransportFailure,
      }),
      CtfRangeRefundReplacedPlanSignedError,
    )
    // The replaced plans are read newest first, after the current plan.
    assert.deepEqual(port.requests, ['current', 'replaced-2', 'replaced-1'])
  }
})

test('an unsigned current plan without a complete replaced plan is unsigned', async () => {
  // A swap signs all of its outputs when it commits. The current plan has no
  // signature, and no replaced plan restores completely and exactly, so this
  // refund did not commit with any plan.
  for (const replaced of ['unsigned', 'partial'] as const) {
    const port = restorePort({
      current: 'unsigned',
      'replaced-1': replaced,
      'replaced-2': replaced,
    })

    assert.deepEqual(
      await restoreSpentCtfRangeRefund({
        currentPlan: 'current',
        replacedPlans: ['replaced-1', 'replaced-2'],
        restore: port.restore,
        isTransportFailure,
      }),
      { kind: 'unsigned' },
    )
    assert.deepEqual(port.requests, ['current', 'replaced-2', 'replaced-1'])
  }
})

test('an incomplete current plan continues reconciliation without refund proofs', async () => {
  for (const replaced of ['unsigned', 'partial'] as const) {
    const port = restorePort({ current: 'partial', 'replaced-1': replaced })
    assert.deepEqual(
      await restoreSpentCtfRangeRefund({
        currentPlan: 'current',
        replacedPlans: ['replaced-1'],
        restore: port.restore,
        isTransportFailure,
      }),
      { kind: 'incomplete' },
    )
    assert.deepEqual(port.requests, ['current', 'replaced-1'])
  }
})

test('an invalid current plan keeps its error', async () => {
  const port = restorePort({ current: 'invalid', 'replaced-1': 'partial' })
  await assert.rejects(
    restoreSpentCtfRangeRefund({
      currentPlan: 'current',
      replacedPlans: ['replaced-1'],
      restore: port.restore,
      isTransportFailure,
    }),
    /plan current is invalid/,
  )
})

test('a transport failure on any plan keeps the refund pending', async () => {
  // A restore that the mint did not answer proves nothing about which plan
  // it signed.
  for (const states of [
    { current: 'transport', 'replaced-1': 'signed' },
    { current: 'unsigned', 'replaced-1': 'transport' },
  ] as const) {
    const port = restorePort(states)

    await assert.rejects(
      restoreSpentCtfRangeRefund({
        currentPlan: 'current',
        replacedPlans: ['replaced-1'],
        restore: port.restore,
        isTransportFailure,
      }),
      TransportFailure,
    )
  }
})

test('the saved replaced plans are a bounded nonempty list when present', () => {
  assert.deepEqual(savedReplacedCtfRangeRefundOutputPlans({}), [])
  const plans = Array.from({ length: CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX }, (_, i) => i)
  assert.deepEqual(
    savedReplacedCtfRangeRefundOutputPlans({ replacedRefundOutputPlans: plans }),
    plans,
  )
  for (const invalid of [[], [...plans, 8], 'plan', null]) {
    assert.throws(
      () => savedReplacedCtfRangeRefundOutputPlans({ replacedRefundOutputPlans: invalid }),
      /replaced output plans are invalid/,
    )
  }
})
