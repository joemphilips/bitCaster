import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildLadder,
  computeLmsrLevels,
  deltaQShares,
  estimateDepthPreview,
  logit,
} from '../src/lmsrDomain.ts'
import type { AmmStrategyParams, PendingQRow } from '../src/lmsrTypes.ts'

function params(overrides: Partial<AmmStrategyParams> = {}): AmmStrategyParams {
  return {
    budgetSats: 110_000,
    effectiveBudgetSats: 100_000,
    bSubunits: Math.floor(100_000 / Math.LN2),
    vigBps: 200,
    levelsPerSide: 5,
    perLevelSizeCapShares: 10_000,
    minFillSizeShares: 100,
    sizeTickSubunits: 100,
    divisibility: 100,
    priceStepSubunits: 1,
    ...overrides,
  }
}

function domainInput(overrides: Partial<Parameters<typeof computeLmsrLevels>[0]> = {}) {
  return {
    marketId: 'cond-YES',
    terminalQ: { YES: 0, NO: 0 },
    pendingQ: { YES: 0, NO: 0 },
    pendingRows: [] as PendingQRow[],
    lockedProofSats: 0,
    marketOpenedAtEpochS: 0,
    marketDeadlineAtEpochS: 0,
    nowEpochS: 0,
    params: params(),
    sizeTickSats: 100,
    ...overrides,
  }
}

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

describe('lmsrDomain properties', () => {
  it('is path independent: shuffled fills reach the same q and aggregate cost', () => {
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

  it('keeps terminal worst-case loss below B_effective for pump-and-fade sequences', () => {
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

  it('buildLadder is non-empty whenever the curve has a minimum-size interval in range', () => {
    for (const b of [100, 1_000, 10_000, 100_000]) {
      for (const divisibility of [100, 1_000, 10_000]) {
        for (const priceStep of [1, Math.max(1, Math.floor(divisibility / 1_000))]) {
          const pS = 0.5
          const minimumSize = 5
          const ladder = buildLadder('ask', pS, 0, b, divisibility, priceStep, 5, minimumSize)
          const maxCurve = (divisibility - 1) / divisibility
          const sharesInRange = Math.floor(deltaQShares(b, pS, maxCurve))
          assert.equal(ladder.length === 0, sharesInRange < minimumSize)
        }
      }
    }
  })

  it('is deterministic for the same input', () => {
    const input = domainInput({
      seedQ: { YES: Math.round(100_000 * Math.log(0.6)), NO: Math.round(100_000 * Math.log(0.4)) },
      terminalQ: { YES: 123, NO: 0 },
      pendingQ: { YES: 50, NO: 0 },
      pendingRows: [{ atoms: ['YES'], qDeltaShares: 50 }],
      lockedProofSats: 50,
    })
    assert.deepEqual(computeLmsrLevels(input), computeLmsrLevels(input))
  })

  it('is decoupled from physical proof inventory (price-only domain)', () => {
    const output = computeLmsrLevels(domainInput())
    assert.equal(output.paused, false)
    assert.ok(output.levels.length > 0)
    assert.equal(JSON.stringify(output).includes('outcomeInventory'), false)
    assert.equal(JSON.stringify(output).includes('virtualInventory'), false)
    assert.ok(Math.abs(logit(0.5)) < 1e-12)
  })

  it('estimates depth preview from effective LMSR budget', () => {
    const preview = estimateDepthPreview({
      budgetSubunits: 100_000,
      outcomeCount: 2,
      projectedFeeReserveSubunits: 1_000,
    })
    assert.equal(preview.bSubunits, Math.floor(99_000 / Math.LN2))
    assert.equal(preview.levelsPerSide, 5)
    assert.ok(preview.sharesPerLevel > 0)
  })
})
