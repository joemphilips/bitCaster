import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  InsufficientParticipationScoreBackingError,
  planDaemonParticipationScoreTopUp,
} from '../src/participationScoreTopUp.ts'

function fixture(input: { availableMsat: number; quoteFails?: boolean; resumes?: boolean }) {
  const calls = { reads: 0, quotedMsat: [] as number[] }
  return {
    calls,
    resumesDelivery: async () => input.resumes === true,
    readAvailableMsat: async () => {
      calls.reads += 1
      return input.availableMsat
    },
    quoteSend: async (amountMsat: number) => {
      calls.quotedMsat.push(amountMsat)
      if (input.quoteFails === true) throw new Error('Not enough funds available for swap')
    },
  }
}

test('daemon Score top-up reads no balance when Score is disabled or sufficient', async () => {
  const io = fixture({ availableMsat: 900_000 })

  assert.deepEqual(
    await planDaemonParticipationScoreTopUp({
      score: { enabled: false, balance: -10 },
      requiredScore: 7,
      ...io,
    }),
    { kind: 'disabled' },
  )
  assert.deepEqual(
    await planDaemonParticipationScoreTopUp({
      score: { enabled: true, balance: 7 },
      requiredScore: 7,
      ...io,
    }),
    { kind: 'sufficient', requiredScore: 7 },
  )
  assert.deepEqual(io.calls, { reads: 0, quotedMsat: [] })
})

test('daemon Score top-up buys the 50 Score buffer when the wallet can pay it', async () => {
  const io = fixture({ availableMsat: 900_000 })

  const plan = await planDaemonParticipationScoreTopUp({
    score: { enabled: true, balance: -1 },
    requiredScore: 1,
    ...io,
  })

  assert.deepEqual(plan, {
    kind: 'needs-top-up',
    requiredScore: 1,
    deficitScore: 2,
    topUpScore: 50,
  })
  assert.deepEqual(io.calls, { reads: 1, quotedMsat: [50_000] })
})

test('daemon Score top-up buys only the whole sats that remain below the buffer', async () => {
  const io = fixture({ availableMsat: 8_999 })

  const plan = await planDaemonParticipationScoreTopUp({
    score: { enabled: true, balance: -1 },
    requiredScore: 1,
    ...io,
  })

  assert.equal(plan.kind === 'needs-top-up' ? plan.topUpScore : null, 8)
  assert.deepEqual(io.calls.quotedMsat, [8_000])
})

test('daemon Score top-up buys the exact shortfall when the buffered send does not fit', async () => {
  const io = fixture({ availableMsat: 50_000, quoteFails: true })

  const plan = await planDaemonParticipationScoreTopUp({
    score: { enabled: true, balance: -1 },
    requiredScore: 1,
    ...io,
  })

  assert.deepEqual(plan, {
    kind: 'needs-top-up',
    requiredScore: 1,
    deficitScore: 2,
    topUpScore: 2,
  })
  assert.deepEqual(io.calls.quotedMsat, [50_000])
})

test('daemon Score top-up does not quote a shortfall that already exceeds the buffer', async () => {
  const io = fixture({ availableMsat: 900_000 })

  const plan = await planDaemonParticipationScoreTopUp({
    score: { enabled: true, balance: -690 },
    requiredScore: 10,
    ...io,
  })

  assert.equal(plan.kind === 'needs-top-up' ? plan.topUpScore : null, 700)
  assert.deepEqual(io.calls, { reads: 1, quotedMsat: [] })
})

test('daemon Score top-up reports the shortfall, not the buffer, when backing is insufficient', async () => {
  const io = fixture({ availableMsat: 1_500 })

  await assert.rejects(
    planDaemonParticipationScoreTopUp({
      score: { enabled: true, balance: -1 },
      requiredScore: 1,
      ...io,
    }),
    (error: unknown) =>
      error instanceof InsufficientParticipationScoreBackingError &&
      error.message === 'insufficient Participation Score backing: have 1500 msat, need 2000 msat',
  )
  assert.deepEqual(io.calls.quotedMsat, [])
})

test('daemon Score top-up resumes an active delivery without a new backing check', async () => {
  const io = fixture({ availableMsat: 0, resumes: true })

  const plan = await planDaemonParticipationScoreTopUp({
    score: { enabled: true, balance: -1 },
    requiredScore: 1,
    ...io,
  })

  assert.deepEqual(plan, {
    kind: 'needs-top-up',
    requiredScore: 1,
    deficitScore: 2,
    topUpScore: 2,
  })
  assert.deepEqual(io.calls, { reads: 0, quotedMsat: [] })
})
