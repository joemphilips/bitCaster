import { describe, expect, it } from 'vitest'
import {
  SettlementSupportError,
  UNSUPPORTED_DIRECT_CTF_SELL_MESSAGE,
  assertOrderSettlementSupported,
  checkOrderSettlementSupport,
} from '@bitcaster/client-sdk/settlementSupport'

describe('shared settlement-support checks', () => {
  it('allows buy orders because the buyer locks sats', () => {
    expect(
      checkOrderSettlementSupport({ request: { side: 'Buy' } }),
    ).toEqual({ supported: true })
  })

  it('allows sell orders by default after same-outcome CTF swaps are supported', () => {
    expect(
      checkOrderSettlementSupport({ request: { side: 'Sell' } }),
    ).toEqual({ supported: true })
  })

  it('fails closed on sell orders when direct CTF locking is disabled for old mints', () => {
    expect(
      checkOrderSettlementSupport({
        request: { side: 'Sell' },
        capabilities: { directCtfSellLocking: false },
      }),
    ).toEqual({
      supported: false,
      code: 'unsupported-direct-ctf-sell',
      message: UNSUPPORTED_DIRECT_CTF_SELL_MESSAGE,
    })
  })

  it('allows sell orders when the runtime advertises direct CTF locking', () => {
    expect(
      checkOrderSettlementSupport({
        request: { side: 'Sell' },
        capabilities: { directCtfSellLocking: true },
      }),
    ).toEqual({ supported: true })
  })

  it('raises a typed error for callers that prefer exceptions', () => {
    expect(() =>
      assertOrderSettlementSupported({
        request: { side: 'Sell' },
        capabilities: { directCtfSellLocking: false },
      }),
    ).toThrow(SettlementSupportError)
  })
})
