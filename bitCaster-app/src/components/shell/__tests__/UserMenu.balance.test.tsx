import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { formatMarketSubunits } from '@bitcaster/client-sdk/marketUnits'
import { UserMenu } from '../UserMenu'

describe('UserMenu balance display', () => {
  it('formats msat wallet balances as sat market subunits', () => {
    expect(formatMarketSubunits(7_000, 'sat')).toBe('7 sats')

    render(<UserMenu user={{ name: 'Anon', balance: 7_000 }} />)

    expect(screen.getByText('7 sats')).toBeInTheDocument()
    expect(screen.queryByText('₿7.0K')).not.toBeInTheDocument()
  })
})
