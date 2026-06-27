import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OrderBookSection } from '../OrderBookSection'

describe('OrderBookSection', () => {
  it('formats amounts as shares and price numerators with the market divisibility', () => {
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
    expect(screen.getByText('0.1 shares')).toBeInTheDocument()
    expect(screen.getByText('0.2 shares')).toBeInTheDocument()
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
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

  it('renders asks and bids in descending price order with closest prices around the spread', () => {
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
      expect.stringContaining('90.00%'),
      expect.stringContaining('80.00%'),
      expect.stringContaining('70.00%'),
    ])

    const askRows = screen.getAllByTestId('order-book-ask-row')
    expect(askRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('95.00%'),
      expect.stringContaining('93.00%'),
      expect.stringContaining('91.00%'),
    ])

    const spreadRow = screen.getByTestId('order-book-spread-row')
    expect(askRows[2].compareDocumentPosition(spreadRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(spreadRow.compareDocumentPosition(bidRows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders ask rows above the spread and bid rows below it in DOM order', () => {
    render(
      <OrderBookSection
        divisibility={100}
        orderBook={{
          bids: [{ price: 45, amount: 100, total: 100 }],
          asks: [{ price: 55, amount: 100, total: 100 }],
          spread: 10,
        }}
      />,
    )

    const askRow = screen.getByTestId('order-book-ask-row')
    const spreadRow = screen.getByTestId('order-book-spread-row')
    const bidRow = screen.getByTestId('order-book-bid-row')

    expect(
      askRow.compareDocumentPosition(spreadRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      spreadRow.compareDocumentPosition(bidRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('combines price, share amount, and amount-proportional depth into each compact row', () => {
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

    expect(bidRows[0]).toHaveAttribute('data-depth-percent', '50')
    expect(bidRows[0]).toHaveAttribute('data-depth-side', 'bid')
    expect(bidRows[0]).toHaveTextContent('52.00%')
    expect(bidRows[0]).toHaveTextContent('1 share')
    expect(screen.getAllByTestId('order-book-bid-depth-fill')[0]).toHaveStyle({ width: '50%' })
    expect(screen.getAllByTestId('order-book-bid-depth-fill')[0]).toHaveClass('left-0')
    expect(screen.getAllByTestId('order-book-bid-depth-fill')[0]).not.toHaveClass('right-0')

    expect(askRows[0]).toHaveAttribute('data-depth-percent', '30')
    expect(askRows[0]).toHaveAttribute('data-depth-side', 'ask')
    expect(askRows[0]).toHaveTextContent('54.00%')
    expect(askRows[0]).toHaveTextContent('0.6 shares')
    expect(screen.getAllByTestId('order-book-ask-depth-fill')[0]).toHaveStyle({ width: '30%' })
    expect(screen.getAllByTestId('order-book-ask-depth-fill')[0]).toHaveClass('left-0')
  })
})
