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

  it('renders only the server depthLimit rows per side while preserving stable bounded sides', () => {
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

  it('combines price, amount, and cumulative proportional depth into each compact row', () => {
    render(
      <OrderBookSection
        divisibility={100}
        orderBook={{
          depthLimit: 2,
          bids: [
            { price: 52, amount: 100, total: 100 },
            { price: 51, amount: 200, total: 300 },
          ],
          asks: [
            { price: 53, amount: 30, total: 30 },
            { price: 54, amount: 60, total: 90 },
          ],
          spread: 1,
        }}
      />,
    )

    const bidRows = screen.getAllByTestId('order-book-bid-row')
    const askRows = screen.getAllByTestId('order-book-ask-row')

    expect(bidRows[0]).toHaveAttribute('data-depth-percent', '33')
    expect(bidRows[0]).toHaveAttribute('data-depth-side', 'bid')
    expect(bidRows[0]).toHaveTextContent('52.00%')
    expect(bidRows[0]).toHaveTextContent('0.1 sats')
    expect(screen.getAllByTestId('order-book-bid-depth-fill')[0]).toHaveStyle({ width: '33%' })

    expect(askRows[0]).toHaveAttribute('data-depth-percent', '33')
    expect(askRows[0]).toHaveAttribute('data-depth-side', 'ask')
    expect(askRows[0]).toHaveTextContent('53.00%')
    expect(askRows[0]).toHaveTextContent('0.03 sats')
    expect(screen.getAllByTestId('order-book-ask-depth-fill')[0]).toHaveStyle({ width: '33%' })
  })
})
