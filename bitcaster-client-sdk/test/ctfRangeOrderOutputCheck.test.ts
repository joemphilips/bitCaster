import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Amount,
  OutputData,
  type CounterSource,
  type Proof,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import {
  CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX,
  CtfRangeOrderOutputCheckError,
  plannedCtfRangeOrderOutputs,
  prepareCheckedCtfRangeSourceOperation,
  reserveCheckedCtfRangeOrderPreparation,
  type CtfRangeOrderCounterStarts,
} from '../src/ctfRangeOrderOutputCheck.ts'
import { prepareCtfRangeSourceOperation } from '../src/ctfRangeSourceOperation.ts'
import type { DurableCustodyProofOperationInput } from '../src/durableCustodyProofOperation.ts'
import type { DurableSeedDerivedOutputPlan } from '../src/durableSeedDerivedOutputs.ts'
import {
  createCounterCtfRangePreparation,
  createCtfRangePreparationIntent,
  planCounterCtfRangePreparation,
  reconstructCtfRangePreparation,
} from '../src/ctfRangeOrderCounterPreparation.ts'
import type { PersistedCtfRangeOrderPreparationV2 } from '../src/ctfRangeOrderProtocol.ts'
import { deriveDurableCustodyScopeId, deriveDurableCustodyWalletId } from '../src/durableCustody.ts'
import {
  SEED_COUNTER_PROBE_BATCH_MAX,
  SEED_COUNTER_SCAN_COUNTERS_MAX,
  SEED_COUNTER_SKIP_AFTER_LAST_SIGNED,
  type SeedCounterRestoreClient,
  type SeedCounterSkip,
} from '../src/seedCounterGapScan.ts'
import { signedOwnerRangeFixture } from './support/signedOwnerRangeFixture.ts'

const SIDES = ['Buy', 'Sell'] as const
const OFFER_START = 40
const RECEIVE_START = 7

function order(side: 'Buy' | 'Sell') {
  const fixture = signedOwnerRangeFixture({ plain: false, side })
  const preparation = fixture.preparation as PersistedCtfRangeOrderPreparationV2
  const { intent } = createCtfRangePreparationIntent({
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(fixture.seed),
    }),
    request: preparation.request,
    feeConsentBytes: null,
    consolidateProofs: false,
  })
  const counts = planCounterCtfRangePreparation(preparation)
  const authorizationCount = (counts.offerCount - counts.changeCount) / 2
  return {
    seed: fixture.seed,
    preparation,
    intent,
    counts,
    authorizationCount,
    offerKeysetId: preparation.offerKeyset.id,
    receiveKeysetId: preparation.receiveKeyset.id,
  }
}

type Order = ReturnType<typeof order>

/** The NUT-13 blinded message of one seed counter, as a plain wallet output derives it. */
function plainOutput(seed: Uint8Array, keysetId: string, counter: number): string {
  return OutputData.createSingleDeterministicData(1, seed, counter, keysetId).blindedMessage.B_
}

/** The authorization outputs that a reservation at these starts sends in its source request. */
function authorizationOutputs(fixture: Order, starts: CtfRangeOrderCounterStarts): string[] {
  const receipt = createCounterCtfRangePreparation({
    preparation: fixture.preparation,
    intent: fixture.intent,
    seed: fixture.seed,
    offerCounterStart: starts.offer,
    receiveCounterStart: starts.receive,
  })
  return reconstructCtfRangePreparation(receipt, fixture.seed).authorizationOutputs.map(
    (output) => output.blindedMessage.B_,
  )
}

/** The pool manifest outputs (receive and change) that the settlement convert signs. */
function manifestOutputs(fixture: Order, starts: CtfRangeOrderCounterStarts): string[] {
  const receipt = createCounterCtfRangePreparation({
    preparation: fixture.preparation,
    intent: fixture.intent,
    seed: fixture.seed,
    offerCounterStart: starts.offer,
    receiveCounterStart: starts.receive,
  })
  return reconstructCtfRangePreparation(receipt, fixture.seed).manifest.serialized.map(
    ({ B_ }) => B_,
  )
}

/** A mint that already signed these blinded messages for another client of the seed. */
function signingMint(signed: Iterable<string>) {
  const signedOutputs = new Set(signed)
  const requests: SerializedBlindedMessage[][] = []
  const mint: SeedCounterRestoreClient = {
    restore: async ({ outputs }) => {
      requests.push(outputs)
      return { outputs: outputs.filter(({ B_ }) => signedOutputs.has(B_)) }
    },
  }
  return { mint, requests }
}

