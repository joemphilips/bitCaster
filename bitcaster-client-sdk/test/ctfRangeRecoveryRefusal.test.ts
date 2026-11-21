import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CTF_RANGE_RECOVERY_REFUSAL_LIMIT,
  countCtfRangeRecoveryRefusal,
  resumeCtfRangeRecoveryRefusalCount,
  type CtfRangeRecoveryRefusalCount,
  type CtfRangeRefusedRequest,
} from '../src/ctfRangeRecoveryRefusal.ts'

const SPENT = { code: 11001, detail: 'Token already spent' }

function refuse(
  previous: CtfRangeRecoveryRefusalCount | null,
  request: CtfRangeRefusedRequest | null,
  times: number,
  refusal = SPENT,
) {
  let current = previous
  let halted = false
  for (let index = 0; index < times; index += 1) {
    const next = countCtfRangeRecoveryRefusal(current, { request, ...refusal })
    current = next.refusal
    halted = next.halted
  }
  return { refusal: current!, halted }
}

test('identical refusals of one request halt the replay at the limit', () => {
  const below = refuse(null, 'source', CTF_RANGE_RECOVERY_REFUSAL_LIMIT - 1)
  assert.equal(below.halted, false)

  const reached = refuse(below.refusal, 'source', 1)
  assert.equal(reached.halted, true)
  assert.deepEqual(reached.refusal, {
    request: 'source',
    ...SPENT,
    count: CTF_RANGE_RECOVERY_REFUSAL_LIMIT,
  })
})

test('source refusals do not halt a later refund refusal with the same code', () => {
  // A recovery pass can restore the source and then meet a refused refund
  // in the same order journal revision.
  const sources = refuse(null, 'source', CTF_RANGE_RECOVERY_REFUSAL_LIMIT - 1)

  const refund = refuse(sources.refusal, 'refund', 1)
  assert.equal(refund.halted, false)
  assert.equal(refund.refusal.count, 1)

  const refunds = refuse(refund.refusal, 'refund', CTF_RANGE_RECOVERY_REFUSAL_LIMIT - 1)
  assert.equal(refunds.halted, true)
})

test('a refusal with another code of the same request starts a new count', () => {
  const pending = refuse(null, 'consolidation', CTF_RANGE_RECOVERY_REFUSAL_LIMIT - 1)

  const other = refuse(pending.refusal, 'consolidation', 1, { code: 12002, detail: 'inactive' })
  assert.equal(other.halted, false)
  assert.equal(other.refusal.count, 1)
})

test('a manual retry allows one more refusal before the replay halts again', () => {
  const halted = refuse(null, 'refund', CTF_RANGE_RECOVERY_REFUSAL_LIMIT + 2)
  assert.equal(halted.halted, true)

  const resumed = resumeCtfRangeRecoveryRefusalCount(halted.refusal)
  assert.equal(resumed.count, CTF_RANGE_RECOVERY_REFUSAL_LIMIT - 1)
  assert.equal(refuse(resumed, 'refund', 1).halted, true)
})
