import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KeyChain,
  selectProofsRGLI,
  selectProofsRotating,
  type ProofLike,
  type SendResponse,
} from '@cashu/cashu-ts'
import { NEW_WALLET_OPERATION_INPUT_LIMIT } from '../src/walletOperationSize.ts'
import { selectWalletProofs } from '../src/walletProofSelection.ts'

const MINT_URL = 'https://mint.example'
const ACTIVE = `01${'a'.repeat(64)}`
const INACTIVE = `01${'b'.repeat(64)}`
const OLD_VERSION = `00${'c'.repeat(14)}`
const FOREIGN = `01${'d'.repeat(64)}`

test('the selection depends on the proofs and not on their order or the attempt', () => {
  const random = generator(11)
  const chain = keyChain({ [ACTIVE]: 1_000, [INACTIVE]: 300 }, [INACTIVE])
  for (let round = 0; round < 60; round += 1) {
    const proofs = [
      ...wallet(random, ACTIVE, 40, 12),
      ...wallet(random, INACTIVE, round % 12, 12, 'i'),
    ]
    const target = 1 + Math.floor(random() * 4_000)
    const expected = secretsOf(selectWalletProofs(proofs, target, chain, true))
    assert.ok(expected.length > 0)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = selectWalletProofs(shuffle(random, proofs), target, chain, true)
      assert.deepEqual(secretsOf(result), expected)
    }
  }
})

test('a wallet that can pay is never refused, and the input count stays near random selection', () => {
  const random = generator(23)
  let inputs = 0
  let randomInputs = 0
  for (const includeFees of [true, false]) {
    for (const ppk of [0, 1, 100, 500, 999, 1_000, 1_500, 2_500]) {
      const chain = keyChain({ [ACTIVE]: ppk })
      for (let round = 0; round < 150; round += 1) {
        // Arbitrary amounts and power-of-two amounts, from nearly empty to full use of the wallet.
        const proofs =
          round % 3 === 0
            ? arbitraryWallet(random, ACTIVE, 1 + (round % 30))
            : wallet(random, ACTIVE, 1 + (round % 70), 13)
        const capacity = payable(proofs, ppk, includeFees)
        const target =
          round % 4 === 0
            ? Math.max(1, capacity - (round % 3))
            : 1 + Math.floor(random() * capacity)
        const result = selectWalletProofs(proofs, target, chain, includeFees)
        const reference = selectProofsRGLI(proofs, target, chain, includeFees)
        assertPartition(result, proofs)
        assert.equal(
          result.send.length > 0,
          capacity >= target,
          `payable wallet refused: target ${target}, payable ${capacity}, ppk ${ppk}`,
        )
        if (result.send.length === 0) continue
        assert.ok(netOf(result.send, ppk, includeFees) >= target)
        // No selected proof is redundant.
        for (const proof of result.send) {
          const others = result.send.filter((other) => other !== proof)
          assert.ok(netOf(others, ppk, includeFees) < target)
        }
        inputs += result.send.length
        randomInputs += reference.send.length
      }
    }
  }
  assert.ok(inputs <= 1.1 * randomInputs, `${inputs} inputs, random selection used ${randomInputs}`)
})

test('a wallet of many small receipts keeps its payments and holdings bounded', () => {
  for (const seed of [1, 2]) {
    const random = generator(seed)
    const chain = keyChain({ [ACTIVE]: 1_000 })
    let held: ProofLike[] = []
    let created = 0
    const receive = (amount: number) => {
      for (let power = 0; 2 ** power <= amount; power += 1)
        if (Math.floor(amount / 2 ** power) % 2 === 1)
          held.push(proof(ACTIVE, 2 ** power, `${seed}:${created++}`))
    }
    receive(1_000_000)
    let maxInputs = 0
    let maxHeld = 0
    let payments = 0
    for (let round = 0; round < 1_000; round += 1) {
      receive(1 + Math.floor(random() * 3_000))
      maxHeld = Math.max(maxHeld, held.length)
      if (round % 10 !== 0) continue
      const target = 1 + Math.floor(random() * 30_000)
      const result = selectWalletProofs(held, target, chain, true)
      assert.ok(result.send.length > 0)
      payments += 1
      maxInputs = Math.max(maxInputs, result.send.length)
      held = [...result.keep]
      receive(netOf(result.send, 1_000, true) - target)
    }
    assert.equal(payments, 100)
    assert.ok(maxInputs <= NEW_WALLET_OPERATION_INPUT_LIMIT, `${maxInputs} inputs`)
    // The random cashu-ts selection holds at most about 1100 proofs here.
    assert.ok(maxHeld <= 1_500, `${maxHeld} held proofs`)
  }
})

