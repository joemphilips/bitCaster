import type { SdkSubmitOrderRequest } from './types.ts'

export const UNSUPPORTED_DIRECT_CTF_SELL_MESSAGE =
  'Direct sell-side locking of existing CTF outcome proofs is unsupported by the current mint. Use a prelocked CTF split flow such as mint maker-as-splitter settlement.'

export type SettlementSupportErrorCode = 'unsupported-direct-ctf-sell'

export interface SettlementSupportCapabilities {
  directCtfSellLocking?: boolean
}

export type OrderSettlementSupport =
  | { supported: true }
  | {
      supported: false
      code: SettlementSupportErrorCode
      message: string
    }

export class SettlementSupportError extends Error {
  readonly code: SettlementSupportErrorCode

  constructor(
    code: SettlementSupportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SettlementSupportError'
    this.code = code
  }
}

export function checkOrderSettlementSupport(params: {
  request: Pick<SdkSubmitOrderRequest, 'side'>
  capabilities?: SettlementSupportCapabilities
}): OrderSettlementSupport {
  if (
    params.request.side === 'Sell' &&
    params.capabilities?.directCtfSellLocking === false
  ) {
    return {
      supported: false,
      code: 'unsupported-direct-ctf-sell',
      message: UNSUPPORTED_DIRECT_CTF_SELL_MESSAGE,
    }
  }

  return { supported: true }
}

export function assertOrderSettlementSupported(params: {
  request: Pick<SdkSubmitOrderRequest, 'side'>
  capabilities?: SettlementSupportCapabilities
}): void {
  const support = checkOrderSettlementSupport(params)
  if (!support.supported) {
    throw new SettlementSupportError(support.code, support.message)
  }
}
