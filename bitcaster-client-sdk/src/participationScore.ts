import { normalizeDurableWalletMintUrl } from './durableWalletMintUrl.ts'

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

export async function deriveParticipationScorePaymentId(input: {
  walletScopeId: string
  accountSubject: string
  mintUrl: string
  amountSats: number
  balance: number
  purchasedTotal: number
  consumedTotal: number
  penaltyTotal: number
  matchDebitScore: number
}): Promise<string> {
  const walletScopeId = requireBoundedText(input.walletScopeId, 'wallet scope', 256)
  const accountSubject = requireBoundedText(input.accountSubject, 'account subject', 512)
  const mintUrl = normalizeDurableWalletMintUrl(input.mintUrl)
  const values = [
    input.amountSats,
    input.balance,
    input.purchasedTotal,
    input.consumedTotal,
    input.penaltyTotal,
    input.matchDebitScore,
  ].map(requireSafeInteger)
  const canonical = JSON.stringify([
    'bitcaster/participation-score-payment/v1',
    walletScopeId,
    accountSubject,
    mintUrl,
    ...values,
  ])
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)),
  )
  const uuid = digest.slice(0, 16)
  uuid[6] = (uuid[6]! & 0x0f) | 0x50
  uuid[8] = (uuid[8]! & 0x3f) | 0x80
  const hex = Array.from(uuid, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function validateScoreAmount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Engine Score debit is misconfigured.')
  }
  return amount
}

function requireBoundedText(value: string, name: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Engine Score ${name} is invalid.`)
  }
  return value
}

function requireSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error('Engine Score payment snapshot is invalid.')
  }
  return value
}
