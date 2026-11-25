import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KeyChain,
  selectProofsRGLI,
  selectProofsRotating,
  type ProofLike,
  type SendResponse,
} from '@cashu/cashu-ts'
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

test('a wallet that can pay is never refused, and the input count stays below random selection', () => {
  const random = generator(23)
  for (const includeFees of [true, false]) {
    for (const ppk of [0, 1, 100, 500, 999, 1_000, 1_500, 2_500]) {
      const chain = keyChain({ [ACTIVE]: ppk })
      let inputs = 0
      let randomInputs = 0
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
      assert.ok(inputs <= randomInputs, `${inputs} inputs, random selection used ${randomInputs}`)
    }
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

function generator(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}