/** One local counter store. A reservation takes both ranges only at the checked starts. */
function counterStore(fixture: Order, initial: CtfRangeOrderCounterStarts) {
  const next = { offer: initial.offer, receive: initial.receive }
  const skips: SeedCounterSkip[] = []
  const reserved: CtfRangeOrderCounterStarts[] = []
  return {
    next,
    skips,
    reserved,
    readCounterStarts: async () => ({ ...next }),
    skipSignedCounters: async (skip: SeedCounterSkip) => {
      skips.push(skip)
      const range = skip.keysetId === fixture.offerKeysetId ? 'offer' : 'receive'
      next[range] = Math.max(next[range], skip.nextCounter)
    },
    reserve: async (checked: CtfRangeOrderCounterStarts) => {
      if (checked.offer !== next.offer || checked.receive !== next.receive) return null
      reserved.push(checked)
      next.offer += fixture.counts.offerCount
      next.receive += fixture.counts.receiveCount
      return { reservedAt: checked }
    },
  }
}

function check(
  fixture: Order,
  mint: SeedCounterRestoreClient,
  store: ReturnType<typeof counterStore>,
) {
  return reserveCheckedCtfRangeOrderPreparation({
    mint,
    seed: fixture.seed,
    preparation: fixture.preparation,
    intent: fixture.intent,
    readCounterStarts: store.readCounterStarts,
    skipSignedCounters: store.skipSignedCounters,
    reserve: store.reserve,
  })
}

const STARTS = { offer: OFFER_START, receive: RECEIVE_START }

for (const side of SIDES) {
  test(`a clean ${side} order sends every planned output in one restore request and reserves at the checked starts`, async () => {
    const fixture = order(side)
    const { mint, requests } = signingMint([])
    const store = counterStore(fixture, STARTS)

    assert.deepEqual(await check(fixture, mint, store), { reservedAt: STARTS })

    assert.equal(requests.length, 1)
    const sent = requests[0]!
    const expected = [
      ...Array.from({ length: fixture.counts.offerCount }, (_, index) =>
        plainOutput(fixture.seed, fixture.offerKeysetId, OFFER_START + index),
      ),
      ...Array.from({ length: fixture.counts.receiveCount }, (_, index) =>
        plainOutput(fixture.seed, fixture.receiveKeysetId, RECEIVE_START + index),
      ),
      ...authorizationOutputs(fixture, STARTS),
    ]
    assert.deepEqual(new Set(sent.map(({ B_ }) => B_)), new Set(expected))
    assert.equal(sent.length, expected.length)
    // The pool manifest outputs are the plain outputs at their counters.
    for (const blinded of manifestOutputs(fixture, STARTS)) {
      assert.ok(expected.includes(blinded), 'a manifest output was not checked')
    }
    // The request shows the mint no amount and only the two order keysets.
    assert.ok(sent.every(({ amount }) => amount.toBigInt() === 1n))
    assert.deepEqual(
      new Set(sent.map(({ id }) => id)),
      new Set([fixture.offerKeysetId, fixture.receiveKeysetId]),
    )
    assert.deepEqual(store.skips, [])
  })
}

/**
 * One output of each range that another client of the seed already signed,
 * and the counter that the skip must pass.
 */
const SIGNED_RANGE_CASES: ReadonlyArray<{
  readonly name: string
  readonly keyset: 'offer' | 'receive'
  readonly signed: (fixture: Order) => { readonly B_: string; readonly counter: number }
}> = [
  {
    name: 'the plain output at the nonce counter of an authorization',
    keyset: 'offer',
    signed: (fixture) => ({
      B_: plainOutput(fixture.seed, fixture.offerKeysetId, OFFER_START),
      counter: OFFER_START,
    }),
  },
  {
    name: 'the plain output at the blinding counter of the last authorization',
    keyset: 'offer',
    signed: (fixture) => {
      const counter = OFFER_START + 2 * fixture.authorizationCount - 1
      return { B_: plainOutput(fixture.seed, fixture.offerKeysetId, counter), counter }
    },
  },
  {
    name: 'an authorization output',
    keyset: 'offer',
    signed: (fixture) => ({
      B_: authorizationOutputs(fixture, STARTS)[0]!,
      // The first authorization takes its blinding factor from counter OFFER_START + 1.
      counter: OFFER_START + 1,
    }),
  },
  {
    name: 'a change output',
    keyset: 'offer',
    signed: (fixture) => {
      const counter = OFFER_START + fixture.counts.offerCount - 1
      return { B_: plainOutput(fixture.seed, fixture.offerKeysetId, counter), counter }
    },
  },
  {
    name: 'a receive output',
    keyset: 'receive',
    signed: (fixture) => {
      const counter = RECEIVE_START + fixture.counts.receiveCount - 1
      return { B_: plainOutput(fixture.seed, fixture.receiveKeysetId, counter), counter }
    },
  },
]

