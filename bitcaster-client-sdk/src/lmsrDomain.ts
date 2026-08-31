import { parseOutcomeSetId } from './outcomeSets.ts'
import {
  DEFAULT_SAT_MARKET_DIVISIBILITY,
  defaultPriceStepSubunits,
} from './marketUnits.ts'
import type { AmmStrategyParams, PendingQRow } from './lmsrTypes.ts'

/** Keep logit arguments strictly inside (0, 1). */
const PRICE_EPSILON = 1e-9

export interface LmsrDomainInput {
  marketId: string
  terminalQ: Record<string, number>
  seedQ?: Record<string, number>
  pendingQ: Record<string, number>
  pendingRows: PendingQRow[]
  lockedProofSats: number
  marketOpenedAtEpochS: number
  marketDeadlineAtEpochS: number
  nowEpochS: number
  params: AmmStrategyParams
  /** Adapter fallback order-size tick from LmsrMakerConfig. */
  sizeTickSats: number
}

export interface LmsrLevel {
  side: 'bid' | 'ask'
  /** Engine price subunits. */
  priceSubunits: number
  /** Curve-implied size before taper and backing allocation. */
  sizeShares: number
}

export interface ReserveRequest {
  side: 'bid' | 'ask'
  priceSubunits: number
  /** Amount to reserve before taper and backing allocation. */
  sizeShares: number
  /** Atom buckets from which the adapter should reserve backing. */
  backingAtoms: string[]
}

export interface LmsrDomainOutput {
  levels: LmsrLevel[]
  reserveRequests: ReserveRequest[]
  paused: boolean
}

export interface DepthPreview {
  /** Estimated number of levels per side the bot would post. */
  levelsPerSide: number
  /** Estimated size per level, in shares. */
  sharesPerLevel: number
  /** Effective liquidity parameter b in CTF subunits. */
  bSubunits: number
}

export function estimateDepthPreview(params: {
  budgetSubunits: number
  outcomeCount: number
  /** Registered market price denominator. LMSR is ordinary-market only. */
  divisibility: number | undefined
  /** Optional: projected fee reserve to subtract from budget. Default 0. */
  projectedFeeReserveSubunits?: number
}): DepthPreview {
  const priceDivisibility = normalizePriceDivisibility(params.divisibility)
  const effectiveBudget = Math.max(
    0,
    Math.floor(params.budgetSubunits) - Math.floor(params.projectedFeeReserveSubunits ?? 0),
  )
  const outcomeCount = Math.max(0, Math.floor(params.outcomeCount))
  const bSubunits = outcomeCount > 1 ? Math.floor(effectiveBudget / Math.log(outcomeCount)) : 0
  if (bSubunits <= 0) return { levelsPerSide: 0, sharesPerLevel: 0, bSubunits: 0 }

  const midpoint = 1 / Math.max(2, outcomeCount)
  const levelsPerSide = Math.max(
    buildLadder(
      'ask',
      midpoint,
      0,
      bSubunits,
      priceDivisibility,
      defaultPriceStepSubunits(priceDivisibility),
      5,
      1,
    ).length,
    buildLadder(
      'bid',
      midpoint,
      0,
      bSubunits,
      priceDivisibility,
      defaultPriceStepSubunits(priceDivisibility),
      5,
      1,
    ).length,
  )
  const reservePerSide = Math.max(1, Math.floor(effectiveBudget / Math.max(2, outcomeCount)))
  return {
    levelsPerSide,
    sharesPerLevel: levelsPerSide > 0 ? Math.max(1, Math.floor(reservePerSide / levelsPerSide)) : 0,
    bSubunits,
  }
}

