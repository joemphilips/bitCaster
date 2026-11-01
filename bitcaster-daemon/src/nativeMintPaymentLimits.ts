import {
  checkMintPaymentAmount,
  classifyMintAmountRefusal,
  describeMintPaymentAmountRejection,
  isMintAmountOutsideLimitError,
  parseMintPaymentLimits,
  type MintPaymentAmountRejection,
  type MintPaymentDirection,
  type MintPaymentLimits,
} from '@bitcaster-market/client-sdk/mintPaymentLimits'
import type { DaemonResponse } from './protocol.ts'

/** Read the public NUT-06 info of one mint. */
export type ReadMintInfo = (mintUrl: string) => Promise<unknown>

/** An amount that the mint does not accept for one native Lightning payment. */
export class NativeMintPaymentAmountError extends Error {
  readonly direction: MintPaymentDirection
  readonly amountMsat: number | null
  readonly rejection: MintPaymentAmountRejection
  /** True when an invoice replacement hid the old invoice before the mint refused the new amount. */
  readonly previousInvoiceHidden: boolean

  constructor(
    direction: MintPaymentDirection,
    amountMsat: number | null,
    rejection: MintPaymentAmountRejection,
    previousInvoiceHidden = false,
  ) {
    super(
      previousInvoiceHidden
        ? `${describeMintPaymentAmountRejection(direction, rejection)} The previous invoice is hidden. Inspect saved invoices before retrying.`
        : describeMintPaymentAmountRejection(direction, rejection),
    )
    this.name = 'NativeMintPaymentAmountError'
    this.direction = direction
    this.amountMsat = amountMsat
    this.rejection = rejection
    this.previousInvoiceHidden = previousInvoiceHidden
  }
}

export interface NativeMintPaymentLimitCheck {
  /** Omit the reader to let the mint enforce its limits alone. */
  readonly readMintInfo: ReadMintInfo | undefined
  readonly mintUrl: string
  readonly direction: MintPaymentDirection
  /** Null when the amount is unknown before the quote, such as an unreadable invoice. */
  readonly amountMsat: number | null
}

/** Refuse an amount outside the known mint limits before a quote request. */
export async function assertNativeMintPaymentAmount(
  check: NativeMintPaymentLimitCheck,
): Promise<void> {
  if (check.amountMsat === null) return
  const limits = await readNativeMintPaymentLimits(check)
  // Unavailable limits refuse nothing: the mint enforces them.
  if (limits === null) return
  const result = checkMintPaymentAmount(limits, check.amountMsat)
  if (result.kind !== 'within-limits') {
    throw new NativeMintPaymentAmountError(check.direction, check.amountMsat, result)
  }
}

/**
 * Run one quote request. Explain a mint refusal (NUT error 11006) with
 * limits read again after the refusal. Other errors pass unchanged.
 */
export async function explainNativeMintAmountRefusal<T>(
  check: NativeMintPaymentLimitCheck,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (!isMintAmountOutsideLimitError(error)) throw error
    const limits = await readNativeMintPaymentLimits(check)
    throw new NativeMintPaymentAmountError(
      check.direction,
      check.amountMsat,
      classifyMintAmountRefusal(limits, check.amountMsat),
    )
  }
}

/** The machine-readable RPC refusal shared by invoice creation and payment quotes. */
export function nativeMintPaymentAmountFailure(
  error: NativeMintPaymentAmountError,
): DaemonResponse {
  return {
    ok: false,
    code: 'amount-outside-mint-limits',
    error: error.message,
    result: {
      direction: error.direction,
      amountMsat: error.amountMsat,
      rejection: error.rejection,
      ...(error.previousInvoiceHidden ? { previousInvoiceHidden: true } : {}),
    },
  }
}

async function readNativeMintPaymentLimits(
  check: NativeMintPaymentLimitCheck,
): Promise<MintPaymentLimits | null> {
  if (check.readMintInfo === undefined) return null
  try {
    return parseMintPaymentLimits(await check.readMintInfo(check.mintUrl), {
      direction: check.direction,
      method: 'bolt11',
      unit: 'msat',
    })
  } catch {
    return null
  }
}
