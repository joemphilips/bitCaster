/** The message of a wallet operation that could not start. */
export function walletOperationErrorMessage(
  error: unknown,
  translate: (key: string) => string,
): string {
  return error instanceof Error ? error.message : translate("wallet.operationFailed");
}
