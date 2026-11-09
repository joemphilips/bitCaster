import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX,
  CtfRangeRefundReplacedPlanSignedError,
  restoreSpentCtfRangeRefund,
  savedReplacedCtfRangeRefundOutputPlans,
} from '../src/ctfRangeRefundReplacedPlans.ts'

class TransportFailure extends Error {}

/** A restore port that signed only the named plans, and records each request. */
function restorePort(signed: ReadonlySet<string>, transport: ReadonlySet<string> = new Set()) {
  const requests: string[] = []
  return {
    requests,
    restore: async (plan: string) => {
      requests.push(plan)
      if (transport.has(plan)) throw new TransportFailure(`no answer for ${plan}`)
      if (!signed.has(plan)) throw new Error(`plan ${plan} is not signed`)
      return [`proof of ${plan}`]
    },
  }
}

const isTransportFailure = (error: unknown) => error instanceof TransportFailure

test('a spent refund restores its current plan without a replaced plan', async () => {
  const port = restorePort(new Set(['current', 'replaced-1']))

  const proofs = await restoreSpentCtfRangeRefund({
    currentPlan: 'current',
    replacedPlans: ['replaced-1'],
    restore: port.restore,
    isTransportFailure,
  })

  assert.deepEqual(proofs, ['proof of current'])
  assert.deepEqual(port.requests, ['current'])
})

test('a hit only on a replaced plan halts the refund and admits nothing', async () => {
  // Backlog "Refund restore from a replaced output plan": another client with
  // the same seed signed every counter of a replaced plan with the same
  // amounts. The refund inputs read SPENT, and the current plan has no
  // signature. The replaced-plan hit does not prove that this refund
  // committed with that plan.
  const port = restorePort(new Set(['replaced-1']))

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
})

test('a refund that no plan restores keeps the error of its current plan', async () => {
  const port = restorePort(new Set())

  await assert.rejects(
    restoreSpentCtfRangeRefund({
      currentPlan: 'current',
      replacedPlans: ['replaced-1'],
      restore: port.restore,
      isTransportFailure,
    }),
    /plan current is not signed/,
  )
})

test('a transport failure on any plan keeps the refund pending', async () => {
  // A restore that the mint did not answer proves nothing about which plan
  // it signed.
  for (const failed of ['current', 'replaced-1']) {
    const port = restorePort(new Set(['replaced-1']), new Set([failed]))

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