export function computeLmsrLevels(input: LmsrDomainInput): LmsrDomainOutput {
  const empty: LmsrDomainOutput = { levels: [], reserveRequests: [], paused: true }
  const params = input.params
  if (params.bSubunits <= 0 || params.levelsPerSide <= 0) return empty
  if (params.perLevelSizeCapShares <= 0) return empty

  const sizeTickSubunits = normalizeSizeTickSubunits(params.sizeTickSubunits, input.sizeTickSats)
  const priceDivisibility = normalizePriceDivisibility(params.divisibility)
  const priceStepSubunits = normalizePriceStepSubunits(params.priceStepSubunits, priceDivisibility)

  const atoms = Object.keys(input.terminalQ).sort()
  if (atoms.length < 2) return empty
  const members = marketMemberAtoms(input.marketId)
  if (
    members.length === 0 ||
    members.length >= atoms.length ||
    !members.every((m) => atoms.includes(m))
  ) {
    return empty
  }

  assertSafeInteger(params.bSubunits, 'bSubunits')
  assertSafeInteger(input.lockedProofSats, 'lockedProofSats')
  for (const atom of atoms) {
    assertSafeInteger(input.terminalQ[atom] ?? 0, `terminalQ[${atom}]`)
    assertSafeInteger(input.pendingQ[atom] ?? 0, `pendingQ[${atom}]`)
  }
  for (const [i, row] of input.pendingRows.entries()) {
    assertSafeInteger(row.qDeltaShares, `pendingRows[${i}].qDeltaShares`)
  }

  if (input.lockedProofSats > 0 && input.pendingRows.length === 0) return empty

  const exposure = sideExposure(input.pendingRows, members)
  const exposureLimit = params.perLevelSizeCapShares * params.levelsPerSide
  if (exposure.ask > exposureLimit || exposure.bid > exposureLimit) return empty
  const askBlocked = exposure.ask >= exposureLimit
  const bidBlocked = exposure.bid >= exposureLimit

  const b = params.bSubunits
  const prices = atomPricesFromQ(effectiveQ(input, atoms), b)
  const pS = members.reduce((sum, m) => sum + (prices[m] ?? 0), 0)
  const halfVig = params.vigBps / 10_000 / 2

  const taper = taperFactor(input)
  const minimumOrderSize = Math.max(params.minFillSizeShares, sizeTickSubunits, 1)
  const minimumCurveLevelSize =
    taper <= 0 ? Number.POSITIVE_INFINITY : Math.ceil(minimumOrderSize / taper)

  const askLevels = askBlocked
    ? []
    : buildLadder(
        'ask',
        pS,
        halfVig,
        b,
        priceDivisibility,
        priceStepSubunits,
        params.levelsPerSide,
        minimumCurveLevelSize,
      )
  const bidLevels = bidBlocked
    ? []
    : buildLadder(
        'bid',
        pS,
        halfVig,
        b,
        priceDivisibility,
        priceStepSubunits,
        params.levelsPerSide,
        minimumCurveLevelSize,
      )

  const complementAtoms = atoms.filter((atom) => !members.includes(atom))
  const levels: LmsrLevel[] = []
  const reserveRequests: ReserveRequest[] = []
  const maxLevels = Math.max(askLevels.length, bidLevels.length)
  for (let i = 0; i < maxLevels; i++) {
    for (const level of [askLevels[i], bidLevels[i]]) {
      if (!level) continue
      const backingAtoms = level.side === 'ask' ? members : complementAtoms
      levels.push(level)
      reserveRequests.push({ ...level, backingAtoms })
    }
  }

  if (levels.length === 0) return empty

  return { levels, reserveRequests, paused: false }
}

export function normalizeSizeTickSubunits(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) return fallback
  return Math.max(value, fallback)
}

export function normalizePriceDivisibility(value: unknown): typeof DEFAULT_SAT_MARKET_DIVISIBILITY {
  if (value !== DEFAULT_SAT_MARKET_DIVISIBILITY) {
    throw new Error('registered ordinary market divisibility is required for LMSR')
  }
  return value
}

export function normalizePriceStepSubunits(
  _value: number | undefined,
  divisibility: unknown,
): 10 {
  normalizePriceDivisibility(divisibility)
  return defaultPriceStepSubunits(divisibility)
}

