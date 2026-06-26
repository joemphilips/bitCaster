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

    expect(screen.getByText('1.00%')).toBeInTheDocument()
    expect(screen.getByText('5.00%')).toBeInTheDocument()
    expect(screen.getByText('6.00%')).toBeInTheDocument()
    expect(screen.getByText('$1.00')).toBeInTheDocument()
    expect(screen.getByText('$2.00')).toBeInTheDocument()
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument()
  })

  it('renders the fixed five-row display depth while preserving stable bounded sides', () => {
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

    expect(screen.getAllByTestId('order-book-bid-row')).toHaveLength(4)
    expect(screen.getAllByTestId('order-book-ask-row')).toHaveLength(4)
    expect(screen.getByText('90.00%')).toBeInTheDocument()
    expect(screen.getByText('93.00%')).toBeInTheDocument()
    expect(screen.getByText('60.00%')).toBeInTheDocument()
    expect(screen.getByText('94.00%')).toBeInTheDocument()
    expect(screen.queryAllByTestId('order-book-bid-placeholder')).toHaveLength(1)
    expect(screen.queryAllByTestId('order-book-ask-placeholder')).toHaveLength(1)
  })

  it('renders bids bottom-up with the best bid closest to the spread and asks top-down', () => {
    render(
      <OrderBookSection
        divisibility={100}
        orderBook={{
          bids: [
            { price: 70, amount: 100, total: 100 },
            { price: 90, amount: 100, total: 200 },
            { price: 80, amount: 100, total: 300 },
          ],
          asks: [
            { price: 95, amount: 100, total: 100 },
            { price: 91, amount: 100, total: 200 },
            { price: 93, amount: 100, total: 300 },
          ],
          spread: 1,
        }}
      />,
    )

    const bidRows = screen.getAllByTestId('order-book-bid-row')
    expect(bidRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('70.00%'),
      expect.stringContaining('80.00%'),
      expect.stringContaining('90.00%'),
    ])

    const askRows = screen.getAllByTestId('order-book-ask-row')
    expect(askRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('91.00%'),
      expect.stringContaining('93.00%'),
      expect.stringContaining('95.00%'),
    ])
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

    expect(bidRows[1]).toHaveAttribute('data-depth-percent', '33')
    expect(bidRows[1]).toHaveAttribute('data-depth-side', 'bid')
    expect(bidRows[1]).toHaveTextContent('52.00%')
    expect(bidRows[1]).toHaveTextContent('0.1 sats')
    expect(screen.getAllByTestId('order-book-bid-depth-fill')[1]).toHaveStyle({ width: '33%' })

    expect(askRows[0]).toHaveAttribute('data-depth-percent', '10')
    expect(askRows[0]).toHaveAttribute('data-depth-side', 'ask')
    expect(askRows[0]).toHaveTextContent('53.00%')
    expect(askRows[0]).toHaveTextContent('0.03 sats')
    expect(screen.getAllByTestId('order-book-ask-depth-fill')[0]).toHaveStyle({ width: '10%' })
  })
})
