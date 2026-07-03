import assert from 'node:assert/strict'
import test from 'node:test'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function lmsrCost(q: Record<string, number>, b: number): number {
  const scaled = Object.values(q).map((value) => value / b)
  const m = Math.max(...scaled)
  const sum = scaled.reduce((acc, value) => acc + Math.exp(value - m), 0)
  return b * (m + Math.log(sum))
}

test('LMSR path independence property holds for shuffled fills', () => {
  const rng = mulberry32(0x4477)
  for (let i = 0; i < 80; i++) {
    const b = randInt(rng, 25_000, 250_000)
    const seedQ = {
      YES: randInt(rng, -20_000, 20_000),
      NO: randInt(rng, -20_000, 20_000),
    }
    const fills = Array.from({ length: randInt(rng, 2, 8) }, () => randInt(rng, 1, 2_000))
    const shuffled = [...fills].sort(() => rng() - 0.5)
    const total = fills.reduce((sum, x) => sum + x, 0)

    const qSequential = { ...seedQ }
    let sequentialCost = 0
    for (const fill of shuffled) {
      const before = lmsrCost(qSequential, b)
      qSequential.YES += fill
      sequentialCost += lmsrCost(qSequential, b) - before
    }

    const qAggregate = { ...seedQ, YES: seedQ.YES + total }
    const aggregateCost = lmsrCost(qAggregate, b) - lmsrCost(seedQ, b)

    assert.deepEqual(qSequential, qAggregate)
    assert.ok(Math.abs(sequentialCost - aggregateCost) < 1e-7)
  }
})

test('LMSR worst-case loss stays below effective budget for pump-and-fade sequences', () => {
  const rng = mulberry32(0x8351)
  for (let i = 0; i < 80; i++) {
    const effectiveBudgetSats = randInt(rng, 5_000, 200_000)
    const b = Math.floor(effectiveBudgetSats / Math.LN2)
    const q = { YES: 0, NO: 0 }
    let revenue = 0
    const rounds = randInt(rng, 1, 20)
    for (let r = 0; r < rounds; r++) {
      const pump = randInt(rng, 1, 2_500)
      const beforePump = lmsrCost(q, b)
      q.YES += pump
      revenue += lmsrCost(q, b) - beforePump

      const fade = randInt(rng, 0, pump)
      const beforeFade = lmsrCost(q, b)
      q.YES -= fade
      revenue += lmsrCost(q, b) - beforeFade
    }

    const worstCaseLoss = Math.max(q.YES, q.NO) - revenue
    assert.ok(worstCaseLoss <= effectiveBudgetSats + 1e-6)
  }
})
