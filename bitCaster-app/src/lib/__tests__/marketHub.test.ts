import { describe, expect, it } from 'vitest'

import { parseTradeExecuted } from '../marketHub'

describe('parseTradeExecuted', () => {
  it('accepts canonical AmountSubunits payloads from the engine', () => {
    expect(parseTradeExecuted({
      MarketId: 'cond-YES',
      ExecutionPrice: 420,
      AmountSubunits: 5_000,
      Side: 'Buy',
      Timestamp: '2026-06-01T00:00:00Z',
    })).toEqual({
      marketId: 'cond-YES',
      trade: {
        executionPrice: 420,
        amountSubunits: 5_000,
        side: 'Buy',
        timestamp: '2026-06-01T00:00:00Z',
      },
    })
  })
})
