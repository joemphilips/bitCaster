export interface ParticipationScoreLike {
  enabled: boolean
  balance: number
}

export const SETTLEMENT_CAPABILITY_V1_TARIFF_RULE_ID = 'settlement-capability-v1'

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
  | { kind: 'needs-top-up'; requiredScore: number; deficitScore: number }

export function planParticipationScoreTopUp(
  score: ParticipationScoreLike,
  requiredScore: number,
): ParticipationScoreTopUpPlan {
  if (!score.enabled) return { kind: 'disabled' }

  validateRequiredScore(requiredScore)
  if (score.balance >= requiredScore) {
    return { kind: 'sufficient', requiredScore }
  }

  return {
    kind: 'needs-top-up',
    requiredScore,
    deficitScore: requiredScore - score.balance,
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

function validateRequiredScore(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Settlement capability tariff is invalid.')
  }
}

function validateCount(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Settlement capability ${label} is invalid.`)
  }
}
