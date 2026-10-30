export interface ParticipationScoreLike {
  enabled: boolean
  balance: number
}

export const SETTLEMENT_CAPABILITY_V1_TARIFF_RULE_ID = 'settlement-capability-v1'

/**
 * Score units that one top-up buys at least, so later trades can skip a
 * delivery. One Score unit costs 1 sat. A wallet that cannot pay the buffer
 * buys less, but never less than the shortfall.
 */
export const PARTICIPATION_SCORE_TOP_UP_BUFFER = 50

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
 * order's own funds are set aside. The buffer never exceeds it, so the buffer
 * cannot make a trade fail when the exact shortfall is payable. Without it,
 * the plan buys the full buffer.
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
  const bufferScore = Math.min(
    PARTICIPATION_SCORE_TOP_UP_BUFFER,
    availableScore ?? PARTICIPATION_SCORE_TOP_UP_BUFFER,
  )
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