test('a payment that fits the input limit is selected within it', () => {
  const chain = keyChain({ [ACTIVE]: 1_000, [OLD_VERSION]: 0 }, [OLD_VERSION])
  const many = [
    ...Array.from({ length: 1_000 }, (_, index) => proof(ACTIVE, 3, `small${index}`)),
    ...Array.from({ length: 20 }, (_, index) => proof(ACTIVE, 65, `large${index}`)),
  ]
  // The net values are 2 and 64, so a close match has several hundred inputs.
  const result = selectWalletProofs(many, 1_200, chain, true)
  assertPartition(result, many)
  assert.ok(result.send.length <= NEW_WALLET_OPERATION_INPUT_LIMIT)
  assert.ok(netOf(result.send, 1_000, true) >= 1_200)
  const reversed = selectWalletProofs([...many].reverse(), 1_200, chain, true)
  assert.deepEqual(secretsOf(reversed), secretsOf(result))

  // The forced stale proofs count against the limit and stay selected.
  const stale = Array.from({ length: 100 }, (_, index) => proof(OLD_VERSION, 1, `stale${index}`))
  const rotated = selectWalletProofs([...many, ...stale], 1_300, chain, true)
  assert.ok(rotated.send.length <= NEW_WALLET_OPERATION_INPUT_LIMIT)
  assert.equal(rotated.send.filter(({ id }) => id === OLD_VERSION).length, 100)
})

test('a payment at the input limit uses the closest match, and above it a set within it', () => {
  const chain = keyChain({ [ACTIVE]: 1_000 })
  const limit = NEW_WALLET_OPERATION_INPUT_LIMIT
  // The net value of each small proof is 1, so a close match has as many inputs as the amount.
  const small = Array.from({ length: limit + 1 }, (_, index) => proof(ACTIVE, 2, `s${index}`))
  const large = Array.from({ length: 2 }, (_, index) => proof(ACTIVE, 65, `l${index}`))
  for (const target of [limit - 1, limit, limit + 1]) {
    // Only small proofs: the one possible set is found, and the caller checks its size.
    assert.equal(selectWalletProofs(small, target, chain, true).send.length, target)
    const mixed = selectWalletProofs([...small, ...large], target, chain, true)
    assert.ok(mixed.send.length <= limit, `${mixed.send.length} inputs for ${target}`)
    assert.ok(netOf(mixed.send, 1_000, true) >= target)
  }
})

test('a fitting set is found whenever one exists', () => {
  const random = generator(61)
  const chain = keyChain({ [ACTIVE]: 1_000 })
  let fallbacks = 0
  for (let round = 0; round < 150; round += 1) {
    const proofs = [
      ...wallet(random, ACTIVE, 300, 3),
      ...wallet(random, ACTIVE, round % 40, 10, 'l'),
    ]
    const target = 1 + Math.floor(random() * 900)
    const byNet = proofs.map(({ amount }) => Number(String(amount)) - 1).sort((a, b) => b - a)
    let covered = 0
    const fewest = byNet.findIndex((net) => (covered += net) >= target) + 1
    const { send } = selectWalletProofs(proofs, target, chain, true)
    if (fewest === 0) assert.equal(send.length, 0)
    else if (fewest <= NEW_WALLET_OPERATION_INPUT_LIMIT)
      assert.ok(send.length > 0 && send.length <= NEW_WALLET_OPERATION_INPUT_LIMIT)
    else assert.equal(send.length, fewest)
    if (send.length === fewest) fallbacks += 1
  }
  assert.ok(fallbacks > 0)
})

test('stale keysets that alone exceed the input limit stay selected, as in cashu-ts', () => {
  const chain = keyChain({ [ACTIVE]: 0, [INACTIVE]: 0 }, [INACTIVE])
  const proofs = [
    ...Array.from({ length: 300 }, (_, index) => proof(INACTIVE, 2, `stale${index}`)),
    proof(ACTIVE, 1_024, 'fresh'),
  ]
  for (const [target, inputs] of [
    [700, 301],
    [520, 260],
  ] as const) {
    assert.equal(selectProofsRotating(proofs, target, chain, true).send.length, inputs)
    assert.equal(selectWalletProofs(proofs, target, chain, true).send.length, inputs)
  }
})

