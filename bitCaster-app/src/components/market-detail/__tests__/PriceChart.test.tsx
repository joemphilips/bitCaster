import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PriceChart } from '../PriceChart'

// These tests assert the rendered SVG STRUCTURE of the Predyx-style chart
// (P22 Link D). They are the deterministic stand-in for a real visual diff:
// step lines, a latest-value pill anchored at the right edge per series, a
// full-width horizontal line for single-point series, and visible X-axis date
// ticks. Pixel-perfect comparison to tmp/predyx_chart.PNG is deferred to the
// local AppHost smoke gate.

describe('PriceChart (Link D)', () => {
  it('renders no Volume toggle (Volume tab dropped)', () => {
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
    expect(screen.queryByText(/volume/i)).not.toBeInTheDocument()
  })

  it('renders a step line + a latest-value pill at the right edge for a multi-point series', () => {
    const { container } = render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [
            { timestamp: '2026-05-20T10:00:00Z', price: 40 },
            { timestamp: '2026-05-22T10:00:00Z', price: 48 },
            { timestamp: '2026-05-25T10:00:00Z', price: 55 },
          ],
        }}
        chartTimeframe="7d"
      />,
    )

    // Step line uses horizontal/vertical segments (H .. V .. commands).
    const line = container.querySelector('[data-testid="series-line"]')
    expect(line).toBeTruthy()
    const d = line?.getAttribute('d') ?? ''
    expect(d).toMatch(/M /)
    expect(d).toMatch(/ H /)
    expect(d).toMatch(/ V /)

    // Latest-value pill shows the newest price (55 → "55.00").
    const pills = container.querySelectorAll('[data-testid="latest-price-pill"]')
    expect(pills.length).toBe(1)
    expect(pills[0].querySelector('text')?.textContent).toBe('55.00')
  })

  it('renders a full-width HORIZONTAL line (not a leftmost circle) for a single-point series', () => {
    const { container } = render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          data: [{ timestamp: '2026-05-25T10:00:00Z', price: 42 }],
        }}
        chartTimeframe="7d"
      />,
    )

    expect(screen.queryByText(/no data available/i)).not.toBeInTheDocument()
    // No single-point circle remains.
    expect(container.querySelector('circle')).toBeNull()
    // The series path is a horizontal line: M <x> <y> H <x2> with one Y value.
    const d = container.querySelector('[data-testid="series-line"]')?.getAttribute('d') ?? ''
    expect(d).toMatch(/^M \S+ \S+ H \S+$/)
  })

  it('renders visible X-axis date ticks', () => {
    const { container } = render(
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
    const ticks = container.querySelectorAll('[data-testid="x-axis-tick"]')
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    // Each tick carries a non-empty date label.
    ticks.forEach((tick) => {
      expect(tick.querySelector('text')?.textContent?.length ?? 0).toBeGreaterThan(0)
    })
  })

  it('renders one step line + one pill per categorical outcome series', () => {
    const { container } = render(
      <PriceChart
        priceHistory={{ timeframe: '7d', data: [] }}
        chartTimeframe="7d"
        outcomes={[
          { id: 'outcome-0', label: 'A', odds: 33 },
          { id: 'outcome-1', label: 'B', odds: 33 },
          { id: 'outcome-2', label: 'C', odds: 34 },
        ]}
        outcomePriceHistories={{
          'outcome-0': {
            timeframe: '7d',
            data: [
              { timestamp: '2026-05-20T10:00:00Z', price: 30 },
              { timestamp: '2026-05-25T10:00:00Z', price: 33 },
            ],
          },
          'outcome-1': {
            timeframe: '7d',
            data: [
              { timestamp: '2026-05-20T10:00:00Z', price: 25 },
              { timestamp: '2026-05-25T10:00:00Z', price: 28 },
            ],
          },
        }}
      />,
    )

    expect(screen.queryByText(/no data available/i)).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-testid="series-line"]').length).toBe(2)
    expect(container.querySelectorAll('[data-testid="latest-price-pill"]').length).toBe(2)
  })

  it('orders series time-ascending so the newest sample feeds the rightmost pill', () => {
    const { container } = render(
      <PriceChart
        priceHistory={{
          timeframe: '7d',
          // Intentionally out of order — newest (60) is NOT last in the array.
          data: [
            { timestamp: '2026-05-25T10:00:00Z', price: 60 },
            { timestamp: '2026-05-20T10:00:00Z', price: 40 },
          ],
        }}
        chartTimeframe="7d"
      />,
    )
    const pill = container.querySelector('[data-testid="latest-price-pill"] text')
    expect(pill?.textContent).toBe('60.00')
  })
})
