import {
  planParticipationScoreTopUp,
  planParticipationScoreTopUpFromWallet,
  type ParticipationScoreLike,
  type ParticipationScoreTopUpPlan,
} from '@bitcaster-market/client-sdk/participationScore'

export class InsufficientParticipationScoreBackingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientParticipationScoreBackingError'
  }
}

/**
 * Plan an order's Score top-up with the SDK buffer rule. The order source is
 * already bound, so the available balance excludes the order's own funds.
 */
export async function planDaemonParticipationScoreTopUp(input: {
  readonly score: ParticipationScoreLike
  readonly requiredScore: number
  readonly resumesDelivery: () => Promise<boolean>
  readonly readAvailableMsat: () => Promise<number>
  readonly quoteSend: (amountMsat: number) => Promise<unknown>
  /** False while another order is prepared: its funds are not set aside yet. */
  readonly buffer?: boolean
}): Promise<ParticipationScoreTopUpPlan> {
  const wallet = { resumed: false, availableMsat: 0 }
  const plan = await planParticipationScoreTopUpFromWallet(
    input.score,
    input.requiredScore,
    async () => {
      // An active delivery resumes with its stored amount and spends no new
      // wallet funds, so neither the backing check nor the buffer applies.
      wallet.resumed = await input.resumesDelivery()
      if (wallet.resumed) return 0
      wallet.availableMsat = await input.readAvailableMsat()
      return Math.floor(wallet.availableMsat / 1_000)
    },
  )
  switch (plan.kind) {
    case 'disabled':
    case 'sufficient':
      return plan
    case 'needs-top-up':
      break
    default:
      return assertNever(plan)
  }
  if (wallet.resumed) return plan
  const backingError = participationScoreBackingError({
    availableMsat: wallet.availableMsat,
    deficitScore: plan.deficitScore,
  })
  if (backingError) throw new InsufficientParticipationScoreBackingError(backingError)
  if (input.buffer === false) {
    return planParticipationScoreTopUp(input.score, input.requiredScore, 0)
  }
  if (plan.topUpScore === plan.deficitScore) return plan
  // The balance excludes input fees. Quote the buffered send against the same
  // proofs. If it does not fit, buy only the shortfall, as before the buffer.
  try {
    await input.quoteSend(participationScoreToMsat(plan.topUpScore))
    return plan
  } catch {
    return planParticipationScoreTopUp(input.score, input.requiredScore, 0)
  }
}

export function participationScoreToMsat(score: number): number {
  if (!Number.isSafeInteger(score) || score <= 0) {
    throw new Error('Participation Score amount is invalid')
  }
  const amountMsat = score * 1_000
  if (!Number.isSafeInteger(amountMsat)) {
    throw new Error('Participation Score amount exceeds safe range')
  }
  return amountMsat
}

function participationScoreBackingError(input: {
  availableMsat: number
  deficitScore: number
}): string | null {
  if (!Number.isSafeInteger(input.availableMsat) || input.availableMsat < 0) {
    throw new Error('Participation Score backing exceeds safe range')
  }
  const requiredMsat = participationScoreToMsat(input.deficitScore)
  if (input.availableMsat >= requiredMsat) return null
  return `insufficient Participation Score backing: have ${input.availableMsat} msat, need ${requiredMsat} msat`
}

function assertNever(value: never): never {
  throw new Error(
    `unsupported Participation Score plan: ${String((value as { kind?: unknown }).kind)}`,
  )
}
