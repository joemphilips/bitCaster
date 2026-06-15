import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PriceChart } from '../PriceChart'

const plotInstances = vi.hoisted(() => [] as Array<{
  setData: ReturnType<typeof vi.fn>
  setSize: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  options: unknown
  data: unknown
}>)

vi.mock('uplot', () => {
  class MockUPlot {
    setData = vi.fn()
    setSize = vi.fn()
    destroy = vi.fn()
    options: unknown
    data: unknown

    constructor(options: unknown, data: unknown, container: HTMLElement) {
      this.options = options
      this.data = data
      plotInstances.push(this)
      container.appendChild(document.createElement('canvas'))
    }
  }
  return {
    default: Object.assign(MockUPlot, {
      paths: {
        stepped: vi.fn(() => 'stepped-paths'),
      },
    }),
  }
})

describe('PriceChart', () => {
  beforeEach(() => {
    plotInstances.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a uPlot chart with fixed probability axis labels', () => {
    render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [
            { timestamp: '2026-05-20T10:00:00Z', price: 40 },
            { timestamp: '2026-05-25T10:00:00Z', price: 55 },
          ],
        }}
        chartTimeframe="7d"
      />,
    )

    expect(screen.getByTestId('price-chart-uplot')).toBeInTheDocument()
    expect(screen.getByTestId('latest-price-pill')).toHaveTextContent('55%')
    expect(plotInstances).toHaveLength(1)
    const options = plotInstances[0].options as {
      axes: Array<{
        splits?: () => number[]
        values?: (_u: unknown, values: number[]) => string[]
      }>
    }
    expect(options.axes[1].splits?.()).toEqual([0, 50, 100])
    expect(options.axes[1].values?.({}, [0, 50, 100])).toEqual(['0%', '50%', '100%'])
  })

  it('updates the existing plot data when history changes', () => {
    const { rerender } = render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [{ timestamp: '2026-05-20T10:00:00Z', price: 40 }],
        }}
        chartTimeframe="7d"
      />,
    )

    const instance = plotInstances[0]
    rerender(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [
            { timestamp: '2026-05-20T10:00:00Z', price: 40 },
            { timestamp: '2026-05-21T10:00:00Z', price: 50 },
          ],
        }}
        chartTimeframe="7d"
      />,
    )

    expect(plotInstances).toHaveLength(1)
    expect(instance.setData).toHaveBeenCalled()
    expect(screen.getByTestId('latest-price-pill')).toHaveTextContent('50%')
  })

  it('destroys the plot on unmount', () => {
    const { unmount } = render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [{ timestamp: '2026-05-20T10:00:00Z', price: 40 }],
        }}
        chartTimeframe="7d"
      />,
    )

    const instance = plotInstances[0]
    unmount()
    expect(instance.destroy).toHaveBeenCalled()
  })

  it('renders one latest-value pill per categorical outcome series', () => {
    render(
      <PriceChart
        priceHistory={{ timeframe: '7d', data: [] }}
        chartTimeframe="7d"
        outcomes={[
          { id: 'outcome-0', label: 'Alice', odds: 33 },
          { id: 'outcome-1', label: 'Bob', odds: 33 },
          { id: 'outcome-2', label: 'Carol', odds: 34 },
        ]}
        outcomePriceHistories={{
          Alice: {
            timeframe: '7d',
            data: [{ timestamp: '2026-05-25T10:00:00Z', price: 33 }],
          },
          Bob: {
            timeframe: '7d',
            data: [{ timestamp: '2026-05-25T10:00:00Z', price: 28 }],
          },
        }}
      />,
    )

    const pills = screen.getAllByTestId('latest-price-pill')
    expect(pills).toHaveLength(2)
    expect(pills[0]).toHaveTextContent('Alice')
    expect(pills[0]).toHaveTextContent('33%')
    expect(pills[1]).toHaveTextContent('Bob')
    expect(pills[1]).toHaveTextContent('28%')
  })
})