for (const side of SIDES) {
  for (const scenario of SIGNED_RANGE_CASES) {
    test(`a ${side} order with ${scenario.name} already signed advances past it before it reserves`, async () => {
      const fixture = order(side)
      const signed = scenario.signed(fixture)
      const { mint, requests } = signingMint([signed.B_])
      const store = counterStore(fixture, STARTS)

      const result = await check(fixture, mint, store)

      const keysetId = scenario.keyset === 'offer' ? fixture.offerKeysetId : fixture.receiveKeysetId
      const fromCounter = scenario.keyset === 'offer' ? OFFER_START : RECEIVE_START
      const nextCounter = signed.counter + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED
      assert.deepEqual(store.skips, [
        { keysetId, fromCounter, lastSignedCounter: signed.counter, nextCounter },
      ])
      const advanced = { ...STARTS, [scenario.keyset]: nextCounter }
      assert.deepEqual(result, { reservedAt: advanced })
      assert.deepEqual(store.reserved, [advanced])
      // The last request checks the rebuilt order at the new counters.
      const last = new Set(requests.at(-1)!.map(({ B_ }) => B_))
      assert.ok(last.has(plainOutput(fixture.seed, keysetId, nextCounter)))
      assert.equal(last.has(signed.B_), false)
      for (const blinded of authorizationOutputs(fixture, advanced)) assert.ok(last.has(blinded))
      assert.ok(requests.every((request) => request.length <= SEED_COUNTER_PROBE_BATCH_MAX))
    })
  }
}

test('a gap scan finds the last output that another client signed after the planned range', async () => {
  const fixture = order('Buy')
  // The other client signed a run that starts inside the receive range and
  // ends 50 counters after it.
  const lastSigned = RECEIVE_START + fixture.counts.receiveCount + 50
  const run = Array.from({ length: lastSigned - RECEIVE_START + 1 }, (_, index) =>
    plainOutput(fixture.seed, fixture.receiveKeysetId, RECEIVE_START + index),
  )
  const { mint } = signingMint(run)
  const store = counterStore(fixture, STARTS)

  await check(fixture, mint, store)

  assert.deepEqual(store.skips, [
    {
      keysetId: fixture.receiveKeysetId,
      fromCounter: RECEIVE_START,
      lastSignedCounter: lastSigned,
      nextCounter: lastSigned + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED,
    },
  ])
  // Receive counters 7 to 16 are the order range, and the run ends 50 later
  // at counter 67. The 150 counters 68 to 217 stay unused.
  assert.equal(store.skips[0]!.nextCounter, 218)
  assert.deepEqual(store.reserved, [
    { offer: OFFER_START, receive: lastSigned + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED },
  ])
})

test('signed outputs in both keysets advance both counters in one pass', async () => {
  const fixture = order('Sell')
  const { mint } = signingMint([
    plainOutput(fixture.seed, fixture.offerKeysetId, OFFER_START + 3),
    plainOutput(fixture.seed, fixture.receiveKeysetId, RECEIVE_START),
  ])
  const store = counterStore(fixture, STARTS)

  await check(fixture, mint, store)

  assert.deepEqual(
    store.skips.map(({ keysetId, nextCounter }) => [keysetId, nextCounter]).sort(),
    [
      [fixture.offerKeysetId, OFFER_START + 3 + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED],
      [fixture.receiveKeysetId, RECEIVE_START + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED],
    ].sort(),
  )
  assert.equal(store.reserved.length, 1)
})

