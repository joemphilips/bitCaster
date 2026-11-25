/** A prepared payment costs more than the caller approved. The message holds no wallet data. */
export class ApprovedWalletDebitExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovedWalletDebitExceededError'
  }
}
