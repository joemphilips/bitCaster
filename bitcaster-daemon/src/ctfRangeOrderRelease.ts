import type { CashuMintRefusal } from '@bitcaster-market/client-sdk/mintRefusal'
import { computeInputFeeSubunitsFromPpk } from '@bitcaster-market/client-sdk/proofSelection'

/**
 * Range order recovery facts that the daemon RPC reports (ADR-037 mint
 * refusal settlement). This module has no coordinator dependency, so the
 * server can name the released error without loading the coordinator.
 */

export interface DaemonCtfRangeRecoveryPending {
  readonly operationId: string
  readonly error: string
  readonly retryAtMs?: number
  /** The coded mint refusal that kept this request reserved. */
  readonly mintError?: CashuMintRefusal
  /** Automatic retries stopped after repeated identical refusals. */
  readonly halted?: true
  /** The CLI command that allows one more automatic attempt. */
  readonly retryCommand?: string
}

export interface DaemonCtfRangeReleasedOperation {
  readonly operationId: string
  readonly mintError: CashuMintRefusal
  readonly message: string
}

export interface DaemonCtfRangeRecoveryStatus {
  readonly pending: DaemonCtfRangeRecoveryPending[]
  readonly released: DaemonCtfRangeReleasedOperation[]
}

/** The mint refused a range order preparation, and the daemon released its reserved funds. */
export class CtfRangeOrderReleasedError extends Error {
  readonly mintError: CashuMintRefusal

  constructor(mintError: CashuMintRefusal) {
    super(rangeOrderReleasedMessage(mintError.code))
    this.name = 'CtfRangeOrderReleasedError'
    this.mintError = mintError
  }
}

/**
 * An earlier sell of the same market still holds reserved funds. The daemon
 * refused this sell before it reserved anything, as the browser does.
 */
export class CtfRangeSellPreparationPendingError extends Error {
  /** The command that retries the earlier sell, when its automatic retries stopped. */
  readonly retryCommand: string | null

  constructor(retryCommand: string | null) {
    super(
      retryCommand === null
        ? 'An earlier sell in this market is still preparing its funds. No order was submitted. To see it, run: bitcaster-cli order recovery'
        : `An earlier sell in this market is still preparing its funds. Its automatic retries stopped. No order was submitted. To try it again, run: ${retryCommand}`,
    )
    this.name = 'CtfRangeSellPreparationPendingError'
    this.retryCommand = retryCommand
  }
}

/**
 * The wallet cannot pay a Buy with all of its available sats. The daemon
 * refused the order before it reserved anything. The amounts are in msat.
 */
export class CtfRangeOrderInsufficientFundsError extends Error {
  readonly requiredMsat: number
  readonly availableMsat: number

  constructor(requiredMsat: number, availableMsat: number) {
    super(
      `Insufficient funds: this order needs ${requiredMsat} msat, including fees, and the wallet has ${availableMsat} msat.`,
    )
    this.name = 'CtfRangeOrderInsufficientFundsError'
    this.requiredMsat = requiredMsat
    this.availableMsat = availableMsat
  }
}

/**
 * The shortfall of a Buy that all available offered proofs cannot pay, or
 * null. `inventory` maps each proof amount in msat to its proof count. A Buy
 * pays its authorization amount and the input fee of each spent proof. A
 * proof worth less than its own input fee lowers what the wallet can pay,
 * so the bound leaves it out.
 */
export function rangeBuyFundsShortfall(
  targetMsat: number,
  inputFeePpk: number,
  inventory: ReadonlyMap<number, number>,
): CtfRangeOrderInsufficientFundsError | null {
  let proofCount = 0
  let availableMsat = 0
  for (const [amount, count] of inventory) {
    if (amount * 1_000 < inputFeePpk) continue
    proofCount += count
    availableMsat += amount * count
  }
  const requiredMsat = targetMsat + computeInputFeeSubunitsFromPpk(inputFeePpk * proofCount)
  return availableMsat < requiredMsat
    ? new CtfRangeOrderInsufficientFundsError(requiredMsat, availableMsat)
    : null
}

/**
 * The consolidation rounds commit before the refused source swap, so a
 * consolidation fee can already be paid. The browser says the same.
 */
export function rangeOrderReleasedMessage(code: number): string {
  return `The mint refused the order (mint code ${code}). No order was submitted. The reserved funds, less any consolidation fee already paid, are available again.`
}

export function rangeOrderRetryCommand(operationId: string): string {
  return `bitcaster-cli order retry ${operationId}`
}
