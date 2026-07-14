import type {
  SubmitOrderRequest,
  SubmitOrderResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import type { DurableOrderCollateralPin } from '@bitcaster-market/client-sdk/durableOrderCollateral'
import type { DaemonOrderCollateralCoordinator } from './durableOrderCollateralCoordinator.ts'

const RECOVERY_PAGE_SIZE = 64

export interface DurableOrderSubmissionRecoveryDependencies {
  coordinator: DaemonOrderCollateralCoordinator
  submitOrder(
    marketId: string,
    request: SubmitOrderRequest,
  ): Promise<SubmitOrderResponse>
  commitAccepted(
    pin: DurableOrderCollateralPin,
    response: SubmitOrderResponse,
  ): Promise<unknown>
  afterCommit?(
    pin: DurableOrderCollateralPin,
    response: SubmitOrderResponse,
  ): Promise<void>
  onAfterCommitError?(error: unknown, pin: DurableOrderCollateralPin): void
}

export async function recoverPreparedOrderSubmissions(
  dependencies: DurableOrderSubmissionRecoveryDependencies,
): Promise<{ recoveredCount: number }> {
  let cursor: string | null = null
  let recoveredCount = 0
  do {
    const page = await dependencies.coordinator.readPreparedPage({
      cursor,
      limit: RECOVERY_PAGE_SIZE,
    })
    for (const pin of page.pins) {
      const response = await dependencies.submitOrder(
        pin.marketId,
        exactSubmitRequest(pin),
      )
      await dependencies.commitAccepted(pin, response)
      recoveredCount += 1
      await runAfterCommitBestEffort(dependencies, pin, response)
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return { recoveredCount }
}

function exactSubmitRequest(pin: DurableOrderCollateralPin): SubmitOrderRequest {
  return pin.submissionRequest
}

async function runAfterCommitBestEffort(
  dependencies: DurableOrderSubmissionRecoveryDependencies,
  pin: DurableOrderCollateralPin,
  response: SubmitOrderResponse,
): Promise<void> {
  if (!dependencies.afterCommit) return
  try {
    await dependencies.afterCommit(pin, response)
  } catch (error) {
    dependencies.onAfterCommitError?.(error, pin)
  }
}