test('an amount equal to the whole net balance selects every proof that pays more than its fee', () => {
  const chain = keyChain({ [ACTIVE]: 1_000 })
  const proofs = [1, 1, 2, 4, 8, 64].map((amount, index) => proof(ACTIVE, amount, `p${index}`))
  const result = selectWalletProofs(proofs, 74, chain, true)
  assert.deepEqual(amountsOf(result.send), [2, 4, 8, 64])
  assert.deepEqual(amountsOf(result.keep), [1, 1])
  assert.equal(selectWalletProofs(proofs, 75, chain, true).send.length, 0)
})

test('the fee of a selection rounds up once', () => {
  const chain = keyChain({ [ACTIVE]: 100 })
  const proofs = Array.from({ length: 10 }, (_, index) => proof(ACTIVE, 2, `p${index}`))
  assert.equal(selectWalletProofs(proofs, 19, chain, true).send.length, 10)
  assert.equal(selectWalletProofs(proofs, 20, chain, true).send.length, 0)
  assert.equal(selectWalletProofs(proofs, 20, chain, false).send.length, 10)
})

test('one larger proof replaces a set that leaves more surplus', () => {
  const chain = keyChain({ [ACTIVE]: 1_000 })
  const proofs = [32, 16, 16].map((amount, index) => proof(ACTIVE, amount, `p${index}`))
  assert.deepEqual(amountsOf(selectWalletProofs(proofs, 20, chain, true).send), [32])
})

test('stale keysets are spent first, as in the cashu-ts default selection', () => {
  const random = generator(31)
  const fees = { [ACTIVE]: 1_000, [INACTIVE]: 250, [OLD_VERSION]: 700 }
  const chain = keyChain(fees, [INACTIVE, OLD_VERSION])
  for (let round = 0; round < 200; round += 1) {
    const stale = [
      ...wallet(random, OLD_VERSION, round % 6, 8, 'o'),
      ...wallet(random, INACTIVE, round % 9, 8, 'i'),
    ]
    const proofs = [...wallet(random, ACTIVE, 30, 12), ...stale]
    const target = 1 + Math.floor(random() * 3_000)
    const result = selectWalletProofs(proofs, target, chain, true)
    const reference = selectProofsRotating(proofs, target, chain, true)
    assertPartition(result, proofs)
    assert.equal(result.send.length > 0, reference.send.length > 0)
    const oldAvailable = proofs.filter(({ id }) => id === OLD_VERSION)
    const sent = new Set(secretsOf(result))
    // A keyset is a source only when every staler keyset is spent completely.
    if (result.send.some(({ id }) => id !== OLD_VERSION))
      assert.ok(oldAvailable.every(({ secret }) => sent.has(secret)))
    if (result.send.some(({ id }) => id === ACTIVE))
      assert.ok(stale.every(({ secret }) => sent.has(secret)))
    assert.ok(mixedNetOf(result.send, fees) >= BigInt(target))
  }
})

test('stale proofs that cannot pay their own fee do not refuse a payable amount', () => {
  const chain = keyChain({ [ACTIVE]: 0, [INACTIVE]: 4_000 }, [INACTIVE])
  const proofs = [
    proof(INACTIVE, 1, 'dust-1'),
    proof(INACTIVE, 1, 'dust-2'),
    proof(ACTIVE, 8, 'fresh'),
  ]
  assert.deepEqual(secretsOf(selectWalletProofs(proofs, 8, chain, true)), ['fresh'])
  assert.deepEqual(secretsOf(selectWalletProofs(proofs, 2, chain, true)), [
    'dust-1',
    'dust-2',
    'fresh',
  ])
})

test('an exact match keeps the cashu-ts selection rules', () => {
  const chain = keyChain({ [ACTIVE]: 0 })
  const proofs = [8, 4, 2].map((amount, index) => proof(ACTIVE, amount, `p${index}`))
  assert.deepEqual(amountsOf(selectWalletProofs(proofs, 6, chain, false, true).send), [2, 4])
  assert.equal(selectWalletProofs(proofs, 5, chain, false, true).send.length, 0)
  assert.deepEqual(amountsOf(selectWalletProofs(proofs, 5, chain, false).send), [2, 4])
})

