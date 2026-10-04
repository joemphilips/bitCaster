import {
  createBoundedRecoveryPager,
  type BoundedRecoveryPage,
  type NormalizedRecoveryOutcome,
} from './boundedRecoveryPager.ts'
import type {
  NativeWalletPaymentOps,
  NativeWalletPaymentRecoveryItem,
} from './nativeWalletPaymentOps.ts'

export type NativeWalletPaymentRecoveryScan = BoundedRecoveryPage

/** Adapt wallet-payment outcomes to the daemon's shared bounded recovery pager. */
export function createNativeWalletPaymentRecoveryPager(
  recover: NonNullable<NativeWalletPaymentOps['recoverActivePage']>,
): {
  recoverPage(): Promise<NativeWalletPaymentRecoveryScan>
  restart(): void
} {
  return createBoundedRecoveryPager(
    (cursor) => recover({ cursor }),
    normalizeNativeWalletPaymentOutcome,
  )
}

function normalizeNativeWalletPaymentOutcome(
  outcome: NativeWalletPaymentRecoveryItem,
): NormalizedRecoveryOutcome {
  switch (outcome.outcome) {
    case 'recovered':
      return { kind: 'recovered', operationId: outcome.operationId }
    case 'pending':
      return {
        kind: 'blocking',
        operationId: outcome.operationId,
        error: 'wallet payment remains pending',
      }
    case 'error':
      return {
        kind: 'blocking',
        operationId: outcome.operationId,
        error: 'wallet payment recovery needs attention',
      }
    default:
      return assertNever(outcome.outcome)
  }
}

function assertNever(value: never): never {
  throw new Error(`native wallet payment recovery outcome is unsupported: ${String(value)}`)
}
