/** Pure LMSR strategy parameter shapes shared by wallet-service and clients. */

export interface AmmStrategyParams {
  /** Raw creator budget in sats. */
  budgetSats: number
  /** Budget after fee reserve: B_effective = max(0, budgetSats - F_projected). */
  effectiveBudgetSats: number
  /** LMSR liquidity parameter in CTF subunits: b = B_effective / ln(n). */
  bSubunits: number
  /** Vig markup in basis points (e.g. 200 = 2 %). */
  vigBps: number
  /** Number of ladder levels posted per side. */
  levelsPerSide: number
  /** Maximum quoted size for any single level after tapering, in shares. */
  perLevelSizeCapShares: number
  /** Engine minimum fill size in shares; governs vig-coverage check. */
  minFillSizeShares: number
  /** Settlement-valid order-size increment in market collateral subunits. */
  sizeTickSubunits: number
  /** Market price denominator/divisibility. */
  divisibility: number
  /** Quote-grid step in market price subunits. Bounded positive integer. */
  priceStepSubunits: number
}

export interface PendingQRow {
  atoms: string[]
  reserveAtoms?: string[]
  qDeltaShares: number
}

export const ZERO_AMM_STRATEGY_PARAMS: Readonly<AmmStrategyParams> = {
  budgetSats: 0,
  effectiveBudgetSats: 0,
  bSubunits: 0,
  vigBps: 0,
  levelsPerSide: 0,
  perLevelSizeCapShares: 0,
  minFillSizeShares: 0,
  sizeTickSubunits: 10_000,
  divisibility: 10_000,
  priceStepSubunits: 10,
}
