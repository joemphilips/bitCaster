export interface ParticipationScoreLike {
  enabled: boolean
  balance: number
}

export const SETTLEMENT_CAPABILITY_V1_TARIFF_RULE_ID = 'settlement-capability-v1'
export const SETTLEMENT_CAPABILITY_V2_TARIFF_RULE_ID = 'settlement-capability-v2'

export type SettlementCapabilityTariffRuleId =
  | typeof SETTLEMENT_CAPABILITY_V1_TARIFF_RULE_ID
  | typeof SETTLEMENT_CAPABILITY_V2_TARIFF_RULE_ID

/**
 * The rule that the engine applies to a new capability admission. The engine
 * keeps each earlier rule for the charges that it recorded under that rule.
 */
export const CURRENT_SETTLEMENT_CAPABILITY_TARIFF_RULE_ID: SettlementCapabilityTariffRuleId =
  SETTLEMENT_CAPABILITY_V2_TARIFF_RULE_ID

/**
 * The v2 tariff is the v1 work sum divided by this value, rounded up. The
 * operator owns this value. Change it here, then the test values.
 */
export const SETTLEMENT_CAPABILITY_V2_TARIFF_DIVISOR = 10

/**
 * Score units that one top-up buys, so later trades can skip a delivery. One
 * Score unit costs 1 sat. The operator owns this value.
 */
export const PARTICIPATION_SCORE_TOP_UP_BUFFER = 20

/**
 * The buffer applies only when the wallet keeps at least this much Score after
 * the order's own funds. A smaller wallet buys only the shortfall and keeps its
 * funds for trades.
 */
export const PARTICIPATION_SCORE_TOP_UP_BUFFER_MINIMUM_SPARE = 200

export interface SettlementCapabilityScoreWorkFacts {
  inputCount: number
  manifestCount: number
  artifactByteCount: number
}

const MAX_INPUT_COUNT = 64
const MAX_MANIFEST_COUNT = 128
const MAX_ARTIFACT_BYTE_COUNT = 262_144

export type ParticipationScoreTopUpPlan =
  | { kind: 'disabled' }
  | { kind: 'sufficient'; requiredScore: number }
  | { kind: 'needs-top-up'; requiredScore: number; deficitScore: number; topUpScore: number }

/**
 * Plan the Score purchase before capability admission. `deficitScore` is the
 * true shortfall for this trade. `topUpScore` is the amount to buy.
 *
 * `availableScore` is the whole Score that the wallet can pay after the
 * order's own funds are set aside. The plan buys the buffer only when that is
 * at least `PARTICIPATION_SCORE_TOP_UP_BUFFER_MINIMUM_SPARE`. Without it, the
 * plan buys only the shortfall.
 */
export function planParticipationScoreTopUp(
  score: ParticipationScoreLike,
  requiredScore: number,
  availableScore?: number,
): ParticipationScoreTopUpPlan {
  if (!score.enabled) return { kind: 'disabled' }

  validateRequiredScore(requiredScore)
  if (availableScore !== undefined) validateAvailableScore(availableScore)
  if (score.balance >= requiredScore) {
    return { kind: 'sufficient', requiredScore }
  }

  const deficitScore = requiredScore - score.balance
  const bufferScore =
    availableScore !== undefined &&
    availableScore >= PARTICIPATION_SCORE_TOP_UP_BUFFER_MINIMUM_SPARE
      ? PARTICIPATION_SCORE_TOP_UP_BUFFER
      : 0
  return {
    kind: 'needs-top-up',
    requiredScore,
    deficitScore,
    topUpScore: Math.max(deficitScore, bufferScore),
  }
}

/**
 * Read the payable Score only when this trade has a shortfall, then plan the
 * buffered top-up. A sufficient or disabled Score needs no wallet read.
 */
export async function planParticipationScoreTopUpFromWallet(
  score: ParticipationScoreLike,
  requiredScore: number,
  readAvailableScore: () => Promise<number>,
): Promise<ParticipationScoreTopUpPlan> {
  const shortfall = planParticipationScoreTopUp(score, requiredScore)
  switch (shortfall.kind) {
    case 'disabled':
    case 'sufficient':
      return shortfall
    case 'needs-top-up':
      return planParticipationScoreTopUp(score, requiredScore, await readAvailableScore())
    default:
      return assertNever(shortfall)
  }
}

/** Mirror the engine tariff of one rule. Use the rule ID that the charge recorded. */
export function calculateSettlementCapabilityTariff(
  ruleId: SettlementCapabilityTariffRuleId,
  facts: SettlementCapabilityScoreWorkFacts,
): number {
  switch (ruleId) {
    case SETTLEMENT_CAPABILITY_V1_TARIFF_RULE_ID:
      return calculateSettlementCapabilityV1Tariff(facts)
    case SETTLEMENT_CAPABILITY_V2_TARIFF_RULE_ID:
      return calculateSettlementCapabilityV2Tariff(facts)
    default:
      throw new Error(`Settlement capability tariff rule is unsupported: ${String(ruleId)}`)
  }
}

export function calculateSettlementCapabilityV1Tariff(
  facts: SettlementCapabilityScoreWorkFacts,
): number {
  validateCount(facts.inputCount, 1, MAX_INPUT_COUNT, 'input count')
  validateCount(facts.manifestCount, 0, MAX_MANIFEST_COUNT, 'manifest count')
  validateCount(facts.artifactByteCount, 1, MAX_ARTIFACT_BYTE_COUNT, 'artifact byte count')
  return (
    1 +
    facts.inputCount +
    Math.ceil(facts.manifestCount / 16) +
    Math.ceil(facts.artifactByteCount / 4_096)
  )
}

/** The v1 tariff divided by the v2 divisor, rounded up, and never less than 1. */
export function calculateSettlementCapabilityV2Tariff(
  facts: SettlementCapabilityScoreWorkFacts,
): number {
  return Math.max(
    1,
    Math.ceil(
      calculateSettlementCapabilityV1Tariff(facts) / SETTLEMENT_CAPABILITY_V2_TARIFF_DIVISOR,
    ),
  )
}

function assertNever(value: never): never {
  throw new Error(
    `unsupported Participation Score plan: ${String((value as { kind?: unknown }).kind)}`,
  )
}

function validateRequiredScore(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Settlement capability tariff is invalid.')
  }
}

function validateAvailableScore(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Participation Score payable Score is invalid.')
  }
}

function validateCount(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Settlement capability ${label} is invalid.`)
  }
}