test('a counter that moves after the check is checked again at its new start', async () => {
  const fixture = order('Buy')
  const { mint, requests } = signingMint([])
  const store = counterStore(fixture, STARTS)
  let moved = false
  const result = await reserveCheckedCtfRangeOrderPreparation({
    mint,
    seed: fixture.seed,
    preparation: fixture.preparation,
    intent: fixture.intent,
    readCounterStarts: store.readCounterStarts,
    skipSignedCounters: store.skipSignedCounters,
    reserve: async (checked) => {
      if (!moved) {
        // Another operation of this wallet reserved receive counters after the check.
        moved = true
        store.next.receive += 5
      }
      return store.reserve(checked)
    },
  })

  assert.deepEqual(result, { reservedAt: { offer: OFFER_START, receive: RECEIVE_START + 5 } })
  assert.equal(requests.length, 2)
  assert.ok(
    requests[1]!.some(
      ({ B_ }) => B_ === plainOutput(fixture.seed, fixture.receiveKeysetId, RECEIVE_START + 5),
    ),
  )
})

const MINT_FAILURES: ReadonlyArray<{
  readonly name: string
  readonly restore: SeedCounterRestoreClient['restore']
}> = [
  {
    name: 'an unreachable mint',
    restore: async () => {
      throw new TypeError('fetch failed')
    },
  },
  {
    name: 'a mint error answer',
    restore: async () => {
      throw Object.assign(new Error('Rate limit exceeded'), { code: 429 })
    },
  },
  {
    name: 'a response without outputs',
    restore: async () => ({}) as never,
  },
  {
    name: 'a response that names an output the request did not hold',
    restore: async () => ({ outputs: [{ B_: '02'.padEnd(66, '1') }] }),
  },
]

for (const failure of MINT_FAILURES) {
  test(`${failure.name} refuses the order before it reserves`, async () => {
    const fixture = order('Buy')
    const store = counterStore(fixture, STARTS)

    await assert.rejects(
      check(fixture, { restore: failure.restore }, store),
      (error: unknown) =>
        error instanceof CtfRangeOrderOutputCheckError &&
        error.reason === 'mint-check-failed' &&
        error.message ===
          "The wallet could not check this order's outputs with the mint. No order was submitted.",
    )
    assert.deepEqual(store.reserved, [])
    assert.deepEqual(store.skips, [])
  })
}

test('a mint that reports every output as signed stops after bounded attempts', async () => {
  const fixture = order('Buy')
  let requests = 0
  const mint: SeedCounterRestoreClient = {
    restore: async ({ outputs }) => {
      requests += 1
      return { outputs }
    },
  }
  const store = counterStore(fixture, STARTS)

  await assert.rejects(
    check(fixture, mint, store),
    (error: unknown) =>
      error instanceof CtfRangeOrderOutputCheckError && error.reason === 'attempts-exhausted',
  )

  assert.deepEqual(store.reserved, [])
  assert.equal(store.skips.length, 2 * CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX)
  // Each attempt sends one check request and one bounded gap scan for each keyset.
  const scanRequests = SEED_COUNTER_SCAN_COUNTERS_MAX / SEED_COUNTER_PROBE_BATCH_MAX
  assert.equal(requests, CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX * (1 + 2 * scanRequests))
})

test('a storage failure of the reservation keeps its own error', async () => {
  const fixture = order('Buy')
  const { mint } = signingMint([])
  const refused = new Error('wallet counter recovery is incomplete')

  await assert.rejects(
    reserveCheckedCtfRangeOrderPreparation({
      mint,
      seed: fixture.seed,
      preparation: fixture.preparation,
      intent: fixture.intent,
      readCounterStarts: async () => STARTS,
      skipSignedCounters: async () => undefined,
      reserve: async () => {
        throw refused
      },
    }),
    (error: unknown) => error === refused,
  )
})

test('a mint failure in the gap scan after a hit refuses the order before it reserves', async () => {
  const fixture = order('Buy')
  const signed = plainOutput(fixture.seed, fixture.receiveKeysetId, RECEIVE_START)
  let requests = 0
  const mint: SeedCounterRestoreClient = {
    restore: async ({ outputs }) => {
      requests += 1
      // The first request is the order check. The gap scan that follows fails.
      if (requests > 1) throw new TypeError('fetch failed')
      return { outputs: outputs.filter(({ B_ }) => B_ === signed) }
    },
  }
  const store = counterStore(fixture, STARTS)

  await assert.rejects(
    check(fixture, mint, store),
    (error: unknown) =>
      error instanceof CtfRangeOrderOutputCheckError && error.reason === 'mint-check-failed',
  )
  assert.equal(requests, 2)
  assert.deepEqual(store.skips, [])
  assert.deepEqual(store.reserved, [])
})

