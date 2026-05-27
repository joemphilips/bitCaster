import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PriceChart } from '../PriceChart'

describe('PriceChart', () => {
  it('renders a visible single tick instead of the empty-data state', () => {
    const { container } = render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [{ timestamp: '2026-05-25T10:00:00Z', price: 42, volume: 100 }],
        }}
        chartTimeframe="7d"
        chartType="price"
      />,
    )

    expect(screen.queryByText(/no data available/i)).not.toBeInTheDocument()
    expect(container.querySelector('circle')).toBeTruthy()
  })

  it('renders categorical charts when only one primitive outcome has history', () => {
    const { container } = render(
      <PriceChart
        priceHistory={{ timeframe: '7d', data: [] }}
        chartTimeframe="7d"
        chartType="price"
        outcomes={[
          { id: 'outcome-0', label: 'A', odds: 33 },
          { id: 'outcome-1', label: 'B', odds: 33 },
          { id: 'outcome-2', label: 'C', odds: 34 },
        ]}
        outcomePriceHistories={{
          'outcome-0': {
            timeframe: '7d',
            data: [{ timestamp: '2026-05-25T10:00:00Z', price: 60, volume: 100 }],
          },
        }}
      />,
    )

    expect(screen.queryByText(/no data available/i)).not.toBeInTheDocument()
    expect(container.querySelector('circle')).toBeTruthy()
  })
})