/** Member atoms of the quoted market's outcome set (ATOMS-ONLY world keys). */
export function marketMemberAtoms(marketId: string): string[] {
  const dash = marketId.indexOf('-')
  if (dash <= 0 || dash === marketId.length - 1) return []
  return parseOutcomeSetId(marketId.slice(dash + 1))
}

/** Numerically-stable softmax: p_i = exp(q_i/b) / Σ_j exp(q_j/b). */
export function atomPricesFromQ(q: Record<string, number>, b: number): Record<string, number> {
  const atoms = Object.keys(q).sort()
  const scaled = atoms.map((atom) => (q[atom] ?? 0) / b)
  const max = Math.max(...scaled)
  const exps = scaled.map((value) => Math.exp(value - max))
  const z = exps.reduce((sum, value) => sum + value, 0)
  const prices: Record<string, number> = {}
  atoms.forEach((atom, i) => {
    prices[atom] = exps[i] / z
  })
  return prices
}

/** ln(p / (1 − p)) with the argument clamped strictly inside (0, 1). */
export function logit(p: number): number {
  const clamped = Math.min(1 - PRICE_EPSILON, Math.max(PRICE_EPSILON, p))
  return Math.log(clamped / (1 - clamped))
}

export function deltaQShares(b: number, p1: number, p2: number): number {
  return b * (logit(p2) - logit(p1))
}

export function taperFactor(
  world: Pick<LmsrDomainInput, 'marketOpenedAtEpochS' | 'marketDeadlineAtEpochS' | 'nowEpochS'>,
): number {
  const opened = world.marketOpenedAtEpochS
  const deadline = world.marketDeadlineAtEpochS
  const now = world.nowEpochS
  if (deadline <= opened) return 1
  if (now >= deadline) return 0
  if (now <= opened) return 1
  return Math.sqrt((deadline - now) / (deadline - opened))
}

export interface LadderLevel {
  side: 'bid' | 'ask'
  /** Executable price in market price subunits. */
  priceSubunits: number
  /** Curve-implied (pre-taper, pre-cap) integer share size, floored. */
  sizeShares: number
}

export function buildLadder(
  side: 'bid' | 'ask',
  pS: number,
  halfVig: number,
  b: number,
  divisibility: number,
  priceStep: number,
  levelsPerSide: number,
  minimumSizeShares = 1,
): LadderLevel[] {
  const result: LadderLevel[] = []
  const dir = side === 'ask' ? 1 : -1
  let prevCurve = clampProbability(pS)
  let lastPrice = side === 'ask' ? -Infinity : Infinity
  const minPrice = 1
  const maxPrice = divisibility - 1

  while (result.length < levelsPerSide) {
    if (minimumSizeShares <= 0) break

    const logitPrev = logit(prevCurve)
    const logitTarget = logitPrev + dir * (minimumSizeShares / b)
    const targetCurve = clampProbability(sigmoid(logitTarget))
    const viggedTargetPrice = divisibility * (targetCurve + dir * halfVig)
    let price =
      side === 'ask'
        ? ceilToStep(viggedTargetPrice, priceStep)
        : floorToStep(viggedTargetPrice, priceStep)

    if (result.length === 0) {
      const viggedMid = divisibility * (pS + dir * halfVig)
      if (side === 'ask') {
        const outward = ceilToStep(viggedMid, priceStep)
        if (price < outward) price = outward
      } else {
        const outward = floorToStep(viggedMid, priceStep)
        if (price > outward) price = outward
      }
    }

    if (result.length > 0) {
      if (side === 'ask' && price <= lastPrice) price = lastPrice + priceStep
      if (side === 'bid' && price >= lastPrice) price = lastPrice - priceStep
    }

    price = Math.max(minPrice, Math.min(maxPrice, price))
    if ((side === 'ask' && price > maxPrice) || (side === 'bid' && price < minPrice)) {
      break
    }

    let curve = price / divisibility - dir * halfVig
    if (curve <= 0 || curve >= 1) break

    let sizeShares = Math.floor(Math.abs(deltaQShares(b, prevCurve, curve)))

    if (sizeShares < minimumSizeShares) {
      const maxIterations = Math.ceil((maxPrice - minPrice) / priceStep) + 10
      let iterations = 0
      while (sizeShares < minimumSizeShares && iterations < maxIterations) {
        iterations++
        const nextPrice = price + dir * priceStep
        if ((side === 'ask' && nextPrice > maxPrice) || (side === 'bid' && nextPrice < minPrice)) {
          break
        }
        price = Math.max(minPrice, Math.min(maxPrice, nextPrice))
        curve = price / divisibility - dir * halfVig
        if (curve <= 0 || curve >= 1) break
        sizeShares = Math.floor(Math.abs(deltaQShares(b, prevCurve, curve)))
      }
    }

    if (sizeShares <= 0) break

    result.push({ side, priceSubunits: price, sizeShares })
    prevCurve = curve
    lastPrice = price
  }

  return result
}

