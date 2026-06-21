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
          bids: [{ price: 50, amount: 100_000, total: 100_000 }],
          asks: [{ price: 60, amount: 200_000, total: 200_000 }],
          spread: 10,
        }}
      />,
    )

    expect(screen.getByText('1.00%')).toBeInTheDocument()
    expect(screen.getByText('5.00%')).toBeInTheDocument()
    expect(screen.getByText('6.00%')).toBeInTheDocument()
    expect(screen.getByText('$1.00')).toBeInTheDocument()
    expect(screen.getByText('$2.00')).toBeInTheDocument()
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument()
  })

  it('renders only the server depthLimit rows per side while preserving stable side columns', () => {
    render(
      <OrderBookSection
        divisibility={100}
        orderBook={{
          depthLimit: 3,
          bids: [
            { price: 90, amount: 100, total: 100 },
            { price: 80, amount: 100, total: 200 },
            { price: 70, amount: 100, total: 300 },
            { price: 60, amount: 100, total: 400 },
          ],
          asks: [
            { price: 91, amount: 100, total: 100 },
            { price: 92, amount: 100, total: 200 },
            { price: 93, amount: 100, total: 300 },
            { price: 94, amount: 100, total: 400 },
          ],
          spread: 1,
        }}
      />,
    )

    expect(screen.getAllByTestId('order-book-bid-row')).toHaveLength(3)
    expect(screen.getAllByTestId('order-book-ask-row')).toHaveLength(3)
    expect(screen.getByText('90.00%')).toBeInTheDocument()
    expect(screen.getByText('93.00%')).toBeInTheDocument()
    expect(screen.queryByText('60.00%')).not.toBeInTheDocument()
    expect(screen.queryByText('94.00%')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('order-book-bid-placeholder')).toHaveLength(0)
    expect(screen.queryAllByTestId('order-book-ask-placeholder')).toHaveLength(0)
  })
})
