import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OrderBookSection } from '../OrderBookSection'

describe('OrderBookSection', () => {
  it('formats amounts and price numerators with the market unit metadata', () => {
    render(
      <OrderBookSection
        baseAsset="usd"
        divisibility={1_000}
        orderBook={{
          bids: [{ price: 50, amount: 100, total: 100 }],
          asks: [{ price: 60, amount: 200, total: 200 }],
          spread: 10,
        }}
      />,
    )

    expect(screen.getByText('1.0%')).toBeInTheDocument()
    expect(screen.getByText('5.0%')).toBeInTheDocument()
    expect(screen.getByText('6.0%')).toBeInTheDocument()
    expect(screen.getByText('$1.00')).toBeInTheDocument()
    expect(screen.getByText('$2.00')).toBeInTheDocument()
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument()
  })
})