export function clampProbability(p: number): number {
  return Math.min(1 - PRICE_EPSILON, Math.max(PRICE_EPSILON, p))
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x)
    return 1 / (1 + z)
  }
  const z = Math.exp(x)
  return z / (1 + z)
}

export function ceilToStep(value: number, step: number): number {
  return Math.ceil(value / step - 1e-9) * step
}

export function floorToStep(value: number, step: number): number {
  return Math.floor(value / step + 1e-9) * step
}

export function sideExposure(
  pendingRows: PendingQRow[],
  members: string[],
): { ask: number; bid: number } {
  let ask = 0
  let bid = 0
  for (const row of pendingRows) {
    const magnitude = Math.abs(row.qDeltaShares)
    if (magnitude === 0) continue
    const touchesMember = row.atoms.some((atom) => members.includes(atom))
    const touchesComplement = row.atoms.some((atom) => !members.includes(atom))
    if (row.qDeltaShares > 0) {
      if (touchesMember) ask += magnitude
      if (touchesComplement) bid += magnitude
    } else {
      if (touchesMember) bid += magnitude
      if (touchesComplement) ask += magnitude
    }
  }
  return { ask, bid }
}

export function unmaterializedReservePerAtom(
  pendingRows: PendingQRow[],
  lockedProofSats: number,
): Record<string, number> {
  const explicitReserve: Record<string, number> = {}
  const legacyPositiveDrawn: Record<string, number> = {}
  let legacyPositiveFace = 0
  for (const row of pendingRows) {
    const reserveAtoms = row.reserveAtoms ?? []
    if (reserveAtoms.length > 0) {
      const magnitude = Math.abs(row.qDeltaShares)
      for (const atom of reserveAtoms) {
        explicitReserve[atom] = (explicitReserve[atom] ?? 0) + magnitude
      }
      continue
    }

    if (row.qDeltaShares <= 0) continue
    for (const atom of row.atoms) {
      legacyPositiveDrawn[atom] = (legacyPositiveDrawn[atom] ?? 0) + row.qDeltaShares
      legacyPositiveFace += row.qDeltaShares
    }
  }
  const unmaterializedTotal = Math.max(0, legacyPositiveFace - lockedProofSats)
  const reserve: Record<string, number> = {}
  for (const [atom, face] of Object.entries(legacyPositiveDrawn)) {
    reserve[atom] = Math.min(face, unmaterializedTotal)
  }
  for (const [atom, face] of Object.entries(explicitReserve)) {
    reserve[atom] = (reserve[atom] ?? 0) + face
  }
  return reserve
}

export function effectiveQ(
  world: Pick<LmsrDomainInput, 'terminalQ' | 'pendingQ' | 'seedQ'>,
  atoms: string[],
): Record<string, number> {
  const q: Record<string, number> = {}
  for (const atom of atoms) {
    q[atom] =
      (world.seedQ?.[atom] ?? 0) + (world.terminalQ[atom] ?? 0) + (world.pendingQ[atom] ?? 0)
  }
  return q
}

export function quantizeDown(size: number, tick: number): number {
  return Math.floor(size / tick) * tick
}

export function assertSafeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a safe integer, got ${value}`)
  }
}