test('a manifest output that is not the plain output at its counter refuses the check', () => {
  const fixture = order('Buy')
  const prepared = reconstructCtfRangePreparation(
    createCounterCtfRangePreparation({
      preparation: fixture.preparation,
      intent: fixture.intent,
      seed: fixture.seed,
      offerCounterStart: OFFER_START,
      receiveCounterStart: RECEIVE_START,
    }),
    fixture.seed,
  )
  const input = {
    seed: fixture.seed,
    prepared,
    starts: STARTS,
    offerCount: fixture.counts.offerCount,
    receiveCount: fixture.counts.receiveCount,
  }
  assert.equal(
    plannedCtfRangeOrderOutputs(input).length,
    fixture.counts.offerCount + fixture.counts.receiveCount + fixture.authorizationCount,
  )
  const [first, ...rest] = prepared.manifest.serialized
  // A manifest output from a counter outside the order ranges.
  const foreign = { ...first!, B_: plainOutput(fixture.seed, fixture.receiveKeysetId, 999) }

  assert.throws(
    () =>
      plannedCtfRangeOrderOutputs({
        ...input,
        prepared: {
          ...prepared,
          manifest: { ...prepared.manifest, serialized: [foreign, ...rest] },
        },
      }),
    /manifest outputs differ from their counters/,
  )
})

/** The offer keyset counter after the fixture order range [23, 29). */
const KEEP_START = 29

function keepPlan(
  operation: DurableCustodyProofOperationInput,
): DurableSeedDerivedOutputPlan | null {
  return operation.metadata?.keepPlan as DurableSeedDerivedOutputPlan | null
}

/**
 * A Buy whose reserved order range ends at counter 29 of the offer keyset.
 * `prepare` builds the exact source request at the current counter, as a
 * coordinator does from a fresh counter snapshot. It sends nothing.
 */
function sourceFixture(sourceAmount = 16) {
  const fixture = signedOwnerRangeFixture({ side: 'Buy' })
  const offerKeysetId = fixture.preparation.offerKeyset.id
  const store = { next: KEEP_START }
  const prepared: DurableCustodyProofOperationInput[] = []
  const skips: SeedCounterSkip[] = []
  const candidate: Proof = {
    id: offerKeysetId,
    amount: Amount.from(sourceAmount),
    secret: 'source-proof',
    C: '02'.padEnd(66, '1'),
  }
  const prepare = async () => {
    let next = store.next
    const counterSource: CounterSource = {
      reserve: async (_keysetId, count) => {
        const range = { start: next, count }
        next += count
        return range
      },
      advanceToAtLeast: async () => {
        throw new Error('the source check must not advance a speculative counter')
      },
    }
    const operation = await prepareCtfRangeSourceOperation({
      preparation: fixture.preparation,
      seed: fixture.seed,
      counterSource,
      candidates: [candidate],
      wallet: {
        prepareSwapToSend: async (amount, proofs, config, outputs) => ({
          amount: Amount.from(amount),
          fees: Amount.from(1),
          keysetId: config.keysetId,
          inputs: proofs,
          sendOutputs: outputs.send.data,
          keepOutputs: outputs.keep.data,
          unselectedProofs: [],
        }),
        completeSwap: async () => ({ keep: [], send: [] }),
        prepareConditionalSwap: async () => {
          throw new Error('unexpected conditional source')
        },
        completeConditionalSwap: async () => ({}),
      },
    })
    if (operation === null) throw new Error('the source fixture is underfunded')
    prepared.push(operation)
    return { operation }
  }
  const checkSource = (mint: SeedCounterRestoreClient) =>
    prepareCheckedCtfRangeSourceOperation({
      mint,
      seed: fixture.seed,
      prepare,
      skipSignedCounters: async (skip) => {
        skips.push(skip)
        // The caller moves its durable counter; the next `prepare` reads it.
        store.next = Math.max(store.next, skip.nextCounter)
      },
    })
  return { fixture, offerKeysetId, prepared, skips, checkSource }
}

test('a clean source request sends its keep outputs in one restore request', async () => {
  const source = sourceFixture()
  const { mint, requests } = signingMint([])

  const { operation } = await source.checkSource(mint)

  const plan = keepPlan(operation)!
  assert.equal(plan.counterStart, KEEP_START)
  assert.equal(source.prepared.length, 1)
  assert.equal(requests.length, 1)
  assert.deepEqual(
    requests[0]!.map(({ B_ }) => B_),
    Array.from({ length: plan.counterCount }, (_, index) =>
      plainOutput(source.fixture.seed, source.offerKeysetId, KEEP_START + index),
    ),
  )
  assert.ok(requests[0]!.every(({ amount }) => amount.toBigInt() === 1n))
  assert.deepEqual(source.skips, [])
})

