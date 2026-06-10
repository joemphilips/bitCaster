export interface ParticipationScoreLike {
  enabled: boolean
  balance: number
  matchDebitScore: number
}

export type ParticipationScoreTopUpPlan =
  | { kind: 'disabled' }
  | { kind: 'sufficient'; requiredScore: number }
  | { kind: 'needs-top-up'; requiredScore: number; deficitScore: number }

export function planParticipationScoreTopUp(
  score: ParticipationScoreLike,
): ParticipationScoreTopUpPlan {
  if (!score.enabled) return { kind: 'disabled' }

  const requiredScore = validateScoreAmount(score.matchDebitScore)
  if (score.balance >= requiredScore) {
    return { kind: 'sufficient', requiredScore }
  }

  return {
    kind: 'needs-top-up',
    requiredScore,
    deficitScore: requiredScore - score.balance,
  }
}

function validateScoreAmount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Engine Score debit is misconfigured.')
  }
  return amount
}
