import { WalletOperationTooLargeError } from "@bitcaster/client-sdk/walletOperationSize";
import i18n from "@/i18n";

const ADVICE_KEYS = {
  /** The user chose the amount for this payment. */
  "smaller-amount": "deposit.tooManyProofsAmount",
  /** The amount is fixed, so only fewer proofs help. */
  "combine-proofs": "deposit.tooManyProofsFixed",
} as const;

export type WalletOperationAdvice = keyof typeof ADVICE_KEYS;

/** Localize the fixed refusal code. Every other error stays as it is. */
export function localizedWalletOperationRefusal(
  error: unknown,
  advice: WalletOperationAdvice,
): unknown {
  return error instanceof WalletOperationTooLargeError
    ? new WalletOperationTooLargeError(i18n.t(ADVICE_KEYS[advice]))
    : error;
}