test('zero and insufficient amounts select nothing', () => {
  const chain = keyChain({ [ACTIVE]: 0, [INACTIVE]: 0 }, [INACTIVE])
  const proofs = [proof(ACTIVE, 4, 'a'), proof(INACTIVE, 4, 'b')]
  for (const target of [0, 9]) {
    const result = selectWalletProofs(proofs, target, chain, true)
    assert.equal(result.send.length, 0)
    assert.equal(result.keep.length, 2)
  }
})

test('a duplicate, unknown, or foreign-unit proof is refused without its secret', () => {
  const chain = keyChain({ [ACTIVE]: 0 })
  const held = proof(ACTIVE, 4, 'private-secret-marker')
  for (const proofs of [
    [held, held],
    [proof(`01${'e'.repeat(64)}`, 4, 'private-secret-marker')],
    [proof(FOREIGN, 4, 'private-secret-marker')],
  ]) {
    assert.throws(
      () => selectWalletProofs(proofs, 1, chain, true),
      (error: Error) => !`${error.message}${error.stack}`.includes('private-secret-marker'),
    )
  }
})

test('a wallet of one thousand proofs is selected in bounded time', { timeout: 10_000 }, () => {
  const random = generator(47)
  const chain = keyChain({ [ACTIVE]: 1_000 })
  const proofs = wallet(random, ACTIVE, 1_000, 16)
  const capacity = payable(proofs, 1_000, true)
  for (const target of [1, 999, Math.floor(capacity / 2), capacity]) {
    const result = selectWalletProofs(proofs, target, chain, true)
    assert.ok(netOf(result.send, 1_000, true) >= target)
  }
})

function keyChain(
  fees: Readonly<Record<string, number>>,
  inactive: readonly string[] = [],
): KeyChain {
  return KeyChain.fromCache(MINT_URL, 'msat', {
    mintUrl: MINT_URL,
    savedAt: 0,
    keysets: [
      ...Object.entries(fees).map(([id, fee]) => ({
        id,
        unit: 'msat',
        active: !inactive.includes(id),
        input_fee_ppk: fee,
      })),
      { id: FOREIGN, unit: 'usd', active: true, input_fee_ppk: 0 },
    ],
  })
}

function proof(id: string, amount: number, secret: string): ProofLike {
  return { id, amount, secret, C: '02'.repeat(33) }
}

function wallet(
  random: () => number,
  id: string,
  count: number,
  powers: number,
  prefix = 'p',
): ProofLike[] {
  return Array.from({ length: count }, (_, index) =>
    proof(id, 2 ** Math.floor(random() * powers), `${prefix}${index}`),
  )
}

function arbitraryWallet(random: () => number, id: string, count: number): ProofLike[] {
  return Array.from({ length: count }, (_, index) =>
    proof(id, 1 + Math.floor(random() * 5_000), `p${index}`),
  )
}

/** The largest amount that the proofs that pay more than their own fee can send. */
function payable(proofs: readonly ProofLike[], ppk: number, includeFees: boolean): number {
  const useful = proofs.filter(
    ({ amount }) => !includeFees || 1_000n * BigInt(String(amount)) > BigInt(ppk),
  )
  return Math.max(0, netOf(useful, ppk, includeFees))
}

function netOf(proofs: readonly ProofLike[], ppk: number, includeFees: boolean): number {
  const gross = proofs.reduce((total, { amount }) => total + Number(String(amount)), 0)
  return gross - (includeFees ? Math.ceil((proofs.length * ppk) / 1_000) : 0)
}

function mixedNetOf(proofs: readonly ProofLike[], fees: Readonly<Record<string, number>>): bigint {
  const gross = proofs.reduce((total, { amount }) => total + BigInt(String(amount)), 0n)
  const ppk = proofs.reduce((total, { id }) => total + fees[id]!, 0)
  return gross - BigInt(Math.ceil(ppk / 1_000))
}

function assertPartition(result: SendResponse, proofs: readonly ProofLike[]): void {
  assert.deepEqual(
    [...result.keep, ...result.send].map(({ secret }) => secret).sort(),
    proofs.map(({ secret }) => secret).sort(),
  )
}

function secretsOf(result: SendResponse): string[] {
  return result.send.map(({ secret }) => secret).sort()
}

function amountsOf(proofs: readonly ProofLike[]): number[] {
  return proofs.map(({ amount }) => Number(String(amount))).sort((a, b) => a - b)
}

function shuffle<T>(random: () => number, values: readonly T[]): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other]!, result[index]!]
  }
  return result
}

/** A seeded 32-bit generator (mulberry32). */
function generator(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32
  }
}