test('a keep output that another client signed is skipped and the source request is rebuilt', async () => {
  const source = sourceFixture()
  const signed = plainOutput(source.fixture.seed, source.offerKeysetId, KEEP_START)
  const { mint, requests } = signingMint([signed])

  const { operation } = await source.checkSource(mint)

  // Counter 29 is signed; the 150 counters 30 to 179 stay unused.
  assert.deepEqual(source.skips, [
    { keysetId: source.offerKeysetId, fromCounter: 29, lastSignedCounter: 29, nextCounter: 180 },
  ])
  assert.equal(source.prepared.length, 2)
  assert.equal(keepPlan(operation)!.counterStart, 180)
  assert.equal(
    operation.outputs.keep!.some(({ blindedMessage }) => blindedMessage.B_ === signed),
    false,
  )
  const last = requests.at(-1)!.map(({ B_ }) => B_)
  assert.ok(last.includes(plainOutput(source.fixture.seed, source.offerKeysetId, 180)))
  assert.equal(last.includes(signed), false)
})

test('a signed run after the order range is scanned to its end before the rebuild', async () => {
  const source = sourceFixture()
  const run = Array.from({ length: 20 }, (_, index) =>
    plainOutput(source.fixture.seed, source.offerKeysetId, KEEP_START + index),
  )
  const { mint } = signingMint(run)

  const { operation } = await source.checkSource(mint)

  assert.deepEqual(source.skips, [
    { keysetId: source.offerKeysetId, fromCounter: 29, lastSignedCounter: 48, nextCounter: 199 },
  ])
  assert.equal(keepPlan(operation)!.counterStart, 199)
})

test('a source request without seed-derived outputs sends no restore request', async () => {
  const exact = signedOwnerRangeFixture({ side: 'Buy' })
  const target = reconstructCtfRangePreparation(exact.preparation, exact.seed)
    .authorizationOutputs.map(({ blindedMessage }) => Number(blindedMessage.amount.toBigInt()))
    .reduce((sum, amount) => sum + amount, 0)
  // The input pays the authorization and a fee of 1, so the request keeps no change.
  const source = sourceFixture(target + 1)
  const { mint, requests } = signingMint([])

  const { operation } = await source.checkSource(mint)

  assert.equal(keepPlan(operation), null)
  assert.equal(requests.length, 0)
})

for (const failure of MINT_FAILURES) {
  test(`${failure.name} refuses the source request before it is sent`, async () => {
    const source = sourceFixture()

    await assert.rejects(
      source.checkSource({ restore: failure.restore }),
      (error: unknown) =>
        error instanceof CtfRangeOrderOutputCheckError && error.reason === 'mint-check-failed',
    )
    assert.equal(source.prepared.length, 1)
    assert.deepEqual(source.skips, [])
  })
}

test('a mint failure in the gap scan after a source hit refuses the source request', async () => {
  const source = sourceFixture()
  const signed = plainOutput(source.fixture.seed, source.offerKeysetId, KEEP_START)
  let requests = 0
  const mint: SeedCounterRestoreClient = {
    restore: async ({ outputs }) => {
      requests += 1
      if (requests > 1) throw new TypeError('fetch failed')
      return { outputs: outputs.filter(({ B_ }) => B_ === signed) }
    },
  }

  await assert.rejects(
    source.checkSource(mint),
    (error: unknown) =>
      error instanceof CtfRangeOrderOutputCheckError && error.reason === 'mint-check-failed',
  )
  assert.deepEqual(source.skips, [])
})

test('source outputs that stay signed stop after bounded attempts', async () => {
  const source = sourceFixture()
  const mint: SeedCounterRestoreClient = { restore: async ({ outputs }) => ({ outputs }) }

  await assert.rejects(
    source.checkSource(mint),
    (error: unknown) =>
      error instanceof CtfRangeOrderOutputCheckError && error.reason === 'attempts-exhausted',
  )
  assert.equal(source.prepared.length, CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX)
  assert.equal(source.skips.length, CTF_RANGE_ORDER_OUTPUT_CHECK_ATTEMPTS_MAX)
})
