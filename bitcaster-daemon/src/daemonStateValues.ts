export const DAEMON_PROOF_OPERATION_KINDS = [
  'swap-lock',
  'swap-claim',
  'conditional-keyset-swap',
  'ctf-split',
  'ctf-merge',
  'ctf-consolidation',
  'ctf-redeem',
  'ctf-condition-registration',
  'regular-split',
  'wallet-send',
  'proof-split',
  'swap-refund',
] as const

export type DaemonProofOperationKind =
  (typeof DAEMON_PROOF_OPERATION_KINDS)[number]

export const DAEMON_PROOF_OPERATION_STATES = [
  'prepared',
  'mint-submitted',
  'completed',
  'Failed',
] as const

export type DaemonProofOperationState =
  (typeof DAEMON_PROOF_OPERATION_STATES)[number]

export const DAEMON_SWAP_STEPS = [
  'awaiting-trade-created',
  'opened',
  'seller-opened',
  'buyer-responded',
  'settling',
  'awaiting-confirmation',
  'confirmed',
  'refunded',
  'Failed',
] as const

export type DaemonSwapStep = (typeof DAEMON_SWAP_STEPS)[number]

export function isDaemonStateValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && allowed.includes(value as T)
}
